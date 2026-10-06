import { readInstances } from "../sources/instances.js";
import {
  advance,
  applyRetry,
  applyUnlaunchable,
  retryDelayMs,
  shouldRetry,
  classifyFailure,
  scheduleRetry,
} from "../pipelineTransitions.js";
import { journal } from "../sources/journal.js";
import type {
  PhaseFailureClass,
  RetryableClass,
  StepCompletion,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import type { RouteOutcome, TransitionResult } from "../pipelineTransitions.js";
import { log } from "../log.js";
import { buildRetryNote } from "./outcome.js";
import type { EngineCore, EngineFns } from "./context.js";

/** Failing a phase or a step, classing the failure, scheduling retries, and journalling what routing decided. Moved verbatim from `createEngine`. */
export function createFailure(core: EngineCore) {
  const { deps, locks, nowISO, T } = core.ctx;
  const defFor: EngineFns["defFor"] = (...args) => core.fns.defFor(...args);
  const queueReadyPhases: EngineFns["queueReadyPhases"] = (...args) =>
    core.fns.queueReadyPhases(...args);
  const readLive: EngineFns["readLive"] = (...args) => core.fns.readLive(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const startPhases: EngineFns["startPhases"] = (...args) => core.fns.startPhases(...args);

  async function failUnlaunchable(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
  ): Promise<void> {
    log.warn("phase cannot be launched: not in the pipeline definition", {
      instanceId: inst.id,
      pipelineId: def.id,
      phaseId,
    });
    await failPhaseConfiguration(
      def,
      inst,
      phaseId,
      `phase "${phaseId}" no longer exists in pipeline "${def.name}"`,
    );
  }

  /**
   * A phase that cannot be launched at all: nothing was spawned for this
   * attempt, so there is nothing to kill. The phase fails under
   * `configuration` — never retried, because what is wrong is the definition,
   * not the weather — the instance settles, and whatever that makes ready is
   * queued exactly as after any other failure.
   */
  async function failPhaseConfiguration(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    reason: string,
  ): Promise<void> {
    const res = T(applyUnlaunchable(def, inst, phaseId, reason, nowISO()));
    const phase = res.instance.phases.find((p) => p.id === phaseId);
    if (phase?.status === "failed") {
      void journal(inst.id, {
        at: nowISO(),
        kind: "phase.failed",
        phaseId,
        attempt: phase.attempt,
        detail: `configuration: ${reason}`,
      });
    }
    noteRouting(def, res.instance, res.routing);
    await saveInstance(res.instance);
    if (res.instance.status === "succeeded" || res.instance.status === "failed") {
      void journal(inst.id, { at: nowISO(), kind: "instance.ended", detail: res.instance.status });
    }
    queueReadyPhases(inst.id, def, res.instance, res.startPhases);
    if (res.instance.status === "failed") deps.onFailure?.(res.instance);
    deps.onChange?.();
  }

  /**
   * Fail one step of a running phase from inside a transition that already
   * holds the instance (in memory, under the lock): the failure signal, its
   * class, the retry decision and the journal entries, in one place.
   */
  function failStepInPlace(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    runId: string,
    failureClass: PhaseFailureClass,
    reason: string,
    extra: Record<string, unknown> = {},
    /** The run's completion record, when the failure is a refused completion. */
    completion?: StepCompletion,
  ): TransitionResult {
    const res = T(
      advance(
        def,
        inst,
        {
          instanceId: inst.id,
          phaseId,
          runId,
          type: "failed",
          token: inst.signalToken,
          payload: { reason, ...extra },
        },
        nowISO(),
        failureClass,
        completion,
      ),
    );
    const phase = res.instance.phases.find((p) => p.id === phaseId);
    if (phase?.status === "failed") {
      T(classifyFailure(res.instance, phaseId, failureClass));
      if (failureClass !== "configuration") {
        noteFailure(def, res.instance, phaseId, failureClass, reason);
      } else {
        void journal(inst.id, {
          at: nowISO(),
          kind: "phase.failed",
          phaseId,
          attempt: phase.attempt,
          detail: `configuration: ${reason}`,
        });
      }
    }
    noteRouting(def, res.instance, res.routing);
    void journal(inst.id, {
      at: nowISO(),
      kind: "phase.signalled",
      phaseId,
      runId,
      detail: `harness: ${failureClass}`,
    });
    if (res.instance.status === "succeeded" || res.instance.status === "failed") {
      void journal(inst.id, { at: nowISO(), kind: "instance.ended", detail: res.instance.status });
    }
    return res;
  }

  /**
   * Note the failure in the journal and, if the phase's policy allows it,
   * schedule another attempt.
   *
   * The retry is *scheduled* (a timestamp on the phase, persisted) rather than
   * awaited with a timer. A `setTimeout` would lose the retry on restart and
   * would hold the instance lock across the backoff; a stored `retryAt` that
   * the reconcile tick picks up survives a crash and costs nothing while it
   * waits. The trade is that backoff resolution is one scheduler tick, which
   * for a policy measured in seconds-to-minutes is not a trade at all.
   */
  function noteFailure(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
    failure: RetryableClass,
    reason: string,
  ): boolean {
    const phase = inst.phases.find((p) => p.id === phaseId);
    if (!phase || phase.status !== "failed") return false;
    T(classifyFailure(inst, phaseId, failure));
    void journal(inst.id, {
      at: nowISO(),
      kind: "phase.failed",
      phaseId,
      attempt: phase.attempt,
      detail: `${failure}: ${reason}`,
    });

    const policy = def.phases.find((p) => p.id === phaseId)?.retry;
    if (!shouldRetry(policy, phase.retries ?? 0, failure)) return false;

    const at = new Date(deps.now().getTime() + retryDelayMs(policy!, phase.retries ?? 0));
    // The instance is no longer terminal: something is still going to happen.
    T(scheduleRetry(inst, phaseId, at.toISOString()));
    void journal(inst.id, {
      at: nowISO(),
      kind: "phase.retry-scheduled",
      phaseId,
      attempt: phase.attempt,
      detail: `attempt ${(phase.retries ?? 0) + 2} of ${policy!.attempts} at ${phase.retryAt}`,
    });
    return true;
  }

  /**
   * Journal what a transition did to the graph's routes, and put any route or
   * result failure through the same policy an ordinary failure gets.
   *
   * Returns true when a retry was scheduled, so the caller re-persists the
   * instance. Nothing here decides anything: settle already did, and this only
   * writes down what it decided.
   */
  function noteRouting(
    def: PipelineDefinition,
    inst: PipelineInstance,
    routing: RouteOutcome | undefined,
  ): boolean {
    if (!routing) return false;
    for (const decision of routing.decisions) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "route.selection",
        phaseId: decision.sourcePhase,
        detail: `${decision.artifact} ${JSON.stringify(decision.value)} → ${decision.reason}`,
      });
    }
    for (const phaseId of routing.skipped) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "route.skip",
        phaseId,
        detail: "not selected by an upstream route",
      });
    }
    let rescheduled = false;
    for (const failure of routing.failures) {
      void journal(inst.id, {
        at: nowISO(),
        kind: "route.failure",
        phaseId: failure.phaseId,
        detail: failure.reason,
      });
      // A result that never arrived, or arrived unusable, is an operational
      // signal failure: the agent reported, and what it reported cannot be
      // routed on. It gets the phase's own retry policy, never a branch.
      if (noteFailure(def, inst, failure.phaseId, "signal", failure.reason)) rescheduled = true;
    }
    return rescheduled;
  }

  /** Start every retry whose backoff has elapsed. Called from reconcile. */
  async function runDueRetries(now: Date): Promise<void> {
    for (const candidate of await readInstances()) {
      if (candidate.status !== "running" && candidate.status !== "failed") continue;
      if (!candidate.phases.some((p) => p.retryAt)) continue;
      const def = await defFor(candidate);
      if (!def) continue;
      await locks.withLock(candidate.id, async () => {
        const inst = await readLive(candidate.id, "retry");
        if (!inst) return;
        const due = inst.phases.filter(
          (p) => p.status === "failed" && p.retryAt && Date.parse(p.retryAt) <= now.getTime(),
        );
        for (const phase of due) {
          const note = await buildRetryNote(def, phase);
          const res = T(applyRetry(inst, phase.id, nowISO()));
          if (res.startPhases.length === 0) continue;
          await saveInstance(res.instance);
          void journal(inst.id, {
            at: nowISO(),
            kind: "phase.retrying",
            phaseId: phase.id,
            attempt: phase.attempt,
          });
          await startPhases(def, res.instance, res.startPhases, note);
          deps.onChange?.();
        }
      });
    }
  }

  function mergeRouting(a?: RouteOutcome, b?: RouteOutcome): RouteOutcome | undefined {
    if (!a) return b;
    if (!b) return a;
    return {
      decisions: [...a.decisions, ...b.decisions],
      skipped: [...a.skipped, ...b.skipped],
      failures: [...a.failures, ...b.failures],
    };
  }

  return {
    failUnlaunchable,
    failPhaseConfiguration,
    failStepInPlace,
    noteFailure,
    noteRouting,
    runDueRetries,
    mergeRouting,
  };
}
