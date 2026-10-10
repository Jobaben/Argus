import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  Anomaly,
  Baseline,
  GateDecision,
  KnowledgeDeltaPreview,
  PhaseDef,
  PipelineInstance,
  Rubric,
  RuleVerificationPreview,
  StoredSnapshot,
  Verdict,
} from "@argus/contracts";
import { autoApprovalQualification } from "../../sources/gatePolicy.js";
import { rubricDigest } from "../../sources/verdict.js";
import { builtinRegistry } from "../definitions.js";
import { applyGateRules, verdictBaseline } from "./baselines.js";
import { h1Enablement, readH1Settings, H1_DEFAULTS } from "./config.js";
import { GATE_REVIEW_V1, h1Registry } from "./definitions.js";
import { gateEligibility, referenceDigest, settle, type GateItem } from "./gate.js";
import {
  projectGateReview,
  reviewStateDigest,
  shapeGateReview,
  type GateReviewBody,
  type GateReviewInput,
} from "./projection.js";
import { MIN, at, gateInstance, gateRun, gateWorld, reviewOf } from "./testSupport.js";

const ON = { ARGUS_DECISIONS: "on", ARGUS_DECISIONS_H1_COLLECT: "on" } as const;
const item: GateItem = { instanceId: "inst-1", phaseId: "publish", attempt: 0 };

// ── Settings ────────────────────────────────────────────────────────────────

test("config: an empty environment disables collection and names both switches", () => {
  const en = h1Enablement({});
  assert.equal(en.enabled, false);
  const reasons = (en as { reasons: string[] }).reasons;
  assert.ok(reasons.includes("ARGUS_DECISIONS is not on"));
  assert.ok(reasons.includes("ARGUS_DECISIONS_H1_COLLECT is not on"));
});

test("config: both switches on enable collection with the conservative defaults", () => {
  const en = h1Enablement({ ...ON });
  assert.ok(en.enabled);
  const s = en.settings;
  assert.equal(s.rate, 1);
  assert.equal(s.seed, "argus-h1");
  assert.deepEqual(s.models, [null]);
  assert.equal(s.limits.maxCallsPer24h, 20);
  assert.equal(s.limits.maxOwnCallsPer24h, 10);
  assert.equal(s.limits.minCallIntervalMs, 15 * MIN);
  assert.equal(s.limits.maxUsdPer24h, 1);
  assert.equal(s.limits.maxTriesPerItem, 3);
  assert.equal(s.limits.retryAfterMs, 30 * MIN);
  assert.equal(s.observation.maxBracketMs, 10 * MIN);
  assert.equal(s.observation.maxPendingMs, 7 * 24 * 60 * MIN);
  assert.equal(s.observation.settleWaitMs, 60 * MIN);
  assert.deepEqual(s, H1_DEFAULTS);
});

test("config: ARGUS_ANALYSIS=off disables collection even with both switches on", () => {
  const en = h1Enablement({ ...ON, ARGUS_ANALYSIS: "off" });
  assert.equal(en.enabled, false);
  assert.ok((en as { reasons: string[] }).reasons.some((r) => r.includes("ARGUS_ANALYSIS=off")));
});

test("config: each invalid value disables collection, is named, and leaves settings null", () => {
  const cases: Array<[string, string]> = [
    ["ARGUS_DECISIONS_H1_RATE", "1.5"],
    ["ARGUS_DECISIONS_H1_RATE", "abc"],
    ["ARGUS_DECISIONS_H1_MODELS", "gpt-4"],
    ["ARGUS_DECISIONS_H1_MODELS", "haiku,haiku"],
    ["ARGUS_DECISIONS_H1_MODELS", "haiku,sonnet,opus,claude-x"],
    ["ARGUS_DECISIONS_H1_SEED", "bad seed"],
    ["ARGUS_DECISIONS_H1_MAX_OWN_CALLS_PER_DAY", "30"],
  ];
  for (const [name, value] of cases) {
    const en = h1Enablement({ ...ON, [name]: value });
    assert.equal(en.enabled, false, `${name}=${value}`);
    assert.equal(en.settings, null, `${name}=${value}`);
    assert.ok(
      (en as { reasons: string[] }).reasons.some((r) => r.includes(name)),
      `${name}=${value} is named`,
    );
    assert.ok(readH1Settings({ [name]: value }).errors.length > 0, `${name}=${value}`);
  }
});

test("config: valid model lists are accepted as given", () => {
  const two = h1Enablement({ ...ON, ARGUS_DECISIONS_H1_MODELS: "haiku,sonnet" });
  assert.ok(two.enabled);
  assert.deepEqual(two.settings.models, ["haiku", "sonnet"]);
  const pinned = h1Enablement({ ...ON, ARGUS_DECISIONS_H1_MODELS: "claude-sonnet-5-5" });
  assert.ok(pinned.enabled);
  assert.deepEqual(pinned.settings.models, ["claude-sonnet-5-5"]);
});

// ── Eligibility ─────────────────────────────────────────────────────────────

const noRecords: GateDecision[] = [];

test("eligibility: an ordinary gate pause is an eligible manual item", () => {
  const inst = gateInstance();
  const e = gateEligibility(inst, item, inst.definition, noRecords);
  assert.deepEqual(e, { ok: true, relevantRuns: ["run-a"], population: "manual" });
});

test("eligibility: a phase that declares autoApprove is the auto-approve-declared population", () => {
  const inst = gateInstance({ phaseDef: { autoApprove: { verdict: 7 } } as never });
  const e = gateEligibility(inst, item, inst.definition, noRecords);
  assert.deepEqual(e, { ok: true, relevantRuns: ["run-a"], population: "auto-approve-declared" });
});

test("eligibility: every way an attempt stops being an item names its reason", () => {
  const reason = (
    inst: PipelineInstance | null,
    decisions: GateDecision[] = noRecords,
    it: GateItem = item,
  ) => {
    const e = gateEligibility(inst, it, inst?.definition, decisions);
    assert.equal(e.ok, false);
    return (e as { reason: string }).reason;
  };
  assert.equal(reason(null), "instance-gone");
  assert.equal(reason(gateInstance(), noRecords, { ...item, attempt: 1 }), "attempt-moved");
  assert.equal(reason(gateInstance({ phase: { status: "succeeded" } })), "phase-succeeded");
  assert.equal(reason(gateInstance({ phase: { pause: "needs-input" } })), "needs-input");
  assert.equal(reason(gateInstance({ phase: { pause: undefined } })), "unknown-pause");
  const pending = gateInstance();
  pending.pendingGateOperation = {
    decisionId: "GD-1",
    decision: "approve",
    phaseId: "publish",
    attempt: 0,
    stopRunIds: [],
    startedAt: at(0),
  };
  assert.equal(reason(pending), "pending-operation");
  assert.equal(
    reason(
      gateInstance({ phase: { steps: [{ name: "ship", runId: "run-a", status: "running" }] } }),
    ),
    "relevant-steps-incomplete",
  );
});

test("eligibility: only a record naming this attempt as awaiting approval makes it ineligible", () => {
  const inst = gateInstance();
  const world = gateWorld();
  world.put(inst);
  const ref = (attempt: number, status: string) => [
    { phaseId: "publish", attempt, status, runIds: ["run-a"] },
  ];
  const same = world.record("inst-1", "approve", { phases: ref(0, "awaiting-approval") });
  const e = gateEligibility(inst, item, inst.definition, [same]);
  assert.deepEqual(e, { ok: false, reason: "prior-decision-record" });

  const otherAttempt = world.record("inst-1", "revise", { phases: ref(1, "awaiting-approval") });
  const failed = world.record("inst-1", "revise", { phases: ref(0, "failed") });
  const ok = gateEligibility(inst, item, inst.definition, [otherAttempt, failed]);
  assert.equal(ok.ok, true);
});

test("eligibility: on best-of-N only the selected candidate's steps count", () => {
  const inst = gateInstance({
    phase: {
      selectedCandidate: 1,
      steps: [
        { name: "ship", candidate: 0, runId: "c0", status: "aborted" },
        { name: "ship", candidate: 1, runId: "c1", status: "succeeded" },
      ],
    },
  });
  const e = gateEligibility(inst, item, inst.definition, noRecords);
  assert.deepEqual(e, { ok: true, relevantRuns: ["c1"], population: "manual" });
});

// ── Settlement ──────────────────────────────────────────────────────────────

function settleIn(world: ReturnType<typeof gateWorld>, it: GateItem = item) {
  return settle(it, world.instances.get(it.instanceId) ?? null, world.decisions);
}

function newWorld() {
  const world = gateWorld();
  world.put(gateInstance());
  return world;
}

test("settle: an applied operator approval is labeled not-sent-back with a digested reference", () => {
  const world = newWorld();
  const d = world.act("inst-1", "approve");
  const s = settleIn(world);
  assert.equal(s.kind, "labeled");
  if (s.kind !== "labeled") return;
  const { digest, ...rest } = s.reference;
  assert.equal(s.reference.label, "not-sent-back");
  assert.equal(s.reference.value, "approve");
  assert.equal(s.reference.mechanism, "operator");
  assert.deepEqual(s.reference.principal, d.principal);
  assert.equal(s.reference.decisionId, d.id);
  assert.equal(digest, referenceDigest(rest));
  assert.match(s.reference.recordDigest, /^[0-9a-f]{64}$/);
});

test("settle: an applied revise or abort is labeled sent-back", () => {
  for (const decision of ["revise", "abort"] as const) {
    const world = newWorld();
    world.act("inst-1", decision);
    const s = settleIn(world);
    assert.equal(s.kind, "labeled", decision);
    if (s.kind === "labeled") {
      assert.equal(s.reference.label, "sent-back", decision);
      assert.equal(s.reference.value, decision);
    }
  }
});

test("settle: what is not an applied operator decision never becomes a label", () => {
  const unlabeled = (s: ReturnType<typeof settle>) => {
    assert.equal(s.kind, "unlabeled");
    return (s as { reason: string }).reason;
  };
  // A record without a link.
  const w1 = newWorld();
  w1.record("inst-1", "approve");
  assert.equal(unlabeled(settleIn(w1)), "no-applied-decision");
  // Linked, effects still under way: wait, not a label.
  const w2 = newWorld();
  w2.link(w2.record("inst-1", "approve"));
  assert.deepEqual(settleIn(w2), { kind: "wait", reason: "effect-incomplete" });
  // No records.
  assert.equal(unlabeled(settleIn(newWorld())), "no-decision-record");
  // No instance.
  assert.equal(unlabeled(settle(item, null, [])), "instance-gone");
});

test("settle: automated and unattributed mechanisms are not operator actions", () => {
  const auto = newWorld();
  auto.act("inst-1", "approve", { mechanism: "verdict-auto-approve", channel: "verdict-watcher" });
  const a = settleIn(auto);
  assert.equal(a.kind, "unlabeled");
  assert.equal((a as { reason: string }).reason, "automated-approval");

  const unspecified = newWorld();
  unspecified.act("inst-1", "approve", { mechanism: "unspecified" });
  const u = settleIn(unspecified);
  assert.equal(u.kind, "unlabeled");
  assert.equal((u as { reason: string }).reason, "unattributed");
});

test("settle: two applied records for one attempt conflict", () => {
  const world = newWorld();
  world.link(world.record("inst-1", "approve"), false);
  world.link(world.record("inst-1", "revise"), false);
  const s = settleIn(world);
  assert.equal(s.kind, "unlabeled");
  assert.equal((s as { reason: string }).reason, "conflicting-records");
});

test("settle: an unapplied record beside an applied one is listed under others", () => {
  const world = newWorld();
  const stray = world.record("inst-1", "revise");
  world.act("inst-1", "approve");
  const s = settleIn(world);
  assert.equal(s.kind, "labeled");
  if (s.kind !== "labeled") return;
  assert.deepEqual(s.reference.others, [
    { id: stray.id, decision: "revise", mechanism: "operator", effect: "not-applied" },
  ]);
});

test("settle: a record naming another attempt is ignored", () => {
  const world = newWorld();
  world.record("inst-1", "approve", {
    phases: [{ phaseId: "publish", attempt: 1, status: "awaiting-approval", runIds: [] }],
  });
  const s = settleIn(world);
  assert.equal(s.kind, "unlabeled");
  assert.equal((s as { reason: string }).reason, "no-decision-record");
});

// ── Deterministic rules ─────────────────────────────────────────────────────

const readyBaseline = (over: Partial<Baseline> = {}): Baseline => ({
  key: "k",
  scope: "phase",
  name: "n",
  samples: 20,
  warmupRemaining: 0,
  since: null,
  resetAt: null,
  duration: null,
  cost: null,
  tokens: null,
  ...over,
});

function anomalyOf(over: Partial<Anomaly> = {}): Anomaly {
  return {
    id: "k|cost|run-a",
    key: "k",
    scope: "phase",
    name: "n",
    runId: "run-a",
    scheduleId: "pipeline:p1",
    metric: "cost",
    direction: "high",
    severity: "warn",
    value: 0.4,
    median: 0.125,
    ratio: 3.2,
    zScore: null,
    at: at(0),
    detail: "3.2x median cost",
    ...over,
  };
}

function inputOf(
  opts: {
    instance?: PipelineInstance;
    review?: GateReviewInput["review"];
    runs?: GateReviewInput["runs"];
    watchtower?: GateReviewInput["watchtower"];
    changes?: GateReviewInput["changes"];
    phaseDef?: PhaseDef;
  } = {},
): GateReviewInput {
  const instance = opts.instance ?? gateInstance();
  return {
    instance,
    phase: instance.phases[0],
    phaseDef: opts.phaseDef ?? instance.definition!.phases[0],
    review: opts.review ?? { ok: true, review: reviewOf(instance, "publish") },
    runs: opts.runs ?? new Map([["run-a", gateRun("run-a")]]),
    watchtower:
      opts.watchtower === undefined
        ? { anomalies: [], baselines: [readyBaseline()], keyOf: () => "k" }
        : opts.watchtower,
    changes: opts.changes ?? {
      files: { status: "unavailable", reason: "x" },
      diffStat: { status: "unavailable", reason: "x" },
      repository: null,
    },
  };
}

const bodyOf = (input: GateReviewInput) => shapeGateReview(input).projected.body;
const rulesFor = (input: GateReviewInput) => applyGateRules(bodyOf(input));

function reviewWith(
  inst: PipelineInstance,
  extra: Partial<ReturnType<typeof reviewOf>>,
): GateReviewInput["review"] {
  return { ok: true, review: { ...reviewOf(inst, "publish"), ...extra } };
}

const ruleStep = { name: "ship", runId: "run-a", status: "succeeded" as const };

function verificationPreview(over: Partial<RuleVerificationPreview> = {}): RuleVerificationPreview {
  return {
    recordId: "V1",
    runId: "run-a",
    step: "ship",
    attempt: 0,
    status: "staged",
    holds: [],
    violated: [],
    unverifiable: [],
    missing: [],
    ...over,
  };
}

const ruleEntry = (outcome: "holds" | "violated" | "unverifiable", evidence: unknown[]) =>
  ({ ref: "RULE-1:v1", rule: { id: "RULE-1", revision: 1 }, outcome, evidence }) as never;

function knowledgePreview(codes: string[]): KnowledgeDeltaPreview {
  return {
    deltaId: "D1",
    runId: "run-a",
    step: "ship",
    attempt: 0,
    status: "staged",
    proposedClaims: [],
    proposedRevisions: [],
    evidence: [],
    justifications: [],
    consumed: [],
    artifacts: [],
    warnings: codes.map((code) => ({ code, message: `warning ${code}` })) as never,
  };
}

function withVerificationStep(preview: RuleVerificationPreview | null): GateReviewInput {
  const inst = gateInstance({
    phase: { steps: [{ ...ruleStep, ruleVerification: { id: "V1", status: "staged" } }] },
  });
  return inputOf({
    instance: inst,
    review: reviewWith(inst, { ruleVerifications: preview ? [preview] : [] }),
  });
}

function withKnowledgeStep(codes: string[] | null): GateReviewInput {
  const inst = gateInstance({
    phase: { steps: [{ ...ruleStep, knowledgeDelta: { id: "D1", status: "staged" } }] },
  });
  return inputOf({
    instance: inst,
    review: reviewWith(inst, { knowledge: codes ? [knowledgePreview(codes)] : [] }),
  });
}

test("rules: the base input has nothing to flag and nothing unevaluable", () => {
  const r = rulesFor(inputOf());
  assert.equal(r.classification, "no-flag");
  assert.deepEqual(r.fired, []);
  assert.deepEqual(r.unevaluable, []);
});

test("rules: a later attempt and automatic retries each fire their rule", () => {
  const later = rulesFor(inputOf({ instance: gateInstance({ phase: { attempt: 1 } }) }));
  assert.deepEqual(later.fired, ["later-attempt"]);
  assert.equal(later.classification, "flag");
  const retried = rulesFor(inputOf({ instance: gateInstance({ phase: { retries: 2 } }) }));
  assert.deepEqual(retried.fired, ["automatic-retry"]);
  assert.equal(retried.classification, "flag");
});

test("rules: no Watchtower report leaves exactly the two anomaly rules unevaluable", () => {
  const r = rulesFor(inputOf({ watchtower: null }));
  assert.equal(r.classification, "insufficient-data");
  assert.deepEqual(
    r.unevaluable.map((u) => u.rule),
    ["cost-anomaly", "duration-anomaly"],
  );
});

test("rules: a baseline still warming up is insufficient data and names the run", () => {
  const r = rulesFor(
    inputOf({
      watchtower: {
        anomalies: [],
        baselines: [readyBaseline({ warmupRemaining: 3 })],
        keyOf: () => "k",
      },
    }),
  );
  assert.equal(r.classification, "insufficient-data");
  assert.ok(r.unevaluable.length > 0);
  for (const u of r.unevaluable) assert.ok(u.reason.includes("run-a"), u.reason);
});

test("rules: a high cost anomaly fires cost-anomaly and a low one does not", () => {
  const watch = (direction: "high" | "low") => ({
    anomalies: [anomalyOf({ direction })],
    baselines: [readyBaseline()],
    keyOf: () => "k",
  });
  const high = rulesFor(inputOf({ watchtower: watch("high") }));
  assert.ok(high.fired.includes("cost-anomaly"));
  assert.equal(high.classification, "flag");
  const low = rulesFor(inputOf({ watchtower: watch("low") }));
  assert.ok(!low.fired.includes("cost-anomaly"));
  assert.equal(low.classification, "no-flag");
});

test("rules: an unverifiable staged result fires unverifiable-result", () => {
  const r = applyGateRules(
    bodyOf(
      withVerificationStep(verificationPreview({ unverifiable: [ruleEntry("unverifiable", [])] })),
    ),
  );
  assert.ok(r.fired.includes("unverifiable-result"));
  assert.equal(r.classification, "flag");
});

test("rules: a holds entry backed only by observation fires observation-only-holds", () => {
  const observed = rulesFor(
    withVerificationStep(
      verificationPreview({ holds: [ruleEntry("holds", [{ type: "observation", note: "n" }])] }),
    ),
  );
  assert.ok(observed.fired.includes("observation-only-holds"));
  const checked = rulesFor(
    withVerificationStep(
      verificationPreview({ holds: [ruleEntry("holds", [{ type: "check", label: "t" }])] }),
    ),
  );
  assert.ok(!checked.fired.includes("observation-only-holds"));
  assert.equal(checked.classification, "no-flag");
});

test("rules: a grounding warning fires grounding-warning and an advisory one does not", () => {
  const grounding = rulesFor(withKnowledgeStep(["source-file-missing"]));
  assert.ok(grounding.fired.includes("grounding-warning"));
  assert.equal(grounding.classification, "flag");
  const advisory = rulesFor(withKnowledgeStep(["assumption-without-evidence"]));
  assert.ok(!advisory.fired.includes("grounding-warning"));
  assert.equal(advisory.classification, "no-flag");
});

test("rules: a staged sidecar with no preview leaves the staged rules unevaluable", () => {
  const r = rulesFor(withKnowledgeStep(null));
  assert.equal(r.classification, "insufficient-data");
  assert.deepEqual(r.fired, []);
  assert.deepEqual(r.unevaluable.map((u) => u.rule).sort(), [
    "grounding-warning",
    "observation-only-holds",
    "unverifiable-result",
  ]);
});

test("rules: a review model that could not be built leaves the staged rules unevaluable", () => {
  const r = rulesFor(inputOf({ review: { ok: false, reason: "no review" } }));
  assert.equal(r.classification, "insufficient-data");
  assert.deepEqual(r.unevaluable.map((u) => u.rule).sort(), [
    "grounding-warning",
    "observation-only-holds",
    "unverifiable-result",
  ]);
});

// ── Verdict baseline ────────────────────────────────────────────────────────

const rubric: Rubric = { goal: "g", criteria: [{ id: "c", label: "c", weight: 1 }] };

function verdictOf(runId: string, over: Partial<Verdict> = {}): Verdict {
  return {
    id: `V-${runId}`,
    runId,
    scheduleId: "pipeline:p1",
    scheduleName: "Release",
    phaseId: "publish",
    status: "ready",
    at: at(0),
    score: 8,
    criteria: [],
    summary: null,
    regression: false,
    minScore: null,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
    rubricDigest: rubricDigest(rubric),
    ...over,
  };
}

function baselineFor(
  verdicts: Verdict[],
  opts: { phaseDef?: Partial<PhaseDef>; runIds?: string[] } = {},
) {
  const inst = gateInstance({
    runIds: opts.runIds,
    phaseDef: { autoApprove: { verdict: 7 }, rubric, ...opts.phaseDef } as never,
  });
  return verdictBaseline(
    inst.phases[0],
    inst.definition!.phases[0],
    new Map(verdicts.map((v) => [v.runId, v])),
  );
}

test("verdict baseline: no autoApprove or no rubric is not-configured", () => {
  const plain = gateInstance();
  const a = verdictBaseline(plain.phases[0], plain.definition!.phases[0], new Map());
  assert.equal(a.classification, "not-configured");
  assert.equal(a.reason, "no-auto-approve");
  const noRubric = gateInstance({ phaseDef: { autoApprove: { verdict: 7 } } as never });
  const b = verdictBaseline(noRubric.phases[0], noRubric.definition!.phases[0], new Map());
  assert.equal(b.classification, "not-configured");
  assert.equal(b.reason, "no-rubric");
});

test("verdict baseline: a knowledge-committing gate is ineligible", () => {
  const r = baselineFor([], { phaseDef: { discovery: { mode: "x" } as never } });
  assert.equal(r.classification, "ineligible");
  assert.ok(r.reason?.startsWith("knowledge:"), String(r.reason));
});

test("verdict baseline: a missing, mismatched, unready or id-less verdict is insufficient data", () => {
  const reason = (v: Verdict[]) => {
    const r = baselineFor(v);
    assert.equal(r.classification, "insufficient-data");
    return r.reason;
  };
  assert.equal(reason([]), "no-verdict:run-a");
  const other = rubricDigest({ goal: "other", criteria: [{ id: "c", label: "c" }] });
  assert.equal(reason([verdictOf("run-a", { rubricDigest: other })]), "rubric-mismatch:run-a");
  assert.equal(
    reason([verdictOf("run-a", { status: "failed", score: null })]),
    "verdict-not-ready:run-a",
  );
  assert.equal(reason([verdictOf("run-a", { id: undefined })]), "verdict-without-id:run-a");
});

test("verdict baseline: a score under the bar is below-threshold and one over it qualifies", () => {
  const below = baselineFor([verdictOf("run-a", { score: 6 })]);
  assert.equal(below.classification, "below-threshold");
  assert.equal(below.rating, 6);
  assert.equal(below.bar, 7);
  assert.equal(below.basis.length, 1);
  assert.equal(below.basis[0].verdictId, "V-run-a");
  const ok = baselineFor([verdictOf("run-a", { score: 8 })]);
  assert.equal(ok.classification, "qualifies");
  assert.equal(ok.rating, 8);
});

test("verdict baseline: with two relevant steps the minimum score decides", () => {
  const r = baselineFor([verdictOf("run-a", { score: 9 }), verdictOf("run-b", { score: 6 })], {
    runIds: ["run-a", "run-b"],
  });
  assert.equal(r.classification, "below-threshold");
  assert.equal(r.rating, 6);
  assert.equal(r.basis.length, 2);
});

test("verdict baseline: agrees with autoApprovalQualification on the same inputs", () => {
  const inst = gateInstance({ phaseDef: { autoApprove: { verdict: 7 }, rubric } as never });
  const cur = new Map([["run-a", verdictOf("run-a", { score: 8 })]]);
  const q = autoApprovalQualification(inst.phases[0], inst.definition!.phases[0], cur);
  assert.equal(q.status, "qualifies");
  assert.equal(
    verdictBaseline(inst.phases[0], inst.definition!.phases[0], cur).classification,
    q.status,
  );
});

// ── Projection ──────────────────────────────────────────────────────────────

const registry = h1Registry();
const projection = registry.projection("gate-review", 1)!;

function project(input: GateReviewInput, def = projection.def): StoredSnapshot {
  const built = projectGateReview(projection.ref, def, input);
  assert.ok(built.ok, built.ok ? "" : built.detail);
  return built.snapshot;
}

const runsWith = (over: Parameters<typeof gateRun>[1]) =>
  new Map([["run-a", gateRun("run-a", over)]]);

test("projection: a secret in a final message is redacted and counted", () => {
  const snap = project(
    inputOf({ runs: runsWith({ resultSummary: "Done. key sk-ant-abcdefghijklmnop end" }) }),
  );
  const body = snap.content.body as GateReviewBody;
  const msg = (body.steps[0].run as { finalMessage: string }).finalMessage;
  assert.ok(!msg.includes("sk-ant-abcdefghijklmnop"));
  assert.ok(msg.includes("[REDACTED:secret.anthropic-key@1]"));
  const red = snap.content.redactions.find((r) => r.rule === "secret.anthropic-key@1");
  assert.equal(red?.count, 1);
});

test("projection: a long prompt is cut to 4000 code points and the cut is recorded", () => {
  const snap = project(inputOf({ runs: runsWith({ prompt: "x".repeat(10_000) }) }));
  const body = snap.content.body as GateReviewBody;
  const run = body.steps[0].run as { prompt: string };
  assert.equal([...run.prompt].length, 4000);
  const t = snap.content.truncations.find((x) => x.pointer === "/steps/0/run/prompt");
  assert.ok(t);
  assert.equal(t.originalCodePoints, 10_000);
  assert.equal(t.keptCodePoints, 4000);
});

test("projection: a run record that could not be read is unavailable, not empty", () => {
  const body = bodyOf(inputOf({ runs: new Map() }));
  assert.equal(body.steps[0].run.status, "unavailable");
});

test("projection: the result is missing, not-declared or present, never guessed", () => {
  const declared = { result: { fields: {} } } as never;
  const missing = bodyOf(inputOf({ instance: gateInstance({ phaseDef: declared }) }));
  assert.deepEqual(missing.result, { status: "missing" });
  assert.deepEqual(bodyOf(inputOf()).result, { status: "not-declared" });
  const present = bodyOf(
    inputOf({ instance: gateInstance({ phaseDef: declared, phase: { result: { ok: true } } }) }),
  );
  assert.deepEqual(present.result, { status: "present", json: '{"ok":true}' });
});

test("projection: verification is missing when checks are declared and no report exists", () => {
  const checks = [{ kind: "command", run: "npm test" }] as never;
  const declared = bodyOf(inputOf({ instance: gateInstance({ phaseDef: { checks } }) }));
  assert.deepEqual(declared.verification, { status: "missing" });
  assert.deepEqual(bodyOf(inputOf()).verification, { status: "not-declared" });
});

test("projection: no gate-decision record, id or pending operation reaches the snapshot", () => {
  const inst = gateInstance();
  inst.gateDecisionIds = ["GD-9"];
  inst.pendingGateOperation = {
    decisionId: "GD-9",
    decision: "revise",
    phaseId: "publish",
    attempt: 0,
    stopRunIds: [],
    startedAt: at(0),
  };
  const snap = project(inputOf({ instance: inst }));
  assert.ok(!JSON.stringify(snap.content).includes("GD-"));
  assert.deepEqual(snap.content.subject, {
    kind: "phase-attempt",
    instanceId: "inst-1",
    phaseId: "publish",
    attempt: 0,
  });
});

test("projection: the final message is marked as text the subject authored", () => {
  const snap = project(inputOf());
  assert.ok(snap.content.subjectAuthored.includes("/steps/0/run/finalMessage"));
});

test("projection: the review-state digest ignores capture-time context", () => {
  const base = reviewStateDigest(project(inputOf()));
  const moved = reviewStateDigest(
    project(inputOf({ runs: runsWith({ costUsd: 9.9, tokens: 123_456, durationMs: 5 * MIN }) })),
  );
  assert.equal(moved, base);
  const anomalous = reviewStateDigest(
    project(
      inputOf({
        watchtower: { anomalies: [anomalyOf()], baselines: [readyBaseline()], keyOf: () => "k" },
      }),
    ),
  );
  assert.equal(anomalous, base);
});

test("projection: the review-state digest moves with the material state of the gate", () => {
  const base = reviewStateDigest(project(inputOf()));
  const message = reviewStateDigest(
    project(inputOf({ runs: runsWith({ resultSummary: "Changed my mind." }) })),
  );
  assert.notEqual(message, base);
  const declared = { result: { fields: {} } } as never;
  const resultA = reviewStateDigest(
    project(
      inputOf({ instance: gateInstance({ phaseDef: declared, phase: { result: { ok: true } } }) }),
    ),
  );
  const resultB = reviewStateDigest(
    project(
      inputOf({ instance: gateInstance({ phaseDef: declared, phase: { result: { ok: false } } }) }),
    ),
  );
  assert.notEqual(resultA, resultB);
  const files = (paths: string[]) =>
    reviewStateDigest(
      project(
        inputOf({
          changes: {
            files: { status: "available", source: "attempt-worktree", paths },
            diffStat: { status: "unavailable", reason: "x" },
            repository: null,
          },
        }),
      ),
    );
  assert.notEqual(files(["a.ts"]), files(["a.ts", "b.ts"]));
});

test("projection: a body over the projection's ceiling is too-large", () => {
  const built = projectGateReview(projection.ref, { ...GATE_REVIEW_V1, maxBytes: 500 }, inputOf());
  assert.equal(built.ok, false);
  assert.equal((built as { reason: string }).reason, "too-large");
});

test("projection: changed paths are de-duplicated, sorted and capped at 100", () => {
  const all = Array.from({ length: 150 }, (_, i) => `src/f${String(i).padStart(3, "0")}.ts`);
  const paths = [...all].reverse().concat(all.slice(0, 10));
  const body = bodyOf(
    inputOf({
      changes: {
        files: { status: "available", source: "attempt-worktree", paths },
        diffStat: { status: "unavailable", reason: "x" },
        repository: null,
      },
    }),
  );
  assert.equal(body.changes.files.status, "available");
  const f = body.changes.files as { total: number; paths: string[] };
  assert.equal(f.total, 150);
  assert.equal(f.paths.length, 100);
  assert.deepEqual(f.paths, all.slice(0, 100));
});

// ── Registry ────────────────────────────────────────────────────────────────

test("registry: gate.operator-action@1 is a consumer-less binary question on gate-review@1", () => {
  const q = h1Registry().question("gate.operator-action", 1);
  assert.ok(q);
  assert.deepEqual(q.def.answers, { shape: "binary" });
  assert.deepEqual(q.def.consumers, []);
  assert.deepEqual(q.def.projection, { id: "gate-review", version: 1 });
  assert.equal(q.def.subject, "phase-attempt");
  const p = h1Registry().projection("gate-review", 1);
  assert.ok(p);
  assert.equal(p.def.subject, "phase-attempt");
});

test("registry: the built-in registry lists H2 questions and their historical versions", () => {
  assert.deepEqual(
    builtinRegistry()
      .questions()
      .map((q) => `${q.id}@${q.version}`),
    ["run.failure-cause.residual@1", "run.termination-probe@1", "run.termination-probe@2"],
  );
});
