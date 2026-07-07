import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  encodeProject,
  killRunProcess,
  patchRun,
  readRun,
  runLogPath,
  writeRun,
} from "./sources/runs.js";
import { markPipelineStarted, readPipelines } from "./sources/pipelines.js";
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
  applyTemplate,
  initInstance,
} from "./pipelineTransitions.js";
import { isAlive, parseRunEnvelope } from "./scheduler.js";
import { graceMsFor, previousFireTime } from "./sources/nextFire.js";
import { KeyedMutex } from "./mutex.js";
import type { Run } from "./sources/scheduleTypes.js";
import type {
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
} from "./sources/pipelineTypes.js";

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
) => { pid: number | null; done: Promise<{ code: number | null }> };

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

/** Build the `claude -p` argument vector for a step run, with the outcome
 *  contract appended to the system prompt. Kept pure for unit testing. */
export function buildClaudeArgs(run: Run): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--session-id",
    run.sessionId ?? randomUUID(),
    "--append-system-prompt",
    OUTCOME_CONTRACT,
  ];
  if (run.model && run.model.trim()) args.push("--model", run.model);
  return args;
}

/** Real spawn: `claude -p`, prompt on stdin, with the signal env injected.
 *  Detached with fd-backed stdio so the run survives an Argus restart and
 *  keeps logging without the parent process. Deliberately NO shell: with a
 *  cmd.exe wrapper the detached grandchild's output never reaches the log fd,
 *  and the wrapper pid breaks pid tracking across restarts (spike-verified).
 *  Requires `claude` to be a real executable (claude.exe / binary), which the
 *  native installer provides. */
export const defaultPipelineSpawn: PipelineSpawnFn = (run, logPath, env) => {
  const fd = openSync(logPath, "a");
  let child: ReturnType<typeof nodeSpawn>;
  try {
    child = nodeSpawn("claude", buildClaudeArgs(run), {
      cwd: run.cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["pipe", fd, fd],
    });
  } finally {
    // The child holds its own duplicate of the descriptor.
    closeSync(fd);
  }
  child.stdin?.on("error", () => {});
  child.stdin?.write(run.prompt);
  child.stdin?.end();
  child.unref();
  const done = new Promise<{ code: number | null }>((resolve) => {
    child.on("error", () => resolve({ code: null }));
    child.on("close", (code) => resolve({ code }));
  });
  return { pid: child.pid ?? null, done };
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
  kill?: (pid: number) => Promise<boolean> | boolean;
}

export interface ActionResult {
  ok: boolean;
  code: number;
  /** Human-readable reason on the failure paths (404/409), for surfacing to a client. */
  error?: string;
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

  async function loadDef(pipelineId: string): Promise<PipelineDefinition | undefined> {
    return (await readPipelines()).find((d) => d.id === pipelineId);
  }

  async function startPhase(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseIndex: number,
    noteSuffix = "",
  ): Promise<void> {
    const phaseDef = def.phases[phaseIndex];
    const prevPayload = phaseIndex > 0 ? inst.phases[phaseIndex - 1].payload : null;
    const startedAt = nowISO();
    const planned = phaseDef.steps.map((stepDef) => {
      const runId = deps.newId();
      const run: Run = {
        id: runId,
        scheduleId: `pipeline:${inst.pipelineId}`,
        scheduleName: `${inst.pipelineName} · ${phaseDef.name}`,
        prompt: applyTemplate(stepDef.prompt, prevPayload) + noteSuffix,
        cwd: phaseDef.cwd,
        status: "running",
        trigger: "scheduled",
        queuedAt: startedAt,
        startedAt,
        endedAt: null,
        durationMs: null,
        pid: null,
        exitCode: null,
        sessionId: deps.newId(),
        model: stepDef.model ?? def.model,
        project: encodeProject(phaseDef.cwd),
        resultSummary: null,
        error: null,
        instanceId: inst.id,
        phaseId: phaseDef.id,
      };
      return { stepDef, run };
    });
    // Record the runIds on the instance up front, then persist once (no write races).
    inst.phases[phaseIndex].steps = planned.map(({ stepDef, run }) => ({
      name: stepDef.name,
      runId: run.id,
      status: "running" as const,
    }));
    inst.phases[phaseIndex].status = "running";
    await writeInstance(inst);

    // Launch each step: acquire a slot, spawn, and persist the pid. Callers on
    // the HTTP request path (start/approve/revise) await these launches so the
    // spawn is observable when they return. The concurrency cap still applies —
    // a launch past the cap waits for a slot, which is fine here because these
    // callers hold no slot of their own.
    for (const { run } of planned) {
      const handle = await launchStep(run, phaseDef, inst);
      if (handle) trackStep(run, handle, startedAt);
    }
    deps.onChange?.();
  }

  /** Acquire a slot and spawn one step, persisting its pid. Returns the handle,
   *  or null if the spawn itself threw (already recorded as failed). */
  async function launchStep(
    run: Run,
    phaseDef: PipelineDefinition["phases"][number],
    inst: PipelineInstance,
  ): Promise<{ pid: number | null; done: Promise<{ code: number | null }> } | null> {
    await sem.acquire();
    const env: Record<string, string> = {
      ARGUS_SIGNAL_URL: `${deps.signalUrlBase}/api/instances/${inst.id}/signal`,
      ARGUS_INSTANCE_ID: inst.id,
      ARGUS_PHASE_ID: phaseDef.id,
      ARGUS_RUN_ID: run.id,
      ARGUS_STEP_NAME: run.scheduleName,
      ARGUS_SIGNAL_TOKEN: inst.signalToken,
    };
    let handle: { pid: number | null; done: Promise<{ code: number | null }> };
    try {
      handle = deps.spawn(run, runLogPath(run.id), env);
    } catch (e) {
      sem.release();
      await writeRun({ ...run, status: "failed", error: String(e), endedAt: nowISO() });
      return null;
    }
    run.pid = handle.pid;
    await writeRun(run);
    return handle;
  }

  /** Await a launched step's completion off the request path, release its slot,
   *  and record the terminal state. Never throws. */
  function trackStep(
    run: Run,
    handle: { done: Promise<{ code: number | null }> },
    startedAt: string,
  ): void {
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        sem.release();
      }
    };
    void handle.done
      .then(async (res) => {
        release();
        // The CLI's JSON result envelope is the last line of the log; harvest
        // cost/tokens/result from it so every completed step reports its spend
        // (not only runs finalized by the adopted-run reconcile path).
        const got = await readRun(run.id);
        const envelope = got ? parseRunEnvelope(got.log) : null;
        await patchRun(run.id, {
          status: res.code === 0 ? "succeeded" : "failed",
          endedAt: nowISO(),
          durationMs: deps.now().getTime() - new Date(startedAt).getTime(),
          exitCode: res.code,
          resultSummary: envelope?.result ?? got?.run.resultSummary ?? null,
          costUsd: envelope?.costUsd ?? got?.run.costUsd ?? null,
          tokens: envelope?.tokens ?? got?.run.tokens ?? null,
          error: res.code === 0 ? null : `exit code ${res.code}`,
        });
        deps.onChange?.();
      })
      .catch((e) => {
        release();
        console.error(`[argus] step run ${run.id} completion handler failed:`, e);
      });
  }

  /** Kill any still-alive process spawned for the instance's current phase.
   *  Used before aborting, and before a revise re-spawns the phase, so a
   *  straggler run can't keep executing (or later signal) against it. */
  async function killPhaseRuns(inst: PipelineInstance): Promise<void> {
    for (const s of inst.phases[inst.currentPhaseIndex]?.steps ?? []) {
      if (!s.runId) continue;
      const got = await readRun(s.runId);
      if (got && isAlive(got.run.pid)) {
        try {
          await kill(got.run.pid!);
        } catch {
          /* already gone */
        }
      }
    }
  }

  async function adopt(): Promise<void> {
    for (const inst of await readInstances()) {
      if (inst.status !== "running") continue;
      const phase = inst.phases[inst.currentPhaseIndex];
      for (const s of phase?.steps ?? []) {
        if (s.status !== "running" || !s.runId || adopted.has(s.runId)) continue;
        const got = await readRun(s.runId);
        if (!got || got.run.status !== "running" || !isAlive(got.run.pid)) continue;
        await sem.acquire();
        adopted.set(s.runId, { instanceId: inst.id });
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
    const { instance, startPhase: idx } = initInstance(
      def,
      trigger,
      { instanceId: deps.newId(), token: deps.newId() },
      nowISO(),
    );
    await writeInstance(instance);
    await markPipelineStarted(def.id, instance.createdAt);
    if (idx !== null) await startPhase(def, instance, idx);
    await pruneInstances(def.id, INSTANCE_KEEP);
    deps.onChange?.();
    return instance;
  }

  async function onSignal(instanceId: string, signal: PipelineSignal): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readInstance(instanceId);
      if (!inst) return { ok: false, code: 404 };
      if (signal.token !== inst.signalToken) return { ok: false, code: 403 };
      if (inst.status !== "running") return { ok: true, code: 200 }; // paused/terminal → idempotent ignore
      const def = await loadDef(inst.pipelineId);
      if (!def) return { ok: false, code: 404 };
      const { instance, startPhase: idx } = advance(def, inst, signal, nowISO());
      await writeInstance(instance);
      const outcome: Run["outcome"] | undefined =
        signal.type === "failed" ? "failed" : signal.type === "completed" ? "succeeded" : undefined;
      if (outcome) await patchRun(signal.runId, { outcome });
      // Start the next phase detached: this handler runs on the child's signal
      // POST, and that child may still hold its concurrency slot until its
      // process exits after we respond. Awaiting startPhase here (which acquires
      // a slot) would deadlock when all slots are held by children waiting on
      // their own signal responses. The detached continuation RE-ACQUIRES the
      // instance lock and re-verifies liveness before launching, so an abort/
      // revise landing in the transition window can't be clobbered and won't be
      // raced into spawning orphan children (it queues behind, then kills them).
      if (idx !== null) {
        void locks
          .withLock(instanceId, async () => {
            const fresh = await readInstance(instanceId);
            if (!fresh || fresh.status !== "running" || fresh.currentPhaseIndex !== idx) return;
            await startPhase(def, fresh, idx);
          })
          .catch((e) => console.error(`[argus] deferred phase start for ${instanceId} failed:`, e));
      }
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
      if (res.startPhase !== null) await startPhase(def, res.instance, res.startPhase);
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
      await killPhaseRuns(inst);
      await writeInstance(res.instance);
      const suffix = note ? `\n\nRevision note: ${note}` : "";
      if (res.startPhase !== null) await startPhase(def, res.instance, res.startPhase, suffix);
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
      await killPhaseRuns(inst);
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
          continue;
        }
        if (isAlive(got.run.pid)) continue;
        const envelope = parseRunEnvelope(got.log);
        const parsed = envelope.isError !== null || envelope.result !== null ? envelope : null;
        const ended = deps.now();
        // patchRun (not a full writeRun spread): the signal path patches
        // `outcome` concurrently, and a stale full-object write would drop it.
        await patchRun(runId, {
          status: parsed && parsed.isError === false ? "succeeded" : "failed",
          endedAt: ended.toISOString(),
          durationMs: got.run.startedAt
            ? ended.getTime() - new Date(got.run.startedAt).getTime()
            : null,
          exitCode: null,
          resultSummary: parsed?.result ?? got.run.resultSummary,
          costUsd: parsed?.costUsd ?? got.run.costUsd,
          tokens: parsed?.tokens ?? got.run.tokens,
          error: !parsed
            ? "ended while detached; no parseable result"
            : parsed.isError === false
              ? null
              : (parsed.result ?? "run reported is_error"),
        });
        adopted.delete(runId);
        sem.release();
        deps.onChange?.();
      } catch (e) {
        // Keep the run adopted; retried next tick.
        console.error("[argus] finalize of adopted run failed:", e);
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

    // 2. Heal running instances whose current-phase runs ended without signalling.
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
          const phase = current.phases[current.currentPhaseIndex];
          for (const s of phase.steps) {
            if (s.status !== "running" || !s.runId) continue;
            const got = await readRun(s.runId);
            const ended =
              got &&
              (got.run.status === "failed" ||
                got.run.status === "succeeded" ||
                !isAlive(got.run.pid));
            if (!ended) continue;
            const restarted = got?.run.status === "interrupted";
            const payload = restarted
              ? { reason: "Argus restarted mid-run — revise to retry", kind: "restarted" }
              : {
                  reason: got?.run.error ?? "run ended without emitting a completion signal",
                };
            const { instance } = advance(
              def,
              current,
              {
                instanceId: current.id,
                phaseId: phase.id,
                runId: s.runId,
                type: "failed",
                token: current.signalToken,
                payload,
              },
              nowISO(),
            );
            await writeInstance(instance);
            if (instance.status === "failed") deps.onFailure?.(instance);
            deps.onChange?.();
            current = instance;
            if (current.status !== "running") break;
          }
        });
      }
    }
  }

  return { start, onSignal, approve, revise, abort, reconcile, adopt };
}
