/**
 * The Decision Plane's shared contracts (RFC 2026-09-29, §E–§F, §O).
 *
 * An assessment is authoritative only about the fact that an inference
 * happened — never about the world. Nothing here is an `EvidenceSource`, a
 * claim, a support verdict or a permission, and no type below carries an
 * effect that grants: the policy contract can only add friction.
 *
 * Four kinds of number are kept in different fields so that none can be read
 * as another (§F.1): a **rating** (an ordinal position on an author's scale —
 * `Verdict.score / 10` is a normalised rating, not a probability), a
 * **predicted probability** (meaning depends on its elicitation), a **provider
 * confidence statistic** (recorded verbatim, never a policy input), and an
 * **observed outcome** (what happened, recorded apart from any prediction).
 */

import type { ClaimRef, ArtifactRef, KnowledgeScope, RepositoryStateRef } from "./knowledge.js";
import type { GateDecisionKind, GateDecisionPrincipal } from "./gates.js";

// ── Subjects and questions ──────────────────────────────────────────────────

/** What is being asked about. Always a record or an execution, never a claim's truth. */
export type DecisionSubject =
  | { kind: "run"; runId: string }
  | { kind: "phase-attempt"; instanceId: string; phaseId: string; attempt: number }
  | { kind: "rule-verification"; verificationId: string }
  | { kind: "acceptance-verification"; verificationId: string };

export type DecisionSubjectKind = DecisionSubject["kind"];

/**
 * A closed answer space. Option ids are slugs; scale points are finite numbers
 * keyed in answers by their JavaScript string form (`String(value)`).
 * `sumTolerance` is how far a provider's distribution may sum from 1 before it
 * is refused rather than renormalised; it is part of the question definition,
 * so changing it bumps the question version.
 */
export type AnswerSpace =
  | { shape: "binary" }
  | {
      shape: "choice";
      options: Array<{ id: string; label: string }>;
      sumTolerance: number;
    }
  | {
      shape: "scale";
      points: Array<{ value: number; label?: string }>;
      sumTolerance: number;
    };

/** A versioned reference to a definition, with the digest of the exact definition used. */
export interface DefinitionRef {
  id: string;
  version: number;
  /** sha256 over the canonical JSON of the definition. */
  digest: string;
}

export interface DecisionQuestion {
  /** e.g. `run.failure-cause.residual`. */
  id: string;
  /** Bumped on ANY change to wording, answer space or projection. */
  version: number;
  /** The question as a provider-neutral domain sentence. */
  text: string;
  answers: AnswerSpace;
  subject: DecisionSubjectKind;
  /** Which projection builds its snapshot. */
  projection: { id: string; version: number };
  /**
   * Declared consumers (policy ids). A policy not listed may not read this
   * question. Always empty in Phase 1: no question has an enforcing consumer.
   */
  consumers: string[];
}

/** A projection definition: what a snapshot builder reads, and how it bounds and redacts. */
export interface DecisionProjection {
  id: string;
  version: number;
  subject: DecisionSubjectKind;
  description: string;
  /** Hard ceiling on the canonical snapshot bytes this projection may produce. */
  maxBytes: number;
  /** Redaction rules applied, by `id@version`, in order. */
  redactionRules: string[];
  /** Truncation rule, by `id@version`, and the per-field caps it enforces. */
  truncation: { rule: string; caps: Record<string, number> };
  /** Fields of the source deliberately withheld from the body. */
  withheld: string[];
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export interface SnapshotRedaction {
  /** `id@version` of the rule. */
  rule: string;
  /** How many matches it replaced, across the whole body. */
  count: number;
}

export interface SnapshotTruncation {
  /** JSON pointer into `body`. */
  pointer: string;
  /** Unicode code points before and after truncation. */
  originalCodePoints: number;
  keptCodePoints: number;
}

/**
 * The typed, retained input to an assessment: exactly what was evaluated,
 * after redaction and truncation.
 *
 * The stored snapshot file is the canonical JSON of this object. Its sha256
 * and byte length are computed over those bytes and live **outside** them
 * (`StoredSnapshot`), so there is no self-reference.
 */
export interface SnapshotContent {
  format: "argus.decision-snapshot";
  formatVersion: 1;
  projection: DefinitionRef;
  subject: DecisionSubject;
  scope?: KnowledgeScope;
  /** Argus-recorded, when the subject is state-dependent. Never the agent's claim. */
  repository?: RepositoryStateRef;
  /** What the body was built from. */
  refs: {
    runs: string[];
    claims: ClaimRef[];
    verifications: string[];
    artifacts: ArtifactRef[];
  };
  /** JSON pointers into `body` that the subject itself authored (asymmetric authority). */
  subjectAuthored: string[];
  redactions: SnapshotRedaction[];
  truncations: SnapshotTruncation[];
  /** Typed per projection. */
  body: unknown;
}

export interface StoredSnapshot {
  sha256: string;
  bytes: number;
  content: SnapshotContent;
}

// ── Answers and provenance ──────────────────────────────────────────────────

/** A provider's answer, by kind (§F.1). A rating is never stored as a probability. */
export type DecisionAnswer =
  | { kind: "probability"; shape: "binary"; p: number }
  | { kind: "probability"; shape: "choice"; p: Record<string, number> }
  | { kind: "probability"; shape: "scale"; p: Record<string, number> }
  | { kind: "rating"; value: number; scale: { min: number; max: number } };

/** Audit of a renormalisation: what the provider actually said. */
export interface AnswerNormalization {
  method: "divide-by-sum";
  rawSum: number;
  raw: Record<string, number>;
}

export type DecisionProviderKind =
  "claude-cli" | "codex-cli" | "jev" | "deterministic" | "human" | "mock";

export interface ProviderIdentity {
  provider: DecisionProviderKind;
  /** What Argus asked for (an alias such as "haiku", or a pinned id); null = the CLI's default. */
  requestedModel: string | null;
  /** What the provider's response said it evaluated with. Null = not reported —
   *  never back-filled from the request, never synthesised. */
  reportedModel: string | null;
  /** Rendering/parsing code version. */
  adapterVersion: number;
  /** How the probability came to exist. Not comparable across kinds without calibration. */
  elicitation: "native" | "verbalized" | "sampled" | "rule" | "label";
}

export type DecisionOutcome =
  | {
      status: "answered";
      answer: DecisionAnswer;
      /** Present when the provider's distribution was renormalised. */
      normalization?: AnswerNormalization;
      /** Verbatim, keyed by the provider's own names; never read by policy as P(correct). */
      providerStatistics?: Record<string, number>;
      /** Display only. */
      rationale?: string;
    }
  | { status: "abstained"; reason: string }
  | {
      status: "failed";
      /** A stable code, e.g. `invalid-answer`, `timeout`, `budget-blocked`. */
      failure: string;
      detail: string;
      /** A bounded excerpt of what the provider returned, for audit. */
      rawExcerpt?: string;
    };

/** Phase 1 writes only `shadow`: no policy consumes an assessment. */
export type DecisionMode = "shadow" | "advisory" | "enforcing";

export interface DecisionAssessment {
  /** `DA-…` */
  id: string;
  question: DefinitionRef;
  subject: DecisionSubject;
  snapshot: { sha256: string; bytes: number; projection: DefinitionRef };
  provider: ProviderIdentity;
  /** 0..n-1 for repeated calls. */
  sample: number;
  /** Set on a re-evaluation: a NEW provider call on the retained snapshot of `DA-…`. */
  reEvaluates?: string;
  outcome: DecisionOutcome;
  mode: DecisionMode;
  latencyMs: number;
  costUsd: number | null;
  tokens: number | null;
  createdAt: string;
}

// ── Observations ────────────────────────────────────────────────────────────

/**
 * What happened, recorded apart from what was predicted (§F.1). Derived
 * read-only from existing durable records (§O.1); never written by the engine.
 */
export type DecisionObservation =
  | {
      kind: "operator-action";
      subject: Extract<DecisionSubject, { kind: "phase-attempt" }>;
      value: GateDecisionKind;
      principal: GateDecisionPrincipal;
      source: ObservationSource;
      observedAt: string;
    }
  | {
      kind: "observed-termination";
      subject: Extract<DecisionSubject, { kind: "run" }>;
      value: ObservedTerminationClass;
      source: ObservationSource;
      observedAt: string;
    }
  | {
      /** Contract only: no durable source exists in Phase 1, so none is derived. */
      kind: "review-finding" | "later-outcome";
      subject: DecisionSubject;
      value: string;
      source: ObservationSource;
      observedAt: string;
    };

export interface ObservationSource {
  store: "gate-decisions" | "runs";
  recordId: string;
  /** sha256 over the canonical JSON of the source record as read. */
  recordDigest: string;
}

/** The termination classes Argus can observe from a run record (§H.2, §O.1). */
export type ObservedTerminationClass = "deadline" | "never-ran" | "ended-normally";

// ── Policy (contract only) ──────────────────────────────────────────────────

/**
 * Policies can only add friction. There is deliberately no effect that removes
 * a human wait or opens a gate; any future automation that would is a separate
 * design decision, not a value of this type. Phase 1 defines no policy.
 */
export interface DecisionPolicy {
  id: string;
  version: number;
  question: { id: string; version: number };
  providers: DecisionProviderKind[];
  aggregate: "latest-current" | "all-samples" | "min" | "disagreement";
  effect: "escalate" | "flag" | "withhold-auto-approval";
  threshold: number;
}

// ── Currency (derived, never stored) ────────────────────────────────────────

export type CurrencyStatus = "current" | "stale" | "unavailable";

export interface CurrencyCheck {
  check:
    | "question-definition"
    | "question-version"
    | "projection-definition"
    | "snapshot"
    | "subject"
    | "claim-revisions"
    | "repository-state";
  status: CurrencyStatus;
  detail: string;
}

export interface AssessmentCurrency {
  assessmentId: string;
  status: CurrencyStatus;
  checks: CurrencyCheck[];
}

// ── H2 shadow experiment: collection status and report (§P) ─────────────────

/**
 * The H2 questions' roles. Probe and residual are different questions over
 * different populations, and nothing below ever pools them (§H.2, §P.7).
 */
export type H2QuestionRole = "residual" | "probe";

/**
 * What became of one collection attempt (§P.5). Only `answered`, `abstained`
 * and `provider-failed` are assessments. `refused`, `missing-input` and
 * `construction-error` made no provider call. `unrecorded` made a call whose
 * outcome could not be stored. `unknown-outcome` may or may not have made a
 * call. `unresolved` is an attempt the report found without a result, and
 * without an assessment to reconcile it from.
 */
export type H2AttemptClass =
  | "answered"
  | "abstained"
  | "provider-failed"
  | "refused"
  | "missing-input"
  | "construction-error"
  | "unrecorded"
  | "unknown-outcome"
  | "unresolved";

export type H2Measured<T> =
  { status: "measured"; value: T } | { status: "unmeasured"; reason: string };

/** A proportion with its Wilson 95 % interval; `value` and `ci95` are null when n = 0. */
export interface H2Proportion {
  k: number;
  n: number;
  value: number | null;
  ci95: [number, number] | null;
}

export interface H2Distribution {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface H2Usage {
  latencyMs: H2Distribution;
  costUsd: { total: number; meanKnown: number | null; known: number; unknown: number };
  tokens: { total: number; meanKnown: number | null; known: number; unknown: number };
  snapshotBytes: H2Distribution;
}

export interface H2Finding {
  kind: string;
  /** The ledger line, when the finding is about one. */
  line: number | null;
  attemptId: string | null;
  detail: string;
}

export interface H2QuestionDefinitionRow {
  role: H2QuestionRole;
  id: string;
  version: number;
  digest: string | null;
  definition: "registered" | "missing" | "digest-mismatch";
  projection: { id: string; version: number; digest: string } | null;
  options: string[];
}

export interface H2CensusStratum {
  /** The observed termination class, or `not-derivable`. */
  stratum: string;
  eligible: number;
  selected: number;
  notSelected: number;
  assessed: number;
  /** Attempted, but no usable assessment: unrecorded, unknown or unresolved. */
  lost: number;
  constructionError: number;
  expired: number;
  /** Retries exhausted without a provider call. */
  abandoned: number;
  pending: number;
}

export interface H2CensusTable {
  role: H2QuestionRole;
  question: { id: string; version: number };
  considered: number;
  /** Exclusion reason → runs. */
  excluded: Record<string, number>;
  strata: H2CensusStratum[];
}

export interface H2PopulationBase {
  question: {
    id: string;
    version: number;
    digest: string;
    definition: "registered" | "missing" | "digest-mismatch";
  };
  projection: { id: string; version: number; digest: string };
  provider: ProviderIdentity;
  attempts: Record<H2AttemptClass, number>;
  assessed: number;
  answered: number;
  abstained: number;
  failed: number;
  /** Refusal code → attempts, for attempts that made no provider call. */
  refusals: Record<string, number>;
  usage: H2Usage;
}

export interface H2ProbeClassRow {
  label: string;
  /** Assessed items bearing this reference label. */
  n: number;
  answered: number;
  abstained: number;
  failed: number;
  correct: number;
  recallAnswered: H2Proportion;
  recallEndToEnd: H2Proportion;
}

export interface H2ReliabilityBucket {
  lower: number;
  upper: number;
  n: number;
  status: "measured" | "unmeasured";
  meanConfidence: number | null;
  accuracy: number | null;
}

export interface H2ProbePopulation extends H2PopulationBase {
  reference: {
    stream: "observed-termination";
    /** Assessed items with a valid retained reference. */
    bearing: number;
    /** Reason → assessed items excluded from scoring. */
    excluded: Record<string, number>;
  };
  classes: H2ProbeClassRow[];
  confusion: { rows: string[]; columns: string[]; counts: number[][] };
  ties: number;
  accuracyAnswered: H2Proportion;
  coverage: H2Proportion;
  accuracyEndToEnd: H2Proportion;
  macroRecall: { answered: number | null; endToEnd: number | null };
  majorityClassShare: number | null;
  kappa: H2Measured<number>;
  brier: H2Measured<{ value: number; n: number }>;
  reliability: { minBucket: number; buckets: H2ReliabilityBucket[] };
  ece: H2Measured<{ value: number; n: number }>;
}

export interface H2ResidualPopulation extends H2PopulationBase {
  strata: Array<{
    stratum: string;
    assessed: number;
    answered: number;
    abstained: number;
    failed: number;
  }>;
  accuracy: { status: "unmeasured"; reason: string };
  probability: { status: "unmeasured"; reason: string };
  /** Descriptive only: how often each option was the top answer. Not accuracy. */
  topAnswers: Record<string, number>;
}

export interface H2ConfigSummary {
  digest: string;
  firstAt: string;
  seed: string;
  rates: Array<{ id: string; version: number; rate: number }>;
  window: { minAgeMs: number; maxAgeMs: number };
  limits: {
    maxCallsPer24h: number;
    minCallIntervalMs: number;
    maxUsdPer24h: number;
    maxTriesPerItem: number;
    retryAfterMs: number;
  };
  provider: {
    provider: DecisionProviderKind;
    requestedModel: string | null;
    adapterVersion: number;
  };
  census: number;
  attempts: number;
}

export interface H2Report {
  report: { id: "decision-h2-report"; version: 1 };
  /** The last ledger line the report read; no wall clock is involved. */
  asOf: { seq: number; at: string | null };
  collection: { start: string | null; configs: H2ConfigSummary[] };
  definitions: H2QuestionDefinitionRow[];
  census: H2CensusTable[];
  probe: H2ProbePopulation[];
  residual: H2ResidualPopulation[];
  baselines: Array<{
    provider: "deterministic" | "autopsy";
    status: "not-applicable" | "not-compared";
    reason: string;
  }>;
  /** Journal assessments no collection attempt names. Not part of the experiment. */
  outsideExperiment: number;
  methods: Record<string, string>;
  integrity: {
    history: "complete" | "incomplete";
    ledger: H2Finding[];
    journal: {
      gaps: number;
      notices: Array<{ kind: string; segment: string | null; line: number | null; detail: string }>;
    };
    findings: H2Finding[];
  };
}

/** Live, in-memory collection state. Reading it calls nothing. */
export interface H2CollectionStatus {
  enabled: boolean;
  /** Why collection is off, or which setting is invalid. */
  reasons: string[];
  settings: {
    residualRate: number;
    probeRate: number;
    maxCallsPer24h: number;
    minCallIntervalMs: number;
    maxUsdPer24h: number;
    requestedModel: string | null;
    seed: string;
  } | null;
  watcher: {
    state: "inactive" | "waiting" | "paused" | "halted";
    detail: string | null;
    until: string | null;
  };
}

export interface H2ReportResponse {
  collection: H2CollectionStatus;
  report: H2Report;
}

// ── H1 shadow experiment: gate operator action (§Q) ─────────────────────────

/**
 * Gates whose phase declares `autoApprove` are a biased subset (a person only
 * sees the ones auto-approval did not open), so they are a population of their
 * own and never pooled with ordinary manual gates (§Q.2).
 */
export type H1Population = "manual" | "auto-approve-declared";

/** The operator-action reference: revise and abort are both "sent back". */
export type H1ReferenceLabel = "sent-back" | "not-sent-back";

/** Live, in-memory H1 collection state. Reading it calls nothing, and it never names a result. */
export interface H1CollectionStatus {
  enabled: boolean;
  reasons: string[];
  settings: {
    rate: number;
    seed: string;
    /** One entry per model arm; null = the runner's default model. */
    models: Array<string | null>;
    maxCallsPer24h: number;
    maxOwnCallsPer24h: number;
    minCallIntervalMs: number;
    maxUsdPer24h: number;
  } | null;
  watcher: {
    state: "inactive" | "waiting" | "paused" | "halted";
    detail: string | null;
    until: string | null;
  };
}

/**
 * Agreement of one predictor with the operator-action reference, over one
 * scoring set (§Q.11). Rows are the reference; columns are what the predictor
 * said. Only `sentBackColumn` and `approveColumn` are predictions of the
 * operator; `decidedColumns` also holds `tie` for a model, which is answered
 * but agrees with nothing. Every other column is an abstention or a coverage
 * gap and is shown, never dropped.
 */
export interface H1Agreement {
  columns: string[];
  sentBackColumn: string;
  approveColumn: string;
  decidedColumns: string[];
  confusion: { rows: H1ReferenceLabel[]; columns: string[]; counts: number[][] };
  scored: number;
  answered: number;
  /** answered / scored. */
  coverage: H2Proportion;
  /** Agreement with operator behaviour — not correctness — over answered items. */
  agreementAnswered: H2Proportion;
  /** The same over every scored item: abstentions and gaps count as not agreeing. */
  agreementEndToEnd: H2Proportion;
  /** P(predicts approve | operator sent back), over answered items. */
  falseClose: H2Proportion;
  /** P(predicts sent back | operator approved), over answered items. */
  falseEscalation: H2Proportion;
  kappa: H2Measured<number>;
}

export interface H1ReliabilityBucket {
  lower: number;
  upper: number;
  n: number;
  status: "measured" | "unmeasured";
  /** Mean predicted probability of "sent back" in the bin. */
  meanPredicted: number | null;
  /** Share of the bin the operator sent back. */
  observedRate: number | null;
}

export interface H1Census {
  population: H1Population;
  captured: number;
  sampled: number;
  notSampled: number;
  /** Captured and not yet settled: counted, never shown. */
  pending: number;
  /** Settled because the attempt stopped being eligible. */
  resolved: number;
  /** Still eligible when observation stopped; counted only. */
  windowClosed: number;
  labeled: {
    sentBack: number;
    notSentBack: number;
    approve: number;
    revise: number;
    abort: number;
  };
  /** Reason → resolved items with no operator-action reference. Never negatives. */
  unlabeled: Record<string, number>;
  /** Labeled items by whether the captured review state held until the action. */
  state: { held: number; changed: number; unobserved: number };
  /** Principal kind → labeled items. A session is an account, not proof of a person. */
  principals: Record<string, number>;
  /** Sampled, resolved and labeled items no call was made for, by reason. */
  notCalled: Record<string, number>;
}

export interface H1BaselineRow {
  population: H1Population;
  definition: { id: string; version: number; digest: string };
  /** Settled, labeled, state-held items: the scoring set. */
  scored: number;
  agreement: H1Agreement;
}

export interface H1VerdictRow extends H1BaselineRow {
  /**
   * AUROC over the minimum current Verdict rating of the relevant steps, with
   * sent back as the positive class and a lower rating expected to mean sent
   * back: P(rating of an approved gate > rating of a sent-back gate), ties ½.
   * A rating, never a probability.
   */
  auroc: H2Measured<{
    value: number;
    ci95: [number, number];
    sentBack: number;
    notSentBack: number;
  }>;
}

export interface H1ModelPopulation {
  population: H1Population;
  question: {
    id: string;
    version: number;
    digest: string;
    definition: "registered" | "missing" | "digest-mismatch";
  };
  projection: { id: string; version: number; digest: string };
  provider: ProviderIdentity;
  /** Attempts on resolved items only; unresolved items are pending and unshown. */
  attempts: Record<H2AttemptClass, number>;
  assessed: number;
  answered: number;
  abstained: number;
  failed: number;
  refusals: Record<string, number>;
  /** Reason → assessed items left out of the scoring set (unlabeled, state, timing). */
  excluded: Record<string, number>;
  agreement: H1Agreement;
  brier: H2Measured<{ value: number; n: number }>;
  reliability: { minBucket: number; buckets: H1ReliabilityBucket[] };
  ece: H2Measured<{ value: number; n: number }>;
  /** The two baselines on exactly this row's scoring set. */
  paired: { deterministic: H1Agreement; verdict: H1Agreement };
  usage: H2Usage;
}

export interface H1ConfigSummary {
  digest: string;
  firstAt: string;
  seed: string;
  rate: number;
  arms: Array<{ requestedModel: string | null; adapterVersion: number }>;
  limits: {
    maxCallsPer24h: number;
    maxOwnCallsPer24h: number;
    minCallIntervalMs: number;
    maxUsdPer24h: number;
    maxTriesPerItem: number;
    retryAfterMs: number;
  };
}

export interface H1Report {
  report: { id: "decision-h1-report"; version: 1 };
  asOf: { seq: number; at: string | null };
  /** Printed with every report: behavioural agreement cannot justify skipping review. */
  statement: string;
  collection: { start: string | null; configs: H1ConfigSummary[] };
  definitions: Array<{
    kind: "question" | "projection" | "rules" | "qualification";
    id: string;
    version: number;
    digest: string | null;
    status: "registered" | "missing" | "digest-mismatch";
  }>;
  /** Gate pauses seen and not captured, by reason. */
  gates: { excluded: Record<string, number> };
  census: H1Census[];
  pending: { total: number; byPopulation: Record<H1Population, number> };
  deterministic: H1BaselineRow[];
  verdict: H1VerdictRow[];
  models: H1ModelPopulation[];
  /** Every attempt, settled or not: counts and money only, never outcomes. */
  spend: { attempts: number; spent: number; usdTotal: number; usdUnknown: number };
  methods: Record<string, string>;
  integrity: {
    history: "complete" | "incomplete";
    ledger: H2Finding[];
    journal: {
      gaps: number;
      notices: Array<{ kind: string; segment: string | null; line: number | null; detail: string }>;
    };
    findings: H2Finding[];
  };
}

export interface H1ReportResponse {
  collection: H1CollectionStatus;
  report: H1Report;
}
