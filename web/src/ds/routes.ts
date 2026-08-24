import type { DependencyEdge, PhaseDef, RouteCondition } from "../types";

/**
 * Reading a conditional graph, for the board and the editor.
 *
 * The server decides routes; this only says what a route *means*, in as few
 * characters as a chip can hold. That matters because the question a branching
 * pipeline gets asked is never "what ran" — the board already shows that — but
 * "why did this one not run", and an answer of "idle" is no answer at all.
 *
 * Mirrors two server functions on purpose: `resolveEdges` (the linear default)
 * and `describeCondition` (the one-line reading). Contracts carry the shapes;
 * these two derivations are small enough that sharing them across the wire
 * would cost more than it saves, and both are pinned by tests on each side.
 */

/** A predicate's operator as a symbol: a chip has room for `=`, not `equals`. */
const OPERATOR: Record<string, string> = {
  equals: "=",
  "not-equals": "≠",
  "one-of": "∈",
};

/** One line describing when an edge selects its target. */
export function conditionLabel(when: RouteCondition | undefined): string {
  if (!when) return "always";
  // "otherwise" rather than "default": the reader wants the branch's meaning,
  // and this one means "when none of the others matched".
  if (when.default) return "otherwise";
  const p = when.predicate;
  if (!p) return "never";
  const path = p.path.join(".");
  if (p.operator === "exists") return `${path} exists`;
  return `${path} ${OPERATOR[p.operator] ?? p.operator} ${JSON.stringify(p.value)}`;
}

/**
 * The dependency edges in force, mirroring the server's `resolveEdges`: if no
 * phase declares `needs` the pipeline is linear and each phase implicitly needs
 * the one before it; if any phase declares it, an absent key means "root".
 */
export function effectiveEdges(phases: PhaseDef[]): Map<string, DependencyEdge[]> {
  const declared = phases.some((p) => p.needs !== undefined);
  const out = new Map<string, DependencyEdge[]>();
  phases.forEach((p, i) => {
    if (declared) {
      out.set(
        p.id,
        (p.needs ?? []).map((d) => (typeof d === "string" ? { phase: d } : d)),
      );
    } else out.set(p.id, i === 0 ? [] : [{ phase: phases[i - 1].id }]);
  });
  return out;
}

/** One incoming edge as the UI renders it. */
export interface RouteEdgeView {
  /** The source phase's id. */
  phase: string;
  label: string;
  conditional: boolean;
  allowSkipped: boolean;
}

export function edgeViews(edges: DependencyEdge[]): RouteEdgeView[] {
  return edges.map((edge) => ({
    phase: edge.phase,
    label: conditionLabel(edge.when),
    conditional: edge.when !== undefined,
    allowSkipped: edge.allowSkipped === true,
  }));
}
