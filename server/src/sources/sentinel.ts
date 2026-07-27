import { createHash } from "node:crypto";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import { readJson } from "./readJson.js";
import type {
  Diagnosis,
  Incident,
  IncidentAlert,
  IncidentEvent,
  IncidentSeverity,
  IncidentSource,
  QuietHours,
  SentinelPolicy,
} from "@argus/contracts";
import type { Anomaly } from "./watchtower.js";
import type { Issue } from "./issues.js";
import type { MonitorHealth } from "./monitors.js";

/**
 * Sentinel's state machine, as pure functions plus two small stores.
 *
 * The reconciliation is the whole feature and it is deliberately shaped as
 * `(existing incidents, current conditions, policy, now) → (incidents,
 * alerts)`. Everything hard about paging lives in that function — open once and
 * only once, escalate on a clock, auto-resolve when the world recovers, reopen
 * rather than duplicate when it recurs — and all of it is testable without a
 * scheduler, a socket, or a clock.
 *
 * Two rules that shape the rest:
 *
 * **A condition has an identity, not a timestamp.** Incidents are keyed by what
 * is wrong (`monitor:<id>`), so a monitor that is down for six hours is one
 * incident with a six-hour timeline, not seventy-two alerts. The whole point of
 * an incident object is to be the thing that *doesn't* repeat.
 *
 * **Quiet hours suppress the notification, never the record.** A suppressed
 * alert still appends to the timeline and still shows in the UI; it just does
 * not ring a bell at 3am. Dropping the record instead would mean the morning
 * view has a hole exactly where the night's problems were.
 */

export type {
  Diagnosis,
  Incident,
  IncidentAlert,
  IncidentEvent,
  IncidentSeverity,
  IncidentSource,
  IncidentStatus,
  QuietHours,
  SentinelPolicy,
  SentinelState,
} from "@argus/contracts";

/** Timeline entries kept per incident. Long enough to hold a bad week. */
export const TIMELINE_CAP = 200;

/** Resolved incidents retained before pruning. */
export const INCIDENT_KEEP = 200;

/** How long a resolved incident stays before it can be pruned. */
export const RESOLVED_RETENTION_MS = 14 * 24 * 3_600_000;

export const DEFAULT_POLICY: SentinelPolicy = {
  enabled: true,
  // Two levels by default: notice, then insist. A single level is not an
  // escalation policy, and five is a configuration exercise nobody completes.
  levels: [
    { afterMinutes: 0, label: "Notify" },
    { afterMinutes: 30, label: "Escalate — still unacknowledged" },
  ],
  quietHours: null,
  quietHoursOverrideCritical: true,
  autoDiagnose: false,
};

export class SentinelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SentinelValidationError";
  }
}

const incidentStore = createJsonArrayStore<Incident>({
  file: paths.incidentsFile,
  label: "incidents.json",
});

export const readIncidents = incidentStore.read;

export async function writeIncidents(list: Incident[]): Promise<void> {
  await incidentStore.write(list);
}

export function withIncidentLock<T>(fn: () => Promise<T>): Promise<T> {
  return incidentStore.withLock(fn);
}

// ── Policy ──────────────────────────────────────────────────────────────────

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

export async function readPolicy(): Promise<SentinelPolicy> {
  const raw = await readJson<Partial<SentinelPolicy> | null>(paths.sentinelFile(), null);
  if (!raw || typeof raw !== "object") return { ...DEFAULT_POLICY };
  return {
    enabled: raw.enabled !== false,
    levels:
      Array.isArray(raw.levels) && raw.levels.length > 0
        ? raw.levels.map((l) => ({
            afterMinutes: Math.max(0, Number(l?.afterMinutes) || 0),
            label: String(l?.label ?? "Escalate").slice(0, 120),
          }))
        : DEFAULT_POLICY.levels,
    quietHours:
      raw.quietHours && HHMM_RE.test(raw.quietHours.start) && HHMM_RE.test(raw.quietHours.end)
        ? { start: raw.quietHours.start, end: raw.quietHours.end }
        : null,
    quietHoursOverrideCritical: raw.quietHoursOverrideCritical !== false,
    autoDiagnose: raw.autoDiagnose === true,
  };
}

export function validatePolicyPatch(raw: unknown): Partial<SentinelPolicy> {
  if (!raw || typeof raw !== "object") throw new SentinelValidationError("body required");
  const r = raw as Record<string, unknown>;
  const patch: Partial<SentinelPolicy> = {};

  if ("enabled" in r) patch.enabled = Boolean(r.enabled);
  if ("autoDiagnose" in r) patch.autoDiagnose = Boolean(r.autoDiagnose);
  if ("quietHoursOverrideCritical" in r) {
    patch.quietHoursOverrideCritical = Boolean(r.quietHoursOverrideCritical);
  }

  if ("levels" in r) {
    if (!Array.isArray(r.levels) || r.levels.length === 0) {
      throw new SentinelValidationError("levels must list at least one escalation level");
    }
    if (r.levels.length > 5) {
      throw new SentinelValidationError("levels is capped at 5");
    }
    patch.levels = r.levels.map((raw, i) => {
      const l = (raw ?? {}) as Record<string, unknown>;
      const afterMinutes = Number(l.afterMinutes);
      if (!Number.isFinite(afterMinutes) || afterMinutes < 0) {
        throw new SentinelValidationError(`level ${i + 1}: afterMinutes must be 0 or more`);
      }
      if (typeof l.label !== "string" || !l.label.trim()) {
        throw new SentinelValidationError(`level ${i + 1}: label is required`);
      }
      return { afterMinutes: Math.floor(afterMinutes), label: l.label.trim().slice(0, 120) };
    });
  }

  if ("quietHours" in r) {
    if (r.quietHours === null) {
      patch.quietHours = null;
    } else {
      const q = (r.quietHours ?? {}) as Record<string, unknown>;
      if (typeof q.start !== "string" || !HHMM_RE.test(q.start)) {
        throw new SentinelValidationError('quietHours.start must be "HH:MM"');
      }
      if (typeof q.end !== "string" || !HHMM_RE.test(q.end)) {
        throw new SentinelValidationError('quietHours.end must be "HH:MM"');
      }
      if (q.start === q.end) {
        throw new SentinelValidationError("quietHours needs an end different from its start");
      }
      patch.quietHours = { start: q.start, end: q.end };
    }
  }

  return patch;
}

export async function updatePolicy(patch: Partial<SentinelPolicy>): Promise<SentinelPolicy> {
  const next = { ...(await readPolicy()), ...patch };
  await atomicWriteJson(paths.sentinelFile(), next);
  return next;
}

/**
 * Whether `now` falls inside the quiet window, on the local clock.
 *
 * Wrapping past midnight is the normal case (22:00–07:00), so it is handled
 * first-class rather than as an edge: when the end is before the start, the
 * window is the union of "after start" and "before end".
 */
export function inQuietHours(quiet: QuietHours | null, now: Date): boolean {
  if (!quiet) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = quiet.start.split(":").map(Number);
  const [eh, em] = quiet.end.split(":").map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Whether an alert of this severity should ring, given the policy and clock. */
export function shouldNotify(
  policy: SentinelPolicy,
  severity: IncidentSeverity,
  now: Date,
): boolean {
  if (!inQuietHours(policy.quietHours, now)) return true;
  return policy.quietHoursOverrideCritical && severity === "critical";
}

// ── Conditions ──────────────────────────────────────────────────────────────

/** One thing that is currently wrong, as Sentinel sees it. */
export interface Condition {
  key: string;
  source: IncidentSource;
  severity: IncidentSeverity;
  title: string;
  detail: string;
  scheduleId: string | null;
  runId: string | null;
  fingerprint: string | null;
}

export interface ConditionInput {
  monitors: MonitorHealth[];
  issues: Issue[];
  anomalies: Anomaly[];
  /** Fingerprints whose triage says "resolved" — a failure after that is a
   *  regression, which is what makes it page-worthy rather than routine. */
  resolvedFingerprints: Set<string>;
}

/**
 * Everything currently worth an incident.
 *
 * Deliberately narrow. Not every open issue is an incident: Argus already has a
 * triage surface for those, and mirroring it here would turn the incident list
 * into a second inbox. What pages is a *change for the worse* that nobody has
 * seen yet — a monitor that stopped reporting, a run that started failing, a
 * previously-resolved issue that came back, or a critical anomaly.
 */
export function deriveConditions(input: ConditionInput): Condition[] {
  const out: Condition[] = [];

  for (const m of input.monitors) {
    if (m.status !== "down" && m.status !== "failing") continue;
    out.push({
      key: `monitor:${m.scheduleId}`,
      source: m.status === "down" ? "monitor-down" : "monitor-failing",
      severity: m.status === "down" ? "critical" : "warning",
      title: m.name,
      detail:
        m.status === "down"
          ? `no run covered the slot expected at ${m.expectedAt ?? "the last interval"}`
          : "the most recent completed run failed",
      scheduleId: m.scheduleId,
      runId: null,
      fingerprint: null,
    });
  }

  for (const issue of input.issues) {
    // A regression, specifically: someone marked this fixed and it came back.
    if (issue.state !== "open" || !input.resolvedFingerprints.has(issue.fingerprint)) continue;
    out.push({
      key: `issue:${issue.fingerprint}`,
      source: "issue-regression",
      severity: "critical",
      title: `Regressed: ${issue.title}`,
      detail: `marked resolved, then failed again ×${issue.count} across ${issue.schedules.join(", ")}`,
      scheduleId: null,
      runId: issue.lastRunId,
      fingerprint: issue.fingerprint,
    });
  }

  for (const a of input.anomalies) {
    if (a.severity !== "critical") continue;
    out.push({
      key: `anomaly:${a.key}:${a.metric}`,
      source: "anomaly",
      severity: "critical",
      title: a.name,
      detail: a.detail,
      scheduleId: a.scheduleId,
      runId: a.runId,
      fingerprint: null,
    });
  }

  return out;
}

// ── Reconciliation ──────────────────────────────────────────────────────────

function incidentId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function event(
  kind: IncidentEvent["kind"],
  detail: string,
  at: string,
  by = "sentinel",
): IncidentEvent {
  return { at, kind, detail, by };
}

function appendEvent(incident: Incident, e: IncidentEvent): Incident {
  const timeline = [...incident.timeline, e];
  return {
    ...incident,
    timeline: timeline.slice(-TIMELINE_CAP),
    updatedAt: e.at,
  };
}

/** When the next escalation from `level` is due, or null when fully climbed. */
function escalationDue(policy: SentinelPolicy, level: number, from: string): string | null {
  const next = policy.levels[level + 1];
  if (!next) return null;
  return new Date(Date.parse(from) + next.afterMinutes * 60_000).toISOString();
}

export interface ReconcileResult {
  incidents: Incident[];
  alerts: IncidentAlert[];
}

/**
 * Fold the current conditions into the existing incidents.
 *
 * Pure. `now` is a parameter, escalation is compared against stored timestamps,
 * and nothing here touches disk — which is what makes "escalates after thirty
 * unacknowledged minutes" a two-line test instead of a thirty-minute one.
 */
export function reconcileIncidents(
  existing: Incident[],
  conditions: Condition[],
  policy: SentinelPolicy,
  now: Date,
): ReconcileResult {
  const at = now.toISOString();
  const alerts: IncidentAlert[] = [];
  const byKey = new Map(existing.map((i) => [i.key, i]));
  const live = new Set(conditions.map((c) => c.key));
  const out: Incident[] = [];

  const alert = (incident: Incident, event: IncidentAlert["event"], detail: string): void => {
    alerts.push({
      event,
      incidentId: incident.id,
      key: incident.key,
      title: incident.title,
      detail,
      severity: incident.severity,
      at,
      suppressed: !shouldNotify(policy, incident.severity, now),
    });
  };

  for (const condition of conditions) {
    const prior = byKey.get(condition.key);

    if (!prior) {
      const opened: Incident = {
        id: incidentId(condition.key),
        key: condition.key,
        source: condition.source,
        severity: condition.severity,
        title: condition.title,
        detail: condition.detail,
        status: "open",
        openedAt: at,
        updatedAt: at,
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        level: 0,
        nextEscalationAt: escalationDue(policy, 0, at),
        timeline: [
          event("opened", `${policy.levels[0]?.label ?? "Notify"}: ${condition.detail}`, at),
        ],
        diagnosis: null,
        scheduleId: condition.scheduleId,
        runId: condition.runId,
        fingerprint: condition.fingerprint,
      };
      out.push(opened);
      alert(opened, "incident.opened", condition.detail);
      continue;
    }

    // The condition is still live. A resolved incident whose condition came
    // back reopens rather than opening a second one: the history of a recurring
    // problem is the most useful thing about it.
    if (prior.status === "resolved") {
      let reopened: Incident = {
        ...prior,
        status: "open",
        severity: condition.severity,
        detail: condition.detail,
        resolvedAt: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        level: 0,
        nextEscalationAt: escalationDue(policy, 0, at),
      };
      reopened = appendEvent(reopened, event("reopened", condition.detail, at));
      out.push(reopened);
      alert(reopened, "incident.opened", `recurred: ${condition.detail}`);
      continue;
    }

    // Escalate an unacknowledged incident whose clock has run out.
    let current: Incident = { ...prior, detail: condition.detail, severity: condition.severity };
    if (
      current.status === "open" &&
      current.nextEscalationAt !== null &&
      Date.parse(current.nextEscalationAt) <= now.getTime()
    ) {
      const level = current.level + 1;
      const label = policy.levels[level]?.label ?? "Escalate";
      current = {
        ...current,
        level,
        nextEscalationAt: escalationDue(policy, level, at),
      };
      current = appendEvent(current, event("escalated", label, at));
      alert(current, "incident.escalated", label);
    }
    out.push(current);
  }

  // Conditions that have cleared: resolve, once.
  for (const prior of existing) {
    if (live.has(prior.key)) continue;
    if (prior.status === "resolved") {
      out.push(prior);
      continue;
    }
    let resolved: Incident = {
      ...prior,
      status: "resolved",
      resolvedAt: at,
      nextEscalationAt: null,
    };
    resolved = appendEvent(resolved, event("resolved", "the condition cleared", at));
    out.push(resolved);
    alert(resolved, "incident.resolved", "the condition cleared");
  }

  return { incidents: prune(out, now), alerts };
}

/** Drop resolved incidents past the retention window, then cap the list. */
function prune(incidents: Incident[], now: Date): Incident[] {
  const floor = now.getTime() - RESOLVED_RETENTION_MS;
  const kept = incidents.filter(
    (i) => i.status !== "resolved" || Date.parse(i.resolvedAt ?? i.updatedAt) >= floor,
  );
  kept.sort((a, b) => {
    // Live incidents first, newest within each group: the list is read
    // top-down under pressure.
    const rank = (i: Incident) => (i.status === "resolved" ? 1 : 0);
    return rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt);
  });
  return kept.slice(0, INCIDENT_KEEP);
}

// ── Human actions ───────────────────────────────────────────────────────────

/** Acknowledge: stop the escalation clock, record who stopped it. */
export function acknowledge(incident: Incident, by: string, now: Date): Incident {
  const at = now.toISOString();
  return appendEvent(
    {
      ...incident,
      status: "acknowledged",
      acknowledgedAt: at,
      acknowledgedBy: by,
      nextEscalationAt: null,
    },
    event("acknowledged", "acknowledged", at, `user:${by}`),
  );
}

/**
 * Resolve by hand.
 *
 * Note that reconciliation will **reopen** this on the next tick if the
 * underlying condition is still live — which is correct, and the timeline says
 * so rather than silently undoing the click.
 */
export function resolveByHand(incident: Incident, by: string, note: string, now: Date): Incident {
  const at = now.toISOString();
  return appendEvent(
    { ...incident, status: "resolved", resolvedAt: at, nextEscalationAt: null },
    event("resolved", note || "resolved by hand", at, `user:${by}`),
  );
}

export function addNote(incident: Incident, by: string, note: string, now: Date): Incident {
  return appendEvent(incident, event("note", note, now.toISOString(), `user:${by}`));
}

export function attachDiagnosis(incident: Incident, diagnosis: Diagnosis, now: Date): Incident {
  const at = now.toISOString();
  return appendEvent(
    { ...incident, diagnosis },
    event(
      "diagnosed",
      diagnosis.status === "ready"
        ? (diagnosis.findings ?? "diagnostic completed")
        : `diagnostic did not complete: ${diagnosis.error ?? "unknown reason"}`,
      at,
    ),
  );
}

export function summarize(incidents: Incident[]) {
  return {
    open: incidents.filter((i) => i.status === "open").length,
    acknowledged: incidents.filter((i) => i.status === "acknowledged").length,
    resolved: incidents.filter((i) => i.status === "resolved").length,
    critical: incidents.filter((i) => i.status !== "resolved" && i.severity === "critical").length,
  };
}
