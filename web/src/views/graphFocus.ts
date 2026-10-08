import type { DsStatus } from "../ds";
import type { LaneLayout } from "./laneGraphLayout";

/**
 * Where a scrolling phase graph should look, and how far it can look.
 *
 * Pure geometry for {@link useGraphFocus}: which phases the run is on, the
 * point to centre, the empty runway that lets the first and last phase reach
 * the centre at all, and which edges have more graph beyond them to fade.
 */

export interface FocusPhase {
  id: string;
  status: DsStatus;
  needs: string[];
}

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The scaled graph's offset inside the scroll content. */
export interface FocusFrame {
  scale: number;
  runway: Point;
}

/**
 * The phases the run is on: what is working; else what waits for a human;
 * else the next phase whose dependencies have all finished; else the last
 * failure. A finished run has nothing to follow.
 */
export function activePhases(phases: readonly FocusPhase[]): string[] {
  const ids = (ps: readonly FocusPhase[]) => ps.map((p) => p.id);
  const working = phases.filter((p) => p.status === "working");
  if (working.length > 0) return ids(working);
  const waiting = phases.filter((p) => p.status === "await");
  if (waiting.length > 0) return ids(waiting);
  const known = new Set(phases.map((p) => p.id));
  const done = new Set(phases.filter((p) => p.status === "done").map((p) => p.id));
  const next = phases.find(
    (p) => p.status === "queued" && p.needs.every((n) => done.has(n) || !known.has(n)),
  );
  if (next) return [next.id];
  const failed = phases.filter((p) => p.status === "failed");
  return failed.length > 0 ? [failed[failed.length - 1].id] : [];
}

/**
 * The point to centre, in layout coordinates: the middle of the active
 * phases, or — when they don't fit the viewport together — the first of them
 * in graph order, so the view starts where the work starts.
 */
export function followTarget(
  phases: readonly FocusPhase[],
  layout: Pick<LaneLayout, "nodes" | "nodeW" | "nodeH">,
  viewport: Size,
): Point | null {
  const active = new Set(activePhases(phases));
  const nodes = layout.nodes
    .filter((n) => active.has(n.id))
    .sort((a, b) => a.stage - b.stage || a.lane - b.lane);
  if (nodes.length === 0) return null;
  const left = Math.min(...nodes.map((n) => n.x));
  const top = Math.min(...nodes.map((n) => n.y));
  const right = Math.max(...nodes.map((n) => n.x + layout.nodeW));
  const bottom = Math.max(...nodes.map((n) => n.y + layout.nodeH));
  if (right - left <= viewport.w && bottom - top <= viewport.h) {
    return { x: (left + right) / 2, y: (top + bottom) / 2 };
  }
  const first = nodes[0];
  return { x: first.x + layout.nodeW / 2, y: first.y + layout.nodeH / 2 };
}

/**
 * Empty scroll space on each side of an axis that overflows, so a phase at the
 * very start or end of the graph can still be scrolled to the centre. An axis
 * that fits needs none — it doesn't scroll.
 */
export function runwayFor(content: number, viewport: number, pad: number): number {
  if (viewport <= 0 || content <= viewport) return 0;
  return Math.max(0, viewport / 2 - pad);
}

/** The scroll offset that puts a layout point in the middle of the viewport. */
export function scrollTargetFor(
  point: Point,
  viewport: Size,
  frame: FocusFrame,
): { left: number; top: number } {
  return {
    left: Math.max(0, Math.round(point.x * frame.scale + frame.runway.x - viewport.w / 2)),
    top: Math.max(0, Math.round(point.y * frame.scale + frame.runway.y - viewport.h / 2)),
  };
}

export interface ScrollMetrics {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

/** How far to fade each edge: only where there is more graph beyond it. */
export function fadeEdges(
  m: ScrollMetrics,
  size = 24,
): { top: number; right: number; bottom: number; left: number } {
  const more = (hidden: number) => (hidden > 0.5 ? size : 0);
  return {
    top: more(m.scrollTop),
    left: more(m.scrollLeft),
    bottom: more(m.scrollHeight - m.clientHeight - m.scrollTop),
    right: more(m.scrollWidth - m.clientWidth - m.scrollLeft),
  };
}
