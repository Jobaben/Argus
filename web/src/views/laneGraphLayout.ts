import type { DsStatus } from "../ds";
import type { RouteEdgeView } from "../ds";
import { graphColumns, graphEdges } from "./phaseGraphLayout";

/**
 * Laying out a pipeline instance as a lane graph: stages are rows, lanes are
 * columns, and every dependency is a drawn edge.
 *
 * The rail this replaces packed one chip per phase into wrapping rows with an
 * arrow between stages. That held a linear pipeline to one card-height, but on
 * a real conditional pipeline it broke the chain wherever the row ran out of
 * width, stacked a fan-out without saying which chip fed which, and put the
 * route condition *inside* the chip — so a phase gated on another phase's
 * verdict carried a chip the width of the sentence.
 *
 * Here the shape is the geometry. A stage (phases that can run together) is a
 * row; the chain that continues stays in lane 0 and leaves hang to the right,
 * so the mainline reads top-down like a git graph. Edges are drawn from the
 * instance's own `needs`, so a join is a join and a fan-out is a fan-out. A
 * condition is a label on the edge it governs, carrying the value alone — the
 * source is the line it sits on. The path that ran is tinted, untaken branches
 * are dashed, and a leaf ends with a terminator.
 *
 * Pure, and separate from the component, because layout is where the
 * off-by-ones live: a label that collides with its sibling, a leaf that is also
 * the last mainline phase, an instance with no edges at all.
 */

/** What the layout needs to know about a phase. */
export interface LanePhase {
  id: string;
  status: DsStatus;
  needs: string[];
  skipped?: boolean;
  /** Incoming edges with their conditions, when the caller has a graph to read. */
  edges?: RouteEdgeView[];
}

/** The geometry every measurement is derived from, in CSS px. */
export interface LaneGeometry {
  /** Width of one node. */
  laneW: number;
  /** Horizontal gap between lanes. */
  laneGap: number;
  /** Height of one node. */
  nodeH: number;
  /** Row gap above a stage whose incoming edges carry a condition label. */
  gapLabelled: number;
  /** Row gap above a stage reached by plain hand-offs only. */
  gapPlain: number;
  /** Padding inside the graph tile. */
  pad: number;
  /** Room left under the last row for a leaf terminator. */
  tail: number;
}

export const LANE_GEOMETRY: LaneGeometry = {
  laneW: 178,
  laneGap: 20,
  nodeH: 30,
  gapLabelled: 36,
  gapPlain: 22,
  pad: 12,
  tail: 10,
};

/** Roughly twelve plain stages; a longer graph scrolls inside its tile. */
export const MAX_TILE_HEIGHT_PX = 640;

/** The tile's border, which a border-box width takes out of the graph's room. */
export const TILE_BORDER_PX = 1;

/** What a classic (non-overlay) vertical scrollbar takes out of the same. */
export const SCROLLBAR_PX = 16;

/**
 * What the tile's own chrome costs the graph horizontally.
 *
 * The graph must never scroll sideways — a pipeline you have to drag to read is
 * not a pipeline at a glance — so the lanes have to be sized for the room left
 * after the border and, on a graph tall enough to scroll, the vertical
 * scrollbar. Both are knowable in one pass: the layout's height does not depend
 * on its lane width, so the tall-graph question is answered before the width is
 * chosen, with no measure-then-resize loop.
 *
 * Sizing is the whole answer only if the numbers are exact, and they are not:
 * a classic scrollbar is 15, 16 or 17px depending on the platform, and device
 * pixels round at fractional display scaling. The tile clips its horizontal
 * overflow for that remainder; this is what keeps the lanes readable, not what
 * keeps the bar away.
 */
export function tileChromeFor(height: number): number {
  return TILE_BORDER_PX * 2 + (height > MAX_TILE_HEIGHT_PX ? SCROLLBAR_PX : 0);
}

/** Lane width by lane count: three lanes side by side need narrower nodes. */
export function laneWidthFor(lanes: number, available?: number): number {
  const ideal = lanes >= 3 ? 150 : LANE_GEOMETRY.laneW;
  if (available == null || available <= 0) return ideal;
  // Fit the container when it is what limits us, never narrower than a name
  // can survive.
  const fit = (available - LANE_GEOMETRY.pad * 2 - (lanes - 1) * LANE_GEOMETRY.laneGap) / lanes;
  return Math.max(110, Math.min(ideal, Math.floor(fit)));
}

export interface LaneNode {
  id: string;
  stage: number;
  lane: number;
  x: number;
  y: number;
  /** No phase depends on this one: the run ends here. */
  leaf: boolean;
}

/**
 * How an edge reads on the board.
 * - `taken`: the source finished and the target was selected — the path that ran.
 * - `skipped`: the source decided against the target.
 * - `pending`: not decided yet.
 */
export type EdgeState = "taken" | "pending" | "skipped";

export interface LaneEdge {
  from: string;
  to: string;
  state: EdgeState;
  /** SVG path data, rounded orthogonal. */
  d: string;
  /** The condition the edge is governed by, positioned on the edge. */
  label: { text: string; x: number; y: number } | null;
}

export interface LaneLayout {
  width: number;
  height: number;
  lanes: number;
  stages: number;
  nodes: LaneNode[];
  edges: LaneEdge[];
}

export function edgeState(source: LanePhase, target: LanePhase): EdgeState {
  if (target.skipped) return "skipped";
  // `idle` is the one status that means "not reached": queued already says
  // the target was selected and is waiting its turn.
  if (source.status === "done" && target.status !== "idle") return "taken";
  return "pending";
}

/** Rounded orthogonal path from a node's bottom centre to another's top centre. */
function edgePath(sx: number, sy: number, tx: number, ty: number, midY: number, r = 7): string {
  if (sx === tx) return `M${sx} ${sy}L${tx} ${ty}`;
  const d = Math.sign(tx - sx);
  return (
    `M${sx} ${sy}L${sx} ${midY - r}Q${sx} ${midY} ${sx + d * r} ${midY}` +
    `L${tx - d * r} ${midY}Q${tx} ${midY} ${tx} ${midY + r}L${tx} ${ty}`
  );
}

/** Estimated rendered width of a label at the graph's 8.5px mono. */
export function labelWidth(text: string): number {
  return text.length * 5.15 + 12;
}

interface PendingLabel {
  edge: number;
  x: number;
  y: number;
  w: number;
  /** Sits on a vertical run, so it must stay centred on its line. */
  straight: boolean;
}

/**
 * Push labels on the same row apart when their boxes would overlap. A label on
 * a straight edge stays centred on its line — moving it would make it look like
 * it belongs to the neighbour — so the branch label is the one that yields.
 */
function spread(labels: PendingLabel[]): void {
  const rows = new Map<number, PendingLabel[]>();
  for (const l of labels) {
    const row = rows.get(l.y);
    if (row) row.push(l);
    else rows.set(l.y, [l]);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const a = row[i - 1];
      const b = row[i];
      const overlap = a.x + a.w / 2 + 6 - (b.x - b.w / 2);
      if (overlap <= 0) continue;
      if (a.straight && !b.straight) b.x += overlap;
      else if (b.straight && !a.straight) a.x -= overlap;
      else {
        a.x -= overlap / 2;
        b.x += overlap / 2;
      }
    }
  }
}

/**
 * Stages for an instance. No edges at all means "unknown", not "one parallel
 * stage" — an instance authored before Weave falls back to one stage per phase
 * in order, joined by implicit hand-offs so the chain still draws.
 */
function stagesOf<T extends LanePhase>(phases: T[]): { stages: T[][]; implicit: boolean } {
  if (graphEdges(phases).length > 0) {
    return { stages: graphColumns(phases).map((c) => c.phases), implicit: false };
  }
  return { stages: phases.map((p) => [p]), implicit: true };
}

export function laneLayout(
  phases: LanePhase[],
  geometry: LaneGeometry = LANE_GEOMETRY,
): LaneLayout {
  const { laneW, laneGap, nodeH, gapLabelled, gapPlain, pad, tail } = geometry;
  if (phases.length === 0) {
    return { width: pad * 2, height: pad * 2, lanes: 0, stages: 0, nodes: [], edges: [] };
  }
  const byId = new Map(phases.map((p) => [p.id, p]));
  const index = new Map(phases.map((p, i) => [p.id, i]));
  const { stages, implicit } = stagesOf(phases);

  // Effective dependencies: the instance's own, or the implicit chain.
  const needsOf = (p: LanePhase): string[] => {
    if (!implicit) return p.needs.filter((n) => byId.has(n));
    const i = index.get(p.id) ?? 0;
    return i === 0 ? [] : [phases[i - 1].id];
  };
  const successors = new Map<string, number>(phases.map((p) => [p.id, 0]));
  for (const p of phases) {
    for (const n of needsOf(p)) successors.set(n, (successors.get(n) ?? 0) + 1);
  }

  // Lanes. Within a stage: phases the chain continues through first, leaves
  // last; among those, follow the parents' lanes so a straight hand-off stays
  // straight; then authored order.
  const laneOf = new Map<string, number>();
  const placed: LaneNode[] = [];
  let lanes = 1;
  const parentLane = (p: LanePhase): number => {
    const ls = needsOf(p)
      .map((n) => laneOf.get(n))
      .filter((l): l is number => l !== undefined);
    return ls.length === 0 ? 0 : ls.reduce((a, b) => a + b, 0) / ls.length;
  };
  const gapBefore: number[] = [];
  stages.forEach((list, s) => {
    const rank = (p: LanePhase): [number, number, number] => [
      (successors.get(p.id) ?? 0) > 0 ? 0 : 1,
      parentLane(p),
      index.get(p.id) ?? 0,
    ];
    const sorted = [...list].sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
    });
    sorted.forEach((p, lane) => {
      laneOf.set(p.id, lane);
      lanes = Math.max(lanes, lane + 1);
    });
    // A stage whose incoming edges carry a condition gets room for the label;
    // a plain hand-off stays tight, so a long linear run does not sprawl.
    const labelled = list.some((p) => (p.edges ?? []).some((e) => e.conditional));
    gapBefore.push(s === 0 ? 0 : labelled ? gapLabelled : gapPlain);
  });

  const x = (lane: number) => pad + lane * (laneW + laneGap);
  const ys: number[] = [];
  let cursor = pad;
  stages.forEach((_, s) => {
    cursor += gapBefore[s];
    ys.push(cursor);
    cursor += nodeH;
  });
  const stageOf = new Map<string, number>();
  stages.forEach((list, s) => list.forEach((p) => stageOf.set(p.id, s)));
  for (const p of phases) {
    const stage = stageOf.get(p.id) ?? 0;
    const lane = laneOf.get(p.id) ?? 0;
    placed.push({
      id: p.id,
      stage,
      lane,
      x: x(lane),
      y: ys[stage],
      leaf: (successors.get(p.id) ?? 0) === 0,
    });
  }
  const nodeOf = new Map(placed.map((n) => [n.id, n]));

  const edges: LaneEdge[] = [];
  const labels: PendingLabel[] = [];
  for (const p of phases) {
    const target = nodeOf.get(p.id)!;
    for (const n of needsOf(p)) {
      const src = byId.get(n);
      const source = nodeOf.get(n);
      if (!src || !source) continue;
      const sx = source.x + laneW / 2;
      const sy = source.y + nodeH;
      const tx = target.x + laneW / 2;
      const ty = target.y;
      const midY = ty - gapBefore[target.stage] / 2;
      const view = (p.edges ?? []).find((e) => e.phase === n);
      const text = view?.conditional ? view.label : null;
      edges.push({
        from: n,
        to: p.id,
        state: edgeState(src, p),
        d: edgePath(sx, sy, tx, ty, midY),
        label: null,
      });
      if (text) {
        labels.push({
          edge: edges.length - 1,
          x: sx === tx ? sx : (sx + tx) / 2,
          y: midY,
          w: labelWidth(text),
          straight: sx === tx,
        });
        edges[edges.length - 1].label = { text, x: 0, y: 0 };
      }
    }
  }
  spread(labels);
  for (const l of labels) {
    const label = edges[l.edge].label!;
    label.x = l.x;
    label.y = l.y;
  }

  return {
    width: pad * 2 + lanes * laneW + (lanes - 1) * laneGap,
    height: cursor + tail + pad,
    lanes,
    stages: stages.length,
    nodes: placed,
    edges,
  };
}
