/**
 * Watchtower: learned envelopes for what a schedule or phase *normally* costs.
 *
 * A monitor answers "did it run"; an issue answers "did it fail". Neither
 * catches the run that succeeded, took nine minutes instead of two, and burned
 * four dollars instead of forty cents. Watchtower learns each unit of work's
 * own distribution and raises an anomaly when a run leaves it — stated as the
 * multiple a human can act on ("3.2× median cost"), not as a raw z-score.
 *
 * Deliberately dependency-free statistics: median and MAD, not a model. Robust
 * estimators survive the handful of wild outliers that agent runs produce
 * without any training step, and a threshold the reader can verify by hand is
 * worth more here than a threshold they have to trust.
 */

export type AnomalyMetric = "duration" | "cost" | "tokens";

/** Above the envelope, or below it. A run that finished in a tenth of the usual
 *  time usually did a tenth of the usual work. */
export type AnomalyDirection = "high" | "low";

export type AnomalySeverity = "warn" | "critical";

/** What a baseline is computed over: one schedule, or one phase of a pipeline. */
export type BaselineScope = "schedule" | "phase";

export interface MetricBaseline {
  metric: AnomalyMetric;
  /** The centre of the envelope. */
  median: number;
  /** Median absolute deviation — the robust spread, unscaled. */
  mad: number;
  p05: number;
  p95: number;
  min: number;
  max: number;
  samples: number;
}

export interface Baseline {
  /** `schedule:<id>` or `phase:<scheduleId>:<phaseId>` — stable and URL-safe. */
  key: string;
  scope: BaselineScope;
  name: string;
  /** Successful runs the envelope was learned from. */
  samples: number;
  /** How many more successful runs until the envelope is trusted; 0 when ready. */
  warmupRemaining: number;
  /** Oldest sample in the window — moves forward when the baseline is reset. */
  since: string | null;
  /** When the operator last reset this baseline, if ever. */
  resetAt: string | null;
  duration: MetricBaseline | null;
  cost: MetricBaseline | null;
  tokens: MetricBaseline | null;
}

export interface Anomaly {
  /** Deterministic: `<key>|<metric>|<runId>`. The same run always yields the
   *  same id, so alert de-duplication needs no extra state. */
  id: string;
  key: string;
  scope: BaselineScope;
  name: string;
  runId: string;
  scheduleId: string;
  metric: AnomalyMetric;
  direction: AnomalyDirection;
  severity: AnomalySeverity;
  /** The run's observed value, in the metric's own unit (ms / USD / tokens). */
  value: number;
  median: number;
  /** `value / median` — the headline multiple. */
  ratio: number;
  /** Robust z, or null when the sample is degenerate (MAD of zero). */
  zScore: number | null;
  at: string;
  /** One human sentence: "3.2× median cost ($0.42 vs $0.13 over 24 runs)". */
  detail: string;
}

export interface WatchtowerSummary {
  /** Baselines with a trusted envelope. */
  ready: number;
  /** Baselines still warming up. */
  warming: number;
  anomalies: number;
  critical: number;
}

export interface WatchtowerReport {
  generatedAt: string;
  baselines: Baseline[];
  /** Recent anomalies, newest first, within the report window. */
  anomalies: Anomaly[];
  summary: WatchtowerSummary;
  /** Successful runs needed before an envelope is trusted. */
  warmupRuns: number;
}

export type AnomalyEvent = "anomaly.detected";
