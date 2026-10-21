/**
 * Server text as a label. Detail lines, incident notes and issue titles are
 * written by the server as clauses ("last completed run failed", "exit code
 * 1") meant to follow something else, and printed as they came they were the
 * one lower-case line on a sentence-case screen. Capitalised here, at the
 * edge, rather than on the server: stored values (an issue's title is part of
 * what people search and file it by) stay exactly as they were recorded.
 */
export function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A phase's failure reason as a person reads it. The scheduler stores it as
 * `<outcome>: <why>` (server/src/harness/completion.ts); "failed:" and
 * "succeeded:" restate the status shown beside it, so they go. "blocked:"
 * stays: the phase reads Failed, and that the agent was blocked rather than
 * failing is news. See ./failureReason for telling it once beside the agent's
 * own message.
 */
const VERDICT = /^\s*(?:failed|succeeded)\s*(?::\s*|$)/i;

export function reasonText(reason: string | null | undefined): string {
  return sentenceStart((reason ?? "").replace(VERDICT, "").trim());
}
