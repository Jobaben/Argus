/**
 * Stall detection: a step whose process is still alive but whose transcript
 * has gone quiet for too long.
 *
 * `timeoutSeconds` catches a step that runs forever; it says nothing about one
 * that is merely *stuck* — spinning on a tool call, waiting on a hung
 * subprocess, or wedged in a loop that produces no output — well inside a
 * generous timeout budget. Stuck-detection is close to universal in the
 * harnesses the research survey looked at (OpenHands, Symphony;
 * docs/HARNESS-RESEARCH.md §2 #7), and Argus already has the raw material:
 * the run tailer's own notion of "when did this run last say anything".
 *
 * Pure: {@link isStalled} only answers the question. The engine (reusing its
 * existing deadline/reconcile machinery, never a second timer system) decides
 * when to ask it and what to do with "yes".
 */

import type { PhaseDef, PhaseStep } from "../sources/pipelineTypes.js";

/** A step's limit, else its phase's, else off. Mirrors
 *  `resolveTimeoutSeconds` in harness/invocation.ts. */
export function resolveStallSeconds(
  phaseDef: Pick<PhaseDef, "stallSeconds">,
  stepDef: Pick<PhaseStep, "stallSeconds">,
): number | null {
  return stepDef.stallSeconds ?? phaseDef.stallSeconds ?? null;
}

export interface StallCheck {
  /** Absent/null = stall detection is off for this run. */
  stallSeconds: number | null;
  /** The last time the run tailer observed new activity, persisted. */
  lastActivityAt: string | null;
  /** Fallback reference when no activity has been observed yet. */
  startedAt: string | null;
  now: Date;
}

/**
 * Has this run gone quiet for at least `stallSeconds`, measured from its last
 * observed activity (or its start, if none has been observed yet)?
 */
export function isStalled(input: StallCheck): boolean {
  if (!input.stallSeconds || input.stallSeconds <= 0) return false;
  const ref = input.lastActivityAt ?? input.startedAt;
  if (!ref) return false;
  const refMs = Date.parse(ref);
  if (Number.isNaN(refMs)) return false;
  return input.now.getTime() - refMs >= input.stallSeconds * 1000;
}
