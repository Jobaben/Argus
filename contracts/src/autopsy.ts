/**
 * Autopsy: an automatic postmortem for every failed run.
 *
 * A failed run leaves an error string and a transcript. Turning those into
 * "what actually went wrong, where, and what to change" is work someone does by
 * hand at 9am, badly, for the third time this week. Autopsy does the same pass
 * automatically, bounded, and attaches the result to the run.
 *
 * Everything it produces is a *proposal*. The failure class is a guess, the
 * span is a guess, and the prompt delta is emphatically a guess — so the
 * relaunch it enables is behind the same admin gate as any other agent spawn,
 * and the UI never presents any of it as fact.
 */

/**
 * The failure taxonomy.
 *
 * Deliberately small and closed. An open-ended "class" field produces a
 * different phrasing every time and cannot be clustered, counted, or filtered —
 * which is most of the value. `other` exists so the model has somewhere honest
 * to put what it doesn't recognise, rather than forcing a wrong bucket.
 */
export type FailureClass =
  | "prompt-ambiguity"
  | "missing-context"
  | "tool-error"
  | "permission-denied"
  | "environment"
  | "timeout"
  | "rate-limit"
  | "model-refusal"
  | "bad-output-format"
  | "infrastructure"
  | "other";

export type AutopsyStatus = "pending" | "ready" | "failed" | "skipped";

/** Where in the recording it went wrong, as an offset span the scrubber can use. */
export interface AutopsySpan {
  /** Milliseconds from the recording origin. */
  fromMs: number;
  toMs: number;
  /** What the model saw there, quoted back so the claim is checkable. */
  quote: string;
}

export interface Autopsy {
  runId: string;
  scheduleId: string;
  scheduleName: string;
  status: AutopsyStatus;
  /** When the pass ran. */
  at: string;
  failureClass: FailureClass | null;
  /** How sure the pass is, 0–1. Low confidence still shows — hidden uncertainty
   *  is worse than visible uncertainty — but the UI says so. */
  confidence: number | null;
  /** One paragraph. Not a bulleted plan; the reader wants the story. */
  why: string | null;
  span: AutopsySpan | null;
  /** A concrete proposed replacement prompt, or null when the pass had none. */
  promptDelta: string | null;
  /** One line on what the delta changes and why. */
  deltaRationale: string | null;
  /** What the pass cost, so it is never invisible. */
  costUsd: number | null;
  tokens: number | null;
  durationMs: number | null;
  /** Why there is no verdict, when `status` is not `ready`. */
  error: string | null;
}

export interface AutopsyResponse {
  autopsy: Autopsy | null;
  /** True when this run is a failure and could have one. */
  eligible: boolean;
  /** Why an autopsy cannot be produced right now, if it can't. */
  unavailable: string | null;
}
