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
  /** Starts a day or a longer unit: the tick that names where it is, as
   *  against an hour inside the day. */
  major: boolean;
}

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The steps an axis can be read against, finest first. The minute steps all
 * divide a day, so a tick lands on the same clock times every day; the day
 * steps count from the first of the month, and a half month is the 1st and
 * the 15th.
 */
type Step = { unit: "minute" | "day" | "month"; n: number };
const STEPS: Step[] = [
  ...[5, 10, 15, 30, 60, 120, 180, 240, 360, 720].map((n) => ({ unit: "minute" as const, n })),
  { unit: "day", n: 1 },
  { unit: "day", n: 2 },
  { unit: "month", n: 0.5 },
  ...[1, 2, 3, 6, 12].map((n) => ({ unit: "month" as const, n })),
];

const stepMs = ({ unit, n }: Step): number =>
  unit === "minute" ? n * MINUTE : unit === "day" ? n * DAY : n * 30.44 * DAY;

const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Every instant on `step`'s grid in (start, end], in local time. */
function gridTimes(step: Step, start: number, end: number): Date[] {
  const s = new Date(start);
  const [y, m, d] = [s.getFullYear(), s.getMonth(), s.getDate()];
  const out: Date[] = [];
  for (let k = 0; ; k++) {
    const at =
      step.unit === "minute"
        ? new Date(y, m, d, 0, k * step.n)
        : step.unit === "day"
          ? new Date(y, m, d + k)
          : step.n < 1
            ? new Date(y, m + Math.floor(k / 2), k % 2 === 0 ? 1 : 15)
            : new Date(y, m + k, 1);
    if (at.getTime() > end) return out;
    // A clock time a spring-forward night skips resolves to the hour after
    // it, which the grid's next step lands on too: one tick, not two.
    if (at.getTime() <= start || at.getTime() === out.at(-1)?.getTime()) continue;
    const onGrid =
      step.unit === "day"
        ? (at.getDate() - 1) % step.n === 0
        : step.unit === "month" && step.n >= 1
          ? at.getMonth() % step.n === 0
          : true;
    if (onGrid) out.push(at);
  }
}

/** What a tick says: as little as tells it apart from its neighbours. */
function label(at: Date, step: Step): string {
  if (step.unit === "minute") {
    // Midnight says which day it starts, so a window over a day boundary
    // shows where the boundary is.
    return at.getHours() === 0 && at.getMinutes() === 0 ? WEEKDAYS[at.getDay()] : hhmm(at);
  }
  if (step.unit === "day") return `${WEEKDAYS[at.getDay()]} ${at.getDate()}`;
  if (step.n < 1) return `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getMonth() === 0 ? String(at.getFullYear()) : MONTHS[at.getMonth()];
}

/**
 * Ticks at round times for the window — every four hours on a day, midnights
 * on a week, months on a year — placed where they fall, at most `max` of them.
 * They used to be the window's start plus sixths of its length, so a day read
 * "02:03 06:03 10:03…": minutes that looked like data, not like a scale.
 */
export function axisTicks(windowStartMs: number, windowEndMs: number, max = 7): AxisTick[] {
  const range = windowEndMs - windowStartMs;
  if (!Number.isFinite(range) || range <= 0 || max < 1) return [];
  const step = STEPS.find((s) => stepMs(s) * max >= range) ?? STEPS[STEPS.length - 1];
  return gridTimes(step, windowStartMs, windowEndMs).map((at) => ({
    pct: ((at.getTime() - windowStartMs) / range) * 100,
    label: label(at, step),
    major: step.unit !== "minute" || (at.getHours() === 0 && at.getMinutes() === 0),
  }));
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
