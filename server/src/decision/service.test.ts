import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { DecisionQuestion } from "@argus/contracts";
import { RESIDUAL_CAUSE_V1 } from "./definitions.js";
import { layout } from "./storage.js";
import { createDeterministicProvider } from "./providers/deterministic.js";
import { createMockProvider } from "./providers/mock.js";
import { createDecisionService } from "./service.js";
import { BUILTIN_BUILDERS } from "./definitions.js";
import { harness, ids, memorySources, RESIDUAL_P, failedRun, transcript } from "./testSupport.js";

const residual = {
  question: "run.failure-cause.residual",
  subject: { kind: "run", runId: "run-1" } as const,
};

test("every assessment is shadow-mode, carries its definitions by digest, and names its retained snapshot", async () => {
  const mock = createMockProvider({
    script: [{ distribution: RESIDUAL_P, rationale: "missing file" }],
  });
  const h = harness({ providers: { mock } });
  const r = await h.service.assess({ ...residual, provider: "mock" });
  assert.ok(r.ok);
  const a = r.assessment;
  assert.equal(a.mode, "shadow");
  assert.deepEqual(a.question, h.registry.question("run.failure-cause.residual", 1)!.ref);
  assert.deepEqual(a.snapshot.projection, h.registry.projection("run-failure", 1)!.ref);
  assert.equal(
    mock.calls[0].snapshot,
    a.snapshot.sha256,
    "the provider saw exactly the retained snapshot",
  );
  assert.equal((await h.journal.loadSnapshot(a.snapshot.sha256)).status, "retained");
  assert.equal(a.reEvaluates, undefined);
});

test("refusals before the call spend nothing: unknown question, wrong subject, unknown or unsupported provider, unbuildable snapshot", async () => {
  const mock = createMockProvider({ script: () => ({ distribution: RESIDUAL_P }) });
  const mem = memorySources({
    runs: [failedRun(), failedRun({ id: "run-2" })],
    transcripts: { "run-1": transcript(), "run-2": null },
  });
  const h = harness({
    providers: { mock, det: createDeterministicProvider() },
    sources: mem.sources,
  });
  const cases = [
    [{ question: "no.such", subject: residual.subject, provider: "mock" }, "unknown-question"],
    [{ ...residual, version: 9, provider: "mock" }, "unknown-question"],
    [
      {
        ...residual,
        subject: { kind: "phase-attempt", instanceId: "i", phaseId: "p", attempt: 0 },
        provider: "mock",
      },
      "subject-mismatch",
    ],
    [{ ...residual, provider: "nobody" }, "unknown-provider"],
    [{ ...residual, provider: "det" }, "unsupported"],
    [
      { ...residual, subject: { kind: "run", runId: "missing" }, provider: "mock" },
      "snapshot-unbuildable",
    ],
    [
      { ...residual, subject: { kind: "run", runId: "run-2" }, provider: "mock" },
      "snapshot-unbuildable",
    ],
  ] as const;
  for (const [req, reason] of cases) {
    const r = await h.service.assess(req as Parameters<typeof h.service.assess>[0]);
    assert.deepEqual(
      [r.ok, !r.ok && r.reason, r.providerCalled],
      [false, reason, false],
      JSON.stringify(req),
    );
  }
  assert.equal(mock.calls.length, 0);
  assert.equal((await h.journal.read()).entries.length, 0);
});

test("the service re-validates what a provider claims, and records crashes and false identities as failures", async () => {
  const mock = createMockProvider({
    script: [
      // A provider that skips validation and claims an out-of-space answer.
      {
        outcome: {
          status: "answered",
          answer: { kind: "probability", shape: "choice", p: { yes: 1 } },
        },
      },
      {
        outcome: {
          status: "answered",
          answer: { kind: "probability", shape: "choice", p: { ...RESIDUAL_P, other: 0.5 } },
        },
      },
      {
        outcome: {
          status: "answered",
          answer: { kind: "rating", value: 7, scale: { min: 0, max: 10 } },
        },
      },
      { throws: "adapter blew up" },
      { distribution: { ...RESIDUAL_P, other: 0.3 } },
    ],
  });
  const h = harness({ providers: { mock } });
  const outcomes = [];
  for (let i = 0; i < 5; i++) {
    const r = await h.service.assess({ ...residual, provider: "mock", sample: i });
    assert.ok(r.ok);
    outcomes.push(r.assessment.outcome);
  }
  assert.deepEqual(
    outcomes.map((o) => (o.status === "failed" ? o.failure : o.status)),
    ["invalid-answer", "invalid-answer", "invalid-answer", "provider-error", "invalid-answer"],
  );
  // A rating is never stored as (or for) a probability question.
  assert.match((outcomes[2] as { detail: string }).detail, /rating answers only a scale/);

  const liar = createMockProvider({ script: [{ distribution: RESIDUAL_P }] });
  const impostor = { ...liar, kind: "claude-cli" as const };
  const h2 = harness({ providers: { x: impostor } });
  const r = await h2.service.assess({ ...residual, provider: "x" });
  assert.ok(r.ok);
  assert.equal(r.assessment.provider.provider, "claude-cli");
  assert.equal(
    r.assessment.outcome.status === "failed" && r.assessment.outcome.failure,
    "identity-mismatch",
  );
});

test("requested and reported model identity are recorded as given, never back-filled", async () => {
  const mock = createMockProvider({
    script: () => ({ distribution: RESIDUAL_P }),
    identity: { requestedModel: "haiku", reportedModel: null, elicitation: "verbalized" },
  });
  const h = harness({ providers: { mock } });
  const r = await h.service.assess({ ...residual, provider: "mock" });
  assert.ok(r.ok);
  assert.equal(r.assessment.provider.requestedModel, "haiku");
  assert.equal(r.assessment.provider.reportedModel, null);
});

test("the deterministic provider answers only questions it has a rule for, by exact version, with elicitation rule", async () => {
  const det = createDeterministicProvider(
    new Map([
      [
        "run.failure-cause.residual@1",
        () => ({
          distribution: {
            ...Object.fromEntries(Object.keys(RESIDUAL_P).map((k) => [k, 0])),
            other: 1,
          },
        }),
      ],
    ]),
  );
  assert.equal(det.supports(RESIDUAL_CAUSE_V1), true);
  assert.equal(det.supports({ ...RESIDUAL_CAUSE_V1, version: 2 }), false);
  const h = harness({ providers: { det } });
  const r = await h.service.assess({ ...residual, provider: "det" });
  assert.ok(r.ok);
  assert.deepEqual(r.assessment.provider, {
    provider: "deterministic",
    requestedModel: null,
    reportedModel: null,
    adapterVersion: 1,
    elicitation: "rule",
  });
  assert.equal(r.assessment.outcome.status, "answered");
});

test("re-evaluation after archival: a new call on the original retained snapshot and question version, linked, never overwriting", async () => {
  const mock = createMockProvider({ script: () => ({ distribution: RESIDUAL_P }) });
  const h = harness({ providers: { mock }, limits: { segmentMaxBytes: 5000 } });
  const first = await h.service.assess({ ...residual, provider: "mock" });
  assert.ok(first.ok);
  const originalLine = (await h.journal.read()).entries[0];

  // The question moves on to v2 and the run's transcript changes; neither
  // may leak into a re-evaluation of the original.
  const v2: DecisionQuestion = { ...RESIDUAL_CAUSE_V1, version: 2, text: "Why did this run fail?" };
  h.registry.registerQuestion(v2);
  h.mem.transcripts.set("run-1", [...transcript(), ...transcript()]);
  await h.journal.archive();
  const view = await h.journal.read();
  assert.equal(view.segments.find((s) => s.segment === originalLine.segment)?.store, "archive");

  const again = await h.service.reEvaluate({
    assessmentId: first.assessment.id,
    provider: "mock",
    sample: 1,
  });
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(again.assessment.reEvaluates, first.assessment.id);
  assert.deepEqual(again.assessment.question, first.assessment.question);
  assert.equal(again.assessment.question.version, 1);
  assert.equal(again.assessment.snapshot.sha256, first.assessment.snapshot.sha256);
  assert.deepEqual(mock.calls.at(-1), {
    question: "run.failure-cause.residual",
    version: 1,
    snapshot: first.assessment.snapshot.sha256,
  });
  assert.notEqual(again.assessment.id, first.assessment.id);

  const after = await h.journal.read();
  const orig = after.entries.find((e) => e.assessment.id === first.assessment.id)!;
  assert.equal(orig.digest, originalLine.digest, "the original record is untouched");
  assert.equal(after.entries.length, 2);
});

test("re-evaluation with missing input fails clearly and calls nothing", async () => {
  const mock = createMockProvider({ script: () => ({ distribution: RESIDUAL_P }) });
  const h = harness({ providers: { mock } });
  const first = await h.service.assess({ ...residual, provider: "mock" });
  assert.ok(first.ok);
  const calls = mock.calls.length;

  const unknown = await h.service.reEvaluate({ assessmentId: "DA-nope00", provider: "mock" });
  assert.deepEqual(
    [unknown.ok, !unknown.ok && unknown.reason, unknown.providerCalled],
    [false, "unknown-assessment", false],
  );

  const noProvider = await h.service.reEvaluate({
    assessmentId: first.assessment.id,
    provider: "ghost",
  });
  assert.equal(!noProvider.ok && noProvider.reason, "unknown-provider");

  // A registry that no longer holds the original version.
  const bare = createDecisionService({
    journal: h.journal,
    registry: (await import("./registry.js")).createRegistry(),
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    providers: { mock },
    newId: ids("DA-bare"),
  });
  const gone = await bare.reEvaluate({ assessmentId: first.assessment.id, provider: "mock" });
  assert.equal(!gone.ok && gone.reason, "unknown-question");

  // The same id and version, but a different definition than the one used.
  const { createRegistry } = await import("./registry.js");
  const edited = createRegistry();
  const { RUN_FAILURE_V1 } = await import("./projections/runFailure.js");
  edited.registerProjection(RUN_FAILURE_V1);
  edited.registerQuestion({ ...RESIDUAL_CAUSE_V1, text: "Edited without a version bump." });
  const drift = createDecisionService({
    ...{ journal: h.journal, builders: BUILTIN_BUILDERS, sources: h.sources },
    registry: edited,
    providers: { mock },
  });
  const mismatch = await drift.reEvaluate({ assessmentId: first.assessment.id, provider: "mock" });
  assert.equal(!mismatch.ok && mismatch.reason, "definition-mismatch");

  // The snapshot body is gone: replayable, but no longer re-evaluable.
  rmSync(layout(h.root).snapshotPath("active", first.assessment.snapshot.sha256));
  const lost = await h.service.reEvaluate({ assessmentId: first.assessment.id, provider: "mock" });
  assert.deepEqual(
    [lost.ok, !lost.ok && lost.reason, lost.providerCalled],
    [false, "snapshot-unavailable", false],
  );

  assert.equal(mock.calls.length, calls, "no refusal made a provider call");
  assert.equal((await h.journal.read()).entries.length, 1);
});

test("storage refusal after a call is reported as such, with the call counted", async () => {
  const mock = createMockProvider({
    script: () => ({ distribution: RESIDUAL_P, rationale: "r".repeat(1500) }),
  });
  const h = harness({ providers: { mock } });
  const first = await h.service.assess({ ...residual, provider: "mock" });
  assert.ok(first.ok);
  // The retry of an already-appended id with other content is a conflict.
  const dup = createDecisionService({
    journal: h.journal,
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    providers: { mock },
    newId: () => first.assessment.id,
  });
  const r = await dup.assess({ ...residual, provider: "mock", sample: 3 });
  assert.deepEqual([r.ok, !r.ok && r.reason, r.providerCalled], [false, "storage-refused", true]);
  assert.match((r as { detail: string }).detail, /conflict/);
});
