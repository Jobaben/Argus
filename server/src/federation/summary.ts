import type { Incident, MachineSummary, MonitorHealth } from "@argus/contracts";
import type { Issue } from "../sources/issues.js";
import type { PipelineInstance } from "../sources/pipelineTypes.js";
import type { Run } from "../sources/scheduleTypes.js";
import type { BudgetStatus } from "@argus/contracts";

/**
 * What one machine tells its peers about itself.
 *
 * Deliberately a summary and not a feed. Three constraints shaped it:
 *
 * **It is counts, not records.** No prompts, no error text, no schedule names,
 * no session ids. A peer summary crosses a network and lands on a machine the
 * author of a run may not have thought about; "seven open issues" answers the
 * fleet-level question without moving anybody's data. Clicking through to the
 * detail means opening that machine's own Argus, which is the right place for
 * it to be.
 *
 * **It is small and fixed-size.** No arrays that grow with the fleet's
 * activity, so a busy machine cannot make its peers' polling expensive.
 *
 * **It is derived per request.** Nothing is stored, so a machine cannot serve a
 * summary that is quietly older than it claims.
 */

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
  };
}
