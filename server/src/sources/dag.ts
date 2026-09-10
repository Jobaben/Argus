import type {
  DependencyEdge,
  PhaseDef,
  PhaseStatus,
  PipelineDefinition,
  PipelineInstance,
  RouteCondition,
  RouteDecision,
} from "./pipelineTypes.js";
import { normalizeNeeds } from "./routing.js";

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
 *
 * Routing adds one idea to that and no more: an edge can carry a condition, so
 * readiness is computed over edges rather than over dependency *names*. An edge
 * has four possible states ({@link edgeState}) and only one of them is new —
 * `routed-out`, "this work was deliberately not selected". Keeping it distinct
 * from `blocked` is what preserves every existing pipeline exactly: a failed
 * dependency still leaves its dependents pending and the instance failed, while
 * an unselected one is skipped and the instance can still succeed.
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
export function resolveEdges(phases: PhaseDef[]): Map<string, DependencyEdge[]> {
  const declared = phases.some((p) => p.needs !== undefined);
  const out = new Map<string, DependencyEdge[]>();
  phases.forEach((p, i) => {
    if (declared) out.set(p.id, normalizeNeeds(p.needs));
    else out.set(p.id, i === 0 ? [] : [{ phase: phases[i - 1].id }]);
  });
  return out;
}

/**
 * The same edges as dependency ids, for everything that only needs the shape of
 * the graph: topology, layers, the board's drawn arrows.
 *
 * Derived from {@link resolveEdges} rather than computed separately, so a
 * condition can never be visible to one and invisible to the other.
 */
export function resolveNeeds(phases: PhaseDef[]): Map<string, string[]> {
  return new Map(
    [...resolveEdges(phases)].map(([id, edges]) => [id, edges.map((edge) => edge.phase)]),
  );
}

/** Every edge pointing *out* of one phase, as routes to its targets, in
 *  definition order — the order route evaluation is specified to use. */
export function outgoingEdges(phases: PhaseDef[], sourceId: string): DependencyEdge[] {
  const edges = resolveEdges(phases);
  const out: DependencyEdge[] = [];
  for (const target of phases) {
    for (const edge of edges.get(target.id) ?? []) {
      if (edge.phase !== sourceId) continue;
      out.push({
        phase: target.id,
        ...(edge.when ? { when: edge.when } : {}),
        ...(edge.allowSkipped ? { allowSkipped: true } : {}),
      });
    }
  }
  return out;
}

/**
 * What one incoming edge currently says about its target.
 *
 * `satisfied` — go. `blocked` — the source failed or was aborted, so the target
 * can never run and the instance is failing; it stays pending, exactly as it did
 * before routing existed. `routed-out` — the source succeeded but did not select
 * this target, so the target is deliberately skipped. `unknown` — the source has
 * not finished, or has finished but its decision has not been recorded yet.
 */
export type EdgeState = "satisfied" | "routed-out" | "blocked" | "unknown";

export function edgeState(
  edge: DependencyEdge,
  target: string,
  statusById: Map<string, PhaseStatus>,
  decisions: Map<string, RouteDecision>,
): EdgeState {
  const status = statusById.get(edge.phase);
  if (status === "failed" || status === "aborted") return "blocked";
  // An explicitly skip-tolerant edge is how a join after alternatives stops
  // waiting for the branch that was never going to run.
  if (status === "skipped") return edge.allowSkipped ? "satisfied" : "routed-out";
  if (status !== "succeeded") return "unknown";
  if (!edge.when) return "satisfied";
  const decision = decisions.get(edge.phase);
  if (!decision) return "unknown";
  return decision.selected.includes(target) ? "satisfied" : "routed-out";
}

/** The recorded decisions by source phase — the only routing input readiness has. */
export function decisionsBySource(inst: PipelineInstance): Map<string, RouteDecision> {
  return new Map((inst.routeDecisions ?? []).map((d) => [d.sourcePhase, d]));
}

function edgeStatesFor(def: PipelineDefinition, inst: PipelineInstance): Map<string, EdgeState[]> {
  const edges = resolveEdges(def.phases);
  const statusById = new Map(inst.phases.map((p) => [p.id, p.status]));
  const decisions = decisionsBySource(inst);
  return new Map(
    inst.phases.map((p) => [
      p.id,
      (edges.get(p.id) ?? []).map((edge) => edgeState(edge, p.id, statusById, decisions)),
    ]),
  );
}

/** A one-line description of an edge's condition, for records and labels. */
export function describeCondition(when: RouteCondition | undefined): string {
  if (!when) return "always";
  if (when.default) return "default";
  const p = when.predicate;
  if (!p) return "never";
  const path = p.path.join(".");
  return p.operator === "exists"
    ? `${path} exists`
    : `${path} ${p.operator} ${JSON.stringify(p.value)}`;
}

/**
 * The one step of a phase allowed to publish its declared result.
 *
 * A single-step phase needs no ceremony; beyond that the definition names the
 * step, because two concurrent siblings racing to write one phase-level
 * decision is not a routing rule — it is a coin toss. Null when the phase
 * declares no result at all.
 */
export function resultStepName(phase: PhaseDef): string | null {
  if (!phase.result) return null;
  return phase.result.resultStep ?? phase.steps[0]?.name ?? null;
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

/**
 * The phases that should start now: pending, with every dependency succeeded.
 *
 * Returns indices into `inst.phases` in declaration order, so the caller can
 * launch them without another lookup.
 */
export function readyPhases(def: PipelineDefinition, inst: PipelineInstance): number[] {
  const states = edgeStatesFor(def, inst);
  const out: number[] = [];
  inst.phases.forEach((p, i) => {
    if (p.status !== "pending") return;
    if ((states.get(p.id) ?? []).every((state) => state === "satisfied")) out.push(i);
  });
  return out;
}

/**
 * The phases routing has decided will not run.
 *
 * A target is skipped only once **every** incoming edge is known: a phase with
 * one routed-out edge and one dependency still running has not been decided
 * yet, and skipping it early would cancel work its other dependency was about
 * to authorize. A single blocked edge keeps the phase pending instead — a
 * failure upstream is a failing instance, never a tidy skip.
 */
export function skippablePhases(def: PipelineDefinition, inst: PipelineInstance): number[] {
  const states = edgeStatesFor(def, inst);
  const out: number[] = [];
  inst.phases.forEach((p, i) => {
    if (p.status !== "pending") return;
    const mine = states.get(p.id) ?? [];
    if (mine.length === 0) return;
    if (mine.some((state) => state === "unknown" || state === "blocked")) return;
    if (mine.some((state) => state === "routed-out")) out.push(i);
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
  // Terminal and intentional: a skipped phase is work routing decided against,
  // so an instance whose every phase either succeeded or was deliberately
  // skipped has done exactly what it was asked to do.
  if (inst.phases.every((p) => p.status === "succeeded" || p.status === "skipped")) {
    return "succeeded";
  }
  // Nothing can progress and at least one phase did not succeed. This includes
  // both a failed dependency with pending descendants and a fully-settled graph
  // containing a failed branch; neither may be rubber-stamped as succeeded.
  return "blocked";
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
export interface ArtifactDirs {
  /** This phase's own artifact directory. */
  own: string | null;
  /** Every phase's artifact directory so far, by phase id. */
  byPhase: Record<string, string>;
}

/**
 * Render a step prompt: `{{previous.payload}}`, `{{artifacts.<name>}}`,
 * `{{artifactDir}}` (this phase's file-artifact directory) and
 * `{{artifactDir.<phaseId>}}` (an earlier phase's). Directories are the
 * file-based counterpart of payload artifacts — a plan or an investigation is
 * handed on as a path the next agent reads, not as text pasted into its prompt.
 */
export function interpolate(
  prompt: string,
  previousPayload: unknown,
  artifacts: Record<string, unknown> = {},
  dirs: ArtifactDirs = { own: null, byPhase: {} },
): string {
  const render = (v: unknown): string =>
    v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return prompt
    .replace(/\{\{previous\.payload\}\}/g, render(previousPayload))
    .replace(/\{\{artifacts\.([A-Za-z0-9_-]+)\}\}/g, (_, name: string) => render(artifacts[name]))
    .replace(/\{\{artifactDir\.([A-Za-z0-9_-]+)\}\}/g, (_, id: string) => dirs.byPhase[id] ?? "")
    .replace(/\{\{artifactDir\}\}/g, dirs.own ?? "");
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
