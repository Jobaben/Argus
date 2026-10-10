import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type {
  DecisionAssessment,
  DecisionOutcome,
  DecisionQuestion,
  DefinitionRef,
  ProviderIdentity,
} from "@argus/contracts";
import { builtinRegistry, RESIDUAL_CAUSE_V1 } from "../definitions.js";
import type { JournalView } from "../journal.js";
import { H2_DEFAULTS } from "./config.js";
import type { LedgerRecord, LedgerView, NewRecord, ResultClass } from "./ledger.js";
import { buildH2Report, renderH2Report, replayH2 } from "./report.js";
import { referenceDigest, type ProbeReference } from "./sampling.js";
import { endedRun, h2Harness, MIN, ON } from "./testSupport.js";
import { buildCollectionConfig } from "./watcher.js";

/**
 * The H2 report (RFC §P.7) over hand-built ledger and journal views, with
 * every expected number worked out by hand, then over real stores to show
 * that replay survives source pruning and journal archival.
 */

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ARGUS_ANALYSIS_MODEL", "ARGUS_ANALYSIS_RUNTIME", "ARGUS_ANALYSIS"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const HAIKU: ProviderIdentity = {
  provider: "claude-cli",
  requestedModel: "haiku",
  reportedModel: null,
  adapterVersion: 1,
  elicitation: "verbalized",
};
const PROBE_OPTIONS = [
  "deadline",
  "never-ran",
  "output-refused",
  "rate-limited",
  "permission-denied",
  "ended-normally",
];

/** A tiny in-memory collection: a ledger view and a journal view built record by record. */
function fixture(registry = builtinRegistry()) {
  const records: Array<{ line: number; record: LedgerRecord }> = [];
  const entries: JournalView["entries"] = [];
  let seq = 0;
  let n = 0;
  const push = (r: NewRecord) => {
    const record = { ...r, seq: ++seq } as LedgerRecord;
    records.push({ line: records.length + 1, record });
  };
  const q = (id: string, version = 1) => {
    const found = registry.question(id, version)!;
    const p = registry.projection(found.def.projection.id, found.def.projection.version)!;
    return { ref: found.ref, def: found.def, projection: p.ref };
  };
  const probe = q("run.termination-probe");
  const residual = q("run.failure-cause.residual");
  const { config, digest } = buildCollectionConfig(
    H2_DEFAULTS,
    [
      { role: "residual", ...residual, rate: 1 },
      { role: "probe", ...probe, rate: 1 },
    ],
    HAIKU,
  );
  push({
    kind: "start",
    at: "2026-09-01T00:00:00.000Z",
    format: "argus.h2-collection-ledger",
    version: 1,
  });
  push({ kind: "config", at: "2026-09-01T00:00:00.000Z", digest, config });

  function reference(label: string, question: DefinitionRef, runId: string): ProbeReference {
    const base = {
      stream: "observed-termination" as const,
      label,
      answerSpace: { ...question },
      observation: {
        source: { store: "runs" as const, recordId: runId, recordDigest: "a".repeat(64) },
        observedAt: "2026-09-01T00:00:00.000Z",
      },
      derivation: "observe-termination@1",
    };
    return { ...base, digest: referenceDigest(base) };
  }

  interface ItemOpts {
    role: "probe" | "residual";
    label: string;
    cls: ResultClass;
    outcome?: DecisionOutcome;
    code?: string;
    latencyMs?: number;
    costUsd?: number | null;
    identity?: ProviderIdentity;
    question?: ReturnType<typeof q>;
    mutateReference?: (r: ProbeReference) => ProbeReference | null;
    /** Leave the assessment out of the journal. */
    lose?: boolean;
    noResult?: boolean;
  }
  function item(o: ItemOpts) {
    const i = ++n;
    const runId = `run-${String(i).padStart(3, "0")}`;
    const Q = o.question ?? (o.role === "probe" ? probe : residual);
    const at = `2026-09-01T01:${String(i % 60).padStart(2, "0")}:00.000Z`;
    push({
      kind: "census",
      at,
      config: digest,
      runId,
      endedAt: at,
      stratum: o.label,
      question: Q.ref,
      verdict: "selected",
      reason: null,
    });
    let ref: ProbeReference | null = o.role === "probe" ? reference(o.label, Q.ref, runId) : null;
    if (ref && o.mutateReference) ref = o.mutateReference(ref);
    const identity = o.identity ?? HAIKU;
    const attemptId = `H2A-fixture${String(i).padStart(4, "0")}`;
    const assessmentId = `DA-fixture${String(i).padStart(4, "0")}`;
    push({
      kind: "attempt",
      at,
      attemptId,
      assessmentId,
      config: digest,
      runId,
      runEndedAt: at,
      question: Q.ref,
      projection: Q.projection,
      provider: {
        provider: identity.provider,
        requestedModel: identity.requestedModel,
        adapterVersion: identity.adapterVersion,
        elicitation: identity.elicitation,
      },
      sample: 0,
      try: 1,
      stratum: { class: o.label, observation: null },
      reference: ref,
    });
    const hasAssessment = o.outcome !== undefined;
    if (!o.noResult) {
      push({
        kind: "result",
        at,
        attemptId,
        class: o.cls,
        providerCalled: ["refused", "missing-input", "construction-error"].includes(o.cls)
          ? "no"
          : "yes",
        assessmentId: hasAssessment ? assessmentId : null,
        outcome: o.outcome
          ? {
              status: o.outcome.status,
              failure: o.outcome.status === "failed" ? o.outcome.failure : null,
            }
          : null,
        code: o.code ?? null,
        detail: "",
        costUsd: o.costUsd ?? null,
        latencyMs: o.latencyMs ?? null,
        reconciled: false,
      });
    }
    if (hasAssessment && !o.lose) {
      const a: DecisionAssessment = {
        id: assessmentId,
        question: Q.ref,
        subject: { kind: "run", runId },
        snapshot: { sha256: "b".repeat(64), bytes: 1000, projection: Q.projection },
        provider: identity,
        sample: 0,
        outcome: o.outcome!,
        mode: "shadow",
        latencyMs: o.latencyMs ?? 0,
        costUsd: o.costUsd === undefined ? 0.01 : o.costUsd,
        tokens: null,
        createdAt: at,
      };
      entries.push({
        segment: "seg-00000001",
        line: entries.length + 2,
        digest: "c".repeat(64),
        assessment: a,
      });
    }
  }
  const ledger = (): LedgerView => ({ records: [...records], notices: [], bytes: 0, lastSeq: seq });
  const journal = (): JournalView => ({
    segments: [],
    entries: [...entries],
    gaps: [],
    notices: [],
  });
  return { item, ledger, journal, registry, probe, residual, q, digest };
}

/** A distribution over the probe options: named values, the rest zero. */
const probeP = (named: Record<string, number>) =>
  Object.fromEntries(PROBE_OPTIONS.map((k) => [k, named[k] ?? 0]));
const answered = (named: Record<string, number>): DecisionOutcome => ({
  status: "answered",
  answer: { kind: "probability", shape: "choice", p: probeP(named) },
});

function probeFixture() {
  const f = fixture();
  const EN = "ended-normally";
  const DL = "deadline";
  const ans = (label: string, p: Record<string, number>, latencyMs: number) =>
    f.item({ role: "probe", label, cls: "answered", outcome: answered(p), latencyMs });
  ans(EN, { [EN]: 0.7, [DL]: 0.3 }, 100); // 1: correct, conf 0.7
  ans(EN, { [EN]: 0.6, [DL]: 0.4 }, 200); // 2: correct
  ans(EN, { [EN]: 0.5, [DL]: 0.5 }, 300); // 3: tie → not correct
  ans(DL, { [DL]: 0.8, [EN]: 0.2 }, 400); // 4: correct
  ans(DL, { [EN]: 0.9, [DL]: 0.1 }, 500); // 5: wrong
  f.item({
    role: "probe",
    label: EN,
    cls: "abstained",
    outcome: { status: "abstained", reason: "unclear" },
    latencyMs: 600,
  }); // 6
  f.item({
    role: "probe",
    label: DL,
    cls: "provider-failed",
    code: "invalid-answer",
    outcome: { status: "failed", failure: "invalid-answer", detail: "bad" },
    latencyMs: 700,
    costUsd: null,
  }); // 7
  ans("never-ran", { "never-ran": 1 }, 800); // 8: correct
  f.item({ role: "probe", label: EN, cls: "refused", code: "busy" }); // 9: no call
  f.item({ role: "probe", label: EN, cls: "missing-input", code: "source-unavailable" }); // 10: no call
  f.item({
    role: "probe",
    label: EN,
    cls: "answered",
    outcome: answered({ [EN]: 1 }),
    latencyMs: 1100,
    mutateReference: (r) => {
      const bogus = { ...r, label: "bogus" };
      const { digest: _d, ...rest } = bogus;
      return { ...bogus, digest: referenceDigest(rest) };
    },
  }); // 11: construction error, excluded
  f.item({
    role: "probe",
    label: EN,
    cls: "answered",
    outcome: answered({ [EN]: 1 }),
    latencyMs: 1200,
    mutateReference: (r) => ({ ...r, label: DL }), // label edited without its digest
  }); // 12: corrupt, excluded
  return f;
}

test("legacy journal guard names remain potentially spent while explicit ledger refusals retain priority", () => {
  const f = fixture();
  for (const failure of ["disabled", "busy", "budget-blocked", "aborted", "unsafe-cwd"]) {
    f.item({
      role: "probe",
      label: "deadline",
      cls: "provider-failed",
      noResult: true,
      outcome: { status: "failed", failure, detail: "legacy" },
      costUsd: null,
    });
  }
  f.item({
    role: "probe",
    label: "deadline",
    cls: "refused",
    code: "disabled",
    outcome: { status: "failed", failure: "disabled", detail: "historical explicit refusal" },
    costUsd: null,
  });
  const report = buildH2Report({ ledger: f.ledger(), journal: f.journal(), registry: f.registry });
  assert.equal(report.probe[0].attempts["provider-failed"], 5);
  assert.equal(report.probe[0].attempts.refused, 1);
});

test("probe metrics on a hand-worked fixture: ties, abstentions, failures, invalid labels and imbalance", () => {
  const f = probeFixture();
  const report = buildH2Report({ ledger: f.ledger(), journal: f.journal(), registry: f.registry });
  assert.equal(report.probe.length, 1);
  assert.equal(report.residual.length, 0);
  const p = report.probe[0];
  assert.deepEqual(p.provider, HAIKU);
  assert.equal(p.question.id, "run.termination-probe");
  assert.equal(p.question.definition, "registered");
  assert.equal(p.projection.id, "run-failure.blind");

  // Attempts by class, and what became an assessment.
  assert.equal(p.attempts.answered, 8);
  assert.equal(p.attempts.abstained, 1);
  assert.equal(p.attempts["provider-failed"], 1);
  assert.equal(p.attempts.refused, 1);
  assert.equal(p.attempts["missing-input"], 1);
  assert.deepEqual([p.assessed, p.answered, p.abstained, p.failed], [10, 8, 1, 1]);
  assert.deepEqual(p.refusals, { "refused:busy": 1, "missing-input:source-unavailable": 1 });

  // References: items 1–8 bear a valid one; 11 and 12 are excluded and named.
  assert.equal(p.reference.bearing, 8);
  assert.deepEqual(p.reference.excluded, { "reference-invalid": 1, "reference-corrupt": 1 });

  // 6 answered (1,2,3,4,5,8), 4 correct (1,2,4,8), 1 tie (3).
  assert.deepEqual(
    [p.accuracyAnswered.k, p.accuracyAnswered.n, p.accuracyAnswered.value],
    [4, 6, 0.666667],
  );
  assert.deepEqual([p.coverage.k, p.coverage.n, p.coverage.value], [6, 8, 0.75]);
  assert.deepEqual(
    [p.accuracyEndToEnd.k, p.accuracyEndToEnd.n, p.accuracyEndToEnd.value],
    [4, 8, 0.5],
  );
  assert.equal(p.ties, 1);

  const cls = Object.fromEntries(p.classes.map((c) => [c.label, c]));
  assert.deepEqual(
    [
      cls["ended-normally"].n,
      cls["ended-normally"].answered,
      cls["ended-normally"].abstained,
      cls["ended-normally"].correct,
    ],
    [4, 3, 1, 2],
  );
  assert.deepEqual(
    [cls.deadline.n, cls.deadline.answered, cls.deadline.failed, cls.deadline.correct],
    [3, 2, 1, 1],
  );
  assert.deepEqual([cls["never-ran"].n, cls["never-ran"].correct], [1, 1]);
  assert.equal(cls["rate-limited"].n, 0);
  assert.equal(cls["rate-limited"].recallAnswered.value, null, "no items: null, not zero");
  // Macro recall: answered-only mean(2/3, 1/2, 1); end-to-end mean(2/4, 1/3, 1).
  assert.equal(p.macroRecall.answered, 0.722222);
  assert.equal(p.macroRecall.endToEnd, 0.611111);
  assert.equal(p.majorityClassShare, 0.5);

  // κ: po = 4/6; pe = (3·3 + 2·1 + 1·1)/36 = 1/3; κ = (2/3 − 1/3)/(2/3) = 0.5.
  assert.deepEqual(p.kappa, { status: "measured", value: 0.5 });
  // Brier: (0.18 + 0.32 + 0.5 + 0.08 + 1.62 + 0)/6 = 0.45.
  assert.deepEqual(p.brier, { status: "measured", value: { value: 0.45, n: 6 } });
  assert.ok(p.reliability.buckets.every((b) => b.status === "unmeasured"));
  assert.equal(p.reliability.minBucket, 20);
  assert.deepEqual(p.ece, { status: "unmeasured", reason: "n = 6 < 200" });

  const cols = p.confusion.columns;
  assert.deepEqual(cols, [...PROBE_OPTIONS, "tie", "abstained", "failed"]);
  const row = (label: string) =>
    Object.fromEntries(
      cols.map((c, i) => [c, p.confusion.counts[p.confusion.rows.indexOf(label)][i]]),
    );
  assert.deepEqual(
    Object.entries(row("ended-normally")).filter(([, v]) => v > 0),
    [
      ["ended-normally", 2],
      ["tie", 1],
      ["abstained", 1],
    ],
  );
  assert.deepEqual(
    Object.entries(row("deadline")).filter(([, v]) => v > 0),
    [
      ["deadline", 1],
      ["ended-normally", 1],
      ["failed", 1],
    ],
  );

  // Usage over the ten assessed items: latencies 100…800, 1100, 1200.
  assert.deepEqual(p.usage.latencyMs, { n: 10, p50: 500, p95: 1200, max: 1200 });
  assert.deepEqual(p.usage.costUsd, { total: 0.09, meanKnown: 0.01, known: 9, unknown: 1 });
  assert.deepEqual(p.usage.snapshotBytes, { n: 10, p50: 1000, p95: 1000, max: 1000 });

  assert.equal(report.integrity.history, "incomplete", "a corrupt and an invalid reference");
  assert.deepEqual(report.integrity.findings.map((x) => x.kind).sort(), [
    "reference-corrupt",
    "reference-invalid",
  ]);
});

test("the census table accounts for every selected item", () => {
  const f = probeFixture();
  const report = buildH2Report({ ledger: f.ledger(), journal: f.journal(), registry: f.registry });
  const [t] = report.census;
  assert.equal(t.role, "probe");
  assert.equal(t.considered, 12);
  const en = t.strata.find((s) => s.stratum === "ended-normally")!;
  // Items 1,2,3,6,9,10,11,12. Assessed: 1,2,3,6,11,12. Pending: 9 and 10 (one no-call try each).
  assert.deepEqual(
    [en.eligible, en.selected, en.assessed, en.pending, en.lost, en.expired, en.abandoned],
    [8, 8, 6, 2, 0, 0, 0],
  );
});

test("residual accuracy is unmeasured; its top answers are descriptive only", () => {
  const f = fixture();
  const p = (named: Record<string, number>): DecisionOutcome => ({
    status: "answered",
    answer: {
      kind: "probability",
      shape: "choice",
      p: Object.fromEntries(
        (RESIDUAL_CAUSE_V1.answers.shape === "choice" ? RESIDUAL_CAUSE_V1.answers.options : []).map(
          (o) => [o.id, named[o.id] ?? 0],
        ),
      ),
    },
  });
  f.item({
    role: "residual",
    label: "ended-normally",
    cls: "answered",
    outcome: p({ "missing-context": 1 }),
  });
  f.item({
    role: "residual",
    label: "deadline",
    cls: "answered",
    outcome: p({ environment: 0.6, other: 0.4 }),
  });
  f.item({
    role: "residual",
    label: "deadline",
    cls: "abstained",
    outcome: { status: "abstained", reason: "?" },
  });
  const report = buildH2Report({ ledger: f.ledger(), journal: f.journal(), registry: f.registry });
  assert.equal(report.probe.length, 0, "never pooled into a probe table");
  const [r] = report.residual;
  assert.equal(r.accuracy.status, "unmeasured");
  assert.match(r.accuracy.reason, /no reference labels/);
  assert.equal(r.probability.status, "unmeasured");
  assert.deepEqual(r.topAnswers, { "missing-context": 1, environment: 1 });
  assert.deepEqual(r.strata, [
    { stratum: "deadline", assessed: 2, answered: 1, abstained: 1, failed: 0 },
    { stratum: "ended-normally", assessed: 1, answered: 1, abstained: 0, failed: 0 },
  ]);
  assert.equal(JSON.stringify(r).includes("accuracyAnswered"), false);
  const baselines = Object.fromEntries(report.baselines.map((b) => [b.provider, b.status]));
  assert.deepEqual(baselines, { deterministic: "not-applicable", autopsy: "not-compared" });
});

test("distinct question versions and model identities are separate populations, never pooled", () => {
  const registry = builtinRegistry();
  const probe = registry.question("run.termination-probe", 1)!.def;
  const v3: DecisionQuestion = { ...probe, version: 3, text: `${probe.text} (v3)` };
  registry.registerQuestion(v3);
  const f = fixture(registry);
  const SONNET = { ...HAIKU, requestedModel: "sonnet" };
  const EN = { "ended-normally": 1 };
  f.item({ role: "probe", label: "ended-normally", cls: "answered", outcome: answered(EN) });
  f.item({
    role: "probe",
    label: "ended-normally",
    cls: "answered",
    outcome: answered(EN),
    identity: SONNET,
  });
  f.item({
    role: "probe",
    label: "ended-normally",
    cls: "answered",
    outcome: answered(EN),
    question: f.q("run.termination-probe", 3),
  });
  const report = buildH2Report({ ledger: f.ledger(), journal: f.journal(), registry });
  assert.deepEqual(
    report.probe.map((p) => [p.question.version, p.provider.requestedModel, p.assessed]).sort(),
    [
      [1, "haiku", 1],
      [1, "sonnet", 1],
      [3, "haiku", 1],
    ],
  );
});

test("missing, mismatched and non-shadow assessments are findings, not scores", () => {
  const f = fixture();
  f.item({
    role: "probe",
    label: "deadline",
    cls: "answered",
    outcome: answered({ deadline: 1 }),
    lose: true,
  });
  f.item({ role: "probe", label: "deadline", cls: "answered", outcome: answered({ deadline: 1 }) });
  const journal = f.journal();
  journal.entries[0] = {
    ...journal.entries[0],
    assessment: { ...journal.entries[0].assessment, mode: "enforcing" },
  };
  journal.gaps.push({
    segment: "seg-00000009",
    reason: "deleted",
    records: 3,
    firstAt: null,
    lastAt: null,
  });
  const report = buildH2Report({ ledger: f.ledger(), journal, registry: f.registry });
  assert.deepEqual(
    report.integrity.findings.map((x) => x.kind),
    ["assessment-missing", "not-shadow"],
  );
  assert.equal(report.probe[0].assessed, 0);
  assert.equal(report.probe[0].reference.bearing, 0);
  assert.equal(report.integrity.journal.gaps, 1);
  assert.equal(report.integrity.history, "incomplete");
});

test("an attempt left open is reconciled from the journal, or reported unresolved", () => {
  const f = fixture();
  f.item({
    role: "probe",
    label: "deadline",
    cls: "answered",
    outcome: answered({ deadline: 1 }),
    noResult: true,
  });
  f.item({ role: "probe", label: "deadline", cls: "answered", noResult: true });
  const report = buildH2Report({ ledger: f.ledger(), journal: f.journal(), registry: f.registry });
  const [p] = report.probe;
  assert.equal(p.attempts.answered, 1);
  assert.equal(p.attempts.unresolved, 1);
  assert.equal(report.census[0].strata[0].lost, 1);
  assert.deepEqual(
    report.integrity.findings.map((x) => x.kind),
    ["reconciled-in-report"],
  );
  assert.equal(report.integrity.history, "complete", "reconciling is informational");
});

test("replay is byte-deterministic and reads no clock", () => {
  const f = probeFixture();
  const a = renderH2Report({ ledger: f.ledger(), journal: f.journal(), registry: f.registry });
  const realNow = Date.now;
  Date.now = () => 0;
  try {
    const b = renderH2Report({ ledger: f.ledger(), journal: f.journal(), registry: f.registry });
    assert.equal(a, b);
  } finally {
    Date.now = realNow;
  }
  assert.equal(a.endsWith("\n"), true);
  assert.equal(JSON.parse(a).report.id, "decision-h2-report");
});

test("an empty collection reports nothing measured and a complete, empty history", () => {
  const report = buildH2Report({
    ledger: { records: [], notices: [], bytes: 0, lastSeq: 0 },
    journal: { segments: [], entries: [], gaps: [], notices: [] },
    registry: builtinRegistry(),
  });
  assert.deepEqual([report.probe, report.residual, report.census], [[], [], []]);
  assert.equal(report.collection.start, null);
  assert.deepEqual(report.asOf, { seq: 0, at: null });
  assert.equal(report.integrity.history, "complete");
  assert.deepEqual(
    report.definitions.map((d) => [d.role, d.id, d.version, d.definition]),
    [
      ["residual", "run.failure-cause.residual", 1, "registered"],
      ["probe", "run.termination-probe", 1, "registered"],
    ],
  );
});

test("references stay usable after the runs and transcripts are pruned, and after journal archival", async () => {
  const runs = [
    endedRun("dl", MIN, { termination: "timed-out", exitCode: null }),
    endedRun("en", MIN),
  ];
  const h = h2Harness({
    env: { ...ON, ARGUS_DECISIONS_H2_RESIDUAL_RATE: "1", ARGUS_DECISIONS_H2_PROBE_RATE: "1" },
    runs,
  });
  await h.watcher.check();
  h.clock.advance(11 * MIN);
  for (let i = 0; i < 6; i++) {
    await h.watcher.check();
    h.clock.advance(16 * MIN);
  }
  assert.equal(h.spawns.length, 4);
  const before = await replayH2(h.ledger, h.journal, h.registry);
  const [p] = before.probe;
  assert.equal(p.reference.bearing, 2);
  assert.equal(p.classes.find((c) => c.label === "deadline")!.n, 1);
  assert.equal(p.accuracyAnswered.k, 1, "the scripted answer says deadline for both");

  // The runs and transcripts are pruned; the journal is archived.
  h.mem.runs.clear();
  h.mem.transcripts.clear();
  rmSync(h.root + "/provider-cwd", { recursive: true, force: true });
  await h.journal.archive();
  const b = h.boot();
  const after = await replayH2(b.ledger, b.journal, h.registry);
  assert.deepEqual(after, before, "the report depends on retained records only");
  assert.equal(h.spawns.length, 4, "replay made no call");
});
