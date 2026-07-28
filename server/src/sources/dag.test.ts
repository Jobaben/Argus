import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DagValidationError,
  currentIndex,
  instanceOutcome,
  interpolate,
  isExplicitDag,
  layers,
  livePhases,
  previousPayloadFor,
  readyPhases,
  resolveNeeds,
  topoOrder,
  validateDag,
} from "./dag.js";
import type {
  PhaseDef,
  PhaseStatus,
  PipelineDefinition,
  PipelineInstance,
} from "./pipelineTypes.js";

const phase = (id: string, needs?: string[]): PhaseDef => ({
  id,
  name: id,
  cwd: "/tmp",
  steps: [{ name: "s", prompt: "p" }],
  gated: false,
  ...(needs === undefined ? {} : { needs }),
});

function def(phases: PhaseDef[]): PipelineDefinition {
  return {
    id: "p1",
    name: "Pipeline",
    phases,
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
}

function instance(phases: PhaseDef[], statuses: Record<string, PhaseStatus>): PipelineInstance {
  return {
    id: "i1",
    pipelineId: "p1",
    pipelineName: "Pipeline",
    status: "running",
    currentPhaseIndex: 0,
    phases: phases.map((p) => ({
      id: p.id,
      name: p.name,
      gated: p.gated,
      status: statuses[p.id] ?? "pending",
      steps: [],
      attempt: 0,
      payload: null,
    })),
    trigger: "manual",
    signalToken: "t",
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
    endedAt: null,
  };
}

// ── The degenerate case ─────────────────────────────────────────────────────

test("regression: a definition with no `needs` is linear — every pre-Weave pipeline still works", () => {
  const phases = [phase("a"), phase("b"), phase("c")];
  assert.equal(isExplicitDag(phases), false);
  assert.deepEqual(
    [...resolveNeeds(phases)],
    [
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
    ],
  );
});

test("regression: one declared `needs` makes the whole graph explicit, not half-implicit", () => {
  // A mixed reading would make the same definition mean two different things
  // depending on which phase you looked at.
  const phases = [phase("a"), phase("b"), phase("c", ["a"])];
  assert.equal(isExplicitDag(phases), true);
  const needs = resolveNeeds(phases);
  assert.deepEqual(needs.get("b"), [], "b does not silently inherit a");
  assert.deepEqual(needs.get("c"), ["a"]);
});

// ── Validation ──────────────────────────────────────────────────────────────

test("a valid graph passes; a cycle names the phases in it", () => {
  validateDag([phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])]);
  assert.throws(() => validateDag([phase("a", ["b"]), phase("b", ["a"])]), /cycle: a, b/);
  assert.throws(() => validateDag([phase("a", ["a"])]), /cannot depend on itself/);
});

test("a dependency that does not exist is named, not silently dropped", () => {
  assert.throws(() => validateDag([phase("a"), phase("b", ["nope"])]), /needs "nope"/);
});

test("duplicate ids and duplicate edges are rejected", () => {
  assert.throws(() => validateDag([phase("a"), phase("a")]), /duplicate phase id/);
  assert.throws(() => validateDag([phase("a"), phase("b", ["a", "a"])]), /twice/);
});

test("a graph where nothing can start is rejected up front", () => {
  // Every phase waiting on another is a pipeline that begins and never begins.
  assert.throws(
    () => validateDag([phase("a", ["b"]), phase("b", ["c"]), phase("c", ["a"])]),
    DagValidationError,
  );
});

test("an empty phase list validates — emptiness is the pipeline validator's business", () => {
  validateDag([]);
});

// ── Shape ───────────────────────────────────────────────────────────────────

test("topoOrder respects dependencies and breaks ties by declaration order", () => {
  const phases = [phase("d", ["b", "c"]), phase("b", ["a"]), phase("c", ["a"]), phase("a")];
  assert.deepEqual(
    topoOrder(phases).map((p) => p.id),
    ["a", "b", "c", "d"],
  );
});

test("layers group the phases that can run at the same time", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])];
  assert.deepEqual(layers(phases), [["a"], ["b", "c"], ["d"]]);
});

test("a linear pipeline is one phase per layer", () => {
  assert.deepEqual(layers([phase("a"), phase("b"), phase("c")]), [["a"], ["b"], ["c"]]);
});

// ── Readiness ───────────────────────────────────────────────────────────────

test("only the roots are ready at the start, and a fan-out starts both branches", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])];
  assert.deepEqual(readyPhases(def(phases), instance(phases, {})), [0]);
  assert.deepEqual(
    readyPhases(def(phases), instance(phases, { a: "succeeded" })),
    [1, 2],
    "both branches of the fan-out",
  );
});

test("regression: a fan-in waits for every dependency, not just the first", () => {
  // This is the case a cursor cannot express, and the reason readiness is
  // computed from statuses instead of an index.
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])];
  const half = instance(phases, { a: "succeeded", b: "succeeded", c: "running" });
  assert.deepEqual(readyPhases(def(phases), half), [], "d must not start on b alone");

  const both = instance(phases, { a: "succeeded", b: "succeeded", c: "succeeded" });
  assert.deepEqual(readyPhases(def(phases), both), [3]);
});

test("a failed dependency never makes its dependents ready", () => {
  const phases = [phase("a"), phase("b", ["a"])];
  assert.deepEqual(readyPhases(def(phases), instance(phases, { a: "failed" })), []);
  assert.deepEqual(readyPhases(def(phases), instance(phases, { a: "aborted" })), []);
});

test("a phase awaiting approval blocks its dependents until it actually succeeds", () => {
  const phases = [phase("a"), phase("b", ["a"])];
  assert.deepEqual(readyPhases(def(phases), instance(phases, { a: "awaiting-approval" })), []);
});

test("livePhases reports what is executing or waiting on a human", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"])];
  const inst = instance(phases, { a: "succeeded", b: "running", c: "awaiting-approval" });
  assert.deepEqual(livePhases(inst), [1, 2]);
});

// ── Outcome ─────────────────────────────────────────────────────────────────

test("an instance is done only when every phase succeeded", () => {
  const phases = [phase("a"), phase("b", ["a"])];
  assert.equal(instanceOutcome(def(phases), instance(phases, { a: "succeeded" })), "running");
  assert.equal(
    instanceOutcome(def(phases), instance(phases, { a: "succeeded", b: "succeeded" })),
    "succeeded",
  );
});

test("regression: a pipeline that skipped half its work reports blocked, not succeeded", () => {
  // Nothing running, nothing ready, phases left: a cursor executor would either
  // hang or claim success. Neither is true.
  const phases = [phase("a"), phase("b", ["a"]), phase("c")];
  const stuck = instance(phases, { a: "failed", c: "succeeded" });
  assert.equal(instanceOutcome(def(phases), stuck), "blocked");
});

test("currentPhaseIndex prefers the gate a human has to act on", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"])];
  assert.equal(
    currentIndex(instance(phases, { a: "succeeded", b: "running", c: "awaiting-approval" })),
    2,
  );
  assert.equal(currentIndex(instance(phases, { a: "succeeded", b: "running" })), 1);
  assert.equal(currentIndex(instance(phases, { a: "failed" })), 0);
  assert.equal(
    currentIndex(instance(phases, { a: "succeeded", b: "succeeded", c: "succeeded" })),
    2,
  );
  assert.equal(currentIndex(instance(phases, {})), 0);
});

// ── Artifacts ───────────────────────────────────────────────────────────────

test("the pre-Weave template still works, and artifacts interpolate by name", () => {
  assert.equal(interpolate("say {{previous.payload}}", "hello"), "say hello");
  assert.equal(
    interpolate("use {{artifacts.plan}} and {{artifacts.review}}", null, {
      plan: "the plan",
      review: { ok: true },
    }),
    'use the plan and {"ok":true}',
  );
});

test("regression: an unknown artifact becomes empty, never a literal template marker", () => {
  // A `{{artifacts.foo}}` reaching the model is worse than a gap: the model
  // tries to make sense of it.
  assert.equal(interpolate("x {{artifacts.missing}} y", null, {}), "x  y");
  assert.equal(interpolate("x {{previous.payload}} y", null), "x  y");
});

test("previousPayloadFor picks a phase's dependency, and is stable with several", () => {
  const phases = [phase("a"), phase("b", ["a"]), phase("c", ["a"]), phase("d", ["b", "c"])];
  const inst = instance(phases, {});
  inst.phases[0].payload = "from a";
  inst.phases[1].payload = "from b";
  inst.phases[2].payload = "from c";

  assert.equal(previousPayloadFor(def(phases), inst, "b"), "from a");
  // With two dependencies there is no single "previous"; the last in
  // declaration order is the only stable answer, which is why such phases
  // should name artifacts instead.
  assert.equal(previousPayloadFor(def(phases), inst, "d"), "from c");
  assert.equal(previousPayloadFor(def(phases), inst, "a"), null, "a root has no previous");
});
