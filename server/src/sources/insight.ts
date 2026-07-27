import type {
  NextFire,
  Situation,
  SituationCounts,
  ThroughputBucket,
  BudgetStatus,
} from "@argus/contracts";
import type { Agent } from "./types.js";
import type { Issue } from "./issues.js";
import type { MonitorHealth } from "./monitors.js";
import type { PipelineDefinition, PipelineInstance } from "./pipelineTypes.js";
import type { Run, ScheduleWithNext } from "./scheduleTypes.js";
import { nextFireAfter } from "./nextFire.js";

export type { NextFire, Situation, SituationCounts, ThroughputBucket } from "@argus/contracts";

/**
 * The board's situation: what is in flight, what is blocked on a human, what it
 * is costing, and what fires next.
 *
 * This exists because the Command Center answered none of those questions
 * without reading it. Every pipeline card is legible on its own, but "is
 * anything waiting for me?" and "how much have I spent today against my limit?"
 * required scanning the board and then visiting two other tabs. All of it is a
 * derivation over state the server already reads — nothing new is persisted.
 */

/** Hourly buckets over the last 24h. Hourly is the useful grain: finer and a
 *  sparkline of unattended runs is mostly empty, coarser and a bad hour hides. */
export const THROUGHPUT_BUCKETS = 24;
const BUCKET_MS = 3_600_000;

export interface SituationInput {
  runs: Run[];
  instances: PipelineInstance[];
  pipelines: PipelineDefinition[];
  schedules: ScheduleWithNext[];
  monitors: MonitorHealth[];
  issues: Issue[];
  agents: Agent[];
  budget: BudgetStatus;
}

/** A run the engine believes is executing right now. */
function isInFlight(run: Run): boolean {
  return run.status === "running";
}

/**
 * A phase waiting on a human.
 *
 * Counted per *instance*, not per phase: an instance has at most one current
 * phase, so counting phases would double-count a re-run gate and make the
 * number disagree with the board.
 */
function isWaitingGate(inst: PipelineInstance): boolean {
  return inst.status === "awaiting-approval";
}

function countStatuses(input: SituationInput): SituationCounts {
  let monitorsDown = 0;
  let monitorsFailing = 0;
  for (const monitor of input.monitors) {
    if (monitor.status === "down") monitorsDown += 1;
    else if (monitor.status === "failing") monitorsFailing += 1;
  }
  return {
    runsInFlight: input.runs.filter(isInFlight).length,
    gatesWaiting: input.instances.filter(isWaitingGate).length,
    failedInstances: input.instances.filter((i) => i.status === "failed").length,
    monitorsDown,
    monitorsFailing,
    openIssues: input.issues.filter((i) => i.state === "open").length,
    liveAgents: input.agents.filter((a) => a.live).length,
  };
}

/**
 * The soonest upcoming firing across schedules and pipelines.
 *
 * Schedules arrive with `nextRun` already computed; pipeline definitions do not,
 * so their trigger is projected here from the same anchor the scheduler uses
 * (`lastStartedAt`, falling back to creation) — otherwise a pipeline would
 * report a different next-fire here than the one that actually fires.
 */
export function soonestFire(input: SituationInput, now: Date): NextFire | null {
  const candidates: NextFire[] = [];

  for (const schedule of input.schedules) {
    if (!schedule.enabled || !schedule.nextRun) continue;
    candidates.push({
      id: schedule.id,
      name: schedule.name,
      kind: "schedule",
      at: schedule.nextRun,
    });
  }

  for (const pipeline of input.pipelines) {
    if (!pipeline.enabled || pipeline.trigger === null) continue;
    const anchor = new Date(pipeline.lastStartedAt ?? pipeline.createdAt);
    const at = nextFireAfter(pipeline.trigger, anchor, now);
    if (!at) continue;
    candidates.push({
      id: pipeline.id,
      name: pipeline.name,
      kind: "pipeline",
      at: at.toISOString(),
    });
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.at < best.at ? c : best));
}

/**
 * Run outcomes bucketed by hour, oldest first, always exactly
 * {@link THROUGHPUT_BUCKETS} long.
 *
 * Fixed-length on purpose: a sparkline whose length depends on how much
 * happened cannot be compared between glances, and an empty hour is itself the
 * signal ("nothing ran overnight").
 */
export function throughputBuckets(runs: Run[], now: Date): ThroughputBucket[] {
  // Align to the hour so buckets are stable between requests instead of sliding
  // with the clock — a shifting x-axis makes a sparkline flicker.
  const end = Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS + BUCKET_MS;
  const start = end - THROUGHPUT_BUCKETS * BUCKET_MS;
  const buckets: ThroughputBucket[] = Array.from({ length: THROUGHPUT_BUCKETS }, (_, i) => ({
    at: new Date(start + i * BUCKET_MS).toISOString(),
    succeeded: 0,
    failed: 0,
  }));

  for (const run of runs) {
    // Bucket by when the work *finished*: that is when its outcome became known,
    // and a long run's outcome belongs to the hour it landed in.
    const stamp = run.endedAt ?? run.startedAt ?? run.queuedAt;
    const ms = new Date(stamp).getTime();
    if (!Number.isFinite(ms) || ms < start || ms >= end) continue;
    const index = Math.floor((ms - start) / BUCKET_MS);
    const bucket = buckets[index];
    if (!bucket) continue;
    // The work-level outcome wins over the exit code, matching the rest of the
    // UI: a run that exited 0 but signalled failure is a failure.
    if (run.outcome === "failed" || run.outcome === "blocked" || run.status === "failed") {
      bucket.failed += 1;
    } else if (run.status === "succeeded") {
      bucket.succeeded += 1;
    }
  }
  return buckets;
}

export function buildSituation(input: SituationInput, now: Date): Situation {
  return {
    generatedAt: now.toISOString(),
    counts: countStatuses(input),
    spend: {
      state: input.budget.state,
      today: input.budget.today,
      month: input.budget.month,
    },
    nextFire: soonestFire(input, now),
    throughput: throughputBuckets(input.runs, now),
  };
}
