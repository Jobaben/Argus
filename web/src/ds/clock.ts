import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * One ticking clock for every relative timestamp in the app.
 *
 * Two problems solved together. Relative labels went stale: "3m ago" was
 * computed at render and stayed "3m ago" until something unrelated re-rendered
 * the tree, so a quiet dashboard quietly lied about how old its data was. And
 * reading `Date.now()` during render is impure — the value depends on when React
 * happened to re-render, which is exactly the class of bug the rule exists for.
 *
 * The alternative — an interval per timestamp — would mean dozens of timers on
 * the board. This is a single module-level interval, started on the first
 * subscriber and cleared with the last, exposed through `useSyncExternalStore`.
 * The snapshot is *quantised* to the tick so it is referentially stable between
 * ticks (a raw `Date.now()` snapshot would make the store re-render forever).
 */

/** Coarse enough to be cheap, fine enough that "45s ago" is honest. */
export const CLOCK_TICK_MS = 15_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let snapshot = quantise(Date.now());

function quantise(ms: number): number {
  return Math.floor(ms / CLOCK_TICK_MS) * CLOCK_TICK_MS;
}

function tick(): void {
  const next = quantise(Date.now());
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    // Re-quantise on the first subscriber: the module may have been idle across
    // a sleep/resume, leaving a snapshot minutes out of date.
    snapshot = quantise(Date.now());
    timer = setInterval(tick, CLOCK_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return snapshot;
}

/**
 * The current time, quantised to {@link CLOCK_TICK_MS} and re-rendering the
 * caller when it advances. Use for any label that says how long ago something
 * happened; use a local interval only when you need sub-tick precision (a
 * running step's elapsed time, the next-fire countdown).
 */
export function useClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * A private, faster clock for the few places that need sub-tick precision: a
 * running step's elapsed time, a countdown to the next firing, a reconnect
 * timer. Pass `active: false` to stop the interval entirely — an idle board
 * should not be ticking once a second for nothing.
 *
 * Distinct from {@link useClock} on purpose. This one is per-component and
 * un-quantised, which is what makes it precise and also what makes it
 * inappropriate for the dozens of "3m ago" labels the shared clock serves.
 */
export function useTicker(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** Exposed for tests: forces a tick without waiting for the interval. */
export function advanceClockForTest(): void {
  snapshot = quantise(Date.now());
  for (const listener of listeners) listener();
}
