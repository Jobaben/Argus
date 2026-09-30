import type {
  DecisionAssessment,
  DecisionQuestion,
  DefinitionRef,
  H2AttemptClass,
  H2CensusStratum,
  H2CensusTable,
  H2ConfigSummary,
  H2Finding,
  H2PopulationBase,
  H2ProbeClassRow,
  H2ProbePopulation,
  H2QuestionDefinitionRow,
  H2QuestionRole,
  H2Report,
  H2ResidualPopulation,
  ProviderIdentity,
} from "@argus/contracts";
import { checkOutcome } from "../answers.js";
import { canonicalJson } from "../canonical.js";
import type { DecisionJournal, JournalNoticeKind, JournalView } from "../journal.js";
import type { DecisionRegistry } from "../registry.js";
import {
  indexLedger,
  configByDigest,
  latestConfig,
  PRECALL_FAILURES,
  type AttemptEntry,
  type LedgerIndex,
} from "./items.js";
import { BENIGN_LEDGER_NOTICES, type CollectionLedger, type LedgerView } from "./ledger.js";
import {
  brierTerm,
  cohensKappa,
  distribution,
  expectedCalibrationError,
  MIN_BUCKET,
  MIN_ECE_N,
  reliability,
  round6,
  totals,
  uniqueTop,
  wilson,
  type Calibrated,
} from "./metrics.js";
import { H2_QUESTIONS, optionIds, referenceDigest } from "./sampling.js";

/**
 * The H2 report, `decision-h2-report` v1 (RFC §P.7): a deterministic replay
 * of the collection ledger joined to the Decision Journal.
 *
 * It is a reader. It takes no provider and no runner, makes no call, and
 * reads no live Argus record: a run pruned since collection changes nothing
 * here, because the reference that was scored is the one the ledger
 * retained. There is no wall clock either; "pending" means pending as of the
 * last ledger line. The same records and definitions always give the same
 * bytes. The Phase 1 `decision-journal-report` v1 is not changed.
 */

export const H2_REPORT_V1 = { id: "decision-h2-report", version: 1 } as const;

const ATTEMPT_CLASSES: readonly H2AttemptClass[] = [
  "answered",
  "abstained",
  "provider-failed",
  "refused",
  "missing-input",
  "construction-error",
  "unrecorded",
  "unknown-outcome",
  "unresolved",
];
const ASSESSED: ReadonlySet<H2AttemptClass> = new Set(["answered", "abstained", "provider-failed"]);
/** Attempted, possibly spent, and no usable assessment. */
const LOST: ReadonlySet<H2AttemptClass> = new Set(["unrecorded", "unknown-outcome", "unresolved"]);
const JOURNAL_BENIGN: ReadonlySet<JournalNoticeKind> = new Set([
  "torn-tail",
  "recovered-torn-write",
  "duplicate",
]);
/** Findings that describe, without losing or contradicting a record. */
const INFORMATIONAL = new Set(["requested-model-differs", "reconciled-in-report"]);

const UNMEASURED_RESIDUAL =
  "no reference labels exist for the residual question: human corrections are optional (Decision 3) and none are recorded";

export const H2_METHODS: Record<string, string> = {
  population:
    "one table per question id, version and digest, and per recorded provider identity (provider, requestedModel, reportedModel, adapterVersion, elicitation); probe and residual are never pooled",
  denominators:
    "assessed = answered + abstained + provider-failed with its assessment present and consistent; answered-only accuracy = correct / answered with coverage = answered / assessed-with-reference; end-to-end accuracy = correct / assessed-with-reference (abstentions and failures count as not correct); refusals, missing input, unrecorded and unknown outcomes are not assessments and are counted beside the table",
  ties: "the prediction is the unique most probable option; an exact tie is 'tie', which is never correct",
  intervals: "Wilson score interval, 95 % (z = 1.959964); null when n = 0",
  brier:
    "multiclass Brier in the original form: mean over answered reference-bearing items of the sum over all K options of (p − y)²; range 0–2; not divided by K",
  reliability: `top-probability confidence in 10 equal-width bins, bin = min(9, floor(10·p)); a bin is shown only at n ≥ ${MIN_BUCKET}`,
  ece: `n-weighted mean |accuracy − confidence| over non-empty bins, only at N ≥ ${MIN_ECE_N}`,
  kappa: "Cohen's κ over answered items, with 'tie' as a prediction category",
  percentiles: "nearest-rank",
  probabilities:
    "only distributions that validate against the registered question with the recorded digest; ratings and provider statistics are never read as probabilities",
  references:
    "probe references are Argus's observed termination, retained with source digest in the collection ledger at attempt time; residual accuracy is unmeasured without valid labels",
};

// ── Joining ─────────────────────────────────────────────────────────────────

interface Joined {
  entry: AttemptEntry;
  cls: H2AttemptClass;
  code: string | null;
  assessment: DecisionAssessment | null;
  identity: ProviderIdentity;
  /** Scorable: assessed with a present, consistent assessment. */
  assessed: boolean;
}

function refEq(a: DefinitionRef, b: DefinitionRef): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest;
}

function classOf(a: DecisionAssessment): { cls: H2AttemptClass; code: string | null } {
  const o = a.outcome;
  if (o.status === "answered" || o.status === "abstained") return { cls: o.status, code: null };
  return { cls: PRECALL_FAILURES.has(o.failure) ? "refused" : "provider-failed", code: o.failure };
}

function join(
  idx: LedgerIndex,
  byId: ReadonlyMap<string, DecisionAssessment>,
  findings: H2Finding[],
): Joined[] {
  const out: Joined[] = [];
  for (const entry of idx.attempts) {
    const a = entry.attempt;
    const found = byId.get(a.assessmentId) ?? null;
    let cls: H2AttemptClass;
    let code: string | null;
    if (entry.result) {
      cls = entry.result.class;
      code = entry.result.code;
    } else if (found) {
      ({ cls, code } = classOf(found));
      findings.push({
        kind: "reconciled-in-report",
        line: entry.line,
        attemptId: a.attemptId,
        detail: "no result line; classified from the journal's assessment",
      });
    } else {
      cls = "unresolved";
      code = null;
    }
    const expectsAssessment = entry.result ? entry.result.assessmentId !== null : found !== null;
    let assessment: DecisionAssessment | null = null;
    if (expectsAssessment && !found) {
      findings.push({
        kind: "assessment-missing",
        line: entry.line,
        attemptId: a.attemptId,
        detail: `assessment ${a.assessmentId} is not in the journal (deleted, damaged or never written)`,
      });
    } else if (found) {
      const problems: string[] = [];
      if (found.subject.kind !== "run" || found.subject.runId !== a.runId) problems.push("subject");
      if (!refEq(found.question, a.question)) problems.push("question");
      if (!refEq(found.snapshot.projection, a.projection)) problems.push("projection");
      if (found.provider.provider !== a.provider.provider) problems.push("provider");
      if (found.sample !== a.sample) problems.push("sample");
      if (entry.result?.outcome && entry.result.outcome.status !== found.outcome.status)
        problems.push("outcome");
      if (found.mode !== "shadow") {
        findings.push({
          kind: "not-shadow",
          line: entry.line,
          attemptId: a.attemptId,
          detail: `assessment ${found.id} is mode ${found.mode}`,
        });
      } else if (problems.length > 0) {
        findings.push({
          kind: "assessment-mismatch",
          line: entry.line,
          attemptId: a.attemptId,
          detail: `assessment ${found.id} differs from its attempt in: ${problems.join(", ")}`,
        });
      } else {
        assessment = found;
        if (found.provider.requestedModel !== a.provider.requestedModel) {
          findings.push({
            kind: "requested-model-differs",
            line: entry.line,
            attemptId: a.attemptId,
            detail: `requested ${String(a.provider.requestedModel)}, the runner passed ${String(found.provider.requestedModel)}`,
          });
        }
      }
    }
    const identity: ProviderIdentity = assessment
      ? assessment.provider
      : { ...a.provider, reportedModel: null };
    out.push({
      entry,
      cls,
      code,
      assessment,
      identity,
      assessed: ASSESSED.has(cls) && assessment !== null,
    });
  }
  return out;
}

// ── Populations ─────────────────────────────────────────────────────────────

const identityKey = (p: ProviderIdentity) =>
  canonicalJson({
    provider: p.provider,
    requestedModel: p.requestedModel,
    reportedModel: p.reportedModel,
    adapterVersion: p.adapterVersion,
    elicitation: p.elicitation,
  });

function definitionStatus(
  registry: DecisionRegistry,
  ref: DefinitionRef,
): { status: "registered" | "missing" | "digest-mismatch"; def: DecisionQuestion | null } {
  const q = registry.question(ref.id, ref.version);
  if (!q) return { status: "missing", def: null };
  if (q.ref.digest !== ref.digest) return { status: "digest-mismatch", def: null };
  return { status: "registered", def: q.def };
}

function baseOf(group: Joined[], registry: DecisionRegistry): H2PopulationBase {
  const first = group[0];
  const q = first.entry.attempt.question;
  const attempts = Object.fromEntries(ATTEMPT_CLASSES.map((c) => [c, 0])) as Record<
    H2AttemptClass,
    number
  >;
  const refusals: Record<string, number> = {};
  for (const j of group) {
    attempts[j.cls]++;
    if (j.cls === "refused" || j.cls === "missing-input" || j.cls === "construction-error") {
      const k = `${j.cls}:${j.code ?? "unspecified"}`;
      refusals[k] = (refusals[k] ?? 0) + 1;
    }
  }
  const assessed = group.filter((j) => j.assessed);
  const count = (s: string) => assessed.filter((j) => j.assessment!.outcome.status === s).length;
  return {
    question: {
      id: q.id,
      version: q.version,
      digest: q.digest,
      definition: definitionStatus(registry, q).status,
    },
    projection: { ...first.entry.attempt.projection },
    provider: { ...first.identity },
    attempts,
    assessed: assessed.length,
    answered: count("answered"),
    abstained: count("abstained"),
    failed: count("failed"),
    refusals,
    usage: {
      latencyMs: distribution(assessed.map((j) => j.assessment!.latencyMs)),
      costUsd: totals(assessed.map((j) => j.assessment!.costUsd)),
      tokens: totals(assessed.map((j) => j.assessment!.tokens)),
      snapshotBytes: distribution(assessed.map((j) => j.assessment!.snapshot.bytes)),
    },
  };
}

function probePopulation(
  group: Joined[],
  registry: DecisionRegistry,
  findings: H2Finding[],
): H2ProbePopulation {
  const base = baseOf(group, registry);
  const qref = group[0].entry.attempt.question;
  const { def } = definitionStatus(registry, qref);
  const options = def ? optionIds(def.answers) : [];
  const excluded: Record<string, number> = {};
  const exclude = (j: Joined, reason: string, kind: string | null, detail: string) => {
    excluded[reason] = (excluded[reason] ?? 0) + 1;
    if (kind)
      findings.push({ kind, line: j.entry.line, attemptId: j.entry.attempt.attemptId, detail });
  };

  interface Scored {
    label: string;
    status: "answered" | "abstained" | "failed";
    top: string | null;
    p: Record<string, number> | null;
  }
  const scored: Scored[] = [];
  for (const j of group) {
    if (!j.assessed) continue;
    const a = j.assessment!;
    const ref = j.entry.attempt.reference;
    if (!def) {
      exclude(j, "question-definition-unavailable", null, "");
      continue;
    }
    if (!ref) {
      exclude(
        j,
        "reference-missing",
        "reference-missing",
        "a probe attempt with no retained reference",
      );
      continue;
    }
    const { digest, ...rest } = ref;
    if (referenceDigest(rest) !== digest) {
      exclude(
        j,
        "reference-corrupt",
        "reference-corrupt",
        "the retained reference does not match its digest",
      );
      continue;
    }
    if (!refEq(ref.answerSpace, qref)) {
      exclude(
        j,
        "reference-mismatch",
        "reference-mismatch",
        "the reference was validated against another question",
      );
      continue;
    }
    if (!options.includes(ref.label)) {
      exclude(
        j,
        "reference-invalid",
        "reference-invalid",
        `construction error: "${ref.label}" is not an option of ${qref.id}@${qref.version}`,
      );
      continue;
    }
    if (a.outcome.status === "answered") {
      const ans = a.outcome.answer;
      if (
        checkOutcome(def.answers, a.outcome) !== null ||
        ans.kind !== "probability" ||
        ans.shape !== "choice"
      ) {
        exclude(
          j,
          "invalid-distribution",
          "invalid-distribution",
          "the stored answer does not validate against the question",
        );
        continue;
      }
      scored.push({
        label: ref.label,
        status: "answered",
        top: uniqueTop(ans.p, options),
        p: ans.p,
      });
    } else {
      scored.push({ label: ref.label, status: a.outcome.status, top: null, p: null });
    }
  }

  const answered = scored.filter((s) => s.status === "answered");
  const correct = answered.filter((s) => s.top === s.label).length;
  const classes: H2ProbeClassRow[] = options.map((label) => {
    const mine = scored.filter((s) => s.label === label);
    const ans = mine.filter((s) => s.status === "answered");
    const ok = ans.filter((s) => s.top === label).length;
    return {
      label,
      n: mine.length,
      answered: ans.length,
      abstained: mine.filter((s) => s.status === "abstained").length,
      failed: mine.filter((s) => s.status === "failed").length,
      correct: ok,
      recallAnswered: wilson(ok, ans.length),
      recallEndToEnd: wilson(ok, mine.length),
    };
  });
  const columns = [...options, "tie", "abstained", "failed"];
  const counts = options.map((label) =>
    columns.map(
      (col) =>
        scored.filter(
          (s) =>
            s.label === label &&
            (col === "abstained" || col === "failed"
              ? s.status === col
              : s.status === "answered" && s.top === col),
        ).length,
    ),
  );
  const mean = (xs: number[]) =>
    xs.length ? round6(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const kappa = cohensKappa(answered.map((s) => [s.label, s.top!] as const));
  const calibrated: Calibrated[] = answered.map((s) => ({
    confidence: Math.max(...options.map((k) => s.p![k])),
    correct: s.top === s.label,
  }));
  const brier = answered.length
    ? round6(
        answered.reduce((sum, s) => sum + brierTerm(s.p!, options, s.label), 0) / answered.length,
      )
    : null;
  const ece = expectedCalibrationError(calibrated);
  const noAnswered = "no answered item with a valid reference and a validated distribution";
  return {
    ...base,
    reference: { stream: "observed-termination", bearing: scored.length, excluded },
    classes,
    confusion: { rows: options, columns, counts },
    ties: answered.filter((s) => s.top === "tie").length,
    accuracyAnswered: wilson(correct, answered.length),
    coverage: wilson(answered.length, scored.length),
    accuracyEndToEnd: wilson(correct, scored.length),
    macroRecall: {
      answered: mean(classes.filter((c) => c.answered > 0).map((c) => c.correct / c.answered)),
      endToEnd: mean(classes.filter((c) => c.n > 0).map((c) => c.correct / c.n)),
    },
    majorityClassShare: scored.length
      ? round6(Math.max(...classes.map((c) => c.n)) / scored.length)
      : null,
    kappa:
      kappa === null
        ? { status: "unmeasured", reason: answered.length ? "chance agreement is 1" : noAnswered }
        : { status: "measured", value: kappa },
    brier:
      brier === null
        ? { status: "unmeasured", reason: noAnswered }
        : { status: "measured", value: { value: brier, n: answered.length } },
    reliability: { minBucket: MIN_BUCKET, buckets: reliability(calibrated) },
    ece:
      ece === null
        ? { status: "unmeasured", reason: `n = ${calibrated.length} < ${MIN_ECE_N}` }
        : { status: "measured", value: { value: ece, n: calibrated.length } },
  };
}

function residualPopulation(
  group: Joined[],
  registry: DecisionRegistry,
  findings: H2Finding[],
): H2ResidualPopulation {
  const base = baseOf(group, registry);
  const { def } = definitionStatus(registry, group[0].entry.attempt.question);
  const options = def ? optionIds(def.answers) : [];
  const strata = new Map<
    string,
    { assessed: number; answered: number; abstained: number; failed: number }
  >();
  const topAnswers: Record<string, number> = {};
  for (const j of group) {
    if (j.entry.attempt.reference !== null) {
      findings.push({
        kind: "unexpected-reference",
        line: j.entry.line,
        attemptId: j.entry.attempt.attemptId,
        detail:
          "a residual attempt carries a reference; the residual question has no reference stream",
      });
    }
    if (!j.assessed) continue;
    const a = j.assessment!;
    const s = strata.get(j.entry.attempt.stratum.class) ?? {
      assessed: 0,
      answered: 0,
      abstained: 0,
      failed: 0,
    };
    s.assessed++;
    s[a.outcome.status]++;
    strata.set(j.entry.attempt.stratum.class, s);
    if (a.outcome.status === "answered" && def && checkOutcome(def.answers, a.outcome) === null) {
      const ans = a.outcome.answer;
      if (ans.kind === "probability" && ans.shape === "choice") {
        const top = uniqueTop(ans.p, options);
        topAnswers[top] = (topAnswers[top] ?? 0) + 1;
      }
    }
  }
  return {
    ...base,
    strata: [...strata.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([stratum, s]) => ({ stratum, ...s })),
    accuracy: { status: "unmeasured", reason: UNMEASURED_RESIDUAL },
    probability: { status: "unmeasured", reason: UNMEASURED_RESIDUAL },
    topAnswers,
  };
}

// ── Census ──────────────────────────────────────────────────────────────────

function roleOf(idx: LedgerIndex, id: string): H2QuestionRole | null {
  for (const c of idx.configs) {
    const q = c.config.sampling.questions.find((x) => x.id === id);
    if (q) return q.role;
  }
  if (id === H2_QUESTIONS.residual.id) return "residual";
  if (id === H2_QUESTIONS.probe.id) return "probe";
  return null;
}

function censusTables(idx: LedgerIndex, joined: Joined[]): H2CensusTable[] {
  const byAttempt = new Map(joined.map((j) => [j.entry.attempt.attemptId, j]));
  const tables = new Map<string, H2CensusTable & { rows: Map<string, H2CensusStratum> }>();
  const fallbackTries = latestConfig(idx)?.config.limits.maxTriesPerItem ?? 3;
  for (const [key, c] of idx.census) {
    const qk = `${c.question.id}@${c.question.version}`;
    const role = roleOf(idx, c.question.id);
    if (!role) continue;
    const t =
      tables.get(qk) ??
      ({
        role,
        question: { id: c.question.id, version: c.question.version },
        considered: 0,
        excluded: {},
        strata: [],
        rows: new Map(),
      } as H2CensusTable & { rows: Map<string, H2CensusStratum> });
    tables.set(qk, t);
    t.considered++;
    if (c.verdict === "excluded") {
      const r = c.reason ?? "unspecified";
      t.excluded[r] = (t.excluded[r] ?? 0) + 1;
      continue;
    }
    const row =
      t.rows.get(c.stratum) ??
      ({
        stratum: c.stratum,
        eligible: 0,
        selected: 0,
        notSelected: 0,
        assessed: 0,
        lost: 0,
        constructionError: 0,
        expired: 0,
        abandoned: 0,
        pending: 0,
      } as H2CensusStratum);
    t.rows.set(c.stratum, row);
    row.eligible++;
    if (c.verdict === "not-selected") {
      row.notSelected++;
      continue;
    }
    row.selected++;
    const item = idx.items.get(key)!;
    const lastConfig = item.attempts.length
      ? configByDigest(idx, item.attempts[item.attempts.length - 1].attempt.config)
      : null;
    const maxTries = lastConfig?.config.limits.maxTriesPerItem ?? fallbackTries;
    const classes = item.attempts.map((e) => byAttempt.get(e.attempt.attemptId)!);
    if (classes.some((j) => j.assessed)) row.assessed++;
    else if (classes.some((j) => LOST.has(j.cls) || (ASSESSED.has(j.cls) && !j.assessment)))
      row.lost++;
    else if (classes.some((j) => j.cls === "construction-error")) row.constructionError++;
    else if (item.expired) row.expired++;
    else if (classes.length >= maxTries) row.abandoned++;
    else row.pending++;
  }
  return [...tables.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([, { rows, ...t }]) => ({
      ...t,
      strata: [...rows.values()].sort((a, b) => (a.stratum < b.stratum ? -1 : 1)),
    }));
}

// ── The report ──────────────────────────────────────────────────────────────

export interface H2ReplayInputs {
  ledger: LedgerView;
  journal: JournalView;
  registry: DecisionRegistry;
}

export function buildH2Report({ ledger, journal, registry }: H2ReplayInputs): H2Report {
  const idx = indexLedger(ledger);
  const findings: H2Finding[] = [];
  const byId = new Map<string, DecisionAssessment>();
  for (const e of journal.entries)
    if (!byId.has(e.assessment.id)) byId.set(e.assessment.id, e.assessment);
  const joined = join(idx, byId, findings);
  for (const s of idx.strayAttempts) {
    findings.push({
      kind: "stray-attempt",
      line: s.line,
      attemptId: s.attempt.attemptId,
      detail: "an attempt for an item with no selected census line",
    });
  }

  // Populations: role by question id, then question version and digest, then identity.
  const groups = new Map<string, { role: H2QuestionRole; items: Joined[] }>();
  for (const j of joined) {
    const q = j.entry.attempt.question;
    const role = roleOf(idx, q.id);
    if (!role) continue;
    const key = canonicalJson([
      role,
      q.id,
      q.version,
      q.digest,
      j.entry.attempt.projection.digest,
      identityKey(j.identity),
    ]);
    const g = groups.get(key) ?? { role, items: [] };
    g.items.push(j);
    groups.set(key, g);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, g]) => g);
  const probe = sorted
    .filter((g) => g.role === "probe")
    .map((g) => probePopulation(g.items, registry, findings));
  const residual = sorted
    .filter((g) => g.role === "residual")
    .map((g) => residualPopulation(g.items, registry, findings));

  // Definitions: every question the ledger names, and the built-in pair.
  const seen = new Map<string, { role: H2QuestionRole; id: string; version: number }>();
  const add = (role: H2QuestionRole, id: string, version: number) => {
    const k = `${id}@${version}`;
    if (!seen.has(k)) seen.set(k, { role, id, version });
  };
  add("residual", H2_QUESTIONS.residual.id, H2_QUESTIONS.residual.version);
  add("probe", H2_QUESTIONS.probe.id, H2_QUESTIONS.probe.version);
  for (const c of idx.configs)
    for (const q of c.config.sampling.questions) add(q.role, q.id, q.version);
  const definitions: H2QuestionDefinitionRow[] = [...seen.values()]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version))
    .map(({ role, id, version }) => {
      const q = registry.question(id, version);
      const recorded = idx.configs
        .flatMap((c) => c.config.sampling.questions)
        .find((x) => x.id === id && x.version === version)?.digest;
      const p = q ? registry.projection(q.def.projection.id, q.def.projection.version) : null;
      return {
        role,
        id,
        version,
        digest: q?.ref.digest ?? recorded ?? null,
        definition: !q
          ? "missing"
          : recorded && recorded !== q.ref.digest
            ? "digest-mismatch"
            : "registered",
        projection: p ? { ...p.ref } : null,
        options: q ? optionIds(q.def.answers) : [],
      };
    });

  const configs: H2ConfigSummary[] = idx.configs.map((c) => ({
    digest: c.digest,
    firstAt: c.at,
    seed: c.config.sampling.seed,
    rates: c.config.sampling.questions.map((q) => ({ id: q.id, version: q.version, rate: q.rate })),
    window: { ...c.config.window },
    limits: { ...c.config.limits },
    provider: {
      provider: c.config.provider.provider,
      requestedModel: c.config.provider.requestedModel,
      adapterVersion: c.config.provider.adapterVersion,
    },
    census: [...idx.census.values()].filter((x) => x.config === c.digest).length,
    attempts: idx.attempts.filter((e) => e.attempt.config === c.digest).length,
  }));

  const named = new Set(idx.attempts.map((e) => e.attempt.assessmentId));
  const last = ledger.records[ledger.records.length - 1]?.record ?? null;
  const journalNotices = journal.notices.map((n) => ({
    kind: n.kind,
    segment: n.segment ?? null,
    line: n.line ?? null,
    detail: n.detail,
  }));
  const complete =
    ledger.notices.every((n) => BENIGN_LEDGER_NOTICES.has(n.kind)) &&
    journal.gaps.length === 0 &&
    journal.notices.every((n) => JOURNAL_BENIGN.has(n.kind)) &&
    findings.every((f) => INFORMATIONAL.has(f.kind));

  return {
    report: { ...H2_REPORT_V1 },
    asOf: { seq: ledger.lastSeq, at: last?.at ?? null },
    collection: { start: idx.start?.at ?? null, configs },
    definitions,
    census: censusTables(idx, joined),
    probe,
    residual,
    baselines: [
      {
        provider: "deterministic",
        status: "not-applicable",
        reason:
          "the deterministic provider has no H2 rules: observed termination is an observation, no rule infers a residual cause, and answering the probe from withheld fields would be circular (§O.4)",
      },
      {
        provider: "autopsy",
        status: "not-compared",
        reason:
          "Autopsy classifies on its own 11-way taxonomy with its own provenance; no mapping to either H2 question is published, so it is not compared numerically",
      },
    ],
    outsideExperiment: [...byId.keys()].filter((id) => !named.has(id)).length,
    methods: { ...H2_METHODS },
    integrity: {
      history: complete ? "complete" : "incomplete",
      ledger: ledger.notices.map((n) => ({
        kind: n.kind,
        line: n.line,
        attemptId: null,
        detail: n.detail,
      })),
      journal: { gaps: journal.gaps.length, notices: journalNotices },
      findings,
    },
  };
}

export function renderH2Report(inputs: H2ReplayInputs): string {
  return `${canonicalJson(buildH2Report(inputs))}\n`;
}

/** Replay from disk. Reads the ledger and the journal; calls nothing else and writes nothing. */
export async function replayH2(
  ledger: Pick<CollectionLedger, "read">,
  journal: Pick<DecisionJournal, "read">,
  registry: DecisionRegistry,
): Promise<H2Report> {
  const [l, j] = await Promise.all([ledger.read(), journal.read()]);
  return buildH2Report({ ledger: l, journal: j, registry });
}
