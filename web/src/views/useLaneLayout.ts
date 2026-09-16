import { useEffect, useMemo, useRef, useState } from "react";
import type { PhasePill } from "../ds";
import { LANE_GEOMETRY, laneLayout, laneWidthFor } from "./laneGraphLayout";

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
 * Two passes: lane count first, then geometry sized for that count. When the
 * graph stacks above the focus panel it fits the card; beside it, lanes take
 * their ideal width and the panel takes the rest. An unmeasured width (first
 * paint, jsdom) means "unknown" and gets the ideal geometry, not the floor.
 */
export function useLaneLayout(phases: PhasePill[], cardWidth: number) {
  return useMemo(() => {
    const lanes = laneLayout(phases).lanes;
    const stacked = cardWidth > 0 && cardWidth < STACK_BELOW_PX;
    const laneW = laneWidthFor(lanes, stacked ? cardWidth : undefined);
    return { layout: laneLayout(phases, { ...LANE_GEOMETRY, laneW }), laneW, stacked };
  }, [phases, cardWidth]);
}
