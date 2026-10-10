import type { RecorderEvent } from "@argus/contracts";

/**
 * The transcript timeline as analysis prompts quote it: one line per Recorder
 * event, with a seconds offset from the run's start.
 *
 * Shared by Autopsy and trajectory judging so both read a run the same way.
 * The bytes are part of the Autopsy prompt (`AUTOPSY_PROMPT_VERSION`): any
 * change here is a prompt change, and `autopsy.test.ts` pins them.
 */

/** Per-event label budget inside a prompt. */
export const TIMELINE_LABEL_MAX = 200;

/** Collapse whitespace and clip to `max` characters. */
export function clipLine(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** One timeline line: `12.3s tool [ERROR]: Bash: npm ci — detail`. */
export function formatTimelineEvent(e: RecorderEvent): string {
  const secs = (e.atMs / 1000).toFixed(1);
  const mark = e.errored || e.kind === "error" ? " [ERROR]" : "";
  const detail = e.detail ? ` — ${clipLine(e.detail, TIMELINE_LABEL_MAX)}` : "";
  return `${secs}s ${e.kind}${mark}: ${clipLine(e.label, TIMELINE_LABEL_MAX)}${detail}`;
}

/** The events as timeline lines, joined; empty string for no events. */
export function formatTimeline(events: readonly RecorderEvent[]): string {
  return events.map(formatTimelineEvent).join("\n");
}
