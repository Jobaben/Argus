import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AnswerSpace, DecisionOutcome } from "@argus/contracts";
import { canonicalDigest } from "./canonical.js";
import { BUILTIN_BUILDERS } from "./definitions.js";
import { createMockProvider } from "./providers/mock.js";
import { createDecisionReader } from "./reader.js";
import { createPolicyPreparer, type PolicyPreparationInput } from "./policyPreparation.js";
import { harness, RESIDUAL_P } from "./testSupport.js";

function files(root: string): unknown {
  return readdirSync(root, { withFileTypes: true }).map((entry) => {
    const file = path.join(root, entry.name);
    return [entry.name, entry.isDirectory() ? files(file) : readFileSync(file).toString("base64")];
  });
}

async function fixture() {
  const provider = createMockProvider({ script: [{ distribution: RESIDUAL_P }] });
  const h = harness({ providers: { mock: provider } });
  const result = await h.service.assess({
    question: "run.failure-cause.residual",
    version: 1,
    subject: { kind: "run", runId: "run-1" },
    provider: "mock",
  });
  assert.ok(result.ok);
  const a = result.assessment;
  const reader = createDecisionReader({
    journal: h.journal,
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    consumers: [
      {
        id: "fixture",
        question: a.question,
        projection: a.snapshot.projection,
        providers: [a.provider],
      },
    ],
  });
  const advisory = await reader.read({
    assessmentId: a.id,
    consumerId: "fixture",
    subject: a.subject,
  });
  assert.ok(advisory.ok && advisory.value.usable);
  const rule = {
    id: "fixture.friction",
    version: 1,
    question: a.question,
    projection: a.snapshot.projection,
    provider: a.provider,
    targetAnswer: {
      kind: "probability" as const,
      shape: "choice" as const,
      optionId: "missing-context",
    },
    comparison: ">=" as const,
    threshold: 0.7,
    effect: "flag" as const,
  };
  return {
    ...h,
    provider,
    input: { rule, advisory, target: { subject: a.subject, stateDigest: "a".repeat(64) } },
  };
}

test("real reader preparation is deterministic, immutable and performs no reads, calls or writes", async () => {
  const h = await fixture();
  const before = files(h.root);
  const reads = { ...h.mem.reads };
  const prepare = createPolicyPreparer({ registry: h.registry }).prepare;
  const first = prepare(h.input);
  assert.ok(first.ok);
  assert.equal(first.value.matched, true);
  assert.equal(first.value.probability, 0.7);
  assert.equal(first.value.applied, false);
  assert.equal(first.value.intent?.applied, false);
  assert.deepEqual(first, prepare(h.input));
  assert.ok(Object.isFrozen(first.value.intent?.target.subject));
  h.input.target.subject = { kind: "run", runId: "changed" };
  assert.equal(first.value.intent?.target.subject.kind, "run");
  assert.deepEqual(first.value.intent?.target.subject, { kind: "run", runId: "run-1" });
  assert.deepEqual(h.mem.reads, reads);
  assert.equal(h.provider.calls.length, 1);
  assert.deepEqual(files(h.root), before);
});

test("below threshold is evaluated without an intent; malformed evidence is refused", async () => {
  const h = await fixture();
  const prepare = createPolicyPreparer({ registry: h.registry }).prepare;
  h.input.rule.threshold = 0.8;
  const result = prepare(h.input);
  assert.ok(result.ok);
  assert.equal(result.value.matched, false);
  assert.equal(result.value.intent, undefined);
  assert.equal(prepare(null as never).ok, false);
  assert.equal(
    prepare({ ...h.input, target: { ...h.input.target, stateDigest: "invalid" } }).ok,
    false,
  );
});

async function answerFixture(answers: AnswerSpace, outcome: DecisionOutcome) {
  const h = await fixture();
  const input: PolicyPreparationInput = structuredClone(h.input);
  assert.ok(input.advisory.ok);
  const registered = h.registry.question(input.rule.question.id, input.rule.question.version)!;
  const question = h.registry.registerQuestion({
    ...registered.def,
    id: "fixture.answer",
    answers,
  });
  const a = input.advisory.value.assessment;
  a.question = question;
  a.outcome = outcome;
  input.rule.question = question;
  input.rule.targetAnswer = { kind: "probability", shape: "binary", event: "p" };
  input.advisory.value.provenance.digest = canonicalDigest({ body: a, kind: "assessment" }).sha256;
  return { ...h, input };
}

test("canonical arrays cannot impersonate string enums", async () => {
  const h = await fixture();
  const input = structuredClone(h.input);
  (input.rule as unknown as { effect: unknown }).effect = ["flag"];
  assert.equal(createPolicyPreparer({ registry: h.registry }).prepare(input).ok, false);
});

test("binary p is selected directly and the prepared digest binds every field", async () => {
  const h = await answerFixture(
    { shape: "binary" },
    {
      status: "answered",
      answer: { kind: "probability", shape: "binary", p: 0.7 },
      providerStatistics: { confidence: 0.01 },
    },
  );
  const result = createPolicyPreparer({ registry: h.registry }).prepare(h.input);
  assert.ok(result.ok && result.value.intent);
  assert.equal(result.value.probability, 0.7);
  const { digest, ...body } = result.value.intent;
  assert.equal(digest, canonicalDigest(body).sha256);
  assert.deepEqual(result.value.intent.targetAnswer, {
    kind: "probability",
    shape: "binary",
    event: "p",
  });
  assert.equal(result.value.rule.digest, canonicalDigest(h.input.rule).sha256);
});

test("ratings and probability scales cannot be used as policy probabilities", async () => {
  for (const outcome of [
    { status: "answered", answer: { kind: "rating", value: 7, scale: { min: 0, max: 10 } } },
    {
      status: "answered",
      answer: { kind: "probability", shape: "scale", p: { "0": 0.3, "1": 0.7 } },
    },
  ] satisfies DecisionOutcome[]) {
    const h = await answerFixture(
      { shape: "scale", points: [{ value: 0 }, { value: 1 }], sumTolerance: 0.01 },
      outcome,
    );
    assert.equal(createPolicyPreparer({ registry: h.registry }).prepare(h.input).ok, false);
  }
});

test("missing, tampered and superseded registry definitions are refused", async () => {
  const h = await fixture();
  const registry = h.registry;
  assert.equal(
    createPolicyPreparer({ registry: { ...registry, question: () => null } }).prepare(h.input).ok,
    false,
  );
  assert.equal(
    createPolicyPreparer({ registry: { ...registry, projection: () => null } }).prepare(h.input).ok,
    false,
  );
  assert.equal(
    createPolicyPreparer({ registry: { ...registry, latestQuestion: () => null } }).prepare(h.input)
      .ok,
    false,
  );
  const q = registry.question(h.input.rule.question.id, 1)!;
  const p = registry.projection(h.input.rule.projection.id, 1)!;
  assert.equal(
    createPolicyPreparer({
      registry: { ...registry, question: () => ({ ...q, def: { ...q.def, text: "tampered" } }) },
    }).prepare(h.input).ok,
    false,
  );
  assert.equal(
    createPolicyPreparer({
      registry: {
        ...registry,
        projection: () => ({ ...p, def: { ...p.def, maxBytes: p.def.maxBytes + 1 } }),
      },
    }).prepare(h.input).ok,
    false,
  );
  assert.equal(
    createPolicyPreparer({
      registry: {
        ...registry,
        latestQuestion: () => ({ ...q, def: { ...q.def, text: "tampered latest" } }),
      },
    }).prepare(h.input).ok,
    false,
  );
  registry.registerQuestion({ ...q.def, version: 2 });
  assert.equal(createPolicyPreparer({ registry }).prepare(h.input).ok, false);
});
