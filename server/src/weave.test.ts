import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  advance,
  applyAbort,
  applyApprove,
  applyRetry,
  applyRevise,
  initInstance,
  retryDelayMs,
  shouldRetry,
} from "./pipelineTransitions.js";
import { forgetJournal, journal, readJournal, journalPath } from "./sources/journal.js";
import type {
  PhaseDef,
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
} from "./sources/pipelineTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-weave-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
});

const NOW = "2026-07-20T12:00:00.000Z";

const phase = (id: string, over: Partial<PhaseDef> = {}): PhaseDef => ({
  id,
  name: id,
  cwd: "/tmp",
  steps: [{ name: "s", prompt: "p" }],
  gated: false,
  ...over,
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
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const start = (d: PipelineDefinition) =>
  initInstance(d, "manual", { instanceId: "i1", token: "t" }, NOW);

/** Drive a phase's single step to a signal, as the engine would. */
function signal(
  d: PipelineDefinition,
  inst: PipelineInstance,
  phaseId: string,
  type: PipelineSignal["type"],
  payload?: unknown,
) {
  const p = inst.phases.find((x) => x.id === phaseId)!;
  // The engine records runIds when it launches; do the same so the signal has
  // a step to match.
  p.steps = p.steps.map((s) => ({ ...s, runId: s.runId ?? `${phaseId}-run`, status: "running" }));
  return advance(
    d,
    inst,
    { instanceId: "i1", phaseId, runId: `${phaseId}-run`, type, token: "t", payload },
    NOW,
  );
}

// ── Fan-out and fan-in ──────────────────────────────────────────────────────

const DIAMOND = [
  phase("plan"),
  phase("build", { needs: ["plan"] }),
  phase("test", { needs: ["plan"] }),
  phase("ship", { needs: ["build", "test"] }),
];

test("a diamond starts one phase, fans out to two, and fans back in to one", () => {
  const d = def(DIAMOND);
  const started = start(d);
  assert.deepEqual(started.startPhases, [0], "only the root");

  const afterPlan = signal(d, started.instance, "plan", "completed");
  assert.deepEqual(afterPlan.startPhases, [1, 2], "both branches launch together");
  assert.equal(afterPlan.instance.phases[1].status, "running");
  assert.equal(afterPlan.instance.phases[2].status, "running");

  const afterBuild = signal(d, afterPlan.instance, "build", "completed");
  assert.deepEqual(afterBuild.startPhases, [], "ship waits for test as well");
  assert.equal(afterBuild.instance.status, "running");

  const afterTest = signal(d, afterBuild.instance, "test", "completed");
  assert.deepEqual(afterTest.startPhases, [3], "now the fan-in opens");

  const done = signal(d, afterTest.instance, "ship", "completed");
  assert.equal(done.instance.status, "succeeded");
  assert.ok(done.instance.endedAt);
});

test("regression: a failed branch does not terminalize the instance while its sibling runs", () => {
  // Flipping to `failed` here would render a terminal pipeline with a live
  // process still writing into it.
  const d = def(DIAMOND);
  const afterPlan = signal(d, start(d).instance, "plan", "completed");
  const buildFailed = signal(d, afterPlan.instance, "build", "failed");

  assert.equal(buildFailed.instance.phases[1].status, "failed");
  assert.equal(buildFailed.instance.status, "running", "test is still running");
  assert.equal(buildFailed.instance.endedAt, null);

  // Once the sibling settles and nothing can progress, the instance is failed.
  const testDone = signal(d, buildFailed.instance, "test", "completed");
  assert.equal(testDone.instance.status, "failed");
  assert.deepEqual(testDone.startPhases, [], "ship can never become ready");
  assert.ok(testDone.instance.endedAt);
});

test("a gate in one branch does not stop the other", () => {
  const d = def([
    phase("plan"),
    phase("review", { needs: ["plan"], gated: true }),
    phase("test", { needs: ["plan"] }),
  ]);
  const afterPlan = signal(d, start(d).instance, "plan", "completed");
  const gated = signal(d, afterPlan.instance, "review", "needs-input");
  assert.equal(gated.instance.status, "awaiting-approval");
  assert.equal(gated.instance.phases[2].status, "running", "test keeps going");
  // The board points at the gate, because that is what needs a human.
  assert.equal(gated.instance.currentPhaseIndex, 1);
});

test("approving a specific gate advances only that branch", () => {
  const d = def([
    phase("plan"),
    phase("review", { needs: ["plan"], gated: true }),
    phase("test", { needs: ["plan"] }),
    phase("ship", { needs: ["review", "test"] }),
  ]);
  const afterPlan = signal(d, start(d).instance, "plan", "completed");
  const gated = signal(d, afterPlan.instance, "review", "needs-input");
  const approved = applyApprove(d, gated.instance, undefined, NOW, "review");
  assert.equal(approved.instance.phases[1].status, "succeeded");
  assert.deepEqual(approved.startPhases, [], "ship still waits for test");
  assert.equal(approved.instance.status, "running");
});

// ── The degenerate case, end to end ─────────────────────────────────────────

test("regression: a pipeline with no `needs` runs exactly as it always did", () => {
  const d = def([phase("a"), phase("b"), phase("c")]);
  const s = start(d);
  assert.deepEqual(s.startPhases, [0]);
  const a = signal(d, s.instance, "a", "completed");
  assert.deepEqual(a.startPhases, [1]);
  const b = signal(d, a.instance, "b", "completed");
  assert.deepEqual(b.startPhases, [2]);
  const c = signal(d, b.instance, "c", "completed");
  assert.equal(c.instance.status, "succeeded");
});

// ── Artifacts ───────────────────────────────────────────────────────────────

test("a phase publishes its payload under the artifact name it declares", () => {
  const d = def([phase("plan", { produces: "plan" }), phase("build", { needs: ["plan"] })]);
  const after = signal(d, start(d).instance, "plan", "completed", { steps: 3 });
  assert.deepEqual(after.instance.artifacts, { plan: { steps: 3 } });
});

test("a phase with no `produces` publishes nothing — artifacts are opt-in", () => {
  const d = def([phase("plan"), phase("build", { needs: ["plan"] })]);
  const after = signal(d, start(d).instance, "plan", "completed", "some payload");
  assert.deepEqual(after.instance.artifacts, {});
});

test("an approved gate publishes its artifact too, using the operator's answers", () => {
  const d = def([phase("review", { gated: true, produces: "decision" })]);
  const gated = signal(d, start(d).instance, "review", "needs-input");
  const approved = applyApprove(d, gated.instance, "ship it", NOW);
  assert.deepEqual(approved.instance.artifacts, { decision: "ship it" });
});

// ── Retry ───────────────────────────────────────────────────────────────────

test("regression: an agent that signalled failure is not retried by default", () => {
  // It considered the work and reported on it; re-running the same prompt just
  // costs the same money twice.
  const policy = { attempts: 3, backoffSeconds: 10 };
  assert.equal(shouldRetry(policy, 0, "signal"), false);
  assert.equal(shouldRetry(policy, 0, "exit-code"), true);
  assert.equal(shouldRetry(policy, 0, "spawn"), true);
  // …unless the author asked for it.
  assert.equal(shouldRetry({ ...policy, retryOn: ["signal"] }, 0, "signal"), true);
});

test("retries stop at the attempt budget, and no policy means no retry", () => {
  const policy = { attempts: 3, backoffSeconds: 10 };
  assert.equal(shouldRetry(policy, 1, "exit-code"), true, "second retry allowed");
  assert.equal(shouldRetry(policy, 2, "exit-code"), false, "3 attempts = 2 retries");
  assert.equal(shouldRetry(undefined, 0, "exit-code"), false);
  assert.equal(shouldRetry({ attempts: 1, backoffSeconds: 10 }, 0, "exit-code"), false);
});

test("backoff doubles and is capped, so a generous budget can't schedule next week", () => {
  const policy = { attempts: 10, backoffSeconds: 30 };
  assert.equal(retryDelayMs(policy, 0), 30_000);
  assert.equal(retryDelayMs(policy, 1), 60_000);
  assert.equal(retryDelayMs(policy, 2), 120_000);
  assert.equal(retryDelayMs(policy, 20), 3_600_000);
  assert.equal(retryDelayMs({ attempts: 2, backoffSeconds: 0 }, 0), 0);
});

test("a retry restarts the phase, bumps the attempt, and counts against the budget", () => {
  const d = def([phase("a", { retry: { attempts: 3, backoffSeconds: 1 } })]);
  const failed = signal(d, start(d).instance, "a", "failed");
  assert.equal(failed.instance.phases[0].status, "failed");

  const retried = applyRetry(failed.instance, "a", NOW);
  assert.deepEqual(retried.startPhases, [0]);
  assert.equal(retried.instance.phases[0].status, "running");
  assert.equal(retried.instance.phases[0].attempt, 1);
  assert.equal(retried.instance.phases[0].retries, 1);
  assert.equal(retried.instance.phases[0].steps[0].runId, null, "a fresh run is spawned");
  assert.equal(retried.instance.status, "running");
});

test("regression: a revise resets the retry budget, so an exhausted phase can still be revised", () => {
  const d = def([phase("a", { retry: { attempts: 2, backoffSeconds: 1 } })]);
  const failed = signal(d, start(d).instance, "a", "failed");
  const exhausted = applyRetry(failed.instance, "a", NOW);
  const failedAgain = signal(d, exhausted.instance, "a", "failed");
  assert.equal(failedAgain.instance.phases[0].retries, 1);

  const revised = applyRevise(failedAgain.instance, NOW);
  assert.equal(revised.instance.phases[0].retries, 0, "the human's decision resets the budget");
  assert.equal(revised.instance.phases[0].attempt, 2);
});

test("retrying a phase that is not failed is a no-op, not a second launch", () => {
  const d = def([phase("a")]);
  const running = start(d);
  const res = applyRetry(running.instance, "a", NOW);
  assert.deepEqual(res.startPhases, []);
  assert.equal(applyRetry(running.instance, "nope", NOW).startPhases.length, 0);
});

// ── Abort across branches ───────────────────────────────────────────────────

test("aborting closes every live branch, not just one", () => {
  const d = def(DIAMOND);
  const afterPlan = signal(d, start(d).instance, "plan", "completed");
  const aborted = applyAbort(afterPlan.instance, NOW);
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.phases[1].status, "aborted");
  assert.equal(aborted.phases[2].status, "aborted");
  assert.ok(
    aborted.phases.every((p) => p.steps.every((s) => s.status !== "running")),
    "no step left running under a stopped instance",
  );
});

// ── The journal ─────────────────────────────────────────────────────────────

test("the journal records history the instance file cannot", async () => {
  await journal("i1", { at: NOW, kind: "instance.started", detail: "Pipeline (manual)" });
  await journal("i1", { at: NOW, kind: "phase.failed", phaseId: "a", detail: "exit-code: boom" });
  await journal("i1", { at: NOW, kind: "phase.retrying", phaseId: "a", attempt: 1 });
  const entries = await readJournal("i1");
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["instance.started", "phase.failed", "phase.retrying"],
  );
});

test("regression: a torn final line costs one record, not the whole journal", async () => {
  await journal("i1", { at: NOW, kind: "instance.started" });
  const { appendFileSync } = await import("node:fs");
  appendFileSync(journalPath("i1")!, '{"at":"x","kind":"pha');
  const entries = await readJournal("i1");
  assert.equal(entries.length, 1);
});

test("a missing journal is empty, and an id that could escape its directory is refused", async () => {
  assert.deepEqual(await readJournal("never-written"), []);
  assert.equal(journalPath("../../etc/passwd"), null);
  assert.equal(journalPath(""), null);
  await journal("../evil", { at: NOW, kind: "instance.started" });
  assert.deepEqual(await readJournal("../evil"), []);
});

test("forgetting a journal removes it", async () => {
  await journal("i1", { at: NOW, kind: "instance.started" });
  await forgetJournal("i1");
  assert.deepEqual(await readJournal("i1"), []);
});
