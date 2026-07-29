import { useLayoutEffect, useRef, useState } from "react";
import { DURATION, EASE, prefersReducedMotion } from "./motion";

/**
 * FLIP: the one technique that makes a live board move like one.
 *
 * Argus is a real-time monitor — data arrives over a WebSocket — and yet rows
 * inserted, removed and re-sorted as hard jumps. The one thing a live dashboard
 * can do that a static report cannot is *show change as change*, and a row that
 * teleports to its new position shows nothing: you are left comparing the board
 * against your memory of it a frame ago.
 *
 * First / Last / Invert / Play. React has already committed the new layout by
 * the time we measure, so "First" is the rect we kept from the previous commit:
 * measure where each row is now, translate it back to where it *was*, and animate
 * that offset away. The row is laid out in its new position the whole time — only
 * its transform lies — so nothing reflows and the animation is compositor-only.
 *
 * Composes with `useChangeFlash`: the row glides to its new position *and*
 * flashes, which answers "what moved" and "why" in one gesture.
 */

/** The largest jump worth animating. */
const MAX_TRAVEL_PX = 2000;
/** Below this a "move" is a sub-pixel layout wobble, not a reorder. */
const MIN_TRAVEL_PX = 1;

export interface FlipOptions {
  durationMs?: number;
  easing?: string;
  /** Set false to leave the list alone (a list that is still loading, say). */
  enabled?: boolean;
}

/**
 * Returns a ref-callback factory: call it with a stable key per row and put the
 * result on the row's element.
 *
 * ```tsx
 * const flip = useFlip();
 * rows.map((r) => <li key={r.id} ref={flip(r.id)}>…</li>)
 * ```
 *
 * The key must identify the *row*, not its position — a key that changes when
 * the row moves is indistinguishable from a different row arriving, and the
 * whole point is telling those two apart.
 */
export function useFlip(options: FlipOptions = {}) {
  const { durationMs = DURATION.base, easing = EASE.outExpo, enabled = true } = options;
  const nodes = useRef(new Map<string, HTMLElement>());
  const rects = useRef(new Map<string, DOMRect>());
  const running = useRef(new Map<string, Animation>());
  /**
   * One callback per key, for the life of the list.
   *
   * Not negotiable, and not an optimisation. React detaches and re-attaches a ref
   * whose *identity* changed — so a `(node) => …` built fresh each render is
   * called with `null` on every single render, which is indistinguishable from
   * the row unmounting. The bookkeeping below would clear the previous rect every
   * time, and FLIP would then have no "first" to invert from: it would silently
   * never animate anything. Held in state rather than a ref because this is read
   * during render, which a ref may not be.
   */
  const [callbacks] = useState(() => new Map<string, (node: HTMLElement | null) => void>());

  const register = (key: string) => {
    const existing = callbacks.get(key);
    if (existing) return existing;
    const callback = (node: HTMLElement | null) => {
      if (node) {
        nodes.current.set(key, node);
        return;
      }
      // A genuine unmount: forget the position, or a recycled key would animate
      // in from wherever the old row happened to be.
      nodes.current.delete(key);
      rects.current.delete(key);
      running.current.get(key)?.cancel();
      running.current.delete(key);
      callbacks.delete(key);
    };
    callbacks.set(key, callback);
    return callback;
  };

  // Layout effect, not effect: this has to run before the browser paints the new
  // positions, or the row is seen in its new place and then animated from its
  // old one — a flicker, which is worse than the teleport it replaces.
  useLayoutEffect(() => {
    const previous = rects.current;
    const next = new Map<string, DOMRect>();
    const animate = enabled && !prefersReducedMotion();

    for (const [key, node] of nodes.current) {
      const rect = node.getBoundingClientRect();
      next.set(key, rect);
      if (!animate) continue;
      const was = previous.get(key);
      if (!was) continue; // A new row: its own entrance animation owns this.

      const dx = was.left - rect.left;
      const dy = was.top - rect.top;
      const travel = Math.hypot(dx, dy);
      if (travel < MIN_TRAVEL_PX || travel > MAX_TRAVEL_PX) continue;
      if (typeof node.animate !== "function") continue;

      // Retarget rather than stack: a board updating faster than it animates
      // must converge on the current layout, not queue every intermediate one.
      running.current.get(key)?.cancel();
      const anim = node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
        { duration: durationMs, easing },
      );
      running.current.set(key, anim);
      anim.onfinish = () => {
        if (running.current.get(key) === anim) running.current.delete(key);
      };
    }

    rects.current = next;
  });

  return register;
}
