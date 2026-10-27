import type { DsStatus } from "../ds";
import type { LaneLayout } from "./laneGraphLayout";

/**
 * Where a scrolling phase graph should look, and how far it can look.
 *
 * Pure geometry for {@link useGraphFocus}: which phases the run is on, where
 * following them scrolls, the empty runway that lets the first and last phase
 * reach the centre at all, and which edges have more graph beyond them to fade.
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
 * How far inside the tile's edge a followed phase comes to rest: clear of the
 * {@link FADE_PX} edge fade, with a little room besides.
 */
export const FOLLOW_MARGIN_PX = 32;

/**
 * Where following scrolls: the middle of the phases the run is on, in the
 * middle of the tile. When they are wider than the tile, the view starts where
 * the work starts instead, a margin inside the edge.
 *
 * Per axis, in scroll offsets, and never past the scroll range: on a graph only
 * a little wider than its tile there is no runway, so the view stops at the
 * graph's own end rather than scrolling into empty space and pushing the root
 * out of view. On a long graph the runway lets the first and last phase reach
 * the centre too.
 */
export function followScroll(
  phases: readonly FocusPhase[],
  layout: Pick<LaneLayout, "nodes" | "nodeW" | "nodeH" | "width" | "height">,
  viewport: Size,
  frame: FocusFrame,
): { left: number; top: number } | null {
  const active = new Set(activePhases(phases));
  const nodes = layout.nodes.filter((n) => active.has(n.id));
  if (nodes.length === 0) return null;
  const s = frame.scale;
  const axis = (starts: number[], size: number, extent: number, view: number, runway: number) => {
    const lo = Math.min(...starts) * s;
    const hi = (Math.max(...starts) + size) * s;
    const want = hi - lo > view ? lo - FOLLOW_MARGIN_PX : (lo + hi) / 2 - view / 2;
    const end = Math.max(0, extent * s - view + 2 * runway);
    return Math.round(Math.min(end, Math.max(0, runway + want)));
  };
  return {
    left: axis(
      nodes.map((n) => n.x),
      layout.nodeW,
      layout.width,
      viewport.w,
      frame.runway.x,
    ),
    top: axis(
      nodes.map((n) => n.y),
      layout.nodeH,
      layout.height,
      viewport.h,
      frame.runway.y,
    ),
  };
}

/**
 * Whether a graph is bigger than its tile along an axis. Half a pixel is
 * allowed: a graph scaled to exactly its viewport comes out a floating-point
 * sliver wider (`w * (v / w)` is not always `v`), and that sliver used to make
 * a fitted graph scroll — and following then pushed half of it out of view.
 */
export function overflows(content: number, viewport: number): boolean {
  return viewport > 0 && content > viewport + 0.5;
}

/**
 * Empty scroll space on each side of an axis that overflows by a lot, so a
 * phase at the very start or end of a long graph can still be scrolled to the
 * centre. A graph that fits needs none — it doesn't scroll — and nor does one
 * only a little bigger than its tile: almost all of it is in view anyway, and
 * the runway gave its scrollbar half a tile of nothing at each end. It grows
 * in with the overflow past half a tile, so no resize jolts the graph by half
 * a tile at once.
 */
export function runwayFor(content: number, viewport: number, pad: number): number {
  if (!overflows(content, viewport)) return 0;
  const full = Math.max(0, viewport / 2 - pad);
  return Math.min(full, Math.max(0, content - viewport * 1.5));
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

/** How far each edge fades where there is more graph beyond it. */
export const FADE_PX = 24;

/**
 * How far to fade each edge: only where there is more graph beyond it. The
 * runway is not graph: at the graph's start the edge before it is empty, and
 * fading it there faded the root, the one phase every view starts from.
 */
export function fadeEdges(
  m: ScrollMetrics,
  runway: Point = { x: 0, y: 0 },
  size = FADE_PX,
): { top: number; right: number; bottom: number; left: number } {
  const more = (hidden: number) => (hidden > 0.5 ? size : 0);
  return {
    top: more(m.scrollTop - runway.y),
    left: more(m.scrollLeft - runway.x),
    bottom: more(m.scrollHeight - m.clientHeight - m.scrollTop - runway.y),
    right: more(m.scrollWidth - m.clientWidth - m.scrollLeft - runway.x),
  };
}
