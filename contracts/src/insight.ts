/**
 * Derived board signal — the "situation" the Command Center header answers at
 * a glance: what is in flight, what is blocked on a human, what it is costing,
 * and what fires next.
 *
 * Every field is a pure derivation over state the server already reads
 * (instances, runs, monitors, issues, schedules, the spend ledger). Nothing new
 * is persisted for it.
 */

import type { BudgetState, BudgetWindow } from "./budget.js";

export interface SituationCounts {
  /** Runs the engine believes are executing right now. */
  runsInFlight: number;
  /** Gated phases sitting in `awaiting-approval` — work blocked on a human. */
  gatesWaiting: number;
  /** Pipeline instances that ended in `failed`. */
  failedInstances: number;
  monitorsDown: number;
  monitorsFailing: number;
  openIssues: number;
  /** Background agents present in the daemon roster. */
  liveAgents: number;
  /** Runs that left their learned envelope, in the Watchtower report window. */
  anomalies: number;
}

export type NextFireKind = "schedule" | "pipeline";

export interface NextFire {
  id: string;
  name: string;
  kind: NextFireKind;
  at: string;
}

/** One bucket of the run-outcome histogram. */
export interface ThroughputBucket {
  /** Inclusive start of the bucket. */
  at: string;
  succeeded: number;
  failed: number;
}

export interface Situation {
  generatedAt: string;
  counts: SituationCounts;
  spend: {
    state: BudgetState;
    today: BudgetWindow;
    month: BudgetWindow;
  };
  /** The soonest upcoming scheduled firing across schedules and pipelines. */
  nextFire: NextFire | null;
  /** Hourly run-outcome buckets covering the last 24h, oldest first. */
  throughput: ThroughputBucket[];
}
