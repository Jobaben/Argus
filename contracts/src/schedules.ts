/** Triggers, schedules, run records and one-off launches. */

import type { BudgetAction } from "./ledger.js";
import type { AgentRuntimeId, ReasoningEffort } from "./runtimes.js";
import type { Rubric } from "./verdict.js";

export type TriggerKind = "interval" | "daily" | "weekly" | "windowed" | "webhook" | "after";

/**
 * When a schedule fires. `everyMinutes` for interval and windowed cadence;
 * `time` ("HH:MM", local) for daily/weekly; `weekday` (0=Sun..6=Sat) for weekly;
 * `startTime`/`endTime` ("HH:MM", local, end exclusive) bound the windowed daily
 * window — an endTime before startTime wraps past midnight into the next day;
 * `weekdays` optionally restricts windowed to the days the window opens on
 * (empty/omitted = every day).
 *
 * `kind: "webhook"` carries no cadence field at all — the owning definition is
 * fired by `POST /api/hooks/{pipelines,schedules}/:id` instead of by the
 * scheduler tick. `kind: "after"` chains this definition off another
 * pipeline's instances: `pipelineId` names the source pipeline (only
 * pipelines may be a chain's source) and `on` says which of its outcomes
 * fires this one. Neither kind is understood by `nextFire.ts`'s cadence math;
 * both are handled as their own firing paths (the webhook route, the
 * scheduler's chain pass).
 */
export interface Trigger {
  kind: TriggerKind;
  everyMinutes?: number;
  time?: string;
  weekday?: number;
  startTime?: string;
  endTime?: string;
  weekdays?: number[];
  /** `kind: "after"` only: the source pipeline's id. */
  pipelineId?: string;
  /** `kind: "after"` only: which of the source pipeline's outcomes fires this one. */
  on?: "succeeded" | "failed" | "any";
}

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled: boolean;
  overlapPolicy: "skip" | "allow";
  /** Anacron-style recovery: when the latest slot was missed beyond the firing
   *  grace (machine asleep, Argus down), fire it once on the next tick instead
   *  of dropping it. Absent = false, so pre-existing schedules keep the old
   *  skip-on-miss behavior. */
  catchUp?: boolean;
  /** Opt-in quality rubric. When set, each completed run is scored by a
   *  bounded judge pass and the score trends on the schedule's card. */
  rubric?: Rubric;
  /** Which agent CLI runs this schedule. Absent = the server default. */
  runtime?: AgentRuntimeId;
  /** Optional model override passed to the selected runtime. */
  model?: string;
  /** Codex-only per-run reasoning override. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Bearer credential for `POST /api/hooks/schedules/:id`, minted once this
   * schedule's `trigger` first becomes `kind: "webhook"` and kept stable
   * across later edits — regenerated only via
   * `POST /api/schedules/:id/hook-token/rotate`. This is a single-user control
   * plane behind `ARGUS_TOKEN`; the token is returned in GET responses rather
   * than hashed, the way `ARGUS_TOKEN` itself is a plaintext shared secret.
   */
  hookToken?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
}

/** A schedule joined with its next computed firing instant. */
export interface ScheduleWithNext extends Schedule {
  nextRun: string | null;
}

/** The client-authored half of a schedule (POST/PUT body). */
export interface ScheduleInput {
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
  catchUp?: boolean;
  /** Null clears an existing rubric; absent leaves it alone on a PATCH. */
  rubric?: Rubric | null;
  /** Null clears the override (back to the server default); absent leaves it alone. */
  runtime?: AgentRuntimeId | null;
  /** Null clears the model override; absent leaves it alone on a PATCH. */
  model?: string | null;
  /** Null clears the Codex reasoning override; absent leaves it alone on a PATCH. */
  reasoningEffort?: ReasoningEffort | null;
}

export type RunStatus =
  "running" | "succeeded" | "failed" | "skipped" | "interrupted" | "cancelled";

/** Work-level conclusion from a pipeline signal, distinct from the
 *  exit-code-derived run `status`. */
export type RunOutcome = "succeeded" | "failed" | "blocked";

export interface Run {
  id: string;
  scheduleId: string;
  scheduleName: string;
  prompt: string;
  cwd: string;
  status: RunStatus;
  /** `"webhook"` — fired by `POST /api/hooks/schedules/:id`. `"chained"` —
   *  fired by an `after` trigger once a source pipeline instance ended. */
  trigger: "scheduled" | "manual" | "webhook" | "chained";
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  pid: number | null;
  exitCode: number | null;
  sessionId: string | null;
  model?: string;
  /** Codex reasoning effort used for this run, when explicitly selected. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Which agent CLI executed this run. Absent means `"claude"` — every run
   * recorded before runtimes existed was one, and rewriting history to say so
   * would be a migration with nothing to gain.
   */
  runtime?: AgentRuntimeId;
  project: string | null;
  resultSummary: string | null;
  error: string | null;
  instanceId?: string;
  phaseId?: string;
  /** Total reported USD, or a public token-price estimate for supported Codex models. */
  costUsd?: number | null;
  /** Total tokens (input+output) reported by the CLI result envelope, if present. */
  tokens?: number | null;
  /** Set once the run's cost has been folded into the all-time totals; guards
   *  against double-counting across the several terminal-write paths. */
  countedInTotals?: boolean;
  /** Null/absent for non-pipeline or unsignalled runs. */
  outcome?: RunOutcome | null;
  /** When the harness will kill this run if it is still alive. Null = no limit. */
  deadlineAt?: string | null;
  /**
   * How the process ended, when the harness knows more than the exit code:
   * `timed-out` — killed at its deadline; `killed` — aborted/cancelled by
   * Argus; `spawn-failed` — never started. Absent = it exited on its own.
   */
  termination?: "exited" | "timed-out" | "killed" | "spawn-failed";
  /**
   * The budget ladder step that governed this run, when one did.
   *
   * Recorded on the run itself so a cheap or missing run is explicable months
   * later: "why did Tuesday's run use Haiku" is answered by the record, not by
   * correlating timestamps against a policy that has since been edited.
   */
  budgetAction?: BudgetAction;
  /** Set when `budgetAction` was `downgrade`: the model it would have used. */
  modelDowngradedFrom?: string;
}

/** One-off run fired from the Launch tab (POST /api/launch). */
export interface LaunchInput {
  name?: string;
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Which agent CLI to run. Absent = the server default. */
  runtime?: AgentRuntimeId;
}
