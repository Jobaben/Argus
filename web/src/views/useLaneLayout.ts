import { useEffect, useMemo, useRef, useState } from "react";
import type { PhasePill } from "../ds";
import { LANE_GEOMETRY, laneLayout, laneWidthFor, tileChromeFor } from "./laneGraphLayout";

/** Below this card width the graph stacks above the focus panel. */
export const STACK_BELOW_PX = 900;

/** The width of the element the ref lands on, tracked as it resizes. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((prev) => (prev === w ? prev : w));
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
