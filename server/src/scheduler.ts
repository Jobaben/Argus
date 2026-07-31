import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { graceMsFor, shouldFire } from "./sources/nextFire.js";
import { markScheduleRan, readSchedules } from "./sources/schedules.js";
import { accumulateRun } from "./sources/totals.js";
import {
  RUN_KEEP,
  encodeProject,
  patchRun,
  pruneRuns,
  readRun,
  readRuns,
  runLogPath,
  writeRun,
} from "./sources/runs.js";
import { currentEnforcement, isSpendBlocked } from "./sources/budget.js";
import { ONEOFF_SCHEDULE_ID, type LaunchInput } from "./sources/launch.js";
import {
  parseClaudeEnvelope,
  parseEnvelopeFor,
  resolveRuntimeId,
  runtimeFor,
} from "./runtimes/index.js";
import type { Run, RunStatus, Schedule } from "./sources/scheduleTypes.js";
import type { AgentRuntimeId, BudgetEnforcement } from "@argus/contracts";
import { log } from "./log.js";

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
    runtime: resolveRuntimeId(schedule.runtime),
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
  /** Set only by runtimes that mint their own session id (Codex), so the run
   *  record can be patched with the id its transcript actually landed under. */
  sessionId?: string | null;
}

export interface SpawnHandle {
  pid: number | null;
  done: Promise<RunResult>;
}

/**
 * Parse a Claude Code result envelope out of captured stdout.
 *
 * Kept here, and kept Claude-shaped, because it is what every caller that knows
 * it is looking at a `claude -p --output-format json` log already means. Code
 * that may be handed either runtime's log uses `parseEnvelopeFor` instead, which
 * dispatches on the run record's `runtime`.
 */
export const parseRunEnvelope = parseClaudeEnvelope;

/**
 * One-time boot backfill: terminal runs recorded before cost capture existed
 * have no `costUsd`/`tokens` keys at all. Harvest them from each run's log
 * envelope and patch the record. Writing explicit nulls when the log has no
 * envelope marks the run as checked, so later boots skip it (the `undefined`
 * vs `null` distinction). Returns how many runs were patched.
 */
export async function backfillRunCosts(): Promise<number> {
  let patched = 0;
  for (const r of await readRuns()) {
    if (r.status === "running") continue;
    if (r.costUsd !== undefined || r.tokens !== undefined) continue;
    const got = await readRun(r.id);
    if (!got) continue;
    // These records predate runtimes, so most are Claude — but a Codex run can
    // reach here too (queued before a restart, finalized after), and the
    // dispatching parser reads whichever the log actually is.
    const env = parseEnvelopeFor(got.run.runtime, got.log);
    await patchRun(r.id, {
      costUsd: env.costUsd,
      tokens: env.tokens,
      resultSummary: got.run.resultSummary ?? env.result,
    });
    patched++;
  }
  return patched;
}

export type SpawnFn = (run: Run, logPath: string) => SpawnHandle;

export interface SchedulerDeps {
  now: () => Date;
  spawn: SpawnFn;
  tickMs: number;
  newId: () => string;
  onChange?: () => void;
  onTick?: () => Promise<void>;
  /** Called when a run reaches the 'failed' state (for failure notifications). */
  onFailure?: (run: Run) => void;
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
 * Real spawn: runs the run's agent CLI in its cwd, piping stdout+stderr to the
 * log file, with the prompt on stdin.
 *
 * Which CLI and which flags is the runtime's business — `claude -p
 * --output-format json` or `codex exec --json`, both producing something
 * {@link AgentRuntime.parseEnvelope} can turn into a result, a cost and a token
 * count. What stays here is the process discipline that is the same either way:
 * the prompt never touches argv (so no shell parses user-authored text, which
 * `shell:true` on win32 would), the child is a POSIX process-group leader so
 * `killRunProcess` can signal the whole tree, and a bounded stdout tail is kept
 * so a multi-KB result envelope survives.
 */
export const defaultSpawn: SpawnFn = (run, logPath) => {
  const out = createWriteStream(logPath, { flags: "a" });
  const runtime = runtimeFor(run.runtime);
  const plan = runtime.batchPlan({
    prompt: run.prompt,
    sessionId: run.sessionId,
    model: run.model,
  });
  const child = nodeSpawn(plan.bin, plan.args, {
    cwd: run.cwd,
    env: { ...process.env, ...plan.env },
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  child.stdin?.on("error", () => {
    /* ignore broken pipe if the process failed to spawn */
  });
  child.stdin?.write(plan.stdin);
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
      const { result, costUsd, tokens, sessionId } = runtime.parseEnvelope(tail);
      resolve({
        code,
        result,
        error: code === 0 ? null : `exit code ${code}`,
        costUsd,
        tokens,
        sessionId,
      });
    });
  });
  return { pid: child.pid ?? null, done };
};

/** Builds the initial "running" run record shared by scheduled and one-off firings. */
function newRun(
  spec: {
    scheduleId: string;
    scheduleName: string;
    prompt: string;
    cwd: string;
    model?: string;
    runtime?: AgentRuntimeId;
  },
  trigger: "scheduled" | "manual",
  startedAt: Date,
  deps: SchedulerDeps,
): Run {
  // Resolved once, at firing time, and written down: a run started under one
  // default must stay explicable after the default changes.
  const runtime = resolveRuntimeId(spec.runtime);
  return {
    id: deps.newId(),
    scheduleId: spec.scheduleId,
    scheduleName: spec.scheduleName,
    prompt: spec.prompt,
    cwd: spec.cwd,
    status: "running",
    trigger,
    queuedAt: startedAt.toISOString(),
    startedAt: startedAt.toISOString(),
    endedAt: null,
    durationMs: null,
    pid: null,
    exitCode: null,
    // A runtime that mints its own thread id gets a null here and is patched
    // with the real one once the stream reports it; pre-assigning a UUID the
    // CLI will ignore would produce a transcript link to nothing.
    sessionId: runtimeFor(runtime).capabilities.presetSessionId ? deps.newId() : null,
    ...(spec.model ? { model: spec.model } : {}),
    runtime,
    project: encodeProject(spec.cwd),
    resultSummary: null,
    error: null,
  };
}

/** Spawns a prepared run record and tracks it to its terminal state: records
 * the pid, then on completion writes the outcome, prunes the run's bucket,
 * folds cost into the totals and fires the failure/change callbacks. */
async function spawnAndTrack(run: Run, startedAt: Date, deps: SchedulerDeps): Promise<Run> {
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
        // The transcript link for a runtime that names its own session: learned
        // from the stream, kept only if we didn't already have one.
        sessionId: run.sessionId ?? res.sessionId ?? null,
        resultSummary: res.result,
        error: res.error,
        costUsd: res.costUsd,
        tokens: res.tokens,
      };
      await writeRun(finished);
      await pruneRuns(run.scheduleId, RUN_KEEP);
      await accumulateRun(finished.id, deps.now);
      if (finished.status === "failed") deps.onFailure?.(finished);
      deps.onChange?.();
    })
    .catch((e: unknown) => log.error("run completion handler failed", { runId: run.id, err: e }));

  return run;
}

/** Creates a run record, spawns it, and updates the record on completion. */
export async function fireRun(
  schedule: Schedule,
  trigger: "scheduled" | "manual",
  deps: SchedulerDeps,
  /** The budget ladder step in force, when one is. Only softens scheduled runs
   *  — a human clicking Run now is its own authorization. */
  enforcement?: BudgetEnforcement,
): Promise<Run> {
  const startedAt = deps.now();
  const run = newRun(
    {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      prompt: schedule.prompt,
      cwd: schedule.cwd,
      ...(schedule.runtime ? { runtime: schedule.runtime } : {}),
    },
    trigger,
    startedAt,
    deps,
  );
  if (trigger === "scheduled" && enforcement?.action === "warn") {
    run.budgetAction = "warn";
  }
  if (trigger === "scheduled" && enforcement?.action === "downgrade" && enforcement.model) {
    run.budgetAction = "downgrade";
    if (run.model) run.modelDowngradedFrom = run.model;
    run.model = enforcement.model;
  }
  await writeRun(run);
  await markScheduleRan(schedule.id, run.id, run.queuedAt);
  return spawnAndTrack(run, startedAt, deps);
}

/** Fires a one-off run (the Launch tab): no schedule is created or touched;
 * the run lands in the shared `oneoff` bucket and completes like any other. */
export async function fireOneOff(input: LaunchInput, deps: SchedulerDeps): Promise<Run> {
  const startedAt = deps.now();
  const run = newRun(
    {
      scheduleId: ONEOFF_SCHEDULE_ID,
      scheduleName: input.name,
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      ...(input.runtime ? { runtime: input.runtime } : {}),
    },
    "manual",
    startedAt,
    deps,
  );
  await writeRun(run);
  return spawnAndTrack(run, startedAt, deps);
}

/** One scheduler pass: fire every due schedule, honouring the budget hard
 * stop and the overlap policy. */
export async function tick(deps: SchedulerDeps): Promise<void> {
  const now = deps.now();
  const grace = graceMsFor(deps.tickMs);
  const schedules = await readSchedules();
  // One read per tick: the same verdict applies to every schedule due in it.
  let budgetBlocked: boolean | null = null;
  let enforcement: Awaited<ReturnType<typeof currentEnforcement>> | null = null;
  for (const schedule of schedules) {
    if (!shouldFire(schedule, now, grace)) continue;

    budgetBlocked ??= await isSpendBlocked(now);
    if (budgetBlocked) {
      const iso = now.toISOString();
      const id = deps.newId();
      const skipped = ephemeralRun(
        schedule,
        id,
        "skipped",
        iso,
        null,
        "skipped: spend budget exceeded",
      );
      skipped.budgetAction = "stop";
      await writeRun(skipped);
      await markScheduleRan(schedule.id, id, iso);
      await pruneRuns(schedule.id, RUN_KEEP);
      deps.onChange?.();
      continue;
    }

    // Below the hard stop, the ladder can still soften or postpone this firing.
    // Recorded on the run either way: "why did Tuesday's run use Haiku" has to
    // be answerable from the record, not by correlating timestamps against a
    // policy that has since been edited.
    enforcement ??= await currentEnforcement(now);
    if (enforcement.action === "defer") {
      const iso = now.toISOString();
      const id = deps.newId();
      const deferred = ephemeralRun(
        schedule,
        id,
        "skipped",
        iso,
        null,
        `deferred: ${enforcement.detail}`,
      );
      deferred.budgetAction = "defer";
      await writeRun(deferred);
      await markScheduleRan(schedule.id, id, iso);
      await pruneRuns(schedule.id, RUN_KEEP);
      deps.onChange?.();
      continue;
    }

    if (schedule.overlapPolicy === "skip") {
      const alive = (await readRuns({ scheduleId: schedule.id })).some(
        (r) => r.status === "running" && isAlive(r.pid),
      );
      if (alive) {
        const iso = now.toISOString();
        const id = deps.newId();
        await writeRun(
          ephemeralRun(
            schedule,
            id,
            "skipped",
            iso,
            null,
            "skipped: previous run still in progress",
          ),
        );
        await markScheduleRan(schedule.id, id, iso);
        await pruneRuns(schedule.id, RUN_KEEP);
        deps.onChange?.();
        continue;
      }
    }

    try {
      await fireRun(schedule, "scheduled", deps, enforcement ?? undefined);
    } catch (e) {
      // Never let one schedule's failure break the tick.
      const iso = now.toISOString();
      const failed = ephemeralRun(
        schedule,
        deps.newId(),
        "failed",
        iso,
        iso,
        e instanceof Error ? e.message : String(e),
      );
      await writeRun(failed);
      await pruneRuns(schedule.id, RUN_KEEP);
      // A spawn-time failure is still a failure the operator should hear about.
      deps.onFailure?.(failed);
      deps.onChange?.();
    }
  }
  if (deps.onTick) {
    try {
      await deps.onTick();
    } catch (e) {
      log.error("pipeline reconcile failed", { err: e });
    }
  }
}

/** On startup, mark any 'running' run whose process is gone as interrupted. */
export async function recoverInterruptedRuns(deps: Pick<SchedulerDeps, "now">): Promise<void> {
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
export function startScheduler(overrides: Partial<SchedulerDeps> = {}): {
  stop: () => Promise<void>;
} {
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
  // Startup recovery runs async; stop() awaits it so a shutdown mid-recovery
  // doesn't let recovery writes continue past stop.
  const recovery = recoverInterruptedRuns(deps)
    .then(() => deps.onChange?.())
    .catch((e: unknown) => log.error("interrupted-run recovery failed", { err: e }));

  const runTick = () => {
    if (stopped || inFlight) return;
    inFlight = tick(deps)
      .catch((e: unknown) => log.error("scheduler tick failed", { err: e }))
      .finally(() => {
        inFlight = null;
      });
  };

  const loop = setInterval(runTick, deps.tickMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(loop);
      // Let in-flight recovery and tick finish so shutdown doesn't race writes.
      await recovery;
      if (inFlight) await inFlight;
    },
  };
}
