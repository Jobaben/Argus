/**
 * Closed-loop change realization (Phase 8) — the pure half.
 *
 * This module holds the one thing Phase 8 exists to define precisely: **when
 * is an accepted business change implemented?** The answer is never one fact,
 * and the four facts it is made of are never merged:
 *
 *   ChangeRealizationComplete ⟺
 *       the implementation execution succeeded
 *     ∧ every mandatory deterministic PhaseCheck passed
 *     ∧ every targeted business-rule revision `holds` at the examined state
 *     ∧ every required acceptance criterion is `satisfied` at that same state
 *     ∧ the verification examined the state the implementation produced
 *     ∧ the semantic target is still the domain's current intent
 *
 * Each conjunct is evaluated from a record Argus wrote, never from an agent's
 * report about itself: `ARGUS_OUTCOME: succeeded` decides only the first, a
 * passing `npm test` only the second, and neither says anything about the two
 * semantic dimensions. That is the point.
 *
 * It also holds the two supporting definitions that make the invariant
 * checkable:
 *
 * - {@link repositoryStateFrom} — the repository-state identity a result is
 *   bound to, precise enough that two dirty trees at one commit are two
 *   states;
 * - {@link buildRemediationContext} — what a remediation is told, derived from
 *   Argus's own accepted results rather than from the previous agent's
 *   transcript.
 *
 * Pure: no clock beyond the one it is handed, no filesystem, no ledger writes.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AcceptanceConformanceStatus,
  AcceptanceVerification,
  AcceptanceVerificationPolicy,
  AcceptedChangeProposal,
  ChangeAttemptOutcome,
  ChangeRealization,
  ClaimRef,
  ImplementationScope,
  ImplementationTarget,
  RealizationAcceptanceResult,
  RealizationRuleResult,
  RealizationTechnicalResult,
  RemediationContext,
  RemediationFailedCriterion,
  RemediationFailedRule,
  RepositoryStateRef,
  RuleVerification,
  VerificationReport,
} from "@argus/contracts";
import {
  formatClaimRef,
  formatCriterionRef,
  formatRepositoryState,
  getClaim,
  repositoryStateIsIdentifiable,
  sameRef,
  sameRepositoryState,
  type KnowledgeLedger,
} from "./kernel.js";
import { criterionIsRequired } from "./acceptance.js";
import { runInvocationDir } from "../sources/runs.js";
import type { WorkingTreeSnapshot } from "../harness/verification.js";

// ── Repository-state identity ───────────────────────────────────────────────

/**
 * The identity of the repository state a snapshot describes.
 *
 * The head alone is not it. An agent that edits files without committing
 * leaves the head exactly where it was, so two different implementations of
 * the same change — the broken first attempt and the corrected remediation —
 * would share one `gitHead`, and a verification bound to the head alone would
 * claim the second's result about the first. The dirty half is therefore
 * hashed: every dirty path with the content identity Argus's own snapshot
 * computed (a sha256 of the bytes, or a size/mtime fallback for a file too
 * large to hash), sorted, joined, hashed again.
 *
 * Returns null when `cwd` was not a git work tree at all — an honest "there is
 * no revision identity here", never a fabricated one.
 */
export function repositoryStateFrom(
  snapshot: WorkingTreeSnapshot | null,
): RepositoryStateRef | null {
  if (!snapshot) return null;
  const entries = Object.entries(snapshot.dirty).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const state: RepositoryStateRef = {};
  if (snapshot.head) state.gitHead = snapshot.head;
  if (entries.length > 0 || snapshot.truncated) {
    const hash = createHash("sha256");
    for (const [p, identity] of entries) hash.update(`${p}\u0000${identity}\u0000`);
    state.workingTree = {
      snapshotHash: hash.digest("hex"),
      dirty: entries.length,
      ...(snapshot.truncated ? { truncated: true } : {}),
    };
  }
  return state.gitHead || state.workingTree ? state : null;
}

/** Argus's own checks over one phase, reduced to what a realization records.
 *  Bound from the phase's {@link VerificationReport}, never from a document an
 *  agent wrote. */
export function technicalResultFrom(
  reports: Array<VerificationReport | undefined>,
): RealizationTechnicalResult | undefined {
  const checks = reports.flatMap((r) => r?.checks ?? []);
  if (reports.every((r) => r === undefined)) return undefined;
  const failed = checks
    .filter((c) => c.status === "failed")
    .map((c) => ({ label: c.label, ...(c.detail ? { detail: c.detail } : {}) }));
  return {
    status: failed.length === 0 ? "passed" : "failed",
    passed: checks.filter((c) => c.status === "passed").map((c) => c.label),
    failed,
  };
}

// ── The completion invariant ────────────────────────────────────────────────

export interface CompletionInput {
  ledger: KnowledgeLedger;
  proposal: AcceptedChangeProposal;
  /** How the implementation (or remediation) execution itself ended. */
  implementation: "succeeded" | "failed" | "blocked";
  /** Argus's own checks over the implementation phase and the verification
   *  phase, already merged. Absent = the phases declared none. */
  technical?: RealizationTechnicalResult;
  /** The state the implementation left behind, as Argus read it. Null = the
   *  working tree is not a git repository. */
  implementationState: RepositoryStateRef | null;
  /** The state the verification phase examined. Null = same. */
  verificationState: RepositoryStateRef | null;
  /** The accepted rule verifications this attempt's verification runs
   *  produced. Bound by run id, so an earlier attempt's results can never
   *  stand in for this one's. */
  ruleVerifications: RuleVerification[];
  /** The accepted acceptance verifications this attempt's runs produced. */
  acceptanceVerifications: AcceptanceVerification[];
  acceptancePolicy?: AcceptanceVerificationPolicy;
}

export interface CompletionVerdict {
  outcome: ChangeAttemptOutcome;
  reason: string;
  ruleResults: RealizationRuleResult[];
  acceptanceResults: RealizationAcceptanceResult[];
  /** Whether another targeted attempt could plausibly fix what is unmet.
   *  A technical failure or a semantic violation can; a blocker, an
   *  unverifiable criterion, a stale target or a state mismatch cannot. */
  remediable: boolean;
}

/**
 * The exact business rules a realization must see `holds` for: the
 * **business-rule** revisions the accepted proposal introduced.
 *
 * Deliberately not "every claim in the ledger" and not "every preserved
 * revision". A decision or a constraint claim the change created is not
 * something an implementation conforms to on its own; and a preserved rule is
 * protected by the proposal's own regression criteria, or by the verification
 * phase's authored rule selection when its author wants it re-verified — never
 * by Argus quietly widening the scope.
 */
export function requiredRules(
  ledger: KnowledgeLedger,
  proposal: AcceptedChangeProposal,
): ClaimRef[] {
  const out: ClaimRef[] = [];
  for (const ref of proposal.semanticChanges) {
    const claim = getClaim(ledger, ref);
    if (!claim || claim.kind !== "business-rule") continue;
    if (!out.some((r) => sameRef(r, ref))) out.push({ id: ref.id, revision: ref.revision });
  }
  return out;
}

/**
 * Decide one attempt's verdict.
 *
 * The order is the order the dimensions fail in, and it is what keeps the
 * failure classes apart: a blocker is not a compile error, a compile error is
 * not a rule violation, and a rule violation is not an acceptance violation.
 * Each is remediated differently, so each is named differently.
 */
export function evaluateCompletion(input: CompletionInput): CompletionVerdict {
  const required = requiredRules(input.ledger, input.proposal);

  // Every rule this attempt actually verified, required or not: an authored
  // selection that came back `violated` blocks the realization even when the
  // rule is not one the change introduced — ignoring it would be Argus
  // deciding that a breach it was told to look for does not count.
  const ruleResults: RealizationRuleResult[] = [];
  const noteRule = (rule: ClaimRef) => {
    if (ruleResults.some((r) => sameRef(r.rule, rule))) return;
    const v = input.ruleVerifications.find((x) => sameRef(x.rule, rule));
    ruleResults.push({
      rule: { id: rule.id, revision: rule.revision },
      outcome: v?.outcome ?? "unverified",
      ...(v ? { verificationId: v.id } : {}),
    });
  };
  for (const rule of required) noteRule(rule);
  for (const v of input.ruleVerifications) noteRule(v.rule);

  const acceptanceResults: RealizationAcceptanceResult[] = input.proposal.acceptanceCriteria.map(
    (c) => {
      const v = input.acceptanceVerifications.find((x) => x.criterionId === c.id);
      return {
        criterionId: c.id,
        outcome: (v?.outcome ?? "unverified") as AcceptanceConformanceStatus,
        ...(v ? { verificationId: v.id } : {}),
      };
    },
  );

  const verdict = (
    outcome: ChangeAttemptOutcome,
    reason: string,
    remediable: boolean,
  ): CompletionVerdict => ({ outcome, reason, ruleResults, acceptanceResults, remediable });

  // 1. The implementation agent said it could not safely do this. More code is
  //    not the answer, so the loop stops and a person decides.
  if (input.implementation === "blocked") {
    return verdict(
      "blocked",
      "the implementation reported it is blocked: the accepted intent cannot safely be implemented with the information available",
      false,
    );
  }
  // 2. The implementation execution failed outright.
  if (input.implementation === "failed") {
    return verdict("technical-failure", "the implementation execution failed", true);
  }
  // 3. Argus's own checks. Nothing semantic is even looked at while the tree
  //    does not build: a rule result about code that does not compile would be
  //    about nothing.
  if (input.technical?.status === "failed") {
    return verdict(
      "technical-failure",
      `deterministic checks failed: ${input.technical.failed.map((f) => f.label).join(", ")}`,
      true,
    );
  }
  // 4. The critical binding: the verification must have examined the state the
  //    implementation produced. Fail closed — a "holds" about a different tree
  //    is not evidence about this one, and Argus will not pretend otherwise.
  const impl = input.implementationState;
  const verif = input.verificationState;
  if (impl || verif) {
    if (!impl || !verif) {
      return verdict(
        "state-mismatch",
        `the implementation and the verification did not both report a repository state (implementation ${formatRepositoryState(
          impl ?? undefined,
        )}, verification ${formatRepositoryState(verif ?? undefined)})`,
        false,
      );
    }
    if (!repositoryStateIsIdentifiable(impl) || !repositoryStateIsIdentifiable(verif)) {
      return verdict(
        "state-mismatch",
        "the repository state could not be identified (the working-tree snapshot was truncated), so no verification can be bound to it",
        false,
      );
    }
    if (!sameRepositoryState(impl, verif)) {
      return verdict(
        "state-mismatch",
        `the verification examined ${formatRepositoryState(verif)}, which is not the state the implementation produced (${formatRepositoryState(impl)})`,
        false,
      );
    }
  }
  // 5. Rule conformance. `unverified` is a failure here and not an oversight:
  //    completeness is enforced at intake, so it means the verification phase
  //    never produced an accepted result for a rule this change introduced.
  const unmetRules = ruleResults.filter((r) => r.outcome !== "holds");
  if (unmetRules.length > 0) {
    return verdict(
      "rule-violation",
      `business-rule conformance is unmet: ${unmetRules
        .map((r) => `${formatClaimRef(r.rule)} ${r.outcome}`)
        .join(", ")}`,
      true,
    );
  }
  // 6. Acceptance satisfaction — independent of rule conformance, and checked
  //    even though every rule holds. "Every rule holds" is not "the change was
  //    carried out".
  const proposalId = input.proposal.id;
  const requiredCriteria = input.proposal.acceptanceCriteria.filter((c) =>
    criterionIsRequired(input.acceptancePolicy, c),
  );
  const unmet = acceptanceResults.filter(
    (r) => r.outcome !== "satisfied" && requiredCriteria.some((c) => c.id === r.criterionId),
  );
  const unverifiable = unmet.filter((r) => r.outcome === "unverifiable");
  if (unverifiable.length > 0) {
    return verdict(
      "acceptance-unverifiable",
      `required acceptance criteria could not be established either way: ${unverifiable
        .map((r) => formatCriterionRef(proposalId, r.criterionId))
        .join(", ")}; more implementation is not the answer, a person is`,
      false,
    );
  }
  if (unmet.length > 0) {
    return verdict(
      "acceptance-violation",
      `required acceptance criteria are unmet: ${unmet
        .map((r) => `${formatCriterionRef(proposalId, r.criterionId)} ${r.outcome}`)
        .join(", ")}`,
      true,
    );
  }
  return verdict(
    "succeeded",
    `every targeted rule holds and every required acceptance criterion is satisfied at ${formatRepositoryState(
      impl ?? undefined,
    )}`,
    false,
  );
}

// ── Remediation ─────────────────────────────────────────────────────────────

/** The path handed to a remediation run as `ARGUS_REMEDIATION_CONTEXT_FILE`. */
export function remediationContextFile(runId: string): string {
  return path.join(runInvocationDir(runId), "remediation-context.json");
}

/** The path handed to an implementation run as
 *  `ARGUS_IMPLEMENTATION_SCOPE_FILE`. */
export function implementationScopeFile(runId: string): string {
  return path.join(runInvocationDir(runId), "implementation-scope.json");
}

export interface RemediationInput {
  realization: ChangeRealization;
  proposal: AcceptedChangeProposal;
  ledger: KnowledgeLedger;
  /** The attempt about to be launched (2..n). */
  attempt: number;
  /** The verdict of the attempt being remediated. */
  previous: CompletionVerdict;
  /** The accepted results that verdict was computed from, so the remediation
   *  is told exactly what the verifier said and where it looked. */
  ruleVerifications: RuleVerification[];
  acceptanceVerifications: AcceptanceVerification[];
  now: string;
}

/**
 * What a remediation agent is told: the exact rules and criteria that are
 * unmet, the deterministic checks Argus saw failing, the scope entries those
 * failures point at, and — so the fix does not undo them — what already holds.
 *
 * Derived entirely from Argus's own accepted records. The remediation agent
 * never has to read the previous agent's transcript to find out what went
 * wrong, and cannot be misled by it if it does.
 */
export function buildRemediationContext(input: RemediationInput): RemediationContext {
  const { proposal, previous } = input;

  const failedRules: RemediationFailedRule[] = previous.ruleResults
    .filter((r) => r.outcome !== "holds")
    .map((r) => {
      const v = input.ruleVerifications.find((x) => sameRef(x.rule, r.rule));
      const claim = getClaim(input.ledger, r.rule);
      return {
        rule: { id: r.rule.id, revision: r.rule.revision },
        ref: formatClaimRef(r.rule),
        ...(claim ? { statement: claim.statement } : {}),
        outcome: r.outcome,
        ...(v?.reason !== undefined ? { reason: v.reason } : {}),
        ...(v?.note !== undefined ? { note: v.note } : {}),
        evidence: v?.evidence ?? [],
      };
    });

  const failedCriteria: RemediationFailedCriterion[] = previous.acceptanceResults
    .filter((r) => r.outcome !== "satisfied")
    .flatMap((r) => {
      const criterion = proposal.acceptanceCriteria.find((c) => c.id === r.criterionId);
      if (!criterion) return [];
      const v = input.acceptanceVerifications.find((x) => x.criterionId === r.criterionId);
      return [
        {
          criterionId: r.criterionId,
          ref: formatCriterionRef(proposal.id, r.criterionId),
          statement: criterion.statement,
          kind: criterion.kind,
          relatesTo: criterion.relatesTo.map((x) => ({ id: x.id, revision: x.revision })),
          outcome: r.outcome,
          ...(v?.reason !== undefined ? { reason: v.reason } : {}),
          ...(v?.note !== undefined ? { note: v.note } : {}),
          evidence: v?.evidence ?? [],
          ...(criterion.verificationHint !== undefined
            ? { verificationHint: criterion.verificationHint }
            : {}),
        },
      ];
    });

  return {
    schemaVersion: 1,
    generatedAt: input.now,
    realizationId: input.realization.id,
    proposalId: proposal.id,
    attempt: input.attempt,
    previousOutcome: previous.outcome,
    failedRules,
    failedCriteria,
    technicalFailures: previous.outcome === "technical-failure" ? technicalFailuresOf(input) : [],
    affectedTargets: affectedTargets(input.realization.scope, failedRules, failedCriteria),
    satisfied: {
      rules: previous.ruleResults
        .filter((r) => r.outcome === "holds")
        .map((r) => formatClaimRef(r.rule)),
      criteria: previous.acceptanceResults
        .filter((r) => r.outcome === "satisfied")
        .map((r) => formatCriterionRef(proposal.id, r.criterionId)),
    },
  };
}

function technicalFailuresOf(input: RemediationInput): Array<{ label: string; detail?: string }> {
  const attempt = input.realization.attempts.find((a) => a.attempt === input.attempt - 1);
  return attempt?.technical?.failed ?? [];
}

/**
 * The scope entries a remediation should look at first: every target whose
 * reasons name one of the failing rules, plus every path the failing results'
 * own evidence cited. Targeted, so attempt 2 is told "this file, this rule",
 * not "here is the whole change again".
 *
 * Falls back to the full scope when nothing narrows — an empty list would
 * read as "nothing to look at", which is never what Argus means.
 */
function affectedTargets(
  scope: ImplementationScope,
  failedRules: RemediationFailedRule[],
  failedCriteria: RemediationFailedCriterion[],
): ImplementationTarget[] {
  const rules = failedRules.map((r) => r.rule);
  const cited = new Set<string>();
  for (const r of [...failedRules, ...failedCriteria]) {
    for (const e of r.evidence) if (e.type === "source-code") cited.add(e.path);
  }
  const narrowed = scope.targets.filter(
    (t) =>
      cited.has(t.path) ||
      t.reasons.some((reason) => reason.claim && rules.some((r) => sameRef(r, reason.claim!))),
  );
  if (narrowed.length > 0) return narrowed;
  // Nothing in the failures points anywhere. The whole scope, minus the
  // regression surface, is still better guidance than silence.
  const work = scope.targets.filter((t) => !t.preserveOnly);
  return work.length > 0 ? work : scope.targets;
}

/** The document text handed to the run. */
export function remediationContextText(ctx: RemediationContext): string {
  return `${JSON.stringify(ctx, null, 2)}\n`;
}

/**
 * The prompt block a remediation step gets.
 *
 * Says what is unmet, what already holds and must stay holding, and — the one
 * thing a remediation agent gets wrong by default — that the accepted business
 * intent is not up for revision. If the intent itself is the problem, the
 * honest answer is `ARGUS_OUTCOME: blocked`, not a rewritten rule.
 */
export function remediationInstruction(ctx: RemediationContext | null): string {
  if (!ctx) return "";
  const lines = [
    "",
    "",
    `Targeted remediation (attempt ${ctx.attempt}). A previous attempt implemented this accepted`,
    "change and Argus's verification found it incomplete. The exact unmet results are in the file",
    "named by the ARGUS_REMEDIATION_CONTEXT_FILE environment variable, with the evidence the",
    "verifier cited and the files they point at. Fix only those.",
  ];
  if (ctx.failedRules.length > 0) {
    lines.push(
      `Unmet business rules: ${ctx.failedRules.map((r) => `${r.ref} (${r.outcome})`).join(", ")}.`,
    );
  }
  if (ctx.failedCriteria.length > 0) {
    lines.push(
      `Unmet acceptance criteria: ${ctx.failedCriteria
        .map((c) => `${c.criterionId} (${c.outcome}) ${c.statement}`)
        .join("; ")}.`,
    );
  }
  if (ctx.technicalFailures.length > 0) {
    lines.push(`Failing checks: ${ctx.technicalFailures.map((f) => f.label).join(", ")}.`);
  }
  if (ctx.satisfied.rules.length > 0 || ctx.satisfied.criteria.length > 0) {
    lines.push(
      `Already satisfied — do not break these: ${[...ctx.satisfied.rules, ...ctx.satisfied.criteria].join(", ")}.`,
    );
  }
  lines.push(
    "The accepted business intent is not up for revision here. If it cannot be implemented as",
    "accepted — a contradiction, a missing external contract, a criterion that cannot be made",
    "testable — report `ARGUS_OUTCOME: blocked` with the reason instead of changing what the",
    "business is taken to have decided.",
  );
  return lines.join("\n");
}

/** One line naming an attempt's verdict, for a journal entry or a reason. */
export function describeVerdict(verdict: CompletionVerdict): string {
  return `${verdict.outcome}: ${verdict.reason}`;
}
