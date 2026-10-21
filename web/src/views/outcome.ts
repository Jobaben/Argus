/**
 * The `ARGUS_OUTCOME: <outcome> <reason>` line an agent ends its reply with.
 *
 * It is protocol: the prompt Argus gives every agent demands it, so the
 * scheduler can read a verdict (server/src/harness/completion.ts). Printed
 * under the human message, it says the same thing again in machine form —
 * "Drafted the changelog… ARGUS_OUTCOME: succeeded" — beside a status pill
 * that already shows the verdict. Every view that prints an agent's summary,
 * error or note reads it through here, so they agree on what a person sees.
 * Display only: the stored text keeps its marker.
 */
const MARKER = /^\s*ARGUS_OUTCOME:\s*(\S*)\s*(.*)$/i;

export interface SplitOutcome {
  /** The text without its marker lines, trimmed. When the marker is all there
   *  is, its reason, so a bare `ARGUS_OUTCOME: failed tests are red` still
   *  says why. */
  prose: string;
  /** The outcome the last marker reported, or null when there was none. */
  outcome: string | null;
}

export function splitOutcome(text: string | null | undefined): SplitOutcome {
  let outcome: string | null = null;
  let reason = "";
  // Split on CRLF too: `.` stops at a carriage return, so a marker line that
  // kept one would not match and would be printed.
  const kept = (text ?? "").split(/\r?\n/).filter((line) => {
    const m = MARKER.exec(line);
    if (!m) return true;
    outcome = m[1] || null;
    reason = m[2].trim();
    return false;
  });
  return { prose: kept.join("\n").trim() || reason, outcome };
}

/** The text a person reads: {@link splitOutcome}'s prose. */
export function withoutOutcome(text: string | null | undefined): string {
  return splitOutcome(text).prose;
}

/** Its first non-empty line, for a row or a strip with room for one. */
export function firstProseLine(text: string | null | undefined): string {
  return (
    withoutOutcome(text)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}
