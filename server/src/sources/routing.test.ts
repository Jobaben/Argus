import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RouteEvaluationError,
  ResultValidationError,
  evaluatePredicate,
  evaluateRoutes,
  validateResult,
} from "./routing.js";
import type { Dependency, ResultSchema, RouteCondition } from "./pipelineTypes.js";

const decisionSchema: ResultSchema = {
  type: "object",
  required: ["decision", "score"],
  properties: {
    decision: { type: "string", enum: ["approve", "revise", "escalate"] },
    score: { type: "number" },
    tags: { type: "array", items: { type: "string" } },
  },
};

const decision = (
  operator: "equals" | "not-equals" | "one-of" | "exists",
  value?: string | number | boolean | null | Array<string | number | boolean | null>,
): RouteCondition => ({
  group: "decision",
  exclusive: true,
  predicate: {
    path: ["decision"],
    operator,
    ...(value === undefined ? {} : { value }),
  },
});

test("validateResult accepts declared scalar and object values but rejects invalid nested values", () => {
  const value = { decision: "approve", score: 0, tags: ["ready"] };
  assert.deepEqual(validateResult(decisionSchema, value), value);
  assert.deepEqual(validateResult({ type: "boolean" }, false), false);

  assert.throws(
    () => validateResult(decisionSchema, { decision: "unknown", score: 0, tags: ["ready"] }),
    ResultValidationError,
  );
  assert.throws(
    () => validateResult(decisionSchema, { decision: "approve", score: "0", tags: ["ready"] }),
    ResultValidationError,
  );
  assert.throws(
    () => validateResult(decisionSchema, { decision: "approve", score: 0, tags: [1] }),
    ResultValidationError,
  );
});

test("evaluatePredicate supports only equality, inequality, one-of, and existence checks", () => {
  const value = { decision: "approve", score: 0, metadata: { reviewed: false } };

  assert.equal(evaluatePredicate(value, decision("equals", "approve").predicate!), true);
  assert.equal(evaluatePredicate(value, decision("not-equals", "revise").predicate!), true);
  assert.equal(evaluatePredicate(value, decision("one-of", ["revise", "approve"]).predicate!), true);
  assert.equal(
    evaluatePredicate(value, { path: ["metadata", "reviewed"], operator: "exists" }),
    true,
  );
  assert.equal(evaluatePredicate(value, { path: ["missing"], operator: "exists" }), false);
});

test("evaluateRoutes selects the group default only when no ordinary condition matches", () => {
  const routes: Dependency[] = [
    { phase: "publish", when: decision("equals", "approve") },
    { phase: "repair", when: decision("equals", "revise") },
    { phase: "escalate", when: { group: "decision", exclusive: true, default: true } },
  ];

  assert.deepEqual(evaluateRoutes(routes, { decision: "approve" }), {
    selected: ["publish"],
    skipped: ["repair", "escalate"],
  });
  assert.deepEqual(evaluateRoutes(routes, { decision: "escalate" }), {
    selected: ["escalate"],
    skipped: ["publish", "repair"],
  });
});

test("evaluateRoutes rejects an exclusive group with more than one matching route", () => {
  const routes: Dependency[] = [
    { phase: "publish", when: decision("equals", "approve") },
    { phase: "archive", when: decision("one-of", ["approve", "revise"]) },
  ];

  assert.throws(() => evaluateRoutes(routes, { decision: "approve" }), RouteEvaluationError);
});

test("evaluateRoutes rejects a required group that has no matching route", () => {
  const routes: Dependency[] = [
    {
      phase: "publish",
      when: { ...decision("equals", "approve"), required: true },
    },
    {
      phase: "repair",
      when: { ...decision("equals", "revise"), required: true },
    },
  ];

  assert.throws(() => evaluateRoutes(routes, { decision: "escalate" }), RouteEvaluationError);
});
