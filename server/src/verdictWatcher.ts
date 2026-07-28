import { performVerdict, readVerdicts, type VerdictDeps } from "./sources/verdict.js";
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
 * must not turn a backlog into a spend spike.
 */

export interface VerdictWatcherDeps extends VerdictDeps {
  readRuns: () => Promise<Run[]>;
  readSchedules: () => Promise<Schedule[]>;
  readPipelines: () => Promise<PipelineDefinition[]>;
  readInstances: () => Promise<PipelineInstance[]>;
  /** The engine's approve, called when a gate's verdict clears its bar. */
  approve: (instanceId: string) => Promise<{ ok: boolean }>;
  onVerdict?: (runId: string) => void;
  onAutoApprove?: (instanceId: string, score: number) => void;
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
 */
export function rubricFor(
  run: Run,
  schedules: Schedule[],
  pipelines: PipelineDefinition[],
): Rubric | null {
  if (run.phaseId) {
    // Step runs carry `scheduleId: "pipeline:<pipelineId>"`.
    const pipelineId = run.scheduleId.startsWith("pipeline:")
      ? run.scheduleId.slice("pipeline:".length)
      : run.scheduleId;
    const phase = pipelines
      .find((p) => p.id === pipelineId)
      ?.phases.find((f) => f.id === run.phaseId);
    return phase?.rubric ?? null;
  }
  return schedules.find((s) => s.id === run.scheduleId)?.rubric ?? null;
}

/** A run worth judging: it finished, and it produced something to judge. */
function isJudgeable(run: Run): boolean {
  return run.status === "succeeded" && (run.resultSummary?.trim().length ?? 0) > 0;
}

export function createVerdictWatcher(deps: VerdictWatcherDeps): { check: () => Promise<void> } {
  return {
    async check(): Promise<void> {
      try {
        const [runs, schedules, pipelines, existing] = await Promise.all([
          deps.readRuns(),
          deps.readSchedules(),
          deps.readPipelines(),
          readVerdicts(),
        ]);
        const scored = new Set(existing.map((v) => v.runId));
        const floor = deps.now().getTime() - VERDICT_MAX_AGE_MS;

        const next = runs
          .filter((r) => isJudgeable(r) && !scored.has(r.id))
          .filter((r) => {
            const at = Date.parse(runMoment(r));
            return Number.isFinite(at) && at >= floor;
          })
          .filter((r) => rubricFor(r, schedules, pipelines) !== null)
          .sort((a, b) => runMoment(b).localeCompare(runMoment(a)))[0];

        if (next) {
          const rubric = rubricFor(next, schedules, pipelines);
          if (rubric) {
            await performVerdict(next, rubric, deps);
            deps.onVerdict?.(next.id);
          }
        }

        await openQualifiedGates(deps, pipelines);
      } catch (e) {
        log.error("verdict check failed", { err: e });
      }
    },
  };
}

/**
 * Open every gate whose phase declares `autoApprove` and whose output has
 * already scored at or above the bar.
 *
 * Two properties this must have and does: a gate with **no verdict yet** waits
 * (silence is not approval), and a gate whose verdict came back *below* the bar
 * also waits, forever, until a human looks at it. Auto-approval can only ever
 * skip the wait for work that has already been judged good.
 */
async function openQualifiedGates(
  deps: VerdictWatcherDeps,
  pipelines: PipelineDefinition[],
): Promise<void> {
  const waiting = (await deps.readInstances()).filter((i) => i.status === "awaiting-approval");
  if (waiting.length === 0) return;
  const verdicts = await readVerdicts();
  const byRun = new Map(verdicts.map((v) => [v.runId, v]));

  for (const inst of waiting) {
    const phase = inst.phases[inst.currentPhaseIndex];
    const def = pipelines.find((p) => p.id === inst.pipelineId);
    const bar = def?.phases.find((p) => p.id === phase?.id)?.autoApprove?.verdict;
    if (bar === undefined || !phase) continue;

    // The phase's own runs, newest first: judge the latest attempt, not the one
    // that was superseded by a revise.
    const scores = phase.steps
      .map((s) => (s.runId ? byRun.get(s.runId) : undefined))
      .filter((v) => v?.status === "ready" && v.score !== null);
    if (scores.length === 0) continue; // not judged yet — silence is not approval

    // Every judged step must clear the bar. A pipeline phase is only as good as
    // its worst step, and averaging would let one excellent step carry a bad one
    // through a gate a human set precisely to catch it.
    const lowest = Math.min(...scores.map((v) => v!.score as number));
    if (lowest < bar) continue;

    try {
      const res = await deps.approve(inst.id);
      if (res.ok) deps.onAutoApprove?.(inst.id, lowest);
    } catch (e) {
      log.error("auto-approve failed", { instanceId: inst.id, err: e });
    }
  }
}
