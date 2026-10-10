import type { Rubric, TrajectorySignalKind, Verdict } from "@argus/contracts";
import type { PhaseDef, PhaseProgress, StepProgress } from "./pipelineTypes.js";
import { rubricDigest } from "./verdict.js";
import {
  hasTrajectory,
  heldSignals,
  judgesTrajectory,
  TRAJECTORY_PROMPT_VERSION,
  TRAJECTORY_SIGNALS_VERSION,
  trajectoryRubricDigest,
} from "./trajectory.js";

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

/** One relevant run's judgment, as a qualification saw it. */
export interface QualificationBasisEntry {
  runId: string;
  stepName: string;
  verdictId: string;
  at: string;
  score: number;
  rubricDigest: string;
  runtime: string | null;
  requestedModel: string | null;
  reportedModel: string | null;
  promptVersion: number | null;
}

/** One relevant run's trajectory judgment, as a qualification saw it. */
export interface TrajectoryBasisEntry {
  runId: string;
  stepName: string;
  verdictId: string;
  at: string;
  /** The weighted trajectory rating; null for a check-only rubric. */
  score: number | null;
  /** Signals the check holds on that were observed, recomputed from the stored signals. */
  held: TrajectorySignalKind[];
  signalsVersion: number;
  rubricDigest: string;
  runtime: string | null;
  requestedModel: string | null;
  reportedModel: string | null;
  promptVersion: number | null;
}

export type TrajectoryInsufficiency =
  | "no-trajectory-verdict"
  | "trajectory-without-id"
  | "trajectory-not-ready"
  | "trajectory-rubric-mismatch"
  | "trajectory-signals-unavailable"
  | "trajectory-signals-truncated"
  | "trajectory-prompt-mismatch";

/**
 * Whether one run's current trajectory verdict can stand in an approval's
 * basis — the one definition shared by the qualification below and the
 * engine's automated-approval boundary. Everything is read from the stored
 * record, and `held` is recomputed from its stored signals against the
 * rubric's check rather than taken from the record.
 *
 * A missing, unready, mismatched or signal-less judgment, or one over a
 * truncated recording, is insufficient: it holds the gate. Whether the score
 * clears the bar, and whether anything was held, is the caller's comparison.
 */
export function trajectoryBasisEntry(
  v: Verdict | undefined,
  rubric: Rubric,
  runId: string,
  stepName: string,
): { ok: true; entry: TrajectoryBasisEntry } | { ok: false; reason: TrajectoryInsufficiency } {
  if (!v || v.kind !== "trajectory" || v.runId !== runId) {
    return { ok: false, reason: "no-trajectory-verdict" };
  }
  if (!v.id) return { ok: false, reason: "trajectory-without-id" };
  if (v.status !== "ready") return { ok: false, reason: "trajectory-not-ready" };
  if (v.rubricDigest !== trajectoryRubricDigest(rubric)) {
    return { ok: false, reason: "trajectory-rubric-mismatch" };
  }
  const signals = v.trajectory?.signals;
  if (
    !signals ||
    signals.transcript !== "present" ||
    signals.version !== TRAJECTORY_SIGNALS_VERSION ||
    !Array.isArray(signals.signals)
  ) {
    return { ok: false, reason: "trajectory-signals-unavailable" };
  }
  // A truncated recording dropped its earliest events. What it kept cannot
  // show that a held signal never occurred, nor give a judge the whole path:
  // insufficient input — not an observed violation, and never clean.
  if (signals.truncated !== false) {
    return { ok: false, reason: "trajectory-signals-truncated" };
  }
  if (judgesTrajectory(rubric)) {
    if (v.score === null || typeof v.score !== "number") {
      return { ok: false, reason: "trajectory-not-ready" };
    }
    if (v.provenance?.promptVersion !== TRAJECTORY_PROMPT_VERSION) {
      return { ok: false, reason: "trajectory-prompt-mismatch" };
    }
  }
  return {
    ok: true,
    entry: {
      runId,
      stepName,
      verdictId: v.id,
      at: v.at,
      score: judgesTrajectory(rubric) ? v.score : null,
      held: heldSignals(signals, rubric.trajectory?.check?.holdOn ?? []),
      signalsVersion: signals.version,
      rubricDigest: v.rubricDigest,
      runtime: v.provenance?.runtime ?? null,
      requestedModel: v.provenance?.requestedModel ?? null,
      reportedModel: v.provenance?.reportedModel ?? null,
      promptVersion: v.provenance?.promptVersion ?? null,
    },
  };
}

/** The bar a trajectory score is compared against: `autoApprove.trajectory`,
 *  else the output bar. Null when the rubric declares no trajectory criteria. */
export function trajectoryBar(phaseDef: PhaseDef): number | null {
  if (!judgesTrajectory(phaseDef.rubric)) return null;
  return phaseDef.autoApprove?.trajectory ?? phaseDef.autoApprove?.verdict ?? null;
}

/**
 * Whether the Phase 0 auto-approval rules would open this gate, over the
 * verdicts given (RFC §M.3, §Q.6). Pure: it reads nothing and opens nothing.
 * The Verdict watcher uses it as its pre-check; the engine still decides
 * again, under its locks, before recording anything.
 *
 * The statuses are kept apart on purpose, because only `qualifies` means the
 * rule would open the gate:
 *
 * - `ineligible` — not a gate the rule may open: not a `gate` pause
 *   (`cause: "pause"`), or the gate commits knowledge by configuration or by
 *   what the attempt staged (`cause: "knowledge"`);
 * - `not-configured` — the phase declares no `autoApprove` bar, or no rubric;
 * - `insufficient-data` — a relevant step did not succeed, has no run, or has
 *   no current, `ready`, scored verdict with an id under this rubric; or, when
 *   the rubric declares a trajectory, no usable current trajectory judgment
 *   ({@link trajectoryBasisEntry});
 * - `below-threshold` — completely judged, and the lowest score is under the
 *   bar — or a trajectory score is under its bar, or the trajectory check held;
 * - `qualifies` — completely judged, and everything clears.
 *
 * `currentByRun` must hold each run's **current** output verdict
 * (`currentVerdicts`), and `trajectoryByRun` its current trajectory verdict
 * (`currentVerdicts(list, "trajectory")`). A rubric without a trajectory
 * never reads `trajectoryByRun`, and its result is exactly what it was before
 * trajectories existed.
 */
export type AutoApprovalQualification =
  | { status: "ineligible"; cause: "pause" | "knowledge"; reasons: string[] }
  | { status: "not-configured"; reason: "no-auto-approve" | "no-rubric" | "no-phase-definition" }
  | {
      status: "insufficient-data";
      reason:
        | "no-relevant-steps"
        | "step-not-succeeded"
        | "no-verdict"
        | "verdict-without-id"
        | "verdict-not-ready"
        | "rubric-mismatch"
        | TrajectoryInsufficiency;
      runId: string | null;
      bar: number;
      rubricDigest: string;
    }
  | {
      status: "below-threshold" | "qualifies";
      lowest: number;
      bar: number;
      rubricDigest: string;
      basis: QualificationBasisEntry[];
      /** Present only when the rubric declares a trajectory. */
      trajectory?: {
        rubricDigest: string;
        bar: number | null;
        lowest: number | null;
        held: TrajectorySignalKind[];
        basis: TrajectoryBasisEntry[];
      };
    };

export function autoApprovalQualification(
  phase: PhaseProgress,
  phaseDef: PhaseDef | undefined,
  currentByRun: ReadonlyMap<string, Verdict>,
  trajectoryByRun: ReadonlyMap<string, Verdict> = new Map(),
): AutoApprovalQualification {
  if (phase.status !== "awaiting-approval" || phase.pause !== "gate") {
    return {
      status: "ineligible",
      cause: "pause",
      reasons: [
        phase.status !== "awaiting-approval"
          ? `phase is ${phase.status}`
          : phase.pause === "needs-input"
            ? "needs-input pause"
            : "pause of unknown cause",
      ],
    };
  }
  if (!phaseDef) return { status: "not-configured", reason: "no-phase-definition" };
  const bar = phaseDef.autoApprove?.verdict;
  if (bar === undefined) return { status: "not-configured", reason: "no-auto-approve" };
  if (!phaseDef.rubric) return { status: "not-configured", reason: "no-rubric" };
  const reasons = [...knowledgeCommitReasons(phaseDef), ...stagedKnowledgeReasons(phase)];
  if (reasons.length > 0) return { status: "ineligible", cause: "knowledge", reasons };
  const digest = rubricDigest(phaseDef.rubric);
  const insufficient = (
    reason: Extract<AutoApprovalQualification, { status: "insufficient-data" }>["reason"],
    runId: string | null,
  ): AutoApprovalQualification => ({
    status: "insufficient-data",
    reason,
    runId,
    bar,
    rubricDigest: digest,
  });
  const steps = gateRelevantSteps(phase);
  if (steps.length === 0) return insufficient("no-relevant-steps", null);
  const bad = steps.find((st) => !st.runId || st.status !== "succeeded");
  if (bad) return insufficient("step-not-succeeded", bad.runId ?? null);
  const basis: QualificationBasisEntry[] = [];
  for (const step of steps) {
    const runId = step.runId as string;
    const v = currentByRun.get(runId);
    if (!v) return insufficient("no-verdict", runId);
    if (!v.id) return insufficient("verdict-without-id", runId);
    if (v.status !== "ready" || v.score === null) return insufficient("verdict-not-ready", runId);
    if (v.rubricDigest !== digest) return insufficient("rubric-mismatch", runId);
    basis.push({
      runId,
      stepName: step.name,
      verdictId: v.id,
      at: v.at,
      score: v.score,
      rubricDigest: v.rubricDigest,
      runtime: v.provenance?.runtime ?? null,
      requestedModel: v.provenance?.requestedModel ?? null,
      reportedModel: v.provenance?.reportedModel ?? null,
      promptVersion: v.provenance?.promptVersion ?? null,
    });
  }
  const lowest = Math.min(...basis.map((b) => b.score));
  if (!hasTrajectory(phaseDef.rubric)) {
    return {
      status: lowest < bar ? "below-threshold" : "qualifies",
      lowest,
      bar,
      rubricDigest: digest,
      basis,
    };
  }
  const tBasis: TrajectoryBasisEntry[] = [];
  for (const step of steps) {
    const runId = step.runId as string;
    const got = trajectoryBasisEntry(trajectoryByRun.get(runId), phaseDef.rubric, runId, step.name);
    if (!got.ok) return insufficient(got.reason, runId);
    tBasis.push(got.entry);
  }
  const tBar = trajectoryBar(phaseDef);
  const scores = tBasis.map((b) => b.score).filter((n): n is number => n !== null);
  const tLowest = scores.length > 0 ? Math.min(...scores) : null;
  const held = [...new Set(tBasis.flatMap((b) => b.held))];
  const below =
    lowest < bar || held.length > 0 || (tBar !== null && tLowest !== null && tLowest < tBar);
  return {
    status: below ? "below-threshold" : "qualifies",
    lowest,
    bar,
    rubricDigest: digest,
    basis,
    trajectory: {
      rubricDigest: trajectoryRubricDigest(phaseDef.rubric),
      bar: tBar,
      lowest: tLowest,
      held,
      basis: tBasis,
    },
  };
}
