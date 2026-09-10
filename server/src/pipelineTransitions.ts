import {
  currentIndex,
  describeCondition,
  instanceOutcome,
  interpolate,
  outgoingEdges,
  readyPhases,
  resolveNeeds,
  resultStepName,
  skippablePhases,
} from "./sources/dag.js";
import { RouteEvaluationError, evaluateRoutes, validateResult } from "./sources/routing.js";
import type {
  DependencyEdge,
  PhaseFailureClass,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
  RetryableClass,
  RetryPolicy,
  RouteDecision,
  VerificationReport,
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

/** A phase that could not produce a usable result, or a route that could not be
 *  evaluated. Both are operational failures under the phase's retry policy —
 *  never a business branch. */
export interface RouteFailure {
  phaseId: string;
  reason: string;
}

/** What this transition did to the graph's routes, for the caller to journal. */
export interface RouteOutcome {
  /** Decisions recorded by this transition (never a replay of an old one). */
  decisions: RouteDecision[];
  /** Phase ids this transition marked skipped. */
  skipped: string[];
  failures: RouteFailure[];
}

export interface TransitionResult {
  instance: PipelineInstance;
  /** Indices into `instance.phases` to launch now. Empty means nothing to do. */
  startPhases: number[];
  /** Present on every settled transition; absent when nothing was settled. */
  routing?: RouteOutcome;
  /**
   * Phase ids whose steps have all reported success and whose declared checks
   * Argus must now run. The phase stays `running` until the engine reports the
   * result through {@link applyVerification}; nothing downstream is ready yet.
   */
  verify?: string[];
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

/** Attach a failure reason to whatever payload the phase already carries. */
function withReason(payload: unknown, reason: string): unknown {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), reason }
    : { reason };
}

/** Record how a failure was classed, beside its reason, so the record explains
 *  the retry policy's decision without re-deriving it. */
export function withFailureClass(payload: unknown, failureClass: PhaseFailureClass): unknown {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), failureClass }
    : { failureClass };
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
 * Resolve one phase's declared structured result, once every step is in.
 *
 * Everything that can go wrong here is an *operational* failure with a specific
 * reason, and that distinction is the whole point: an agent that decided "fail
 * the audit" has succeeded at its job, while an agent that never wrote the file,
 * wrote unparseable bytes, or wrote a value the schema rejects has not reported
 * anything the pipeline can branch on. The first is a route; the second is a
 * failed phase under the phase's ordinary retry policy.
 */
function resolvePhaseResult(
  def: PipelineDefinition,
  phase: PhaseProgress,
): { ok: true; value?: unknown } | { ok: false; reason: string } {
  const phaseDef = def.phases.find((p) => p.id === phase.id);
  if (!phaseDef?.result) return { ok: true };
  const artifact = phaseDef.result.artifact;
  const wanted = resultStepName(phaseDef);

  const unreadable = phase.steps.find((s) => s.resultError);
  if (unreadable) return { ok: false, reason: `result "${artifact}": ${unreadable.resultError}` };

  const submitted = phase.steps.filter((s) => s.result !== undefined);
  if (new Set(submitted.map((s) => JSON.stringify(s.result))).size > 1) {
    return {
      ok: false,
      reason: `contradictory result submissions for "${artifact}" from steps ${submitted
        .map((s) => `"${s.name}"`)
        .join(", ")}`,
    };
  }
  const foreign = submitted.find((s) => s.name !== wanted);
  if (foreign) {
    return {
      ok: false,
      reason: `result "${artifact}" was submitted by step "${foreign.name}", which is not the declared result step ("${wanted}")`,
    };
  }
  if (submitted.length === 0) {
    return {
      ok: false,
      reason: `phase "${phase.id}" did not deliver its declared result "${artifact}"`,
    };
  }
  try {
    validateResult(phaseDef.result.schema, submitted[0].result);
  } catch (e) {
    return {
      ok: false,
      reason: `result "${artifact}" does not match the declared schema: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  return { ok: true, value: submitted[0].result };
}

/** A record of what a decision selected and skipped, and on what grounds. */
function describeDecision(edges: DependencyEdge[], selected: string[], skipped: string[]): string {
  const label = (id: string) => {
    const edge = edges.find((e) => e.phase === id);
    return `${id} (${describeCondition(edge?.when)})`;
  };
  const parts = [
    selected.length ? `selected ${selected.map(label).join(", ")}` : "selected nothing",
  ];
  if (skipped.length) parts.push(`skipped ${skipped.map(label).join(", ")}`);
  return parts.join("; ");
}

/**
 * Record the route decision of every succeeded result-producing phase that does
 * not have one yet.
 *
 * "Does not have one yet" is what makes recovery safe. A decision is written
 * once, in the same atomic instance write as the statuses it implies, and from
 * then on it is replayed rather than recomputed — so a crash between the write
 * and the branch's launch resumes onto the same branch, and a revise downstream
 * cannot quietly re-decide what already happened.
 */
function recordRouteDecisions(
  def: PipelineDefinition,
  inst: PipelineInstance,
  routing: RouteOutcome,
): void {
  const settled = new Set((inst.routeDecisions ?? []).map((d) => d.sourcePhase));
  for (const phase of inst.phases) {
    if (phase.status !== "succeeded" || settled.has(phase.id)) continue;
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    if (!phaseDef?.result) continue;
    const edges = outgoingEdges(def.phases, phase.id);
    if (phase.result === undefined) {
      // Reachable only when a definition gained its `result` after this phase
      // had already succeeded — an edit to a running pipeline. With nothing to
      // evaluate, every predicate would read false and every branch would be
      // silently skipped, so say so instead. (A declared result *value* of
      // null is a different thing, and is recorded as null.)
      if (!edges.some((edge) => edge.when)) continue;
      const reason = `route evaluation failed: phase "${phase.id}" succeeded without recording its declared result "${phaseDef.result.artifact}"`;
      phase.status = "failed";
      phase.payload = withReason(phase.payload, reason);
      routing.failures.push({ phaseId: phase.id, reason });
      settled.add(phase.id);
      continue;
    }
    try {
      const { selected, skipped } = evaluateRoutes(edges, phase.result);
      // The artifact and the decision are the same fact, so they are published
      // together: no reader can see one without the other.
      inst.artifacts = {
        ...(inst.artifacts ?? {}),
        [phaseDef.result.artifact]: phase.result ?? null,
      };
      const decision: RouteDecision = {
        sourcePhase: phase.id,
        artifact: phaseDef.result.artifact,
        value: phase.result ?? null,
        selected,
        skipped,
        reason: describeDecision(edges, selected, skipped),
      };
      inst.routeDecisions = [...(inst.routeDecisions ?? []), decision];
      routing.decisions.push(decision);
    } catch (e) {
      // An ambiguous or unmatched required group would authorize work nobody
      // asked for (or none at all), so the source phase fails instead.
      const reason = `route evaluation failed: ${
        e instanceof RouteEvaluationError ? e.message : String(e)
      }`;
      phase.status = "failed";
      phase.payload = withReason(phase.payload, reason);
      routing.failures.push({ phaseId: phase.id, reason });
    }
    settled.add(phase.id);
  }
}

/** Mark the work routing decided against, and everything that only it fed. */
function propagateSkips(
  def: PipelineDefinition,
  inst: PipelineInstance,
  routing: RouteOutcome,
): void {
  // Iterated to a fixed point: skipping a phase resolves its own outgoing
  // edges, which can be the last unknown edge of the phase after it.
  for (;;) {
    const next = skippablePhases(def, inst);
    if (next.length === 0) return;
    for (const i of next) {
      const phase = inst.phases[i];
      phase.status = "skipped";
      phase.steps = phase.steps.map((step) =>
        step.status === "pending" ? { ...step, status: "skipped" as const } : step,
      );
      routing.skipped.push(phase.id);
    }
  }
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
 *
 * This is also the *only* route evaluator. Routes are decided here, before
 * readiness, because a decision is what makes a conditional edge readable at
 * all: skips propagate from it, and the phases it authorized are launched in the
 * same pass. Nowhere else in Argus may select a branch.
 */
export function settle(
  def: PipelineDefinition,
  inst: PipelineInstance,
  nowISO: string,
  priorFailures: RouteFailure[] = [],
): TransitionResult {
  const routing: RouteOutcome = { decisions: [], skipped: [], failures: [...priorFailures] };
  recordRouteDecisions(def, inst, routing);
  propagateSkips(def, inst, routing);

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
  return { instance: inst, startPhases, routing };
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
  // A structured result belongs to the step that submitted it until every step
  // is in: the phase publishes one decision, and which step may submit it is
  // the definition's business, not the arrival order's.
  if (signal.result !== undefined) step.result = signal.result;
  if (signal.resultError !== undefined) step.resultError = signal.resultError;

  if (signal.type === "failed" && !payloadReason(phase.payload)) {
    phase.payload = withReason(phase.payload, DEFAULT_FAIL_REASON);
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
  // Every step is in, so the phase's declared result is now due. A gate
  // validates it here and still waits for a human: the result is what the
  // approval is *about*, and routes activate only once that approval lands.
  const resolved = resolvePhaseResult(def, phase);
  if (!resolved.ok) {
    phase.status = "failed";
    phase.payload = withReason(phase.payload, resolved.reason);
    failLeftoverSteps(phase);
    return settle(def, inst, nowISO, [{ phaseId: phase.id, reason: resolved.reason }]);
  }
  if (resolved.value !== undefined) phase.result = resolved.value;

  // Agent completion is not phase success. A phase with declared checks stays
  // running while Argus verifies the work itself; the gate and the successors
  // wait for that verdict, not for the agent's.
  const checks = def.phases.find((p) => p.id === phase.id)?.checks;
  if (checks && checks.length > 0) {
    phase.verification = { status: "running", startedAt: nowISO, checks: [] };
    touch(inst, nowISO);
    return { instance: inst, startPhases: [], verify: [phase.id] };
  }
  return concludePhase(def, inst, phase, nowISO);
}

/** Every step is in and every check has passed: pause at the gate or succeed. */
function concludePhase(
  def: PipelineDefinition,
  inst: PipelineInstance,
  phase: PhaseProgress,
  nowISO: string,
): TransitionResult {
  if (phase.gated) {
    phase.status = "awaiting-approval";
    return settle(def, inst, nowISO);
  }
  phase.status = "succeeded";
  publishArtifact(def, inst, phase.id);
  return settle(def, inst, nowISO);
}

/** One line naming what failed, for the phase's failure reason. */
export function verificationFailureReason(report: VerificationReport): string {
  const failed = report.checks.filter((c) => c.status === "failed");
  if (failed.length === 0) return "verification failed";
  return `verification failed: ${failed.map((c) => `${c.label} (${c.detail})`).join("; ")}`;
}

/**
 * Record the outcome of Argus's own checks over a phase whose steps have all
 * reported success.
 *
 * Only a phase still `running` under a `running` verification takes the
 * report: an abort, a revise or a competing transition in the window while the
 * checks ran has already decided otherwise, and a stale report must not undo
 * it. A passing report concludes the phase exactly as a check-less phase would
 * have at the last step's signal; a failing one fails the phase under the
 * `verification` class, carrying the report as evidence for the retry, the
 * revise, or the person reading the board.
 */
export function applyVerification(
  def: PipelineDefinition,
  inst: PipelineInstance,
  phaseId: string,
  report: VerificationReport,
  nowISO: string,
): TransitionResult {
  const phase = inst.phases.find((p) => p.id === phaseId);
  if (!phase || phase.status !== "running" || phase.verification?.status !== "running") {
    return { instance: inst, startPhases: [] };
  }
  phase.verification = report;
  if (report.status === "passed") return concludePhase(def, inst, phase, nowISO);

  phase.status = "failed";
  phase.payload = withFailureClass(
    withReason(phase.payload, verificationFailureReason(report)),
    "verification",
  );
  failLeftoverSteps(phase);
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
  // A fresh attempt is verified afresh; the previous report stays in the
  // journal, and in the payload's reason, not on the live phase.
  delete phase.verification;
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
