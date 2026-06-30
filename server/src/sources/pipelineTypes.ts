import type { Trigger } from "./scheduleTypes.js";

export interface PhaseStep {
  name: string;
  prompt: string;
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
  lastStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
