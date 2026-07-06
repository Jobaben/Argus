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
  model?: string;
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

export type InstanceStatus =
  | "running"
  | "awaiting-approval"
  | "failed"
  | "succeeded"
  | "aborted";

export type PhaseStatus =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "succeeded"
  | "failed";

export type StepStatus = "pending" | "running" | "succeeded" | "failed";

export interface StepProgress {
  name: string;
  runId: string | null;
  status: StepStatus;
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

export interface OverviewEntry {
  definition: PipelineDefinition;
  latest: PipelineInstance | null;
}
