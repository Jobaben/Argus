/**
 * What an instance's status means, named once.
 *
 * Since a gate pauses only its own phase, an instance can read
 * `awaiting-approval` while sibling phases keep running, and every question of
 * the form "is this instance still going?" or "is a human needed?" has two
 * spellings that must agree. They are asked here, never inline, so a new path
 * cannot answer one of them differently (`engine/instanceStatus.test.ts`).
 *
 * Not in `engine/`: the transitions, the sources, the scheduler and the
 * federation summary ask the same questions and may not import the engine.
 */
import type { InstanceStatus, PipelineInstance } from "./pipelineTypes.js";

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
 * Something moves without waiting on a human: no gate pauses the instance, a
 * phase is running beside one, or a retry is scheduled. An instance paused
 * only at its gates is live but not in flight.
 */
export function inFlight(inst: Pick<PipelineInstance, "status" | "phases">): boolean {
  if (!resumable(inst.status)) return false;
  return (
    appliesResults(inst.status) ||
    inst.phases.some((p) => p.status === "running") ||
    pendingRetry(inst)
  );
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
