import type { PipelineDefinition, PipelineInstance, InstanceStatus } from "./pipelineTypes.js";
import type { Run } from "./scheduleTypes.js";
import type { ActivityEvent } from "../runTailer.js";

/** Aggregated spend for one instance. Null field = no run reported that metric. */
export interface OverviewCost {
  usd: number | null;
  tokens: number | null;
}

export interface OverviewEntry {
  definition: PipelineDefinition;
  latest: PipelineInstance | null;
  /** Total spend of the latest instance across all its runs (including
   *  superseded revise attempts). Null when there is no instance. */
  cost: OverviewCost | null;
}

// Lower rank sorts first: states needing human action come first
// (awaiting-approval, then failed — both are paused awaiting a human), then
// running, then terminal success/aborted; a definition with no instance ranks
// last. Statuses not listed (succeeded/aborted) take the default rank.
const ATTENTION_RANK: Partial<Record<InstanceStatus, number>> = {
  "awaiting-approval": 0,
  failed: 1,
  running: 2,
};

function rank(latest: PipelineInstance | null): number {
  if (!latest) return 4;
  return ATTENTION_RANK[latest.status] ?? 3;
}

/** Copy the run's cost/token/timing metrics — and, while running, its latest
 *  tailer activity — onto each step that has a run record. */
function enrichSteps(
  inst: PipelineInstance,
  byRunId: Map<string, Run>,
  activity?: Map<string, ActivityEvent>,
): PipelineInstance {
  return {
    ...inst,
    phases: inst.phases.map((p) => ({
      ...p,
      steps: p.steps.map((s) => {
        const run = s.runId ? byRunId.get(s.runId) : undefined;
        if (!run) return s;
        const act = s.status === "running" && s.runId ? activity?.get(s.runId) : undefined;
        return {
          ...s,
          costUsd: run.costUsd ?? null,
          tokens: run.tokens ?? null,
          startedAt: run.startedAt ?? null,
          durationMs: run.durationMs ?? null,
          ...(act ? { currentActivity: act.label, activityAt: act.at } : {}),
        };
      }),
    })),
  };
}

/** Sum reported cost/tokens over every run of the instance — including runs
 *  from earlier revise attempts no longer referenced by the step list. */
function instanceCost(instanceId: string, runs: Run[]): OverviewCost {
  let usd: number | null = null;
  let tokens: number | null = null;
  for (const r of runs) {
    if (r.instanceId !== instanceId) continue;
    if (typeof r.costUsd === "number") usd = (usd ?? 0) + r.costUsd;
    if (typeof r.tokens === "number") tokens = (tokens ?? 0) + r.tokens;
  }
  return { usd, tokens };
}

/**
 * Pair each definition with its latest instance and sort attention-first.
 * `instances` is expected newest-first (createdAt desc), as readInstances returns;
 * the first instance seen per pipelineId is therefore its latest.
 * `runs` (when given) joins per-step cost/tokens/timing onto the latest
 * instance and totals the instance's spend. `activity` (when given) further
 * joins each running step's latest tailer event.
 */
export function buildOverview(
  definitions: PipelineDefinition[],
  instances: PipelineInstance[],
  runs: Run[] = [],
  activity?: Map<string, ActivityEvent>,
): OverviewEntry[] {
  const latestByPipeline = new Map<string, PipelineInstance>();
  for (const i of instances) {
    if (!latestByPipeline.has(i.pipelineId)) latestByPipeline.set(i.pipelineId, i);
  }
  const byRunId = new Map(runs.map((r) => [r.id, r]));
  const entries: OverviewEntry[] = definitions.map((definition) => {
    const latest = latestByPipeline.get(definition.id) ?? null;
    return {
      definition,
      latest: latest ? enrichSteps(latest, byRunId, activity) : null,
      cost: latest ? instanceCost(latest.id, runs) : null,
    };
  });
  return entries.sort((a, b) => {
    const r = rank(a.latest) - rank(b.latest);
    if (r !== 0) return r;
    const au = a.latest?.updatedAt ?? "";
    const bu = b.latest?.updatedAt ?? "";
    if (au !== bu) return bu.localeCompare(au);
    return a.definition.name.localeCompare(b.definition.name);
  });
}
