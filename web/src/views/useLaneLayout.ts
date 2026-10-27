import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PhasePill } from "../ds";
import { laneLayout, type LaneLayout } from "./laneGraphLayout";

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
 * An instance's graph, always left to right: the run reads the way the text
 * does. The board puts it above the focus panel whatever the card's width, in
 * a window that pans when the graph is wider than the card.
 */
export function phaseLayout(phases: PhasePill[]): LaneLayout {
  return laneLayout(phases, { orientation: "LR" });
}

export function usePhaseLayout(phases: PhasePill[]): LaneLayout {
  return useMemo(() => phaseLayout(phases), [phases]);
}
