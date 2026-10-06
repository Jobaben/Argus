import { killRunProcess } from "../sources/runs.js";
import { readInstance, writeInstance } from "../sources/instances.js";
import { createInstancePersistence } from "./persistence.js";
import { appendTransitionRecord, readTransitionLog } from "../transitionLog/store.js";
import { KeyedMutex } from "../mutex.js";
import { log } from "../log.js";
import type { EngineDeps } from "./types.js";
import { Semaphore } from "./spawn.js";
import type { createStore } from "./store.js";
import type { createLaunch } from "./launch.js";
import type { createRealization } from "./realization.js";
import type { createFailure } from "./failure.js";
import type { createLifecycle } from "./lifecycle.js";
import type { createVerification } from "./verification.js";
import type { createKnowledgeIntake } from "./knowledgeIntake.js";
import type { createKnowledgeCommit } from "./knowledgeCommit.js";
import type { createCandidates } from "./candidates.js";
import type { createSignals } from "./signals.js";
import type { createGates } from "./gates.js";
import type { createReconcile } from "./reconcile.js";

/**
 * The engine's shared state and helpers, built once per engine: the
 * concurrency semaphore, the per-instance locks, the in-memory sets that
 * keep a process from repeating its own work, the clock, the kill seam,
 * the detached-work tracker and the instance persistence. Moved here
 * verbatim from `createEngine`; every engine module receives it as
 * `core.ctx`.
 */
export function createEngineContext(deps: EngineDeps) {
  const sem = new Semaphore(deps.maxConcurrent);
  // Serializes all read-modify-write mutations of a single instance so
  // concurrent signals / reconcile passes cannot lose each other's updates.
  const locks = new KeyedMutex();
  /** Runs spawned by a previous server process, reattached after restart. */
  const adopted = new Map<string, { instanceId: string }>();
  const nowISO = () => deps.now().toISOString();
  const kill = deps.kill ?? killRunProcess;
  const parentEnv = () => deps.parentEnv ?? process.env;
  /** Phase attempts whose checks this process is currently running. */
  const verifying = new Set<string>();
  /** Phase attempts (`instance:phase:attempt`) with a launch queued by this
   *  process, so recovery does not queue a second one beside it. */
  const queuedLaunches = new Set<string>();
  /** Runs this process spawned and is still awaiting the exit of. */
  const live = new Set<string>();
  /** Detached continuations in flight, so `drain` can wait for them. */
  const detached = new Set<Promise<unknown>>();
  function track<T>(p: Promise<T>): Promise<T> {
    detached.add(p);
    void p.finally(() => detached.delete(p)).catch(() => {});
    return p;
  }
  async function drain(): Promise<void> {
    while (detached.size > 0) await Promise.allSettled([...detached]);
  }

  /** Every instance save is a transition commit (engine/persistence.ts). */
  const persist = createInstancePersistence({
    now: deps.now,
    publish: deps.transitionLog?.publish ?? writeInstance,
    readSaved: readInstance,
    append: deps.transitionLog?.append ?? ((record) => appendTransitionRecord(record)),
    readLog: deps.transitionLog?.readLog ?? readTransitionLog,
    onUnattributed:
      deps.onUnattributedTransition ??
      ((instanceId, changes) => {
        // The test preload sets this, so a forgotten transition fails the
        // suite; in production it is recorded on the transition and warned.
        if (process.env.ARGUS_STRICT_TRANSITIONS === "1") {
          throw new Error(
            `unattributed pipeline status change on ${instanceId}: ${changes.join("; ")}`,
          );
        }
        log.warn("pipeline status changed outside a recorded transition", { instanceId, changes });
      }),
    onDegraded: (instanceId, outcome) =>
      log.warn("transition log could not be written; the instance continues degraded", {
        instanceId,
        reason: outcome.reason,
        ...(outcome.reason === "error" ? { err: outcome.error } : {}),
      }),
  });
  /** Hand a transition's events to the commit that will save its result. */
  const T = persist.noteResult;

  /** Instances whose worktrees this process has already cleaned up. */
  const cleaned = new Set<string>();
  /** Instances whose memory notes this process has already trimmed. */
  const memoryChecked = new Set<string>();

  return {
    deps,
    sem,
    locks,
    adopted,
    nowISO,
    kill,
    parentEnv,
    verifying,
    queuedLaunches,
    live,
    detached,
    track,
    drain,
    persist,
    T,
    cleaned,
    memoryChecked,
  };
}

export type EngineContext = ReturnType<typeof createEngineContext>;

/** Every engine module's functions, as the others call them. */
export type EngineFns = ReturnType<typeof createStore> &
  ReturnType<typeof createLaunch> &
  ReturnType<typeof createRealization> &
  ReturnType<typeof createFailure> &
  ReturnType<typeof createLifecycle> &
  ReturnType<typeof createVerification> &
  ReturnType<typeof createKnowledgeIntake> &
  ReturnType<typeof createKnowledgeCommit> &
  ReturnType<typeof createCandidates> &
  ReturnType<typeof createSignals> &
  ReturnType<typeof createGates> &
  ReturnType<typeof createReconcile>;

/**
 * What each engine module is built from: the shared context, and the other
 * modules' functions — bound late, after every module exists, because they
 * call each other in both directions.
 */
export interface EngineCore {
  ctx: EngineContext;
  fns: EngineFns;
}
