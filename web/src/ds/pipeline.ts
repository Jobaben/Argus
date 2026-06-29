import type { DsStatus } from "./status";

export interface PipelineTile {
  jobShort: string | null;
  name: string;
  subId: string;
  status: DsStatus;
  detail: string;
  tokens?: number;
  costUsd?: number;
  updatedAt: string | null;
}

export interface PipelinePhase {
  id: string;
  index: number;
  name: string;
  tiles: PipelineTile[];
}

export interface PipelineState {
  feature: string;
  phases: PipelinePhase[];
}
