import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initInstance, advance, applyApprove, applyRevise, applyAbort, applyTemplate,
} from "./pipelineTransitions.js";
import type { PipelineDefinition, PipelineInstance, PipelineSignal } from "./sources/pipelineTypes.js";

const NOW = "2026-06-30T12:00:00.000Z";

function def(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "p1", name: "feature", trigger: null, enabled: true, overlapPolicy: "skip",
    lastStartedAt: null, createdAt: NOW, updatedAt: NOW,
    phases: [
      { id: "brainstorm", name: "Brainstorm", cwd: "/tmp", gated: true, steps: [{ name: "bs", prompt: "go" }] },
      { id: "plan", name: "Plan", cwd: "/tmp", gated: false, steps: [{ name: "wp", prompt: "plan {{previous.payload}}" }] },
    ],
    ...over,
  };
}

function started(d: PipelineDefinition): PipelineInstance {
  const { instance } = initInstance(d, "manual", { instanceId: "i1", token: "tok" }, NOW);
  // simulate the orchestrator having spawned phase 0's step:
  instance.phases[0].steps[0].runId = "run-0";
  instance.phases[0].steps[0].status = "running";
  return instance;
}

const sig = (over: Partial<PipelineSignal>): PipelineSignal => ({
  instanceId: "i1", phaseId: "brainstorm", runId: "run-0", type: "completed", token: "tok", ...over,
});

test("applyTemplate substitutes previous payload", () => {
  assert.equal(applyTemplate("plan {{previous.payload}}", "ANSWERS"), "plan ANSWERS");
  assert.equal(applyTemplate("plan {{previous.payload}}", null), "plan ");
  assert.equal(applyTemplate("plan {{previous.payload}}", { a: 1 }), 'plan {"a":1}');
});

test("initInstance starts phase 0 running and asks to spawn index 0", () => {
  const r = initInstance(def(), "manual", { instanceId: "i1", token: "tok" }, NOW);
  assert.equal(r.startPhase, 0);
  assert.equal(r.instance.status, "running");
  assert.equal(r.instance.phases[0].status, "running");
  assert.equal(r.instance.phases[1].status, "pending");
});

test("needs-input pauses for approval, no spawn", () => {
  const inst = started(def());
  const r = advance(def(), inst, sig({ type: "needs-input", payload: "QUESTIONS" }), NOW);
  assert.equal(r.startPhase, null);
  assert.equal(r.instance.status, "awaiting-approval");
  assert.equal(r.instance.phases[0].payload, "QUESTIONS");
});

test("completed on a gated phase pauses for approval", () => {
  const inst = started(def());
  const r = advance(def(), inst, sig({ type: "completed" }), NOW);
  assert.equal(r.startPhase, null);
  assert.equal(r.instance.status, "awaiting-approval");
});

test("completed on a non-gated phase advances and asks to spawn the next phase", () => {
  const d = def();
  d.phases[0].gated = false;
  const inst = started(d);
  const r = advance(d, inst, sig({ type: "completed", payload: "OUT" }), NOW);
  assert.equal(r.startPhase, 1);
  assert.equal(r.instance.currentPhaseIndex, 1);
  assert.equal(r.instance.phases[0].status, "succeeded");
  assert.equal(r.instance.phases[1].status, "running");
});

test("completed on the last non-gated phase succeeds the instance", () => {
  const d = def({ phases: [{ id: "only", name: "Only", cwd: "/tmp", gated: false, steps: [{ name: "s", prompt: "p" }] }] });
  const inst = started(d);
  const r = advance(d, { ...inst, phases: [{ ...inst.phases[0], id: "only", steps: [{ name: "s", runId: "run-0", status: "running" }] }] }, sig({ phaseId: "only" }), NOW);
  assert.equal(r.startPhase, null);
  assert.equal(r.instance.status, "succeeded");
  assert.equal(r.instance.endedAt, NOW);
});

test("failed signal pauses the instance as failed", () => {
  const inst = started(def());
  const r = advance(def(), inst, sig({ type: "failed", payload: "boom" }), NOW);
  assert.equal(r.instance.status, "failed");
  assert.equal(r.instance.phases[0].status, "failed");
});

test("failed signal sets the instance end time", () => {
  const inst = started(def());
  const r = advance(def(), inst, sig({ type: "failed", payload: "boom" }), NOW);
  assert.equal(r.instance.endedAt, NOW);
});

test("a signal from an untracked run is ignored (dedup of concurrent runs)", () => {
  // A stale/duplicate concurrent run signals with a runId that no longer
  // matches the tracked step; it must not terminalize or advance the instance.
  const inst = started(def());
  const r = advance(def(), inst, sig({ type: "failed", payload: "boom", runId: "some-other-run" }), NOW);
  assert.equal(r.startPhase, null);
  assert.equal(r.instance.status, "running");
  assert.equal(r.instance.phases[0].status, "running");
  assert.equal(r.instance.phases[0].steps[0].status, "running");
});

test("a failed phase terminalizes running sibling steps", () => {
  const d = def({
    phases: [{ id: "brainstorm", name: "Brainstorm", cwd: "/tmp", gated: false, steps: [
      { name: "a", prompt: "p" }, { name: "b", prompt: "p" },
    ] }, { id: "plan", name: "Plan", cwd: "/tmp", gated: false, steps: [{ name: "wp", prompt: "p" }] }],
  });
  const inst = started(d);
  inst.phases[0].steps = [
    { name: "a", runId: "run-a", status: "running" },
    { name: "b", runId: "run-b", status: "running" },
  ];
  const r = advance(d, inst, sig({ type: "failed", runId: "run-a" }), NOW);
  assert.equal(r.instance.phases[0].status, "failed");
  assert.equal(r.instance.phases[0].steps[0].status, "failed"); // the signalled step
  assert.equal(r.instance.phases[0].steps[1].status, "failed"); // the abandoned sibling
});

test("a stale signal for a non-current phase is a no-op (idempotent)", () => {
  const d = def();
  d.phases[0].gated = false;
  const inst = started(d);
  advance(d, inst, sig({ type: "completed" }), NOW); // now on phase 1
  const r = advance(d, inst, sig({ type: "completed" }), NOW); // re-send phase 0 signal
  assert.equal(r.startPhase, null);
  assert.equal(r.instance.currentPhaseIndex, 1);
});

test("applyApprove advances past a gate, forwarding answers as payload", () => {
  const inst = started(def());
  advance(def(), inst, sig({ type: "needs-input", payload: "Q" }), NOW); // awaiting-approval
  const r = applyApprove(def(), inst, "MY ANSWERS", NOW);
  assert.equal(r.startPhase, 1);
  assert.equal(r.instance.phases[0].payload, "MY ANSWERS");
  assert.equal(r.instance.status, "running");
});

test("applyApprove throws when not awaiting approval", () => {
  const inst = started(def());
  assert.throws(() => applyApprove(def(), inst, undefined, NOW), /not awaiting approval/);
});

test("applyRevise re-runs the current phase with a bumped attempt", () => {
  const inst = started(def());
  advance(def(), inst, sig({ type: "failed" }), NOW); // failed
  const r = applyRevise(inst, NOW);
  assert.equal(r.startPhase, 0);
  assert.equal(r.instance.phases[0].attempt, 1);
  assert.equal(r.instance.phases[0].status, "running");
  assert.equal(r.instance.phases[0].steps[0].runId, null);
  assert.equal(r.instance.status, "running");
});

test("applyAbort marks the instance aborted", () => {
  const inst = started(def());
  const out = applyAbort(inst, NOW);
  assert.equal(out.status, "aborted");
  assert.equal(out.endedAt, NOW);
});

test("applyAbort throws when the instance is already terminal", () => {
  const inst = started(def());
  inst.status = "succeeded";
  assert.throws(() => applyAbort(inst, NOW), /already terminal/);
});
