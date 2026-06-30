import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOverview } from "./overview.js";
import type { PipelineDefinition, PipelineInstance, InstanceStatus } from "./pipelineTypes.js";

function def(id: string, name = id): PipelineDefinition {
  return {
    id, name,
    phases: [{ id: "p1", name: "P1", cwd: "/", gated: false, steps: [{ name: "s", prompt: "x" }] }],
    trigger: null, enabled: true, overlapPolicy: "skip",
    lastStartedAt: null, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function inst(id: string, pipelineId: string, status: InstanceStatus, createdAt: string, updatedAt = createdAt): PipelineInstance {
  return {
    id, pipelineId, pipelineName: pipelineId, status,
    currentPhaseIndex: 0,
    phases: [{ id: "p1", name: "P1", gated: false, status: "running", steps: [], attempt: 1, payload: null }],
    trigger: "manual", signalToken: "tok", createdAt, updatedAt, endedAt: null,
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
  assert.deepEqual(out.map((e) => e.definition.id), ["await", "run", "done"]);
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
  assert.deepEqual(out.map((e) => e.definition.id), ["await", "fail", "run", "done"]);
});

test("breaks ties by updatedAt desc then definition name", () => {
  const defs = [def("zeta"), def("alpha")];
  const instances = [
    inst("i-z", "zeta", "running", "2026-06-30T10:00:00.000Z"),
    inst("i-a", "alpha", "running", "2026-06-30T10:00:00.000Z"),
  ];
  const out = buildOverview(defs, instances);
  assert.deepEqual(out.map((e) => e.definition.id), ["alpha", "zeta"]);
});
