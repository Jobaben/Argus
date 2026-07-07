import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOverview } from "./overview.js";
import type { PipelineDefinition, PipelineInstance, InstanceStatus } from "./pipelineTypes.js";
import type { Run } from "./scheduleTypes.js";

function def(id: string, name = id): PipelineDefinition {
  return {
    id,
    name,
    phases: [{ id: "p1", name: "P1", cwd: "/", gated: false, steps: [{ name: "s", prompt: "x" }] }],
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function inst(
  id: string,
  pipelineId: string,
  status: InstanceStatus,
  createdAt: string,
  updatedAt = createdAt,
): PipelineInstance {
  return {
    id,
    pipelineId,
    pipelineName: pipelineId,
    status,
    currentPhaseIndex: 0,
    phases: [
      {
        id: "p1",
        name: "P1",
        gated: false,
        status: "running",
        steps: [],
        attempt: 1,
        payload: null,
      },
    ],
    trigger: "manual",
    signalToken: "tok",
    createdAt,
    updatedAt,
    endedAt: null,
  };
}

test("pairs each definition with its latest (newest-first) instance", () => {
  const defs = [def("a")];
  const instances = [
    inst("i2", "a", "running", "2026-06-30T10:00:00.000Z"),
    inst("i1", "a", "succeeded", "2026-06-29T10:00:00.000Z"),
  ];
  const out = buildOverview(defs, instances);
  assert.equal(out.length, 1);
  assert.equal(out[0].latest?.id, "i2");
});

test("a definition with no instances gets latest=null and sorts last", () => {
  const defs = [def("a"), def("b")];
  const instances = [inst("i1", "a", "running", "2026-06-30T10:00:00.000Z")];
  const out = buildOverview(defs, instances);
  assert.equal(out[0].definition.id, "a");
  assert.equal(out[1].definition.id, "b");
  assert.equal(out[1].latest, null);
});

test("sorts attention-first: awaiting-approval before running before succeeded", () => {
  const defs = [def("run"), def("await"), def("done")];
  const instances = [
    inst("i-run", "run", "running", "2026-06-30T12:00:00.000Z"),
    inst("i-await", "await", "awaiting-approval", "2026-06-30T09:00:00.000Z"),
    inst("i-done", "done", "succeeded", "2026-06-30T13:00:00.000Z"),
  ];
  const out = buildOverview(defs, instances);
  assert.deepEqual(
    out.map((e) => e.definition.id),
    ["await", "run", "done"],
  );
});

test("ranks a failed instance after awaiting but before running and succeeded", () => {
  const defs = [def("run"), def("fail"), def("await"), def("done")];
  const instances = [
    inst("i-run", "run", "running", "2026-06-30T12:00:00.000Z"),
    inst("i-fail", "fail", "failed", "2026-06-30T08:00:00.000Z"),
    inst("i-await", "await", "awaiting-approval", "2026-06-30T09:00:00.000Z"),
    inst("i-done", "done", "succeeded", "2026-06-30T13:00:00.000Z"),
  ];
  const out = buildOverview(defs, instances);
  assert.deepEqual(
    out.map((e) => e.definition.id),
    ["await", "fail", "run", "done"],
  );
});

function run(id: string, instanceId: string, costUsd: number | null, tokens: number | null): Run {
  return {
    id,
    scheduleId: "pipeline:a",
    scheduleName: "a · P1",
    prompt: "x",
    cwd: "/",
    status: "succeeded",
    trigger: "scheduled",
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
    instanceId,
    phaseId: "p1",
    costUsd,
    tokens,
  };
}

test("joins run cost/tokens onto steps and totals the instance spend", () => {
  const i = inst("i1", "a", "running", "2026-06-30T10:00:00.000Z");
  i.phases[0].steps = [
    { name: "s1", runId: "r1", status: "succeeded" },
    { name: "s2", runId: "r2", status: "running" },
  ];
  const runs = [run("r1", "i1", 0.25, 1000), run("r2", "i1", null, null)];
  const out = buildOverview([def("a")], [i], runs);
  const steps = out[0].latest!.phases[0].steps;
  assert.equal(steps[0].costUsd, 0.25);
  assert.equal(steps[0].tokens, 1000);
  assert.equal(steps[1].costUsd, null);
  assert.equal(steps[1].tokens, null);
  assert.deepEqual(out[0].cost, { usd: 0.25, tokens: 1000 });
});

test("instance total includes runs from superseded revise attempts", () => {
  const i = inst("i1", "a", "running", "2026-06-30T10:00:00.000Z");
  i.phases[0].steps = [{ name: "s1", runId: "r2", status: "running" }];
  // r1 was the pre-revise attempt: no longer referenced by any step, still spent.
  const runs = [run("r1", "i1", 0.25, 400), run("r2", "i1", 0.5, 600), run("rx", "other", 9, 9)];
  const out = buildOverview([def("a")], [i], runs);
  assert.deepEqual(out[0].cost, { usd: 0.75, tokens: 1000 });
});

test("cost is null-per-metric when no run reported it, and null with no instance", () => {
  const i = inst("i1", "a", "running", "2026-06-30T10:00:00.000Z");
  i.phases[0].steps = [{ name: "s1", runId: "r1", status: "running" }];
  const out = buildOverview([def("a"), def("b")], [i], [run("r1", "i1", null, 500)]);
  assert.deepEqual(out[0].cost, { usd: null, tokens: 500 });
  assert.equal(out[1].cost, null);
});

test("joins current activity and timing onto running steps", () => {
  const d = def("a");
  const i = inst("i1", "a", "running", "2026-06-30T10:00:00.000Z");
  i.phases[0].steps = [{ name: "s", runId: "r1", status: "running" }];
  const run = {
    id: "r1",
    scheduleId: "pipeline:a",
    scheduleName: "a · P1",
    prompt: "x",
    cwd: "/",
    status: "running",
    trigger: "scheduled",
    queuedAt: "2026-06-30T10:00:00.000Z",
    startedAt: "2026-06-30T10:00:00.000Z",
    endedAt: null,
    durationMs: null,
    pid: 1,
    exitCode: null,
    sessionId: "s",
    project: null,
    resultSummary: null,
    error: null,
    instanceId: "i1",
    phaseId: "p1",
  } as Run;
  const activity = new Map([
    ["r1", { at: "2026-06-30T10:05:00.000Z", kind: "tool" as const, label: "Bash: npm test" }],
  ]);
  const out = buildOverview([d], [i], [run], activity);
  const step = out[0].latest!.phases[0].steps[0];
  assert.equal(step.currentActivity, "Bash: npm test");
  assert.equal(step.activityAt, "2026-06-30T10:05:00.000Z");
  assert.equal(step.startedAt, "2026-06-30T10:00:00.000Z");
});

test("finished steps get durationMs but no activity", () => {
  const d = def("a");
  const i = inst("i1", "a", "running", "2026-06-30T10:00:00.000Z");
  i.phases[0].steps = [{ name: "s", runId: "r1", status: "succeeded" }];
  const run = {
    id: "r1", scheduleId: "pipeline:a", scheduleName: "a · P1", prompt: "x", cwd: "/",
    status: "succeeded", trigger: "scheduled", queuedAt: "2026-06-30T10:00:00.000Z",
    startedAt: "2026-06-30T10:00:00.000Z", endedAt: "2026-06-30T10:02:08.000Z",
    durationMs: 128000, pid: 1, exitCode: 0, sessionId: "s", project: null,
    resultSummary: null, error: null, instanceId: "i1", phaseId: "p1",
  } as Run;
  const activity = new Map([
    ["r1", { at: "2026-06-30T10:01:00.000Z", kind: "done" as const, label: "finished" }],
  ]);
  const out = buildOverview([d], [i], [run], activity);
  const step = out[0].latest!.phases[0].steps[0];
  assert.equal(step.durationMs, 128000);
  assert.equal(step.currentActivity, undefined);
});

test("active lists every running/awaiting instance newest-first, with per-instance cost", () => {
  const i2 = inst("i2", "a", "running", "2026-06-30T11:00:00.000Z");
  i2.phases[0].steps = [{ name: "s1", runId: "r2", status: "running" }];
  const i1 = inst("i1", "a", "awaiting-approval", "2026-06-30T10:00:00.000Z");
  i1.phases[0].steps = [{ name: "s1", runId: "r1", status: "succeeded" }];
  const i0 = inst("i0", "a", "aborted", "2026-06-30T09:00:00.000Z");
  const runs = [run("r1", "i1", 0.25, 1000), run("r2", "i2", 0.5, 2000)];
  const out = buildOverview([def("a")], [i2, i1, i0], runs);
  assert.deepEqual(
    out[0].active.map((a) => a.instance.id),
    ["i2", "i1"],
  );
  assert.deepEqual(out[0].active[0].cost, { usd: 0.5, tokens: 2000 });
  assert.deepEqual(out[0].active[1].cost, { usd: 0.25, tokens: 1000 });
  // steps are enriched like latest
  assert.equal(out[0].active[0].instance.phases[0].steps[0].costUsd, 0.5);
});

test("active is empty when the only instance is terminal", () => {
  const out = buildOverview([def("a")], [inst("i1", "a", "aborted", "2026-06-30T10:00:00.000Z")]);
  assert.deepEqual(out[0].active, []);
  assert.equal(out[0].latest?.id, "i1");
});

test("breaks ties by updatedAt desc then definition name", () => {
  const defs = [def("zeta"), def("alpha")];
  const instances = [
    inst("i-z", "zeta", "running", "2026-06-30T10:00:00.000Z"),
    inst("i-a", "alpha", "running", "2026-06-30T10:00:00.000Z"),
  ];
  const out = buildOverview(defs, instances);
  assert.deepEqual(
    out.map((e) => e.definition.id),
    ["alpha", "zeta"],
  );
});
