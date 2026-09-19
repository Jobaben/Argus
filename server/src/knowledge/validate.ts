import type { ClaimKind, EvidenceSource, ExecutionRef } from "@argus/contracts";
import {
  CLAIM_ID_RE,
  CLAIM_KINDS,
  KnowledgeValidationError,
  parseClaimKey,
  type ClaimKey,
} from "./kernel.js";

/**
 * The boundary where an untrusted proposal becomes a typed ledger input.
 *
 * Today the proposer is an operator or a test through the HTTP API; later it
 * will be an extraction agent. Either way the rule is the same: the caller
 * describes *what* it asserts, and Argus decides the id (unless a valid one is
 * proposed), the revision, the timestamp and whether the references hold. This
 * module does the shape checks — field types, lengths, enumerations — and the
 * kernel does the semantic ones (existence, uniqueness, acyclicity), so a
 * malformed body and an unknown premise both come back as a 400 with a message
 * naming the field.
 *
 * Everything here is deliberately literal: no coercion, no defaults beyond
 * `direction: "supports"`, and no field the ledger does not store.
 */

export const STATEMENT_MAX_CHARS = 8000;
export const NOTE_MAX_CHARS = 2000;
/** Serialized cap on `structuredValue` — an opaque payload, but a bounded one. */
export const STRUCTURED_VALUE_MAX_BYTES = 64 * 1024;
export const PREMISES_MAX = 64;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA_RE = /^[0-9a-f]{7,64}$/;

/** The typed shapes the routes hand to the kernel (ids minted by the store). */
export interface ProposedClaim {
  id?: string;
  kind: ClaimKind;
  statement: string;
  structuredValue?: unknown;
  producedBy?: ExecutionRef;
}
export interface ProposedRevision {
  statement: string;
  structuredValue?: unknown;
  producedBy?: ExecutionRef;
  revisionNote?: string;
}
export interface ProposedEvidence {
  claim: ClaimKey;
  direction: "supports" | "opposes";
  source: EvidenceSource;
  note?: string;
}
export interface ProposedJustification {
  conclusion: ClaimKey;
  premises: ClaimKey[];
  direction: "supports" | "opposes";
  producedBy?: ExecutionRef;
  note?: string;
}

function fail(msg: string): never {
  throw new KnowledgeValidationError(msg);
}

function record(raw: unknown, ctx: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${ctx} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function text(raw: unknown, ctx: string, max: number): string {
  if (typeof raw !== "string" || !raw.trim()) fail(`${ctx} must be a non-empty string`);
  if (raw.length > max) fail(`${ctx} exceeds ${max} characters`);
  return raw.trim();
}

function optionalText(raw: unknown, ctx: string, max: number): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  return text(raw, ctx, max);
}

function identifier(raw: unknown, ctx: string): string {
  if (typeof raw !== "string" || !ID_RE.test(raw)) fail(`${ctx} is not a valid identifier`);
  return raw;
}

function optionalIdentifier(raw: unknown, ctx: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  return identifier(raw, ctx);
}

function structuredValue(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  } catch {
    return fail("structuredValue must be JSON-serializable");
  }
  if (bytes > STRUCTURED_VALUE_MAX_BYTES) {
    fail(`structuredValue exceeds ${STRUCTURED_VALUE_MAX_BYTES} bytes`);
  }
  return raw;
}

function executionRef(raw: unknown): ExecutionRef | undefined {
  if (raw === undefined || raw === null) return undefined;
  const r = record(raw, "producedBy");
  const out: ExecutionRef = {};
  const instanceId = optionalIdentifier(r.instanceId, "producedBy.instanceId");
  const phaseId = optionalIdentifier(r.phaseId, "producedBy.phaseId");
  const runId = optionalIdentifier(r.runId, "producedBy.runId");
  if (instanceId) out.instanceId = instanceId;
  if (phaseId) out.phaseId = phaseId;
  if (runId) out.runId = runId;
  return Object.keys(out).length > 0 ? out : undefined;
}

function direction(raw: unknown, ctx: string): "supports" | "opposes" {
  if (raw === undefined || raw === null) return "supports";
  if (raw !== "supports" && raw !== "opposes") fail(`${ctx} must be "supports" | "opposes"`);
  return raw;
}

/**
 * A claim reference in a body: the string form (`RULE-17` or `RULE-17:v2`) or
 * the object form `{ id, revision? }`. A bare id resolves to the active
 * revision at write time — and is then *stored* as that exact revision, so
 * the record never floats.
 */
export function claimKey(raw: unknown, ctx: string): ClaimKey {
  if (typeof raw === "string") {
    const key = parseClaimKey(raw);
    if (!key) fail(`${ctx} "${raw}" is not a valid claim reference`);
    return key;
  }
  const r = record(raw, ctx);
  if (typeof r.id !== "string" || !CLAIM_ID_RE.test(r.id)) {
    fail(`${ctx}.id is not a valid claim id`);
  }
  if (r.revision === undefined || r.revision === null) return { id: r.id };
  if (typeof r.revision !== "number" || !Number.isInteger(r.revision) || r.revision < 1) {
    fail(`${ctx}.revision must be a positive integer`);
  }
  return { id: r.id, revision: r.revision };
}

function evidenceSource(raw: unknown): EvidenceSource {
  const r = record(raw, "source");
  const ctx = "source";
  switch (r.type) {
    case "run":
      return { type: "run", runId: identifier(r.runId, `${ctx}.runId`) };
    case "phase":
      return {
        type: "phase",
        instanceId: identifier(r.instanceId, `${ctx}.instanceId`),
        phaseId: identifier(r.phaseId, `${ctx}.phaseId`),
      };
    case "artifact":
      return {
        type: "artifact",
        instanceId: identifier(r.instanceId, `${ctx}.instanceId`),
        phaseId: identifier(r.phaseId, `${ctx}.phaseId`),
        path: text(r.path, `${ctx}.path`, 1024),
      };
    case "verification":
      return {
        type: "verification",
        instanceId: identifier(r.instanceId, `${ctx}.instanceId`),
        phaseId: identifier(r.phaseId, `${ctx}.phaseId`),
      };
    case "source-code": {
      const out: EvidenceSource = { type: "source-code", path: text(r.path, `${ctx}.path`, 1024) };
      if (r.line !== undefined && r.line !== null) {
        if (typeof r.line !== "number" || !Number.isInteger(r.line) || r.line < 1) {
          fail(`${ctx}.line must be a positive integer`);
        }
        out.line = r.line;
      }
      if (r.gitHead !== undefined && r.gitHead !== null) {
        if (typeof r.gitHead !== "string" || !SHA_RE.test(r.gitHead)) {
          fail(`${ctx}.gitHead must be a hex commit sha`);
        }
        out.gitHead = r.gitHead;
      }
      return out;
    }
    case "git-commit": {
      if (typeof r.sha !== "string" || !SHA_RE.test(r.sha)) {
        fail(`${ctx}.sha must be a hex commit sha`);
      }
      const repository = optionalText(r.repository, `${ctx}.repository`, 512);
      return { type: "git-commit", sha: r.sha, ...(repository ? { repository } : {}) };
    }
    case "document": {
      const title = optionalText(r.title, `${ctx}.title`, 512);
      return {
        type: "document",
        uri: text(r.uri, `${ctx}.uri`, 2048),
        ...(title ? { title } : {}),
      };
    }
    case "human":
      return { type: "human", who: text(r.who, `${ctx}.who`, 256) };
    default:
      return fail(
        `${ctx}.type must be one of run | phase | artifact | verification | source-code | git-commit | document | human`,
      );
  }
}

export function validateClaim(raw: unknown): ProposedClaim {
  const r = record(raw, "claim");
  if (typeof r.kind !== "string" || !CLAIM_KINDS.includes(r.kind as ClaimKind)) {
    fail(`kind must be one of ${CLAIM_KINDS.join(" | ")}`);
  }
  const out: ProposedClaim = {
    kind: r.kind as ClaimKind,
    statement: text(r.statement, "statement", STATEMENT_MAX_CHARS),
  };
  if (r.id !== undefined && r.id !== null) {
    if (typeof r.id !== "string" || !CLAIM_ID_RE.test(r.id)) fail("id is not a valid claim id");
    out.id = r.id;
  }
  const sv = structuredValue(r.structuredValue);
  if (sv !== undefined) out.structuredValue = sv;
  const producedBy = executionRef(r.producedBy);
  if (producedBy) out.producedBy = producedBy;
  return out;
}

export function validateRevision(raw: unknown): ProposedRevision {
  const r = record(raw, "revision");
  const out: ProposedRevision = { statement: text(r.statement, "statement", STATEMENT_MAX_CHARS) };
  const sv = structuredValue(r.structuredValue);
  if (sv !== undefined) out.structuredValue = sv;
  const producedBy = executionRef(r.producedBy);
  if (producedBy) out.producedBy = producedBy;
  const note = optionalText(r.revisionNote, "revisionNote", NOTE_MAX_CHARS);
  if (note) out.revisionNote = note;
  return out;
}

export function validateEvidence(raw: unknown): ProposedEvidence {
  const r = record(raw, "evidence");
  const out: ProposedEvidence = {
    claim: claimKey(r.claim, "claim"),
    direction: direction(r.direction, "direction"),
    source: evidenceSource(r.source),
  };
  const note = optionalText(r.note, "note", NOTE_MAX_CHARS);
  if (note) out.note = note;
  return out;
}

export function validateJustification(raw: unknown): ProposedJustification {
  const r = record(raw, "justification");
  if (!Array.isArray(r.premises)) fail("premises must be an array of claim references");
  if (r.premises.length === 0) fail("premises must name at least one claim");
  if (r.premises.length > PREMISES_MAX) fail(`premises exceeds ${PREMISES_MAX} entries`);
  const out: ProposedJustification = {
    conclusion: claimKey(r.conclusion, "conclusion"),
    premises: r.premises.map((p, i) => claimKey(p, `premises[${i}]`)),
    direction: direction(r.direction, "direction"),
  };
  const producedBy = executionRef(r.producedBy);
  if (producedBy) out.producedBy = producedBy;
  const note = optionalText(r.note, "note", NOTE_MAX_CHARS);
  if (note) out.note = note;
  return out;
}
