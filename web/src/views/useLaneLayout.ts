import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PhasePill } from "../ds";
import { LANE_GEOMETRY, laneLayout, laneWidthFor, tileChromeFor } from "./laneGraphLayout";

/** Below this card width the graph stacks above the focus panel. */
export const STACK_BELOW_PX = 900;

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

/**
 * The layout for an instance at a given card width.
 *
 * Two passes: lane count and height first, then geometry sized for that count.
 * When the graph stacks above the focus panel it fits the card; beside it, lanes
 * take their ideal width and the panel takes the rest. An unmeasured width
 * (first paint, jsdom) means "unknown" and gets the ideal geometry, not the
 * floor.
 *
 * Both passes are sized for the room *inside* the tile: the border, and the
 * scrollbar of a graph tall enough to scroll, come off the width first. Paying
 * for them here is what keeps the graph off its horizontal scrollbar — the tile
 * is a border-box, so a tile exactly `layout.width` wide is two pixels too
 * narrow for the graph it holds, and one more on a tall pipeline.
 */
export function useLaneLayout(phases: PhasePill[], cardWidth: number) {
  return useMemo(() => {
    const probe = laneLayout(phases);
    const stacked = cardWidth > 0 && cardWidth < STACK_BELOW_PX;
    const chrome = tileChromeFor(probe.height);
    const laneW = laneWidthFor(probe.lanes, stacked ? cardWidth - chrome : undefined);
    const layout = laneLayout(phases, { ...LANE_GEOMETRY, laneW });
    return { layout, laneW, stacked, tileWidth: layout.width + chrome };
  }, [phases, cardWidth]);
}
