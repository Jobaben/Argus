export type AgentStatus =
  | "working"
  | "done"
  | "failed"
  | "idle"
  | "queued"
  | "stopped"
  | "unknown";

export interface Agent {
  short: string;
  sessionId: string | null;
  name: string;
  status: AgentStatus;
  tempo: string | null;
  detail: string | null;
  result: string | null;
  template: string | null;
  cwd: string | null;
  cliVersion: string | null;
  inFlight: { tasks: number; queued: number; kinds: string[] } | null;
  createdAt: string | null;
  updatedAt: string | null;
  firstTerminalAt: string | null;
  live: boolean;
  pid: number | null;
}

export interface TimelineEntry {
  at: string;
  state?: AgentStatus;
  detail?: string;
  text?: string;
}

export type TriggerKind = "interval" | "daily" | "weekly";

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

export interface ScheduleWithNext extends Schedule {
  nextRun: string | null;
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
  project: string | null;
  resultSummary: string | null;
  error: string | null;
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
}
