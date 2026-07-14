import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BudgetValidationError,
  buildBudgetStatus,
  dayKey,
  recentDays,
  validateBudgetPatch,
  type BudgetConfig,
  type SpendLedger,
} from "./budget.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-budget-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function load() {
  return import(`./budget.js?${Math.random()}`);
}

const NOW = new Date(2026, 6, 13, 12, 0); // local 2026-07-13
const cfg = (over: Partial<BudgetConfig> = {}): BudgetConfig => ({
  dailyUsd: null,
  monthlyUsd: null,
  blockScheduled: false,
  updatedAt: null,
  ...over,
});
const ledger = (days: SpendLedger["days"]): SpendLedger => ({ days });

test("dayKey is the local calendar date", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("status is unset without limits, ok/warning/exceeded against the daily limit", () => {
  const spend = ledger({ "2026-07-13": { usd: 8, tokens: 100, runs: 2 } });
  assert.equal(buildBudgetStatus(cfg(), spend, NOW).state, "unset");
  assert.equal(buildBudgetStatus(cfg({ dailyUsd: 20 }), spend, NOW).state, "ok");
  assert.equal(buildBudgetStatus(cfg({ dailyUsd: 10 }), spend, NOW).state, "warning");
  assert.equal(buildBudgetStatus(cfg({ dailyUsd: 8 }), spend, NOW).state, "exceeded");
});

test("month window sums every day of the current local month", () => {
  const spend = ledger({
    "2026-07-01": { usd: 5, tokens: 0, runs: 1 },
    "2026-07-13": { usd: 7, tokens: 0, runs: 1 },
    "2026-06-30": { usd: 100, tokens: 0, runs: 1 }, // previous month — excluded
  });
  const status = buildBudgetStatus(cfg({ monthlyUsd: 15 }), spend, NOW);
  assert.equal(status.month.spentUsd, 12);
  assert.equal(status.state, "warning");
  assert.equal(status.today.spentUsd, 7);
});

test("the worst window wins: monthly exceeded beats daily ok", () => {
  const spend = ledger({
    "2026-07-01": { usd: 50, tokens: 0, runs: 1 },
    "2026-07-13": { usd: 1, tokens: 0, runs: 1 },
  });
  const status = buildBudgetStatus(cfg({ dailyUsd: 100, monthlyUsd: 40 }), spend, NOW);
  assert.equal(status.state, "exceeded");
});

test("recordRunSpend accumulates into the endedAt day and prunes old keys", async () => {
  const budget = await load();
  await budget.recordRunSpend(
    { endedAt: "2026-07-13T04:00:00.000Z", queuedAt: "", costUsd: 1.5, tokens: 100 },
    () => NOW,
  );
  await budget.recordRunSpend(
    { endedAt: "2026-07-13T05:00:00.000Z", queuedAt: "", costUsd: 0.5, tokens: 50 },
    () => NOW,
  );
  // Costless runs never touch the ledger.
  await budget.recordRunSpend({ endedAt: null, queuedAt: "", costUsd: null }, () => NOW);
  const spend = await budget.readSpendLedger();
  const key = dayKey(new Date("2026-07-13T04:00:00.000Z"));
  assert.deepEqual(spend.days[key], { usd: 2, tokens: 150, runs: 2 });
});

test("ledger pruning keeps only the newest LEDGER_KEEP_DAYS keys", async () => {
  const budget = await load();
  for (let i = 0; i < budget.LEDGER_KEEP_DAYS + 5; i++) {
    const d = new Date(2024, 0, 1 + i, 12, 0);
    await budget.recordRunSpend(
      { endedAt: d.toISOString(), queuedAt: "", costUsd: 0.01 },
      () => NOW,
    );
  }
  const spend = await budget.readSpendLedger();
  assert.equal(Object.keys(spend.days).length, budget.LEDGER_KEEP_DAYS);
});

test("recentDays zero-fills and stays chronological", () => {
  const spend = ledger({ "2026-07-12": { usd: 3, tokens: 30, runs: 1 } });
  const days = recentDays(spend, NOW, 3);
  assert.deepEqual(
    days.map((d) => d.date),
    ["2026-07-11", "2026-07-12", "2026-07-13"],
  );
  assert.equal(days[1].usd, 3);
  assert.equal(days[2].usd, 0);
});

test("validateBudgetPatch accepts positive limits, null to clear, and booleans", () => {
  assert.deepEqual(validateBudgetPatch({ dailyUsd: 5, blockScheduled: true }), {
    dailyUsd: 5,
    blockScheduled: true,
  });
  assert.deepEqual(validateBudgetPatch({ monthlyUsd: null }), { monthlyUsd: null });
  assert.throws(() => validateBudgetPatch({ dailyUsd: 0 }), BudgetValidationError);
  assert.throws(() => validateBudgetPatch({ dailyUsd: "5" }), BudgetValidationError);
  assert.throws(() => validateBudgetPatch({ blockScheduled: "yes" }), BudgetValidationError);
  assert.throws(() => validateBudgetPatch(null), BudgetValidationError);
});

test("config round-trips through update/read and tolerates a missing file", async () => {
  const budget = await load();
  assert.deepEqual(await budget.readBudgetConfig(), cfg());
  await budget.updateBudgetConfig({ dailyUsd: 10, blockScheduled: true }, NOW);
  const read = await budget.readBudgetConfig();
  assert.equal(read.dailyUsd, 10);
  assert.equal(read.monthlyUsd, null);
  assert.equal(read.blockScheduled, true);
  assert.equal(read.updatedAt, NOW.toISOString());
});

test("isSpendBlocked only blocks when blockScheduled is on and a limit is breached", async () => {
  const budget = await load();
  await budget.recordRunSpend({ endedAt: NOW.toISOString(), queuedAt: "", costUsd: 12 }, () => NOW);
  assert.equal(await budget.isSpendBlocked(NOW), false); // no config
  await budget.updateBudgetConfig({ dailyUsd: 10 }, NOW);
  assert.equal(await budget.isSpendBlocked(NOW), false); // alert-only
  await budget.updateBudgetConfig({ blockScheduled: true }, NOW);
  assert.equal(await budget.isSpendBlocked(NOW), true);
  await budget.updateBudgetConfig({ dailyUsd: 20 }, NOW);
  assert.equal(await budget.isSpendBlocked(NOW), false); // back under
});
