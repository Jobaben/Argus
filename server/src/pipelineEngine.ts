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
  applyRevise,
  applyRetry,
  applyVerification,
  retryDelayMs,
  shouldRetry,
  initInstance,
  withFailureClass,
} from "./pipelineTransitions.js";
import { interpolate, livePhases, previousPayloadFor, resultStepName } from "./sources/dag.js";
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
  PhaseStep,
  RetryableClass,
} from "./sources/pipelineTypes.js";
import type { RouteOutcome, TransitionResult } from "./pipelineTransitions.js";
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
  };
}

export interface ActionResult {
  ok: boolean;
  code: number;
  /** Human-readable reason on the failure paths (404/409), for surfacing to a client. */
  error?: string;
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
 *  deadline, or exited on its own. */
export function failureClassOfRecord(run: Run): RetryableClass {
  if (run.termination === "timed-out") return "timeout";
  return run.pid == null ? "spawn" : "exit-code";
}

/** A retry re-runs the same prompt. When the previous attempt failed on the
 *  work itself — the agent's own verdict, or Argus's checks — the next attempt
 *  is told why, so it is a repair rather than a replay. Infrastructure failures
 *  (a process that never started, a dead exit) carry nothing worth repeating. */
export function retryNote(payload: unknown): string {
  const p = (payload ?? {}) as PhaseFailurePayload;
  if (p.failureClass !== "verification" && p.failureClass !== "signal") return "";
  const reason = typeof p.reason === "string" ? p.reason.trim() : "";
  return reason ? `\n\nPrevious attempt failed: ${reason}` : "";
}

export interface Engine {
  start(pipelineId: string, trigger?: "manual" | "scheduled"): Promise<PipelineInstance | null>;
  onSignal(instanceId: string, signal: PipelineSignal): Promise<ActionResult>;
  approve(instanceId: string, answers?: unknown): Promise<ActionResult>;
  revise(instanceId: string, note?: string): Promise<ActionResult>;
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

  async function loadDef(pipelineId: string): Promise<PipelineDefinition | undefined> {
    return (await readPipelines()).find((d) => d.id === pipelineId);
  }

  /**
   * Launch a wave of ready phases.
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

  async function startPhase(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseIndex: number,
    noteSuffix = "",
  ): Promise<void> {
    const phaseDef = def.phases[phaseIndex];
    // "Previous" is the phase's own dependency, which for a linear pipeline is
    // the phase before it — the same value the cursor version produced.
    const prevPayload = previousPayloadFor(def, inst, phaseDef.id);
    const startedAt = nowISO();
    const artifactDir = phaseArtifactDir(paths.artifactsDir(), inst.id, phaseDef.id);
    inst.phases[phaseIndex].artifactDir = artifactDir;
    const dirs = {
      own: artifactDir,
      byPhase: Object.fromEntries(
        inst.phases.flatMap((p) => (p.artifactDir ? [[p.id, p.artifactDir]] : [])),
      ) as Record<string, string>,
    };
    // Exactly one step may publish the phase's result; only that step is told
    // about it, so concurrent siblings cannot race to write a decision.
    const publishingStep = resultStepName(phaseDef);
    const planned = phaseDef.steps.map((stepDef) => {
      const runId = deps.newId();
      const publishes = stepDef.name === publishingStep;
      // Narrowest wins: a step names its runtime, else its phase, else the
      // pipeline, else the server default. Resolved and written down here, so a
      // mixed-runtime pipeline stays readable on the board and in the record.
      const runtime = resolveRuntimeId(stepDef.runtime, phaseDef.runtime, def.runtime);
      const timeoutSeconds = resolveTimeoutSeconds(phaseDef, stepDef);
      const run: Run = {
        id: runId,
        scheduleId: `pipeline:${inst.pipelineId}`,
        scheduleName: `${inst.pipelineName} · ${phaseDef.name}`,
        prompt:
          interpolate(stepDef.prompt, prevPayload, inst.artifacts ?? {}, dirs) +
          (publishes ? resultInstruction(phaseDef.result) : "") +
          artifactInstruction(phaseDef.checks, artifactDir) +
          noteSuffix,
        cwd: phaseDef.cwd,
        status: "running",
        trigger: "scheduled",
        queuedAt: startedAt,
        startedAt,
        endedAt: null,
        durationMs: null,
        pid: null,
        exitCode: null,
        sessionId: runtimeFor(runtime).capabilities.presetSessionId ? deps.newId() : null,
        model: stepDef.model ?? def.model,
        reasoningEffort: stepDef.reasoningEffort ?? def.reasoningEffort,
        runtime,
        project: encodeProject(phaseDef.cwd),
        resultSummary: null,
        error: null,
        instanceId: inst.id,
        phaseId: phaseDef.id,
        // The deadline is set at spawn, not here: a step may wait for a
        // concurrency slot first, and waiting is not running.
        deadlineAt: null,
      };
      return { stepDef, run, publishes, timeoutSeconds };
    });
    // Record the runIds on the instance up front, then persist once (no write races).
    inst.phases[phaseIndex].steps = planned.map(({ stepDef, run }) => ({
      name: stepDef.name,
      runId: run.id,
      status: "running" as const,
    }));
    inst.phases[phaseIndex].status = "running";
    await writeInstance(inst);
    void journal(inst.id, {
      at: startedAt,
      kind: "phase.started",
      phaseId: phaseDef.id,
      attempt: inst.phases[phaseIndex].attempt,
      detail: `${planned.length} step${planned.length === 1 ? "" : "s"}`,
    });
    // Every attempt starts with an empty artifact directory: a file left by a
    // previous attempt must never satisfy this attempt's checks or mislead the
    // agent about what it has already done.
    await rm(artifactDir, { recursive: true, force: true });
    await mkdir(artifactDir, { recursive: true });
    // A working-tree baseline for `changed-files` checks, kept out of the
    // agent's reach (beside the invocation records, not in the artifact dir).
    let baseline: WorkingTreeSnapshot | null = null;
    if (phaseDef.checks?.some((c) => c.kind === "changed-files")) {
      baseline = await snapshotWorkingTree(phaseDef.cwd);
      const file = phaseBaselinePath(
        paths.invocationsDir(),
        inst.id,
        phaseDef.id,
        inst.phases[phaseIndex].attempt,
      );
      if (baseline) await atomicWriteJson(file, baseline);
      else await rm(file, { force: true });
    }

    // Launch each step: acquire a slot, spawn, and persist the pid. Callers on
    // the HTTP request path (start/approve/revise) await these launches so the
    // spawn is observable when they return. The concurrency cap still applies —
    // a launch past the cap waits for a slot, which is fine here because these
    // callers hold no slot of their own.
    const gitHead = baseline?.head ?? (await readGitHead(phaseDef.cwd));
    const unlaunchable: { run: Run; reason: string }[] = [];
    for (const { stepDef, run, publishes, timeoutSeconds } of planned) {
      const launched = await launchStep(run, {
        def,
        phaseDef,
        stepDef,
        inst,
        publishes,
        artifactDir,
        timeoutSeconds,
        gitHead,
      });
      void journal(inst.id, {
        at: nowISO(),
        kind: "step.spawned",
        phaseId: phaseDef.id,
        runId: run.id,
        detail:
          "handle" in launched
            ? `pid ${run.pid ?? "unknown"}`
            : launched.failure === "configuration"
              ? `not launched: ${launched.reason}`
              : "spawn failed",
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
      await writeInstance(inst);
      // Siblings that did launch belong to a phase that has already failed.
      await killPhaseRuns(inst, [phaseDef.id], "stopped: phase failed");
      queueReadyPhases(inst.id, def, inst, readyAfterFailure);
      if (inst.status === "failed") deps.onFailure?.(inst);
    }
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
        resultFile,
        timeoutSeconds: ctx.timeoutSeconds,
        gitHead: ctx.gitHead,
        parentEnv: parentEnv(),
        now: new Date(run.startedAt),
      });
      run.deadlineAt = prepared.record.deadlineAt;
      await writeInvocation(prepared.record);
      for (const file of prepared.files) await writeFile(file.path, file.contents, "utf8");
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
          got?.run.termination === "timed-out" || got?.run.termination === "killed";
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
      const def = await loadDef(inst.pipelineId);
      if (!def) return;
      if (beforeTransition) await beforeTransition();
      const res = failStepInPlace(def, inst, phaseId, runId, failureClass, reason, extra);
      await patchRun(runId, { outcome: "failed" });
      await writeInstance(res.instance);
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
      const def = await loadDef(candidate.pipelineId);
      if (!def) continue;
      await locks.withLock(candidate.id, async () => {
        const inst = await readInstance(candidate.id);
        if (!inst) return;
        const due = inst.phases.filter(
          (p) => p.status === "failed" && p.retryAt && Date.parse(p.retryAt) <= now.getTime(),
        );
        for (const phase of due) {
          const note = retryNote(phase.payload);
          const res = applyRetry(inst, phase.id, nowISO());
          if (res.startPhases.length === 0) continue;
          await writeInstance(res.instance);
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

  async function start(pipelineId: string, trigger: "manual" | "scheduled" = "manual") {
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
    );
    await writeInstance(instance);
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
          cwd: phaseDef.cwd,
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
          await writeInstance(res.instance);
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
      const def = await loadDef(inst.pipelineId);
      if (!def) return { ok: false, code: 404 };
      const {
        instance,
        startPhases: ready,
        routing,
        verify,
      } = advance(def, inst, signal, nowISO());
      noteRouting(def, instance, routing);
      if (signal.type === "failed") {
        // An agent that signalled failure has considered the work, so this
        // class is excluded from the default retry set — but an author who
        // opted into it gets it.
        noteFailure(def, instance, signal.phaseId, "signal", "the agent signalled failure");
      }
      // One write: the route decision, the skips it implies, the phase
      // statuses, the failure class and any scheduled retry land together or
      // not at all.
      await writeInstance(instance);
      queueVerifications(instanceId, def, instance, verify);
      const outcome: Run["outcome"] | undefined =
        signal.type === "failed" ? "failed" : signal.type === "completed" ? "succeeded" : undefined;
      if (outcome) await patchRun(signal.runId, { outcome });
      void journal(instance.id, {
        at: nowISO(),
        kind: "phase.signalled",
        phaseId: signal.phaseId,
        runId: signal.runId,
        detail: signal.type,
      });
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

  async function approve(instanceId: string, answers?: unknown): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404, error: "instance not found" };
      const def = await loadDef(inst.pipelineId);
      if (!def) return { ok: false, code: 404, error: "pipeline not found" };
      let res;
      try {
        res = applyApprove(def, inst, answers, nowISO());
      } catch (e) {
        return { ok: false, code: 409, error: e instanceof Error ? e.message : String(e) };
      }
      await writeInstance(res.instance);
      if (noteRouting(def, res.instance, res.routing)) await writeInstance(res.instance);
      await startPhases(def, res.instance, res.startPhases);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  async function revise(instanceId: string, note?: string): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404, error: "instance not found" };
      const def = await loadDef(inst.pipelineId);
      if (!def) return { ok: false, code: 404, error: "pipeline not found" };
      // Validate the transition BEFORE any destructive side effect: killing the
      // phase's straggler runs must not happen if the instance can't be revised
      // (e.g. it isn't awaiting approval), or a rejected 409 would still have
      // torn down live work.
      let res;
      try {
        res = applyRevise(inst, nowISO());
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
      await writeInstance(res.instance);
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
      await writeInstance(aborted);
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
          got.run.termination === "timed-out" || got.run.termination === "killed";
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

    // 3. Heal running instances whose live-phase runs ended without signalling.
    //    Each instance is healed under its lock, re-reading fresh state inside,
    //    so a genuine completion signal landing mid-pass is never clobbered by a
    //    stale "failed" write (the TOCTOU the lock closes).
    for (const def of defs) {
      const candidates = await readInstances({ pipelineId: def.id });
      for (const candidate of candidates) {
        if (candidate.status !== "running") continue;
        await locks.withLock(candidate.id, async () => {
          const inst = await readInstance(candidate.id);
          if (!inst || inst.status !== "running") return;
          let current = inst;
          // A phase whose checks were running when Argus stopped is verified
          // again: the checks are Argus's own and deterministic, and the
          // attempt key makes a duplicate report a no-op.
          for (const i of livePhases(current)) {
            const phase = current.phases[i];
            if (
              phase.status === "running" &&
              phase.verification?.status === "running" &&
              !verifying.has(`${current.id}:${phase.id}:${phase.attempt}`)
            ) {
              queueVerification(current.id, def, phase.id, phase.attempt);
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
            );
            if (recovered) await patchRun(s.runId, { outcome: recovered.outcome });
            if (signalType === "failed") {
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
            await writeInstance(instance);
            queueVerifications(instance.id, def, instance, verify);
            void journal(instance.id, {
              at: nowISO(),
              kind: "phase.signalled",
              phaseId,
              runId: s.runId,
              detail: recovered ? `run-record fallback: ${recovered.outcome}` : "reconcile: failed",
            });
            queueReadyPhases(instance.id, def, instance, ready);
            deps.tailer?.untrack(s.runId);
            if (instance.status === "failed") deps.onFailure?.(instance);
            deps.onChange?.();
            current = instance;
            if (current.status !== "running" && current.status !== "awaiting-approval") break;
          }
        });
      }
    }
  }

  return { start, onSignal, approve, revise, abort, reconcile, adopt, drain };
}
