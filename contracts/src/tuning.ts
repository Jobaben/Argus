/**
 * Tuning: a per-phase settings review for one pipeline.
 *
 * Pressing **Analyze** on a pipeline asks one bounded model pass per phase
 * whether that phase's model, reasoning effort, timeout and turn cap fit the
 * work its steps' prompts describe. Everything a pass returns is a *proposal*:
 * nothing here is applied until a human ticks it and saves, through the same
 * admin-gated pipeline update as any hand edit.
 *
 * Two absences are the point of this contract. There is no field that can
 * carry prompt text — a pass reads prompts to judge the work and has no way to
 * hand a rewrite back. And "no change" is not a proposal with a null value; it
 * is the *absence* of a proposal plus the step's name under `unchanged`, so a
 * phase whose settings already fit produces an empty list and a `ready`
 * status, never a manufactured diff.
 */

/** The closed set of settings a pass may propose changing. */
export type TuningField = "model" | "reasoningEffort" | "timeoutSeconds" | "maxTurns";

/** Whether a proposal targets one step or the phase's own defaults. */
export type TuningScope = "phase" | "step";

/** Where the setting a proposal replaces currently comes from. `cli` means no
 *  level sets it and the agent CLI's own default applies. */
export type TuningInheritedFrom = "step" | "phase" | "pipeline" | "cli";

export type PhaseTuningStatus = "pending" | "running" | "ready" | "failed" | "skipped";

export type TuningStatus = "running" | "ready" | "failed" | "skipped";

export interface TuningProposal {
  phaseId: string;
  phaseName: string;
  scope: TuningScope;
  /** Null for a phase-scoped proposal. */
  stepName: string | null;
  stepIndex: number | null;
  field: TuningField;
  /** The effective value today, resolved through step → phase → pipeline. */
  current: string | number | null;
  proposed: string | number;
  inheritedFrom: TuningInheritedFrom;
  /** `current` and `proposed` rendered for a human, derived server-side. */
  before: string;
  after: string;
  /** The pass's one-sentence justification. Required: an unexplained change is
   *  not reviewable. */
  reason: string;
}

export interface PhaseTuning {
  phaseId: string;
  phaseName: string;
  status: PhaseTuningStatus;
  /** The pass's one-line read of the phase, or null before it has one. */
  summary: string | null;
  proposals: TuningProposal[];
  /** Steps the pass looked at and left alone. */
  unchanged: string[];
  /** Proposals dropped during validation, one line each, so a pass that named
   *  a model outside the roster is visible rather than silently smaller. */
  warnings: string[];
  costUsd: number | null;
  tokens: number | null;
  durationMs: number | null;
  /** Why there is no result, when `status` is `failed` or `skipped`. */
  error: string | null;
}

export interface TuningReport {
  id: string;
  pipelineId: string;
  pipelineName: string;
  status: TuningStatus;
  startedAt: string;
  endedAt: string | null;
  phasesDone: number;
  phasesTotal: number;
  phases: PhaseTuning[];
  /** Spend across every phase pass, so a review is never free-looking. */
  costUsd: number | null;
  tokens: number | null;
  error: string | null;
}

export interface TuningResponse {
  /** The newest report for this pipeline, or null when none has run. */
  report: TuningReport | null;
  /** Why a pass cannot be started right now, if it can't. */
  unavailable: string | null;
}
