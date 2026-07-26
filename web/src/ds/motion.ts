import { useEffect, useRef, useState } from "react";

/**
 * Motion helpers.
 *
 * The rule applied throughout: animation has to *carry information*, or it is
 * decoration that costs the user time. So there are exactly two here —
 *
 * - {@link useCountUp} makes a number's *change* visible, which on a spend
 *   counter or a failure count is the thing you were looking for.
 * - {@link useChangeFlash} marks *which* row just changed, which in a live
 *   monitoring board is otherwise invisible: statuses swap silently and you
 *   cannot tell whether you missed one.
 *
 * Both honour `prefers-reduced-motion` by resolving instantly rather than by
 * animating faster, and both are safe to call unconditionally.
 */

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Cubic ease-out: fast, then settling — the same feel as `--ease-out-expo`. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

const COUNT_DURATION_MS = 420;

/**
 * Animates from the previous value to `value` whenever it changes.
 *
 * Snapping rules matter more than the easing:
 *
 * - The **first** value is never animated. Counting up from zero on load is a
 *   splash screen, not information.
 * - A **huge** jump snaps. Rolling from 0 to 8.9M reads as a slot machine and
 *   makes the number unreadable for the whole duration.
 * - Non-finite input snaps, so a `NaN` can never wedge the loop.
 */
export function useCountUp(value: number, durationMs = COUNT_DURATION_MS): number {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number | null>(null);
  const firstRef = useRef(true);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    const snap = () => {
      fromRef.current = to;
      setShown(to);
    };

    if (firstRef.current) {
      firstRef.current = false;
      snap();
      return;
    }
    if (!Number.isFinite(to) || !Number.isFinite(from) || from === to || prefersReducedMotion()) {
      snap();
      return;
    }
    // A change of more than ~20× is a different quantity, not an increment.
    const magnitude = Math.abs(to - from);
    if (magnitude > Math.max(1, Math.abs(from)) * 20) {
      snap();
      return;
    }

    const start = performance.now();
    const tick = (nowMs: number) => {
      const t = Math.min(1, (nowMs - start) / durationMs);
      setShown(from + (to - from) * easeOut(t));
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        frameRef.current = null;
      }
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      // Leave `from` at the interrupted position so a rapid second change
      // continues from where the eye last saw the number, not from the old one.
      fromRef.current = shown;
    };
    // `shown` is deliberately not a dependency: it changes every frame, and
    // re-running this effect per frame would restart the animation forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationMs]);

  return shown;
}

/**
 * True for a moment after `key` changes — used to flash the thing that changed.
 *
 * Keyed on an arbitrary value (a status string, a run id) rather than a boolean,
 * so callers express "flash when this becomes different" instead of managing
 * their own previous-value bookkeeping.
 */
export function useChangeFlash(key: string | number | null, holdMs = 900): boolean {
  // "Adjust state when a prop changes": compare against the key seen last
  // render and update during render, not in an effect. React re-renders
  // immediately with the new value instead of painting one frame un-flashed and
  // then a second frame flashed.
  const [flash, setFlash] = useState<{ key: string | number | null; on: boolean }>({
    key,
    on: false,
  });
  if (flash.key !== key) {
    setFlash({ key, on: !prefersReducedMotion() });
  }

  useEffect(() => {
    if (!flash.on) return;
    const timer = setTimeout(() => setFlash((f) => ({ ...f, on: false })), holdMs);
    return () => clearTimeout(timer);
  }, [flash, holdMs]);

  return flash.on;
}

/**
 * A per-item entrance delay for a staggered list.
 *
 * Capped deliberately: with 40 rows an uncapped stagger means the last one
 * arrives two seconds late, which stops reading as polish and starts reading as
 * a slow page.
 */
export function staggerDelay(index: number, stepMs = 28, maxMs = 240): string {
  return `${Math.min(index * stepMs, maxMs)}ms`;
}
