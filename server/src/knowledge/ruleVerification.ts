/**
 * Business-rule verification and implementation conformance (Phase 6) — the
 * pure half.
 *
 * Phase 5 answered "what rules does this organization have, and what grounds
 * them?". This module answers a *different* question about the same rules:
 *
 *   canonical rules (KnowledgeContext)
 *     ↓ the agent reads the implementation it was pointed at  verificationInstruction
 *     ↓ it writes one RuleVerificationReport                  ARGUS_RULE_VERIFICATION_FILE
 *     ↓ Argus checks what it can check                        checkRuleVerification
 *     ↓ the gate shows the outcomes                           previewRuleVerification
 *     ↓ a person approves                                     (Phase 3 boundary, unchanged)
 *     ↓ the results commit atomically                         (store.ts)
 *   durable RuleVerification records
 *
 * **The invariant this whole phase exists to protect.** A verification never
 * touches claim support. `RULE-42:v1 → violated` says the *code* disagrees
 * with the rule; it does not say the business might not have the rule. Nothing
 * here produces an `Evidence` record, a `Justification` or a claim, and the
 * kernel transition that persists a verification appends to exactly one array.
 * So `support = supported` and `conformance = violated` coexist, which is the
 * ordinary state of a bug.
 *
 * **What Argus owns, and what the agent owns.** Deciding that
 * `if (comment.Length > 180)` implements "customer comments max 180" is
 * interpretation, and an agent does it. Everything around that is Argus's and
 * is decided from structured data alone:
 *
 * - which exact rules the run was accountable for (its supplied
 *   KnowledgeContext — never a second selection mechanism);
 * - that every one of them got an outcome, and that nothing else did;
 * - that the rule reference is an exact revision that exists;
 * - that a cited check is a check of *this* phase;
 * - that a cited source path is a real file inside the run's repository
 *   (through `realpath`, not lexically);
 * - that `holds`/`violated` cite evidence and `unverifiable` gives a reason;
 * - the repository revision, the execution identity, the timestamps and ids.
 *
 * A structured result is not a proof. Argus validates the *shape and the
 * references* of a semantic judgement; it does not establish that the code and
 * the sentence mean the same thing, which is why a verification phase is
 * normally gated.
 */

import type {
  ClaimKind,
  ClaimRef,
  DeltaClaimRef,
  KnowledgeDelta,
  PhaseCheck,
  ProposedRuleVerification,
  RuleVerificationErrorCode,
  RuleVerificationHoldsPolicy,
  RuleVerificationOutcome,
  RuleVerificationPolicy,
  RuleVerificationPreview,
  RuleVerificationPreviewEntry,
  RuleVerificationRecord,
  RuleVerificationReport,
  RuleVerificationSummary,
  SourceCodeEvidence,
  VerificationCheckEvidence,
  VerificationEvidence,
} from "@argus/contracts";
import {
  KnowledgeValidationError,
  VERIFICATION_EVIDENCE_MAX,
  VERIFICATION_OUTCOMES,
  VERIFICATION_REASON_MAX_CHARS,
  evaluateSupport,
  formatClaimRef,
  getClaim,
  lifecycleOf,
  parseClaimKey,
  sameCommit,
  sameRef,
  validArtifactPath,
  type KnowledgeLedger,
} from "./kernel.js";
import { resolveRepositoryFile } from "./sourcePath.js";
import { NOTE_MAX_CHARS, artifactRef, optionalText, record, text } from "./validate.js";

export const RULE_VERIFICATION_SCHEMA_VERSION = 1;
/** Most rules one phase attempt may report on. A verification phase is a
 *  bounded question about a bounded context, not a repository audit. */
export const VERIFICATION_SECTION_MAX = 64;
export const VERIFICATION_SUMMARY_MAX_CHARS = 2000;
/** The default: only business rules are things an implementation conforms to.
 *  A context may carry facts and assumptions for the verifier to reason
 *  *with*, and those are not asked for an outcome. */
export const DEFAULT_VERIFICATION_KINDS: readonly ClaimKind[] = ["business-rule"];

/** A refused verification proposal. Maps to the `rule-verification` failure
 *  class in the engine. */
export class RuleVerificationError extends KnowledgeValidationError {
  constructor(
    public readonly code: RuleVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuleVerificationError";
  }
}

function fail(code: RuleVerificationErrorCode, msg: string): never {
  throw new RuleVerificationError(code, msg);
}

// ── The agent-facing contract ───────────────────────────────────────────────

/**
 * The reusable verification instructions — the one place the "what does
 * conformance mean?" contract is written, so an authored pipeline never has to
 * restate it.
 *
 * The two things it insists on are the two an agent gets wrong by default:
 * that `unverifiable` is a first-class, respectable answer (rather than
 * something to round up to `holds`), and that finding the code in breach is
 * *not* a reason to doubt the rule.
 */
export const RULE_VERIFICATION_CONTRACT = [
  "Business-rule verification. This phase's job is to decide, for every business rule you were",
  "given as canonical semantic context, whether the implementation in your working tree conforms",
  "to it — and to write the answer as one JSON document to the file path in the",
  "ARGUS_RULE_VERIFICATION_FILE environment variable.",
  "",
  "Document shape:",
  '{"schemaVersion":1,"verifications":[',
  '  {"rule":"RULE-42:v1","outcome":"holds|violated|unverifiable",',
  '   "evidence":[ ... ], "reason":"required when unverifiable", "note":"one line"}',
  '], "metadata":{"summary":"one paragraph"}}',
  "",
  "Outcomes, and what each one means:",
  "- holds — you found implementation or test evidence sufficient to conclude the code satisfies",
  "  the rule. Cite it.",
  "- violated — you found evidence that the code contradicts the rule. Cite it.",
  "- unverifiable — you could not establish either from the evidence available. This is an",
  "  honest and expected answer for a rule with no executable expression. Give a reason. Do NOT",
  "  report holds because nothing contradicted the rule.",
  "",
  "Evidence records (at least one for holds and for violated):",
  '- {"type":"check","label":"<a label from this phase\'s checks>","note":"..."} — cite a',
  "  deterministic check of this phase. You name the check; Argus binds whether it passed.",
  '- {"type":"source-code","path":"<repository-relative>","symbol":"...","startLine":N,',
  '  "endLine":M,"gitHead":"<the commit you read>"} — where in the code. A reference, never a copy.',
  '- {"type":"artifact","artifact":{"location":"artifact-dir|repository","path":"..."}} — a test',
  "  report or analysis file this phase produced.",
  '- {"type":"observation","note":"..."} — your own reading, where no deterministic check can',
  "  express the link. The weakest kind; do not let it carry an outcome on its own.",
  "",
  "Completeness. Every rule you were supplied must appear exactly once, and no rule you were not",
  "supplied may appear at all. A missing rule refuses the whole document — say unverifiable",
  "rather than leaving one out.",
  "",
  "This is NOT a knowledge proposal. Finding that the code violates a rule does not mean the rule",
  "is wrong, doubtful or in need of revision: it means the code is in breach. Do not write",
  "opposing evidence, a revision or a new claim about a rule because its implementation fails.",
  "If you genuinely learned something durable about the domain, that is a separate KnowledgeDelta.",
].join("\n");

/** The prompt block a verification step gets: the fixed contract, this
 *  phase's policy, and the exact rules it is accountable for. */
export function verificationInstruction(
  policy: RuleVerificationPolicy | undefined,
  selected: ClaimRef[],
): string {
  if (!policy) return "";
  const rules = selected.length
    ? selected.map(formatClaimRef).join(", ")
    : "(none — your context supplied no business rules)";
  const holds =
    holdsPolicy(policy) === "deterministic-check"
      ? "This phase requires a passing deterministic check for holds: an outcome of holds must " +
        'cite at least one {"type":"check"} evidence record naming a check of this phase. A rule ' +
        "you cannot back with a check is unverifiable, not holds."
      : "An outcome of holds must cite concrete evidence; an agent's assertion with nothing " +
        "attached is refused.";
  const note = policy.note ? `\n${policy.note}` : "";
  return `\n\n${RULE_VERIFICATION_CONTRACT}\n\nRules to verify: ${rules}. ${holds}${note}`;
}

export function holdsPolicy(
  policy: RuleVerificationPolicy | undefined,
): RuleVerificationHoldsPolicy {
  return policy?.holds ?? "agent-evidence";
}

/** The claim kinds this policy asks for an outcome on. */
export function verificationKinds(
  policy: RuleVerificationPolicy | undefined,
): readonly ClaimKind[] {
  return policy?.kinds?.length ? policy.kinds : DEFAULT_VERIFICATION_KINDS;
}

/**
 * Which of the revisions Argus supplied to a run the phase is accountable for.
 *
 * Deliberately derived from the supplied context and the ledger, never from
 * anything the agent wrote: the run's accountability is fixed before it starts.
 * A supplied revision the ledger no longer resolves (a hand-edited file) is
 * skipped rather than demanded — Argus cannot ask for an outcome on a rule it
 * cannot describe.
 */
export function selectedRules(
  ledger: KnowledgeLedger | null,
  supplied: ClaimRef[] | undefined,
  policy: RuleVerificationPolicy | undefined,
): ClaimRef[] {
  const kinds = verificationKinds(policy);
  const out: ClaimRef[] = [];
  for (const ref of supplied ?? []) {
    const claim = ledger ? getClaim(ledger, ref) : null;
    if (!claim || !kinds.includes(claim.kind)) continue;
    if (!out.some((r) => sameRef(r, ref))) out.push({ id: ref.id, revision: ref.revision });
  }
  return out;
}

// ── Validation ──────────────────────────────────────────────────────────────

/** An exact existing revision, in object or string form. A bare id is refused:
 *  a conformance result that could be retargeted to a later revision is
 *  exactly the thing Phase 6 forbids. */
export function verificationRuleRef(raw: unknown, ctx: string): ClaimRef {
  if (typeof raw === "string") {
    const key = parseClaimKey(raw);
    if (!key) fail("schema", `${ctx} "${raw}" is not a valid claim reference`);
    if (key.revision === undefined) {
      fail("schema", `${ctx} "${raw}" must name an exact revision (ID:vN), not a bare id`);
    }
    return { id: key.id, revision: key.revision };
  }
  const r = record(raw, ctx);
  if (typeof r.id !== "string") fail("schema", `${ctx}.id is not a valid claim id`);
  const key = parseClaimKey(r.id);
  if (!key || key.revision !== undefined) fail("schema", `${ctx}.id is not a valid claim id`);
  if (typeof r.revision !== "number" || !Number.isInteger(r.revision) || r.revision < 1) {
    fail("schema", `${ctx}.revision must be a positive integer (exact revisions only)`);
  }
  return { id: r.id, revision: r.revision };
}

function sourceCodeEvidence(r: Record<string, unknown>, ctx: string): SourceCodeEvidence {
  if (typeof r.path !== "string" || !validArtifactPath(r.path)) {
    fail("schema", `${ctx}.path must be a repository-relative POSIX path inside the repository`);
  }
  const out: SourceCodeEvidence = { type: "source-code", path: r.path };
  for (const field of ["repository", "gitHead", "symbol"] as const) {
    const v = optionalText(r[field], `${ctx}.${field}`, NOTE_MAX_CHARS);
    if (v) out[field] = v;
  }
  for (const field of ["startLine", "endLine", "line"] as const) {
    if (r[field] === undefined || r[field] === null) continue;
    const n = r[field];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      fail("schema", `${ctx}.${field} must be a positive integer`);
    }
    out[field] = n;
  }
  if (out.startLine !== undefined && out.endLine !== undefined && out.endLine < out.startLine) {
    fail("schema", `${ctx} has endLine ${out.endLine} before startLine ${out.startLine}`);
  }
  return out;
}

/**
 * One evidence record as the agent may write it.
 *
 * A `check` record carries a label and nothing else the agent gets to assert:
 * `status`, `exitCode` and `detail` are stripped here and bound by Argus from
 * the phase's own verification report at commit, so no document can claim a
 * test passed.
 */
export function verificationEvidence(raw: unknown, ctx: string): VerificationEvidence {
  const r = record(raw, ctx);
  switch (r.type) {
    case "check": {
      const out: VerificationCheckEvidence = {
        type: "check",
        label: text(r.label, `${ctx}.label`, NOTE_MAX_CHARS),
      };
      const note = optionalText(r.note, `${ctx}.note`, NOTE_MAX_CHARS);
      if (note) out.note = note;
      return out;
    }
    case "source-code":
      return sourceCodeEvidence(r, ctx);
    case "artifact": {
      const out: VerificationEvidence = {
        type: "artifact",
        artifact: artifactRef(r.artifact, `${ctx}.artifact`),
      };
      const note = optionalText(r.note, `${ctx}.note`, NOTE_MAX_CHARS);
      if (note) out.note = note;
      return out;
    }
    case "observation":
      return { type: "observation", note: text(r.note, `${ctx}.note`, NOTE_MAX_CHARS) };
    default:
      fail(
        "schema",
        `${ctx}.type must be one of check | source-code | artifact | observation (got ${JSON.stringify(r.type)})`,
      );
  }
}

function proposedVerification(raw: unknown, ctx: string): ProposedRuleVerification {
  const r = record(raw, ctx);
  if (typeof r.outcome !== "string" || !VERIFICATION_OUTCOMES.includes(r.outcome as never)) {
    fail("schema", `${ctx}.outcome must be one of ${VERIFICATION_OUTCOMES.join(" | ")}`);
  }
  const outcome = r.outcome as RuleVerificationOutcome;
  if (r.evidence !== undefined && r.evidence !== null && !Array.isArray(r.evidence)) {
    fail("schema", `${ctx}.evidence must be an array`);
  }
  const rawEvidence = Array.isArray(r.evidence) ? r.evidence : [];
  if (rawEvidence.length > VERIFICATION_EVIDENCE_MAX) {
    fail("schema", `${ctx}.evidence exceeds ${VERIFICATION_EVIDENCE_MAX} entries`);
  }
  const out: ProposedRuleVerification = {
    rule: verificationRuleRef(r.rule, `${ctx}.rule`),
    outcome,
    evidence: rawEvidence.map((e, i) => verificationEvidence(e, `${ctx}.evidence[${i}]`)),
  };
  const reason = optionalText(r.reason, `${ctx}.reason`, VERIFICATION_REASON_MAX_CHARS);
  if (reason) out.reason = reason;
  const note = optionalText(r.note, `${ctx}.note`, NOTE_MAX_CHARS);
  if (note) out.note = note;

  // The floor, decided from the document alone: "it holds because I say so"
  // is refused however the phase is configured, and an honest "I could not
  // tell" has to say why it could not.
  if (outcome !== "unverifiable" && out.evidence.length === 0) {
    fail(
      "evidence",
      `${ctx}: a ${outcome} outcome for ${formatClaimRef(out.rule)} must cite at least one evidence record`,
    );
  }
  if (outcome === "unverifiable" && !out.reason) {
    fail(
      "evidence",
      `${ctx}: an unverifiable outcome for ${formatClaimRef(out.rule)} must give a reason`,
    );
  }
  return out;
}

/**
 * Untrusted document → typed report, or a {@link RuleVerificationError}.
 *
 * Structural only: nothing here consults a ledger, a phase definition or a
 * filesystem. What *is* enforced is everything the document decides on its
 * own — shape, bounds, enumerations, exact refs, evidence floors, and that no
 * rule is reported on twice.
 */
export function validateRuleVerificationReport(raw: unknown): RuleVerificationReport {
  let r: Record<string, unknown>;
  try {
    r = record(raw, "verification");
  } catch (e) {
    fail("schema", e instanceof Error ? e.message : String(e));
  }
  if (r.schemaVersion !== RULE_VERIFICATION_SCHEMA_VERSION) {
    fail(
      "schema",
      `schemaVersion must be ${RULE_VERIFICATION_SCHEMA_VERSION} (got ${JSON.stringify(r.schemaVersion)})`,
    );
  }
  if (
    r.verifications !== undefined &&
    r.verifications !== null &&
    !Array.isArray(r.verifications)
  ) {
    fail("schema", "verifications must be an array");
  }
  const rawList = Array.isArray(r.verifications) ? r.verifications : [];
  if (rawList.length > VERIFICATION_SECTION_MAX) {
    fail("schema", `verifications exceeds ${VERIFICATION_SECTION_MAX} entries`);
  }
  let verifications: ProposedRuleVerification[];
  try {
    verifications = rawList.map((v, i) => proposedVerification(v, `verifications[${i}]`));
  } catch (e) {
    if (e instanceof RuleVerificationError) throw e;
    if (e instanceof KnowledgeValidationError) fail("schema", e.message);
    throw e;
  }
  const seen = new Set<string>();
  for (const v of verifications) {
    const key = formatClaimRef(v.rule);
    if (seen.has(key)) fail("schema", `verifications: ${key} is reported on twice`);
    seen.add(key);
  }
  const out: RuleVerificationReport = {
    schemaVersion: RULE_VERIFICATION_SCHEMA_VERSION,
    verifications,
  };
  if (r.metadata !== undefined && r.metadata !== null) {
    const m = record(r.metadata, "metadata");
    const summary = optionalText(m.summary, "metadata.summary", VERIFICATION_SUMMARY_MAX_CHARS);
    if (summary) out.metadata = { summary };
  }
  return out;
}

/** Parse the agent's file text and validate it. `invalid-json` names the parse
 *  failure distinctly from a well-formed document of the wrong shape. */
export function parseRuleVerificationReport(rawText: string): RuleVerificationReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    fail("invalid-json", `not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateRuleVerificationReport(parsed);
}

// ── Deterministic checks against the run's world ────────────────────────────

/** What a verification check needs to know about the run that wrote the report. */
export interface VerificationContext {
  policy: RuleVerificationPolicy;
  /** The exact rules Argus supplied this run and requires an outcome for. */
  selected: ClaimRef[];
  /** The working tree the run ran in. Null = no root to check paths against,
   *  which makes file existence unverifiable rather than failed. */
  repoRoot: string | null;
  /** `git rev-parse HEAD` as Argus recorded it at launch, when the tree is a
   *  repository. */
  gitHead: string | null;
  /** The labels this phase's `checks` declare. A `check` evidence record
   *  naming anything else is a forged reference and refuses the proposal. */
  checkLabels: string[];
}

/**
 * Completeness: the selected rules are exactly the reported ones.
 *
 *   selected = holds ∪ violated ∪ unverifiable, each rule exactly once
 *
 * Both directions are refusals, and both matter. A **missing** rule is silent
 * omission: the phase would read as though a rule had been considered when it
 * had not, which is worse than an explicit `unverifiable`. An **extra** rule is
 * a result about something this run was never given — unaccountable, and
 * possibly about a revision the run never saw.
 */
export function completenessRefusal(
  report: RuleVerificationReport,
  selected: ClaimRef[],
): { code: RuleVerificationErrorCode; message: string } | null {
  const reported = report.verifications.map((v) => v.rule);
  const missing = selected.filter((s) => !reported.some((r) => sameRef(r, s)));
  if (missing.length > 0) {
    return {
      code: "incomplete",
      message: `every selected rule must receive an outcome; ${missing
        .map(formatClaimRef)
        .join(
          ", ",
        )} ${missing.length === 1 ? "is" : "are"} missing (use unverifiable with a reason rather than omitting a rule)`,
    };
  }
  const extra = reported.filter((r) => !selected.some((s) => sameRef(s, r)));
  if (extra.length > 0) {
    return {
      code: "not-selected",
      message: `${extra.map(formatClaimRef).join(", ")} ${
        extra.length === 1 ? "was" : "were"
      } not supplied to this run and cannot be verified by it`,
    };
  }
  return null;
}

/** Every `check` evidence record in a report, with where it sits. */
function checkEvidence(
  report: RuleVerificationReport,
): Array<{ rule: ClaimRef; evidence: VerificationCheckEvidence }> {
  return report.verifications.flatMap((v) =>
    v.evidence.flatMap((e) => (e.type === "check" ? [{ rule: v.rule, evidence: e }] : [])),
  );
}

/** Every `source-code` evidence record in a report. */
function sourceEvidence(
  report: RuleVerificationReport,
): Array<{ rule: ClaimRef; source: SourceCodeEvidence }> {
  return report.verifications.flatMap((v) =>
    v.evidence.flatMap((e) => (e.type === "source-code" ? [{ rule: v.rule, source: e }] : [])),
  );
}

/** The labels a phase's declared checks produce, in declaration order. */
export function declaredCheckLabels(
  checks: PhaseCheck[] | undefined,
  label: (check: PhaseCheck) => string,
): string[] {
  return (checks ?? []).map(label);
}

/**
 * Everything deterministic Argus can refuse about a proposal, given the run's
 * world. Returns the one-sentence refusal, or null when it may be staged.
 *
 * Fail-closed, in the same spirit as the discovery checks: a conformance
 * result nobody can go and re-examine is worse than no result.
 */
export async function checkRuleVerification(
  report: RuleVerificationReport,
  ledger: KnowledgeLedger | null,
  ctx: VerificationContext,
): Promise<{ code: RuleVerificationErrorCode; message: string } | null> {
  const complete = completenessRefusal(report, ctx.selected);
  if (complete) return complete;

  // The rule must resolve, exactly. The selected list already came from the
  // ledger, so this only bites on a hand-built context — but a verification
  // pointing at a revision that does not exist must never be staged.
  if (ledger) {
    for (const v of report.verifications) {
      if (!getClaim(ledger, v.rule)) {
        return {
          code: "unknown-rule",
          message: `verification names unknown claim revision ${formatClaimRef(v.rule)}`,
        };
      }
    }
  }

  // A cited check must be one this phase declares. Decided from the phase
  // definition, so a forged label is refused at intake rather than at the
  // commit boundary — and long before anybody reads an outcome backed by a
  // test that does not exist.
  for (const { rule, evidence } of checkEvidence(report)) {
    if (!ctx.checkLabels.includes(evidence.label)) {
      return {
        code: "check-reference",
        message: `${formatClaimRef(rule)} cites check "${evidence.label}", which this phase does not declare (declared: ${
          ctx.checkLabels.length ? ctx.checkLabels.map((l) => `"${l}"`).join(", ") : "none"
        })`,
      };
    }
  }

  // Under `deterministic-check`, `holds` must be backed by a check of this
  // phase. Whether it passed is bound at commit from the phase's report; that
  // it was cited at all is decidable now.
  if (holdsPolicy(ctx.policy) === "deterministic-check") {
    for (const v of report.verifications) {
      if (v.outcome !== "holds") continue;
      if (!v.evidence.some((e) => e.type === "check")) {
        return {
          code: "evidence",
          message: `this phase requires a deterministic check for holds, but ${formatClaimRef(v.rule)} cites none (report it as unverifiable instead)`,
        };
      }
    }
  }

  // Source evidence: safe, real, inside the repository through every symlink
  // on the way, and at the commit Argus recorded.
  const seen = new Set<string>();
  for (const { rule, source } of sourceEvidence(report)) {
    if (source.gitHead && ctx.gitHead && !sameCommit(ctx.gitHead, source.gitHead)) {
      return {
        code: "source-evidence",
        message: `${formatClaimRef(rule)} cites "${source.path}" at commit ${source.gitHead}, but the run was recorded at ${ctx.gitHead}`,
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
          ? `${formatClaimRef(rule)} cites "${source.path}", which resolves outside the run's repository`
          : verdict.reason === "not-a-file"
            ? `${formatClaimRef(rule)} cites "${source.path}", which is not a file in the run's repository`
            : `${formatClaimRef(rule)} cites "${source.path}", which does not exist in the run's repository`,
    };
  }
  return null;
}

/**
 * Bind every `check` evidence record to the phase's actual
 * {@link VerificationReport}: the agent named a check, Argus says how it went.
 *
 * Run at the commit boundary, where the report exists (checks run after every
 * step has reported). A cited check missing from the report refuses the
 * commit: the phase declared it, so it ran, and a citation Argus cannot
 * substantiate must not become durable.
 */
export function bindCheckEvidence(
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
 * Under `deterministic-check`, a `holds` result must end up citing a check
 * that actually **passed**. Checked after binding, so it is decided from
 * Argus's report rather than from the agent's claim.
 */
export function holdsPolicyRefusal(
  rule: ClaimRef,
  outcome: RuleVerificationOutcome,
  evidence: VerificationEvidence[],
  policy: RuleVerificationPolicy | undefined,
): string | null {
  if (outcome !== "holds" || holdsPolicy(policy) !== "deterministic-check") return null;
  const passed = evidence.some((e) => e.type === "check" && e.status === "passed");
  return passed
    ? null
    : `this phase requires a passing deterministic check for holds, and ${formatClaimRef(rule)} has none`;
}

/**
 * The one thing a verification phase's **KnowledgeDelta** may not do.
 *
 * A verification run is still an ordinary run: it may write a KnowledgeDelta
 * if it genuinely learned something durable. What it may not do is express
 * "the code is in breach" as doubt about the rule — opposing evidence on, or
 * an opposing justification concluding, one of the exact rules it was supplied
 * to verify. That is precisely the contamination Phase 6 exists to prevent,
 * and on a verification phase it is decidable structurally: the delta names an
 * exact revision, and the supplied set says whether that revision is one of
 * the rules under verification.
 *
 * Deliberately narrow. It says nothing about opposing evidence in general (a
 * legitimate Phase 1 concept), nothing about rules this run was not asked to
 * verify, and nothing about what the evidence means. It closes the one path by
 * which a failing test could turn a supported rule `contested`.
 */
export function verificationDeltaRefusal(
  delta: KnowledgeDelta,
  selected: ClaimRef[],
): string | null {
  if (selected.length === 0) return null;
  const selectedRef = (r: DeltaClaimRef): ClaimRef | null => {
    if ("local" in r) return null;
    return selected.some((sel) => sameRef(sel, r)) ? r : null;
  };
  const because =
    'An implementation that breaches a rule is a conformance result (outcome "violated"), ' +
    "not a reason to doubt the rule.";

  for (const e of delta.evidence ?? []) {
    if ((e.direction ?? "supports") !== "opposes") continue;
    const ref = selectedRef(e.claim);
    if (!ref) continue;
    return `this verification phase's KnowledgeDelta attaches opposing evidence to ${formatClaimRef(ref)}, one of the rules it was supplied to verify. ${because}`;
  }
  for (const j of delta.justifications ?? []) {
    if ((j.direction ?? "supports") !== "opposes") continue;
    const ref = selectedRef(j.conclusion);
    if (!ref) continue;
    return `this verification phase's KnowledgeDelta justifies against ${formatClaimRef(ref)}, one of the rules it was supplied to verify. ${because}`;
  }
  return null;
}

// ── Read models ─────────────────────────────────────────────────────────────

function previewEntry(
  ledger: KnowledgeLedger | null,
  v: ProposedRuleVerification,
): RuleVerificationPreviewEntry {
  const claim = ledger ? getClaim(ledger, v.rule) : null;
  return {
    ref: formatClaimRef(v.rule),
    rule: { id: v.rule.id, revision: v.rule.revision },
    ...(claim
      ? {
          statement: claim.statement,
          kind: claim.kind,
          support: evaluateSupport(ledger!, v.rule),
          lifecycle: lifecycleOf(ledger!, v.rule),
        }
      : {}),
    outcome: v.outcome,
    evidence: v.evidence.map((e) => ({ ...e })),
    ...(v.reason !== undefined ? { reason: v.reason } : {}),
    ...(v.note !== undefined ? { note: v.note } : {}),
  };
}

/**
 * The deterministic read model of one staged verification proposal: what a
 * reviewer needs in order to decide, without reading the agent's transcript.
 *
 * Each row carries the rule's **own** derived support beside the outcome, on
 * purpose. A reviewer looking at `RULE-42:v1 — supported — VIOLATED` can see
 * at a glance that the rule stands and the code does not, which is the
 * distinction this whole phase exists to make legible.
 */
export function previewRuleVerification(
  rec: RuleVerificationRecord,
  ledger: KnowledgeLedger | null,
): RuleVerificationPreview {
  const report: RuleVerificationReport = rec.report ?? { schemaVersion: 1, verifications: [] };
  const entries = report.verifications.map((v) => previewEntry(ledger, v));
  const reported = report.verifications.map((v) => v.rule);
  return {
    recordId: rec.id,
    runId: rec.runId,
    step: rec.step,
    attempt: rec.attempt,
    status: rec.status,
    ...(rec.gitHead ? { gitHead: rec.gitHead } : {}),
    holds: entries.filter((e) => e.outcome === "holds"),
    violated: entries.filter((e) => e.outcome === "violated"),
    unverifiable: entries.filter((e) => e.outcome === "unverifiable"),
    missing: rec.selected
      .filter((s) => !reported.some((r) => sameRef(r, s)))
      .map((s) => formatClaimRef(s)),
    ...(report.metadata?.summary !== undefined ? { summary: report.metadata.summary } : {}),
  };
}

/** The counts a verification phase reports for routing, status and the board. */
export function summarizeRuleVerification(
  previews: RuleVerificationPreview[],
  requiresReview: boolean,
): RuleVerificationSummary {
  const sum = (f: (p: RuleVerificationPreview) => number) => previews.reduce((n, p) => n + f(p), 0);
  return {
    selected: sum(
      (p) => p.holds.length + p.violated.length + p.unverifiable.length + p.missing.length,
    ),
    holds: sum((p) => p.holds.length),
    violated: sum((p) => p.violated.length),
    unverifiable: sum((p) => p.unverifiable.length),
    requiresReview,
  };
}

/** One line naming what a verification concluded, for a journal entry. */
export function describeReport(report: RuleVerificationReport): string {
  const counts: Record<RuleVerificationOutcome, number> = {
    holds: 0,
    violated: 0,
    unverifiable: 0,
  };
  for (const v of report.verifications) counts[v.outcome] += 1;
  return VERIFICATION_OUTCOMES.filter((o) => counts[o] > 0)
    .map((o) => `${counts[o]} ${o}`)
    .join(", ");
}
