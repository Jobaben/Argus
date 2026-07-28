import { paths } from "../claudeHome.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import type {
  Anomaly,
  AnomalyDirection,
  AnomalyMetric,
  Baseline,
  BaselineScope,
  MetricBaseline,
  WatchtowerReport,
} from "@argus/contracts";
import type { Run } from "./scheduleTypes.js";

/**
 * Watchtower: per-schedule and per-phase envelopes learned from history.
 *
 * The whole derivation is pure — `(runs, resets, now) → WatchtowerReport` — so
 * every threshold decision below is exercised directly in tests rather than
 * inferred from a rendered chart.
 *
 * Four decisions worth defending, because each one is a way this could have
 * been noise instead of signal:
 *
 * **Baselines learn from successes only.** A crashed run that died in two
 * seconds is not evidence about how long the work takes; folding failures into
 * the envelope drags the median down and then flags every *healthy* run as
 * slow. Failures are still *evaluated* against the envelope — they just don't
 * shape it.
 *
 * **Both a z-score and a ratio must agree.** Robust z alone fires constantly on
 * tightly-clustered metrics: a schedule that always costs exactly $0.01 has a
 * MAD near zero, so $0.012 is "twenty sigma". Requiring a real multiple as well
 * means the alert is always something a human would also call unusual.
 *
 * **Degenerate spread falls back to ratio alone.** When every sample is
 * identical the MAD is exactly zero and z is undefined — not infinite. Those
 * cases report `zScore: null` and lean on the ratio, rather than pretending to
 * a precision the data doesn't support.
 *
 * **Warm-up is explicit.** Under {@link WARMUP_RUNS} successful samples the
 * envelope is shown but never fires. A median of three runs is a rumour.
 */

export type {
  Anomaly,
  AnomalyDirection,
  AnomalyMetric,
  AnomalySeverity,
  Baseline,
  BaselineScope,
  MetricBaseline,
  WatchtowerReport,
  WatchtowerSummary,
} from "@argus/contracts";

/** Successful runs required before an envelope is allowed to fire. */
export const WARMUP_RUNS = 8;

/** Samples retained per key. Beyond this the oldest drop out, so an envelope
 *  tracks how the work behaves *now* rather than how it behaved in March. */
export const SAMPLE_WINDOW = 100;

/** Anomalies older than this are not reported; they are history, not news. */
export const ANOMALY_WINDOW_MS = 14 * 24 * 3_600_000;

/** Most recent anomalies returned. */
export const ANOMALY_CAP = 100;

/** Robust z beyond which a value is outside the envelope. */
const Z_THRESHOLD = 3.5;
/** …and the multiple of the median it must also clear, so a tight-but-tiny
 *  distribution can't turn rounding noise into an alert. */
const RATIO_HIGH = 1.5;
const RATIO_LOW = 0.5;
/** Ratio-only thresholds, used when the spread is degenerate (MAD = 0). */
const DEGENERATE_RATIO_HIGH = 2;
const DEGENERATE_RATIO_LOW = 0.5;
/** Above these, an anomaly is critical rather than a warning. */
const CRITICAL_RATIO = 3;
const CRITICAL_Z = 7;

/** MAD → standard-deviation-equivalent for a normal distribution. */
const MAD_TO_SIGMA = 1.4826;

/** Values below this are treated as "no measurement" rather than as zero: a
 *  run with a null cost and a run that genuinely cost nothing are different
 *  facts, and only the second belongs in a distribution. */
const EPSILON = 1e-9;

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;

/** Persisted reset markers — the only Watchtower state on disk. */
export interface BaselineReset {
  key: string;
  resetAt: string;
}

const store = createJsonArrayStore<BaselineReset>({
  file: paths.watchtowerFile,
  label: "watchtower.json",
});

export class WatchtowerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchtowerValidationError";
  }
}

export const readResets = store.read;

/** Mark "learn from here": runs before `now` stop counting for this key. */
export async function resetBaseline(key: string, now: Date): Promise<BaselineReset> {
  assertKey(key);
  const record: BaselineReset = { key, resetAt: now.toISOString() };
  return store.withLock(async () => {
    const list = await store.read();
    await store.write([...list.filter((r) => r.key !== key), record]);
    return record;
  });
}

/** Drop a reset marker, restoring the full history for a key. */
export async function clearBaselineReset(key: string): Promise<boolean> {
  assertKey(key);
  return store.withLock(async () => {
    const list = await store.read();
    const next = list.filter((r) => r.key !== key);
    if (next.length === list.length) return false;
    await store.write(next);
    return true;
  });
}

function assertKey(key: string): void {
  if (!KEY_RE.test(key)) throw new WatchtowerValidationError("invalid baseline key");
}

// ── Statistics ──────────────────────────────────────────────────────────────

/** Median of a non-empty numeric array. Sorts a copy — callers keep their order. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile (0–1), which never invents a value between samples. */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

/** Median absolute deviation — the spread estimator that a single 40× outlier
 *  cannot move, which is exactly the shape agent-run metrics have. */
export function medianAbsoluteDeviation(values: number[], centre: number): number {
  return median(values.map((v) => Math.abs(v - centre)));
}

function baselineFor(metric: AnomalyMetric, values: number[]): MetricBaseline | null {
  if (values.length === 0) return null;
  const med = median(values);
  return {
    metric,
    median: med,
    mad: medianAbsoluteDeviation(values, med),
    p05: percentile(values, 0.05),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
    samples: values.length,
  };
}

// ── Grouping ────────────────────────────────────────────────────────────────

/**
 * The unit of work a run belongs to.
 *
 * A pipeline's phases have wildly different shapes — a two-second lint step and
 * a ten-minute build share a pipeline but nothing else — so they get their own
 * envelopes rather than one averaged into meaninglessness.
 */
export function baselineKey(run: Run): { key: string; scope: BaselineScope; name: string } {
  if (run.phaseId) {
    return {
      key: `phase:${run.scheduleId}:${run.phaseId}`,
      scope: "phase",
      name: `${run.scheduleName} › ${run.phaseId}`,
    };
  }
  return { key: `schedule:${run.scheduleId}`, scope: "schedule", name: run.scheduleName };
}

const metricOf = (run: Run, metric: AnomalyMetric): number | null => {
  const raw = metric === "duration" ? run.durationMs : metric === "cost" ? run.costUsd : run.tokens;
  if (raw == null || !Number.isFinite(raw) || raw <= EPSILON) return null;
  return raw;
};

const METRICS: AnomalyMetric[] = ["duration", "cost", "tokens"];

const runMoment = (run: Run): string => run.endedAt ?? run.startedAt ?? run.queuedAt;

/** Terminal runs only: a run still in flight has no duration to judge. */
function isTerminal(run: Run): boolean {
  return run.status !== "running" && run.endedAt != null;
}

// ── Detection ───────────────────────────────────────────────────────────────

const UNIT: Record<AnomalyMetric, (v: number) => string> = {
  duration: (v) => (v >= 60_000 ? `${(v / 60_000).toFixed(1)}m` : `${(v / 1000).toFixed(1)}s`),
  cost: (v) => (v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`),
  tokens: (v) =>
    v >= 1_000_000
      ? `${(v / 1_000_000).toFixed(1)}M`
      : v >= 1000
        ? `${(v / 1000).toFixed(1)}k`
        : String(v),
};

const NOUN: Record<AnomalyMetric, string> = {
  duration: "duration",
  cost: "cost",
  tokens: "token use",
};

/**
 * Judge one observation against an envelope. Exported because the threshold
 * logic is the whole feature: it deserves direct tests, not tests of a route
 * that happens to call it.
 */
export function judge(
  base: MetricBaseline,
  value: number,
): { direction: AnomalyDirection; ratio: number; zScore: number | null } | null {
  if (base.median <= EPSILON) return null;
  const ratio = value / base.median;
  const sigma = base.mad * MAD_TO_SIGMA;

  if (sigma <= EPSILON) {
    // Every sample identical: z is undefined, not enormous. Ratio alone decides.
    if (ratio >= DEGENERATE_RATIO_HIGH) return { direction: "high", ratio, zScore: null };
    if (ratio <= DEGENERATE_RATIO_LOW) return { direction: "low", ratio, zScore: null };
    return null;
  }

  const z = (value - base.median) / sigma;
  if (z >= Z_THRESHOLD && ratio >= RATIO_HIGH) return { direction: "high", ratio, zScore: z };
  if (z <= -Z_THRESHOLD && ratio <= RATIO_LOW) return { direction: "low", ratio, zScore: z };
  return null;
}

function describe(
  metric: AnomalyMetric,
  direction: AnomalyDirection,
  value: number,
  base: MetricBaseline,
  ratio: number,
): string {
  const multiple = direction === "high" ? ratio : 1 / ratio;
  const word = direction === "high" ? "" : "of the ";
  return (
    `${multiple.toFixed(1)}× ${word}median ${NOUN[metric]} ` +
    `(${UNIT[metric](value)} vs ${UNIT[metric](base.median)} over ${base.samples} runs)`
  );
}

function severityOf(ratio: number, zScore: number | null, direction: AnomalyDirection) {
  const multiple = direction === "high" ? ratio : ratio > 0 ? 1 / ratio : Infinity;
  if (multiple >= CRITICAL_RATIO) return "critical" as const;
  if (zScore != null && Math.abs(zScore) >= CRITICAL_Z) return "critical" as const;
  return "warn" as const;
}

/**
 * Build the full report: one baseline per unit of work, plus every anomaly in
 * the reporting window.
 *
 * `runs` may arrive in any order; the derivation sorts what it needs. Runs
 * before a key's reset marker are excluded from both the envelope and the
 * evaluation, so "reset" means "forget", not "hide".
 */
export function buildWatchtower(runs: Run[], resets: BaselineReset[], now: Date): WatchtowerReport {
  const resetByKey = new Map(resets.map((r) => [r.key, r.resetAt]));
  const groups = new Map<
    string,
    { scope: BaselineScope; name: string; newestAt: string; runs: Run[] }
  >();

  for (const run of runs) {
    if (!isTerminal(run)) continue;
    const { key, scope, name } = baselineKey(run);
    const resetAt = resetByKey.get(key);
    if (resetAt && runMoment(run) < resetAt) continue;
    const at = runMoment(run);
    const group = groups.get(key);
    if (group) {
      group.runs.push(run);
      // The freshest name wins: a renamed schedule should not read under its
      // old label. Tracked against a running maximum rather than the
      // first-seen run, because `runs` arrives in no guaranteed order and
      // comparing to element zero picks the wrong name on a mixed sequence.
      if (at > group.newestAt) {
        group.newestAt = at;
        group.name = name;
      }
    } else {
      groups.set(key, { scope, name, newestAt: at, runs: [run] });
    }
  }

  const baselines: Baseline[] = [];
  const anomalies: Anomaly[] = [];
  const windowFloor = now.getTime() - ANOMALY_WINDOW_MS;

  for (const [key, group] of groups) {
    // Newest first, then windowed: an envelope describes recent behaviour.
    const ordered = [...group.runs].sort((a, b) => runMoment(b).localeCompare(runMoment(a)));
    const window = ordered.slice(0, SAMPLE_WINDOW);
    const successes = window.filter((r) => r.status === "succeeded");

    const metricBaselines = Object.fromEntries(
      METRICS.map((m) => [
        m,
        baselineFor(
          m,
          successes.map((r) => metricOf(r, m)).filter((v): v is number => v !== null),
        ),
      ]),
    ) as Record<AnomalyMetric, MetricBaseline | null>;

    const resetAt = resetByKey.get(key) ?? null;
    const oldest = window[window.length - 1];
    baselines.push({
      key,
      scope: group.scope,
      name: group.name,
      samples: successes.length,
      warmupRemaining: Math.max(0, WARMUP_RUNS - successes.length),
      since: oldest ? runMoment(oldest) : null,
      resetAt,
      duration: metricBaselines.duration,
      cost: metricBaselines.cost,
      tokens: metricBaselines.tokens,
    });

    if (successes.length < WARMUP_RUNS) continue;

    for (const run of window) {
      const at = runMoment(run);
      if (Date.parse(at) < windowFloor) continue;
      for (const metric of METRICS) {
        const base = metricBaselines[metric];
        const value = metricOf(run, metric);
        if (!base || value === null) continue;
        // A run inside the sample set is judged against a baseline it helped
        // form. With a median that is exactly what we want: one outlier cannot
        // move the centre enough to hide itself.
        const verdict = judge(base, value);
        if (!verdict) continue;
        anomalies.push({
          id: `${key}|${metric}|${run.id}`,
          key,
          scope: group.scope,
          name: group.name,
          runId: run.id,
          scheduleId: run.scheduleId,
          metric,
          direction: verdict.direction,
          severity: severityOf(verdict.ratio, verdict.zScore, verdict.direction),
          value,
          median: base.median,
          ratio: verdict.ratio,
          zScore: verdict.zScore,
          at,
          detail: describe(metric, verdict.direction, value, base, verdict.ratio),
        });
      }
    }
  }

  anomalies.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
  const capped = anomalies.slice(0, ANOMALY_CAP);
  baselines.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));

  return {
    generatedAt: now.toISOString(),
    baselines,
    anomalies: capped,
    summary: {
      ready: baselines.filter((b) => b.warmupRemaining === 0).length,
      warming: baselines.filter((b) => b.warmupRemaining > 0).length,
      anomalies: capped.length,
      critical: capped.filter((a) => a.severity === "critical").length,
    },
    warmupRuns: WARMUP_RUNS,
  };
}
