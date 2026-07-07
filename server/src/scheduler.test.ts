import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-scheduler-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function load() {
  const scheduler = await import(`./scheduler.js?${Math.random()}`);
  const schedules = await import(`./sources/schedules.js?${Math.random()}`);
  const runs = await import(`./sources/runs.js?${Math.random()}`);
  return { scheduler, schedules, runs };
}

let counter = 0;
const deps = (over: Record<string, unknown>) => ({
  now: () => new Date(2026, 5, 22, 11, 1),
  tickMs: 30000,
  newId: () => `run-${++counter}`,
  spawn: () => ({ pid: 999, done: Promise.resolve({ code: 0, result: "done", error: null }) }),
  ...over,
});

test("tick fires a due schedule and records a succeeded run", async () => {
  const { scheduler, schedules, runs } = await load();
  await schedules.createSchedule(
    { name: "n", prompt: "p", cwd: home, trigger: { kind: "interval", everyMinutes: 60 } },
    new Date(2026, 5, 22, 10, 0),
    "s1",
  );
  await scheduler.tick(deps({}));
  // let the spawn promise resolve
  await new Promise((r) => setTimeout(r, 10));
  const list = await runs.readRuns({ scheduleId: "s1" });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "succeeded");
  const after = (await schedules.readSchedules())[0];
  assert.equal(after.lastRunId, list[0].id);
});

test("overlap=skip records a skipped run when a prior run is alive", async () => {
  const { scheduler, schedules, runs } = await load();
  await schedules.createSchedule(
    { name: "n", prompt: "p", cwd: home, trigger: { kind: "interval", everyMinutes: 60 } },
    new Date(2026, 5, 22, 10, 0),
    "s1",
  );
  // A prior run still "running" with this process's own (alive) pid.
  await runs.writeRun({
    id: "old",
    scheduleId: "s1",
    scheduleName: "n",
    prompt: "p",
    cwd: home,
    status: "running",
    trigger: "scheduled",
    queuedAt: new Date(2026, 5, 22, 10, 30).toISOString(),
    startedAt: new Date(2026, 5, 22, 10, 30).toISOString(),
    endedAt: null,
    durationMs: null,
    pid: process.pid,
    exitCode: null,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
  });
  await scheduler.tick(
    deps({
      spawn: () => {
        throw new Error("should not spawn");
      },
    }),
  );
  const skipped = (await runs.readRuns({ scheduleId: "s1" })).find(
    (r: { status: string }) => r.status === "skipped",
  );
  assert.ok(skipped, "expected a skipped run");
});

test("recoverInterruptedRuns marks dead 'running' rows interrupted", async () => {
  const { scheduler, runs } = await load();
  await runs.writeRun({
    id: "dead",
    scheduleId: "s1",
    scheduleName: "n",
    prompt: "p",
    cwd: home,
    status: "running",
    trigger: "scheduled",
    queuedAt: new Date(2026, 5, 22, 10, 0).toISOString(),
    startedAt: new Date(2026, 5, 22, 10, 0).toISOString(),
    endedAt: null,
    durationMs: null,
    pid: 2_000_000_000,
    exitCode: null,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
  });
  await scheduler.recoverInterruptedRuns({ now: () => new Date(2026, 5, 22, 12, 0) });
  const got = await runs.readRun("dead");
  assert.equal(got?.run.status, "interrupted");
});

test("a failed spawn yields a failed run, scheduler does not throw", async () => {
  const { scheduler, schedules, runs } = await load();
  await schedules.createSchedule(
    { name: "n", prompt: "p", cwd: home, trigger: { kind: "interval", everyMinutes: 60 } },
    new Date(2026, 5, 22, 10, 0),
    "s1",
  );
  await scheduler.tick(
    deps({
      spawn: () => ({ pid: null, done: Promise.resolve({ code: 1, result: null, error: "boom" }) }),
    }),
  );
  await new Promise((r) => setTimeout(r, 10));
  const list = await runs.readRuns({ scheduleId: "s1" });
  assert.equal(list[0].status, "failed");
  assert.equal(list[0].error, "boom");
});

test("tick calls the onTick hook", async () => {
  const { scheduler } = await load();
  let called = 0;
  await scheduler.tick(
    deps({
      onTick: async () => {
        called++;
      },
    }),
  );
  assert.equal(called, 1);
});
