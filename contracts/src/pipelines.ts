/** Pipeline definitions, running instances, and the board overview. */

import type { AgentRuntimeId, ReasoningEffort } from "./runtimes.js";
import type { Trigger } from "./schedules.js";
import type { AutoApprove, Rubric } from "./verdict.js";

export interface PhaseStep {
  name: string;
  prompt: string;
  model?: string;
  /** Codex-only override; absent inherits the pipeline/CLI setting. */
  reasoningEffort?: ReasoningEffort;
  /** Overrides the phase's (and pipeline's) runtime for this one step. */
  runtime?: AgentRuntimeId;
}

/**
 * Which observable failures are worth another attempt.
 *
 * Deliberately not "any": an agent that *signalled* failure has considered the
 * work and reported on it, and running the same prompt again is unlikely to
 * change its mind — while a process that never started, or died on a non-zero
 * exit, plausibly hit something transient.
 */
export type RetryableClass = "spawn" | "exit-code" | "signal";

export interface RetryPolicy {
  /** Total attempts including the first. 1 means no retry. */
  attempts: number;
  /** Delay before the first retry. Doubles each subsequent attempt. */
  backoffSeconds: number;
  /** Defaults to `["spawn", "exit-code"]` — the transient-looking ones. */
  retryOn?: RetryableClass[];
}

/** A dependency can preserve the legacy phase-id shorthand or describe a route. */
export type Dependency = string | DependencyEdge;

/** The object form of a dependency edge. */
export interface DependencyEdge {
  phase: string;
  when?: RouteCondition;
  /** Accept a source phase that was intentionally skipped by routing. */
  allowSkipped?: boolean;
}

export interface RouteCondition {
  group?: string;
  exclusive?: boolean;
  required?: boolean;
  default?: true;
  predicate?: RoutePredicate;
}

export interface RoutePredicate {
  path: string[];
  operator: "equals" | "not-equals" | "one-of" | "exists";
  value?: string | number | boolean | null | Array<string | number | boolean | null>;
}

/** A deliberately small recursive schema for a JSON phase result. */
export interface ResultSchema {
  type: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, ResultSchema>;
  required?: string[];
  items?: ResultSchema;
  enum?: Array<string | number | boolean | null>;
}

/** Opt-in structured outcome a completed phase may publish. */
export interface PhaseResult {
  artifact: string;
  resultStep?: string;
  schema: ResultSchema;
}

/** Immutable outcome of evaluating a result-producing phase's routes. */
export interface RouteDecision {
  sourcePhase: string;
  artifact: string;
  value: unknown;
  selected: string[];
  skipped: string[];
  reason: string;
}

export interface PhaseDef {
  id: string;
  name: string;
  cwd: string;
  steps: PhaseStep[];
  gated: boolean;
  /**
   * Phase ids this one waits for.
   *
   * Absent on **every** phase means the pipeline is linear and each phase
   * implicitly needs the one before it — which is how every pipeline authored
   * before Weave keeps working, unchanged, as a degenerate DAG.
   */
  needs?: Dependency[];
  /** Opt-in structured result used by conditional outgoing dependencies. */
  result?: PhaseResult;
  /** Retry policy for this phase's steps. Absent = one attempt. */
  retry?: RetryPolicy;
  /**
   * Publish this phase's payload under a name later phases can interpolate as
   * `{{artifacts.<name>}}`. Absent = the payload is only visible to the
   * immediately following phase, as `{{previous.payload}}`.
   */
  produces?: string;
  /** Opt-in quality rubric for this phase's output. */
  rubric?: Rubric;
  /** On a gated phase: let the gate open itself when the verdict clears the
   *  bar. Requires `rubric`; without one there is nothing to clear. */
  autoApprove?: AutoApprove;
  /** Overrides the pipeline's runtime for every step in this phase. */
  runtime?: AgentRuntimeId;
}

export interface PipelineDefinition {
  id: string;
  name: string;
  phases: PhaseDef[];
  trigger: Trigger | null;
  enabled: boolean;
  overlapPolicy: "skip" | "allow";
  model?: string;
  /** Default Codex reasoning effort for steps that do not override it. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Which agent CLI runs this pipeline's steps, unless a phase or step names
   * another. Absent = the server default, so every pipeline authored before
   * runtimes existed keeps running on Claude Code exactly as it did.
   */
  runtime?: AgentRuntimeId;
  lastStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The client-authored half of a pipeline (POST/PUT body). */
export interface PipelineInput {
  name: string;
  phases: PhaseDef[];
  trigger: Trigger | null;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
  model?: string;
  reasoningEffort?: ReasoningEffort;
  runtime?: AgentRuntimeId;
}

export type InstanceStatus = "running" | "awaiting-approval" | "failed" | "succeeded" | "aborted";

export type PhaseStatus =
  "pending" | "running" | "awaiting-approval" | "succeeded" | "skipped" | "failed" | "aborted";

export type StepStatus = "pending" | "running" | "succeeded" | "skipped" | "failed" | "aborted";

export interface StepProgress {
  name: string;
  runId: string | null;
  status: StepStatus;
  /** USD cost of the step's run, joined from the run record at read time. */
  costUsd?: number | null;
  /** Total tokens of the step's run, joined from the run record at read time. */
  tokens?: number | null;
  /** Model the step's run was started with, joined from the run record. */
  model?: string | null;
  /** Runtime the step's run was started with, joined from the run record. */
  runtime?: AgentRuntimeId | null;
  /** Latest activity label from the run tailer; only set while running. */
  currentActivity?: string | null;
  /** Arrival timestamp of that activity. */
  activityAt?: string | null;
  /** Run start time, joined from the run record. */
  startedAt?: string | null;
  /** Final run duration, joined from the run record when it ended. */
  durationMs?: number | null;
  /**
   * The structured result this step delivered, exactly as it was submitted.
   *
   * Held per-step because a phase's result arrives with one step's completion
   * signal while its siblings may still be running, and it is the phase — not
   * the step — that publishes a decision once every step is in.
   */
  result?: unknown;
  /** Why the step's declared result could not be read (e.g. a torn file). */
  resultError?: string;
}

export interface PhaseProgress {
  id: string;
  name: string;
  gated: boolean;
  status: PhaseStatus;
  steps: StepProgress[];
  /** Which attempt of this phase is in flight. Bumped by a revise *and* by an
   *  automatic retry, so the two read the same on the board. */
  attempt: number;
  /** Phase ids this one waited for, resolved (so a linear phase shows its
   *  implicit predecessor). Lets the board draw the graph without the def. */
  needs?: string[];
  /** Retries already consumed by the current attempt chain. */
  retries?: number;
  /** When the next automatic retry is due, while one is pending. */
  retryAt?: string | null;
  /** Free-form: a gated phase carries whatever its agent signalled, a failed
   *  phase carries a {@link PhaseFailurePayload}. Narrow before reading. */
  payload: unknown | null;
  /** Validated structured outcome, intentionally separate from legacy payloads. */
  result?: unknown;
}

/** What the engine writes into `PhaseProgress.payload` when a phase fails.
 *  `kind: "restarted"` means the run was orphaned by an Argus restart rather
 *  than having genuinely failed, which the UI offers to retry instead of revise. */
export interface PhaseFailurePayload {
  reason?: string;
  kind?: "restarted" | string;
}

export interface PipelineInstance {
  id: string;
  pipelineId: string;
  pipelineName: string;
  status: InstanceStatus;
  currentPhaseIndex: number;
  phases: PhaseProgress[];
  trigger: "manual" | "scheduled";
  signalToken: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** Named payloads published by completed phases, for `{{artifacts.<name>}}`. */
  artifacts?: Record<string, unknown>;
  /** Immutable records for phase outcomes that selected conditional routes. */
  routeDecisions?: RouteDecision[];
}

export type SignalType = "completed" | "needs-input" | "failed";

export interface PipelineSignal {
  instanceId: string;
  phaseId: string;
  runId: string;
  type: SignalType;
  token: string;
  payload?: unknown;
  /**
   * The structured result the run wrote to its result file, parsed by the stop
   * hook. Never derived from the agent's prose: routing reads declared JSON or
   * it fails the phase.
   */
  result?: unknown;
  /** Set instead of `result` when the result file existed but could not be read. */
  resultError?: string;
}

/** Aggregated spend for one instance. Null field = no run reported that metric. */
export interface OverviewCost {
  usd: number | null;
  tokens: number | null;
}

export interface OverviewEntry {
  definition: PipelineDefinition;
  latest: PipelineInstance | null;
  /** Total spend of the latest instance across all its runs (including
   *  superseded revise attempts). Null when there is no instance. */
  cost: OverviewCost | null;
  /** Instances sharing the board, newest-first: every non-terminal one
   *  (running / awaiting-approval) plus terminal ones whose lifetime
   *  overlapped the latest instance, so a just-stopped sibling stays visible
   *  beside its peers. Empty when only the lone `latest` instance remains. */
  active: { instance: PipelineInstance; cost: OverviewCost }[];
}
