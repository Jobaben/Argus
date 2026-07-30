import { useCallback, useEffect, useRef, useState } from "react";
import { DURATION, EASE, prefersReducedMotion } from "./motion";

/**
 * The lifecycle contract: nothing enters that does not also know how to leave.
 *
 * Every overlay in this app used to be `open ? <Panel/> : null` — a surface that
 * slides in over 180ms and vanishes in zero. Users do not consciously notice a
 * missing exit; they feel it, because the illusion that these are objects
 * collapses at every dismissal, and dismissal is the most frequent thing they do.
 *
 * Two hooks, and the reason there are two:
 *
 * - {@link usePresence} owns *mounting*. It keeps a surface in the tree after
 *   `open` goes false, until whoever is animating it says the exit finished.
 * - {@link useSurfaceMotion} owns *moving*. It drives one element's entrance and
 *   exit through the Web Animations API, which — unlike a CSS keyframe — can be
 *   asked where it currently is. That is the whole reason for WAAPI here:
 *   open-close-open on a keyframe restarts from opacity 0, which is the visual
 *   signature of an interface that is busy animating rather than listening.
 *
 * Reduced motion is honoured by resolving instantly, never by animating faster:
 * for those users today's teleporting dismissal is already the correct
 * behaviour, so exits are added *on top of* it rather than by slowing everyone
 * down. The same goes for a browser with no `Element.animate` — it gets the old
 * instant behaviour rather than a broken half-animated one.
 */

/**
 * A surface's motion, declared once.
 *
 * `hidden` is the *only* thing a surface specifies, and the visible end is
 * derived from it (`opacity: 1`, `transform: none`). That is not a shortcut: it
 * is what guarantees the exit is the exact time-reverse of the entrance, which
 * is the property that makes an interrupted transition able to reverse at all.
 */
export interface SurfaceMotion {
  /** The far end of the surface's travel — where it enters from and exits to. */
  hidden: { opacity?: number; transform?: string };
  enterMs: number;
  exitMs: number;
  enterEasing: string;
  exitEasing: string;
}

/**
 * The app's surfaces, as motion.
 *
 * One table, so "how does an overlay leave?" has a single answer and a new
 * overlay cannot invent its own timing. Durations and easings come from
 * {@link DURATION}/{@link EASE} — the same values `index.css` declares as
 * tokens — never from a literal at the point of use.
 */
export const SURFACE = {
  /** A dimming scrim: opacity only, and quicker than the panel it backs, so the
   *  page behind is already committing to its new state as the panel arrives. */
  scrim: {
    hidden: { opacity: 0 },
    enterMs: DURATION.quick,
    exitMs: DURATION.exitQuick,
    enterEasing: "ease-out",
    exitEasing: EASE.inExpo,
  },
  /** An in-place region resolving into another: opacity only, no travel, because
   *  both states occupy the same box and moving either would be a lie about that.
   *  The skeleton→content hand-off. Same timing as `scrim` today and deliberately
   *  not the same entry: the scrim's is chosen against the panel it backs, so
   *  tuning that must not silently retime every loading region in the app. */
  fade: {
    hidden: { opacity: 0 },
    enterMs: DURATION.quick,
    exitMs: DURATION.exitQuick,
    enterEasing: "ease-out",
    exitEasing: EASE.inExpo,
  },
  /** An overlay arriving from in front of the page: down and slightly small.
   *  The palette, the shortcut sheet, the mobile nav. */
  rise: {
    hidden: { opacity: 0, transform: "translateY(-8px) scale(0.985)" },
    enterMs: DURATION.base,
    exitMs: DURATION.exit,
    enterEasing: EASE.outExpo,
    exitEasing: EASE.inExpo,
  },
  /** The right-edge slide-over. */
  panel: {
    hidden: { opacity: 0, transform: "translateX(16px)" },
    enterMs: DURATION.base,
    exitMs: DURATION.exit,
    enterEasing: EASE.outExpo,
    exitEasing: EASE.inExpo,
  },
  /** A small menu hung off its trigger. Quick, because it is a click away from
   *  the thing that opened it and any slower reads as a wait. */
  menu: {
    hidden: { opacity: 0, transform: "translateY(-4px) scale(0.97)" },
    enterMs: DURATION.quick,
    exitMs: DURATION.exitQuick,
    enterEasing: EASE.outExpo,
    exitEasing: EASE.inExpo,
  },
} as const satisfies Record<string, SurfaceMotion>;

/**
 * Keeps a surface mounted through its exit.
 *
 * Returns `present` (render the surface at all) and `exited` (the callback whose
 * job is to say the exit animation has finished). Splitting those from the
 * animation itself is what lets one presence cover a scrim *and* a panel: the
 * panel is the one that reports, the scrim just follows.
 */
export function usePresence(open: boolean): { present: boolean; exited: () => void } {
  // "Adjust state when a prop changes": compared and updated during render, not
  // in an effect, so the surface never paints one frame in the wrong state. State
  // rather than a ref for the previous value, because React needs to know the
  // comparison happened — a ref written during render is invisible to it.
  const [seen, setSeen] = useState({ open, exiting: false });
  if (seen.open !== open) setSeen({ open, exiting: !open });

  const exited = useCallback(() => setSeen((s) => ({ ...s, exiting: false })), []);
  return { present: open || (seen.open === open && seen.exiting), exited };
}

type Direction = "in" | "out";

/**
 * Drives one element's entrance and exit, reversibly.
 *
 * Returns a ref callback to put on the animated element. Attach it to the thing
 * that *moves* — for a dialog that is the panel, not the fixed scrim wrapper.
 *
 * @param visible the surface's intent, which is the caller's `open` — not
 *   whether it is mounted. Going false plays the exit; going true mid-exit
 *   reverses it from wherever it had got to.
 * @param motion must be a *stable* reference — one of the {@link SURFACE}
 *   entries, not an object literal. It is a dependency of the effect that drives
 *   the animation, so a fresh object every render would restart the animation
 *   every render.
 * @param onExited called once the exit finishes; wire it to
 *   {@link usePresence}'s `exited` on exactly one element per surface.
 */
export function useSurfaceMotion<T extends HTMLElement>(
  visible: boolean,
  motion: SurfaceMotion,
  onExited?: () => void,
  /** `transform-origin` for the animated element, so an overlay can grow out of
   *  whatever opened it instead of out of an anonymous point above the page. */
  origin?: string,
): (node: T | null) => void {
  const elRef = useRef<T | null>(null);
  const animRef = useRef<Animation | null>(null);
  const dirRef = useRef<Direction | null>(null);
  /**
   * Where the surface visually is, 0 = hidden … 1 = shown.
   *
   * Zero on mount, *not* `visible ? 1 : 0`. A surface's element only exists
   * because the surface is opening, so it starts hidden and travels in; seeding
   * this from `visible` seeks the entrance straight to its end and the surface
   * simply appears — an entrance that is skipped exactly when it is wanted.
   */
  const atRef = useRef(0);

  const ref = useCallback(
    (node: T | null) => {
      elRef.current = node;
      if (!node) return;
      if (origin) node.style.transformOrigin = origin;
      // Paint the hidden state as the node attaches — before the browser's first
      // paint of it. Without this the surface flashes at full opacity for one
      // frame and *then* starts its entrance, which is worse than no entrance.
      if (atRef.current === 0 && canAnimate(node)) applyState(node, motion.hidden);
    },
    [motion, origin],
  );

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const spec = motion;
    const exited = onExited;
    if (origin) el.style.transformOrigin = origin;

    if (!canAnimate(el)) {
      clearState(el, spec.hidden);
      atRef.current = visible ? 1 : 0;
      if (!visible) exited?.();
      return;
    }

    // Interruption: take the running animation's position as the new start
    // point, so a reversal continues from what is on screen.
    const running = animRef.current;
    if (running) {
      atRef.current = positionOf(running, dirRef.current, spec);
      running.cancel();
      animRef.current = null;
    }

    const shown = shownState(spec.hidden);
    const duration = visible ? spec.enterMs : spec.exitMs;
    const anim = el.animate(visible ? [spec.hidden, shown] : [shown, spec.hidden], {
      duration,
      easing: visible ? spec.enterEasing : spec.exitEasing,
      fill: "both",
    });
    // Seek to where the surface already is rather than scaling the duration:
    // the remaining time falls out of it, and the curve stays the one curve the
    // surface is specified with.
    anim.currentTime = (visible ? atRef.current : 1 - atRef.current) * duration;
    animRef.current = anim;
    dirRef.current = visible ? "in" : "out";

    anim.onfinish = () => {
      animRef.current = null;
      atRef.current = visible ? 1 : 0;
      if (visible) {
        // Release the fill, or the element stays pinned at `transform: none` and
        // every hover lift and press underneath it stops working.
        anim.cancel();
        clearState(el, spec.hidden);
      } else {
        exited?.();
      }
    };

    return () => {
      // Deliberately *not* cancelled here. This effect re-runs when `visible`
      // flips, and the run above needs the previous animation's position; the
      // interruption branch cancels it. On unmount the element goes with it.
      anim.onfinish = null;
    };
  }, [visible, motion, onExited, origin]);

  return ref;
}

/** How far along its travel a running animation currently is, 0…1. */
function positionOf(anim: Animation, direction: Direction | null, spec: SurfaceMotion): number {
  const elapsed = typeof anim.currentTime === "number" ? anim.currentTime : 0;
  if (direction === "out") {
    return clamp01(1 - elapsed / Math.max(1, spec.exitMs));
  }
  return clamp01(elapsed / Math.max(1, spec.enterMs));
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function canAnimate(node: HTMLElement): boolean {
  return typeof node.animate === "function" && !prefersReducedMotion();
}

/** The visible counterpart of a `hidden` state — its exact opposite, per key. */
function shownState(hidden: SurfaceMotion["hidden"]): SurfaceMotion["hidden"] {
  const shown: SurfaceMotion["hidden"] = {};
  if (hidden.opacity !== undefined) shown.opacity = 1;
  if (hidden.transform !== undefined) shown.transform = "none";
  return shown;
}

function applyState(node: HTMLElement, state: SurfaceMotion["hidden"]): void {
  if (state.opacity !== undefined) node.style.opacity = String(state.opacity);
  if (state.transform !== undefined) node.style.transform = state.transform;
}

function clearState(node: HTMLElement, state: SurfaceMotion["hidden"]): void {
  if (state.opacity !== undefined) node.style.removeProperty("opacity");
  if (state.transform !== undefined) node.style.removeProperty("transform");
}

/** One item's presence in a list that animates its own arrivals and departures. */
export interface PresentItem<T> {
  key: string;
  item: T;
  /** True while the item is on its way out — it is no longer in `items`. */
  leaving: boolean;
}

/**
 * The list form of {@link usePresence}: keeps departed items rendered long
 * enough to animate out, in the position they departed from.
 *
 * Needed because a departure is usually not the list's decision. A toast is
 * removed by the queue that owns it, an alert by the server saying it recovered
 * — by the time the list re-renders the item is simply gone, and there is
 * nothing left to animate. This holds the gap open for one exit.
 *
 * Pair it with `useFlip` on the same list: this animates the item that left, and
 * FLIP animates the rows that closed the gap behind it.
 */
export function useListPresence<T>(
  items: T[],
  keyOf: (item: T) => string,
  exitMs = DURATION.exit,
): PresentItem<T>[] {
  const [held, setHeld] = useState<PresentItem<T>[]>(() => live(items, keyOf));
  const next = merge(held, items, keyOf, prefersReducedMotion());
  if (differs(held, next)) setHeld(next);

  // One timer per departure, kept across renders.
  //
  // A single timer keyed on the whole leaving *set* gets restarted by every new
  // departure, so a list that churns faster than one exit never releases
  // anything: each departed item stays in the tree, invisible but still in flow,
  // and the stack shows a gap where it was until the churn stops. A toast burst
  // does exactly that — `useToastQueue` evicts the oldest on every push past its
  // cap. Per-key deadlines mean an item leaves `exitMs` after *it* departed,
  // whatever else is happening around it.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const scheduled = timers.current;
    const leaving = new Set(next.filter((e) => e.leaving).map((e) => e.key));

    // An item that came back cancels its own departure: `merge` has already
    // cleared its `leaving`, and firing the deadline anyway would evict a live row.
    for (const [key, timer] of scheduled) {
      if (leaving.has(key)) continue;
      clearTimeout(timer);
      scheduled.delete(key);
    }

    for (const key of leaving) {
      if (scheduled.has(key)) continue;
      scheduled.set(
        key,
        setTimeout(() => {
          scheduled.delete(key);
          // Re-checked at fire time as well as cancelled above: together those
          // mean a returning item cannot be dropped by an in-flight deadline,
          // whichever order the render and the timeout land in.
          setHeld((current) => current.filter((e) => e.key !== key || !e.leaving));
        }, exitMs),
      );
    }
    // No dependency array on purpose: the body is idempotent per key, so it can
    // run every render. The alternative is encoding the leaving set as a string
    // to diff — which is what held a literal NUL byte in this file and made every
    // `grep` over the motion layer skip it as binary.
  });

  // Unmount only; the effect above owns cancellation for the whole mounted life.
  useEffect(() => {
    const scheduled = timers.current;
    return () => {
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
    };
  }, []);

  return next;
}

function live<T>(items: T[], keyOf: (item: T) => string): PresentItem<T>[] {
  return items.map((item) => ({ key: keyOf(item), item, leaving: false }));
}

function merge<T>(
  held: PresentItem<T>[],
  items: T[],
  keyOf: (item: T) => string,
  reduced: boolean,
): PresentItem<T>[] {
  if (reduced) return live(items, keyOf);
  const incoming = new Map(items.map((item) => [keyOf(item), item] as const));
  const merged: PresentItem<T>[] = [];
  const placed = new Set<string>();
  // Held order first, so an item that leaves does not drag the ones after it
  // upward before it has finished leaving.
  for (const entry of held) {
    const still = incoming.get(entry.key);
    if (still !== undefined) merged.push({ key: entry.key, item: still, leaving: false });
    else merged.push({ ...entry, leaving: true });
    placed.add(entry.key);
  }
  for (const item of items) {
    const key = keyOf(item);
    if (!placed.has(key)) merged.push({ key, item, leaving: false });
  }
  return merged;
}

/** Compared on keys, order and leaving-ness only — the payload is read fresh. */
function differs<T>(a: PresentItem<T>[], b: PresentItem<T>[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((entry, i) => entry.key !== b[i].key || entry.leaving !== b[i].leaving);
}
