import path from "node:path";
import type { GateDecision } from "@argus/contracts";
import { readRun, runInvocationDir } from "../sources/runs.js";
import { readGateDecisions } from "../sources/gateDecisions.js";
import { classifyOutcomeMarker } from "../harness/completion.js";
import { log } from "../log.js";
import { REVISION_NOTES_MAX_CHARS } from "./constants.js";
import type {
  VerificationReport,
  PhaseFailureClass,
  PhaseFailurePayload,
  PhaseProgress,
  OutcomeMarkerKind,
  RetryableClass,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import type { Run } from "../sources/scheduleTypes.js";

export interface RecoveredOutcome {
  signalType: "completed" | "failed";
  outcome: NonNullable<Run["outcome"]>;
  payload: unknown;
  /** Failure policy class. Absent for a recovered success. */
  failureClass?: RetryableClass;
  failureReason?: string;
  /** What the classifier read in the final message, when the run exited
   *  cleanly and there was a final message to read. Null otherwise. */
  marker: OutcomeMarkerKind | null;
}

/**
 * Recover a run's work-level conclusion from the final message stored on a
 * terminal run record. A completion signal remains authoritative when one
 * arrives; this is only used by reconciliation while the tracked step is still
 * `running`.
 *
 * For Codex it backstops a hook whose delivery is best-effort. For OpenCode,
 * which exposes no command hook at all, it *is* the completion protocol — the
 * agent writes the same `ARGUS_OUTCOME` line either way, and the only
 * difference is that the conclusion is read off the record on the next
 * reconcile tick instead of being pushed the instant the run ends. Which
 * runtimes are eligible is the runtime's own declaration
 * ({@link AgentRuntime.outcomeFromRecord}), so a runtime whose hook Argus
 * installs is never quietly rubber-stamped when that hook fails to fire.
 *
 * The final message is read by the same classifier the signal path uses
 * ({@link classifyOutcomeMarker}). Conflicting sentinels are deliberately
 * ambiguous: repeating the same sentinel is harmless (models sometimes recap
 * before the required last line), but two different conclusions must never be
 * guessed into success. A missing or conflicting marker is `unverified` under
 * either completion policy — on this path an exit code alone is never taken
 * for a completion, which is what it has always meant here; `lenient` relaxes
 * the signal path only.
 */
export function recoverRunOutcome(run: Run): RecoveredOutcome {
  if (run.status !== "succeeded" || (run.exitCode != null && run.exitCode !== 0)) {
    const reason =
      run.error?.trim() ||
      (run.exitCode != null ? `exit code ${run.exitCode}` : `run ended with status ${run.status}`);
    return {
      signalType: "failed",
      outcome: "failed",
      payload: { reason },
      failureClass: failureClassOfRecord(run),
      failureReason: reason,
      marker: null,
    };
  }

  const message = run.resultSummary ?? "";
  const classified = classifyOutcomeMarker(message);
  if (classified.kind === "missing" || classified.kind === "conflicting") {
    const reason =
      classified.kind === "missing"
        ? "run succeeded but ended without an ARGUS_OUTCOME completion marker; its final message must end with `ARGUS_OUTCOME: succeeded`"
        : `run succeeded but reported conflicting ARGUS_OUTCOME markers (${classified.found.join(", ")}); its final message must end with exactly one, \`ARGUS_OUTCOME: succeeded\``;
    return {
      signalType: "failed",
      outcome: "failed",
      payload: { reason },
      // An absent or ambiguous report is a protocol failure, not a considered
      // agent verdict: `unverified`, which the default retry policy retries
      // exactly as it retried this case (then classed `exit-code`) before.
      failureClass: "unverified",
      failureReason: reason,
      marker: classified.kind,
    };
  }

  const kind = classified.kind;
  const payload = {
    last_assistant_message: message,
    completion_source: "run-record-fallback",
  };
  if (kind === "succeeded") {
    return { signalType: "completed", outcome: kind, payload, marker: kind };
  }

  const reason = classified.reason ?? kind;
  return {
    signalType: "failed",
    outcome: kind,
    payload: { ...payload, reason },
    failureClass: "signal",
    failureReason: reason,
    marker: kind,
  };
}

/** How a run that ended without a considered agent verdict is classed for the
 *  retry policy, from what its record shows: never started, killed at its
 *  deadline (or for going quiet — a stall is a timeout that noticed sooner),
 *  or exited on its own. */
export function failureClassOfRecord(run: Run): RetryableClass {
  if (run.termination === "timed-out" || run.termination === "stalled") return "timeout";
  return run.pid == null ? "spawn" : "exit-code";
}

/** Bound on the whole retry note, across every class — generous enough for a
 *  handful of failed checks' output tails, small enough that a retry prompt
 *  never balloons past what one bad attempt is worth repeating. */
export const RETRY_NOTE_MAX_BYTES = 2000;

/** Per-check output tail kept in a verification retry note. */
export const VERIFICATION_TAIL_CHARS = 600;

/** Tail of a run's own error/result text kept in an exit-code retry note. */
export const EXIT_CODE_TAIL_CHARS = 800;

export interface RetryNoteInput {
  failureClass?: PhaseFailureClass;
  /** The phase's own one-line reason — used as-is for `timeout`, `spawn` and
   *  `signal`, which already carry everything worth repeating. */
  reason?: string;
  /** The failed attempt's own checks, when the class is `verification`. */
  verification?: VerificationReport;
  /** The failed run's exit code, when the class is `exit-code`. */
  exitCode?: number | null;
  /** The failed run's own error/result text, when the class is `exit-code`. */
  runText?: string | null;
  /** Which attempt just failed (1-based) and how many the policy allows, for
   *  the note's own header. */
  attempt: number;
  maxAttempts: number;
}

/**
 * A retry re-runs the same prompt. Every retryable class now hands the next
 * attempt *something* worth repairing against — this is the best-evidenced
 * loop in the harness literature (Aider, CodeRabbit; see
 * docs/HARNESS-RESEARCH.md §2 #4) — bounded per class so a chatty check
 * output can never balloon the prompt:
 *
 *  - `verification`: each failed check by name, with the tail of its output.
 *  - `exit-code`: the exit code plus the tail of the run's own error/result text.
 *  - `timeout` (including a stall — "stalled: no output for Ns"), `spawn` and
 *    `signal`: the one-line reason already computed where the failure was
 *    recorded — there is nothing more specific to add.
 *
 * Pure, so every class is unit-testable without touching a run record: the
 * caller (which does the I/O to read the failed run and the report) hands in
 * exactly what it found.
 */
export function retryNote(input: RetryNoteInput): string {
  const cls = input.failureClass;
  if (!cls || cls === "configuration") return "";

  let body = "";
  if (cls === "verification" && input.verification) {
    body = input.verification.checks
      .filter((c) => c.status === "failed")
      .map((c) => `${c.label}: ${(c.output ?? "").trim().slice(-VERIFICATION_TAIL_CHARS)}`)
      .join("\n");
  } else if (cls === "exit-code") {
    const tail = (input.runText ?? "").trim().slice(-EXIT_CODE_TAIL_CHARS);
    body = `exit code ${input.exitCode ?? "unknown"}${tail ? `: ${tail}` : ""}`;
  } else {
    // timeout (incl. stalled), spawn, signal
    body = (input.reason ?? "").trim();
  }
  body = body.trim();
  if (!body) return "";
  if (body.length > RETRY_NOTE_MAX_BYTES) body = `…${body.slice(-(RETRY_NOTE_MAX_BYTES - 1))}`;
  return `\n\nPrevious attempt (${input.attempt} of ${input.maxAttempts}) failed — ${cls}:\n${body}`;
}

/**
 * Gather what {@link retryNote} needs for one failed phase, doing the one bit
 * of I/O it can't do itself: reading the failed run's own record for an
 * `exit-code` class. Every other class reads only what is already on the
 * phase (`payload`, `verification`).
 */
export async function buildRetryNote(
  def: PipelineDefinition,
  phase: PhaseProgress,
): Promise<string> {
  const payload = (phase.payload ?? {}) as PhaseFailurePayload;
  const policy = def.phases.find((p) => p.id === phase.id)?.retry;
  const attempt = (phase.retries ?? 0) + 1;
  let exitCode: number | null = null;
  let runText: string | null = null;
  if (payload.failureClass === "exit-code") {
    const failedStep = phase.steps.find((s) => s.status === "failed" && s.runId);
    if (failedStep?.runId) {
      const got = await readRun(failedStep.runId);
      exitCode = got?.run.exitCode ?? null;
      runText = got?.run.error ?? got?.run.resultSummary ?? null;
    }
  }
  return retryNote({
    failureClass: payload.failureClass,
    reason: typeof payload.reason === "string" ? payload.reason : undefined,
    verification: phase.verification,
    exitCode,
    runText,
    attempt,
    maxAttempts: policy?.attempts ?? attempt,
  });
}

/** One revise decision's note, as a later attempt of its phase is told it. */
export interface RevisionNote {
  /** The attempt the note revised (0-based, as the gate-decisions API counts). */
  attempt: number;
  note: string;
}

/**
 * Every revise note this phase received in this instance, oldest first, read
 * from the durable gate-decisions record when an attempt is planned. Only a
 * decision linked to the instance took effect, so an unlinked (not-applied)
 * record is left out. Reading the record instead of carrying the note forward
 * is what keeps a note across every launch path: a second revise, a retry
 * after a revise, and a launch recovery owed after a restart.
 */
export async function revisionHistory(
  inst: PipelineInstance,
  phaseId: string,
): Promise<RevisionNote[]> {
  const linked = new Set(inst.gateDecisionIds ?? []);
  if (linked.size === 0) return [];
  let decisions: GateDecision[];
  try {
    decisions = await readGateDecisions(inst.id);
  } catch (e) {
    log.error("revision notes could not be read; the attempt starts without them", {
      instanceId: inst.id,
      phaseId,
      err: e,
    });
    return [];
  }
  return decisions
    .filter((d) => d.decision === "revise" && linked.has(d.id))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .flatMap((d) => {
      const ref = d.phases[0];
      return ref?.phaseId === phaseId && d.note?.trim()
        ? [{ attempt: ref.attempt, note: d.note }]
        : [];
    });
}

/** Where a run's revision notes go in full when they did not all fit its prompt. */
export function revisionNotesFile(runId: string): string {
  return path.join(runInvocationDir(runId), "notes", "revision-notes.md");
}

/**
 * The block a phase's revision notes add to a prompt, and the full text when
 * the block had to leave some out.
 *
 * Every note is one line, oldest first, labelled with the attempt it revised.
 * Past {@link REVISION_NOTES_MAX_CHARS} the oldest note stays (it usually
 * frames the rest), then as many of the newest as fit, and a marker names the
 * file that holds them all.
 *
 * Pure, so the bound is unit-testable without a gate decision on disk.
 */
export function revisionNotes(
  history: RevisionNote[],
  fullPath: string,
): { text: string; full: string | null } {
  if (history.length === 0) return { text: "", full: null };
  const head = "\n\nRevision notes, oldest first:";
  const lines = history.map(
    (n) => `- After attempt ${n.attempt}: ${n.note.trim().replace(/\r?\n/g, "\n  ")}`,
  );
  const all = `${head}\n${lines.join("\n")}`;
  if (all.length <= REVISION_NOTES_MAX_CHARS) return { text: all, full: null };

  const marker = (omitted: number): string =>
    `- [… ${omitted} note${omitted === 1 ? "" : "s"} omitted for length; all ${lines.length} are in ${fullPath} …]`;
  // Sized with the largest marker, so a shorter final one can only fit better.
  let size = head.length + 1 + lines[0].length + 1 + marker(lines.length - 1).length;
  const newest: string[] = [];
  for (let i = lines.length - 1; i >= 1; i--) {
    if (size + 1 + lines[i].length > REVISION_NOTES_MAX_CHARS) break;
    newest.unshift(lines[i]);
    size += 1 + lines[i].length;
  }
  const omitted = lines.length - 1 - newest.length;
  const kept = omitted > 0 ? [lines[0], marker(omitted), ...newest] : [lines[0], ...newest];
  return {
    text: `${head}\n${kept.join("\n")}`,
    full: `Revision notes, oldest first:\n${lines.join("\n")}\n`,
  };
}
