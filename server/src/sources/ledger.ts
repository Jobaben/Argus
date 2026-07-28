import { median } from "./watchtower.js";
import type {
  Attribution,
  BudgetAction,
  BudgetConfig,
  BudgetEnforcement,
  BudgetLadderStep,
  BudgetStatus,
  CostDimension,
  CostSlice,
  Forecast,
  LedgerReport,
  WhatIfRequest,
  WhatIfResult,
} from "@argus/contracts";
import type { Verdict } from "./verdict.js";
import type { Run } from "./scheduleTypes.js";
import type { SpendLedger } from "./budget.js";

/**
 * The Ledger's derivations: attribution, forecasting, and the what-if.
 *
 * The rule that shapes all three: **nothing here invents a number.** Attribution
 * sums observed costs. The forecast extrapolates observed days. The what-if
 * compares what two models *have actually cost on this machine* — there is no
 * embedded price list, because a saving computed from a price table looks
 * identical to a measured one and is wrong the week the prices change.
 *
 * The cost of that discipline is that some questions have no answer, and the
 * result types say so out loud (`unavailable`, `confidence: null`) rather than
 * returning a plausible zero.
 */

export type {
  Attribution,
  BudgetAction,
  BudgetEnforcement,
  BudgetLadderStep,
  CostDimension,
  CostSlice,
  Forecast,
  LedgerReport,
  WhatIfRequest,
  WhatIfResult,
} from "@argus/contracts";

/** Days of run history the attribution covers by default. */
export const WINDOW_DAYS = 30;

/** Slices returned per dimension; the rest fold into an "other" row. */
export const SLICE_CAP = 12;

/** Ledger days needed before a projection is offered at all. */
export const MIN_FORECAST_DAYS = 3;

/** …and the number at which it stops carrying a "treat as indicative" note. */
export const CONFIDENT_FORECAST_DAYS = 10;

const PIPELINE_PREFIX = "pipeline:";
const ONEOFF = "oneoff";

const runMoment = (r: Run): string => r.endedAt ?? r.startedAt ?? r.queuedAt;

/** A run that cost something we can attribute. */
function costed(run: Run): boolean {
  return typeof run.costUsd === "number" && Number.isFinite(run.costUsd) && run.costUsd > 0;
}

/**
 * The slice a run belongs to in one dimension, or null when the dimension does
 * not apply — a schedule run has no pipeline, and neither has a model unless
 * one was pinned.
 */
export function sliceOf(run: Run, dimension: CostDimension): { key: string; label: string } | null {
  switch (dimension) {
    case "project":
      return run.project ? { key: run.project, label: decodeProject(run.project) } : null;
    case "schedule":
      return run.scheduleId.startsWith(PIPELINE_PREFIX)
        ? null
        : {
            key: run.scheduleId,
            label: run.scheduleId === ONEOFF ? "One-off runs" : run.scheduleName,
          };
    case "pipeline":
      return run.scheduleId.startsWith(PIPELINE_PREFIX)
        ? {
            key: run.scheduleId.slice(PIPELINE_PREFIX.length),
            // Step runs are named "<pipeline> · <phase>"; the pipeline is the
            // part before the separator.
            label: run.scheduleName.split(" · ")[0],
          }
        : null;
    case "agent":
      // The worker that actually ran. A pipeline phase is its own process and
      // its own cost; rolling it into the pipeline hides which part is
      // expensive, which is usually the question being asked.
      return run.phaseId
        ? { key: `${run.scheduleId}/${run.phaseId}`, label: run.scheduleName }
        : {
            key: `agent:${run.scheduleId}`,
            label: run.scheduleId === ONEOFF ? "One-off runs" : run.scheduleName,
          };
    case "model":
      // A run with no pinned model used the CLI default, which is a real and
      // reportable answer — just not a model *name* Argus can be sure of.
      return { key: run.model ?? "(cli default)", label: run.model ?? "CLI default" };
  }
}

/** The lossy project-dir encoding, made readable. Cosmetic only. */
function decodeProject(encoded: string): string {
  let s = encoded;
  if (s.startsWith("C--")) s = "C:/" + s.slice(3);
  else if (s.startsWith("-")) s = s.slice(1);
  return s.replace(/-/g, "/").replace(/\/+/g, "/");
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Group a window of runs by one dimension, largest spend first. */
export function attribute(runs: Run[], dimension: CostDimension): Attribution {
  const buckets = new Map<string, { label: string; usd: number; tokens: number; runs: number }>();
  let totalUsd = 0;
  let totalTokens = 0;
  let counted = 0;
  let unattributed = 0;

  for (const run of runs) {
    if (!costed(run)) continue;
    counted++;
    totalUsd += run.costUsd as number;
    totalTokens += run.tokens ?? 0;
    const slice = sliceOf(run, dimension);
    if (!slice) {
      unattributed++;
      continue;
    }
    const bucket = buckets.get(slice.key) ?? { label: slice.label, usd: 0, tokens: 0, runs: 0 };
    bucket.usd += run.costUsd as number;
    bucket.tokens += run.tokens ?? 0;
    bucket.runs += 1;
    buckets.set(slice.key, bucket);
  }

  const all: CostSlice[] = [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      label: b.label,
      usd: round4(b.usd),
      tokens: b.tokens,
      runs: b.runs,
      share: totalUsd > 0 ? b.usd / totalUsd : 0,
      perRunUsd: b.runs > 0 ? round4(b.usd / b.runs) : 0,
    }))
    .sort((a, b) => b.usd - a.usd || a.label.localeCompare(b.label));

  // Everything past the cap folds into one row rather than being dropped: a
  // total that doesn't add up is worse than a long tail you can't itemise.
  const slices = all.slice(0, SLICE_CAP);
  const tail = all.slice(SLICE_CAP);
  if (tail.length > 0) {
    const usd = tail.reduce((n, s) => n + s.usd, 0);
    const runs = tail.reduce((n, s) => n + s.runs, 0);
    slices.push({
      key: "__other__",
      label: `${tail.length} more`,
      usd: round4(usd),
      tokens: tail.reduce((n, s) => n + s.tokens, 0),
      runs,
      share: totalUsd > 0 ? usd / totalUsd : 0,
      perRunUsd: runs > 0 ? round4(usd / runs) : 0,
    });
  }

  return {
    dimension,
    slices,
    totalUsd: round4(totalUsd),
    totalTokens,
    runs: counted,
    unattributedRuns: unattributed,
  };
}

// ── Forecast ────────────────────────────────────────────────────────────────

/**
 * Project month-end spend from the daily ledger.
 *
 * A **median** daily rate, not a mean: one runaway backfill day should not set
 * the trend for the rest of the month. The band comes from the observed spread
 * (the 20th and 80th percentile days), so it widens when the days are erratic
 * and narrows when they are not — which is exactly when a reader should trust
 * it more or less.
 *
 * Under {@link MIN_FORECAST_DAYS} of history there is no projection at all.
 * Three data points can be extrapolated into any number you like, and a
 * confident-looking figure derived from two days is worse than no figure.
 */
export function forecast(ledger: SpendLedger, config: BudgetConfig, now: Date): Forecast {
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const entries = Object.entries(ledger.days ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const monthToDateUsd = round4(
    entries.filter(([d]) => d.startsWith(monthPrefix)).reduce((n, [, v]) => n + (v.usd ?? 0), 0),
  );

  // Exclude today: a partial day drags the median down all morning and would
  // make the projection sag and recover on a daily cycle.
  const todayKey = `${monthPrefix}-${String(now.getDate()).padStart(2, "0")}`;
  const past = entries.filter(([d]) => d < todayKey).map(([, v]) => v.usd ?? 0);
  const samples = past.length;

  const base = {
    samples,
    monthToDateUsd,
    dailyUsd: null,
    monthEndUsd: null,
    lowUsd: null,
    highUsd: null,
    confidence: null,
    overLimit: false,
  };

  if (samples < MIN_FORECAST_DAYS) {
    return {
      ...base,
      note: `Only ${samples} full day${samples === 1 ? "" : "s"} of history — not enough to project a month yet.`,
    };
  }

  const daily = median(past);
  const sorted = [...past].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const low = at(0.2);
  const high = at(0.8);

  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const remaining = Math.max(0, daysInMonth - now.getDate());
  const project = (rate: number) => round2(monthToDateUsd + rate * remaining);

  const monthEndUsd = project(daily);
  // Confidence from relative spread: a tight distribution projects well, an
  // erratic one does not, and the number should say which this is.
  const spread = daily > 0 ? (high - low) / daily : 0;
  const confidence = Math.max(0.1, Math.min(0.95, 1 - spread / 2));

  const limit = config.monthlyUsd;
  const overLimit = limit != null && monthEndUsd > limit;

  const indicative =
    samples < CONFIDENT_FORECAST_DAYS ? ` Based on ${samples} days — treat as indicative.` : "";
  const note = overLimit
    ? `On this pace the month ends near $${monthEndUsd.toFixed(2)}, over the $${limit!.toFixed(2)} limit.${indicative}`
    : limit != null
      ? `On this pace the month ends near $${monthEndUsd.toFixed(2)}, inside the $${limit.toFixed(2)} limit.${indicative}`
      : `On this pace the month ends near $${monthEndUsd.toFixed(2)}. No monthly limit is set.${indicative}`;

  return {
    ...base,
    dailyUsd: round4(daily),
    monthEndUsd,
    lowUsd: project(low),
    highUsd: project(high),
    confidence: Math.round(confidence * 100) / 100,
    overLimit,
    note,
  };
}

// ── What-if ─────────────────────────────────────────────────────────────────

/**
 * "What if this work ran on a cheaper model?"
 *
 * Answered entirely from observation: the slice's own cost per run against what
 * the target model has cost on *any* run this machine has made. When the target
 * model has never been used here, the honest answer is "I don't know", not a
 * figure derived from a price list that may be a year out of date.
 *
 * The quality half is the same discipline. If both models have Verdict scores,
 * the median difference is reported with its sample count; if either doesn't,
 * `verdictDelta` is null — because "nobody has measured" is the true answer far
 * more often than "no difference".
 */
export function whatIf(
  runs: Run[],
  verdicts: Verdict[],
  request: WhatIfRequest,
  windowDays: number,
): WhatIfResult {
  const inSlice = runs.filter(
    (r) => costed(r) && sliceOf(r, request.dimension)?.key === request.key,
  );
  const label =
    inSlice.length > 0
      ? (sliceOf(inSlice[0], request.dimension)?.label ?? request.key)
      : request.key;

  const empty: WhatIfResult = {
    ok: false,
    unavailable: null,
    label,
    fromModel: null,
    toModel: request.toModel,
    affectedRuns: inSlice.length,
    currentPerRunUsd: null,
    projectedPerRunUsd: null,
    monthlySavingUsd: null,
    currentMonthlyUsd: null,
    projectedMonthlyUsd: null,
    verdictDelta: null,
    verdictSamples: 0,
    summary: "",
  };

  if (inSlice.length === 0) {
    return { ...empty, unavailable: "no costed runs in this slice yet", summary: "" };
  }

  const currentModels = [...new Set(inSlice.map((r) => r.model ?? "(cli default)"))];
  const fromModel = currentModels.length === 1 ? currentModels[0] : "mixed";
  if (fromModel === request.toModel) {
    return {
      ...empty,
      fromModel,
      unavailable: "this work already runs on that model",
      summary: "",
    };
  }

  const target = runs.filter((r) => costed(r) && (r.model ?? "(cli default)") === request.toModel);
  if (target.length === 0) {
    return {
      ...empty,
      fromModel,
      unavailable: `no runs on "${request.toModel}" to compare against — Argus estimates from what a model has actually cost here, never from a price list`,
      summary: "",
    };
  }

  // Medians on both sides: a single expensive outlier should not decide whether
  // a migration looks worthwhile.
  const currentPerRun = median(inSlice.map((r) => r.costUsd as number));
  const targetPerRun = median(target.map((r) => r.costUsd as number));

  // The slice's own observed run rate, extrapolated to 30 days.
  const runsPerMonth = (inSlice.length / Math.max(1, windowDays)) * 30;
  const currentMonthly = round2(currentPerRun * runsPerMonth);
  const projectedMonthly = round2(targetPerRun * runsPerMonth);
  const saving = round2(currentMonthly - projectedMonthly);

  const scoreFor = (subset: Run[]): number[] => {
    const ids = new Set(subset.map((r) => r.id));
    return verdicts
      .filter((v) => v.status === "ready" && v.score !== null && ids.has(v.runId))
      .map((v) => v.score as number);
  };
  const currentScores = scoreFor(inSlice);
  const targetScores = scoreFor(target);
  const verdictDelta =
    currentScores.length > 0 && targetScores.length > 0
      ? Math.round((median(targetScores) - median(currentScores)) * 10) / 10
      : null;

  const money =
    saving > 0
      ? `saves $${saving.toFixed(2)}/mo`
      : saving < 0
        ? `costs $${Math.abs(saving).toFixed(2)}/mo more`
        : "costs about the same";
  const quality =
    verdictDelta === null
      ? "quality effect unmeasured"
      : verdictDelta === 0
        ? "no measured quality change"
        : `${verdictDelta > 0 ? "+" : ""}${verdictDelta.toFixed(1)} Verdict`;

  return {
    ok: true,
    unavailable: null,
    label,
    fromModel,
    toModel: request.toModel,
    affectedRuns: inSlice.length,
    currentPerRunUsd: round4(currentPerRun),
    projectedPerRunUsd: round4(targetPerRun),
    monthlySavingUsd: saving,
    currentMonthlyUsd: currentMonthly,
    projectedMonthlyUsd: projectedMonthly,
    verdictDelta,
    verdictSamples: currentScores.length + targetScores.length,
    summary: `${request.toModel} on ${label} ${money} at ${quality}`,
  };
}

// ── The policy ladder ───────────────────────────────────────────────────────

const ACTION_ORDER: BudgetAction[] = ["warn", "downgrade", "defer", "stop"];

/**
 * The ladder step in force, given the current spend ratios.
 *
 * The **highest** matching step wins, not the first: with a ladder of
 * warn@0.8 / downgrade@0.9 / stop@1.0, a run at 1.05 must be stopped, and a
 * first-match reading would only have warned it.
 *
 * Both windows are checked; the more severe verdict applies, because a day that
 * is fine inside a month that is not should still be governed by the month.
 */
export function enforcementFor(
  ladder: BudgetLadderStep[] | undefined,
  status: BudgetStatus,
): BudgetEnforcement {
  const none: BudgetEnforcement = {
    action: null,
    atRatio: null,
    model: null,
    window: null,
    detail: "spend is inside the configured limits",
  };
  if (!ladder || ladder.length === 0) return none;

  const windows: { window: "daily" | "monthly"; ratio: number | null }[] = [
    { window: "daily", ratio: status.today.ratio },
    { window: "monthly", ratio: status.month.ratio },
  ];

  let best: (BudgetEnforcement & { severity: number }) | null = null;
  for (const { window, ratio } of windows) {
    if (ratio == null) continue;
    for (const step of ladder) {
      if (ratio < step.atRatio) continue;
      const severity = ACTION_ORDER.indexOf(step.action);
      if (best && severity <= best.severity) continue;
      best = {
        severity,
        action: step.action,
        atRatio: step.atRatio,
        model: step.model ?? null,
        window,
        detail: describeAction(step, window, ratio),
      };
    }
  }
  if (!best) return none;
  const { severity: _severity, ...enforcement } = best;
  return enforcement;
}

function describeAction(step: BudgetLadderStep, window: string, ratio: number): string {
  const at = `${window} spend is at ${Math.round(ratio * 100)}% of its limit`;
  switch (step.action) {
    case "warn":
      return `${at} — warning only`;
    case "downgrade":
      return `${at} — scheduled runs moved to ${step.model ?? "a cheaper model"}`;
    case "defer":
      return `${at} — scheduled slots deferred; manual runs still allowed`;
    case "stop":
      return `${at} — scheduled runs stopped`;
  }
}

export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

export function validateLadder(raw: unknown): BudgetLadderStep[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new LedgerValidationError("ladder must be a list of steps");
  if (raw.length > 6) throw new LedgerValidationError("ladder is capped at 6 steps");

  const steps = raw.map((item, i) => {
    const s = (item ?? {}) as Record<string, unknown>;
    const atRatio = Number(s.atRatio);
    if (!Number.isFinite(atRatio) || atRatio <= 0 || atRatio > 2) {
      throw new LedgerValidationError(`step ${i + 1}: atRatio must be between 0 and 2`);
    }
    if (typeof s.action !== "string" || !ACTION_ORDER.includes(s.action as BudgetAction)) {
      throw new LedgerValidationError(`step ${i + 1}: action must be ${ACTION_ORDER.join(" | ")}`);
    }
    const action = s.action as BudgetAction;
    let model: string | undefined;
    if (action === "downgrade") {
      if (typeof s.model !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(s.model)) {
        throw new LedgerValidationError(`step ${i + 1}: downgrade needs a model to move runs to`);
      }
      model = s.model;
    }
    return { atRatio, action, ...(model ? { model } : {}) };
  });

  // Sorted by threshold so the ladder reads top-to-bottom as it engages, and so
  // an author cannot express "stop at 0.9, warn at 1.0" and be surprised.
  return steps.sort((a, b) => a.atRatio - b.atRatio);
}

// ── The report ──────────────────────────────────────────────────────────────

export function buildLedger(
  runs: Run[],
  ledger: SpendLedger,
  config: BudgetConfig,
  status: BudgetStatus,
  now: Date,
  windowDays = WINDOW_DAYS,
): LedgerReport {
  const floor = now.getTime() - windowDays * 86_400_000;
  const window = runs.filter((r) => {
    const at = Date.parse(runMoment(r));
    return Number.isFinite(at) && at >= floor;
  });

  return {
    generatedAt: now.toISOString(),
    windowDays,
    byProject: attribute(window, "project"),
    byAgent: attribute(window, "agent"),
    bySchedule: attribute(window, "schedule"),
    byPipeline: attribute(window, "pipeline"),
    byModel: attribute(window, "model"),
    forecast: forecast(ledger, config, now),
    enforcement: enforcementFor(config.ladder, status),
  };
}
