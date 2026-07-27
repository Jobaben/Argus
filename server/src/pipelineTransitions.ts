import {
  currentIndex,
  instanceOutcome,
  interpolate,
  readyPhases,
  resolveNeeds,
} from "./sources/dag.js";
import type {
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
  RetryableClass,
  RetryPolicy,
} from "./sources/pipelineTypes.js";

/**
 * The pure state transitions of a pipeline instance.
 *
 * Since Weave these are DAG transitions rather than cursor transitions, and the
 * difference is concentrated in one function: {@link settle}. Every mutation —
 * a signal, an approval, a revise, a retry — changes one phase's status and
 * then asks `settle` what follows. Nothing else computes readiness, terminality
 * or the current index, so there is exactly one place where "what happens next"
 * can be wrong.
 *
 * A linear pipeline takes the same path: it is a DAG whose every phase needs
 * the one before it, so the executor has no linear special case to keep in step
 * with the general one.
 */

export interface TransitionResult {
  instance: PipelineInstance;
  /** Indices into `instance.phases` to launch now. Empty means nothing to do. */
  startPhases: number[];
}

/** Kept for definitions and tests that predate `{{artifacts.<name>}}`. */
export function applyTemplate(prompt: string, prevPayload: unknown): string {
  return interpolate(prompt, prevPayload);
}

function touch(inst: PipelineInstance, nowISO: string): void {
  inst.updatedAt = nowISO;
}

const DEFAULT_FAIL_REASON = "run stopped without reporting an outcome";

/** The failure reason carried by a payload, mirroring the web's extractReason. */
function payloadReason(payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() || null;
  if (payload && typeof payload === "object" && "reason" in payload) {
    const r = (payload as { reason: unknown }).reason;
    return typeof r === "string" ? r.trim() || null : null;
  }
  return null;
}

/**
 * When a phase fails, any of its steps still pending/running are abandoned —
 * mark them failed so no step is left "running" under a terminal phase.
 * Covers a running sibling in a multi-step phase, and a step whose runId the
 * failing signal didn't match (e.g. a stale or duplicate concurrent run).
 */
function failLeftoverSteps(phase: PhaseProgress): void {
  for (const s of phase.steps) {
    if (s.status === "pending" || s.status === "running") s.status = "failed";
  }
}

/** Publish a succeeded phase's payload under its declared artifact name. */
function publishArtifact(def: PipelineDefinition, inst: PipelineInstance, phaseId: string): void {
  const name = def.phases.find((p) => p.id === phaseId)?.produces;
  if (!name) return;
  inst.artifacts = {
    ...(inst.artifacts ?? {}),
    [name]: inst.phases.find((p) => p.id === phaseId)?.payload ?? null,
  };
}

/**
 * Advance the instance to whatever the current phase statuses imply.
 *
 * Marks newly-ready phases running and returns them, then decides the
 * instance's own status. The one subtlety worth stating: a failed phase does
 * **not** immediately terminate the instance while a sibling branch is still
 * executing. Flipping the instance to `failed` there would render a terminal
 * pipeline with a live process still writing to it — so the failure is recorded
 * on the phase, the branch that is still running is allowed to finish, and the
 * instance settles to `failed` when nothing is left that could still progress.
 */
export function settle(
  def: PipelineDefinition,
  inst: PipelineInstance,
  nowISO: string,
): TransitionResult {
  const needs = resolveNeeds(def.phases);
  const startPhases = readyPhases(def, inst);
  for (const i of startPhases) {
    inst.phases[i].status = "running";
    // Recorded on the instance so the board can draw the graph without also
    // fetching the definition (which may since have been edited).
    inst.phases[i].needs = needs.get(inst.phases[i].id) ?? [];
  }

  const outcome = instanceOutcome(def, inst);
  if (outcome === "succeeded") {
    inst.status = "succeeded";
    inst.endedAt = nowISO;
  } else if (outcome === "blocked") {
    inst.status = "failed";
    inst.endedAt = nowISO;
  } else {
    inst.status = inst.phases.some((p) => p.status === "awaiting-approval")
      ? "awaiting-approval"
      : "running";
    inst.endedAt = null;
  }

  inst.currentPhaseIndex = currentIndex(inst);
  touch(inst, nowISO);
  return { instance: inst, startPhases };
}

export function initInstance(
  def: PipelineDefinition,
  trigger: "manual" | "scheduled",
  ids: { instanceId: string; token: string },
  nowISO: string,
): TransitionResult {
  if (def.phases.length === 0) throw new Error("pipeline has no phases");
  const needs = resolveNeeds(def.phases);
  const phases: PhaseProgress[] = def.phases.map((p) => ({
    id: p.id,
    name: p.name,
    gated: p.gated,
    status: "pending",
    steps: p.steps.map((s) => ({ name: s.name, runId: null, status: "pending" as const })),
    attempt: 0,
    needs: needs.get(p.id) ?? [],
    retries: 0,
    payload: null,
  }));
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
    artifacts: {},
  };
  return settle(def, instance, nowISO);
}

export function advance(
  def: PipelineDefinition,
  inst: PipelineInstance,
  signal: PipelineSignal,
  nowISO: string,
): TransitionResult {
  // Located by id, not by a cursor: with a fan-out, several phases are live at
  // once and the signalling one is whichever sent it.
  const phase = inst.phases.find((p) => p.id === signal.phaseId);
  if (!phase || phase.status !== "running") return { instance: inst, startPhases: [] };

  // Only a run currently tracked by this phase may drive it. A signal whose
  // runId matches no step comes from a stale or duplicate concurrent run (its
  // runId was overwritten by a later revise/re-spawn) and is ignored, so it
  // can't terminalize or advance the instance behind the tracked run's back.
  const step = phase.steps.find((s) => s.runId === signal.runId);
  if (!step) return { instance: inst, startPhases: [] };
  step.status = signal.type === "failed" ? "failed" : "succeeded";
  if (signal.payload !== undefined) phase.payload = signal.payload;

  if (signal.type === "failed" && !payloadReason(phase.payload)) {
    phase.payload =
      phase.payload && typeof phase.payload === "object" && !Array.isArray(phase.payload)
        ? { ...(phase.payload as Record<string, unknown>), reason: DEFAULT_FAIL_REASON }
        : { reason: DEFAULT_FAIL_REASON };
  }

  if (signal.type === "failed") {
    phase.status = "failed";
    failLeftoverSteps(phase);
    return settle(def, inst, nowISO);
  }
  if (signal.type === "needs-input") {
    phase.status = "awaiting-approval";
    return settle(def, inst, nowISO);
  }
  // completed
  if (phase.steps.some((s) => s.status === "failed")) {
    phase.status = "failed";
    failLeftoverSteps(phase);
    return settle(def, inst, nowISO);
  }
  if (!phase.steps.every((s) => s.status === "succeeded")) {
    // Wait for sibling steps. Nothing about the graph changed, so nothing to
    // settle — but the timestamp moves so the board shows progress.
    touch(inst, nowISO);
    return { instance: inst, startPhases: [] };
  }
  if (phase.gated) {
    phase.status = "awaiting-approval";
    return settle(def, inst, nowISO);
  }
  phase.status = "succeeded";
  publishArtifact(def, inst, phase.id);
  return settle(def, inst, nowISO);
}

/** The phase a human action targets: the named one, else the single paused one. */
function pausedPhase(inst: PipelineInstance, phaseId?: string): PhaseProgress | undefined {
  if (phaseId) return inst.phases.find((p) => p.id === phaseId);
  return (
    inst.phases.find((p) => p.status === "awaiting-approval") ??
    inst.phases.find((p) => p.status === "failed")
  );
}

export function applyApprove(
  def: PipelineDefinition,
  inst: PipelineInstance,
  answers: unknown,
  nowISO: string,
  phaseId?: string,
): TransitionResult {
  const phase = pausedPhase(inst, phaseId);
  if (!phase || phase.status !== "awaiting-approval") {
    throw new Error("instance is not awaiting approval");
  }
  if (answers !== undefined) phase.payload = answers;
  phase.status = "succeeded";
  publishArtifact(def, inst, phase.id);
  return settle(def, inst, nowISO);
}

export function applyRevise(
  inst: PipelineInstance,
  nowISO: string,
  phaseId?: string,
): TransitionResult {
  const phase = pausedPhase(inst, phaseId);
  if (!phase || (phase.status !== "awaiting-approval" && phase.status !== "failed")) {
    throw new Error("instance is not paused");
  }
  restartPhase(phase);
  // A revise is a human's decision to try again, so it resets the automatic
  // retry budget too — otherwise a phase that had already exhausted its retries
  // could not be revised more than once.
  phase.retries = 0;
  phase.retryAt = null;
  inst.status = "running";
  inst.endedAt = null;
  inst.currentPhaseIndex = inst.phases.indexOf(phase);
  touch(inst, nowISO);
  return { instance: inst, startPhases: [inst.phases.indexOf(phase)] };
}

function restartPhase(phase: PhaseProgress): void {
  phase.attempt += 1;
  phase.status = "running";
  phase.steps = phase.steps.map((s) => ({ name: s.name, runId: null, status: "pending" }));
}

export function applyAbort(inst: PipelineInstance, nowISO: string): PipelineInstance {
  if (inst.status === "succeeded" || inst.status === "failed" || inst.status === "aborted") {
    throw new Error("instance is already terminal");
  }
  // Close out every in-flight phase, not just one: with a fan-out there can be
  // several, and leaving steps "running" would render working tiles (with live
  // elapsed tickers) inside a stopped instance.
  for (const phase of inst.phases) {
    if (phase.status !== "running" && phase.status !== "awaiting-approval") continue;
    phase.status = "aborted";
    for (const s of phase.steps) {
      if (s.status === "running" || s.status === "pending") s.status = "aborted";
    }
  }
  inst.status = "aborted";
  inst.endedAt = nowISO;
  touch(inst, nowISO);
  return inst;
}

// ── Retry ───────────────────────────────────────────────────────────────────

const DEFAULT_RETRYABLE: RetryableClass[] = ["spawn", "exit-code"];

/**
 * Whether a failed phase gets another automatic attempt.
 *
 * The default class list excludes `signal` on purpose: an agent that signalled
 * failure has *considered* the work and reported on it, and re-running the same
 * prompt is unlikely to change its mind — it just costs the same money twice.
 * A process that never started, or died on a non-zero exit, plausibly hit
 * something transient.
 */
export function shouldRetry(
  policy: RetryPolicy | undefined,
  retriesSoFar: number,
  failure: RetryableClass,
): boolean {
  if (!policy || policy.attempts <= 1) return false;
  if (retriesSoFar >= policy.attempts - 1) return false;
  return (policy.retryOn ?? DEFAULT_RETRYABLE).includes(failure);
}

/** Exponential backoff, doubling from the policy's base. Capped at an hour so a
 *  generous `attempts` cannot schedule a retry for next week. */
export function retryDelayMs(policy: RetryPolicy, retriesSoFar: number): number {
  const base = Math.max(0, policy.backoffSeconds) * 1000;
  return Math.min(3_600_000, base * 2 ** retriesSoFar);
}

/**
 * Put a failed phase back into `running` for an automatic retry.
 *
 * Separate from {@link applyRevise} because the two mean different things on
 * the board: a revise is a person deciding to try again (and resetting the
 * retry budget), a retry is the policy the author wrote executing itself.
 */
export function applyRetry(
  inst: PipelineInstance,
  phaseId: string,
  nowISO: string,
): TransitionResult {
  const phase = inst.phases.find((p) => p.id === phaseId);
  if (!phase || phase.status !== "failed") return { instance: inst, startPhases: [] };
  restartPhase(phase);
  phase.retries = (phase.retries ?? 0) + 1;
  phase.retryAt = null;
  inst.status = "running";
  inst.endedAt = null;
  inst.currentPhaseIndex = inst.phases.indexOf(phase);
  touch(inst, nowISO);
  return { instance: inst, startPhases: [inst.phases.indexOf(phase)] };
}
