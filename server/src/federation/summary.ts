import type {
  Incident,
  MachineFacets,
  MachineSummary,
  MonitorHealth,
  PeerIssue,
  PeerPipeline,
  PeerRun,
} from "@argus/contracts";
import type { Issue } from "../sources/issues.js";
import type { PipelineInstance } from "../sources/pipelineTypes.js";
import type { Run } from "../sources/scheduleTypes.js";
import type { BudgetStatus } from "@argus/contracts";

/**
 * What one machine tells its peers about itself.
 *
 * Deliberately a summary and not a feed. Three constraints shape it.
 *
 * **It is bounded on every axis.** Headline counts, plus a capped facet list
 * per fleet-wide view — twelve pipelines, twelve issues, forty recent runs,
 * every string clamped. No array grows with the machine's activity, so a busy
 * peer cannot make its neighbours' polling expensive.
 *
 * **It carries labels, not payloads.** A pipeline's name and status travel; its
 * prompts, working directory and session ids do not. Opening a run means
 * opening that machine's own Argus, which is the right place for it to be.
 *
 * **It is derived per request.** Nothing is stored, so a machine cannot serve a
 * summary that is quietly older than it claims.
 *
 * The facet lists are a revision of a stricter first version that sent counts
 * only. Counts cannot make Command Center, Chronicle, Issues and Budget
 * fleet-wide, and a fleet view that can only say "seven issues somewhere" is a
 * worse product than one that names them. What makes it safe is not the absence
 * of detail but who receives it: a peer you paired with by hand, over a channel
 * sealed with the secret you carried between the two machines.
 */

/** Facet caps. Small enough that a summary stays a summary. */
export const FACET_PIPELINES = 12;
export const FACET_ISSUES = 12;
export const FACET_RUNS = 40;
const LABEL_CAP = 80;

const clamp = (s: unknown, n = LABEL_CAP): string => (typeof s === "string" ? s.slice(0, n) : "");

export interface SummaryInput {
  machineId: string;
  label: string;
  version: string;
  schedules: number;
  monitors: MonitorHealth[];
  issues: Issue[];
  instances: PipelineInstance[];
  runs: Run[];
  incidents: Incident[];
  budget: BudgetStatus;
  now: Date;
}

/** Local calendar day, matching the convention budgets and triggers already use. */
function isToday(iso: string | null | undefined, now: Date): boolean {
  if (!iso) return false;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return false;
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The bounded detail the fleet-wide views read. Pure. */
export function buildFacets(input: SummaryInput): MachineFacets {
  const pipelines: PeerPipeline[] = input.instances
    .filter((i) => i.status === "running" || i.status === "awaiting-approval")
    .slice(0, FACET_PIPELINES)
    .map((i) => ({
      id: i.id,
      name: clamp(i.pipelineName),
      status: i.status,
      phase:
        clamp(
          i.phases?.find((p) => p.status === "running" || p.status === "awaiting-approval")?.id,
        ) || null,
    }));

  const issues: PeerIssue[] = input.issues
    .filter((i) => i.state === "open")
    // Loudest first: a cap that kept an arbitrary twelve would hide the ones
    // worth crossing a machine boundary for.
    .slice()
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, FACET_ISSUES)
    .map((i) => ({
      fingerprint: i.fingerprint,
      title: clamp(i.title, 140),
      count: i.count,
      lastSeen: i.lastSeen,
    }));

  const recentRuns: PeerRun[] = input.runs
    .slice()
    .sort((a, b) => moment(b).localeCompare(moment(a)))
    .slice(0, FACET_RUNS)
    .map((r) => ({
      id: r.id,
      // The schedule's name, never the prompt: a prompt is the one field on a
      // run that is certain to contain something its author wrote for one
      // machine's eyes.
      label: clamp(r.scheduleName || r.scheduleId),
      status: r.outcome === "failed" ? "failed" : r.status,
      at: moment(r),
      durationMs: r.durationMs ?? null,
    }));

  return {
    pipelines,
    issues,
    recentRuns,
    budget: {
      state: input.budget.state,
      dailyLimitUsd: input.budget.today.limitUsd,
      monthlyLimitUsd: input.budget.month.limitUsd,
    },
  };
}

const moment = (r: Run): string => r.endedAt ?? r.startedAt ?? r.queuedAt;

export function buildSummary(input: SummaryInput): MachineSummary {
  const today = input.runs.filter((r) =>
    isToday(r.endedAt ?? r.startedAt ?? r.queuedAt, input.now),
  );

  const open = input.incidents.filter((i) => i.status !== "resolved");
  // Critical beats warning, and among equals the most recent — the headline
  // should move when something worse happens, not stick on the first thing.
  const worst =
    open
      .slice()
      .sort(
        (a, b) =>
          Number(b.severity === "critical") - Number(a.severity === "critical") ||
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      )[0] ?? null;

  return {
    machineId: input.machineId,
    label: input.label,
    version: input.version,
    generatedAt: input.now.toISOString(),
    schedules: input.schedules,
    monitorsDown: input.monitors.filter((m) => m.status === "down").length,
    monitorsFailing: input.monitors.filter((m) => m.status === "failing").length,
    openIssues: input.issues.filter((i) => i.state === "open").length,
    liveInstances: input.instances.filter((i) => i.status === "running").length,
    gatedInstances: input.instances.filter((i) => i.status === "awaiting-approval").length,
    runsToday: today.length,
    failuresToday: today.filter((r) => r.status === "failed" || r.outcome === "failed").length,
    spendTodayUsd: round2(input.budget.today.spentUsd),
    spendMonthUsd: round2(input.budget.month.spentUsd),
    // The title, not the detail: enough to know something is wrong here and
    // worth opening, without shipping the failure text to another machine.
    worstIncident: worst ? `${worst.severity}: ${worst.title}` : null,
    facets: buildFacets(input),
  };
}

/** Validate a summary received from a peer. Never trust a shape off the wire. */
export function parseSummary(raw: unknown): MachineSummary | null {
  const r = (raw ?? {}) as Partial<MachineSummary>;
  if (typeof r.machineId !== "string" || !r.machineId) return null;
  if (typeof r.generatedAt !== "string" || !Number.isFinite(Date.parse(r.generatedAt))) return null;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    machineId: r.machineId,
    // A peer naming itself is fine; a peer naming itself in 4 KB of markup is
    // not, so the label is clamped like every other string that crosses in.
    label: typeof r.label === "string" ? r.label.slice(0, 60) : r.machineId.slice(0, 8),
    version: typeof r.version === "string" ? r.version.slice(0, 20) : "unknown",
    generatedAt: r.generatedAt,
    schedules: n(r.schedules),
    monitorsDown: n(r.monitorsDown),
    monitorsFailing: n(r.monitorsFailing),
    openIssues: n(r.openIssues),
    liveInstances: n(r.liveInstances),
    gatedInstances: n(r.gatedInstances),
    runsToday: n(r.runsToday),
    failuresToday: n(r.failuresToday),
    spendTodayUsd: n(r.spendTodayUsd),
    spendMonthUsd: n(r.spendMonthUsd),
    worstIncident: typeof r.worstIncident === "string" ? r.worstIncident.slice(0, 140) : null,
    facets: parseFacets(r.facets),
  };
}

const EMPTY_FACETS: MachineFacets = {
  pipelines: [],
  issues: [],
  recentRuns: [],
  budget: { state: "unset", dailyLimitUsd: null, monthlyLimitUsd: null },
};

/**
 * Validate the facet payload from a peer.
 *
 * The caps are re-applied here, not just at the sender. A peer is a machine you
 * trust to be yours, not one you trust to be correct — a bug or an older build
 * on the other side must not be able to make this machine render four thousand
 * rows.
 */
export function parseFacets(raw: unknown): MachineFacets {
  const f = (raw ?? {}) as Partial<MachineFacets>;
  const list = <T>(v: unknown, cap: number, map: (x: Record<string, unknown>) => T | null): T[] =>
    (Array.isArray(v) ? v : [])
      .slice(0, cap)
      .map((x) => map((x ?? {}) as Record<string, unknown>))
      .filter((x): x is T => x !== null);

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const limit = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  const budget = (f.budget ?? {}) as Record<string, unknown>;

  return {
    pipelines: list(f.pipelines, FACET_PIPELINES, (p) =>
      typeof p.id === "string" && p.id
        ? {
            id: p.id.slice(0, 80),
            name: clamp(p.name),
            status: clamp(p.status, 24),
            phase: typeof p.phase === "string" ? p.phase.slice(0, 80) : null,
          }
        : null,
    ),
    issues: list(f.issues, FACET_ISSUES, (i) =>
      typeof i.fingerprint === "string" && i.fingerprint
        ? {
            fingerprint: i.fingerprint.slice(0, 120),
            title: clamp(i.title, 140),
            count: Math.max(0, Math.round(num(i.count))),
            lastSeen: clamp(i.lastSeen, 40),
          }
        : null,
    ),
    recentRuns: list(f.recentRuns, FACET_RUNS, (r) =>
      typeof r.id === "string" && r.id
        ? {
            id: r.id.slice(0, 80),
            label: clamp(r.label),
            status: clamp(r.status, 24),
            at: clamp(r.at, 40),
            durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
          }
        : null,
    ),
    budget: {
      state: clamp(budget.state, 24) || EMPTY_FACETS.budget.state,
      dailyLimitUsd: limit(budget.dailyLimitUsd),
      monthlyLimitUsd: limit(budget.monthlyLimitUsd),
    },
  };
}
