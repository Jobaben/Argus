/**
 * The pipeline engine: its public surface, and the wiring of its modules.
 *
 * The engine was one 7,000-line closure; its responsibilities now live in
 * `engine/` — persistence (`store`, `persistence`), process lifecycle
 * (`process`), failure and retry (`failure`), verification, knowledge
 * (`knowledgeIntake`, `knowledgeCommit`), realization, candidates, launch,
 * gates, signals and reconciliation — each a factory over one shared context
 * (`engine/context.ts`). This file keeps every symbol it always exported, and
 * `createEngine` does nothing but build the modules and hand back the Engine.
 */
import type { Engine, EngineDeps } from "./engine/types.js";
import { createEngineContext, type EngineCore, type EngineFns } from "./engine/context.js";
import { createStore } from "./engine/store.js";
import { createLaunch } from "./engine/launch.js";
import { createRealization } from "./engine/realization.js";
import { createFailure } from "./engine/failure.js";
import { createLifecycle } from "./engine/lifecycle.js";
import { createVerification } from "./engine/verification.js";
import { createKnowledgeIntake } from "./engine/knowledgeIntake.js";
import { createKnowledgeCommit } from "./engine/knowledgeCommit.js";
import { createCandidates } from "./engine/candidates.js";
import { createSignals } from "./engine/signals.js";
import { createGates } from "./engine/gates.js";
import { createReconcile } from "./engine/reconcile.js";

export { PreflightError, Semaphore, defaultPipelineSpawn } from "./engine/spawn.js";
export {
  OUTCOME_CONTRACT,
  KNOWLEDGE_DELTA_CONTRACT,
  KNOWLEDGE_CONTEXT_CONTRACT,
  STEP_CONTRACT,
  resultInstruction,
  artifactInstruction,
  memoryInstruction,
  knowledgeContextInstruction,
  buildStepPlan,
  buildClaudeArgs,
} from "./engine/prompts.js";
export { recoverRunOutcome, failureClassOfRecord, retryNote } from "./engine/outcome.js";
export type { RetryNoteInput } from "./engine/outcome.js";
export type {
  PipelineSpawnFn,
  EngineDeps,
  ActionResult,
  GateEffectPoint,
  GateTarget,
  OperatorSource,
  AutomatedApproval,
  Engine,
} from "./engine/types.js";

export function createEngine(deps: EngineDeps): Engine {
  const ctx = createEngineContext(deps);
  // Filled in below, once every module exists: the modules call each other
  // in both directions, so each is handed the object and reads it at call
  // time, never at construction.
  const fns = {} as EngineFns;
  const core: EngineCore = { ctx, fns };
  Object.assign(fns, createStore(core));
  Object.assign(fns, createLaunch(core));
  Object.assign(fns, createRealization(core));
  Object.assign(fns, createFailure(core));
  Object.assign(fns, createLifecycle(core));
  Object.assign(fns, createVerification(core));
  Object.assign(fns, createKnowledgeIntake(core));
  Object.assign(fns, createKnowledgeCommit(core));
  Object.assign(fns, createCandidates(core));
  Object.assign(fns, createSignals(core));
  Object.assign(fns, createGates(core));
  Object.assign(fns, createReconcile(core));

  const { start, onSignal, approve, approveAutomatically, revise, abort, reconcile, adopt } = fns;
  return {
    start,
    onSignal,
    approve,
    approveAutomatically,
    revise,
    abort,
    reconcile,
    adopt,
    drain: ctx.drain,
  };
}
