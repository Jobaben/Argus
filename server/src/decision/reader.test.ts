import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { DecisionAssessment, DecisionSubject } from "@argus/contracts";
import { canonicalDigest } from "./canonical.js";
import { BUILTIN_BUILDERS } from "./definitions.js";
import { createMockProvider, type MockStep } from "./providers/mock.js";
import { createDecisionReader, type AdvisoryConsumer } from "./reader.js";
import { replay } from "./replay.js";
import { harness, RESIDUAL_P } from "./testSupport.js";

function files(root: string): Array<[string, string]> {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((e): Array<[string, string]> => {
      const p = path.join(root, e.name);
      return e.isDirectory() ? files(p) : [[p, readFileSync(p).toString("base64")]];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}
async function setup(step: MockStep = { distribution: RESIDUAL_P }) {
  const provider = createMockProvider({ script: [step] });
  const h = harness({ providers: { mock: provider } });
  const result = await h.service.assess({
    question: "run.failure-cause.residual",
    version: 1,
    subject: { kind: "run", runId: "run-1" },
    provider: "mock",
  });
  assert.ok(result.ok);
  const a = result.assessment;
  const consumer: AdvisoryConsumer = {
    id: "test-advisory",
    question: a.question,
    projection: a.snapshot.projection,
    providers: [a.provider],
  };
  const reader = createDecisionReader({
    journal: h.journal,
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    consumers: [consumer],
  });
  const read = (subject: DecisionSubject = a.subject) =>
    reader.read({ assessmentId: a.id, consumerId: consumer.id, subject });
  return { ...h, a, consumer, provider, reader, read };
}

test("advisory reads and replay are deterministic, never write or call providers", async () => {
  const h = await setup();
  const before = files(h.root);
  const replayBefore = await replay(h.journal, h.registry);
  const first = await h.read();
  assert.ok(first.ok);
  assert.equal(first.value.presentation, "current");
  assert.equal(first.value.usable, true);
  assert.equal(first.value.cost.status, "unknown");
  assert.equal(first.value.cost.usd, null);
  assert.deepEqual(first, await h.read());
  assert.equal(await replay(h.journal, h.registry), replayBefore);
  assert.deepEqual(files(h.root), before);
  assert.equal(h.provider.calls.length, 1);
});

test("missing live sources preserve retained historical inference without current usability", async () => {
  const h = await setup();
  h.mem.runs.delete("run-1");
  const result = await h.read();
  assert.ok(result.ok);
  assert.equal(result.value.presentation, "historical");
  assert.equal(result.value.currency.status, "unavailable");
  assert.equal(result.value.retained.status, "retained");
  assert.equal(result.value.usable, false);
});

test("changed sources make retained inference stale", async () => {
  const h = await setup();
  h.mem.runs.get("run-1")!.prompt = "Different task";
  const result = await h.read();
  assert.ok(result.ok);
  assert.equal(result.value.presentation, "stale");
  assert.equal(result.value.usable, false);
});

for (const step of [
  { throws: "no output" },
  { abstain: "cannot assess" },
  { distribution: { invalid: 1 } },
] satisfies MockStep[]) {
  test(`failed or abstained inference cannot become usable: ${JSON.stringify(step)}`, async () => {
    const h = await setup(step);
    const result = await h.read();
    assert.ok(result.ok);
    assert.equal(result.value.usable, false);
    assert.ok(result.value.reasons.some((r) => r === "failed" || r === "abstained"));
    assert.equal(result.value.assessment.costUsd, null);
  });
}

for (const damage of ["corrupt", "pruned"] as const) {
  test(`retained snapshot ${damage} cannot become current through reconstruction`, async () => {
    const h = await setup();
    const snapshotFile = files(h.root).find(([p]) => p.endsWith(`${h.a.snapshot.sha256}.json`))![0];
    if (damage === "corrupt") writeFileSync(snapshotFile, "damaged");
    else unlinkSync(snapshotFile);
    const result = await h.read();
    assert.ok(result.ok);
    assert.equal(result.value.presentation, "unavailable");
    assert.equal(result.value.currency.status, "current");
    assert.equal(result.value.usable, false);
    assert.ok(
      result.value.reasons.includes(
        damage === "corrupt" ? "snapshot-corrupt" : "snapshot-unavailable",
      ),
    );
  });
}

test("subject and complete provider identity are exact, never inferred from provider kind", async () => {
  const h = await setup();
  const wrong = await h.read({ kind: "run", runId: "other" });
  assert.deepEqual(wrong, { ok: false, reason: "subject-mismatch" });
  const reader = createDecisionReader({
    journal: h.journal,
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    consumers: [{ ...h.consumer, providers: [{ ...h.a.provider, adapterVersion: 99 }] }],
  });
  const result = await reader.read({
    assessmentId: h.a.id,
    consumerId: h.consumer.id,
    subject: h.a.subject,
  });
  assert.deepEqual(result, { ok: false, reason: "unsupported-provider" });
});

test("snapshot with valid digest but a different subject is unusable", async () => {
  const h = await setup();
  const found = await h.journal.loadSnapshot(h.a.snapshot.sha256);
  assert.equal(found.status, "retained");
  if (found.status !== "retained") return;
  const content = { ...found.snapshot.content, subject: { kind: "run", runId: "other" } as const };
  const sealed = canonicalDigest(content);
  const a: DecisionAssessment = {
    ...h.a,
    snapshot: { ...h.a.snapshot, sha256: sealed.sha256, bytes: sealed.bytes },
  };
  const view = await h.journal.read();
  const reader = createDecisionReader({
    journal: {
      read: async () => ({ ...view, entries: [{ ...view.entries[0], assessment: a }] }),
      loadSnapshot: async () => ({
        status: "retained",
        store: "active",
        snapshot: { content, sha256: sealed.sha256, bytes: sealed.bytes },
      }),
    },
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    consumers: [h.consumer],
  });
  const result = await reader.read({
    assessmentId: a.id,
    consumerId: h.consumer.id,
    subject: a.subject,
  });
  assert.ok(result.ok);
  assert.equal(result.value.usable, false);
  assert.ok(result.value.reasons.includes("snapshot-identity-mismatch"));
});

test("older phase attempts stay historical records and become stale", async () => {
  const h = await setup();
  const projection = {
    id: "reader-phase",
    version: 1,
    subject: "phase-attempt" as const,
    description: "fixture",
    maxBytes: 4096,
    redactionRules: [],
    truncation: { rule: "none", caps: {} },
    withheld: [],
  };
  h.registry.registerProjection(projection);
  h.registry.registerQuestion({
    id: "reader.phase",
    version: 1,
    text: "Review?",
    answers: { shape: "binary" },
    subject: "phase-attempt",
    projection,
    consumers: [],
  });
  const subject = {
    kind: "phase-attempt" as const,
    instanceId: "instance-1",
    phaseId: "phase-1",
    attempt: 1,
  };
  const content = {
    format: "argus.decision-snapshot" as const,
    formatVersion: 1 as const,
    projection: h.registry.projection(projection.id, 1)!.ref,
    subject,
    refs: { runs: [], claims: [], verifications: [], artifacts: [] },
    subjectAuthored: [],
    redactions: [],
    truncations: [],
    body: { candidate: 0 },
  };
  const sealed = canonicalDigest(content);
  const snapshot = { content, sha256: sealed.sha256, bytes: sealed.bytes };
  const a: DecisionAssessment = {
    ...h.a,
    id: "DA-phase000001",
    question: h.registry.question("reader.phase", 1)!.ref,
    subject,
    snapshot: { sha256: snapshot.sha256, bytes: snapshot.bytes, projection: content.projection },
    outcome: { status: "answered", answer: { kind: "probability", shape: "binary", p: 0.2 } },
  };
  await h.journal.append(a, snapshot);
  const reader = createDecisionReader({
    journal: h.journal,
    registry: h.registry,
    builders: [],
    sources: {
      ...h.sources,
      readInstance: async () =>
        ({ id: subject.instanceId, phases: [{ id: subject.phaseId, attempt: 2 }] }) as never,
    },
    consumers: [
      {
        id: "phase-advisory",
        question: a.question,
        projection: a.snapshot.projection,
        providers: [a.provider],
      },
    ],
  });
  const result = await reader.read({ assessmentId: a.id, subject, consumerId: "phase-advisory" });
  assert.ok(result.ok);
  assert.equal(result.value.presentation, "stale");
  assert.equal(result.value.usable, false);
  assert.equal(result.value.currency.checks.find((c) => c.check === "subject")!.status, "stale");
});

test("question and projection digests are required by the declared consumer", async () => {
  const h = await setup();
  for (const field of ["question", "projection"] as const) {
    const consumer = { ...h.consumer, [field]: { ...h.consumer[field], digest: "0".repeat(64) } };
    const reader = createDecisionReader({
      journal: h.journal,
      registry: h.registry,
      builders: BUILTIN_BUILDERS,
      sources: h.sources,
      consumers: [consumer],
    });
    assert.deepEqual(
      await reader.read({ assessmentId: h.a.id, consumerId: consumer.id, subject: h.a.subject }),
      {
        ok: false,
        reason: field === "question" ? "unsupported-question" : "unsupported-projection",
      },
    );
  }
});

test("journal damage is exposed and never favorable evidence", async () => {
  const h = await setup();
  const view = await h.journal.read();
  const reader = createDecisionReader({
    journal: {
      read: async () => ({
        ...view,
        notices: [{ kind: "seal-mismatch", detail: "fixture damage" }],
      }),
      loadSnapshot: (sha) => h.journal.loadSnapshot(sha),
    },
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    consumers: [h.consumer],
  });
  const result = await reader.read({
    assessmentId: h.a.id,
    consumerId: h.consumer.id,
    subject: h.a.subject,
  });
  assert.ok(result.ok);
  assert.equal(result.value.presentation, "unavailable");
  assert.ok(result.value.reasons.includes("journal-integrity"));
});

test("missing transcript is unavailable rather than an empty current input", async () => {
  const h = await setup();
  h.mem.transcripts.set("run-1", null);
  const result = await h.read();
  assert.ok(result.ok);
  assert.equal(result.value.presentation, "historical");
  assert.ok(result.value.reasons.includes("currency-unavailable"));
});

test("absence and refusals remain typed without journal mutation", async () => {
  const h = await setup();
  const before = files(h.root);
  assert.deepEqual(
    await h.reader.read({
      assessmentId: "DA-missing0001",
      consumerId: h.consumer.id,
      subject: h.a.subject,
    }),
    { ok: false, reason: "unknown-assessment" },
  );
  assert.deepEqual(
    await h.reader.read({ assessmentId: h.a.id, consumerId: "other", subject: h.a.subject }),
    { ok: false, reason: "unknown-consumer" },
  );
  assert.deepEqual(
    await h.reader.read({
      assessmentId: "../invalid",
      consumerId: h.consumer.id,
      subject: h.a.subject,
    }),
    { ok: false, reason: "invalid-id" },
  );
  assert.deepEqual(files(h.root), before);
});

for (const [field, replacement] of [
  ["snapshot", (a: DecisionAssessment) => ({ sha256: a.snapshot.sha256, bytes: a.snapshot.bytes })],
  ["provider", () => ({ provider: "mock" })],
  ["subject", () => ({ kind: "run" })],
  ["question", (a: DecisionAssessment) => ({ ...a.question, version: 0 })],
  ["outcome", () => ({ status: "unexpected-status" })],
  ["outcome", () => ({ status: "answered" })],
] as const) {
  test(`real journal malformed ${field} is a typed refusal rather than a reader exception: ${replacement.toString()}`, async () => {
    const h = await setup();
    const retained = await h.journal.loadSnapshot(h.a.snapshot.sha256);
    assert.equal(retained.status, "retained");
    if (retained.status !== "retained") return;
    const bad = { ...h.a, id: "DA-malformed0001", [field]: replacement(h.a) } as DecisionAssessment;
    await h.journal.append(bad, retained.snapshot);
    assert.ok((await h.journal.read()).entries.some((e) => e.assessment.id === bad.id));
    const before = files(h.root);
    assert.deepEqual(
      await h.reader.read({
        assessmentId: bad.id,
        consumerId: h.consumer.id,
        subject: h.a.subject,
      }),
      { ok: false, reason: "malformed-assessment" },
    );
    assert.deepEqual(files(h.root), before);
  });
}

test("retained valid-digest snapshot lacking required reference arrays is unavailable", async () => {
  const h = await setup();
  const found = await h.journal.loadSnapshot(h.a.snapshot.sha256);
  assert.equal(found.status, "retained");
  if (found.status !== "retained") return;
  const content = { ...found.snapshot.content };
  delete (content as Partial<typeof content>).refs;
  const sealed = canonicalDigest(content);
  const bad = {
    ...h.a,
    id: "DA-badsnapshot01",
    snapshot: { ...h.a.snapshot, sha256: sealed.sha256, bytes: sealed.bytes },
  };
  await h.journal.append(bad, { content, sha256: sealed.sha256, bytes: sealed.bytes });
  const result = await h.reader.read({
    assessmentId: bad.id,
    consumerId: h.consumer.id,
    subject: bad.subject,
  });
  assert.ok(result.ok);
  assert.equal(result.value.presentation, "unavailable");
  assert.equal(result.value.usable, false);
});

test("retained valid-digest snapshot with malformed claim references is unavailable", async () => {
  const h = await setup();
  const found = await h.journal.loadSnapshot(h.a.snapshot.sha256);
  assert.equal(found.status, "retained");
  if (found.status !== "retained") return;
  const content = {
    ...found.snapshot.content,
    refs: { ...found.snapshot.content.refs, claims: [null] },
  } as unknown as typeof found.snapshot.content;
  const sealed = canonicalDigest(content);
  const bad = {
    ...h.a,
    id: "DA-badreferences01",
    snapshot: { ...h.a.snapshot, sha256: sealed.sha256, bytes: sealed.bytes },
  };
  await h.journal.append(bad, { content, sha256: sealed.sha256, bytes: sealed.bytes });
  const result = await h.reader.read({
    assessmentId: bad.id,
    consumerId: h.consumer.id,
    subject: bad.subject,
  });
  assert.ok(result.ok);
  assert.equal(result.value.presentation, "unavailable");
});
