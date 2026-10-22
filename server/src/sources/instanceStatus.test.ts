import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appliesResults,
  hasWaitingGate,
  inFlight,
  isLiveTask,
  isTerminal,
  liveStatus,
  pendingRetry,
  resumable,
} from "./instanceStatus.js";

const phase = (status: string, extra: Record<string, unknown> = {}) =>
  ({ id: status, status, ...extra }) as never;

test("resumable, isTerminal and appliesResults partition the instance statuses", () => {
  for (const s of ["running", "awaiting-approval"]) {
    assert.equal(resumable(s), true, `${s} is resumable`);
    assert.equal(isTerminal(s), false, `${s} is not terminal`);
  }
  for (const s of ["succeeded", "failed", "aborted"]) {
    assert.equal(resumable(s), false, `${s} is not resumable`);
    assert.equal(isTerminal(s), true, `${s} is terminal`);
  }
  assert.equal(appliesResults("running"), true, "results apply while running");
  assert.equal(appliesResults("awaiting-approval"), false, "results wait for a gate decision");
});

test("liveStatus reads a waiting gate from the phases, whatever the status says", () => {
  assert.equal(
    liveStatus({ phases: [phase("running"), phase("awaiting-approval")] }),
    "awaiting-approval",
    "a sibling's gate wins",
  );
  assert.equal(liveStatus({ phases: [phase("running"), phase("failed")] }), "running", "no gate");
});

test("hasWaitingGate asks the phases, and never of an ended instance", () => {
  const phases = [phase("running"), phase("awaiting-approval")];
  assert.equal(hasWaitingGate({ status: "running", phases }), true, "a masked gate is seen");
  assert.equal(
    hasWaitingGate({ status: "aborted", phases }),
    false,
    "an ended instance waits on nobody",
  );
  assert.equal(
    hasWaitingGate({ status: "running", phases: [phase("running")] }),
    false,
    "no gate, no wait",
  );
});

test("pendingRetry is a failed phase with a retry scheduled", () => {
  assert.equal(
    pendingRetry({ phases: [phase("failed", { retryAt: "2026-10-13T12:00:00.000Z" })] }),
    true,
    "a scheduled retry",
  );
  assert.equal(pendingRetry({ phases: [phase("failed", { retryAt: null })] }), false, "no retry");
  assert.equal(
    pendingRetry({ phases: [phase("running", { retryAt: "2026-10-13T12:00:00.000Z" })] }),
    false,
    "only a failed phase is waiting to retry",
  );
});

test("inFlight: something moves without a person", () => {
  const gate = phase("awaiting-approval");
  assert.equal(inFlight({ status: "awaiting-approval", phases: [gate] }), false, "a gate alone");
  assert.equal(
    inFlight({ status: "awaiting-approval", phases: [gate, phase("running")] }),
    true,
    "a sibling runs",
  );
  assert.equal(
    inFlight({
      status: "awaiting-approval",
      phases: [gate, phase("failed", { retryAt: "2026-10-13T12:00:00.000Z" })],
    }),
    true,
    "a retry is due",
  );
  assert.equal(inFlight({ status: "running", phases: [] }), true, "no gate pauses it");
  assert.equal(
    inFlight({
      status: "failed",
      phases: [phase("failed", { retryAt: "2026-10-13T12:00:00.000Z" })],
    }),
    false,
    "an ended instance never moves",
  );
});

test("inFlight: a spawn phase whose children wait on a person is not in flight", () => {
  const spawning = (...states: string[]) => ({
    status: "running" as const,
    phases: [
      phase("succeeded"),
      phase("running", {
        children: { tasks: states.map((state, i) => ({ key: `t${i}`, state })) },
      }),
    ],
  });
  assert.equal(
    inFlight(spawning("awaiting-approval", "pending")),
    false,
    "every live child waits at its own gate",
  );
  assert.equal(inFlight(spawning("running")), true, "a child runs");
  assert.equal(inFlight(spawning("planned")), true, "a start is owed");
  assert.equal(inFlight(spawning("reviving")), true, "a revive is owed");
  assert.equal(
    inFlight(spawning("awaiting-approval", "running")),
    true,
    "one child waits, another runs",
  );
  assert.equal(inFlight(spawning("succeeded", "pending")), true, "a plan is owed");
  assert.equal(
    inFlight({ status: "running", phases: [phase("succeeded"), phase("running")] }),
    true,
    "a running phase without children",
  );
  assert.equal(
    inFlight({
      status: "running",
      phases: [
        phase("running", { children: { tasks: [{ key: "a", state: "awaiting-approval" }] } }),
        phase("running"),
      ],
    }),
    true,
    "a sibling phase runs beside the waiting children",
  );
  assert.equal(
    inFlight({
      status: "running",
      phases: [
        phase("running", { children: { tasks: [{ key: "a", state: "awaiting-approval" }] } }),
        phase("failed", { retryAt: "2026-10-13T12:00:00.000Z" }),
      ],
    }),
    true,
    "a retry is due beside the waiting children",
  );
});

test("isLiveTask: a task that holds one of its phase's slots", () => {
  for (const s of ["planned", "reviving", "running", "awaiting-approval"] as const) {
    assert.equal(isLiveTask(s), true, `${s} is live`);
  }
  for (const s of ["pending", "succeeded", "failed", "aborted", "blocked"] as const) {
    assert.equal(isLiveTask(s), false, `${s} is not live`);
  }
});
