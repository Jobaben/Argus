import { reasonText, sentenceStart } from "./text";

/**
 * A phase's failure reason, told once.
 *
 * The scheduler records why a phase stopped by re-encoding the agent's
 * `ARGUS_OUTCOME` line as `<outcome>: <why>` (server/src/harness/completion.ts).
 * Printed as it came, a drawer opened on "failed: could not reach advisory
 * database (ETIMEDOUT)" — a lower-case protocol prefix repeating the Failed
 * pill beside it — and directly under it the agent's last message said the
 * same thing again in fuller words. Presented here, at the edge: the stored
 * reason is what the scheduler and `argus tail` read, and stays as written.
 */

// The one-line presentation lives in ./text: the board, on the first paint,
// needs it, and the matching below is only for the lazy drawers.
export { reasonText };

/** Loosely the same words: case, punctuation, articles and a verdict prefix
 *  set aside. The words stay apart, so a match ends where a word does. */
function loose(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(?:failed|blocked|succeeded)\s*:\s*/, "")
    .replace(/\b(?:the|a|an)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A Markdown block marker opening a line: a heading, a quote, a list item. */
const BLOCK_MARKER = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/;

/**
 * The reason and the agent's message about it, each said once.
 *
 * When the message opens by telling the reason, in the same words or in the
 * same words and more ("…after 3 retries"), that opening line is the fuller
 * telling: it becomes the reason, and the message keeps whatever it says after
 * that line. Anything else comes back as it was, the reason through
 * {@link reasonText}. Opening, not containing: a short reason ("exit code 1")
 * turns up inside plenty of messages that are about something else.
 */
export function tellOnce(
  reason: string | null | undefined,
  message: string,
): { reason: string; message: string } {
  const said = reasonText(reason);
  const text = message.trim();
  const cut = text.indexOf("\n");
  const opening = (cut < 0 ? text : text.slice(0, cut)).trim().replace(BLOCK_MARKER, "");
  const core = loose(said);
  const lead = loose(opening);
  // Whole words: "exit code 1" is not the opening of "Exit code 127 from npm".
  if (core === "" || (lead !== core && !lead.startsWith(`${core} `))) {
    return { reason: said, message: text };
  }
  return { reason: sentenceStart(opening), message: cut < 0 ? "" : text.slice(cut + 1).trim() };
}
