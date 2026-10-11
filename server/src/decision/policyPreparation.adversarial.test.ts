import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { BUILTIN_BUILDERS } from "./definitions.js";
import { createPolicyPreparer, type PolicyPreparationRule } from "./policyPreparation.js";
import { createMockProvider } from "./providers/mock.js";
import { createDecisionReader, type AdvisoryAssessment } from "./reader.js";
import { harness, RESIDUAL_P } from "./testSupport.js";

function files(root: string): Array<[string, string]> {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry): Array<[string, string]> => {
      const file = path.join(root, entry.name);
      return entry.isDirectory() ? files(file) : [[file, readFileSync(file).toString("base64")]];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

async function fixture() {
  const provider = createMockProvider({ script: [{ distribution: RESIDUAL_P }] });
  const h = harness({ providers: { mock: provider } });
  const assessed = await h.service.assess({
    question: "run.failure-cause.residual",
    version: 1,
    subject: { kind: "run", runId: "run-1" },
    provider: "mock",
  });
  assert.ok(assessed.ok);
  const assessment = assessed.assessment;
  const reader = createDecisionReader({
    journal: h.journal,
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    consumers: [
      {
        id: "adversarial-fixture",
        question: assessment.question,
        projection: assessment.snapshot.projection,
        providers: [assessment.provider],
      },
    ],
  });
  const advisory = await reader.read({
    assessmentId: assessment.id,
    consumerId: "adversarial-fixture",
    subject: assessment.subject,
  });
  assert.ok(advisory.ok);
  assert.equal(advisory.value.usable, true);
  const rule: PolicyPreparationRule = {
    id: "fixture-choice-friction",
    version: 1,
    question: assessment.question,
    projection: assessment.snapshot.projection,
    provider: assessment.provider,
    targetAnswer: { kind: "probability", shape: "choice", optionId: "missing-context" },
    comparison: ">=",
    threshold: 0.7,
    effect: "flag",
  };
  const target = { subject: assessment.subject, stateDigest: "a".repeat(64) };
  return {
    ...h,
    provider,
    reader,
    rule,
    advisory,
    target,
    preparer: createPolicyPreparer({ registry: h.registry }),
  };
}

const counterfeitCases: Array<[string, (value: AdvisoryAssessment) => void]> = [
  [
    "failed outcome",
    (v) => {
      v.assessment.outcome = { status: "failed", failure: "timeout", detail: "fixture" };
    },
  ],
  [
    "abstained outcome",
    (v) => {
      v.assessment.outcome = { status: "abstained", reason: "fixture" };
    },
  ],
  [
    "stale reason",
    (v) => {
      v.reasons.push("stale");
    },
  ],
  [
    "stale presentation",
    (v) => {
      v.presentation = "stale";
    },
  ],
  [
    "historical presentation",
    (v) => {
      v.presentation = "historical";
    },
  ],
  [
    "unavailable currency",
    (v) => {
      v.currency.status = "unavailable";
    },
  ],
  [
    "stale currency check",
    (v) => {
      v.currency.checks[0].status = "stale";
    },
  ],
  [
    "missing currency checks",
    (v) => {
      v.currency.checks = [];
    },
  ],
  [
    "wrong currency assessment",
    (v) => {
      v.currency.assessmentId = "DA-other000001";
    },
  ],
  [
    "journal integrity notice",
    (v) => {
      v.integrity.notices.push({ kind: "seal-mismatch", detail: "fixture" });
    },
  ],
  [
    "unavailable retained snapshot",
    (v) => {
      v.retained = { status: "unavailable" };
    },
  ],
  [
    "corrupt retained snapshot",
    (v) => {
      v.retained = { status: "corrupt", detail: "fixture" };
    },
  ],
  [
    "wrong assessment provenance",
    (v) => {
      v.provenance.digest = "0".repeat(64);
    },
  ],
  [
    "wrong retained byte count",
    (v) => {
      if (v.retained.status === "retained") v.retained.snapshot.bytes++;
    },
  ],
  [
    "changed retained body",
    (v) => {
      if (v.retained.status === "retained") v.retained.snapshot.content.body = { forged: true };
    },
  ],
];

test("counterfeit usable/current flags cannot override contradictory evidence", async () => {
  const h = await fixture();
  for (const [label, damage] of counterfeitCases) {
    const advisory = structuredClone(h.advisory);
    damage(advisory.value);
    advisory.value.usable = true;
    assert.equal(h.preparer.prepare({ rule: h.rule, advisory, target: h.target }).ok, false, label);
  }
});

test("probability threshold uses inclusive comparison without rounding", async () => {
  const h = await fixture();
  for (const [threshold, matched] of [
    [0, true],
    [0.7 - Number.EPSILON, true],
    [0.7, true],
    [0.7 + Number.EPSILON, false],
    [1, false],
  ] as const) {
    const result = h.preparer.prepare({
      rule: { ...h.rule, threshold },
      advisory: h.advisory,
      target: h.target,
    });
    assert.ok(result.ok);
    assert.equal(result.value.probability, 0.7);
    assert.equal(result.value.matched, matched);
    assert.equal(result.value.applied, false);
    assert.equal(Boolean(result.value.intent), matched);
  }
});

test("caller cannot substitute a different answer shape, event or statistic", async () => {
  const h = await fixture();
  for (const targetAnswer of [
    { kind: "probability", shape: "choice", optionId: "confidence" },
    { kind: "probability", shape: "binary", event: "p" },
    { kind: "rating", shape: "choice", optionId: "missing-context" },
    { kind: "probability", shape: "scale", optionId: "missing-context" },
  ]) {
    const rule = { ...h.rule, targetAnswer } as PolicyPreparationRule;
    assert.equal(h.preparer.prepare({ rule, advisory: h.advisory, target: h.target }).ok, false);
  }
  const result = h.preparer.prepare({
    rule: {
      ...h.rule,
      targetAnswer: { kind: "probability", shape: "choice", optionId: "environment" },
    },
    advisory: h.advisory,
    target: h.target,
  });
  assert.ok(result.ok);
  assert.equal(result.value.probability, 0.1);
  assert.equal(result.value.matched, false);
});

test("complete provider identity and target subject remain exact", async () => {
  const h = await fixture();
  for (const provider of [
    { ...h.rule.provider, requestedModel: "different" },
    { ...h.rule.provider, reportedModel: "different" },
    { ...h.rule.provider, adapterVersion: h.rule.provider.adapterVersion + 1 },
    { ...h.rule.provider, elicitation: "sampled" as const },
  ]) {
    assert.equal(
      h.preparer.prepare({ rule: { ...h.rule, provider }, advisory: h.advisory, target: h.target })
        .ok,
      false,
    );
  }
  assert.equal(
    h.preparer.prepare({
      rule: h.rule,
      advisory: h.advisory,
      target: { ...h.target, subject: { kind: "run", runId: "other-run" } },
    }).ok,
    false,
  );
});

test("definition id, version and digest drift each refuse independently", async () => {
  const h = await fixture();
  for (const field of ["question", "projection"] as const) {
    for (const patch of [{ id: "other-definition" }, { version: 2 }, { digest: "0".repeat(64) }]) {
      const rule = { ...h.rule, [field]: { ...h.rule[field], ...patch } };
      assert.equal(
        h.preparer.prepare({ rule, advisory: h.advisory, target: h.target }).ok,
        false,
        `${field} ${Object.keys(patch)[0]}`,
      );
    }
  }
});

test("duplicate currency checks cannot stand in for complete current checks", async () => {
  const h = await fixture();
  const advisory = structuredClone(h.advisory);
  advisory.value.currency.checks.push(structuredClone(advisory.value.currency.checks[0]));
  assert.equal(h.preparer.prepare({ rule: h.rule, advisory, target: h.target }).ok, false);
});

test("malformed canonical inputs refuse without invoking an accessor", async () => {
  const h = await fixture();
  let accessorCalls = 0;
  const accessorTarget = { subject: h.target.subject };
  Object.defineProperty(accessorTarget, "stateDigest", {
    enumerable: true,
    get() {
      accessorCalls++;
      return h.target.stateDigest;
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = new Array(2);
  sparse[1] = "present";
  for (const target of [
    accessorTarget,
    cycle,
    new Date(0),
    sparse,
    { ...h.target, unexpected: undefined },
    { ...h.target, [Symbol("hidden")]: true },
  ]) {
    assert.equal(
      h.preparer.prepare({ rule: h.rule, advisory: h.advisory, target: target as typeof h.target })
        .ok,
      false,
    );
  }
  assert.equal(accessorCalls, 0);
});

test("malformed runtime thresholds and unsupported rule operations refuse", async () => {
  const h = await fixture();
  for (const threshold of [NaN, Infinity, -Infinity, -0, -0.1, 1.1, "0.7", null]) {
    const rule = { ...h.rule, threshold } as PolicyPreparationRule;
    assert.equal(h.preparer.prepare({ rule, advisory: h.advisory, target: h.target }).ok, false);
  }
  for (const extension of [
    { comparison: ">" },
    { aggregate: "latest-current" },
    { effect: "approve" },
  ]) {
    const rule = { ...h.rule, ...extension } as PolicyPreparationRule;
    assert.equal(h.preparer.prepare({ rule, advisory: h.advisory, target: h.target }).ok, false);
  }
});

test("preparation remains deterministic and deeply immutable without store effects", async () => {
  const h = await fixture();
  const before = files(h.root);
  const calls = h.provider.calls.length;
  const reads = { ...h.mem.reads };
  const input = structuredClone({ rule: h.rule, advisory: h.advisory, target: h.target });
  const original = structuredClone(input);
  const first = h.preparer.prepare(input);
  assert.ok(first.ok);
  assert.ok(first.value.intent);
  assert.equal(first.value.intent.status, "prepared");
  assert.equal(first.value.intent.applied, false);
  assert.equal(first.value.intent.authority, "inference-only");
  assert.equal(first.value.intent.assessmentId, original.advisory.value.assessment.id);
  assert.equal(first.value.intent.assessmentDigest, original.advisory.value.provenance.digest);
  assert.deepEqual(first.value.intent.question, original.rule.question);
  assert.deepEqual(first.value.intent.projection, original.rule.projection);
  assert.deepEqual(first.value.intent.provider, original.rule.provider);
  assert.deepEqual(first.value.intent.target, original.target);
  assert.deepEqual(first.value.intent.targetAnswer, original.rule.targetAnswer);
  assert.deepEqual(first.value.intent.snapshot, original.advisory.value.assessment.snapshot);
  assert.deepEqual(input, original);
  assert.deepEqual(h.preparer.prepare(input), first);
  assert.ok(Object.isFrozen(first));
  function frozen(value: unknown): void {
    if (value && typeof value === "object") {
      assert.ok(Object.isFrozen(value));
      for (const child of Object.values(value)) frozen(child);
    }
  }
  frozen(first);
  const saved = structuredClone(first);
  input.rule.threshold = 0.8;
  input.rule.provider.requestedModel = "mutated";
  input.target.stateDigest = "b".repeat(64);
  input.target.subject = { kind: "run", runId: "changed" };
  assert.deepEqual(first, saved);
  const changed = h.preparer.prepare({
    ...original,
    target: { ...original.target, stateDigest: "b".repeat(64) },
  });
  assert.ok(changed.ok);
  assert.ok(changed.value.intent);
  assert.notEqual(changed.value.intent.digest, first.value.intent.digest);
  assert.deepEqual(files(h.root), before);
  assert.equal(h.provider.calls.length, calls);
  assert.deepEqual(h.mem.reads, reads);
});
