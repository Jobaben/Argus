import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRunEnvelope } from "./scheduler.js";
import * as schedulerModule from "./scheduler.js";

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

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
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
  // `tick` returns before the run does: completion is handled off the spawn
  // promise, so the terminal status lands whenever the event loop gets to it.
  // Waiting a fixed 10ms for that was a coin toss on a loaded machine — wait for
  // the state itself. Waiting for *terminal* rather than for "succeeded" keeps a
  // wrong outcome an assertion failure that names it, not a timeout that doesn't.
  await waitFor(async () => (await runs.readRuns({ scheduleId: "s1" }))[0]?.status !== "running");
  const list = await runs.readRuns({ scheduleId: "s1" });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "succeeded");
  const after = (await schedules.readSchedules())[0];
  assert.equal(after.lastRunId, list[0].id);
});

test("a completed scheduler run folds its cost into the totals", async () => {
  const { scheduler, schedules } = await load();
  const totals = await import(`./sources/totals.js?${Math.random()}`);
  await schedules.createSchedule(
    { name: "n", prompt: "p", cwd: home, trigger: { kind: "interval", everyMinutes: 60 } },
    new Date(2026, 5, 22, 10, 0),
    "s1",
  );
  await scheduler.tick(
    deps({
      spawn: () => ({
        pid: 999,
        done: Promise.resolve({
          code: 0,
          result: "done",
          error: null,
          costUsd: 0.123,
          tokens: 150,
        }),
      }),
    }),
  );
  await waitFor(async () => (await totals.readTotals()).runsCounted === 1);
  const t = await totals.readTotals();
  assert.equal(t.usd, 0.123);
  assert.equal(t.runsCounted, 1);
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
  await waitFor(async () => (await runs.readRuns({ scheduleId: "s1" }))[0]?.status !== "running");
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

test("fireOneOff records a run in the oneoff bucket without touching schedules", async () => {
  const { scheduler, schedules, runs } = await load();
  const run = await scheduler.fireOneOff(
    { name: "Quick audit", prompt: "audit", cwd: home, model: "haiku" },
    deps({}),
  );
  assert.equal(run.scheduleId, "oneoff");
  assert.equal(run.scheduleName, "Quick audit");
  assert.equal(run.trigger, "manual");
  assert.equal(run.model, "haiku");
  await waitFor(
    async () => (await runs.readRuns({ scheduleId: "oneoff" }))[0]?.status !== "running",
  );
  const list = await runs.readRuns({ scheduleId: "oneoff" });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "succeeded");
  assert.equal(list[0].resultSummary, "done");
  assert.equal((await schedules.readSchedules()).length, 0);
});

test("a failed one-off run reaches onFailure and stays in the bucket", async () => {
  const { scheduler, runs } = await load();
  const failures: string[] = [];
  await scheduler.fireOneOff(
    { name: "boom", prompt: "p", cwd: home },
    deps({
      spawn: () => ({
        pid: 1,
        done: Promise.resolve({ code: 3, result: null, error: "exit code 3" }),
      }),
      onFailure: (r: { scheduleName: string }) => failures.push(r.scheduleName),
    }),
  );
  await waitFor(() => failures.length === 1);
  const list = await runs.readRuns({ scheduleId: "oneoff" });
  assert.equal(list[0].status, "failed");
  assert.equal(list[0].error, "exit code 3");
});

test("a run whose envelope says is_error fails even though the process exited 0", async () => {
  const { scheduler, runs } = await load();
  const failures: string[] = [];
  await scheduler.fireOneOff(
    { name: "refused", prompt: "p", cwd: home },
    deps({
      spawn: () => ({
        pid: 1,
        done: Promise.resolve({
          code: 0,
          result: "Invalid API key · Please run /login",
          error: "Invalid API key · Please run /login",
          costUsd: null,
          tokens: null,
          isError: true,
        }),
      }),
      onFailure: (r: { scheduleName: string }) => failures.push(r.scheduleName),
    }),
  );
  await waitFor(() => failures.length === 1);
  const list = await runs.readRuns({ scheduleId: "oneoff" });
  assert.equal(list[0].status, "failed");
  assert.equal(list[0].exitCode, 0);
  assert.equal(list[0].error, "Invalid API key · Please run /login");
});

test("a clean exit with no envelope to read (isError null) still succeeds", async () => {
  const { scheduler, runs } = await load();
  await scheduler.fireOneOff(
    { name: "quiet", prompt: "p", cwd: home },
    deps({
      spawn: () => ({
        pid: 1,
        done: Promise.resolve({
          code: 0,
          result: null,
          error: null,
          costUsd: null,
          tokens: null,
          isError: null,
        }),
      }),
    }),
  );
  await waitFor(
    async () => (await runs.readRuns({ scheduleId: "oneoff" }))[0]?.status !== "running",
  );
  assert.equal((await runs.readRuns({ scheduleId: "oneoff" }))[0].status, "succeeded");
});

test("runSucceeded / runError: exit code is a precondition, the envelope is the verdict", () => {
  const { runSucceeded, runError } = schedulerModule;
  assert.equal(runSucceeded({ code: 0, isError: null }), true);
  assert.equal(runSucceeded({ code: 0, isError: false }), true);
  assert.equal(runSucceeded({ code: 0, isError: true }), false);
  assert.equal(runSucceeded({ code: 0 }), true);
  assert.equal(runSucceeded({ code: 1, isError: false }), false);
  assert.equal(runSucceeded({ code: null, isError: null }), false);
  // A non-zero exit names the exit code even when the envelope also errored.
  assert.equal(runError(1, true, "boom"), "exit code 1");
  assert.equal(runError(null, null, null), "exit code null");
  // Exit 0 + is_error names the CLI's own message, or a fallback if it had none.
  assert.equal(runError(0, true, "  Invalid API key  "), "Invalid API key");
  assert.equal(runError(0, true, ""), "agent reported an error");
  assert.equal(runError(0, true, null), "agent reported an error");
  assert.equal(runError(0, false, "fine"), null);
  assert.equal(runError(0, null, null), null);
});

test("tick skips a due schedule while the budget hard stop is engaged", async () => {
  const { scheduler, schedules, runs } = await load();
  const budget = await import(`./sources/budget.js?${Math.random()}`);
  const now = new Date(2026, 5, 22, 11, 1);
  await budget.updateBudgetConfig({ dailyUsd: 1, blockScheduled: true }, now);
  await budget.recordRunSpend({ endedAt: now.toISOString(), queuedAt: "", costUsd: 2 }, () => now);
  await schedules.createSchedule(
    { name: "n", prompt: "p", cwd: home, trigger: { kind: "interval", everyMinutes: 60 } },
    new Date(2026, 5, 22, 10, 0),
    "s1",
  );
  let spawned = 0;
  await scheduler.tick(deps({ spawn: () => (spawned++, { pid: 1, done: new Promise(() => {}) }) }));
  assert.equal(spawned, 0);
  const list = await runs.readRuns({ scheduleId: "s1" });
  assert.equal(list.length, 1);
  assert.equal(list[0].status, "skipped");
  assert.match(list[0].error ?? "", /budget/);
  // The slot counts as covered, so the next tick doesn't re-skip it.
  await scheduler.tick(deps({}));
  assert.equal((await runs.readRuns({ scheduleId: "s1" })).length, 1);
});

test("tick fires normally when the budget is alert-only (blockScheduled off)", async () => {
  const { scheduler, schedules, runs } = await load();
  const budget = await import(`./sources/budget.js?${Math.random()}`);
  const now = new Date(2026, 5, 22, 11, 1);
  await budget.updateBudgetConfig({ dailyUsd: 1 }, now);
  await budget.recordRunSpend({ endedAt: now.toISOString(), queuedAt: "", costUsd: 2 }, () => now);
  await schedules.createSchedule(
    { name: "n", prompt: "p", cwd: home, trigger: { kind: "interval", everyMinutes: 60 } },
    new Date(2026, 5, 22, 10, 0),
    "s1",
  );
  await scheduler.tick(deps({}));
  await waitFor(async () => (await runs.readRuns({ scheduleId: "s1" }))[0]?.status === "succeeded");
});

// ── after-triggered chaining ──────────────────────────────────────────────────

async function loadChainDeps() {
  const pipelines = await import(`./sources/pipelines.js?${Math.random()}`);
  const instances = await import(`./sources/instances.js?${Math.random()}`);
  const chains = await import(`./sources/chains.js?${Math.random()}`);
  return { pipelines, instances, chains };
}

function sourcePipelineInput(over: Record<string, unknown> = {}) {
  return {
    name: "source",
    phases: [{ id: "p", name: "p", cwd: home, gated: false, steps: [{ name: "s", prompt: "go" }] }],
    trigger: null,
    ...over,
  };
}

function fakeInstance(over: Record<string, unknown>) {
  return {
    id: "inst-1",
    pipelineId: "source",
    pipelineName: "source",
    status: "succeeded",
    currentPhaseIndex: 0,
    phases: [],
    trigger: "manual",
    signalToken: "tok",
    createdAt: new Date(2026, 5, 22, 9, 0).toISOString(),
    updatedAt: new Date(2026, 5, 22, 9, 5).toISOString(),
    endedAt: new Date(2026, 5, 22, 9, 5).toISOString(),
    ...over,
  };
}

test("tick chains a source instance into a target pipeline exactly once", async () => {
  const { scheduler } = await load();
  const { pipelines, instances, chains } = await loadChainDeps();
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(sourcePipelineInput()),
    new Date(2026, 5, 22, 8, 0),
    "source",
  );
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(
      sourcePipelineInput({
        name: "target",
        trigger: { kind: "after", pipelineId: "source", on: "succeeded" },
      }),
    ),
    new Date(2026, 5, 22, 8, 0),
    "target",
  );
  await instances.writeInstance(fakeInstance({}));

  const started: unknown[] = [];
  await scheduler.tick(
    deps({
      startPipeline: async (pipelineId: string, trigger: string, firing: unknown) => {
        started.push([pipelineId, trigger, firing]);
        return { id: "chained-1" };
      },
    }),
  );
  assert.equal(started.length, 1);
  assert.deepEqual(started[0], [
    "target",
    "chained",
    {
      chainedFrom: "inst-1",
      triggerPayload: { sourceInstanceId: "inst-1", sourcePipelineId: "source", status: "succeeded" },
    },
  ]);

  const ledger = await chains.readChainLedger();
  assert.deepEqual(ledger["inst-1"], ["target"]);

  // A second tick must not fire again — the ledger already recorded it.
  await scheduler.tick(
    deps({ startPipeline: async () => (started.push("again"), { id: "x" }) }),
  );
  assert.equal(started.length, 1);
});

test("tick does not chain an instance that ended before the target's trigger was saved", async () => {
  const { scheduler } = await load();
  const { pipelines, instances } = await loadChainDeps();
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(sourcePipelineInput()),
    new Date(2026, 5, 22, 8, 0),
    "source",
  );
  // Target's `after` trigger is saved *after* the source instance already ended.
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(
      sourcePipelineInput({
        name: "target",
        trigger: { kind: "after", pipelineId: "source", on: "succeeded" },
      }),
    ),
    new Date(2026, 5, 22, 10, 0),
    "target",
  );
  await instances.writeInstance(fakeInstance({}));

  let started = 0;
  await scheduler.tick(deps({ startPipeline: async () => (started++, { id: "x" }) }));
  assert.equal(started, 0);
});

test("tick honours `on`: a failed source instance does not chain an on:succeeded target", async () => {
  const { scheduler } = await load();
  const { pipelines, instances } = await loadChainDeps();
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(sourcePipelineInput()),
    new Date(2026, 5, 22, 8, 0),
    "source",
  );
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(
      sourcePipelineInput({
        name: "target",
        trigger: { kind: "after", pipelineId: "source", on: "succeeded" },
      }),
    ),
    new Date(2026, 5, 22, 8, 0),
    "target",
  );
  await instances.writeInstance(fakeInstance({ status: "failed" }));

  let started = 0;
  await scheduler.tick(deps({ startPipeline: async () => (started++, { id: "x" }) }));
  assert.equal(started, 0);
});

test("tick chains an after-triggered schedule as a normal scheduled run, trigger: chained", async () => {
  const { scheduler, schedules, runs } = await load();
  const { pipelines, instances } = await loadChainDeps();
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(sourcePipelineInput()),
    new Date(2026, 5, 22, 8, 0),
    "source",
  );
  await schedules.createSchedule(
    {
      name: "n",
      prompt: "p",
      cwd: home,
      trigger: { kind: "after", pipelineId: "source", on: "any" },
    },
    new Date(2026, 5, 22, 8, 0),
    "s1",
  );
  await instances.writeInstance(fakeInstance({}));

  await scheduler.tick(deps({}));
  await waitFor(async () => (await runs.readRuns({ scheduleId: "s1" })).length > 0);
  const list = await runs.readRuns({ scheduleId: "s1" });
  assert.equal(list.length, 1);
  assert.equal(list[0].trigger, "chained");
});

test("tick leaves an overlap=skip busy pipeline target out of the ledger, so it retries", async () => {
  const { scheduler } = await load();
  const { pipelines, instances, chains } = await loadChainDeps();
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(sourcePipelineInput()),
    new Date(2026, 5, 22, 8, 0),
    "source",
  );
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(
      sourcePipelineInput({
        name: "target",
        trigger: { kind: "after", pipelineId: "source", on: "any" },
      }),
    ),
    new Date(2026, 5, 22, 8, 0),
    "target",
  );
  await instances.writeInstance(fakeInstance({}));

  // startPipeline returning null mirrors the engine's own overlap=skip refusal.
  await scheduler.tick(deps({ startPipeline: async () => null }));
  const ledger = await chains.readChainLedger();
  assert.equal(ledger["inst-1"], undefined);
});
