import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Claim, ClaimKind, Evidence, Justification } from "@argus/contracts";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";
import { KeyedMutex } from "../mutex.js";
import {
  LEDGER_VERSION,
  activeRevision,
  addClaim,
  addEvidence,
  addJustification,
  emptyLedger,
  resolveKey,
  reviseClaim,
  KnowledgeValidationError,
  formatClaimRef,
  type ClaimKey,
  type KnowledgeLedger,
} from "./kernel.js";
import type {
  ProposedClaim,
  ProposedEvidence,
  ProposedJustification,
  ProposedRevision,
} from "./validate.js";

/**
 * The Knowledge Ledger's one authoritative store: `~/.claude/argus/knowledge.json`.
 *
 * Why a JSON document and not the Vault. The Vault is a *rebuildable cache* of
 * execution history — it can be deleted and re-ingested from the run and
 * instance files, and it is allowed to be unavailable (`node:sqlite` missing, a
 * read-only home) at the cost of a feature. Nothing can rebuild a claim graph;
 * the ledger *is* the record. So it takes the discipline Argus already trusts
 * for `pipelines.json` and `schedules.json`: a whole-document read-modify-write
 * under a keyed mutex, written through the atomic tmp+rename writer, refusing
 * to overwrite a file it cannot parse. A single document (rather than one file
 * per claim) is chosen because every mutation is validated against the whole
 * graph — uniqueness, references, cycles — and a single atomic write is the
 * simplest way to make "the graph I validated against" and "the graph I wrote"
 * the same graph.
 *
 * This module is the side-effecting shell around `kernel.ts`: it reads, hands
 * the snapshot to a pure transition, writes what comes back. It mints ids and
 * stamps timestamps, and decides nothing else.
 */

const lock = new KeyedMutex();
const LOCK_KEY = "knowledge.json";

/** Mint prefixes, so a minted claim id reads as its kind in a URL or a log. */
const KIND_PREFIX: Record<ClaimKind, string> = {
  fact: "FACT",
  assumption: "ASSUME",
  "business-rule": "RULE",
  constraint: "CONSTRAINT",
  conclusion: "CONCLUSION",
  decision: "DECISION",
};

function mint(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

function isLedgerShape(v: unknown): v is KnowledgeLedger {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.version === LEDGER_VERSION &&
    Array.isArray(r.claims) &&
    Array.isArray(r.evidence) &&
    Array.isArray(r.justifications)
  );
}

/** Missing = empty and safe to write. Present but unparseable or of another
 *  shape = corrupt: readable as empty, never overwritten. */
async function readRaw(): Promise<{ ok: boolean; ledger: KnowledgeLedger }> {
  let text: string;
  try {
    text = await readFile(paths.knowledgeFile(), "utf8");
  } catch {
    return { ok: true, ledger: emptyLedger() };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isLedgerShape(parsed)) return { ok: false, ledger: emptyLedger() };
    return { ok: true, ledger: parsed };
  } catch {
    return { ok: false, ledger: emptyLedger() };
  }
}

/** The current ledger; empty on missing or corrupt. */
export async function readLedger(): Promise<KnowledgeLedger> {
  return (await readRaw()).ledger;
}

/**
 * Run one pure transition against the current ledger and persist its result.
 * The critical section is the whole read-modify-write, so two concurrent
 * proposals see each other's records — the second of two identical claim ids
 * is refused rather than written twice.
 */
export async function mutateLedger<T>(
  fn: (ledger: KnowledgeLedger) => { ledger: KnowledgeLedger; result: T },
): Promise<T> {
  return lock.withLock(LOCK_KEY, async () => {
    const current = await readRaw();
    if (!current.ok) {
      throw new Error("knowledge.json could not be parsed; refusing to overwrite it");
    }
    const next = fn(current.ledger);
    if (next.ledger !== current.ledger) await atomicWriteJson(paths.knowledgeFile(), next.ledger);
    return next.result;
  });
}

function resolveOrThrow(ledger: KnowledgeLedger, key: ClaimKey, ctx: string) {
  const claim = resolveKey(ledger, key);
  if (!claim) {
    const shown =
      key.revision === undefined ? key.id : formatClaimRef({ id: key.id, revision: key.revision });
    throw new KnowledgeValidationError(`${ctx} names unknown claim ${shown}`);
  }
  return { id: claim.id, revision: claim.revision };
}

/** Add revision 1 of a claim, minting an id from its kind unless one was proposed. */
export async function createClaim(input: ProposedClaim, now: Date): Promise<Claim> {
  return mutateLedger((ledger) => {
    let id = input.id;
    if (!id) {
      do id = mint(KIND_PREFIX[input.kind]);
      while (activeRevision(ledger, id));
    }
    const { ledger: next, claim } = addClaim(ledger, { ...input, id }, now.toISOString());
    return { ledger: next, result: claim };
  });
}

/** Supersede the active revision of `id`. Throws {@link UnknownClaimError} for an unknown id. */
export async function createRevision(
  id: string,
  input: ProposedRevision,
  now: Date,
): Promise<Claim> {
  return mutateLedger((ledger) => {
    const { ledger: next, claim } = reviseClaim(ledger, { ...input, id }, now.toISOString());
    return { ledger: next, result: claim };
  });
}

export async function createEvidence(input: ProposedEvidence, now: Date): Promise<Evidence> {
  return mutateLedger((ledger) => {
    const claim = resolveOrThrow(ledger, input.claim, "evidence");
    let id: string;
    do id = mint("EV");
    while (ledger.evidence.some((e) => e.id === id));
    const { ledger: next, evidence } = addEvidence(
      ledger,
      { ...input, id, claim },
      now.toISOString(),
    );
    return { ledger: next, result: evidence };
  });
}

export async function createJustification(
  input: ProposedJustification,
  now: Date,
): Promise<Justification> {
  return mutateLedger((ledger) => {
    const conclusion = resolveOrThrow(ledger, input.conclusion, "conclusion");
    const premises = input.premises.map((p, i) => resolveOrThrow(ledger, p, `premises[${i}]`));
    let id: string;
    do id = mint("J");
    while (ledger.justifications.some((j) => j.id === id));
    const { ledger: next, justification } = addJustification(
      ledger,
      { ...input, id, conclusion, premises },
      now.toISOString(),
    );
    return { ledger: next, result: justification };
  });
}
