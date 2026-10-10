import {
  currentVerdicts,
  performVerdict,
  readVerdicts,
  verdictKind,
  type VerdictDeps,
} from "./sources/verdict.js";
import { hasTrajectory } from "./sources/trajectory.js";
import { performTrajectoryVerdict } from "./sources/trajectoryVerdict.js";
import { autoApprovalQualification } from "./sources/gatePolicy.js";
import type { AutomatedApproval } from "./pipelineEngine.js";
import type { PipelineDefinition, PipelineInstance } from "./sources/pipelineTypes.js";
import type { Run, Schedule } from "./sources/scheduleTypes.js";
import type { Rubric } from "@argus/contracts";
import { log } from "./log.js";

/**
 * Scores completed runs against their rubric, and lets a gate open itself when
 * the score clears the bar.
 *
 * Two jobs, one tick, because they are the same fact viewed twice: a phase
 * cannot auto-approve until its output has been judged, and judging happens
 * here.
 *
 * **Why a watcher and not the engine.** Auto-approval could live inside the
 * pipeline engine's signal path, next to the gate it opens. It deliberately
 * doesn't: that path runs under the instance lock, inside a request handler
 * that a child process is still blocked on, and adding a 90-second model call
 * there is how you turn a gate into a deadlock. Judging out here costs at most
 * one scheduler tick of latency and cannot wedge the engine.
 *
 * **One judgement per tick**, matching Autopsy: a rubric on a busy schedule
 * must not turn a backlog into a spend spike. A rubric that declares a
 * trajectory adds at most one trajectory pass per tick, after the output
 * judgment and — because the tick is sequential — before the shadow
 * experiments ask the runner for anything. A trajectory pass the runner
 * refuses as busy or over budget writes nothing and is tried again later.
 */

export interface VerdictWatcherDeps extends VerdictDeps {
  readRuns: () => Promise<Run[]>;
  readSchedules: () => Promise<Schedule[]>;
  readPipelines: () => Promise<PipelineDefinition[]>;
  readInstances: () => Promise<PipelineInstance[]>;
  /**
   * The engine's automated-approval boundary. Never the operator `approve`:
   * that path carries no verdict basis and does not refuse knowledge gates.
   */
  approveAutomatically: (request: AutomatedApproval) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Transcript lines for a run, for trajectory analysis. Absent = no
   * trajectory analysis: a gate whose rubric declares one then never
   * qualifies (it waits for a person), it does not open without it.
   */
  readLines?: (project: string, sessionId: string) => Promise<unknown[]>;
  onVerdict?: (runId: string) => void;
  onAutoApprove?: (instanceId: string, phaseId: string, score: number) => void;
  /**
   * A gate declares `autoApprove` but commits knowledge, so it will wait for a
   * person however well it scores. Reported once per phase attempt (per
   * process), so an author with a legacy definition learns why.
   */
  onAutoApprovalWithheld?: (
    instanceId: string,
    phaseId: string,
    attempt: number,
    reason: string,
  ) => void;
}

/** Runs older than this are not judged on discovery — the score would arrive
 *  long after anyone stopped caring, and still cost money. */
export const VERDICT_MAX_AGE_MS = 24 * 3_600_000;

const runMoment = (r: Run): string => r.endedAt ?? r.startedAt ?? r.queuedAt;

/**
 * The rubric that applies to a run: its schedule's, or — for a pipeline step —
 * the phase's. Exported because "which rubric governs this run" is exactly the
 * kind of lookup that goes subtly wrong when a pipeline is renamed or a phase
 * removed, and it deserves its own tests.
 *
 * A step run is judged by the rubric its *instance* started with — the
 * definition snapshotted on the instance — so a rubric edited after the run
 * launched does not move the bar under it. The live definition is only
 * consulted for instances written before the snapshot existed.
 */
export function rubricFor(
  run: Run,
  schedules: Schedule[],
  pipelines: PipelineDefinition[],
  instances: PipelineInstance[] = [],
): Rubric | null {
  if (run.phaseId) {
    // Step runs carry `scheduleId: "pipeline:<pipelineId>"`.
    const pipelineId = run.scheduleId.startsWith("pipeline:")
      ? run.scheduleId.slice("pipeline:".length)
      : run.scheduleId;
    const def =
      instances.find((i) => i.id === run.instanceId)?.definition ??
      pipelines.find((p) => p.id === pipelineId);
    const phase = def?.phases.find((f) => f.id === run.phaseId);
    return phase?.rubric ?? null;
  }
  return schedules.find((s) => s.id === run.scheduleId)?.rubric ?? null;
}

/** A run worth judging: it finished, and it produced something to judge. */
function isJudgeable(run: Run): boolean {
  return run.status === "succeeded" && (run.resultSummary?.trim().length ?? 0) > 0;
}

export function createVerdictWatcher(deps: VerdictWatcherDeps): { check: () => Promise<void> } {
  const withheld = new Set<string>();
  return {
    async check(): Promise<void> {
      try {
        const [runs, schedules, pipelines, instances, existing] = await Promise.all([
          deps.readRuns(),
          deps.readSchedules(),
          deps.readPipelines(),
          deps.readInstances(),
          readVerdicts(),
        ]);
        const scored = new Set(
          existing.filter((v) => verdictKind(v) === "output").map((v) => v.runId),
        );
        const traced = new Set(
          existing.filter((v) => verdictKind(v) === "trajectory").map((v) => v.runId),
        );
        const floor = deps.now().getTime() - VERDICT_MAX_AGE_MS;

        const next = runs
          .filter((r) => isJudgeable(r) && !scored.has(r.id))
          .filter((r) => {
            const at = Date.parse(runMoment(r));
            return Number.isFinite(at) && at >= floor;
          })
          .filter((r) => rubricFor(r, schedules, pipelines, instances) !== null)
          .sort((a, b) => runMoment(b).localeCompare(runMoment(a)))[0];

        if (next) {
          const rubric = rubricFor(next, schedules, pipelines, instances);
          if (rubric) {
            await performVerdict(next, rubric, deps);
            deps.onVerdict?.(next.id);
          }
        }

        const readLines = deps.readLines;
        if (readLines) {
          const trace = runs
            .filter((r) => r.status === "succeeded" && !traced.has(r.id))
            .filter((r) => {
              const at = Date.parse(runMoment(r));
              return Number.isFinite(at) && at >= floor;
            })
            .filter((r) => hasTrajectory(rubricFor(r, schedules, pipelines, instances)))
            .sort((a, b) => runMoment(b).localeCompare(runMoment(a)))[0];
          if (trace) {
            const rubric = rubricFor(trace, schedules, pipelines, instances);
            if (rubric && (await performTrajectoryVerdict(trace, rubric, { ...deps, readLines }))) {
              deps.onVerdict?.(trace.id);
            }
          }
        }

        await openQualifiedGates(deps, pipelines, instances, withheld);
      } catch (e) {
        log.error("verdict check failed", { err: e });
      }
    },
  };
}

/**
 * Open every gate whose phase declares `autoApprove` and whose output has
 * already been judged, completely and currently, at or above the bar.
 *
 * What must hold, per waiting phase attempt — anything less and the gate waits
 * for a person (silence is not approval):
 *
 * - the gate commits no knowledge, by configuration or by what the attempt
 *   staged (`sources/gatePolicy.ts`). A model's rating of an agent's message
 *   never makes semantic knowledge canonical, however high;
 * - every relevant step (`gateRelevantSteps`) succeeded and has a run;
 * - every one of those runs has a **current** verdict — its newest judgment —
 *   that is `ready`, has a score, and was produced under the rubric this
 *   instance's own definition carries (by digest). A step with no verdict, a
 *   failed or skipped judgment, or a judgment under a different rubric holds
 *   the gate; averaging over the steps that happen to be judged is exactly
 *   the hole a gate exists to close;
 * - the lowest of those scores clears the bar. A phase is only as good as its
 *   worst step;
 * - when the rubric declares a trajectory, every one of those runs also has a
 *   current, usable trajectory judgment under the rubric's trajectory digest:
 *   its check held nothing and its score (if judged) clears the trajectory
 *   bar. A skipped, failed, missing or pruned trajectory judgment holds the
 *   gate. That basis is sent separately from the output basis.
 *
 * Every waiting phase is considered, not only `currentPhaseIndex`: a fan-out
 * can pause several at once. The approval names the exact phase, attempt,
 * runs and verdicts, and the engine re-checks all of it under the instance
 * lock before recording anything.
 */
async function openQualifiedGates(
  deps: VerdictWatcherDeps,
  pipelines: PipelineDefinition[],
  instances: PipelineInstance[],
  withheld: Set<string>,
): Promise<void> {
  // `settle` keeps the instance status `awaiting-approval` exactly while some
  // phase is waiting; the engine re-checks the phase itself under its lock.
  const live = instances.filter((i) => i.status === "awaiting-approval");
  if (live.length === 0) return;
  const all = await readVerdicts();
  const byRun = new Map(currentVerdicts(all).map((v) => [v.runId, v]));
  const trajectoryByRun = new Map(currentVerdicts(all, "trajectory").map((v) => [v.runId, v]));

  for (const inst of live) {
    // The bar and rubric the gate was authored with, from the instance's own
    // snapshot — a definition edited since cannot move them.
    const def = inst.definition ?? pipelines.find((p) => p.id === inst.pipelineId);
    for (const phase of inst.phases) {
      // Only a gate pause: a `needs-input` pause is a question for a person,
      // and a pause of unknown cause (written before causes were recorded)
      // is treated as one. A pre-check only, over what this tick read: the
      // engine decides again, from the verdict store under its lock, and
      // records the basis from the stored verdicts — this request only names
      // which ones.
      const q = autoApprovalQualification(
        phase,
        def?.phases.find((p) => p.id === phase.id),
        byRun,
        trajectoryByRun,
      );
      if (q.status === "ineligible" && q.cause === "knowledge") {
        const key = `${inst.id}|${phase.id}|${phase.attempt}`;
        if (!withheld.has(key)) {
          withheld.add(key);
          deps.onAutoApprovalWithheld?.(
            inst.id,
            phase.id,
            phase.attempt,
            `autoApprove is not applied: this gate commits knowledge (${q.reasons.join(", ")}) ` +
              "and needs a person",
          );
        }
        continue;
      }
      // Not completely judged yet, not configured, or below the bar.
      if (q.status !== "qualifies") continue;
      const basis: AutomatedApproval["verdicts"] = q.basis.map((b) => ({
        runId: b.runId,
        verdictId: b.verdictId,
      }));
      const lowest = q.lowest;

      try {
        const res = await deps.approveAutomatically({
          instanceId: inst.id,
          phaseId: phase.id,
          attempt: phase.attempt,
          runIds: basis.map((b) => b.runId),
          verdicts: basis,
          ...(q.trajectory
            ? {
                trajectoryVerdicts: q.trajectory.basis.map((b) => ({
                  runId: b.runId,
                  verdictId: b.verdictId,
                })),
              }
            : {}),
        });
        if (res.ok) deps.onAutoApprove?.(inst.id, phase.id, lowest);
        else
          log.warn("auto-approve refused", {
            instanceId: inst.id,
            phaseId: phase.id,
            error: res.error,
          });
      } catch (e) {
        log.error("auto-approve failed", { instanceId: inst.id, phaseId: phase.id, err: e });
      }
    }
  }
}
