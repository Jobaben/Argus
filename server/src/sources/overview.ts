import type { PipelineDefinition, PipelineInstance, InstanceStatus } from "./pipelineTypes.js";

export interface OverviewEntry {
  definition: PipelineDefinition;
  latest: PipelineInstance | null;
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

/**
 * Pair each definition with its latest instance and sort attention-first.
 * `instances` is expected newest-first (createdAt desc), as readInstances returns;
 * the first instance seen per pipelineId is therefore its latest.
 */
export function buildOverview(
  definitions: PipelineDefinition[],
  instances: PipelineInstance[],
): OverviewEntry[] {
  const latestByPipeline = new Map<string, PipelineInstance>();
  for (const i of instances) {
    if (!latestByPipeline.has(i.pipelineId)) latestByPipeline.set(i.pipelineId, i);
  }
  const entries: OverviewEntry[] = definitions.map((definition) => ({
    definition,
    latest: latestByPipeline.get(definition.id) ?? null,
  }));
  return entries.sort((a, b) => {
    const r = rank(a.latest) - rank(b.latest);
    if (r !== 0) return r;
    const au = a.latest?.updatedAt ?? "";
    const bu = b.latest?.updatedAt ?? "";
    if (au !== bu) return bu.localeCompare(au);
    return a.definition.name.localeCompare(b.definition.name);
  });
}
