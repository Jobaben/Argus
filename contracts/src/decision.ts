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
