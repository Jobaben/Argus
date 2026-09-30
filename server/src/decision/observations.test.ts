import { test } from "node:test";
import assert from "node:assert/strict";
import type { GateDecision } from "@argus/contracts";
import { canonicalDigest } from "./canonical.js";
import {
  observeTermination,
  operatorActionObservations,
  terminationObservations,
} from "./observations.js";
import { failedRun } from "./testSupport.js";

test("observed termination is derived from the run record, and only where the record states it", () => {
  const cases: Array<[Parameters<typeof failedRun>[0], string | null]> = [
    [{ termination: "timed-out" }, "deadline"],
    [{ termination: "stalled" }, "deadline"],
    [{ termination: "spawn-failed", startedAt: null }, "never-ran"],
    [{ termination: "exited" }, "ended-normally"],
    [{}, "ended-normally"],
    [{ status: "succeeded", exitCode: 0 }, "ended-normally"],
    // Interrupted by a restart: it ran, so it is not "never-ran" (§O.1).
    [{ status: "interrupted" }, null],
    [{ termination: "killed", status: "cancelled" }, null],
    [{ status: "cancelled" }, null],
    [{ status: "running", endedAt: null }, null],
    [{ startedAt: null }, null],
  ];
  for (const [over, want] of cases) {
    const got = observeTermination(failedRun(over));
    assert.equal(got.ok ? got.value : null, want, JSON.stringify(over));
    if (!got.ok) assert.ok(got.reason.length > 0);
  }
});

test("termination observations cite their source record by id and digest", () => {
  const run = failedRun({ termination: "timed-out" });
  const [o, ...rest] = terminationObservations([
    run,
    failedRun({ id: "run-2", status: "interrupted" }),
  ]);
  assert.equal(rest.length, 0);
  assert.deepEqual(o, {
    kind: "observed-termination",
    subject: { kind: "run", runId: "run-1" },
    value: "deadline",
    source: { store: "runs", recordId: "run-1", recordDigest: canonicalDigest(run).sha256 },
    observedAt: run.endedAt,
  });
});

function decision(over: Partial<GateDecision>): GateDecision {
  return {
    id: "GD-1",
    instanceId: "inst-1",
    pipelineId: "p",
    decision: "revise",
    mechanism: "operator",
    channel: "http",
    principal: { kind: "session", username: "ana", role: "admin" },
    phases: [
      { phaseId: "plan", attempt: 1, status: "awaiting-approval", runIds: ["r1"] },
      { phaseId: "build", attempt: 0, status: "awaiting-approval", runIds: ["r2"] },
    ],
    recordedAt: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

test("operator actions come only from operator-mechanism gate decisions, one per phase, principal as recorded", () => {
  const human = decision({});
  const auto = decision({
    id: "GD-2",
    decision: "approve",
    mechanism: "verdict-auto-approve",
    principal: { kind: "system", component: "verdict-watcher" },
  });
  const unspecified = decision({
    id: "GD-3",
    mechanism: "unspecified",
    principal: { kind: "unknown" },
  });
  const obs = operatorActionObservations([human, auto, unspecified]);
  assert.equal(obs.length, 2);
  assert.ok(obs.every((o) => o.kind === "operator-action" && o.source.recordId === "GD-1"));
  assert.deepEqual(
    obs.map((o) => o.subject),
    [
      { kind: "phase-attempt", instanceId: "inst-1", phaseId: "plan", attempt: 1 },
      { kind: "phase-attempt", instanceId: "inst-1", phaseId: "build", attempt: 0 },
    ],
  );
  const first = obs[0] as Extract<(typeof obs)[number], { kind: "operator-action" }>;
  assert.equal(first.value, "revise");
  assert.deepEqual(first.principal, human.principal);
  assert.equal(first.source.recordDigest, canonicalDigest(human).sha256);
  // A later outcome or review finding is never synthesised from an operator action.
  assert.ok(obs.every((o) => o.kind === "operator-action"));
});
