/**
 * Pure percentage math for the Chronicle timeline: spans and axis ticks are
 * positioned relative to a [windowStart, windowEnd] range so the view renders
 * with plain absolute positioning and no measurement.
 */

export interface SpanGeometry {
  /** Left edge, percent of the window width. */
  left: number;
  /** Width, percent of the window width (never below the minimum). */
  width: number;
  /** True when the span is still in flight and drawn through "now". */
  openEnded: boolean;
}

/**
 * Floor on a span's rendered width, as a percentage of the panel.
 *
 * A 40-second run inside a 7-day window is ~0.03% wide — mathematically correct
 * and completely unusable: you cannot see it, and you certainly cannot hover it
 * for its tooltip. 1.2% is ~16px on a 1400px panel, which is a real target.
 * The cost is that very short spans look equal in length; the tooltip carries
 * the true duration.
 */
const MIN_WIDTH_PCT = 1.2;

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/**
 * Position a span inside the window. Spans straddling the window edges are
 * clipped; instant/short spans get a minimum visible width. Returns null for
 * unparsable timestamps or spans entirely outside the window.
 */
export function spanGeometry(
  startedAt: string,
  endedAt: string | null,
  windowStartMs: number,
  windowEndMs: number,
): SpanGeometry | null {
  const range = windowEndMs - windowStartMs;
  if (range <= 0) return null;
  const start = new Date(startedAt).getTime();
  if (Number.isNaN(start)) return null;
  const openEnded = endedAt == null;
  const rawEnd = openEnded ? windowEndMs : new Date(endedAt).getTime();
  if (Number.isNaN(rawEnd)) return null;
  const end = Math.max(start, rawEnd);
  if (end < windowStartMs || start > windowEndMs) return null;

  const left = clampPct(((start - windowStartMs) / range) * 100);
  const right = clampPct(((end - windowStartMs) / range) * 100);
  const width = Math.max(MIN_WIDTH_PCT, right - left);
  // Keep the minimum-width bar inside the panel when it lands at the far edge.
  return { left: Math.min(left, 100 - width), width, openEnded };
}

export interface AxisTick {
  pct: number;
  label: string;
}

/** "14:05" for sub-2-day windows, "Mon 14:05" beyond that. */
export function tickLabel(atMs: number, rangeMs: number): string {
  const d = new Date(atMs);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (rangeMs <= 48 * 3_600_000) return time;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${day} ${time}`;
}

/** Evenly spaced ticks across the window, inclusive of the start edge. */
export function axisTicks(windowStartMs: number, windowEndMs: number, count = 6): AxisTick[] {
  const range = windowEndMs - windowStartMs;
  if (range <= 0 || count < 1) return [];
  const ticks: AxisTick[] = [];
  for (let i = 0; i < count; i++) {
    const pct = (i / count) * 100;
    const at = windowStartMs + (range * i) / count;
    ticks.push({ pct, label: tickLabel(at, range) });
  }
  return ticks;
}

/**
 * Shortens a lane label to its trailing path segments.
 *
 * Lane labels are mostly project paths, and a path is identified by its *tail*
 * — `home/mtrushbad/GIT/spectacle` matters as "GIT/spectacle". Wrapping the
 * whole thing broke words mid-token ("wareh / ouse") and cost two lines per
 * lane; truncating from the front keeps the identifying part and stays on one.
 * The full label remains available as a tooltip.
 */
export function shortenLanePath(label: string, segments = 2): string {
  const parts = label.split("/").filter(Boolean);
  if (parts.length <= segments) return label;
  return `…/${parts.slice(-segments).join("/")}`;
}
