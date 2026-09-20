import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type {
  AcceptanceVerification,
  AcceptedChangeProposal,
  ArtifactProduction,
  ChangeRealization,
  ChangeRealizationAttempt,
  ChangeRealizationOutcome,
  Claim,
  ClaimConsumption,
  ClaimRef,
  Evidence,
  Justification,
  KnowledgeDeltaApplyResult,
  RuleVerification,
  RunExecutionRef,
  SuppliedContext,
} from "@argus/contracts";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";
import { KeyedMutex } from "../mutex.js";
import {
  LEDGER_VERSION,
  activeRevision,
  addClaim,
  addEvidence,
  addJustification,
  appendRealizationAttempt,
  closeChangeRealization,
  emptyLedger,
  recordAcceptanceVerification,
  recordArtifact,
  recordChangeProposal,
  recordConsumption,
  recordRuleVerification,
  recordSuppliedContext,
  resolveKey,
  reviseClaim,
  startChangeRealization,
  type StartRealizationInput,
  KnowledgeValidationError,
  formatClaimRef,
  type ClaimKey,
  type KnowledgeLedger,
} from "./kernel.js";
import type {
  ProposedArtifacts,
  ProposedClaim,
  ProposedConsumptions,
  ProposedEvidence,
  ProposedJustification,
  ProposedRevision,
} from "./validate.js";
import { KIND_PREFIX, applyKnowledgeDeltas, type DeltaProposal } from "./delta.js";
import type { RecordAcceptanceInput, RecordVerificationInput } from "./kernel.js";
import { resolveChangeAcceptance, type ChangeProposalAcceptance } from "./changeIntent.js";
import { qualifyClaimId } from "./scope.js";

export type { ChangeProposalAcceptance };

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

function mint(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/**
 * Accept the current shape, or an older document upgraded in memory: a
 * version 1 file (Phase 1: no provenance arrays) gains empty `consumptions`
 * and `artifacts`; a version 2 file (Phase 2) gains an empty `deltas`; a
 * version 3 file (Phase 3) gains an empty `supplied`; a version 4 file
 * (Phase 4.1) gains an empty `verifications`; a version 5 file (Phase 6)
 * gains an empty `changeProposals`; a version 6 file (Phase 7) gains empty
 * `acceptanceVerifications` and `changeRealizations`; a version 7 file
 * (knowledge scopes) gains nothing at all but the version number. The upgrade
 * is written back only by the next successful transition, and it adds nothing
 * but empty arrays and a version number, so nothing an earlier phase recorded
 * changes.
 * In particular an upgraded document claims **no** supplied provenance, **no**
 * conformance, **no** acceptance result and **no** realization for the runs,
 * rules and changes it already holds: unknown stays unknown (`unverified`,
 * never `holds`, never `satisfied`), never retro-inferred, and no accepted
 * change gains a realization nobody ran.
 *
 * The same rule governs **knowledge scope** (version 8), and it is the one
 * migration decision worth stating outright: an upgraded document's claims
 * stay *unscoped*. Argus cannot prove which project a claim written before
 * scopes existed belongs to — the ledger records no repository and no cwd
 * against a claim — so it assigns none rather than adopting them all into
 * whichever project declares a scope first. The consequence is explicit and
 * fail-safe: a scoped pipeline cannot resolve a legacy claim at all (it gets
 * `out-of-scope`, never the record), and an unscoped pipeline keeps resolving
 * them exactly as before. An operator who *does* know the ownership states it
 * by re-running discovery under a declared scope, which creates properly
 * scoped claims; nothing here rewrites history to pretend it was always known.
 *
 * Anything else is another shape: readable as empty, never overwritten.
 */
export function upgradeLedger(v: unknown): KnowledgeLedger | null {
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  const phase1 =
    Array.isArray(r.claims) && Array.isArray(r.evidence) && Array.isArray(r.justifications);
  if (!phase1) return null;
  /** Everything a document of `version` does not yet have, all empty. */
  const added = {
    acceptanceVerifications: [],
    changeRealizations: [],
  };
  if (r.version === 1) {
    return {
      ...r,
      version: LEDGER_VERSION,
      consumptions: [],
      artifacts: [],
      deltas: [],
      supplied: [],
      verifications: [],
      changeProposals: [],
      ...added,
    } as unknown as KnowledgeLedger;
  }
  const phase2 = Array.isArray(r.consumptions) && Array.isArray(r.artifacts);
  if (r.version === 2 && phase2) {
    return {
      ...r,
      version: LEDGER_VERSION,
      deltas: [],
      supplied: [],
      verifications: [],
      changeProposals: [],
      ...added,
    } as unknown as KnowledgeLedger;
  }
  if (r.version === 3 && phase2 && Array.isArray(r.deltas)) {
    return {
      ...r,
      version: LEDGER_VERSION,
      supplied: [],
      verifications: [],
      changeProposals: [],
      ...added,
    } as unknown as KnowledgeLedger;
  }
  if (r.version === 4 && phase2 && Array.isArray(r.deltas) && Array.isArray(r.supplied)) {
    return {
      ...r,
      version: LEDGER_VERSION,
      verifications: [],
      changeProposals: [],
      ...added,
    } as unknown as KnowledgeLedger;
  }
  const phase6 =
    phase2 &&
    Array.isArray(r.deltas) &&
    Array.isArray(r.supplied) &&
    Array.isArray(r.verifications);
  if (r.version === 5 && phase6) {
    return {
      ...r,
      version: LEDGER_VERSION,
      changeProposals: [],
      ...added,
    } as unknown as KnowledgeLedger;
  }
  const phase7 = phase6 && Array.isArray(r.changeProposals);
  if (r.version === 6 && phase7) {
    return { ...r, version: LEDGER_VERSION, ...added } as unknown as KnowledgeLedger;
  }
  const phase8 =
    phase7 && Array.isArray(r.acceptanceVerifications) && Array.isArray(r.changeRealizations);
  // Version 7 → 8 adds only the optional `Claim.scope`, so the upgrade is the
  // version number and nothing else. Every claim it carries stays unscoped.
  if (r.version === 7 && phase8) {
    return { ...r, version: LEDGER_VERSION } as unknown as KnowledgeLedger;
  }
  if (r.version === LEDGER_VERSION && phase8) {
    return r as unknown as KnowledgeLedger;
  }
  return null;
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
    const ledger = upgradeLedger(JSON.parse(text));
    if (!ledger) return { ok: false, ledger: emptyLedger() };
    return { ok: true, ledger };
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

/**
 * Add revision 1 of a claim, minting an id from its kind unless one was
 * proposed, and qualifying it with the claim's scope.
 *
 * `RULE-42` proposed in scope `project-a/git:…/kobra` becomes the canonical
 * `RULE-42.4f3a9c17`, so a second project may propose its own `RULE-42`
 * without either being able to name — or be mistaken for — the other's. An
 * unscoped claim keeps its proposed name exactly.
 */
export async function createClaim(input: ProposedClaim, now: Date): Promise<Claim> {
  return mutateLedger((ledger) => {
    let id: string;
    if (input.id) {
      id = qualifyClaimId(input.id, input.scope);
    } else {
      do id = qualifyClaimId(mint(KIND_PREFIX[input.kind]), input.scope);
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

/**
 * Record that a run consumed the given revisions, all in one transition so a
 * body that names an unknown claim writes nothing at all. Bare ids resolve to
 * the active revision at write time and are stored as that exact revision.
 * Already-recorded pairs are returned unchanged; `added` counts the new ones.
 */
export async function registerConsumptions(
  execution: RunExecutionRef,
  input: ProposedConsumptions,
  now: Date,
): Promise<{ execution: RunExecutionRef; consumptions: ClaimConsumption[]; added: number }> {
  return mutateLedger((ledger) => {
    const claims = input.claims.map((c, i) => resolveOrThrow(ledger, c, `claims[${i}]`));
    let next = ledger;
    let added = 0;
    const consumptions: ClaimConsumption[] = [];
    for (const claim of claims) {
      const r = recordConsumption(next, { execution, claim }, now.toISOString());
      next = r.ledger;
      if (r.added) added += 1;
      if (
        !consumptions.some((c) => c.claim.id === claim.id && c.claim.revision === claim.revision)
      ) {
        consumptions.push(r.consumption);
      }
    }
    const resolved = consumptions[0]?.execution ?? execution;
    return { ledger: next, result: { execution: resolved, consumptions, added } };
  });
}

/** Record the artifacts a run produced, all in one transition. */
export async function registerArtifacts(
  execution: RunExecutionRef,
  input: ProposedArtifacts,
  now: Date,
): Promise<{ execution: RunExecutionRef; artifacts: ArtifactProduction[]; added: number }> {
  return mutateLedger((ledger) => {
    let next = ledger;
    let added = 0;
    const artifacts: ArtifactProduction[] = [];
    for (const artifact of input.artifacts) {
      const r = recordArtifact(next, { execution, artifact }, now.toISOString());
      next = r.ledger;
      if (r.added) added += 1;
      if (
        !artifacts.some(
          (a) => a.artifact.location === artifact.location && a.artifact.path === artifact.path,
        )
      ) {
        artifacts.push(r.production);
      }
    }
    const resolved = artifacts[0]?.execution ?? execution;
    return { ledger: next, result: { execution: resolved, artifacts, added } };
  });
}

// ── Durable supplied provenance (Phase 4.1) ─────────────────────────────────

/**
 * Persist "Argus supplied exactly these revisions to run R", called from the
 * invocation lifecycle between writing the invocation record and spawning the
 * process. Idempotent on the run: the same record twice is `added: false`,
 * and a *different* context for the same run throws
 * {@link KnowledgeValidationError} rather than rewriting history.
 *
 * There is deliberately no HTTP mutation for this. Only Argus's own launch
 * path may assert what it supplied.
 */
export async function registerSuppliedContext(
  execution: RunExecutionRef,
  input: { claims: ClaimRef[]; sha256: string; attempt?: number; schemaVersion?: 1 },
  now: Date,
): Promise<{ supplied: SuppliedContext; added: boolean }> {
  return mutateLedger((ledger) => {
    const r = recordSuppliedContext(ledger, { execution, ...input }, now.toISOString());
    return { ledger: r.ledger, result: { supplied: r.supplied, added: r.added } };
  });
}

// ── KnowledgeDelta commit (Phase 3) ─────────────────────────────────────────

/**
 * Validate one or more staged proposals against the ledger *as it stands* —
 * the same preflight a commit runs — without writing anything. Used at
 * intake so a proposal that is already refusable (an unknown revision, a
 * precondition that no longer holds, a cycle) fails the step at once rather
 * than after a gate has waited on a human. Throws what the commit would.
 */
export async function preflightKnowledgeDeltas(
  proposals: DeltaProposal[],
  now: Date,
): Promise<void> {
  const ledger = await readLedger();
  applyKnowledgeDeltas(ledger, proposals, { now: now.toISOString(), mint });
}

/**
 * Commit a phase attempt's staged deltas as **one** ledger transition.
 *
 * Inside the ledger mutex: read the document, run every proposal through the
 * pure {@link applyKnowledgeDeltas} against that one snapshot, and write the
 * result once. A refusal anywhere throws before the write, so either every
 * record of every proposal is in `knowledge.json` or none is. Proposals the
 * ledger already lists in `deltas` are skipped (their results rebuilt), which
 * is what makes committing again after a crash safe.
 */
export async function commitKnowledgeDeltas(
  proposals: DeltaProposal[],
  now: Date,
): Promise<KnowledgeDeltaApplyResult[]> {
  return (await commitPhaseSemantics(proposals, [], now)).deltas;
}

// ── Rule-verification commit (Phase 6) ──────────────────────────────────────

/** One accepted conformance result with the execution provenance Argus binds
 *  to it. `id` is minted by the caller's commit, never by the agent. */
export type VerificationProposal = Omit<RecordVerificationInput, "id">;

/** One accepted acceptance-criterion result with the execution provenance
 *  Argus binds to it (Phase 8). `id` is minted by the commit, never by the
 *  agent, exactly as a rule verification's is. */
export type AcceptanceProposal = Omit<RecordAcceptanceInput, "id">;

export interface PhaseSemanticsResult {
  deltas: KnowledgeDeltaApplyResult[];
  verifications: RuleVerification[];
  /** The durable change-provenance records this commit wrote (Phase 7). */
  changeProposals: AcceptedChangeProposal[];
  /** The durable acceptance-criterion results this commit wrote (Phase 8). */
  acceptanceVerifications: AcceptanceVerification[];
}

/**
 * Commit a phase attempt's accepted semantics as **one** ledger transition:
 * its staged KnowledgeDeltas, its staged conformance results, and the change
 * proposals a person approved.
 *
 * Inside the ledger mutex: read the document, apply every delta proposal to
 * that one snapshot, append every verification, then record every accepted
 * change proposal, and write once. A refusal anywhere throws before the write,
 * so a phase that revises a rule, verifies one and records the request that
 * caused the revision leaves all three durable or none of them.
 *
 * The order is the dependency order, not a licence:
 *
 *   deltas → verifications → change proposals
 *
 * A verification may name a revision the same phase's delta just created, and
 * a change proposal's acceptance criteria must be resolved against exactly
 * what that delta minted — `local:r42` becomes `RULE-42:v2` here or the whole
 * transition is refused.
 *
 * Idempotent on all three: a delta already in `ledger.deltas` is skipped, a
 * verification whose `(runId, rule)` is recorded is a no-op, and a run that
 * already has an accepted change proposal keeps it. So committing again after
 * a crash between the ledger write and the instance write is safe.
 */
export async function commitPhaseSemantics(
  proposals: DeltaProposal[],
  verifications: VerificationProposal[],
  now: Date,
  acceptances: ChangeProposalAcceptance[] = [],
  acceptanceResults: AcceptanceProposal[] = [],
): Promise<PhaseSemanticsResult> {
  return mutateLedger((ledger) => {
    const { ledger: afterDeltas, results } = applyKnowledgeDeltas(ledger, proposals, {
      now: now.toISOString(),
      mint,
    });
    let next = afterDeltas;
    const recorded: RuleVerification[] = [];
    for (const v of verifications) {
      const working = next;
      let id: string;
      do id = mint("RV");
      while (working.verifications.some((x) => x.id === id));
      const r = recordRuleVerification(next, { ...v, id }, now.toISOString());
      next = r.ledger;
      recorded.push(r.verification);
    }
    // Change provenance last: its references may name revisions the deltas
    // above just minted, and resolving them needs the post-apply ledger.
    const changes: AcceptedChangeProposal[] = [];
    for (const acceptance of acceptances) {
      const applied = acceptance.deltaId
        ? (results.find((r) => r.deltaId === acceptance.deltaId) ?? null)
        : null;
      const r = recordChangeProposal(
        next,
        resolveChangeAcceptance(acceptance, applied, next),
        now.toISOString(),
      );
      next = r.ledger;
      changes.push(r.proposal);
    }
    // Acceptance criteria last of all: they name an accepted proposal, which
    // the step above may have just written, and the criterion's statement is
    // taken from *that* record rather than from the agent's document.
    const acceptancesOut: AcceptanceVerification[] = [];
    for (const a of acceptanceResults) {
      const working = next;
      let id: string;
      do id = mint("AV");
      while (working.acceptanceVerifications.some((x) => x.id === id));
      const r = recordAcceptanceVerification(next, { ...a, id }, now.toISOString());
      next = r.ledger;
      acceptancesOut.push(r.verification);
    }
    return {
      ledger: next,
      result: {
        deltas: results,
        verifications: recorded,
        changeProposals: changes,
        acceptanceVerifications: acceptancesOut,
      },
    };
  });
}

// ── Change realization (Phase 8) ────────────────────────────────────────────

/**
 * Open (or re-open idempotently) the realization one implementation phase
 * drives. Called at the phase attempt's launch, before any agent exists, so
 * "which run was intended to realize CP-12?" is answerable even if the run
 * then crashes.
 */
export async function openChangeRealization(
  input: Omit<StartRealizationInput, "id">,
  now: Date,
): Promise<{ realization: ChangeRealization; added: boolean }> {
  return mutateLedger((ledger) => {
    let id: string;
    do id = mint("CR");
    while (ledger.changeRealizations.some((r) => r.id === id));
    const r = startChangeRealization(ledger, { ...input, id }, now.toISOString());
    return { ledger: r.ledger, result: { realization: r.realization, added: r.added } };
  });
}

/** Append one attempt's verdict. Idempotent on the attempt number. */
export async function recordRealizationAttempt(
  realizationId: string,
  attempt: ChangeRealizationAttempt,
): Promise<ChangeRealization> {
  return mutateLedger((ledger) => {
    const r = appendRealizationAttempt(ledger, realizationId, attempt);
    return { ledger: r.ledger, result: r.realization };
  });
}

/** Write the realization's terminal verdict. Idempotent on an identical
 *  status; a different one is refused rather than rewriting a conclusion. */
export async function closeRealization(
  realizationId: string,
  outcome: ChangeRealizationOutcome,
): Promise<ChangeRealization> {
  return mutateLedger((ledger) => {
    const r = closeChangeRealization(ledger, realizationId, outcome);
    return { ledger: r.ledger, result: r.realization };
  });
}
