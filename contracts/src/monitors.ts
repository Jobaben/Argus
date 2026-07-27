/** Dead-man's-switch health per schedule. */

import type { RunOutcome, RunStatus } from "./schedules.js";

export type MonitorStatus = "up" | "late" | "down" | "failing" | "paused" | "pending";

export interface Heartbeat {
  runId: string;
  status: RunStatus;
  outcome?: RunOutcome | null;
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
  /** Oldest → newest, capped at the server's retention window. */
  heartbeats: Heartbeat[];
}

export type MonitorsSummary = Record<MonitorStatus, number>;
