import type {
  PhaseDef,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
} from "./pipelineTypes.js";

/**
 * Weave: the pipeline as a typed directed acyclic graph.
 *
 * Everything about "which phases may run now" lives here, as pure functions
 * over a definition and an instance. The engine keeps owning processes, locks
 * and slots; it asks this module what to start and never works out the answer
 * itself.
 *
 * The single most important property is the one that costs nothing to state and
 * a great deal to get wrong: **a linear pipeline is a DAG in which each phase
 * needs the one before it**. Nothing authored before Weave declares `needs`, so
 * {@link resolveNeeds} supplies that edge, every existing definition loads
 * unchanged, and the linear behaviour is not a special case in the executor —
 * it is the degenerate shape of the general one.
 *
 * Fan-in is the other half. A phase becomes ready only when *every* dependency
 * has succeeded, which is why readiness is computed from the instance's phase
 * statuses rather than from a cursor. A cursor cannot express "wait for both".
 */

export class DagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagValidationError";
  }
}

/**
 * The dependency edges actually in force.
 *
 * If **no** phase declares `needs`, the definition is linear and each phase
 * inherits an implicit edge from its predecessor. If *any* phase declares
 * `needs`, the graph is taken at face value — a mixed reading, where some
 * phases get implicit predecessors and others don't, would make the same
 * definition mean two different things depending on where you looked.
 */
export function resolveNeeds(phases: PhaseDef[]): Map<string, string[]> {
  const declared = phases.some((p) => p.needs !== undefined);
  const out = new Map<string, string[]>();
  phases.forEach((p, i) => {
    if (declared) out.set(p.id, [...(p.needs ?? [])]);
    else out.set(p.id, i === 0 ? [] : [phases[i - 1].id]);
  });
  return out;
}

/** True when the definition uses explicit edges rather than the linear default. */
export function isExplicitDag(phases: PhaseDef[]): boolean {
  return phases.some((p) => p.needs !== undefined);
}

/**
 * Reject a graph that cannot execute, with a message naming the phase.
 *
 * Called from pipeline validation, so a cycle is a `400` at authoring time
 * rather than an instance that starts and then simply never finishes — which is
 * how a DAG executor fails if nobody checks.
 */
export function validateDag(phases: PhaseDef[]): void {
  const ids = new Set<string>();
  for (const p of phases) {
    if (ids.has(p.id)) throw new DagValidationError(`duplicate phase id "${p.id}"`);
    ids.add(p.id);
  }

  const needs = resolveNeeds(phases);
  for (const [id, deps] of needs) {
    for (const dep of deps) {
      if (dep === id) throw new DagValidationError(`phase "${id}" cannot depend on itself`);
      if (!ids.has(dep)) {
        throw new DagValidationError(`phase "${id}" needs "${dep}", which does not exist`);
      }
    }
    if (new Set(deps).size !== deps.length) {
      throw new DagValidationError(`phase "${id}" lists a dependency twice`);
    }
  }

  // Kahn's algorithm; whatever is left when no node has zero in-degree is a cycle.
  const remaining = new Map(needs);
  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const [id, deps] of remaining) {
      if (deps.every((d) => !remaining.has(d))) {
        remaining.delete(id);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) {
    const names = [...remaining.keys()].sort().join(", ");
    throw new DagValidationError(`phases form a cycle: ${names}`);
  }

  // Every phase must be reachable from a root, or it can never start. An
  // unreachable phase is always a mistake, and always a silent one.
  const roots = phases.filter((p) => (needs.get(p.id) ?? []).length === 0);
  if (phases.length > 0 && roots.length === 0) {
    throw new DagValidationError("no phase can start: every phase depends on another");
  }
}

/**
 * Phases in dependency order, ties broken by declaration order.
 *
 * Used for rendering and for deterministic launch order within a wave. The
 * executor does not depend on this — readiness does — but a stable order means
 * two identical runs launch their steps in the same sequence, which makes logs
 * comparable.
 */
export function topoOrder(phases: PhaseDef[]): PhaseDef[] {
  const needs = resolveNeeds(phases);
  const byId = new Map(phases.map((p) => [p.id, p]));
  const done = new Set<string>();
  const out: PhaseDef[] = [];
  while (out.length < phases.length) {
    const ready = phases.filter(
      (p) => !done.has(p.id) && (needs.get(p.id) ?? []).every((d) => done.has(d)),
    );
    if (ready.length === 0) break; // cycle; validateDag reports it properly
    for (const p of ready) {
      done.add(p.id);
      out.push(byId.get(p.id)!);
    }
  }
  return out;
}

/**
 * Depth layers: phases that can run at the same time.
 *
 * The board draws one column per layer, which is what makes a fan-out read as a
 * fan-out instead of as a list that happens to be in a helpful order.
 */
export function layers(phases: PhaseDef[]): string[][] {
  const needs = resolveNeeds(phases);
  const depth = new Map<string, number>();
  for (const p of topoOrder(phases)) {
    const deps = needs.get(p.id) ?? [];
    depth.set(p.id, deps.length === 0 ? 0 : Math.max(...deps.map((d) => (depth.get(d) ?? 0) + 1)));
  }
  const out: string[][] = [];
  for (const p of phases) {
    const d = depth.get(p.id) ?? 0;
    (out[d] ??= []).push(p.id);
  }
  return out.map((l) => l ?? []);
}

const TERMINAL: ReadonlySet<PhaseProgress["status"]> = new Set(["succeeded", "failed", "aborted"]);

/**
 * The phases that should start now: pending, with every dependency succeeded.
 *
 * Returns indices into `inst.phases` in declaration order, so the caller can
 * launch them without another lookup.
 */
export function readyPhases(def: PipelineDefinition, inst: PipelineInstance): number[] {
  const needs = resolveNeeds(def.phases);
  const statusById = new Map(inst.phases.map((p) => [p.id, p.status]));
  const out: number[] = [];
  inst.phases.forEach((p, i) => {
    if (p.status !== "pending") return;
    const deps = needs.get(p.id) ?? [];
    if (deps.every((d) => statusById.get(d) === "succeeded")) out.push(i);
  });
  return out;
}

/** Phases that are executing or waiting on a human right now. */
export function livePhases(inst: PipelineInstance): number[] {
  return inst.phases
    .map((p, i) => (p.status === "running" || p.status === "awaiting-approval" ? i : -1))
    .filter((i) => i >= 0);
}

/**
 * Whether the instance has finished, and how.
 *
 * `blocked` is the case a cursor-based executor cannot even represent: nothing
 * is running, nothing is ready, and phases remain — which happens when a
 * dependency failed and its dependents can never become ready. Reporting it as
 * a distinct state beats reporting "succeeded" for a pipeline that skipped half
 * its work.
 */
export function instanceOutcome(
  def: PipelineDefinition,
  inst: PipelineInstance,
): "running" | "succeeded" | "blocked" {
  if (livePhases(inst).length > 0) return "running";
  if (readyPhases(def, inst).length > 0) return "running";
  if (inst.phases.every((p) => p.status === "succeeded")) return "succeeded";
  return inst.phases.some((p) => !TERMINAL.has(p.status)) ? "blocked" : "succeeded";
}

/**
 * The index the UI should treat as "the current phase".
 *
 * `currentPhaseIndex` predates the DAG and is load-bearing for every existing
 * view, so rather than removing it, it is redefined as the *most interesting*
 * live phase: a gate waiting on a human first (that is what the reader needs to
 * act on), then anything running, then the last phase that did something.
 */
export function currentIndex(inst: PipelineInstance): number {
  const awaiting = inst.phases.findIndex((p) => p.status === "awaiting-approval");
  if (awaiting !== -1) return awaiting;
  const running = inst.phases.findIndex((p) => p.status === "running");
  if (running !== -1) return running;
  const failed = inst.phases.findIndex((p) => p.status === "failed");
  if (failed !== -1) return failed;
  const lastDone = inst.phases.map((p) => p.status).lastIndexOf("succeeded");
  return lastDone === -1 ? 0 : lastDone;
}

// ── Artifacts ───────────────────────────────────────────────────────────────

/**
 * Interpolate a step prompt.
 *
 * `{{previous.payload}}` is kept exactly as it was — it is in existing
 * definitions — and now means "the payload of this phase's dependency", which
 * for a linear pipeline is the same phase it always was. `{{artifacts.<name>}}`
 * is the DAG-shaped replacement: a phase with two dependencies has no single
 * "previous", so it names what it wants.
 *
 * An unknown artifact interpolates to empty rather than being left as a literal
 * `{{artifacts.foo}}` in the prompt — a template marker reaching the model is
 * worse than a gap, because the model will try to make sense of it.
 */
export function interpolate(
  prompt: string,
  previousPayload: unknown,
  artifacts: Record<string, unknown> = {},
): string {
  const render = (v: unknown): string =>
    v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return prompt
    .replace(/\{\{previous\.payload\}\}/g, render(previousPayload))
    .replace(/\{\{artifacts\.([A-Za-z0-9_-]+)\}\}/g, (_, name: string) => render(artifacts[name]));
}

/** The payload a phase should see as `{{previous.payload}}`: its dependency's,
 *  or — with several — the last one in declaration order, which is the only
 *  stable choice and is why multi-dependency phases should name artifacts. */
export function previousPayloadFor(
  def: PipelineDefinition,
  inst: PipelineInstance,
  phaseId: string,
): unknown {
  const deps = resolveNeeds(def.phases).get(phaseId) ?? [];
  if (deps.length === 0) return null;
  const order = new Map(def.phases.map((p, i) => [p.id, i]));
  const last = [...deps].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).at(-1);
  return inst.phases.find((p) => p.id === last)?.payload ?? null;
}
