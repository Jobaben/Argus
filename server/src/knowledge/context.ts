/**
 * KnowledgeContext — controlled semantic context delivery (Phase 4).
 *
 * The KnowledgeDelta protocol (delta.ts) is how an agent puts knowledge *into*
 * the ledger. This module is the opposite direction: how Argus chooses exact
 * claim revisions for one run, projects them into an agent-facing document,
 * and proves afterwards precisely what it supplied.
 *
 *   Knowledge Ledger snapshot
 *     ↓ selectors (authored on the step or its phase)          parseKnowledgeContextSpec
 *     ↓ resolve each to an exact revision; freeze              resolveKnowledgeContext
 *     ↓ project: statement, kind, lifecycle, support, evidence  (same call)
 *     ↓ serialize deterministically; hash                        serializeKnowledgeContext / sha256Hex
 *     ↓ argus/invocations/<runId>/knowledge-context.json         knowledgeContextFile (read-only channel)
 *     ↓ invocation record: exact refs + sha256                   (harness/invocation.ts)
 *     ↓ knowledge.json `supplied`: the durable record            (kernel recordSuppliedContext)
 *     ↓ agent reads $ARGUS_KNOWLEDGE_CONTEXT_FILE
 *     ↓ at completion, re-hash the file                          verifyKnowledgeContextIntegrity
 *     ↓ optional KnowledgeDelta declares `consumed`              (delta.ts classifies each entry)
 *
 * Two facts, kept apart on purpose: **supplied** (Argus-controlled, durable in
 * the ledger since Phase 4.1) and **consumed** (agent-declared, a Phase 2
 * consumption edge). Nothing here records a consumption, and nothing in impact
 * analysis reads a supplied set. The only place the two meet is
 * {@link compareSuppliedConsumed}, a derived comparison.
 *
 * The resolution half is pure: one ledger snapshot in, one document out, no
 * clock beyond the `now` it is handed, no I/O. The file helpers at the bottom
 * are the thin I/O shell.
 */

import { createHash } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ClaimKind,
  ClaimRef,
  ContextIntegrityResult,
  KnowledgeContext,
  KnowledgeContextClaim,
  KnowledgeContextSelector,
  KnowledgeContextSpec,
  PhaseProducedSelector,
  SuppliedConsumedComparison,
} from "@argus/contracts";
import { atomicWriteFile } from "../sources/atomicWrite.js";
import { runInvocationDir } from "../sources/runs.js";
import {
  CLAIM_ID_RE,
  CLAIM_KINDS,
  EXECUTION_ID_RE,
  KnowledgeValidationError,
  activeRevision,
  claimsProducedByPhase,
  evidenceOf,
  formatClaimRef,
  getClaim,
  lifecycleOf,
  parseClaimKey,
  sameRef,
  supersededBy,
  evaluateSupport,
  type KnowledgeLedger,
} from "./kernel.js";

/** Why a spec or a resolution was refused. `spec` is an authoring error
 *  (refused when the pipeline is saved); the rest are ledger-dependent and
 *  refuse the *launch* as a `configuration` failure. */
export type KnowledgeContextErrorCode =
  | "spec"
  | "unknown-claim"
  | "unknown-revision"
  | "unknown-phase"
  | "phase-not-accepted"
  | "too-many-claims";

export class KnowledgeContextError extends KnowledgeValidationError {
  constructor(
    public readonly code: KnowledgeContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeContextError";
  }
}

function fail(code: KnowledgeContextErrorCode, msg: string): never {
  throw new KnowledgeContextError(code, msg);
}

/** Selectors per spec. The same bound the delta protocol puts on a section:
 *  a context is a focused selection, not the ledger. */
export const CONTEXT_MAX_CLAIMS = 64;

/** `RULE-17:v2` for an exact selector, `RULE-17 (active)` for an active one. */
export function formatSelector(sel: KnowledgeContextSelector): string {
  return sel.revision === "active"
    ? `${sel.id} (active)`
    : formatClaimRef({ id: sel.id, revision: sel.revision });
}

/**
 * One selector from its authored form: `"RULE-17:v2"` (exact), `"RULE-17"`
 * (active), or `{ id, revision: <n> | "active" }`. Returned normalized to the
 * object form, so what is persisted in a pipeline definition never depends
 * on how it was spelled.
 */
function parseSelector(raw: unknown, ctx: string): KnowledgeContextSelector {
  if (typeof raw === "string") {
    const key = parseClaimKey(raw.trim());
    if (!key) {
      fail(
        "spec",
        `${ctx} must be a claim id ("RULE-17", meaning its active revision) or an exact revision ("RULE-17:v2")`,
      );
    }
    return { id: key.id, revision: key.revision ?? "active" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("spec", `${ctx} must be a string or an object { id, revision }`);
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "id" && k !== "revision") fail("spec", `${ctx} has unknown key "${k}"`);
  }
  if (typeof r.id !== "string" || !CLAIM_ID_RE.test(r.id)) {
    fail("spec", `${ctx}.id must be a claim id`);
  }
  if (r.revision === "active") return { id: r.id, revision: "active" };
  if (typeof r.revision !== "number" || !Number.isInteger(r.revision) || r.revision < 1) {
    fail("spec", `${ctx}.revision must be a positive integer or "active"`);
  }
  return { id: r.id, revision: r.revision };
}

/**
 * Untrusted authoring → a validated spec. Ledger-independent: this is what a
 * pipeline definition is checked against when it is saved, so a malformed
 * selector is refused before any instance exists.
 *
 * **Duplicates are refused, by logical id.** A context is a set of claims
 * keyed by id — each selector answers "which revision of X does this step
 * see" — so a second selector for the same id is either redundant (the same
 * revision twice) or asks the agent to hold two revisions of one claim as
 * simultaneously *the* claim, which is exactly the ambiguity the protocol
 * exists to remove. Refusing is deterministic and says which id.
 */
export function parseKnowledgeContextSpec(raw: unknown): KnowledgeContextSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("spec", "knowledgeContext must be an object { claims: [...] }");
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "claims" && k !== "fromPhases") {
      fail("spec", `knowledgeContext has unknown key "${k}"`);
    }
  }
  const hasClaims = r.claims !== undefined && r.claims !== null;
  const hasPhases = r.fromPhases !== undefined && r.fromPhases !== null;
  if (!hasClaims && !hasPhases) {
    fail(
      "spec",
      "knowledgeContext must name claims or fromPhases (omit knowledgeContext for no semantic context)",
    );
  }
  const out: KnowledgeContextSpec = {};

  if (hasClaims) {
    if (!Array.isArray(r.claims)) fail("spec", "knowledgeContext.claims must be a list");
    if (r.claims.length === 0) {
      fail(
        "spec",
        "knowledgeContext.claims must name at least one claim (omit knowledgeContext for none)",
      );
    }
    if (r.claims.length > CONTEXT_MAX_CLAIMS) {
      fail("spec", `knowledgeContext.claims may name at most ${CONTEXT_MAX_CLAIMS} claims`);
    }
    const claims = r.claims.map((c, i) => parseSelector(c, `knowledgeContext.claims[${i}]`));
    const seen = new Map<string, number>();
    claims.forEach((sel, i) => {
      const first = seen.get(sel.id);
      if (first !== undefined) {
        fail(
          "spec",
          `knowledgeContext.claims[${i}]: ${sel.id} is already selected by claims[${first}]; each claim id may appear once`,
        );
      }
      seen.set(sel.id, i);
    });
    out.claims = claims;
  }

  if (hasPhases) {
    if (!Array.isArray(r.fromPhases)) fail("spec", "knowledgeContext.fromPhases must be a list");
    if (r.fromPhases.length === 0) {
      fail("spec", "knowledgeContext.fromPhases must name at least one phase");
    }
    if (r.fromPhases.length > CONTEXT_MAX_PHASES) {
      fail("spec", `knowledgeContext.fromPhases may name at most ${CONTEXT_MAX_PHASES} phases`);
    }
    const fromPhases = r.fromPhases.map((f, i) =>
      parsePhaseSelector(f, `knowledgeContext.fromPhases[${i}]`),
    );
    const seen = new Map<string, number>();
    fromPhases.forEach((sel, i) => {
      const first = seen.get(sel.phaseId);
      if (first !== undefined) {
        fail(
          "spec",
          `knowledgeContext.fromPhases[${i}]: phase "${sel.phaseId}" is already selected by fromPhases[${first}]`,
        );
      }
      seen.set(sel.phaseId, i);
    });
    out.fromPhases = fromPhases;
  }
  return out;
}

/** Phases one spec may draw from. Small on purpose: a step that needs a
 *  dozen upstream phases' output is not selecting, it is dumping. */
export const CONTEXT_MAX_PHASES = 8;

/**
 * One `fromPhases` entry: `"discover-rules"` or
 * `{ phaseId, kinds?: ClaimKind[] }`. Normalized to the object form, and the
 * kinds list is deduplicated but not reordered, so what a definition persists
 * does not depend on how it was spelled.
 */
function parsePhaseSelector(raw: unknown, ctx: string): PhaseProducedSelector {
  if (typeof raw === "string") return { phaseId: phaseId(raw.trim(), ctx) };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail("spec", `${ctx} must be a phase id or an object { phaseId, kinds }`);
  }
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== "phaseId" && k !== "kinds") fail("spec", `${ctx} has unknown key "${k}"`);
  }
  const out: PhaseProducedSelector = {
    phaseId: phaseId(typeof r.phaseId === "string" ? r.phaseId.trim() : "", `${ctx}.phaseId`),
  };
  if (r.kinds !== undefined && r.kinds !== null) {
    if (!Array.isArray(r.kinds)) fail("spec", `${ctx}.kinds must be a list of claim kinds`);
    if (r.kinds.length === 0) {
      fail("spec", `${ctx}.kinds must name at least one kind (omit it for every kind)`);
    }
    const kinds: ClaimKind[] = [];
    for (const [i, k] of r.kinds.entries()) {
      if (typeof k !== "string" || !CLAIM_KINDS.includes(k as ClaimKind)) {
        fail("spec", `${ctx}.kinds[${i}] must be one of ${CLAIM_KINDS.join(" | ")}`);
      }
      if (!kinds.includes(k as ClaimKind)) kinds.push(k as ClaimKind);
    }
    out.kinds = kinds;
  }
  return out;
}

function phaseId(raw: string, ctx: string): string {
  if (!raw || !EXECUTION_ID_RE.test(raw)) fail("spec", `${ctx} must be a phase id`);
  return raw;
}

/** The spec a step's run receives: its own, else its phase's, else none. A
 *  step's spec *replaces* the phase's (no merging of selector lists). */
export function effectiveContextSpec(
  phaseDef: { knowledgeContext?: KnowledgeContextSpec },
  stepDef: { knowledgeContext?: KnowledgeContextSpec },
): KnowledgeContextSpec | null {
  return stepDef.knowledgeContext ?? phaseDef.knowledgeContext ?? null;
}

export interface ResolvedKnowledgeContext {
  /** The agent-facing document. */
  context: KnowledgeContext;
  /** The exact revisions it contains, in document order. */
  supplied: ClaimRef[];
  /** The document as it is written to disk — deterministic for one context. */
  text: string;
  /** SHA-256 (hex) of `text`. */
  sha256: string;
}

/**
 * Resolve a spec against **one** ledger snapshot and build the projection.
 *
 * The snapshot is the resolution boundary (KNOWLEDGE-LEDGER.md § stale-at-
 * launch): every selector — exact and active alike — is answered from this
 * one document, and what it resolved to is what the run receives, whatever
 * the ledger does afterwards. An exact selector may name a superseded
 * revision (it exists; that is what "historical" means) and the projection
 * says so; an active selector resolves to the highest revision of the id.
 * Support state never blocks selection: `unsupported` and `contested` are
 * exposed, not hidden — a contested rule may be what the step must reason
 * about. A selector that cannot be resolved refuses the whole context.
 */
export function resolveKnowledgeContext(
  ledger: KnowledgeLedger,
  spec: KnowledgeContextSpec,
  now: string,
  scope?: KnowledgeContextScope,
): ResolvedKnowledgeContext {
  const selection: NonNullable<KnowledgeContext["metadata"]>["selection"] = [];
  const claims: KnowledgeContextClaim[] = [];
  const supplied: ClaimRef[] = [];
  /** Claim ids already selected. A context is a set keyed by id (§ spec). */
  const taken = new Set<string>();

  const project = (ref: ClaimRef) => {
    const claim = getClaim(ledger, ref)!;
    const next = supersededBy(ledger, ref);
    const evidence = evidenceOf(ledger, ref).map((e) => ({
      direction: e.direction,
      source: e.source,
      ...(e.note !== undefined ? { note: e.note } : {}),
    }));
    claims.push({
      ref: formatClaimRef(ref),
      id: claim.id,
      revision: claim.revision,
      kind: claim.kind,
      statement: claim.statement,
      ...(claim.structuredValue !== undefined ? { structuredValue: claim.structuredValue } : {}),
      lifecycle: lifecycleOf(ledger, ref),
      ...(next ? { supersededBy: formatClaimRef(next) } : {}),
      support: evaluateSupport(ledger, ref),
      ...(claim.revisionNote !== undefined ? { revisionNote: claim.revisionNote } : {}),
      ...(claim.producedBy !== undefined ? { producedBy: claim.producedBy } : {}),
      ...(evidence.length ? { evidence } : {}),
    });
    supplied.push(ref);
    taken.add(ref.id);
  };

  (spec.claims ?? []).forEach((sel, i) => {
    const where = `knowledgeContext.claims[${i}] (${formatSelector(sel)})`;
    const claim =
      sel.revision === "active"
        ? activeRevision(ledger, sel.id)
        : getClaim(ledger, { id: sel.id, revision: sel.revision });
    if (!claim) {
      if (!activeRevision(ledger, sel.id)) {
        fail("unknown-claim", `${where}: claim ${sel.id} does not exist in the ledger`);
      }
      fail(
        "unknown-revision",
        `${where}: revision v${sel.revision} of ${sel.id} does not exist in the ledger`,
      );
    }
    const ref: ClaimRef = { id: claim.id, revision: claim.revision };
    project(ref);
    selection.push({ selector: sel, resolved: ref });
  });

  (spec.fromPhases ?? []).forEach((sel, i) => {
    const where = `knowledgeContext.fromPhases[${i}] (${sel.phaseId})`;
    if (!scope) {
      fail(
        "spec",
        `${where}: a fromPhases selector can only be resolved inside a pipeline instance`,
      );
    }
    const status = scope.phaseStatus(sel.phaseId);
    if (status === null) {
      fail("unknown-phase", `${where}: this pipeline has no phase "${sel.phaseId}"`);
    }
    if (!ACCEPTED_PHASE_STATUS.has(status)) {
      fail(
        "phase-not-accepted",
        `${where}: phase "${sel.phaseId}" is ${status}; a fromPhases selector reads only what an accepted phase committed`,
      );
    }
    for (const ref of producedRefs(ledger, scope.instanceId, sel)) {
      if (taken.has(ref.id)) continue;
      project(ref);
      selection.push({
        selector: { id: ref.id, revision: ref.revision },
        resolved: ref,
        fromPhase: sel.phaseId,
      });
    }
  });

  if (claims.length > CONTEXT_MAX_CLAIMS) {
    fail(
      "too-many-claims",
      `knowledgeContext resolved to ${claims.length} claims; a context may carry at most ${CONTEXT_MAX_CLAIMS}. Narrow the fromPhases selector with kinds.`,
    );
  }

  const context: KnowledgeContext = {
    schemaVersion: 1,
    generatedAt: now,
    claims,
    metadata: { selection },
  };
  const text = serializeKnowledgeContext(context);
  return { context, supplied, text, sha256: sha256Hex(text) };
}

/**
 * The exact revisions one `fromPhases` selector resolves to, from the applied
 * delta provenance ({@link claimsProducedByPhase}) — never from a staged
 * record and never by scanning the ledger for claims that name the phase.
 *
 * One revision per logical id: if the phase committed RULE-42:v1 and later,
 * in the same accepted attempt, RULE-42:v2, the *highest* revision the phase
 * produced is what a downstream step receives, because that is the state the
 * phase actually left the claim in. The order is first-appearance order, so
 * the context file reads in the order the phase created things.
 */
function producedRefs(
  ledger: KnowledgeLedger,
  instanceId: string,
  sel: PhaseProducedSelector,
): ClaimRef[] {
  const order: string[] = [];
  const best = new Map<string, ClaimRef>();
  for (const ref of claimsProducedByPhase(ledger, instanceId, sel.phaseId)) {
    const claim = getClaim(ledger, ref);
    if (!claim) continue;
    if (sel.kinds && !sel.kinds.includes(claim.kind)) continue;
    const held = best.get(ref.id);
    if (!held) order.push(ref.id);
    if (!held || ref.revision > held.revision) best.set(ref.id, ref);
  }
  return order.map((id) => best.get(id)!);
}

/**
 * The instance a `fromPhases` selector is resolved inside. Supplied by the
 * engine at phase-attempt planning; absent for a plain ledger resolution
 * (a test, an API preview), in which case a `fromPhases` selector is refused
 * rather than silently resolving to nothing.
 */
export interface KnowledgeContextScope {
  instanceId: string;
  /** The named phase's status on this instance, or null when the pipeline has
   *  no such phase. */
  phaseStatus: (phaseId: string) => string | null;
}

/**
 * Which phase statuses a `fromPhases` selector may read from.
 *
 * `succeeded` is the ordinary case — the phase crossed every acceptance
 * condition and its delta committed. `skipped` is admitted because a routed
 * DAG may legitimately bypass discovery and still run the phases after it;
 * the phase committed nothing, so the selector contributes nothing, which is
 * the honest answer rather than a refused launch.
 *
 * Everything else refuses the launch as a `configuration` failure. In
 * particular `awaiting-approval`: a discovery phase parked at its gate has
 * staged candidates and committed nothing, and a downstream step that quietly
 * received an empty context in that state would look like it had been told
 * there was no knowledge, rather than that the knowledge was not accepted yet.
 */
const ACCEPTED_PHASE_STATUS = new Set(["succeeded", "skipped"]);

/** The one serialization of a context: pretty JSON, trailing newline. The
 *  hash on the invocation record is over exactly these bytes. */
export function serializeKnowledgeContext(context: KnowledgeContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The three sets a later analysis compares. Order follows the supplied list
 * for the first two and the consumed list for the third; each ref once.
 */
export function compareSuppliedConsumed(
  supplied: ClaimRef[],
  consumed: ClaimRef[],
): SuppliedConsumedComparison {
  const has = (list: ClaimRef[], r: ClaimRef) => list.some((x) => sameRef(x, r));
  const dedupe = (list: ClaimRef[]) =>
    list.filter((r, i) => list.findIndex((x) => sameRef(x, r)) === i);
  const s = dedupe(supplied);
  const c = dedupe(consumed);
  return {
    suppliedAndConsumed: s.filter((r) => has(c, r)).map(plain),
    suppliedNotConsumed: s.filter((r) => !has(c, r)).map(plain),
    consumedNotSupplied: c.filter((r) => !has(s, r)).map(plain),
  };
}

const plain = (r: ClaimRef): ClaimRef => ({ id: r.id, revision: r.revision });

// ── The file ────────────────────────────────────────────────────────────────

/** The path handed to the agent as `ARGUS_KNOWLEDGE_CONTEXT_FILE`: inside the
 *  run's own invocation directory, never shared between runs. */
export function knowledgeContextFile(runId: string): string {
  return path.join(runInvocationDir(runId), "knowledge-context.json");
}

/**
 * Materialize the context: atomic write, then the file is made read-only
 * (`0444`). The mode is a guard against an accidental overwrite by the
 * agent's tools, not a security boundary — the runtime's own sandbox or deny
 * rules are (HARNESS.md §3a), and the invocation record's hash is the proof
 * of what was supplied whatever happens to the file afterwards.
 */
export async function writeKnowledgeContextFile(file: string, text: string): Promise<void> {
  await atomicWriteFile(file, text);
  try {
    await chmod(file, 0o444);
  } catch {
    // A filesystem without POSIX modes: the record's hash still stands.
  }
}

/**
 * Does the materialized context still hold the bytes Argus recorded at launch?
 * (Phase 4.1 §integrity.)
 *
 * `expected` is the hash on the run's durable supplied record. The comparison
 * is over **bytes**, never over meaning: a claim revised in the ledger while
 * the agent ran does not touch the file, so this still answers `unchanged` —
 * the run legitimately continues on the historical revision it was given.
 * Semantic currency is a separate, derived question ({@link ExecutionCurrency}).
 *
 * A missing file is an integrity failure, not a pass: Argus cannot confirm the
 * agent read what it was given. The durable record keeps the history either
 * way, so nothing is lost by refusing.
 *
 * The result never carries context *contents* — only the two hashes and the
 * path, which is what a reader needs to diagnose it.
 */
export async function verifyKnowledgeContextIntegrity(
  file: string,
  expected: string,
): Promise<ContextIntegrityResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { status: "missing", expected, file };
  }
  const actual = sha256Hex(text);
  return actual === expected
    ? { status: "unchanged", expected, file }
    : { status: "modified", expected, actual, file };
}

/** The one sentence a refused completion carries. Names the run, the hashes
 *  and the path; never the bytes. */
export function describeIntegrityFailure(runId: string, r: ContextIntegrityResult): string {
  const where = r.file ? ` at ${r.file}` : "";
  return r.status === "missing"
    ? `knowledge context integrity: run ${runId}'s context file is missing${where} (expected sha256 ${r.expected})`
    : `knowledge context integrity: run ${runId}'s context file changed during execution${where} (expected sha256 ${r.expected}, found ${r.actual})`;
}

/** The materialized document, or null when the file is gone (the run was
 *  pruned) or is not a schema-1 context. */
export async function readKnowledgeContext(file: string): Promise<KnowledgeContext | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      !Array.isArray((parsed as { claims?: unknown }).claims)
    ) {
      return null;
    }
    return parsed as KnowledgeContext;
  } catch {
    return null;
  }
}
