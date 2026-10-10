import { readRun } from "../sources/runs.js";
import { workspacePolicyFor } from "../harness/workspace.js";
import {
  applyCandidateSelection,
  applyCandidatesExhausted,
  candidateFailureClass,
  candidateFailureReason,
  candidateRecordOf,
  selectCandidate,
  toCandidateOutcomes,
  applyCandidateTreesRemoved,
} from "../pipelineTransitions.js";
import { journal } from "../sources/journal.js";
import type {
  PhaseDef,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
} from "../sources/pipelineTypes.js";
import type { CandidateRecord, TransitionResult } from "../pipelineTransitions.js";
import type { EngineCore, EngineFns } from "./context.js";

/** Best-of-N: selecting a candidate, or failing the phase when none can win. Moved verbatim from `createEngine`. */
export function createCandidates(core: EngineCore) {
  const { deps, nowISO, T } = core.ctx;
  const noteFailure: EngineFns["noteFailure"] = (...args) => core.fns.noteFailure(...args);
  const noteRouting: EngineFns["noteRouting"] = (...args) => core.fns.noteRouting(...args);
  const queueReadyPhases: EngineFns["queueReadyPhases"] = (...args) =>
    core.fns.queueReadyPhases(...args);
  const removeWorkspace: EngineFns["removeWorkspace"] = (...args) =>
    core.fns.removeWorkspace(...args);
  const saveInstance: EngineFns["saveInstance"] = (...args) => core.fns.saveInstance(...args);
  const settleKnowledge: EngineFns["settleKnowledge"] = (...args) =>
    core.fns.settleKnowledge(...args);
  const settleRealizations: EngineFns["settleRealizations"] = (...args) =>
    core.fns.settleRealizations(...args);
  const terminateRun: EngineFns["terminateRun"] = (...args) => core.fns.terminateRun(...args);

  // ── Candidates ─────────────────────────────────────────────────────────────

  /**
   * Every candidate of a phase, as the selectors need to read it: what the
   * instance persisted, joined with what the run records say it cost.
   *
   * The join lives here rather than in the transitions because cost and
   * duration are not on the instance — they are read off the run at display
   * time — and `cheapest-verified` is precisely a rule about them.
   */
  async function candidateRecordsFor(phase: PhaseProgress): Promise<CandidateRecord[]> {
    const records: CandidateRecord[] = [];
    for (const step of phase.steps) {
      if (step.candidate === undefined) continue;
      const got = step.runId ? await readRun(step.runId) : null;
      records.push({
        ...candidateRecordOf(step),
        costUsd: got?.run.costUsd ?? null,
        durationMs: got?.run.durationMs ?? null,
        runtime: got?.run.runtime ?? null,
        model: got?.run.model ?? null,
      });
    }
    return records;
  }

  /** Remove the worktrees of the candidates that did not win. The branches
   *  survive, as everywhere else: a losing draft is still evidence, and a
   *  `keep` policy keeps its directory too. */
  async function removeCandidateTrees(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseDef: PhaseDef,
    phase: PhaseProgress,
    keptCandidate: number | null,
  ): Promise<void> {
    if (workspacePolicyFor(def, phaseDef)?.keep === true) return;
    const removed: number[] = [];
    for (const step of phase.steps) {
      if (step.candidate === undefined || step.candidate === keptCandidate) continue;
      if (!step.workspace) continue;
      const tree = step.workspace;
      // The record is only forgotten once the directory is: a tree the kill
      // raced (the agent still writing as git was asked to take it away) stays
      // on the step, and the instance's own cleanup collects it at settlement.
      if (await removeWorkspace(inst.id, phaseDef.cwd, tree.path, tree.branch)) {
        removed.push(step.candidate);
      }
    }
    T(applyCandidateTreesRemoved(inst, phase.id, removed));
  }

  /**
   * Ask a candidates phase whether it has an answer yet, and act on it.
   *
   * Called after anything that could move a candidate — a signal, a report from
   * its checks, a deadline, a run found dead after a restart — always under the
   * instance lock, with the in-memory instance. Three outcomes, and the first is
   * the common one:
   *
   *  - nothing decided yet, so nothing happens;
   *  - a winner, whose worktree, payload, result and verification become the
   *    phase's; the siblings still running are killed (`first-verified` exists
   *    to stop paying for them) and their trees removed;
   *  - nobody left who could win, so the phase fails once, with every
   *    candidate's fate in the reason and the retry policy applied as usual.
   */
  async function settleCandidates(
    def: PipelineDefinition,
    inst: PipelineInstance,
    phaseId: string,
  ): Promise<void> {
    const phase = inst.phases.find((p) => p.id === phaseId);
    const phaseDef = def.phases.find((p) => p.id === phaseId);
    if (!phase || !phaseDef?.candidates || phase.status !== "running") return;
    const records = await candidateRecordsFor(phase);
    const decision = selectCandidate(phaseDef.candidates, records);
    if (decision.kind === "pending") return;
    const outcomes = toCandidateOutcomes(records);

    let res: TransitionResult;
    if (decision.kind === "selected") {
      const winner = decision.candidate;
      // Kill first, transition second: the reason is written onto the run
      // record before the process dies, so the close handler reports "superseded
      // by candidate k" rather than inventing something from an exit code.
      for (const step of phase.steps) {
        if (step.candidate === undefined || step.candidate === winner || !step.runId) continue;
        await terminateRun(step.runId, `superseded by candidate ${winner}`, "killed");
        deps.tailer?.untrack(step.runId);
      }
      await removeCandidateTrees(def, inst, phaseDef, phase, winner);
      res = T(applyCandidateSelection(def, inst, phaseId, winner, outcomes, nowISO()));
      void journal(inst.id, {
        at: nowISO(),
        kind: "phase.candidate-selected",
        phaseId,
        attempt: phase.attempt,
        detail: `c${winner} of ${records.length} (${phaseDef.candidates.select})`,
      });
      res = await settleKnowledge(def, res);
      res = await settleRealizations(def, res);
    } else {
      const failureClass = candidateFailureClass(records);
      const reason = candidateFailureReason(records);
      await removeCandidateTrees(def, inst, phaseDef, phase, null);
      res = T(
        applyCandidatesExhausted(def, inst, phaseId, failureClass, reason, outcomes, nowISO()),
      );
      if (failureClass === "configuration") {
        // Every candidate was refused as declared, so the definition is what is
        // wrong and another attempt cannot help. Journalled, never retried.
        void journal(inst.id, {
          at: nowISO(),
          kind: "phase.failed",
          phaseId,
          attempt: phase.attempt,
          detail: `configuration: ${reason}`,
        });
      } else {
        // The class is already on the payload; this is what schedules the retry
        // and writes the `phase.failed` entry, exactly as for any other failure.
        noteFailure(def, res.instance, phaseId, failureClass, reason);
      }
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

  return {
    candidateRecordsFor,
    removeCandidateTrees,
    settleCandidates,
  };
}
