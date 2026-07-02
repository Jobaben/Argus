import type { DsStatus } from "./status";
import type {
  InstanceStatus, PhaseStatus, PhaseProgress, OverviewEntry, PipelineInstance,
} from "../types";

export interface PhasePill {
  id: string;
  name: string;
  status: DsStatus;
  activeStep: string | null;
}

/**
 * The actionable gate for a row. Present when the instance is paused awaiting a
 * human: `awaiting-approval` (Approve + Revise) or `failed` (Revise-only retry,
 * since the engine's applyRevise also accepts a failed instance).
 */
export interface OverviewGate {
  phaseId: string;
  canApprove: boolean;
}

export interface OverviewRow {
  pipelineId: string;
  name: string;
  badge: DsStatus;
  updatedAt: string | null;
  phases: PhasePill[];
  instanceId: string | null;
  gate: OverviewGate | null;
  failure: { step: string | null; reason: string | null } | null;
}

const PHASE_STATUS_TO_DS: Record<PhaseStatus, DsStatus> = {
  pending: "idle",
  running: "working",
  "awaiting-approval": "await",
  succeeded: "done",
  failed: "failed",
};

const INSTANCE_BADGE: Record<InstanceStatus, DsStatus> = {
  running: "working",
  "awaiting-approval": "await",
  failed: "failed",
  succeeded: "done",
  aborted: "idle",
};

function activeStepName(phase: PhaseProgress): string | null {
  if (phase.status !== "running") return null;
  return phase.steps.find((s) => s.status === "running")?.name ?? null;
}

function gateFor(latest: OverviewEntry["latest"]): OverviewGate | null {
  if (!latest) return null;
  if (latest.status === "awaiting-approval") {
    const phase = latest.phases.find((p) => p.status === "awaiting-approval");
    if (phase) return { phaseId: phase.id, canApprove: true };
  }
  if (latest.status === "failed") {
    const phase = latest.phases.find((p) => p.status === "failed");
    if (phase) return { phaseId: phase.id, canApprove: false };
  }
  return null;
}

function extractReason(payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() || null;
  if (payload && typeof payload === "object" && "reason" in payload) {
    const r = (payload as { reason: unknown }).reason;
    return typeof r === "string" ? r.trim() || null : null;
  }
  return null;
}

function failureFor(latest: PipelineInstance): OverviewRow["failure"] {
  if (latest.status !== "failed") return null;
  const phase = latest.phases.find((p) => p.status === "failed");
  if (!phase) return null;
  const failed = phase.steps.filter((s) => s.status === "failed").map((s) => s.name);
  const step = failed.length ? failed.join(", ") : phase.name;
  return { step, reason: extractReason(phase.payload) };
}

export function toOverviewRow(entry: OverviewEntry): OverviewRow {
  const { definition, latest } = entry;

  if (!latest) {
    return {
      pipelineId: definition.id,
      name: definition.name,
      badge: "idle",
      updatedAt: null,
      phases: definition.phases.map((p) => ({
        id: p.id, name: p.name, status: "idle", activeStep: null,
      })),
      instanceId: null,
      gate: null,
      failure: null,
    };
  }

  const phases: PhasePill[] = latest.phases.map((p) => ({
    id: p.id,
    name: p.name,
    status: PHASE_STATUS_TO_DS[p.status],
    activeStep: activeStepName(p),
  }));

  return {
    pipelineId: definition.id,
    name: definition.name,
    badge: INSTANCE_BADGE[latest.status],
    updatedAt: latest.updatedAt,
    phases,
    instanceId: latest.id,
    gate: gateFor(latest),
    failure: failureFor(latest),
  };
}
