/** The only thing layout needs from a phase. */
export interface GraphNode {
  id: string;
  needs?: string[];
}

/**
 * Laying out a pipeline's phase graph, from the instance alone.
 *
 * The instance carries each phase's resolved `needs`, so the board never has to
 * fetch the definition to draw the shape — which also means an instance that
 * started before its definition was edited still renders the graph it actually
 * ran, not the one that exists now.
 *
 * Pure, and separate from the component, because graph layout is where the
 * off-by-ones live: a phase with no `needs` and a phase whose `needs` are all
 * missing look the same in a rendered DOM and are very different bugs.
 */

export interface GraphColumn<T extends GraphNode> {
  /** Depth from the roots. Column 0 is what starts first. */
  depth: number;
  phases: T[];
}

/** Edges the graph should draw, as (from, to) phase ids. */
export interface GraphEdge {
  from: string;
  to: string;
}

/**
 * Columns of phases that can run at the same time.
 *
 * A phase's depth is one past its deepest dependency. Dependencies that don't
 * exist in the instance (a definition edited mid-flight) are ignored rather
 * than treated as depth zero — otherwise a stale edge would drag a late phase
 * to the front of the graph.
 */
export function graphColumns<T extends GraphNode>(phases: T[]): GraphColumn<T>[] {
  const known = new Set(phases.map((p) => p.id));
  const depth = new Map<string, number>();

  // Iterate to a fixed point rather than recursing: cheap at this size, and a
  // cycle (which the server rejects, but a hand-edited file might not) settles
  // instead of overflowing the stack.
  for (let pass = 0; pass < phases.length + 1; pass++) {
    let moved = false;
    for (const p of phases) {
      const deps = (p.needs ?? []).filter((d) => known.has(d));
      const next = deps.length === 0 ? 0 : Math.max(...deps.map((d) => (depth.get(d) ?? 0) + 1));
      if (depth.get(p.id) !== next) {
        depth.set(p.id, next);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const byDepth = new Map<number, T[]>();
  for (const p of phases) {
    const d = depth.get(p.id) ?? 0;
    byDepth.set(d, [...(byDepth.get(d) ?? []), p]);
  }
  return [...byDepth.entries()]
    .sort(([a], [b]) => a - b)
    .map(([depth, phases]) => ({ depth, phases }));
}

/** Every dependency edge that both ends of exist. */
export function graphEdges(phases: GraphNode[]): GraphEdge[] {
  const known = new Set(phases.map((p) => p.id));
  return phases.flatMap((p) =>
    (p.needs ?? []).filter((d) => known.has(d)).map((from) => ({ from, to: p.id })),
  );
}

/**
 * Whether this instance is worth drawing as a graph.
 *
 * Two conditions, and the second is the one that is easy to miss. A linear
 * pipeline is a DAG, but drawing it as one is worse than drawing it as a list:
 * a single column per phase says "graph" and shows nothing a row of pills
 * didn't. So the graph needs a column with more than one phase.
 *
 * It *also* needs at least one edge. A phase list carrying no dependency
 * information at all — an instance written before Weave, or a definition
 * summary that never had it — collapses to one column containing everything,
 * which looks exactly like a total fan-out and is nothing of the kind. Absent
 * edges mean "unknown", not "parallel", and drawing a five-way fan-out for a
 * plain linear pipeline is the worst possible reading of that.
 */
export function isBranching(phases: GraphNode[]): boolean {
  if (graphEdges(phases).length === 0) return false;
  return graphColumns(phases).some((c) => c.phases.length > 1);
}
