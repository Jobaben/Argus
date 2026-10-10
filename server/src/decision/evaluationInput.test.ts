import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  prepareEvaluationInput,
  bindEvaluationInputAudit,
  type EvaluationInputArtifact,
} from "./evaluationInput.js";
import { canonicalDigest, sha256Hex } from "./canonical.js";
import { createMockProvider } from "./providers/mock.js";
import { harness, failedRun, assistant, memorySources } from "./testSupport.js";
import { renderDecisionPrompt } from "./providers/claudeCli.js";

async function fixture(
  text = "process exited normally after permission denied",
  version = 2,
  hint = "CASE_METADATA",
  runId = "run-1",
) {
  const mock = createMockProvider({ script: [{ abstain: "fixture" }] });
  mock.identity = () => ({
    provider: "claude-cli",
    requestedModel: "offline-model",
    reportedModel: null,
    adapterVersion: 1,
    elicitation: "verbalized",
  });
  const mem = memorySources({
    runs: [failedRun({ id: runId, scheduleName: hint, prompt: hint, resultSummary: hint })],
    transcripts: { [runId]: [assistant(1000, [{ type: "text", text }])] },
  });
  const h = harness({ providers: { claude: mock }, sources: mem.sources });
  const parent = await h.service.assess({
    question: "run.termination-probe",
    version,
    subject: { kind: "run", runId },
    provider: "claude",
  });
  assert.ok(parent.ok);
  return {
    ...h,
    mock,
    request: { assessmentId: parent.assessment.id, provider: "claude", sample: 1 },
  };
}
function inventory(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = sha256Hex(readFileSync(file));
    }
  }
  walk(root);
  return result;
}
function receipt(artifact: EvaluationInputArtifact, disposition = "reviewed-for-offline-use") {
  const body = {
    format: "argus.evaluation-input-audit-receipt",
    formatVersion: 1,
    artifactDigest: artifact.digest,
    protocol: { id: "offline-review", version: 1, digest: "a".repeat(64) },
    reviewer: { provenance: "unauthenticated-reference", reference: "review/session/1" },
    at: "2026-10-10T00:00:00.000Z",
    disposition,
  };
  return { ...body, digest: canonicalDigest(body).sha256 };
}
test("offline preparation pins exact UTF8 text and full immutable identities without calls or writes", async () => {
  const h = await fixture("正常終了 🧪");
  const before = inventory(h.root);
  const result = await prepareEvaluationInput(h, h.request);
  assert.ok(result.ok);
  const a = result.artifact;
  assert.equal(a.dispatchable, false);
  assert.equal(a.prompt.sha256, sha256Hex(a.prompt.text));
  assert.equal(a.prompt.bytes, Buffer.byteLength(a.prompt.text, "utf8"));
  assert.ok(a.prompt.bytes > a.prompt.text.length);
  assert.equal(a.preparation.sample, 1);
  assert.equal(a.renderer.version, 1);
  assert.equal(a.renderer.adapterVersion, 1);
  assert.ok(Object.isFrozen(a.snapshot.content.body));
  assert.throws(() => {
    a.preparation.provider.requestedModel = "mutated";
  }, TypeError);
  assert.deepEqual(await prepareEvaluationInput(h, h.request), result);
  assert.deepEqual(inventory(h.root), before);
  assert.equal(h.mock.calls.length, 1);
});
test("omitted metadata is invariant while authored hints and legitimate process vocabulary remain visible", async () => {
  const a = await fixture(
    "process exited normally after permission denied",
    2,
    "EXPECTED_DEADLINE",
  );
  const b = await fixture("process exited normally after permission denied", 2, "EXPECTED_NORMAL");
  const x = await prepareEvaluationInput(a, a.request),
    y = await prepareEvaluationInput(b, b.request);
  assert.ok(x.ok && y.ok);
  assert.equal(x.artifact.prompt.text, y.artifact.prompt.text);
  assert.equal(x.artifact.digest, y.artifact.digest);
  assert.ok(!x.artifact.prompt.text.includes("EXPECTED_DEADLINE"));
  assert.ok(x.artifact.prompt.text.includes("permission denied"));
  const c = await fixture("CASE_D1_EXPECTED_DEADLINE");
  const z = await prepareEvaluationInput(c, c.request);
  assert.ok(z.ok && z.artifact.prompt.text.includes("CASE_D1_EXPECTED_DEADLINE"));
  assert.equal(bindEvaluationInputAudit(z.artifact, undefined).ok, false);
});
test("provider requested identity and sample drift change artifact even when text is equal", async () => {
  const h = await fixture();
  const initial = await prepareEvaluationInput(h, h.request);
  assert.ok(initial.ok);
  const identity = h.mock.identity();
  h.mock.identity = () => ({ ...identity, requestedModel: "another-offline-model" });
  const changed = await prepareEvaluationInput(h, h.request);
  const sample = await prepareEvaluationInput(h, { ...h.request, sample: 2 });
  assert.ok(changed.ok && sample.ok);
  assert.equal(initial.artifact.prompt.text, changed.artifact.prompt.text);
  assert.notEqual(initial.artifact.digest, changed.artifact.digest);
  assert.notEqual(sample.artifact.digest, changed.artifact.digest);
  assert.equal(bindEvaluationInputAudit(changed.artifact, receipt(initial.artifact)).ok, false);
  h.mock.identity = () => ({ ...identity, adapterVersion: 2 });
  assert.equal((await prepareEvaluationInput(h, h.request)).ok, false);
});
test("different retained run/snapshot identities need separate receipts even with equal prompt bytes", async () => {
  const first = await fixture("same process evidence", 2, "metadata", "run-a");
  const second = await fixture("same process evidence", 2, "metadata", "run-b");
  const a = await prepareEvaluationInput(first, first.request),
    b = await prepareEvaluationInput(second, second.request);
  assert.ok(a.ok && b.ok);
  assert.equal(a.artifact.prompt.sha256, b.artifact.prompt.sha256);
  assert.notEqual(a.artifact.snapshot.sha256, b.artifact.snapshot.sha256);
  assert.notEqual(a.artifact.digest, b.artifact.digest);
  assert.equal(bindEvaluationInputAudit(b.artifact, receipt(a.artifact)).ok, false);
});
test("question labels, authored pointers and truncation annotations change exact rendered bytes", async () => {
  const h = await fixture();
  const result = await prepareEvaluationInput(h, h.request);
  assert.ok(result.ok);
  const a = result.artifact;
  const label = structuredClone(a.question);
  assert.equal(label.answers.shape, "choice");
  if (label.answers.shape === "choice") label.answers.options[0].label = "different label";
  const pointer = structuredClone(a.snapshot);
  pointer.content.subjectAuthored.push("/extra");
  const truncation = structuredClone(a.snapshot);
  truncation.content.truncations.push({
    pointer: "/timeline/events",
    originalCodePoints: 100,
    keptCodePoints: 10,
  });
  for (const text of [
    renderDecisionPrompt(label, a.snapshot),
    renderDecisionPrompt(a.question, pointer),
    renderDecisionPrompt(a.question, truncation),
  ])
    assert.notEqual(sha256Hex(text), a.prompt.sha256);
});
test("rechecked parent provenance and retained content refuse drift with no calls or writes", async () => {
  const h = await fixture();
  const before = inventory(h.root);
  const originalRead = h.journal.read.bind(h.journal);
  const originalLoad = h.journal.loadSnapshot.bind(h.journal);
  const preparation = await h.service.prepareReEvaluation(h.request);
  assert.ok(preparation.ok);
  const service = { prepareReEvaluation: async () => preparation };
  for (const change of ["digest", "subject", "gap", "notice", "snapshot", "missing-segment"]) {
    const journal = {
      read: async () => {
        const view = structuredClone(await originalRead());
        if (change === "digest") view.entries[0].digest = "a".repeat(64);
        if (change === "subject")
          view.entries[0].assessment.subject = { kind: "run", runId: "other-run" };
        if (change === "gap")
          view.gaps.push({
            segment: "lost",
            reason: "missing",
            records: null,
            firstAt: null,
            lastAt: null,
          });
        if (change === "notice")
          view.notices.push({ kind: "manifest-damage", detail: "partial evidence" });
        if (change === "missing-segment") view.segments = [];
        return view;
      },
      loadSnapshot: async (sha: string) => {
        const retained = structuredClone(await originalLoad(sha));
        if (change === "snapshot" && retained.status === "retained")
          retained.snapshot.content.subject = { kind: "run", runId: "other-run" };
        return retained;
      },
    };
    assert.equal(
      (await prepareEvaluationInput({ registry: h.registry, service, journal }, h.request)).ok,
      false,
      change,
    );
  }
  assert.deepEqual(inventory(h.root), before);
  assert.equal(h.mock.calls.length, 1);
});
test("caller mutation during awaited reads cannot alter pinned preparation or text", async () => {
  const h = await fixture();
  const prepared = await h.service.prepareReEvaluation(h.request);
  assert.ok(prepared.ok);
  const load = h.journal.loadSnapshot.bind(h.journal);
  const snapshot = await load(prepared.preparation.snapshot.sha256);
  assert.equal(snapshot.status, "retained");
  const result = await prepareEvaluationInput(
    {
      ...h,
      service: { prepareReEvaluation: async () => prepared },
      journal: {
        read: async () => {
          prepared.preparation.provider.requestedModel = "mutated during read";
          return h.journal.read();
        },
        loadSnapshot: async () => snapshot,
      },
    },
    h.request,
  );
  assert.ok(result.ok);
  assert.equal(result.artifact.preparation.provider.requestedModel, "offline-model");
  if (snapshot.status === "retained") snapshot.snapshot.content.body = { changed: true };
  assert.ok(!result.artifact.prompt.text.includes("changed"));
});
test("V1 cannot be relabelled as a V2 input", async () => {
  const h = await fixture("normal", 1);
  assert.equal((await prepareEvaluationInput(h, h.request)).ok, false);
});
test("closed explicit receipts bind only offline review completeness, never dispatch authority", async () => {
  const h = await fixture();
  const r = await prepareEvaluationInput(h, h.request);
  assert.ok(r.ok);
  const valid = receipt(r.artifact);
  const bound = bindEvaluationInputAudit(r.artifact, valid);
  assert.ok(bound.ok);
  assert.equal(bound.dispatchable, false);
  assert.equal(bound.status, "offline-review-complete");
  valid.reviewer.reference = "caller mutation";
  assert.equal(bound.receipt.reviewer.reference, "review/session/1");
  for (const bad of [
    undefined,
    null,
    {},
    receipt(r.artifact, "withheld"),
    { ...receipt(r.artifact), artifactDigest: "b".repeat(64) },
    { ...receipt(r.artifact), humanLabel: "deadline" },
  ]) {
    assert.equal(bindEvaluationInputAudit(r.artifact, bad).ok, false);
  }
  const changed = structuredClone(r.artifact);
  changed.renderer.version++;
  assert.equal(bindEvaluationInputAudit(changed, receipt(r.artifact)).ok, false);
});
test("receipt accessors are refused without invoking caller code", async () => {
  const h = await fixture();
  const r = await prepareEvaluationInput(h, h.request);
  assert.ok(r.ok);
  const supplied = receipt(r.artifact);
  let reads = 0;
  Object.defineProperty(supplied, "protocol", {
    enumerable: true,
    get() {
      reads++;
      return { id: "x", version: 1, digest: "a".repeat(64) };
    },
  });
  assert.equal(bindEvaluationInputAudit(r.artifact, supplied).ok, false);
  assert.equal(reads, 0);
});
test("self-consistent imported artifacts cannot add authority fields or malformed preparation identities", async () => {
  const h = await fixture();
  const r = await prepareEvaluationInput(h, h.request);
  assert.ok(r.ok);
  for (const mutate of [
    (a: EvaluationInputArtifact) => {
      Object.assign(a, { authenticatedReview: true });
    },
    (a: EvaluationInputArtifact) => {
      a.preparation.sample = -1;
    },
    (a: EvaluationInputArtifact) => {
      a.preparation.parent.line = 0;
    },
    (a: EvaluationInputArtifact) => {
      Object.assign(a.preparation.provider, { requestedModel: 42 });
    },
    (a: EvaluationInputArtifact) => {
      Object.assign(a.preparation, { humanReferenceLabel: "deadline" });
    },
  ]) {
    const a: EvaluationInputArtifact = structuredClone(r.artifact);
    mutate(a);
    const { digest: ignoredPreparation, ...preparationBody } = a.preparation;
    void ignoredPreparation;
    a.preparation.digest = canonicalDigest(preparationBody).sha256;
    const { digest: ignoredArtifact, ...artifactBody } = a;
    void ignoredArtifact;
    a.digest = canonicalDigest(artifactBody).sha256;
    assert.equal(bindEvaluationInputAudit(a, receipt(a)).ok, false);
  }
});
