import type { PipelineDefinition, PipelineInstance, InstanceStatus } from "./pipelineTypes.js";
import type { Run } from "./scheduleTypes.js";
import type { ActivityEvent } from "../runTailer.js";
import type { OverviewCost, OverviewEntry } from "@argus/contracts";
import { resumable } from "./instanceStatus.js";

export type { OverviewCost, OverviewEntry } from "@argus/contracts";

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
          model: run.model ?? null,
          runtime: run.runtime ?? null,
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
 * What the board shows for a deleted pipeline: the instance's own snapshot, or
 * for an instance written before snapshots a stand-in with no phases (the board
 * then draws the graph from the instance's recorded edges, as it does for a
 * phase an edit removed).
 */
function orphanDefinition(inst: PipelineInstance): PipelineDefinition {
  return (
    inst.definition ?? {
      id: inst.pipelineId,
      name: inst.pipelineName,
      phases: [],
      trigger: null,
      enabled: false,
      overlapPolicy: "allow",
      lastStartedAt: inst.createdAt,
      createdAt: inst.createdAt,
      updatedAt: inst.updatedAt,
    }
  );
}

/**
 * Pair each definition with its latest instance and sort attention-first.
 * `instances` is expected newest-first (createdAt desc), as readInstances returns;
 * the first instance seen per pipelineId is therefore its latest.
 * `runs` (when given) joins per-step cost/tokens/timing onto the latest
 * instance and totals the instance's spend. `activity` (when given) further
 * joins each running step's latest tailer event.
 *
 * Live instances of a pipeline that has since been deleted get an entry too,
 * marked `orphaned`: without one they would have no card and no abort control,
 * while the gate counts (`insight.ts`) would still count them.
 */
export function buildOverview(
  definitions: PipelineDefinition[],
  instances: PipelineInstance[],
  runs: Run[] = [],
  activity?: Map<string, ActivityEvent>,
): OverviewEntry[] {
  const byPipeline = new Map<string, PipelineInstance[]>();
  for (const i of instances) {
    const list = byPipeline.get(i.pipelineId);
    if (list) list.push(i);
    else byPipeline.set(i.pipelineId, [i]);
  }
  // The board's concurrent generation: non-terminal instances plus terminal
  // ones that overlapped the latest instance's lifetime (ended at/after its
  // start), so a just-stopped sibling stays visible beside its peers. A lone
  // latest instance keeps the classic single-card fallback (empty active).
  const boardInstances = (list: PipelineInstance[]): PipelineInstance[] => {
    const latest = list[0];
    if (!latest) return [];
    const overlapping = list.filter(
      (i) => resumable(i.status) || (i.endedAt !== null && i.endedAt >= latest.createdAt),
    );
    return overlapping.length > 1 ? overlapping : list.filter((i) => resumable(i.status));
  };
  const byRunId = new Map(runs.map((r) => [r.id, r]));
  const entry = (definition: PipelineDefinition, list: PipelineInstance[]): OverviewEntry => {
    const latest = list[0] ?? null;
    return {
      definition,
      latest: latest ? enrichSteps(latest, byRunId, activity) : null,
      cost: latest ? instanceCost(latest.id, runs) : null,
      active: boardInstances(list).map((i) => ({
        instance: enrichSteps(i, byRunId, activity),
        cost: instanceCost(i.id, runs),
      })),
    };
  };
  const entries: OverviewEntry[] = definitions.map((definition) =>
    entry(definition, byPipeline.get(definition.id) ?? []),
  );
  const defined = new Set(definitions.map((d) => d.id));
  for (const [pipelineId, list] of byPipeline) {
    if (defined.has(pipelineId)) continue;
    const live = list.filter((i) => resumable(i.status));
    if (live.length === 0) continue;
    entries.push({ ...entry(orphanDefinition(live[0]), live), orphaned: true });
  }
  return entries.sort((a, b) => {
    const r = rank(a.latest) - rank(b.latest);
    if (r !== 0) return r;
    const au = a.latest?.updatedAt ?? "";
    const bu = b.latest?.updatedAt ?? "";
    if (au !== bu) return bu.localeCompare(au);
    return a.definition.name.localeCompare(b.definition.name);
  });
}
