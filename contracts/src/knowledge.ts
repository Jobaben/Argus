/**
 * The Knowledge Ledger — Argus's semantic provenance graph.
 *
 * The pipeline DAG answers "what executes after what?". The Knowledge Ledger
 * answers "what depends *logically* on what?": which facts, business rules and
 * assumptions a conclusion rests on, which evidence supports those premises,
 * and what would lose support if one of them were superseded. The two graphs
 * are separate concepts and stay separate: nothing here references
 * `PhaseDef.needs`, and nothing in the execution DAG references a claim.
 *
 * Three rules shape every type in this file:
 *
 * - **No `truth` field.** Argus models SUPPORT, EVIDENCE and CONFLICT. A
 *   claim's {@link ClaimSupport} is *derived* from its evidence and
 *   justifications by a deterministic function, never stored, and no agent can
 *   set it.
 * - **History is preserved.** A claim revision is immutable once written. A
 *   later revision supersedes it; the old one remains addressable, and every
 *   justification or evidence record that named it keeps naming it.
 * - **Agents propose, Argus applies.** These are the shapes Argus *returns*
 *   and the validated inputs it *accepts*; ids, revisions, timestamps and
 *   referential integrity are Argus's to assign and enforce.
 */

/** What sort of assertion a claim is. `business-rule` is first class because
 *  rule impact analysis is the reason the Ledger exists. */
export type ClaimKind =
  "fact" | "assumption" | "business-rule" | "constraint" | "conclusion" | "decision";

/**
 * The revision identity of a claim: one exact statement, at one point in its
 * history. `id` alone is the *logical* identity (RULE-17); the pair is the
 * revision identity (RULE-17:v2). Every edge in the graph — evidence,
 * justification premise, justification conclusion — names a revision, never a
 * bare id, so nothing can be silently retargeted when a claim is revised.
 *
 * String form, used in URLs and accepted anywhere a ref is written:
 * `<id>:v<revision>`. A bare `<id>` in a URL means "the active revision".
 */
export interface ClaimRef {
  id: string;
  revision: number;
}

/** Where in Argus's execution provenance a ledger record was produced. Every
 *  field is optional so a human-authored record can carry none. */
export interface ExecutionRef {
  instanceId?: string;
  phaseId?: string;
  runId?: string;
}

/**
 * One immutable revision of a claim. Revisions of an id are numbered 1..n with
 * no gaps; the highest is the active one, and every lower one is superseded.
 * `lifecycle` is therefore derived (see {@link ClaimView}), not stored.
 */
export interface Claim {
  id: string;
  revision: number;
  kind: ClaimKind;
  statement: string;
  /**
   * Structured form of the statement, when one exists. For a business rule this
   * is the extension point for a future `{ when, then, unless }` representation;
   * Phase 1 stores it opaquely and never interprets it.
   */
  structuredValue?: unknown;
  producedBy?: ExecutionRef;
  /** Why this revision replaced the previous one. Absent on revision 1. */
  revisionNote?: string;
  createdAt: string;
}

/** Lifecycle is about *history*: is this the current revision of its id? It is
 *  deliberately independent of support — a superseded revision can still be
 *  fully supported, and an active one can be unsupported. */
export type ClaimLifecycle = "active" | "superseded";

/**
 * Where a piece of evidence points. A small, closed union rather than a URI
 * scheme so each variant can be validated field by field; adding a source type
 * is a one-line addition here and one case in the validator.
 */
export type EvidenceSource =
  | { type: "run"; runId: string }
  | { type: "phase"; instanceId: string; phaseId: string }
  | { type: "artifact"; instanceId: string; phaseId: string; path: string }
  | { type: "verification"; instanceId: string; phaseId: string }
  | { type: "source-code"; path: string; line?: number; gitHead?: string }
  | { type: "git-commit"; sha: string; repository?: string }
  | { type: "document"; uri: string; title?: string }
  | { type: "human"; who: string };

/** The direction an evidence record or a justification bears on its target. */
export type SupportDirection = "supports" | "opposes";

/**
 * A stable-identity record of provenance bearing on one claim revision. A
 * claim never *contains* prose about where it came from; it is pointed at by
 * evidence, which can be listed, counted and — later — re-checked against the
 * execution record it names.
 */
export interface Evidence {
  id: string;
  claim: ClaimRef;
  direction: SupportDirection;
  source: EvidenceSource;
  note?: string;
  createdAt: string;
}

/**
 * A semantic derivation: "these premise revisions, taken together, support (or
 * oppose) this conclusion revision". Premises are conjunctive — a justification
 * is in force only while *every* premise is active and supported. Two
 * independent derivations of the same conclusion are two justifications, which
 * is what lets a conclusion survive losing one of them.
 */
export interface Justification {
  id: string;
  conclusion: ClaimRef;
  premises: ClaimRef[];
  direction: SupportDirection;
  producedBy?: ExecutionRef;
  note?: string;
  createdAt: string;
}

/**
 * The deterministic support state of a claim revision.
 *
 * - `supported` — at least one positive signal is in force and no negative one.
 * - `contested` — positive and negative signals are both in force.
 * - `unsupported` — no positive signal is in force (whether or not a negative
 *   one is; the report says which).
 */
export type ClaimSupport = "supported" | "unsupported" | "contested";

/** Why a justification does or does not currently lend force. */
export type JustificationForce =
  | { inForce: true }
  | {
      inForce: false;
      /** Every premise that fails, with the first reason it fails for.
       *  `missing` is unreachable through the API (references are checked on
       *  write) and exists so a hand-edited ledger still evaluates. */
      failing: Array<{
        premise: ClaimRef;
        reason: "superseded" | "unsupported" | "contested" | "missing";
      }>;
    };

/** A justification as it bears on one claim's support right now. */
export interface JustificationStatus {
  justification: Justification;
  force: JustificationForce;
}

/** A claim revision with its derived history and support state. */
export interface ClaimView extends Claim {
  lifecycle: ClaimLifecycle;
  /** The revision that replaced this one, when superseded. */
  supersededBy?: ClaimRef;
  support: ClaimSupport;
}

/** The full answer to "why is this claim supported (or not)?". */
export interface SupportReport {
  claim: ClaimRef;
  lifecycle: ClaimLifecycle;
  support: ClaimSupport;
  evidence: Evidence[];
  justifications: JustificationStatus[];
}

/** The answer to "what depends on this claim revision?". */
export interface DependentsReport {
  claim: ClaimRef;
  /** Conclusions of justifications that name this revision as a premise. */
  direct: ClaimRef[];
  /** `direct`, then their dependents, and so on — breadth-first, each once. */
  transitive: ClaimRef[];
}

export interface ClaimDetail {
  claim: ClaimView;
  /** Every revision of the claim's id, oldest first. */
  revisions: ClaimView[];
}

export interface ClaimsResponse {
  claims: ClaimView[];
}

// ── Execution provenance bridge (Phase 2) ───────────────────────────────────
//
// Two graphs, three explicit bridges:
//
//   Execution ──produced──▶ ClaimRevision        (Phase 1: `producedBy`)
//   ClaimRevision ──consumed-by──▶ Execution     (ClaimConsumption)
//   Execution ──produced──▶ Artifact             (ArtifactProduction)
//
// `producedBy` says which execution *created* a piece of knowledge. It says
// nothing about which later execution *relied on* it. The consumption edge
// is that second, distinct fact — and it is the one that matters for impact:
// when a premise stops being current, the run that produced the downstream
// decision is provenance; the run that consumed the decision to build
// something is what needs reevaluation.

/**
 * An {@link ExecutionRef} that definitely names a run. The run is Argus's unit
 * of execution — one step attempt, one invocation record — so it is the one
 * identifier that can say "this exact execution consumed that exact revision".
 * `instanceId` and `phaseId` stay optional locators, exactly as on `producedBy`.
 */
export interface RunExecutionRef extends ExecutionRef {
  runId: string;
}

/**
 * "Execution E consumed exact claim revision R." Immutable once recorded, and
 * identified by the pair `(execution.runId, claim)`: registering the same pair
 * again is a no-op that returns the existing record. Revising the claim never
 * moves this edge — `RULE-17:v1 → v2` leaves every consumer of v1 pointing at
 * v1, which is precisely what lets impact analysis find them.
 */
export interface ClaimConsumption {
  claim: ClaimRef;
  execution: RunExecutionRef;
  createdAt: string;
}

/**
 * The smallest useful artifact identity: where a path is rooted, and the path.
 * `artifact-dir` is the producing phase's artifact directory (the same `path`
 * a `PhaseArtifact` lists); `repository` is the working tree the run ran in,
 * with `gitHead` optionally pinning the commit that carries the content. No
 * content addressing, no versioning — the record `(execution, artifact)`
 * already names "the file at this path as this run left it".
 */
export interface ArtifactRef {
  location: "artifact-dir" | "repository";
  /** Relative, POSIX separators, no `..` segment. */
  path: string;
  gitHead?: string;
}

/** "Execution E produced artifact A." Identified by `(execution.runId, location, path)`. */
export interface ArtifactProduction {
  execution: RunExecutionRef;
  artifact: ArtifactRef;
  createdAt: string;
}

/** The answer to "which executions consumed this exact revision?". */
export interface ConsumersReport {
  claim: ClaimRef;
  /** In the order they were recorded. */
  consumptions: ClaimConsumption[];
}

/**
 * Semantic currency of one consumed revision, derived at read time: is the
 * revision the execution relied on still the active, supported one?
 */
export interface ConsumedClaimStatus {
  claim: ClaimRef;
  lifecycle: ClaimLifecycle;
  support: ClaimSupport;
  /** `true` iff `lifecycle === "active" && support === "supported"`. */
  current: boolean;
}

/**
 * `current` — every consumed revision is active and supported. `stale` — at
 * least one is superseded, unsupported or contested. Derived, never stored,
 * and independent of the run's own status: a run that `succeeded` stays
 * `succeeded` forever; what can change is whether its premises still hold.
 */
export type ExecutionCurrency = "current" | "stale";

/** Everything the ledger knows about one execution, in both directions. */
export interface ExecutionProvenance {
  execution: RunExecutionRef;
  /** Revisions this execution relied on, with their currency now. */
  consumed: ConsumedClaimStatus[];
  produced: {
    /** Claim revisions whose `producedBy.runId` is this run. */
    claims: ClaimView[];
    /** Justifications whose `producedBy.runId` is this run. */
    justifications: Justification[];
    artifacts: ArtifactRef[];
  };
  currency: ExecutionCurrency;
}

// ── Impact analysis ─────────────────────────────────────────────────────────

/** What is wrong with the root revision, as the ledger stands. Empty when the
 *  root is active and supported — and then nothing is impacted. */
export type RootCondition = "superseded" | "unsupported" | "contested";

/**
 * Why a node is in an impact set. A closed vocabulary, so a consumer can act
 * on it without parsing prose.
 *
 * - `premise-superseded | premise-unsupported | premise-contested` — a claim:
 *   a justification concluding it (supporting *or* opposing) lost force
 *   because an affected premise — the root or another affected claim — is
 *   superseded / unsupported / contested. The `support` pair says which way
 *   the claim moved; an opposing derivation losing force moves it *up*.
 * - `support-changed` — a claim whose derived support differs from what it
 *   would be were the root current, with no justification concluding it
 *   failing on an affected premise: one *gained* force, because a contested
 *   premise upstream became supported.
 * - `consumed-affected-claim` — an execution that consumed the root or an
 *   affected claim.
 * - `produced-by-affected-execution` — an artifact such an execution produced.
 */
export type ImpactReason =
  | "premise-superseded"
  | "premise-unsupported"
  | "premise-contested"
  | "support-changed"
  | "consumed-affected-claim"
  | "produced-by-affected-execution";

/**
 * A claim whose support *changed* because of the root's condition: its
 * derived support under the counterfactual "the root is active and supported"
 * differs from its support in the ledger as it stands. Mere reachability is
 * not impact — a conclusion with an independent justification still in force
 * is not here.
 */
export interface ClaimImpact {
  claim: ClaimRef;
  reasons: ImpactReason[];
  support: { ifRootHeld: ClaimSupport; actual: ClaimSupport };
  /** Provenance, not impact: the execution that *derived* this claim is not
   *  thereby a consumer of anything. */
  producedBy?: ExecutionRef;
}

/** A justification whose force differs between the two evaluations. */
export interface JustificationImpact {
  id: string;
  conclusion: ClaimRef;
  inForce: { ifRootHeld: boolean; actual: boolean };
}

export interface ExecutionImpact {
  execution: RunExecutionRef;
  reasons: ImpactReason[];
  /** The consumed revisions that are the root or affected, in recording order. */
  consumed: ClaimRef[];
}

export interface ArtifactImpact {
  execution: RunExecutionRef;
  artifact: ArtifactRef;
  reasons: ImpactReason[];
}

export type ImpactNode =
  | { kind: "claim"; claim: ClaimRef }
  | { kind: "execution"; execution: RunExecutionRef }
  | { kind: "artifact"; execution: RunExecutionRef; artifact: ArtifactRef };

export type ImpactEdge = "premise-of" | "consumed-by" | "produced";

export interface ImpactHop {
  via: ImpactEdge;
  /** The justification carrying a `premise-of` hop. */
  justification?: string;
  to: ImpactNode;
}

/**
 * One explanation per impacted node: the hops from the root to it. The path
 * is the shortest through affected nodes, ties broken by ledger order, so the
 * same ledger always explains the same node the same way.
 */
export interface ImpactPath {
  target: ImpactNode;
  hops: ImpactHop[];
}

/** The deterministic result of `analyzeImpact(root)`. Every list is
 *  deduplicated and in a stable order; `paths` explains every entry. */
export interface ImpactSet {
  root: {
    claim: ClaimRef;
    lifecycle: ClaimLifecycle;
    support: ClaimSupport;
    conditions: RootCondition[];
  };
  semantic: {
    affectedClaims: ClaimImpact[];
    affectedJustifications: JustificationImpact[];
  };
  executions: ExecutionImpact[];
  artifacts: ArtifactImpact[];
  paths: ImpactPath[];
}

/** `POST /executions/:runId/consumptions` and `/artifacts` answer with the
 *  records for what was requested — new or pre-existing alike. */
export interface ConsumptionsResponse {
  execution: RunExecutionRef;
  consumptions: ClaimConsumption[];
}

export interface ArtifactProductionsResponse {
  execution: RunExecutionRef;
  artifacts: ArtifactProduction[];
}
