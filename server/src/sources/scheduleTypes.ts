export type TriggerKind = "interval" | "daily" | "weekly";

/** When a schedule fires. `everyMinutes` for interval; `time` ("HH:MM", local)
 * for daily/weekly; `weekday` (0=Sun..6=Sat) for weekly. */
export interface Trigger {
  kind: TriggerKind;
  everyMinutes?: number;
  time?: string;
  weekday?: number;
}

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled: boolean;
  overlapPolicy: "skip" | "allow";
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunId: string | null;
}

export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "interrupted";

export interface Run {
  id: string;
  scheduleId: string;
  scheduleName: string;
  prompt: string;
  cwd: string;
  status: RunStatus;
  trigger: "scheduled" | "manual";
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  pid: number | null;
  exitCode: number | null;
  sessionId: string | null;
  model?: string;
  project: string | null;
  resultSummary: string | null;
  error: string | null;
  instanceId?: string;
  phaseId?: string;
}
