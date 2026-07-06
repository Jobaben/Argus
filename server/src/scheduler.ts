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
import type { Run, RunStatus, Schedule } from "./sources/scheduleTypes.js";

/** Builds a terminal run record for a schedule that never spawned a process
 * (skipped due to overlap, or failed before/at spawn). */
function ephemeralRun(
  schedule: Schedule,
  id: string,
  status: RunStatus,
  iso: string,
  startedAt: string | null,
  error: string,
): Run {
  return {
    id,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    prompt: schedule.prompt,
    cwd: schedule.cwd,
    status,
    trigger: "scheduled",
    queuedAt: iso,
    startedAt,
    endedAt: iso,
    durationMs: 0,
    pid: null,
    exitCode: null,
    sessionId: null,
    project: null,
    resultSummary: null,
    error,
  };
}

export interface RunResult {
  code: number | null;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  tokens: number | null;
}

export interface SpawnHandle {
  pid: number | null;
  done: Promise<RunResult>;
}

/**
 * `claude -p --output-format json` prints a single JSON envelope as its final
 * output. Parse it out of the captured stdout, tolerant of anything the tool
 * logged before it: try the whole buffer, then fall back to the last balanced
 * top-level `{...}` object. Returns nulls when nothing parses.
 */
export function parseRunEnvelope(stdout: string): {
  result: string | null;
  costUsd: number | null;
  tokens: number | null;
} {
  const empty = { result: null, costUsd: null, tokens: null };
  const extract = (obj: Record<string, unknown>) => {
    const usage = (obj.usage ?? {}) as Record<string, unknown>;
    const inTok = Number(usage.input_tokens ?? 0);
    const outTok = Number(usage.output_tokens ?? 0);
    const tokens = Number.isFinite(inTok + outTok) && inTok + outTok > 0 ? inTok + outTok : null;
    const cost = Number(obj.total_cost_usd ?? obj.cost_usd);
    return {
      result: typeof obj.result === "string" ? obj.result : null,
      costUsd: Number.isFinite(cost) ? cost : null,
      tokens,
    };
  };
  const text = stdout.trim();
  if (!text) return empty;
  try {
    return extract(JSON.parse(text) as Record<string, unknown>);
  } catch {
    // Scan backwards for the last balanced brace-delimited object.
    const end = text.lastIndexOf("}");
    for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
      try {
        return extract(JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>);
      } catch {
        /* keep scanning earlier braces */
      }
    }
    return empty;
  }
}

export type SpawnFn = (run: Run, logPath: string) => SpawnHandle;

export interface SchedulerDeps {
  now: () => Date;
  spawn: SpawnFn;
  tickMs: number;
  newId: () => string;
  onChange?: () => void;
  onTick?: () => Promise<void>;
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
    ["-p", "--output-format", "json", "--session-id", run.sessionId ?? randomUUID()],
    { cwd: run.cwd, shell: process.platform === "win32" },
  );
  // The prompt is user-authored; pass it on stdin so no shell parsing touches it
  // (shell:true on win32 would otherwise word-split it and interpret metacharacters).
  child.stdin?.on("error", () => {
    /* ignore broken pipe if the process failed to spawn */
  });
  child.stdin?.write(run.prompt);
  child.stdin?.end();
  child.stdout?.pipe(out, { end: false });
  child.stderr?.pipe(out, { end: false });

  const done = new Promise<RunResult>((resolve) => {
    let settled = false;
    // Keep enough tail to hold a large result envelope (the CLI can emit
    // multi-KB JSON); 8 KB silently dropped results whose JSON exceeded it.
    let tail = "";
    const TAIL_CAP = 256 * 1024;
    child.stdout?.on("data", (d: Buffer) => {
      tail = (tail + d.toString("utf8")).slice(-TAIL_CAP);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      out.end();
      resolve({ code: null, result: null, error: err.message, costUsd: null, tokens: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      out.end();
      const { result, costUsd, tokens } = parseRunEnvelope(tail);
      resolve({ code, result, error: code === 0 ? null : `exit code ${code}`, costUsd, tokens });
    });
  });
  return { pid: child.pid ?? null, done };
};

/** Creates a run record, spawns it, and updates the record on completion. */
export async function fireRun(
  schedule: Schedule,
  trigger: "scheduled" | "manual",
  deps: SchedulerDeps,
): Promise<Run> {
  const startedAt = deps.now();
  const sessionId = deps.newId();
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

  // Track completion without blocking the tick. Errors in the handler must not
  // become an unhandled rejection that crashes the daemon.
  void handle.done
    .then(async (res) => {
      const ended = deps.now();
      const finished: Run = {
        ...run,
        status: res.code === 0 ? "succeeded" : "failed",
        endedAt: ended.toISOString(),
        durationMs: ended.getTime() - startedAt.getTime(),
        exitCode: res.code,
        resultSummary: res.result,
        error: res.error,
        costUsd: res.costUsd,
        tokens: res.tokens,
      };
      await writeRun(finished);
      await pruneRuns(schedule.id, RUN_KEEP);
      deps.onChange?.();
    })
    .catch((e) => console.error(`[argus] run ${run.id} completion handler failed:`, e));

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
        const id = deps.newId();
        await writeRun(
          ephemeralRun(schedule, id, "skipped", iso, null, "skipped: previous run still in progress"),
        );
        await markScheduleRan(schedule.id, id, iso);
        await pruneRuns(schedule.id, RUN_KEEP);
        deps.onChange?.();
        continue;
      }
    }

    try {
      await fireRun(schedule, "scheduled", deps);
    } catch (e) {
      // Never let one schedule's failure break the tick.
      const iso = now.toISOString();
      await writeRun(
        ephemeralRun(
          schedule,
          deps.newId(),
          "failed",
          iso,
          iso,
          e instanceof Error ? e.message : String(e),
        ),
      );
      await pruneRuns(schedule.id, RUN_KEEP);
      deps.onChange?.();
    }
  }
  if (deps.onTick) {
    try {
      await deps.onTick();
    } catch (e) {
      console.error("[argus] pipeline reconcile failed:", e);
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
  // Guards against overlapping ticks: a tick that runs longer than tickMs (slow
  // disk, many schedules) must not start a second pass concurrently, or the two
  // could both see a schedule as due and fire it twice within the grace window.
  let inFlight: Promise<void> | null = null;
  void recoverInterruptedRuns(deps).then(() => deps.onChange?.());

  const runTick = () => {
    if (stopped || inFlight) return;
    inFlight = tick(deps)
      .catch((e) => console.error("[argus] scheduler tick failed:", e))
      .finally(() => { inFlight = null; });
  };

  const loop = setInterval(runTick, deps.tickMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(loop);
      // Let an in-flight tick finish so shutdown doesn't race its writes.
      if (inFlight) await inFlight;
    },
  };
}
