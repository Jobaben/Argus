/**
 * What an instance's status means, named once.
 *
 * Since a gate pauses only its own phase, an instance can read
 * `awaiting-approval` while sibling phases keep running, and every question of
 * the form "is this instance still going?" or "is a human needed?" has two
 * spellings that must agree. They are asked here, never inline, so a new path
 * cannot answer one of them differently (`engine/instanceStatus.test.ts`).
 *
 * A spawn phase stays `running` while its children run, so its parent's
 * status never says that a child waits at a gate of its own: `inFlight` reads
 * the phase's tasks to tell a parent that only waits on people apart.
 *
 * Not in `engine/`: the transitions, the sources, the scheduler and the
 * federation summary ask the same questions and may not import the engine.
 */
import type { InstanceStatus, PipelineInstance, SpawnTaskState } from "./pipelineTypes.js";

type Phased = Pick<PipelineInstance, "phases">;

/** The engine may still act on the instance's phases: a sibling paused at a
 *  gate does not stop the rest of the instance. */
export const resumable = (status: InstanceStatus | string): boolean =>
  status === "running" || status === "awaiting-approval";

/** The instance has ended and will never move again. */
export const isTerminal = (status: InstanceStatus | string): boolean =>
  status === "succeeded" || status === "failed" || status === "aborted";

/**
 * Results (check reports, a candidate's verification) are applied only while
 * no gate waits: with a decision pending, they wait for it rather than change
 * the graph under the human deciding.
 */
export const appliesResults = (status: InstanceStatus | string): boolean => status === "running";

/** Some phase waits on a human, by its phases, not by the instance's status. */
export function hasWaitingGate(inst: Pick<PipelineInstance, "status" | "phases">): boolean {
  return !isTerminal(inst.status) && inst.phases.some((p) => p.status === "awaiting-approval");
}

/** A failed phase whose automatic retry is scheduled: the instance is not over. */
export function pendingRetry(inst: Phased): boolean {
  return inst.phases.some((p) => p.status === "failed" && !!p.retryAt);
}

/**
 * A spawn phase's task whose child is started or owed a start, and not
 * finished: it holds one of the phase's `maxParallel` slots. Spelled here and
 * not in `sources/children.ts`, which imports this module: `dag.ts` imports
 * this module too, and `children.ts` imports `dag.ts`.
 */
export function isLiveTask(state: SpawnTaskState): boolean {
  return (
    state === "planned" ||
    state === "reviving" ||
    state === "running" ||
    state === "awaiting-approval"
  );
}

/** A running spawn phase that waits only on people: it has live tasks, and
 *  each one is a child waiting at a gate of its own. */
function waitsOnChildGates(phase: PipelineInstance["phases"][number]): boolean {
  const live = (phase.children?.tasks ?? []).filter((t) => isLiveTask(t.state));
  return live.length > 0 && live.every((t) => t.state === "awaiting-approval");
}

/**
 * Something moves without waiting on a human: a phase is running (a spawn
 * phase counts only while one of its live children is not waiting at its own
 * gate), a retry is scheduled, or, with no phase running, no gate pauses the
 * instance. An instance paused only at its gates, or only at its children's,
 * is live but not in flight.
 */
export function inFlight(inst: Pick<PipelineInstance, "status" | "phases">): boolean {
  if (!resumable(inst.status)) return false;
  if (pendingRetry(inst)) return true;
  const running = inst.phases.filter((p) => p.status === "running");
  if (running.length > 0) return running.some((p) => !waitsOnChildGates(p));
  return appliesResults(inst.status);
}

/**
 * The status of an instance that has not ended, derived from its phases:
 * `awaiting-approval` while any phase waits at a gate, else `running`. The one
 * derivation every transition that keeps an instance live writes.
 */
export function liveStatus(inst: Phased): "running" | "awaiting-approval" {
  return inst.phases.some((p) => p.status === "awaiting-approval")
    ? "awaiting-approval"
    : "running";
}
