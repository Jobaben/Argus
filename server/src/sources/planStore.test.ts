import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Plan, PlannedMutation } from "@argus/contracts";
import { clearPlans, pendingCount, rememberPlan, takePlan, PLAN_TTL_MS } from "./planStore.js";

const NOW = new Date("2026-07-20T12:00:00.000Z");

const mutation: PlannedMutation = {
  kind: "schedule.disable",
  targetId: "s1",
  targetLabel: "Nightly triage",
  value: null,
  before: "enabled",
  after: "disabled",
};

function plan(id: string, over: Partial<Plan> = {}): Plan {
  return {
    id,
    status: "ready",
    intent: "pause it",
    mutations: [mutation],
    warnings: [],
    summary: "",
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + PLAN_TTL_MS).toISOString(),
    ...over,
  };
}

beforeEach(clearPlans);

test("a plan round-trips by id", () => {
  rememberPlan(plan("a"), NOW);
  assert.equal(takePlan("a", NOW)?.intent, "pause it");
});

test("regression: a plan is single-use", () => {
  rememberPlan(plan("a"), NOW);
  assert.ok(takePlan("a", NOW));
  // A confirm button that can be double-clicked into two executions is the same
  // bug as a payment form that can, and has the same fix.
  assert.equal(takePlan("a", NOW), null);
});

test("an expired plan is gone", () => {
  rememberPlan(plan("a"), NOW);
  const later = new Date(NOW.getTime() + PLAN_TTL_MS + 1);
  assert.equal(takePlan("a", later), null);
});

test("an unknown id is null, not a throw", () => {
  assert.equal(takePlan("nope", NOW), null);
});

test("a plan with nothing to do is not stored — there is nothing to confirm", () => {
  rememberPlan(plan("a", { mutations: [], status: "empty" }), NOW);
  rememberPlan(plan("", {}), NOW);
  assert.equal(pendingCount(), 0);
});

test("the pending set is bounded, dropping the oldest", () => {
  for (let i = 0; i < 60; i++) rememberPlan(plan(`p${i}`), NOW);
  assert.equal(pendingCount(), 50);
  // The plan a user is looking at right now is the one that matters.
  assert.equal(takePlan("p0", NOW), null);
  assert.ok(takePlan("p59", NOW));
});

test("expiry is swept on write, so a quiet server does not hold plans forever", () => {
  rememberPlan(plan("old"), NOW);
  const later = new Date(NOW.getTime() + PLAN_TTL_MS + 1);
  rememberPlan(
    plan("new", { expiresAt: new Date(later.getTime() + PLAN_TTL_MS).toISOString() }),
    later,
  );
  assert.equal(pendingCount(), 1);
});
