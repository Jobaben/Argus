import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { encodeProject, readRun, runLogPath, writeRun } from "./sources/runs.js";
import { markPipelineStarted, readPipelines } from "./sources/pipelines.js";
import {
  INSTANCE_KEEP, pruneInstances, readInstance, readInstances, writeInstance,
} from "./sources/instances.js";
import {
  advance, applyAbort, applyApprove, applyRevise, applyTemplate, initInstance,
} from "./pipelineTransitions.js";
import { isAlive } from "./scheduler.js";
import { graceMsFor, previousFireTime } from "./sources/nextFire.js";
import type { Run } from "./sources/scheduleTypes.js";
import type { PipelineDefinition, PipelineInstance, PipelineSignal } from "./sources/pipelineTypes.js";

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

/** Real spawn: `claude -p`, prompt on stdin, with the signal env injected. */
export const defaultPipelineSpawn: PipelineSpawnFn = (run, logPath, env) => {
  const out = createWriteStream(logPath, { flags: "a" });
  const child = nodeSpawn(
    "claude",
    ["-p", "--output-format", "json", "--session-id", run.sessionId ?? randomUUID()],
    { cwd: run.cwd, shell: process.platform === "win32", env: { ...process.env, ...env } },
  );
  child.stdin?.on("error", () => {});
  child.stdin?.write(run.prompt);
  child.stdin?.end();
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });
  const done = new Promise<{ code: number | null }>((resolve) => {
    child.on("error", () => { out.end(); resolve({ code: null }); });
    child.on("close", (code) => { out.end(); resolve({ code }); });
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
}

export function createEngine(deps: EngineDeps): Engine {
  const sem = new Semaphore(deps.maxConcurrent);
  const nowISO = () => deps.now().toISOString();

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
      name: stepDef.name, runId: run.id, status: "running" as const,
    }));
    inst.phases[phaseIndex].status = "running";
    await writeInstance(inst);

    for (const { run } of planned) {
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
        continue;
      }
      run.pid = handle.pid;
      await writeRun(run);
      void handle.done.then(async (res) => {
        sem.release();
        await writeRun({
          ...run,
          status: res.code === 0 ? "succeeded" : "failed",
          endedAt: nowISO(),
          durationMs: deps.now().getTime() - new Date(startedAt).getTime(),
          exitCode: res.code,
          error: res.code === 0 ? null : `exit code ${res.code}`,
        });
      });
    }
    deps.onChange?.();
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
    const { instance, startPhase: idx } = initInstance(
      def, trigger, { instanceId: deps.newId(), token: deps.newId() }, nowISO(),
    );
    await writeInstance(instance);
    await markPipelineStarted(def.id, instance.createdAt);
    if (idx !== null) await startPhase(def, instance, idx);
    await pruneInstances(def.id, INSTANCE_KEEP);
    deps.onChange?.();
    return instance;
  }

  async function onSignal(instanceId: string, signal: PipelineSignal) {
    const inst = await readInstance(instanceId);
    if (!inst) return { ok: false, code: 404 };
    if (signal.token !== inst.signalToken) return { ok: false, code: 403 };
    if (inst.status !== "running") return { ok: true, code: 200 }; // paused/terminal → idempotent ignore
    const def = await loadDef(inst.pipelineId);
    if (!def) return { ok: false, code: 404 };
    const { instance, startPhase: idx } = advance(def, inst, signal, nowISO());
    await writeInstance(instance);
    if (idx !== null) await startPhase(def, instance, idx);
    deps.onChange?.();
    return { ok: true, code: 202 };
  }

  async function approve(instanceId: string, answers?: unknown) {
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
  }

  async function revise(instanceId: string, note?: string) {
    const inst = await readInstance(instanceId);
    if (!inst) return { ok: false, code: 404, error: "instance not found" };
    const def = await loadDef(inst.pipelineId);
    if (!def) return { ok: false, code: 404, error: "pipeline not found" };
    let res;
    try {
      res = applyRevise(inst, nowISO());
    } catch (e) {
      return { ok: false, code: 409, error: e instanceof Error ? e.message : String(e) };
    }
    await writeInstance(res.instance);
    const suffix = note ? `\n\nRevision note: ${note}` : "";
    if (res.startPhase !== null) await startPhase(def, res.instance, res.startPhase, suffix);
    deps.onChange?.();
    return { ok: true, code: 200 };
  }

  async function abort(instanceId: string) {
    const inst = await readInstance(instanceId);
    if (!inst) return { ok: false, code: 404, error: "instance not found" };
    let aborted: PipelineInstance;
    try {
      aborted = applyAbort(inst, nowISO());
    } catch (e) {
      return { ok: false, code: 409, error: e instanceof Error ? e.message : String(e) };
    }
    for (const s of inst.phases[inst.currentPhaseIndex]?.steps ?? []) {
      if (!s.runId) continue;
      const got = await readRun(s.runId);
      if (got && isAlive(got.run.pid)) {
        try { process.kill(got.run.pid!); } catch { /* already gone */ }
      }
    }
    await writeInstance(aborted);
    deps.onChange?.();
    return { ok: true, code: 200 };
  }

  async function reconcile() {
    const defs = await readPipelines();
    const grace = graceMsFor(deps.tickMs ?? 30000);
    const now = deps.now();

    // 1. Start clock-due pipeline definitions.
    for (const def of defs) {
      if (!def.enabled || !def.trigger) continue;
      const anchor = new Date(def.lastStartedAt ?? def.createdAt);
      const prev = previousFireTime(def.trigger, anchor, now);
      if (!prev) continue;
      if (def.lastStartedAt && new Date(def.lastStartedAt).getTime() >= prev.getTime()) continue;
      if (now.getTime() - prev.getTime() > grace) continue;
      await start(def.id, "scheduled");
    }

    // 2. Heal running instances whose current-phase runs ended without signalling.
    for (const def of defs) {
      const insts = await readInstances({ pipelineId: def.id });
      for (const inst of insts) {
        if (inst.status !== "running") continue;
        const phase = inst.phases[inst.currentPhaseIndex];
        for (const s of phase.steps) {
          if (s.status !== "running" || !s.runId) continue;
          const got = await readRun(s.runId);
          const ended = got && (got.run.status === "failed" || got.run.status === "succeeded" || !isAlive(got.run.pid));
          if (!ended) continue;
          const { instance } = advance(def, inst, {
            instanceId: inst.id, phaseId: phase.id, runId: s.runId, type: "failed", token: inst.signalToken,
            payload: { reason: got?.run.error ?? "run ended without emitting a completion signal" },
          }, nowISO());
          await writeInstance(instance);
          deps.onChange?.();
          if (instance.status !== "running") break;
        }
      }
    }
  }

  return { start, onSignal, approve, revise, abort, reconcile };
}
