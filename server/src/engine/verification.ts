import { readFile } from "node:fs/promises";
import { paths } from "../claudeHome.js";
import {
  candidateArtifactDir,
  phaseArtifactDir,
  phaseBaselinePath,
  resolveCapabilities,
} from "../harness/invocation.js";
import { buildChildEnv } from "../harness/childEnv.js";
import { runChecks } from "../harness/verification.js";
import type { WorkingTreeSnapshot } from "../harness/verification.js";
import { readInstance } from "../sources/instances.js";
import { applyCandidateVerification, applyVerification } from "../pipelineTransitions.js";
import { journal } from "../sources/journal.js";
import type {
  PhaseFailurePayload,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import { log } from "../log.js";
import { readRun } from "../sources/runs.js";
import { readSessionLines } from "../sources/sessions.js";
import { buildRecording } from "../sources/recorder.js";
import { gateRelevantSteps } from "../sources/gatePolicy.js";
import { computeTrajectorySignals, type TrajectoryRunInput } from "../sources/trajectory.js";
import type { EngineCore, EngineFns } from "./context.js";

/** Running a phase's (or a candidate's) checks off the instance lock, and recording the report under it. Moved verbatim from `createEngine`. */
/** ` (n not evaluated)` when some checks could not be evaluated, else "". */
function notEvaluated(checks: Array<{ status: string }>): string {
  const n = checks.filter((c) => c.status === "not-evaluated").length;
  return n > 0 ? ` (${n} not evaluated)` : "";
}

export function createVerification(core: EngineCore) {
  const { deps, locks, nowISO, parentEnv, verifying, track, T } = core.ctx;
  const noteFailure: EngineFns["noteFailure"] = (...args) => core.fns.noteFailure(...args);
  const noteRouting: EngineFns["noteRouting"] = (...args) => core.fns.noteRouting(...args);
  const queueReadyPhases: EngineFns["queueReadyPhases"] = (...args) =>
    core.fns.queueReadyPhases(...args);
  const readLive: EngineFns["readLive"] = (...args) => core.fns.readLive(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const settleCandidates: EngineFns["settleCandidates"] = (...args) =>
    core.fns.settleCandidates(...args);
  const settleKnowledge: EngineFns["settleKnowledge"] = (...args) =>
    core.fns.settleKnowledge(...args);
  const settleRealizations: EngineFns["settleRealizations"] = (...args) =>
    core.fns.settleRealizations(...args);

  /**
   * Trajectory signals for each run, from the Recorder over the run's own
   * transcript — the same reader and heuristics as trajectory judging. A run
   * with no record, no session or no readable transcript is reported as such:
   * the check decides what an absence means, and it never means clean.
   */
  async function trajectoryInputs(runIds: string[]): Promise<TrajectoryRunInput[]> {
    const out: TrajectoryRunInput[] = [];
    for (const runId of runIds) {
      const got = await readRun(runId).catch(() => null);
      if (!got) {
        out.push({ runId, signals: null, unavailable: "no run record" });
        continue;
      }
      const run = got.run;
      if (!run.project || !run.sessionId) {
        out.push({ runId, signals: null, unavailable: "no session recorded for the run" });
        continue;
      }
      const lines = await readSessionLines(run.project, run.sessionId).catch(() => []);
      const signals = computeTrajectorySignals(
        buildRecording(run, lines, deps.now()),
        run.cwd || null,
      );
      out.push(
        signals.transcript === "present"
          ? { runId, signals }
          : { runId, signals, unavailable: "no readable transcript" },
      );
    }
    return out;
  }

  /**
   * Run a phase's declared checks off the lock, then record the verdict under
   * it.
   *
   * The checks are Argus's own work — a test command, a required artifact, the
   * set of files the agent touched — and can take as long as a test suite. They
   * run outside the instance lock so signals for sibling branches keep flowing,
   * and the verdict is applied by {@link applyVerification}, which refuses a
   * report for any phase attempt that is no longer waiting on one. Keyed by
   * attempt so a crash mid-verification is re-run by reconcile, and a revise
   * during the checks makes the stale report a no-op rather than a decision.
   */
  function queueVerification(
    instanceId: string,
    def: PipelineDefinition,
    phaseId: string,
    attempt: number,
  ): void {
    const key = `${instanceId}:${phaseId}:${attempt}`;
    if (verifying.has(key)) return;
    verifying.add(key);
    const phaseDef = def.phases.find((p) => p.id === phaseId);
    void track(
      (async () => {
        if (!phaseDef) return;
        const inst = await readInstance(instanceId);
        const phase = inst?.phases.find((p) => p.id === phaseId);
        if (!inst || !phase) return;
        void journal(instanceId, {
          at: nowISO(),
          kind: "phase.verifying",
          phaseId,
          attempt,
          detail: `${phaseDef.checks?.length ?? 0} check${phaseDef.checks?.length === 1 ? "" : "s"}`,
        });
        let baseline: WorkingTreeSnapshot | null = null;
        try {
          baseline = JSON.parse(
            await readFile(
              phaseBaselinePath(paths.invocationsDir(), instanceId, phaseId, attempt),
              "utf8",
            ),
          ) as WorkingTreeSnapshot;
        } catch {
          /* no baseline recorded (not a git repository, or no changed-files check) */
        }
        const report = await runChecks(phaseDef.checks ?? [], {
          // The checks look at the work, so they look where the work happened:
          // the phase's worktree when it had one, its own cwd otherwise.
          cwd: phase.workspace?.path ?? phaseDef.cwd,
          artifactDir: phase.artifactDir ?? null,
          baseline,
          now: deps.now,
          // The checks run under the phase's own environment policy: a command
          // check is a script in the repository the agent just edited, and must
          // not see what the agent was not allowed to see.
          env: buildChildEnv(parentEnv(), resolveCapabilities(def, phaseDef, {})?.env).env,
          // The runs whose work passes this gate: the selected candidate's
          // when one is selected, otherwise every step of the attempt.
          trajectoryRuns: () =>
            trajectoryInputs(
              gateRelevantSteps(phase)
                .map((s) => s.runId)
                .filter((id): id is string => !!id),
            ),
        });
        await locks.withLock(instanceId, async () => {
          const fresh = await readLive(instanceId, "verification");
          if (!fresh || fresh.status !== "running") return;
          const current = fresh.phases.find((p) => p.id === phaseId);
          if (!current || current.attempt !== attempt) return;
          let res = T(applyVerification(def, fresh, phaseId, report, nowISO()));
          if (!res.verificationApplied) return;
          const failed = report.status === "failed";
          void journal(instanceId, {
            at: nowISO(),
            kind: "phase.verified",
            phaseId,
            attempt,
            detail: failed
              ? `failed: ${report.checks
                  .filter((c) => c.status === "failed")
                  .map((c) => c.label)
                  .join(", ")}`
              : `passed: ${report.checks.length} check${report.checks.length === 1 ? "" : "s"}${notEvaluated(report.checks)}`,
          });
          if (failed) {
            const reason =
              (res.instance.phases.find((p) => p.id === phaseId)?.payload as PhaseFailurePayload)
                ?.reason ?? "verification failed";
            noteFailure(def, res.instance, phaseId, "verification", reason);
          }
          res = await settleKnowledge(def, res);
          res = await settleRealizations(def, res);
          noteRouting(def, res.instance, res.routing);
          await saveInstance(res.instance);
          if (res.instance.status === "succeeded" || res.instance.status === "failed") {
            void journal(instanceId, {
              at: nowISO(),
              kind: "instance.ended",
              detail: res.instance.status,
            });
          }
          queueReadyPhases(instanceId, def, res.instance, res.startPhases);
          if (res.instance.status === "failed") deps.onFailure?.(res.instance);
          deps.onChange?.();
        });
      })()
        .catch((e: unknown) =>
          log.error("phase verification failed to run", { instanceId, phaseId, err: e }),
        )
        .finally(() => verifying.delete(key)),
    );
  }

  /**
   * Run one candidate's copy of the phase's checks, inside that candidate's own
   * worktree, against its own baseline and artifact directory.
   *
   * The same shape as {@link queueVerification} and for the same reasons — off
   * the lock because a test suite takes as long as a test suite, keyed so a
   * crash mid-verification is re-run by reconcile and a stale report is a no-op
   * — but keyed by candidate as well as attempt, because a candidates phase has
   * `count` independent verdicts rather than one.
   */
  function queueCandidateVerification(
    instanceId: string,
    def: PipelineDefinition,
    phaseId: string,
    attempt: number,
    candidate: number,
  ): void {
    const key = `${instanceId}:${phaseId}:${attempt}:c${candidate}`;
    if (verifying.has(key)) return;
    verifying.add(key);
    const phaseDef = def.phases.find((p) => p.id === phaseId);
    void track(
      (async () => {
        if (!phaseDef) return;
        const inst = await readInstance(instanceId);
        const phase = inst?.phases.find((p) => p.id === phaseId);
        const step = phase?.steps.find((s) => s.candidate === candidate);
        if (!inst || !phase || !step) return;
        const count = phaseDef.checks?.length ?? 0;
        void journal(instanceId, {
          at: nowISO(),
          kind: "phase.verifying",
          phaseId,
          attempt,
          detail: `c${candidate}: ${count} check${count === 1 ? "" : "s"}`,
        });
        let baseline: WorkingTreeSnapshot | null = null;
        try {
          baseline = JSON.parse(
            await readFile(
              phaseBaselinePath(paths.invocationsDir(), instanceId, phaseId, attempt, candidate),
              "utf8",
            ),
          ) as WorkingTreeSnapshot;
        } catch {
          /* no baseline recorded (not a git repository, or no changed-files check) */
        }
        const own = candidateArtifactDir(
          phase.artifactDir ?? phaseArtifactDir(paths.artifactsDir(), instanceId, phaseId),
          candidate,
        );
        const report = await runChecks(phaseDef.checks ?? [], {
          // This candidate's tree, not the phase's: the whole point is that each
          // draft is judged on what it alone did.
          cwd: step.workspace?.path ?? phase.workspace?.path ?? phaseDef.cwd,
          artifactDir: own,
          baseline,
          now: deps.now,
          env: buildChildEnv(parentEnv(), resolveCapabilities(def, phaseDef, {})?.env).env,
          // This candidate's own run, judged on what it alone did.
          trajectoryRuns: () => trajectoryInputs(step.runId ? [step.runId] : []),
        });
        await locks.withLock(instanceId, async () => {
          const fresh = await readLive(instanceId, "candidate-verification");
          if (!fresh || fresh.status !== "running") return;
          const current = fresh.phases.find((p) => p.id === phaseId);
          if (!current || current.attempt !== attempt) return;
          const res = T(applyCandidateVerification(fresh, phaseId, candidate, report, nowISO()));
          if (!res.verificationApplied) return;
          void journal(instanceId, {
            at: nowISO(),
            kind: "phase.verified",
            phaseId,
            attempt,
            detail:
              report.status === "passed"
                ? `c${candidate} passed: ${report.checks.length} check${report.checks.length === 1 ? "" : "s"}${notEvaluated(report.checks)}`
                : `c${candidate} failed: ${report.checks
                    .filter((c) => c.status === "failed")
                    .map((c) => c.label)
                    .join(", ")}`,
          });
          await saveInstance(res.instance);
          await settleCandidates(def, res.instance, phaseId);
          deps.onChange?.();
        });
      })()
        .catch((e: unknown) =>
          log.error("candidate verification failed to run", {
            instanceId,
            phaseId,
            candidate,
            err: e,
          }),
        )
        .finally(() => verifying.delete(key)),
    );
  }

  /** Start the checks a transition asked for, by phase id. */
  function queueVerifications(
    instanceId: string,
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseIds: string[] | undefined,
  ): void {
    for (const id of phaseIds ?? []) {
      const phase = inst.phases.find((p) => p.id === id);
      if (phase) queueVerification(instanceId, def, id, phase.attempt);
    }
  }

  return {
    queueVerification,
    queueCandidateVerification,
    queueVerifications,
  };
}
