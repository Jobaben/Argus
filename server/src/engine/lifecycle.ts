import { patchRun, readRun } from "../sources/runs.js";
import { accumulateRun } from "../sources/totals.js";
import { readInstances } from "../sources/instances.js";
import { decidedRuns } from "../transitionLog/effects.js";
import { livePhases } from "../sources/dag.js";
import { journal } from "../sources/journal.js";
import { isAlive } from "../scheduler.js";
import { parseEnvelopeFor } from "../runtimes/index.js";
import type { Run } from "../sources/scheduleTypes.js";
import type { PhaseFailureClass, PipelineInstance } from "../sources/pipelineTypes.js";
import { log } from "../log.js";
import type { EngineCore, EngineFns } from "./context.js";

/** Process lifecycle: awaiting a run's exit, deadlines and stalls, and the one way Argus ends a run (`terminateRun`). Moved verbatim from `createEngine`. */
export function createLifecycle(core: EngineCore) {
  const { deps, sem, locks, adopted, nowISO, kill, live, track } = core.ctx;
  const defFor: EngineFns["defFor"] = (...args) => core.fns.defFor(...args);
  const failStepInPlace: EngineFns["failStepInPlace"] = (...args) =>
    core.fns.failStepInPlace(...args);
  const queueReadyPhases: EngineFns["queueReadyPhases"] = (...args) =>
    core.fns.queueReadyPhases(...args);
  const readLive: EngineFns["readLive"] = (...args) => core.fns.readLive(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const settleCandidates: EngineFns["settleCandidates"] = (...args) =>
    core.fns.settleCandidates(...args);

  /** Await a launched step's completion off the request path, release its slot,
   *  and record the terminal state. Never throws. */
  function trackStep(
    run: Run,
    handle: { done: Promise<{ code: number | null }> },
    startedAt: string,
    instanceId: string,
    phaseId: string,
  ): void {
    let released = false;
    live.add(run.id);
    const release = () => {
      if (!released) {
        released = true;
        live.delete(run.id);
        sem.release();
      }
    };
    // The deadline is enforced from here while this process lives; after a
    // restart the reconcile pass enforces it from the persisted `deadlineAt`.
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (run.deadlineAt) {
      const wait = Math.max(0, Date.parse(run.deadlineAt) - deps.now().getTime());
      timer = setTimeout(() => {
        timer = null;
        void track(
          expireStep(run.id, instanceId, phaseId).catch((e) =>
            log.error("step deadline handler failed", { runId: run.id, err: e }),
          ),
        );
      }, wait);
    }
    void handle.done
      .then(async (res) => {
        release();
        if (timer) clearTimeout(timer);
        // The CLI's JSON result envelope is the last line of the log; harvest
        // cost/tokens/result from it so every completed step reports its spend
        // (not only runs finalized by the adopted-run reconcile path).
        const got = await readRun(run.id);
        const envelope = got
          ? parseEnvelopeFor(run.runtime, got.log, { model: got.run.model })
          : null;
        // A run Argus itself ended (deadline, abort) keeps the reason Argus
        // wrote; the exit code of a killed process explains nothing.
        const endedByArgus =
          got?.run.termination === "timed-out" ||
          got?.run.termination === "stalled" ||
          got?.run.termination === "killed";
        await patchRun(run.id, {
          status: res.code === 0 && !endedByArgus ? "succeeded" : "failed",
          endedAt: nowISO(),
          durationMs: deps.now().getTime() - new Date(startedAt).getTime(),
          exitCode: res.code,
          // Codex names its own thread; the id only becomes knowable once the
          // stream has reported it, which by now the log has.
          sessionId: got?.run.sessionId ?? envelope?.sessionId ?? null,
          resultSummary: envelope?.result ?? got?.run.resultSummary ?? null,
          costUsd: envelope?.costUsd ?? got?.run.costUsd ?? null,
          tokens: envelope?.tokens ?? got?.run.tokens ?? null,
          error: endedByArgus
            ? (got?.run.error ?? "stopped by Argus")
            : res.code === 0
              ? null
              : `exit code ${res.code}`,
        });
        await accumulateRun(run.id, deps.now);
        // The completion signal is authoritative and has already advanced the
        // phase; a process that then exits non-zero contradicts its own report.
        // Argus does not unwind downstream work over it, but it must not be
        // silent either: the journal names it, and the run record carries both
        // the outcome and the exit code for anyone reconciling the two.
        if (res.code !== 0 && !endedByArgus && got?.run.outcome === "succeeded") {
          void journal(instanceId, {
            at: nowISO(),
            kind: "step.exit-mismatch",
            phaseId,
            runId: run.id,
            detail: `signalled completed, then exited ${res.code ?? "on a signal"}`,
          });
        }
        deps.tailer?.untrack(run.id);
        deps.onChange?.();
      })
      .catch((e) => {
        release();
        if (timer) clearTimeout(timer);
        deps.tailer?.untrack(run.id);
        log.error("step run completion handler failed", { runId: run.id, err: e });
      });
  }

  /**
   * Runs this process has delivered a stop to — SIGTERM sent, SIGKILL armed.
   * In memory only, and deliberately: within one process that delivery is the
   * whole of it (the escalation finishes the job), while after a restart a
   * recorded request whose process is still alive has, as far as anyone can
   * prove, never been delivered — and is delivered again.
   */
  const delivered = new Set<string>();

  /**
   * The one way Argus ends a run's process.
   *
   * Three facts, kept apart because none implies another:
   * - the *request* — `Run.termination` and its reason, written first so the
   *   close handler reports why rather than an exit code. Durable, but only a
   *   request: its presence does not prove the process stopped;
   * - *liveness* — `isAlive(pid)`, asked now;
   * - *delivery* — the signal sent by this process ({@link delivered}).
   *
   * `record: "if-absent"` keeps the first reason a run was given (an abort
   * does not overwrite a timeout); `"always"` stamps this one (a deadline or a
   * stall names itself). `deliver: "if-alive"` signals only a live process;
   * `"always"` signals regardless, as the deadline handlers always have.
   */
  async function terminateRun(
    runId: string,
    reason: string,
    kind: "killed" | "timed-out" | "stalled",
    opts: {
      record?: "if-absent" | "always";
      deliver?: "if-alive" | "always";
      got?: Awaited<ReturnType<typeof readRun>>;
    } = {},
  ): Promise<"not-running" | "gone" | "signalled"> {
    const got = opts.got !== undefined ? opts.got : await readRun(runId);
    if (!got || got.run.status !== "running") return "not-running";
    const alive = isAlive(got.run.pid);
    const record = opts.record ?? "if-absent";
    if (record === "always" || (alive && !got.run.termination)) {
      await patchRun(runId, { termination: kind, error: reason });
    }
    if (!alive && (opts.deliver ?? "if-alive") === "if-alive") return "gone";
    await stopRun(got.run.pid);
    delivered.add(runId);
    return alive ? "signalled" : "gone";
  }

  /**
   * Kill a run's process tree, escalating to SIGKILL after a grace period if
   * it ignores the request. The escalation is best-effort and unawaited: the
   * transition that follows must not wait on a process that may never answer.
   */
  async function stopRun(pid: number | null): Promise<void> {
    if (!pid) return;
    try {
      await kill(pid);
    } catch {
      /* already gone */
    }
    const grace = deps.killGraceMs ?? 5000;
    const t = setTimeout(() => {
      // Sent to the group regardless of the leader: a child that outlived an
      // exited leader is exactly the process this exists to reach. Killing a
      // group that is already gone is a harmless error.
      void Promise.resolve(kill(pid, "SIGKILL")).catch(() => {});
    }, grace);
    // Never keep the server alive just to escalate a kill.
    if (typeof t === "object" && "unref" in t) t.unref();
  }

  /**
   * A step has reached its deadline while its process is still alive: record
   * why it is being ended (before the close handler can read the exit code),
   * stop it, and fail the phase under the `timeout` class. The phase's sibling
   * steps are stopped too — a failed phase has no use for their work, and a
   * process nobody is waiting for is a process that keeps spending.
   */
  async function expireStep(runId: string, instanceId: string, phaseId: string): Promise<void> {
    const got = await readRun(runId);
    if (!got || got.run.status !== "running") return;
    const seconds =
      got.run.deadlineAt && got.run.startedAt
        ? Math.round((Date.parse(got.run.deadlineAt) - Date.parse(got.run.startedAt)) / 1000)
        : null;
    const reason = seconds != null ? `timed out after ${seconds}s` : "timed out";
    // Nothing is written until the step is known to still be running: a step
    // whose completion signal already landed is not timed out, whatever its
    // process is still doing, and must not be stamped as if it were.
    await failStep(
      instanceId,
      phaseId,
      runId,
      "timeout",
      reason,
      { kind: "timed-out" },
      async () => {
        await terminateRun(runId, reason, "timed-out", {
          record: "always",
          deliver: "always",
          got,
        });
        void journal(instanceId, {
          at: nowISO(),
          kind: "step.timed-out",
          phaseId,
          runId,
          detail: reason,
        });
      },
    );
  }

  /**
   * A step's process is still alive, but its transcript has gone quiet for at
   * least its `stallSeconds` (§D, harness/stall.ts) — killed the same way a
   * hard timeout is, under the same `timeout` retry class (a stall is a
   * timeout that noticed sooner), with its own termination and reason so the
   * two are distinguishable in the record.
   */
  async function expireStalledStep(
    runId: string,
    instanceId: string,
    phaseId: string,
    stallSeconds: number,
  ): Promise<void> {
    const got = await readRun(runId);
    if (!got || got.run.status !== "running") return;
    const reason = `stalled: no output for ${stallSeconds}s`;
    await failStep(instanceId, phaseId, runId, "timeout", reason, { kind: "stalled" }, async () => {
      await terminateRun(runId, reason, "stalled", { record: "always", deliver: "always", got });
      void journal(instanceId, {
        at: nowISO(),
        kind: "step.stalled",
        phaseId,
        runId,
        detail: reason,
      });
    });
  }

  /**
   * Fail a running step from outside the signal path (deadline, or any other
   * harness-side verdict), under the instance lock. Only a step still tracked
   * as running is failed: a completion signal that landed first has already
   * decided, and a late failure must not overturn it.
   */
  async function failStep(
    instanceId: string,
    phaseId: string,
    runId: string,
    failureClass: PhaseFailureClass,
    reason: string,
    extra: Record<string, unknown> = {},
    /**
     * Runs under the lock once the failure is known to apply, before the
     * transition. Both deadline handlers stop the failed run's process here,
     * under their own termination, so the phase sweep below leaves it alone.
     */
    beforeTransition?: () => Promise<void>,
  ): Promise<void> {
    await locks.withLock(instanceId, async () => {
      const inst = await readLive(instanceId, "deadline");
      if (!inst || inst.status !== "running") return;
      const phase = inst.phases.find((p) => p.id === phaseId);
      const step = phase?.steps.find((s) => s.runId === runId);
      if (!phase || phase.status !== "running" || step?.status !== "running") return;
      const def = await defFor(inst);
      if (!def) return;
      if (beforeTransition) await beforeTransition();
      const res = failStepInPlace(def, inst, phaseId, runId, failureClass, reason, extra);
      await patchRun(runId, { outcome: "failed" });
      await saveInstance(res.instance);
      if (res.candidatesMoved) {
        // One candidate timed out. Its siblings are the point of running
        // several, so they are left alone and the selection is re-asked.
        await settleCandidates(def, res.instance, res.candidatesMoved);
        deps.onChange?.();
        return;
      }
      // The sweep is for the failed run's siblings: the run itself was already
      // asked to stop in `beforeTransition`, its SIGKILL escalation already
      // pending. It is still `running` until its process exits, so without
      // the exclusion a live process would be asked to stop a second time.
      await killPhaseRuns(
        res.instance,
        [phaseId],
        "stopped: phase failed",
        beforeTransition ? [runId] : [],
      );
      queueReadyPhases(instanceId, def, res.instance, res.startPhases);
      if (res.instance.status === "failed") deps.onFailure?.(res.instance);
      deps.onChange?.();
    });
  }

  /**
   * Kill any still-alive process spawned for the named phases, so a straggler
   * run can't keep executing (or later signal) against them.
   *
   * The phase ids are explicit rather than derived from "what is live" for two
   * reasons that pull in opposite directions, and both matter with a DAG:
   * aborting must reach phases the abort has *already* marked terminal, while
   * revising must **not** reach a sibling branch that is legitimately still
   * running.
   */
  async function killPhaseRuns(
    inst: PipelineInstance,
    phaseIds: string[],
    reason = "stopped by Argus",
    alreadyStopped: string[] = [],
  ): Promise<void> {
    const wanted = new Set(phaseIds);
    const runIds = inst.phases
      .filter((p) => wanted.has(p.id))
      .flatMap((p) => p.steps.map((s) => s.runId))
      .filter((id): id is string => !!id);
    await stopRuns(runIds, reason, alreadyStopped);
  }

  /**
   * Stop exactly these runs. Idempotent: a run that is no longer running, or
   * whose process is gone, is left alone — which is what lets an interrupted
   * revise or abort be carried through again without signalling anything new.
   * `alreadyStopped` names runs the caller has itself just asked to stop: they
   * are not signalled again, only untracked like the rest.
   */
  async function stopRuns(
    runIds: string[],
    reason = "stopped by Argus",
    alreadyStopped: string[] = [],
  ): Promise<void> {
    for (const runId of runIds) {
      // The reason is written before the kill so the close handler reads the
      // reason Argus gave rather than inventing one from the exit code.
      if (!alreadyStopped.includes(runId)) await terminateRun(runId, reason, "killed");
      deps.tailer?.untrack(runId);
    }
  }

  async function adopt(): Promise<void> {
    for (const inst of await readInstances()) {
      if (inst.status !== "running") continue;
      // Every live phase, not just one: a fan-out has several in flight, and an
      // unadopted run is a process nobody is tracking.
      for (const s of livePhases(inst).flatMap((i) => inst.phases[i].steps)) {
        if (s.status !== "running" || !s.runId || adopted.has(s.runId)) continue;
        const got = await readRun(s.runId);
        if (!got || got.run.status !== "running" || !isAlive(got.run.pid)) continue;
        await sem.acquire();
        adopted.set(s.runId, { instanceId: inst.id });
        deps.tailer?.track(s.runId, inst.id, got.run.runtime);
      }
    }
  }

  /**
   * Stop every still-alive run whose step has already been decided — failed,
   * aborted, superseded, or left running under a phase that is over — that
   * this process has not itself stopped. Each is either a recorded request a
   * crash interrupted before delivery, or a sibling the sweep that follows a
   * failure never reached. A run that reported its own outcome is ending by
   * itself and is left alone; so is everything this process already
   * signalled (its SIGKILL escalation is armed).
   */
  async function sweepDecidedRuns(inst: PipelineInstance): Promise<void> {
    for (const runId of decidedRuns(inst)) {
      if (delivered.has(runId)) continue;
      const got = await readRun(runId);
      if (!got || got.run.status !== "running" || got.run.outcome) continue;
      if (!isAlive(got.run.pid)) continue;
      const requested = !!got.run.termination && got.run.termination !== "spawn-failed";
      const reason = requested
        ? (got.run.error ?? "stopped by Argus")
        : "stopped: its step was already decided";
      await terminateRun(runId, reason, "killed", { got });
      deps.tailer?.untrack(runId);
      void journal(inst.id, {
        at: nowISO(),
        kind: requested ? "step.termination-redelivered" : "step.orphan-stopped",
        ...(got.run.phaseId ? { phaseId: got.run.phaseId } : {}),
        runId,
        detail: reason,
      });
    }
  }

  return {
    trackStep,
    delivered,
    terminateRun,
    stopRun,
    expireStep,
    expireStalledStep,
    failStep,
    killPhaseRuns,
    stopRuns,
    adopt,
    sweepDecidedRuns,
  };
}
