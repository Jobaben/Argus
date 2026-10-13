import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appliesResults,
  hasWaitingGate,
  inFlight,
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
