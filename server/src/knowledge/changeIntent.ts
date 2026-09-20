/**
 * Change-intent orchestration (Phase 7).
 *
 * Phase 5 read code and proposed the rules it appears to enforce. Phase 6
 * asked whether the code does what the rules say. Phase 7 starts from the
 * other end — somebody wants the business to work differently — and turns that
 * request into a structured, reviewable semantic transition:
 *
 *   ChangeRequest  +  current canonical knowledge  +  current conformance
 *     ↓ the agent reasons about the transition          changeIntentInstruction
 *     ↓ it writes one ChangeProposal                    parseChangeProposal
 *     ↓ Argus checks what it can check                  checkChangeProposal
 *     ↓ the gate shows request / current / proposed     previewChangeProposal
 *     ↓ a person approves                               (Phase 3 commit, unchanged)
 *     ↓ semanticDelta commits; the proposal is durable  resolveChangeAcceptance
 *   canonical semantics + change provenance
 *
 * Four things this module keeps apart, and never lets collapse:
 *
 * - **A request is not a rule.** `ChangeRequest.summary` is somebody's words.
 *   It is carried, frozen, on the accepted proposal and never written into the
 *   ledger as a claim.
 * - **An implementation is not an intent.** Conformance state reaches the
 *   agent as *input* and the reviewer as a *warning*. A proposal revises a
 *   rule because the request asked for it — never because the code happens to
 *   differ — and no verification is ever rewritten to make the past agree with
 *   the requested future.
 * - **An acceptance criterion is not a business rule.** A rule describes
 *   domain semantics; a criterion describes evidence that one change was
 *   carried out. Criteria live on the accepted proposal, outside the claim
 *   graph.
 * - **Change provenance is not justification.** "Which request caused this
 *   revision?" and "why is this claim supported?" are different questions with
 *   different records.
 *
 * Nothing here can write the ledger, and nothing here is a second acceptance
 * path: a proposal's `semanticDelta` is an ordinary staged KnowledgeDelta and
 * becomes canonical through exactly the Phase 3 commit boundary.
 */

import { chmod } from "node:fs/promises";
import path from "node:path";
import type {
  AcceptanceCriterion,
  AcceptanceCriterionKind,
  AcceptedChangeProposal,
  ChangeClaimRef,
  ChangeClaimSummary,
  ChangeContext,
  ChangeIntentInput,
  ChangeIntentPolicy,
  ChangeIntentSummary,
  ChangeProposal,
  ChangeProposalErrorCode,
  ChangeProposalPreview,
  ChangeProposalReadiness,
  ChangeProposalRecord,
  ChangeProposalWarning,
  ChangeProposalWarningCode,
  ChangeRequest,
  ChangeRuleState,
  ClaimKind,
  ClaimRef,
  KnowledgeDelta,
  KnowledgeDeltaApplyResult,
  KnowledgeDeltaRecord,
  ResolvedAcceptanceCriterion,
  ResolvedUnresolvedQuestion,
  RuleChangeDisposition,
  RuleClassification,
  UnresolvedQuestion,
} from "@argus/contracts";
import { atomicWriteFile } from "../sources/atomicWrite.js";
import { runInvocationDir } from "../sources/runs.js";
import {
  CLAIM_ID_RE,
  KnowledgeValidationError,
  evaluateSupport,
  formatClaimRef,
  getClaim,
  lifecycleOf,
  ruleConformance,
  sameRef,
  type KnowledgeLedger,
} from "./kernel.js";
import { validateKnowledgeDelta, exactClaimRef, deltaClaimRef } from "./delta.js";
import { previewKnowledgeDelta } from "./discovery.js";
import { NOTE_MAX_CHARS, optionalText, record, text } from "./validate.js";
import type { RecordChangeProposalInput } from "./kernel.js";

export const CHANGE_PROPOSAL_SCHEMA_VERSION = 1;
export const CHANGE_SUMMARY_MAX_CHARS = 2000;
export const CHANGE_DETAILS_MAX_CHARS = 8000;
export const CHANGE_STATEMENT_MAX_CHARS = 2000;
export const CHANGE_SECTION_MAX = 64;
export const CHANGE_SCOPE_MAX_PATHS = 32;
export const CHANGE_REQUEST_CONSTRAINTS_MAX = 32;
/** The default: only business rules must be accounted for. A context may carry
 *  facts and constraints to reason *with*, and a change need not classify each. */
export const DEFAULT_CHANGE_KINDS: readonly ClaimKind[] = ["business-rule"];

const CRITERION_KINDS: readonly AcceptanceCriterionKind[] = [
  "behavior",
  "invariant",
  "regression",
  "verification",
];
const DISPOSITIONS: readonly RuleChangeDisposition[] = [
  "revised",
  "preserved",
  "not-relevant",
  "unresolved",
];

/** A refused change proposal. Maps to the `change-proposal` failure class in
 *  the engine and to 400 over HTTP. */
export class ChangeProposalError extends KnowledgeValidationError {
  constructor(
    public readonly code: ChangeProposalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChangeProposalError";
  }
}

function fail(code: ChangeProposalErrorCode, msg: string): never {
  throw new ChangeProposalError(code, msg);
}

// ── The agent-facing contract ───────────────────────────────────────────────

/**
 * The reusable change-intent instructions — the one place the "what is a
 * change proposal?" contract is written, so an authored pipeline never has to
 * restate it.
 *
 * The four things it insists on are the four a model gets wrong by default:
 * that a request is not permission to invent a value, that an existing rule is
 * revised rather than duplicated, that what stays the same must be said out
 * loud, and that the code already differing from a rule is not a reason to
 * change the rule.
 */
export const CHANGE_INTENT_CONTRACT = [
  "Change-intent reasoning. This phase's job is to turn one explicitly requested business change",
  "into a structured, reviewable semantic proposal — and to STOP there. You are not implementing",
  "anything, not editing code, and not running anything. You are answering four questions:",
  "what business semantics are intended to change, what stays exactly as it is, what follows from",
  "that, and how anyone would know the change had been made correctly.",
  "",
  "Your inputs:",
  "- ARGUS_CHANGE_REQUEST_FILE — the requested change verbatim, plus, for every rule you are",
  "  accountable for, its current implementation conformance (holds / violated / unverifiable /",
  "  unverified at the repository revision under analysis).",
  "- ARGUS_KNOWLEDGE_CONTEXT_FILE — what the domain currently says: the exact canonical claim",
  "  revisions. This, not the request, is the record of current semantics.",
  "",
  "Write ONE JSON document to the path in ARGUS_CHANGE_PROPOSAL_FILE. Do not write a",
  "KnowledgeDelta file: a change-intent run proposes semantics only through this document.",
  "",
  "Document shape:",
  '{"schemaVersion":1,',
  ' "semanticDelta":{"schemaVersion":1,"revisions":[...],"claims":[...],"evidence":[...],',
  '                  "justifications":[...],"consumed":["RULE-42:v1"]},',
  ' "preserved":["CONSTRAINT-8:v1"],',
  ' "classification":[{"rule":"RULE-42:v1","disposition":"revised"}],',
  ' "acceptanceCriteria":[{"id":"AC-1","statement":"...","kind":"behavior",',
  '                       "relatesTo":[{"local":"r42"}],"verificationHint":"..."}],',
  ' "unresolved":[{"id":"Q-1","question":"..."}],',
  ' "metadata":{"summary":"one paragraph"}}',
  "",
  "semanticDelta — the only part that becomes canonical knowledge, and only after approval:",
  "- Revise, do not duplicate. When the request changes an existing rule you were given, propose",
  '  a REVISION of that exact claim: {"claimId":"RULE-42","expectedRevision":1,"statement":"...",',
  '  "localId":"r42","revisionNote":"why"}. Creating a second rule about the same thing is wrong.',
  "- Decisions. Where the change forces a choice the rules alone do not settle — which integration",
  "  it applies to, which boundary enforces it — propose a `decision` claim and justify it from",
  "  the revised rule plus the constraints it must respect. A decision is business or system",
  "  level; which class or helper to use is not durable semantic knowledge and does not belong",
  "  in the ledger.",
  "- New constraints. Only when the change genuinely introduces one.",
  "- Attach the request as evidence for what you propose:",
  '  {"type":"document","uri":"argus:change-request/<request id>","title":"<request summary>"}.',
  "",
  "preserved — exact revisions this change deliberately leaves untouched, and whose behaviour an",
  "implementation must not alter. Name existing revisions; never create a claim just to say that",
  "an existing rule is unchanged.",
  "",
  "classification — one entry for EVERY rule you were told you are accountable for, with",
  "disposition revised | preserved | not-relevant | unresolved. It must agree with your",
  "semanticDelta: `revised` means the delta revises it, and `preserved`/`not-relevant` mean it",
  "does not. Give a note for `not-relevant`. Silence about a supplied rule refuses the proposal.",
  "",
  "acceptanceCriteria — observable, checkable conditions that demonstrate the change was made:",
  '  AC-1 "a 500-character Kobra comment is accepted"        kind: behavior',
  '  AC-2 "a 501-character Kobra comment is rejected"        kind: behavior',
  '  AC-3 "non-Kobra comment limits are unchanged"           kind: regression',
  "They are NOT business rules and are not stored as claims. `relatesTo` names what each one is",
  "evidence for: a local id from your semanticDelta, or an exact existing revision.",
  "",
  "unresolved — where the request does not determine the answer, SAY SO. If a request asks to",
  '"increase the limit" without naming the new one, the correct output is an unresolved question,',
  "not a number you chose. A proposal with unresolved questions is not implementation-ready, and",
  "that is a better outcome than a confident guess.",
  "",
  "Current implementation state is context, never intent. If the code already violates a rule,",
  "that is a pre-existing defect: report it in your summary, and do not revise the rule for that",
  "reason. Revise a rule only because the requested change says the business semantics differ.",
].join("\n");

/** How one rule's current state reads in the prompt. */
function ruleLine(r: ChangeRuleState): string {
  return `${r.ref} (${r.support}, implementation ${r.conformance}${
    r.conformanceAt ? ` @${r.conformanceAt.slice(0, 8)}` : ""
  })`;
}

/**
 * The prompt block a change-intent step gets: the fixed contract, the request
 * in one line, and the exact rules it must account for with their current
 * conformance. Appended after the author's own prompt, like every other
 * Argus-owned instruction.
 */
export function changeIntentInstruction(
  policy: ChangeIntentPolicy | undefined,
  request: ChangeRequest | null,
  relevant: ChangeRuleState[],
): string {
  if (!policy) return "";
  const rules = relevant.length
    ? relevant.map(ruleLine).join(", ")
    : "(none — your context supplied no rules of the accountable kinds)";
  const criteria =
    (policy.acceptanceCriteria ?? "required") === "warn"
      ? "A proposed business-rule change with no acceptance criterion is flagged for the reviewer."
      : "Every proposed business-rule change MUST carry at least one acceptance criterion " +
        "referencing it; one that does not is refused and fails this step.";
  const note = policy.note ? `\n${policy.note}` : "";
  const summary = request ? `\n\nRequested change: ${request.summary}` : "";
  return (
    `\n\n${CHANGE_INTENT_CONTRACT}${summary}\n\n` +
    `Rules you must classify: ${rules}. ${criteria}${note}`
  );
}

// ── Policy helpers ──────────────────────────────────────────────────────────

/** The claim kinds this policy asks for a classification on. */
export function changeIntentKinds(policy: ChangeIntentPolicy | undefined): readonly ClaimKind[] {
  return policy?.kinds?.length ? policy.kinds : DEFAULT_CHANGE_KINDS;
}

/**
 * Which of the revisions Argus supplied to a run the change phase must account
 * for. Derived from the supplied context and the ledger, never from anything
 * the agent wrote: accountability is fixed before the run starts, exactly as
 * it is for a verification phase.
 */
export function selectedChangeRules(
  ledger: KnowledgeLedger | null,
  supplied: ClaimRef[] | undefined,
  policy: ChangeIntentPolicy | undefined,
): ClaimRef[] {
  const kinds = changeIntentKinds(policy);
  const out: ClaimRef[] = [];
  for (const ref of supplied ?? []) {
    const claim = ledger ? getClaim(ledger, ref) : null;
    if (!claim || !kinds.includes(claim.kind)) continue;
    if (!out.some((r) => sameRef(r, ref))) out.push({ id: ref.id, revision: ref.revision });
  }
  return out;
}

// ── The request ─────────────────────────────────────────────────────────────

const REQUEST_ID_RE = CLAIM_ID_RE;

/**
 * An authored or supplied {@link ChangeRequest}, validated.
 *
 * Accepted from two places — a phase's `changeIntent.request` and an
 * instance's trigger payload — and validated identically by both, so a request
 * that arrives with a manual start is held to the same shape as one written
 * into a pipeline.
 */
export function validateChangeRequest(raw: unknown, ctx: string): ChangeRequest {
  const r = record(raw, ctx);
  const out: ChangeRequest = {
    id: "",
    summary: text(r.summary, `${ctx}.summary`, CHANGE_SUMMARY_MAX_CHARS),
  };
  if (r.id !== undefined && r.id !== null) {
    if (typeof r.id !== "string" || !REQUEST_ID_RE.test(r.id)) {
      fail("schema", `${ctx}.id is not a valid change-request id`);
    }
    out.id = r.id;
  }
  const details = optionalText(r.details, `${ctx}.details`, CHANGE_DETAILS_MAX_CHARS);
  if (details) out.details = details;
  const requestedBy = optionalText(r.requestedBy, `${ctx}.requestedBy`, NOTE_MAX_CHARS);
  if (requestedBy) out.requestedBy = requestedBy;
  const receivedAt = optionalText(r.receivedAt, `${ctx}.receivedAt`, NOTE_MAX_CHARS);
  if (receivedAt) out.receivedAt = receivedAt;
  if (r.scope !== undefined && r.scope !== null) {
    const s = record(r.scope, `${ctx}.scope`);
    const scope: NonNullable<ChangeRequest["scope"]> = {};
    if (s.paths !== undefined && s.paths !== null) {
      if (!Array.isArray(s.paths) || s.paths.length > CHANGE_SCOPE_MAX_PATHS) {
        fail(
          "schema",
          `${ctx}.scope.paths must be a list of at most ${CHANGE_SCOPE_MAX_PATHS} paths`,
        );
      }
      scope.paths = s.paths.map((p, i) => text(p, `${ctx}.scope.paths[${i}]`, NOTE_MAX_CHARS));
    }
    const label = optionalText(s.label, `${ctx}.scope.label`, NOTE_MAX_CHARS);
    if (label) scope.label = label;
    const note = optionalText(s.note, `${ctx}.scope.note`, CHANGE_SUMMARY_MAX_CHARS);
    if (note) scope.note = note;
    if (Object.keys(scope).length > 0) out.scope = scope;
  }
  if (r.claims !== undefined && r.claims !== null) {
    if (!Array.isArray(r.claims) || r.claims.length > CHANGE_SECTION_MAX) {
      fail("schema", `${ctx}.claims must be a list of at most ${CHANGE_SECTION_MAX} claim refs`);
    }
    out.claims = r.claims.map((c, i) => exactChangeRef(c, `${ctx}.claims[${i}]`));
  }
  if (r.constraints !== undefined && r.constraints !== null) {
    if (!Array.isArray(r.constraints) || r.constraints.length > CHANGE_REQUEST_CONSTRAINTS_MAX) {
      fail(
        "schema",
        `${ctx}.constraints must be a list of at most ${CHANGE_REQUEST_CONSTRAINTS_MAX} lines`,
      );
    }
    out.constraints = r.constraints.map((v, i) =>
      text(v, `${ctx}.constraints[${i}]`, CHANGE_STATEMENT_MAX_CHARS),
    );
  }
  return out;
}

/** An exact existing revision, refusing a bare id for the usual reason: a
 *  reference that could be retargeted by a later revision. */
function exactChangeRef(raw: unknown, ctx: string): ClaimRef {
  try {
    return exactClaimRef(raw, ctx);
  } catch (e) {
    fail("schema", e instanceof Error ? e.message : String(e));
  }
}

/** Give a request an identity when its author did not: stable within one
 *  phase attempt, so two runs of the same attempt answer the same request. */
export function requestWithIdentity(
  request: ChangeRequest,
  fallbackId: string,
  now: string,
): ChangeRequest {
  return {
    ...request,
    id: request.id && REQUEST_ID_RE.test(request.id) ? request.id : fallbackId,
    receivedAt: request.receivedAt ?? now,
  };
}

// ── Validation of the agent's document ──────────────────────────────────────

function changeRef(raw: unknown, ctx: string): ChangeClaimRef {
  try {
    return deltaClaimRef(raw, ctx);
  } catch (e) {
    fail("schema", e instanceof Error ? e.message : String(e));
  }
}

function acceptanceCriterion(raw: unknown, ctx: string): AcceptanceCriterion {
  const r = record(raw, ctx);
  if (typeof r.id !== "string" || !CLAIM_ID_RE.test(r.id)) {
    fail("schema", `${ctx}.id is not a valid acceptance-criterion id`);
  }
  if (typeof r.kind !== "string" || !CRITERION_KINDS.includes(r.kind as AcceptanceCriterionKind)) {
    fail("schema", `${ctx}.kind must be one of ${CRITERION_KINDS.join(" | ")}`);
  }
  if (!Array.isArray(r.relatesTo) || r.relatesTo.length === 0) {
    fail("schema", `${ctx}.relatesTo must name at least one proposed or existing claim`);
  }
  if (r.relatesTo.length > CHANGE_SECTION_MAX) {
    fail("schema", `${ctx}.relatesTo exceeds ${CHANGE_SECTION_MAX} entries`);
  }
  const out: AcceptanceCriterion = {
    id: r.id,
    statement: text(r.statement, `${ctx}.statement`, CHANGE_STATEMENT_MAX_CHARS),
    kind: r.kind as AcceptanceCriterionKind,
    relatesTo: r.relatesTo.map((v, i) => changeRef(v, `${ctx}.relatesTo[${i}]`)),
  };
  const hint = optionalText(r.verificationHint, `${ctx}.verificationHint`, NOTE_MAX_CHARS);
  if (hint) out.verificationHint = hint;
  return out;
}

function unresolvedQuestion(raw: unknown, ctx: string): UnresolvedQuestion {
  const r = record(raw, ctx);
  if (typeof r.id !== "string" || !CLAIM_ID_RE.test(r.id)) {
    fail("schema", `${ctx}.id is not a valid question id`);
  }
  const out: UnresolvedQuestion = {
    id: r.id,
    question: text(r.question, `${ctx}.question`, CHANGE_STATEMENT_MAX_CHARS),
  };
  if (r.blocks !== undefined && r.blocks !== null) {
    if (!Array.isArray(r.blocks) || r.blocks.length > CHANGE_SECTION_MAX) {
      fail("schema", `${ctx}.blocks must be a list of at most ${CHANGE_SECTION_MAX} references`);
    }
    out.blocks = r.blocks.map((v, i) => changeRef(v, `${ctx}.blocks[${i}]`));
  }
  const note = optionalText(r.note, `${ctx}.note`, NOTE_MAX_CHARS);
  if (note) out.note = note;
  return out;
}

function classification(raw: unknown, ctx: string): RuleClassification {
  const r = record(raw, ctx);
  if (
    typeof r.disposition !== "string" ||
    !DISPOSITIONS.includes(r.disposition as RuleChangeDisposition)
  ) {
    fail("schema", `${ctx}.disposition must be one of ${DISPOSITIONS.join(" | ")}`);
  }
  const out: RuleClassification = {
    rule: exactChangeRef(r.rule, `${ctx}.rule`),
    disposition: r.disposition as RuleChangeDisposition,
  };
  const note = optionalText(r.note, `${ctx}.note`, NOTE_MAX_CHARS);
  if (note) out.note = note;
  return out;
}

function list<T>(raw: unknown, name: string, item: (v: unknown, ctx: string) => T): T[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("schema", `${name} must be an array`);
  if (raw.length > CHANGE_SECTION_MAX) {
    fail("schema", `${name} exceeds ${CHANGE_SECTION_MAX} entries`);
  }
  return raw.map((v, i) => item(v, `${name}[${i}]`));
}

/**
 * Untrusted document → typed {@link ChangeProposal}, or a
 * {@link ChangeProposalError}.
 *
 * Structural only: nothing here consults a ledger. The nested `semanticDelta`
 * is validated by the delta validator itself, unchanged, so a change proposal
 * can never smuggle in a delta shape the KnowledgeDelta protocol would refuse.
 */
export function validateChangeProposal(raw: unknown): ChangeProposal {
  let r: Record<string, unknown>;
  try {
    r = record(raw, "proposal");
  } catch (e) {
    fail("schema", e instanceof Error ? e.message : String(e));
  }
  if (r.schemaVersion !== CHANGE_PROPOSAL_SCHEMA_VERSION) {
    fail(
      "schema",
      `schemaVersion must be ${CHANGE_PROPOSAL_SCHEMA_VERSION} (got ${JSON.stringify(r.schemaVersion)})`,
    );
  }
  const out: ChangeProposal = { schemaVersion: CHANGE_PROPOSAL_SCHEMA_VERSION };
  if (r.semanticDelta !== undefined && r.semanticDelta !== null) {
    try {
      out.semanticDelta = validateKnowledgeDelta(r.semanticDelta);
    } catch (e) {
      fail("delta", `semanticDelta: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (r.preserved !== undefined && r.preserved !== null) {
    if (!Array.isArray(r.preserved) || r.preserved.length > CHANGE_SECTION_MAX) {
      fail("schema", `preserved must be a list of at most ${CHANGE_SECTION_MAX} exact revisions`);
    }
    out.preserved = r.preserved.map((v, i) => exactChangeRef(v, `preserved[${i}]`));
  }
  const criteria = list(r.acceptanceCriteria, "acceptanceCriteria", acceptanceCriterion);
  if (criteria.length) out.acceptanceCriteria = criteria;
  const questions = list(r.unresolved, "unresolved", unresolvedQuestion);
  if (questions.length) out.unresolved = questions;
  const classes = list(r.classification, "classification", classification);
  if (classes.length) out.classification = classes;

  // Local uniqueness, so a reviewer and a resolver can key on these ids.
  const dupe = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) fail("schema", `${what} id "${id}" appears twice`);
      seen.add(id);
    }
  };
  dupe(
    "acceptanceCriteria",
    criteria.map((c) => c.id),
  );
  dupe(
    "unresolved",
    questions.map((q) => q.id),
  );
  const classified = new Set<string>();
  for (const c of classes) {
    const key = formatClaimRef(c.rule);
    if (classified.has(key)) fail("schema", `classification names ${key} twice`);
    classified.add(key);
  }
  if (r.metadata !== undefined && r.metadata !== null) {
    const m = record(r.metadata, "metadata");
    const summary = optionalText(m.summary, "metadata.summary", CHANGE_SUMMARY_MAX_CHARS);
    if (summary) out.metadata = { summary };
  }
  return out;
}

/** Parse the agent's file text and validate it. `invalid-json` names the parse
 *  failure distinctly from a well-formed document of the wrong shape. */
export function parseChangeProposal(rawText: string): ChangeProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    fail("invalid-json", `not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateChangeProposal(parsed);
}

// ── Deterministic checks against the run's world ────────────────────────────

/** What a change-proposal check needs to know about the run that wrote it. */
export interface ChangeIntentContext {
  policy: ChangeIntentPolicy;
  /** The request the run was given, frozen at launch. */
  request: ChangeRequest;
  /** The exact rules Argus supplied and requires a classification for. */
  selected: ClaimRef[];
  /** The repository revision conformance is scoped to, as Argus recorded it. */
  gitHead: string | null;
}

function warn(
  code: ChangeProposalWarningCode,
  subject: string,
  message: string,
): ChangeProposalWarning {
  return { code, subject, message };
}

const isLocal = (r: ChangeClaimRef): r is { local: string } => "local" in r;

/** Every delta-local id the proposal's semantic delta declares. */
export function localIdsOf(delta: KnowledgeDelta | undefined): Set<string> {
  const out = new Set<string>();
  for (const c of delta?.claims ?? []) out.add(c.localId);
  for (const r of delta?.revisions ?? []) if (r.localId) out.add(r.localId);
  return out;
}

/** The exact revision a proposed revision would create. */
const nextRef = (claimId: string, expected: number): ClaimRef => ({
  id: claimId,
  revision: expected + 1,
});

/** Does this reference point at the semantic change `target` describes? */
function refersTo(ref: ChangeClaimRef, target: BusinessRuleChange): boolean {
  return isLocal(ref)
    ? target.local !== undefined && ref.local === target.local
    : target.ref !== undefined && sameRef(ref, target.ref);
}

/**
 * Everything deterministic Argus can say about a change proposal, from the
 * proposal, the ledger and the conformance records alone.
 *
 * Never from similarity, never from a model's opinion, and never from the
 * implementation's *intent*: conformance appears here only as a warning about
 * what is currently true of the code, which is a fact, and never as a reason
 * to revise anything.
 */
export function changeProposalWarnings(
  proposal: ChangeProposal,
  ledger: KnowledgeLedger | null,
  ctx: ChangeIntentContext,
): ChangeProposalWarning[] {
  const out: ChangeProposalWarning[] = [];
  const delta = proposal.semanticDelta;
  const revisions = delta?.revisions ?? [];
  const newClaims = delta?.claims ?? [];
  const revisedIds = new Set(revisions.map((r) => r.claimId));
  const classes = proposal.classification ?? [];
  const preserved = proposal.preserved ?? [];
  const criteria = proposal.acceptanceCriteria ?? [];
  const questions = proposal.unresolved ?? [];

  // 1. Every rule this run was made accountable for is accounted for. Silence
  //    about a supplied rule is indistinguishable from not having looked.
  for (const rule of ctx.selected) {
    const key = formatClaimRef(rule);
    const entry = classes.find((c) => sameRef(c.rule, rule));
    if (!entry) {
      out.push(
        warn(
          "selected-rule-unclassified",
          key,
          `${key} was supplied to this run as a relevant rule but the proposal does not classify it as revised, preserved, not-relevant or unresolved`,
        ),
      );
      continue;
    }
    // 2. The accounting and the proposal must describe the same change.
    const revised = revisedIds.has(rule.id);
    if (entry.disposition === "revised" && !revised) {
      out.push(
        warn(
          "classification-mismatch",
          key,
          `${key} is classified "revised" but the proposal's semanticDelta revises no claim "${rule.id}"`,
        ),
      );
    }
    if ((entry.disposition === "preserved" || entry.disposition === "not-relevant") && revised) {
      out.push(
        warn(
          "classification-mismatch",
          key,
          `${key} is classified "${entry.disposition}" but the proposal's semanticDelta revises it`,
        ),
      );
    }
  }

  // 3. Preserved and revised are contradictory statements about one claim.
  for (const ref of preserved) {
    if (revisedIds.has(ref.id)) {
      const key = formatClaimRef(ref);
      out.push(
        warn(
          "preserved-and-revised",
          key,
          `${key} is listed as preserved while the proposal's semanticDelta revises ${ref.id}`,
        ),
      );
    }
  }

  // 4. Acceptance criteria must reference something that will exist.
  const locals = localIdsOf(delta);
  for (const criterion of criteria) {
    for (const ref of criterion.relatesTo) {
      if (isLocal(ref)) {
        if (!locals.has(ref.local)) {
          out.push(
            warn(
              "acceptance-criterion-unknown-ref",
              criterion.id,
              `acceptance criterion ${criterion.id} names local id "${ref.local}", which the proposal's semanticDelta does not declare`,
            ),
          );
        }
        continue;
      }
      if (ledger && !getClaim(ledger, ref)) {
        out.push(
          warn(
            "acceptance-criterion-unknown-ref",
            criterion.id,
            `acceptance criterion ${criterion.id} names unknown claim revision ${formatClaimRef(ref)}`,
          ),
        );
      }
    }
  }

  // 5. Every proposed business-rule change needs a way to judge success.
  for (const target of businessRuleChanges(proposal, ledger)) {
    const covered = criteria.some((c) => c.relatesTo.some((r) => refersTo(r, target)));
    if (!covered) {
      out.push(
        warn(
          "acceptance-criteria-missing",
          target.display,
          `the proposed business-rule change ${target.display} carries no acceptance criterion; there would be no observable way to judge whether it had been implemented`,
        ),
      );
    }
  }

  // 6. A request that produced no semantic difference at all.
  if (revisions.length === 0 && newClaims.length === 0) {
    out.push(
      warn(
        "no-semantic-change",
        ctx.request.id,
        `the proposal makes no semantic change: the requested change "${ctx.request.summary}" results in no revised or new claim`,
      ),
    );
  }

  // 7. Unresolved questions: honest, and not implementation-ready.
  if (questions.length > 0) {
    out.push(
      warn(
        "unresolved-questions",
        questions.map((q) => q.id).join(", "),
        `${questions.length} question${questions.length === 1 ? " is" : "s are"} unresolved, so this proposal is not implementation-ready: ${questions.map((q) => q.question).join(" · ")}`,
      ),
    );
  }

  // 8. What the implementation currently does. Exact RuleVerification state,
  //    never speculation — and never a reason to change a rule.
  if (ledger) {
    for (const rule of ctx.selected) {
      const key = formatClaimRef(rule);
      const conf = ruleConformance(ledger, rule, ctx.gitHead ?? undefined);
      const at = ctx.gitHead ? ` at ${ctx.gitHead.slice(0, 8)}` : "";
      if (conf.status === "violated") {
        out.push(
          revisedIds.has(rule.id)
            ? warn(
                "change-may-be-implemented",
                key,
                `the implementation${at} already violates ${key}, which this proposal revises: the code may already behave as the request asks. The rule is revised because of the request, not because of the code, and the recorded violation of ${key} stands.`,
              )
            : warn(
                "implementation-already-violates",
                key,
                `the implementation${at} already violates ${key}, which this proposal does not revise: a pre-existing defect this change does not address`,
              ),
        );
      } else if (conf.status === "unverified") {
        out.push(
          warn(
            "implementation-unverified",
            key,
            `no accepted verification of ${key}${at}: nothing is known about whether the implementation does what this rule says`,
          ),
        );
      }
    }
    // 9. The request pointed at something the ledger does not hold.
    for (const ref of ctx.request.claims ?? []) {
      if (!getClaim(ledger, ref)) {
        out.push(
          warn(
            "request-claim-unknown",
            formatClaimRef(ref),
            `the change request names ${formatClaimRef(ref)}, which the ledger does not hold`,
          ),
        );
      }
    }
  }
  return out;
}

/** One proposed semantic change to a business rule, in the two forms it can
 *  take: a revision of an existing rule, or a brand-new rule. */
interface BusinessRuleChange {
  display: string;
  /** The delta-local id, when the proposal gave the change one. */
  local?: string;
  /** The exact revision the change would create. A *new* rule has none: it
   *  has no canonical identity until the commit mints one, so only a local
   *  reference can name it. */
  ref?: ClaimRef;
}

function businessRuleChanges(
  proposal: ChangeProposal,
  ledger: KnowledgeLedger | null,
): BusinessRuleChange[] {
  const delta = proposal.semanticDelta;
  const out: BusinessRuleChange[] = [];
  for (const rev of delta?.revisions ?? []) {
    // A revision does not carry a kind — it cannot change one — so the kind is
    // the ledger's. With no ledger (a preview on a pruned snapshot) the
    // revision is treated as a rule change, which errs towards asking for
    // criteria rather than towards silently not asking.
    const active = ledger
      ? getClaim(ledger, { id: rev.claimId, revision: rev.expectedRevision })
      : null;
    if (ledger && active && active.kind !== "business-rule") continue;
    const ref = nextRef(rev.claimId, rev.expectedRevision);
    out.push({
      display: `${rev.claimId} v${rev.expectedRevision} → v${rev.expectedRevision + 1}`,
      ...(rev.localId ? { local: rev.localId } : {}),
      ref,
    });
  }
  for (const claim of delta?.claims ?? []) {
    if (claim.kind !== "business-rule") continue;
    out.push({ display: `local:${claim.localId}`, local: claim.localId });
  }
  return out;
}

/**
 * Which warnings refuse a change proposal outright, rather than flagging it.
 *
 * Everything Argus can *prove* inconsistent about the proposal is fatal: a
 * supplied rule left unaccounted for, an accounting that contradicts the
 * proposal, a claim both preserved and revised, a criterion pointing at
 * nothing. Everything that is a judgement for a person — an unresolved
 * question, a pre-existing defect, a change that turns out to be a no-op — is
 * a warning, because refusing it would be Argus deciding the semantics.
 *
 * `acceptanceCriteria: "warn"` downgrades exactly one code, and nothing else:
 * an author may choose to see an uncovered rule change at the gate, but the
 * proposal then reads `needs-input` rather than `ready`.
 */
export function fatalChangeWarnings(
  warnings: ChangeProposalWarning[],
  policy: ChangeIntentPolicy,
): ChangeProposalWarning[] {
  const criteriaRequired = (policy.acceptanceCriteria ?? "required") !== "warn";
  return warnings.filter((w) => {
    switch (w.code) {
      case "selected-rule-unclassified":
      case "classification-mismatch":
      case "preserved-and-revised":
      case "acceptance-criterion-unknown-ref":
        return true;
      case "acceptance-criteria-missing":
        return criteriaRequired;
      default:
        return false;
    }
  });
}

/**
 * Whether the proposal is fit to drive an implementation, decided
 * deterministically from the proposal and its warnings — never asserted by
 * the agent.
 *
 * `needs-input` on any of: an unresolved question, a rule the proposal could
 * not decide about, or a business-rule change with no acceptance criteria
 * (reachable only under `acceptanceCriteria: "warn"`, since it is otherwise a
 * refusal). Fail-closed: anything Argus is unsure about reads `needs-input`.
 */
export function changeReadiness(
  proposal: ChangeProposal,
  warnings: ChangeProposalWarning[],
): ChangeProposalReadiness {
  if ((proposal.unresolved ?? []).length > 0) return "needs-input";
  if ((proposal.classification ?? []).some((c) => c.disposition === "unresolved")) {
    return "needs-input";
  }
  if (warnings.some((w) => w.code === "acceptance-criteria-missing")) return "needs-input";
  return "ready";
}

/**
 * The one sentence a refused change proposal carries, plus the warnings and
 * readiness the staged record keeps. Non-fatal warnings travel to the gate on
 * the preview, where a person can weigh them.
 */
export function checkChangeProposal(
  proposal: ChangeProposal,
  ledger: KnowledgeLedger | null,
  ctx: ChangeIntentContext,
): {
  warnings: ChangeProposalWarning[];
  readiness: ChangeProposalReadiness;
  refusal: { code: ChangeProposalErrorCode; message: string } | null;
} {
  const warnings = changeProposalWarnings(proposal, ledger, ctx);
  const fatal = fatalChangeWarnings(warnings, ctx.policy);
  const readiness = changeReadiness(proposal, warnings);
  if (fatal.length === 0) return { warnings, readiness, refusal: null };
  const code: ChangeProposalErrorCode = fatal.some((f) => f.code === "selected-rule-unclassified")
    ? "incomplete"
    : fatal.some((f) => f.code === "acceptance-criteria-missing")
      ? "acceptance-criteria"
      : fatal.some((f) => f.code === "acceptance-criterion-unknown-ref")
        ? "local-reference"
        : "contradiction";
  return {
    warnings,
    readiness,
    refusal: { code, message: fatal.map((f) => f.message).join("; ") },
  };
}

// ── The agent-facing input: request + current conformance ───────────────────

/**
 * One rule's current state: what the business says, whether that is well
 * founded, and whether the code does it — the last scoped to the repository
 * revision under analysis.
 *
 * The two halves never merge. `unverified` means nobody looked at this commit;
 * it is not "fine", and it is not `unverifiable` (somebody looked and could
 * not tell). Reporting either as the other would invent or destroy an
 * investigation.
 */
export function changeRuleState(
  ledger: KnowledgeLedger,
  ref: ClaimRef,
  gitHead: string | null,
): ChangeRuleState | null {
  const claim = getClaim(ledger, ref);
  if (!claim) return null;
  const conf = ruleConformance(ledger, ref, gitHead ?? undefined);
  return {
    ref: formatClaimRef(ref),
    claim: { id: ref.id, revision: ref.revision },
    kind: claim.kind,
    statement: claim.statement,
    support: evaluateSupport(ledger, ref),
    lifecycle: lifecycleOf(ledger, ref),
    conformance: conf.status,
    ...(conf.latest?.repository?.gitHead ? { conformanceAt: conf.latest.repository.gitHead } : {}),
    ...(conf.latest ? { verifiedAt: conf.latest.createdAt } : {}),
  };
}

/** The current state of every rule a change-intent run must account for. */
export function changeRuleStates(
  ledger: KnowledgeLedger | null,
  selected: ClaimRef[],
  gitHead: string | null,
): ChangeRuleState[] {
  if (!ledger) return [];
  return selected.flatMap((ref) => {
    const state = changeRuleState(ledger, ref, gitHead);
    return state ? [state] : [];
  });
}

/**
 * Build the read-only document a change-intent run receives as
 * `ARGUS_CHANGE_REQUEST_FILE`.
 *
 * Deliberately narrow. It carries the request verbatim and the current
 * conformance of the accountable rules — the two things the agent has no other
 * way to know — and nothing else. Current *semantics* arrive through the
 * ordinary KnowledgeContext, so there is exactly one channel for "what the
 * ledger holds" and a request can never become a place to restate it.
 */
export function buildChangeIntentInput(
  ledger: KnowledgeLedger | null,
  request: ChangeRequest,
  selected: ClaimRef[],
  gitHead: string | null,
  now: string,
): { input: ChangeIntentInput; relevant: ChangeRuleState[]; text: string } {
  const relevant = changeRuleStates(ledger, selected, gitHead);
  const input: ChangeIntentInput = {
    schemaVersion: 1,
    generatedAt: now,
    request,
    relevant,
    ...(gitHead ? { gitHead } : {}),
  };
  return { input, relevant, text: `${JSON.stringify(input, null, 2)}\n` };
}

/** The path handed to the agent as `ARGUS_CHANGE_REQUEST_FILE`: inside the
 *  run's own invocation directory, never shared between runs. */
export function changeRequestFile(runId: string): string {
  return path.join(runInvocationDir(runId), "change-request.json");
}

/** The path handed to a downstream run as `ARGUS_CHANGE_CONTEXT_FILE`. */
export function changeContextFile(runId: string): string {
  return path.join(runInvocationDir(runId), "change-context.json");
}

/** Materialize a read-only Argus-owned input: atomic write, then `0444`. The
 *  mode guards against an accidental overwrite by the agent's own tools; it is
 *  not a security boundary (the runtime's sandbox is). */
export async function writeReadOnlyInput(file: string, text: string): Promise<void> {
  await atomicWriteFile(file, text);
  try {
    await chmod(file, 0o444);
  } catch {
    // A filesystem without POSIX modes: the record of what was written stands.
  }
}

// ── The downstream handoff ──────────────────────────────────────────────────

/**
 * The {@link ChangeContext} a later implementation run receives: what this
 * change intends to make true, what must stay true, and how success is judged.
 *
 * **References, not restatements.** `semanticChanges` names `RULE-42:v2`; what
 * RULE-42:v2 says arrives through the run's KnowledgeContext. A second copy of
 * a claim's sentence in a second file is a second thing to drift, and the
 * whole point of the ledger is that there is one.
 *
 * Built only from an {@link AcceptedChangeProposal}, which exists only in the
 * ledger, which is written only at the commit boundary — so a staged proposal
 * cannot reach a downstream run by construction.
 */
export function buildChangeContext(
  accepted: AcceptedChangeProposal,
  now: string,
): { context: ChangeContext; text: string } {
  const context: ChangeContext = {
    schemaVersion: 1,
    generatedAt: now,
    proposalId: accepted.id,
    request: accepted.request,
    readiness: accepted.readiness,
    semanticChanges: accepted.semanticChanges,
    revised: accepted.revised,
    created: accepted.created,
    decisions: accepted.decisions,
    constraints: accepted.constraints,
    preserved: accepted.preserved,
    acceptanceCriteria: accepted.acceptanceCriteria,
    unresolved: accepted.unresolved,
  };
  return { context, text: `${JSON.stringify(context, null, 2)}\n` };
}

/**
 * The instruction a step gets when Argus supplied it a ChangeContext. Says
 * what the file is, what it is *not* (a licence to change anything else), and
 * that the acceptance criteria are how the work will be judged.
 */
export function changeContextInstruction(accepted: AcceptedChangeProposal | null): string {
  if (!accepted) return "";
  const criteria = accepted.acceptanceCriteria
    .map((c) => `${c.id} (${c.kind}) ${c.statement}`)
    .join("; ");
  return (
    "\n\nAccepted change intent. Argus has written the approved ChangeProposal for this run to " +
    "the path in the ARGUS_CHANGE_CONTEXT_FILE environment variable. It names, as exact " +
    "canonical references, the claim revisions this change introduced, the revisions it " +
    "deliberately preserved, the decisions that follow, and the acceptance criteria your work " +
    "will be judged by. What those claims SAY is in your KnowledgeContext; the change context " +
    "names them, it does not restate them.\n" +
    `Requested change: ${accepted.request.summary}\n` +
    (criteria ? `Acceptance criteria: ${criteria}\n` : "") +
    "Change only what the accepted intent requires. A revision that is listed as preserved must " +
    "keep behaving exactly as it does."
  );
}

// ── Resolution at the acceptance boundary ───────────────────────────────────

/**
 * One accepted change proposal as the commit receives it: everything decided
 * at the gate, with its claim references still possibly **local** to the delta
 * that is about to be applied.
 *
 * They cannot be resolved earlier. `AC-1 relates to local:r42` means "the
 * revision this same commit is about to mint", and that revision does not
 * exist until the delta is applied — which happens inside the commit's single
 * ledger transition, on that snapshot.
 */
export interface ChangeProposalAcceptance extends Omit<
  RecordChangeProposalInput,
  | "semanticChanges"
  | "revised"
  | "created"
  | "decisions"
  | "constraints"
  | "acceptanceCriteria"
  | "unresolved"
> {
  /** The proposal's own criteria and questions, references not yet resolved. */
  acceptanceCriteria: AcceptanceCriterion[];
  unresolved: UnresolvedQuestion[];
}

/**
 * Turn a staged acceptance into the durable record, resolving every
 * delta-local reference against what the commit actually minted.
 *
 * This is the moment `local:r42` stops existing. `AC-1 relates to local:r42`
 * becomes `AC-1 relates to RULE-42:v2`, and a local id the delta did not
 * create throws — refusing the whole transition rather than persisting a label
 * that points at nothing. After this function nothing downstream ever sees a
 * local reference, which is exactly the guarantee a later implementation run
 * needs in order to act on exact revisions.
 */
export function resolveChangeAcceptance(
  acceptance: ChangeProposalAcceptance,
  applied: KnowledgeDeltaApplyResult | null,
  ledger: KnowledgeLedger,
): RecordChangeProposalInput {
  const locals = new Map<string, ClaimRef>();
  for (const c of applied?.createdClaims ?? []) locals.set(c.localId, c.claim);
  for (const r of applied?.createdRevisions ?? []) if (r.localId) locals.set(r.localId, r.claim);

  const created = (applied?.createdClaims ?? []).map((c) => c.claim);
  const revised = (applied?.createdRevisions ?? []).map((r) => ({
    from: r.supersedes,
    to: r.claim,
  }));
  // Commit order: the delta applies new claims first, then revisions.
  const semanticChanges = [...created, ...revised.map((r) => r.to)];
  const ofKind = (kind: ClaimKind) => created.filter((ref) => getClaim(ledger, ref)?.kind === kind);

  const resolve = (ref: ChangeClaimRef, ctx: string): ClaimRef => {
    if (!isLocal(ref)) return { id: ref.id, revision: ref.revision };
    const got = locals.get(ref.local);
    if (!got) {
      throw new KnowledgeValidationError(
        `change proposal ${acceptance.id}: ${ctx} names local id "${ref.local}", which this commit did not create`,
      );
    }
    return got;
  };

  return {
    id: acceptance.id,
    request: acceptance.request,
    execution: acceptance.execution,
    attempt: acceptance.attempt,
    deltaId: acceptance.deltaId,
    readiness: acceptance.readiness,
    semanticChanges,
    revised,
    created,
    decisions: ofKind("decision"),
    constraints: ofKind("constraint"),
    preserved: acceptance.preserved.map((r) => ({ id: r.id, revision: r.revision })),
    acceptanceCriteria: acceptance.acceptanceCriteria.map((c): ResolvedAcceptanceCriterion => ({
      ...c,
      relatesTo: c.relatesTo.map((r, i) =>
        resolve(r, `acceptanceCriteria ${c.id}.relatesTo[${i}]`),
      ),
    })),
    unresolved: acceptance.unresolved.map((q): ResolvedUnresolvedQuestion => {
      const blocks = q.blocks?.map((r, i) => resolve(r, `unresolved ${q.id}.blocks[${i}]`));
      return blocks ? { ...q, blocks } : { ...q, blocks: undefined };
    }),
    classification: acceptance.classification,
  };
}

// ── The review projection ───────────────────────────────────────────────────

function summarize(ledger: KnowledgeLedger | null, ref: ClaimRef): ChangeClaimSummary {
  const claim = ledger ? getClaim(ledger, ref) : null;
  return {
    ref: formatClaimRef(ref),
    claim: { id: ref.id, revision: ref.revision },
    ...(claim ? { kind: claim.kind, statement: claim.statement } : {}),
  };
}

/** The context a preview recomputes its warnings against, rebuilt from the
 *  staged record — which already froze the request, the selection and the
 *  commit the analysis was scoped to. */
export function contextOfRecord(
  record: ChangeProposalRecord,
  policy: ChangeIntentPolicy | undefined,
): ChangeIntentContext {
  return {
    policy: policy ?? {},
    request: record.request,
    selected: record.selected,
    gitHead: record.gitHead ?? null,
  };
}

/**
 * The deterministic read model of one staged change proposal (Phase 7 §review
 * surface): everything a reviewer needs, in the order they need it.
 *
 *   requested change → CURRENT (rule, support, conformance) → PROPOSED →
 *   PRESERVED → ACCEPTANCE CRITERIA → UNRESOLVED → warnings
 *
 * Three things it takes care to do honestly, the same three the candidate
 * preview does: it invents no canonical identity (a proposed claim is
 * `local:…` until the commit mints an id), it shows what a revision would
 * replace, and it mutates nothing. A fourth is Phase 7's own: it shows the
 * rule's support **and** its current implementation conformance side by side,
 * so "the code already disagrees with the rule we are about to change" is
 * visible rather than inferred.
 */
export function previewChangeProposal(
  record: ChangeProposalRecord,
  ledger: KnowledgeLedger | null,
  deltaRecord: KnowledgeDeltaRecord | null,
  policy?: ChangeIntentPolicy,
): ChangeProposalPreview {
  const proposal: ChangeProposal = record.proposal ?? { schemaVersion: 1 };
  const ctx = contextOfRecord(record, policy);
  const warnings = changeProposalWarnings(proposal, ledger, ctx);
  return {
    proposalId: record.id,
    runId: record.runId,
    step: record.step,
    attempt: record.attempt,
    status: record.status,
    readiness: record.readiness ?? changeReadiness(proposal, warnings),
    request: record.request,
    current: changeRuleStates(ledger, record.selected, record.gitHead ?? null),
    ...(deltaRecord ? { semantic: previewKnowledgeDelta(deltaRecord, ledger) } : {}),
    preserved: (proposal.preserved ?? []).map((r) => summarize(ledger, r)),
    acceptanceCriteria: proposal.acceptanceCriteria ?? [],
    unresolved: proposal.unresolved ?? [],
    classification: proposal.classification ?? [],
    warnings,
    ...(proposal.metadata?.summary !== undefined ? { summary: proposal.metadata.summary } : {}),
  };
}

/** The counts a change-intent phase reports for routing, status and the board.
 *  The proposal itself stays in the staged record, which is the one
 *  authoritative form of it. */
export function summarizeChangeIntent(
  preview: ChangeProposalPreview | null,
  requiresReview: boolean,
): ChangeIntentSummary | undefined {
  if (!preview) return undefined;
  const semantic = preview.semantic;
  return {
    requestId: preview.request.id,
    readiness: preview.readiness,
    selected: preview.current.length,
    revised: semantic?.proposedRevisions.length ?? 0,
    created: semantic?.proposedClaims.length ?? 0,
    decisions: (semantic?.proposedClaims ?? []).filter((c) => c.kind === "decision").length,
    preserved: preview.preserved.length,
    acceptanceCriteria: preview.acceptanceCriteria.length,
    unresolved: preview.unresolved.length,
    warnings: preview.warnings.length + (semantic?.warnings.length ?? 0),
    requiresReview,
  };
}

/** One line naming what a proposal contains, for a journal entry. */
export function describeChangeProposal(proposal: ChangeProposal): string {
  const d = proposal.semanticDelta;
  const parts: Array<[number, string]> = [
    [d?.revisions?.length ?? 0, "revision"],
    [d?.claims?.length ?? 0, "new claim"],
    [proposal.preserved?.length ?? 0, "preserved"],
    [proposal.acceptanceCriteria?.length ?? 0, "acceptance criterion"],
    [proposal.unresolved?.length ?? 0, "unresolved question"],
  ];
  const shown = parts
    .filter(([n]) => n > 0)
    .map(([n, what]) =>
      n === 1
        ? `${n} ${what}`
        : `${n} ${what === "acceptance criterion" ? "acceptance criteria" : what === "preserved" ? "preserved" : `${what}s`}`,
    );
  return shown.length > 0 ? shown.join(", ") : "nothing";
}
