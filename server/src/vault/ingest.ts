import { createHash } from "node:crypto";
import type { Anomaly, Incident, Verdict, VaultIngestResult } from "@argus/contracts";
import type { Run } from "../sources/scheduleTypes.js";
import type { SpendLedger } from "../sources/budget.js";
import { openVault, readMeta, writeMeta, type VaultDb } from "./db.js";

/**
 * Ingest: moving what the JSON files hold *now* into the store that will still
 * hold it after they have pruned.
 *
 * The whole design turns on one property: **every write is an upsert keyed by
 * the record's own identity**. A run is its id, an incident event is a hash of
 * (incident, timestamp, message), a spend day is its calendar date. Re-running
 * a pass therefore changes nothing, which is what makes the watermark below an
 * optimisation rather than a correctness requirement — a lost watermark costs
 * one slow pass, never a duplicated or missing row.
 *
 * The alternative (append-only with a strictly-advancing cursor) is faster and
 * wrong in exactly the case that matters: a run that starts before the cursor
 * and *finishes* after it would be recorded forever as still running.
 */

/** How far back a normal pass re-reads, regardless of the watermark.
 *
 *  A run's record is rewritten when it finishes, so the row the Vault ingested
 *  while it was queued is stale until it is re-read. This window is the promise
 *  that a run which took under an hour is always eventually corrected. */
export const REINGEST_WINDOW_MS = 60 * 60_000;

/** Prompt/summary text stored per run. Enough to search, not a second copy of
 *  the transcript — the Vault indexes the record, not the conversation. */
const TEXT_CAP = 4000;

const WATERMARK = "ingest.watermark";
const LAST_INGEST = "ingest.at";

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const clip = (s: string | null | undefined): string | null =>
  s == null ? null : s.slice(0, TEXT_CAP);

/** A run's place on the timeline: when it ended, else started, else queued. */
export function runMoment(run: Run): number | null {
  return ms(run.endedAt) ?? ms(run.startedAt) ?? ms(run.queuedAt);
}

/** Stable id for a record the source never gave one to. */
export function eventId(parts: string[]): string {
  // NUL as the separator, written as an escape: with a space, ["a b", "c"]
  // and ["a", "b c"] hash identically, and an incident detail containing a
  // space is not a hypothetical.
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

export interface IngestInput {
  runs: Run[];
  incidents: Incident[];
  anomalies: Anomaly[];
  verdicts: Verdict[];
  spend: SpendLedger;
  now: Date;
}

/**
 * One event row, flattened from whichever feature raised it.
 *
 * Alerts live in five different shapes across Sentinel, Watchtower, Monitors
 * and the budget. The Vault stores the shape they have in common — when, what
 * kind, how bad, what it was about — because a cross-source timeline can only
 * be built from the intersection, and the source files remain available for
 * anything more specific.
 */
export interface VaultEvent {
  id: string;
  atMs: number;
  kind: string;
  severity: string | null;
  subject: string | null;
  detail: string | null;
  href: string | null;
}

/** Pure: the event rows implied by the current incidents and anomalies. */
export function eventsFrom(incidents: Incident[], anomalies: Anomaly[]): VaultEvent[] {
  const out: VaultEvent[] = [];
  for (const incident of incidents) {
    for (const entry of incident.timeline) {
      const at = ms(entry.at);
      if (at == null) continue;
      out.push({
        // Hashing the content rather than the index: a timeline that is capped
        // and drops its oldest entries renumbers every remaining one, so an
        // index-keyed id would re-ingest the whole history on every prune.
        id: eventId(["incident", incident.id, entry.at, entry.kind, entry.detail]),
        atMs: at,
        kind: `incident.${entry.kind}`,
        severity: incident.severity,
        subject: incident.title,
        detail: entry.detail,
        href: "#/sentinel",
      });
    }
  }
  for (const anomaly of anomalies) {
    const at = ms(anomaly.at);
    if (at == null) continue;
    out.push({
      id: eventId(["anomaly", anomaly.id]),
      atMs: at,
      kind: `anomaly.${anomaly.metric}`,
      severity: anomaly.severity,
      subject: anomaly.name,
      detail: anomaly.detail,
      href: "#/watchtower",
    });
  }
  return out;
}

/** The searchable document for a run. Null when there is nothing to index. */
export function runDoc(run: Run): { title: string; body: string } | null {
  const body = [run.prompt, run.resultSummary, run.error].filter(Boolean).join("\n").trim();
  if (!body) return null;
  return { title: run.scheduleName || run.id, body: body.slice(0, TEXT_CAP) };
}

const PIPELINE_PREFIX = "pipeline:";

export function pipelineIdOf(run: Run): string | null {
  return run.scheduleId.startsWith(PIPELINE_PREFIX)
    ? run.scheduleId.slice(PIPELINE_PREFIX.length)
    : null;
}

function durationOf(run: Run): number | null {
  const start = ms(run.startedAt);
  const end = ms(run.endedAt);
  return start != null && end != null && end >= start ? end - start : null;
}

/**
 * Run one ingest pass. Never throws: a failure is reported in the result and
 * the next tick tries again.
 */
export function ingest(input: IngestInput): VaultIngestResult {
  // The watermark is the *logical* clock the caller supplied; `ms` has to be a
  // real elapsed duration, or an injected clock makes every pass look instant
  // (or, with a fixed date, negative) and the slow-pass backoff never fires.
  const watermarkAt = input.now.getTime();
  const t0 = Date.now();
  const empty: VaultIngestResult = {
    ok: false,
    runs: 0,
    events: 0,
    spendDays: 0,
    scores: 0,
    ms: 0,
    error: null,
  };

  const handle = openVault();
  if (!handle) return { ...empty, error: "the Vault is unavailable" };

  try {
    const counts = writeAll(handle.db, input);
    writeMeta(handle.db, LAST_INGEST, input.now.toISOString());
    writeMeta(handle.db, WATERMARK, String(watermarkAt));
    return { ...counts, ok: true, error: null, ms: Date.now() - t0 };
  } catch (e) {
    return {
      ...empty,
      error: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    };
  }
}

/** The watermark from the last successful pass, or null. */
export function lastWatermark(db: VaultDb): number | null {
  const raw = readMeta(db, WATERMARK);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function lastIngestAt(db: VaultDb): string | null {
  return readMeta(db, LAST_INGEST);
}

/**
 * Which runs this pass needs to write.
 *
 * Pure and exported because the rule is the subtle part: everything newer than
 * `watermark - REINGEST_WINDOW_MS`, not everything newer than the watermark. A
 * run whose record was rewritten on completion must be re-read, and its
 * *timeline* position (when it ended) can be older than the moment it changed.
 */
export function runsToWrite(runs: Run[], watermark: number | null): Run[] {
  if (watermark == null) return runs;
  const floor = watermark - REINGEST_WINDOW_MS;
  return runs.filter((r) => {
    const at = runMoment(r);
    // A run with no usable timestamp is written every pass rather than never:
    // it is cheap, bounded by how few such runs exist, and the alternative is a
    // record that is silently unreachable.
    return at == null || at >= floor || r.status === "running";
  });
}

function writeAll(db: VaultDb, input: IngestInput) {
  const watermark = lastWatermark(db);
  const runs = runsToWrite(input.runs, watermark);

  const upsertRun = db.prepare(`
    INSERT INTO runs (id, schedule_id, schedule_name, pipeline_id, instance_id, phase_id,
                      project, model, trigger, status, outcome, at_ms, duration_ms, cost_usd,
                      tokens, budget_action, prompt, summary, error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      schedule_name = excluded.schedule_name, project = excluded.project,
      model = excluded.model, status = excluded.status, outcome = excluded.outcome,
      at_ms = excluded.at_ms, duration_ms = excluded.duration_ms,
      cost_usd = excluded.cost_usd, tokens = excluded.tokens,
      budget_action = excluded.budget_action, prompt = excluded.prompt,
      summary = excluded.summary, error = excluded.error
  `);
  const dropDoc = db.prepare("DELETE FROM docs WHERE ref = ? AND kind = ?");
  const addDoc = db.prepare(
    "INSERT INTO docs (title, body, kind, ref, at_ms, href) VALUES (?,?,?,?,?,?)",
  );
  const upsertEvent = db.prepare(`
    INSERT INTO events (id, at_ms, kind, severity, subject, detail, href)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      severity = excluded.severity, subject = excluded.subject, detail = excluded.detail
  `);
  const upsertDay = db.prepare(`
    INSERT INTO spend_days (day, usd, tokens, runs) VALUES (?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET usd = excluded.usd, tokens = excluded.tokens, runs = excluded.runs
  `);
  const upsertScore = db.prepare(`
    INSERT INTO scores (run_id, at_ms, score, goal) VALUES (?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET at_ms = excluded.at_ms, score = excluded.score, goal = excluded.goal
  `);

  // One transaction for the whole pass. A pass that dies halfway leaves the
  // Vault exactly as it was, so the watermark and the rows can never disagree.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const run of runs) {
      const at = runMoment(run) ?? input.now.getTime();
      upsertRun.run(
        run.id,
        run.scheduleId,
        run.scheduleName,
        pipelineIdOf(run),
        run.instanceId ?? null,
        run.phaseId ?? null,
        run.project ?? null,
        run.model ?? null,
        run.trigger ?? null,
        run.status,
        run.outcome ?? null,
        at,
        durationOf(run),
        run.costUsd ?? null,
        run.tokens ?? null,
        run.budgetAction ?? null,
        clip(run.prompt),
        clip(run.resultSummary),
        clip(run.error),
      );
      const doc = runDoc(run);
      // FTS5 has no upsert, so a re-ingested run replaces its document. Doing
      // the delete unconditionally keeps a run whose text was cleared from
      // leaving a stale document behind.
      dropDoc.run(run.id, "run");
      if (doc) {
        addDoc.run(
          doc.title,
          doc.body,
          "run",
          run.id,
          at,
          run.project && run.sessionId
            ? `#/sessions/${encodeURIComponent(run.project)}/${encodeURIComponent(run.sessionId)}`
            : "#/schedules",
        );
      }
    }

    const events = eventsFrom(input.incidents, input.anomalies);
    for (const e of events) {
      upsertEvent.run(e.id, e.atMs, e.kind, e.severity, e.subject, e.detail, e.href);
      dropDoc.run(e.id, "event");
      const body = [e.subject, e.detail].filter(Boolean).join("\n");
      if (body) addDoc.run(e.subject ?? e.kind, body, "event", e.id, e.atMs, e.href);
    }

    const days = Object.entries(input.spend.days ?? {});
    for (const [day, v] of days) {
      upsertDay.run(day, v.usd ?? 0, v.tokens ?? 0, v.runs ?? 0);
    }

    let scores = 0;
    for (const verdict of input.verdicts) {
      const at = ms(verdict.at);
      if (at == null || verdict.status !== "ready") continue;
      upsertScore.run(verdict.runId, at, verdict.score, verdict.summary ?? null);
      scores++;
    }

    db.exec("COMMIT");
    return { runs: runs.length, events: events.length, spendDays: days.length, scores };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the failure below is the one worth reporting */
    }
    throw e;
  }
}
