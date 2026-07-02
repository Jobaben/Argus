import type { DsStatus } from "./status";
import type {
  InstanceStatus, PhaseStatus, StepStatus, PhaseProgress, PhaseDef,
  OverviewEntry, PipelineInstance,
} from "../types";

export interface StepPill {
  name: string;
  runId: string | null;
  status: DsStatus;
}

export interface PhasePill {
  id: string;
  name: string;
  status: DsStatus;
  activeStep: string | null;
  steps: StepPill[];
  /** Failure reason from the phase payload, when the phase failed. */
  reason: string | null;
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

const STEP_STATUS_TO_DS: Record<StepStatus, DsStatus> = {
  pending: "queued",
  running: "working",
  succeeded: "done",
  failed: "failed",
};

/** Upcoming phases report no step progress yet; tile them from the definition. */
const FALLBACK_STEP_STATUS: Record<PhaseStatus, DsStatus> = {
  pending: "queued",
  running: "working",
  "awaiting-approval": "done",
  succeeded: "done",
  failed: "failed",
};

function stepPills(phase: PhaseProgress, def: PhaseDef | undefined): StepPill[] {
  if (phase.steps.length > 0) {
    return phase.steps.map((s) => ({
      name: s.name,
      runId: s.runId,
      status: STEP_STATUS_TO_DS[s.status],
    }));
  }
  return (def?.steps ?? []).map((s) => ({
    name: s.name,
    runId: null,
    status: FALLBACK_STEP_STATUS[phase.status],
  }));
}

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
        id: p.id,
        name: p.name,
        status: "idle",
        activeStep: null,
        steps: p.steps.map((s) => ({ name: s.name, runId: null, status: "idle" as const })),
        reason: null,
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
    steps: stepPills(p, definition.phases.find((d) => d.id === p.id)),
    reason: p.status === "failed" ? extractReason(p.payload) : null,
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
