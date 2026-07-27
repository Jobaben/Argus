/**
 * The Ledger: where the money went, where it is going, and what to do about it.
 *
 * The budget page already answered "how much today, how much this month". This
 * answers the three questions that follow: **which work** is spending it, **how
 * much** the month will end at, and **what would change** if you moved one
 * thing to a cheaper model.
 *
 * Everything here is computed from runs Argus actually observed. No model price
 * list is embedded, and none is inferred: a saving estimate is the difference
 * between what two models *have cost here*, or it is absent. A number invented
 * from a price table would look identical to a measured one and be wrong the
 * week the prices change.
 */

/** How spend is grouped. */
export type CostDimension = "project" | "schedule" | "pipeline" | "model";

export interface CostSlice {
  /** Stable identity within the dimension. */
  key: string;
  label: string;
  usd: number;
  tokens: number;
  runs: number;
  /** Fraction of the window's total spend, 0–1. */
  share: number;
  /** Mean USD per run — what a marginal run of this slice costs. */
  perRunUsd: number;
}

export interface Attribution {
  dimension: CostDimension;
  slices: CostSlice[];
  totalUsd: number;
  totalTokens: number;
  runs: number;
  /** Runs in the window that reported no cost, so the totals are honest. */
  unattributedRuns: number;
}

export interface Forecast {
  /** Days of ledger history the projection is built from. */
  samples: number;
  /** Robust daily rate — a median, so one runaway day doesn't set the trend. */
  dailyUsd: number | null;
  /** Spend so far this calendar month. */
  monthToDateUsd: number;
  /** Projected month-end total, and the band around it. */
  monthEndUsd: number | null;
  lowUsd: number | null;
  highUsd: number | null;
  /** 0–1, from how tight the daily history is. Null when there is too little. */
  confidence: number | null;
  /** Whether the projection crosses the configured monthly limit. */
  overLimit: boolean;
  /** One sentence a human can act on, including "not enough history yet". */
  note: string;
}

export interface WhatIfRequest {
  dimension: CostDimension;
  /** The slice to change, e.g. a schedule id. */
  key: string;
  /** The model to move it to. */
  toModel: string;
}

export interface WhatIfResult {
  ok: boolean;
  /** Why the question cannot be answered from observed data, when it can't. */
  unavailable: string | null;
  label: string;
  fromModel: string | null;
  toModel: string;
  affectedRuns: number;
  currentPerRunUsd: number | null;
  projectedPerRunUsd: number | null;
  /** Positive = a saving. Extrapolated at the slice's observed run rate. */
  monthlySavingUsd: number | null;
  currentMonthlyUsd: number | null;
  projectedMonthlyUsd: number | null;
  /**
   * Observed quality difference between the two models, in Verdict points.
   * Negative means the cheaper model scored worse. Null when either side has no
   * scores — the honest answer to "what does this cost in quality" is often
   * "nobody has measured".
   */
  verdictDelta: number | null;
  /** Verdict samples behind `verdictDelta`, so the reader can weigh it. */
  verdictSamples: number;
  /** The headline, already phrased: "saves $41/mo at −0.2 Verdict". */
  summary: string;
}

/** What the budget does as spend climbs. */
export type BudgetAction = "warn" | "downgrade" | "defer" | "stop";

export interface BudgetLadderStep {
  /** Fraction of the limit at which this step engages, 0–2. */
  atRatio: number;
  action: BudgetAction;
  /** For `downgrade`: the model scheduled runs are moved to. */
  model?: string;
}

/** The step in force right now, if any. */
export interface BudgetEnforcement {
  action: BudgetAction | null;
  atRatio: number | null;
  model: string | null;
  /** Which window triggered it. */
  window: "daily" | "monthly" | null;
  /** One sentence for the UI and for the run record. */
  detail: string;
}

export interface LedgerReport {
  generatedAt: string;
  /** The window the attribution covers, in days. */
  windowDays: number;
  byProject: Attribution;
  bySchedule: Attribution;
  byPipeline: Attribution;
  byModel: Attribution;
  forecast: Forecast;
  enforcement: BudgetEnforcement;
}
