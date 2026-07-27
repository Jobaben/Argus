import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERDICT_MAX_AGE_MS, createVerdictWatcher, rubricFor } from "./verdictWatcher.js";
import { readVerdicts, writeVerdict, type Rubric, type Verdict } from "./sources/verdict.js";
import { createAnalysisRunner, type AnalysisSpawn } from "./sources/analysis.js";
import type { PipelineDefinition, PipelineInstance } from "./sources/pipelineTypes.js";
import type { Run, Schedule } from "./sources/scheduleTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-verdictw-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_ANALYSIS;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");

const RUBRIC: Rubric = {
  goal: "Be good.",
  criteria: [{ id: "quality", label: "Overall quality" }],
  minScore: 6,
};

function run(id: string, over: Partial<Run> = {}): Run {
  const at = new Date(NOW.getTime() - 60_000).toISOString();
  return {
    id,
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    durationMs: 1000,
    pid: null,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: "the output",
    error: null,
    ...over,
  };
}

function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    trigger: { kind: "interval", everyMinutes: 60 },
    enabled: true,
    overlapPolicy: "skip",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastRunAt: null,
    lastRunId: null,
    ...over,
  };
}

function pipeline(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "p1",
    name: "Release train",
    phases: [
      {
        id: "build",
        name: "Build",
        cwd: "/tmp",
        steps: [{ name: "s", prompt: "p" }],
        gated: true,
        rubric: RUBRIC,
        autoApprove: { verdict: 7 },
      },
    ],
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

function instance(over: Partial<PipelineInstance> = {}): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "p1",
    pipelineName: "Release train",
    status: "awaiting-approval",
    currentPhaseIndex: 0,
    phases: [
      {
        id: "build",
        name: "Build",
        gated: true,
        status: "awaiting-approval",
        steps: [{ name: "s", runId: "step-1", status: "succeeded" }],
        attempt: 1,
        payload: null,
      },
    ],
    trigger: "manual",
    signalToken: "t",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    endedAt: null,
    ...over,
  };
}

const answer = (score: number) =>
  JSON.stringify({
    result: JSON.stringify({ criteria: [{ id: "quality", score, note: "n" }] }),
    total_cost_usd: 0.001,
  });

const respond =
  (stdout: string): AnalysisSpawn =>
  () => ({ kill: () => {}, done: Promise.resolve({ code: 0, stdout, error: null }) });

function verdict(runId: string, score: number, over: Partial<Verdict> = {}): Verdict {
  return {
    runId,
    scheduleId: "pipeline:p1",
    scheduleName: "Release train",
    phaseId: "build",
    status: "ready",
    at: NOW.toISOString(),
    score,
    criteria: [],
    summary: null,
    regression: false,
    minScore: 6,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
    ...over,
  };
}

function watcher(opts: {
  runs?: Run[];
  schedules?: Schedule[];
  pipelines?: PipelineDefinition[];
  instances?: PipelineInstance[];
  spawn?: AnalysisSpawn;
}) {
  const approved: string[] = [];
  const judged: string[] = [];
  const w = createVerdictWatcher({
    runner: createAnalysisRunner({
      spawn: opts.spawn ?? respond(answer(8)),
      now: () => NOW,
      meter: async () => {},
    }),
    now: () => NOW,
    readRuns: async () => opts.runs ?? [],
    readSchedules: async () => opts.schedules ?? [],
    readPipelines: async () => opts.pipelines ?? [],
    readInstances: async () => opts.instances ?? [],
    approve: async (id) => {
      approved.push(id);
      return { ok: true };
    },
    onVerdict: (id) => judged.push(id),
  });
  return { w, approved, judged };
}

// ── Which rubric governs a run ──────────────────────────────────────────────

test("rubricFor resolves a schedule's rubric and a phase's rubric", () => {
  const scheds = [schedule({ rubric: RUBRIC })];
  assert.equal(rubricFor(run("a"), scheds, []), RUBRIC);
  assert.equal(rubricFor(run("a"), [schedule()], []), null);

  const step = run("b", { scheduleId: "pipeline:p1", phaseId: "build" });
  assert.equal(rubricFor(step, [], [pipeline()])?.goal, "Be good.");
  assert.equal(rubricFor(step, [], []), null, "a deleted pipeline is not a crash");
  const renamedPhase = run("c", { scheduleId: "pipeline:p1", phaseId: "gone" });
  assert.equal(rubricFor(renamedPhase, [], [pipeline()]), null);
});

// ── Scoring ─────────────────────────────────────────────────────────────────

test("only runs whose definition declares a rubric are judged", async () => {
  const { w, judged } = watcher({ runs: [run("a")], schedules: [schedule()] });
  await w.check();
  assert.equal(judged.length, 0);
});

test("a run with a rubric is judged, once", async () => {
  const { w, judged } = watcher({ runs: [run("a")], schedules: [schedule({ rubric: RUBRIC })] });
  await w.check();
  await w.check();
  assert.deepEqual(judged, ["a"]);
  assert.equal((await readVerdicts()).length, 1);
});

test("failed runs and runs with no output are not judged — there is nothing to score", async () => {
  const { w, judged } = watcher({
    runs: [run("failed", { status: "failed", exitCode: 1 }), run("empty", { resultSummary: "" })],
    schedules: [schedule({ rubric: RUBRIC })],
  });
  await w.check();
  assert.equal(judged.length, 0);
});

test("regression: a backlog is judged one run per tick", async () => {
  const { w, judged } = watcher({
    runs: [run("a"), run("b"), run("c")],
    schedules: [schedule({ rubric: RUBRIC })],
  });
  await w.check();
  assert.equal(judged.length, 1);
  await w.check();
  await w.check();
  assert.equal(judged.length, 3);
});

test("stale runs are not judged — the score would arrive after anyone cared", async () => {
  const old = new Date(NOW.getTime() - VERDICT_MAX_AGE_MS - 3_600_000).toISOString();
  const { w, judged } = watcher({
    runs: [run("a", { endedAt: old, startedAt: old, queuedAt: old })],
    schedules: [schedule({ rubric: RUBRIC })],
  });
  await w.check();
  assert.equal(judged.length, 0);
});

// ── Auto-approving gates ────────────────────────────────────────────────────

test("a gate opens itself once its output scores at or above the bar", async () => {
  await writeVerdict(verdict("step-1", 8));
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [instance()] });
  await w.check();
  assert.deepEqual(approved, ["i1"]);
});

test("regression: a gate with no verdict yet waits — silence is not approval", async () => {
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [instance()] });
  await w.check();
  assert.equal(approved.length, 0);
});

test("regression: a gate whose verdict came back below the bar waits for a human", async () => {
  await writeVerdict(verdict("step-1", 5));
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [instance()] });
  await w.check();
  assert.equal(approved.length, 0);
});

test("regression: every judged step must clear the bar, not the average", async () => {
  // One excellent step must not carry a bad one through a gate a human set
  // precisely to catch it.
  await writeVerdict(verdict("step-1", 10));
  await writeVerdict(verdict("step-2", 2));
  const inst = instance({
    phases: [
      {
        id: "build",
        name: "Build",
        gated: true,
        status: "awaiting-approval",
        steps: [
          { name: "a", runId: "step-1", status: "succeeded" },
          { name: "b", runId: "step-2", status: "succeeded" },
        ],
        attempt: 1,
        payload: null,
      },
    ],
  });
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [inst] });
  await w.check();
  assert.equal(approved.length, 0);
});

test("a gated phase with no autoApprove is never opened automatically", async () => {
  await writeVerdict(verdict("step-1", 10));
  const noAuto = pipeline({
    phases: [
      {
        id: "build",
        name: "Build",
        cwd: "/tmp",
        steps: [{ name: "s", prompt: "p" }],
        gated: true,
        rubric: RUBRIC,
      },
    ],
  });
  const { w, approved } = watcher({ pipelines: [noAuto], instances: [instance()] });
  await w.check();
  assert.equal(approved.length, 0);
});

test("an instance that is not awaiting approval is untouched", async () => {
  await writeVerdict(verdict("step-1", 10));
  const { w, approved } = watcher({
    pipelines: [pipeline()],
    instances: [instance({ status: "running" })],
  });
  await w.check();
  assert.equal(approved.length, 0);
});

test("a read failure is swallowed rather than wedging the scheduler tick", async () => {
  const w = createVerdictWatcher({
    runner: createAnalysisRunner({
      spawn: respond(answer(8)),
      now: () => NOW,
      meter: async () => {},
    }),
    now: () => NOW,
    readRuns: () => Promise.reject(new Error("disk gone")),
    readSchedules: async () => [],
    readPipelines: async () => [],
    readInstances: async () => [],
    approve: async () => ({ ok: true }),
  });
  await w.check();
});
