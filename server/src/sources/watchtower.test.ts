import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ANOMALY_WINDOW_MS,
  WARMUP_RUNS,
  WatchtowerValidationError,
  baselineKey,
  buildWatchtower,
  clearBaselineReset,
  judge,
  median,
  medianAbsoluteDeviation,
  percentile,
  readResets,
  resetBaseline,
  type BaselineReset,
  type MetricBaseline,
} from "./watchtower.js";
import type { Run } from "./scheduleTypes.js";

beforeEach(() => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-watchtower-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
});

const NOW = new Date("2026-07-20T12:00:00.000Z");
let seq = 0;

function run(over: Partial<Run> = {}): Run {
  seq += 1;
  const at = new Date(NOW.getTime() - seq * 3_600_000).toISOString();
  return {
    id: `r${seq}`,
    scheduleId: "s1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/tmp",
    status: "succeeded",
    trigger: "scheduled",
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    durationMs: 60_000,
    pid: 1,
    exitCode: 0,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
    costUsd: 0.1,
    tokens: 1000,
    ...over,
  };
}

/** A healthy history with slight natural jitter, enough to pass warm-up. */
function healthy(count = 12, over: Partial<Run> = {}): Run[] {
  return Array.from({ length: count }, (_, i) =>
    run({
      durationMs: 60_000 + (i % 3) * 1000,
      costUsd: 0.1 + (i % 3) * 0.002,
      tokens: 1000 + (i % 3) * 20,
      ...over,
    }),
  );
}

// ── Statistics ──────────────────────────────────────────────────────────────

test("median handles odd and even lengths without mutating the input", () => {
  const values = [5, 1, 3];
  assert.equal(median(values), 3);
  assert.deepEqual(values, [5, 1, 3], "input order preserved");
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("percentile is nearest-rank, never interpolating a value that never occurred", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 0.05), 1);
  assert.equal(percentile(values, 0.95), 10);
  assert.equal(percentile(values, 0.5), 5);
});

test("MAD ignores a single wild outlier the way a standard deviation cannot", () => {
  const tight = [10, 10, 11, 10, 9];
  const withOutlier = [...tight, 100_000];
  const a = medianAbsoluteDeviation(tight, median(tight));
  const b = medianAbsoluteDeviation(withOutlier, median(withOutlier));
  assert.ok(b <= a + 1, `MAD barely moved: ${a} → ${b}`);
});

// ── The threshold rule ──────────────────────────────────────────────────────

const base = (over: Partial<MetricBaseline> = {}): MetricBaseline => ({
  metric: "cost",
  median: 0.1,
  mad: 0.01,
  p05: 0.09,
  p95: 0.12,
  min: 0.09,
  max: 0.12,
  samples: 20,
  ...over,
});

test("judge fires only when the z-score AND the ratio both agree", () => {
  // Far in z terms but barely a multiple: 0.14 is ~2.7σ, under the z bar.
  assert.equal(judge(base(), 0.14), null);
  // Big multiple and far in z: fires high.
  const high = judge(base(), 0.4);
  assert.equal(high?.direction, "high");
  assert.ok((high?.ratio ?? 0) > 3);
  // A normal run does not fire.
  assert.equal(judge(base(), 0.105), null);
});

test("regression: a tight distribution cannot turn rounding noise into an alert", () => {
  // A schedule that always costs almost exactly the same: MAD is tiny, so a
  // z-only rule would call $0.0102 a twenty-sigma event.
  const tight = base({ median: 0.01, mad: 0.00001 });
  assert.equal(judge(tight, 0.0102), null, "1.02× must not alert");
  assert.ok(judge(tight, 0.02), "2× still alerts");
});

test("regression: an identical-sample distribution reports no z rather than infinity", () => {
  const degenerate = base({ median: 100, mad: 0 });
  assert.equal(judge(degenerate, 105), null, "5% off an exact distribution is not news");
  const verdict = judge(degenerate, 250);
  assert.equal(verdict?.direction, "high");
  assert.equal(verdict?.zScore, null, "no finite z is claimed");
  assert.equal(judge(degenerate, 10)?.direction, "low");
});

test("judge declines to divide by a zero median", () => {
  assert.equal(judge(base({ median: 0 }), 5), null);
});

// ── The report ──────────────────────────────────────────────────────────────

test("nothing fires before the warm-up threshold, and the shortfall is reported", () => {
  // The spike run is itself a success, so it counts toward warm-up: one short.
  const runs = [...healthy(WARMUP_RUNS - 2), run({ costUsd: 50, tokens: 900_000 })];
  const report = buildWatchtower(runs, [], NOW);
  assert.equal(report.anomalies.length, 0);
  const b = report.baselines[0];
  assert.equal(b.warmupRemaining, 1);
  assert.equal(report.summary.warming, 1);
  assert.equal(report.summary.ready, 0);
});

test("a cost spike past warm-up is reported as the multiple, not a z-score", () => {
  const runs = [...healthy(), run({ costUsd: 0.42, durationMs: 60_000, tokens: 1000 })];
  const report = buildWatchtower(runs, [], NOW);
  const cost = report.anomalies.find((a) => a.metric === "cost");
  assert.ok(cost, "a cost anomaly was raised");
  assert.equal(cost.direction, "high");
  assert.match(cost.detail, /× median cost/);
  assert.match(cost.detail, /\$0\.42 vs \$0\.10/);
  assert.equal(cost.severity, "critical"); // >3× the median
  assert.equal(cost.id, `schedule:s1|cost|${cost.runId}`);
});

test("a run that finished suspiciously fast is a low anomaly", () => {
  const runs = [...healthy(), run({ durationMs: 2_000, costUsd: 0.1, tokens: 1000 })];
  const report = buildWatchtower(runs, [], NOW);
  const dur = report.anomalies.find((a) => a.metric === "duration");
  assert.ok(dur);
  assert.equal(dur.direction, "low");
  assert.match(dur.detail, /× of the median duration/);
});

test("regression: baselines learn from successes only, so a crash cannot drag the envelope down", () => {
  // Twelve healthy 60s runs plus a dozen 1s crashes. If failures shaped the
  // envelope the median would collapse and every healthy run would read as slow.
  const runs = [
    ...healthy(),
    ...Array.from({ length: 12 }, () =>
      run({ status: "failed", exitCode: 1, durationMs: 1_000, costUsd: 0.001, tokens: 10 }),
    ),
  ];
  const report = buildWatchtower(runs, [], NOW);
  const b = report.baselines[0];
  assert.equal(b.samples, 12, "only the successes were sampled");
  assert.ok(b.duration && b.duration.median >= 60_000);
  // The crashes are still *judged* — they are wildly below the envelope.
  assert.ok(report.anomalies.some((a) => a.metric === "duration" && a.direction === "low"));
});

test("phases get their own envelopes rather than being averaged into the pipeline", () => {
  const runs = [
    ...healthy(10, { scheduleId: "pipeline:p1", phaseId: "lint", durationMs: 2_000 }),
    ...healthy(10, { scheduleId: "pipeline:p1", phaseId: "build", durationMs: 600_000 }),
  ];
  const report = buildWatchtower(runs, [], NOW);
  assert.equal(report.baselines.length, 2);
  const lint = report.baselines.find((b) => b.key.endsWith(":lint"));
  const build = report.baselines.find((b) => b.key.endsWith(":build"));
  assert.equal(lint?.scope, "phase");
  assert.ok(lint!.duration!.median < build!.duration!.median);
  // Neither is an anomaly against its own envelope.
  assert.equal(report.anomalies.length, 0);
});

test("baselineKey separates schedule runs from phase runs", () => {
  assert.deepEqual(baselineKey(run()), {
    key: "schedule:s1",
    scope: "schedule",
    name: "Nightly triage",
  });
  const phase = baselineKey(run({ scheduleId: "pipeline:p1", phaseId: "build" }));
  assert.equal(phase.key, "phase:pipeline:p1:build");
  assert.equal(phase.scope, "phase");
});

test("a reset forgets prior history for that key alone", async () => {
  const spike = run({ costUsd: 0.42 });
  const runs = [...healthy(), spike];
  const before = buildWatchtower(runs, [], NOW);
  assert.ok(before.anomalies.length > 0);

  // Reset to *after* every existing run: the key has no samples left.
  const resets: BaselineReset[] = [
    { key: "schedule:s1", resetAt: new Date(NOW.getTime() + 1000).toISOString() },
  ];
  const after = buildWatchtower(runs, resets, NOW);
  assert.equal(after.baselines.length, 0, "every sample was before the reset point");
  assert.equal(after.anomalies.length, 0);
});

test("runs missing a metric are skipped rather than counted as zero", () => {
  const runs = healthy(12, { costUsd: null, tokens: null });
  const report = buildWatchtower(runs, [], NOW);
  const b = report.baselines[0];
  assert.equal(b.cost, null);
  assert.equal(b.tokens, null);
  assert.ok(b.duration);
});

test("still-running runs contribute nothing — there is no duration to judge yet", () => {
  const runs = [...healthy(), run({ status: "running", endedAt: null, durationMs: null })];
  const report = buildWatchtower(runs, [], NOW);
  assert.equal(report.baselines[0].samples, 12);
});

test("anomalies older than the report window are history, not news", () => {
  const stale = new Date(NOW.getTime() - ANOMALY_WINDOW_MS - 3_600_000).toISOString();
  const runs = [
    ...healthy(),
    run({ costUsd: 0.42, queuedAt: stale, startedAt: stale, endedAt: stale }),
  ];
  const report = buildWatchtower(runs, [], NOW);
  assert.equal(report.anomalies.length, 0);
});

test("regression: the freshest schedule name wins whatever order the runs arrive in", () => {
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  const named = (hoursAgo: number, scheduleName: string) =>
    run({ scheduleName, queuedAt: at(hoursAgo), startedAt: at(hoursAgo), endedAt: at(hoursAgo) });

  // Deliberately mixed: oldest, newest, middle. Comparing each run against the
  // *first* one seen (rather than a running maximum) picked "Middle" here.
  const report = buildWatchtower(
    [named(30, "Oldest"), named(1, "Newest"), named(15, "Middle")],
    [],
    NOW,
  );
  assert.equal(report.baselines[0].name, "Newest");
});

test("an empty history is an empty report, not a throw", () => {
  const report = buildWatchtower([], [], NOW);
  assert.deepEqual(report.baselines, []);
  assert.deepEqual(report.anomalies, []);
  assert.equal(report.summary.ready, 0);
  assert.equal(report.warmupRuns, WARMUP_RUNS);
});

// ── Reset persistence ───────────────────────────────────────────────────────

test("reset markers round-trip and are replaced, not duplicated", async () => {
  await resetBaseline("schedule:s1", NOW);
  await resetBaseline("schedule:s1", new Date(NOW.getTime() + 1000));
  const list = await readResets();
  assert.equal(list.length, 1);
  assert.equal(list[0].resetAt, new Date(NOW.getTime() + 1000).toISOString());
});

test("clearing a reset reports whether anything was removed", async () => {
  await resetBaseline("schedule:s1", NOW);
  assert.equal(await clearBaselineReset("schedule:s1"), true);
  assert.equal(await clearBaselineReset("schedule:s1"), false);
  assert.deepEqual(await readResets(), []);
});

test("a key that could escape its namespace is rejected", async () => {
  for (const bad of ["../../etc/passwd", "schedule:s1/../x", "", "a b", "x".repeat(300)]) {
    await assert.rejects(() => resetBaseline(bad, NOW), WatchtowerValidationError);
  }
});
