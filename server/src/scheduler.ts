import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { graceMsFor, shouldFire } from "./sources/nextFire.js";
import {
  markScheduleRan,
  readSchedules,
} from "./sources/schedules.js";
import {
  RUN_KEEP,
  encodeProject,
  pruneRuns,
  readRun,
  readRuns,
  runLogPath,
  writeRun,
} from "./sources/runs.js";
import type { Run, Schedule } from "./sources/scheduleTypes.js";

export interface SpawnHandle {
  pid: number | null;
  done: Promise<{ code: number | null; result: string | null; error: string | null }>;
}

export type SpawnFn = (run: Run, logPath: string) => SpawnHandle;

export interface SchedulerDeps {
  now: () => Date;
  spawn: SpawnFn;
  tickMs: number;
  newId: () => string;
  onChange?: () => void;
}

/** True if a process with `pid` is currently alive. */
export function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Real spawn: runs `claude -p <prompt>` in the run's cwd, piping stdout+stderr
 * to the log file. A pre-generated session id (already on the run) is passed so
 * the transcript can be linked; `--output-format json` lets us capture a result.
 *
 * NOTE: verify these flags against the installed CLI before relying on them:
 *   claude -p "hi" --output-format json --session-id <uuid>
 * Adjust the args here if the installed version differs.
 */
export const defaultSpawn: SpawnFn = (run, logPath) => {
  const out = createWriteStream(logPath, { flags: "a" });
  const child = nodeSpawn(
    "claude",
    ["-p", run.prompt, "--output-format", "json", "--session-id", run.sessionId ?? randomUUID()],
    { cwd: run.cwd, shell: process.platform === "win32" },
  );
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });

  const done = new Promise<{ code: number | null; result: string | null; error: string | null }>(
    (resolve) => {
      let tail = "";
      child.stdout?.on("data", (d: Buffer) => {
        tail = (tail + d.toString("utf8")).slice(-8192);
      });
      child.on("error", (err) => {
        out.end();
        resolve({ code: null, result: null, error: err.message });
      });
      child.on("close", (code) => {
        out.end();
        let result: string | null = null;
        try {
          const parsed = JSON.parse(tail) as { result?: string };
          result = parsed.result ?? null;
        } catch {
          result = null;
        }
        resolve({ code, result, error: code === 0 ? null : `exit code ${code}` });
      });
    },
  );
  return { pid: child.pid ?? null, done };
};

/** Creates a run record, spawns it, and updates the record on completion. */
export async function fireRun(
  schedule: Schedule,
  trigger: "scheduled" | "manual",
  deps: SchedulerDeps,
): Promise<Run> {
  const startedAt = deps.now();
  const sessionId = randomUUID();
  const run: Run = {
    id: deps.newId(),
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    prompt: schedule.prompt,
    cwd: schedule.cwd,
    status: "running",
    trigger,
    queuedAt: startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    endedAt: null,
    durationMs: null,
    pid: null,
    exitCode: null,
    sessionId,
    project: encodeProject(schedule.cwd),
    resultSummary: null,
    error: null,
  };
  await writeRun(run);
  await markScheduleRan(schedule.id, run.id, run.queuedAt);

  const handle = deps.spawn(run, runLogPath(run.id));
  run.pid = handle.pid;
  await writeRun(run);
  deps.onChange?.();

  // Track completion without blocking the tick.
  void handle.done.then(async (res) => {
    const ended = deps.now();
    const finished: Run = {
      ...run,
      status: res.code === 0 ? "succeeded" : "failed",
      endedAt: ended.toISOString(),
      durationMs: ended.getTime() - startedAt.getTime(),
      exitCode: res.code,
      resultSummary: res.result,
      error: res.error,
    };
    await writeRun(finished);
    await pruneRuns(schedule.id, RUN_KEEP);
    deps.onChange?.();
  });

  return run;
}

/** One scheduler pass: fire every due schedule, honouring overlap policy. */
export async function tick(deps: SchedulerDeps): Promise<void> {
  const now = deps.now();
  const grace = graceMsFor(deps.tickMs);
  const schedules = await readSchedules();
  for (const schedule of schedules) {
    if (!shouldFire(schedule, now, grace)) continue;

    if (schedule.overlapPolicy === "skip") {
      const alive = (await readRuns({ scheduleId: schedule.id })).some(
        (r) => r.status === "running" && isAlive(r.pid),
      );
      if (alive) {
        const iso = now.toISOString();
        await writeRun({
          id: deps.newId(),
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          prompt: schedule.prompt,
          cwd: schedule.cwd,
          status: "skipped",
          trigger: "scheduled",
          queuedAt: iso,
          startedAt: null,
          endedAt: iso,
          durationMs: 0,
          pid: null,
          exitCode: null,
          sessionId: null,
          project: null,
          resultSummary: null,
          error: "skipped: previous run still in progress",
        });
        await markScheduleRan(schedule.id, "", iso);
        deps.onChange?.();
        continue;
      }
    }

    try {
      await fireRun(schedule, "scheduled", deps);
    } catch (e) {
      // Never let one schedule's failure break the tick.
      const iso = now.toISOString();
      await writeRun({
        id: deps.newId(),
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        prompt: schedule.prompt,
        cwd: schedule.cwd,
        status: "failed",
        trigger: "scheduled",
        queuedAt: iso,
        startedAt: iso,
        endedAt: iso,
        durationMs: 0,
        pid: null,
        exitCode: null,
        sessionId: null,
        project: null,
        resultSummary: null,
        error: e instanceof Error ? e.message : String(e),
      });
      deps.onChange?.();
    }
  }
}

/** On startup, mark any 'running' run whose process is gone as interrupted. */
export async function recoverInterruptedRuns(
  deps: Pick<SchedulerDeps, "now">,
): Promise<void> {
  const running = (await readRuns()).filter((r) => r.status === "running");
  for (const r of running) {
    if (isAlive(r.pid)) continue;
    const got = await readRun(r.id);
    if (!got) continue;
    const ended = deps.now();
    await writeRun({
      ...got.run,
      status: "interrupted",
      endedAt: ended.toISOString(),
      durationMs: got.run.startedAt
        ? ended.getTime() - new Date(got.run.startedAt).getTime()
        : null,
      error: "interrupted: Argus restarted while this run was in progress",
    });
  }
}

/** Boots the scheduler loop; returns a stop handle for graceful shutdown. */
export function startScheduler(
  overrides: Partial<SchedulerDeps> = {},
): { stop: () => Promise<void> } {
  const deps: SchedulerDeps = {
    now: () => new Date(),
    spawn: defaultSpawn,
    tickMs: Number(process.env.ARGUS_SCHED_TICK_MS ?? 30000),
    newId: () => randomUUID(),
    ...overrides,
  };

  let stopped = false;
  void recoverInterruptedRuns(deps).then(() => deps.onChange?.());

  const loop = setInterval(() => {
    if (stopped) return;
    void tick(deps).catch((e) => console.error("[argus] scheduler tick failed:", e));
  }, deps.tickMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(loop);
    },
  };
}
