import type {
  PhaseProgress, PipelineDefinition, PipelineInstance, PipelineSignal,
} from "./sources/pipelineTypes.js";

export interface TransitionResult {
  instance: PipelineInstance;
  startPhase: number | null;
}

export function applyTemplate(prompt: string, prevPayload: unknown): string {
  const value =
    prevPayload == null ? "" : typeof prevPayload === "string" ? prevPayload : JSON.stringify(prevPayload);
  return prompt.replace(/\{\{previous\.payload\}\}/g, value);
}

function touch(inst: PipelineInstance, nowISO: string): void {
  inst.updatedAt = nowISO;
}

export function initInstance(
  def: PipelineDefinition,
  trigger: "manual" | "scheduled",
  ids: { instanceId: string; token: string },
  nowISO: string,
): TransitionResult {
  if (def.phases.length === 0) throw new Error("pipeline has no phases");
  const phases: PhaseProgress[] = def.phases.map((p) => ({
    id: p.id,
    name: p.name,
    gated: p.gated,
    status: "pending",
    steps: p.steps.map((s) => ({ name: s.name, runId: null, status: "pending" as const })),
    attempt: 0,
    payload: null,
  }));
  phases[0].status = "running";
  const instance: PipelineInstance = {
    id: ids.instanceId,
    pipelineId: def.id,
    pipelineName: def.name,
    status: "running",
    currentPhaseIndex: 0,
    phases,
    trigger,
    signalToken: ids.token,
    createdAt: nowISO,
    updatedAt: nowISO,
    endedAt: null,
  };
  return { instance, startPhase: 0 };
}

function advanceToNext(def: PipelineDefinition, inst: PipelineInstance, nowISO: string): TransitionResult {
  const next = inst.currentPhaseIndex + 1;
  if (next >= def.phases.length) {
    inst.status = "succeeded";
    inst.endedAt = nowISO;
    touch(inst, nowISO);
    return { instance: inst, startPhase: null };
  }
  inst.currentPhaseIndex = next;
  inst.status = "running";
  inst.phases[next].status = "running";
  touch(inst, nowISO);
  return { instance: inst, startPhase: next };
}

export function advance(
  def: PipelineDefinition,
  inst: PipelineInstance,
  signal: PipelineSignal,
  nowISO: string,
): TransitionResult {
  const phase = inst.phases[inst.currentPhaseIndex];
  if (!phase || signal.phaseId !== phase.id) return { instance: inst, startPhase: null };

  const step = phase.steps.find((s) => s.runId === signal.runId);
  if (step) step.status = signal.type === "failed" ? "failed" : "succeeded";
  if (signal.payload !== undefined) phase.payload = signal.payload;

  if (signal.type === "failed") {
    phase.status = "failed";
    inst.status = "failed";
    touch(inst, nowISO);
    return { instance: inst, startPhase: null };
  }
  if (signal.type === "needs-input") {
    phase.status = "awaiting-approval";
    inst.status = "awaiting-approval";
    touch(inst, nowISO);
    return { instance: inst, startPhase: null };
  }
  // completed
  if (phase.steps.some((s) => s.status === "failed")) {
    phase.status = "failed";
    inst.status = "failed";
    touch(inst, nowISO);
    return { instance: inst, startPhase: null };
  }
  if (!phase.steps.every((s) => s.status === "succeeded")) {
    return { instance: inst, startPhase: null }; // wait for sibling steps
  }
  if (phase.gated) {
    phase.status = "awaiting-approval";
    inst.status = "awaiting-approval";
    touch(inst, nowISO);
    return { instance: inst, startPhase: null };
  }
  phase.status = "succeeded";
  return advanceToNext(def, inst, nowISO);
}

export function applyApprove(
  def: PipelineDefinition,
  inst: PipelineInstance,
  answers: unknown,
  nowISO: string,
): TransitionResult {
  if (inst.status !== "awaiting-approval") throw new Error("instance is not awaiting approval");
  const phase = inst.phases[inst.currentPhaseIndex];
  if (answers !== undefined) phase.payload = answers;
  phase.status = "succeeded";
  return advanceToNext(def, inst, nowISO);
}

export function applyRevise(inst: PipelineInstance, nowISO: string): TransitionResult {
  if (inst.status !== "awaiting-approval" && inst.status !== "failed") {
    throw new Error("instance is not paused");
  }
  const phase = inst.phases[inst.currentPhaseIndex];
  phase.attempt += 1;
  phase.status = "running";
  phase.steps = phase.steps.map((s) => ({ name: s.name, runId: null, status: "pending" }));
  inst.status = "running";
  touch(inst, nowISO);
  return { instance: inst, startPhase: inst.currentPhaseIndex };
}

export function applyAbort(inst: PipelineInstance, nowISO: string): PipelineInstance {
  if (inst.status === "succeeded" || inst.status === "failed" || inst.status === "aborted") {
    throw new Error("instance is already terminal");
  }
  inst.status = "aborted";
  inst.endedAt = nowISO;
  touch(inst, nowISO);
  return inst;
}
