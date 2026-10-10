import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionAssessment, DecisionQuestion, DecisionSubject } from "@argus/contracts";
import { canonicalDigest } from "./canonical.js";
import { RESIDUAL_CAUSE_V1 } from "./definitions.js";
import { layout } from "./storage.js";
import { createDeterministicProvider } from "./providers/deterministic.js";
import { createMockProvider } from "./providers/mock.js";
import type { DecisionProvider, ProviderResponse } from "./providers/types.js";
import { createDecisionService } from "./service.js";
import { BUILTIN_BUILDERS } from "./definitions.js";
import { harness, ids, memorySources, RESIDUAL_P, failedRun, transcript } from "./testSupport.js";

const residual = {
  question: "run.failure-cause.residual",
  subject: { kind: "run", runId: "run-1" } as const,
};

test("explicit consistent no-call guards return typed refusals without appending assessments", async () => {
  for (const failure of [
    "disabled",
    "busy",
    "budget-blocked",
    "aborted",
    "unsafe-cwd",
    "dispatch-refused",
  ]) {
    const mock = createMockProvider({ script: [] });
    const provider: DecisionProvider = {
      ...mock,
      async assess() {
        return {
          identity: mock.identity(),
          outcome: { status: "failed", failure, detail: "guard refused" },
          costUsd: null,
          tokens: 0,
          executionDisposition: "not-called",
        };
      },
    };
    const h = harness({ providers: { guard: provider } });
    const result = await h.service.assess({ ...residual, provider: "guard" });
    assert.deepEqual(result, {
      ok: false,
      reason: failure,
      detail: "guard refused",
      providerCalled: false,
    });
    assert.equal((await h.journal.read()).entries.length, 0);
  }
});

test("unproven and contradictory execution claims remain spent with honest usage", async () => {
  const mock = createMockProvider({ script: [] });
  const base = {
    identity: mock.identity(),
    outcome: { status: "failed", failure: "disabled", detail: "claimed guard" },
    costUsd: null,
    tokens: null,
  };
  const cases = [
    { name: "missing", response: base, expected: "disabled" },
    {
      name: "possibly called spoof",
      response: { ...base, executionDisposition: "possibly-called" },
      expected: "disabled",
    },
    {
      name: "malformed",
      response: { ...base, executionDisposition: "never" },
      expected: "invalid-execution-disposition",
    },
    {
      name: "positive cost",
      response: { ...base, executionDisposition: "not-called", costUsd: 0.2 },
      expected: "invalid-execution-disposition",
    },
    {
      name: "positive tokens",
      response: { ...base, executionDisposition: "not-called", tokens: 12 },
      expected: "invalid-execution-disposition",
    },
    {
      name: "invalid metering",
      response: { ...base, executionDisposition: "not-called", costUsd: -1 },
      expected: "invalid-execution-disposition",
    },
    {
      name: "answered",
      response: {
        ...base,
        executionDisposition: "not-called",
        outcome: {
          status: "answered",
          answer: { kind: "probability", shape: "choice", p: RESIDUAL_P },
        },
      },
      expected: "invalid-execution-disposition",
    },
    {
      name: "raw output",
      response: {
        ...base,
        executionDisposition: "not-called",
        outcome: { ...base.outcome, rawExcerpt: "response" },
      },
      expected: "invalid-execution-disposition",
    },
    {
      name: "reported model",
      response: {
        ...base,
        executionDisposition: "not-called",
        identity: { ...base.identity, reportedModel: "model" },
      },
      expected: "invalid-execution-disposition",
    },
    {
      name: "false identity",
      response: {
        ...base,
        executionDisposition: "not-called",
        identity: { ...base.identity, adapterVersion: 2 },
      },
      expected: "invalid-execution-disposition",
    },
    {
      name: "unknown guard",
      response: {
        ...base,
        executionDisposition: "not-called",
        outcome: { ...base.outcome, failure: "other" },
      },
      expected: "invalid-execution-disposition",
    },
  ];
  for (const c of cases) {
    let executions = 0;
    const provider: DecisionProvider = {
      ...mock,
      async assess() {
        executions++;
        return c.response as ProviderResponse;
      },
    };
    const h = harness({ providers: { guard: provider } });
    const result = await h.service.assess({ ...residual, provider: "guard" });
    assert.equal(executions, 1, c.name);
    assert.ok(result.ok, c.name);
    assert.equal(result.providerCalled, true, c.name);
    assert.equal(
      result.assessment.outcome.status === "failed" && result.assessment.outcome.failure,
      c.expected,
      c.name,
    );
    assert.equal(result.assessment.costUsd, c.name === "positive cost" ? 0.2 : null, c.name);
    assert.equal(result.assessment.tokens, c.name === "positive tokens" ? 12 : null, c.name);
    assert.equal((await h.journal.read()).entries.length, 1, c.name);
    assert.equal("executionDisposition" in result.assessment, false);
  }
});

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

test("invalid provider spend and usage remain unknown in retained assessments", async () => {
  for (const value of [-1, NaN, Infinity, -Infinity]) {
    const mock = createMockProvider({
      script: [{ distribution: RESIDUAL_P }],
      costUsd: value,
      tokens: value,
    });
    const h = harness({ providers: { mock } });
    const result = await h.service.assess({ ...residual, provider: "mock" });
    assert.ok(result.ok);
    assert.equal(result.assessment.costUsd, null);
    assert.equal(result.assessment.tokens, null);
    const retained = await h.journal.read();
    assert.equal(retained.entries[0].assessment.costUsd, null);
    assert.equal(retained.entries[0].assessment.tokens, null);
  }
  const mock = createMockProvider({
    script: [{ distribution: RESIDUAL_P }],
    costUsd: 0,
    tokens: 0,
  });
  const h = harness({ providers: { mock } });
  const result = await h.service.assess({ ...residual, provider: "mock" });
  assert.ok(result.ok);
  assert.equal(result.assessment.costUsd, 0);
  assert.equal(result.assessment.tokens, 0);
});

async function retainedEvaluationFixture() {
  const mock = createMockProvider({ script: () => ({ distribution: RESIDUAL_P }) });
  const h = harness({ providers: { mock } });
  const first = await h.service.assess({ ...residual, provider: "mock" });
  assert.ok(first.ok);
  const retained = await h.journal.loadSnapshot(first.assessment.snapshot.sha256);
  assert.equal(retained.status, "retained");
  assert.ok(retained.status === "retained");
  return { ...h, mock, original: first.assessment, snapshot: retained.snapshot };
}

for (const altered of ["subject", "projection-id", "projection-version"] as const) {
  test(`retained re-evaluation refuses parent ${altered} mismatch before invoking provider`, async () => {
    const h = await retainedEvaluationFixture();
    const parent: DecisionAssessment = {
      ...h.original,
      id: `DA-retained-${altered}`,
      ...(altered === "subject"
        ? { subject: { kind: "run" as const, runId: "other-run" } }
        : {
            snapshot: {
              ...h.original.snapshot,
              projection: {
                ...h.original.snapshot.projection,
                ...(altered === "projection-id" ? { id: "other-projection" } : { version: 2 }),
              },
            },
          }),
    };
    await h.journal.append(parent, h.snapshot);
    const before = await h.journal.read();
    const calls = h.mock.calls.length;
    const result = await h.service.reEvaluate({ assessmentId: parent.id, provider: "mock" });
    assert.equal(result.ok, false);
    assert.equal(result.providerCalled, false);
    assert.equal(h.mock.calls.length, calls);
    assert.deepEqual(await h.journal.read(), before);
  });
}

for (const damage of [
  "loaded-hash",
  "loaded-bytes",
  "parent-bytes",
  "content",
  "non-canonical",
  "format",
  "oversize",
] as const) {
  test(`retained re-evaluation refuses ${damage} identity damage before invoking provider`, async () => {
    const h = await retainedEvaluationFixture();
    const snapshot = structuredClone(h.snapshot);
    const parent = structuredClone(h.original);
    if (damage === "loaded-hash") snapshot.sha256 = "f".repeat(64);
    if (damage === "loaded-bytes") snapshot.bytes++;
    if (damage === "parent-bytes") parent.snapshot.bytes++;
    if (damage === "content") snapshot.content.body = { different: true };
    if (damage === "non-canonical") snapshot.content.body = { impossible: undefined };
    if (damage === "format" || damage === "oversize") {
      if (damage === "format") Object.assign(snapshot.content, { formatVersion: 999 });
      else snapshot.content.body = { text: "x".repeat(300_000) };
      const sealed = canonicalDigest(snapshot.content);
      snapshot.sha256 = sealed.sha256;
      snapshot.bytes = sealed.bytes;
      parent.snapshot.sha256 = sealed.sha256;
      parent.snapshot.bytes = sealed.bytes;
    }
    const before = await h.journal.read();
    const journal = new Proxy(h.journal, {
      get(target, key) {
        if (key === "read")
          return async () => ({
            ...before,
            entries: before.entries.map((e) =>
              e.assessment.id === parent.id ? { ...e, assessment: parent } : e,
            ),
          });
        if (key === "loadSnapshot") return async () => ({ status: "retained" as const, snapshot });
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = createDecisionService({
      journal,
      registry: h.registry,
      builders: BUILTIN_BUILDERS,
      sources: h.sources,
      providers: { mock: h.mock },
    });
    const calls = h.mock.calls.length;
    const result = await service.reEvaluate({ assessmentId: parent.id, provider: "mock" });
    assert.equal(result.ok, false);
    assert.equal(result.providerCalled, false);
    assert.equal(h.mock.calls.length, calls);
    assert.deepEqual(await h.journal.read(), before);
  });
}

test("retained re-evaluation refuses registered projection drift despite unchanged question digest", async () => {
  const h = await retainedEvaluationFixture();
  const { createRegistry } = await import("./registry.js");
  const { RUN_FAILURE_V1 } = await import("./projections/runFailure.js");
  const registry = createRegistry();
  registry.registerProjection({
    ...RUN_FAILURE_V1,
    description: "Changed without a version bump.",
  });
  registry.registerQuestion(RESIDUAL_CAUSE_V1);
  const service = createDecisionService({
    journal: h.journal,
    registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    providers: { mock: h.mock },
  });
  const before = await h.journal.read();
  const calls = h.mock.calls.length;
  const result = await service.reEvaluate({ assessmentId: h.original.id, provider: "mock" });
  assert.equal(result.ok, false);
  assert.equal(result.providerCalled, false);
  assert.equal(h.mock.calls.length, calls);
  assert.deepEqual(await h.journal.read(), before);
});

async function retainedSubjectFixture(subject: Record<string, unknown>) {
  const h = await retainedEvaluationFixture();
  const { createRegistry } = await import("./registry.js");
  const { RUN_FAILURE_V1 } = await import("./projections/runFailure.js");
  const kind = subject.kind as DecisionSubject["kind"];
  const registry = createRegistry();
  registry.registerProjection({ ...RUN_FAILURE_V1, subject: kind });
  registry.registerQuestion({ ...RESIDUAL_CAUSE_V1, subject: kind });
  const content = {
    ...h.snapshot.content,
    subject: subject as unknown as DecisionSubject,
    projection: registry.projection(RUN_FAILURE_V1.id, 1)!.ref,
  };
  const sealed = canonicalDigest(content);
  const parent = {
    ...h.original,
    id: "DA-retainedsubject01",
    subject: content.subject,
    question: registry.question(RESIDUAL_CAUSE_V1.id, 1)!.ref,
    snapshot: {
      ...h.original.snapshot,
      sha256: sealed.sha256,
      bytes: sealed.bytes,
      projection: content.projection,
    },
  };
  await h.journal.append(parent, { ...sealed, content });
  const service = createDecisionService({
    journal: h.journal,
    registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    providers: { mock: h.mock },
  });
  return { ...h, parent, service };
}

const incompleteSubjects: Array<[string, Record<string, unknown>]> = [
  ["missing run id", { kind: "run" }],
  ["blank run id", { kind: "run", runId: "  " }],
  ["non-string run id", { kind: "run", runId: 42 }],
  ["missing instance id", { kind: "phase-attempt", phaseId: "p", attempt: 0 }],
  ["blank phase id", { kind: "phase-attempt", instanceId: "i", phaseId: "", attempt: 0 }],
  ["missing attempt", { kind: "phase-attempt", instanceId: "i", phaseId: "p" }],
  ["negative attempt", { kind: "phase-attempt", instanceId: "i", phaseId: "p", attempt: -1 }],
  ["fractional attempt", { kind: "phase-attempt", instanceId: "i", phaseId: "p", attempt: 0.5 }],
  [
    "unsafe attempt",
    { kind: "phase-attempt", instanceId: "i", phaseId: "p", attempt: Number.MAX_SAFE_INTEGER + 1 },
  ],
  ["string attempt", { kind: "phase-attempt", instanceId: "i", phaseId: "p", attempt: "0" }],
  ["missing rule verification id", { kind: "rule-verification" }],
  ["blank rule verification id", { kind: "rule-verification", verificationId: " " }],
  ["missing acceptance verification id", { kind: "acceptance-verification" }],
  [
    "non-string acceptance verification id",
    { kind: "acceptance-verification", verificationId: [] },
  ],
];
for (const [name, subject] of incompleteSubjects) {
  test("retained re-evaluation refuses matching incomplete subject: " + name, async () => {
    const h = await retainedSubjectFixture(subject);
    const before = await h.journal.read();
    const calls = h.mock.calls.length;
    const result = await h.service.reEvaluate({ assessmentId: h.parent.id, provider: "mock" });
    assert.deepEqual(
      [result.ok, result.providerCalled, !result.ok && result.reason],
      [false, false, "subject-mismatch"],
    );
    assert.equal(h.mock.calls.length, calls);
    assert.deepEqual(await h.journal.read(), before);
  });
}
for (const subject of [
  { kind: "run", runId: "archived-run" },
  { kind: "phase-attempt", instanceId: "archived-instance", phaseId: "p", attempt: 0 },
  { kind: "rule-verification", verificationId: "archived-rule" },
  { kind: "acceptance-verification", verificationId: "archived-acceptance" },
]) {
  test(
    "retained re-evaluation preserves valid archival " + subject.kind + " identity",
    async () => {
      const h = await retainedSubjectFixture(subject);
      const calls = h.mock.calls.length;
      const result = await h.service.reEvaluate({ assessmentId: h.parent.id, provider: "mock" });
      assert.ok(result.ok);
      assert.equal(h.mock.calls.length, calls + 1);
      assert.deepEqual(result.assessment.subject, subject);
      assert.equal(result.assessment.reEvaluates, h.parent.id);
    },
  );
}

function retainedStoreInventory(root: string): Record<string, string> {
  const inventory: Record<string, string> = {};
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else inventory[path] = readFileSync(path).toString("base64");
    }
  }
  visit(root);
  return inventory;
}

test("retained preparation is deterministic, detached, and reads only retained stores", async () => {
  const h = await retainedEvaluationFixture();
  const before = await h.journal.read();
  const inventory = retainedStoreInventory(h.root);
  const reads = structuredClone(h.mem.reads);
  const request = { assessmentId: h.original.id, provider: "mock", sample: 2 };
  const first = await h.service.prepareReEvaluation(request);
  const second = await h.service.prepareReEvaluation(request);
  assert.ok(first.ok && second.ok);
  assert.deepEqual(first, second);
  assert.equal(first.preparation.parent.digest, before.entries[0].digest);
  assert.deepEqual(first.preparation.question, h.original.question);
  assert.deepEqual(first.preparation.snapshot.subject, h.original.subject);
  assert.equal(first.preparation.sample, 2);
  assert.equal("reportedModel" in first.preparation.provider, false);
  first.preparation.question.id = "caller mutation";
  assert.deepEqual(await h.service.prepareReEvaluation(request), second);
  assert.deepEqual(await h.journal.read(), before);
  assert.deepEqual(retainedStoreInventory(h.root), inventory);
  assert.deepEqual(h.mem.reads, reads);
  assert.equal(h.mock.calls.length, 1);
});

for (const sample of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`retained preparation and dispatch reject sample ${sample} before calling`, async () => {
    const h = await retainedEvaluationFixture();
    const request = { assessmentId: h.original.id, provider: "mock", sample };
    for (const result of [
      await h.service.prepareReEvaluation(request),
      await h.service.reEvaluate(request),
    ]) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.providerCalled, false);
    }
    assert.equal(h.mock.calls.length, 1);
  });
}

test("prepared dispatch preserves custom id and original linkage; invalid or existing ids call none", async () => {
  const h = await retainedEvaluationFixture();
  const request = { assessmentId: h.original.id, provider: "mock", sample: 3 };
  const prepared = await h.service.prepareReEvaluation(request);
  assert.ok(prepared.ok);
  for (const id of ["../bad", h.original.id]) {
    const refused = await h.service.reEvaluate({
      ...request,
      id,
      expectedPreparationDigest: prepared.preparation.digest,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.providerCalled, false);
  }
  const result = await h.service.reEvaluate({
    ...request,
    id: "DA-prepared-result01",
    expectedPreparationDigest: prepared.preparation.digest,
  });
  assert.ok(result.ok);
  assert.equal(result.assessment.id, "DA-prepared-result01");
  assert.equal(result.assessment.reEvaluates, h.original.id);
  assert.deepEqual(result.assessment.question, h.original.question);
  assert.equal(h.mock.calls.length, 2);
});

test("dispatch refuses changed requested identity or sample but reported model is observed only", async () => {
  const h = await retainedEvaluationFixture();
  const request = { assessmentId: h.original.id, provider: "mock" };
  const prepared = await h.service.prepareReEvaluation(request);
  assert.ok(prepared.ok);
  const identity = h.mock.identity();
  let current = { ...identity };
  const provider = { ...h.mock, identity: () => current };
  const service = createDecisionService({
    journal: h.journal,
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    providers: { mock: provider },
  });
  for (const field of ["requestedModel", "adapterVersion", "elicitation"] as const) {
    current = {
      ...identity,
      [field]:
        field === "adapterVersion"
          ? identity.adapterVersion + 1
          : field === "elicitation"
            ? "sampled"
            : "changed",
    };
    const result = await service.reEvaluate({
      ...request,
      expectedPreparationDigest: prepared.preparation.digest,
    });
    assert.equal(result.ok, false);
    assert.equal(result.providerCalled, false);
  }
  current = { ...identity };
  const changedSample = await service.reEvaluate({
    ...request,
    sample: 1,
    expectedPreparationDigest: prepared.preparation.digest,
  });
  assert.equal(changedSample.ok, false);
  assert.equal(h.mock.calls.length, 1);
  current = { ...identity, reportedModel: "observed-later" };
  const valid = await service.reEvaluate({
    ...request,
    expectedPreparationDigest: prepared.preparation.digest,
  });
  assert.ok(valid.ok);
});

for (const change of [
  "parent-digest",
  "parent-provenance",
  "provider-key",
  "question",
  "projection",
] as const) {
  test(`prepared dispatch rejects ${change} drift without calls or writes`, async () => {
    const h = await retainedEvaluationFixture();
    const req = { assessmentId: h.original.id, provider: "mock" };
    const initial = await h.service.prepareReEvaluation(req);
    assert.ok(initial.ok);
    const before = await h.journal.read();
    const inventory = retainedStoreInventory(h.root);
    const registry = new Proxy(h.registry, {
      get(target, key) {
        if (key === "question" && change === "question")
          return (...args: Parameters<typeof target.question>) => {
            const q = target.question(...args)!;
            return { ...q, ref: { ...q.ref, digest: "a".repeat(64) } };
          };
        if (key === "projection" && change === "projection")
          return (...args: Parameters<typeof target.projection>) => {
            const p = target.projection(...args)!;
            return { ...p, ref: { ...p.ref, digest: "a".repeat(64) } };
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const journal = new Proxy(h.journal, {
      get(target, key) {
        if (key === "read")
          return async () => ({
            ...before,
            entries: before.entries.map((e) => ({
              ...e,
              ...(change === "parent-digest" ? { digest: "b".repeat(64) } : {}),
              ...(change === "parent-provenance" ? { line: e.line + 1 } : {}),
            })),
          });
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = createDecisionService({
      journal,
      registry,
      builders: BUILTIN_BUILDERS,
      sources: h.sources,
      providers: { mock: h.mock, other: h.mock },
    });
    const result = await service.reEvaluate({
      ...req,
      ...(change === "provider-key" ? { provider: "other" } : {}),
      expectedPreparationDigest: initial.preparation.digest,
    });
    assert.equal(result.ok, false);
    assert.equal(result.providerCalled, false);
    assert.equal(h.mock.calls.length, 1);
    assert.deepEqual(retainedStoreInventory(h.root), inventory);
  });
}

test("prepared dispatch rejects malformed digest before retained reads", async () => {
  const h = await retainedEvaluationFixture();
  const journal = new Proxy(h.journal, {
    get(target, key) {
      if (key === "read")
        return async () => {
          assert.fail("invalid digest must refuse before read");
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const service = createDecisionService({
    journal,
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    providers: { mock: h.mock },
  });
  const result = await service.reEvaluate({
    assessmentId: h.original.id,
    provider: "mock",
    expectedPreparationDigest: "invalid",
  });
  assert.equal(result.ok, false);
  assert.equal(result.providerCalled, false);
  assert.equal(h.mock.calls.length, 1);
});

for (const result of ["expired", "throw", "accepted"] as const) {
  test(`retained dispatch final boundary guard ${result} runs after asynchronous revalidation`, async () => {
    const h = await retainedEvaluationFixture();
    const request = { assessmentId: h.original.id, provider: "mock" };
    const initial = await h.service.prepareReEvaluation(request);
    assert.ok(initial.ok);
    const load = h.journal.loadSnapshot.bind(h.journal);
    let expired = false;
    h.journal.loadSnapshot = async (hash) => {
      const retained = await load(hash);
      expired = true;
      return retained;
    };
    const inventory = retainedStoreInventory(h.root);
    let guards = 0;
    const dispatched = await h.service.reEvaluate({
      ...request,
      expectedPreparationDigest: initial.preparation.digest,
      beforeProviderCall: async () => {
        guards++;
        assert.equal(expired, true, "guard must run after the awaited snapshot validation");
        assert.equal(h.mock.calls.length, 1, "guard must precede the actual provider call");
        if (result === "throw") throw new Error("ownership check unavailable");
        return result === "expired"
          ? { ok: false as const, detail: "authorization expired during retained revalidation" }
          : { ok: true as const, validateNow: () => ({ ok: true as const }) };
      },
    });
    assert.equal(guards, 1);
    if (result === "accepted") {
      assert.ok(dispatched.ok);
      assert.equal(h.mock.calls.length, 2);
    } else {
      assert.equal(dispatched.ok, false);
      assert.equal(dispatched.providerCalled, false);
      assert.equal(!dispatched.ok && dispatched.reason, "dispatch-refused");
      assert.equal(h.mock.calls.length, 1);
      assert.deepEqual(retainedStoreInventory(h.root), inventory);
    }
  });
}

test("guarded retained dispatch refuses a provider missing admission capability", async () => {
  const h = await retainedEvaluationFixture();
  const legacy = { ...h.mock };
  delete (legacy as Partial<DecisionProvider>).assessWithAdmission;
  const service = createDecisionService({
    journal: h.journal,
    registry: h.registry,
    builders: BUILTIN_BUILDERS,
    sources: h.sources,
    providers: { legacy },
  });
  const result = await service.reEvaluate({
    assessmentId: h.original.id,
    provider: "legacy",
    beforeProviderCall: async () => ({ ok: true, validateNow: () => ({ ok: true }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.providerCalled, false);
  assert.equal(!result.ok && result.reason, "dispatch-refused");
  assert.equal(h.mock.calls.length, 1);
  assert.equal((await h.journal.read()).entries.length, 1);
});
