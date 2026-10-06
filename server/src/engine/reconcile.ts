import { encodeProject, patchRun, readRun, readRunResult, writeRun } from "../sources/runs.js";
import { isStalled, resolveStallSeconds } from "../harness/stall.js";
import { resolveCompletionPolicy } from "../harness/completion.js";
import { readPipelines } from "../sources/pipelines.js";
import { accumulateRun } from "../sources/totals.js";
import { readInstance, readInstances } from "../sources/instances.js";
import { advance } from "../pipelineTransitions.js";
import { livePhases } from "../sources/dag.js";
import { journal } from "../sources/journal.js";
import { isAlive } from "../scheduler.js";
import { parseEnvelopeFor, runtimeFor } from "../runtimes/index.js";
import { graceMsFor, previousFireTime } from "../sources/nextFire.js";
import type { Run } from "../sources/scheduleTypes.js";
import type { RetryableClass, StepCompletion } from "../sources/pipelineTypes.js";
import { log } from "../log.js";
import { failureClassOfRecord, recoverRunOutcome } from "./outcome.js";
import type { EngineCore, EngineFns } from "./context.js";

/** Instance statuses whose running phases reconcile may still act on. */
const resumable = (status: string) => status === "running" || status === "awaiting-approval";

/** The reconcile tick: gate recovery, adopted runs, due retries, stalls, healing, owed launches and the decided-run sweep. Moved verbatim from `createEngine`. */
export function createReconcile(core: EngineCore) {
  const { deps, sem, locks, adopted, nowISO, verifying, queuedLaunches, live, T } = core.ctx;
  const acceptCompletion: EngineFns["acceptCompletion"] = (...args) =>
    core.fns.acceptCompletion(...args);
  const delivered = core.fns.delivered;
  const expireStalledStep: EngineFns["expireStalledStep"] = (...args) =>
    core.fns.expireStalledStep(...args);
  const noteFailure: EngineFns["noteFailure"] = (...args) => core.fns.noteFailure(...args);
  const noteRouting: EngineFns["noteRouting"] = (...args) => core.fns.noteRouting(...args);
  const queueCandidateVerification: EngineFns["queueCandidateVerification"] = (...args) =>
    core.fns.queueCandidateVerification(...args);
  const queueReadyPhases: EngineFns["queueReadyPhases"] = (...args) =>
    core.fns.queueReadyPhases(...args);
  const queueVerification: EngineFns["queueVerification"] = (...args) =>
    core.fns.queueVerification(...args);
  const queueVerifications: EngineFns["queueVerifications"] = (...args) =>
    core.fns.queueVerifications(...args);
  const readLive: EngineFns["readLive"] = (...args) => core.fns.readLive(...args);
  const runDueRetries: EngineFns["runDueRetries"] = (...args) => core.fns.runDueRetries(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const settleCandidates: EngineFns["settleCandidates"] = (...args) =>
    core.fns.settleCandidates(...args);
  const settleKnowledge: EngineFns["settleKnowledge"] = (...args) =>
    core.fns.settleKnowledge(...args);
  const settleRealizations: EngineFns["settleRealizations"] = (...args) =>
    core.fns.settleRealizations(...args);
  const start: EngineFns["start"] = (...args) => core.fns.start(...args);
  const sweepDecidedRuns: EngineFns["sweepDecidedRuns"] = (...args) =>
    core.fns.sweepDecidedRuns(...args);
  const terminateRun: EngineFns["terminateRun"] = (...args) => core.fns.terminateRun(...args);

  async function reconcile() {
    const defs = await readPipelines();
    const grace = graceMsFor(deps.tickMs ?? 30000);
    const now = deps.now();

    // Before anything else: complete every gate operation that was
    // interrupted (a restart after a crash mid-revise, mid-abort,
    // mid-approval), whatever the instance's status — an aborting instance
    // may still read `running`, a revising one `awaiting-approval`. Every
    // later step of this pass then sees the state the decision produced.
    for (const candidate of await readInstances()) {
      if (!candidate.pendingGateOperation) continue;
      await locks.withLock(candidate.id, () => readLive(candidate.id, "gate-recovery"));
    }

    // 0. Finalize adopted (reattached) runs whose detached process has ended.
    //    The in-memory done-handler was lost with the previous server process,
    //    so status/result come from the log's JSON envelope instead. Instance
    //    advancement is not done here — the healing pass below (under the
    //    instance lock) handles steps whose runs ended without signalling.
    for (const runId of [...adopted.keys()]) {
      try {
        const got = await readRun(runId);
        if (!got || got.run.status !== "running") {
          adopted.delete(runId);
          sem.release();
          deps.tailer?.untrack(runId);
          continue;
        }
        if (isAlive(got.run.pid)) {
          // A recorded request to end it, with the process still alive and no
          // delivery by this process: the previous one died between writing
          // the request and sending the signal. The request is not the stop —
          // deliver it now, under the reason it was given.
          if (got.run.termination && got.run.termination !== "spawn-failed") {
            if (!delivered.has(runId)) {
              await terminateRun(runId, got.run.error ?? "stopped by Argus", "killed", { got });
              if (got.run.instanceId) {
                void journal(got.run.instanceId, {
                  at: nowISO(),
                  kind: "step.termination-redelivered",
                  ...(got.run.phaseId ? { phaseId: got.run.phaseId } : {}),
                  runId,
                  detail: `${got.run.termination}: ${got.run.error ?? "stopped by Argus"}`,
                });
              }
            }
            continue;
          }
          // The deadline outlives the process that set the timer: an adopted
          // run past its deadline is ended here, and finalized next tick.
          if (got.run.deadlineAt && Date.parse(got.run.deadlineAt) <= now.getTime()) {
            const reason = `timed out after ${Math.round(
              (Date.parse(got.run.deadlineAt) - Date.parse(got.run.startedAt ?? got.run.queuedAt)) /
                1000,
            )}s`;
            await terminateRun(runId, reason, "timed-out", { record: "always", got });
            if (got.run.instanceId && got.run.phaseId) {
              void journal(got.run.instanceId, {
                at: nowISO(),
                kind: "step.timed-out",
                phaseId: got.run.phaseId,
                runId,
                detail: reason,
              });
            }
          }
          continue;
        }
        const envelope = parseEnvelopeFor(got.run.runtime, got.log, { model: got.run.model });
        const parsed = envelope.isError !== null || envelope.result !== null ? envelope : null;
        const ended = deps.now();
        // patchRun (not a full writeRun spread): the signal path patches
        // `outcome` concurrently, and a stale full-object write would drop it.
        const endedByArgus =
          got.run.termination === "timed-out" ||
          got.run.termination === "stalled" ||
          got.run.termination === "killed";
        await patchRun(runId, {
          status: parsed && parsed.isError === false && !endedByArgus ? "succeeded" : "failed",
          endedAt: ended.toISOString(),
          durationMs: got.run.startedAt
            ? ended.getTime() - new Date(got.run.startedAt).getTime()
            : null,
          exitCode: null,
          sessionId: got.run.sessionId ?? parsed?.sessionId ?? null,
          resultSummary: parsed?.result ?? got.run.resultSummary,
          costUsd: parsed?.costUsd ?? got.run.costUsd,
          tokens: parsed?.tokens ?? got.run.tokens,
          error: endedByArgus
            ? got.run.error
            : !parsed
              ? "ended while detached; no parseable result"
              : parsed.isError === false
                ? null
                : (parsed.result ?? "run reported is_error"),
        });
        await accumulateRun(runId, deps.now);
        adopted.delete(runId);
        sem.release();
        deps.tailer?.untrack(runId);
        deps.onChange?.();
      } catch (e) {
        // Keep the run adopted; retried next tick.
        log.error("finalize of adopted run failed", { err: e });
      }
    }

    // 1. Start clock-due pipeline definitions.
    for (const def of defs) {
      if (!def.enabled || !def.trigger) continue;
      const anchor = new Date(def.lastStartedAt ?? def.createdAt);
      const prev = previousFireTime(def.trigger, anchor, now);
      if (!prev) continue;
      // Don't backfill a slot from before the pipeline was created (mirrors
      // shouldFire): avoids an immediate fire on creation within the window.
      if (prev.getTime() < new Date(def.createdAt).getTime()) continue;
      if (def.lastStartedAt && new Date(def.lastStartedAt).getTime() >= prev.getTime()) continue;
      if (now.getTime() - prev.getTime() > grace) continue;
      await start(def.id, "scheduled");
    }

    // 2. Start any retry whose backoff has elapsed. Before healing, so a phase
    //    that just became due is retried rather than re-examined as an orphan.
    await runDueRetries(now);

    // 2.5 Stall detection (§D): a running step whose transcript has gone
    //     quiet longer than its declared `stallSeconds`, even though the
    //     process is still alive, is killed like a timeout. Reuses this same
    //     reconcile tick rather than a second timer system, and covers both
    //     this process's own runs and adopted ones — the run tailer's
    //     `latest()` only knows about runs *this* process is tailing, so
    //     `Run.lastActivityAt` (refreshed here, persisted) is what a restart
    //     falls back to until the tailer catches up.
    for (const candidate of await readInstances()) {
      if (candidate.status !== "running") continue;
      const def = candidate.definition ?? defs.find((d) => d.id === candidate.pipelineId);
      if (!def) continue;
      for (const i of livePhases(candidate)) {
        const phase = candidate.phases[i];
        if (phase.status !== "running") continue;
        const phaseDef = def.phases.find((p) => p.id === phase.id);
        if (!phaseDef) continue;
        for (const step of phase.steps) {
          if (step.status !== "running" || !step.runId) continue;
          const stepDef = phaseDef.candidates
            ? phaseDef.steps[0]
            : phaseDef.steps.find((s) => s.name === step.name);
          const stallSeconds = resolveStallSeconds(phaseDef, stepDef ?? {});
          if (!stallSeconds) continue;
          const got = await readRun(step.runId);
          if (!got || got.run.status !== "running" || got.run.termination) continue;
          const observed = deps.tailer?.latest?.().get(step.runId)?.at ?? null;
          if (observed && observed !== got.run.lastActivityAt) {
            await patchRun(step.runId, { lastActivityAt: observed });
          }
          const lastActivityAt = observed ?? got.run.lastActivityAt ?? null;
          if (isStalled({ stallSeconds, lastActivityAt, startedAt: got.run.startedAt, now })) {
            await expireStalledStep(step.runId, candidate.id, phase.id, stallSeconds);
          }
        }
      }
    }

    // 3. Heal running instances whose live-phase runs ended without signalling.
    //    Each instance is healed under its lock, re-reading fresh state inside,
    //    so a genuine completion signal landing mid-pass is never clobbered by a
    //    stale "failed" write (the TOCTOU the lock closes).
    //    Over the instances, not the definitions: an instance heals against its
    //    own snapshot, so one whose definition was edited — or deleted — under
    //    it is healed like any other rather than left running forever.
    //
    //    An instance with a phase paused at a gate (`awaiting-approval`) is
    //    visited too, with the authority the live paths give it: work a
    //    committed decision ordered still happens — an owed launch, and a
    //    knowledge commit an approval or a phase already decided — while
    //    results wait for the gate decision: agent outcomes (the signal path
    //    drops signals on a paused instance), check results (not applied to a
    //    paused instance) and candidate selection. The paused phase itself is
    //    never touched: every block below acts only on `running` phases.
    for (const candidate of await readInstances()) {
      if (!resumable(candidate.status)) continue;
      const def = candidate.definition ?? defs.find((d) => d.id === candidate.pipelineId);
      if (!def) continue;
      await locks.withLock(candidate.id, async () => {
        const inst = await readLive(candidate.id, "reconcile");
        if (!inst || !resumable(inst.status)) return;
        let current = inst;
        // A phase whose knowledge commit was pending when Argus stopped is
        // committed again: the commit is idempotent on delta id, so a ledger
        // already carrying the deltas simply concludes the phase.
        for (const i of livePhases(current)) {
          const phase = current.phases[i];
          if (phase.status !== "running" || phase.knowledge?.status !== "pending") continue;
          const res = await settleRealizations(
            def,
            await settleKnowledge(def, {
              instance: current,
              startPhases: [],
              commitKnowledge: [phase.id],
            }),
          );
          noteRouting(def, res.instance, res.routing);
          await saveInstance(res.instance);
          if (res.instance.status === "succeeded" || res.instance.status === "failed") {
            void journal(current.id, {
              at: nowISO(),
              kind: "instance.ended",
              detail: res.instance.status,
            });
          }
          queueReadyPhases(current.id, def, res.instance, res.startPhases);
          if (res.instance.status === "failed") deps.onFailure?.(res.instance);
          deps.onChange?.();
          current = res.instance;
        }
        if (!resumable(current.status)) return;
        const paused = current.status === "awaiting-approval";
        // A phase whose checks were running when Argus stopped is verified
        // again: the checks are Argus's own and deterministic, and the
        // attempt key makes a duplicate report a no-op. Not while a gate is
        // paused: the result would not be applied (verification.ts), so the
        // checks wait for the decision rather than run to be thrown away.
        for (const i of paused ? [] : livePhases(current)) {
          const phase = current.phases[i];
          if (phase.status !== "running") continue;
          if (
            phase.verification?.status === "running" &&
            !verifying.has(`${current.id}:${phase.id}:${phase.attempt}`)
          ) {
            queueVerification(current.id, def, phase.id, phase.attempt);
          }
          // The same for each candidate that was being verified when Argus
          // stopped. Keyed by candidate as well as attempt, so a duplicate
          // report is the same no-op it is for an ordinary phase.
          for (const step of phase.steps) {
            if (step.candidate === undefined) continue;
            if (step.verification?.status !== "running") continue;
            if (verifying.has(`${current.id}:${phase.id}:${phase.attempt}:c${step.candidate}`)) {
              continue;
            }
            queueCandidateVerification(current.id, def, phase.id, phase.attempt, step.candidate);
          }
        }
        // Owed launches, read off the saved instance alone: a phase attempt it
        // says is running with no run planned — a crash landed between the
        // transition that started it (a retry, a revise, a remediation, a
        // settle) and the launch. A transition record past the saved instance
        // never gets here: only what was committed is acted on.
        const owedLaunch: number[] = [];
        for (const i of livePhases(current)) {
          const phase = current.phases[i];
          if (phase.status !== "running" || phase.steps.length === 0) continue;
          if (phase.steps.some((s) => s.runId)) continue;
          if (phase.verification?.status === "running" || phase.knowledge?.status === "pending") {
            continue;
          }
          if (queuedLaunches.has(`${current.id}:${phase.id}:${phase.attempt}`)) continue;
          owedLaunch.push(i);
          void journal(current.id, {
            at: nowISO(),
            kind: "phase.launch-recovered",
            phaseId: phase.id,
            attempt: phase.attempt,
            detail: "running with no run planned; launched by reconcile",
          });
        }
        queueReadyPhases(current.id, def, current, owedLaunch);
        await sweepDecidedRuns(current);
        // Agent outcomes and candidate selection wait for the gate decision,
        // as the signal path does.
        if (paused) return;
        // Every live phase: with a fan-out, a died-without-signalling run can
        // be in any of them, and healing only one would leave the others
        // showing a working tile forever.
        const orphans = livePhases(current).flatMap((i) =>
          current.phases[i].steps.map((s) => ({ phaseId: current.phases[i].id, step: s })),
        );
        for (const { phaseId, step: s } of orphans) {
          if (s.status !== "running" || !s.runId) continue;
          let got = await readRun(s.runId);
          // A step recorded as running with no process behind it — no run
          // record at all, or one that never got a pid — and not being
          // launched by this process: Argus stopped between recording the
          // step and starting it. Nothing will ever signal for it, so it is
          // failed here as a spawn failure (retryable by default).
          if (
            !live.has(s.runId) &&
            (!got || (got.run.status === "running" && got.run.pid == null))
          ) {
            const stepDef = def.phases.find((p) => p.id === phaseId);
            const reason = "Argus stopped before the step's process was started";
            const stub: Run = got?.run ?? {
              id: s.runId,
              scheduleId: `pipeline:${current.pipelineId}`,
              scheduleName: `${current.pipelineName} · ${stepDef?.name ?? phaseId}`,
              prompt: "",
              cwd: stepDef?.cwd ?? "",
              status: "running",
              trigger: "scheduled",
              queuedAt: nowISO(),
              startedAt: null,
              endedAt: null,
              durationMs: null,
              pid: null,
              exitCode: null,
              sessionId: null,
              project: stepDef ? encodeProject(stepDef.cwd) : null,
              resultSummary: null,
              error: null,
              instanceId: current.id,
              phaseId,
            };
            await writeRun({
              ...stub,
              status: "failed",
              termination: "spawn-failed",
              error: reason,
              endedAt: nowISO(),
            });
            got = await readRun(s.runId);
          }
          // Reconcile only from a completed run record. A dead pid whose
          // record is still `running` can be racing the normal close handler;
          // guessing in that window would discard the agent's final message,
          // which is what distinguishes success, failure, and ambiguity.
          const ended =
            got &&
            (got.run.status === "failed" ||
              got.run.status === "succeeded" ||
              got.run.status === "interrupted" ||
              got.run.status === "cancelled");
          if (!ended) continue;
          const restarted = got?.run.status === "interrupted";
          const recovered =
            !restarted && got && runtimeFor(got.run.runtime).outcomeFromRecord
              ? recoverRunOutcome(got.run)
              : null;
          let signalType = recovered?.signalType ?? "failed";
          // A recovered *completion* may carry a declared result. Read it the
          // same way the stop hook would; this is the whole completion
          // protocol for a runtime with no hook to install.
          const recoveredResult = signalType === "completed" ? await readRunResult(s.runId) : {};
          // And it goes through the same acceptance the signal path applies:
          // the supplied context is re-verified and any KnowledgeDelta staged
          // — or refused, which turns the recovered completion into a
          // `knowledge-delta` or `knowledge-context-integrity` failure.
          const intake =
            signalType === "completed"
              ? await acceptCompletion(def, current, phaseId, s.runId)
              : null;
          const knowledgeRefused = intake && !intake.ok ? intake.reason : null;
          if (knowledgeRefused) signalType = "failed";
          const payload = knowledgeRefused
            ? { reason: knowledgeRefused }
            : recovered
              ? recovered.payload
              : restarted
                ? { reason: "Argus restarted mid-run — revise to retry", kind: "restarted" }
                : {
                    reason: got?.run.error ?? "run ended without emitting a completion signal",
                  };
          const recordClass: RetryableClass =
            intake && !intake.ok
              ? intake.failure
              : (recovered?.failureClass ?? (got ? failureClassOfRecord(got.run) : "spawn"));
          // The run-record completion's own account, when there was a final
          // message to classify: the same fields the signal path records, so
          // a phase's per-run provenance reads alike whichever way it arrived.
          const recordCompletion: StepCompletion | undefined =
            recovered?.marker != null
              ? {
                  signal: recovered.signalType,
                  source: "run-record",
                  policy: resolveCompletionPolicy(
                    def,
                    def.phases.find((p) => p.id === phaseId),
                  ),
                  marker: recovered.marker,
                  verdict: knowledgeRefused
                    ? "refused"
                    : recovered.signalType === "completed"
                      ? "accepted"
                      : recovered.failureClass === "unverified"
                        ? "refused"
                        : "reported-failure",
                  ...(knowledgeRefused
                    ? { reason: knowledgeRefused }
                    : recovered.failureClass === "unverified" && recovered.failureReason
                      ? { reason: recovered.failureReason }
                      : {}),
                  at: nowISO(),
                }
              : undefined;
          let res = T(
            advance(
              def,
              current,
              {
                instanceId: current.id,
                phaseId,
                runId: s.runId,
                type: signalType,
                token: current.signalToken,
                payload,
                ...(knowledgeRefused ? {} : recoveredResult),
              },
              nowISO(),
              signalType === "failed" ? recordClass : undefined,
              recordCompletion,
            ),
          );
          if (recovered) {
            await patchRun(s.runId, { outcome: knowledgeRefused ? "failed" : recovered.outcome });
          }
          if (signalType === "failed" && !res.candidatesMoved) {
            // Class the failure from what the run record shows, so retry
            // policies keep distinguishing infrastructure from an agent's
            // considered failed/blocked conclusion.
            const reason =
              knowledgeRefused ??
              recovered?.failureReason ??
              (payload as { reason?: string }).reason ??
              "run ended without emitting a completion signal";
            noteFailure(def, res.instance, phaseId, recordClass, reason);
          }
          res = await settleKnowledge(def, res);
          res = await settleRealizations(def, res);
          const {
            instance,
            startPhases: ready,
            routing,
            verify,
            verifyCandidate,
            candidatesMoved,
          } = res;
          noteRouting(def, instance, routing);
          await saveInstance(instance);
          queueVerifications(instance.id, def, instance, verify);
          if (verifyCandidate) {
            const healed = instance.phases.find((p) => p.id === verifyCandidate.phaseId);
            if (healed) {
              queueCandidateVerification(
                instance.id,
                def,
                verifyCandidate.phaseId,
                healed.attempt,
                verifyCandidate.candidate,
              );
            }
          }
          void journal(instance.id, {
            at: nowISO(),
            kind: "phase.signalled",
            phaseId,
            runId: s.runId,
            detail: knowledgeRefused
              ? `harness: ${intake && !intake.ok ? intake.failure : "knowledge-delta"}`
              : recovered
                ? `run-record fallback: ${recovered.outcome}`
                : "reconcile: failed",
          });
          deps.tailer?.untrack(s.runId);
          if (candidatesMoved) await settleCandidates(def, instance, candidatesMoved);
          else queueReadyPhases(instance.id, def, instance, ready);
          if (instance.status === "failed") deps.onFailure?.(instance);
          deps.onChange?.();
          current = instance;
          if (current.status !== "running" && current.status !== "awaiting-approval") break;
        }
        // A restart can land between a candidate's last report and the
        // selection that report implied. The decision is a pure function of
        // what is on disk, so it is simply asked again — and answers `pending`,
        // harmlessly, for every phase still genuinely waiting.
        if (current.status === "running") {
          for (const i of livePhases(current)) {
            const phase = current.phases[i];
            if (phase.status !== "running") continue;
            if (!def.phases.find((p) => p.id === phase.id)?.candidates) continue;
            await settleCandidates(def, current, phase.id);
          }
        }
      });
    }

    // 4. The same sweep over instances that are no longer running, but
    //    recently were: a failure or an abort settles the instance in the
    //    same save that decides its steps, so a crash before the stop is
    //    delivered leaves a terminal instance with live runs.
    const recent = now.getTime() - 24 * 3_600_000;
    for (const candidate of await readInstances()) {
      if (candidate.status === "running") continue;
      if (Date.parse(candidate.updatedAt) < recent) continue;
      await locks.withLock(candidate.id, async () => {
        const inst = await readInstance(candidate.id);
        if (inst && inst.status !== "running") await sweepDecidedRuns(inst);
      });
    }
  }

  return {
    reconcile,
  };
}
