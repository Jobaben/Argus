import type {
  AppliedKnowledgeDelta,
  ArtifactProduction,
  ArtifactRef,
  Claim,
  ClaimConsumption,
  ClaimKind,
  ClaimLifecycle,
  ClaimRef,
  ClaimSupport,
  ClaimView,
  ConsumedClaimStatus,
  ConsumptionSource,
  ConsumersReport,
  DependentsReport,
  Evidence,
  EvidenceSource,
  ExecutionProvenance,
  ExecutionRef,
  Justification,
  JustificationForce,
  JustificationStatus,
  RunExecutionRef,
  SuppliedContext,
  SuppliedToReport,
  SupportDirection,
  SupportReport,
} from "@argus/contracts";

/**
 * The Knowledge Ledger's semantic kernel: pure functions over an immutable
 * ledger snapshot.
 *
 * This is the same shape as `pipelineTransitions.ts` is to the engine. Every
 * transition takes a ledger and returns a *new* ledger (plus the record it
 * added); every query is a function of the ledger alone. Nothing here touches
 * a filesystem, a clock or a random source — ids and timestamps arrive as
 * arguments — so the whole semantics can be tested with hand-built ledgers and
 * the shell in `store.ts` has nothing to decide.
 *
 * What the kernel enforces, and where:
 *
 * - **Identity.** A claim id is a logical identity; `(id, revision)` is a
 *   revision identity. Revisions of one id are 1..n with no gaps; the highest
 *   is active. `reviseClaim` is the only way to get a revision > 1.
 * - **Immutability.** A record, once in the ledger, is never changed or
 *   removed. There is no `updateClaim`, and lifecycle is derived rather than
 *   written, so nothing can rewrite what a past execution referenced.
 * - **Referential integrity.** Evidence and justifications may only name
 *   revisions that exist at the time they are added.
 * - **Acyclicity.** A justification whose premises transitively depend on its
 *   own conclusion is rejected. Support evaluation is recursive over premises,
 *   and rejecting cycles up front keeps the recursion — and the meaning of
 *   "supported" — simple. Evaluation is nevertheless cycle-safe (a hand-edited
 *   file cannot hang the server); a cyclic premise is treated as unsupported.
 * - **Support is derived.** {@link evaluateSupport} is the only definition of
 *   `supported | unsupported | contested`, and it is a total, deterministic
 *   function of the ledger. No record carries a truth value.
 * - **Provenance edges are exact and immutable.** A consumption names one
 *   revision and one run; an artifact production names one run and one path.
 *   Neither is ever retargeted, and recording an identical edge twice is a
 *   no-op — the ledger holds each fact once.
 */

/**
 * The authoritative ledger document. `version` guards the on-disk shape.
 *
 * Version 2 (Phase 2) added `consumptions` and `artifacts` — the explicit
 * bridges from the semantic graph back into execution history. Version 3
 * (Phase 3) added `deltas` — the ledger's own record of every KnowledgeDelta
 * it applied, so the provenance chain "canonical record ← delta ← run" is
 * answerable from this document alone and a commit is idempotent on delta id.
 * Version 4 (Phase 4.1) added `supplied` — the durable half of the
 * KnowledgeContext protocol, so "which exact revisions did run_456 receive?"
 * outlives the invocation record that is pruned with the run.
 * Older files are upgraded on read by `store.ts` (the new arrays start empty);
 * the kernel only ever sees version 4.
 */
export interface KnowledgeLedger {
  version: 4;
  /** Every claim revision, in the order it was added. */
  claims: Claim[];
  evidence: Evidence[];
  justifications: Justification[];
  /** Execution → exact claim revision it relied on, in recording order. */
  consumptions: ClaimConsumption[];
  /** Execution → artifact it produced, in recording order. */
  artifacts: ArtifactProduction[];
  /** Every KnowledgeDelta applied, in commit order. See `delta.ts`. */
  deltas: AppliedKnowledgeDelta[];
  /** Execution → the exact context Argus supplied it, in launch order. One
   *  record per run. See {@link recordSuppliedContext}. */
  supplied: SuppliedContext[];
}

export const LEDGER_VERSION = 4 as const;

export function emptyLedger(): KnowledgeLedger {
  return {
    version: LEDGER_VERSION,
    claims: [],
    evidence: [],
    justifications: [],
    consumptions: [],
    artifacts: [],
    deltas: [],
    supplied: [],
  };
}

/** An input or transition the ledger refuses: bad shape, an unknown reference,
 *  a duplicate id, a cycle. Maps to 400. */
export class KnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeValidationError";
  }
}

/** A lookup of a claim (or revision) that does not exist. Maps to 404. */
export class UnknownClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownClaimError";
  }
}

export const CLAIM_KINDS: readonly ClaimKind[] = [
  "fact",
  "assumption",
  "business-rule",
  "constraint",
  "conclusion",
  "decision",
];

/** Same alphabet as phase ids: URL-safe, no `:` (the revision separator).
 *  Evidence and justification ids share it. */
export const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** The shape of an Argus execution identifier (a run, instance or phase id):
 *  UUIDs, `run-7`-style test ids and phase ids all fit. Same alphabet as the
 *  `producedBy` validator accepts. */
export const EXECUTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Bounds on an {@link ArtifactRef.path}. */
export const ARTIFACT_PATH_MAX_CHARS = 1024;
const SHA_RE = /^[0-9a-f]{7,64}$/;

// ── Refs ────────────────────────────────────────────────────────────────────

/** `RULE-17:v2`. The only string form the ledger ever emits for a revision. */
export function formatClaimRef(ref: ClaimRef): string {
  return `${ref.id}:v${ref.revision}`;
}

/** A URL key: a bare id (meaning "the active revision") or a `:vN` ref. */
export interface ClaimKey {
  id: string;
  revision?: number;
}

/**
 * Parse `RULE-17` or `RULE-17:v2`. Null for anything else, including `:v0`
 * and a malformed id — the caller answers 404, since a key that cannot name a
 * claim cannot find one.
 */
export function parseClaimKey(key: string): ClaimKey | null {
  const m = /^([^:]+)(?::v([1-9][0-9]{0,8}))?$/.exec(key);
  if (!m || !CLAIM_ID_RE.test(m[1])) return null;
  return m[2] === undefined ? { id: m[1] } : { id: m[1], revision: Number(m[2]) };
}

export function sameRef(a: ClaimRef, b: ClaimRef): boolean {
  return a.id === b.id && a.revision === b.revision;
}

export function refOf(claim: Claim): ClaimRef {
  return { id: claim.id, revision: claim.revision };
}

// ── Lookups ─────────────────────────────────────────────────────────────────

/** Every revision of an id, oldest first. */
export function revisionsOf(ledger: KnowledgeLedger, id: string): Claim[] {
  return ledger.claims.filter((c) => c.id === id).sort((a, b) => a.revision - b.revision);
}

/** The highest revision of an id, or null when the id is unknown. */
export function activeRevision(ledger: KnowledgeLedger, id: string): Claim | null {
  let best: Claim | null = null;
  for (const c of ledger.claims) {
    if (c.id === id && (!best || c.revision > best.revision)) best = c;
  }
  return best;
}

export function getClaim(ledger: KnowledgeLedger, ref: ClaimRef): Claim | null {
  return ledger.claims.find((c) => sameRef(c, ref)) ?? null;
}

/** Resolve a URL key: a bare id to its active revision, a ref to itself. */
export function resolveKey(ledger: KnowledgeLedger, key: ClaimKey): Claim | null {
  return key.revision === undefined
    ? activeRevision(ledger, key.id)
    : getClaim(ledger, { id: key.id, revision: key.revision });
}

function requireClaim(ledger: KnowledgeLedger, ref: ClaimRef): Claim {
  const claim = getClaim(ledger, ref);
  if (!claim) throw new UnknownClaimError(`unknown claim revision ${formatClaimRef(ref)}`);
  return claim;
}

/** Active when no higher revision of the id exists. Derived, never stored. */
export function lifecycleOf(ledger: KnowledgeLedger, ref: ClaimRef): ClaimLifecycle {
  const active = activeRevision(ledger, ref.id);
  return active && active.revision > ref.revision ? "superseded" : "active";
}

/** The revision that replaced this one, or undefined while it is active. */
export function supersededBy(ledger: KnowledgeLedger, ref: ClaimRef): ClaimRef | undefined {
  const next = getClaim(ledger, { id: ref.id, revision: ref.revision + 1 });
  return next ? refOf(next) : undefined;
}

/** A claim with its derived lifecycle and support, for every read surface. */
export function viewOf(ledger: KnowledgeLedger, claim: Claim): ClaimView {
  const ref = refOf(claim);
  const next = supersededBy(ledger, ref);
  return {
    ...claim,
    lifecycle: lifecycleOf(ledger, ref),
    ...(next ? { supersededBy: next } : {}),
    support: evaluateSupport(ledger, ref),
  };
}

// ── Transitions ─────────────────────────────────────────────────────────────

export interface AddClaimInput {
  /** Caller-proposed or Argus-minted; either way validated and unique. */
  id: string;
  kind: ClaimKind;
  statement: string;
  structuredValue?: unknown;
  producedBy?: ExecutionRef;
}

export interface ReviseClaimInput {
  id: string;
  statement: string;
  structuredValue?: unknown;
  producedBy?: ExecutionRef;
  revisionNote?: string;
}

export interface AddEvidenceInput {
  id: string;
  claim: ClaimRef;
  direction: SupportDirection;
  source: EvidenceSource;
  note?: string;
}

export interface AddJustificationInput {
  id: string;
  conclusion: ClaimRef;
  premises: ClaimRef[];
  direction: SupportDirection;
  producedBy?: ExecutionRef;
  note?: string;
}

function requireRecordId(id: string, what: string): void {
  if (!CLAIM_ID_RE.test(id)) throw new KnowledgeValidationError(`${what} id "${id}" is invalid`);
}

/** Drop undefined optionals so the persisted record has no `"x": undefined` noise
 *  and two equivalent records serialize identically. */
function compact<T extends object>(rec: T): T {
  return Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined)) as T;
}

/** Create revision 1 of a new claim id. */
export function addClaim(
  ledger: KnowledgeLedger,
  input: AddClaimInput,
  now: string,
): { ledger: KnowledgeLedger; claim: Claim } {
  if (!CLAIM_ID_RE.test(input.id)) {
    throw new KnowledgeValidationError(`claim id "${input.id}" is invalid`);
  }
  if (!CLAIM_KINDS.includes(input.kind)) {
    throw new KnowledgeValidationError(`claim kind "${String(input.kind)}" is invalid`);
  }
  if (activeRevision(ledger, input.id)) {
    throw new KnowledgeValidationError(
      `claim "${input.id}" already exists; revise it rather than adding it again`,
    );
  }
  const claim: Claim = compact({
    id: input.id,
    revision: 1,
    kind: input.kind,
    statement: input.statement,
    structuredValue: input.structuredValue,
    producedBy: input.producedBy,
    createdAt: now,
  });
  return { ledger: { ...ledger, claims: [...ledger.claims, claim] }, claim };
}

/**
 * Supersede the active revision of a claim with a new one.
 *
 * The old revision stays in the ledger untouched. Kind is part of the logical
 * identity and cannot change — a rule that becomes a fact is a different
 * claim. Nothing that referenced the old revision is retargeted: a
 * justification built on `RULE-17:v1` remains a justification built on
 * `RULE-17:v1`, and {@link evaluateSupport} will report it as no longer in
 * force because its premise is superseded.
 */
export function reviseClaim(
  ledger: KnowledgeLedger,
  input: ReviseClaimInput,
  now: string,
): { ledger: KnowledgeLedger; claim: Claim } {
  const current = activeRevision(ledger, input.id);
  if (!current) throw new UnknownClaimError(`unknown claim "${input.id}"`);
  const claim: Claim = compact({
    id: current.id,
    revision: current.revision + 1,
    kind: current.kind,
    statement: input.statement,
    structuredValue: input.structuredValue,
    producedBy: input.producedBy,
    revisionNote: input.revisionNote,
    createdAt: now,
  });
  return { ledger: { ...ledger, claims: [...ledger.claims, claim] }, claim };
}

/** Attach evidence to an existing claim revision — active or superseded; a
 *  historical revision can still acquire provenance. */
export function addEvidence(
  ledger: KnowledgeLedger,
  input: AddEvidenceInput,
  now: string,
): { ledger: KnowledgeLedger; evidence: Evidence } {
  requireRecordId(input.id, "evidence");
  if (ledger.evidence.some((e) => e.id === input.id)) {
    throw new KnowledgeValidationError(`evidence "${input.id}" already exists`);
  }
  if (!getClaim(ledger, input.claim)) {
    throw new KnowledgeValidationError(
      `evidence names unknown claim revision ${formatClaimRef(input.claim)}`,
    );
  }
  const evidence: Evidence = compact({
    id: input.id,
    claim: { id: input.claim.id, revision: input.claim.revision },
    direction: input.direction,
    source: input.source,
    note: input.note,
    createdAt: now,
  });
  return { ledger: { ...ledger, evidence: [...ledger.evidence, evidence] }, evidence };
}

/**
 * Record a derivation. Rejected when: any ref is unknown, the premise list is
 * empty or repeats a revision, the conclusion is among the premises, or the
 * conclusion already (transitively) supports one of the premises — the last
 * two being the cycle rule.
 */
export function addJustification(
  ledger: KnowledgeLedger,
  input: AddJustificationInput,
  now: string,
): { ledger: KnowledgeLedger; justification: Justification } {
  requireRecordId(input.id, "justification");
  if (ledger.justifications.some((j) => j.id === input.id)) {
    throw new KnowledgeValidationError(`justification "${input.id}" already exists`);
  }
  if (!getClaim(ledger, input.conclusion)) {
    throw new KnowledgeValidationError(
      `justification names unknown conclusion ${formatClaimRef(input.conclusion)}`,
    );
  }
  if (input.premises.length === 0) {
    throw new KnowledgeValidationError("justification needs at least one premise");
  }
  const seen = new Set<string>();
  for (const p of input.premises) {
    const key = formatClaimRef(p);
    if (seen.has(key)) throw new KnowledgeValidationError(`premise ${key} is listed twice`);
    seen.add(key);
    if (!getClaim(ledger, p)) {
      throw new KnowledgeValidationError(`justification names unknown premise ${key}`);
    }
    if (sameRef(p, input.conclusion)) {
      throw new KnowledgeValidationError(`claim ${key} cannot justify itself`);
    }
  }
  // A new edge premise → conclusion closes a cycle exactly when the conclusion
  // already reaches that premise.
  const downstream = new Set(
    transitiveDependentsOf(ledger, input.conclusion).map((r) => formatClaimRef(r)),
  );
  for (const p of input.premises) {
    const key = formatClaimRef(p);
    if (downstream.has(key)) {
      throw new KnowledgeValidationError(
        `justification would form a cycle: ${key} already depends on ${formatClaimRef(input.conclusion)}`,
      );
    }
  }
  const justification: Justification = compact({
    id: input.id,
    conclusion: { id: input.conclusion.id, revision: input.conclusion.revision },
    premises: input.premises.map((p) => ({ id: p.id, revision: p.revision })),
    direction: input.direction,
    producedBy: input.producedBy,
    note: input.note,
    createdAt: now,
  });
  return {
    ledger: { ...ledger, justifications: [...ledger.justifications, justification] },
    justification,
  };
}

// ── Execution provenance ────────────────────────────────────────────────────

export function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  return a.location === b.location && a.path === b.path;
}

/** Every provenance record naming a run — consumptions, then artifact
 *  productions, then applied deltas — each in ledger order. */
function executionRecordsOf(ledger: KnowledgeLedger, runId: string): RunExecutionRef[] {
  return [
    ...ledger.consumptions.filter((c) => c.execution.runId === runId).map((c) => c.execution),
    ...ledger.artifacts.filter((a) => a.execution.runId === runId).map((a) => a.execution),
    ...ledger.deltas.filter((d) => d.execution.runId === runId).map((d) => d.execution),
    ...ledger.supplied.filter((s) => s.execution.runId === runId).map((s) => s.execution),
  ];
}

/**
 * Validate an execution reference and reconcile its locators with what the
 * ledger already holds for the run. A run belongs to exactly one instance and
 * phase, so a locator that contradicts an earlier record is refused; a locator
 * omitted here is filled from the earlier record so every edge of a run reads
 * the same. Run *existence* is deliberately not checked: run files are a
 * pruned, rebuildable record (`runs/` → the Vault), and refusing a reference
 * to a run whose JSON has aged out would make historical provenance
 * unrecordable. Shape is what can be validated, so shape is what is.
 */
function resolveExecution(ledger: KnowledgeLedger, input: RunExecutionRef): RunExecutionRef {
  if (typeof input.runId !== "string" || !EXECUTION_ID_RE.test(input.runId)) {
    throw new KnowledgeValidationError(`run id "${String(input.runId)}" is invalid`);
  }
  for (const [field, value] of [
    ["instanceId", input.instanceId],
    ["phaseId", input.phaseId],
  ] as const) {
    if (value !== undefined && !EXECUTION_ID_RE.test(value)) {
      throw new KnowledgeValidationError(`execution.${field} "${value}" is invalid`);
    }
  }
  const out: RunExecutionRef = compact({
    runId: input.runId,
    instanceId: input.instanceId,
    phaseId: input.phaseId,
  });
  for (const known of executionRecordsOf(ledger, input.runId)) {
    for (const field of ["instanceId", "phaseId"] as const) {
      const have = known[field];
      if (have === undefined) continue;
      if (out[field] === undefined) out[field] = have;
      else if (out[field] !== have) {
        throw new KnowledgeValidationError(
          `run ${input.runId} is already recorded with ${field} "${have}", not "${out[field]}"`,
        );
      }
    }
  }
  return out;
}

export interface RecordConsumptionInput {
  execution: RunExecutionRef;
  claim: ClaimRef;
  /** Whether Argus supplied the revision to the run (Phase 4). Absent when
   *  the caller has no invocation record to answer from. */
  source?: ConsumptionSource;
}

/**
 * Record that an execution consumed an exact claim revision. The revision must
 * exist; it may be superseded (a run that relied on `RULE-17:v1` did so
 * whether or not v2 exists yet). An identical edge already present makes this
 * a no-op — `added: false` and the same ledger back — so registering twice is
 * safe and deterministic. Consumption is semantic provenance, not execution
 * order: nothing here consults, or is consulted by, the DAG.
 */
export function recordConsumption(
  ledger: KnowledgeLedger,
  input: RecordConsumptionInput,
  now: string,
): { ledger: KnowledgeLedger; consumption: ClaimConsumption; added: boolean } {
  const execution = resolveExecution(ledger, input.execution);
  if (!getClaim(ledger, input.claim)) {
    throw new KnowledgeValidationError(
      `consumption names unknown claim revision ${formatClaimRef(input.claim)}`,
    );
  }
  const existing = ledger.consumptions.find(
    (c) => c.execution.runId === execution.runId && sameRef(c.claim, input.claim),
  );
  if (existing) return { ledger, consumption: existing, added: false };
  const consumption: ClaimConsumption = {
    claim: { id: input.claim.id, revision: input.claim.revision },
    execution,
    createdAt: now,
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
  return {
    ledger: { ...ledger, consumptions: [...ledger.consumptions, consumption] },
    consumption,
    added: true,
  };
}

export interface RecordArtifactInput {
  execution: RunExecutionRef;
  artifact: ArtifactRef;
}

/** A relative POSIX path that stays inside its root: no drive, no leading
 *  slash, no `..` segment, no NUL, no backslash. Mirrors the containment rule
 *  the artifact viewer applies, so a path recorded here is one it could list. */
export function validArtifactPath(path: string): boolean {
  if (!path || path.length > ARTIFACT_PATH_MAX_CHARS) return false;
  if (path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Record that an execution produced an artifact. Identity is
 * `(runId, location, path)`; an identical record is a no-op, and a differing
 * `gitHead` for the same path is refused rather than silently kept twice — a
 * run has one working tree.
 */
export function recordArtifact(
  ledger: KnowledgeLedger,
  input: RecordArtifactInput,
  now: string,
): { ledger: KnowledgeLedger; production: ArtifactProduction; added: boolean } {
  const execution = resolveExecution(ledger, input.execution);
  const { artifact } = input;
  if (artifact.location !== "artifact-dir" && artifact.location !== "repository") {
    throw new KnowledgeValidationError(`artifact.location must be artifact-dir | repository`);
  }
  if (typeof artifact.path !== "string" || !validArtifactPath(artifact.path)) {
    throw new KnowledgeValidationError(
      `artifact.path "${String(artifact.path)}" must be a relative POSIX path inside its root`,
    );
  }
  if (artifact.gitHead !== undefined) {
    if (artifact.location !== "repository") {
      throw new KnowledgeValidationError("artifact.gitHead only applies to a repository path");
    }
    if (!SHA_RE.test(artifact.gitHead)) {
      throw new KnowledgeValidationError("artifact.gitHead must be a hex commit sha");
    }
  }
  const existing = ledger.artifacts.find(
    (a) => a.execution.runId === execution.runId && sameArtifact(a.artifact, artifact),
  );
  if (existing) {
    if (existing.artifact.gitHead !== artifact.gitHead) {
      throw new KnowledgeValidationError(
        `run ${execution.runId} already produced ${artifact.path} at ${existing.artifact.gitHead ?? "an unpinned head"}`,
      );
    }
    return { ledger, production: existing, added: false };
  }
  const production: ArtifactProduction = {
    execution,
    artifact: compact({
      location: artifact.location,
      path: artifact.path,
      gitHead: artifact.gitHead,
    }),
    createdAt: now,
  };
  return {
    ledger: { ...ledger, artifacts: [...ledger.artifacts, production] },
    production,
    added: true,
  };
}

// ── Durable supplied provenance (Phase 4.1) ─────────────────────────────────

export interface RecordSuppliedContextInput {
  execution: RunExecutionRef;
  /** The phase attempt the invocation belonged to, when known. */
  attempt?: number;
  /**
   * The exact revisions supplied, in context-file order.
   *
   * May be **empty**: since Phase 5 a spec can select "whatever the discovery
   * phase committed", and an accepted phase is allowed to have committed
   * nothing. The run still received a context file, so the record still
   * exists — and it says, durably, that the file it was given held no
   * revisions. That is a different fact from a run launched with no semantic
   * context at all, which gets no record.
   */
  claims: ClaimRef[];
  /** SHA-256 (hex) of the materialized context file's bytes. */
  sha256: string;
  schemaVersion?: 1;
}

/**
 * Record what Argus supplied to one execution — the durable counterpart of
 * the invocation record's `knowledgeContext`.
 *
 * **Identity is the run.** A run receives one context, materialized once,
 * before the process exists. Registering the *identical* record again (a
 * retried preparation, a restart re-observing the run) returns the existing
 * one with `added: false`; registering a different claim list or a different
 * hash for the same run is **refused**, never merged and never overwritten —
 * conflicting accounts of what a past execution was given are a bug, and
 * silently keeping the last one would erase the history this record exists to
 * hold.
 *
 * **Supplied is not consumed.** Nothing here touches `consumptions`, and
 * impact analysis never reads this list. A supplied revision becomes a
 * dependency only when the agent declares it consumed.
 *
 * Unlike a consumption, a supplied ref is **not** required to still resolve
 * in the ledger at write time beyond well-formedness: it was in the document
 * the agent received, which is a fact about the past. In practice every ref
 * came from the same ledger a moment earlier, so this only matters for a
 * hand-edited file.
 */
export function recordSuppliedContext(
  ledger: KnowledgeLedger,
  input: RecordSuppliedContextInput,
  now: string,
): { ledger: KnowledgeLedger; supplied: SuppliedContext; added: boolean } {
  const execution = resolveExecution(ledger, input.execution);
  if (!Array.isArray(input.claims)) {
    throw new KnowledgeValidationError("supplied context claims must be a list");
  }
  const claims = input.claims.map((c) => {
    if (
      typeof c?.id !== "string" ||
      !CLAIM_ID_RE.test(c.id) ||
      !Number.isInteger(c.revision) ||
      c.revision < 1
    ) {
      throw new KnowledgeValidationError(
        `supplied context names malformed claim reference ${JSON.stringify(c)}`,
      );
    }
    return { id: c.id, revision: c.revision };
  });
  const seen = new Set<string>();
  for (const c of claims) {
    const key = formatClaimRef(c);
    if (seen.has(key)) {
      throw new KnowledgeValidationError(`supplied context lists ${key} twice`);
    }
    seen.add(key);
  }
  if (typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new KnowledgeValidationError("supplied context sha256 must be 64 hex characters");
  }
  if (input.attempt !== undefined && (!Number.isInteger(input.attempt) || input.attempt < 0)) {
    throw new KnowledgeValidationError("supplied context attempt must be a non-negative integer");
  }
  const existing = ledger.supplied.find((s) => s.execution.runId === execution.runId);
  if (existing) {
    const same =
      existing.sha256 === input.sha256 &&
      existing.claims.length === claims.length &&
      existing.claims.every((c, i) => sameRef(c, claims[i]));
    if (!same) {
      throw new KnowledgeValidationError(
        `run ${execution.runId} is already recorded as supplied ` +
          `${existing.claims.map(formatClaimRef).join(", ")} (sha256 ${existing.sha256}); ` +
          `refusing to replace it with ${claims.map(formatClaimRef).join(", ")} (sha256 ${input.sha256})`,
      );
    }
    return { ledger, supplied: existing, added: false };
  }
  const supplied: SuppliedContext = compact({
    execution,
    attempt: input.attempt,
    schemaVersion: (input.schemaVersion ?? 1) as 1,
    claims,
    sha256: input.sha256,
    suppliedAt: now,
  });
  return {
    ledger: { ...ledger, supplied: [...ledger.supplied, supplied] },
    supplied,
    added: true,
  };
}

/** What Argus supplied to one run, or null when it supplied nothing (or the
 *  run predates Phase 4.1). */
export function suppliedContextOf(ledger: KnowledgeLedger, runId: string): SuppliedContext | null {
  return ledger.supplied.find((s) => s.execution.runId === runId) ?? null;
}

/**
 * "Which executions were supplied this exact revision?" — the durable reverse
 * query. A different revision of the same id is not a match, and a run whose
 * invocation directory has been pruned is still listed: this reads the ledger,
 * never the filesystem. Oldest launch first, ties broken by run id.
 */
export function suppliedToReport(ledger: KnowledgeLedger, ref: ClaimRef): SuppliedToReport {
  const executions = ledger.supplied
    .filter((s) => s.claims.some((c) => sameRef(c, ref)))
    .map((s) =>
      compact({
        execution: s.execution,
        suppliedAt: s.suppliedAt,
        sha256: s.sha256,
        attempt: s.attempt,
      }),
    )
    .sort(
      (a, b) =>
        a.suppliedAt.localeCompare(b.suppliedAt) ||
        a.execution.runId.localeCompare(b.execution.runId),
    );
  return { claim: { id: ref.id, revision: ref.revision }, executions };
}

/**
 * "Which canonical claim revisions did this phase of this instance commit?"
 * — the Phase 5 handoff from an accepted phase to a later phase's
 * KnowledgeContext.
 *
 * Answered from the ledger's **applied delta provenance** and nothing else.
 * Three properties follow, and all three are the point:
 *
 * - **A staged proposal cannot appear here.** `ledger.deltas` holds applied
 *   deltas only. A discovery phase waiting at a gate has committed nothing,
 *   so a downstream selector resolves to nothing — candidate knowledge can
 *   never leak downstream, by construction rather than by a check somebody
 *   has to remember to write.
 * - **It is exact.** The refs are the ones the commit minted, not claims that
 *   happen to name the phase in `producedBy` and not claims that look recent.
 *   A superseded attempt's records are not in `deltas` at all.
 * - **It is historically stable.** A later revision of one of these claims
 *   creates a *new* record; it does not retarget this one. Asking the same
 *   question tomorrow gives the same answer.
 *
 * In commit order, then delta order, each revision once.
 */
export function claimsProducedByPhase(
  ledger: KnowledgeLedger,
  instanceId: string,
  phaseId: string,
): ClaimRef[] {
  const out: ClaimRef[] = [];
  for (const d of ledger.deltas) {
    if (d.execution.instanceId !== instanceId || d.execution.phaseId !== phaseId) continue;
    for (const c of d.claims) {
      if (!out.some((x) => sameRef(x, c))) out.push({ id: c.id, revision: c.revision });
    }
  }
  return out;
}

// ── Support ─────────────────────────────────────────────────────────────────

/** Justifications whose conclusion is this revision, in ledger order. */
export function premisesOf(ledger: KnowledgeLedger, ref: ClaimRef): Justification[] {
  return ledger.justifications.filter((j) => sameRef(j.conclusion, ref));
}

/** Evidence attached to this revision, in ledger order. */
export function evidenceOf(ledger: KnowledgeLedger, ref: ClaimRef): Evidence[] {
  return ledger.evidence.filter((e) => sameRef(e.claim, ref));
}

/**
 * One evaluation pass: a memo, a cycle guard, and — for impact analysis — at
 * most one *assumption*. An assumed revision is treated as active and
 * `supported` regardless of the ledger, which is how `analyzeImpact` asks "what
 * would hold if this revision were still current?" without building a second
 * ledger. Nothing outside `impact.ts` sets it.
 */
export interface Evaluation {
  memo: Map<string, ClaimSupport>;
  /** Revisions on the current recursion path — only ever non-empty on a
   *  hand-edited ledger, since `addJustification` rejects cycles. */
  visiting: Set<string>;
  /** `formatClaimRef` of the revision held as active and supported, if any. */
  assume?: string;
}

export function newEvaluation(assume?: ClaimRef): Evaluation {
  return {
    memo: new Map(),
    visiting: new Set(),
    ...(assume ? { assume: formatClaimRef(assume) } : {}),
  };
}

/**
 * Whether a justification currently lends force to its conclusion.
 *
 * In force iff **every** premise is (a) present, (b) the active revision of
 * its id and (c) itself `supported`. A superseded premise never transmits
 * support, which is the whole reason revising a rule matters downstream; a
 * contested premise does not either — a derivation from disputed ground is not
 * a derivation Argus will vouch for.
 */
export function forceOf(
  ledger: KnowledgeLedger,
  j: Justification,
  ev: Evaluation,
): JustificationForce {
  const failing: Extract<JustificationForce, { inForce: false }>["failing"] = [];
  for (const premise of j.premises) {
    if (ev.assume !== undefined && formatClaimRef(premise) === ev.assume) continue;
    if (!getClaim(ledger, premise)) {
      failing.push({ premise, reason: "missing" });
      continue;
    }
    if (lifecycleOf(ledger, premise) === "superseded") {
      failing.push({ premise, reason: "superseded" });
      continue;
    }
    const support = evaluate(ledger, premise, ev);
    if (support !== "supported") failing.push({ premise, reason: support });
  }
  return failing.length === 0 ? { inForce: true } : { inForce: false, failing };
}

/** {@link evaluateSupport} within an existing pass, so one memo serves many
 *  claims. The reference is not checked for existence; an unknown revision
 *  evaluates to `unsupported`, as a missing premise would. */
export function evaluate(ledger: KnowledgeLedger, ref: ClaimRef, ev: Evaluation): ClaimSupport {
  const key = formatClaimRef(ref);
  if (ev.assume === key) return "supported";
  const hit = ev.memo.get(key);
  if (hit) return hit;
  // Cycle guard: a revision reached again while it is being evaluated cannot
  // support itself. Unreachable through the API (cycles are rejected), kept so
  // a corrupted file degrades to "unsupported" rather than a stack overflow.
  if (ev.visiting.has(key)) return "unsupported";
  ev.visiting.add(key);

  let positive = false;
  let negative = false;
  for (const e of evidenceOf(ledger, ref)) {
    if (e.direction === "supports") positive = true;
    else negative = true;
  }
  for (const j of premisesOf(ledger, ref)) {
    if (!forceOf(ledger, j, ev).inForce) continue;
    if (j.direction === "supports") positive = true;
    else negative = true;
  }
  const support: ClaimSupport =
    positive && negative ? "contested" : positive ? "supported" : "unsupported";

  ev.visiting.delete(key);
  ev.memo.set(key, support);
  return support;
}

/**
 * The deterministic support state of a claim revision.
 *
 * Positive signals: supporting evidence on the revision, or a supporting
 * justification in force. Negative signals: opposing evidence, or an opposing
 * justification in force. Both → `contested`; positive only → `supported`;
 * otherwise `unsupported`. Lifecycle is not an input: a superseded revision is
 * evaluated on its own evidence and justifications, exactly as it stood, so a
 * historical execution's premises can still be inspected as they were.
 */
export function evaluateSupport(ledger: KnowledgeLedger, ref: ClaimRef): ClaimSupport {
  requireClaim(ledger, ref);
  return evaluate(ledger, ref, newEvaluation());
}

/** "Why is this claim supported (or not)?" — every signal, with its force. */
export function supportReport(ledger: KnowledgeLedger, ref: ClaimRef): SupportReport {
  requireClaim(ledger, ref);
  const ev = newEvaluation();
  const justifications: JustificationStatus[] = premisesOf(ledger, ref).map((j) => ({
    justification: j,
    force: forceOf(ledger, j, ev),
  }));
  return {
    claim: { id: ref.id, revision: ref.revision },
    lifecycle: lifecycleOf(ledger, ref),
    support: evaluate(ledger, ref, ev),
    evidence: evidenceOf(ledger, ref),
    justifications,
  };
}

// ── Dependency traversal ────────────────────────────────────────────────────

/**
 * Conclusions of every justification naming this revision as a premise, in
 * ledger order, each once. Opposing justifications count: a conclusion whose
 * refutation rests on X depends on X.
 */
export function dependentsOf(ledger: KnowledgeLedger, ref: ClaimRef): ClaimRef[] {
  const out: ClaimRef[] = [];
  const seen = new Set<string>();
  for (const j of ledger.justifications) {
    if (!j.premises.some((p) => sameRef(p, ref))) continue;
    const key = formatClaimRef(j.conclusion);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: j.conclusion.id, revision: j.conclusion.revision });
  }
  return out;
}

/**
 * Everything downstream of a revision, breadth-first in ledger order, each
 * revision once, the start excluded. The visited set makes this terminate on
 * any graph, cyclic or not.
 */
export function transitiveDependentsOf(ledger: KnowledgeLedger, ref: ClaimRef): ClaimRef[] {
  const out: ClaimRef[] = [];
  const seen = new Set<string>([formatClaimRef(ref)]);
  const queue: ClaimRef[] = [ref];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of dependentsOf(ledger, current)) {
      const key = formatClaimRef(next);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(next);
      queue.push(next);
    }
  }
  return out;
}

export function dependentsReport(ledger: KnowledgeLedger, ref: ClaimRef): DependentsReport {
  requireClaim(ledger, ref);
  return {
    claim: { id: ref.id, revision: ref.revision },
    direct: dependentsOf(ledger, ref),
    transitive: transitiveDependentsOf(ledger, ref),
  };
}

// ── Provenance traversal ────────────────────────────────────────────────────

/** Consumption records naming this exact revision, in recording order. A
 *  revised claim's consumers stay on the revision they consumed. */
export function consumersOf(ledger: KnowledgeLedger, ref: ClaimRef): ClaimConsumption[] {
  return ledger.consumptions.filter((c) => sameRef(c.claim, ref));
}

export function consumersReport(ledger: KnowledgeLedger, ref: ClaimRef): ConsumersReport {
  requireClaim(ledger, ref);
  return { claim: { id: ref.id, revision: ref.revision }, consumptions: consumersOf(ledger, ref) };
}

/**
 * The run's reference as the ledger knows it: locators merged across its
 * provenance records (they cannot disagree — `resolveExecution` refuses that),
 * then filled from any `producedBy` naming the run. Null when the ledger holds
 * nothing about it.
 */
export function executionOf(ledger: KnowledgeLedger, runId: string): RunExecutionRef | null {
  const records: ExecutionRef[] = [
    ...executionRecordsOf(ledger, runId),
    ...ledger.claims.filter((c) => c.producedBy?.runId === runId).map((c) => c.producedBy!),
    ...ledger.justifications.filter((j) => j.producedBy?.runId === runId).map((j) => j.producedBy!),
  ];
  if (records.length === 0) return null;
  const out: RunExecutionRef = { runId };
  for (const r of records) {
    if (out.instanceId === undefined && r.instanceId !== undefined) out.instanceId = r.instanceId;
    if (out.phaseId === undefined && r.phaseId !== undefined) out.phaseId = r.phaseId;
  }
  return out;
}

/** Whether a consumed revision is still the active, supported one. Total: a
 *  dangling reference in a hand-edited file reads as `unsupported`. */
export function consumedStatus(
  ledger: KnowledgeLedger,
  ref: ClaimRef,
  source?: ConsumptionSource,
): ConsumedClaimStatus {
  const lifecycle = lifecycleOf(ledger, ref);
  const support = evaluate(ledger, ref, newEvaluation());
  return {
    claim: { id: ref.id, revision: ref.revision },
    lifecycle,
    support,
    current: lifecycle === "active" && support === "supported",
    ...(source !== undefined ? { source } : {}),
  };
}

/**
 * Both directions of one execution's semantic provenance, plus its currency.
 * Null when the ledger holds no *reliance or production* record for the run.
 * `produced` comes from Phase 1's `producedBy` (matched on `runId`);
 * `consumed` from the consumption edges. The two are distinct facts:
 * producing a claim does not make a run a consumer of it, and this report
 * never conflates them. Currency is derived here and stored nowhere — the
 * run's own status record is not consulted and not touched.
 *
 * A durable supplied record (Phase 4.1) is deliberately **not** enough to
 * make this report exist: supply is what Argus handed a run, not what the run
 * relied on, and a merely-supplied run has no semantic provenance to report.
 * What it received is `GET /executions/:runId/context`, which reads the
 * supplied record directly.
 */
export function executionProvenance(
  ledger: KnowledgeLedger,
  runId: string,
): ExecutionProvenance | null {
  const relied =
    ledger.consumptions.some((c) => c.execution.runId === runId) ||
    ledger.artifacts.some((a) => a.execution.runId === runId) ||
    ledger.deltas.some((d) => d.execution.runId === runId) ||
    ledger.claims.some((c) => c.producedBy?.runId === runId) ||
    ledger.justifications.some((j) => j.producedBy?.runId === runId);
  if (!relied) return null;
  const execution = executionOf(ledger, runId);
  if (!execution) return null;
  const consumed = ledger.consumptions
    .filter((c) => c.execution.runId === runId)
    .map((c) => consumedStatus(ledger, c.claim, c.source));
  return {
    execution,
    consumed,
    produced: {
      claims: ledger.claims
        .filter((c) => c.producedBy?.runId === runId)
        .map((c) => viewOf(ledger, c)),
      justifications: ledger.justifications.filter((j) => j.producedBy?.runId === runId),
      artifacts: ledger.artifacts.filter((a) => a.execution.runId === runId).map((a) => a.artifact),
    },
    currency: consumed.every((c) => c.current) ? "current" : "stale",
  };
}
