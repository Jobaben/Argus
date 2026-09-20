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
  AgentRuntimeId,
  CandidateOutcome,
  CandidatePolicy,
  DependencyEdge,
  PhaseFailureClass,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
  PipelineSignal,
  RetryableClass,
  RetryPolicy,
  RouteDecision,
  StepProgress,
  StepStatus,
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
  /** Set by {@link applyVerification} when the report was taken; absent when it
   *  was refused as stale. */
  verificationApplied?: boolean;
  /**
   * One candidate of a `candidates` phase whose own `checks` Argus must now run,
   * inside that candidate's worktree. The phase stays `running`: the selection
   * is not decidable until enough candidates have reported.
   */
  verifyCandidate?: { phaseId: string; candidate: number };
  /**
   * Set whenever a candidate of a `candidates` phase moved. The engine answers
   * it by re-evaluating the selection ({@link selectCandidate}) with the run
   * records the cost comparison needs, which is I/O and therefore not done here.
   */
  candidatesMoved?: string;
  /**
   * Phase ids whose every acceptance condition has been met — steps
   * succeeded, result validated, checks passed, gate approved — and whose
   * staged KnowledgeDeltas Argus must now commit before the phase may
   * succeed. The phase stays `running` with `knowledge.status: "pending"`
   * until the engine reports through {@link applyKnowledgeCommit}; nothing
   * downstream is ready yet.
   */
  commitKnowledge?: string[];
  /** Set by {@link applyKnowledgeCommit} when the verdict was taken; absent
   *  when it was refused as stale. */
  knowledgeApplied?: boolean;
  /** Set by {@link advance} when the signal matched nothing it may drive and
   *  the instance was returned untouched. */
  ignored?: "unknown-phase" | "phase-not-running" | "unknown-run";
}

/** Kept for definitions and tests that predate `{{artifacts.<name>}}`. */
export function applyTemplate(prompt: string, prevPayload: unknown): string {
  return interpolate(prompt, prevPayload).prompt;
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
  /** Which of the phase's steps may have delivered the result. Defaults to all
   *  of them; a `candidates` phase passes only the winner, because the losers'
   *  submissions are drafts the phase decided against, not contradictions. */
  steps: StepProgress[] = phase.steps,
): { ok: true; value?: unknown } | { ok: false; reason: string } {
  const phaseDef = def.phases.find((p) => p.id === phase.id);
  if (!phaseDef?.result) return { ok: true };
  const artifact = phaseDef.result.artifact;
  const wanted = resultStepName(phaseDef);

  const unreadable = steps.find((s) => s.resultError);
  if (unreadable) return { ok: false, reason: `result "${artifact}": ${unreadable.resultError}` };

  const submitted = steps.filter((s) => s.result !== undefined);
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
  trigger: PipelineInstance["trigger"],
  ids: { instanceId: string; token: string },
  nowISO: string,
  /** Set for `trigger: "webhook"` (the request body) or `"chained"` (the
   *  source instance's outcome) — absent for `"manual"`/`"scheduled"`. */
  firing?: { triggerPayload?: unknown; chainedFrom?: string },
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
    ...(firing?.triggerPayload !== undefined ? { triggerPayload: firing.triggerPayload } : {}),
    ...(firing?.chainedFrom !== undefined ? { chainedFrom: firing.chainedFrom } : {}),
    signalToken: ids.token,
    createdAt: nowISO,
    updatedAt: nowISO,
    endedAt: null,
    artifacts: {},
    // Snapshotted here, in the same record as the phase list it describes: the
    // instance carries its own definition from its first write, so nothing an
    // author saves afterwards can reach it.
    definition: def,
  };
  return settle(def, instance, nowISO);
}

export function advance(
  def: PipelineDefinition,
  inst: PipelineInstance,
  signal: PipelineSignal,
  nowISO: string,
  /**
   * How a `failed` signal was classed, when the caller already knows (a
   * deadline, a dead run record, an invocation Argus refused to make).
   *
   * Read only on a candidates phase, which records the class per candidate
   * because its phase-level payload belongs to whichever candidate wins. An
   * ordinary phase's class is applied by the engine after the transition, as
   * it always was.
   */
  failureClass?: PhaseFailureClass,
): TransitionResult {
  // Located by id, not by a cursor: with a fan-out, several phases are live at
  // once and the signalling one is whichever sent it.
  const phase = inst.phases.find((p) => p.id === signal.phaseId);
  if (!phase) return { instance: inst, startPhases: [], ignored: "unknown-phase" };
  if (phase.status !== "running") {
    return { instance: inst, startPhases: [], ignored: "phase-not-running" };
  }

  // Only a run currently tracked by this phase may drive it. A signal whose
  // runId matches no step comes from a stale or duplicate concurrent run (its
  // runId was overwritten by a later revise/re-spawn) and is ignored, so it
  // can't terminalize or advance the instance behind the tracked run's back.
  const step = phase.steps.find((s) => s.runId === signal.runId);
  if (!step) return { instance: inst, startPhases: [], ignored: "unknown-run" };

  // A candidate is not a step of a phase in the ordinary sense: its failure
  // does not fail the phase, and its success does not conclude it. Everything
  // about that lives in one place rather than as conditions sprinkled below.
  const phaseDef = def.phases.find((p) => p.id === phase.id);
  if (phaseDef?.candidates && step.candidate !== undefined) {
    return advanceCandidate(inst, phase, step, signal, nowISO, failureClass);
  }

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

/** Every step is in and every check has passed: pause at the gate, or
 *  succeed — through the knowledge commit when the attempt staged any. */
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
  return succeedPhase(def, inst, phase, nowISO);
}

/**
 * The KnowledgeDeltas this attempt would commit: one per step whose run
 * staged one and whose step *succeeded*. A losing candidate's step is
 * `aborted` and its delta is not eligible, however valid it was.
 */
export function stagedDeltaIds(phase: PhaseProgress): string[] {
  return phase.steps.flatMap((s) =>
    s.status === "succeeded" && s.knowledgeDelta?.status === "staged" ? [s.knowledgeDelta.id] : [],
  );
}

/**
 * The rule-verification proposals this attempt would commit (Phase 6): one per
 * step whose run staged one and whose step *succeeded*. Exactly the same
 * eligibility rule as {@link stagedDeltaIds}, so an abandoned attempt's
 * conformance results can no more become durable than its claims can.
 */
export function stagedVerificationIds(phase: PhaseProgress): string[] {
  return phase.steps.flatMap((s) =>
    s.status === "succeeded" && s.ruleVerification?.status === "staged"
      ? [s.ruleVerification.id]
      : [],
  );
}

/**
 * The change proposals this attempt would accept (Phase 7): one per step whose
 * run staged one and whose step *succeeded*. Exactly the same eligibility rule
 * as {@link stagedDeltaIds}, so an abandoned attempt's reasoning can no more
 * become canonical intent than its claims can become canonical knowledge.
 */
export function stagedChangeProposalIds(phase: PhaseProgress): string[] {
  return phase.steps.flatMap((s) =>
    s.status === "succeeded" && s.changeProposal?.status === "staged" ? [s.changeProposal.id] : [],
  );
}

/**
 * The last rung of the acceptance ladder. A phase whose attempt staged no
 * KnowledgeDelta succeeds here exactly as it always did. One that did stays
 * `running` under `knowledge.status: "pending"` — the same shape as a phase
 * under `verification.status: "running"` — and hands the engine the phase id:
 * the commit is I/O against `knowledge.json`, which a pure transition cannot
 * do, and the phase must not read as succeeded until it has happened. The
 * held phase is persisted in that state, so a restart between the ledger
 * write and the instance write is healed by committing again (idempotent).
 */
function succeedPhase(
  def: PipelineDefinition,
  inst: PipelineInstance,
  phase: PhaseProgress,
  nowISO: string,
): TransitionResult {
  const deltas = stagedDeltaIds(phase);
  const verifications = stagedVerificationIds(phase);
  const changeProposals = stagedChangeProposalIds(phase);
  if (deltas.length > 0 || verifications.length > 0 || changeProposals.length > 0) {
    phase.status = "running";
    phase.knowledge = {
      status: "pending",
      deltas,
      ...(verifications.length > 0 ? { verifications } : {}),
      ...(changeProposals.length > 0 ? { changeProposals } : {}),
      startedAt: nowISO,
    };
    return { ...settle(def, inst, nowISO), commitKnowledge: [phase.id] };
  }
  phase.status = "succeeded";
  publishArtifact(def, inst, phase.id);
  return settle(def, inst, nowISO);
}

/** What the engine learned from committing a phase's staged deltas. */
export type KnowledgeCommitVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Record the outcome of committing a phase attempt's staged KnowledgeDeltas.
 *
 * Only a phase still `running` under a `pending` commit takes the verdict: an
 * abort or a revise in the window has already decided otherwise. A committed
 * ledger concludes the phase as `succeeded` exactly as a delta-less phase
 * would have; a refused commit — the ledger moved under a precondition, two
 * steps' proposals conflicted — fails the phase under the `knowledge-delta`
 * class with the ledger's own reason, so the retry note or the person
 * revising sees precisely what was refused.
 */
export function applyKnowledgeCommit(
  def: PipelineDefinition,
  inst: PipelineInstance,
  phaseId: string,
  verdict: KnowledgeCommitVerdict,
  nowISO: string,
): TransitionResult {
  const phase = inst.phases.find((p) => p.id === phaseId);
  if (!phase || phase.status !== "running" || phase.knowledge?.status !== "pending") {
    return { instance: inst, startPhases: [] };
  }
  const held = phase.knowledge;
  const heldVerifications = held.verifications ?? [];
  const heldChanges = held.changeProposals ?? [];
  const mark = (status: "applied" | "rejected") => {
    for (const s of phase.steps) {
      if (s.knowledgeDelta && held.deltas.includes(s.knowledgeDelta.id)) {
        s.knowledgeDelta = { ...s.knowledgeDelta, status };
      }
      if (s.ruleVerification && heldVerifications.includes(s.ruleVerification.id)) {
        s.ruleVerification = { ...s.ruleVerification, status };
      }
      if (s.changeProposal && heldChanges.includes(s.changeProposal.id)) {
        // A change proposal is `accepted`, not `applied`: what became canonical
        // is its delta, and what became durable is the record of the request.
        s.changeProposal = {
          ...s.changeProposal,
          status: status === "applied" ? "accepted" : "rejected",
        };
      }
    }
  };
  if (verdict.ok) {
    phase.knowledge = { ...held, status: "applied", endedAt: nowISO };
    mark("applied");
    phase.status = "succeeded";
    publishArtifact(def, inst, phase.id);
    return { ...settle(def, inst, nowISO), knowledgeApplied: true };
  }
  phase.knowledge = { ...held, status: "rejected", endedAt: nowISO, reason: verdict.reason };
  mark("rejected");
  phase.status = "failed";
  // The commit is one transition over every half, so one failure class names
  // it. `change-proposal` when a change proposal was at stake — it is the
  // outermost thing the attempt was doing; `rule-verification` when only
  // conformance results were; `knowledge-delta` otherwise, unchanged from
  // Phase 3.
  phase.payload = withFailureClass(
    withReason(phase.payload, verdict.reason),
    heldChanges.length > 0
      ? "change-proposal"
      : held.deltas.length === 0 && heldVerifications.length > 0
        ? "rule-verification"
        : "knowledge-delta",
  );
  failLeftoverSteps(phase);
  return { ...settle(def, inst, nowISO), knowledgeApplied: true };
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
  if (report.status === "passed") {
    return { ...concludePhase(def, inst, phase, nowISO), verificationApplied: true };
  }

  phase.status = "failed";
  phase.payload = withFailureClass(
    withReason(phase.payload, verificationFailureReason(report)),
    "verification",
  );
  failLeftoverSteps(phase);
  return { ...settle(def, inst, nowISO), verificationApplied: true };
}

// ── Candidates: best-of-N with verifier-gated selection ──────────────────────

/**
 * Where one candidate has got to, as selection sees it.
 *
 * Three states, and the middle one is the whole point: a candidate that has
 * *finished running* is not yet a candidate that has *won*. It has won when its
 * own copy of the phase's checks passed inside its own worktree.
 */
export type CandidateState = "running" | "verified" | "lost";

/**
 * One candidate as the selectors read it: the persisted step, joined with the
 * cost and duration its run reported.
 *
 * The join is the caller's job (the engine reads the run records), which keeps
 * every rule below a pure function of plain data — and makes "cheapest wins"
 * testable without a filesystem.
 */
export interface CandidateRecord {
  candidate: number;
  status: StepStatus;
  /** Whether its checks passed. Null = it never reached them. */
  verified: boolean | null;
  /** When its checks finished, for "first". Null = they did not. */
  verifiedAt: string | null;
  costUsd: number | null;
  durationMs: number | null;
  runtime: AgentRuntimeId | null;
  model: string | null;
  /** Why it lost, when it did. */
  reason?: string;
  /** How its own failure was classed, for {@link candidateFailureClass}. */
  failureClass?: PhaseFailureClass;
}

export function candidateState(record: CandidateRecord): CandidateState {
  if (record.verified === true) return "verified";
  if (record.verified === false) return "lost";
  if (record.status === "failed" || record.status === "aborted" || record.status === "skipped") {
    return "lost";
  }
  return "running";
}

/** The record for one persisted candidate step, before the run join. */
export function candidateRecordOf(step: StepProgress): CandidateRecord {
  const verification = step.verification;
  return {
    candidate: step.candidate ?? 0,
    status: step.status,
    verified:
      verification?.status === "passed" ? true : verification?.status === "failed" ? false : null,
    verifiedAt: verification?.endedAt ?? null,
    costUsd: null,
    durationMs: null,
    runtime: null,
    model: null,
    ...(step.failure ? { reason: step.failure.reason, failureClass: step.failure.class } : {}),
  };
}

/** What the selection concluded, without acting on it. */
export type CandidateSelection =
  { kind: "pending" } | { kind: "selected"; candidate: number } | { kind: "none" };

/** Nulls sort last: an unknown cost is not a cheap one. */
function orMax(n: number | null): number {
  return n == null ? Number.POSITIVE_INFINITY : n;
}

/**
 * Which candidate the phase keeps, if the question can be answered yet.
 *
 * `first-verified` answers as soon as one candidate's checks pass — the whole
 * point being that the siblings are then killed rather than paid for. Among
 * several already-verified candidates (a restart re-evaluating, or two reports
 * landing in the same tick) the earliest to finish its checks wins, then the
 * lowest index: a rule that reads the same off the persisted records however
 * many times it is applied.
 *
 * `cheapest-verified` waits for every candidate to settle and then buys the
 * cheapest verified draft, tie-broken by duration and then by index.
 *
 * Pure and total: `pending` means "ask again later", `none` means "nothing can
 * still win".
 */
export function selectCandidate(
  policy: CandidatePolicy,
  records: CandidateRecord[],
): CandidateSelection {
  const verified = records.filter((r) => candidateState(r) === "verified");
  const running = records.filter((r) => candidateState(r) === "running");

  if (policy.select === "first-verified") {
    if (verified.length > 0) {
      const winner = [...verified].sort(
        (a, b) =>
          (a.verifiedAt ?? "").localeCompare(b.verifiedAt ?? "") || a.candidate - b.candidate,
      )[0];
      return { kind: "selected", candidate: winner.candidate };
    }
    return running.length > 0 ? { kind: "pending" } : { kind: "none" };
  }

  // cheapest-verified: no decision until the last candidate has had its say,
  // because the one still running may be the cheap one.
  if (running.length > 0) return { kind: "pending" };
  if (verified.length === 0) return { kind: "none" };
  const winner = [...verified].sort(
    (a, b) =>
      orMax(a.costUsd) - orMax(b.costUsd) ||
      orMax(a.durationMs) - orMax(b.durationMs) ||
      a.candidate - b.candidate,
  )[0];
  return { kind: "selected", candidate: winner.candidate };
}

/**
 * How a phase whose every candidate lost is classed for the retry policy.
 *
 * The last candidate to settle is the one whose story the phase tells, so its
 * class is used when every candidate agrees with it. When they disagree, a
 * `verification` failure outranks the rest — a candidate that got as far as the
 * checks and was rejected by them is the most informative thing that happened,
 * and it is the class an author who opted into retrying verification meant.
 * Failing both, `exit-code`: something ran and did not work out.
 */
export function candidateFailureClass(records: CandidateRecord[]): PhaseFailureClass {
  const classes = records.map((r) => r.failureClass).filter((c): c is PhaseFailureClass => !!c);
  if (classes.length === 0) return "exit-code";
  const last = classes[classes.length - 1];
  if (classes.every((c) => c === last)) return last;
  if (classes.includes("verification")) return "verification";
  return "exit-code";
}

/** One line per candidate: what it was, and why it is not the answer. */
export function candidateFailureReason(records: CandidateRecord[]): string {
  const lines = [...records]
    .sort((a, b) => a.candidate - b.candidate)
    .map((r) => {
      const who = [r.runtime, r.model].filter(Boolean).join(" ");
      const label = who ? `c${r.candidate} (${who})` : `c${r.candidate}`;
      return `${label}: ${r.reason ?? (r.verified === false ? "checks failed" : r.status)}`;
    });
  return `no candidate passed its checks — ${lines.join("; ")}`;
}

/** The outcomes written onto the phase once it settles, newest evidence first
 *  in candidate order so the board can list them without re-sorting. */
export function toCandidateOutcomes(records: CandidateRecord[]): CandidateOutcome[] {
  return [...records]
    .sort((a, b) => a.candidate - b.candidate)
    .map((r) => ({
      candidate: r.candidate,
      status: r.status,
      verified: r.verified,
      costUsd: r.costUsd,
      durationMs: r.durationMs,
      runtime: r.runtime,
      model: r.model,
      ...(r.reason ? { reason: r.reason } : {}),
    }));
}

/**
 * One candidate reported. Nothing about the phase is decided here.
 *
 * A candidate's payload, result and failure are held on its own step: the phase
 * publishes exactly one of them, and which one is a question only the selection
 * can answer. So this records what arrived and hands the caller a
 * `candidatesMoved` flag, and the engine re-runs the selection with the run
 * records it alone can read.
 */
function advanceCandidate(
  inst: PipelineInstance,
  phase: PhaseProgress,
  step: StepProgress,
  signal: PipelineSignal,
  nowISO: string,
  failureClass?: PhaseFailureClass,
): TransitionResult {
  if (signal.payload !== undefined) step.payload = signal.payload;
  if (signal.result !== undefined) step.result = signal.result;
  if (signal.resultError !== undefined) step.resultError = signal.resultError;
  touch(inst, nowISO);

  if (signal.type === "completed") {
    step.status = "succeeded";
    // Even a phase with no `checks` goes through verification: an empty check
    // list passes trivially, and one code path for "is this candidate any
    // good" is worth more than the microseconds it costs.
    step.verification = { status: "running", startedAt: nowISO, checks: [] };
    return {
      instance: inst,
      startPhases: [],
      verifyCandidate: { phaseId: phase.id, candidate: step.candidate ?? 0 },
      candidatesMoved: phase.id,
    };
  }

  // `needs-input` has nowhere to go on a candidate: the gate of a candidates
  // phase opens after selection, on the winner, so a draft that stops to ask a
  // question has stopped without delivering one. It loses, and says so.
  const reason =
    signal.type === "needs-input"
      ? "candidate asked for input; a candidate phase gates on its winner, not on a draft"
      : (payloadReason(step.payload) ?? DEFAULT_FAIL_REASON);
  step.status = "failed";
  step.failure = { class: failureClass ?? "signal", reason };
  return { instance: inst, startPhases: [], candidatesMoved: phase.id };
}

/**
 * Record one candidate's own verification report.
 *
 * Refused unless that candidate is still `succeeded` under a `running` report —
 * a revise, an abort or a selection that already happened has decided
 * otherwise, and a report from the losing side of that decision must not
 * reopen it.
 */
export function applyCandidateVerification(
  inst: PipelineInstance,
  phaseId: string,
  candidate: number,
  report: VerificationReport,
  nowISO: string,
): TransitionResult {
  const phase = inst.phases.find((p) => p.id === phaseId);
  const step = phase?.steps.find((s) => s.candidate === candidate);
  if (!phase || !step || phase.status !== "running" || step.verification?.status !== "running") {
    return { instance: inst, startPhases: [] };
  }
  step.verification = report;
  if (report.status !== "passed") {
    step.failure = { class: "verification", reason: verificationFailureReason(report) };
  }
  touch(inst, nowISO);
  return {
    instance: inst,
    startPhases: [],
    verificationApplied: true,
    candidatesMoved: phaseId,
  };
}

/**
 * The selection landed: one candidate is the phase's work and the rest are not.
 *
 * The winner's worktree, verification report, payload and result become the
 * phase's own — a downstream phase reading `{{previous.payload}}` must never see
 * a draft the pipeline threw away. The losers are marked `aborted` rather than
 * `failed`: nothing went wrong with them, they were simply not chosen, and a
 * board that says "failed" about three-quarters of a successful phase is a
 * board nobody trusts.
 *
 * The caller has already killed whatever was still running (and removed the
 * losing worktrees); this only writes down what that means.
 */
export function applyCandidateSelection(
  def: PipelineDefinition,
  inst: PipelineInstance,
  phaseId: string,
  candidate: number,
  outcomes: CandidateOutcome[],
  nowISO: string,
): TransitionResult {
  const phase = inst.phases.find((p) => p.id === phaseId);
  const winner = phase?.steps.find((s) => s.candidate === candidate);
  if (!phase || !winner || phase.status !== "running") {
    return { instance: inst, startPhases: [] };
  }
  for (const s of phase.steps) {
    if (s === winner) continue;
    if (s.status === "pending" || s.status === "running" || s.status === "succeeded") {
      s.status = "aborted";
      s.failure ??= { class: "exit-code", reason: `superseded by candidate ${candidate}` };
    }
  }
  phase.selectedCandidate = candidate;
  phase.candidateOutcomes = outcomes;
  phase.payload = winner.payload ?? null;
  phase.verification = winner.verification;
  phase.workspace = winner.workspace ?? null;

  const resolved = resolvePhaseResult(def, phase, [winner]);
  if (!resolved.ok) {
    phase.status = "failed";
    phase.payload = withReason(phase.payload, resolved.reason);
    return settle(def, inst, nowISO, [{ phaseId, reason: resolved.reason }]);
  }
  if (resolved.value !== undefined) phase.result = resolved.value;
  return concludePhase(def, inst, phase, nowISO);
}

/**
 * Every candidate lost. The phase fails once, with every draft's fate in the
 * reason — the point of running N of them is that the N failures together say
 * more than any one of them, and a retry (or a person) gets all of it.
 */
export function applyCandidatesExhausted(
  def: PipelineDefinition,
  inst: PipelineInstance,
  phaseId: string,
  failureClass: PhaseFailureClass,
  reason: string,
  outcomes: CandidateOutcome[],
  nowISO: string,
): TransitionResult {
  const phase = inst.phases.find((p) => p.id === phaseId);
  if (!phase || phase.status !== "running") return { instance: inst, startPhases: [] };
  phase.selectedCandidate = null;
  phase.candidateOutcomes = outcomes;
  phase.status = "failed";
  phase.payload = withFailureClass(withReason(phase.payload, reason), failureClass);
  failLeftoverSteps(phase);
  return settle(def, inst, nowISO);
}

/**
 * Fail a phase that is about to launch but whose definition is gone: the
 * pipeline was edited under a live instance and no longer names this phase.
 * A `configuration` failure, never retried, because running again cannot
 * bring the phase back; a person fixes the definition or revises elsewhere.
 * Only a `running` phase is taken (the one a revise, retry or settle just
 * marked); anything else is left alone.
 */
export function applyUnlaunchable(
  def: PipelineDefinition,
  inst: PipelineInstance,
  phaseId: string,
  reason: string,
  nowISO: string,
): TransitionResult {
  const phase = inst.phases.find((p) => p.id === phaseId);
  if (!phase || phase.status !== "running") return { instance: inst, startPhases: [] };
  phase.status = "failed";
  phase.payload = withFailureClass(withReason(phase.payload, reason), "configuration");
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
  // Approval is the gate's acceptance condition; the staged knowledge commits
  // only now, never when the agent finished or the checks passed.
  return succeedPhase(def, inst, phase, nowISO);
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
  // One entry per declared step, not per candidate run: `startPhase` plans the
  // attempt afresh and overwrites this, and a candidate phase's next attempt
  // may not even have the same `count`.
  const names = [...new Set(phase.steps.map((s) => s.name))];
  phase.steps = names.map((name) => ({ name, runId: null, status: "pending" }));
  // A fresh attempt is verified afresh; the previous report stays in the
  // journal, and in the payload's reason, not on the live phase.
  delete phase.verification;
  // And its knowledge is proposed afresh: the previous attempt's staged deltas
  // (on the steps just replaced) are superseded, never committed.
  delete phase.knowledge;
  // So is a fresh attempt selected afresh. The previous attempt's outcomes are
  // evidence about a run that no longer exists.
  delete phase.selectedCandidate;
  delete phase.candidateOutcomes;
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
