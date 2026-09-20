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
  | SourceCodeEvidence
  | { type: "git-commit"; sha: string; repository?: string }
  | { type: "document"; uri: string; title?: string }
  | { type: "human"; who: string };

/**
 * A location in a repository working tree — the evidence kind repository
 * discovery produces (Phase 5).
 *
 * It records **provenance, not content**: enough to go and look at the code
 * again, never a copy of it. The ledger holds no source snippets, so a rule
 * supported by this evidence stays small however large the function it was
 * read from.
 *
 * Every field but `path` is optional because a discovery agent may honestly
 * know less than the full locator; what Argus *validates* is that what is
 * there is structurally sound (see `knowledge/discovery.ts`):
 *
 * - `path` is repository-relative, POSIX-separated, with no `..` segment, no
 *   leading slash and no drive letter — it can never address anything outside
 *   the repository the run worked in;
 * - `startLine <= endLine`, both positive integers;
 * - `gitHead` is a hex commit sha, and on a discovery-mode delta it must match
 *   the commit Argus itself recorded for the run.
 *
 * The identity is **historical**. `src/Kobra.cs@abc123:120-136` means that
 * file at that commit; a later commit that moves the code does not retarget
 * the record, exactly as a claim revision does not retarget a consumption.
 */
export interface SourceCodeEvidence {
  type: "source-code";
  /** Repository-relative POSIX path. Never absolute, never escaping the root. */
  path: string;
  /** Which repository, when a run works with more than one. Free-form label. */
  repository?: string;
  /** The commit the path was read at. */
  gitHead?: string;
  /** The symbol the evidence is about (`KobraBookingMapper.Map`), when known. */
  symbol?: string;
  /** First line of the relevant range (1-based). */
  startLine?: number;
  /** Last line of the relevant range (1-based, `>= startLine`). */
  endLine?: number;
  /** Pre-Phase-5 single-line form. Kept so records written before ranges
   *  existed still parse; new evidence should use `startLine`/`endLine`. */
  line?: number;
}

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

/**
 * Claims committed by an **accepted earlier phase of this same instance**
 * (Phase 5). The bridge from "discovery just created RULE-42" to "the
 * planning phase receives RULE-42:v1", without the author having to know the
 * canonical id a future run will mint.
 *
 * Resolved exclusively from the *applied* KnowledgeDelta provenance the
 * ledger holds for that phase ({@link AppliedKnowledgeDelta}) — never by
 * scanning today's ledger for claims that look like the phase's, and never
 * from a staged record. Two consequences, both deliberate:
 *
 * - **A staged proposal cannot leak.** Only an accepted phase's commit is in
 *   `ledger.deltas`, so a candidate waiting at a gate resolves to nothing.
 * - **It is historically stable.** The refs are the exact revisions that
 *   phase created; a later revision of one of them does not change what this
 *   selector resolved to.
 */
export interface PhaseProducedSelector {
  /** A phase of the same pipeline, which must run before this one. */
  phaseId: string;
  /** Narrow to these claim kinds. Absent = every claim the phase committed. */
  kinds?: ClaimKind[];
}

/**
 * What a step (or every step of a phase) receives. Each logical claim id may
 * appear once: a context is a set of claims keyed by id.
 *
 * Two selector families, both optional, at least one non-empty. `claims`
 * names exact or active revisions the author already knows about;
 * `fromPhases` names knowledge an earlier phase of this instance committed.
 * They compose: `claims` is resolved first and wins on a collision, so an
 * author who pinned a revision explicitly keeps it.
 */
export interface KnowledgeContextSpec {
  claims?: KnowledgeContextSelector[];
  /** Claims committed by accepted earlier phases of this instance. */
  fromPhases?: PhaseProducedSelector[];
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
    selection?: Array<{
      selector: KnowledgeContextSelector;
      resolved: ClaimRef;
      /** The earlier phase whose accepted commit produced this claim, when it
       *  was selected by a {@link PhaseProducedSelector} rather than named
       *  directly. The stored `selector` is always the exact revision that
       *  resolution settled on, so the record never floats. */
      fromPhase?: string;
    }>;
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
  /**
   * The exact revisions supplied, in context-file order.
   *
   * May be empty. Since Phase 5 a spec can select "whatever the accepted
   * discovery phase committed", and a phase is allowed to have committed
   * nothing; the run still received — and Argus still hashed — a context
   * file, so the record still exists and says durably that the file held no
   * revisions. A run launched with *no* semantic context at all has no record
   * here, which is the different, and equally important, fact.
   */
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

// ── Business-rule discovery orchestration (Phase 5) ──────────────────────────
//
// Phase 3 gave an agent a way to *propose* semantic knowledge and Argus a way
// to commit it only once the phase was accepted. Phase 5 uses exactly that
// machinery for one specific workflow — reading a bounded repository scope and
// proposing the business rules its code appears to enforce — and adds the two
// things a reviewer and a downstream phase need:
//
//   repository evidence → candidate KnowledgeDelta → review → canonical rule
//
//   1. a deterministic **preview** of the staged delta, so the gate shows the
//      candidate rules, their evidence and their assumptions without anyone
//      reading the agent's transcript;
//   2. deterministic **warnings and invariants** over what the agent proposed,
//      so "an agent said so" is never on its own enough to create a rule.
//
// What stays interpretation: whether the rule the agent read out of the code
// is the rule the business actually has. Argus does not, and cannot, check
// that — which is exactly why the human gate is mandatory for discovery.

/**
 * A bounded repository scope for one discovery invocation.
 *
 * Discovery is never "understand the repository". The author names the files
 * or directories in scope, and Argus uses that list twice: it goes into the
 * agent's instructions, and it is the containment rule every `source-code`
 * evidence path is checked against. A rule whose evidence points outside the
 * declared scope is refused — the agent went looking somewhere it was not
 * asked to.
 */
export interface DiscoveryScope {
  /** Repository-relative paths (files or directories), at least one. `"."`
   *  means the whole working tree, which an author must say explicitly. */
  paths: string[];
  /** A short name for what is being investigated ("Kobra booking"). Appears
   *  in the agent's instructions and in the review. */
  label?: string;
  /** One sentence narrowing what to look for. Author-written, not Argus's. */
  note?: string;
}

/**
 * Turns a phase into a **business-rule discovery phase**.
 *
 * The phase is otherwise an ordinary phase: the same steps, the same gate, the
 * same KnowledgeDelta channel, the same commit boundary. What `discovery`
 * changes is three things, all deterministic:
 *
 * - the steps get the discovery instructions appended to their prompt
 *   (what counts as a business rule, what evidence is required, how to
 *   propose an assumption, how to revise a rule it was supplied);
 * - the delta the run writes is held to the **discovery invariants** below —
 *   every business rule needs evidence, every source path must exist inside
 *   the declared scope at the commit Argus recorded;
 * - the phase carries a {@link DiscoverySummary} and its gate carries a
 *   {@link KnowledgeDeltaPreview}.
 *
 * Nothing here weakens the Phase 3 boundary: a discovery agent still cannot
 * write the ledger, still cannot mint a canonical id, and its proposal still
 * becomes canonical only when the phase is accepted.
 */
export interface DiscoveryPolicy {
  scope: DiscoveryScope;
  /**
   * Whether a business rule this delta creates or revises must carry
   * supporting evidence in the same delta. Default `"required"`, which is the
   * point of the feature; `"warn"` downgrades it to a review warning for an
   * author who wants the candidate visible rather than refused.
   */
  evidence?: "required" | "warn";
}

/** The counts a discovery phase reports for routing, status and observability.
 *  The canonical detail stays in the staged KnowledgeDelta; this is the
 *  summary, never a second copy of the candidates. */
export interface DiscoverySummary {
  /** Proposed claims plus proposed revisions: everything awaiting a decision. */
  candidates: number;
  /** New `business-rule` claims. */
  newRules: number;
  /** Proposed revisions of existing claims, of any kind. */
  revisions: number;
  /** New `assumption` claims. */
  assumptions: number;
  /** New `fact` claims. */
  facts: number;
  /** New `constraint` claims. */
  constraints: number;
  /** New `conclusion` claims. */
  conclusions: number;
  /** Evidence records proposed across the attempt's deltas. */
  evidence: number;
  /** Deterministic review warnings raised over the attempt's deltas. */
  warnings: number;
  /** True while the candidates are staged and not yet accepted. */
  requiresReview: boolean;
}

/**
 * How one claim is named in a preview.
 *
 * A proposed claim has no canonical identity yet and the preview must not
 * pretend otherwise: it shows `local:comment-limit`, which is honestly a
 * delta-local label. An existing revision shows its real ref, `RULE-17:v2`.
 * A proposed *revision* shows both — the id it targets and the revision it
 * would become — because a reviewer's question is precisely "which rule is
 * this changing, and to what?".
 */
export interface PreviewRef {
  /** What to print: `local:comment-limit`, `RULE-17:v2`, or `RULE-17:v2 (proposed)`. */
  display: string;
  /** Set when the reference is delta-local. */
  local?: string;
  /** Set when the reference names an existing exact revision. */
  claim?: ClaimRef;
  /** True when `claim` is the revision this delta would *create*, not one the
   *  ledger holds. */
  proposed?: boolean;
}

export interface PreviewEvidence {
  claim: PreviewRef;
  direction: SupportDirection;
  source: EvidenceSource;
  note?: string;
}

export interface PreviewJustification {
  conclusion: PreviewRef;
  premises: PreviewRef[];
  direction: SupportDirection;
  note?: string;
}

/** A claim this delta would create, with everything in the delta that bears
 *  on it gathered under it, so a reviewer reads one block per candidate. */
export interface PreviewClaim {
  ref: PreviewRef;
  kind: ClaimKind;
  statement: string;
  structuredValue?: unknown;
  /** Evidence in this delta attached to this claim. */
  evidence: PreviewEvidence[];
  /** Justifications in this delta concluding this claim. */
  justifications: PreviewJustification[];
}

/** A revision this delta would create. `current` is what the ledger holds for
 *  the targeted id right now — the reviewer's before-and-after. */
export interface PreviewRevision {
  claimId: string;
  expectedRevision: number;
  /** The revision this would become: `expectedRevision + 1`. */
  ref: PreviewRef;
  kind?: ClaimKind;
  statement: string;
  revisionNote?: string;
  structuredValue?: unknown;
  /** The active revision as the ledger stands, when the claim exists. */
  current?: {
    claim: ClaimRef;
    statement: string;
    support: ClaimSupport;
    lifecycle: ClaimLifecycle;
  };
  /** True when `expectedRevision` is no longer the active revision: the
   *  precondition will refuse this delta at commit. */
  stale?: boolean;
  evidence: PreviewEvidence[];
  justifications: PreviewJustification[];
}

/**
 * Why a reviewer should look twice. Every code is decided from **exact
 * structured information** — the delta, the ledger, the filesystem — never
 * from similarity, embeddings or a model's opinion.
 *
 * - `business-rule-without-evidence` — a proposed rule carries no supporting
 *   evidence in the delta. Under `evidence: "required"` this is refused, not
 *   warned.
 * - `revision-without-evidence` — a business-rule revision changes the
 *   sentence without adding evidence for the new statement.
 * - `assumption-without-evidence` — an assumption with neither evidence nor a
 *   justification. Always a warning, never a refusal: an assumption is
 *   allowed to be a bare stipulation, but it should be visible as one.
 * - `claim-without-support` — any other proposed claim with no evidence and
 *   no justification.
 * - `revision-target-unsupported` — the revision targets a claim the ledger
 *   currently holds as `unsupported` or `contested`.
 * - `revision-stale` — the `expectedRevision` is no longer active; the commit
 *   will refuse the whole delta.
 * - `source-file-missing` — `source-code` evidence names a path that is not in
 *   the run's working tree.
 * - `source-outside-scope` — the path is inside the repository but outside the
 *   phase's declared discovery scope.
 * - `source-path-unsafe` — the path is absolute, escapes the root, or is
 *   otherwise not a containable repository-relative path.
 * - `source-git-head-mismatch` — the evidence names a commit other than the one
 *   Argus recorded for the run.
 * - `source-range-invalid` — `endLine` precedes `startLine`.
 * - `new-rule-while-rules-supplied` — the delta creates a new business rule
 *   although the run was *supplied* existing business rules it does not
 *   revise. Purely structural: it counts supplied refs and revised ids, and
 *   says "check whether one of these is the same logical rule". It is not a
 *   similarity judgement and never claims the rules are duplicates.
 */
export type KnowledgeDeltaWarningCode =
  | "business-rule-without-evidence"
  | "revision-without-evidence"
  | "assumption-without-evidence"
  | "claim-without-support"
  | "revision-target-unsupported"
  | "revision-stale"
  | "source-file-missing"
  | "source-outside-scope"
  | "source-path-unsafe"
  | "source-git-head-mismatch"
  | "source-range-invalid"
  | "new-rule-while-rules-supplied";

export interface KnowledgeDeltaWarning {
  code: KnowledgeDeltaWarningCode;
  /** One sentence, naming the subject and what is wrong with it. */
  message: string;
  /** The display form of what the warning is about (`local:comment-limit`,
   *  `RULE-17`, `src/KobraAdapter.cs`). */
  subject?: string;
}

/**
 * The deterministic read model of a staged KnowledgeDelta: what would become
 * canonical if this phase were approved, as a reviewer needs to see it.
 *
 * Derived per read from the staged record and the ledger as it stands. It
 * mutates nothing, mints no id, and does not pretend a proposed claim already
 * has a canonical identity — a new claim is `local:<label>` here and gets its
 * real id only at commit.
 */
export interface KnowledgeDeltaPreview {
  deltaId: string;
  runId: string;
  /** The step whose run wrote it. */
  step: string;
  attempt: number;
  status: KnowledgeDeltaStatus;
  proposedClaims: PreviewClaim[];
  proposedRevisions: PreviewRevision[];
  /** Every evidence record in the delta, in delta order — including the ones
   *  already shown under their claim, so a reviewer can scan evidence alone. */
  evidence: PreviewEvidence[];
  justifications: PreviewJustification[];
  /** Exact revisions the run declared it relied on, with their statements
   *  when the ledger still holds them. */
  consumed: Array<{ ref: string; claim: ClaimRef; kind?: ClaimKind; statement?: string }>;
  artifacts: ArtifactRef[];
  /** The exact revisions Argus supplied to the run, when it recorded any. */
  supplied?: Array<{ ref: string; claim: ClaimRef; kind?: ClaimKind; statement?: string }>;
  /** The agent's own one-paragraph summary, when the delta carried one. */
  summary?: string;
  warnings: KnowledgeDeltaWarning[];
}

// ── Business-rule verification (Phase 6) ────────────────────────────────────
//
// Phase 5 answered "what business rules does this organization have, and what
// grounds them?". Phase 6 answers a **different** question about the same
// rules: does the implementation, at one exact repository revision, do what a
// rule says?
//
//   RULE SUPPORT              is the rule itself well founded?
//                             derived from evidence and justifications,
//                             never stored, never set by an agent.
//
//   IMPLEMENTATION CONFORMANCE does the code satisfy the rule right now?
//                             a {@link RuleVerification} record bound to one
//                             exact ClaimRef and one exact gitHead.
//
// They are orthogonal, and Phase 6 exists precisely to keep them that way. A
// supported rule whose implementation violates it is the *normal* state of a
// bug:
//
//   RULE-42:v1  support = supported          (the business really does say 180)
//   RULE-42:v1  @abc123 → violated           (the validator allows 500)
//
// Recording that violation as *opposing evidence* on RULE-42:v1 would make the
// rule read `contested` — "we are no longer sure the business has this rule" —
// which is false, and would then propagate through justifications and impact
// analysis as though the domain itself were in doubt. So a verification never
// touches claim support: it creates no evidence, no justification, and appears
// nowhere in {@link ImpactSet}. The only thing a violation says is that the
// code and the rule disagree, which is a fact about the code.
//
// Two bindings make a verification meaningful, and neither is ever retargeted:
//
//   - the **exact claim revision**. A verification of `RULE-42:v1` says
//     nothing about `RULE-42:v2`; the new revision starts `unverified`.
//   - the **exact repository revision**. `holds at abc123` says nothing about
//     `def456`; the new commit starts `unverified` too.
//
// History is never rewritten and never marked stale. Currency is *derived*
// by asking a scoped question ({@link RuleConformanceReport}).

/**
 * What a verification concluded about one rule at one repository revision.
 *
 * - `holds` — the verifier obtained sufficient implementation or test evidence
 *   to conclude the examined implementation satisfies the rule under the
 *   authored verification criteria.
 * - `violated` — the verifier obtained sufficient evidence that the examined
 *   implementation contradicts the rule.
 * - `unverifiable` — the verifier could not deterministically establish either
 *   outcome from the available implementation and test evidence. An honest
 *   "I could not tell", which is why it must carry a reason. Many business
 *   rules have no executable expression at all, and `unverifiable` exists so
 *   that fact is recorded rather than laundered into `holds`.
 *
 * Deliberately no confidence score and no fourth hedging value: a score would
 * be an agent's opinion wearing a number, and the one thing Argus can be
 * strict about is that uncertainty is named as uncertainty.
 */
export type RuleVerificationOutcome = "holds" | "violated" | "unverifiable";

/**
 * A deterministic check of the verifying phase, cited as conformance evidence.
 *
 * The agent names the check by its `label` only — the label the phase's own
 * `checks` declare. Argus resolves it against the phase definition at intake
 * (a label no check declares refuses the whole proposal) and binds `status`,
 * `exitCode` and `detail` from the phase's {@link VerificationReport} at
 * commit. The agent can therefore cite a test; it cannot *claim* one passed.
 *
 * This is what separates "an agent says it holds" from "an agent says it
 * holds AND `customer-comment-tests` exited 0".
 */
export interface VerificationCheckEvidence {
  type: "check";
  /** The check's label on the phase's `checks`, as the report shows it. */
  label: string;
  /** Bound by Argus from the phase's verification report at commit. */
  status?: "passed" | "failed";
  exitCode?: number | null;
  /** One line from the check result. Never its output. */
  detail?: string;
  note?: string;
}

/** A file the verifying phase produced, cited as conformance evidence — a
 *  test report, a generated analysis. A reference, never a copy. */
export interface VerificationArtifactEvidence {
  type: "artifact";
  artifact: ArtifactRef;
  note?: string;
}

/**
 * The verifier's own reading of the code, where no deterministic check can
 * express the link. Allowed, and deliberately the weakest thing in the union:
 * an outcome resting on this alone is an agent's word, which is why
 * `holds` may be configured to require a passing check
 * ({@link RuleVerificationPolicy.holds}).
 */
export interface VerificationObservationEvidence {
  type: "observation";
  note: string;
}

/**
 * Why an implementation does or does not conform. Deliberately a *separate*
 * union from {@link EvidenceSource}: rule-support evidence and
 * implementation-conformance evidence answer different questions and must
 * never be mistaken for one another — the whole point of Phase 6 is that a
 * failing test is not an argument against the business having the rule.
 *
 * {@link SourceCodeEvidence} is reused as-is, because "where in the code" is
 * the same fact in both worlds, and it stays provenance rather than content:
 * a path, a commit, a symbol, a line range — never a snippet.
 */
export type VerificationEvidence =
  | VerificationCheckEvidence
  | SourceCodeEvidence
  | VerificationArtifactEvidence
  | VerificationObservationEvidence;

/**
 * "Execution E concluded that the implementation at gitHead H does (or does
 * not) conform to exact claim revision R."
 *
 * Immutable once written, and never retargeted: a later revision of the rule,
 * or a later commit of the repository, produces a *new* record. Identity is
 * `(execution.runId, rule)` — one run verifies one rule once — which is what
 * makes committing again after a crash a no-op rather than a duplicate.
 *
 * What it is not: evidence about the rule, a justification, a claim, or an
 * input to support evaluation. `ledger.verifications` is read by the
 * conformance queries and by nothing else.
 */
export interface RuleVerification {
  id: string;
  /** The exact claim revision verified. Always exact, never a bare id. */
  rule: ClaimRef;
  outcome: RuleVerificationOutcome;
  /** The run that performed the verification, with its instance and phase. */
  execution: RunExecutionRef;
  /** The phase attempt the run belonged to. A locator, not identity. */
  attempt?: number;
  /**
   * The repository state examined, as **Argus** recorded it for the run — the
   * invocation record's `gitHead`, never the agent's claim about it. Absent
   * when the run's working tree was not a git repository: then the record
   * says, honestly, that it cannot be scoped to a revision.
   */
  repository?: { gitHead: string };
  /**
   * The repository state examined, at the precision Phase 8 needs: the head
   * **and** the identity of any uncommitted content. Two different dirty trees
   * share one `gitHead`, so a conformance result scoped to the head alone
   * cannot say which implementation it examined.
   *
   * Absent on every record written before Phase 8, and on a run whose working
   * tree Argus could not snapshot. Such a record answers only head-scoped
   * questions; a state-scoped question that carries a working tree never
   * matches it, because it cannot.
   */
  repositoryState?: RepositoryStateRef;
  /** At least one record for `holds` and `violated`. */
  evidence: VerificationEvidence[];
  /** Required for `unverifiable`: why conformance could not be established. */
  reason?: string;
  /** The verifier's one-line note about this rule. */
  note?: string;
  /** Which policy `holds` was granted under, for a later reader. */
  policy?: RuleVerificationHoldsPolicy;
  createdAt: string;
}

/**
 * What `holds` requires.
 *
 * - `agent-evidence` (default) — at least one concrete cited evidence record
 *   of any kind. "The agent said so" with nothing attached is refused either
 *   way; this is the floor, not an absence of one.
 * - `deterministic-check` — additionally, at least one
 *   {@link VerificationCheckEvidence} naming a check of this phase that
 *   passed. A rule with no executable expression then comes back
 *   `unverifiable`, which is the honest answer, rather than `holds`.
 *
 * `violated` always requires cited evidence, and `unverifiable` always
 * requires a reason, under every policy.
 */
export type RuleVerificationHoldsPolicy = "agent-evidence" | "deterministic-check";

/**
 * Turns a phase into a **business-rule verification phase**.
 *
 * What it does *not* do is select rules. The rules a verification phase is
 * accountable for are exactly the ones Argus supplied it through its
 * {@link KnowledgeContextSpec} — `claims`, `fromPhases`, an accepted
 * discovery phase's output — because that mechanism already exists, already
 * records durably what was supplied, and already refuses to float onto a
 * newer revision. Adding a second rule-selection vocabulary would create two
 * answers to "which rules was this run accountable for?".
 *
 * So this policy says only: *this phase is expected to produce structured
 * conformance results for the business rules it was given*, plus how strict
 * `holds` is.
 */
export interface RuleVerificationPolicy {
  /**
   * Which supplied claim kinds must receive an outcome. Default
   * `["business-rule"]`: a context may carry facts and assumptions for the
   * verifier to reason *with*, and those are not things an implementation
   * conforms to.
   */
  kinds?: ClaimKind[];
  /** What `holds` requires. Default `agent-evidence`. */
  holds?: RuleVerificationHoldsPolicy;
  /** One sentence narrowing what "conforms" means here. Author-written. */
  note?: string;
}

/** One rule's conformance result as the agent proposes it. `rule` must name
 *  an exact revision (`RULE-42:v1`), never a bare id. */
export interface ProposedRuleVerification {
  rule: ClaimRef;
  outcome: RuleVerificationOutcome;
  evidence: VerificationEvidence[];
  /** Required when `outcome` is `unverifiable`. */
  reason?: string;
  note?: string;
}

/**
 * The versioned wire format of a verification phase's structured output — the
 * document at `ARGUS_RULE_VERIFICATION_FILE`.
 *
 * Deliberately **not** a {@link KnowledgeDelta}. A delta proposes new
 * canonical semantics; a verification report describes the relationship
 * between an implementation and semantics that already exist. Overloading the
 * delta would have made every conformance result look like a knowledge
 * mutation, and the first thing an agent would have reached for is opposing
 * evidence on the rule — which is exactly the contamination Phase 6 forbids.
 *
 * A run may still write *both* files: a verification phase that also learns
 * something durable proposes it through the delta channel, as any phase does.
 */
export interface RuleVerificationReport {
  schemaVersion: 1;
  verifications: ProposedRuleVerification[];
  metadata?: { summary?: string };
}

/** Same lifecycle as a staged {@link KnowledgeDelta}: nothing is canonical
 *  until the phase crosses its acceptance boundary. */
export type RuleVerificationStatus = "staged" | "applied" | "rejected" | "superseded";

/** Why a verification proposal was refused. Closed, so the engine and the API
 *  can act on it. */
export type RuleVerificationErrorCode =
  | "invalid-json"
  | "schema"
  | "unknown-rule"
  | "not-selected"
  | "incomplete"
  | "evidence"
  | "check-reference"
  | "source-evidence";

/**
 * A verification proposal as Argus staged it beside the run: the identity of
 * the attempt that produced it, exactly which rules Argus held it accountable
 * for, and its status.
 *
 * Per run, like a staged delta, so a retry or a revise writes a fresh path and
 * an abandoned attempt's results can never be credited to a later one.
 */
export interface RuleVerificationRecord {
  id: string;
  runId: string;
  instanceId: string;
  phaseId: string;
  attempt: number;
  step: string;
  status: RuleVerificationStatus;
  receivedAt: string;
  updatedAt: string;
  /** The exact rules Argus supplied this run and requires an outcome for. */
  selected: ClaimRef[];
  /** The repository revision Argus recorded for the run, when it had one. */
  gitHead?: string;
  /** The exact repository state Argus snapshotted when the run completed
   *  (Phase 8): the head *and* the identity of any uncommitted content, so a
   *  realization can prove the verification examined the implementation it is
   *  claiming. Absent when the working tree is not a git repository. */
  repository?: RepositoryStateRef;
  /** The validated proposal. Absent when the document could not be parsed. */
  report?: RuleVerificationReport;
  /** Why it is `rejected` or `superseded`. */
  reason?: string;
  /** The durable records this proposal became, once `applied`. */
  result?: { verifications: RuleVerification[] };
}

/** The counts a verification phase reports for routing, status and the board.
 *  The detail stays in the staged record, which is the one authoritative form. */
export interface RuleVerificationSummary {
  /** Rules Argus supplied and required an outcome for. */
  selected: number;
  holds: number;
  violated: number;
  unverifiable: number;
  /** True while the results are staged and not yet canonical. */
  requiresReview: boolean;
}

/** One rule's proposed outcome, as the gate shows it. */
export interface RuleVerificationPreviewEntry {
  /** `RULE-42:v1`. */
  ref: string;
  rule: ClaimRef;
  /** The rule's statement, when the ledger still holds the revision. */
  statement?: string;
  kind?: ClaimKind;
  /** The rule's own derived state — shown beside the outcome precisely so a
   *  reviewer can see that a `violated` implementation leaves a `supported`
   *  rule supported. */
  support?: ClaimSupport;
  lifecycle?: ClaimLifecycle;
  outcome: RuleVerificationOutcome;
  evidence: VerificationEvidence[];
  reason?: string;
  note?: string;
}

/**
 * The deterministic read model of one staged verification proposal: what would
 * become durable if this phase were approved, grouped by outcome so a reviewer
 * reads "Holds (4) · Violated (1) · Unverifiable (2)" and then the rows.
 *
 * Derived per read from the staged record and the ledger as it stands.
 */
export interface RuleVerificationPreview {
  recordId: string;
  runId: string;
  step: string;
  attempt: number;
  status: RuleVerificationStatus;
  /** The repository revision the results are bound to. */
  gitHead?: string;
  holds: RuleVerificationPreviewEntry[];
  violated: RuleVerificationPreviewEntry[];
  unverifiable: RuleVerificationPreviewEntry[];
  /** Selected rules with no submitted outcome. Empty on a staged record —
   *  completeness is enforced before staging — and populated only on a
   *  rejected one, where it is the reason. */
  missing: string[];
  summary?: string;
}

/**
 * The conformance question's four answers.
 *
 * `unverified` and `unverifiable` are different facts and are never collapsed:
 *
 * - `unverified` — **no accepted verification exists** for the scope asked
 *   about. Nobody looked (at this revision of the rule, at this commit).
 * - `unverifiable` — somebody looked and **concluded the available evidence
 *   could not settle it**.
 *
 * Reporting the first as the second would claim an investigation that never
 * happened; reporting the second as the first would lose one.
 */
export type RuleConformanceStatus = "holds" | "violated" | "unverifiable" | "unverified";

/**
 * "Does the implementation conform to this exact rule revision?" — derived per
 * read, never stored, and never timeless.
 *
 * `gitHead` scopes the question. With one, only verifications that examined
 * that commit count, so a rule verified `holds` at `abc123` reads
 * `unverified` at `def456` until somebody verifies it there: Argus never says
 * "the current implementation holds" on the strength of an older commit.
 * Without one, `status` is the latest recorded outcome for the revision, and
 * `latest.repository.gitHead` says which commit that was about — a statement
 * about the past, which is the only kind of statement the record supports.
 *
 * `history` is always the full, unfiltered history of the revision, oldest
 * first, so several repository revisions coexist and none is ever rewritten.
 */
export interface RuleConformanceReport {
  rule: ClaimRef;
  /** The repository revision the question was scoped to, when one was given. */
  gitHead?: string;
  status: RuleConformanceStatus;
  /** The verification that decides `status`. Absent when `unverified`. */
  latest?: RuleVerification;
  /** Every verification of this exact revision, oldest first. */
  history: RuleVerification[];
}

/** `GET /api/knowledge/claims/:key/verifications`. */
export interface ClaimVerificationsResponse {
  claim: ClaimRef;
  verifications: RuleVerification[];
}

/** `GET /api/knowledge/executions/:runId/verifications`. */
export interface ExecutionVerificationsResponse {
  runId: string;
  verifications: RuleVerification[];
}

// ── Change-intent orchestration (Phase 7) ───────────────────────────────────
//
// Phase 5 answered "what business rules does this organization have?". Phase 6
// answered "does the implementation satisfy them?". Phase 7 answers a third,
// different question, and the one a person actually arrives with:
//
//   "We want the business to work differently. What does that mean?"
//
// Three things that look alike and are not, and the whole phase exists to keep
// them apart:
//
//   REQUESTED CHANGE      "Kobra now supports 500-character comments."
//                         a {@link ChangeRequest}. Somebody's words. Neither
//                         canonical knowledge nor evidence that any particular
//                         reading of it is correct.
//
//   CURRENT SEMANTICS     RULE-42:v1 "Kobra comments max = 180", supported.
//                         the ledger. Reaches the agent as a KnowledgeContext.
//
//   CURRENT IMPLEMENTATION RULE-42:v1 @abc123 → holds (or violated, or
//                         unverified). a {@link RuleVerification}. A fact
//                         about the code, never about what the business wants.
//
// and the output, which is a fourth thing again:
//
//   PROPOSED TRANSITION   revise RULE-42:v1 → v2 "max = 500", preserve
//                         CONSTRAINT-8:v1, decide "only when engine == Kobra",
//                         accept when 500 passes and 501 fails.
//                         a {@link ChangeProposal}: *reviewed intent*, not
//                         canonical until a person approves it.
//
// Phase 7 stops there. It proposes semantics; it never writes code, never
// re-runs an implementation, and never infers what the business *wants* from
// what the code currently *does*.
//
// The semantic half of a proposal is an ordinary {@link KnowledgeDelta} — the
// one mechanism that turns a proposal into canonical claims — so nothing here
// duplicates mutation logic, and a change proposal becomes canonical through
// exactly the Phase 3 commit boundary. What Phase 7 adds around it is the
// material a delta has no place for: what is deliberately *unchanged*, how
// success will be judged, what is still unknown, and which request caused
// any of it.

/**
 * The bounded target of one requested change. Free-form on purpose: unlike a
 * {@link DiscoveryScope}, nothing is checked against it — no evidence path is
 * contained by it — because Phase 7 reads no code. It narrows the agent's
 * attention and appears in the review, and that is all.
 */
export interface ChangeRequestScope {
  /** Repository-relative paths or areas the requester believes are involved. */
  paths?: string[];
  /** A short name for what is changing ("Kobra booking comments"). */
  label?: string;
  /** One sentence narrowing the request. Requester-written, never Argus's. */
  note?: string;
}

/**
 * The structured form of "we want the business to work differently".
 *
 * Deliberately *not* a claim. A request is somebody's words about a desired
 * future; a claim is what the organization holds to be the case. Conflating
 * them is precisely how a Jira ticket becomes organizational truth without
 * anyone deciding that it should. So a ChangeRequest is never written into
 * `knowledge.json` as a claim — it is carried, frozen, on the
 * {@link AcceptedChangeProposal} that answered it.
 *
 * `claims` names canonical revisions the *requester* believes are involved.
 * It is a hint, not a selection: which rules the change agent is accountable
 * for classifying comes from the phase's KnowledgeContext, exactly as a
 * verification phase's accountability does.
 */
export interface ChangeRequest {
  /** Stable identity, so several proposals can answer the same request.
   *  Authored, or minted by Argus from the phase attempt when absent. */
  id: string;
  /** One line: what is wanted. */
  summary: string;
  /** The longer form, when there is one. */
  details?: string;
  scope?: ChangeRequestScope;
  /** Canonical revisions the requester thinks are involved. A hint. */
  claims?: ClaimRef[];
  /** Constraints the requester supplied in their own words. Not canonical
   *  constraints — those are `constraint` claims, and a genuinely new one is
   *  proposed through the semantic delta like anything else. */
  constraints?: string[];
  /** Who asked. Free-form. */
  requestedBy?: string;
  /** When Argus received it (bound by Argus at phase-attempt planning). */
  receivedAt?: string;
}

/**
 * A reference inside a change proposal: a claim the proposal's own semantic
 * delta creates (by its delta-local id) or an **exact** existing revision.
 * The same rule as {@link DeltaClaimRef} and for the same reason — a bare id
 * could be silently retargeted by a later revision — and the same string form
 * (`RULE-42:v2`) is accepted.
 */
export type ChangeClaimRef = DeltaClaimRef;

/** What an acceptance criterion is *about*. A closed vocabulary so a later
 *  phase can route on it without parsing prose.
 *
 *  - `behavior` — an externally observable behaviour the change introduces.
 *  - `invariant` — something that must hold throughout, new or not.
 *  - `regression` — something that must keep working exactly as before.
 *  - `verification` — a check or test that must exist and pass. */
export type AcceptanceCriterionKind = "behavior" | "invariant" | "regression" | "verification";

/**
 * One observable condition that demonstrates the requested change was
 * implemented correctly.
 *
 * **Not a business rule, and never stored as one.** A business rule describes
 * domain semantics that outlive any particular change ("Kobra comments max =
 * 500"); an acceptance criterion describes the evidence that one change was
 * carried out ("a 501-character Kobra comment is rejected"). Storing criteria
 * as claims would fill the ledger with per-change assertions that nothing
 * supersedes and nobody would ever revise, and would make "what does the
 * business say?" unanswerable. So criteria live on the
 * {@link AcceptedChangeProposal} — durable, addressable, and outside the claim
 * graph.
 *
 * They may *reference* exact rule revisions, and after the commit they do:
 * `relatesTo` is rewritten from delta-local ids to the canonical refs the
 * commit minted ({@link ResolvedAcceptanceCriterion}).
 *
 * Deliberately not a test DSL. `verificationHint` is one line of prose for a
 * human or a later agent; Argus never executes it.
 */
export interface AcceptanceCriterion {
  /** Proposal-local identity (`AC-1`). Unique within one proposal. */
  id: string;
  statement: string;
  kind: AcceptanceCriterionKind;
  /** The proposed or existing semantics this criterion is evidence for. */
  relatesTo: ChangeClaimRef[];
  /** One line on how it could be checked. Never executed by Argus. */
  verificationHint?: string;
}

/** An acceptance criterion as it is persisted on an accepted proposal: every
 *  reference resolved to a canonical revision. A delta-local id can never
 *  appear here — that is the point of resolving at commit. */
export interface ResolvedAcceptanceCriterion extends Omit<AcceptanceCriterion, "relatesTo"> {
  relatesTo: ClaimRef[];
}

/**
 * Something the requested change does not determine.
 *
 * The alternative to this type is an agent inventing a number. Asked to
 * "increase the Kobra comment limit" with no new maximum stated, a model will
 * produce `500` and a justification for it, and the fact that nobody ever
 * decided `500` disappears. An unresolved question keeps that fact, and keeps
 * the proposal out of `ready`.
 */
export interface UnresolvedQuestion {
  /** Proposal-local identity (`Q-1`). */
  id: string;
  question: string;
  /** The proposed or existing semantics that cannot be settled without an
   *  answer. Resolved to canonical refs at commit. */
  blocks?: ChangeClaimRef[];
  note?: string;
}

/** An unresolved question as persisted: references resolved, no local ids. */
export interface ResolvedUnresolvedQuestion extends Omit<UnresolvedQuestion, "blocks"> {
  blocks?: ClaimRef[];
}

/**
 * How one rule Argus held the change agent accountable for was accounted for.
 *
 * - `revised` — this proposal revises it.
 * - `preserved` — it stays exactly as it is, deliberately, and the
 *   implementation must not change its behaviour.
 * - `not-relevant` — the request does not bear on it.
 * - `unresolved` — whether it changes cannot be decided without an answer to
 *   an {@link UnresolvedQuestion}.
 *
 * Every selected rule must carry one of these. Silence is the failure mode
 * this exists to close: a change agent that simply never mentions a rule it
 * was given looks exactly like one that decided the rule was unaffected.
 */
export type RuleChangeDisposition = "revised" | "preserved" | "not-relevant" | "unresolved";

export interface RuleClassification {
  rule: ClaimRef;
  disposition: RuleChangeDisposition;
  /** One line: why. Required for `not-relevant` — the disposition that is
   *  otherwise indistinguishable from not having looked. */
  note?: string;
}

/**
 * Whether the proposal is fit to drive an implementation.
 *
 * - `ready` — every selected rule is accounted for, nothing is unresolved,
 *   and every proposed business-rule change carries acceptance criteria.
 * - `needs-input` — something is missing. The proposal may still be approved
 *   (its semantic delta, if any, commits), and the accepted record says
 *   `needs-input` forever; what it may not do is silently drive an
 *   implementation. A {@link ChangeContextSpec} refuses it by default.
 *
 * Derived deterministically from the proposal, never asserted by the agent.
 */
export type ChangeProposalReadiness = "ready" | "needs-input";

/**
 * The versioned wire format of a change-intent phase's output — the document
 * at `ARGUS_CHANGE_PROPOSAL_FILE`.
 *
 * `semanticDelta` is an ordinary {@link KnowledgeDelta} and is the *only* way
 * anything here becomes canonical: rule revisions, new constraints and
 * decisions go in it, are staged as that run's delta, and commit through the
 * Phase 3 boundary. Everything beside it — what is preserved, how success is
 * judged, what is unknown — is change material, not claim material, and is
 * persisted on the accepted proposal instead.
 *
 * A change-intent run writes this file and **not** an
 * `ARGUS_KNOWLEDGE_DELTA_FILE`: one run, one account of what it proposes.
 */
export interface ChangeProposal {
  schemaVersion: 1;
  /** The canonical semantic mutations this change would make. Absent or empty
   *  = the request implies no semantic difference, which is a legitimate (and
   *  warned) answer. */
  semanticDelta?: KnowledgeDelta;
  /** Existing revisions this change deliberately leaves untouched. Exact refs
   *  only: "the rule as it is right now", not "whatever RULE-9 becomes". */
  preserved?: ClaimRef[];
  /** One entry per rule Argus held this run accountable for. */
  classification?: RuleClassification[];
  acceptanceCriteria?: AcceptanceCriterion[];
  unresolved?: UnresolvedQuestion[];
  metadata?: { summary?: string };
}

/** Same lifecycle as a staged {@link KnowledgeDelta}. Nothing is canonical
 *  until the phase crosses its acceptance boundary. */
export type ChangeProposalStatus = "staged" | "accepted" | "rejected" | "superseded";

/** Why a change proposal was refused. Closed, so the engine and the API can
 *  act on it. */
export type ChangeProposalErrorCode =
  | "invalid-json"
  | "schema"
  | "unknown-claim"
  | "local-reference"
  | "incomplete"
  | "contradiction"
  | "acceptance-criteria"
  | "delta";

/**
 * A change proposal as Argus staged it beside the run: the request it was
 * answering, exactly which rules it was accountable for, the staged delta
 * carrying its semantic half, and its status.
 *
 * Per run, like a staged delta, so a retry or a revise writes a fresh path and
 * an abandoned attempt's proposal can never be credited to a later one.
 */
export interface ChangeProposalRecord {
  id: string;
  runId: string;
  instanceId: string;
  phaseId: string;
  attempt: number;
  step: string;
  status: ChangeProposalStatus;
  receivedAt: string;
  updatedAt: string;
  /** The request this run was given, frozen at launch. */
  request: ChangeRequest;
  /** The exact rules Argus supplied this run and requires a classification for. */
  selected: ClaimRef[];
  /** Everything Argus supplied as KnowledgeContext, when it recorded any. */
  supplied?: ClaimRef[];
  /** The repository revision Argus recorded for the run, when it had one.
   *  What the conformance projection was scoped to. */
  gitHead?: string;
  /** The validated proposal. Absent when the document could not be parsed. */
  proposal?: ChangeProposal;
  /** The staged {@link KnowledgeDeltaRecord} carrying `semanticDelta`, when
   *  the proposal had semantic content. The two records commit together. */
  deltaId?: string;
  /** Derived at intake from the validated proposal. */
  readiness?: ChangeProposalReadiness;
  /** Why it is `rejected` or `superseded`. */
  reason?: string;
  /** The durable record it became, once `accepted`. */
  result?: { proposal: AcceptedChangeProposal };
}

/**
 * The durable record of a change that a person approved (ledger version 6).
 *
 * Lives in `knowledge.json` beside the records its delta created, so three
 * questions are answerable from the ledger alone, forever:
 *
 *   "What requested change caused RULE-42:v2 to exist?"
 *   "What acceptance criteria were associated with RULE-42:v2?"
 *   "Which implementation run was later intended to realize CP-12?"
 *
 * This is **change provenance**, and it is deliberately not justification.
 * A justification answers *why is this claim supported?* — an argument from
 * premises, which bears on support. Change provenance answers *which request
 * made us intentionally introduce or revise it?* — a historical fact about
 * intent, which bears on nothing. Conflating them would make "the business
 * asked for it" an argument that a rule is true.
 *
 * Immutable once written, and never retargeted: a later `RULE-42:v3` does not
 * change what this proposal says it did, exactly as a consumption or a
 * verification does not.
 */
export interface AcceptedChangeProposal {
  id: string;
  schemaVersion: 1;
  /** The request, frozen as it was when the run was launched. */
  request: ChangeRequest;
  /** The run that produced the proposal, with its instance and phase. */
  execution: RunExecutionRef;
  attempt?: number;
  /** The applied {@link KnowledgeDelta} that carried the semantic half. */
  deltaId?: string;
  readiness: ChangeProposalReadiness;
  /** Every canonical revision this change created — new claims and revisions
   *  alike — in commit order. */
  semanticChanges: ClaimRef[];
  /** Revisions, as before-and-after pairs. */
  revised: Array<{ from: ClaimRef; to: ClaimRef }>;
  /** New claims of any kind (revision 1). */
  created: ClaimRef[];
  /** The subset of `created` that are `decision` claims, for the downstream
   *  handoff, which cares about them specifically. */
  decisions: ClaimRef[];
  /** The subset of `created` that are `constraint` claims. */
  constraints: ClaimRef[];
  /** Existing revisions this change deliberately left untouched. */
  preserved: ClaimRef[];
  /** Every reference resolved to canonical identity. */
  acceptanceCriteria: ResolvedAcceptanceCriterion[];
  unresolved: ResolvedUnresolvedQuestion[];
  classification: RuleClassification[];
  acceptedAt: string;
}

/**
 * Why a reviewer should look twice at a change proposal. Every code is decided
 * from **exact structured information** — the proposal, the ledger, the
 * conformance records — never from similarity, embeddings or a model's
 * opinion, exactly as {@link KnowledgeDeltaWarningCode} is.
 *
 * - `no-semantic-change` — the request produced no proposed semantic
 *   difference at all. Sometimes correct (the rule already says it); always
 *   worth a second look.
 * - `selected-rule-unclassified` — a rule Argus supplied and held the run
 *   accountable for is neither revised, preserved, not-relevant nor
 *   unresolved. **Refuses the proposal**: silence about a supplied rule is
 *   indistinguishable from not having considered it.
 * - `preserved-and-revised` — the same claim is listed as preserved *and*
 *   revised. **Refuses the proposal**: a contradiction, not a judgement call.
 * - `classification-mismatch` — a rule classified `revised` that the semantic
 *   delta does not revise, or classified `preserved`/`not-relevant` while the
 *   delta revises it. **Refuses the proposal**: the accounting and the
 *   proposal must describe the same change, or the accounting is decoration.
 * - `acceptance-criterion-unknown-ref` — a criterion names a delta-local id
 *   the semantic delta does not declare. **Refuses the proposal**.
 * - `acceptance-criteria-missing` — a proposed business-rule change carries no
 *   acceptance criterion referencing it. Refuses under the default
 *   `acceptanceCriteria: "required"`; under `"warn"` it is a warning and the
 *   proposal reads `needs-input`.
 * - `unresolved-questions` — the proposal carries unresolved questions, so it
 *   is not implementation-ready.
 * - `implementation-already-violates` — the current implementation is already
 *   non-conformant with a selected rule this proposal does **not** revise: a
 *   pre-existing defect the change does not address. From the exact
 *   {@link RuleVerification} record, never from an agent's reading.
 * - `change-may-be-implemented` — the current implementation already violates
 *   a rule this proposal revises: the code may already do the requested thing
 *   and the rule is only now catching up. Still not a reason to revise the
 *   rule — the *request* is — and never a licence to rewrite the violation.
 * - `implementation-unverified` — no accepted verification exists for a
 *   selected rule at the run's repository revision, so nothing is known about
 *   whether the code does what the rule says.
 * - `request-claim-unknown` — the request named a canonical revision the
 *   ledger does not hold.
 */
export type ChangeProposalWarningCode =
  | "no-semantic-change"
  | "selected-rule-unclassified"
  | "preserved-and-revised"
  | "classification-mismatch"
  | "acceptance-criterion-unknown-ref"
  | "acceptance-criteria-missing"
  | "unresolved-questions"
  | "implementation-already-violates"
  | "change-may-be-implemented"
  | "implementation-unverified"
  | "request-claim-unknown";

export interface ChangeProposalWarning {
  code: ChangeProposalWarningCode;
  /** One sentence, naming the subject and what is wrong with it. */
  message: string;
  /** The display form of what the warning is about (`RULE-42:v1`, `AC-2`). */
  subject?: string;
}

/**
 * One rule's current state as the change agent receives it and the reviewer
 * sees it: what the business says, whether that is well founded, and whether
 * the code currently does it.
 *
 * The two halves are shown together and never merged. `support` is about the
 * rule; `conformance` is about the code. A rule may be `supported` and
 * `violated` at once — that is a bug — and a change proposal must be able to
 * say so without either fact contaminating the other.
 */
export interface ChangeRuleState {
  /** `RULE-42:v1`. */
  ref: string;
  claim: ClaimRef;
  kind: ClaimKind;
  statement: string;
  support: ClaimSupport;
  lifecycle: ClaimLifecycle;
  /** Conformance scoped to the repository revision the change is analysed at.
   *  `unverified` means nobody looked at this commit — never "it is fine". */
  conformance: RuleConformanceStatus;
  /** The commit the deciding verification examined, when there is one. */
  conformanceAt?: string;
  /** When it was recorded. */
  verifiedAt?: string;
}

/**
 * The versioned wire format of the input Argus materializes for a
 * change-intent run — the document at `ARGUS_CHANGE_REQUEST_FILE`.
 *
 * It carries the two things the agent cannot be trusted to derive: the request
 * verbatim, and the *current conformance* of the rules it is accountable for.
 * The current **semantics** deliberately arrive separately, through the
 * ordinary KnowledgeContext, so there is exactly one channel for "what the
 * ledger holds" and the request never becomes a place to restate it.
 */
export interface ChangeIntentInput {
  schemaVersion: 1;
  generatedAt: string;
  request: ChangeRequest;
  /** The rules this run must classify, with their current state. */
  relevant: ChangeRuleState[];
  /** The repository revision `relevant[].conformance` is scoped to. */
  gitHead?: string;
}

/**
 * Turns a phase into a **change-intent phase** (Phase 7).
 *
 * The phase is otherwise ordinary: the same steps, the same gate, the same
 * commit boundary. What `changeIntent` changes:
 *
 * - the run receives a {@link ChangeIntentInput} (the request plus current
 *   conformance) and is instructed to answer with a {@link ChangeProposal};
 * - the rules it is accountable for classifying are exactly the ones its
 *   `knowledgeContext` supplied — there is no second selection mechanism;
 * - its proposal's `semanticDelta` is staged as the run's KnowledgeDelta and
 *   commits through the Phase 3 boundary, atomically with the accepted
 *   proposal record.
 *
 * A change-intent phase **must** be `gated`. Phase 7 exists so that a
 * requested change is reviewed before it becomes canonical semantics; an
 * ungated one would be a pipeline that rewrites the domain because somebody
 * filed a ticket.
 */
export interface ChangeIntentPolicy {
  /**
   * The request, authored on the phase. An instance whose trigger payload
   * carries `changeRequest` overrides it — the run-specific request is more
   * specific than the pipeline's default. One of the two must resolve, or the
   * phase fails as a `configuration` error rather than inventing a request.
   */
  request?: ChangeRequest;
  /**
   * Which supplied claim kinds must be classified. Default
   * `["business-rule"]`: a context may carry facts and constraints for the
   * agent to reason *with*, and a change does not have to account for each.
   */
  kinds?: ClaimKind[];
  /**
   * Whether a proposed business-rule change must carry an acceptance
   * criterion referencing it. Default `"required"` — fail-closed, because an
   * implementation-ready proposal with no way to judge success is the failure
   * this phase is meant to prevent. `"warn"` downgrades it to a warning and
   * the proposal reads `needs-input`.
   */
  acceptanceCriteria?: "required" | "warn";
  /** One sentence narrowing what this phase should reason about. */
  note?: string;
}

/**
 * How a later phase receives an accepted {@link ChangeProposal} (Phase 7 §23).
 *
 * Resolved exclusively from the ledger's **accepted** change proposals for the
 * named phase of this same instance — never from a staged record — so a
 * proposal parked at a gate resolves to nothing and refuses the launch rather
 * than leaking unapproved intent into an implementation run.
 */
export interface ChangeContextSpec {
  /** A phase of the same pipeline, which must run before this one. */
  fromPhase: string;
  /** Refuse the launch when the accepted proposal is `needs-input`. Default
   *  `true`: an implementation driven by intent nobody finished deciding is
   *  exactly what readiness exists to prevent. */
  requireReady?: boolean;
}

/**
 * The versioned wire format of the accepted intent a later run receives — the
 * document at `ARGUS_CHANGE_CONTEXT_FILE`.
 *
 * The contract between intent reasoning and implementation. It carries
 * **references**, not restatements: `semanticChanges` names `RULE-42:v2`, and
 * what RULE-42:v2 *says* arrives through the run's KnowledgeContext. A second
 * copy of a claim's sentence in a second file is a second thing to drift.
 */
export interface ChangeContext {
  schemaVersion: 1;
  generatedAt: string;
  proposalId: string;
  request: ChangeRequest;
  readiness: ChangeProposalReadiness;
  /** Canonical revisions this change created. */
  semanticChanges: ClaimRef[];
  revised: Array<{ from: ClaimRef; to: ClaimRef }>;
  created: ClaimRef[];
  decisions: ClaimRef[];
  constraints: ClaimRef[];
  /** Exact revisions that must keep behaving as they do. */
  preserved: ClaimRef[];
  acceptanceCriteria: ResolvedAcceptanceCriterion[];
  unresolved: ResolvedUnresolvedQuestion[];
}

/** An existing revision as a change preview names it: the ref, and the
 *  statement when the ledger still holds it. */
export interface ChangeClaimSummary {
  ref: string;
  claim: ClaimRef;
  kind?: ClaimKind;
  statement?: string;
}

/**
 * The deterministic read model of one staged change proposal: everything a
 * reviewer needs, in the order they need it, without reading a transcript.
 *
 *   Requested change → CURRENT (rule + support + conformance) → PROPOSED →
 *   PRESERVED → DECISIONS → ACCEPTANCE CRITERIA → UNRESOLVED → warnings
 *
 * `semantic` is the ordinary {@link KnowledgeDeltaPreview} of the proposal's
 * delta, so proposed revisions, their before-and-after and their own
 * deterministic warnings are shown by exactly the machinery Phase 5 built.
 * Derived per read; mutates nothing and mints no id.
 */
export interface ChangeProposalPreview {
  proposalId: string;
  runId: string;
  step: string;
  attempt: number;
  status: ChangeProposalStatus;
  readiness: ChangeProposalReadiness;
  request: ChangeRequest;
  /** The rules this run was accountable for, with their support and the
   *  conformance of the implementation at the run's commit. */
  current: ChangeRuleState[];
  /** The semantic half, previewed as any staged delta is. Absent when the
   *  proposal proposes no semantic change. */
  semantic?: KnowledgeDeltaPreview;
  preserved: ChangeClaimSummary[];
  acceptanceCriteria: AcceptanceCriterion[];
  unresolved: UnresolvedQuestion[];
  classification: RuleClassification[];
  warnings: ChangeProposalWarning[];
  summary?: string;
}

/** The counts a change-intent phase reports for routing, status and the board.
 *  The proposal itself stays in the staged record, which is the one
 *  authoritative form of it. */
export interface ChangeIntentSummary {
  requestId: string;
  readiness: ChangeProposalReadiness;
  /** Selected rules, i.e. the ones a classification is required for. */
  selected: number;
  revised: number;
  created: number;
  decisions: number;
  preserved: number;
  acceptanceCriteria: number;
  unresolved: number;
  warnings: number;
  /** True while the proposal is staged and not yet accepted. */
  requiresReview: boolean;
}

/** `GET /api/knowledge/change-proposals`. Accepted proposals, newest first. */
export interface ChangeProposalsResponse {
  proposals: AcceptedChangeProposal[];
}

// ── Targeted implementation and closed-loop realization (Phase 8) ───────────
//
// Phase 7 ended at *accepted intent*: a person approved a ChangeProposal, its
// semantic delta committed, and an implementation phase could receive the
// result as a ChangeContext. Phase 8 answers the question that follows:
//
//   "Has this accepted business change actually been implemented, and how do
//    we know?"
//
// The answer is never one fact. Four independent dimensions have to hold, and
// the whole phase exists to keep them apart:
//
//   TECHNICAL EXECUTION      the implementation run reported succeeded.
//                            An agent's own word about its own work.
//
//   DETERMINISTIC CHECKS     Argus's PhaseChecks passed: it compiled, the
//                            tests exited 0. Argus's own observation.
//
//   RULE CONFORMANCE         RuleVerification says the code at this exact
//                            repository state satisfies the exact revised
//                            rules (§Phase 6). About the domain's semantics.
//
//   ACCEPTANCE SATISFACTION  AcceptanceVerification says the accepted
//                            proposal's own criteria are met at that state.
//                            About *this change* having been carried out.
//
// `ARGUS_OUTCOME: succeeded` alone is not implementation. `npm test` exiting 0
// alone is not implementation. Every rule holding is not implementation while
// an acceptance criterion is violated, and every criterion being satisfied is
// not implementation while a revised rule is violated. A change is realized
// only when **all four** hold, at one repository state, against semantic
// intent that is still current.

/**
 * The repository state a verification examined, precisely enough that two
 * different implementations cannot be mistaken for one another.
 *
 * `gitHead` alone is not an identity for a working tree an agent edited
 * without committing: two different dirty trees share one head, and a
 * conformance result bound to the head alone would claim that what was true
 * of one is true of the other. So a dirty tree additionally carries the
 * identity of its uncommitted content — the hash of Argus's own
 * `WorkingTreeSnapshot`, which is derived from the bytes of every dirty path
 * and never from a timestamp.
 *
 * Absent `workingTree` means **clean at `gitHead`** — a positive statement,
 * not an unknown. A ref with neither field is a working directory that is not
 * a git repository at all: represented explicitly so nothing downstream
 * invents a revision identity that does not exist.
 */
export interface RepositoryStateRef {
  /** `git rev-parse HEAD` as Argus read it. Absent outside a repository. */
  gitHead?: string;
  /** The uncommitted content, when there was any. Absent = the tree was clean. */
  workingTree?: {
    /** sha256 over the sorted (path → content identity) pairs of the snapshot. */
    snapshotHash: string;
    /** How many paths were dirty. A locator for a reader, never identity. */
    dirty: number;
    /** Set when the snapshot hit Argus's entry cap and cannot identify the
     *  tree. Such a state can never back a realization close-out. */
    truncated?: boolean;
  };
}

// ── Implementation scope ────────────────────────────────────────────────────

/**
 * Why one path is in an implementation's scope. A closed taxonomy, so the
 * reason is machine-readable rather than prose a later phase would have to
 * parse:
 *
 * - `impact-artifact` — an {@link ImpactSet} says an execution that consumed a
 *   revised rule produced this artifact. The strongest reason: exact
 *   consumption provenance, from Phase 2, not a guess.
 * - `source-code-evidence` — a `source-code` {@link Evidence} record grounds a
 *   rule this change revises (or its superseded predecessor). "This is where
 *   the rule lives in the code", as discovery recorded it.
 * - `preserved-evidence` — the same, for a revision the change deliberately
 *   **preserves**: the regression surface, named so the agent knows what it
 *   must not break.
 * - `request-scope` — the requester's own `ChangeRequest.scope.paths`. A human
 *   hint, carried through verbatim and labelled as such.
 * - `verification-evidence` — a `source-code` record cited by an accepted
 *   {@link RuleVerification} of a rule this change revises: where somebody
 *   last looked when they decided whether the code conformed.
 */
export type ScopeReasonCode =
  | "impact-artifact"
  | "source-code-evidence"
  | "preserved-evidence"
  | "request-scope"
  | "verification-evidence";

/** One machine-readable justification for a path being in scope. Every field
 *  beyond `code` is provenance a reader can follow back into the ledger. */
export interface ScopeReason {
  code: ScopeReasonCode;
  /** The exact revision this reason is about, when it has one. */
  claim?: ClaimRef;
  /** The execution that produced the artifact, for `impact-artifact`. */
  execution?: RunExecutionRef;
  /** The evidence record id, for the evidence-derived reasons. */
  evidenceId?: string;
  /** One line, for a human reading the scope. Never parsed. */
  detail?: string;
}

/** One place the implementation is expected to touch (or to leave alone), with
 *  every reason Argus can give for it. A path may carry several reasons. */
export interface ImplementationTarget {
  /** Repository-relative, exactly as the evidence or the request wrote it. May
   *  name a directory when the request's scope did. */
  path: string;
  /** Where it came from, `repository` for source and `artifact-dir` for a
   *  file an earlier phase produced into its artifact directory. */
  location: ArtifactRef["location"];
  reasons: ScopeReason[];
  /** True when every reason is `preserved-evidence`: this is regression
   *  surface, not work. */
  preserveOnly: boolean;
}

/**
 * Whether Argus's provenance can actually name where this change has to
 * happen.
 *
 * - `known-targets` — every semantic change the proposal makes has at least
 *   one target derived from exact provenance.
 * - `scope-incomplete` — at least one does not. A brand-new business rule that
 *   nothing has ever implemented has no consumer execution, no artifact and no
 *   source evidence, and the honest answer is "Argus cannot tell you where
 *   this goes", **never** "nothing is affected".
 *
 * A scope is a deterministic derivation from what Argus recorded, not a claim
 * to exhaustiveness: even `known-targets` means "these are the places the
 * ledger knows about", and the agent may legitimately need to touch others.
 */
export type ImplementationScopeCompleteness = "known-targets" | "scope-incomplete";

/**
 * The deterministic implementation scope of one accepted change — the document
 * at `ARGUS_IMPLEMENTATION_SCOPE_FILE`.
 *
 * Derived from provenance Argus already holds, in this order and from nothing
 * else: the proposal's `semanticChanges`, the {@link ImpactSet} of each
 * superseded predecessor (consumer executions and the artifacts they
 * produced), the `source-code` evidence grounding the revised and preserved
 * revisions, the `source-code` evidence of accepted rule verifications, and
 * the `ChangeRequest`'s own scope paths. No model, no similarity, no
 * heuristics.
 */
export interface ImplementationScope {
  schemaVersion: 1;
  generatedAt: string;
  proposalId: string;
  /** The exact revisions this change introduced. */
  semanticChanges: ClaimRef[];
  /** The exact revisions it deliberately preserved. */
  preserved: ClaimRef[];
  targets: ImplementationTarget[];
  /** Executions whose work the change impacts, from `analyzeImpact`. */
  impactedExecutions: RunExecutionRef[];
  completeness: ImplementationScopeCompleteness;
  /** The semantic changes with no derivable target. Empty iff
   *  `completeness` is `known-targets`. */
  withoutTargets: ClaimRef[];
  /** The requester's own `scope.paths`, carried through verbatim. */
  requestedPaths: string[];
}

// ── Acceptance verification ─────────────────────────────────────────────────

/**
 * An acceptance criterion, addressed globally and unambiguously.
 *
 * `AC-1` is proposal-local by design (§Phase 7) — two changes may both have an
 * `AC-1` meaning entirely different things — so nothing outside one proposal
 * may address a criterion by its bare id. The pair is the identity, written
 * `CP-12/AC-1`.
 */
export interface AcceptanceCriterionRef {
  proposalId: string;
  criterionId: string;
}

/**
 * The acceptance question's three answers, deliberately mirroring
 * {@link RuleVerificationOutcome} without being it.
 *
 * - `satisfied` — sufficient evidence that the implementation meets this
 *   accepted criterion.
 * - `violated` — sufficient evidence that it does not.
 * - `unverifiable` — the verifier could not establish either. Requires a
 *   reason. Not every criterion can be made executable, and saying so is the
 *   honest answer rather than rounding up to `satisfied`.
 *
 * Deliberately **not** mapped onto rule verification. "Non-Kobra behaviour is
 * unchanged" is not a business rule revision and has no claim to be verified
 * against; it is evidence that one change was carried out correctly.
 */
export type AcceptanceOutcome = "satisfied" | "violated" | "unverifiable";

/** The fourth value, which exists only in the read model: **nobody looked**
 *  at this criterion, at this repository state. Never collapsed with
 *  `unverifiable`, for the reason `unverified` is never collapsed with it in
 *  Phase 6. */
export type AcceptanceConformanceStatus = AcceptanceOutcome | "unverified";

/**
 * "Execution E concluded that the implementation at repository state S does
 * (or does not) satisfy criterion CP-12/AC-1."
 *
 * Immutable once written and never retargeted: a later repository state, or a
 * later proposal, produces a *new* record. Identity is
 * `(execution.runId, proposalId, criterionId)` — one run answers one criterion
 * once — which makes committing again after a crash a no-op rather than a
 * duplicate.
 *
 * What it is not: evidence about a claim, a justification, or an input to
 * support evaluation. `ledger.acceptanceVerifications` is read by the
 * acceptance queries and the realization close-out, and by nothing else.
 */
export interface AcceptanceVerification {
  id: string;
  /** The accepted proposal whose criterion this is. */
  proposalId: string;
  /** The criterion's proposal-local id (`AC-3`). */
  criterionId: string;
  /** The criterion's statement, frozen as the accepted proposal holds it, so
   *  the record still reads after a pruning path removes the run. */
  statement: string;
  kind: AcceptanceCriterionKind;
  outcome: AcceptanceOutcome;
  execution: RunExecutionRef;
  attempt?: number;
  /** The repository state examined, as **Argus** recorded it — never the
   *  agent's claim about it. Absent when the working tree was not a git
   *  repository, which the record then says honestly. */
  repository?: RepositoryStateRef;
  /** The same evidence union rule verification uses: a cited `check` whose
   *  status Argus binds, a source location, an artifact, an observation. */
  evidence: VerificationEvidence[];
  /** Required for `unverifiable`. */
  reason?: string;
  note?: string;
  createdAt: string;
}

/** One criterion's result as the agent proposes it. */
export interface ProposedAcceptanceVerification {
  /** The criterion's proposal-local id. The proposal is fixed by the run's
   *  ChangeContext, so the agent never names it. */
  criterionId: string;
  outcome: AcceptanceOutcome;
  evidence: VerificationEvidence[];
  /** Required when `outcome` is `unverifiable`. */
  reason?: string;
  note?: string;
}

/**
 * The versioned wire format of an acceptance-verification phase's structured
 * output — the document at `ARGUS_ACCEPTANCE_VERIFICATION_FILE`.
 *
 * Its own channel beside `ARGUS_RULE_VERIFICATION_FILE`, for the reason the
 * two dimensions are separate: a rule result is about the domain's semantics
 * and is bound to a `ClaimRef`; a criterion result is about *this change*
 * having been carried out and is bound to `CP-12/AC-1`. A phase that answers
 * both writes both files.
 */
export interface AcceptanceVerificationReport {
  schemaVersion: 1;
  /** The proposal the run was answering for, echoed from its ChangeContext.
   *  Optional; when present it must match, which catches a report written
   *  against the wrong change. */
  proposalId?: string;
  criteria: ProposedAcceptanceVerification[];
  metadata?: { summary?: string };
}

/** Same lifecycle as a staged {@link RuleVerificationReport}: nothing is
 *  durable until the phase crosses its acceptance boundary. */
export type AcceptanceVerificationStatus = "staged" | "applied" | "rejected" | "superseded";

/** Why an acceptance-verification proposal was refused. Closed, so the engine
 *  and the API can act on it. */
export type AcceptanceVerificationErrorCode =
  | "invalid-json"
  | "schema"
  | "unknown-proposal"
  | "unknown-criterion"
  | "incomplete"
  | "evidence"
  | "check-reference"
  | "source-evidence";

/**
 * An acceptance-verification proposal as Argus staged it beside the run: which
 * accepted proposal it answers, exactly which criteria it is accountable for,
 * the repository state it examined, and its status.
 */
export interface AcceptanceVerificationRecord {
  id: string;
  runId: string;
  instanceId: string;
  phaseId: string;
  attempt: number;
  step: string;
  status: AcceptanceVerificationStatus;
  receivedAt: string;
  updatedAt: string;
  /** The accepted proposal this run answers for. */
  proposalId: string;
  /** Every criterion of that proposal: the run must account for all of them. */
  required: AcceptanceCriterion[];
  /** The repository state Argus recorded for the run. */
  repository?: RepositoryStateRef;
  report?: AcceptanceVerificationReport;
  reason?: string;
  result?: { criteria: AcceptanceVerification[] };
}

/** The counts an acceptance-verification phase reports for routing, status and
 *  the board. */
export interface AcceptanceVerificationSummary {
  proposalId: string;
  /** Criteria the accepted proposal carries, i.e. the ones required. */
  required: number;
  satisfied: number;
  violated: number;
  unverifiable: number;
  requiresReview: boolean;
}

/** One criterion's proposed outcome, as the gate shows it. */
export interface AcceptanceVerificationPreviewEntry {
  /** `CP-12/AC-1`. */
  ref: string;
  criterionId: string;
  statement: string;
  kind: AcceptanceCriterionKind;
  /** The exact revisions the criterion is evidence for. */
  relatesTo: ClaimRef[];
  outcome: AcceptanceOutcome;
  evidence: VerificationEvidence[];
  reason?: string;
  note?: string;
}

/** The deterministic read model of one staged acceptance proposal. */
export interface AcceptanceVerificationPreview {
  recordId: string;
  runId: string;
  step: string;
  attempt: number;
  status: AcceptanceVerificationStatus;
  proposalId: string;
  repository?: RepositoryStateRef;
  satisfied: AcceptanceVerificationPreviewEntry[];
  violated: AcceptanceVerificationPreviewEntry[];
  unverifiable: AcceptanceVerificationPreviewEntry[];
  /** Required criteria with no submitted outcome. Empty on a staged record —
   *  completeness is enforced before staging — and populated only on a
   *  rejected one, where it is the reason. */
  missing: string[];
  summary?: string;
}

/**
 * "Is this accepted criterion satisfied?" — derived per read, never stored,
 * and never timeless.
 *
 * A `repository` scopes the question exactly as `gitHead` scopes
 * {@link RuleConformanceReport}: only verifications that examined that state
 * count, so a criterion satisfied at one dirty tree reads `unverified` at
 * another, and Argus never reports a past state's conclusion as a statement
 * about the current one.
 */
export interface AcceptanceConformanceReport {
  criterion: AcceptanceCriterionRef;
  repository?: RepositoryStateRef;
  status: AcceptanceConformanceStatus;
  latest?: AcceptanceVerification;
  /** Every verification of this exact criterion, oldest first. */
  history: AcceptanceVerification[];
}

// ── Change realization ──────────────────────────────────────────────────────

/**
 * How one attempt to realize an accepted change ended. Deliberately distinct
 * from a technical failure class: the remediation that follows depends on
 * *which dimension* failed.
 *
 * - `succeeded` — everything required held at the examined state.
 * - `technical-failure` — the implementation execution failed, or a mandatory
 *   deterministic check did. No semantic close-out happened; no rule or
 *   criterion result from this attempt is durable.
 * - `rule-violation` — the code compiled and the checks passed, and a targeted
 *   rule revision is `violated` (or was left `unverified`/`unverifiable`).
 * - `acceptance-violation` — every targeted rule holds and a required
 *   criterion is `violated`.
 * - `acceptance-unverifiable` — a required criterion could not be established
 *   either way. More code is not obviously the answer, so this stops the loop.
 * - `blocked` — the implementation agent reported it cannot safely implement
 *   the accepted intent with the information it has. Not a failure of the
 *   code; a statement that the intent needs a person.
 * - `stale-intent` — the semantic target moved while the attempt ran. The
 *   attempt's results stay historically true about the revisions they named;
 *   the realization may not be presented as current completion.
 * - `state-mismatch` — the repository state the verification examined is not
 *   the one the implementation produced. Fail-closed: Argus will not claim a
 *   verification proves an implementation it did not look at.
 */
export type ChangeAttemptOutcome =
  | "succeeded"
  | "technical-failure"
  | "rule-violation"
  | "acceptance-violation"
  | "acceptance-unverifiable"
  | "blocked"
  | "stale-intent"
  | "state-mismatch";

/**
 * The externally useful state of a realization.
 *
 * - `running` — an attempt is in flight.
 * - `succeeded` — every required dimension held, at one repository state, with
 *   the semantic target still current.
 * - `needs-remediation` — the implementation ran and accepted verification
 *   found unmet rules or criteria that another targeted attempt could fix, and
 *   attempts remain.
 * - `failed` — terminal without success: the attempt budget is exhausted, the
 *   implementation is blocked, a required criterion is unverifiable, or a
 *   technical failure ended it.
 * - `stale` — the accepted intent this realization targets was superseded.
 *   Remediation stops; a new change decision is required, not more code.
 */
export type ChangeRealizationStatus =
  "running" | "succeeded" | "needs-remediation" | "failed" | "stale";

/** One rule's outcome inside a realization attempt, as the durable record
 *  keeps it: the ref, what was concluded, and the {@link RuleVerification}
 *  that concluded it. The full record stays in `ledger.verifications`. */
export interface RealizationRuleResult {
  rule: ClaimRef;
  /** `unverified` when the verification phase produced no result for it. */
  outcome: RuleConformanceStatus;
  verificationId?: string;
}

/** One criterion's outcome inside a realization attempt. */
export interface RealizationAcceptanceResult {
  criterionId: string;
  outcome: AcceptanceConformanceStatus;
  verificationId?: string;
}

/** What Argus's own deterministic checks said about one attempt. Bound from
 *  the phases' own {@link VerificationReport}s, never from an agent's claim. */
export interface RealizationTechnicalResult {
  status: "passed" | "failed";
  /** Labels that passed and labels that failed, in report order. */
  passed: string[];
  failed: Array<{ label: string; detail?: string }>;
}

/**
 * One attempt to realize the accepted change: an implementation (or
 * remediation) execution, the deterministic checks over it, and the semantic
 * verification of what it produced.
 *
 * Append-only. A remediation never rewrites the attempt it is remediating —
 * that history is how anyone later explains how the implementation converged.
 */
export interface ChangeRealizationAttempt {
  /** 1-based. Attempt 1 is the implementation; 2..n are remediations. */
  attempt: number;
  kind: "implementation" | "remediation";
  /** The runs that did the work, with their instance and phase. */
  implementation: RunExecutionRef[];
  /** The runs that verified it. Empty when the attempt never got that far. */
  verification: RunExecutionRef[];
  /** The repository state the implementation produced, as Argus read it. */
  repository?: RepositoryStateRef;
  technical?: RealizationTechnicalResult;
  ruleResults: RealizationRuleResult[];
  acceptanceResults: RealizationAcceptanceResult[];
  outcome: ChangeAttemptOutcome;
  /** One sentence naming exactly what was unmet. */
  reason?: string;
  startedAt: string;
  endedAt?: string;
}

/** The terminal verdict of a realization, written exactly once and never
 *  rewritten. Its presence is what makes the realization no longer `running`. */
export interface ChangeRealizationOutcome {
  status: Exclude<ChangeRealizationStatus, "running">;
  /** The repository state the success is bound to. Required for `succeeded`
   *  when the working tree was a git repository. */
  repository?: RepositoryStateRef;
  /** One sentence: why it ended this way. */
  reason: string;
  /** The exact rules still unmet, for a terminal non-success. */
  unmetRules: RealizationRuleResult[];
  /** The exact criteria still unmet. */
  unmetCriteria: RealizationAcceptanceResult[];
  completedAt: string;
}

/**
 * The durable record of one attempt-chain to realize an accepted
 * {@link AcceptedChangeProposal} (ledger version 7).
 *
 * It answers, from the ledger alone and forever:
 *
 *   "Was CP-12 implemented, and verified how?"
 *   "Which implementation runs participated?"
 *   "Which repository state completed it?"
 *   "Which rule verifications and which acceptance verifications proved it?"
 *   "What remediation attempts happened, and what did each one fail on?"
 *
 * Mutable in exactly two controlled ways and in no other: `attempts` is
 * appended to, and `outcome` is written once. Everything else — identity, the
 * proposal it targets, the scope it was derived with — is frozen at creation.
 * A realization that already has an `outcome` refuses a second, different one
 * rather than rewriting what was concluded.
 */
export interface ChangeRealization {
  id: string;
  schemaVersion: 1;
  /** The accepted proposal this realization targets. Frozen: a realization is
   *  never retargeted at a newer proposal (§stale intent). */
  proposalId: string;
  /** The exact revisions the proposal introduced, as they were when this
   *  realization started — what "the semantic target" means for it. */
  target: ClaimRef[];
  instanceId: string;
  /** The implementation phase whose attempts this realization chains. */
  phaseId: string;
  /** The phase that verifies them. */
  verificationPhaseId?: string;
  /** Attempts allowed in total (1 = no remediation). */
  maxAttempts: number;
  /** The deterministic scope the implementation was launched against. */
  scope: ImplementationScope;
  attempts: ChangeRealizationAttempt[];
  /** Written once, at the terminal transition. Absent while `running`. */
  outcome?: ChangeRealizationOutcome;
  createdAt: string;
}

/** The realization's status, derived rather than stored twice. */
export interface ChangeRealizationView extends ChangeRealization {
  status: ChangeRealizationStatus;
  /** The attempt in flight, or the last one. */
  currentAttempt: number;
  /** Attempts still available after the current one. */
  attemptsRemaining: number;
}

/** `GET /api/knowledge/realizations`. Newest first. */
export interface ChangeRealizationsResponse {
  realizations: ChangeRealizationView[];
}

/** `GET /api/knowledge/realizations/:id/runs`. */
export interface ChangeRealizationRunsResponse {
  realizationId: string;
  implementation: RunExecutionRef[];
  verification: RunExecutionRef[];
}

/** `GET /api/knowledge/realizations/:id/results`: the durable semantic records
 *  this realization's attempts produced, unfiltered and in commit order. */
export interface ChangeRealizationResultsResponse {
  realizationId: string;
  proposalId: string;
  rules: RuleVerification[];
  acceptance: AcceptanceVerification[];
}

// ── Remediation ─────────────────────────────────────────────────────────────

/** One rule a remediation must fix, with everything the agent needs to fix it
 *  and nothing it would have to infer from a transcript. */
export interface RemediationFailedRule {
  rule: ClaimRef;
  ref: string;
  statement?: string;
  outcome: RuleConformanceStatus;
  /** The verifier's own words, when it gave any. */
  reason?: string;
  note?: string;
  /** The evidence the verifier cited — where it looked, which check failed. */
  evidence: VerificationEvidence[];
}

/** One criterion a remediation must satisfy. */
export interface RemediationFailedCriterion {
  criterionId: string;
  ref: string;
  statement: string;
  kind: AcceptanceCriterionKind;
  relatesTo: ClaimRef[];
  outcome: AcceptanceConformanceStatus;
  reason?: string;
  note?: string;
  evidence: VerificationEvidence[];
  verificationHint?: string;
}

/**
 * The versioned wire format of a remediation's input — the document at
 * `ARGUS_REMEDIATION_CONTEXT_FILE`.
 *
 * Written by Argus from its own accepted verification results, so the
 * remediation agent is told exactly what is unmet rather than having to read
 * the previous agent's transcript and guess. Present only on a remediation
 * attempt; attempt 1 has no failures to describe.
 */
export interface RemediationContext {
  schemaVersion: 1;
  generatedAt: string;
  realizationId: string;
  proposalId: string;
  /** Which attempt this document is for (2..n). */
  attempt: number;
  /** What the previous attempt failed on, as a class. */
  previousOutcome: ChangeAttemptOutcome;
  failedRules: RemediationFailedRule[];
  failedCriteria: RemediationFailedCriterion[];
  /** Deterministic checks Argus observed failing. */
  technicalFailures: Array<{ label: string; detail?: string }>;
  /** The scope entries the failures point at — the files the previous attempt
   *  produced or the evidence the failures cited — so remediation is targeted
   *  rather than a fresh start. */
  affectedTargets: ImplementationTarget[];
  /** Rules and criteria that already hold, named so a remediation does not
   *  undo them. References only. */
  satisfied: { rules: string[]; criteria: string[] };
}

// ── Phase policies ──────────────────────────────────────────────────────────

/**
 * Turns a phase into the **implementation half of a change realization**
 * (Phase 8).
 *
 * The phase must also declare a `changeContext`: the accepted proposal it
 * realizes is the one that selector resolves, never a second selection
 * mechanism. What this policy adds is the durable {@link ChangeRealization},
 * the deterministic {@link ImplementationScope} the run receives, and the
 * bound on how many times the loop may come back.
 *
 * Absent = an ordinary phase, behaving in every respect exactly as before
 * Phase 8 existed — including a phase that declares `changeContext` alone,
 * which is Phase 7's implementation handoff and stays exactly as it was.
 */
export interface ImplementationPolicy {
  /**
   * Total implementation attempts, including the first. `1` means no
   * autonomous remediation at all; the default is `2` (one implementation,
   * one targeted remediation). Capped, because an unbounded
   * implement → verify → implement loop is the failure mode this bound
   * exists to prevent.
   */
  maxAttempts?: number;
  /**
   * Refuse to launch when the accepted proposal's semantic target is no longer
   * the active revision (§preflight). Default `true`: an implementation of
   * intent the domain has already moved past is work nobody wants.
   */
  requireCurrentIntent?: boolean;
  /** Include the source evidence of **preserved** revisions in the scope, as
   *  regression surface. Default `true`. */
  includePreserved?: boolean;
  /** One sentence narrowing what this phase should do. Author-written. */
  note?: string;
}

/**
 * Turns a phase into the **verification half of a change realization**
 * (Phase 8): it decides whether the accepted proposal's acceptance criteria
 * are satisfied by the implementation it can see.
 *
 * Ordinarily declared together with `ruleVerification` — the two dimensions
 * are independent and both are required for completion — and with a
 * `changeContext` naming the same change-intent phase, which is where the
 * criteria come from.
 */
export interface AcceptanceVerificationPolicy {
  /**
   * The implementation phase of the realization this verifies. It must be a
   * dependency of this phase and must declare `implementation`. This is the
   * link that makes "which implementation state am I verifying?" answerable.
   */
  implementationPhase: string;
  /**
   * What the realization requires of each criterion. `all` (the default)
   * requires every criterion of the accepted proposal to be `satisfied`;
   * `behavioral` requires it of `behavior`, `invariant` and `verification`
   * criteria and accepts `unverifiable` for `regression` ones. Nothing
   * downgrades a `violated`.
   */
  require?: "all" | "behavioral";
  /** One sentence narrowing what "satisfied" means here. */
  note?: string;
}

/** A staged acceptance proposal as the instance record sees it. */
export interface StepAcceptanceVerification {
  id: string;
  status: AcceptanceVerificationStatus;
}
