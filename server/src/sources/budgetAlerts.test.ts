import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBudgetAlert } from "./budgetAlerts.js";
import type { BudgetStatus, BudgetState } from "./budget.js";

const AT = "2026-07-13T12:00:00.000Z";

function status(state: BudgetState, over: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    state,
    today: { spentUsd: 12, limitUsd: 10, ratio: 1.2 },
    month: { spentUsd: 12, limitUsd: null, ratio: null },
    blockScheduled: false,
    ...over,
  };
}

test("first observation is a silent baseline", () => {
  assert.equal(detectBudgetAlert(null, status("exceeded"), AT), null);
});

test("ok → warning and warning → exceeded alert with a spend summary", () => {
  const warn = detectBudgetAlert("ok", status("warning"), AT);
  assert.equal(warn?.event, "budget.warning");
  const over = detectBudgetAlert("warning", status("exceeded"), AT);
  assert.equal(over?.event, "budget.exceeded");
  assert.match(over!.detail, /today \$12\.00 of \$10\.00/);
});

test("exceeded with blocking on says scheduled runs are paused", () => {
  const alert = detectBudgetAlert("ok", status("exceeded", { blockScheduled: true }), AT);
  assert.match(alert!.detail, /scheduled runs are paused/);
});

test("dropping back to ok or unset clears; exceeded → warning stays quiet", () => {
  assert.equal(detectBudgetAlert("exceeded", status("ok"), AT)?.event, "budget.cleared");
  assert.equal(detectBudgetAlert("warning", status("unset"), AT)?.event, "budget.cleared");
  assert.equal(detectBudgetAlert("exceeded", status("warning"), AT), null);
});

test("no alert without a state change", () => {
  assert.equal(detectBudgetAlert("warning", status("warning"), AT), null);
  assert.equal(detectBudgetAlert("ok", status("unset"), AT), null);
});
