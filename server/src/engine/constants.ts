import type { PhaseProgress } from "../sources/pipelineTypes.js";

/** Phase statuses from which a phase never moves again. */
export const TERMINAL_PHASE: PhaseProgress["status"][] = [
  "succeeded",
  "failed",
  "skipped",
  "aborted",
];

/** Instance statuses whose running phases the engine may still act on: a
 *  sibling paused at a gate does not stop the rest of the instance. */
export const resumable = (status: string) => status === "running" || status === "awaiting-approval";

/** The largest `maxAttempts` an author may configure, and the default. */
export const REALIZATION_ATTEMPT_CAP = 8;

export const DEFAULT_REALIZATION_ATTEMPTS = 2;
