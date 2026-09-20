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
 * the time we measure, so "First" is the position we kept from the previous
 * commit: measure where each row is now, translate it back to where it *was*,
 * and animate that offset away. The row is laid out in its new position the
 * whole time — only its transform lies — so nothing reflows and the animation is
 * compositor-only.
 *
 * Composes with `useChangeFlash`: the row glides to its new position *and*
 * flashes, which answers "what moved" and "why" in one gesture.
 */

/** The largest jump worth animating. */
const MAX_TRAVEL_PX = 2000;
/**
 * Below this a "move" is a layout wobble, not a reorder. Positions are read as
 * integers (see {@link layoutPoint}), so a half-pixel reflow can round to a
 * one-pixel difference; a genuine reorder is never that small.
 */
const MIN_TRAVEL_PX = 2;

export interface FlipOptions {
  durationMs?: number;
  easing?: string;
  /** Set false to leave the list alone (a list that is still loading, say). */
  enabled?: boolean;
}

interface Point {
  left: number;
  top: number;
}

/**
 * Where a row *is laid out*, summed up its `offsetParent` chain.
 *
 * Not `getBoundingClientRect()`, and the difference is the whole bug this
 * replaces. The client rect is viewport-relative and includes every transform
 * in effect at the moment of reading, so it answered "where is this drawn right
 * now?" when the question is "did the layout move this row?". Read on every
 * render of a live board, it produced three phantom moves: a page scroll between
 * two renders read as every row shifting by the scroll distance; a render
 * during a running glide stored the half-way transform, so the next render
 * animated a bounce back; and the very first measurement landed while the
 * row's own `slide-up` entrance was still 6px low, so the first re-render after
 * the entrance twitched the whole list.
 *
 * `offsetLeft`/`offsetTop` are layout-box values: scroll and transforms — the
 * row's own, an ancestor's, a hover lift — leave them alone. The chain ends at
 * the nearest fixed-position ancestor (`offsetParent` is null there), which
 * keeps a fixed toast stack measured against itself rather than the page.
 */
function layoutPoint(node: HTMLElement): Point {
  let left = 0;
  let top = 0;
  for (let el: HTMLElement | null = node; el; el = el.offsetParent as HTMLElement | null) {
    left += el.offsetLeft;
    top += el.offsetTop;
  }
  return { left, top };
}

/**
 * The translation a row is currently drawn with, from its computed transform.
 *
 * A layout point says where the row belongs, not where the eye sees it while a
 * glide is still in flight. Retargeting a running glide has to start from the
 * latter, or the row snaps back to its full old offset before setting off again.
 */
function currentTranslation(node: HTMLElement): Point {
  if (typeof getComputedStyle !== "function") return { left: 0, top: 0 };
  const transform = getComputedStyle(node).transform;
  if (!transform || transform === "none") return { left: 0, top: 0 };
  const match = /matrix(?:3d)?\(([^)]+)\)/.exec(transform);
  if (!match) return { left: 0, top: 0 };
  const parts = match[1].split(",").map((s) => Number.parseFloat(s));
  // 2D: matrix(a, b, c, d, tx, ty). 3D: matrix3d(...) with tx, ty at 12, 13.
  const [tx, ty] = parts.length === 16 ? [parts[12], parts[13]] : [parts[4], parts[5]];
  return {
    left: Number.isFinite(tx) ? tx : 0,
    top: Number.isFinite(ty) ? ty : 0,
  };
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
  const points = useRef(new Map<string, Point>());
  const running = useRef(new Map<string, Animation>());
  /**
   * One callback per key, for the life of the list.
   *
   * Not negotiable, and not an optimisation. React detaches and re-attaches a ref
   * whose *identity* changed — so a `(node) => …` built fresh each render is
   * called with `null` on every single render, which is indistinguishable from
   * the row unmounting. The bookkeeping below would clear the previous position
   * every time, and FLIP would then have no "first" to invert from: it would
   * silently never animate anything. Held in state rather than a ref because
   * this is read during render, which a ref may not be.
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
      points.current.delete(key);
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
  //
  // No dependency list on purpose: any render may have reordered the list, and
  // because the measurement is layout-based (not the drawn rect) a render that
  // moved nothing measures the same points and does nothing.
  useLayoutEffect(() => {
    const previous = points.current;
    const next = new Map<string, Point>();
    const animate = enabled && !prefersReducedMotion();

    for (const [key, node] of nodes.current) {
      const point = layoutPoint(node);
      next.set(key, point);
      if (!animate) continue;
      const was = previous.get(key);
      if (!was) continue; // A new row: its own entrance animation owns this.

      const dx = was.left - point.left;
      const dy = was.top - point.top;
      const travel = Math.hypot(dx, dy);
      if (travel < MIN_TRAVEL_PX || travel > MAX_TRAVEL_PX) continue;
      if (typeof node.animate !== "function") continue;

      // Retarget rather than stack: a board updating faster than it animates
      // must converge on the current layout, not queue every intermediate one.
      // The new glide starts from where the row is *drawn*, which mid-glide is
      // its layout position plus whatever translation is still playing out.
      const inFlight = running.current.get(key);
      const from = inFlight ? currentTranslation(node) : { left: 0, top: 0 };
      inFlight?.cancel();
      const anim = node.animate(
        [
          { transform: `translate(${dx + from.left}px, ${dy + from.top}px)` },
          { transform: "none" },
        ],
        { duration: durationMs, easing },
      );
      running.current.set(key, anim);
      anim.onfinish = () => {
        if (running.current.get(key) === anim) running.current.delete(key);
      };
    }

    points.current = next;
  });

  return register;
}
