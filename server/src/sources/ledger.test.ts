import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIDENT_FORECAST_DAYS,
  LedgerValidationError,
  MIN_FORECAST_DAYS,
  SLICE_CAP,
  attribute,
  buildLedger,
  enforcementFor,
  forecast,
  sliceOf,
  validateLadder,
  whatIf,
} from "./ledger.js";
import type { BudgetConfig, BudgetStatus } from "@argus/contracts";
import type { SpendLedger } from "./budget.js";
import type { Verdict } from "./verdict.js";
import type { Run } from "./scheduleTypes.js";

const NOW = new Date(2026, 6, 20, 12, 0, 0); // 20 July 2026, local
let seq = 0;

function run(over: Partial<Run> = {}): Run {
  seq += 1;
  const at = new Date(NOW.getTime() - seq * 3_600_000).toISOString();
  return {
    id: `r${seq}`,
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/repo",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    durationMs: 1000,
    pid: 1,
    exitCode: 0,
    sessionId: null,
    project: "-home-you-repo",
    resultSummary: "ok",
    error: null,
    costUsd: 0.1,
    tokens: 1000,
    ...over,
  };
}

const CONFIG: BudgetConfig = {
  dailyUsd: 10,
  monthlyUsd: 200,
  blockScheduled: false,
  updatedAt: null,
};

const status = (todayRatio: number | null, monthRatio: number | null): BudgetStatus => ({
  state: "ok",
  today: { spentUsd: 0, limitUsd: 10, ratio: todayRatio },
  month: { spentUsd: 0, limitUsd: 200, ratio: monthRatio },
  blockScheduled: false,
});

// ── Attribution ─────────────────────────────────────────────────────────────

test("sliceOf keeps schedules and pipelines apart, and names the CLI default", () => {
  assert.deepEqual(sliceOf(run(), "schedule"), {
    key: "s1",
    label: "Nightly triage",
  });
  assert.equal(sliceOf(run({ scheduleId: "pipeline:p1" }), "schedule"), null);
  assert.deepEqual(
    sliceOf(run({ scheduleId: "pipeline:p1", scheduleName: "Release train · Build" }), "pipeline"),
    { key: "p1", label: "Release train" },
  );
  assert.deepEqual(sliceOf(run(), "model"), { key: "(cli default)", label: "CLI default" });
  assert.deepEqual(sliceOf(run({ model: "haiku" }), "model"), { key: "haiku", label: "haiku" });
  assert.equal(sliceOf(run({ project: null }), "project"), null);
  assert.equal(sliceOf(run({ scheduleId: "oneoff" }), "schedule")?.label, "One-off runs");
});

test("attribution sums observed cost and reports the share and per-run rate", () => {
  const a = attribute(
    [
      run({ scheduleId: "s1", scheduleName: "A", costUsd: 0.3 }),
      run({ scheduleId: "s1", scheduleName: "A", costUsd: 0.1 }),
      run({ scheduleId: "s2", scheduleName: "B", costUsd: 0.6 }),
    ],
    "schedule",
  );
  assert.equal(a.totalUsd, 1);
  assert.equal(a.runs, 3);
  assert.equal(a.slices[0].key, "s2", "biggest spender first");
  assert.equal(a.slices[0].share, 0.6);
  assert.equal(a.slices[1].perRunUsd, 0.2);
});

test("regression: runs with no cost are counted as unattributed, not as zero", () => {
  // Silently dropping them would make "3 runs, $0.40" read as $0.13 a run when
  // it is really $0.20 across the two that reported.
  const a = attribute(
    [run({ costUsd: 0.2 }), run({ costUsd: 0.2 }), run({ costUsd: null })],
    "schedule",
  );
  assert.equal(a.runs, 2);
  assert.equal(a.slices[0].perRunUsd, 0.2);
});

test("a run outside the dimension is unattributed rather than dropped from the total", () => {
  const a = attribute(
    [run({ costUsd: 0.5 }), run({ scheduleId: "pipeline:p1", costUsd: 0.5 })],
    "schedule",
  );
  assert.equal(a.totalUsd, 1, "the total is all costed runs");
  assert.equal(a.unattributedRuns, 1);
  assert.equal(a.slices.length, 1);
});

test("regression: the long tail folds into one row so the numbers still add up", () => {
  const many = Array.from({ length: SLICE_CAP + 5 }, (_, i) =>
    run({ scheduleId: `s${i}`, scheduleName: `S${i}`, costUsd: 1 }),
  );
  const a = attribute(many, "schedule");
  assert.equal(a.slices.length, SLICE_CAP + 1);
  const other = a.slices.at(-1)!;
  assert.equal(other.key, "__other__");
  assert.equal(other.runs, 5);
  assert.equal(
    Math.round(a.slices.reduce((n, s) => n + s.usd, 0)),
    Math.round(a.totalUsd),
    "the rows sum to the total",
  );
});

test("an empty window is an empty attribution, not a divide by zero", () => {
  const a = attribute([], "model");
  assert.deepEqual(a.slices, []);
  assert.equal(a.totalUsd, 0);
});

// ── Forecast ────────────────────────────────────────────────────────────────

function ledgerOf(days: Record<string, number>): SpendLedger {
  return {
    days: Object.fromEntries(
      Object.entries(days).map(([d, usd]) => [d, { usd, tokens: 0, runs: 1 }]),
    ),
  };
}

test("regression: under a few days of history there is no projection at all", () => {
  // Two data points extrapolate to any number you like, and a confident-looking
  // figure derived from them is worse than no figure.
  const f = forecast(ledgerOf({ "2026-07-18": 5, "2026-07-19": 5 }), CONFIG, NOW);
  assert.equal(f.samples, 2);
  assert.equal(f.monthEndUsd, null);
  assert.equal(f.confidence, null);
  assert.match(f.note, /not enough to project/);
  assert.ok(MIN_FORECAST_DAYS > 2);
});

test("a steady history projects to month end with a tight band", () => {
  const days: Record<string, number> = {};
  for (let d = 1; d <= 19; d++) days[`2026-07-${String(d).padStart(2, "0")}`] = 5;
  const f = forecast(ledgerOf(days), CONFIG, NOW);
  assert.equal(f.samples, 19);
  assert.equal(f.dailyUsd, 5);
  // 19 days at $5 = $95 so far, plus 11 remaining days.
  assert.equal(f.monthToDateUsd, 95);
  assert.equal(f.monthEndUsd, 150);
  assert.equal(f.lowUsd, 150);
  assert.equal(f.highUsd, 150);
  assert.ok((f.confidence ?? 0) > 0.9, "a flat history is confidently projectable");
  assert.equal(f.overLimit, false);
});

test("regression: one runaway day does not set the trend", () => {
  // A mean would. The median is what makes a single backfill day survivable.
  const days: Record<string, number> = {};
  for (let d = 1; d <= 19; d++) days[`2026-07-${String(d).padStart(2, "0")}`] = 1;
  days["2026-07-10"] = 500;
  const f = forecast(ledgerOf(days), CONFIG, NOW);
  assert.equal(f.dailyUsd, 1, "the median ignores the spike");
  assert.ok((f.highUsd ?? 0) >= (f.monthEndUsd ?? 0), "but the band still widens");
});

test("an erratic history projects with lower confidence and a wider band", () => {
  const days: Record<string, number> = {};
  for (let d = 1; d <= 19; d++)
    days[`2026-07-${String(d).padStart(2, "0")}`] = d % 2 === 0 ? 1 : 12;
  const f = forecast(ledgerOf(days), CONFIG, NOW);
  assert.ok((f.confidence ?? 1) < 0.6);
  assert.ok((f.highUsd ?? 0) > (f.lowUsd ?? 0));
});

test("a projection over the limit says so, and a short history says it is indicative", () => {
  const days: Record<string, number> = {};
  for (let d = 1; d <= 19; d++) days[`2026-07-${String(d).padStart(2, "0")}`] = 20;
  assert.match(forecast(ledgerOf(days), CONFIG, NOW).note, /over the \$200\.00 limit/);

  const few: Record<string, number> = {};
  for (let d = 1; d <= MIN_FORECAST_DAYS + 1; d++) {
    few[`2026-07-${String(d).padStart(2, "0")}`] = 1;
  }
  const short = forecast(ledgerOf(few), CONFIG, NOW);
  assert.ok(short.samples < CONFIDENT_FORECAST_DAYS);
  assert.match(short.note, /treat as indicative/);
});

test("regression: today's partial day is excluded from the daily rate", () => {
  // Including it would make the projection sag every morning and recover every
  // evening, on a daily cycle.
  const days: Record<string, number> = {};
  for (let d = 1; d <= 19; d++) days[`2026-07-${String(d).padStart(2, "0")}`] = 5;
  days["2026-07-20"] = 0.1; // today, barely started
  const f = forecast(ledgerOf(days), CONFIG, NOW);
  assert.equal(f.dailyUsd, 5);
  assert.equal(f.monthToDateUsd, 95.1, "…but it still counts toward month-to-date");
});

test("with no monthly limit the note says so rather than implying one", () => {
  const days: Record<string, number> = {};
  for (let d = 1; d <= 19; d++) days[`2026-07-${String(d).padStart(2, "0")}`] = 5;
  const f = forecast(ledgerOf(days), { ...CONFIG, monthlyUsd: null }, NOW);
  assert.match(f.note, /No monthly limit is set/);
  assert.equal(f.overLimit, false);
});

// ── What-if ─────────────────────────────────────────────────────────────────

const verdict = (runId: string, score: number): Verdict => ({
  runId,
  scheduleId: "s1",
  scheduleName: "n",
  phaseId: null,
  status: "ready",
  at: NOW.toISOString(),
  score,
  criteria: [],
  summary: null,
  regression: false,
  minScore: null,
  costUsd: null,
  tokens: null,
  durationMs: null,
  error: null,
});

test("regression: with no runs on the target model, the answer is 'I don't know'", () => {
  // Not a figure derived from a price list — that would look identical to a
  // measured one and be wrong the week the prices change.
  const res = whatIf(
    [run({ scheduleId: "s1", model: "opus", costUsd: 1 })],
    [],
    { dimension: "schedule", key: "s1", toModel: "haiku" },
    30,
  );
  assert.equal(res.ok, false);
  assert.match(res.unavailable ?? "", /never from a price list/);
  assert.equal(res.monthlySavingUsd, null);
});

test("a saving is the observed difference, extrapolated at the slice's own run rate", () => {
  const runs = [
    run({ scheduleId: "s1", model: "opus", costUsd: 1 }),
    run({ scheduleId: "s1", model: "opus", costUsd: 1 }),
    run({ scheduleId: "s2", model: "haiku", costUsd: 0.1 }),
    run({ scheduleId: "s2", model: "haiku", costUsd: 0.1 }),
  ];
  const res = whatIf(runs, [], { dimension: "schedule", key: "s1", toModel: "haiku" }, 30);
  assert.equal(res.ok, true);
  assert.equal(res.fromModel, "opus");
  assert.equal(res.currentPerRunUsd, 1);
  assert.equal(res.projectedPerRunUsd, 0.1);
  // 2 runs in 30 days → 2/month; (1 − 0.1) × 2 = $1.80.
  assert.equal(res.monthlySavingUsd, 1.8);
  assert.match(res.summary, /saves \$1\.80\/mo/);
});

test("the quality half is reported only when both models have been scored", () => {
  const runs = [
    run({ id: "a", scheduleId: "s1", model: "opus", costUsd: 1 }),
    run({ id: "b", scheduleId: "s2", model: "haiku", costUsd: 0.1 }),
  ];
  const unscored = whatIf(runs, [], { dimension: "schedule", key: "s1", toModel: "haiku" }, 30);
  assert.equal(unscored.verdictDelta, null);
  assert.match(unscored.summary, /quality effect unmeasured/);

  const scored = whatIf(
    runs,
    [verdict("a", 8), verdict("b", 6.5)],
    { dimension: "schedule", key: "s1", toModel: "haiku" },
    30,
  );
  assert.equal(scored.verdictDelta, -1.5);
  assert.equal(scored.verdictSamples, 2);
  assert.match(scored.summary, /-1\.5 Verdict/);
});

test("moving work to the model it already uses is refused, politely", () => {
  const res = whatIf(
    [run({ scheduleId: "s1", model: "haiku", costUsd: 0.1 })],
    [],
    { dimension: "schedule", key: "s1", toModel: "haiku" },
    30,
  );
  assert.equal(res.ok, false);
  assert.match(res.unavailable ?? "", /already runs on that model/);
});

test("a slice with no costed runs says so instead of returning zeros", () => {
  const res = whatIf([], [], { dimension: "schedule", key: "s1", toModel: "haiku" }, 30);
  assert.match(res.unavailable ?? "", /no costed runs/);
});

test("a change that costs more is reported as costing more, not as a negative saving", () => {
  const runs = [
    run({ scheduleId: "s1", model: "haiku", costUsd: 0.1 }),
    run({ scheduleId: "s2", model: "opus", costUsd: 1 }),
  ];
  const res = whatIf(runs, [], { dimension: "schedule", key: "s1", toModel: "opus" }, 30);
  assert.ok((res.monthlySavingUsd ?? 0) < 0);
  assert.match(res.summary, /costs \$0\.90\/mo more/);
});

// ── The ladder ──────────────────────────────────────────────────────────────

const LADDER = [
  { atRatio: 0.8, action: "warn" as const },
  { atRatio: 0.9, action: "downgrade" as const, model: "haiku" },
  { atRatio: 1, action: "stop" as const },
];

test("regression: the highest matching step wins, not the first", () => {
  // A first-match reading would only *warn* a run that is 5% over the limit.
  assert.equal(enforcementFor(LADDER, status(1.05, null)).action, "stop");
  assert.equal(enforcementFor(LADDER, status(0.95, null)).action, "downgrade");
  assert.equal(enforcementFor(LADDER, status(0.85, null)).action, "warn");
  assert.equal(enforcementFor(LADDER, status(0.5, null)).action, null);
});

test("the more severe of the two windows applies", () => {
  // A day that is fine inside a month that is not should still be governed.
  const e = enforcementFor(LADDER, status(0.1, 1.2));
  assert.equal(e.action, "stop");
  assert.equal(e.window, "monthly");
});

test("an enforcement carries a sentence fit for the run record", () => {
  const e = enforcementFor(LADDER, status(0.95, null));
  assert.equal(e.model, "haiku");
  assert.match(e.detail, /daily spend is at 95%/);
  assert.match(e.detail, /moved to haiku/);
});

test("no ladder, or no limits, means no enforcement", () => {
  assert.equal(enforcementFor(undefined, status(2, 2)).action, null);
  assert.equal(enforcementFor([], status(2, 2)).action, null);
  assert.equal(enforcementFor(LADDER, status(null, null)).action, null);
});

test("a ladder is validated and sorted, so it reads as it engages", () => {
  const steps = validateLadder([
    { atRatio: 1, action: "stop" },
    { atRatio: 0.8, action: "warn" },
  ]);
  assert.deepEqual(
    steps?.map((s) => s.action),
    ["warn", "stop"],
  );
  assert.equal(validateLadder(undefined), undefined);
  assert.deepEqual(validateLadder([]), []);
});

test("an unusable ladder is rejected with a message that says what to fix", () => {
  assert.throws(() => validateLadder([{ atRatio: 0, action: "warn" }]), /between 0 and 2/);
  assert.throws(() => validateLadder([{ atRatio: 1, action: "explode" }]), /action must be/);
  assert.throws(
    () => validateLadder([{ atRatio: 1, action: "downgrade" }]),
    /needs a model to move runs to/,
  );
  assert.throws(() => validateLadder("nope"), LedgerValidationError);
});

// ── The report ──────────────────────────────────────────────────────────────

test("the report windows runs and carries every dimension", () => {
  const old = new Date(NOW.getTime() - 60 * 86_400_000).toISOString();
  const report = buildLedger(
    [run({ costUsd: 1 }), run({ costUsd: 99, queuedAt: old, startedAt: old, endedAt: old })],
    ledgerOf({}),
    CONFIG,
    status(0.1, 0.1),
    NOW,
  );
  assert.equal(report.windowDays, 30);
  assert.equal(report.byProject.totalUsd, 1, "the 60-day-old run is outside the window");
  assert.deepEqual(
    [
      report.byProject.dimension,
      report.bySchedule.dimension,
      report.byPipeline.dimension,
      report.byModel.dimension,
    ],
    ["project", "schedule", "pipeline", "model"],
  );
  assert.equal(report.enforcement.action, null);
});
