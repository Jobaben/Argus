import { useRef, type MouseEvent, type PointerEvent, type RefObject } from "react";

/** How far the pointer must travel before a press becomes a pan rather than a click. */
export const DRAG_THRESHOLD_PX = 4;

/**
 * Pans a scroll container by dragging it, in every direction at once.
 *
 * A press that never travels past {@link DRAG_THRESHOLD_PX} is left alone, so a
 * click on a node still lands on the node. Once it does travel, the container
 * captures the pointer, and the click that ends the pan is swallowed, so
 * letting go over a node never selects it. `onPan` runs once per drag, when it
 * starts.
 */
export function useDragPan(
  scrollerRef: RefObject<HTMLElement | null>,
  { enabled, onPan }: { enabled: boolean; onPan: () => void },
) {
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
    panning: boolean;
  } | null>(null);
  // Cleared on the next press too: a release outside the tile fires no click.
  const swallowClick = useRef(false);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    const el = scrollerRef.current;
    swallowClick.current = false;
    if (!enabled || !el || e.button !== 0) return;
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
      panning: false,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const el = scrollerRef.current;
    if (!d || !el || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.panning) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      d.panning = true;
      el.setPointerCapture?.(e.pointerId);
      onPan();
    }
    el.scrollLeft = d.left - dx;
    el.scrollTop = d.top - dy;
  };

  const end = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.panning) return;
    swallowClick.current = true;
    scrollerRef.current?.releasePointerCapture?.(e.pointerId);
  };

  const onClickCapture = (e: MouseEvent<HTMLElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  return { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end, onClickCapture };
}
