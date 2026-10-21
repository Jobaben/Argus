import type { PhaseProgress } from "../sources/pipelineTypes.js";

/** Phase statuses from which a phase never moves again. */
export const TERMINAL_PHASE: PhaseProgress["status"][] = [
  "succeeded",
  "failed",
  "skipped",
  "aborted",
];

/** The largest `maxAttempts` an author may configure, and the default. */
export const REALIZATION_ATTEMPT_CAP = 8;

export const DEFAULT_REALIZATION_ATTEMPTS = 2;

/** The longest revise note Argus keeps. The decision record and every prompt
 *  that repeats the note carry at most this much of it. */
export const REVISE_NOTE_MAX = 2000;

/** The most a phase's revision notes may add to one prompt. Past it, the
 *  oldest note and the newest that fit stay, and all of them go in a file. */
export const REVISION_NOTES_MAX_CHARS = 8000;
