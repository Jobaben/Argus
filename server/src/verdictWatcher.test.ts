import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VERDICT_MAX_AGE_MS, createVerdictWatcher, rubricFor } from "./verdictWatcher.js";
import {
  readVerdicts,
  rubricDigest,
  writeVerdict,
  type Rubric,
  type Verdict,
} from "./sources/verdict.js";
import type { AutomatedApproval } from "./pipelineEngine.js";
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
        pause: "gate",
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
    rubricDigest: rubricDigest(RUBRIC),
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
  const requests: AutomatedApproval[] = [];
  const withheld: Array<{ instanceId: string; phaseId: string; attempt: number; reason: string }> =
    [];
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
    approveAutomatically: async (request) => {
      approved.push(request.instanceId);
      requests.push(request);
      return { ok: true };
    },
    onVerdict: (id) => judged.push(id),
    onAutoApprovalWithheld: (instanceId, phaseId, attempt, reason) =>
      withheld.push({ instanceId, phaseId, attempt, reason }),
  });
  return { w, approved, requests, withheld, judged };
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

  // A step run is judged by the rubric its instance started with: a rubric
  // edited (or removed) on the live definition does not move the bar under a
  // run that is already in flight.
  const pinned = run("d", { scheduleId: "pipeline:p1", phaseId: "build", instanceId: "i1" });
  const stricter = pipeline({
    phases: pipeline().phases.map((p) => ({ ...p, rubric: { ...RUBRIC, goal: "Be perfect." } })),
  });
  const snapshot = instance({ definition: pipeline() });
  assert.equal(rubricFor(pinned, [], [stricter], [snapshot])?.goal, "Be good.");
  assert.equal(rubricFor(pinned, [], [], [snapshot])?.goal, "Be good.", "deleted, still judged");
  const legacy = instance();
  assert.equal(rubricFor(pinned, [], [stricter], [legacy])?.goal, "Be perfect.", "no snapshot");
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
  await writeVerdict(verdict("step-1", 8, { id: "V-1" }));
  const { w, approved, requests } = watcher({ pipelines: [pipeline()], instances: [instance()] });
  await w.check();
  assert.deepEqual(approved, ["i1"]);
  // Bound to the exact phase, attempt, run and verdict — never "whatever is
  // paused on this instance".
  assert.equal(requests[0].phaseId, "build");
  assert.equal(requests[0].attempt, 1);
  assert.deepEqual(requests[0].runIds, ["step-1"]);
  assert.equal(requests[0].verdicts[0].verdictId, "V-1");
  assert.equal(requests[0].verdicts[0].score, 8);
  assert.equal(requests[0].verdicts[0].bar, 7);
  assert.equal(requests[0].verdicts[0].rubricDigest, rubricDigest(RUBRIC));
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
        pause: "gate",
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
    approveAutomatically: async () => ({ ok: true }),
  });
  await w.check();
});

// ── Completeness, currency and binding (Phase 0) ────────────────────────────

const twoSteps = (over: Partial<PipelineInstance["phases"][number]> = {}) =>
  instance({
    phases: [
      {
        id: "build",
        name: "Build",
        gated: true,
        status: "awaiting-approval",
        pause: "gate",
        steps: [
          { name: "a", runId: "step-1", status: "succeeded" },
          { name: "b", runId: "step-2", status: "succeeded" },
        ],
        attempt: 1,
        payload: null,
        ...over,
      },
    ],
  });

test("regression: a gate with only SOME steps judged waits — partial judging is not approval", async () => {
  // Before Phase 0 the watcher took the minimum over the steps that happened
  // to have a verdict, so one judged 10/10 step opened a two-step gate whose
  // other step had never been looked at.
  await writeVerdict(verdict("step-1", 10));
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [twoSteps()] });
  await w.check();
  assert.equal(approved.length, 0);
});

test("every relevant step judged at or above the bar opens the gate, naming every run", async () => {
  await writeVerdict(verdict("step-1", 9));
  await writeVerdict(verdict("step-2", 7));
  const { w, requests } = watcher({ pipelines: [pipeline()], instances: [twoSteps()] });
  await w.check();
  assert.equal(requests.length, 1);
  assert.deepEqual([...requests[0].runIds].sort(), ["step-1", "step-2"]);
  assert.equal(requests[0].verdicts.length, 2);
});

test("regression: a failed or skipped current verdict holds the gate, even over an older good one", async () => {
  await writeVerdict(verdict("step-1", 9, { at: "2026-07-20T11:00:00.000Z" }));
  await writeVerdict(
    verdict("step-1", 0, {
      status: "failed",
      score: null,
      at: "2026-07-20T11:30:00.000Z",
      error: "timed out",
    }),
  );
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [instance()] });
  await w.check();
  assert.equal(approved.length, 0, "the run's current judgment is a failure");
  assert.equal((await readVerdicts()).length, 2, "both judgments are kept");
});

test("regression: a verdict produced under a different rubric cannot open the gate", async () => {
  const other: Rubric = { ...RUBRIC, goal: "Be fast." };
  await writeVerdict(verdict("step-1", 10, { rubricDigest: rubricDigest(other) }));
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [instance()] });
  await w.check();
  assert.equal(approved.length, 0);
});

test("a legacy verdict without a rubric digest cannot open the gate — it waits for a person", async () => {
  await writeVerdict(verdict("step-1", 10, { rubricDigest: undefined }));
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [instance()] });
  await w.check();
  assert.equal(approved.length, 0);
});

test("regression: a verdict on a previous attempt's run does not open the revised attempt", async () => {
  // Attempt 1 ran as step-1 and was judged; a person revised it, and attempt 2
  // runs as step-9, which nobody has judged yet.
  await writeVerdict(verdict("step-1", 10));
  const revised = instance({
    phases: [
      {
        id: "build",
        name: "Build",
        gated: true,
        status: "awaiting-approval",
        pause: "gate",
        steps: [{ name: "s", runId: "step-9", status: "succeeded" }],
        attempt: 2,
        payload: null,
      },
    ],
  });
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [revised] });
  await w.check();
  assert.equal(approved.length, 0);
});

test("regression: the approval names the auto-approvable phase, not whichever sibling is paused first", async () => {
  // A fan-out with two gates waiting. Only `build` declares autoApprove, and
  // `currentPhaseIndex` points at `review`. The old watcher looked at the
  // current index only, and approved the instance without naming a phase —
  // which the engine resolved to the first paused phase.
  await writeVerdict(verdict("step-1", 9));
  const def = pipeline({
    phases: [
      {
        id: "review",
        name: "Review",
        cwd: "/tmp",
        steps: [{ name: "r", prompt: "p" }],
        gated: true,
      },
      pipeline().phases[0],
    ],
  });
  const inst = instance({
    currentPhaseIndex: 0,
    phases: [
      {
        id: "review",
        name: "Review",
        gated: true,
        status: "awaiting-approval",
        pause: "gate",
        steps: [{ name: "r", runId: "rev-1", status: "succeeded" }],
        attempt: 1,
        payload: null,
      },
      instance().phases[0],
    ],
  });
  const { w, requests } = watcher({ pipelines: [def], instances: [inst] });
  await w.check();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].phaseId, "build");
});

test("regression: a legacy knowledge gate with autoApprove is withheld, reported once per attempt", async () => {
  // Saved before validation refused it: a rule-verification phase that also
  // declares autoApprove. It scores 10/10 and still waits for a person.
  await writeVerdict(verdict("step-1", 10));
  const legacy = pipeline({
    phases: [{ ...pipeline().phases[0], ruleVerification: { kinds: ["business-rule"] } }],
  } as Partial<PipelineDefinition>);
  const { w, approved, withheld } = watcher({ pipelines: [legacy], instances: [instance()] });
  await w.check();
  await w.check();
  assert.equal(approved.length, 0);
  assert.equal(withheld.length, 1, "reported once, not every tick");
  assert.match(withheld[0].reason, /rule-verification/);
});

test("regression: an ordinary phase that staged an optional KnowledgeDelta is withheld too", async () => {
  // Its configuration says nothing about knowledge; the step staged a delta
  // anyway (every step is offered one). Approving would commit it.
  await writeVerdict(verdict("step-1", 10));
  const staged = instance({
    phases: [
      {
        ...instance().phases[0],
        steps: [
          {
            name: "s",
            runId: "step-1",
            status: "succeeded",
            knowledgeDelta: { id: "KD-1", status: "staged" },
          },
        ],
      },
    ],
  } as Partial<PipelineInstance>);
  const { w, approved, withheld } = watcher({ pipelines: [pipeline()], instances: [staged] });
  await w.check();
  assert.equal(approved.length, 0);
  assert.match(withheld[0].reason, /staged-knowledge-delta/);
});

test("a best-of-N gate is judged on the selected candidate only", async () => {
  await writeVerdict(verdict("cand-2", 8));
  const inst = instance({
    phases: [
      {
        id: "build",
        name: "Build",
        gated: true,
        status: "awaiting-approval",
        pause: "gate",
        steps: [
          { name: "s", runId: "cand-1", status: "aborted", candidate: 0 },
          { name: "s", runId: "cand-2", status: "succeeded", candidate: 1 },
        ],
        selectedCandidate: 1,
        attempt: 1,
        payload: null,
      },
    ],
  } as Partial<PipelineInstance>);
  const { w, requests } = watcher({ pipelines: [pipeline()], instances: [inst] });
  await w.check();
  assert.deepEqual(requests[0]?.runIds, ["cand-2"]);
});

test("regression: a needs-input pause is never answered by a score", async () => {
  await writeVerdict(verdict("step-1", 10));
  const asked = instance({
    phases: [{ ...instance().phases[0], pause: "needs-input" }],
  });
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [asked] });
  await w.check();
  assert.equal(approved.length, 0);
});

test("a pause of unknown cause (written before causes were recorded) waits for a person", async () => {
  await writeVerdict(verdict("step-1", 10));
  const { pause: _drop, ...legacyPhase } = instance().phases[0];
  const legacy = instance({ phases: [legacyPhase] });
  const { w, approved } = watcher({ pipelines: [pipeline()], instances: [legacy] });
  await w.check();
  assert.equal(approved.length, 0);
});
