import type { RecorderEvent, RecorderLane } from "../types";

/**
 * The pure maths behind the Flight Recorder's track.
 *
 * Kept out of the component for the usual reason — a scrubber is all
 * off-by-ones (which event is "current" at exactly its own timestamp? what
 * happens at t=0 with no events?) and those are worth testing directly rather
 * than through a rendered DOM.
 */

/** How many columns the density strip is quantized into. */
export const TRACK_COLUMNS = 220;

/**
 * Per-column occupancy for one lane, 0–1.
 *
 * A long run puts thousands of events on a track a few hundred pixels wide.
 * Rendering one node per event is both slow and illegible — the marks overlap
 * into a solid bar. Quantizing into columns and shading by density keeps the
 * shape of the run readable (where the tool storms were, where it went quiet)
 * at a bounded DOM cost.
 */
export function laneDensity(
  events: RecorderEvent[],
  lane: RecorderLane,
  durationMs: number,
  columns: number = TRACK_COLUMNS,
): number[] {
  const cols = new Array<number>(columns).fill(0);
  if (durationMs <= 0) return cols;
  let peak = 0;
  for (const e of events) {
    if (e.lane !== lane) continue;
    const col = Math.min(columns - 1, Math.max(0, Math.floor((e.atMs / durationMs) * columns)));
    cols[col] += 1;
    if (cols[col] > peak) peak = cols[col];
  }
  if (peak === 0) return cols;
  return cols.map((n) => n / peak);
}

/**
 * The index of the event the playhead is "on" at time `t`: the last event at or
 * before it. Returns -1 before the first event, which the caller renders as
 * "not started yet" rather than pinning to event zero.
 *
 * Binary search because this runs on every animation frame during playback.
 * Events are guaranteed non-decreasing in `atMs` by the server derivation.
 */
export function indexAtTime(events: RecorderEvent[], t: number): number {
  let lo = 0;
  let hi = events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].atMs <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The next event index in `dir` from time `t`, skipping the whole cluster that
 * shares the current timestamp — stepping forward through twelve events that
 * all sit at 00:42 should advance the clock, not just the selection.
 */
export function stepIndex(events: RecorderEvent[], t: number, dir: 1 | -1): number | null {
  if (events.length === 0) return null;
  if (dir === 1) {
    for (let i = 0; i < events.length; i++) {
      if (events[i].atMs > t) return i;
    }
    return null;
  }
  const current = indexAtTime(events, t);
  // Walking back from the event *before* the current one skips a same-instant
  // cluster in one press instead of appearing to do nothing.
  for (let i = Math.min(current, events.length - 1) - 1; i >= 0; i--) {
    if (events[i].atMs < t) return i;
  }
  return null;
}

/**
 * A window of `size` events centred on `index`, clamped to the ends. The list
 * pane renders only this slice: a 2000-row list re-rendered every frame is the
 * one thing that would make playback stutter.
 */
export function eventWindow(
  events: RecorderEvent[],
  index: number,
  size: number,
): { start: number; slice: RecorderEvent[] } {
  if (events.length === 0) return { start: 0, slice: [] };
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(events.length - size, Math.max(0, index) - half));
  return {
    start: Math.max(0, start),
    slice: events.slice(Math.max(0, start), Math.max(0, start) + size),
  };
}

/** "00:42" / "1:02:03" — the scrubber's clock. */
export function trackTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
