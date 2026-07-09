import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
const CLOCK = () => new Date("2026-07-09T12:00:00.000Z");

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-totals-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  const totals = await import(`./totals.js?${Math.random()}`);
  const runs = await import(`./runs.js?${Math.random()}`);
  return { totals, runs };
}

const makeRun = (over: Record<string, unknown>) => ({
  id: "r1",
  scheduleId: "s1",
  scheduleName: "n",
  prompt: "p",
  cwd: "/tmp",
  status: "succeeded",
  trigger: "manual",
  queuedAt: "2026-07-09T11:00:00.000Z",
  startedAt: "2026-07-09T11:00:00.000Z",
  endedAt: "2026-07-09T11:01:00.000Z",
  durationMs: 60000,
  pid: 1,
  exitCode: 0,
  sessionId: null,
  project: null,
  resultSummary: "ok",
  error: null,
  costUsd: 0.5,
  tokens: 1000,
  ...over,
});

test("readTotals returns a zeroed default with a stamped since when absent", async () => {
  const { totals } = await fresh();
  const t = await totals.readTotals();
  assert.equal(t.usd, 0);
  assert.equal(t.tokens, 0);
  assert.equal(t.runsCounted, 0);
  assert.equal(typeof t.since, "string");
});

test("accumulateRun folds a terminal run's cost in exactly once", async () => {
  const { totals, runs } = await fresh();
  await runs.writeRun(makeRun({}));
  await totals.accumulateRun("r1", CLOCK);
  await totals.accumulateRun("r1", CLOCK); // second call is a no-op
  const t = await totals.readTotals();
  assert.equal(t.usd, 0.5);
  assert.equal(t.tokens, 1000);
  assert.equal(t.runsCounted, 1);
  assert.equal((await runs.readRun("r1"))!.run.countedInTotals, true);
});

test("accumulateRun skips running runs and runs without cost", async () => {
  const { totals, runs } = await fresh();
  await runs.writeRun(makeRun({ id: "running", status: "running" }));
  await runs.writeRun(makeRun({ id: "nocost", costUsd: null, tokens: null }));
  await totals.accumulateRun("running", CLOCK);
  await totals.accumulateRun("nocost", CLOCK);
  const t = await totals.readTotals();
  assert.equal(t.runsCounted, 0);
});

test("accumulateRun adds tokens even when only tokens are present", async () => {
  const { totals, runs } = await fresh();
  await runs.writeRun(makeRun({ costUsd: null, tokens: 250 }));
  await totals.accumulateRun("r1", CLOCK);
  const t = await totals.readTotals();
  assert.equal(t.usd, 0);
  assert.equal(t.tokens, 250);
  assert.equal(t.runsCounted, 1);
});

test("accumulateRun serializes concurrent calls for distinct runs (no lost update)", async () => {
  const { totals, runs } = await fresh();
  await runs.writeRun(makeRun({ id: "rA", scheduleId: "s1" }));
  await runs.writeRun(makeRun({ id: "rB", scheduleId: "s1", costUsd: 0.25, tokens: 500 }));
  await Promise.all([totals.accumulateRun("rA", CLOCK), totals.accumulateRun("rB", CLOCK)]);
  const t = await totals.readTotals();
  assert.equal(t.usd, 0.75);
  assert.equal(t.tokens, 1500);
  assert.equal(t.runsCounted, 2);
});

test("accumulateRun serializes concurrent calls for the same run (folds exactly once)", async () => {
  const { totals, runs } = await fresh();
  await runs.writeRun(makeRun({}));
  await Promise.all([totals.accumulateRun("r1", CLOCK), totals.accumulateRun("r1", CLOCK)]);
  const t = await totals.readTotals();
  assert.equal(t.usd, 0.5);
  assert.equal(t.tokens, 1000);
  assert.equal(t.runsCounted, 1);
});

test("resetTotals zeroes counters and re-stamps since", async () => {
  const { totals, runs } = await fresh();
  await runs.writeRun(makeRun({}));
  await totals.accumulateRun("r1", CLOCK);
  const reset = await totals.resetTotals(CLOCK);
  assert.equal(reset.usd, 0);
  assert.equal(reset.tokens, 0);
  assert.equal(reset.runsCounted, 0);
  assert.equal(reset.since, "2026-07-09T12:00:00.000Z");
  assert.deepEqual(await totals.readTotals(), reset);
});
