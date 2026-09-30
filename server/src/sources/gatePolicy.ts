import type { PhaseDef, PhaseProgress, StepProgress } from "./pipelineTypes.js";

/**
 * Which gates an automated judgment may open.
 *
 * A gate is the acceptance boundary for whatever its phase staged: approving it
 * is what commits a KnowledgeDelta, a rule verification, a change proposal or
 * an acceptance result into `knowledge.json`, and what lets a realization
 * record its attempt. A Verdict score is a model's rating of an agent's final
 * message — text the judged agent wrote — so it must never be what makes
 * semantic knowledge canonical. This module is the one definition of "this gate
 * commits knowledge", used at three places that must agree:
 *
 * 1. pipeline validation, which refuses `autoApprove` on such a phase when a
 *    definition is saved;
 * 2. the engine's automated-approval boundary, which refuses at runtime — the
 *    check that actually protects legacy definitions saved before (1), and
 *    instances whose definition snapshot predates it;
 * 3. the Verdict watcher, which does not even ask.
 *
 * Two inputs, and neither is anything an agent declares:
 *
 * - **configuration** (`knowledgeCommitReasons`) — the phase's own definition
 *   says it stages or commits knowledge. Knowable before anything runs.
 * - **staging** (`stagedKnowledgeReasons`) — what this attempt actually staged,
 *   read from Argus's own staging records on the steps. Needed because every
 *   step is offered an *optional* KnowledgeDelta: an ordinary phase can stage a
 *   delta that its configuration never mentions. A step that staged nothing
 *   leaves nothing to commit, so the absence is Argus's observation, not the
 *   agent's claim.
 */

export type KnowledgeCommitReason =
  | "discovery"
  | "rule-verification"
  | "change-intent"
  | "acceptance-verification"
  | "implementation"
  | "knowledge-delta-required";

/** Why this phase's configuration makes its gate a knowledge commit. Empty = it does not. */
export function knowledgeCommitReasons(phase: PhaseDef): KnowledgeCommitReason[] {
  const out: KnowledgeCommitReason[] = [];
  if (phase.discovery) out.push("discovery");
  if (phase.ruleVerification) out.push("rule-verification");
  if (phase.changeIntent) out.push("change-intent");
  if (phase.acceptanceVerification) out.push("acceptance-verification");
  // An implementation phase's acceptance is when its realization records the
  // attempt in the ledger.
  if (phase.implementation) out.push("implementation");
  if (phase.knowledgeDelta === "required") out.push("knowledge-delta-required");
  return out;
}

export type StagedKnowledgeReason =
  | "staged-knowledge-delta"
  | "staged-rule-verification"
  | "staged-change-proposal"
  | "staged-acceptance-verification"
  | "pending-knowledge-commit"
  | "realization-attempt";

/**
 * What this attempt has staged for commit, from Argus's staging records. A
 * sidecar is counted whatever its status except the two that can never commit
 * (`rejected`, `superseded`) — erring toward "there is something here".
 */
export function stagedKnowledgeReasons(phase: PhaseProgress): StagedKnowledgeReason[] {
  const live = (s?: { status?: string } | null) =>
    !!s && s.status !== "rejected" && s.status !== "superseded";
  const out: StagedKnowledgeReason[] = [];
  if (phase.steps.some((s) => live(s.knowledgeDelta))) out.push("staged-knowledge-delta");
  if (phase.steps.some((s) => live(s.ruleVerification))) out.push("staged-rule-verification");
  if (phase.steps.some((s) => live(s.changeProposal))) out.push("staged-change-proposal");
  if (phase.steps.some((s) => live(s.acceptanceVerification)))
    out.push("staged-acceptance-verification");
  if (phase.knowledge?.status === "pending") out.push("pending-knowledge-commit");
  if (phase.realization) out.push("realization-attempt");
  return out;
}

/** The authoring-time error, phrased so the author knows what to change. */
export function autoApproveRefusal(phaseLabel: string, reasons: readonly string[]): string {
  return (
    `${phaseLabel}: autoApprove cannot open a gate that commits knowledge ` +
    `(${reasons.join(", ")}). A person must approve this gate. Remove autoApprove from this ` +
    `phase; a rubric may stay, and scoring still runs, but approval is manual.`
  );
}

/**
 * The steps whose output is what passes this gate, and so what an automated
 * approval must have judged — every one of them.
 *
 * Ordinarily every step of the attempt. A best-of-N phase that has selected a
 * candidate passes only the winner's work (the losers are aborted and their
 * worktrees removed), so only the winner's steps are relevant.
 */
export function gateRelevantSteps(phase: PhaseProgress): StepProgress[] {
  if (phase.selectedCandidate != null) {
    return phase.steps.filter((s) => s.candidate === phase.selectedCandidate);
  }
  return phase.steps;
}
