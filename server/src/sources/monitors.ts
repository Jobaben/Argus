import { nextFireAfter, previousFireTime } from "./nextFire.js";
import type { Run, RunStatus, Schedule, Trigger } from "./scheduleTypes.js";

/**
 * Monitors: a Healthchecks.io-style dead-man's switch over schedules, plus
 * Uptime-Kuma-style heartbeat history. Everything here is a pure derivation
 * over schedules + runs — the runs list can only show runs that *happened*;
 * a monitor's job is to notice the slot where nothing did.
 */

export type MonitorStatus = "up" | "late" | "down" | "failing" | "paused" | "pending";

export interface Heartbeat {
  runId: string;
  status: RunStatus;
  outcome?: "succeeded" | "failed" | "blocked" | null;
  at: string;
  durationMs: number | null;
}

export interface MonitorHealth {
  scheduleId: string;
  name: string;
  enabled: boolean;
  status: MonitorStatus;
  /** succeeded / (succeeded + failed) over the retained heartbeats, 0–100. */
  uptimePct: number | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  /** The slot the monitor is judging (last expected fire), if any. */
  expectedAt: string | null;
  nextExpected: string | null;
  graceMs: number;
  /** Oldest → newest, capped at HEARTBEAT_KEEP. */
  heartbeats: Heartbeat[];
}

export type MonitorsSummary = Record<MonitorStatus, number>;

export const HEARTBEAT_KEEP = 30;

/** Slack when matching a run to its slot: the scheduler stamps queuedAt a
 *  moment after the grid instant, never before it — but clocks and manual
 *  runs deserve a margin. */
const SLOT_SLACK_MS = 60_000;

const MIN_GRACE_MS = 5 * 60_000;
const MAX_GRACE_MS = 60 * 60_000;

function periodMs(trigger: Trigger): number {
  switch (trigger.kind) {
    case "interval":
    case "windowed":
      return Math.max(1, trigger.everyMinutes ?? 1) * 60_000;
    case "daily":
      return 24 * 3_600_000;
    case "weekly":
      return 7 * 24 * 3_600_000;
  }
}

/** Healthchecks' period+grace model with derived defaults: 10% of the period,
 *  clamped to [5 min, 60 min]. (Distinct from the scheduler's tick-based
 *  firing grace in nextFire.ts.) */
export function monitorGraceMs(trigger: Trigger): number {
  return Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, periodMs(trigger) * 0.1));
}

const runAt = (r: Run): string => r.endedAt ?? r.startedAt ?? r.queuedAt;

const failedRun = (r: Run): boolean =>
  r.status === "failed" || r.outcome === "failed" || r.outcome === "blocked";

function toHeartbeats(runs: Run[]): Heartbeat[] {
  // readRuns order is newest first; heartbeats read left→right in time.
  return runs
    .slice(0, HEARTBEAT_KEEP)
    .reverse()
    .map((r) => ({
      runId: r.id,
      status: r.status,
      outcome: r.outcome ?? null,
      at: runAt(r),
      durationMs: r.durationMs,
    }));
}

function uptimePct(runs: Run[]): number | null {
  let ok = 0;
  let bad = 0;
  for (const r of runs.slice(0, HEARTBEAT_KEEP)) {
    if (failedRun(r)) bad++;
    else if (r.status === "succeeded") ok++;
    // running/skipped/cancelled/interrupted: neither up nor down
  }
  const total = ok + bad;
  return total === 0 ? null : Math.round((ok / total) * 1000) / 10;
}

/** Health of one schedule. `runs` must be this schedule's runs, newest first. */
export function monitorFor(schedule: Schedule, runs: Run[], now: Date): MonitorHealth {
  const grace = monitorGraceMs(schedule.trigger);
  const anchor = new Date(schedule.lastRunAt ?? schedule.createdAt);
  const next = schedule.enabled ? nextFireAfter(schedule.trigger, anchor, now) : null;
  const last = runs[0] ?? null;

  const base: Omit<MonitorHealth, "status" | "expectedAt"> = {
    scheduleId: schedule.id,
    name: schedule.name,
    enabled: schedule.enabled,
    uptimePct: uptimePct(runs),
    lastRunAt: last ? runAt(last) : null,
    lastRunStatus: last?.status ?? null,
    nextExpected: next ? next.toISOString() : null,
    graceMs: grace,
    heartbeats: toHeartbeats(runs),
  };

  if (!schedule.enabled) return { ...base, status: "paused", expectedAt: null };

  let expected = previousFireTime(schedule.trigger, anchor, now);
  // Slots from before the schedule existed were never owed a run (mirrors the
  // scheduler's no-backfill-on-create rule).
  if (expected && expected.getTime() < new Date(schedule.createdAt).getTime()) expected = null;

  if (!expected) {
    // Nothing owed yet: judge the last completed run if there is one.
    const done = runs.find((r) => r.status === "succeeded" || failedRun(r));
    if (!done) return { ...base, status: runs.length ? "up" : "pending", expectedAt: null };
    return { ...base, status: failedRun(done) ? "failing" : "up", expectedAt: null };
  }

  const expectedIso = expected.toISOString();
  const covered =
    runs.some((r) => new Date(r.queuedAt).getTime() >= expected.getTime() - SLOT_SLACK_MS) ||
    (schedule.lastRunAt !== null && new Date(schedule.lastRunAt).getTime() >= expected.getTime());

  if (!covered) {
    const overdueMs = now.getTime() - expected.getTime();
    return { ...base, status: overdueMs <= grace ? "late" : "down", expectedAt: expectedIso };
  }

  const done = runs.find((r) => r.status === "succeeded" || failedRun(r));
  const status: MonitorStatus = done && failedRun(done) ? "failing" : "up";
  return { ...base, status, expectedAt: expectedIso };
}

export function buildMonitors(
  schedules: Schedule[],
  runs: Run[],
  now: Date,
): { monitors: MonitorHealth[]; summary: MonitorsSummary } {
  const bySchedule = new Map<string, Run[]>();
  // Preserve readRuns' newest-first order within each schedule bucket.
  for (const r of runs) {
    const list = bySchedule.get(r.scheduleId);
    if (list) list.push(r);
    else bySchedule.set(r.scheduleId, [r]);
  }
  const monitors = schedules.map((s) => monitorFor(s, bySchedule.get(s.id) ?? [], now));
  const rank: Record<MonitorStatus, number> = {
    down: 0,
    failing: 1,
    late: 2,
    up: 3,
    pending: 4,
    paused: 5,
  };
  monitors.sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  const summary: MonitorsSummary = { up: 0, late: 0, down: 0, failing: 0, paused: 0, pending: 0 };
  for (const m of monitors) summary[m.status]++;
  return { monitors, summary };
}
