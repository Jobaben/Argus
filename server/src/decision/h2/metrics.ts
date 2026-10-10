import type { H2Distribution, H2Proportion, H2ReliabilityBucket } from "@argus/contracts";

/**
 * The statistics the H2 report prints (RFC §P.7). Every function is pure and
 * deterministic, and none of them invents a number for an empty sample: n = 0
 * gives null, never zero.
 */

/** The two-sided 95 % normal quantile. */
export const Z95 = 1.959963984540054;
/** Reliability buckets below this size are unmeasured (RFC §H.3: "about 20"). */
export const MIN_BUCKET = 20;
/** ECE is unmeasured below this many items (RFC §H.4). */
export const MIN_ECE_N = 200;
export const BUCKETS = 10;

/** Fixed six-decimal rounding, so replayed bytes do not carry float noise. */
export const round6 = (x: number): number => {
  const r = Math.round(x * 1e6) / 1e6;
  // Canonical JSON refuses -0, and a rounded tiny negative is one.
  return r === 0 ? 0 : r;
};

/** Wilson score interval, 95 %. */
export function wilson(k: number, n: number): H2Proportion {
  if (n <= 0) return { k, n, value: null, ci95: null };
  const p = k / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    k,
    n,
    value: round6(p),
    ci95: [round6(Math.max(0, centre - half)), round6(Math.min(1, centre + half))],
  };
}

/** Nearest-rank percentile: the smallest value with at least p of the sample at or below it. */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1];
}

export function distribution(values: readonly number[]): H2Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

export function totals(values: ReadonlyArray<number | null>) {
  const known = values.filter((v): v is number => v !== null);
  const total = known.reduce((s, v) => s + v, 0);
  return {
    total: round6(total),
    meanKnown: known.length ? round6(total / known.length) : null,
    known: known.length,
    unknown: values.length - known.length,
  };
}

/** The unique most probable key, or `tie` when two or more share the maximum exactly. */
export function uniqueTop(p: Readonly<Record<string, number>>, keys: readonly string[]): string {
  let best: string | null = null;
  let tied = false;
  for (const k of keys) {
    const v = p[k];
    if (best === null || v > p[best]) {
      best = k;
      tied = false;
    } else if (v === p[best]) {
      tied = true;
    }
  }
  return best === null || tied ? "tie" : best;
}

/** One item's multiclass Brier term: Σ over every option of (p − y)². Range [0, 2]. */
export function brierTerm(
  p: Readonly<Record<string, number>>,
  keys: readonly string[],
  ref: string,
): number {
  let s = 0;
  for (const k of keys) {
    const y = k === ref ? 1 : 0;
    s += ((p[k] ?? 0) - y) ** 2;
  }
  return s;
}

/**
 * Cohen's κ over (reference, prediction) pairs. `tie` is an ordinary
 * prediction category that no reference carries. Null when there are no
 * pairs or chance agreement is already 1.
 */
export function cohensKappa(pairs: ReadonlyArray<readonly [string, string]>): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const refs = new Map<string, number>();
  const preds = new Map<string, number>();
  let agree = 0;
  for (const [r, p] of pairs) {
    refs.set(r, (refs.get(r) ?? 0) + 1);
    preds.set(p, (preds.get(p) ?? 0) + 1);
    if (r === p) agree++;
  }
  const po = agree / n;
  let pe = 0;
  for (const [k, c] of refs) pe += (c / n) * ((preds.get(k) ?? 0) / n);
  if (pe >= 1) return null;
  return round6((po - pe) / (1 - pe));
}

export interface Calibrated {
  confidence: number;
  correct: boolean;
}

/** Equal-width bins over top-probability confidence; bin = min(9, floor(10·c)). */
export function reliability(
  items: readonly Calibrated[],
  minBucket = MIN_BUCKET,
): H2ReliabilityBucket[] {
  const bins = Array.from({ length: BUCKETS }, () => ({ n: 0, conf: 0, correct: 0 }));
  for (const it of items) {
    const b = bins[Math.min(BUCKETS - 1, Math.floor(it.confidence * BUCKETS))];
    b.n++;
    b.conf += it.confidence;
    if (it.correct) b.correct++;
  }
  return bins.map((b, i) => {
    const measured = b.n >= minBucket;
    return {
      lower: round6(i / BUCKETS),
      upper: round6((i + 1) / BUCKETS),
      n: b.n,
      status: measured ? "measured" : "unmeasured",
      meanConfidence: measured ? round6(b.conf / b.n) : null,
      accuracy: measured ? round6(b.correct / b.n) : null,
    };
  });
}

/** Expected calibration error, n-weighted over every non-empty bin; null below `minN`. */
export function expectedCalibrationError(
  items: readonly Calibrated[],
  minN = MIN_ECE_N,
): number | null {
  if (items.length < minN) return null;
  const bins = Array.from({ length: BUCKETS }, () => ({ n: 0, conf: 0, correct: 0 }));
  for (const it of items) {
    const b = bins[Math.min(BUCKETS - 1, Math.floor(it.confidence * BUCKETS))];
    b.n++;
    b.conf += it.confidence;
    if (it.correct) b.correct++;
  }
  let e = 0;
  for (const b of bins) {
    if (b.n === 0) continue;
    e += (b.n / items.length) * Math.abs(b.correct / b.n - b.conf / b.n);
  }
  return round6(e);
}
