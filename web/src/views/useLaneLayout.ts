import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PhasePill } from "../ds";
import { chooseOrientation, laneLayout, MIN_SCALE, type LaneLayout } from "./laneGraphLayout";

/** Below this card width the graph stacks above the focus panel. */
export const STACK_BELOW_PX = 900;

/** The narrowest the focus panel may get beside the graph before the board stacks. */
export const FOCUS_MIN_PX = 360;

/** The board grid's `gap-4`. */
export const BOARD_GAP_PX = 16;

/** The graph tile's border, both sides. */
const TILE_CHROME_PX = 2;

/**
 * The width of the element the ref lands on, tracked as it resizes.
 *
 * Measured in a layout effect, before the first paint: a `ResizeObserver` alone
 * reports after paint, so the graph drew once at its "unknown width" geometry
 * and snapped to the real one a frame later — on every instance mount.
 */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => setWidth((prev) => (prev === w ? prev : w));
    apply(Math.round(el.clientWidth));
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      apply(Math.round(entries[0]?.contentRect.width ?? 0));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface BoardArrangement {
  layout: LaneLayout;
  /** The graph sits above the focus panel rather than beside it. */
  stacked: boolean;
  /** The graph's grid track beside the focus panel; never more than the room left. */
  graphTrackPx: number;
}

/** Top-down unless only left-to-right fits the room, or overflows it less. */
function layoutFor(phases: PhasePill[], availW: number): LaneLayout {
  const tb = laneLayout(phases, { orientation: "TB" });
  if (availW <= 0 || tb.width <= availW) return tb;
  const lr = laneLayout(phases, { orientation: "LR" });
  return chooseOrientation(tb, lr, availW) === "LR" ? lr : tb;
}

/**
 * How an instance's graph and focus panel share a card of a given width.
 *
 * Beside, the focus panel is guaranteed {@link FOCUS_MIN_PX}: the graph gets
 * what is left, and only if it is still readable there at {@link MIN_SCALE}.
 * Otherwise the graph stacks above the panel and takes the card's full width.
 * Either way the graph is bounded by its track and scrolls inside it — no
 * shape can push the panel to zero or the card past its column.
 *
 * An unmeasured width (first paint, jsdom) means "unknown" and gets the
 * natural geometry beside the panel, not the narrow fallback.
 */
export function boardArrangement(phases: PhasePill[], cardWidth: number): BoardArrangement {
  if (cardWidth <= 0) {
    const layout = layoutFor(phases, 0);
    return { layout, stacked: false, graphTrackPx: layout.width + TILE_CHROME_PX };
  }
  if (cardWidth >= STACK_BELOW_PX) {
    const room = cardWidth - FOCUS_MIN_PX - BOARD_GAP_PX;
    const layout = layoutFor(phases, room - TILE_CHROME_PX);
    if (layout.width * MIN_SCALE <= room - TILE_CHROME_PX) {
      return {
        layout,
        stacked: false,
        graphTrackPx: Math.min(layout.width + TILE_CHROME_PX, room),
      };
    }
  }
  const layout = layoutFor(phases, cardWidth - TILE_CHROME_PX);
  return { layout, stacked: true, graphTrackPx: cardWidth };
}

export function useBoardArrangement(phases: PhasePill[], cardWidth: number): BoardArrangement {
  return useMemo(() => boardArrangement(phases, cardWidth), [phases, cardWidth]);
}
