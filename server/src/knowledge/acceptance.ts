/**
 * Acceptance-criterion verification (Phase 8) — the pure half.
 *
 * Phase 6 answers *does the code satisfy this business rule?*. This module
 * answers a different question about the same implementation:
 *
 *   > Was **this accepted change** carried out, judged by the criteria the
 *   > person who approved it wrote down?
 *
 * They are not the same question and are never mapped onto one another:
 *
 *   RULE-42:v2  "Kobra comments max = 500"   a domain rule that outlives the
 *                                            change. Bound to a ClaimRef.
 *   CP-12/AC-3  "Non-Kobra behaviour is      evidence that one change was
 *               unchanged."                  done right. Bound to a proposal.
 *
 * AC-3 is not a business-rule revision, has no claim to be verified against,
 * and must never become one — Phase 7 §acceptance criteria are not business
 * rules. So it gets its own channel, its own durable record and its own read
 * model, and a realization requires **both** dimensions.
 *
 * What Argus owns here is everything except the judgement:
 *
 * - which criteria the run is accountable for (every criterion of the accepted
 *   proposal its ChangeContext resolved — there is no second selection);
 * - that every one of them got an outcome, and that nothing else did;
 * - that a cited check is a check of *this* phase, and what that check's
 *   status actually was (bound from Argus's own report at commit);
 * - that a cited source path is a real file inside the run's repository;
 * - that `satisfied`/`violated` cite evidence and `unverifiable` gives a
 *   reason;
 * - the repository state, the execution identity, the ids and the timestamps.
 */

import type {
  AcceptanceCriterion,
  AcceptanceOutcome,
  AcceptanceVerificationErrorCode,
  AcceptanceVerificationPolicy,
  AcceptanceVerificationPreview,
  AcceptanceVerificationPreviewEntry,
  AcceptanceVerificationRecord,
  AcceptanceVerificationReport,
  AcceptanceVerificationSummary,
  PhaseCheck,
  ProposedAcceptanceVerification,
  SourceCodeEvidence,
  VerificationCheckEvidence,
  VerificationEvidence,
} from "@argus/contracts";
import {
  ACCEPTANCE_OUTCOMES,
  KnowledgeValidationError,
  VERIFICATION_EVIDENCE_MAX,
  VERIFICATION_REASON_MAX_CHARS,
  formatCriterionRef,
  sameCommit,
  type KnowledgeLedger,
} from "./kernel.js";
import { resolveRepositoryFile } from "./sourcePath.js";
import { verificationEvidence } from "./ruleVerification.js";
import { NOTE_MAX_CHARS, optionalText, record, text } from "./validate.js";

export const ACCEPTANCE_SCHEMA_VERSION = 1;
/** Most criteria one report may carry — the same bound the accepted proposal
 *  itself has, so a complete answer always fits. */
export const ACCEPTANCE_SECTION_MAX = 64;
export const ACCEPTANCE_SUMMARY_MAX_CHARS = 2000;

/** A refused acceptance proposal. Maps to the `acceptance-verification`
 *  failure class in the engine. */
export class AcceptanceVerificationError extends KnowledgeValidationError {
  constructor(
    public readonly code: AcceptanceVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AcceptanceVerificationError";
  }
}

function fail(code: AcceptanceVerificationErrorCode, msg: string): never {
  throw new AcceptanceVerificationError(code, msg);
}

// ── The agent-facing contract ───────────────────────────────────────────────

/**
 * The reusable acceptance instructions.
 *
 * The three things an agent gets wrong by default, said outright: that a
 * criterion is not a business rule (so it is not answered in the rule file);
 * that `unverifiable` is a respectable answer rather than something to round
 * up to `satisfied`; and that writing a test is not evidence — running one is.
 */
export const ACCEPTANCE_VERIFICATION_CONTRACT = [
  "Acceptance verification. This phase must decide, for every acceptance criterion of the accepted",
  "change you were given as ChangeContext, whether the implementation in your working tree satisfies",
  "it — and write the answer as one JSON document to the file path in the",
  "ARGUS_ACCEPTANCE_VERIFICATION_FILE environment variable.",
  "",
  "Document shape:",
  '{"schemaVersion":1,"proposalId":"<the proposalId from your ChangeContext>","criteria":[',
  '  {"criterionId":"AC-1","outcome":"satisfied|violated|unverifiable",',
  '   "evidence":[ ... ], "reason":"required when unverifiable", "note":"one line"}',
  '], "metadata":{"summary":"one paragraph"}}',
  "",
  "Outcomes, and what each one means:",
  "- satisfied — you obtained evidence sufficient to conclude the implementation meets this",
  "  criterion. Cite it.",
  "- violated — you obtained evidence that it does not. Cite it.",
  "- unverifiable — you could not establish either from the evidence available. An honest and",
  "  expected answer for a criterion with no executable expression. Give a reason. Do NOT report",
  "  satisfied because nothing contradicted it.",
  "",
  "Evidence records (at least one for satisfied and for violated):",
  '- {"type":"check","label":"<a label from this phase\'s checks>"} — cite a deterministic check of',
  "  this phase. You name the check; Argus binds whether it passed. You cannot claim a check passed.",
  '- {"type":"source-code","path":"<repository-relative>","startLine":N,"endLine":M} — where in the',
  "  code. A reference, never a copy.",
  '- {"type":"artifact","artifact":{"location":"artifact-dir|repository","path":"..."}} — a test',
  "  report or analysis file this phase produced.",
  '- {"type":"observation","note":"..."} — your own reading. The weakest kind.',
  "",
  "Completeness. Every criterion of the accepted proposal must appear exactly once, and no criterion",
  "it does not declare may appear at all. A missing criterion refuses the whole document — say",
  "unverifiable rather than leaving one out.",
  "",
  "An acceptance criterion is NOT a business rule. Rule conformance goes in the rule-verification",
  "file; this file is only about whether this accepted change was carried out. A criterion being",
  "violated is never a reason to revise, doubt or weaken a rule, and adding a test does not by",
  "itself satisfy a criterion — only running it, as a check of this phase, is evidence.",
].join("\n");

/** The prompt block an acceptance-verification step gets: the fixed contract,
 *  the exact criteria it must answer for, and the phase's own note. */
export function acceptanceInstruction(
  policy: AcceptanceVerificationPolicy | undefined,
  proposalId: string | null,
  criteria: AcceptanceCriterion[],
): string {
  if (!policy) return "";
  const list = criteria.length
    ? criteria.map((c) => `${c.id} (${c.kind}) ${c.statement}`).join("; ")
    : "(none — the accepted proposal declares no acceptance criteria)";
  const note = policy.note ? `\n${policy.note}` : "";
  const which = proposalId ? `Accepted change: ${proposalId}. ` : "";
  return `\n\n${ACCEPTANCE_VERIFICATION_CONTRACT}\n\n${which}Criteria to answer for: ${list}.${note}`;
}

/** Does this policy require `satisfied`, or does it accept `unverifiable`, for
 *  one criterion? Never downgrades `violated` — that is always a failure. */
export function criterionIsRequired(
  policy: AcceptanceVerificationPolicy | undefined,
  criterion: Pick<AcceptanceCriterion, "kind">,
): boolean {
  if ((policy?.require ?? "all") === "all") return true;
  return criterion.kind !== "regression";
}

// ── Validation ──────────────────────────────────────────────────────────────

/** A criterion id as the agent may write it: the proposal-local label, never a
 *  `CP-12/AC-1` pair — the proposal is fixed by the run's ChangeContext, so an
 *  agent naming one would be naming a change it was not given. */
const CRITERION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function proposedCriterion(raw: unknown, ctx: string): ProposedAcceptanceVerification {
  const r = record(raw, ctx);
  const criterionId = text(r.criterionId, `${ctx}.criterionId`, 80);
  if (!CRITERION_ID_RE.test(criterionId)) {
    fail("schema", `${ctx}.criterionId "${criterionId}" is not a valid criterion id`);
  }
  if (typeof r.outcome !== "string" || !ACCEPTANCE_OUTCOMES.includes(r.outcome as never)) {
    fail("schema", `${ctx}.outcome must be one of ${ACCEPTANCE_OUTCOMES.join(" | ")}`);
  }
  const outcome = r.outcome as AcceptanceOutcome;
  if (r.evidence !== undefined && r.evidence !== null && !Array.isArray(r.evidence)) {
    fail("schema", `${ctx}.evidence must be an array`);
  }
  const rawEvidence = Array.isArray(r.evidence) ? r.evidence : [];
  if (rawEvidence.length > VERIFICATION_EVIDENCE_MAX) {
    fail("schema", `${ctx}.evidence exceeds ${VERIFICATION_EVIDENCE_MAX} entries`);
  }
  let evidence: VerificationEvidence[];
  try {
    // The same evidence union rule verification uses, validated by exactly the
    // same function — including its stripping of any `status` the agent wrote
    // on a `check` record, which is Argus's to bind and nobody else's.
    evidence = rawEvidence.map((e, i) => verificationEvidence(e, `${ctx}.evidence[${i}]`));
  } catch (e) {
    fail("schema", e instanceof Error ? e.message : String(e));
  }
  const out: ProposedAcceptanceVerification = { criterionId, outcome, evidence };
  const reason = optionalText(r.reason, `${ctx}.reason`, VERIFICATION_REASON_MAX_CHARS);
  if (reason) out.reason = reason;
  const note = optionalText(r.note, `${ctx}.note`, NOTE_MAX_CHARS);
  if (note) out.note = note;

  // The floor, decided from the document alone.
  if (outcome !== "unverifiable" && out.evidence.length === 0) {
    fail("evidence", `${ctx}: a ${outcome} outcome for ${criterionId} must cite evidence`);
  }
  if (outcome === "unverifiable" && !out.reason) {
    fail("evidence", `${ctx}: an unverifiable outcome for ${criterionId} must give a reason`);
  }
  return out;
}

/**
 * Untrusted document → typed report, or an {@link AcceptanceVerificationError}.
 * Structural only: nothing here consults a ledger, a phase definition or a
 * filesystem.
 */
export function validateAcceptanceReport(raw: unknown): AcceptanceVerificationReport {
  let r: Record<string, unknown>;
  try {
    r = record(raw, "acceptance");
  } catch (e) {
    fail("schema", e instanceof Error ? e.message : String(e));
  }
  if (r.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION) {
    fail(
      "schema",
      `schemaVersion must be ${ACCEPTANCE_SCHEMA_VERSION} (got ${JSON.stringify(r.schemaVersion)})`,
    );
  }
  if (r.criteria !== undefined && r.criteria !== null && !Array.isArray(r.criteria)) {
    fail("schema", "criteria must be an array");
  }
  const rawList = Array.isArray(r.criteria) ? r.criteria : [];
  if (rawList.length > ACCEPTANCE_SECTION_MAX) {
    fail("schema", `criteria exceeds ${ACCEPTANCE_SECTION_MAX} entries`);
  }
  let criteria: ProposedAcceptanceVerification[];
  try {
    criteria = rawList.map((v, i) => proposedCriterion(v, `criteria[${i}]`));
  } catch (e) {
    if (e instanceof AcceptanceVerificationError) throw e;
    if (e instanceof KnowledgeValidationError) fail("schema", e.message);
    throw e;
  }
  const seen = new Set<string>();
  for (const c of criteria) {
    if (seen.has(c.criterionId)) fail("schema", `criteria: ${c.criterionId} is reported on twice`);
    seen.add(c.criterionId);
  }
  const out: AcceptanceVerificationReport = { schemaVersion: ACCEPTANCE_SCHEMA_VERSION, criteria };
  const proposalId = optionalText(r.proposalId, "proposalId", 120);
  if (proposalId) out.proposalId = proposalId;
  if (r.metadata !== undefined && r.metadata !== null) {
    const m = record(r.metadata, "metadata");
    const summary = optionalText(m.summary, "metadata.summary", ACCEPTANCE_SUMMARY_MAX_CHARS);
    if (summary) out.metadata = { summary };
  }
  return out;
}

/** Parse the agent's file text and validate it. */
export function parseAcceptanceReport(rawText: string): AcceptanceVerificationReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    fail("invalid-json", `not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateAcceptanceReport(parsed);
}

// ── Deterministic checks against the run's world ────────────────────────────

export interface AcceptanceContext {
  policy: AcceptanceVerificationPolicy;
  /** The accepted proposal this run answers for, from its ChangeContext. */
  proposalId: string;
  /** Every criterion of that proposal. The run must account for all of them. */
  required: AcceptanceCriterion[];
  repoRoot: string | null;
  gitHead: string | null;
  checkLabels: string[];
}

/**
 * Completeness: the accepted proposal's criteria are exactly the reported ones.
 *
 *   required = satisfied ∪ violated ∪ unverifiable, each criterion once
 *
 * A **missing** criterion is silent omission — the change would read as though
 * a criterion had been considered when it had not. An **extra** one is a
 * result about something this change does not declare, and the classic form of
 * it is a criterion belonging to a *different* proposal: `CP-11/AC-1` can
 * never satisfy CP-12, and this is where that is refused.
 */
export function acceptanceCompletenessRefusal(
  report: AcceptanceVerificationReport,
  required: AcceptanceCriterion[],
): { code: AcceptanceVerificationErrorCode; message: string } | null {
  const reported = report.criteria.map((c) => c.criterionId);
  const missing = required.filter((r) => !reported.includes(r.id)).map((r) => r.id);
  if (missing.length > 0) {
    return {
      code: "incomplete",
      message: `every acceptance criterion must receive an outcome; ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } missing (use unverifiable with a reason rather than omitting one)`,
    };
  }
  const extra = reported.filter((id) => !required.some((r) => r.id === id));
  if (extra.length > 0) {
    return {
      code: "unknown-criterion",
      message: `${extra.join(", ")} ${
        extra.length === 1 ? "is" : "are"
      } not a criterion of this accepted change and cannot be answered by this run`,
    };
  }
  return null;
}

/**
 * Everything deterministic Argus can refuse about an acceptance proposal.
 * Returns the one-sentence refusal, or null when it may be staged.
 */
export async function checkAcceptanceReport(
  report: AcceptanceVerificationReport,
  ctx: AcceptanceContext,
): Promise<{ code: AcceptanceVerificationErrorCode; message: string } | null> {
  // The proposal, when the agent echoed one. A report written against a
  // different change is refused before anything else is looked at: criterion
  // ids are proposal-scoped, so `AC-1` from CP-11 would otherwise validate
  // perfectly against CP-12's `AC-1`.
  if (report.proposalId && report.proposalId !== ctx.proposalId) {
    return {
      code: "unknown-proposal",
      message: `this report names accepted change ${report.proposalId}, but this run was given ${ctx.proposalId}; acceptance criteria are proposal-scoped and one change's AC-1 is not another's`,
    };
  }
  const complete = acceptanceCompletenessRefusal(report, ctx.required);
  if (complete) return complete;

  for (const c of report.criteria) {
    for (const e of c.evidence) {
      if (e.type !== "check") continue;
      if (!ctx.checkLabels.includes(e.label)) {
        return {
          code: "check-reference",
          message: `${formatCriterionRef(ctx.proposalId, c.criterionId)} cites check "${e.label}", which this phase does not declare (declared: ${
            ctx.checkLabels.length ? ctx.checkLabels.map((l) => `"${l}"`).join(", ") : "none"
          })`,
        };
      }
    }
  }

  const seen = new Set<string>();
  for (const c of report.criteria) {
    for (const e of c.evidence) {
      if (e.type !== "source-code") continue;
      const source = e as SourceCodeEvidence;
      if (source.gitHead && ctx.gitHead && !sameCommit(ctx.gitHead, source.gitHead)) {
        return {
          code: "source-evidence",
          message: `${formatCriterionRef(ctx.proposalId, c.criterionId)} cites "${source.path}" at commit ${source.gitHead}, but the run was recorded at ${ctx.gitHead}`,
        };
      }
      if (!ctx.repoRoot || seen.has(source.path)) continue;
      seen.add(source.path);
      const verdict = await resolveRepositoryFile(ctx.repoRoot, source.path);
      if (verdict.ok) continue;
      return {
        code: "source-evidence",
        message:
          verdict.reason === "unsafe"
            ? `${formatCriterionRef(ctx.proposalId, c.criterionId)} cites "${source.path}", which resolves outside the run's repository`
            : verdict.reason === "not-a-file"
              ? `${formatCriterionRef(ctx.proposalId, c.criterionId)} cites "${source.path}", which is not a file in the run's repository`
              : `${formatCriterionRef(ctx.proposalId, c.criterionId)} cites "${source.path}", which does not exist in the run's repository`,
      };
    }
  }
  return null;
}

/** The labels a phase's declared checks produce, in declaration order. */
export function acceptanceCheckLabels(
  checks: PhaseCheck[] | undefined,
  label: (check: PhaseCheck) => string,
): string[] {
  return (checks ?? []).map(label);
}

// ── Read models ─────────────────────────────────────────────────────────────

function previewEntry(
  criterion: AcceptanceCriterion | undefined,
  proposalId: string,
  v: ProposedAcceptanceVerification,
): AcceptanceVerificationPreviewEntry {
  return {
    ref: formatCriterionRef(proposalId, v.criterionId),
    criterionId: v.criterionId,
    statement: criterion?.statement ?? "(criterion not found on the accepted proposal)",
    kind: criterion?.kind ?? "behavior",
    relatesTo: (criterion?.relatesTo ?? []).flatMap((r) =>
      "local" in r ? [] : [{ id: r.id, revision: r.revision }],
    ),
    outcome: v.outcome,
    evidence: v.evidence,
    ...(v.reason !== undefined ? { reason: v.reason } : {}),
    ...(v.note !== undefined ? { note: v.note } : {}),
  };
}

/** The deterministic read model of one staged acceptance proposal, grouped by
 *  outcome, with the criterion's own statement beside each result. */
export function previewAcceptance(
  rec: AcceptanceVerificationRecord,
): AcceptanceVerificationPreview {
  const report = rec.report ?? { schemaVersion: 1 as const, criteria: [] };
  const entries = report.criteria.map((v) =>
    previewEntry(
      rec.required.find((c) => c.id === v.criterionId),
      rec.proposalId,
      v,
    ),
  );
  const reported = report.criteria.map((c) => c.criterionId);
  return {
    recordId: rec.id,
    runId: rec.runId,
    step: rec.step,
    attempt: rec.attempt,
    status: rec.status,
    proposalId: rec.proposalId,
    ...(rec.repository ? { repository: rec.repository } : {}),
    satisfied: entries.filter((e) => e.outcome === "satisfied"),
    violated: entries.filter((e) => e.outcome === "violated"),
    unverifiable: entries.filter((e) => e.outcome === "unverifiable"),
    missing: rec.required.filter((c) => !reported.includes(c.id)).map((c) => c.id),
    ...(report.metadata?.summary !== undefined ? { summary: report.metadata.summary } : {}),
  };
}

/** The counts an acceptance phase reports for routing, status and the board. */
export function summarizeAcceptance(
  proposalId: string,
  previews: AcceptanceVerificationPreview[],
  requiresReview: boolean,
): AcceptanceVerificationSummary {
  const sum = (f: (p: AcceptanceVerificationPreview) => number) =>
    previews.reduce((n, p) => n + f(p), 0);
  return {
    proposalId,
    required: sum(
      (p) => p.satisfied.length + p.violated.length + p.unverifiable.length + p.missing.length,
    ),
    satisfied: sum((p) => p.satisfied.length),
    violated: sum((p) => p.violated.length),
    unverifiable: sum((p) => p.unverifiable.length),
    requiresReview,
  };
}

/** One line naming what an acceptance report concluded, for a journal entry. */
export function describeAcceptanceReport(report: AcceptanceVerificationReport): string {
  const counts: Record<AcceptanceOutcome, number> = {
    satisfied: 0,
    violated: 0,
    unverifiable: 0,
  };
  for (const c of report.criteria) counts[c.outcome] += 1;
  return ACCEPTANCE_OUTCOMES.filter((o) => counts[o] > 0)
    .map((o) => `${counts[o]} ${o}`)
    .join(", ");
}

/** Bind every `check` evidence record to the phase's own report, exactly as
 *  rule verification does: the agent names a check, Argus says how it went. */
export function bindAcceptanceChecks(
  evidence: VerificationEvidence[],
  results: Array<{
    label: string;
    status: "passed" | "failed";
    exitCode?: number | null;
    detail: string;
  }>,
): { evidence: VerificationEvidence[]; missing: string[] } {
  const missing: string[] = [];
  const bound = evidence.map((e) => {
    if (e.type !== "check") return e;
    const result = results.find((r) => r.label === e.label);
    if (!result) {
      if (!missing.includes(e.label)) missing.push(e.label);
      return e;
    }
    const out: VerificationCheckEvidence = {
      type: "check",
      label: e.label,
      status: result.status,
      detail: result.detail,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(e.note !== undefined ? { note: e.note } : {}),
    };
    return out;
  });
  return { evidence: bound, missing };
}

/**
 * A `satisfied` result may not rest on a check Argus observed **failing**.
 *
 * The forged-evidence case, closed after binding: an agent cites
 * `kobra-comment-500`, Argus runs it, it exits 1, and the agent still wrote
 * `satisfied`. Argus's own report decides. Returns the refusal, or null.
 */
export function acceptanceCheckRefusal(
  proposalId: string,
  criterionId: string,
  outcome: AcceptanceOutcome,
  evidence: VerificationEvidence[],
): string | null {
  if (outcome !== "satisfied") return null;
  const failed = evidence.filter((e) => e.type === "check" && e.status === "failed");
  if (failed.length === 0) return null;
  const labels = failed.map((e) => `"${(e as VerificationCheckEvidence).label}"`).join(", ");
  return `${formatCriterionRef(proposalId, criterionId)} is reported satisfied but cites check ${labels}, which Argus observed failing`;
}

/** The ledger is not consulted by anything above; this is the one place a
 *  staged record's proposal is confirmed to still exist at the commit
 *  boundary, so a criterion cannot be recorded against a proposal that is not
 *  there. */
export function acceptanceProposalMissing(
  ledger: KnowledgeLedger,
  proposalId: string,
): string | null {
  return ledger.changeProposals.some((c) => c.id === proposalId)
    ? null
    : `the ledger holds no accepted change proposal ${proposalId}`;
}
