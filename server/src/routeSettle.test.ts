import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { advance, applyApprove, initInstance, settle } from "./pipelineTransitions.js";
import type {
  PhaseDef,
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
  ResultSchema,
} from "./sources/pipelineTypes.js";

/**
 * Route execution on the settle path.
 *
 * `settle()` is the only place a route is ever evaluated, which is what makes
 * the whole feature auditable: a branch was taken because one function looked at
 * one validated result and wrote down what it selected. Everything else — a
 * signal, an approval, a retry, a reconcile tick — changes a status and asks
 * settle what follows.
 */

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-route-settle-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
});

const NOW = "2026-08-13T12:00:00.000Z";

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

/** Drive one phase's single step to a signal, as the engine would. */
function signal(
  d: PipelineDefinition,
  inst: PipelineInstance,
  phaseId: string,
  type: PipelineSignal["type"],
  extra: Partial<PipelineSignal> = {},
) {
  const p = inst.phases.find((x) => x.id === phaseId)!;
  p.steps = p.steps.map((s) => ({ ...s, runId: s.runId ?? `${phaseId}-run`, status: "running" }));
  return advance(
    d,
    inst,
    { instanceId: "i1", phaseId, runId: `${phaseId}-run`, type, token: "t", ...extra },
    NOW,
  );
}

const status = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)?.status;

// ── The spec's worked example ───────────────────────────────────────────────

const acceptedSchema: ResultSchema = {
  type: "object",
  required: ["accepted"],
  properties: { accepted: { type: "boolean" } },
};

const accepted = (value: boolean) => ({
  predicate: { path: ["accepted"], operator: "equals" as const, value },
});

const WORKED = [
  phase("evaluate", { result: { artifact: "evaluation", schema: acceptedSchema } }),
  phase("publish", { needs: [{ phase: "evaluate", when: accepted(true) }] }),
  phase("repair", { needs: [{ phase: "evaluate", when: accepted(false) }] }),
  phase("report", {
    needs: [
      { phase: "publish", allowSkipped: true },
      { phase: "repair", allowSkipped: true },
    ],
  }),
];

test("a matching route runs its branch and skips the alternative", () => {
  const d = def(WORKED);
  const inst = start(d).instance;
  const res = signal(d, inst, "evaluate", "completed", { result: { accepted: true } });

  assert.equal(status(inst, "evaluate"), "succeeded");
  assert.equal(status(inst, "publish"), "running");
  assert.equal(status(inst, "repair"), "skipped", "the unselected branch is skipped, not idle");
  assert.equal(status(inst, "report"), "pending", "the join waits for the selected branch");
  assert.deepEqual(
    res.startPhases.map((i) => inst.phases[i].id),
    ["publish"],
  );
});

test("the other value takes the other branch", () => {
  const d = def(WORKED);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: false } });
  assert.equal(status(inst, "publish"), "skipped");
  assert.equal(status(inst, "repair"), "running");
});

test("an allowSkipped join runs once the selected branch lands, and the instance succeeds", () => {
  const d = def(WORKED);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: true } });
  signal(d, inst, "publish", "completed");

  assert.equal(status(inst, "report"), "running", "a skipped dependency satisfies the join");
  signal(d, inst, "report", "completed");
  assert.equal(inst.status, "succeeded", "a skipped branch still leaves the instance succeeded");
  assert.equal(status(inst, "repair"), "skipped");
});

test("the decision is recorded on the instance, with what it selected and why", () => {
  const d = def(WORKED);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: true } });

  assert.equal(inst.routeDecisions?.length, 1);
  const decision = inst.routeDecisions![0];
  assert.equal(decision.sourcePhase, "evaluate");
  assert.equal(decision.artifact, "evaluation");
  assert.deepEqual(decision.value, { accepted: true });
  assert.deepEqual(decision.selected, ["publish"]);
  assert.deepEqual(decision.skipped, ["repair"]);
  assert.match(decision.reason, /accepted equals true/);
  assert.match(decision.reason, /publish/);
});

test("the validated result is published as its artifact and reaches later prompts", () => {
  const d = def([
    phase("evaluate", { result: { artifact: "evaluation", schema: acceptedSchema } }),
    phase("publish", {
      needs: [{ phase: "evaluate", when: accepted(true) }],
      steps: [{ name: "s", prompt: "ship {{artifacts.evaluation}}" }],
    }),
  ]);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: true } });
  assert.deepEqual(inst.artifacts?.evaluation, { accepted: true });
  assert.deepEqual(inst.phases[0].result, { accepted: true });
});

test("the result is kept apart from the legacy payload", () => {
  const d = def(WORKED);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", {
    result: { accepted: true },
    payload: { last_assistant_message: "all done" },
  });
  assert.deepEqual(inst.phases[0].result, { accepted: true });
  assert.deepEqual(inst.phases[0].payload, { last_assistant_message: "all done" });
});

// ── Skip propagation ───────────────────────────────────────────────────────

test("a skip travels down the branch it cancelled", () => {
  const d = def([
    phase("evaluate", { result: { artifact: "evaluation", schema: acceptedSchema } }),
    phase("publish", { needs: [{ phase: "evaluate", when: accepted(true) }] }),
    phase("announce", { needs: ["publish"] }),
  ]);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: false } });
  assert.equal(status(inst, "publish"), "skipped");
  assert.equal(status(inst, "announce"), "skipped", "a skipped dependency cancels its dependents");
  assert.equal(inst.status, "succeeded");
});

test("a phase skips only once every incoming edge is known", () => {
  const d = def([
    phase("evaluate", { result: { artifact: "evaluation", schema: acceptedSchema } }),
    phase("other"),
    phase("both", {
      needs: [{ phase: "evaluate", when: accepted(true) }, "other"],
    }),
  ]);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: false } });
  assert.equal(
    status(inst, "both"),
    "pending",
    "one edge is routed out but the other has not resolved",
  );
  signal(d, inst, "other", "completed");
  assert.equal(status(inst, "both"), "skipped");
  assert.equal(inst.status, "succeeded");
});

test("a join that does not tolerate skips is skipped itself", () => {
  const d = def([
    phase("evaluate", { result: { artifact: "evaluation", schema: acceptedSchema } }),
    phase("publish", { needs: [{ phase: "evaluate", when: accepted(true) }] }),
    phase("repair", { needs: [{ phase: "evaluate", when: accepted(false) }] }),
    phase("report", { needs: ["publish", "repair"] }),
  ]);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: true } });
  signal(d, inst, "publish", "completed");
  assert.equal(status(inst, "report"), "skipped", "an intolerant join cannot wait forever");
  assert.equal(inst.status, "succeeded");
});

test("the steps of a skipped phase are skipped too", () => {
  const d = def(WORKED);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: true } });
  assert.deepEqual(
    inst.phases.find((p) => p.id === "repair")!.steps.map((s) => s.status),
    ["skipped"],
  );
});

// ── Groups, defaults and runtime route failures ─────────────────────────────

const verdictSchema: ResultSchema = {
  type: "object",
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["pass", "warn", "fail"] } },
};

const group = { group: "verdict", exclusive: true, required: true };
const verdict = (value: string) => ({
  ...group,
  predicate: { path: ["verdict"], operator: "equals" as const, value },
});

test("a group default is selected only when no ordinary condition matched", () => {
  const d = def([
    phase("audit", { result: { artifact: "audit", schema: verdictSchema } }),
    phase("ship", { needs: [{ phase: "audit", when: verdict("pass") }] }),
    phase("triage", { needs: [{ phase: "audit", when: { ...group, default: true } }] }),
  ]);
  const inst = start(d).instance;
  signal(d, inst, "audit", "completed", { result: { verdict: "warn" } });
  assert.equal(status(inst, "ship"), "skipped");
  assert.equal(status(inst, "triage"), "running");
  assert.match(inst.routeDecisions![0].reason, /default/);
});

test("an exclusive group matching twice fails the phase instead of running both", () => {
  const d = def([
    phase("audit", { result: { artifact: "audit", schema: verdictSchema } }),
    phase("ship", { needs: [{ phase: "audit", when: verdict("pass") }] }),
    phase("archive", {
      needs: [
        {
          phase: "audit",
          when: { ...group, predicate: { path: ["verdict"], operator: "one-of", value: ["pass"] } },
        },
      ],
    }),
  ]);
  const inst = start(d).instance;
  const res = signal(d, inst, "audit", "completed", { result: { verdict: "pass" } });

  assert.equal(status(inst, "audit"), "failed", "an ambiguous route is a failure, not a branch");
  assert.equal(inst.routeDecisions ?? undefined, undefined, "no decision is recorded");
  assert.equal(status(inst, "ship"), "pending");
  assert.equal(status(inst, "archive"), "pending");
  assert.equal(inst.status, "failed");
  assert.match(res.routing!.failures[0].reason, /exclusive route group/);
  assert.equal(res.routing!.failures[0].phaseId, "audit");
});

test("a required group that matches nothing fails the phase", () => {
  const d = def([
    phase("audit", { result: { artifact: "audit", schema: verdictSchema } }),
    phase("ship", { needs: [{ phase: "audit", when: verdict("pass") }] }),
  ]);
  const inst = start(d).instance;
  const res = signal(d, inst, "audit", "completed", { result: { verdict: "fail" } });
  assert.equal(status(inst, "audit"), "failed");
  assert.match(res.routing!.failures[0].reason, /required route group/);
});

// ── Result failures are operational failures, never business branches ───────

const missingCases: [string, Partial<PipelineSignal>, RegExp][] = [
  ["no result at all", {}, /did not deliver its declared result/],
  [
    "a result the schema rejects",
    { result: { accepted: "yes" } },
    /does not match the declared schema/,
  ],
  [
    "a result file that could not be read",
    { resultError: "the result file at /x could not be parsed as JSON: bad" },
    /could not be parsed/,
  ],
];

for (const [label, extra, pattern] of missingCases) {
  test(`a phase that completes with ${label} fails with a specific reason`, () => {
    const d = def(WORKED);
    const inst = start(d).instance;
    const res = signal(d, inst, "evaluate", "completed", extra);
    assert.equal(status(inst, "evaluate"), "failed");
    assert.match(String((inst.phases[0].payload as { reason: string }).reason), pattern);
    assert.match(res.routing!.failures[0].reason, pattern);
    assert.equal(status(inst, "publish"), "pending", "no branch is selected by a failure");
    assert.equal(status(inst, "repair"), "pending");
    assert.equal(inst.status, "failed");
  });
}

test("two steps submitting different results is a failure, not a coin toss", () => {
  const d = def([
    phase("evaluate", {
      steps: [
        { name: "a", prompt: "p" },
        { name: "b", prompt: "p" },
      ],
      result: { artifact: "evaluation", resultStep: "b", schema: acceptedSchema },
    }),
    phase("publish", { needs: [{ phase: "evaluate", when: accepted(true) }] }),
  ]);
  const inst = start(d).instance;
  const p = inst.phases[0];
  p.steps = p.steps.map((s) => ({ ...s, runId: `run-${s.name}`, status: "running" }));
  advance(
    d,
    inst,
    {
      instanceId: "i1",
      phaseId: "evaluate",
      runId: "run-a",
      type: "completed",
      token: "t",
      result: { accepted: false },
    },
    NOW,
  );
  const res = advance(
    d,
    inst,
    {
      instanceId: "i1",
      phaseId: "evaluate",
      runId: "run-b",
      type: "completed",
      token: "t",
      result: { accepted: true },
    },
    NOW,
  );
  assert.equal(status(inst, "evaluate"), "failed");
  assert.match(res.routing!.failures[0].reason, /contradictory/);
});

test("a result submitted by a step that is not the declared one is refused", () => {
  const d = def([
    phase("evaluate", {
      steps: [
        { name: "a", prompt: "p" },
        { name: "b", prompt: "p" },
      ],
      result: { artifact: "evaluation", resultStep: "b", schema: acceptedSchema },
    }),
    phase("publish", { needs: [{ phase: "evaluate", when: accepted(true) }] }),
  ]);
  const inst = start(d).instance;
  const p = inst.phases[0];
  p.steps = p.steps.map((s) => ({ ...s, runId: `run-${s.name}`, status: "running" }));
  for (const [runId, result] of [
    ["run-a", { accepted: true }],
    ["run-b", undefined],
  ] as const) {
    advance(
      d,
      inst,
      {
        instanceId: "i1",
        phaseId: "evaluate",
        runId,
        type: "completed",
        token: "t",
        ...(result ? { result } : {}),
      },
      NOW,
    );
  }
  assert.equal(status(inst, "evaluate"), "failed");
  assert.match(
    String((inst.phases[0].payload as { reason: string }).reason),
    /step "a".*not the declared result step/,
  );
});

// ── Gates ──────────────────────────────────────────────────────────────────

test("a gated phase validates its result at completion but routes only after approval", () => {
  const d = def([
    phase("evaluate", {
      gated: true,
      result: { artifact: "evaluation", schema: acceptedSchema },
    }),
    phase("publish", { needs: [{ phase: "evaluate", when: accepted(true) }] }),
    phase("repair", { needs: [{ phase: "evaluate", when: accepted(false) }] }),
  ]);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: true } });

  assert.equal(status(inst, "evaluate"), "awaiting-approval");
  assert.deepEqual(inst.phases[0].result, { accepted: true }, "validated at completion");
  assert.equal(inst.routeDecisions ?? undefined, undefined, "but not yet routed");
  assert.equal(status(inst, "publish"), "pending");

  applyApprove(d, inst, { note: "looks right" }, NOW);
  assert.equal(status(inst, "publish"), "running");
  assert.equal(status(inst, "repair"), "skipped");
  assert.deepEqual(inst.phases[0].payload, { note: "looks right" });
  assert.deepEqual(inst.phases[0].result, { accepted: true }, "the gate answer is not the result");
});

test("a gated phase whose agent delivered no result fails at completion", () => {
  const d = def([
    phase("evaluate", { gated: true, result: { artifact: "evaluation", schema: acceptedSchema } }),
    phase("publish", { needs: [{ phase: "evaluate", when: accepted(true) }] }),
  ]);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed");
  assert.equal(status(inst, "evaluate"), "failed");
});

// ── Recovery replays, it never re-decides ──────────────────────────────────

test("a settled route is replayed from its record, not evaluated again", () => {
  const d = def(WORKED);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: true } });

  // Simulate a crash between the decision write and the branch launch: the
  // phase statuses are rolled back to what they were, but the record stands.
  inst.phases.find((p) => p.id === "publish")!.status = "pending";
  inst.phases.find((p) => p.id === "repair")!.status = "pending";
  // And the stored result now says the opposite, as a torn write might.
  inst.phases[0].result = { accepted: false };

  const res = settle(d, inst, NOW);
  assert.equal(inst.routeDecisions!.length, 1, "no second decision is recorded");
  assert.deepEqual(inst.routeDecisions![0].value, { accepted: true });
  assert.equal(status(inst, "publish"), "running", "the recorded decision is what replays");
  assert.equal(status(inst, "repair"), "skipped");
  assert.deepEqual(res.routing!.decisions, [], "a replay reports no new decision");
});

test("a phase that succeeded before its result was declared fails rather than skipping everything", () => {
  const d = def(WORKED);
  const inst = start(d).instance;
  // As an instance mid-flight would look if the phase had succeeded under a
  // definition that did not yet declare a result.
  const evaluate = inst.phases[0];
  evaluate.status = "succeeded";
  evaluate.steps = evaluate.steps.map((s) => ({ ...s, status: "succeeded" }));
  delete evaluate.result;

  const res = settle(d, inst, NOW);
  assert.equal(status(inst, "evaluate"), "failed");
  assert.equal(status(inst, "publish"), "pending", "no branch is guessed");
  assert.equal(status(inst, "repair"), "pending");
  assert.match(res.routing!.failures[0].reason, /without recording its declared result/);
});

// ── Every pre-routing definition behaves exactly as before ─────────────────

test("a failed phase still blocks its dependents rather than skipping them", () => {
  const d = def([phase("a"), phase("b", { needs: ["a"] }), phase("c", { needs: ["b"] })]);
  const inst = start(d).instance;
  signal(d, inst, "a", "failed", { payload: { reason: "nope" } });
  assert.equal(status(inst, "b"), "pending", "a failure is not a skip");
  assert.equal(status(inst, "c"), "pending");
  assert.equal(inst.status, "failed");
});

test("a linear pipeline records no routing state at all", () => {
  const d = def([phase("a"), phase("b")]);
  const inst = start(d).instance;
  const first = signal(d, inst, "a", "completed");
  assert.equal(status(inst, "b"), "running");
  assert.equal(inst.routeDecisions ?? undefined, undefined);
  assert.deepEqual(first.routing?.decisions ?? [], []);
  assert.deepEqual(first.routing?.skipped ?? [], []);
  signal(d, inst, "b", "completed");
  assert.equal(inst.status, "succeeded");
});

test("an unconditional edge is still satisfied only by a succeeded source", () => {
  const d = def([
    phase("evaluate", { result: { artifact: "evaluation", schema: acceptedSchema } }),
    phase("always", { needs: ["evaluate"] }),
    phase("maybe", { needs: [{ phase: "evaluate", when: accepted(false) }] }),
  ]);
  const inst = start(d).instance;
  signal(d, inst, "evaluate", "completed", { result: { accepted: true } });
  assert.equal(status(inst, "always"), "running", "no condition means: it succeeded, so go");
  assert.equal(status(inst, "maybe"), "skipped");
  assert.deepEqual(inst.routeDecisions![0].selected, ["always"]);
});
