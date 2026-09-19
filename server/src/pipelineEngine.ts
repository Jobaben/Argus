import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  encodeProject,
  killRunProcess,
  patchRun,
  readRun,
  readRunResult,
  runInvocationDir,
  runLogPath,
  runResultPath,
  writeInvocation,
  writeRun,
} from "./sources/runs.js";
import { paths } from "./claudeHome.js";
import { atomicWriteJson } from "./sources/atomicWrite.js";
import {
  candidateArtifactDir,
  phaseArtifactDir,
  phaseBaselinePath,
  prepareInvocation,
  readGitHead,
  resolveCapabilities,
  resolveTimeoutSeconds,
} from "./harness/invocation.js";
import type { PreparedInvocation } from "./harness/invocation.js";
import { buildChildEnv } from "./harness/childEnv.js";
import { runChecks, snapshotWorkingTree } from "./harness/verification.js";
import type { WorkingTreeSnapshot } from "./harness/verification.js";
import {
  createWorktree,
  plannedRemovals,
  removeWorktree,
  workspacePolicyFor,
  workspaceTarget,
} from "./harness/workspace.js";
import {
  DEFAULT_MEMORY_BYTES,
  ensureMemoryDir,
  isSettled,
  memoryDirFor,
  readMemoryNotes,
  summarizeInstance,
  trimMemoryIfNeeded,
} from "./harness/memory.js";
import { isStalled, resolveStallSeconds } from "./harness/stall.js";
import { markPipelineStarted, readPipelines } from "./sources/pipelines.js";
import { accumulateRun } from "./sources/totals.js";
import {
  INSTANCE_KEEP,
  pruneInstances,
  readInstance,
  readInstances,
  writeInstance,
} from "./sources/instances.js";
import {
  advance,
  applyAbort,
  applyApprove,
  applyCandidateSelection,
  applyCandidateVerification,
  applyCandidatesExhausted,
  applyRevise,
  applyRetry,
  applyUnlaunchable,
  applyVerification,
  candidateFailureClass,
  candidateFailureReason,
  candidateRecordOf,
  retryDelayMs,
  selectCandidate,
  shouldRetry,
  initInstance,
  toCandidateOutcomes,
  withFailureClass,
} from "./pipelineTransitions.js";
import { interpolate, livePhases, previousPayloadFor, resultStepName } from "./sources/dag.js";
import type { VerificationReport } from "./sources/pipelineTypes.js";
import { journal } from "./sources/journal.js";
import { isAlive } from "./scheduler.js";
import { claudeRuntime, parseEnvelopeFor, resolveRuntimeId, runtimeFor } from "./runtimes/index.js";
import { graceMsFor, previousFireTime } from "./sources/nextFire.js";
import { KeyedMutex } from "./mutex.js";
import { spawnPipelineProcess } from "./pipelineProcess.js";
import type { PipelineProcessHandle } from "./pipelineProcess.js";
import type { SpawnPlan } from "./runtimes/index.js";
import type { AgentRuntimeId } from "@argus/contracts";
import type { Run } from "./sources/scheduleTypes.js";
import type {
  PhaseDef,
  PhaseFailureClass,
  PhaseFailurePayload,
  PhaseProgress,
  PhaseStep,
  RetryableClass,
  WorkspacePolicy,
  WorkspaceRecord,
} from "./sources/pipelineTypes.js";

/**
 * One run of one step, planned but not yet launched.
 *
 * A candidates phase plans `count` of these from a single `stepDef`, each with
 * a worktree, an artifact directory and a baseline of its own — which is why
 * the per-run context is a record here rather than being derived from the
 * phase at launch time.
 */
interface PlannedRun {
  stepDef: PhaseStep;
  run: Run;
  publishes: boolean;
  timeoutSeconds: number | null;
  /** Which candidate this run is, on a `candidates` phase. */
  candidate: number | undefined;
  artifactDir: string;
  workspace: WorkspaceRecord | null;
  /** Full values of any placeholder {@link interpolate} trimmed, for the
   *  engine to write under this run's invocation directory. */
  contextFiles: { path: string; contents: string }[];
}
import type { CandidateRecord, RouteOutcome, TransitionResult } from "./pipelineTransitions.js";
import type {
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
} from "./sources/pipelineTypes.js";
import { log } from "./log.js";

/** Thrown by start() when the pre-run guard finds a critical prerequisite still broken. */
export class PreflightError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`setup preconditions not met: ${reasons.join("; ")}`);
    this.name = "PreflightError";
  }
}

/** Caps the number of concurrently spawned child processes. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

export type PipelineSpawnFn = (
  run: Run,
  logPath: string,
  env: Record<string, string>,
  /**
   * The invocation as the harness prepared it: argv, materialized config and
   * the *complete* child environment with the step's policy applied. The real
   * spawn uses exactly this; a test double may ignore it.
   */
  prepared?: PreparedInvocation,
) => PipelineProcessHandle | Promise<PipelineProcessHandle>;

/**
 * Injected into every step run's system prompt so the Stop hook can derive an
 * outcome without the pipeline author writing the ARGUS_OUTCOME mechanic. Must
 * stay a pure constant — no per-run data — or the prompt cache prefix breaks.
 */
export const OUTCOME_CONTRACT =
  "When you finish, the final line of your last message must report the outcome " +
  "so the pipeline can decide whether to advance. Write `ARGUS_OUTCOME: succeeded` " +
  "if you fully met the task's stated criteria, or `ARGUS_OUTCOME: failed` " +
  "(use `blocked` if you could not proceed) followed by a one-line reason. " +
  "Judge success against the criteria in the task, not merely whether you stopped cleanly. " +
  "This is a one-shot batch run: it will not be re-invoked when background tasks or " +
  "subagents finish, so do not stop while any are still in flight. If you must stop " +
  "with deferred work unfinished, report `ARGUS_OUTCOME: blocked`.";

/**
 * The instruction a result-producing step gets appended to its prompt.
 *
 * Not part of {@link OUTCOME_CONTRACT}: that is a pure constant so the prompt
 * cache prefix holds across every run, and this text carries the phase's own
 * schema. It goes in the prompt rather than the system prompt for the same
 * reason the schema is in the definition — it is this phase's contract, not
 * Argus's.
 *
 * The two say different things and both are needed. `ARGUS_OUTCOME` reports
 * whether the run *worked*; the result file reports what it *decided*. An agent
 * that decides "reject" has succeeded operationally, and conflating the two is
 * how a failing audit becomes a failing pipeline.
 */
export function resultInstruction(result: PhaseDef["result"]): string {
  if (!result) return "";
  return (
    "\n\nStructured result required. Before you finish, write this phase's result as JSON " +
    "to the file path given in the ARGUS_RESULT_FILE environment variable. It must match " +
    `this schema: ${JSON.stringify(result.schema)}. The pipeline reads that file — not your ` +
    "message text — to decide what runs next, and the phase fails if it is missing or does " +
    "not match. Reporting `ARGUS_OUTCOME: succeeded` still means the work itself went fine, " +
    "whatever the result says."
  );
}

/**
 * The instruction a step gets when its phase requires file artifacts.
 *
 * Which files must exist afterwards is system control — a check Argus runs —
 * so Argus states it, in the prompt, beside the path the files go to. The
 * author's prompt says what the files should contain; this says that they
 * must exist and where.
 */
export function artifactInstruction(checks: PhaseDef["checks"], artifactDir: string): string {
  const required = (checks ?? []).flatMap((c) => (c.kind === "artifact" ? [c.path] : []));
  if (required.length === 0) return "";
  return (
    "\n\nRequired artifacts. Before you finish, this phase must leave the following " +
    `file${required.length === 1 ? "" : "s"} in its artifact directory ${artifactDir} ` +
    `(also given as the ARGUS_ARTIFACT_DIR environment variable): ${required.join(", ")}. ` +
    "The pipeline checks that each exists and is non-empty; the phase fails otherwise."
  );
}

/**
 * The instruction a step gets when its pipeline has `memory` enabled.
 *
 * Argus states where the file is and what it is for; what to actually write
 * in it is the author's business (or the agent's own judgment) — this is only
 * the fixed, system-owned part: the path, and the cap Argus itself enforces
 * after the fact (§ harness/memory.ts `trimMemoryIfNeeded`).
 */
export function memoryInstruction(memory: PipelineDefinition["memory"] | undefined): string {
  if (!memory?.enabled) return "";
  const cap = memory.maxBytes ?? DEFAULT_MEMORY_BYTES;
  return (
    "\n\nDurable notes for this pipeline live at $ARGUS_MEMORY_DIR/NOTES.md. Append what a " +
    "future run of this pipeline must know (decisions, gotchas, what was tried); keep it under " +
    `${cap} bytes — Argus trims the head beyond that.`
  );
}

/**
 * Build the invocation for a step run, with the outcome contract carried into
 * the agent's instructions.
 *
 * The runtime decides how that contract is delivered — Claude Code takes it on
 * `--append-system-prompt`, Codex has no such flag so it rides at the top of
 * the prompt — and both produce a run that reports `ARGUS_OUTCOME` the same way.
 * Kept pure for unit testing.
 */
export function buildStepPlan(run: Run): SpawnPlan {
  return runtimeFor(run.runtime).streamPlan({
    prompt: run.prompt,
    sessionId: run.sessionId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    systemPrompt: OUTCOME_CONTRACT,
  });
}

/** The Claude Code argument vector for a step run. Retained as the narrow,
 *  named form of {@link buildStepPlan} for callers and tests that mean Claude. */
export function buildClaudeArgs(run: Run): string[] {
  return claudeRuntime.streamPlan({
    prompt: run.prompt,
    sessionId: run.sessionId,
    model: run.model,
    systemPrompt: OUTCOME_CONTRACT,
  }).args;
}

/** Real spawn: the run's agent CLI, prompt on stdin, with the signal env
 *  injected. POSIX starts the agent directly and detached; Windows uses a
 *  hidden, detached two-stage host so the real agent PID can be confirmed over
 *  IPC before this handle resolves. Both keep fd-backed logs so the run survives
 *  an Argus restart. The handshake, rather than the host itself, preserves PID
 *  tracking across restarts.
 *
 *  With a prepared invocation the child gets exactly what the harness decided —
 *  argv and environment alike; `process.env` is not consulted here, because
 *  the environment policy has already been applied to it. The legacy branch
 *  (no preparation) is kept for callers that build a run by hand. */
export const defaultPipelineSpawn: PipelineSpawnFn = async (run, logPath, env, prepared) => {
  const fd = openSync(logPath, "a");
  const plan = prepared?.plan ?? buildStepPlan(run);
  try {
    return await spawnPipelineProcess(
      {
        bin: plan.bin,
        args: plan.args,
        stdin: plan.stdin,
        cwd: run.cwd,
        env: prepared ? prepared.env : { ...process.env, ...plan.env, ...env },
      },
      fd,
    );
  } finally {
    closeSync(fd);
  }
};

export interface EngineDeps {
  now: () => Date;
  newId: () => string;
  spawn: PipelineSpawnFn;
  signalUrlBase: string;
  maxConcurrent: number;
  tickMs?: number;
  onChange?: () => void;
  /** Called when an instance reaches the 'failed' state (failure notifications). */
  onFailure?: (inst: PipelineInstance) => void;
  /** Optional pre-run guard. When it returns { ok: false }, start() throws PreflightError. */
  preflight?: () => Promise<{ ok: boolean; reasons: string[] }>;
  /** Kills a run's process tree; injectable for tests. Defaults to killRunProcess. */
  kill?: (pid: number, signal?: NodeJS.Signals) => Promise<boolean> | boolean;
  /** The environment step env policies are applied to. Defaults to process.env. */
  parentEnv?: NodeJS.ProcessEnv;
  /** Grace between the deadline's SIGTERM and a SIGKILL escalation. */
  killGraceMs?: number;
  /** Live-activity tailer; told when step runs start and end, and under which
   *  runtime so it reads the log in that CLI's event vocabulary. */
  tailer?: {
    track(runId: string, instanceId: string, runtime?: AgentRuntimeId | null): void;
    untrack(runId: string): void;
    /** This process's most recent observed activity per tracked run, for
     *  stall detection. Optional so existing test doubles need not implement
     *  it; absent means every stall check falls back to `startedAt`. */
    latest?(): Map<string, { at: string }>;
  };
}

export interface ActionResult {
  ok: boolean;
  code: number;
  /** Human-readable reason on the failure paths (404/409), for surfacing to a client. */
  error?: string;
}

/** Which paused phase a gate action means, when more than one could be. */
export interface GateTarget {
  phaseId?: string;
}

interface RecoveredOutcome {
  signalType: "completed" | "failed";
  outcome: NonNullable<Run["outcome"]>;
  payload: unknown;
  /** Failure policy class. Absent for a recovered success. */
  failureClass?: RetryableClass;
  failureReason?: string;
}

const OUTCOME_LINE_RE = /^\s*ARGUS_OUTCOME:\s*(succeeded|failed|blocked)\b[^\S\r\n]*(.*)$/gim;

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
 * Conflicting sentinels are deliberately ambiguous. Repeating the same
 * sentinel is harmless (models sometimes recap before the required last
 * line), but two different conclusions must never be guessed into success.
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
    };
  }

  const message = run.resultSummary ?? "";
  const matches = [...message.matchAll(OUTCOME_LINE_RE)];
  const kinds = new Set(matches.map((m) => m[1].toLowerCase()));
  if (matches.length === 0 || kinds.size !== 1) {
    const reason =
      matches.length === 0
        ? "run succeeded but ended without an ARGUS_OUTCOME completion marker"
        : `run succeeded but reported conflicting ARGUS_OUTCOME markers (${[...kinds].join(", ")})`;
    return {
      signalType: "failed",
      outcome: "failed",
      payload: { reason },
      // A missing/ambiguous completion protocol is recoverable infrastructure,
      // not a considered agent failure, so existing exit-code retry policies
      // keep their pre-fallback behavior.
      failureClass: "exit-code",
      failureReason: reason,
    };
  }

  const kind = matches[matches.length - 1][1].toLowerCase() as NonNullable<Run["outcome"]>;
  const payload = {
    last_assistant_message: message,
    completion_source: "run-record-fallback",
  };
  if (kind === "succeeded") return { signalType: "completed", outcome: kind, payload };

  const tail = (matches[matches.length - 1][2] ?? "").replace(/^[\s:–—-]+/, "").trim();
  const reason = tail ? `${kind}: ${tail}` : kind;
  return {
    signalType: "failed",
    outcome: kind,
    payload: { ...payload, reason },
    failureClass: "signal",
    failureReason: reason,
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
const RETRY_NOTE_MAX_BYTES = 2000;
/** Per-check output tail kept in a verification retry note. */
const VERIFICATION_TAIL_CHARS = 600;
/** Tail of a run's own error/result text kept in an exit-code retry note. */
const EXIT_CODE_TAIL_CHARS = 800;

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
async function buildRetryNote(def: PipelineDefinition, phase: PhaseProgress): Promise<string> {
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

export interface Engine {
  start(
    pipelineId: string,
    trigger?: PipelineInstance["trigger"],
    /** Set for `trigger: "webhook"` (the request body) or `"chained"` (the
     *  source instance's outcome) — omitted for `"manual"`/`"scheduled"`. */
    firing?: { triggerPayload?: unknown; chainedFrom?: string },
  ): Promise<PipelineInstance | null>;
  onSignal(instanceId: string, signal: PipelineSignal): Promise<ActionResult>;
  /** Open a gate. `phaseId` names which paused phase when a fan-out has more
   *  than one waiting; absent, the single paused phase is meant. */
  approve(instanceId: string, answers?: unknown, options?: GateTarget): Promise<ActionResult>;
  /** Send a paused phase back to its agent with the human's note. */
  revise(instanceId: string, note?: string, options?: GateTarget): Promise<ActionResult>;
  abort(instanceId: string): Promise<ActionResult>;
  reconcile(): Promise<void>;
  /** On boot: claim still-alive runs from running instances so they keep
   *  their concurrency slots and get finalized by reconcile when they end. */
  adopt(): Promise<void>;
  /**
   * Resolves once every piece of detached work the engine has queued — phase
   * launches deferred off a signal, verifications, deadline handlers — has
   * settled. For an orderly shutdown, and for tests that must observe the
   * state a transition leads to rather than the one it left.
   */
  drain(): Promise<void>;
}

export function createEngine(deps: EngineDeps): Engine {
  const sem = new Semaphore(deps.maxConcurrent);
  // Serializes all read-modify-write mutations of a single instance so
  // concurrent signals / reconcile passes cannot lose each other's updates.
  const locks = new KeyedMutex();
  /** Runs spawned by a previous server process, reattached after restart. */
  const adopted = new Map<string, { instanceId: string }>();
  const nowISO = () => deps.now().toISOString();
  const kill = deps.kill ?? killRunProcess;
  const parentEnv = () => deps.parentEnv ?? process.env;
  /** Phase attempts whose checks this process is currently running. */
  const verifying = new Set<string>();
  /** Runs this process spawned and is still awaiting the exit of. */
  const live = new Set<string>();
  /** Detached continuations in flight, so `drain` can wait for them. */
  const detached = new Set<Promise<unknown>>();
  function track<T>(p: Promise<T>): Promise<T> {
    detached.add(p);
    void p.finally(() => detached.delete(p)).catch(() => {});
    return p;
  }
  async function drain(): Promise<void> {
    while (detached.size > 0) await Promise.allSettled([...detached]);
  }

  /** Instances whose worktrees this process has already cleaned up. */
  const cleaned = new Set<string>();
  /** Instances whose memory notes this process has already trimmed. */
  const memoryChecked = new Set<string>();

  /**
   * Persist an instance, and — once it has settled — remove the worktrees it
   * created and trim its pipeline's memory notes if they have grown past cap.
   *
   * Every write of an instance goes through here rather than through
   * `writeInstance` directly, because an instance can reach a terminal status
   * from a dozen places (a signal, a deadline, a failed check, an abort, a
   * reconcile pass), and a cleanup hook on each of them is a cleanup hook
   * somebody eventually forgets. The removal is detached and never throws into
   * the transition that caused it: a worktree Argus cannot delete is a warning
   * in the log, never a pipeline that fails to finish.
   */
  async function saveInstance(inst: PipelineInstance): Promise<void> {
    await writeInstance(inst);
    if (inst.status === "running" || inst.status === "awaiting-approval") {
      // Alive again — a revise of a failed instance, a scheduled retry. What it
      // creates from here is cleaned up by the settlement that follows.
      cleaned.delete(inst.id);
      memoryChecked.delete(inst.id);
      return;
    }
    if (!memoryChecked.has(inst.id)) {
      memoryChecked.add(inst.id);
      void track(trimMemoryFor(inst));
    }
    if (cleaned.has(inst.id)) return;
    // Steps as well as phases: a candidates phase records a tree per candidate
    // and never one of its own until a winner is chosen, so an instance aborted
    // mid-selection has trees that only the steps know about.
    const anyTree =
      inst.workspace ||
      inst.phases.some((p) => p.workspace || p.steps.some((step) => step.workspace));
    if (!anyTree) return;
    cleaned.add(inst.id);
    void track(cleanupWorkspaces(inst));
  }

  /** Trim one settled instance's pipeline's `NOTES.md` back to its cap, when
   *  `memory` is enabled and the file has grown past it. Never throws — a
   *  file Argus cannot trim is a warning in the log, never a settlement that
   *  fails to finish. */
  async function trimMemoryFor(inst: PipelineInstance): Promise<void> {
    const def = await defFor(inst);
    if (!def?.memory?.enabled) return;
    const cap = def.memory.maxBytes ?? DEFAULT_MEMORY_BYTES;
    try {
      const trimmed = await trimMemoryIfNeeded(def.id, cap);
      if (trimmed) {
        await journal(inst.id, {
          at: nowISO(),
          kind: "memory.trimmed",
          detail: `NOTES.md trimmed to ${cap} bytes`,
        });
      }
    } catch (e) {
      log.warn("pipeline memory could not be trimmed", { pipelineId: def.id, err: e });
    }
  }

  /** Remove every worktree of a settled instance whose policy did not ask for
   *  it to be kept. The branches are never touched: they are the deliverable. */
  async function cleanupWorkspaces(inst: PipelineInstance): Promise<void> {
    const def = await defFor(inst);
    if (!def) return;
    for (const removal of plannedRemovals(def, inst)) {
      await removeWorkspace(inst.id, removal.repoCwd, removal.path, removal.branch);
    }
  }

  /** One worktree, gone. Never throws — a directory Argus could not remove must
   *  not take a transition (or an instance's settlement) down with it. Returns
   *  whether it is actually gone, so a caller that was about to forget the
   *  record can keep it and let the instance's own cleanup try again. */
  async function removeWorkspace(
    instanceId: string,
    repoCwd: string,
    workspacePath: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await removeWorktree({ repoCwd, path: workspacePath });
      // Awaited, unlike the engine's other journal calls: this one runs off the
      // transition path already, and a settled instance's evidence should be on
      // disk by the time `drain()` says the settlement is finished.
      await journal(instanceId, {
        at: nowISO(),
        kind: "workspace.removed",
        detail: `${branch} at ${workspacePath}`,
      });
      return true;
    } catch (e) {
      log.warn("workspace could not be removed", { instanceId, path: workspacePath, err: e });
      return false;
    }
  }

  /**
   * The worktree this phase attempt runs in, created (or re-attached) before
   * anything is planned.
   *
   * `scope: "instance"` resolves to one tree per instance, shared by every
   * phase that opts in and recorded on the instance the first time it is used —
   * the record is kept as it was, so the base commit it was cut from stays the
   * one it was cut from however many phases reuse it. `scope: "attempt"` gives
   * each attempt its own, and the superseded attempt's tree is removed as the
   * new one is created unless the policy says to keep it.
   *
   * Throws {@link WorkspaceError} (with git's own words) when the repository,
   * the base ref or git itself is not what the definition assumed: the caller
   * turns that into a `configuration` failure of the phase.
   */
  async function ensureWorkspace(
    inst: PipelineInstance,
    phaseDef: PhaseDef,
    progress: PhaseProgress,
    policy: WorkspacePolicy,
    /** One candidate of this attempt, when the phase runs best-of-N: each gets
     *  its own tree, because candidates that share a checkout are not samples. */
    candidate?: number,
  ): Promise<WorkspaceRecord> {
    const target = workspaceTarget({
      root: paths.worktreesDir(),
      instanceId: inst.id,
      phaseId: phaseDef.id,
      attempt: progress.attempt,
      policy,
      ...(candidate === undefined ? {} : { candidate }),
    });
    const previous = candidate === undefined ? progress.workspace : undefined;
    if (previous && previous.path !== target.path && policy.keep !== true) {
      await removeWorkspace(inst.id, phaseDef.cwd, previous.path, previous.branch);
    }
    // A restart finds the directory already there (reused as it stands) or the
    // branch already there without it (checked out again, keeping its commits).
    const shared =
      policy.scope === "instance" && inst.workspace?.path === target.path ? inst.workspace : null;
    const created = await createWorktree({
      repoCwd: phaseDef.cwd,
      path: target.path,
      branch: target.branch,
      ...(policy.base ? { base: policy.base } : {}),
    });
    const record = shared ?? created;
    if (policy.scope === "instance") inst.workspace = record;
    if (!shared) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "workspace.created",
        phaseId: phaseDef.id,
        attempt: progress.attempt,
        detail:
          candidate === undefined
            ? `${record.branch} at ${record.path}`
            : `c${candidate}: ${record.branch} at ${record.path}`,
      });
    }
    return record;
  }

  async function loadDef(pipelineId: string): Promise<PipelineDefinition | undefined> {
    return (await readPipelines()).find((d) => d.id === pipelineId);
  }

  /**
   * The definition an existing instance runs against: the copy it snapshotted
   * when it started. Only `start` reads the live definition; everything after
   * — a signal, an approval, a revise, a retry, a verification, a run healed
   * after a restart — reads the snapshot, so an edit (or a delete) saved
   * mid-flight cannot change what the instance does. An instance written
   * before the snapshot existed has none and falls back to the live definition,
   * which is exactly the behaviour it was started under.
   */
  async function defFor(inst: PipelineInstance): Promise<PipelineDefinition | undefined> {
    return inst.definition ?? (await loadDef(inst.pipelineId));
  }

  /**
   * Launch a wave of ready phases, given as indices into `inst.phases`.
   *
   * Sequential over the wave rather than `Promise.all`: each phase's launch
   * writes the instance, and two concurrent writers would race on the same
   * file. The steps *within* a phase already run concurrently, and the phases
   * themselves proceed concurrently once launched — this loop only serializes
   * the handful of milliseconds it takes to record their runIds.
   */
  async function startPhases(
    def: PipelineDefinition,
    inst: PipelineInstance,
    indices: number[],
    noteSuffix = "",
  ): Promise<void> {
    for (const i of indices) await startPhase(def, inst, i, noteSuffix);
  }

  /**
   * Launch one instance phase. `phaseIndex` indexes `inst.phases`; the phase's
   * definition is found by id, never by that index. `def` is normally the
   * instance's own snapshot, where the two line up — but an instance from
   * before the snapshot existed runs against the live definition, which may
   * have been edited since it started (a phase inserted ahead shifts every
   * index, and its id is the one stable key).
   */
  async function startPhase(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseIndex: number,
    noteSuffix = "",
  ): Promise<void> {
    const progress = inst.phases[phaseIndex];
    const phaseDef = def.phases.find((p) => p.id === progress.id);
    if (!phaseDef) {
      await failUnlaunchable(def, inst, progress.id);
      return;
    }
    // "Previous" is the phase's own dependency, which for a linear pipeline is
    // the phase before it — the same value the cursor version produced. A
    // dependency the edited definition names but the instance never had reads
    // as absent, which is the honest answer.
    const prevPayload = previousPayloadFor(def, inst, phaseDef.id);
    const startedAt = nowISO();
    // Isolation first: the worktree is what the steps' `cwd` will be, so it has
    // to exist before a single run is planned — and a tree that cannot be
    // created is a definition Argus cannot honour, not a step that failed.
    const policy = workspacePolicyFor(def, phaseDef);
    // Best-of-N: `count` runs of the phase's one step, each in a worktree of
    // its own. The phase-level tree is *not* created for such an attempt — the
    // winner's becomes the phase's at selection, and a shared one would be a
    // directory nothing ever ran in.
    const candidates = phaseDef.candidates;
    // "none" is a phase opting *out* of a pipeline-wide policy it inherited —
    // the same as no policy at all for this one phase: it runs in its own
    // `cwd`, no worktree is created or recorded.
    if (policy && policy.scope !== "none" && !candidates) {
      try {
        progress.workspace = await ensureWorkspace(inst, phaseDef, progress, policy);
      } catch (e) {
        await failPhaseConfiguration(
          def,
          inst,
          phaseDef.id,
          e instanceof Error ? e.message : String(e),
        );
        return;
      }
    }
    const artifactDir = phaseArtifactDir(paths.artifactsDir(), inst.id, phaseDef.id);
    progress.artifactDir = artifactDir;
    const byPhase = Object.fromEntries(
      inst.phases.flatMap((p) => (p.artifactDir ? [[p.id, p.artifactDir]] : [])),
    ) as Record<string, string>;
    // Exactly one step may publish the phase's result; only that step is told
    // about it, so concurrent siblings cannot race to write a decision. Every
    // candidate of a candidates phase is that step — each writes to its own
    // run's result file, and the phase takes the winner's.
    const publishingStep = resultStepName(phaseDef);

    // Pipeline memory (§B): read once per phase-start, and only when a step
    // actually asks for it — the common case is a pipeline with `memory` off,
    // or a phase whose prompt has nothing to do with it, and neither should
    // pay for a file read it never uses.
    const promptsHere = phaseDef.steps.map((s) => s.prompt).join("\n");
    const memoryPolicy = def.memory;
    const memoryDir = memoryPolicy?.enabled ? memoryDirFor(def.id) : null;
    const memoryText =
      memoryPolicy?.enabled && promptsHere.includes("{{memory}}")
        ? await readMemoryNotes(def.id, memoryPolicy.maxBytes ?? DEFAULT_MEMORY_BYTES)
        : "";
    if (memoryDir) await ensureMemoryDir(def.id);

    // `{{previous.instance}}` (§B): the most recent settled instance of this
    // pipeline that started before this one. Not gated on `memory.enabled` —
    // it costs one instance listing, already read from disk elsewhere, and
    // says nothing a pipeline needs to opt into.
    let previousInstanceSummary = "";
    if (promptsHere.includes("{{previous.instance}}")) {
      const siblings = (await readInstances({ pipelineId: def.id }))
        .filter((i) => i.id !== inst.id && i.createdAt < inst.createdAt && isSettled(i))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      if (siblings[0]) previousInstanceSummary = summarizeInstance(siblings[0]);
    }
    // What is actually launched: one run per declared step, or `count` runs of
    // the single step a candidates phase has.
    const units = candidates
      ? Array.from({ length: candidates.count }, (_, i) => ({
          stepDef: phaseDef.steps[0],
          candidate: i as number | undefined,
        }))
      : phaseDef.steps.map((stepDef) => ({ stepDef, candidate: undefined as number | undefined }));

    const planned: PlannedRun[] = [];
    for (const { stepDef, candidate } of units) {
      let workspace = progress.workspace ?? null;
      if (candidates && policy && policy.scope !== "none") {
        try {
          workspace = await ensureWorkspace(inst, phaseDef, progress, policy, candidate);
        } catch (e) {
          await failPhaseConfiguration(
            def,
            inst,
            phaseDef.id,
            e instanceof Error ? e.message : String(e),
          );
          return;
        }
      }
      // Where this run's work actually happens: its worktree, else the phase's
      // own directory exactly as before workspaces existed.
      const cwd = workspace?.path ?? phaseDef.cwd;
      const own =
        candidate === undefined ? artifactDir : candidateArtifactDir(artifactDir, candidate);
      // Cycled, so `count: 4` with two variants alternates them. Absent = the
      // step's own settings, which is what makes `count` alone mean "sample the
      // same thing N times".
      const variant =
        candidates && candidate !== undefined && candidates.variants?.length
          ? candidates.variants[candidate % candidates.variants.length]
          : undefined;
      const runId = deps.newId();
      const publishes = stepDef.name === publishingStep;
      // Narrowest wins: a candidate's variant names its runtime, else the step,
      // else its phase, else the pipeline, else the server default. Resolved and
      // written down here, so a mixed-runtime pipeline stays readable on the
      // board and in the record.
      const runtime = resolveRuntimeId(
        variant?.runtime,
        stepDef.runtime,
        phaseDef.runtime,
        def.runtime,
      );
      const timeoutSeconds = resolveTimeoutSeconds(phaseDef, stepDef);
      const stallSeconds = resolveStallSeconds(phaseDef, stepDef);
      // Argus-injected blocks ride after the agent's own prompt, in a fixed
      // order, with the retry note last: the note is what matters most on a
      // retry, and recency in the prompt is what the model weighs most (see
      // docs/HARNESS-RESEARCH.md §2 #5, "lost in the middle").
      const rendered = interpolate(
        stepDef.prompt,
        prevPayload,
        inst.artifacts ?? {},
        { own, byPhase },
        {
          triggerPayload: inst.triggerPayload,
          memory: memoryText,
          previousInstanceSummary,
          maxPlaceholderBytes: def.contextLimits?.placeholderBytes,
          contextDir: runInvocationDir(runId),
        },
      );
      const run: Run = {
        id: runId,
        scheduleId: `pipeline:${inst.pipelineId}`,
        scheduleName: `${inst.pipelineName} · ${phaseDef.name}`,
        prompt:
          rendered.prompt +
          (publishes ? resultInstruction(phaseDef.result) : "") +
          artifactInstruction(phaseDef.checks, own) +
          memoryInstruction(memoryPolicy) +
          noteSuffix,
        cwd,
        status: "running",
        trigger: "scheduled",
        queuedAt: startedAt,
        startedAt,
        endedAt: null,
        durationMs: null,
        pid: null,
        exitCode: null,
        sessionId: runtimeFor(runtime).capabilities.presetSessionId ? deps.newId() : null,
        model: variant?.model ?? stepDef.model ?? def.model,
        reasoningEffort: variant?.reasoningEffort ?? stepDef.reasoningEffort ?? def.reasoningEffort,
        runtime,
        project: encodeProject(cwd),
        resultSummary: null,
        error: null,
        instanceId: inst.id,
        phaseId: phaseDef.id,
        // The deadline is set at spawn, not here: a step may wait for a
        // concurrency slot first, and waiting is not running.
        deadlineAt: null,
        stallSeconds,
      };
      planned.push({
        stepDef,
        run,
        publishes,
        timeoutSeconds,
        candidate,
        artifactDir: own,
        workspace,
        contextFiles: rendered.contextFiles,
      });
    }
    // Record the runIds on the instance up front, then persist once (no write races).
    progress.steps = planned.map(({ stepDef, run, candidate, workspace }) => ({
      name: stepDef.name,
      runId: run.id,
      status: "running" as const,
      ...(candidate === undefined ? {} : { candidate }),
      ...(candidate === undefined ? {} : { workspace }),
    }));
    progress.status = "running";
    await saveInstance(inst);
    void journal(inst.id, {
      at: startedAt,
      kind: "phase.started",
      phaseId: phaseDef.id,
      attempt: progress.attempt,
      detail: candidates
        ? `${planned.length} candidates`
        : `${planned.length} step${planned.length === 1 ? "" : "s"}`,
    });
    // Every attempt starts with an empty artifact directory: a file left by a
    // previous attempt must never satisfy this attempt's checks or mislead the
    // agent about what it has already done.
    await rm(artifactDir, { recursive: true, force: true });
    await mkdir(artifactDir, { recursive: true });
    for (const unit of planned) {
      if (unit.artifactDir !== artifactDir) await mkdir(unit.artifactDir, { recursive: true });
    }

    // Launch each run: acquire a slot, spawn, and persist the pid. Callers on
    // the HTTP request path (start/approve/revise) await these launches so the
    // spawn is observable when they return. The concurrency cap still applies —
    // a launch past the cap waits for a slot, which is fine here because these
    // callers hold no slot of their own. Candidates are ordinary runs in that
    // respect: `count` of them take `count` slots, and queue when the cap is
    // smaller than the count.
    const unlaunchable: { run: Run; reason: string }[] = [];
    for (const unit of planned) {
      const { stepDef, run, publishes, timeoutSeconds, candidate } = unit;
      // A working-tree baseline for `changed-files` checks, kept out of the
      // agent's reach (beside the invocation records, not in the artifact dir).
      // Per candidate, because each candidate has a tree of its own and is
      // judged on what *it* changed.
      let baseline: WorkingTreeSnapshot | null = null;
      if (phaseDef.checks?.some((c) => c.kind === "changed-files")) {
        baseline = await snapshotWorkingTree(run.cwd);
        const file = phaseBaselinePath(
          paths.invocationsDir(),
          inst.id,
          phaseDef.id,
          progress.attempt,
          candidate,
        );
        if (baseline) await atomicWriteJson(file, baseline);
        else await rm(file, { force: true });
      }
      const gitHead = baseline?.head ?? (await readGitHead(run.cwd));
      const launched = await launchStep(run, {
        def,
        phaseDef,
        stepDef,
        inst,
        publishes,
        artifactDir: unit.artifactDir,
        timeoutSeconds,
        gitHead,
        workspace: unit.workspace,
        memoryDir,
        contextFiles: unit.contextFiles,
      });
      void journal(inst.id, {
        at: nowISO(),
        kind: "step.spawned",
        phaseId: phaseDef.id,
        runId: run.id,
        detail:
          ("handle" in launched
            ? `pid ${run.pid ?? "unknown"}`
            : launched.failure === "configuration"
              ? `not launched: ${launched.reason}`
              : "spawn failed") + (candidate === undefined ? "" : ` (c${candidate})`),
      });
      if ("handle" in launched) trackStep(run, launched.handle, startedAt, inst.id, phaseDef.id);
      else if (launched.failure === "configuration")
        unlaunchable.push({ run, reason: launched.reason });
    }

    // A step Argus refused to launch as declared fails its phase now, under the
    // `configuration` class — never retried, because the definition is what is
    // wrong. (A spawn *error* keeps its existing path: the run record says
    // failed and the reconcile pass classes it as `spawn`.)
    const readyAfterFailure: number[] = [];
    for (const { run, reason } of unlaunchable) {
      if (inst.status !== "running") break;
      readyAfterFailure.push(
        ...failStepInPlace(def, inst, phaseDef.id, run.id, "configuration", reason).startPhases,
      );
    }
    if (unlaunchable.length > 0) {
      await saveInstance(inst);
      if (candidates) {
        // A candidate Argus would not launch as declared is one candidate lost,
        // not a phase lost: the others may still win, and the phase only fails
        // when none of them can.
        await settleCandidates(def, inst, phaseDef.id);
      } else {
        // Siblings that did launch belong to a phase that has already failed.
        await killPhaseRuns(inst, [phaseDef.id], "stopped: phase failed");
        queueReadyPhases(inst.id, def, inst, readyAfterFailure);
        if (inst.status === "failed") deps.onFailure?.(inst);
      }
    }
    deps.onChange?.();
  }

  /**
   * A phase the instance has but the definition no longer names. Nothing was
   * spawned for this attempt (its steps carry no runId), so there is nothing
   * to kill; the phase fails under `configuration`, the instance settles, and
   * whatever that makes ready is queued exactly as after any other failure.
   */
  async function failUnlaunchable(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
  ): Promise<void> {
    log.warn("phase cannot be launched: not in the pipeline definition", {
      instanceId: inst.id,
      pipelineId: def.id,
      phaseId,
    });
    await failPhaseConfiguration(
      def,
      inst,
      phaseId,
      `phase "${phaseId}" no longer exists in pipeline "${def.name}"`,
    );
  }

  /**
   * A phase that cannot be launched at all: nothing was spawned for this
   * attempt, so there is nothing to kill. The phase fails under
   * `configuration` — never retried, because what is wrong is the definition,
   * not the weather — the instance settles, and whatever that makes ready is
   * queued exactly as after any other failure.
   */
  async function failPhaseConfiguration(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    reason: string,
  ): Promise<void> {
    const res = applyUnlaunchable(def, inst, phaseId, reason, nowISO());
    const phase = res.instance.phases.find((p) => p.id === phaseId);
    if (phase?.status === "failed") {
      void journal(inst.id, {
        at: nowISO(),
        kind: "phase.failed",
        phaseId,
        attempt: phase.attempt,
        detail: `configuration: ${reason}`,
      });
    }
    noteRouting(def, res.instance, res.routing);
    await saveInstance(res.instance);
    if (res.instance.status === "succeeded" || res.instance.status === "failed") {
      void journal(inst.id, { at: nowISO(), kind: "instance.ended", detail: res.instance.status });
    }
    queueReadyPhases(inst.id, def, res.instance, res.startPhases);
    if (res.instance.status === "failed") deps.onFailure?.(res.instance);
    deps.onChange?.();
  }

  /**
   * Fail one step of a running phase from inside a transition that already
   * holds the instance (in memory, under the lock): the failure signal, its
   * class, the retry decision and the journal entries, in one place.
   */
  function failStepInPlace(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
    failureClass: PhaseFailureClass,
    reason: string,
    extra: Record<string, unknown> = {},
  ): TransitionResult {
    const res = advance(
      def,
      inst,
      {
        instanceId: inst.id,
        phaseId,
        runId,
        type: "failed",
        token: inst.signalToken,
        payload: { reason, ...extra },
      },
      nowISO(),
      failureClass,
    );
    const phase = res.instance.phases.find((p) => p.id === phaseId);
    if (phase?.status === "failed") {
      phase.payload = withFailureClass(phase.payload, failureClass);
      if (failureClass !== "configuration") {
        noteFailure(def, res.instance, phaseId, failureClass, reason);
      } else {
        void journal(inst.id, {
          at: nowISO(),
          kind: "phase.failed",
          phaseId,
          attempt: phase.attempt,
          detail: `configuration: ${reason}`,
        });
      }
    }
    noteRouting(def, res.instance, res.routing);
    void journal(inst.id, {
      at: nowISO(),
      kind: "phase.signalled",
      phaseId,
      runId,
      detail: `harness: ${failureClass}`,
    });
    if (res.instance.status === "succeeded" || res.instance.status === "failed") {
      void journal(inst.id, { at: nowISO(), kind: "instance.ended", detail: res.instance.status });
    }
    return res;
  }

  interface LaunchContext {
    def: PipelineDefinition;
    phaseDef: PhaseDef;
    stepDef: PhaseStep;
    inst: PipelineInstance;
    publishes: boolean;
    artifactDir: string;
    timeoutSeconds: number | null;
    gitHead: string | null;
    /** The worktree the step runs in, when its phase declared a policy. */
    workspace: WorkspaceRecord | null;
    /** This pipeline's durable-notes directory, when `memory` is enabled. */
    memoryDir: string | null;
    /** Full values of any placeholder {@link interpolate} trimmed for this
     *  run's prompt, to write under its own invocation directory. */
    contextFiles: { path: string; contents: string }[];
  }

  type Launched =
    { handle: PipelineProcessHandle } | { failure: "spawn" | "configuration"; reason: string };

  /**
   * Prepare, record and spawn one step, persisting its pid.
   *
   * Preparation decides everything before the process exists: the runtime maps
   * the step's capability profile onto flags and config files, the environment
   * policy is applied, and the invocation record is written — so even a step
   * that never launches leaves a record of what Argus would have run and why it
   * refused. Under strict enforcement a profile the runtime cannot honour is a
   * `configuration` failure; the step does not launch with more capability than
   * its author declared.
   */
  async function launchStep(run: Run, ctx: LaunchContext): Promise<Launched> {
    await sem.acquire();
    const env: Record<string, string> = {
      ARGUS_SIGNAL_URL: `${deps.signalUrlBase}/api/instances/${ctx.inst.id}/signal`,
      ARGUS_INSTANCE_ID: ctx.inst.id,
      ARGUS_PHASE_ID: ctx.phaseDef.id,
      ARGUS_RUN_ID: run.id,
      ARGUS_STEP_NAME: run.scheduleName,
      ARGUS_SIGNAL_TOKEN: ctx.inst.signalToken,
      // Which CLI the hook is running under. One hook file serves both, and the
      // two deliver slightly different Stop payloads; this removes the guess.
      ARGUS_RUNTIME: resolveRuntimeId(run.runtime),
      // Where this phase's file artifacts go; later phases read them from here.
      ARGUS_ARTIFACT_DIR: ctx.artifactDir,
    };
    // The isolated worktree the step is already running in, named so a script
    // (or a nested tool) does not have to derive it from `pwd`. Per-invocation,
    // and therefore stripped from the inherited environment by buildChildEnv.
    if (ctx.workspace) env.ARGUS_WORKSPACE = ctx.workspace.path;
    // This pipeline's durable-notes directory, when `memory` is enabled.
    if (ctx.memoryDir) env.ARGUS_MEMORY_DIR = ctx.memoryDir;
    // The result file is named for every runtime, hook or no hook: the agent
    // writes the same file either way, and a runtime without a command hook has
    // it read off disk on the next reconcile tick instead.
    let resultFile: string | null = null;
    if (ctx.publishes) {
      resultFile = runResultPath(run.id);
      await mkdir(path.dirname(resultFile), { recursive: true });
      env.ARGUS_RESULT_FILE = resultFile;
    }
    const invocationDir = runInvocationDir(run.id);
    let prepared: PreparedInvocation;
    try {
      await mkdir(invocationDir, { recursive: true });
      // The clock the deadline runs from: now, with the slot held and the
      // process about to start.
      run.startedAt = nowISO();
      prepared = prepareInvocation({
        run,
        def: ctx.def,
        phaseDef: ctx.phaseDef,
        stepDef: ctx.stepDef,
        instanceId: ctx.inst.id,
        attempt: ctx.inst.phases.find((p) => p.id === ctx.phaseDef.id)?.attempt ?? 0,
        systemPrompt: OUTCOME_CONTRACT,
        argusEnv: env,
        invocationDir,
        artifactDir: ctx.artifactDir,
        memoryDir: ctx.memoryDir,
        workspace: ctx.workspace,
        resultFile,
        timeoutSeconds: ctx.timeoutSeconds,
        gitHead: ctx.gitHead,
        parentEnv: parentEnv(),
        now: new Date(run.startedAt),
      });
      run.deadlineAt = prepared.record.deadlineAt;
      await writeInvocation(prepared.record);
      for (const file of prepared.files) await writeFile(file.path, file.contents, "utf8");
      // Any placeholder {@link interpolate} trimmed for this run's prompt: the
      // full value, so the agent can still read the whole thing if it needs to.
      for (const file of ctx.contextFiles) {
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, file.contents, "utf8");
      }
    } catch (e) {
      sem.release();
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: String(e),
        endedAt: nowISO(),
      });
      return { failure: "spawn", reason: String(e) };
    }
    if (prepared.blocking.length > 0) {
      sem.release();
      const reason = `capability profile cannot be enforced by ${resolveRuntimeId(run.runtime)}: ${prepared.blocking.join("; ")}`;
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: reason,
        endedAt: nowISO(),
      });
      return { failure: "configuration", reason };
    }
    let handle: PipelineProcessHandle;
    try {
      const logPath = runLogPath(run.id);
      await mkdir(path.dirname(logPath), { recursive: true });
      handle = await Promise.resolve(deps.spawn(run, logPath, env, prepared));
    } catch (e) {
      sem.release();
      await writeRun({
        ...run,
        status: "failed",
        termination: "spawn-failed",
        error: String(e),
        endedAt: nowISO(),
      });
      return { failure: "spawn", reason: String(e) };
    }
    run.pid = handle.pid;
    await writeRun(run);
    deps.tailer?.track(run.id, ctx.inst.id, run.runtime);
    return { handle };
  }

  /** Await a launched step's completion off the request path, release its slot,
   *  and record the terminal state. Never throws. */
  function trackStep(
    run: Run,
    handle: { done: Promise<{ code: number | null }> },
    startedAt: string,
    instanceId: string,
    phaseId: string,
  ): void {
    let released = false;
    live.add(run.id);
    const release = () => {
      if (!released) {
        released = true;
        live.delete(run.id);
        sem.release();
      }
    };
    // The deadline is enforced from here while this process lives; after a
    // restart the reconcile pass enforces it from the persisted `deadlineAt`.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (run.deadlineAt) {
      const wait = Math.max(0, Date.parse(run.deadlineAt) - deps.now().getTime());
      timer = setTimeout(() => {
        timer = null;
        void track(
          expireStep(run.id, instanceId, phaseId).catch((e) =>
            log.error("step deadline handler failed", { runId: run.id, err: e }),
          ),
        );
      }, wait);
    }
    void handle.done
      .then(async (res) => {
        release();
        if (timer) clearTimeout(timer);
        // The CLI's JSON result envelope is the last line of the log; harvest
        // cost/tokens/result from it so every completed step reports its spend
        // (not only runs finalized by the adopted-run reconcile path).
        const got = await readRun(run.id);
        const envelope = got
          ? parseEnvelopeFor(run.runtime, got.log, { model: got.run.model })
          : null;
        // A run Argus itself ended (deadline, abort) keeps the reason Argus
        // wrote; the exit code of a killed process explains nothing.
        const endedByArgus =
          got?.run.termination === "timed-out" ||
          got?.run.termination === "stalled" ||
          got?.run.termination === "killed";
        await patchRun(run.id, {
          status: res.code === 0 && !endedByArgus ? "succeeded" : "failed",
          endedAt: nowISO(),
          durationMs: deps.now().getTime() - new Date(startedAt).getTime(),
          exitCode: res.code,
          // Codex names its own thread; the id only becomes knowable once the
          // stream has reported it, which by now the log has.
          sessionId: got?.run.sessionId ?? envelope?.sessionId ?? null,
          resultSummary: envelope?.result ?? got?.run.resultSummary ?? null,
          costUsd: envelope?.costUsd ?? got?.run.costUsd ?? null,
          tokens: envelope?.tokens ?? got?.run.tokens ?? null,
          error: endedByArgus
            ? (got?.run.error ?? "stopped by Argus")
            : res.code === 0
              ? null
              : `exit code ${res.code}`,
        });
        await accumulateRun(run.id, deps.now);
        // The completion signal is authoritative and has already advanced the
        // phase; a process that then exits non-zero contradicts its own report.
        // Argus does not unwind downstream work over it, but it must not be
        // silent either: the journal names it, and the run record carries both
        // the outcome and the exit code for anyone reconciling the two.
        if (res.code !== 0 && !endedByArgus && got?.run.outcome === "succeeded") {
          void journal(instanceId, {
            at: nowISO(),
            kind: "step.exit-mismatch",
            phaseId,
            runId: run.id,
            detail: `signalled completed, then exited ${res.code ?? "on a signal"}`,
          });
        }
        deps.tailer?.untrack(run.id);
        deps.onChange?.();
      })
      .catch((e) => {
        release();
        if (timer) clearTimeout(timer);
        deps.tailer?.untrack(run.id);
        log.error("step run completion handler failed", { runId: run.id, err: e });
      });
  }

  /**
   * Kill a run's process tree, escalating to SIGKILL after a grace period if
   * it ignores the request. The escalation is best-effort and unawaited: the
   * transition that follows must not wait on a process that may never answer.
   */
  async function stopRun(pid: number | null): Promise<void> {
    if (!pid) return;
    try {
      await kill(pid);
    } catch {
      /* already gone */
    }
    const grace = deps.killGraceMs ?? 5000;
    const t = setTimeout(() => {
      // Sent to the group regardless of the leader: a child that outlived an
      // exited leader is exactly the process this exists to reach. Killing a
      // group that is already gone is a harmless error.
      void Promise.resolve(kill(pid, "SIGKILL")).catch(() => {});
    }, grace);
    // Never keep the server alive just to escalate a kill.
    if (typeof t === "object" && "unref" in t) t.unref();
  }

  /**
   * A step has reached its deadline while its process is still alive: record
   * why it is being ended (before the close handler can read the exit code),
   * stop it, and fail the phase under the `timeout` class. The phase's sibling
   * steps are stopped too — a failed phase has no use for their work, and a
   * process nobody is waiting for is a process that keeps spending.
   */
  async function expireStep(runId: string, instanceId: string, phaseId: string): Promise<void> {
    const got = await readRun(runId);
    if (!got || got.run.status !== "running") return;
    const seconds =
      got.run.deadlineAt && got.run.startedAt
        ? Math.round((Date.parse(got.run.deadlineAt) - Date.parse(got.run.startedAt)) / 1000)
        : null;
    const reason = seconds != null ? `timed out after ${seconds}s` : "timed out";
    // Nothing is written until the step is known to still be running: a step
    // whose completion signal already landed is not timed out, whatever its
    // process is still doing, and must not be stamped as if it were.
    await failStep(
      instanceId,
      phaseId,
      runId,
      "timeout",
      reason,
      { kind: "timed-out" },
      async () => {
        await patchRun(runId, { termination: "timed-out", error: reason });
        await stopRun(got.run.pid);
        void journal(instanceId, {
          at: nowISO(),
          kind: "step.timed-out",
          phaseId,
          runId,
          detail: reason,
        });
      },
    );
  }

  /**
   * A step's process is still alive, but its transcript has gone quiet for at
   * least its `stallSeconds` (§D, harness/stall.ts) — killed the same way a
   * hard timeout is, under the same `timeout` retry class (a stall is a
   * timeout that noticed sooner), with its own termination and reason so the
   * two are distinguishable in the record.
   */
  async function expireStalledStep(
    runId: string,
    instanceId: string,
    phaseId: string,
    stallSeconds: number,
  ): Promise<void> {
    const got = await readRun(runId);
    if (!got || got.run.status !== "running") return;
    const reason = `stalled: no output for ${stallSeconds}s`;
    await failStep(instanceId, phaseId, runId, "timeout", reason, { kind: "stalled" }, async () => {
      await patchRun(runId, { termination: "stalled", error: reason });
      await stopRun(got.run.pid);
      void journal(instanceId, {
        at: nowISO(),
        kind: "step.stalled",
        phaseId,
        runId,
        detail: reason,
      });
    });
  }

  /**
   * Fail a running step from outside the signal path (deadline, or any other
   * harness-side verdict), under the instance lock. Only a step still tracked
   * as running is failed: a completion signal that landed first has already
   * decided, and a late failure must not overturn it.
   */
  async function failStep(
    instanceId: string,
    phaseId: string,
    runId: string,
    failureClass: PhaseFailureClass,
    reason: string,
    extra: Record<string, unknown> = {},
    /** Runs under the lock once the failure is known to apply, before the transition. */
    beforeTransition?: () => Promise<void>,
  ): Promise<void> {
    await locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst || inst.status !== "running") return;
      const phase = inst.phases.find((p) => p.id === phaseId);
      const step = phase?.steps.find((s) => s.runId === runId);
      if (!phase || phase.status !== "running" || step?.status !== "running") return;
      const def = await defFor(inst);
      if (!def) return;
      if (beforeTransition) await beforeTransition();
      const res = failStepInPlace(def, inst, phaseId, runId, failureClass, reason, extra);
      await patchRun(runId, { outcome: "failed" });
      await saveInstance(res.instance);
      if (res.candidatesMoved) {
        // One candidate timed out. Its siblings are the point of running
        // several, so they are left alone and the selection is re-asked.
        await settleCandidates(def, res.instance, res.candidatesMoved);
        deps.onChange?.();
        return;
      }
      await killPhaseRuns(res.instance, [phaseId], "stopped: phase failed");
      queueReadyPhases(instanceId, def, res.instance, res.startPhases);
      if (res.instance.status === "failed") deps.onFailure?.(res.instance);
      deps.onChange?.();
    });
  }

  /**
   * Kill any still-alive process spawned for the named phases, so a straggler
   * run can't keep executing (or later signal) against them.
   *
   * The phase ids are explicit rather than derived from "what is live" for two
   * reasons that pull in opposite directions, and both matter with a DAG:
   * aborting must reach phases the abort has *already* marked terminal, while
   * revising must **not** reach a sibling branch that is legitimately still
   * running.
   */
  async function killPhaseRuns(
    inst: PipelineInstance,
    phaseIds: string[],
    reason = "stopped by Argus",
  ): Promise<void> {
    const wanted = new Set(phaseIds);
    const steps = inst.phases.filter((p) => wanted.has(p.id)).flatMap((p) => p.steps);
    for (const s of steps) {
      if (!s.runId) continue;
      const got = await readRun(s.runId);
      if (got && got.run.status === "running" && isAlive(got.run.pid)) {
        // Written before the kill so the close handler reads the reason Argus
        // gave rather than inventing one from the exit code.
        if (!got.run.termination) {
          await patchRun(s.runId, { termination: "killed", error: reason });
        }
        await stopRun(got.run.pid);
      }
      deps.tailer?.untrack(s.runId);
    }
  }

  /**
   * Note the failure in the journal and, if the phase's policy allows it,
   * schedule another attempt.
   *
   * The retry is *scheduled* (a timestamp on the phase, persisted) rather than
   * awaited with a timer. A `setTimeout` would lose the retry on restart and
   * would hold the instance lock across the backoff; a stored `retryAt` that
   * the reconcile tick picks up survives a crash and costs nothing while it
   * waits. The trade is that backoff resolution is one scheduler tick, which
   * for a policy measured in seconds-to-minutes is not a trade at all.
   */
  function noteFailure(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    failure: RetryableClass,
    reason: string,
  ): boolean {
    const phase = inst.phases.find((p) => p.id === phaseId);
    if (!phase || phase.status !== "failed") return false;
    phase.payload = withFailureClass(phase.payload, failure);
    void journal(inst.id, {
      at: nowISO(),
      kind: "phase.failed",
      phaseId,
      attempt: phase.attempt,
      detail: `${failure}: ${reason}`,
    });

    const policy = def.phases.find((p) => p.id === phaseId)?.retry;
    if (!shouldRetry(policy, phase.retries ?? 0, failure)) return false;

    const at = new Date(deps.now().getTime() + retryDelayMs(policy!, phase.retries ?? 0));
    phase.retryAt = at.toISOString();
    // The instance is no longer terminal: something is still going to happen.
    inst.status = "running";
    inst.endedAt = null;
    void journal(inst.id, {
      at: nowISO(),
      kind: "phase.retry-scheduled",
      phaseId,
      attempt: phase.attempt,
      detail: `attempt ${(phase.retries ?? 0) + 2} of ${policy!.attempts} at ${phase.retryAt}`,
    });
    return true;
  }

  /**
   * Journal what a transition did to the graph's routes, and put any route or
   * result failure through the same policy an ordinary failure gets.
   *
   * Returns true when a retry was scheduled, so the caller re-persists the
   * instance. Nothing here decides anything: settle already did, and this only
   * writes down what it decided.
   */
  function noteRouting(
    def: PipelineDefinition,
    inst: PipelineInstance,
    routing: RouteOutcome | undefined,
  ): boolean {
    if (!routing) return false;
    for (const decision of routing.decisions) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "route.selection",
        phaseId: decision.sourcePhase,
        detail: `${decision.artifact} ${JSON.stringify(decision.value)} → ${decision.reason}`,
      });
    }
    for (const phaseId of routing.skipped) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "route.skip",
        phaseId,
        detail: "not selected by an upstream route",
      });
    }
    let rescheduled = false;
    for (const failure of routing.failures) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "route.failure",
        phaseId: failure.phaseId,
        detail: failure.reason,
      });
      // A result that never arrived, or arrived unusable, is an operational
      // signal failure: the agent reported, and what it reported cannot be
      // routed on. It gets the phase's own retry policy, never a branch.
      if (noteFailure(def, inst, failure.phaseId, "signal", failure.reason)) rescheduled = true;
    }
    return rescheduled;
  }

  /** Start every retry whose backoff has elapsed. Called from reconcile. */
  async function runDueRetries(now: Date): Promise<void> {
    for (const candidate of await readInstances()) {
      if (candidate.status !== "running" && candidate.status !== "failed") continue;
      if (!candidate.phases.some((p) => p.retryAt)) continue;
      const def = await defFor(candidate);
      if (!def) continue;
      await locks.withLock(candidate.id, async () => {
        const inst = await readInstance(candidate.id);
        if (!inst) return;
        const due = inst.phases.filter(
          (p) => p.status === "failed" && p.retryAt && Date.parse(p.retryAt) <= now.getTime(),
        );
        for (const phase of due) {
          const note = await buildRetryNote(def, phase);
          const res = applyRetry(inst, phase.id, nowISO());
          if (res.startPhases.length === 0) continue;
          await saveInstance(res.instance);
          void journal(inst.id, {
            at: nowISO(),
            kind: "phase.retrying",
            phaseId: phase.id,
            attempt: phase.attempt,
          });
          await startPhases(def, res.instance, res.startPhases, note);
          deps.onChange?.();
        }
      });
    }
  }

  async function adopt(): Promise<void> {
    for (const inst of await readInstances()) {
      if (inst.status !== "running") continue;
      // Every live phase, not just one: a fan-out has several in flight, and an
      // unadopted run is a process nobody is tracking.
      for (const s of livePhases(inst).flatMap((i) => inst.phases[i].steps)) {
        if (s.status !== "running" || !s.runId || adopted.has(s.runId)) continue;
        const got = await readRun(s.runId);
        if (!got || got.run.status !== "running" || !isAlive(got.run.pid)) continue;
        await sem.acquire();
        adopted.set(s.runId, { instanceId: inst.id });
        deps.tailer?.track(s.runId, inst.id, got.run.runtime);
      }
    }
  }

  async function start(
    pipelineId: string,
    trigger: PipelineInstance["trigger"] = "manual",
    firing?: { triggerPayload?: unknown; chainedFrom?: string },
  ) {
    const def = await loadDef(pipelineId);
    if (!def) throw new Error("pipeline not found");
    if (def.overlapPolicy === "skip") {
      const busy = (await readInstances({ pipelineId })).some(
        (i) => i.status === "running" || i.status === "awaiting-approval",
      );
      if (busy) return null;
    }
    if (deps.preflight) {
      const pf = await deps.preflight();
      if (!pf.ok) throw new PreflightError(pf.reasons);
    }
    const { instance, startPhases: ready } = initInstance(
      def,
      trigger,
      { instanceId: deps.newId(), token: deps.newId() },
      nowISO(),
      firing,
    );
    await saveInstance(instance);
    await markPipelineStarted(def.id, instance.createdAt);
    void journal(instance.id, {
      at: instance.createdAt,
      kind: "instance.started",
      detail: `${def.name} (${trigger})`,
    });
    // Under the lock like every other launch, so a reconcile tick that sees
    // the new instance cannot mistake a step still being prepared for one
    // whose launch was lost.
    await locks.withLock(instance.id, () => startPhases(def, instance, ready));
    await pruneInstances(def.id, INSTANCE_KEEP);
    deps.onChange?.();
    return instance;
  }

  /**
   * Launch phases exposed by a transition after the caller releases the
   * instance lock. Signal handlers must answer the child before waiting for a
   * concurrency slot, and reconciliation uses the same path so fallback and a
   * delayed hook have one idempotency boundary.
   */
  function queueReadyPhases(
    instanceId: string,
    def: PipelineDefinition,
    transitioned: PipelineInstance,
    ready: number[],
  ): void {
    if (ready.length === 0) return;
    const wantIds = ready.map((i) => transitioned.phases[i].id);
    void track(
      locks
        .withLock(instanceId, async () => {
          const fresh = await readInstance(instanceId);
          if (!fresh || fresh.status !== "running") return;
          // Re-resolve by phase id: an abort/revise landing in the transition
          // window may have changed which work is live.
          const stillWanted = wantIds
            .map((id) => fresh.phases.findIndex((p) => p.id === id))
            .filter((i) => i >= 0 && fresh.phases[i].status === "running");
          await startPhases(def, fresh, stillWanted);
        })
        .catch((e: unknown) => log.error("deferred phase start failed", { instanceId, err: e })),
    );
  }

  /**
   * Run a phase's declared checks off the lock, then record the verdict under
   * it.
   *
   * The checks are Argus's own work — a test command, a required artifact, the
   * set of files the agent touched — and can take as long as a test suite. They
   * run outside the instance lock so signals for sibling branches keep flowing,
   * and the verdict is applied by {@link applyVerification}, which refuses a
   * report for any phase attempt that is no longer waiting on one. Keyed by
   * attempt so a crash mid-verification is re-run by reconcile, and a revise
   * during the checks makes the stale report a no-op rather than a decision.
   */
  function queueVerification(
    instanceId: string,
    def: PipelineDefinition,
    phaseId: string,
    attempt: number,
  ): void {
    const key = `${instanceId}:${phaseId}:${attempt}`;
    if (verifying.has(key)) return;
    verifying.add(key);
    const phaseDef = def.phases.find((p) => p.id === phaseId);
    void track(
      (async () => {
        if (!phaseDef) return;
        const inst = await readInstance(instanceId);
        const phase = inst?.phases.find((p) => p.id === phaseId);
        if (!inst || !phase) return;
        void journal(instanceId, {
          at: nowISO(),
          kind: "phase.verifying",
          phaseId,
          attempt,
          detail: `${phaseDef.checks?.length ?? 0} check${phaseDef.checks?.length === 1 ? "" : "s"}`,
        });
        let baseline: WorkingTreeSnapshot | null = null;
        try {
          baseline = JSON.parse(
            await readFile(
              phaseBaselinePath(paths.invocationsDir(), instanceId, phaseId, attempt),
              "utf8",
            ),
          ) as WorkingTreeSnapshot;
        } catch {
          /* no baseline recorded (not a git repository, or no changed-files check) */
        }
        const report = await runChecks(phaseDef.checks ?? [], {
          // The checks look at the work, so they look where the work happened:
          // the phase's worktree when it had one, its own cwd otherwise.
          cwd: phase.workspace?.path ?? phaseDef.cwd,
          artifactDir: phase.artifactDir ?? null,
          baseline,
          now: deps.now,
          // The checks run under the phase's own environment policy: a command
          // check is a script in the repository the agent just edited, and must
          // not see what the agent was not allowed to see.
          env: buildChildEnv(parentEnv(), resolveCapabilities(def, phaseDef, {})?.env).env,
        });
        await locks.withLock(instanceId, async () => {
          const fresh = await readInstance(instanceId);
          if (!fresh || fresh.status !== "running") return;
          const current = fresh.phases.find((p) => p.id === phaseId);
          if (!current || current.attempt !== attempt) return;
          const res = applyVerification(def, fresh, phaseId, report, nowISO());
          if (!res.verificationApplied) return;
          const failed = report.status === "failed";
          void journal(instanceId, {
            at: nowISO(),
            kind: "phase.verified",
            phaseId,
            attempt,
            detail: failed
              ? `failed: ${report.checks
                  .filter((c) => c.status === "failed")
                  .map((c) => c.label)
                  .join(", ")}`
              : `passed: ${report.checks.length} check${report.checks.length === 1 ? "" : "s"}`,
          });
          if (failed) {
            const reason =
              (res.instance.phases.find((p) => p.id === phaseId)?.payload as PhaseFailurePayload)
                ?.reason ?? "verification failed";
            noteFailure(def, res.instance, phaseId, "verification", reason);
          }
          noteRouting(def, res.instance, res.routing);
          await saveInstance(res.instance);
          if (res.instance.status === "succeeded" || res.instance.status === "failed") {
            void journal(instanceId, {
              at: nowISO(),
              kind: "instance.ended",
              detail: res.instance.status,
            });
          }
          queueReadyPhases(instanceId, def, res.instance, res.startPhases);
          if (res.instance.status === "failed") deps.onFailure?.(res.instance);
          deps.onChange?.();
        });
      })()
        .catch((e: unknown) =>
          log.error("phase verification failed to run", { instanceId, phaseId, err: e }),
        )
        .finally(() => verifying.delete(key)),
    );
  }

  // ── Candidates ─────────────────────────────────────────────────────────────

  /**
   * Every candidate of a phase, as the selectors need to read it: what the
   * instance persisted, joined with what the run records say it cost.
   *
   * The join lives here rather than in the transitions because cost and
   * duration are not on the instance — they are read off the run at display
   * time — and `cheapest-verified` is precisely a rule about them.
   */
  async function candidateRecordsFor(phase: PhaseProgress): Promise<CandidateRecord[]> {
    const records: CandidateRecord[] = [];
    for (const step of phase.steps) {
      if (step.candidate === undefined) continue;
      const got = step.runId ? await readRun(step.runId) : null;
      records.push({
        ...candidateRecordOf(step),
        costUsd: got?.run.costUsd ?? null,
        durationMs: got?.run.durationMs ?? null,
        runtime: got?.run.runtime ?? null,
        model: got?.run.model ?? null,
      });
    }
    return records;
  }

  /** Remove the worktrees of the candidates that did not win. The branches
   *  survive, as everywhere else: a losing draft is still evidence, and a
   *  `keep` policy keeps its directory too. */
  async function removeCandidateTrees(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseDef: PhaseDef,
    phase: PhaseProgress,
    keptCandidate: number | null,
  ): Promise<void> {
    if (workspacePolicyFor(def, phaseDef)?.keep === true) return;
    for (const step of phase.steps) {
      if (step.candidate === undefined || step.candidate === keptCandidate) continue;
      if (!step.workspace) continue;
      const tree = step.workspace;
      // The record is only forgotten once the directory is: a tree the kill
      // raced (the agent still writing as git was asked to take it away) stays
      // on the step, and the instance's own cleanup collects it at settlement.
      if (await removeWorkspace(inst.id, phaseDef.cwd, tree.path, tree.branch)) {
        step.workspace = null;
      }
    }
  }

  /**
   * Ask a candidates phase whether it has an answer yet, and act on it.
   *
   * Called after anything that could move a candidate — a signal, a report from
   * its checks, a deadline, a run found dead after a restart — always under the
   * instance lock, with the in-memory instance. Three outcomes, and the first is
   * the common one:
   *
   *  - nothing decided yet, so nothing happens;
   *  - a winner, whose worktree, payload, result and verification become the
   *    phase's; the siblings still running are killed (`first-verified` exists
   *    to stop paying for them) and their trees removed;
   *  - nobody left who could win, so the phase fails once, with every
   *    candidate's fate in the reason and the retry policy applied as usual.
   */
  async function settleCandidates(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
  ): Promise<void> {
    const phase = inst.phases.find((p) => p.id === phaseId);
    const phaseDef = def.phases.find((p) => p.id === phaseId);
    if (!phase || !phaseDef?.candidates || phase.status !== "running") return;
    const records = await candidateRecordsFor(phase);
    const decision = selectCandidate(phaseDef.candidates, records);
    if (decision.kind === "pending") return;
    const outcomes = toCandidateOutcomes(records);

    let res: TransitionResult;
    if (decision.kind === "selected") {
      const winner = decision.candidate;
      // Kill first, transition second: the reason is written onto the run
      // record before the process dies, so the close handler reports "superseded
      // by candidate k" rather than inventing something from an exit code.
      for (const step of phase.steps) {
        if (step.candidate === undefined || step.candidate === winner || !step.runId) continue;
        const got = await readRun(step.runId);
        if (got && got.run.status === "running" && isAlive(got.run.pid)) {
          if (!got.run.termination) {
            await patchRun(step.runId, {
              termination: "killed",
              error: `superseded by candidate ${winner}`,
            });
          }
          await stopRun(got.run.pid);
        }
        deps.tailer?.untrack(step.runId);
      }
      await removeCandidateTrees(def, inst, phaseDef, phase, winner);
      res = applyCandidateSelection(def, inst, phaseId, winner, outcomes, nowISO());
      void journal(inst.id, {
        at: nowISO(),
        kind: "phase.candidate-selected",
        phaseId,
        attempt: phase.attempt,
        detail: `c${winner} of ${records.length} (${phaseDef.candidates.select})`,
      });
    } else {
      const failureClass = candidateFailureClass(records);
      const reason = candidateFailureReason(records);
      await removeCandidateTrees(def, inst, phaseDef, phase, null);
      res = applyCandidatesExhausted(def, inst, phaseId, failureClass, reason, outcomes, nowISO());
      if (failureClass === "configuration") {
        // Every candidate was refused as declared, so the definition is what is
        // wrong and another attempt cannot help. Journalled, never retried.
        void journal(inst.id, {
          at: nowISO(),
          kind: "phase.failed",
          phaseId,
          attempt: phase.attempt,
          detail: `configuration: ${reason}`,
        });
      } else {
        // The class is already on the payload; this is what schedules the retry
        // and writes the `phase.failed` entry, exactly as for any other failure.
        noteFailure(def, res.instance, phaseId, failureClass, reason);
      }
    }

    noteRouting(def, res.instance, res.routing);
    await saveInstance(res.instance);
    if (res.instance.status === "succeeded" || res.instance.status === "failed") {
      void journal(inst.id, { at: nowISO(), kind: "instance.ended", detail: res.instance.status });
    }
    queueReadyPhases(inst.id, def, res.instance, res.startPhases);
    if (res.instance.status === "failed") deps.onFailure?.(res.instance);
    deps.onChange?.();
  }

  /**
   * Run one candidate's copy of the phase's checks, inside that candidate's own
   * worktree, against its own baseline and artifact directory.
   *
   * The same shape as {@link queueVerification} and for the same reasons — off
   * the lock because a test suite takes as long as a test suite, keyed so a
   * crash mid-verification is re-run by reconcile and a stale report is a no-op
   * — but keyed by candidate as well as attempt, because a candidates phase has
   * `count` independent verdicts rather than one.
   */
  function queueCandidateVerification(
    instanceId: string,
    def: PipelineDefinition,
    phaseId: string,
    attempt: number,
    candidate: number,
  ): void {
    const key = `${instanceId}:${phaseId}:${attempt}:c${candidate}`;
    if (verifying.has(key)) return;
    verifying.add(key);
    const phaseDef = def.phases.find((p) => p.id === phaseId);
    void track(
      (async () => {
        if (!phaseDef) return;
        const inst = await readInstance(instanceId);
        const phase = inst?.phases.find((p) => p.id === phaseId);
        const step = phase?.steps.find((s) => s.candidate === candidate);
        if (!inst || !phase || !step) return;
        const count = phaseDef.checks?.length ?? 0;
        void journal(instanceId, {
          at: nowISO(),
          kind: "phase.verifying",
          phaseId,
          attempt,
          detail: `c${candidate}: ${count} check${count === 1 ? "" : "s"}`,
        });
        let baseline: WorkingTreeSnapshot | null = null;
        try {
          baseline = JSON.parse(
            await readFile(
              phaseBaselinePath(paths.invocationsDir(), instanceId, phaseId, attempt, candidate),
              "utf8",
            ),
          ) as WorkingTreeSnapshot;
        } catch {
          /* no baseline recorded (not a git repository, or no changed-files check) */
        }
        const own = candidateArtifactDir(
          phase.artifactDir ?? phaseArtifactDir(paths.artifactsDir(), instanceId, phaseId),
          candidate,
        );
        const report = await runChecks(phaseDef.checks ?? [], {
          // This candidate's tree, not the phase's: the whole point is that each
          // draft is judged on what it alone did.
          cwd: step.workspace?.path ?? phase.workspace?.path ?? phaseDef.cwd,
          artifactDir: own,
          baseline,
          now: deps.now,
          env: buildChildEnv(parentEnv(), resolveCapabilities(def, phaseDef, {})?.env).env,
        });
        await locks.withLock(instanceId, async () => {
          const fresh = await readInstance(instanceId);
          if (!fresh || fresh.status !== "running") return;
          const current = fresh.phases.find((p) => p.id === phaseId);
          if (!current || current.attempt !== attempt) return;
          const res = applyCandidateVerification(fresh, phaseId, candidate, report, nowISO());
          if (!res.verificationApplied) return;
          void journal(instanceId, {
            at: nowISO(),
            kind: "phase.verified",
            phaseId,
            attempt,
            detail:
              report.status === "passed"
                ? `c${candidate} passed: ${report.checks.length} check${report.checks.length === 1 ? "" : "s"}`
                : `c${candidate} failed: ${report.checks
                    .filter((c) => c.status === "failed")
                    .map((c) => c.label)
                    .join(", ")}`,
          });
          await saveInstance(res.instance);
          await settleCandidates(def, res.instance, phaseId);
          deps.onChange?.();
        });
      })()
        .catch((e: unknown) =>
          log.error("candidate verification failed to run", {
            instanceId,
            phaseId,
            candidate,
            err: e,
          }),
        )
        .finally(() => verifying.delete(key)),
    );
  }

  /** Start the checks a transition asked for, by phase id. */
  function queueVerifications(
    instanceId: string,
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseIds: string[] | undefined,
  ): void {
    for (const id of phaseIds ?? []) {
      const phase = inst.phases.find((p) => p.id === id);
      if (phase) queueVerification(instanceId, def, id, phase.attempt);
    }
  }

  async function onSignal(instanceId: string, signal: PipelineSignal): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404 };
      if (signal.token !== inst.signalToken) return { ok: false, code: 403 };
      if (inst.status !== "running") return { ok: true, code: 200 }; // paused/terminal → idempotent ignore
      const def = await defFor(inst);
      if (!def) return { ok: false, code: 404 };
      const res = advance(def, inst, signal, nowISO());
      const outcome: Run["outcome"] | undefined =
        signal.type === "failed" ? "failed" : signal.type === "completed" ? "succeeded" : undefined;
      if (res.ignored) {
        // The instance is untouched; say so where someone debugging will look,
        // instead of journalling the signal as if it had landed. The run did
        // report, so its own record keeps the outcome.
        const status = inst.phases.find((p) => p.id === signal.phaseId)?.status;
        const why =
          res.ignored === "unknown-phase"
            ? `no phase "${signal.phaseId}" on this instance`
            : res.ignored === "phase-not-running"
              ? `phase "${signal.phaseId}" is ${status}, not running`
              : `run ${signal.runId} is not a tracked step of phase "${signal.phaseId}"`;
        log.warn("pipeline signal ignored", {
          instanceId,
          phaseId: signal.phaseId,
          runId: signal.runId,
          type: signal.type,
          reason: res.ignored,
        });
        if (outcome) await patchRun(signal.runId, { outcome });
        void journal(instanceId, {
          at: nowISO(),
          kind: "phase.signalled",
          phaseId: signal.phaseId,
          runId: signal.runId,
          detail: `${signal.type} (ignored: ${why})`,
        });
        return { ok: true, code: 202 };
      }
      const { instance, startPhases: ready, routing, verify, verifyCandidate } = res;
      noteRouting(def, instance, routing);
      // A candidate's failure is not the phase's: it loses, the phase carries
      // on, and `settleCandidates` below decides whether anything is left.
      if (signal.type === "failed" && !res.candidatesMoved) {
        // An agent that signalled failure has considered the work, so this
        // class is excluded from the default retry set — but an author who
        // opted into it gets it.
        noteFailure(def, instance, signal.phaseId, "signal", "the agent signalled failure");
      }
      // One write: the route decision, the skips it implies, the phase
      // statuses, the failure class and any scheduled retry land together or
      // not at all.
      await saveInstance(instance);
      queueVerifications(instanceId, def, instance, verify);
      if (verifyCandidate) {
        const phase = instance.phases.find((p) => p.id === verifyCandidate.phaseId);
        if (phase) {
          queueCandidateVerification(
            instanceId,
            def,
            verifyCandidate.phaseId,
            phase.attempt,
            verifyCandidate.candidate,
          );
        }
      }
      if (outcome) await patchRun(signal.runId, { outcome });
      void journal(instance.id, {
        at: nowISO(),
        kind: "phase.signalled",
        phaseId: signal.phaseId,
        runId: signal.runId,
        detail: signal.type,
      });
      if (res.candidatesMoved) {
        // Everything after this — the phase's own conclusion, its journal
        // entries, the next phases — is the selection's business, not the
        // signalling candidate's.
        await settleCandidates(def, instance, res.candidatesMoved);
        deps.onChange?.();
        return { ok: true, code: 202 };
      }
      if (instance.status === "succeeded" || instance.status === "failed") {
        void journal(instance.id, {
          at: nowISO(),
          kind: "instance.ended",
          detail: instance.status,
        });
      }
      // Start the next phase detached: this handler runs on the child's signal
      // POST, and that child may still hold its concurrency slot until its
      // process exits after we respond. Awaiting startPhase here (which acquires
      // a slot) would deadlock when all slots are held by children waiting on
      // their own signal responses. The detached continuation RE-ACQUIRES the
      // instance lock and re-verifies liveness before launching, so an abort/
      // revise landing in the transition window can't be clobbered and won't be
      // raced into spawning orphan children (it queues behind, then kills them).
      queueReadyPhases(instanceId, def, instance, ready);
      if (instance.status === "failed") deps.onFailure?.(instance);
      deps.onChange?.();
      return { ok: true, code: 202 };
    });
  }

  async function approve(
    instanceId: string,
    answers?: unknown,
    options: GateTarget = {},
  ): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404, error: "instance not found" };
      const def = await defFor(inst);
      if (!def) return { ok: false, code: 404, error: "pipeline not found" };
      let res;
      try {
        res = applyApprove(def, inst, answers, nowISO(), options.phaseId);
      } catch (e) {
        return { ok: false, code: 409, error: e instanceof Error ? e.message : String(e) };
      }
      await saveInstance(res.instance);
      if (noteRouting(def, res.instance, res.routing)) await saveInstance(res.instance);
      await startPhases(def, res.instance, res.startPhases);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  async function revise(
    instanceId: string,
    note?: string,
    options: GateTarget = {},
  ): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404, error: "instance not found" };
      const def = await defFor(inst);
      if (!def) return { ok: false, code: 404, error: "pipeline not found" };
      // Validate the transition BEFORE any destructive side effect: killing the
      // phase's straggler runs must not happen if the instance can't be revised
      // (e.g. it isn't awaiting approval), or a rejected 409 would still have
      // torn down live work.
      let res;
      try {
        res = applyRevise(inst, nowISO(), options.phaseId);
      } catch (e) {
        return { ok: false, code: 409, error: e instanceof Error ? e.message : String(e) };
      }
      // Only the revised phase: a sibling branch that is legitimately running
      // is not part of this decision, and killing it would be a silent abort.
      await killPhaseRuns(
        inst,
        res.startPhases.map((i) => res.instance.phases[i].id),
        "superseded by a revise",
      );
      await saveInstance(res.instance);
      const suffix = note ? `\n\nRevision note: ${note}` : "";
      await startPhases(def, res.instance, res.startPhases, suffix);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  async function abort(instanceId: string): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404, error: "instance not found" };
      let aborted: PipelineInstance;
      try {
        aborted = applyAbort(inst, nowISO());
      } catch (e) {
        return { ok: false, code: 409, error: e instanceof Error ? e.message : String(e) };
      }
      // Everything: an abort stops the whole instance, including branches the
      // applyAbort above has already marked terminal.
      await killPhaseRuns(
        inst,
        inst.phases.map((p) => p.id),
        "aborted",
      );
      await saveInstance(aborted);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  async function reconcile() {
    const defs = await readPipelines();
    const grace = graceMsFor(deps.tickMs ?? 30000);
    const now = deps.now();

    // 0. Finalize adopted (reattached) runs whose detached process has ended.
    //    The in-memory done-handler was lost with the previous server process,
    //    so status/result come from the log's JSON envelope instead. Instance
    //    advancement is not done here — the healing pass below (under the
    //    instance lock) handles steps whose runs ended without signalling.
    for (const runId of [...adopted.keys()]) {
      try {
        const got = await readRun(runId);
        if (!got || got.run.status !== "running") {
          adopted.delete(runId);
          sem.release();
          deps.tailer?.untrack(runId);
          continue;
        }
        if (isAlive(got.run.pid)) {
          // The deadline outlives the process that set the timer: an adopted
          // run past its deadline is ended here, and finalized next tick.
          if (
            got.run.deadlineAt &&
            !got.run.termination &&
            Date.parse(got.run.deadlineAt) <= now.getTime()
          ) {
            const reason = `timed out after ${Math.round(
              (Date.parse(got.run.deadlineAt) - Date.parse(got.run.startedAt ?? got.run.queuedAt)) /
                1000,
            )}s`;
            await patchRun(runId, { termination: "timed-out", error: reason });
            await stopRun(got.run.pid);
            if (got.run.instanceId && got.run.phaseId) {
              void journal(got.run.instanceId, {
                at: nowISO(),
                kind: "step.timed-out",
                phaseId: got.run.phaseId,
                runId,
                detail: reason,
              });
            }
          }
          continue;
        }
        const envelope = parseEnvelopeFor(got.run.runtime, got.log, { model: got.run.model });
        const parsed = envelope.isError !== null || envelope.result !== null ? envelope : null;
        const ended = deps.now();
        // patchRun (not a full writeRun spread): the signal path patches
        // `outcome` concurrently, and a stale full-object write would drop it.
        const endedByArgus =
          got.run.termination === "timed-out" ||
          got.run.termination === "stalled" ||
          got.run.termination === "killed";
        await patchRun(runId, {
          status: parsed && parsed.isError === false && !endedByArgus ? "succeeded" : "failed",
          endedAt: ended.toISOString(),
          durationMs: got.run.startedAt
            ? ended.getTime() - new Date(got.run.startedAt).getTime()
            : null,
          exitCode: null,
          sessionId: got.run.sessionId ?? parsed?.sessionId ?? null,
          resultSummary: parsed?.result ?? got.run.resultSummary,
          costUsd: parsed?.costUsd ?? got.run.costUsd,
          tokens: parsed?.tokens ?? got.run.tokens,
          error: endedByArgus
            ? got.run.error
            : !parsed
              ? "ended while detached; no parseable result"
              : parsed.isError === false
                ? null
                : (parsed.result ?? "run reported is_error"),
        });
        await accumulateRun(runId, deps.now);
        adopted.delete(runId);
        sem.release();
        deps.tailer?.untrack(runId);
        deps.onChange?.();
      } catch (e) {
        // Keep the run adopted; retried next tick.
        log.error("finalize of adopted run failed", { err: e });
      }
    }

    // 1. Start clock-due pipeline definitions.
    for (const def of defs) {
      if (!def.enabled || !def.trigger) continue;
      const anchor = new Date(def.lastStartedAt ?? def.createdAt);
      const prev = previousFireTime(def.trigger, anchor, now);
      if (!prev) continue;
      // Don't backfill a slot from before the pipeline was created (mirrors
      // shouldFire): avoids an immediate fire on creation within the window.
      if (prev.getTime() < new Date(def.createdAt).getTime()) continue;
      if (def.lastStartedAt && new Date(def.lastStartedAt).getTime() >= prev.getTime()) continue;
      if (now.getTime() - prev.getTime() > grace) continue;
      await start(def.id, "scheduled");
    }

    // 2. Start any retry whose backoff has elapsed. Before healing, so a phase
    //    that just became due is retried rather than re-examined as an orphan.
    await runDueRetries(now);

    // 2.5 Stall detection (§D): a running step whose transcript has gone
    //     quiet longer than its declared `stallSeconds`, even though the
    //     process is still alive, is killed like a timeout. Reuses this same
    //     reconcile tick rather than a second timer system, and covers both
    //     this process's own runs and adopted ones — the run tailer's
    //     `latest()` only knows about runs *this* process is tailing, so
    //     `Run.lastActivityAt` (refreshed here, persisted) is what a restart
    //     falls back to until the tailer catches up.
    for (const candidate of await readInstances()) {
      if (candidate.status !== "running") continue;
      const def = candidate.definition ?? defs.find((d) => d.id === candidate.pipelineId);
      if (!def) continue;
      for (const i of livePhases(candidate)) {
        const phase = candidate.phases[i];
        if (phase.status !== "running") continue;
        const phaseDef = def.phases.find((p) => p.id === phase.id);
        if (!phaseDef) continue;
        for (const step of phase.steps) {
          if (step.status !== "running" || !step.runId) continue;
          const stepDef = phaseDef.candidates
            ? phaseDef.steps[0]
            : phaseDef.steps.find((s) => s.name === step.name);
          const stallSeconds = resolveStallSeconds(phaseDef, stepDef ?? {});
          if (!stallSeconds) continue;
          const got = await readRun(step.runId);
          if (!got || got.run.status !== "running" || got.run.termination) continue;
          const observed = deps.tailer?.latest?.().get(step.runId)?.at ?? null;
          if (observed && observed !== got.run.lastActivityAt) {
            await patchRun(step.runId, { lastActivityAt: observed });
          }
          const lastActivityAt = observed ?? got.run.lastActivityAt ?? null;
          if (isStalled({ stallSeconds, lastActivityAt, startedAt: got.run.startedAt, now })) {
            await expireStalledStep(step.runId, candidate.id, phase.id, stallSeconds);
          }
        }
      }
    }

    // 3. Heal running instances whose live-phase runs ended without signalling.
    //    Each instance is healed under its lock, re-reading fresh state inside,
    //    so a genuine completion signal landing mid-pass is never clobbered by a
    //    stale "failed" write (the TOCTOU the lock closes).
    //    Over the instances, not the definitions: an instance heals against its
    //    own snapshot, so one whose definition was edited — or deleted — under
    //    it is healed like any other rather than left running forever.
    for (const candidate of await readInstances()) {
      if (candidate.status !== "running") continue;
      const def = candidate.definition ?? defs.find((d) => d.id === candidate.pipelineId);
      if (!def) continue;
      await locks.withLock(candidate.id, async () => {
        const inst = await readInstance(candidate.id);
        if (!inst || inst.status !== "running") return;
        let current = inst;
        // A phase whose checks were running when Argus stopped is verified
        // again: the checks are Argus's own and deterministic, and the
        // attempt key makes a duplicate report a no-op.
        for (const i of livePhases(current)) {
          const phase = current.phases[i];
          if (phase.status !== "running") continue;
          if (
            phase.verification?.status === "running" &&
            !verifying.has(`${current.id}:${phase.id}:${phase.attempt}`)
          ) {
            queueVerification(current.id, def, phase.id, phase.attempt);
          }
          // The same for each candidate that was being verified when Argus
          // stopped. Keyed by candidate as well as attempt, so a duplicate
          // report is the same no-op it is for an ordinary phase.
          for (const step of phase.steps) {
            if (step.candidate === undefined) continue;
            if (step.verification?.status !== "running") continue;
            if (verifying.has(`${current.id}:${phase.id}:${phase.attempt}:c${step.candidate}`)) {
              continue;
            }
            queueCandidateVerification(current.id, def, phase.id, phase.attempt, step.candidate);
          }
        }
        // Every live phase: with a fan-out, a died-without-signalling run can
        // be in any of them, and healing only one would leave the others
        // showing a working tile forever.
        const orphans = livePhases(current).flatMap((i) =>
          current.phases[i].steps.map((s) => ({ phaseId: current.phases[i].id, step: s })),
        );
        for (const { phaseId, step: s } of orphans) {
          if (s.status !== "running" || !s.runId) continue;
          let got = await readRun(s.runId);
          // A step recorded as running with no process behind it — no run
          // record at all, or one that never got a pid — and not being
          // launched by this process: Argus stopped between recording the
          // step and starting it. Nothing will ever signal for it, so it is
          // failed here as a spawn failure (retryable by default).
          if (
            !live.has(s.runId) &&
            (!got || (got.run.status === "running" && got.run.pid == null))
          ) {
            const stepDef = def.phases.find((p) => p.id === phaseId);
            const reason = "Argus stopped before the step's process was started";
            const stub: Run = got?.run ?? {
              id: s.runId,
              scheduleId: `pipeline:${current.pipelineId}`,
              scheduleName: `${current.pipelineName} · ${stepDef?.name ?? phaseId}`,
              prompt: "",
              cwd: stepDef?.cwd ?? "",
              status: "running",
              trigger: "scheduled",
              queuedAt: nowISO(),
              startedAt: null,
              endedAt: null,
              durationMs: null,
              pid: null,
              exitCode: null,
              sessionId: null,
              project: stepDef ? encodeProject(stepDef.cwd) : null,
              resultSummary: null,
              error: null,
              instanceId: current.id,
              phaseId,
            };
            await writeRun({
              ...stub,
              status: "failed",
              termination: "spawn-failed",
              error: reason,
              endedAt: nowISO(),
            });
            got = await readRun(s.runId);
          }
          // Reconcile only from a completed run record. A dead pid whose
          // record is still `running` can be racing the normal close handler;
          // guessing in that window would discard the agent's final message,
          // which is what distinguishes success, failure, and ambiguity.
          const ended =
            got &&
            (got.run.status === "failed" ||
              got.run.status === "succeeded" ||
              got.run.status === "interrupted" ||
              got.run.status === "cancelled");
          if (!ended) continue;
          const restarted = got?.run.status === "interrupted";
          const recovered =
            !restarted && got && runtimeFor(got.run.runtime).outcomeFromRecord
              ? recoverRunOutcome(got.run)
              : null;
          const signalType = recovered?.signalType ?? "failed";
          // A recovered *completion* may carry a declared result. Read it the
          // same way the stop hook would; this is the whole completion
          // protocol for a runtime with no hook to install.
          const recoveredResult = signalType === "completed" ? await readRunResult(s.runId) : {};
          const payload = recovered
            ? recovered.payload
            : restarted
              ? { reason: "Argus restarted mid-run — revise to retry", kind: "restarted" }
              : {
                  reason: got?.run.error ?? "run ended without emitting a completion signal",
                };
          const {
            instance,
            startPhases: ready,
            routing,
            verify,
            verifyCandidate,
            candidatesMoved,
          } = advance(
            def,
            current,
            {
              instanceId: current.id,
              phaseId,
              runId: s.runId,
              type: signalType,
              token: current.signalToken,
              payload,
              ...recoveredResult,
            },
            nowISO(),
            signalType === "failed"
              ? (recovered?.failureClass ?? (got ? failureClassOfRecord(got.run) : "spawn"))
              : undefined,
          );
          if (recovered) await patchRun(s.runId, { outcome: recovered.outcome });
          if (signalType === "failed" && !candidatesMoved) {
            // Class the failure from what the run record shows, so retry
            // policies keep distinguishing infrastructure from an agent's
            // considered failed/blocked conclusion.
            const failureClass: RetryableClass =
              recovered?.failureClass ?? (got ? failureClassOfRecord(got.run) : "spawn");
            const reason =
              recovered?.failureReason ??
              (payload as { reason?: string }).reason ??
              "run ended without emitting a completion signal";
            noteFailure(def, instance, phaseId, failureClass, reason);
          }
          noteRouting(def, instance, routing);
          await saveInstance(instance);
          queueVerifications(instance.id, def, instance, verify);
          if (verifyCandidate) {
            const healed = instance.phases.find((p) => p.id === verifyCandidate.phaseId);
            if (healed) {
              queueCandidateVerification(
                instance.id,
                def,
                verifyCandidate.phaseId,
                healed.attempt,
                verifyCandidate.candidate,
              );
            }
          }
          void journal(instance.id, {
            at: nowISO(),
            kind: "phase.signalled",
            phaseId,
            runId: s.runId,
            detail: recovered ? `run-record fallback: ${recovered.outcome}` : "reconcile: failed",
          });
          deps.tailer?.untrack(s.runId);
          if (candidatesMoved) await settleCandidates(def, instance, candidatesMoved);
          else queueReadyPhases(instance.id, def, instance, ready);
          if (instance.status === "failed") deps.onFailure?.(instance);
          deps.onChange?.();
          current = instance;
          if (current.status !== "running" && current.status !== "awaiting-approval") break;
        }
        // A restart can land between a candidate's last report and the
        // selection that report implied. The decision is a pure function of
        // what is on disk, so it is simply asked again — and answers `pending`,
        // harmlessly, for every phase still genuinely waiting.
        if (current.status === "running") {
          for (const i of livePhases(current)) {
            const phase = current.phases[i];
            if (phase.status !== "running") continue;
            if (!def.phases.find((p) => p.id === phase.id)?.candidates) continue;
            await settleCandidates(def, current, phase.id);
          }
        }
      });
    }
  }

  return { start, onSignal, approve, revise, abort, reconcile, adopt, drain };
}
