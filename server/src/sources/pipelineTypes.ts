import type { Trigger } from "./scheduleTypes.js";

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

export type InstanceStatus = "running" | "awaiting-approval" | "failed" | "succeeded" | "aborted";

export type PhaseStatus =
  "pending" | "running" | "awaiting-approval" | "succeeded" | "failed" | "aborted";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "aborted";

export interface StepProgress {
  name: string;
  runId: string | null;
  status: StepStatus;
  /** USD cost of the step's run, joined from the run record at read time. */
  costUsd?: number | null;
  /** Total tokens of the step's run, joined from the run record at read time. */
  tokens?: number | null;
  /** Model the step's run was started with, joined from the run record. */
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

export type SignalType = "completed" | "needs-input" | "failed";

export interface PipelineSignal {
  instanceId: string;
  phaseId: string;
  runId: string;
  type: SignalType;
  token: string;
  payload?: unknown;
}
