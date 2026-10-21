import { formatTokens, formatUsd, type RunLogField } from "../ds";

/**
 * A run log's closing envelope, worded one way wherever a run's log is shown.
 *
 * The step drawer and a run row used to say the same envelope two ways:
 * "Process · exited cleanly" in one, "Agent exit · success" in the other, with
 * the row repeating its own cost and tokens beneath it, the tokens as raw
 * counts ("115620 in / 25380 out"), all in mono.
 *
 * Its "Status" is the agent CLI's verdict on its own session, not the run's: a
 * run the scheduler failed (a refused outcome, a non-zero exit) read "Status
 * success" under a red pill. So it is named for what it is, the process, and
 * explained when the two disagree. Figures the surrounding view already shows
 * are left out; the rest are in the app's own formats.
 */
export interface EnvelopeField {
  label: string;
  value: string;
  /** Why the process's word and the run's status disagree, when they do. */
  note?: string;
  /** An identifier: set in mono, because it is copied rather than read. */
  machine: boolean;
}

/** Envelope fields whose value is an identifier. */
const MACHINE_FIELDS = new Set(["Session", "Thread", "API error"]);

export function envelopeFields(
  fields: RunLogField[],
  /** Which figures the view around the log already shows. */
  shown: { cost: boolean; tokens: boolean; duration: boolean },
  runFailed: boolean,
): EnvelopeField[] {
  return fields.flatMap((f): EnvelopeField[] => {
    if (f.label === "Cost" && shown.cost) return [];
    if (f.label === "Tokens" && shown.tokens) return [];
    if (f.label === "Duration" && shown.duration) return [];
    if (f.label === "Status") {
      // Claude Code says "success" (or "error (<subtype>)"); Codex and
      // OpenCode say "completed" or "success".
      const clean = /^(success|completed)/i.test(f.value);
      return [
        {
          label: "Process",
          value: clean ? "exited cleanly" : f.value,
          note: runFailed && clean ? "The run failed its outcome check all the same." : undefined,
          machine: false,
        },
      ];
    }
    if (f.label === "Cost") {
      const usd = Number(f.value.replace(/^\$/, ""));
      return [{ ...f, value: Number.isFinite(usd) ? formatUsd(usd) : f.value, machine: false }];
    }
    if (f.label === "Tokens") {
      const m = /^(\d+) in \/ (\d+) out$/.exec(f.value);
      const value = m
        ? `${formatTokens(Number(m[1]))} in / ${formatTokens(Number(m[2]))} out`
        : f.value;
      return [{ ...f, value, machine: false }];
    }
    return [{ ...f, machine: MACHINE_FIELDS.has(f.label) }];
  });
}
