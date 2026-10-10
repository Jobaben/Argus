import type { DsStatus } from "../ds";
import type { RouteEdgeView } from "../ds";
import type { DagLayoutEngine, Orientation } from "./dagLayout";
import { roundedOrthogonalPath } from "./edgePath";
import { graphEdges } from "./phaseGraphLayout";
import { sugiyamaLayout } from "./sugiyamaLayout";

/**
 * Laying out a pipeline instance as a lane graph: stages are ranks, every
 * dependency is a drawn edge.
 *
 * The rail this replaces packed one chip per phase into wrapping rows with an
 * arrow between stages. That held a linear pipeline to one card-height, but on
 * a real conditional pipeline it broke the chain wherever the row ran out of
 * width, stacked a fan-out without saying which chip fed which, and put the
 * route condition *inside* the chip — so a phase gated on another phase's
 * verdict carried a chip the width of the sentence.
 *
 * Here the shape is the geometry. A stage (phases that can run together) is a
 * rank; the chain that continues stays in lane 0 and leaves hang beside it, so
 * the mainline reads like a git graph. Edges are drawn from the instance's own
 * `needs`, so a join is a join and a fan-out is a fan-out. A condition is a
 * label on the edge it governs, carrying the value alone — the source is the
 * line it sits on. The path that ran is tinted, untaken branches are dashed,
 * and a leaf ends with a terminator.
 *
 * This is the adapter between phases and a {@link DagLayoutEngine}: it decides
 * sizes, gaps and labels, and the engine decides where things go. Pure, and
 * separate from the component, because layout is where the off-by-ones live.
 */

/** What the layout needs to know about a phase. */
export interface LanePhase {
  id: string;
  name?: string;
  status: DsStatus;
  needs: string[];
  skipped?: boolean;
  /** Incoming edges with their conditions, when the caller has a graph to read. */
  edges?: RouteEdgeView[];
}

/** The geometry every measurement is derived from, in CSS px. */
export interface LaneGeometry {
  /** Gap between neighbouring lanes. */
  laneGap: number;
  /** Height of one node. */
  nodeH: number;
  /** Gap in front of a stage whose incoming edges carry a condition label. */
  gapLabelled: number;
  /** Gap in front of a stage reached by plain hand-offs only. */
  gapPlain: number;
  /** Padding inside the graph. */
  pad: number;
  /** Room after the last stage for a leaf terminator. */
  tail: number;
}

export const LANE_GEOMETRY: LaneGeometry = {
  laneGap: 20,
  nodeH: 30,
  gapLabelled: 36,
  gapPlain: 22,
  pad: 12,
  tail: 10,
};

/** Roughly twelve plain stages; a longer graph scrolls inside its tile. */
export const MAX_TILE_HEIGHT_PX = 640;

/** The furthest fit-to-view shrinks a graph before it scrolls instead. */
export const MIN_SCALE = 0.6;

export const NODE_MIN_W = 160;
export const NODE_MAX_W = 240;

/** Height of a route label, for spreading labels stacked along a column. */
const LABEL_H = 14;

/**
 * Node width for a set of names: the longest name plus the node's own chrome
 * (dot, index, markers), estimated rather than measured so layout never reads
 * the DOM. Clamped, so one long name cannot make every node a banner.
 */
export function nodeWidthFor(names: string[]): number {
  const longest = Math.max(0, ...names.map((n) => n.length));
  return Math.round(Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, longest * 6.4 + 64)));
}

/**
 * Top-down when that fits, left-to-right when only that fits, otherwise
 * whichever overflows less. A wide fan-out is the case this exists for: eight
 * parallel phases are a long row top-down and a short column left-to-right.
 * Unmeasured (first paint, jsdom) means unknown, and gets top-down.
 */
export function chooseOrientation(
  tb: { width: number; height: number },
  lr: { width: number; height: number },
  availW: number,
): Orientation {
  if (availW <= 0 || tb.width <= availW) return "TB";
  if (lr.width <= availW) return "LR";
  const overflow = (l: { width: number; height: number }) =>
    Math.max(0, l.width - availW) * l.height;
  return overflow(lr) < overflow(tb) ? "LR" : "TB";
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
  orientation: Orientation;
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
  lanes: number;
  stages: number;
  nodes: LaneNode[];
  edges: LaneEdge[];
}

export interface LaneOptions {
  orientation?: Orientation;
  geometry?: LaneGeometry;
  /** Overrides the width estimated from the phase names. */
  nodeW?: number;
}

export function edgeState(source: LanePhase, target: LanePhase): EdgeState {
  if (target.skipped) return "skipped";
  // `idle` is the one status that means "not reached": queued already says
  // the target was selected and is waiting its turn.
  if (source.status === "done" && target.status !== "idle") return "taken";
  return "pending";
}

/** Estimated rendered width of a label at the graph's 8.5px mono. */
export function labelWidth(text: string): number {
  return text.length * 5.15 + 12;
}

interface PendingLabel {
  edge: number;
  /** Position along the gap the label sits in. */
  along: number;
  /** Which gap: labels only collide with labels in the same one. */
  gap: number;
  /** Extent along the gap. */
  size: number;
  /** Sits on a straight run, so it must stay centred on its line. */
  straight: boolean;
}

/**
 * Push labels in the same gap apart when their boxes would overlap. A label on
 * a straight edge stays centred on its line — moving it would make it look like
 * it belongs to the neighbour — so the branch label is the one that yields.
 */
function spread(labels: PendingLabel[]): void {
  const gaps = new Map<number, PendingLabel[]>();
  for (const l of labels) {
    const row = gaps.get(l.gap);
    if (row) row.push(l);
    else gaps.set(l.gap, [l]);
  }
  for (const row of gaps.values()) {
    row.sort((a, b) => a.along - b.along);
    for (let i = 1; i < row.length; i++) {
      const a = row[i - 1];
      const b = row[i];
      const overlap = a.along + a.size / 2 + 6 - (b.along - b.size / 2);
      if (overlap <= 0) continue;
      if (a.straight && !b.straight) b.along += overlap;
      else if (b.straight && !a.straight) a.along -= overlap;
      else {
        a.along -= overlap / 2;
        b.along += overlap / 2;
      }
    }
  }
}

export function laneLayout(
  phases: LanePhase[],
  options: LaneOptions = {},
  engine: DagLayoutEngine = sugiyamaLayout,
): LaneLayout {
  const orientation = options.orientation ?? "TB";
  const { laneGap, nodeH, gapLabelled, gapPlain, pad, tail } = options.geometry ?? LANE_GEOMETRY;
  const nodeW = options.nodeW ?? nodeWidthFor(phases.map((p) => p.name ?? p.id));
  const tb = orientation === "TB";

  // No edges at all means "unknown", not "one parallel stage" — an instance
  // authored before Weave falls back to the phases in order, joined by
  // implicit hand-offs so the chain still draws.
  const implicit = graphEdges(phases).length === 0;
  const needsOf = (p: LanePhase, i: number): string[] =>
    implicit ? (i === 0 ? [] : [phases[i - 1].id]) : p.needs;

  const conditions = (p: LanePhase) =>
    (p.edges ?? []).filter((e) => e.conditional).map((e) => e.label);
  // A stage whose incoming edges carry a condition gets room for the label; a
  // plain hand-off stays tight, so a long linear run does not sprawl. Side by
  // side, the label has to fit across the gap rather than along it.
  const gapFor = (p: LanePhase): number => {
    const labels = conditions(p);
    if (labels.length === 0) return 0;
    return tb ? gapLabelled : Math.max(gapLabelled, ...labels.map(labelWidth)) + 16;
  };

  const dag = engine(
    {
      nodes: phases.map((p, i) => ({
        id: p.id,
        deps: needsOf(p, i),
        w: nodeW,
        h: nodeH,
        gapBefore: gapFor(p),
      })),
    },
    { orientation, rankGap: gapPlain, nodeGap: laneGap, pad, tail },
  );

  const byId = new Map(phases.map((p) => [p.id, p]));
  const nodes: LaneNode[] = dag.nodes.map((n) => ({
    id: n.id,
    stage: n.rank,
    lane: n.order,
    x: n.x,
    y: n.y,
    leaf: n.leaf,
  }));

  const edges: LaneEdge[] = [];
  const labels: PendingLabel[] = [];
  for (const e of dag.edges) {
    const source = byId.get(e.from)!;
    const target = byId.get(e.to)!;
    const view = (target.edges ?? []).find((r) => r.phase === e.from);
    const text = view?.conditional ? view.label : null;
    edges.push({
      from: e.from,
      to: e.to,
      state: edgeState(source, target),
      d: roundedOrthogonalPath(e.points),
      label: text ? { text, x: e.anchor.x, y: e.anchor.y } : null,
    });
    if (text) {
      labels.push({
        edge: edges.length - 1,
        along: tb ? e.anchor.x : e.anchor.y,
        gap: tb ? e.anchor.y : e.anchor.x,
        size: tb ? labelWidth(text) : LABEL_H,
        straight: e.anchor.straight,
      });
    }
  }
  spread(labels);
  for (const l of labels) {
    const label = edges[l.edge].label!;
    if (tb) label.x = l.along;
    else label.y = l.along;
  }

  return {
    orientation,
    width: dag.width,
    height: dag.height,
    nodeW,
    nodeH,
    lanes: nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.lane)) + 1,
    stages: nodes.length === 0 ? 0 : Math.max(...nodes.map((n) => n.stage)) + 1,
    nodes,
    edges,
  };
}
