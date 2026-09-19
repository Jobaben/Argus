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
 *     ↓ agent reads $ARGUS_KNOWLEDGE_CONTEXT_FILE
 *     ↓ optional KnowledgeDelta declares `consumed`              (delta.ts classifies each entry)
 *
 * Two facts, kept apart on purpose: **supplied** (Argus-controlled, on the
 * invocation record) and **consumed** (agent-declared, a Phase 2 consumption
 * edge). Nothing here records a consumption, and nothing in impact analysis
 * reads a supplied set. The only place the two meet is
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
  ClaimRef,
  KnowledgeContext,
  KnowledgeContextClaim,
  KnowledgeContextSelector,
  KnowledgeContextSpec,
  SuppliedConsumedComparison,
} from "@argus/contracts";
import { atomicWriteFile } from "../sources/atomicWrite.js";
import { runInvocationDir } from "../sources/runs.js";
import {
  CLAIM_ID_RE,
  KnowledgeValidationError,
  activeRevision,
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
export type KnowledgeContextErrorCode = "spec" | "unknown-claim" | "unknown-revision";

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
    if (k !== "claims") fail("spec", `knowledgeContext has unknown key "${k}"`);
  }
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
  return { claims };
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
): ResolvedKnowledgeContext {
  const selection: NonNullable<KnowledgeContext["metadata"]>["selection"] = [];
  const claims: KnowledgeContextClaim[] = [];
  const supplied: ClaimRef[] = [];
  spec.claims.forEach((sel, i) => {
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
    selection.push({ selector: sel, resolved: ref });
  });
  const context: KnowledgeContext = {
    schemaVersion: 1,
    generatedAt: now,
    claims,
    metadata: { selection },
  };
  const text = serializeKnowledgeContext(context);
  return { context, supplied, text, sha256: sha256Hex(text) };
}

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
