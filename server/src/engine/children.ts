import { probeInstance, readInstance, readInstances } from "../sources/instances.js";
import { decisionEffect, readGateDecisions } from "../sources/gateDecisions.js";
import { isSpendBlocked } from "../sources/budget.js";
import { journal, type JournalKind } from "../sources/journal.js";
import { resumable } from "../sources/instanceStatus.js";
import {
  buildPhaseChildren,
  childObservation,
  nextSpawns,
  parentDecision,
  spawnPayloadFor,
  type ChildObservation,
} from "../sources/children.js";
import {
  applyChildDeferred,
  applyChildRefused,
  applyChildrenObserved,
  applyChildrenPlan,
  applyChildrenStart,
  type PlannedChild,
  type TransitionResult,
} from "../pipelineTransitions.js";
import { decidedChildren } from "../transitionLog/effects.js";
import { log } from "../log.js";
import { PreflightError } from "./spawn.js";
import type {
  PhaseChildren,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
  SpawnTaskState,
} from "../sources/pipelineTypes.js";
import type { ActionResult, ChildEffectPoint, OperatorSource, StartOutcome } from "./types.js";
import type { EngineCore, EngineFns } from "./context.js";

/**
 * Spawn phases: one child instance per task, joined. The engine half of
 * `sources/children.ts`: building the task list, starting each child exactly
 * once by the id saved on the parent, mirroring children into the parent, the
 * join and the `children` pause, the spend-budget hold, revives, the abort
 * cascade, the sweep and the parent check. Lock order: a parent's lock is
 * never held while waiting for a child's lock or a pipeline's start lock;
 * everything that needs one is queued with `track()`, and children are read
 * from disk, never locked, from a parent-locked section. A child's lock is
 * never held while waiting for its parent's either: the parent is read, never
 * locked, from a child-locked section (HARNESS §20).
 */

/** Task states whose child is read on every sync: the live ones, and `failed`
 *  (a person may have re-run that child directly). */
const OBSERVED = new Set<SpawnTaskState>([
  "planned",
  "reviving",
  "running",
  "awaiting-approval",
  "failed",
]);

/** Every parent-driven action on a child is recorded under this principal. */
const SPAWN: OperatorSource = {
  channel: "in-process",
  principal: { kind: "system", component: "spawn" },
};

/** A spawn phase that can still move: running, or waiting at its `children` pause. */
function childrenLive(phase: PhaseProgress): boolean {
  return (
    phase.status === "running" ||
    (phase.status === "awaiting-approval" && phase.pause === "children")
  );
}

export function createChildren(core: EngineCore) {
  const { deps, locks, nowISO, track, T } = core.ctx;
  const abort: EngineFns["abort"] = (...args) => core.fns.abort(...args);
  const defFor: EngineFns["defFor"] = (...args) => core.fns.defFor(...args);
  const failPhaseConfiguration: EngineFns["failPhaseConfiguration"] = (...args) =>
    core.fns.failPhaseConfiguration(...args);
  const mergeRouting: EngineFns["mergeRouting"] = (...args) => core.fns.mergeRouting(...args);
  const noteRouting: EngineFns["noteRouting"] = (...args) => core.fns.noteRouting(...args);
  const queueReadyPhases: EngineFns["queueReadyPhases"] = (...args) =>
    core.fns.queueReadyPhases(...args);
  const readLive: EngineFns["readLive"] = (...args) => core.fns.readLive(...args);
  const revise: EngineFns["revise"] = (...args) => core.fns.revise(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const startInstance: EngineFns["startInstance"] = (...args) => core.fns.startInstance(...args);
  const withStartsHeld: EngineFns["withStartsHeld"] = (...args) => core.fns.withStartsHeld(...args);

  const probe = async (point: ChildEffectPoint, instanceId: string) =>
    deps.childEffectProbe?.(point, instanceId);
  /** Parents with a sync queued that has not begun. */
  const syncQueued = new Set<string>();
  /** Child ids whose start this process has in flight. */
  const startsQueued = new Set<string>();
  /** Child ids whose revive this process has in flight. */
  const revivesQueued = new Set<string>();
  /** `parent:phase` pairs journalled as held by the spend budget. */
  const held = new Set<string>();

  // ── The spawn phase, under its instance's lock ─────────────────────────────

  /** `startPhase`'s branch for a spawn phase. The caller holds the instance's lock. */
  async function startSpawnPhase(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
  ): Promise<void> {
    await syncSpawnPhase(def, inst, phaseId);
  }

  /**
   * One spawn phase's work, under its instance's lock (held by the caller):
   * build the task list once; mirror every child it names; conclude (the join,
   * the `children` pause, or resuming from it); plan what is ready unless the
   * spend budget holds it; commit all of it in one save (the commit point of
   * every id minted here); then queue, off the lock, the starts and revives
   * the saved state owes. `prior`: a transition the caller already applied to
   * `inst`, which this save must carry.
   */
  async function syncSpawnPhase(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    prior?: TransitionResult,
  ): Promise<void> {
    const spawn = def.phases.find((p) => p.id === phaseId)?.spawn;
    const phase = inst.phases.find((p) => p.id === phaseId);
    const results: TransitionResult[] = prior ? [prior] : [];
    let planned: PlannedChild[] = [];
    if (spawn && phase && resumable(inst.status)) {
      if (!phase.children && phase.status === "running") {
        const built = buildPhaseChildren(spawn, inst, phaseId);
        if (!built.ok) {
          // The definition and the source result disagree: not something
          // another attempt can fix. `configuration`, never retried.
          await failPhaseConfiguration(def, inst, phaseId, built.reason);
          return;
        }
        results.push(
          T(applyChildrenStart(def, inst, phaseId, phase.attempt, built.children, nowISO())),
        );
      }
      if (phase.children && childrenLive(phase)) {
        const observed = await observeChildren(inst.id, phase.children);
        results.push(
          T(applyChildrenObserved(def, inst, phaseId, phase.attempt, observed, nowISO())),
        );
        const plan = await planReady(inst, phase);
        if (plan) {
          results.push(plan.result);
          planned = plan.planned;
        }
      }
    }
    const events = results.flatMap((r) => r.events ?? []);
    if (events.length > 0) {
      const startPhases = [...new Set(results.flatMap((r) => r.startPhases))];
      const routing = results.reduce<TransitionResult["routing"]>(
        (acc, r) => mergeRouting(acc, r.routing),
        undefined,
      );
      noteRouting(def, inst, routing);
      await saveInstance(inst);
      if (planned.length > 0) await probe("spawn:planned", inst.id);
      journalSync(inst, phaseId, events, planned);
      queueReadyPhases(inst.id, def, inst, startPhases);
      if (inst.status === "failed") deps.onFailure?.(inst);
      deps.onChange?.();
    }
    if (phase) queueOwedWork(inst.id, phaseId, phase);
  }

  /** The journal of one saved sync, read off the events it committed. */
  function journalSync(
    inst: PipelineInstance,
    phaseId: string,
    events: NonNullable<TransitionResult["events"]>,
    planned: PlannedChild[],
  ): void {
    const at = nowISO();
    const phase = inst.phases.find((p) => p.id === phaseId);
    const about = { phaseId, ...(phase ? { attempt: phase.attempt } : {}) };
    const children = phase?.children;
    const has = (kind: string, detail?: string) =>
      events.some(
        (e) =>
          e.kind === kind && e.phaseId === phaseId && (detail === undefined || e.detail === detail),
      );
    if (children && has("children-started")) {
      const n = children.tasks.length;
      void journal(inst.id, {
        at,
        kind: "children.started",
        ...about,
        detail: `${n} task${n === 1 ? "" : "s"} of pipeline ${children.pipelineId}`,
      });
    }
    for (const p of planned) {
      const key = children?.tasks[p.index]?.key ?? `#${p.index + 1}`;
      void journal(inst.id, {
        at,
        kind: "child.planned",
        ...about,
        detail: `${key} → ${p.instanceId}`,
      });
    }
    if (children && has("phase-succeeded")) {
      const n = children.tasks.length;
      void journal(inst.id, {
        at,
        kind: "children.joined",
        ...about,
        detail: `${n} task${n === 1 ? "" : "s"} succeeded`,
      });
    }
    if (children && has("phase-paused", "children")) {
      const dropped = children.tasks.filter((t) => t.state !== "succeeded").map((t) => t.key);
      void journal(inst.id, {
        at,
        kind: "children.halted",
        ...about,
        detail: `waiting for a person: ${dropped.join(", ")} did not succeed`,
      });
    }
    if (inst.status === "succeeded" || inst.status === "failed") {
      void journal(inst.id, { at, kind: "instance.ended", detail: inst.status });
    }
  }

  /**
   * Mint one id per task that is ready now, unless the spend budget holds new
   * children. Applied under the parent's lock on the instance the caller read
   * there; the save that follows is the commit point of each id.
   */
  async function planReady(
    inst: PipelineInstance,
    phase: PhaseProgress,
  ): Promise<{ result: TransitionResult; planned: PlannedChild[] } | null> {
    if (phase.status !== "running" || !phase.children) return null;
    const ready = nextSpawns(phase.children);
    if (ready.length === 0) return null;
    if (await spendHeld(inst.id, phase.id)) return null;
    const minted = ready.map((index) => ({ index, instanceId: deps.newId() }));
    const result = T(applyChildrenPlan(inst, phase.id, phase.attempt, minted, nowISO()));
    // Only the entries the transition took: those are what the save commits.
    const tasks = phase.children.tasks;
    const planned = minted.filter((p) => tasks[p.index]?.instanceId === p.instanceId);
    return result.events?.length ? { result, planned } : null;
  }

  /**
   * Whether the spend budget holds new children now: the authority scheduled
   * firings obey (`isSpendBlocked`). A budget that cannot be read holds too,
   * and the next tick asks again. Journalled once when a hold begins and once
   * when it lifts, not on every tick in between.
   */
  async function spendHeld(parentId: string, phaseId: string): Promise<boolean> {
    let blocked: boolean;
    try {
      blocked = await isSpendBlocked(deps.now());
    } catch (e) {
      log.warn("the spend budget could not be read; new children wait", {
        instanceId: parentId,
        err: e,
      });
      blocked = true;
    }
    const key = `${parentId}:${phaseId}`;
    if (blocked && !held.has(key)) {
      held.add(key);
      void journal(parentId, {
        at: nowISO(),
        kind: "children.held",
        phaseId,
        detail: "the spend budget is exceeded; no new child starts until it allows them",
      });
    } else if (!blocked && held.delete(key)) {
      void journal(parentId, {
        at: nowISO(),
        kind: "children.released",
        phaseId,
        detail: "the spend budget allows new children again",
      });
    }
    return blocked;
  }

  /** Every child the task list names, as last saved: read from disk, never
   *  locked. Each one read is returned; the transition ignores what did not
   *  change. */
  async function observeChildren(
    parentId: string,
    children: PhaseChildren,
  ): Promise<ChildObservation[]> {
    const out: ChildObservation[] = [];
    for (const [index, task] of children.tasks.entries()) {
      if (!task.instanceId || !OBSERVED.has(task.state)) continue;
      const read = await probeInstance(task.instanceId);
      if (read.kind === "unreadable") continue; // a passing read error: no news
      const child = read.kind === "present" ? read.instance : null;
      if (child && child.parent?.instanceId !== parentId) continue; // not ours: never adopted
      const revised =
        task.state === "reviving" && child?.status === "failed"
          ? (await reviveLinked(child, task.reviveDecisionId)) === true
          : false;
      out.push(childObservation(index, task.instanceId, child, revised));
    }
    return out;
  }

  /** Whether this decision's revive of the child took effect: the child links
   *  a decision carrying `parentDecisionId`, and has finished applying it. A
   *  revise linked but still pending (`incomplete`) has re-run nothing yet:
   *  the child's `failed` is still the failure being revived. Null when the
   *  record cannot be read: the caller asks again next tick rather than
   *  guess. */
  async function reviveLinked(
    child: PipelineInstance,
    decisionId: string | undefined,
  ): Promise<boolean | null> {
    if (!decisionId || !child.gateDecisionIds?.length) return false;
    try {
      const records = await readGateDecisions(child.id);
      return records.some(
        (d) => d.parentDecisionId === decisionId && decisionEffect(d, child) === "applied",
      );
    } catch (e) {
      log.warn("a child's gate decisions could not be read; its revive is asked again", {
        instanceId: child.id,
        err: e,
      });
      return null;
    }
  }

  // ── Starts and revives, off the parent's lock ──────────────────────────────

  /** Queue, off the lock, every start and revive the saved state owes. */
  function queueOwedWork(parentId: string, phaseId: string, phase: PhaseProgress): void {
    if (phase.status !== "running") return;
    for (const [index, task] of (phase.children?.tasks ?? []).entries()) {
      if (!task.instanceId) continue;
      if (task.state === "planned") queueChildStart(parentId, phaseId, index, task.instanceId);
      if (task.state === "reviving" && task.reviveDecisionId) {
        queueChildRevive(parentId, phaseId, index, task.instanceId, task.reviveDecisionId);
      }
    }
  }

  function queueChildStart(parentId: string, phaseId: string, index: number, childId: string) {
    if (startsQueued.has(childId)) return;
    startsQueued.add(childId);
    void track(
      startChild(parentId, phaseId, index, childId)
        .catch((e: unknown) =>
          log.error("a child could not be started; reconcile asks again", {
            instanceId: parentId,
            childId,
            err: e,
          }),
        )
        .finally(() => startsQueued.delete(childId)),
    );
  }

  /** Start one planned child with the id its parent saved (§9.2). Every
   *  outcome is recorded on the parent: a child created or found is mirrored;
   *  a start put off stays `planned` and is tried again next tick; one refused
   *  for good fails the task. */
  async function startChild(
    parentId: string,
    phaseId: string,
    index: number,
    childId: string,
  ): Promise<void> {
    const parent = await readInstance(parentId);
    const def = parent ? await defFor(parent) : undefined;
    const spawn = def?.phases.find((p) => p.id === phaseId)?.spawn;
    const phase = parent?.phases.find((p) => p.id === phaseId);
    const task = phase?.children?.tasks[index];
    if (!parent || !spawn || !phase || task?.instanceId !== childId || task.state !== "planned") {
      return;
    }
    const attempt = phase.attempt;
    if (await spendHeld(parentId, phaseId)) {
      await deferTask(parentId, phaseId, attempt, index, childId, "the spend budget is exceeded");
      return;
    }
    const payload = spawnPayloadFor(spawn, parent, phaseId, index, task.key);
    if (!payload.ok) {
      await refuseTask(parentId, phaseId, attempt, index, childId, payload.reason);
      return;
    }
    await probe("spawn:starting", parentId);
    let out: StartOutcome;
    try {
      out = await startInstance(
        spawn.pipelineId,
        "spawned",
        {
          instanceId: childId,
          triggerPayload: payload.payload,
          parent: payload.payload.parent,
          ...(spawn.base ? { workspaceBase: spawn.base } : {}),
        },
        { stillWanted: () => childStillWanted(parentId, phaseId, index, childId) },
      );
    } catch (e) {
      // A failed preflight or an I/O error: nothing was created; try again.
      const reason =
        e instanceof PreflightError
          ? e.message
          : `the start failed: ${e instanceof Error ? e.message : String(e)}`;
      await deferTask(parentId, phaseId, attempt, index, childId, reason);
      return;
    }
    switch (out.kind) {
      case "started":
      case "existing":
        // An instance under this id that another parent (or none) started is
        // never adopted: the task fails, and a revise gives it a fresh id.
        if (out.instance.parent?.instanceId !== parentId) {
          await refuseTask(
            parentId,
            phaseId,
            attempt,
            index,
            childId,
            `instance ${childId} already exists and is not this task's child`,
          );
          return;
        }
        void journal(parentId, {
          at: nowISO(),
          kind: "child.started",
          phaseId,
          attempt,
          detail: `${task.key}: ${childId}${out.kind === "existing" ? " (already started)" : ""}`,
        });
        await probe("spawn:started", parentId);
        queueParentSync(parentId);
        return;
      case "busy":
        await deferTask(
          parentId,
          phaseId,
          attempt,
          index,
          childId,
          `pipeline ${spawn.pipelineId} allows one instance at a time (overlapPolicy skip) ` +
            "and one is live",
        );
        return;
      case "unreadable":
        await deferTask(
          parentId,
          phaseId,
          attempt,
          index,
          childId,
          `instance ${childId} exists but cannot be read (${out.reason}); it is never overwritten`,
        );
        return;
      case "no-pipeline":
        await refuseTask(
          parentId,
          phaseId,
          attempt,
          index,
          childId,
          `pipeline ${spawn.pipelineId} does not exist`,
        );
        return;
      case "not-wanted":
        return; // the parent decided while this start waited
    }
  }

  /** Asked by `startInstance` under the child pipeline's start lock: does the
   *  parent still wait for this id? */
  async function childStillWanted(
    parentId: string,
    phaseId: string,
    index: number,
    childId: string,
  ): Promise<boolean> {
    const parent = await readInstance(parentId);
    const phase = parent?.phases.find((p) => p.id === phaseId);
    const task = phase?.children?.tasks[index];
    return (
      !!parent &&
      resumable(parent.status) &&
      phase?.status === "running" &&
      task?.instanceId === childId &&
      task.state === "planned"
    );
  }

  /** Say on the parent why a planned start or an owed revive waits,
   *  journalled as `kind`. Takes the parent's lock; nothing else is held. The
   *  same reason again saves and journals nothing. */
  async function deferTask(
    parentId: string,
    phaseId: string,
    attempt: number,
    index: number,
    childId: string,
    reason: string,
    kind: JournalKind = "child.deferred",
  ): Promise<void> {
    await locks.withLock(parentId, async () => {
      const inst = await readLive(parentId, "spawn");
      if (!inst) return;
      const res = T(applyChildDeferred(inst, phaseId, attempt, index, childId, reason, nowISO()));
      if (!res.events?.length) return;
      await saveInstance(inst);
      void journal(parentId, {
        at: nowISO(),
        kind,
        phaseId,
        attempt,
        detail: res.events[0].detail ?? reason,
      });
      deps.onChange?.();
    });
  }

  /** Fail a planned or reviving task for good, without a child. Takes the
   *  parent's lock; nothing else is held. */
  async function refuseTask(
    parentId: string,
    phaseId: string,
    attempt: number,
    index: number,
    childId: string,
    reason: string,
  ): Promise<void> {
    await locks.withLock(parentId, async () => {
      const inst = await readLive(parentId, "spawn");
      const def = inst ? await defFor(inst) : undefined;
      if (!inst || !def) return;
      const res = T(
        applyChildRefused(def, inst, phaseId, attempt, index, childId, reason, nowISO()),
      );
      if (!res.events?.length) return;
      void journal(parentId, {
        at: nowISO(),
        kind: "child.refused",
        phaseId,
        attempt,
        detail: res.events[0].detail ?? reason,
      });
      // The refusal may already have paused the phase; the sync saves it,
      // mirrors anything else and queues what is owed, in the same save.
      await syncSpawnPhase(def, inst, phaseId, res);
    });
  }

  function queueChildRevive(
    parentId: string,
    phaseId: string,
    index: number,
    childId: string,
    decisionId: string,
  ): void {
    if (revivesQueued.has(childId)) return;
    revivesQueued.add(childId);
    void track(
      reviveChild(parentId, phaseId, index, childId, decisionId)
        .catch((e: unknown) =>
          log.error("a child could not be revived; reconcile asks again", {
            instanceId: parentId,
            childId,
            err: e,
          }),
        )
        .finally(() => revivesQueued.delete(childId)),
    );
  }

  /**
   * Revive one failed child in place, for the parent's revise of its spawn
   * phase: a revise of the child recorded with mechanism `parent-decision`,
   * the parent's decision id and the parent's note, which the child's next
   * attempt reads like any revise note. Idempotent: whether this revive
   * happened is asked of the child alone (`reviveLinked`), so one interrupted
   * anywhere is carried out exactly once. No lock is held on entry; the
   * revise takes the child's, and the mirror the parent's, one after the
   * other. A revive is never held by the spend budget: it is a person's
   * decision, which Argus never budget-checks.
   */
  async function reviveChild(
    parentId: string,
    phaseId: string,
    index: number,
    childId: string,
    decisionId: string,
  ): Promise<void> {
    const parent = await readInstance(parentId);
    const phase = parent?.phases.find((p) => p.id === phaseId);
    const task = phase?.children?.tasks[index];
    if (
      !parent ||
      !phase ||
      !resumable(parent.status) ||
      task?.instanceId !== childId ||
      task.state !== "reviving" ||
      task.reviveDecisionId !== decisionId
    ) {
      return;
    }
    const attempt = phase.attempt;
    const found = await probeInstance(childId);
    if (found.kind === "unreadable") {
      await deferTask(
        parentId,
        phaseId,
        attempt,
        index,
        childId,
        `child ${childId} cannot be read (${found.reason})`,
      );
      return;
    }
    if (found.kind === "absent") {
      await refuseTask(
        parentId,
        phaseId,
        attempt,
        index,
        childId,
        `child instance ${childId} is gone; revise the spawn phase again to start a fresh one`,
      );
      return;
    }
    const child = found.instance;
    // A decision on the child is under way, or was interrupted (this revive's
    // own, linked but not applied, for one): neither a second revise nor a
    // sync now. Its completing save syncs the parent, and reconcile completes
    // an interrupted one first; a sync here would only queue this revive again.
    if (child.pendingGateOperation) return;
    if (child.status === "failed") {
      const linked = await reviveLinked(child, decisionId);
      if (linked === null) return; // asked again next tick
      if (!linked) {
        const note = (await readGateDecisions(parentId)).find((d) => d.id === decisionId)?.note;
        await probe("spawn:reviving", parentId);
        const res = await revise(childId, note, { source: SPAWN, byParent: { decisionId } });
        if (!res.ok) {
          // Said on the task, once per reason; reconcile asks again.
          await deferTask(
            parentId,
            phaseId,
            attempt,
            index,
            childId,
            `the child refused the revise (${res.error ?? res.code})`,
            "child.revive-refused",
          );
          return;
        }
        void journal(parentId, {
          at: nowISO(),
          kind: "child.revived",
          phaseId,
          attempt,
          detail: `${task.key}: ${childId}`,
        });
      }
    }
    // Revived now, revived before, or no longer failed (a person re-ran or
    // aborted it meanwhile): the mirror decides what that means for the task.
    queueParentSync(parentId);
  }

  // ── The mirror ─────────────────────────────────────────────────────────────

  /**
   * A child was saved: its parent mirrors it. Called with the child's lock
   * held (`saveInstance`), so it only queues; the sync takes the parent's lock
   * off every child's. One queued sync per parent at a time: a save while it
   * waits is covered by it, a save while it runs queues one more.
   */
  function queueParentSync(parentId: string): void {
    if (syncQueued.has(parentId)) return;
    syncQueued.add(parentId);
    void track(
      locks
        .withLock(parentId, async () => {
          syncQueued.delete(parentId);
          const inst = await readLive(parentId, "spawn");
          const def = inst ? await defFor(inst) : undefined;
          if (!inst || !def) return;
          for (const phaseDef of def.phases) {
            if (phaseDef.spawn) await syncSpawnPhase(def, inst, phaseDef.id);
          }
        })
        .catch((e: unknown) =>
          log.error("a parent could not mirror its children; reconcile asks again", {
            instanceId: parentId,
            err: e,
          }),
        ),
    );
  }

  /** Every live parent's spawn phases, under its lock: a list a crash left
   *  unbuilt, every child mirrored (one that ended while Argus was down joins
   *  here), the next tasks planned, and the starts and revives owed queued.
   *  Not gated on `appliesResults`: an observation is what ends a `children`
   *  pause. */
  async function reconcileChildren(): Promise<void> {
    for (const candidate of await readInstances()) {
      if (!resumable(candidate.status)) continue;
      const def = await defFor(candidate);
      const spawnIds = new Set(def?.phases.filter((p) => p.spawn).map((p) => p.id));
      if (!def || !candidate.phases.some((p) => spawnIds.has(p.id) && childrenLive(p))) continue;
      try {
        await locks.withLock(candidate.id, async () => {
          const inst = await readLive(candidate.id, "reconcile");
          if (!inst) return;
          for (const phaseDef of def.phases) {
            if (phaseDef.spawn) await syncSpawnPhase(def, inst, phaseDef.id);
          }
        });
      } catch (e) {
        // One parent's trouble must not stop the pass for the others.
        log.error("a spawn phase could not be reconciled", { instanceId: candidate.id, err: e });
      }
    }
  }

  // ── Decisions on a child, and the parent's end ─────────────────────────────

  /**
   * `409 parent-decided` for a decision on a spawned child whose parent no
   * longer waits for it, or null. A parent record that is gone allows it; one
   * that cannot be read refuses without a code (try again). The parent is
   * read, never locked: the caller holds the child's lock.
   */
  async function childDecisionAllowed(child: PipelineInstance): Promise<ActionResult | null> {
    if (!child.parent) return null;
    const read = await probeInstance(child.parent.instanceId);
    if (read.kind === "absent") return null;
    if (read.kind === "unreadable") {
      return {
        ok: false,
        code: 409,
        error:
          `the parent instance ${child.parent.instanceId} could not be read (${read.reason}); ` +
          "nothing changed, try again",
      };
    }
    const why = parentDecision(child, read.instance);
    return why
      ? {
          ok: false,
          code: 409,
          errorCode: "parent-decided",
          error: `${child.id} is a spawned child and ${why}; abort it, or start a follow-up instead`,
        }
      : null;
  }

  /**
   * Approving a spawn phase at its `children` pause accepts the tasks that
   * succeeded. Refused with answers (its payload is the children summary,
   * which `produces` publishes), and while a child a person re-ran is live
   * again (its sync is queued behind the parent's lock, which the caller
   * holds) or its revise is still being applied (it reads `failed` until the
   * revise's last save). Every child is read, never locked.
   */
  async function childrenApproveRefusal(
    phase: PhaseProgress,
    answers: unknown,
  ): Promise<ActionResult | null> {
    if (answers !== undefined) {
      return {
        ok: false,
        code: 400,
        errorCode: "answers-not-accepted",
        error:
          "a spawn phase paused at children takes no answers: approve accepts the tasks that " +
          "succeeded, revise re-runs the rest",
      };
    }
    for (const task of phase.children?.tasks ?? []) {
      if (task.state !== "failed" || !task.instanceId) continue;
      const read = await probeInstance(task.instanceId);
      if (
        read.kind === "present" &&
        (resumable(read.instance.status) ||
          read.instance.pendingGateOperation?.decision === "revise")
      ) {
        return {
          ok: false,
          code: 409,
          errorCode: "children-running",
          error:
            `task "${task.key}" is running again in ${task.instanceId}; ` +
            "wait for it, or abort it, then decide",
        };
      }
    }
    return null;
  }

  /** Queued by `continueAbort` after the aborted parent is saved (its lock is
   *  held there). Reconcile's sweep finishes anything this misses. */
  function queueAbortCascade(parentId: string, decisionId: string): void {
    void track(
      abortChildren(parentId, decisionId).catch((e: unknown) =>
        log.error("a parent's children could not all be aborted; reconcile's sweep finishes it", {
          instanceId: parentId,
          err: e,
        }),
      ),
    );
  }

  /** Abort every child an aborted parent's spawn phases name, recorded as
   *  carrying out the parent's abort (`decisionId`). */
  async function abortChildren(parentId: string, decisionId: string): Promise<void> {
    const first = await readInstance(parentId);
    const pipelines = new Set(
      (first?.phases ?? []).flatMap((p) => (p.children ? [p.children.pipelineId] : [])),
    );
    for (const pipelineId of pipelines) {
      // Under the child pipeline's start lock, re-reading the parent there: a
      // start already past its parent check has finished (and is aborted
      // below); one still to come re-reads the parent and starts nothing.
      await withStartsHeld(pipelineId, async () => {
        const parent = await readInstance(parentId);
        if (!parent || resumable(parent.status)) return;
        for (const phase of parent.phases) {
          if (phase.children?.pipelineId !== pipelineId) continue;
          for (const task of phase.children.tasks) {
            if (!task.instanceId) continue;
            await probe("spawn:cascade", parentId);
            // Unconditional: abort refuses an ended child (409) by itself, and
            // a read here could miss a revive landing just after it.
            const res = await abort(task.instanceId, {
              source: SPAWN,
              cause: "parent-aborted",
              byParent: { decisionId },
            });
            if (res.ok) {
              void journal(parentId, {
                at: nowISO(),
                kind: "child.aborted",
                phaseId: phase.id,
                attempt: phase.attempt,
                detail: `${task.key}: ${task.instanceId}`,
              });
            }
          }
        }
      });
    }
  }

  /**
   * Reconcile's sweep: a live child its parent no longer waits for (the
   * parent ended before the cascade reached it, decided its spawn phase, or
   * replaced the child) is aborted (`parent-aborted`). A parent Argus cannot
   * read decides nothing; a parent whose record is gone leaves the child to
   * run on its own. No lock is held on entry; each abort takes the child's.
   */
  async function sweepStrayChildren(): Promise<void> {
    for (const child of await readInstances()) {
      if (!child.parent || !resumable(child.status)) continue;
      const link = child.parent;
      try {
        const parent = await probeInstance(link.instanceId);
        if (parent.kind !== "present") continue;
        if (!decidedChildren(parent.instance).includes(child.id)) continue;
        // `byParent` without a decision: the sweep acts on the parent's state,
        // not on one decision of it.
        const res = await abort(child.id, {
          source: SPAWN,
          cause: "parent-aborted",
          byParent: {},
        });
        if (res.ok) {
          void journal(link.instanceId, {
            at: nowISO(),
            kind: "child.aborted",
            phaseId: link.phaseId,
            detail: `${link.key}: ${child.id} (no longer waited for)`,
          });
        }
      } catch (e) {
        // One child's trouble must not stop the pass for the others.
        log.error("a child its parent no longer waits for could not be aborted", {
          instanceId: child.id,
          err: e,
        });
      }
    }
  }

  return {
    startSpawnPhase,
    queueParentSync,
    queueAbortCascade,
    childDecisionAllowed,
    childrenApproveRefusal,
    reconcileChildren,
    sweepStrayChildren,
  };
}
