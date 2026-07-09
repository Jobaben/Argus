export type AgentStatus = "working" | "done" | "failed" | "idle" | "queued" | "stopped" | "unknown";

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

export type TriggerKind = "interval" | "daily" | "weekly" | "windowed";

export interface Trigger {
  kind: TriggerKind;
  everyMinutes?: number;
  time?: string;
  weekday?: number;
  startTime?: string;
  endTime?: string;
  weekdays?: number[];
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
  "running" | "succeeded" | "failed" | "skipped" | "interrupted" | "cancelled";

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
  costUsd?: number | null;
  tokens?: number | null;
  outcome?: "succeeded" | "failed" | "blocked" | null;
}

export interface ScheduleInput {
  name: string;
  prompt: string;
  cwd: string;
  trigger: Trigger;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
}

export type InstanceStatus = "running" | "awaiting-approval" | "failed" | "succeeded" | "aborted";

export type PhaseStatus =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "succeeded"
  | "failed"
  | "aborted";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "aborted";

export interface StepProgress {
  name: string;
  runId: string | null;
  status: StepStatus;
  /** USD cost of the step's run, joined server-side from the run record. */
  costUsd?: number | null;
  /** Total tokens of the step's run, joined server-side from the run record. */
  tokens?: number | null;
  /** Model the step's run was started with, joined server-side from the run record. */
  model?: string | null;
  /** Latest activity label from the run tailer; only set while running. */
  currentActivity?: string | null;
  /** Arrival timestamp of that activity. */
  activityAt?: string | null;
  /** Run start time, joined from the run record. */
  startedAt?: string | null;
  /** Final run duration, joined from the run record when it ended. */
  durationMs?: number | null;
}

export interface PhaseProgress {
  id: string;
  name: string;
  gated: boolean;
  status: PhaseStatus;
  steps: StepProgress[];
  attempt: number;
  payload: unknown | null;
}

export interface PhaseStep {
  name: string;
  prompt: string;
  model?: string;
}

export interface PhaseDef {
  id: string;
  name: string;
  cwd: string;
  steps: PhaseStep[];
  gated: boolean;
}

export interface PipelineDefinition {
  id: string;
  name: string;
  phases: PhaseDef[];
  trigger: Trigger | null;
  enabled: boolean;
  overlapPolicy: "skip" | "allow";
  model?: string;
  lastStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineInput {
  name: string;
  phases: PhaseDef[];
  trigger: Trigger | null;
  enabled?: boolean;
  overlapPolicy?: "skip" | "allow";
  model?: string;
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
   *  superseded revise attempts). Null/absent when there is no instance. */
  cost?: OverviewCost | null;
  /** Instances sharing the board, newest-first: every non-terminal one
   *  (running / awaiting-approval) plus terminal ones whose lifetime
   *  overlapped the latest instance, so a just-stopped sibling stays visible
   *  beside its peers. Empty when only the lone latest instance remains. */
  active?: { instance: PipelineInstance; cost: OverviewCost }[];
}
