import type {
  AppliedKnowledgeDelta,
  ArtifactProduction,
  ArtifactRef,
  ClaimConsumption,
  ClaimKind,
  ClaimRef,
  DeltaClaimRef,
  DeltaProposedClaim,
  DeltaProposedEvidence,
  DeltaProposedJustification,
  DeltaProposedRevision,
  KnowledgeDelta,
  KnowledgeDeltaApplyResult,
  RunExecutionRef,
} from "@argus/contracts";
import {
  CLAIM_ID_RE,
  CLAIM_KINDS,
  KnowledgeValidationError,
  activeRevision,
  addClaim,
  addEvidence,
  addJustification,
  formatClaimRef,
  getClaim,
  parseClaimKey,
  recordArtifact,
  recordConsumption,
  refOf,
  reviseClaim,
  sameArtifact,
  sameRef,
  type KnowledgeLedger,
} from "./kernel.js";
import {
  NOTE_MAX_CHARS,
  STATEMENT_MAX_CHARS,
  artifactRef,
  direction,
  evidenceSource,
  optionalText,
  record,
  structuredValue,
  text,
} from "./validate.js";

/**
 * The KnowledgeDelta protocol's pure half: what an agent's proposal document
 * must look like, and how a set of proposals becomes one atomic ledger
 * transition.
 *
 * Two functions, both pure (no clock, no I/O, no randomness — ids and
 * timestamps arrive as arguments), so the whole protocol is testable on
 * hand-built ledgers and the side-effecting shell (`staging.ts`, `store.ts`,
 * the engine) has nothing semantic to decide:
 *
 * - {@link validateKnowledgeDelta} — untrusted JSON → typed
 *   {@link KnowledgeDelta}. Shape, bounds, enumerations, and the two invariants
 *   that need no ledger: every delta-local id is declared exactly once, and
 *   every `{ local }` reference names one of them. Every reference to
 *   *existing* knowledge must be an exact revision; a bare id is refused here,
 *   before anything is staged, so nothing ambiguous can ever be persisted.
 *
 * - {@link applyKnowledgeDeltas} — one ledger snapshot plus one or more
 *   validated proposals → a new ledger and one result per proposal, or a
 *   thrown {@link KnowledgeDeltaError} and *no* new ledger. It composes the
 *   Phase 1/2 kernel transitions (which are themselves immutable: each returns
 *   a new ledger) on a working copy, so a failure anywhere — an unknown
 *   revision, a stale precondition, a cycle, a conflict between two proposals
 *   — leaves the caller holding the snapshot it started with. Validation and
 *   transition happen against the same snapshot, and the caller persists the
 *   returned ledger in one atomic write or not at all.
 *
 * What Argus decides here, and the agent never does: canonical claim ids
 * (minted), revision numbers (the kernel's), execution provenance
 * (`producedBy` and the consuming/producing execution are the run that wrote
 * the file, bound by the caller), timestamps, and whether the references hold.
 */

export const KNOWLEDGE_DELTA_SCHEMA_VERSION = 1;
/** Most entries any one section of a delta may carry. */
export const DELTA_SECTION_MAX = 64;
export const DELTA_SUMMARY_MAX_CHARS = 2000;
/** Same alphabet as a claim id, so a local id reads like the id it will
 *  become — but it never *is* one: the two live in different syntactic
 *  positions (`{ local }` vs `{ id, revision }`) and cannot be confused. */
export const LOCAL_ID_RE = CLAIM_ID_RE;

/** Why a delta was refused. Closed, so the engine and the API can act on it. */
export type KnowledgeDeltaErrorCode =
  | "invalid-json"
  | "schema"
  | "local-reference"
  | "unknown-reference"
  | "stale-revision"
  | "conflict"
  | "artifact"
  | "ledger";

/** A refused delta. Maps to 400 over HTTP and to the `knowledge-delta`
 *  failure class in the engine. */
export class KnowledgeDeltaError extends KnowledgeValidationError {
  constructor(
    public readonly code: KnowledgeDeltaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeDeltaError";
  }
}

function fail(code: KnowledgeDeltaErrorCode, msg: string): never {
  throw new KnowledgeDeltaError(code, msg);
}

// ── Validation ──────────────────────────────────────────────────────────────

function section<T>(raw: unknown, name: string, item: (v: unknown, ctx: string) => T): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("schema", `${name} must be an array`);
  if (raw.length > DELTA_SECTION_MAX) {
    fail("schema", `${name} exceeds ${DELTA_SECTION_MAX} entries`);
  }
  return raw.map((v, i) => item(v, `${name}[${i}]`));
}

function localId(raw: unknown, ctx: string): string {
  if (typeof raw !== "string" || !LOCAL_ID_RE.test(raw)) {
    fail("schema", `${ctx} is not a valid local id`);
  }
  return raw;
}

function forbid(r: Record<string, unknown>, ctx: string, field: string, why: string): void {
  if (r[field] !== undefined) fail("schema", `${ctx}.${field} is not allowed: ${why}`);
}

/**
 * A reference inside a delta: `{ local }`, `{ id, revision }` or `"ID:vN"`. A
 * bare id — `"RULE-17"` or `{ id }` without a revision — is refused: the
 * agent may have meant "whatever is current", and a committed delta must
 * never carry that ambiguity.
 */
export function deltaClaimRef(raw: unknown, ctx: string): DeltaClaimRef {
  if (typeof raw === "string") {
    const key = parseClaimKey(raw);
    if (!key) fail("schema", `${ctx} "${raw}" is not a valid claim reference`);
    if (key.revision === undefined) {
      fail("schema", `${ctx} "${raw}" must name an exact revision (ID:vN), not a bare id`);
    }
    return { id: key.id, revision: key.revision };
  }
  const r = record(raw, ctx);
  if (r.local !== undefined) {
    if (r.id !== undefined || r.revision !== undefined) {
      fail("schema", `${ctx} must be either a local reference or an exact revision, not both`);
    }
    return { local: localId(r.local, `${ctx}.local`) };
  }
  return exactClaimRef(raw, ctx);
}

/** An exact existing revision, in object or string form. Never local. */
export function exactClaimRef(raw: unknown, ctx: string): ClaimRef {
  if (typeof raw === "string") {
    const key = parseClaimKey(raw);
    if (!key) fail("schema", `${ctx} "${raw}" is not a valid claim reference`);
    if (key.revision === undefined) {
      fail("schema", `${ctx} "${raw}" must name an exact revision (ID:vN), not a bare id`);
    }
    return { id: key.id, revision: key.revision };
  }
  const r = record(raw, ctx);
  if (r.local !== undefined) fail("schema", `${ctx} must name an existing exact revision`);
  if (typeof r.id !== "string" || !CLAIM_ID_RE.test(r.id)) {
    fail("schema", `${ctx}.id is not a valid claim id`);
  }
  if (typeof r.revision !== "number" || !Number.isInteger(r.revision) || r.revision < 1) {
    fail("schema", `${ctx}.revision must be a positive integer (exact revisions only)`);
  }
  return { id: r.id, revision: r.revision };
}

function proposedClaim(raw: unknown, ctx: string): DeltaProposedClaim {
  const r = record(raw, ctx);
  forbid(r, ctx, "id", "canonical ids are assigned by Argus; use localId");
  forbid(r, ctx, "revision", "revision numbers are assigned by Argus");
  forbid(r, ctx, "producedBy", "provenance is bound by Argus from the run");
  if (typeof r.kind !== "string" || !CLAIM_KINDS.includes(r.kind as ClaimKind)) {
    fail("schema", `${ctx}.kind must be one of ${CLAIM_KINDS.join(" | ")}`);
  }
  const out: DeltaProposedClaim = {
    localId: localId(r.localId, `${ctx}.localId`),
    kind: r.kind as ClaimKind,
    statement: text(r.statement, `${ctx}.statement`, STATEMENT_MAX_CHARS),
  };
  const sv = structuredValue(r.structuredValue);
  if (sv !== undefined) out.structuredValue = sv;
  return out;
}

function proposedRevision(raw: unknown, ctx: string): DeltaProposedRevision {
  const r = record(raw, ctx);
  forbid(r, ctx, "kind", "kind is part of a claim's identity and cannot change on revision");
  forbid(
    r,
    ctx,
    "revision",
    "the new revision number is assigned by Argus; state expectedRevision",
  );
  forbid(r, ctx, "producedBy", "provenance is bound by Argus from the run");
  if (typeof r.claimId !== "string" || !CLAIM_ID_RE.test(r.claimId)) {
    fail("schema", `${ctx}.claimId is not a valid claim id`);
  }
  if (
    typeof r.expectedRevision !== "number" ||
    !Number.isInteger(r.expectedRevision) ||
    r.expectedRevision < 1
  ) {
    fail("schema", `${ctx}.expectedRevision must be a positive integer`);
  }
  const out: DeltaProposedRevision = {
    claimId: r.claimId,
    expectedRevision: r.expectedRevision,
    statement: text(r.statement, `${ctx}.statement`, STATEMENT_MAX_CHARS),
  };
  const sv = structuredValue(r.structuredValue);
  if (sv !== undefined) out.structuredValue = sv;
  const note = optionalText(r.revisionNote, `${ctx}.revisionNote`, NOTE_MAX_CHARS);
  if (note) out.revisionNote = note;
  if (r.localId !== undefined && r.localId !== null) {
    out.localId = localId(r.localId, `${ctx}.localId`);
  }
  return out;
}

function proposedEvidence(raw: unknown, ctx: string): DeltaProposedEvidence {
  const r = record(raw, ctx);
  forbid(r, ctx, "id", "evidence ids are assigned by Argus");
  const out: DeltaProposedEvidence = {
    claim: deltaClaimRef(r.claim, `${ctx}.claim`),
    direction: direction(r.direction, `${ctx}.direction`),
    source: evidenceSource(r.source),
  };
  const note = optionalText(r.note, `${ctx}.note`, NOTE_MAX_CHARS);
  if (note) out.note = note;
  return out;
}

function proposedJustification(raw: unknown, ctx: string): DeltaProposedJustification {
  const r = record(raw, ctx);
  forbid(r, ctx, "id", "justification ids are assigned by Argus");
  forbid(r, ctx, "producedBy", "provenance is bound by Argus from the run");
  if (!Array.isArray(r.premises)) fail("schema", `${ctx}.premises must be an array`);
  if (r.premises.length === 0) fail("schema", `${ctx}.premises must name at least one claim`);
  if (r.premises.length > DELTA_SECTION_MAX) {
    fail("schema", `${ctx}.premises exceeds ${DELTA_SECTION_MAX} entries`);
  }
  const out: DeltaProposedJustification = {
    conclusion: deltaClaimRef(r.conclusion, `${ctx}.conclusion`),
    premises: r.premises.map((p, i) => deltaClaimRef(p, `${ctx}.premises[${i}]`)),
    direction: direction(r.direction, `${ctx}.direction`),
  };
  const note = optionalText(r.note, `${ctx}.note`, NOTE_MAX_CHARS);
  if (note) out.note = note;
  return out;
}

const isLocal = (ref: DeltaClaimRef): ref is { local: string } => "local" in ref;

/**
 * Untrusted document → typed delta, or a {@link KnowledgeDeltaError}.
 *
 * Structural only: nothing here consults a ledger. What *is* enforced is
 * everything that can be decided from the document alone — shape, bounds,
 * enumerations, that no canonical id / revision / provenance is being
 * asserted by the agent, that local ids are unique across claims and
 * revisions, that every local reference resolves, that a claim is not revised
 * twice in one delta, and that no consumed revision or artifact is listed
 * twice. Existence, staleness, cycles and cross-delta conflicts are the
 * ledger's business ({@link applyKnowledgeDeltas}).
 */
export function validateKnowledgeDelta(raw: unknown): KnowledgeDelta {
  try {
    return validateShape(raw);
  } catch (e) {
    // The shared field validators throw the base class; at this boundary
    // every refusal is a typed delta refusal.
    if (e instanceof KnowledgeDeltaError) throw e;
    if (e instanceof KnowledgeValidationError) fail("schema", e.message);
    throw e;
  }
}

function validateShape(raw: unknown): KnowledgeDelta {
  const r = record(raw, "delta");
  if (r.schemaVersion !== KNOWLEDGE_DELTA_SCHEMA_VERSION) {
    fail(
      "schema",
      `schemaVersion must be ${KNOWLEDGE_DELTA_SCHEMA_VERSION} (got ${JSON.stringify(r.schemaVersion)})`,
    );
  }
  const delta: KnowledgeDelta = { schemaVersion: KNOWLEDGE_DELTA_SCHEMA_VERSION };
  const claims = section(r.claims, "claims", proposedClaim);
  const revisions = section(r.revisions, "revisions", proposedRevision);
  const evidence = section(r.evidence, "evidence", proposedEvidence);
  const justifications = section(r.justifications, "justifications", proposedJustification);
  const consumed = section(r.consumed, "consumed", exactClaimRef);
  const artifacts = section(r.artifacts, "artifacts", artifactRef);
  if (r.metadata !== undefined && r.metadata !== null) {
    const m = record(r.metadata, "metadata");
    const summary = optionalText(m.summary, "metadata.summary", DELTA_SUMMARY_MAX_CHARS);
    if (summary) delta.metadata = { summary };
  }

  // Local ids: declared once, across both sections that may declare them.
  const locals = new Set<string>();
  const declare = (id: string, ctx: string) => {
    if (locals.has(id)) fail("local-reference", `${ctx}: local id "${id}" is declared twice`);
    locals.add(id);
  };
  claims.forEach((c, i) => declare(c.localId, `claims[${i}]`));
  revisions.forEach((rev, i) => {
    if (rev.localId) declare(rev.localId, `revisions[${i}]`);
  });
  const resolve = (ref: DeltaClaimRef, ctx: string) => {
    if (isLocal(ref) && !locals.has(ref.local)) {
      fail("local-reference", `${ctx} names undeclared local id "${ref.local}"`);
    }
  };
  evidence.forEach((e, i) => resolve(e.claim, `evidence[${i}].claim`));
  justifications.forEach((j, i) => {
    resolve(j.conclusion, `justifications[${i}].conclusion`);
    j.premises.forEach((p, k) => resolve(p, `justifications[${i}].premises[${k}]`));
  });

  // Internal contradictions: one claim revised twice; a revision or an
  // artifact listed twice.
  const revised = new Set<string>();
  for (const rev of revisions) {
    if (revised.has(rev.claimId)) {
      fail("schema", `revisions: claim "${rev.claimId}" is revised twice in one delta`);
    }
    revised.add(rev.claimId);
  }
  const seenConsumed = new Set<string>();
  for (const c of consumed) {
    const key = formatClaimRef(c);
    if (seenConsumed.has(key)) fail("schema", `consumed: ${key} is listed twice`);
    seenConsumed.add(key);
  }
  for (let i = 0; i < artifacts.length; i++) {
    for (let k = 0; k < i; k++) {
      if (sameArtifact(artifacts[i], artifacts[k])) {
        fail("schema", `artifacts: ${artifacts[i].location}:${artifacts[i].path} is listed twice`);
      }
    }
  }

  if (claims.length) delta.claims = claims;
  if (revisions.length) delta.revisions = revisions;
  if (evidence.length) delta.evidence = evidence;
  if (justifications.length) delta.justifications = justifications;
  if (consumed.length) delta.consumed = consumed;
  if (artifacts.length) delta.artifacts = artifacts;
  return delta;
}

/** Parse the agent's file text and validate it. `invalid-json` names the
 *  parse failure distinctly from a well-formed document of the wrong shape. */
export function parseKnowledgeDelta(rawText: string): KnowledgeDelta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    fail("invalid-json", `not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateKnowledgeDelta(parsed);
}

/** A delta that proposes nothing at all. Equivalent to no file. */
export function isEmptyDelta(delta: KnowledgeDelta): boolean {
  return (
    !delta.claims?.length &&
    !delta.revisions?.length &&
    !delta.evidence?.length &&
    !delta.justifications?.length &&
    !delta.consumed?.length &&
    !delta.artifacts?.length
  );
}

// ── Application ─────────────────────────────────────────────────────────────

/** One validated proposal with the execution provenance Argus binds to it. */
export interface DeltaProposal {
  /** The delta's stable identity, assigned by Argus at staging. */
  id: string;
  delta: KnowledgeDelta;
  /** The run that wrote the file, with its instance and phase. Every record
   *  the delta creates is attributed to exactly this execution. */
  execution: RunExecutionRef;
  attempt: number;
  /**
   * The exact revisions Argus supplied to the run as its KnowledgeContext
   * (Phase 4), from the invocation record. When present, every `consumed`
   * entry is classified on commit — `supplied-context` if it is in this
   * list, `agent-discovered` otherwise. Absent = unknown (no record to
   * answer from): the consumption is recorded without a `source`. Never
   * adds a consumption: a supplied revision the agent did not declare stays
   * merely supplied.
   */
  supplied?: ClaimRef[];
}

export interface ApplyDeltasOptions {
  now: string;
  /** Mint a fresh record id with the given prefix (`RULE`, `EV`, `J`, …).
   *  Uniqueness against the working ledger is checked here; the minter only
   *  has to be fresh enough to terminate. */
  mint: (prefix: string) => string;
}

export interface ApplyDeltasResult {
  ledger: KnowledgeLedger;
  results: KnowledgeDeltaApplyResult[];
}

/** Mint prefixes, so a minted claim id reads as its kind in a URL or a log. */
export const KIND_PREFIX: Record<ClaimKind, string> = {
  fact: "FACT",
  assumption: "ASSUME",
  "business-rule": "RULE",
  constraint: "CONSTRAINT",
  conclusion: "CONCLUSION",
  decision: "DECISION",
};

const ref = (r: ClaimRef): ClaimRef => ({ id: r.id, revision: r.revision });

/**
 * Everything about a set of proposals that can be refused by looking at the
 * snapshot alone, before a single record is added: references to existing
 * knowledge resolve, revision preconditions hold, and no two proposals
 * contend for the same claim. Cross-delta conflicts are checked here rather
 * than discovered by whichever proposal happens to be applied second, so the
 * refusal — and the message — is the same whatever order the runs finished in.
 */
function preflight(snapshot: KnowledgeLedger, proposals: DeltaProposal[]): void {
  const ids = new Set<string>();
  const revisedBy = new Map<string, string>();
  for (const p of proposals) {
    const who = `delta ${p.id} (run ${p.execution.runId})`;
    if (ids.has(p.id)) fail("conflict", `${who} is listed twice in one commit`);
    ids.add(p.id);
    const d = p.delta;
    const mustExist = (r: ClaimRef, ctx: string) => {
      if (!getClaim(snapshot, r)) {
        fail(
          "unknown-reference",
          `${who}: ${ctx} names unknown claim revision ${formatClaimRef(r)}`,
        );
      }
    };
    d.evidence?.forEach((e, i) => {
      if (!isLocal(e.claim)) mustExist(e.claim, `evidence[${i}].claim`);
    });
    d.justifications?.forEach((j, i) => {
      if (!isLocal(j.conclusion)) mustExist(j.conclusion, `justifications[${i}].conclusion`);
      j.premises.forEach((pr, k) => {
        if (!isLocal(pr)) mustExist(pr, `justifications[${i}].premises[${k}]`);
      });
    });
    d.consumed?.forEach((c, i) => mustExist(c, `consumed[${i}]`));
    d.revisions?.forEach((rev, i) => {
      const active = activeRevision(snapshot, rev.claimId);
      if (!active) {
        fail("unknown-reference", `${who}: revisions[${i}] names unknown claim "${rev.claimId}"`);
      }
      if (active.revision !== rev.expectedRevision) {
        fail(
          "stale-revision",
          `${who}: revisions[${i}] expects ${rev.claimId} at v${rev.expectedRevision}, but the active revision is v${active.revision}`,
        );
      }
      const other = revisedBy.get(rev.claimId);
      if (other !== undefined) {
        fail(
          "conflict",
          `deltas ${other} and ${p.id} both revise ${rev.claimId} from v${rev.expectedRevision}; the phase commit is refused rather than choosing one`,
        );
      }
      revisedBy.set(rev.claimId, p.id);
    });
  }
}

/**
 * Apply proposals to a ledger snapshot as one transition.
 *
 * Preflight first ({@link preflight}), then each proposal in the given order
 * — new claims, revisions, evidence, justifications, consumptions, artifacts
 * — through the kernel's own transitions on a working ledger. A kernel refusal
 * (a cycle, a duplicate premise, a locator that contradicts an earlier record
 * of the run) surfaces as `ledger`, prefixed with which delta it came from.
 * Any throw leaves the input snapshot untouched: the kernel never mutates,
 * and the working ledger is simply dropped. The order of proposals decides
 * only minted ids and array order, never validity: every reference to
 * existing knowledge is checked against the *snapshot*, so a proposal cannot
 * depend on a sibling's creations and the outcome cannot depend on which run
 * finished first.
 *
 * Proposals whose id is already in `ledger.deltas` are already canonical and
 * are skipped, with their result reconstructed from the ledger's record — the
 * commit is idempotent, which is what makes a crash between the ledger write
 * and the instance write recoverable by simply committing again.
 */
export function applyKnowledgeDeltas(
  ledger: KnowledgeLedger,
  proposals: DeltaProposal[],
  opts: ApplyDeltasOptions,
): ApplyDeltasResult {
  const pending = proposals.filter((p) => !ledger.deltas.some((d) => d.id === p.id));
  preflight(ledger, pending);

  let next = ledger;
  const results = new Map<string, KnowledgeDeltaApplyResult>();
  for (const p of proposals) {
    const already = ledger.deltas.find((d) => d.id === p.id);
    if (already) {
      results.set(p.id, reconstructResult(ledger, p, already));
      continue;
    }
    const who = `delta ${p.id} (run ${p.execution.runId})`;
    const wrap = <T>(ctx: string, fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof KnowledgeDeltaError) throw e;
        if (e instanceof KnowledgeValidationError || e instanceof Error) {
          fail("ledger", `${who}: ${ctx}: ${e.message}`);
        }
        throw e;
      }
    };
    const fresh = (prefix: string, taken: (id: string) => boolean): string => {
      let id: string;
      do id = opts.mint(prefix);
      while (taken(id));
      return id;
    };
    const producedBy = { ...p.execution };
    const locals = new Map<string, ClaimRef>();
    const resolve = (r: DeltaClaimRef, ctx: string): ClaimRef => {
      if (!isLocal(r)) return ref(r);
      const got = locals.get(r.local);
      // Unreachable after validation; kept so a hand-built proposal fails loudly.
      if (!got) fail("local-reference", `${who}: ${ctx} names undeclared local id "${r.local}"`);
      return got;
    };

    const result: KnowledgeDeltaApplyResult = {
      status: "applied",
      deltaId: p.id,
      appliedAt: opts.now,
      createdClaims: [],
      createdRevisions: [],
      evidenceIds: [],
      justificationIds: [],
      consumptions: [],
      artifacts: [],
    };
    const applied: AppliedKnowledgeDelta = {
      id: p.id,
      execution: { ...p.execution },
      attempt: p.attempt,
      appliedAt: opts.now,
      claims: [],
      evidence: [],
      justifications: [],
      consumptions: [],
      artifacts: [],
    };

    const d = p.delta;
    d.claims?.forEach((c, i) => {
      const working = next;
      const id = fresh(KIND_PREFIX[c.kind], (cand) => activeRevision(working, cand) !== null);
      const r = wrap(`claims[${i}]`, () =>
        addClaim(
          next,
          {
            id,
            kind: c.kind,
            statement: c.statement,
            structuredValue: c.structuredValue,
            producedBy,
          },
          opts.now,
        ),
      );
      next = r.ledger;
      locals.set(c.localId, refOf(r.claim));
      result.createdClaims.push({ localId: c.localId, claim: refOf(r.claim) });
      applied.claims.push(refOf(r.claim));
    });
    d.revisions?.forEach((rev, i) => {
      const before = activeRevision(next, rev.claimId);
      const r = wrap(`revisions[${i}]`, () =>
        reviseClaim(
          next,
          {
            id: rev.claimId,
            statement: rev.statement,
            structuredValue: rev.structuredValue,
            revisionNote: rev.revisionNote,
            producedBy,
          },
          opts.now,
        ),
      );
      next = r.ledger;
      if (rev.localId) locals.set(rev.localId, refOf(r.claim));
      result.createdRevisions.push({
        ...(rev.localId ? { localId: rev.localId } : {}),
        claim: refOf(r.claim),
        supersedes: before ? refOf(before) : { id: rev.claimId, revision: rev.expectedRevision },
      });
      applied.claims.push(refOf(r.claim));
    });
    d.evidence?.forEach((e, i) => {
      const working = next;
      const id = fresh("EV", (cand) => working.evidence.some((x) => x.id === cand));
      const r = wrap(`evidence[${i}]`, () =>
        addEvidence(
          next,
          {
            id,
            claim: resolve(e.claim, `evidence[${i}].claim`),
            direction: e.direction ?? "supports",
            source: e.source,
            note: e.note,
          },
          opts.now,
        ),
      );
      next = r.ledger;
      result.evidenceIds.push(r.evidence.id);
      applied.evidence.push(r.evidence.id);
    });
    d.justifications?.forEach((j, i) => {
      const working = next;
      const id = fresh("J", (cand) => working.justifications.some((x) => x.id === cand));
      const r = wrap(`justifications[${i}]`, () =>
        addJustification(
          next,
          {
            id,
            conclusion: resolve(j.conclusion, `justifications[${i}].conclusion`),
            premises: j.premises.map((pr, k) => resolve(pr, `justifications[${i}].premises[${k}]`)),
            direction: j.direction ?? "supports",
            producedBy,
            note: j.note,
          },
          opts.now,
        ),
      );
      next = r.ledger;
      result.justificationIds.push(r.justification.id);
      applied.justifications.push(r.justification.id);
    });
    d.consumed?.forEach((c, i) => {
      const source =
        p.supplied === undefined
          ? undefined
          : p.supplied.some((s) => sameRef(s, c))
            ? "supplied-context"
            : "agent-discovered";
      const r = wrap(`consumed[${i}]`, () =>
        recordConsumption(
          next,
          { execution: p.execution, claim: c, ...(source ? { source } : {}) },
          opts.now,
        ),
      );
      next = r.ledger;
      result.consumptions.push(r.consumption);
      applied.consumptions.push(ref(c));
    });
    d.artifacts?.forEach((a, i) => {
      const r = wrap(`artifacts[${i}]`, () =>
        recordArtifact(next, { execution: p.execution, artifact: a }, opts.now),
      );
      next = r.ledger;
      result.artifacts.push(r.production);
      applied.artifacts.push({ ...a });
    });

    next = { ...next, deltas: [...next.deltas, applied] };
    results.set(p.id, result);
  }

  return { ledger: next, results: proposals.map((p) => results.get(p.id)!) };
}

/**
 * The apply result of a delta the ledger already holds, rebuilt from the
 * ledger's record: claims were created in delta order (new claims first, then
 * revisions), which is how the local ids map back onto canonical identities.
 */
function reconstructResult(
  ledger: KnowledgeLedger,
  p: DeltaProposal,
  applied: AppliedKnowledgeDelta,
): KnowledgeDeltaApplyResult {
  const newClaims = p.delta.claims ?? [];
  const revisions = p.delta.revisions ?? [];
  return {
    status: "applied",
    deltaId: applied.id,
    appliedAt: applied.appliedAt,
    createdClaims: newClaims.map((c, i) => ({ localId: c.localId, claim: ref(applied.claims[i]) })),
    createdRevisions: revisions.map((rev, i) => {
      const claim = ref(applied.claims[newClaims.length + i]);
      return {
        ...(rev.localId ? { localId: rev.localId } : {}),
        claim,
        supersedes: { id: claim.id, revision: claim.revision - 1 },
      };
    }),
    evidenceIds: [...applied.evidence],
    justificationIds: [...applied.justifications],
    consumptions: applied.consumptions.map(
      (c) =>
        ledger.consumptions.find(
          (x) => x.execution.runId === applied.execution.runId && sameRef(x.claim, c),
        ) ??
        ({
          claim: ref(c),
          execution: applied.execution,
          createdAt: applied.appliedAt,
        } as ClaimConsumption),
    ),
    artifacts: applied.artifacts.map(
      (a) =>
        ledger.artifacts.find(
          (x) => x.execution.runId === applied.execution.runId && sameArtifact(x.artifact, a),
        ) ??
        ({
          execution: applied.execution,
          artifact: { ...a } as ArtifactRef,
          createdAt: applied.appliedAt,
        } as ArtifactProduction),
    ),
  };
}

/** Every applied delta naming a run, in commit order. */
export function deltasOfRun(ledger: KnowledgeLedger, runId: string): AppliedKnowledgeDelta[] {
  return ledger.deltas.filter((d) => d.execution.runId === runId);
}

/** The applied delta that introduced a claim revision, or null. */
export function deltaOfClaim(
  ledger: KnowledgeLedger,
  claim: ClaimRef,
): AppliedKnowledgeDelta | null {
  return ledger.deltas.find((d) => d.claims.some((c) => sameRef(c, claim))) ?? null;
}
