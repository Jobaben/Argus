import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveReliability, withStepMetrics } from "./reliability.js";
import type { PhaseProgress, PipelineInstance, StepProgress } from "./pipelineTypes.js";
import type { Run } from "./scheduleTypes.js";

const NOW = new Date("2026-09-19T12:00:00.000Z");

let seq = 0;

function step(over: Partial<StepProgress> = {}): StepProgress {
  seq += 1;
  return { name: `s${seq}`, runId: null, status: "succeeded", ...over };
}

function phase(over: Partial<PhaseProgress> = {}): PhaseProgress {
  return {
    id: "build",
    name: "Build",
    gated: false,
    status: "succeeded",
    steps: [step()],
    attempt: 1,
    payload: null,
    ...over,
  };
}

/** An instance settled `daysAgo` days before `NOW`, with the given phases. */
function instance(over: Partial<PipelineInstance> & { daysAgo?: number } = {}): PipelineInstance {
  seq += 1;
  const { daysAgo = 0, ...rest } = over;
  const at = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
  return {
    id: `i${seq}`,
    pipelineId: "p1",
    pipelineName: "Pipeline",
    status: "succeeded",
    currentPhaseIndex: 0,
    phases: [phase()],
    trigger: "manual",
    signalToken: "t",
    createdAt: at,
    updatedAt: at,
    endedAt: at,
    ...rest,
  };
}

test("empty window: rates are null, not NaN", () => {
  const r = deriveReliability("p1", [], NOW, 30);
  assert.equal(r.instances, 0);
  assert.equal(r.succeeded, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.aborted, 0);
  assert.equal(r.firstAttemptSuccessRate, null);
  assert.equal(r.luckyPassRate, null);
  assert.deepEqual(r.phases, []);
  assert.equal(r.trend.length, 30);
  assert.ok(r.trend.every((d) => d.succeeded === 0 && d.failed === 0));
});

test("all first-attempt passes: 100% clean, no lucky passes", () => {
  const instances = [instance({ daysAgo: 1 }), instance({ daysAgo: 2 }), instance({ daysAgo: 3 })];
  const r = deriveReliability("p1", instances, NOW, 30);
  assert.equal(r.instances, 3);
  assert.equal(r.succeeded, 3);
  assert.equal(r.firstAttemptSuccessRate, 1);
  assert.equal(r.luckyPassRate, 0);
  assert.equal(r.phases.length, 1);
  const build = r.phases[0];
  assert.equal(build.instances, 3);
  assert.equal(build.firstAttemptPass, 3);
  assert.equal(build.luckyPass, 0);
  assert.equal(build.failed, 0);
  assert.equal(build.meanAttempts, 1);
});

test("lucky passes: succeeded only after a retry or revise (attempt > 1)", () => {
  const instances = [
    instance({ daysAgo: 1, phases: [phase({ attempt: 2, retries: 1 })] }),
    instance({ daysAgo: 2, phases: [phase({ attempt: 3 })] }), // revised twice, no auto-retry
    instance({ daysAgo: 3 }), // clean
  ];
  const r = deriveReliability("p1", instances, NOW, 30);
  assert.equal(r.succeeded, 3);
  assert.equal(r.firstAttemptSuccessRate, 1 / 3);
  assert.equal(r.luckyPassRate, 2 / 3);
  const build = r.phases[0];
  assert.equal(build.firstAttemptPass, 1);
  assert.equal(build.luckyPass, 2);
  assert.equal(build.meanAttempts, (2 + 3 + 1) / 3);
});

test("verification failures are classed and rated", () => {
  const instances = [
    instance({
      daysAgo: 1,
      status: "failed",
      endedAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
      phases: [
        phase({
          status: "failed",
          attempt: 1,
          payload: { reason: "checks failed", failureClass: "verification" },
        }),
      ],
    }),
    instance({ daysAgo: 2 }), // one clean pass
  ];
  const r = deriveReliability("p1", instances, NOW, 30);
  assert.equal(r.failed, 1);
  assert.equal(r.succeeded, 1);
  const build = r.phases[0];
  assert.equal(build.failed, 1);
  assert.deepEqual(build.failureClasses, { verification: 1 });
  assert.equal(build.verificationFailRate, 1 / 2);
  assert.equal(build.stalls, 0);
});

test("timeout failures count as stalls", () => {
  const instances = [
    instance({
      daysAgo: 1,
      status: "failed",
      endedAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
      phases: [
        phase({
          status: "failed",
          payload: { reason: "no output for 300s", failureClass: "timeout" },
        }),
      ],
    }),
  ];
  const r = deriveReliability("p1", instances, NOW, 30);
  const build = r.phases[0];
  assert.equal(build.stalls, 1);
  assert.deepEqual(build.failureClasses, { timeout: 1 });
  assert.equal(build.verificationFailRate, 0);
});

test("aborted instances are counted but excluded from pass/fail rates", () => {
  const instances = [
    instance({
      daysAgo: 1,
      status: "aborted",
      endedAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
      phases: [phase({ status: "aborted" })],
    }),
    instance({ daysAgo: 2 }), // one clean pass
  ];
  const r = deriveReliability("p1", instances, NOW, 30);
  assert.equal(r.instances, 2);
  assert.equal(r.aborted, 1);
  assert.equal(r.succeeded, 1);
  // firstAttemptSuccessRate is over all settled instances, so the aborted one
  // still counts in the denominator without being a "pass".
  assert.equal(r.firstAttemptSuccessRate, 1 / 2);
  const build = r.phases[0];
  // The aborted phase ran (counts toward `instances`/meanAttempts) but is
  // neither a pass nor a classified failure.
  assert.equal(build.instances, 2);
  assert.equal(build.firstAttemptPass, 1);
  assert.equal(build.luckyPass, 0);
  assert.equal(build.failed, 0);
});

test("a phase never reached in an instance (pending/skipped) does not count for that phase", () => {
  const instances = [
    instance({
      daysAgo: 1,
      phases: [
        phase({ id: "build", status: "succeeded" }),
        phase({ id: "deploy", status: "skipped", steps: [] }),
      ],
    }),
    instance({
      daysAgo: 2,
      phases: [
        phase({ id: "build", status: "succeeded" }),
        phase({ id: "deploy", status: "succeeded", steps: [step()] }),
      ],
    }),
  ];
  const r = deriveReliability("p1", instances, NOW, 30);
  const deploy = r.phases.find((p) => p.phaseId === "deploy");
  assert.ok(deploy);
  assert.equal(deploy!.instances, 1, "the skipped run does not count");
  assert.equal(deploy!.firstAttemptPass, 1);
});

test("windowDays excludes instances that settled outside the window", () => {
  const instances = [instance({ daysAgo: 5 }), instance({ daysAgo: 40 })];
  const r = deriveReliability("p1", instances, NOW, 30);
  assert.equal(r.instances, 1);
});

test("instances of another pipeline are ignored", () => {
  const instances = [instance({ pipelineId: "other" }), instance()];
  const r = deriveReliability("p1", instances, NOW, 30);
  assert.equal(r.instances, 1);
});

test("a still-running instance is not settled and is excluded", () => {
  const instances = [instance({ status: "running", endedAt: null })];
  const r = deriveReliability("p1", instances, NOW, 30);
  assert.equal(r.instances, 0);
});

test("trend buckets settled instances by the UTC day they ended", () => {
  const instances = [
    instance({ daysAgo: 0 }),
    instance({ daysAgo: 0, status: "failed", endedAt: NOW.toISOString() }),
    instance({ daysAgo: 2 }),
  ];
  const r = deriveReliability("p1", instances, NOW, 7);
  assert.equal(r.trend.length, 7);
  const today = r.trend[r.trend.length - 1];
  assert.equal(today.day, "2026-09-19");
  assert.equal(today.succeeded, 1);
  assert.equal(today.failed, 1);
  const twoDaysAgo = r.trend[r.trend.length - 3];
  assert.equal(twoDaysAgo.succeeded, 1);
});

test("mean cost and duration are null when no step reported them", () => {
  const r = deriveReliability("p1", [instance()], NOW, 30);
  assert.equal(r.phases[0].meanDurationMs, null);
  assert.equal(r.phases[0].meanCostUsd, null);
});

test("mean cost and duration sum a phase's steps, averaged over instances that reported any", () => {
  const instances = [
    instance({
      daysAgo: 1,
      phases: [
        phase({
          steps: [
            step({ costUsd: 0.1, durationMs: 1000 }),
            step({ costUsd: 0.2, durationMs: 2000 }),
          ],
        }),
      ],
    }),
    instance({
      daysAgo: 2,
      phases: [phase({ steps: [step({ costUsd: 0.3, durationMs: 3000 })] })],
    }),
    instance({ daysAgo: 3 }), // no cost/duration reported at all
  ];
  const r = deriveReliability("p1", instances, NOW, 30);
  const build = r.phases[0];
  assert.ok(Math.abs((build.meanCostUsd ?? NaN) - 0.3) < 1e-9);
  assert.equal(build.meanDurationMs, 3000);
});

// ── withStepMetrics ──────────────────────────────────────────────────────────

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    scheduleId: "s1",
    scheduleName: "",
    prompt: "p",
    cwd: "/tmp",
    status: "succeeded",
    trigger: "manual",
    queuedAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    endedAt: NOW.toISOString(),
    durationMs: 5000,
    pid: 1,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
    costUsd: 0.42,
    tokens: 1000,
    ...over,
  };
}

test("withStepMetrics joins a step's cost/duration in from its run", () => {
  const inst = instance({ phases: [phase({ steps: [step({ runId: "r1" })] })] });
  const [joined] = withStepMetrics([inst], [run()]);
  assert.equal(joined.phases[0].steps[0].costUsd, 0.42);
  assert.equal(joined.phases[0].steps[0].durationMs, 5000);
});

test("withStepMetrics leaves an already-enriched step alone", () => {
  const inst = instance({
    phases: [phase({ steps: [step({ runId: "r1", costUsd: 1, durationMs: 1 })] })],
  });
  const [joined] = withStepMetrics([inst], [run({ costUsd: 99, durationMs: 99 })]);
  assert.equal(joined.phases[0].steps[0].costUsd, 1);
  assert.equal(joined.phases[0].steps[0].durationMs, 1);
});

test("withStepMetrics leaves a step with no matching run untouched", () => {
  const inst = instance({ phases: [phase({ steps: [step({ runId: "unknown" })] })] });
  const [joined] = withStepMetrics([inst], [run()]);
  assert.equal(joined.phases[0].steps[0].costUsd, undefined);
});
