import { plannedRemovals, removeWorktree } from "../harness/workspace.js";
import { DEFAULT_MEMORY_BYTES, trimMemoryIfNeeded } from "../harness/memory.js";
import { readPipelines } from "../sources/pipelines.js";
import { journal } from "../sources/journal.js";
import type { PipelineDefinition, PipelineInstance } from "../sources/pipelineTypes.js";
import { log } from "../log.js";
import type { EngineCore, EngineFns } from "./context.js";

/** Saving an instance and the housekeeping a settled one triggers: worktree cleanup, memory trimming, the definition an instance runs against. Moved verbatim from `createEngine`. */
export function createStore(core: EngineCore) {
  const { nowISO, track, persist, cleaned, memoryChecked } = core.ctx;
  const retireStagedDeltas: EngineFns["retireStagedDeltas"] = (...args) =>
    core.fns.retireStagedDeltas(...args);

  /**
   * Persist an instance, and — once it has settled — remove the worktrees it
   * created and trim its pipeline's memory notes if they have grown past cap.
   *
   * Every write of an instance goes through here rather than through
   * `writeInstance` directly, because an instance can reach a terminal status
   * from a dozen places (a signal, a deadline, a failed check, an abort, a
   * reconcile pass), and a cleanup hook on each of them is a cleanup hook
   * somebody eventually forgets. The removal is detached and never throws into
   * the transition that caused it: a worktree Argus cannot delete is a warning
   * in the log, never a pipeline that fails to finish.
   */
  async function saveInstance(inst: PipelineInstance): Promise<void> {
    await retireStagedDeltas(inst);
    await persist.commit(inst);
    if (inst.status === "running" || inst.status === "awaiting-approval") {
      // Alive again — a revise of a failed instance, a scheduled retry. What it
      // creates from here is cleaned up by the settlement that follows.
      cleaned.delete(inst.id);
      memoryChecked.delete(inst.id);
      return;
    }
    if (!memoryChecked.has(inst.id)) {
      memoryChecked.add(inst.id);
      void track(trimMemoryFor(inst));
    }
    if (cleaned.has(inst.id)) return;
    // Steps as well as phases: a candidates phase records a tree per candidate
    // and never one of its own until a winner is chosen, so an instance aborted
    // mid-selection has trees that only the steps know about.
    const anyTree =
      inst.workspace ||
      inst.phases.some((p) => p.workspace || p.steps.some((step) => step.workspace));
    if (!anyTree) return;
    cleaned.add(inst.id);
    void track(cleanupWorkspaces(inst));
  }

  /** Trim one settled instance's pipeline's `NOTES.md` back to its cap, when
   *  `memory` is enabled and the file has grown past it. Never throws — a
   *  file Argus cannot trim is a warning in the log, never a settlement that
   *  fails to finish. */
  async function trimMemoryFor(inst: PipelineInstance): Promise<void> {
    const def = await defFor(inst);
    if (!def?.memory?.enabled) return;
    const cap = def.memory.maxBytes ?? DEFAULT_MEMORY_BYTES;
    try {
      const trimmed = await trimMemoryIfNeeded(def.id, cap);
      if (trimmed) {
        await journal(inst.id, {
          at: nowISO(),
          kind: "memory.trimmed",
          detail: `NOTES.md trimmed to ${cap} bytes`,
        });
      }
    } catch (e) {
      log.warn("pipeline memory could not be trimmed", { pipelineId: def.id, err: e });
    }
  }

  /** Remove every worktree of a settled instance whose policy did not ask for
   *  it to be kept. The branches are never touched: they are the deliverable. */
  async function cleanupWorkspaces(inst: PipelineInstance): Promise<void> {
    const def = await defFor(inst);
    if (!def) return;
    for (const removal of plannedRemovals(def, inst)) {
      await removeWorkspace(inst.id, removal.repoCwd, removal.path, removal.branch);
    }
  }

  /** One worktree, gone. Never throws — a directory Argus could not remove must
   *  not take a transition (or an instance's settlement) down with it. Returns
   *  whether it is actually gone, so a caller that was about to forget the
   *  record can keep it and let the instance's own cleanup try again. */
  async function removeWorkspace(
    instanceId: string,
    repoCwd: string,
    workspacePath: string,
    branch: string,
  ): Promise<boolean> {
    try {
      await removeWorktree({ repoCwd, path: workspacePath });
      // Awaited, unlike the engine's other journal calls: this one runs off the
      // transition path already, and a settled instance's evidence should be on
      // disk by the time `drain()` says the settlement is finished.
      await journal(instanceId, {
        at: nowISO(),
        kind: "workspace.removed",
        detail: `${branch} at ${workspacePath}`,
      });
      return true;
    } catch (e) {
      log.warn("workspace could not be removed", { instanceId, path: workspacePath, err: e });
      return false;
    }
  }

  async function loadDef(pipelineId: string): Promise<PipelineDefinition | undefined> {
    return (await readPipelines()).find((d) => d.id === pipelineId);
  }

  /**
   * The definition an existing instance runs against: the copy it snapshotted
   * when it started. Only `start` reads the live definition; everything after
   * — a signal, an approval, a revise, a retry, a verification, a run healed
   * after a restart — reads the snapshot, so an edit (or a delete) saved
   * mid-flight cannot change what the instance does. An instance written
   * before the snapshot existed has none and falls back to the live definition,
   * which is exactly the behaviour it was started under.
   */
  async function defFor(inst: PipelineInstance): Promise<PipelineDefinition | undefined> {
    return inst.definition ?? (await loadDef(inst.pipelineId));
  }

  return {
    saveInstance,
    trimMemoryFor,
    cleanupWorkspaces,
    removeWorkspace,
    loadDef,
    defFor,
  };
}
