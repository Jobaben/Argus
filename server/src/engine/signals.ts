import { patchRun, readRun } from "../sources/runs.js";
import { safeEqual, verifySignalToken } from "../harness/signalToken.js";
import {
  completionMessageOf,
  decideCompletion,
  resolveCompletionPolicy,
} from "../harness/completion.js";
import { advance } from "../pipelineTransitions.js";
import { journal } from "../sources/journal.js";
import type { Run } from "../sources/scheduleTypes.js";
import type { PipelineInstance, PipelineSignal } from "../sources/pipelineTypes.js";
import { log } from "../log.js";
import type { ActionResult } from "./types.js";
import type { EngineCore, EngineFns } from "./context.js";

/** Authenticating and applying an agent's signal. Moved verbatim from `createEngine`. */
export function createSignals(core: EngineCore) {
  const { deps, locks, nowISO, T } = core.ctx;
  const acceptCompletion: EngineFns["acceptCompletion"] = (...args) =>
    core.fns.acceptCompletion(...args);
  const defFor: EngineFns["defFor"] = (...args) => core.fns.defFor(...args);
  const failStepInPlace: EngineFns["failStepInPlace"] = (...args) =>
    core.fns.failStepInPlace(...args);
  const liveStep: EngineFns["liveStep"] = (...args) => core.fns.liveStep(...args);
  const noteFailure: EngineFns["noteFailure"] = (...args) => core.fns.noteFailure(...args);
  const noteRouting: EngineFns["noteRouting"] = (...args) => core.fns.noteRouting(...args);
  const queueCandidateVerification: EngineFns["queueCandidateVerification"] = (...args) =>
    core.fns.queueCandidateVerification(...args);
  const queueReadyPhases: EngineFns["queueReadyPhases"] = (...args) =>
    core.fns.queueReadyPhases(...args);
  const queueVerifications: EngineFns["queueVerifications"] = (...args) =>
    core.fns.queueVerifications(...args);
  const readLive: EngineFns["readLive"] = (...args) => core.fns.readLive(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const settleCandidates: EngineFns["settleCandidates"] = (...args) =>
    core.fns.settleCandidates(...args);
  const settleKnowledge: EngineFns["settleKnowledge"] = (...args) =>
    core.fns.settleKnowledge(...args);
  const settleRealizations: EngineFns["settleRealizations"] = (...args) =>
    core.fns.settleRealizations(...args);

  /**
   * Does this signal's token authenticate it for the run it names?
   *
   * - A run of the current attempt: against its step's own record. A step
   *   recorded without one — a run launched before per-run tokens, on an
   *   instance that predates them — accepts the instance's legacy token, so a
   *   run that was already going when Argus was upgraded can still finish.
   * - Any other run (a stale attempt's, a superseded candidate's): against its
   *   run record's own binding, so a genuine late signal is told apart from a
   *   forgery even after its step is gone. It is never acted on either way.
   *
   * Runs a runtime without a hook were given no credential (`none`): nothing
   * authenticates for them. The engine's own synthesized completions
   * (run-record recovery, deadlines, refusals) never come through here.
   */
  async function authenticateSignal(
    inst: PipelineInstance,
    signal: PipelineSignal,
  ): Promise<boolean> {
    const legacyOk = () =>
      inst.signalScheme === undefined &&
      typeof signal.token === "string" &&
      safeEqual(signal.token, inst.signalToken);
    const phase = inst.phases.find((p) => p.id === signal.phaseId);
    const step = phase?.steps.find((s) => !!s.runId && s.runId === signal.runId);
    if (step) {
      if (!step.signalAuth) return legacyOk();
      return verifySignalToken(step.signalAuth, inst.id, signal.runId, signal.token);
    }
    const got = signal.runId ? await readRun(signal.runId).catch(() => null) : null;
    const run = got?.run;
    if (run?.signalAuth && run.instanceId === inst.id) {
      return verifySignalToken(run.signalAuth, inst.id, signal.runId, signal.token);
    }
    return legacyOk();
  }

  async function onSignal(instanceId: string, signal: PipelineSignal): Promise<ActionResult> {
    return locks.withLock(instanceId, async () => {
      const inst = await readLive(instanceId, "signal");
      if (!inst) return { ok: false, code: 404 };
      if (!(await authenticateSignal(inst, signal))) return { ok: false, code: 403 };
      if (inst.status !== "running") return { ok: true, code: 200 }; // paused/terminal → idempotent ignore
      const def = await defFor(inst);
      if (!def) return { ok: false, code: 404 };
      const live = liveStep(inst, signal.phaseId, signal.runId);
      // The agent's own report first (docs/HARNESS.md §2): Argus classifies
      // the final message it was actually handed — never the caller's
      // account of it — under the phase's completion policy, read from the
      // instance's own definition snapshot. A completion refused here fails
      // the step before a single file the run wrote is read, so nothing it
      // proposed is ever staged. A marker is still the agent's word: an
      // accepted one decides only that the step may go on to the checks, the
      // result, the gate and the commit, which decide everything else.
      const completion =
        live && (signal.type === "completed" || signal.type === "failed")
          ? decideCompletion({
              signal: signal.type,
              source: "signal",
              policy: resolveCompletionPolicy(
                def,
                def.phases.find((p) => p.id === signal.phaseId),
              ),
              message: completionMessageOf(signal.payload),
              hookMeta: signal.completion,
              at: nowISO(),
            })
          : null;
      const refused =
        signal.type === "completed" && completion && !completion.accept ? completion : null;
      // A completion is accepted only once Argus has re-verified the semantic
      // context it supplied (Phase 4.1) and read, validated and staged any
      // KnowledgeDelta the run wrote — both *before* the transition, so a
      // refusal fails the step under its own class instead of the step
      // succeeding with the proposal silently dropped, and a staged delta is
      // on the step by the time the transition decides whether the phase may
      // conclude.
      const intake =
        signal.type === "completed" && live && !refused
          ? await acceptCompletion(def, inst, signal.phaseId, signal.runId)
          : null;
      let res =
        refused && !refused.accept
          ? failStepInPlace(
              def,
              inst,
              signal.phaseId,
              signal.runId,
              refused.failureClass ?? "unverified",
              refused.reason,
              {},
              refused.record,
            )
          : intake && !intake.ok
            ? failStepInPlace(
                def,
                inst,
                signal.phaseId,
                signal.runId,
                intake.failure,
                intake.reason,
                {},
                completion
                  ? { ...completion.record, verdict: "refused", reason: intake.reason }
                  : undefined,
              )
            : T(advance(def, inst, signal, nowISO(), undefined, completion?.record));
      const outcome: Run["outcome"] | undefined =
        refused || (intake && !intake.ok)
          ? "failed"
          : signal.type === "failed"
            ? "failed"
            : signal.type === "completed"
              ? "succeeded"
              : undefined;
      if (res.ignored) {
        // The instance is untouched; say so where someone debugging will look,
        // instead of journalling the signal as if it had landed. The run did
        // report, so its own record keeps the outcome.
        const status = inst.phases.find((p) => p.id === signal.phaseId)?.status;
        const stepStatus = inst.phases
          .find((p) => p.id === signal.phaseId)
          ?.steps.find((s) => s.runId === signal.runId)?.status;
        const why =
          res.ignored === "unknown-phase"
            ? `no phase "${signal.phaseId}" on this instance`
            : res.ignored === "phase-not-running"
              ? `phase "${signal.phaseId}" is ${status}, not running`
              : res.ignored === "step-not-running"
                ? `run ${signal.runId} already ended as ${stepStatus}`
                : `run ${signal.runId} is not a tracked step of phase "${signal.phaseId}"`;
        log.warn("pipeline signal ignored", {
          instanceId,
          phaseId: signal.phaseId,
          runId: signal.runId,
          type: signal.type,
          reason: res.ignored,
        });
        // Nothing is written but the journal entry: not the instance, and not
        // the run record either — a run whose step was already decided (its
        // completion refused, its attempt revised, its candidacy lost) keeps
        // the outcome that decision gave it, whatever it says afterwards.
        void journal(instanceId, {
          at: nowISO(),
          kind: "phase.signalled",
          phaseId: signal.phaseId,
          runId: signal.runId,
          detail: `${signal.type} (ignored: ${why})`,
        });
        return { ok: true, code: 202 };
      }
      res = await settleKnowledge(def, res);
      res = await settleRealizations(def, res);
      const { instance, startPhases: ready, routing, verify, verifyCandidate } = res;
      noteRouting(def, instance, routing);
      // A candidate's failure is not the phase's: it loses, the phase carries
      // on, and `settleCandidates` below decides whether anything is left. (A
      // refused completion was classed by `failStepInPlace` already.)
      if (signal.type === "failed" && !res.candidatesMoved) {
        // An agent that signalled failure has considered the work, so this
        // class is excluded from the default retry set — but an author who
        // opted into it gets it.
        noteFailure(def, instance, signal.phaseId, "signal", "the agent signalled failure");
      }
      // One write: the route decision, the skips it implies, the phase
      // statuses, the failure class and any scheduled retry land together or
      // not at all.
      await saveInstance(instance);
      queueVerifications(instanceId, def, instance, verify);
      if (verifyCandidate) {
        const phase = instance.phases.find((p) => p.id === verifyCandidate.phaseId);
        if (phase) {
          queueCandidateVerification(
            instanceId,
            def,
            verifyCandidate.phaseId,
            phase.attempt,
            verifyCandidate.candidate,
          );
        }
      }
      if (outcome) await patchRun(signal.runId, { outcome });
      void journal(instance.id, {
        at: nowISO(),
        kind: "phase.signalled",
        phaseId: signal.phaseId,
        runId: signal.runId,
        detail: refused
          ? `${signal.type} (refused: ${refused.failureClass ?? "unverified"}, marker ${refused.record.marker})`
          : intake && !intake.ok
            ? `${signal.type} (${
                intake.failure === "knowledge-context-integrity"
                  ? "knowledge context integrity"
                  : "knowledge delta refused"
              })`
            : completion
              ? `${signal.type} (marker ${completion.record.marker}${
                  completion.record.hook && !completion.record.hook.agrees
                    ? `; hook reported ${completion.record.hook.marker ?? "malformed metadata"}`
                    : ""
                })`
              : signal.type,
      });
      if (res.candidatesMoved) {
        // Everything after this — the phase's own conclusion, its journal
        // entries, the next phases — is the selection's business, not the
        // signalling candidate's.
        await settleCandidates(def, instance, res.candidatesMoved);
        deps.onChange?.();
        return { ok: true, code: 202 };
      }
      if (instance.status === "succeeded" || instance.status === "failed") {
        void journal(instance.id, {
          at: nowISO(),
          kind: "instance.ended",
          detail: instance.status,
        });
      }
      // Start the next phase detached: this handler runs on the child's signal
      // POST, and that child may still hold its concurrency slot until its
      // process exits after we respond. Awaiting startPhase here (which acquires
      // a slot) would deadlock when all slots are held by children waiting on
      // their own signal responses. The detached continuation RE-ACQUIRES the
      // instance lock and re-verifies liveness before launching, so an abort/
      // revise landing in the transition window can't be clobbered and won't be
      // raced into spawning orphan children (it queues behind, then kills them).
      queueReadyPhases(instanceId, def, instance, ready);
      if (instance.status === "failed") deps.onFailure?.(instance);
      deps.onChange?.();
      return { ok: true, code: 202 };
    });
  }

  return {
    authenticateSignal,
    onSignal,
  };
}
