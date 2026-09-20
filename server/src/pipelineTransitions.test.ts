import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initInstance,
  advance,
  applyApprove,
  applyCandidateSelection,
  applyCandidateVerification,
  applyCandidatesExhausted,
  applyRevise,
  applyAbort,
  applyTemplate,
  applyUnlaunchable,
  candidateFailureClass,
  candidateFailureReason,
  candidateRecordOf,
  candidateState,
  selectCandidate,
  toCandidateOutcomes,
} from "./pipelineTransitions.js";
import type { CandidateRecord } from "./pipelineTransitions.js";
import type {
  CandidatePolicy,
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
  VerificationReport,
} from "./sources/pipelineTypes.js";

const NOW = "2026-06-30T12:00:00.000Z";

function def(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "p1",
    name: "feature",
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    phases: [
      {
        id: "brainstorm",
        name: "Brainstorm",
        cwd: "/tmp",
        gated: true,
        steps: [{ name: "bs", prompt: "go" }],
      },
      {
        id: "plan",
        name: "Plan",
        cwd: "/tmp",
        gated: false,
        steps: [{ name: "wp", prompt: "plan {{previous.payload}}" }],
      },
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
  instanceId: "i1",
  phaseId: "brainstorm",
  runId: "run-0",
  type: "completed",
  token: "tok",
  ...over,
});

test("applyTemplate substitutes previous payload", () => {
  assert.equal(applyTemplate("plan {{previous.payload}}", "ANSWERS"), "plan ANSWERS");
  assert.equal(applyTemplate("plan {{previous.payload}}", null), "plan ");
  assert.equal(applyTemplate("plan {{previous.payload}}", { a: 1 }), 'plan {"a":1}');
});

test("initInstance starts phase 0 running and asks to spawn index 0", () => {
  const r = initInstance(def(), "manual", { instanceId: "i1", token: "tok" }, NOW);
  assert.deepEqual(r.startPhases, [0]);
  assert.equal(r.instance.status, "running");
  assert.equal(r.instance.phases[0].status, "running");
  assert.equal(r.instance.phases[1].status, "pending");
});

test("needs-input pauses for approval, no spawn", () => {
  const inst = started(def());
  const r = advance(def(), inst, sig({ type: "needs-input", payload: "QUESTIONS" }), NOW);
  assert.deepEqual(r.startPhases, []);
  assert.equal(r.instance.status, "awaiting-approval");
  assert.equal(r.instance.phases[0].payload, "QUESTIONS");
});

test("completed on a gated phase pauses for approval", () => {
  const inst = started(def());
  const r = advance(def(), inst, sig({ type: "completed" }), NOW);
  assert.deepEqual(r.startPhases, []);
  assert.equal(r.instance.status, "awaiting-approval");
});

test("completed on a non-gated phase advances and asks to spawn the next phase", () => {
  const d = def();
  d.phases[0].gated = false;
  const inst = started(d);
  const r = advance(d, inst, sig({ type: "completed", payload: "OUT" }), NOW);
  assert.deepEqual(r.startPhases, [1]);
  assert.equal(r.instance.currentPhaseIndex, 1);
  assert.equal(r.instance.phases[0].status, "succeeded");
  assert.equal(r.instance.phases[1].status, "running");
});

test("completed on the last non-gated phase succeeds the instance", () => {
  const d = def({
    phases: [
      { id: "only", name: "Only", cwd: "/tmp", gated: false, steps: [{ name: "s", prompt: "p" }] },
    ],
  });
  const inst = started(d);
  const r = advance(
    d,
    {
      ...inst,
      phases: [
        {
          ...inst.phases[0],
          id: "only",
          steps: [{ name: "s", runId: "run-0", status: "running" }],
        },
      ],
    },
    sig({ phaseId: "only" }),
    NOW,
  );
  assert.deepEqual(r.startPhases, []);
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
  const r = advance(
    def(),
    inst,
    sig({ type: "failed", payload: "boom", runId: "some-other-run" }),
    NOW,
  );
  assert.deepEqual(r.startPhases, []);
  assert.equal(r.instance.status, "running");
  assert.equal(r.instance.phases[0].status, "running");
  assert.equal(r.instance.phases[0].steps[0].status, "running");
});

test("a failed phase terminalizes running sibling steps", () => {
  const d = def({
    phases: [
      {
        id: "brainstorm",
        name: "Brainstorm",
        cwd: "/tmp",
        gated: false,
        steps: [
          { name: "a", prompt: "p" },
          { name: "b", prompt: "p" },
        ],
      },
      { id: "plan", name: "Plan", cwd: "/tmp", gated: false, steps: [{ name: "wp", prompt: "p" }] },
    ],
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
  assert.deepEqual(r.startPhases, []);
  assert.equal(r.instance.currentPhaseIndex, 1);
});

test("applyApprove advances past a gate, forwarding answers as payload", () => {
  const inst = started(def());
  advance(def(), inst, sig({ type: "needs-input", payload: "Q" }), NOW); // awaiting-approval
  const r = applyApprove(def(), inst, "MY ANSWERS", NOW);
  assert.deepEqual(r.startPhases, [1]);
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
  assert.deepEqual(r.startPhases, [0]);
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

test("applyAbort closes out the in-flight phase and its running/pending steps", () => {
  const inst = started(def());
  const out = applyAbort(inst, NOW);
  assert.equal(out.phases[0].status, "aborted");
  assert.equal(out.phases[0].steps[0].status, "aborted");
  // later phases were never reached — they stay pending, not aborted
  assert.equal(out.phases[1].status, "pending");
});

test("applyAbort leaves finished steps of the current phase untouched", () => {
  const inst = started(def());
  inst.phases[0].steps[0].status = "succeeded";
  const out = applyAbort(inst, NOW);
  assert.equal(out.phases[0].steps[0].status, "succeeded");
  assert.equal(out.phases[0].status, "aborted");
});

test("applyAbort throws when the instance is already terminal", () => {
  const inst = started(def());
  inst.status = "succeeded";
  assert.throws(() => applyAbort(inst, NOW), /already terminal/);
});

test("failed signal with no reason gets a backstop reason", () => {
  const inst = started(def());
  const r = advance(def(), inst, sig({ type: "failed", payload: { session_id: "x" } }), NOW);
  assert.equal(r.instance.status, "failed");
  const payload = r.instance.phases[0].payload as { reason?: string; session_id?: string };
  assert.equal(payload.reason, "run stopped without reporting an outcome");
  assert.equal(payload.session_id, "x"); // existing payload keys preserved
});

test("failed signal keeps an existing reason untouched", () => {
  const inst = started(def());
  const r = advance(
    def(),
    inst,
    sig({ type: "failed", payload: { reason: "blocked: no Jira" } }),
    NOW,
  );
  assert.equal((r.instance.phases[0].payload as { reason: string }).reason, "blocked: no Jira");
});

test("applyUnlaunchable fails a running phase under the configuration class and settles", () => {
  const d = def();
  const inst = started(d);
  const res = applyUnlaunchable(d, inst, "brainstorm", 'phase "brainstorm" is gone', NOW);
  const phase = res.instance.phases[0];
  assert.equal(phase.status, "failed");
  assert.deepEqual(phase.payload, {
    reason: 'phase "brainstorm" is gone',
    failureClass: "configuration",
  });
  assert.ok(phase.steps.every((s) => s.status === "failed"));
  assert.equal(res.instance.status, "failed");
  assert.deepEqual(res.startPhases, []);
});

test("applyUnlaunchable leaves a phase that is not running alone", () => {
  const d = def();
  const inst = started(d);
  const res = applyUnlaunchable(d, inst, "plan", "gone", NOW);
  assert.equal(res.instance.phases[1].status, "pending");
  assert.equal(res.instance.status, "running");
  assert.deepEqual(res.startPhases, []);
});

test("advance names why a signal it cannot apply was ignored", () => {
  const d = def();
  assert.equal(advance(d, started(d), sig({ phaseId: "nope" }), NOW).ignored, "unknown-phase");
  assert.equal(advance(d, started(d), sig({ runId: "other" }), NOW).ignored, "unknown-run");
  const paused = advance(d, started(d), sig({ type: "needs-input", payload: "Q?" }), NOW).instance;
  assert.equal(advance(d, paused, sig({}), NOW).ignored, "phase-not-running");
  assert.equal(advance(d, started(d), sig({}), NOW).ignored, undefined);
});

// ── Candidates: best-of-N with verifier-gated selection ──────────────────────

function candidateDef(over: Partial<CandidatePolicy> = {}): PipelineDefinition {
  return def({
    workspace: { scope: "attempt" },
    phases: [
      {
        id: "impl",
        name: "Implement",
        cwd: "/tmp",
        gated: false,
        steps: [{ name: "code", prompt: "do it" }],
        checks: [{ kind: "command", run: "npm test", label: "tests" }],
        candidates: { count: 3, select: "first-verified", ...over },
      },
      {
        id: "ship",
        name: "Ship",
        cwd: "/tmp",
        gated: false,
        needs: ["impl"],
        steps: [{ name: "go", prompt: "ship {{previous.payload}}" }],
      },
    ],
  });
}

/** An instance whose candidates phase has `count` running candidate steps. */
function candidateInstance(d: PipelineDefinition, count = 3): PipelineInstance {
  const { instance } = initInstance(d, "manual", { instanceId: "i1", token: "tok" }, NOW);
  instance.phases[0].steps = Array.from({ length: count }, (_, i) => ({
    name: "code",
    runId: `run-c${i}`,
    status: "running" as const,
    candidate: i,
    workspace: {
      path: `/w/c${i}`,
      branch: `argus/i1/impl/0-c${i}`,
      base: "HEAD",
      baseHead: "abc",
    },
  }));
  return instance;
}

const report = (status: "passed" | "failed", endedAt = NOW): VerificationReport => ({
  status,
  startedAt: NOW,
  endedAt,
  checks: [
    {
      kind: "command",
      label: "tests",
      status,
      detail: status === "passed" ? "exit 0" : "exit 1",
      durationMs: 10,
    },
  ],
});

const rec = (over: Partial<CandidateRecord> & { candidate: number }): CandidateRecord => ({
  status: "succeeded",
  verified: null,
  verifiedAt: null,
  costUsd: null,
  durationMs: null,
  runtime: null,
  model: null,
  ...over,
});

test("candidateState: a finished candidate is not a won candidate", () => {
  assert.equal(candidateState(rec({ candidate: 0, status: "running" })), "running");
  // Succeeded, but its checks have not reported: still in the race.
  assert.equal(candidateState(rec({ candidate: 0, status: "succeeded" })), "running");
  assert.equal(candidateState(rec({ candidate: 0, verified: true })), "verified");
  assert.equal(candidateState(rec({ candidate: 0, verified: false })), "lost");
  assert.equal(candidateState(rec({ candidate: 0, status: "failed" })), "lost");
  assert.equal(candidateState(rec({ candidate: 0, status: "aborted" })), "lost");
});

test("first-verified selects as soon as one passes, and waits while any could still pass", () => {
  const policy: CandidatePolicy = { count: 3, select: "first-verified" };
  assert.deepEqual(
    selectCandidate(policy, [
      rec({ candidate: 0, status: "running" }),
      rec({ candidate: 1, status: "running" }),
    ]),
    { kind: "pending" },
  );
  assert.deepEqual(
    selectCandidate(policy, [
      rec({ candidate: 0, status: "failed" }),
      rec({ candidate: 1, verified: true, verifiedAt: "2026-06-30T12:00:05.000Z" }),
      rec({ candidate: 2, status: "running" }),
    ]),
    { kind: "selected", candidate: 1 },
  );
  // Two already verified (a restart re-asking): the earlier report wins, so the
  // answer is the same however many times it is asked.
  assert.deepEqual(
    selectCandidate(policy, [
      rec({ candidate: 0, verified: true, verifiedAt: "2026-06-30T12:00:09.000Z" }),
      rec({ candidate: 1, verified: true, verifiedAt: "2026-06-30T12:00:03.000Z" }),
    ]),
    { kind: "selected", candidate: 1 },
  );
  assert.deepEqual(
    selectCandidate(policy, [
      rec({ candidate: 0, status: "failed" }),
      rec({ candidate: 1, verified: false }),
    ]),
    { kind: "none" },
  );
});

test("cheapest-verified waits for the last candidate, then buys the cheapest", () => {
  const policy: CandidatePolicy = { count: 3, select: "cheapest-verified" };
  // A verified candidate does not end the race: the one still running may be
  // cheaper, which is the whole difference from first-verified.
  assert.deepEqual(
    selectCandidate(policy, [
      rec({ candidate: 0, verified: true, costUsd: 1 }),
      rec({ candidate: 1, status: "running" }),
    ]),
    { kind: "pending" },
  );
  assert.deepEqual(
    selectCandidate(policy, [
      rec({ candidate: 0, verified: true, costUsd: 1.2 }),
      rec({ candidate: 1, verified: true, costUsd: 0.4 }),
      rec({ candidate: 2, verified: false, costUsd: 0.1 }),
    ]),
    { kind: "selected", candidate: 1 },
  );
  // Null cost sorts last: an unknown price is not a cheap one.
  assert.deepEqual(
    selectCandidate(policy, [
      rec({ candidate: 0, verified: true, costUsd: null }),
      rec({ candidate: 1, verified: true, costUsd: 9 }),
    ]),
    { kind: "selected", candidate: 1 },
  );
  // Same cost → shortest duration; same duration → lowest index.
  assert.deepEqual(
    selectCandidate(policy, [
      rec({ candidate: 0, verified: true, costUsd: 1, durationMs: 900 }),
      rec({ candidate: 1, verified: true, costUsd: 1, durationMs: 100 }),
    ]),
    { kind: "selected", candidate: 1 },
  );
  assert.deepEqual(
    selectCandidate(policy, [
      rec({ candidate: 0, verified: true, costUsd: 1, durationMs: 100 }),
      rec({ candidate: 1, verified: true, costUsd: 1, durationMs: 100 }),
    ]),
    { kind: "selected", candidate: 0 },
  );
});

test("candidateFailureClass: shared class, else verification, else exit-code", () => {
  assert.equal(
    candidateFailureClass([
      rec({ candidate: 0, failureClass: "timeout" }),
      rec({ candidate: 1, failureClass: "timeout" }),
    ]),
    "timeout",
  );
  assert.equal(
    candidateFailureClass([
      rec({ candidate: 0, failureClass: "verification" }),
      rec({ candidate: 1, failureClass: "exit-code" }),
    ]),
    "verification",
  );
  assert.equal(
    candidateFailureClass([
      rec({ candidate: 0, failureClass: "spawn" }),
      rec({ candidate: 1, failureClass: "signal" }),
    ]),
    "exit-code",
  );
  assert.equal(candidateFailureClass([rec({ candidate: 0 })]), "exit-code");
});

test("candidateFailureReason names every candidate, in candidate order", () => {
  const reason = candidateFailureReason([
    rec({ candidate: 1, runtime: "codex", verified: false, reason: "checks failed: tests" }),
    rec({ candidate: 0, runtime: "claude", model: "opus", reason: "timed out after 60s" }),
  ]);
  assert.match(reason, /no candidate passed its checks/);
  assert.ok(reason.indexOf("c0 (claude opus)") < reason.indexOf("c1 (codex)"));
  assert.match(reason, /timed out after 60s/);
});

test("a candidate's failure does not fail its phase", () => {
  const d = candidateDef();
  const inst = candidateInstance(d);
  const res = advance(
    d,
    inst,
    { instanceId: "i1", phaseId: "impl", runId: "run-c1", type: "failed", token: "tok" },
    NOW,
    "timeout",
  );
  assert.equal(res.candidatesMoved, "impl");
  assert.equal(res.instance.status, "running");
  assert.equal(res.instance.phases[0].status, "running");
  const step = res.instance.phases[0].steps[1];
  assert.equal(step.status, "failed");
  assert.equal(step.failure?.class, "timeout");
  // Its siblings are untouched: that is the point of running three.
  assert.equal(res.instance.phases[0].steps[0].status, "running");
});

test("a completed candidate asks for its own checks, and holds its payload on its step", () => {
  const d = candidateDef();
  const inst = candidateInstance(d);
  const res = advance(
    d,
    inst,
    {
      instanceId: "i1",
      phaseId: "impl",
      runId: "run-c2",
      type: "completed",
      token: "tok",
      payload: { note: "from c2" },
    },
    NOW,
  );
  assert.deepEqual(res.verifyCandidate, { phaseId: "impl", candidate: 2 });
  const step = res.instance.phases[0].steps[2];
  assert.equal(step.status, "succeeded");
  assert.deepEqual(step.payload, { note: "from c2" });
  assert.equal(step.verification?.status, "running");
  // The phase publishes nothing until a candidate is selected.
  assert.equal(res.instance.phases[0].payload, null);
});

test("a candidate that asks for input loses; the gate belongs to the winner", () => {
  const d = candidateDef();
  const inst = candidateInstance(d);
  const res = advance(
    d,
    inst,
    { instanceId: "i1", phaseId: "impl", runId: "run-c0", type: "needs-input", token: "tok" },
    NOW,
  );
  assert.equal(res.instance.phases[0].status, "running");
  assert.equal(res.instance.phases[0].steps[0].status, "failed");
  assert.match(res.instance.phases[0].steps[0].failure!.reason, /gates on its winner/);
});

test("applyCandidateVerification refuses a report for a candidate nobody is waiting on", () => {
  const d = candidateDef();
  const inst = candidateInstance(d);
  // Never reported completion, so no verification is running for it.
  const res = applyCandidateVerification(inst, "impl", 0, report("passed"), NOW);
  assert.equal(res.verificationApplied, undefined);
  assert.equal(inst.phases[0].steps[0].verification, undefined);
});

test("selection makes the winner's work the phase's, and the losers superseded", () => {
  const d = candidateDef();
  const inst = candidateInstance(d);
  const steps = inst.phases[0].steps;
  steps[1].status = "succeeded";
  steps[1].payload = { note: "c1 wins" };
  steps[1].verification = report("passed");
  const res = applyCandidateSelection(
    d,
    inst,
    "impl",
    1,
    [
      {
        candidate: 0,
        status: "running",
        verified: null,
        costUsd: null,
        durationMs: null,
        runtime: null,
        model: null,
      },
      {
        candidate: 1,
        status: "succeeded",
        verified: true,
        costUsd: 1,
        durationMs: 5,
        runtime: null,
        model: null,
      },
      {
        candidate: 2,
        status: "failed",
        verified: null,
        costUsd: null,
        durationMs: null,
        runtime: null,
        model: null,
      },
    ],
    NOW,
  );
  const phase = res.instance.phases[0];
  assert.equal(phase.status, "succeeded");
  assert.equal(phase.selectedCandidate, 1);
  assert.deepEqual(phase.payload, { note: "c1 wins" });
  assert.equal(phase.verification?.status, "passed");
  assert.equal(phase.workspace?.branch, "argus/i1/impl/0-c1");
  // Not "failed": nothing went wrong with c0, it was simply not chosen.
  assert.equal(phase.steps[0].status, "aborted");
  assert.match(phase.steps[0].failure!.reason, /superseded by candidate 1/);
  assert.equal(phase.candidateOutcomes?.length, 3);
  // The next phase is launched, and reads the winner's payload.
  assert.deepEqual(res.startPhases, [1]);
});

test("a gated candidates phase opens its gate after selection, not before", () => {
  const d = candidateDef();
  d.phases[0].gated = true;
  const inst = candidateInstance(d);
  inst.phases[0].steps[0].status = "succeeded";
  inst.phases[0].steps[0].verification = report("passed");
  const res = applyCandidateSelection(d, inst, "impl", 0, [], NOW);
  assert.equal(res.instance.phases[0].status, "awaiting-approval");
  assert.equal(res.instance.status, "awaiting-approval");
  assert.deepEqual(res.startPhases, []);
});

test("only the winner's declared result is resolved; the losers' drafts are not contradictions", () => {
  const d = candidateDef();
  d.phases[0].result = {
    artifact: "impl",
    schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
  };
  const inst = candidateInstance(d);
  inst.phases[0].steps[0].result = { ok: false };
  inst.phases[0].steps[1].result = { ok: true };
  inst.phases[0].steps[1].status = "succeeded";
  inst.phases[0].steps[1].verification = report("passed");
  const res = applyCandidateSelection(d, inst, "impl", 1, [], NOW);
  assert.equal(res.instance.phases[0].status, "succeeded");
  assert.deepEqual(res.instance.phases[0].result, { ok: true });
});

test("every candidate lost: one failure, carrying all of them", () => {
  const d = candidateDef();
  const inst = candidateInstance(d);
  for (const s of inst.phases[0].steps) {
    s.status = "succeeded";
    s.verification = report("failed");
    s.failure = { class: "verification", reason: "checks failed: tests" };
  }
  const records = inst.phases[0].steps.map((s) => ({
    ...candidateRecordOf(s),
    costUsd: null,
    durationMs: null,
  }));
  const res = applyCandidatesExhausted(
    d,
    inst,
    "impl",
    candidateFailureClass(records),
    candidateFailureReason(records),
    toCandidateOutcomes(records),
    NOW,
  );
  const phase = res.instance.phases[0];
  assert.equal(phase.status, "failed");
  assert.equal(phase.selectedCandidate, null);
  assert.equal((phase.payload as { failureClass?: string }).failureClass, "verification");
  assert.match((phase.payload as { reason: string }).reason, /c0: checks failed/);
  assert.match((phase.payload as { reason: string }).reason, /c2: checks failed/);
  assert.equal(res.instance.status, "failed");
  assert.equal(phase.candidateOutcomes?.length, 3);
});

test("a revise of a settled candidates phase clears the selection and re-plans one step", () => {
  const d = candidateDef();
  const inst = candidateInstance(d);
  inst.phases[0].status = "failed";
  inst.phases[0].selectedCandidate = null;
  inst.phases[0].candidateOutcomes = [];
  const res = applyRevise(inst, NOW, "impl");
  const phase = res.instance.phases[0];
  assert.equal(phase.attempt, 1);
  assert.equal(phase.selectedCandidate, undefined);
  assert.equal(phase.candidateOutcomes, undefined);
  // One entry per declared step: the next attempt plans its own candidates.
  assert.deepEqual(
    phase.steps.map((s) => s.name),
    ["code"],
  );
});
