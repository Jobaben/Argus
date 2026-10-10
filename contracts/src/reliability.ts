/**
 * Reliability derivation: how often a pipeline's own phases pass on the first
 * try, where they lose attempts, and whether a "succeeded" run was clean or
 * lucky.
 *
 * Argus already has three ways to grade a run — Verdict (a rubric score),
 * Watchtower (this run vs. this unit of work's own envelope) and Ledger
 * (what it cost) — but none of them answers the question a binary pass/fail
 * hides: a phase that only passed after a retry or a human revise is not the
 * same fact as a phase that passed cleanly, even though both end up
 * `succeeded` on the board. AgentLens found 0.5–23% of "passing" agent
 * trajectories are exactly this kind of lucky pass. This is the derivation
 * that tells the two apart, per pipeline, over a trailing window.
 *
 * The "first attempt" rule — see `deriveReliability` in
 * `@argus/server/sources/reliability.ts` for the full reasoning — is:
 * `PhaseProgress.attempt === 1` at the phase's final status means it neither
 * retried nor was revised; anything higher means at least one of those
 * happened, whatever mix of automatic retries and human revises produced it.
 */

import type { PhaseFailureClass } from "./pipelines.js";

export interface PhaseReliability {
  phaseId: string;
  name: string;
  /** Instances in the window where this phase ran at all (i.e. reached a
   *  terminal status — succeeded, failed or aborted — rather than staying
   *  `pending` or `skipped`). */
  instances: number;
  /** Succeeded with `attempt === 1` and no retries: passed clean. */
  firstAttemptPass: number;
  /** Succeeded only after ≥1 retry or revise (`attempt > 1`). */
  luckyPass: number;
  /** Ended `failed` in the final record. */
  failed: number;
  /** Mean `attempt` across every instance where the phase ran (succeeded,
   *  failed or aborted); null when it never ran in the window. */
  meanAttempts: number | null;
  /** Count of failed instances by the final payload's `failureClass`, for the
   *  subset that reported one. Partial: classes that never occurred are
   *  simply absent, not zero. */
  failureClasses: Partial<Record<PhaseFailureClass, number>>;
  /** Share of instances (of `instances`, not just the failed ones) whose
   *  final payload classed the failure as `"verification"`; null when the
   *  phase never ran in the window. */
  verificationFailRate: number | null;
  /** Failures classed `"timeout"` — Argus's stand-in for "the step stalled
   *  and never came back", since a stall is reported as a timed-out step. */
  stalls: number;
  /** Mean of the phase's steps' summed reported duration, over instances
   *  where at least one step reported one; null when none did. Covers only
   *  the attempt that is on the final record — an earlier attempt's spend is
   *  not retained once a retry or revise replaces its steps. */
  meanDurationMs: number | null;
  /** Same caveat as `meanDurationMs`, for summed step cost. */
  meanCostUsd: number | null;
}

export interface PipelineReliability {
  pipelineId: string;
  windowDays: number;
  /** Settled (succeeded/failed/aborted) instances started or ended in the
   *  window — see the deriving function for the exact boundary. */
  instances: number;
  succeeded: number;
  failed: number;
  aborted: number;
  /** Share of `instances` that succeeded with every phase that ran passing on
   *  attempt 1. Null when `instances` is 0 — not 0, which would claim a
   *  perfect record instead of no evidence at all. */
  firstAttemptSuccessRate: number | null;
  /** Share of `succeeded` instances that needed ≥1 lucky phase to get there.
   *  Null when nothing succeeded in the window. */
  luckyPassRate: number | null;
  phases: PhaseReliability[];
  /** One entry per calendar day (UTC) in the window, oldest first, counting
   *  settled instances by the day they ended. */
  trend: Array<{ day: string; succeeded: number; failed: number }>;
  computedAt: string;
}
