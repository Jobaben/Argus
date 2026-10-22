import { readInstance } from "../sources/instances.js";
import {
  applyApprove,
  applyChildRevived,
  applyRevise,
  pausedPhase,
  abortTransition,
  applyGateComplete,
  applyGateLink,
  applyConditionFailed,
} from "../pipelineTransitions.js";
import { journal } from "../sources/journal.js";
import { appendGateDecision } from "../sources/gateDecisions.js";
import {
  gateRelevantSteps,
  knowledgeCommitReasons,
  stagedKnowledgeReasons,
  trajectoryBar,
  trajectoryBasisEntry,
} from "../sources/gatePolicy.js";
import { rubricDigest, withCurrentVerdicts } from "../sources/verdict.js";
import { hasTrajectory } from "../sources/trajectory.js";
import type {
  AbortCause,
  TransitionSource,
  GateDecision,
  GateDecisionPhaseRef,
  GateDecisionTrajectoryBasis,
  GateDecisionVerdictBasis,
  PendingGateOperation,
} from "@argus/contracts";
import type {
  PhaseDef,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import type { TransitionResult } from "../pipelineTransitions.js";
import { log } from "../log.js";
import { isTerminal } from "../sources/instanceStatus.js";
import { REVISE_NOTE_MAX } from "./constants.js";
import type {
  ActionResult,
  AutomatedApproval,
  ConditionApproval,
  ConditionFailure,
  Continued,
  GateEffectPoint,
  GateTarget,
  OperatorSource,
} from "./types.js";
import type { EngineCore, EngineFns } from "./context.js";

/** An automated rule's own question: does the phase's definition snapshot declare it? */
interface AutomatedRule {
  declares: (phaseDef: PhaseDef) => boolean;
  /** Completes "phase <id> …" when it does not. */
  missing: string;
}

/** A Verdict auto-approval: a bar to clear, and a rubric to score against. */
const AUTO_APPROVE_RULE: AutomatedRule = {
  declares: (p) => p.autoApprove?.verdict !== undefined && !!p.rubric,
  missing: "does not declare autoApprove with a rubric",
};

/** An approval condition (DL-A3): a command polled while the gate waits. */
const APPROVE_WHEN_RULE: AutomatedRule = {
  declares: (p) => !!p.approveWhen,
  missing: "does not declare approveWhen",
};

/** A decision Argus carries out for a parent is neither an operator's nor unspecified. */
function decisionMechanism(options: {
  source?: OperatorSource;
  byParent?: { decisionId?: string };
}): GateDecision["mechanism"] {
  if (options.byParent) return "parent-decision";
  return options.source ? "operator" : "unspecified";
}

/** Gate decisions: approve, revise, abort and automated approval (a Verdict or an approval condition), with their write-ahead record, link and completion. Moved verbatim from `createEngine`. */
export function createGates(core: EngineCore) {
  const { deps, locks, nowISO, persist, T } = core.ctx;
  const childDecisionAllowed: EngineFns["childDecisionAllowed"] = (...args) =>
    core.fns.childDecisionAllowed(...args);
  const childrenApproveRefusal: EngineFns["childrenApproveRefusal"] = (...args) =>
    core.fns.childrenApproveRefusal(...args);
  const defFor: EngineFns["defFor"] = (...args) => core.fns.defFor(...args);
  const noteRouting: EngineFns["noteRouting"] = (...args) => core.fns.noteRouting(...args);
  const queueAbortCascade: EngineFns["queueAbortCascade"] = (...args) =>
    core.fns.queueAbortCascade(...args);
  const queueReadyPhases: EngineFns["queueReadyPhases"] = (...args) =>
    core.fns.queueReadyPhases(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const settleKnowledge: EngineFns["settleKnowledge"] = (...args) =>
    core.fns.settleKnowledge(...args);
  const settleRealizations: EngineFns["settleRealizations"] = (...args) =>
    core.fns.settleRealizations(...args);
  const startPhases: EngineFns["startPhases"] = (...args) => core.fns.startPhases(...args);
  const stopRuns: EngineFns["stopRuns"] = (...args) => core.fns.stopRuns(...args);
  const supersedeDeltas: EngineFns["supersedeDeltas"] = (...args) =>
    core.fns.supersedeDeltas(...args);

  // ── Gate decisions ────────────────────────────────────────────────────────
  //
  // The order every approve, revise and abort follows, and why:
  //
  //   1. validate                         — a refusal (409) writes nothing
  //   2. record the decision, fsynced     — intent (sources/gateDecisions.ts)
  //   3. LINK: one instance save naming the decision in `gateDecisionIds`
  //      and carrying `pendingGateOperation`   — before any effect
  //   4. effects: supersede staged records, stop runs, commit knowledge,
  //      settle realizations, transition the phase
  //   5. COMPLETE: the instance save that clears `pendingGateOperation`
  //
  // So an unlinked record provably had no effect (`not-applied`), a linked one
  // with its marker still present is `incomplete`, and a linked one without it
  // is `applied`. Step 4 is idempotent against what is on disk, and every path
  // that mutates an instance first completes a leftover marker (`readLive`),
  // so an interrupted operation is carried through exactly once and nothing
  // else — an approval of the attempt a revise discarded, the work an abort was
  // stopping — can happen in between.

  const recordGateDecision = deps.recordGateDecision ?? appendGateDecision;
  const probe = async (point: GateEffectPoint, instanceId: string) =>
    deps.gateEffectProbe?.(point, instanceId);

  function phaseRef(phase: PhaseProgress): GateDecisionPhaseRef {
    return {
      phaseId: phase.id,
      attempt: phase.attempt,
      status: phase.status,
      runIds: phase.steps.map((s) => s.runId).filter((id): id is string => !!id),
    };
  }

  const UNSPECIFIED: OperatorSource = { channel: "in-process", principal: { kind: "unknown" } };

  /** Step 2. The record, or the refusal to return when it cannot be written. */
  async function writeDecision(
    decision: Omit<GateDecision, "id" | "recordedAt">,
  ): Promise<{ record: GateDecision } | { refusal: ActionResult }> {
    const record: GateDecision = {
      id: `GD-${deps.newId()}`,
      ...decision,
      recordedAt: nowISO(),
    };
    try {
      await recordGateDecision(record);
      return { record };
    } catch (e) {
      log.error("gate decision could not be recorded; refusing it", {
        instanceId: decision.instanceId,
        decision: decision.decision,
        err: e,
      });
      return {
        refusal: {
          ok: false,
          code: 500,
          error: "the gate decision could not be recorded, so it was not applied; nothing changed",
        },
      };
    }
  }

  /**
   * Step 3. Link the decision and mark its operation pending, in one save,
   * before any effect. Returns the refusal when the save fails — and says
   * whether the link landed anyway, re-read from disk rather than assumed.
   */
  async function linkDecision(
    inst: PipelineInstance,
    record: GateDecision,
    op: Omit<PendingGateOperation, "decisionId" | "decision" | "startedAt">,
  ): Promise<ActionResult | null> {
    T(applyGateLink(inst, record, op, nowISO()));
    try {
      // The plain commit, not `saveInstance`: the link must not carry any
      // effect with it — `saveInstance` also retires staged records and, for
      // a terminal instance, starts workspace cleanup. This save changes no
      // phase state, so there is nothing for those to act on anyway. The
      // transition record goes to the log first; the instance publication is
      // still the commit point, so a record whose publication failed is only
      // ever a proposal.
      await persist.commit(inst);
      await probe(`${record.decision}:linked` as GateEffectPoint, inst.id);
      return null;
    } catch (e) {
      const onDisk = await readInstance(inst.id).catch(() => null);
      const linked = !!onDisk?.gateDecisionIds?.includes(record.id);
      log.error("gate decision could not be linked to its instance", {
        instanceId: inst.id,
        decisionId: record.id,
        linked,
        err: e,
      });
      return {
        ok: false,
        code: 500,
        error: linked
          ? "the gate decision was linked but not completed; Argus completes it before anything else happens to this instance"
          : "the gate decision was recorded but could not be linked to the instance, so none of its effects started; nothing changed",
      };
    }
  }

  function stopTargets(phases: PhaseProgress[]): string[] {
    return phases.flatMap((p) => p.steps.map((s) => s.runId).filter((id): id is string => !!id));
  }

  /**
   * Step 4–5 for a revise. Idempotent against disk: records already
   * superseded stay superseded, a run already stopped is not alive, and a phase
   * already on the next attempt is not restarted again.
   */
  async function continueRevise(
    inst: PipelineInstance,
    op: PendingGateOperation,
  ): Promise<Continued> {
    let startIdx: number[] = [];
    const phase = inst.phases.find((p) => p.id === op.phaseId);
    if (
      phase &&
      phase.attempt === op.attempt &&
      (phase.status === "awaiting-approval" || phase.status === "failed")
    ) {
      // The paused phase's staged records are the attempt being discarded:
      // superseded while the steps that reference them still exist, so they
      // can never be committed by the attempt that follows.
      await supersedeDeltas(inst, phase, phase.steps, `attempt ${phase.attempt} revised`);
      await probe("revise:superseded", inst.id);
      // Exactly the revised attempt's runs, captured when the decision was
      // linked — never a sibling branch, and never the new attempt's.
      await stopRuns(op.stopRunIds, "superseded by a revise");
      await probe("revise:killed", inst.id);
      const res = T(applyRevise(inst, nowISO(), phase.id));
      startIdx = res.startPhases;
      // A spawn phase revised at its `children` pause re-runs every task that
      // did not succeed: failed children are revived in place, the rest get
      // fresh ones. In this same save, so the revives are owed from the moment
      // the revise is (engine/children.ts queues them when the phase starts).
      if (phase.children) {
        T(applyChildRevived(inst, phase.id, phase.attempt, op.decisionId, nowISO()));
      }
    }
    T(applyGateComplete(inst));
    await saveInstance(inst);
    await probe("revise:saved", inst.id);
    // The note reaches the new attempt from the durable decision record when
    // the attempt is planned (engine/outcome.ts `revisionHistory`), so it
    // survives every launch path, not only this one.
    return { instance: inst, startPhases: startIdx };
  }

  /** Step 4–5 for an abort. Idempotent: stopping a dead run is a no-op, an
   *  aborted instance is not re-aborted, and a realization that already has an
   *  outcome is left alone by `settleRealizations`. */
  async function continueAbort(
    inst: PipelineInstance,
    op: PendingGateOperation,
  ): Promise<Continued> {
    await stopRuns(op.stopRunIds, "aborted");
    await probe("abort:killed", inst.id);
    let aborted = inst;
    if (!isTerminal(inst.status)) {
      aborted = T(abortTransition(inst, nowISO(), op.cause)).instance;
    }
    // An abort ends every realization this instance was driving: a
    // completion question nothing will ever answer is not left `running`.
    const def = await defFor(aborted);
    const settled = def
      ? await settleRealizations(def, { instance: aborted, startPhases: [] })
      : { instance: aborted, startPhases: [] };
    await probe("abort:realizations-settled", inst.id);
    T(applyGateComplete(settled.instance));
    await saveInstance(settled.instance);
    await probe("abort:saved", inst.id);
    // The children stop with their parent: queued, off this lock (a child's
    // abort takes the child's lock, which is never awaited under a parent's).
    if (settled.instance.phases.some((p) => p.children)) queueAbortCascade(inst.id, op.decisionId);
    return { instance: settled.instance, startPhases: [] };
  }

  /** Step 4–5 for an approval. From the waiting phase, it applies the approval;
   *  from a phase whose commit is already pending, it re-drives the commit,
   *  which is idempotent on delta id. */
  async function continueApproval(
    def: PipelineDefinition,
    inst: PipelineInstance,
    op: PendingGateOperation,
  ): Promise<Continued> {
    const phase = inst.phases.find((p) => p.id === op.phaseId);
    let res: TransitionResult = { instance: inst, startPhases: [] };
    if (phase && phase.status === "awaiting-approval" && phase.attempt === op.attempt) {
      res = T(applyApprove(def, inst, op.answers, nowISO(), phase.id));
    } else if (phase && phase.status === "running" && phase.knowledge?.status === "pending") {
      res = { instance: inst, startPhases: [], commitKnowledge: [phase.id] };
    }
    // The gate is the acceptance condition: a staged delta commits here,
    // after the approval, never when the agent finished. `settleKnowledge`
    // saves the pending-commit state (marker still present) before it
    // touches the ledger.
    res = await settleKnowledge(def, res);
    await probe("approve:knowledge-settled", inst.id);
    res = await settleRealizations(def, res);
    await probe("approve:realizations-settled", inst.id);
    T(applyGateComplete(res.instance));
    await saveInstance(res.instance);
    await probe("approve:saved", inst.id);
    if (res.instance.status === "succeeded" || res.instance.status === "failed") {
      void journal(inst.id, {
        at: nowISO(),
        kind: "instance.ended",
        detail: res.instance.status,
      });
    }
    if (res.instance.status === "failed") deps.onFailure?.(res.instance);
    if (noteRouting(def, res.instance, res.routing)) await saveInstance(res.instance);
    return { instance: res.instance, startPhases: res.startPhases };
  }

  async function continueOperation(inst: PipelineInstance): Promise<Continued> {
    const op = inst.pendingGateOperation;
    if (!op) return { instance: inst, startPhases: [] };
    if (op.decision === "abort") return continueAbort(inst, op);
    if (op.decision === "revise") return continueRevise(inst, op);
    const def = await defFor(inst);
    if (!def)
      throw new Error("the instance's definition is gone; the approval cannot be completed");
    return continueApproval(def, inst, op);
  }

  /**
   * The engine's read for any path that is about to mutate an instance, under
   * its lock. When a gate operation was interrupted (the process died, or a
   * save failed, part-way through step 4), it is completed here first — from
   * disk, idempotently — and its phase launches are queued, so the caller
   * works on the state the decision produced, never on the state it was
   * interrupting. `null` when the instance is missing, or when the operation
   * could not be completed; then nothing may transition the instance, and the
   * decision stays `incomplete` until a later attempt succeeds.
   */
  async function readLive(
    instanceId: string,
    /** What the caller is about to do with it — recorded on its transitions. */
    source: TransitionSource = "engine",
  ): Promise<PipelineInstance | null> {
    const raw = await readInstance(instanceId);
    if (!raw) return null;
    const inst = persist.capture(raw, raw.pendingGateOperation ? "gate-recovery" : source);
    if (!inst.pendingGateOperation) return inst;
    const op = inst.pendingGateOperation;
    try {
      const done = await continueOperation(inst);
      void journal(inst.id, {
        at: nowISO(),
        kind: "gate.operation-completed",
        ...(op.phaseId ? { phaseId: op.phaseId } : {}),
        ...(op.attempt !== null ? { attempt: op.attempt } : {}),
        detail: `${op.decision} ${op.decisionId} completed after an interruption`,
      });
      const def = await defFor(done.instance);
      if (def && done.startPhases.length > 0) {
        queueReadyPhases(inst.id, def, done.instance, done.startPhases);
      }
      deps.onChange?.();
      const fresh = await readInstance(instanceId);
      return fresh ? persist.capture(fresh, source) : null;
    } catch (e) {
      log.error("an interrupted gate operation could not be completed; the instance is held", {
        instanceId,
        decisionId: op.decisionId,
        err: e,
      });
      return null;
    }
  }

  /** `readLive` for the gate actions, which say why rather than 404. */
  async function readForDecision(
    instanceId: string,
    source: TransitionSource = "operator",
  ): Promise<{ inst: PipelineInstance } | { refusal: ActionResult }> {
    const raw = await readInstance(instanceId);
    if (!raw) return { refusal: { ok: false, code: 404, error: "instance not found" } };
    const inst = await readLive(instanceId, source);
    if (!inst) {
      return {
        refusal: {
          ok: false,
          code: 409,
          error:
            "an earlier gate decision on this instance is incomplete and could not be completed; " +
            "nothing else can happen to it until it is",
        },
      };
    }
    return { inst };
  }

  function attemptMismatch(phase: PhaseProgress, attempt: number | undefined): ActionResult | null {
    if (attempt === undefined || attempt === phase.attempt) return null;
    return {
      ok: false,
      code: 409,
      error: `phase ${phase.id} is on attempt ${phase.attempt}, not attempt ${attempt}`,
    };
  }

  async function approve(
    instanceId: string,
    answers?: unknown,
    options: GateTarget = {},
  ): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const read = await readForDecision(instanceId);
      if ("refusal" in read) return read.refusal;
      const inst = read.inst;
      const def = await defFor(inst);
      if (!def) return { ok: false, code: 404, error: "pipeline not found" };
      const phase = pausedPhase(inst, options.phaseId);
      if (!phase || phase.status !== "awaiting-approval") {
        return { ok: false, code: 409, error: "instance is not awaiting approval" };
      }
      const stale = attemptMismatch(phase, options.attempt);
      if (stale) return stale;
      // A spawned child whose parent no longer waits for it (the parent ended,
      // decided its spawn phase, or started a fresh child for the task) is not
      // re-run or approved: its outcome would count for nothing. Abort is exempt.
      if (!options.byParent) {
        const decided = await childDecisionAllowed(inst);
        if (decided) return decided;
      }
      if (phase.pause === "children") {
        const refused = await childrenApproveRefusal(phase, answers);
        if (refused) return refused;
      }
      const source = options.source ?? UNSPECIFIED;
      const written = await writeDecision({
        instanceId: inst.id,
        pipelineId: inst.pipelineId,
        decision: "approve",
        mechanism: options.source ? "operator" : "unspecified",
        channel: source.channel,
        principal: source.principal,
        phases: [phaseRef(phase)],
        ...(answers !== undefined ? { answersProvided: true } : {}),
      });
      if ("refusal" in written) return written.refusal;
      await probe("approve:recorded", inst.id);
      const unlinked = await linkDecision(inst, written.record, {
        phaseId: phase.id,
        attempt: phase.attempt,
        stopRunIds: [],
        ...(answers !== undefined ? { answers } : {}),
      });
      if (unlinked) return unlinked;
      const done = await continueApproval(def, inst, inst.pendingGateOperation!);
      await startPhases(def, done.instance, done.startPhases);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  /**
   * What every automated gate decision checks first, under the instance lock
   * and before anything is recorded — extracted from `approveAutomatically`,
   * whose refusals it keeps word for word: the instance (any interrupted gate
   * operation completed first), its definition, the exact attempt waiting at a
   * known `gate` pause (never a spawn phase's `children` pause), a spawned
   * child's parent still waiting for it (`409 parent-decided` otherwise), the
   * rule declared on the phase's own snapshot, and a gate that commits no
   * knowledge by configuration or by what the attempt staged. A refusal
   * writes nothing.
   */
  async function readAutomatedTarget(
    target: { instanceId: string; phaseId: string; attempt: number },
    source: TransitionSource,
    rule: AutomatedRule,
  ): Promise<
    | { inst: PipelineInstance; def: PipelineDefinition; phase: PhaseProgress; phaseDef: PhaseDef }
    | { refusal: ActionResult }
  > {
    const refuse = (error: string, code = 409) => ({ refusal: { ok: false, code, error } });
    const read = await readForDecision(target.instanceId, source);
    if ("refusal" in read) return read;
    const inst = read.inst;
    const def = await defFor(inst);
    if (!def) return refuse("pipeline not found", 404);
    const phase = inst.phases.find((p) => p.id === target.phaseId);
    if (!phase || phase.status !== "awaiting-approval") {
      return refuse(`phase ${target.phaseId} is not awaiting approval`);
    }
    const stale = attemptMismatch(phase, target.attempt);
    if (stale) return { refusal: stale };
    // A question an agent put to a person (`needs-input`) paused the phase
    // before its result, checks and staging ran — and a pause recorded
    // before the cause was recorded cannot be told apart from one. Only a
    // known gate pause is a rule's to open.
    if (phase.pause !== "gate") {
      return refuse(
        phase.pause === "needs-input"
          ? `phase ${phase.id} is waiting on an answer to an agent's question, which needs a person`
          : phase.pause === "children"
            ? `phase ${phase.id} is waiting on its children: approving it drops the tasks that ` +
              "did not succeed, which needs a person"
            : `phase ${phase.id} paused before pause causes were recorded; it needs a person`,
      );
    }
    // A spawned child whose parent no longer waits for it is not decided by a
    // rule: its outcome would count for nothing.
    const decided = await childDecisionAllowed(inst);
    if (decided) return { refusal: decided };
    const phaseDef = def.phases.find((p) => p.id === phase.id);
    if (!phaseDef || !rule.declares(phaseDef)) return refuse(`phase ${phase.id} ${rule.missing}`);
    const reasons = [...knowledgeCommitReasons(phaseDef), ...stagedKnowledgeReasons(phase)];
    if (reasons.length > 0) {
      return refuse(
        `phase ${phase.id} commits knowledge (${reasons.join(", ")}); ` +
          "its gate needs a person, and automated approval is refused",
      );
    }
    return { inst, def, phase, phaseDef };
  }

  /**
   * The automated approval boundary.
   *
   * **What the request may say.** Only which verdict it proposes for each
   * run: `{ runId, verdictId }`. Any other field a caller puts on a basis
   * entry is ignored. A request that names a run twice, or names a run that is
   * not one of the attempt's relevant runs, is refused as inconsistent. What
   * is persisted about each verdict — score, timestamp, rubric digest,
   * runtime, requested and reported model, prompt version — is read from the
   * stored verdict; the bar and step identity from the instance and its own
   * definition snapshot. Metadata a stored verdict does not carry stays
   * `null`, never filled in.
   *
   * **The decision point.** Validation, the decision record and the instance
   * link (step 3) all happen while the verdict store's lock is held
   * (`withCurrentVerdicts`), the lock every verdict write takes. So every
   * verdict write is ordered against the approval's commit: one that lands
   * before it is part of what was validated (a newer failed, unscored or
   * lower-scoring current verdict refuses the approval); one that lands after
   * it cannot revoke an approval that is already durable. "Current" is the
   * store's order — the newest `at`, ties to the most recent write.
   */
  async function approveAutomatically(request: AutomatedApproval): Promise<ActionResult> {
    return locks.withLock(request.instanceId, async () => {
      const refuse = (error: string, code = 409): ActionResult => ({ ok: false, code, error });
      const target = await readAutomatedTarget(request, "verdict-watcher", AUTO_APPROVE_RULE);
      if ("refusal" in target) return target.refusal;
      const { inst, def, phase, phaseDef } = target;
      const bar = phaseDef.autoApprove?.verdict;
      const rubric = phaseDef.rubric;
      // Declared, by AUTO_APPROVE_RULE; narrowed here for the types.
      if (bar === undefined || !rubric) {
        return refuse(`phase ${phase.id} does not declare autoApprove with a rubric`);
      }
      const relevant = gateRelevantSteps(phase);
      const attemptRuns = relevant.map((s) => s.runId).filter((id): id is string => !!id);
      const everyStepRan =
        relevant.length > 0 && relevant.every((s) => !!s.runId && s.status === "succeeded");
      const sameRuns =
        attemptRuns.length === request.runIds.length &&
        attemptRuns.every((id) => request.runIds.includes(id));
      if (!everyStepRan || attemptRuns.length === 0 || !sameRuns) {
        return refuse(
          `the runs named are not exactly the succeeded runs of attempt ${phase.attempt}`,
        );
      }
      // The proposed basis: exactly one entry per relevant run, nothing else.
      const proposed = new Map<string, string | null>();
      for (const entry of request.verdicts) {
        if (!attemptRuns.includes(entry.runId)) {
          return refuse(`the basis names run ${entry.runId}, which this gate is not about`);
        }
        if (proposed.has(entry.runId)) {
          return refuse(`the basis names run ${entry.runId} more than once`);
        }
        proposed.set(entry.runId, entry.verdictId ?? null);
      }
      // The trajectory basis, validated the same way and kept apart: a phase
      // whose rubric declares a trajectory needs one current, usable
      // trajectory judgment per relevant run; any other phase takes none.
      const wantsTrajectory = hasTrajectory(rubric);
      const proposedTrajectory = new Map<string, string | null>();
      if (!wantsTrajectory && (request.trajectoryVerdicts?.length ?? 0) > 0) {
        return refuse(
          `the basis names trajectory judgments, but phase ${phase.id}'s rubric declares no trajectory`,
        );
      }
      for (const entry of request.trajectoryVerdicts ?? []) {
        if (!attemptRuns.includes(entry.runId)) {
          return refuse(
            `the trajectory basis names run ${entry.runId}, which this gate is not about`,
          );
        }
        if (proposedTrajectory.has(entry.runId)) {
          return refuse(`the trajectory basis names run ${entry.runId} more than once`);
        }
        proposedTrajectory.set(entry.runId, entry.verdictId ?? null);
      }
      const tBar = trajectoryBar(phaseDef);
      const digest = rubricDigest(rubric);

      return withCurrentVerdicts(async (currentList, trajectoryList) => {
        const current = new Map(currentList.map((v) => [v.runId, v]));
        const basis: GateDecisionVerdictBasis[] = [];
        for (const step of relevant) {
          const runId = step.runId as string;
          if (!proposed.has(runId))
            return refuse(`run ${runId} has no verdict in the approval request`);
          const stored = current.get(runId);
          if (!stored || stored.id == null || stored.id !== proposed.get(runId)) {
            return refuse(`the verdict named for run ${runId} is not that run's current verdict`);
          }
          if (stored.status !== "ready" || stored.score === null) {
            return refuse(`run ${runId}'s current verdict is ${stored.status}, not a score`);
          }
          if (stored.rubricDigest !== digest) {
            return refuse(`run ${runId} was not judged under this phase's rubric`);
          }
          if (stored.score < bar) {
            return refuse(`run ${runId} scored ${stored.score}, below the bar of ${bar}`);
          }
          // Built from the stored judgment and the instance's own policy —
          // never from what the request said about it.
          basis.push({
            runId,
            stepName: step.name,
            verdictId: stored.id,
            at: stored.at,
            score: stored.score,
            bar,
            runtime: stored.provenance?.runtime ?? null,
            requestedModel: stored.provenance?.requestedModel ?? null,
            reportedModel: stored.provenance?.reportedModel ?? null,
            promptVersion: stored.provenance?.promptVersion ?? null,
            rubricDigest: stored.rubricDigest ?? null,
          });
        }
        const trajectoryBasis: GateDecisionTrajectoryBasis[] = [];
        if (wantsTrajectory) {
          const currentTrajectory = new Map(trajectoryList.map((v) => [v.runId, v]));
          for (const step of relevant) {
            const runId = step.runId as string;
            if (!proposedTrajectory.has(runId)) {
              return refuse(`run ${runId} has no trajectory judgment in the approval request`);
            }
            const stored = currentTrajectory.get(runId);
            if (!stored || stored.id == null || stored.id !== proposedTrajectory.get(runId)) {
              return refuse(
                `the trajectory judgment named for run ${runId} is not that run's current one`,
              );
            }
            const got = trajectoryBasisEntry(stored, rubric, runId, step.name);
            if (!got.ok) {
              return refuse(
                `run ${runId}'s trajectory judgment cannot open a gate (${got.reason})`,
              );
            }
            if (got.entry.held.length > 0) {
              return refuse(`run ${runId}'s trajectory check held on ${got.entry.held.join(", ")}`);
            }
            if (tBar !== null && got.entry.score !== null && got.entry.score < tBar) {
              return refuse(
                `run ${runId}'s trajectory scored ${got.entry.score}, below the bar of ${tBar}`,
              );
            }
            // From the stored judgment and the instance's own policy, never
            // from the request.
            trajectoryBasis.push({ ...got.entry, bar: tBar });
          }
        }
        await probe("approve:validated", inst.id);
        const written = await writeDecision({
          instanceId: inst.id,
          pipelineId: inst.pipelineId,
          decision: "approve",
          mechanism: "verdict-auto-approve",
          channel: "verdict-watcher",
          principal: { kind: "system", component: "verdict-watcher" },
          phases: [phaseRef(phase)],
          verdicts: basis,
          ...(wantsTrajectory ? { trajectoryVerdicts: trajectoryBasis } : {}),
        });
        if ("refusal" in written) return written.refusal;
        await probe("approve:recorded", inst.id);
        // The commit point: once this save lands, the approval is durable and
        // its basis is fixed. Still inside the verdict store's lock.
        const unlinked = await linkDecision(inst, written.record, {
          phaseId: phase.id,
          attempt: phase.attempt,
          stopRunIds: [],
        });
        if (unlinked) return unlinked;
        return null;
      }).then(async (refused) => {
        if (refused) return refused;
        // Completing an approval that is already durable needs no verdict.
        const done = await continueApproval(def, inst, inst.pendingGateOperation!);
        await startPhases(def, done.instance, done.startPhases);
        deps.onChange?.();
        return { ok: true, code: 200 };
      });
    });
  }

  /**
   * The approval-condition boundary (DL-A3): the gate's `approveWhen` command
   * exited 0. The same write-ahead, link, completion and recovery as a
   * person's approval (a crash after the link is finished by `readLive` as any
   * approval is); the record says a rule opened the gate, and keeps what the
   * poll observed as its basis. Decided again here, under the lock, because
   * the poll ran outside it and a person may have decided since.
   */
  async function approveOnCondition(request: ConditionApproval): Promise<ActionResult> {
    return locks.withLock(request.instanceId, async () => {
      const target = await readAutomatedTarget(request, "approval-poll", APPROVE_WHEN_RULE);
      if ("refusal" in target) return target.refusal;
      const { inst, def, phase } = target;
      if (request.basis.exitCode !== 0) {
        return {
          ok: false,
          code: 409,
          error: `the condition exited ${request.basis.exitCode}, not 0`,
        };
      }
      await probe("approve:validated", inst.id);
      const written = await writeDecision({
        instanceId: inst.id,
        pipelineId: inst.pipelineId,
        decision: "approve",
        mechanism: "approval-condition",
        channel: "approval-poll",
        principal: { kind: "system", component: "approval-poll" },
        phases: [phaseRef(phase)],
        condition: request.basis,
      });
      if ("refusal" in written) return written.refusal;
      await probe("approve:recorded", inst.id);
      const unlinked = await linkDecision(inst, written.record, {
        phaseId: phase.id,
        attempt: phase.attempt,
        stopRunIds: [],
      });
      if (unlinked) return unlinked;
      const done = await continueApproval(def, inst, inst.pendingGateOperation!);
      await startPhases(def, done.instance, done.startPhases);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  /**
   * The gate's `approveWhen` command exited with its `failOnExit` code: the
   * phase fails under `approval-condition` (`applyConditionFailed`), never
   * retried; a person can revise it. Not a gate decision — there is no kind
   * for it, and an older build would finish an unknown kind as an approval —
   * so it is one ordinary transition save, refused on exactly the terms a
   * condition approval is.
   */
  async function failOnCondition(request: ConditionFailure): Promise<ActionResult> {
    return locks.withLock(request.instanceId, async () => {
      const target = await readAutomatedTarget(request, "approval-poll", APPROVE_WHEN_RULE);
      if ("refusal" in target) return target.refusal;
      const { inst, def, phase, phaseDef } = target;
      if (phaseDef.approveWhen?.failOnExit !== request.exitCode) {
        return {
          ok: false,
          code: 409,
          error: `exit ${request.exitCode} is not phase ${phase.id}'s failOnExit`,
        };
      }
      const res = T(
        applyConditionFailed(def, inst, phase.id, phase.attempt, request.reason, nowISO()),
      );
      const failed = res.instance.phases.find((p) => p.id === phase.id);
      if (failed?.status !== "failed") {
        return { ok: false, code: 409, error: `phase ${phase.id} is not awaiting approval` };
      }
      void journal(inst.id, {
        at: nowISO(),
        kind: "phase.failed",
        phaseId: phase.id,
        attempt: failed.attempt,
        detail: `approval-condition: ${request.reason}`,
      });
      noteRouting(def, res.instance, res.routing);
      await saveInstance(res.instance);
      if (res.instance.status === "succeeded" || res.instance.status === "failed") {
        void journal(inst.id, {
          at: nowISO(),
          kind: "instance.ended",
          detail: res.instance.status,
        });
      }
      queueReadyPhases(inst.id, def, res.instance, res.startPhases);
      if (res.instance.status === "failed") deps.onFailure?.(res.instance);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  async function revise(
    instanceId: string,
    note?: string,
    options: GateTarget = {},
  ): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const read = await readForDecision(instanceId);
      if ("refusal" in read) return read.refusal;
      const inst = read.inst;
      const def = await defFor(inst);
      if (!def) return { ok: false, code: 404, error: "pipeline not found" };
      // Validate BEFORE anything is recorded or destroyed: a refused 409 must
      // not have torn down live work.
      const target = pausedPhase(inst, options.phaseId);
      if (!target || (target.status !== "awaiting-approval" && target.status !== "failed")) {
        return { ok: false, code: 409, error: "instance is not paused" };
      }
      const stale = attemptMismatch(target, options.attempt);
      if (stale) return stale;
      // A spawned child whose parent no longer waits for it (the parent ended,
      // decided its spawn phase, or started a fresh child for the task) is not
      // re-run or approved: its outcome would count for nothing. Abort is exempt.
      if (!options.byParent) {
        const decided = await childDecisionAllowed(inst);
        if (decided) return decided;
      }
      const source = options.source ?? UNSPECIFIED;
      // Clipped once, here: the record and the pending operation carry the
      // same text, and so does every prompt that repeats it.
      const clipped = typeof note === "string" && note ? note.slice(0, REVISE_NOTE_MAX) : undefined;
      const written = await writeDecision({
        instanceId: inst.id,
        pipelineId: inst.pipelineId,
        decision: "revise",
        mechanism: decisionMechanism(options),
        channel: source.channel,
        principal: source.principal,
        phases: [phaseRef(target)],
        ...(clipped ? { note: clipped } : {}),
        ...(options.byParent?.decisionId ? { parentDecisionId: options.byParent.decisionId } : {}),
      });
      if ("refusal" in written) return written.refusal;
      await probe("revise:recorded", inst.id);
      const unlinked = await linkDecision(inst, written.record, {
        phaseId: target.id,
        attempt: target.attempt,
        // Only the revised phase's runs: a sibling branch that is
        // legitimately running is not part of this decision, and killing it
        // would be a silent abort.
        stopRunIds: stopTargets([target]),
        ...(clipped ? { note: clipped } : {}),
      });
      if (unlinked) return unlinked;
      const done = await continueRevise(inst, inst.pendingGateOperation!);
      await startPhases(def, done.instance, done.startPhases);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  async function abort(
    instanceId: string,
    options: {
      source?: OperatorSource;
      cause?: AbortCause;
      byParent?: { decisionId?: string };
    } = {},
  ): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const read = await readForDecision(instanceId);
      if ("refusal" in read) return read.refusal;
      const inst = read.inst;
      if (isTerminal(inst.status)) {
        return { ok: false, code: 409, error: "instance is already terminal" };
      }
      const source = options.source ?? UNSPECIFIED;
      const written = await writeDecision({
        instanceId: inst.id,
        pipelineId: inst.pipelineId,
        decision: "abort",
        mechanism: decisionMechanism(options),
        channel: source.channel,
        principal: source.principal,
        // Every phase the abort stops: the ones still running or waiting.
        phases: inst.phases
          .filter((p) => p.status === "running" || p.status === "awaiting-approval")
          .map(phaseRef),
        ...(options.byParent?.decisionId ? { parentDecisionId: options.byParent.decisionId } : {}),
      });
      if ("refusal" in written) return written.refusal;
      await probe("abort:recorded", inst.id);
      // Everything: an abort stops the whole instance.
      const unlinked = await linkDecision(inst, written.record, {
        phaseId: null,
        attempt: null,
        stopRunIds: stopTargets(inst.phases),
        ...(options.cause ? { cause: options.cause } : {}),
      });
      if (unlinked) return unlinked;
      await continueAbort(inst, inst.pendingGateOperation!);
      deps.onChange?.();
      return { ok: true, code: 200 };
    });
  }

  return {
    recordGateDecision,
    probe,
    phaseRef,
    UNSPECIFIED,
    writeDecision,
    linkDecision,
    stopTargets,
    continueRevise,
    continueAbort,
    continueApproval,
    continueOperation,
    readLive,
    readForDecision,
    attemptMismatch,
    approve,
    approveAutomatically,
    approveOnCondition,
    failOnCondition,
    revise,
    abort,
  };
}
