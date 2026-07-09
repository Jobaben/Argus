import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRunEnvelope } from "./scheduler.js";

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

test("backfillRunCosts patches legacy terminal runs from their log envelope, once", async () => {
  const { scheduler, runs } = await load();
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  const base = {
    scheduleId: "pipeline:p1",
    scheduleName: "n",
    prompt: "p",
    cwd: home,
    trigger: "scheduled" as const,
    queuedAt: "2026-06-30T10:00:00.000Z",
    startedAt: "2026-06-30T10:00:00.000Z",
    endedAt: "2026-06-30T10:01:00.000Z",
    durationMs: 60000,
    pid: null,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
  };
  // Legacy run (no costUsd/tokens keys) with an envelope in its log.
  await runs.writeRun({ ...base, id: "legacy", status: "succeeded" });
  writeFileSync(
    runs.runLogPath("legacy"),
    '{"type":"result","is_error":false,"result":"ok","total_cost_usd":0.11,"usage":{"input_tokens":10,"output_tokens":5}}\n',
    "utf8",
  );
  // Legacy run with no envelope: must be marked checked (explicit nulls).
  await runs.writeRun({ ...base, id: "bare", status: "failed" });
  // Still-running and already-captured runs must be untouched.
  await runs.writeRun({ ...base, id: "live", status: "running" });
  await runs.writeRun({ ...base, id: "done", status: "succeeded", costUsd: 1, tokens: 2 });

  const patched = await scheduler.backfillRunCosts();
  assert.equal(patched, 2);
  assert.equal((await runs.readRun("legacy"))!.run.costUsd, 0.11);
  assert.equal((await runs.readRun("legacy"))!.run.tokens, 15);
  assert.equal((await runs.readRun("legacy"))!.run.resultSummary, "ok");
  assert.equal((await runs.readRun("bare"))!.run.costUsd, null);
  assert.equal((await runs.readRun("live"))!.run.costUsd, undefined);
  assert.equal((await runs.readRun("done"))!.run.costUsd, 1);
  // Second pass: everything is checked; nothing to patch.
  assert.equal(await scheduler.backfillRunCosts(), 0);
});

test("parseRunEnvelope harvests the result line from a stream-json NDJSON transcript", () => {
  const transcript = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m" }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }],
        usage: { input_tokens: 9999, output_tokens: 9999 },
      },
      session_id: "s1",
    }),
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      session_id: "s1",
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 42000,
      num_turns: 2,
      result: "All green. ARGUS_OUTCOME: succeeded",
      session_id: "s1",
      total_cost_usd: 0.123,
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
    "",
  ].join("\n");
  const env = parseRunEnvelope(transcript);
  assert.equal(env.result, "All green. ARGUS_OUTCOME: succeeded");
  assert.equal(env.costUsd, 0.123);
  assert.equal(env.tokens, 150);
  assert.equal(env.isError, false);
});
