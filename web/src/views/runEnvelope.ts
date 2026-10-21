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
 * explained when the two disagree. Nor is it the process's exit: a CLI can
 * report "success" and still exit 1, which read "exited cleanly — the run
 * failed its outcome check all the same" over a run that did neither. The
 * run's own exit code, when it has one, is what the process did. Figures the
 * surrounding view already shows are left out; the rest are in the app's own
 * formats.
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
  run: {
    /** The run failed, whatever its process said. */
    failed: boolean;
    /** Null while it runs, and when Argus never saw it exit: the CLI's own
     *  word stands in for it then. */
    exitCode: number | null | undefined;
  },
): EnvelopeField[] {
  return fields.flatMap((f): EnvelopeField[] => {
    if (f.label === "Cost" && shown.cost) return [];
    if (f.label === "Tokens" && shown.tokens) return [];
    if (f.label === "Duration" && shown.duration) return [];
    if (f.label === "Status") {
      // Claude Code says "success" (or "error (<subtype>)"); Codex and
      // OpenCode say "completed" or "success".
      const clean = /^(success|completed)/i.test(f.value);
      if (run.exitCode != null && run.exitCode !== 0) {
        return [
          {
            label: "Process",
            value: `exited with code ${run.exitCode}`,
            // The CLI's own word, quoted as it said it, is usually why.
            note: clean ? undefined : `The agent reported “${f.value}”.`,
            machine: false,
          },
        ];
      }
      return [
        {
          label: "Process",
          value: clean ? "exited cleanly" : f.value,
          // Only a process known to have exited 0: without an exit code there
          // is no clean exit for the outcome to have disagreed with.
          note:
            run.failed && clean && run.exitCode === 0
              ? "The run failed its outcome check all the same."
              : undefined,
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
