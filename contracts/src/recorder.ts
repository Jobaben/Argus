/**
 * The Flight Recorder: a run rendered as a scrubbable causal timeline.
 *
 * A transcript on disk is a JSONL wall — thousands of lines where the one that
 * matters is indistinguishable from the ones that don't. A recording is the
 * same information as a *recording*: every tool call, file diff, token burst
 * and cost tick placed on one time axis, so "what was it doing at 00:42" and
 * "where did it go wrong" are both a scrub away.
 *
 * Everything here is derived. The transcript and the run record stay the source
 * of truth; a recording is rebuilt on every read and never persisted.
 */

import type { RunOutcome, RunStatus } from "./schedules.js";

/**
 * Which horizontal band an event is drawn in. The timeline is one track (one
 * shared time axis, one scrubber); lanes only decide vertical placement so a
 * burst of file writes doesn't bury the tool call that caused it.
 */
export type RecorderLane = "agent" | "tool" | "file" | "spend";

export type RecorderEventKind =
  "start" | "prompt" | "thinking" | "text" | "tool" | "file" | "usage" | "error" | "end";

export interface RecorderEvent {
  /** Stable within a recording, and what a deep link addresses. */
  id: string;
  /** Milliseconds from the recording origin. Monotonic, non-decreasing. */
  atMs: number;
  /** Wall clock, for the tooltip and for correlating with other views. */
  at: string;
  lane: RecorderLane;
  kind: RecorderEventKind;
  /** One-line label, already clipped for display. */
  label: string;
  /** Longer body: the command, the message excerpt, the error text. */
  detail?: string;
  /** Tool-call → tool-result latency, when both halves are in the transcript. */
  durationMs?: number;
  /** The tool that produced this event (`tool` and `file` lanes). */
  tool?: string;
  /** File events: the path and the shape of the diff. */
  path?: string;
  added?: number;
  removed?: number;
  /** Usage events: this burst, and the running total. */
  tokens?: number;
  tokensTotal?: number;
  /** Spend events: this tick's USD, and the running total. */
  costUsd?: number;
  costTotalUsd?: number;
  /** The tool call came back `is_error`. */
  errored?: boolean;
}

export interface RecorderLaneSummary {
  lane: RecorderLane;
  label: string;
  count: number;
}

export interface RecorderTotals {
  tools: number;
  files: number;
  errors: number;
  tokens: number | null;
  costUsd: number | null;
}

/** Why a run has no timeline. Each maps to an empty state that says what to do. */
export type RecorderUnavailable =
  "no-session" | "no-transcript" | "empty-transcript" | "not-started";

export interface Recording {
  runId: string;
  scheduleId: string;
  scheduleName: string;
  status: RunStatus;
  outcome: RunOutcome | null;
  sessionId: string | null;
  project: string | null;
  /** Scrubber origin — the run's start, falling back to the first line. */
  startedAt: string | null;
  endedAt: string | null;
  /** Scrubber length. Always at least the last event's `atMs`. */
  durationMs: number;
  events: RecorderEvent[];
  lanes: RecorderLaneSummary[];
  /** Index into `events` of where it went wrong, or null when nothing did. */
  failureIndex: number | null;
  totals: RecorderTotals;
  /** Per-event cost is apportioned from the run total by token share, not
   *  measured — the CLI reports one figure for the whole run. */
  costEstimated: boolean;
  /** Earlier events were dropped to stay under the event cap. */
  truncated: boolean;
  /** Set when `events` is empty and the reason is knowable. */
  unavailable: RecorderUnavailable | null;
}
