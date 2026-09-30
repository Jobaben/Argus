import { randomBytes } from "node:crypto";
import type {
  DecisionAssessment,
  DecisionQuestion,
  DefinitionRef,
  H2CollectionStatus,
  ProviderIdentity,
  Run,
} from "@argus/contracts";
import { log } from "../../log.js";
import { canonicalDigest } from "../canonical.js";
import type { DecisionJournal } from "../journal.js";
import type { DecisionRegistry } from "../registry.js";
import type { DecisionService, ServiceResult } from "../service.js";
import type { H2Enablement, H2Settings } from "./config.js";
import {
  indexLedger,
  isSpent,
  itemKey,
  itemStatus,
  latestConfig,
  PRECALL_FAILURES,
  type Item,
} from "./items.js";
import {
  CONFIG_FORMAT,
  isDamaged,
  LedgerError,
  type AttemptRecord,
  type CollectionConfig,
  type CollectionLedger,
  type NewRecord,
  type RequestedIdentity,
  type ResultRecord,
} from "./ledger.js";
import {
  considerRun,
  EXCLUSION_RULES,
  H2_QUESTIONS,
  isSelected,
  PROBE_ELIGIBILITY,
  probeEligibility,
  probeReference,
  RESIDUAL_ELIGIBILITY,
  residualEligibility,
  retainedObservation,
  runMoment,
  SAMPLING_METHOD,
  terminationStratum,
} from "./sampling.js";

/**
 * The H2 shadow-collection watcher (RFC §P).
 *
 * It runs as the last step of the scheduler tick, outside every instance
 * lock, and the tick awaits it. At most one provider invocation happens per
 * check, and none while any other analysis pass has started since the
 * previous check or is in flight. Its only writes are the collection ledger
 * and, through the Decision service, the Decision Journal. Every assessment
 * it causes is `mode: "shadow"` and nothing consumes it.
 *
 * When collection is not enabled, `check` returns before reading or writing
 * anything.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const PAUSE = {
  budget: 15 * MINUTE,
  storage: 60 * MINUTE,
  error: 60 * MINUTE,
  other: 5 * MINUTE,
} as const;
export const MAX_CENSUS_PER_CHECK = 500;

type Role = "residual" | "probe";

export type H2CheckOutcome =
  | { action: "inactive" }
  | { action: "overlap" }
  | { action: "paused"; until: string }
  | { action: "halted"; detail: string }
  | { action: "deferred"; detail: string }
  | { action: "limited"; detail: string }
  | { action: "idle" }
  | { action: "attempted"; attemptId: string; class: ResultRecord["class"] }
  | { action: "error"; detail: string };

export interface H2WatcherDeps {
  enablement: () => H2Enablement;
  ledger: CollectionLedger;
  journal: Pick<DecisionJournal, "read">;
  service: Pick<DecisionService, "assess">;
  registry: DecisionRegistry;
  questions?: { residual: { id: string; version: number }; probe: { id: string; version: number } };
  /** The service's key for the provider to ask. */
  providerKey: string;
  /** The identity the provider would report before a call: what is requested. */
  providerIdentity: () => ProviderIdentity;
  readRuns: () => Promise<Run[]>;
  runner: { inFlight(): number; passesStarted(): number };
  spendBlocked: (now: Date) => Promise<boolean>;
  now: () => Date;
  newAttemptId?: () => string;
  newAssessmentId?: () => string;
  /** Test seam: throwing here simulates the process stopping at that point. */
  fault?: (point: "attempt-written" | "assessed") => void | Promise<void>;
  maxCensusPerCheck?: number;
  /**
   * The other shadow experiment's spent invocations (RFC §Q.8). Each limit is
   * then checked against both ledgers combined. Absent, or empty while the H1
   * ledger holds no invocation, H2 behaves exactly as it did alone.
   */
  otherSpend?: () => Promise<Array<{ atMs: number; costUsd: number | null }>>;
  /** Whether another shadow experiment invoked the provider earlier on this tick. */
  slotTaken?: () => boolean;
}

export interface H2Watcher {
  check(): Promise<H2CheckOutcome>;
  status(): H2CollectionStatus["watcher"];
}

interface Resolved {
  role: Role;
  ref: DefinitionRef;
  def: DecisionQuestion;
  projection: DefinitionRef;
  rate: number;
}

type Classified = Omit<ResultRecord, "kind" | "seq" | "at" | "attemptId" | "reconciled">;

const bounded = (s: string, max = 500) => {
  const cps = Array.from(s);
  return cps.length > max ? cps.slice(0, max).join("") : s;
};

/** What a recorded assessment says about its call. */
export function fromAssessment(a: DecisionAssessment): Classified {
  const base = {
    assessmentId: a.id,
    costUsd: a.costUsd,
    latencyMs: a.latencyMs,
  };
  const o = a.outcome;
  if (o.status === "answered" || o.status === "abstained") {
    return {
      ...base,
      class: o.status,
      providerCalled: "yes",
      outcome: { status: o.status, failure: null },
      code: null,
      detail: "",
    };
  }
  const precall = PRECALL_FAILURES.has(o.failure);
  return {
    ...base,
    class: precall ? "refused" : "provider-failed",
    providerCalled: precall ? "no" : "yes",
    outcome: { status: "failed", failure: o.failure },
    code: o.failure,
    detail: bounded(o.detail),
  };
}

export function classifyServiceResult(res: ServiceResult): Classified {
  if (res.ok) return fromAssessment(res.assessment);
  const none = { assessmentId: null, outcome: null, costUsd: null, latencyMs: null };
  if (res.reason === "snapshot-unbuildable" && res.detail.startsWith("source-unavailable")) {
    return {
      ...none,
      class: "missing-input",
      providerCalled: "no",
      code: "source-unavailable",
      detail: bounded(res.detail),
    };
  }
  if (res.providerCalled) {
    return {
      ...none,
      class: "unrecorded",
      providerCalled: "yes",
      code: res.reason,
      detail: bounded(res.detail),
    };
  }
  return {
    ...none,
    class: "refused",
    providerCalled: "no",
    code: res.reason,
    detail: bounded(res.detail),
  };
}

function pauseFor(c: Classified): number {
  if (c.class === "refused") {
    if (c.code === "budget-blocked" || c.code === "disabled") return PAUSE.budget;
    if (c.code === "storage-refused") return PAUSE.storage;
    if (c.code === "busy") return 0;
    return PAUSE.other;
  }
  if (c.class === "missing-input" || c.class === "construction-error") return PAUSE.other;
  if (c.class === "unknown-outcome") return PAUSE.error;
  return 0;
}

export const requestedIdentity = (i: ProviderIdentity): RequestedIdentity => ({
  provider: i.provider,
  requestedModel: i.requestedModel,
  adapterVersion: i.adapterVersion,
  elicitation: i.elicitation,
});

export function buildCollectionConfig(
  settings: H2Settings,
  qs: Resolved[],
  identity: ProviderIdentity,
): { config: CollectionConfig; digest: string } {
  const config: CollectionConfig = {
    format: CONFIG_FORMAT,
    version: 1,
    sampling: {
      method: SAMPLING_METHOD,
      seed: settings.seed,
      questions: qs.map((q) => ({
        role: q.role,
        id: q.ref.id,
        version: q.ref.version,
        digest: q.ref.digest,
        rate: q.rate,
      })),
    },
    window: { ...settings.window },
    eligibility: { residual: RESIDUAL_ELIGIBILITY, probe: PROBE_ELIGIBILITY },
    exclusions: [...EXCLUSION_RULES],
    limits: { ...settings.limits },
    provider: requestedIdentity(identity),
  };
  return { config, digest: canonicalDigest(config).sha256 };
}

export function createH2Watcher(deps: H2WatcherDeps): H2Watcher {
  const questions = deps.questions ?? H2_QUESTIONS;
  const newAttemptId = deps.newAttemptId ?? (() => `H2A-${randomBytes(12).toString("base64url")}`);
  const newAssessmentId =
    deps.newAssessmentId ?? (() => `DA-${randomBytes(12).toString("base64url")}`);
  const maxCensus = deps.maxCensusPerCheck ?? MAX_CENSUS_PER_CHECK;

  let running = false;
  let pausedUntil = 0;
  let lastPasses: number | null = null;
  let state: H2CollectionStatus["watcher"] = { state: "inactive", detail: null, until: null };

  const set = (
    s: H2CollectionStatus["watcher"]["state"],
    detail: string | null,
    until: string | null = null,
  ) => {
    state = { state: s, detail, until };
  };

  function resolve(settings: H2Settings): Resolved[] | string {
    const out: Resolved[] = [];
    for (const role of ["residual", "probe"] as const) {
      const want = questions[role];
      const q = deps.registry.question(want.id, want.version);
      if (!q) return `${want.id}@${want.version} is not registered`;
      if (q.def.answers.shape !== "choice")
        return `${want.id}@${want.version} is not a closed choice`;
      const p = deps.registry.projection(q.def.projection.id, q.def.projection.version);
      if (!p)
        return `projection ${q.def.projection.id}@${q.def.projection.version} is not registered`;
      out.push({
        role,
        ref: q.ref,
        def: q.def,
        projection: p.ref,
        rate: role === "residual" ? settings.residualRate : settings.probeRate,
      });
    }
    return out;
  }

  async function reconcile(open: AttemptRecord[], at: string): Promise<void> {
    const view = await deps.journal.read();
    const byId = new Map(view.entries.map((e) => [e.assessment.id, e.assessment]));
    const results: NewRecord[] = open.map((a) => {
      const found = byId.get(a.assessmentId);
      const c: Classified = found
        ? { ...fromAssessment(found), detail: "reconciled from the journal after a restart" }
        : {
            class: "unknown-outcome",
            providerCalled: "unknown",
            assessmentId: null,
            outcome: null,
            code: "interrupted",
            detail:
              "the process stopped during this attempt; the provider call may or may not have happened, and it is not retried",
            costUsd: null,
            latencyMs: null,
          };
      return { kind: "result", at, attemptId: a.attemptId, reconciled: true, ...c };
    });
    await deps.ledger.append(results);
  }

  async function collect(settings: H2Settings): Promise<H2CheckOutcome> {
    const now = deps.now();
    const nowMs = now.getTime();
    const at = now.toISOString();
    if (nowMs < pausedUntil) {
      const until = new Date(pausedUntil).toISOString();
      set("paused", state.detail, until);
      return { action: "paused", until };
    }
    const halt = (detail: string): H2CheckOutcome => {
      set("halted", detail);
      return { action: "halted", detail };
    };

    const qs = resolve(settings);
    if (typeof qs === "string") return halt(qs);

    let view = await deps.ledger.load();
    if (isDamaged(view)) {
      const first = view.notices.find(
        (n) => n.kind !== "torn-tail" && n.kind !== "recovered-torn-write",
      );
      return halt(
        `the collection ledger is damaged (${first?.kind} at line ${first?.line}); deduplication cannot be trusted`,
      );
    }

    // 1. Close attempts an earlier process left open.
    let idx = indexLedger(view);
    const open = idx.attempts.filter((e) => e.result === null).map((e) => e.attempt);
    if (open.length > 0) await reconcile(open, at);

    // 2. The start, once, and the definition in force.
    const pre: NewRecord[] = [];
    if (!idx.start)
      pre.push({ kind: "start", at, format: "argus.h2-collection-ledger", version: 1 });
    const identity = deps.providerIdentity();
    const { config, digest } = buildCollectionConfig(settings, qs, identity);
    if (latestConfig(idx)?.digest !== digest) pre.push({ kind: "config", at, digest, config });
    await deps.ledger.append(pre);
    view = await deps.ledger.load();
    idx = indexLedger(view);
    const startMs = Date.parse(idx.start!.at);

    // 3. Census: every newly considered run, once per question version.
    const runs = await deps.readRuns();
    const byId = new Map(runs.map((r) => [r.id, r]));
    const census: NewRecord[] = [];
    const ordered = [...runs].sort((a, b) => runMoment(a) - runMoment(b) || (a.id < b.id ? -1 : 1));
    outer: for (const run of ordered) {
      const c = considerRun(run, startMs, nowMs, settings.window);
      if (c.kind !== "consider") continue;
      const { stratum } = terminationStratum(run);
      for (const q of qs) {
        if (idx.census.has(itemKey(run.id, q.ref))) continue;
        if (census.length >= maxCensus) break outer;
        const e =
          q.role === "residual" ? residualEligibility(run) : probeEligibility(run, q.def.answers);
        let verdict: "selected" | "not-selected" | "excluded";
        let reason: string | null = null;
        if (!e.ok) {
          verdict = "excluded";
          reason = e.reason;
        } else if (c.missedWindow) {
          verdict = "excluded";
          reason = "missed-window";
        } else {
          verdict = isSelected(settings.seed, q.ref, run.id, q.rate) ? "selected" : "not-selected";
        }
        census.push({
          kind: "census",
          at,
          config: digest,
          runId: run.id,
          endedAt: run.endedAt!,
          stratum,
          question: q.ref,
          verdict,
          reason,
        });
      }
    }
    await deps.ledger.append(census);
    idx = indexLedger(await deps.ledger.load());

    // 4. Selected items that left the window unattempted.
    const maxTries = settings.limits.maxTriesPerItem;
    const expired: NewRecord[] = [];
    for (const item of idx.items.values()) {
      if (itemStatus(item, maxTries) !== "pending") continue;
      if (nowMs - Date.parse(item.census.endedAt) > settings.window.maxAgeMs) {
        expired.push({
          kind: "expired",
          at,
          runId: item.runId,
          question: item.question,
          reason: "window-closed",
        });
      }
    }
    await deps.ledger.append(expired);
    idx = indexLedger(await deps.ledger.load());

    // 5. May a call be made now? Existing analysis always goes first.
    const passes = deps.runner.passesStarted();
    if (lastPasses === null || passes !== lastPasses) {
      const detail =
        lastPasses === null
          ? "first check since start"
          : "another analysis pass ran since the last check";
      lastPasses = passes;
      set("waiting", detail);
      return { action: "deferred", detail };
    }
    if (deps.runner.inFlight() > 0) {
      set("waiting", "an analysis pass is in flight");
      return { action: "deferred", detail: "an analysis pass is in flight" };
    }
    if (deps.slotTaken?.()) {
      const detail = "another shadow experiment used this tick's provider invocation";
      set("waiting", detail);
      return { action: "deferred", detail };
    }
    const since = nowMs - DAY;
    const spent = idx.attempts.filter((e) => isSpent(e) && Date.parse(e.attempt.at) > since);
    const other = deps.otherSpend ? (await deps.otherSpend()).filter((o) => o.atMs > since) : [];
    const combined = other.length > 0 ? " (H1 and H2 combined)" : "";
    const limited = (detail: string): H2CheckOutcome => {
      set("waiting", detail);
      return { action: "limited", detail };
    };
    if (spent.length + other.length >= settings.limits.maxCallsPer24h) {
      return limited(
        `${spent.length + other.length} provider invocations in the last 24 hours${combined} (limit ${settings.limits.maxCallsPer24h})`,
      );
    }
    const last = Math.max(
      spent.reduce((m, e) => Math.max(m, Date.parse(e.attempt.at)), -Infinity),
      other.reduce((m, o) => Math.max(m, o.atMs), -Infinity),
    );
    if (nowMs - last < settings.limits.minCallIntervalMs) {
      return limited("the minimum interval since the last provider invocation has not passed");
    }
    const usd =
      spent.reduce((s, e) => s + (e.result?.costUsd ?? 0), 0) +
      other.reduce((s, o) => s + (o.costUsd ?? 0), 0);
    if (usd >= settings.limits.maxUsdPer24h) {
      return limited(
        `US$${usd.toFixed(4)} recorded in the last 24 hours${combined} (limit US$${settings.limits.maxUsdPer24h})`,
      );
    }

    // 6. The oldest pending item of a question version in force.
    const inForce = new Map(qs.map((q) => [`${q.ref.id}@${q.ref.version}`, q]));
    const next = [...idx.items.values()]
      .filter((item) => inForce.has(`${item.question.id}@${item.question.version}`))
      .filter((item) => itemStatus(item, maxTries) === "pending")
      .filter((item) => {
        const tries = item.attempts.map((e) => Date.parse(e.attempt.at));
        return tries.length === 0 || nowMs - Math.max(...tries) >= settings.limits.retryAfterMs;
      })
      .sort(
        (a, b) =>
          Date.parse(a.census.endedAt) - Date.parse(b.census.endedAt) ||
          (a.question.id < b.question.id ? -1 : a.question.id > b.question.id ? 1 : 0) ||
          (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
      )[0];
    if (!next) {
      set("waiting", "nothing pending");
      return { action: "idle" };
    }
    if (await deps.spendBlocked(now)) {
      pausedUntil = nowMs + PAUSE.budget;
      set("paused", "the spend budget hard stop is in force", new Date(pausedUntil).toISOString());
      return { action: "paused", until: new Date(pausedUntil).toISOString() };
    }
    return attempt(
      next,
      inForce.get(`${next.question.id}@${next.question.version}`)!,
      byId.get(next.runId) ?? null,
      {
        digest,
        identity,
        at,
        nowMs,
      },
    );
  }

  async function attempt(
    item: Item,
    q: Resolved,
    run: Run | null,
    ctx: { digest: string; identity: ProviderIdentity; at: string; nowMs: number },
  ): Promise<H2CheckOutcome> {
    const attemptId = newAttemptId();
    const base: Omit<AttemptRecord, "seq" | "stratum" | "reference"> = {
      kind: "attempt",
      at: ctx.at,
      attemptId,
      assessmentId: newAssessmentId(),
      config: ctx.digest,
      runId: item.runId,
      runEndedAt: item.census.endedAt,
      question: q.ref,
      projection: q.projection,
      provider: requestedIdentity(ctx.identity),
      sample: 0,
      try: item.attempts.length + 1,
    };
    const finish = async (c: Classified): Promise<H2CheckOutcome> => {
      await deps.ledger.append([
        { kind: "result", at: ctx.at, attemptId, reconciled: false, ...c },
      ]);
      const pause = pauseFor(c);
      if (pause > 0) pausedUntil = ctx.nowMs + pause;
      set(
        pause > 0 ? "paused" : "waiting",
        `last attempt: ${c.class}${c.code ? ` (${c.code})` : ""}`,
        pause > 0 ? new Date(pausedUntil).toISOString() : null,
      );
      return { action: "attempted", attemptId, class: c.class };
    };
    const noCall = (
      cls: "missing-input" | "construction-error",
      code: string,
      detail: string,
    ): Classified => ({
      class: cls,
      providerCalled: "no",
      assessmentId: null,
      outcome: null,
      code,
      detail: bounded(detail),
      costUsd: null,
      latencyMs: null,
    });

    if (!run) {
      await deps.ledger.append([
        { ...base, stratum: { class: item.census.stratum, observation: null }, reference: null },
      ]);
      return finish(
        noCall("missing-input", "run-unavailable", `run ${item.runId} is no longer readable`),
      );
    }
    const stratum = {
      class: terminationStratum(run).stratum,
      observation: retainedObservation(run),
    };
    let reference = null;
    if (q.role === "probe") {
      const r = probeReference(run, { ref: q.ref, answers: q.def.answers });
      if (!r.ok) {
        await deps.ledger.append([{ ...base, stratum, reference: null }]);
        return finish(noCall("construction-error", `reference-${r.reason}`, r.detail));
      }
      reference = r.reference;
    }
    // Intent first, fsync'd: after a crash this line is what stops a silent repeat.
    await deps.ledger.append([{ ...base, stratum, reference }]);
    await deps.fault?.("attempt-written");
    let c: Classified;
    try {
      const res = await deps.service.assess({
        question: q.ref.id,
        version: q.ref.version,
        subject: { kind: "run", runId: item.runId },
        provider: deps.providerKey,
        sample: 0,
        id: base.assessmentId,
      });
      c = classifyServiceResult(res);
    } catch (e) {
      c = {
        class: "unknown-outcome",
        providerCalled: "unknown",
        assessmentId: null,
        outcome: null,
        code: "error",
        detail: bounded(`the attempt threw: ${(e as Error)?.message ?? String(e)}`),
        costUsd: null,
        latencyMs: null,
      };
    }
    await deps.fault?.("assessed");
    return finish(c);
  }

  return {
    async check() {
      if (running) return { action: "overlap" };
      const en = deps.enablement();
      if (!en.enabled) {
        set("inactive", en.reasons.join("; "));
        return { action: "inactive" };
      }
      running = true;
      try {
        return await collect(en.settings);
      } catch (e) {
        const detail =
          e instanceof LedgerError
            ? `${e.code}: ${e.message}`
            : `collection check failed: ${(e as Error)?.message ?? String(e)}`;
        if (e instanceof LedgerError && e.code === "ledger-full") set("halted", detail);
        else set("waiting", detail);
        log.error("h2 collection check failed", { err: e });
        return { action: "error", detail };
      } finally {
        running = false;
      }
    },
    status: () => ({ ...state }),
  };
}
