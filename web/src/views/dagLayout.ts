/**
 * The contract between the phase graph and whatever lays it out.
 *
 * The board depends on this shape, never on an engine, so the hand-rolled
 * layered layout can be swapped (a lazily loaded library, a smarter crossing
 * reducer) without touching the adapter or the renderer.
 */

export type Orientation = "TB" | "LR";

export interface DagInputNode {
  id: string;
  deps: string[];
  w: number;
  h: number;
  /** Minimum gap in front of this node's rank, e.g. room for an edge label. */
  gapBefore?: number;
}

export interface DagInput {
  nodes: DagInputNode[];
}

export interface DagOptions {
  /** TB: ranks are rows, top to bottom. LR: ranks are columns, left to right. */
  orientation: Orientation;
  /** Default gap between consecutive ranks. */
  rankGap: number;
  /** Gap between neighbours within a rank. */
  nodeGap: number;
  pad: number;
  /** Extra room after the last rank, for leaf terminators. */
  tail: number;
}

export interface DagNode {
  id: string;
  rank: number;
  /** Slot within the rank. Edges that skip a rank occupy a slot of their own. */
  order: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Nothing depends on this node. */
  leaf: boolean;
}

export interface DagEdge {
  from: string;
  to: string;
  /** Orthogonal polyline from the source's border to the target's border. */
  points: [number, number][];
  /** Drawn against the flow because it closed a cycle. */
  reversed: boolean;
  /** Where the edge crosses the middle of the gap in front of its target. */
  anchor: { x: number; y: number; straight: boolean };
}

export interface DagLayout {
  orientation: Orientation;
  width: number;
  height: number;
  nodes: DagNode[];
  edges: DagEdge[];
  dropped: {
    danglingDeps: { from: string; to: string }[];
    cycleEdges: { from: string; to: string }[];
  };
}

export type DagLayoutEngine = (input: DagInput, options: DagOptions) => DagLayout;
