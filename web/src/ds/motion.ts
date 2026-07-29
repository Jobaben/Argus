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

/**
 * The motion tokens, for the animations JavaScript drives.
 *
 * `index.css` is still where these are *declared* — every CSS animation reads
 * them as `var(--duration-base)` and none of them may inline a number. But the
 * Web Animations API takes milliseconds, not custom properties, so an
 * interruptible transition has to know the value. Rather than let a `180` appear
 * at a call site (the drift `CommandPalette.tsx` had already started, with a
 * hardcoded `160ms` beside the token system), the numbers live here once and
 * `tokens.test.ts` reads `index.css` and fails if the two disagree.
 */
export const DURATION = {
  quick: 120,
  base: 180,
  slow: 320,
  exit: 126,
  exitQuick: 84,
  press: 70,
} as const;

/** The easings, same contract as {@link DURATION}. */
export const EASE = {
  outExpo: "cubic-bezier(0.16, 1, 0.3, 1)",
  inExpo: "cubic-bezier(0.7, 0, 0.84, 0)",
  spring: "cubic-bezier(0.34, 1.36, 0.64, 1)",
} as const;

/**
 * One shared origin for every free-running ambient animation.
 *
 * Not `Date.now()` at render: two indicators mounting a beat apart would still
 * be out of phase, which is the whole problem. Module load is a fixed point
 * every caller can measure from.
 */
const AMBIENT_EPOCH = Date.now();

/**
 * A negative `animation-delay` that starts an infinite animation part-way
 * through, so every indicator using the same cycle length breathes in phase.
 *
 * The `pulse` and `sweep` indicators free-ran: each started when its component
 * mounted, so on a board with six live steps they drifted into six unrelated
 * rhythms, and six things blinking independently reads as clutter rather than as
 * liveness. In phase, they read as one system with a pulse.
 *
 * Returns `undefined` under reduced motion so callers can spread it into a style
 * object without a branch.
 */
export function syncedDelay(cycleMs: number, nowMs = Date.now()): string | undefined {
  if (!Number.isFinite(cycleMs) || cycleMs <= 0 || prefersReducedMotion()) return undefined;
  const phase = (nowMs - AMBIENT_EPOCH) % cycleMs;
  return `-${Math.round(phase)}ms`;
}

/**
 * {@link syncedDelay}, captured once per mount.
 *
 * Components must not recompute it per render: `animation-delay` is part of an
 * animation's timing, so re-writing it mid-cycle *shifts the animation* — a
 * board that re-renders on every WebSocket frame would jitter its own liveness
 * indicators. The phase is fixed at mount, which is exactly when the element's
 * animation starts.
 */
export function useSyncedDelay(cycleMs: number): string | undefined {
  const [delay] = useState(() => syncedDelay(cycleMs));
  return delay;
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
