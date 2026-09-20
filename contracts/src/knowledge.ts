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
  /**
   * Where the consumed revision came from, relative to what Argus supplied
   * to the run (Phase 4). Set when the consumption was committed from a
   * KnowledgeDelta whose run's invocation record is known: `supplied-context`
   * when Argus can prove the revision was in the run's KnowledgeContext,
   * `agent-discovered` when it was not (the agent found it independently —
   * source code, a document, a tool). Absent on records registered through
   * the admin API or written before Phase 4: no claim either way.
   */
  source?: ConsumptionSource;
}

/**
 * The provenance of a consumption relative to Argus's own record of what it
 * supplied. Supplied and consumed are two facts kept deliberately separate:
 * this is the smallest representation that preserves the distinction on the
 * consumption edge itself, without making every supplied claim a dependency.
 */
export type ConsumptionSource = "supplied-context" | "agent-discovered";

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
  /** Carried from the consumption record; see {@link ClaimConsumption.source}. */
  source?: ConsumptionSource;
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

// ── KnowledgeDelta protocol (Phase 3) ───────────────────────────────────────
//
// The typed wire contract through which an agent execution *proposes* semantic
// changes. The agent writes one JSON document to the path Argus handed it in
// `ARGUS_KNOWLEDGE_DELTA_FILE`; Argus reads it when the run completes,
// validates it, stages it beside the run, and applies it to `knowledge.json`
// only when the phase the run belongs to has crossed every deterministic
// acceptance condition (checks passed; gate approved). The agent never writes
// the ledger, never assigns a canonical id or revision number, and never
// modifies an existing record. LLMs propose; Argus validates and applies.

/**
 * A claim reference inside a delta. Either a claim this same delta proposes
 * (by its delta-local id) or an **exact** existing revision. A bare id is
 * refused: a committed delta may only ever name an immutable revision, so
 * that nothing it recorded can be retargeted when the claim is revised.
 * The string form `RULE-17:v2` is accepted for the exact case and parsed to
 * the object form before staging.
 */
export type DeltaClaimRef = { local: string } | ClaimRef;

/** A new claim. Argus mints the canonical id from `kind`; `localId` exists
 *  only inside this delta and is never persisted as semantic identity. */
export interface DeltaProposedClaim {
  localId: string;
  kind: ClaimKind;
  statement: string;
  structuredValue?: unknown;
}

/**
 * The next revision of an existing claim, with an optimistic-concurrency
 * precondition: it is created only if `expectedRevision` is still the active
 * revision at commit. If the claim has moved on, the whole delta is stale and
 * nothing in it is applied — reasoning built on a revision that is no longer
 * current is not silently rebased onto the newer one. `localId` (optional)
 * lets the same delta justify from, or attach evidence to, the new revision.
 */
export interface DeltaProposedRevision {
  claimId: string;
  expectedRevision: number;
  statement: string;
  structuredValue?: unknown;
  revisionNote?: string;
  localId?: string;
}

export interface DeltaProposedEvidence {
  claim: DeltaClaimRef;
  /** Default `supports`. */
  direction?: SupportDirection;
  source: EvidenceSource;
  note?: string;
}

export interface DeltaProposedJustification {
  conclusion: DeltaClaimRef;
  premises: DeltaClaimRef[];
  /** Default `supports`. */
  direction?: SupportDirection;
  note?: string;
}

/**
 * One execution's proposed semantic changes. Every section is optional; an
 * absent file, or a delta with every section empty, means the run proposed no
 * durable knowledge and the pipeline behaves exactly as it did before this
 * protocol existed. Provenance (`producedBy`, the consuming/producing
 * execution) is *not* a field: Argus binds it from the run that wrote the file.
 */
export interface KnowledgeDelta {
  schemaVersion: 1;
  claims?: DeltaProposedClaim[];
  revisions?: DeltaProposedRevision[];
  evidence?: DeltaProposedEvidence[];
  justifications?: DeltaProposedJustification[];
  /** Exact revisions this execution declares it relied on. Agent-declared: Argus
   *  proves the reference exists and is well formed, not that the model
   *  reasoned from it. Recorded through the Phase 2 consumption edge. */
  consumed?: ClaimRef[];
  /** Artifacts this execution produced. Recorded through the Phase 2
   *  production edge; paths are containment-checked against the run's roots. */
  artifacts?: ArtifactRef[];
  metadata?: { summary?: string };
}

/**
 * Where a staged delta is in its life.
 *
 * - `staged` — parsed, validated against the ledger as it stood, waiting for
 *   its phase to be accepted. Not canonical.
 * - `applied` — committed atomically to `knowledge.json` when its phase
 *   succeeded. `result` says what it became.
 * - `rejected` — refused: at intake (malformed, unresolved reference, stale
 *   precondition) or at commit (the ledger moved, or a sibling delta in the
 *   same phase conflicted). Nothing from it entered the ledger.
 * - `superseded` — its attempt failed, was revised, was aborted, or lost a
 *   candidate selection. Kept as diagnostic evidence; never canonical.
 */
export type KnowledgeDeltaStatus = "staged" | "applied" | "rejected" | "superseded";

/** What one applied delta became, in canonical terms. */
export interface KnowledgeDeltaApplyResult {
  status: "applied";
  deltaId: string;
  appliedAt: string;
  /** Local id → the canonical revision-1 identity Argus minted for it. */
  createdClaims: Array<{ localId: string; claim: ClaimRef }>;
  /** Each revision proposal → the revision it created and the one it superseded. */
  createdRevisions: Array<{ localId?: string; claim: ClaimRef; supersedes: ClaimRef }>;
  evidenceIds: string[];
  justificationIds: string[];
  consumptions: ClaimConsumption[];
  artifacts: ArtifactProduction[];
}

/**
 * A delta as Argus staged it: stable identity, the execution provenance that
 * distinguishes it from any other attempt's proposal, and its status. The
 * staging identity is (instance, phase, attempt, run); an older attempt's
 * delta can never be mistaken for a newer one's.
 */
export interface KnowledgeDeltaRecord {
  id: string;
  runId: string;
  instanceId: string;
  phaseId: string;
  attempt: number;
  step: string;
  status: KnowledgeDeltaStatus;
  /** When Argus read the agent's file. */
  receivedAt: string;
  updatedAt: string;
  /** The validated proposal. Absent when the document could not be parsed or
   *  failed structural validation (then `reason` says why). */
  delta?: KnowledgeDelta;
  /** Why it is `rejected` or `superseded`. */
  reason?: string;
  /** Present once `applied`. */
  result?: KnowledgeDeltaApplyResult;
  /**
   * The exact revisions Argus supplied to the run as its KnowledgeContext
   * (Phase 4), copied from the run's invocation record at intake so the
   * commit can classify each `consumed` entry ({@link ConsumptionSource})
   * and so the record shows supplied and consumed side by side. Absent when
   * the invocation record could not be read; empty when the run was launched
   * with no semantic context.
   */
  supplied?: ClaimRef[];
}

/**
 * The ledger's own record of an applied delta (ledger version 3). Lives in
 * `knowledge.json` beside the records it created, so "which canonical
 * records came from this run?" is answerable from the ledger alone, and so a
 * commit is idempotent: a delta whose id is already here is not applied twice.
 */
export interface AppliedKnowledgeDelta {
  id: string;
  execution: RunExecutionRef;
  attempt: number;
  appliedAt: string;
  /** Every claim revision this delta created — new claims and revisions alike. */
  claims: ClaimRef[];
  evidence: string[];
  justifications: string[];
  consumptions: ClaimRef[];
  artifacts: ArtifactRef[];
}

/** `GET /api/knowledge/executions/:runId/deltas`. */
export interface KnowledgeDeltasResponse {
  runId: string;
  deltas: KnowledgeDeltaRecord[];
}

// ── KnowledgeContext protocol (Phase 4) ─────────────────────────────────────
//
// The opposite direction of the KnowledgeDelta protocol. Argus selects exact
// claim revisions for one run, materializes them as a read-only file the agent
// learns of from `ARGUS_KNOWLEDGE_CONTEXT_FILE`, and records on the invocation
// what it supplied. Two facts, never collapsed:
//
//   SUPPLIED  — Argus can prove this revision was in the run's context
//               (the invocation record: exact refs + the file's sha256).
//   CONSUMED  — the agent declares it materially relied on this revision
//               (the KnowledgeDelta's `consumed`, a Phase 2 consumption edge).
//
// Supplying a claim never creates a consumption; impact analysis stays
// consumption-based. What Phase 4 adds is that Argus now knows which side of
// the line each consumption falls on (`ClaimConsumption.source`).

/**
 * How a step's author names one claim the run should receive. Either an
 * exact historical revision — always that revision, even once superseded —
 * or `"active"`: resolved to the active revision when the phase attempt is
 * prepared, then frozen. The invocation provenance always stores the resolved
 * exact revision, never `"active"`. Authored as `"RULE-17:v2"`, `"RULE-17"`
 * (active) or the object form; stored normalized to the object form.
 */
export type KnowledgeContextSelector = { id: string; revision: number | "active" };

/** What a step (or every step of a phase) receives. Each logical claim id
 *  may appear once: a context is a set of claims keyed by id. */
export interface KnowledgeContextSpec {
  claims: KnowledgeContextSelector[];
}

/** One direct evidence record, as the agent-facing projection shows it: the
 *  direction and the source, without ledger ids or timestamps. */
export interface KnowledgeContextEvidence {
  direction: SupportDirection;
  source: EvidenceSource;
  note?: string;
}

/**
 * One claim revision in a KnowledgeContext — an agent-facing projection of
 * the ledger's {@link ClaimView}, with the derived state at generation time.
 * `ref` is the immutable identity the agent must use when it declares
 * consumption. Lifecycle and support are exposed, never hidden: a contested
 * or superseded revision may be exactly what a step is asked to reason about.
 */
export interface KnowledgeContextClaim {
  /** `RULE-17:v2` — the exact revision identity. */
  ref: string;
  id: string;
  revision: number;
  kind: ClaimKind;
  statement: string;
  structuredValue?: unknown;
  lifecycle: ClaimLifecycle;
  /** The revision that replaced this one, when `lifecycle` is `superseded`. */
  supersededBy?: string;
  support: ClaimSupport;
  revisionNote?: string;
  /** The execution that derived this revision, when the ledger knows one. */
  producedBy?: ExecutionRef;
  /** Direct evidence on this revision, in ledger order. Absent when none. */
  evidence?: KnowledgeContextEvidence[];
}

/**
 * The versioned wire format of the semantic context Argus supplies to one
 * run — the document at `ARGUS_KNOWLEDGE_CONTEXT_FILE`. Immutable once the
 * run is prepared: a revision created while the agent runs never appears in
 * it, and the invocation record proves what it contained.
 */
export interface KnowledgeContext {
  schemaVersion: 1;
  generatedAt: string;
  claims: KnowledgeContextClaim[];
  metadata?: {
    /** How each entry was selected, in `claims` order: the authored selector
     *  and the exact revision it resolved to. */
    selection?: Array<{ selector: KnowledgeContextSelector; resolved: ClaimRef }>;
  };
}

/** What the invocation record keeps about the context it supplied: enough
 *  to prove exactly which revisions the run received, and to verify the
 *  file against it, even if the ledger has changed since. */
export interface InvocationKnowledgeContext {
  schemaVersion: 1;
  /** The exact revisions supplied, in file order. */
  claims: ClaimRef[];
  /** SHA-256 (hex) of the file's bytes as written. */
  sha256: string;
}

/** The supplied-vs-consumed comparison for one run, derived per read. */
export interface SuppliedConsumedComparison {
  /** Supplied and declared consumed: the normal case. */
  suppliedAndConsumed: ClaimRef[];
  /** Supplied, not declared consumed: allowed — the agent did not need it. */
  suppliedNotConsumed: ClaimRef[];
  /** Declared consumed, never supplied: allowed and recorded — the agent
   *  found it independently. */
  consumedNotSupplied: ClaimRef[];
}

// ── Durable supplied provenance (Phase 4.1) ─────────────────────────────────
//
// Phase 4 made the invocation record the single account of what Argus supplied.
// That is true while the record exists — and invocation records are pruned with
// their runs, so the answer to "what canonical semantic context did run_456
// receive?" had a retention horizon that consumption provenance does not. Phase
// 4.1 closes the asymmetry: the *identity* of the context (exact refs + hash +
// when) is written into `knowledge.json` alongside the other semantic execution
// provenance, and the heavy operational artifacts — the invocation record, the
// materialized projection — stay prunable.
//
//   heavy operational records (invocation dir, context file)  → prunable
//   small semantic provenance (this record, consumptions)     → durable

/**
 * "Argus supplied exactly these claim revisions to execution E." The durable,
 * retention-proof half of the KnowledgeContext protocol: written into the
 * ledger when the context file is materialized, before the process exists,
 * and never rewritten.
 *
 * Identity is `execution.runId` — one run receives one context, once. Argus
 * re-registering the identical record (a retried preparation, a reconcile
 * re-observing the run) is a no-op; registering a *different* `claims` list or
 * `sha256` for the same run is refused rather than silently overwriting
 * history. A later revision of a supplied claim never retargets this record:
 * `run_456 → RULE-17:v2` stays v2 forever, exactly as a consumption does.
 *
 * What it does **not** assert: that the process ran, or that the agent read
 * the file. It attests supply — "this context was materialized and named to
 * this attempted invocation". Whether the execution then ran is the run
 * record's question ({@link ClaimConsumption} and {@link AppliedKnowledgeDelta}
 * are the durable evidence that it ran *and* produced semantics).
 */
export interface SuppliedContext {
  execution: RunExecutionRef;
  /** The phase attempt this invocation belonged to, when known. Attempt 1 and
   *  attempt 2 are different runs, so they are different records; this is a
   *  locator, never part of the identity. */
  attempt?: number;
  /** The {@link KnowledgeContext} wire version the run received. */
  schemaVersion: 1;
  /** The exact revisions supplied, in context-file order. */
  claims: ClaimRef[];
  /** SHA-256 (hex) of the materialized context file's bytes. */
  sha256: string;
  /** When Argus materialized the context for launch. */
  suppliedAt: string;
}

/**
 * Whether the materialized context file still holds the bytes Argus recorded
 * at launch. Checked when a run's completion is accepted, against the hash on
 * the durable record.
 *
 * - `unchanged` — the file hashes to the recorded value. The only outcome that
 *   lets a completion (and its KnowledgeDelta) proceed.
 * - `modified` — the file exists and hashes to something else.
 * - `missing` — the file is gone. Argus cannot confirm integrity, so it is an
 *   integrity failure too (the durable record keeps the history either way).
 * - `unverifiable` — the run has no durable supplied record: it was launched
 *   without a semantic context, or predates Phase 4.1. Nothing to check.
 */
export type ContextIntegrityStatus = "unchanged" | "modified" | "missing" | "unverifiable";

/** The outcome of one integrity check. Never carries context *contents*. */
export interface ContextIntegrityResult {
  status: ContextIntegrityStatus;
  /** The hash recorded at launch. Absent when `unverifiable`. */
  expected?: string;
  /** The hash of the bytes found now. Present only when `modified`. */
  actual?: string;
  /** Where the file was expected. Absent when `unverifiable`. */
  file?: string;
}

/** `GET /api/knowledge/executions/:runId/context` — what a run received.
 *
 *  Answered from the durable {@link SuppliedContext} record, so it survives
 *  run and invocation pruning. The materialized projection is an operational
 *  artifact and may be gone; `context.projectionAvailable` says so explicitly
 *  rather than the API reconstructing something from today's ledger. */
export interface ExecutionContextReport {
  execution: RunExecutionRef;
  context: InvocationKnowledgeContext & {
    /** Where the file was materialized. Null once the invocation directory
     *  has been pruned. */
    file: string | null;
    /** When Argus materialized it. */
    suppliedAt: string;
    /** Whether `projection` below could be read. False after pruning. */
    projectionAvailable: boolean;
  };
  /** The exact revisions Argus supplied, in file order (`context.claims`). */
  supplied: ClaimRef[];
  /** The exact revisions the ledger records this run as having consumed. */
  consumed: ClaimRef[];
  comparison: SuppliedConsumedComparison;
  /** The materialized document, when the file is still on disk — never
   *  rebuilt from the current ledger. */
  projection: KnowledgeContext | null;
}

/** `GET /api/knowledge/claims/:key/supplied-to` — which runs received this
 *  exact revision, from the ledger's durable supplied provenance, so a run
 *  whose invocation record has been pruned is still listed. */
export interface SuppliedToReport {
  claim: ClaimRef;
  executions: Array<{
    execution: RunExecutionRef;
    /** When the invocation was prepared. */
    suppliedAt: string;
    sha256: string;
    /** The phase attempt, when the record carries one. */
    attempt?: number;
  }>;
}
