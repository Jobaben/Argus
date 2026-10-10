import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brierTerm,
  cohensKappa,
  distribution,
  expectedCalibrationError,
  nearestRank,
  reliability,
  round6,
  totals,
  uniqueTop,
  wilson,
} from "./metrics.js";

/** Every expected value below is worked by hand in the comment beside it. */

const close = (a: number | null, b: number, tol = 1e-4) =>
  assert.ok(a !== null && Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test("Wilson 95 % intervals match hand-worked values, and n = 0 is null, not zero", () => {
  // 5/8: centre (0.625 + z²/16)/(1 + z²/8) = 0.584449, half-width 0.278711.
  const w = wilson(5, 8);
  assert.equal(w.value, 0.625);
  close(w.ci95![0], 0.305738);
  close(w.ci95![1], 0.86316);
  // 0/10: the lower bound is 0, the upper is z²/(n + z²) = 3.841459/13.841459.
  const zero = wilson(0, 10);
  assert.equal(zero.value, 0);
  assert.equal(zero.ci95![0], 0);
  close(zero.ci95![1], 0.277533);
  // 10/10 mirrors it.
  close(wilson(10, 10).ci95![0], 1 - 0.277533);
  assert.equal(wilson(10, 10).ci95![1], 1);
  assert.deepEqual(wilson(0, 0), { k: 0, n: 0, value: null, ci95: null });
});

test("the nearest-rank percentile and the distribution summary", () => {
  assert.equal(nearestRank([10, 20, 30, 40], 0.5), 20); // ceil(0.5·4) = 2nd
  assert.equal(nearestRank([10, 20, 30, 40], 0.95), 40); // ceil(3.8) = 4th
  assert.equal(nearestRank([7], 0.95), 7);
  assert.equal(nearestRank([], 0.5), null);
  assert.deepEqual(distribution([40, 10, 30, 20]), { n: 4, p50: 20, p95: 40, max: 40 });
  assert.deepEqual(distribution([]), { n: 0, p50: null, p95: null, max: null });
  assert.deepEqual(totals([0.01, null, 0.02]), {
    total: 0.03,
    meanKnown: 0.015,
    known: 2,
    unknown: 1,
  });
  assert.deepEqual(totals([null]), { total: 0, meanKnown: null, known: 0, unknown: 1 });
});

test("the top answer is the unique maximum; an exact tie is 'tie'", () => {
  const keys = ["a", "b", "c"];
  assert.equal(uniqueTop({ a: 0.2, b: 0.5, c: 0.3 }, keys), "b");
  assert.equal(uniqueTop({ a: 0.4, b: 0.4, c: 0.2 }, keys), "tie");
  assert.equal(uniqueTop({ a: 0.2, b: 0.4, c: 0.4 }, keys), "tie");
  assert.equal(uniqueTop({ a: 0.5, b: 0.25, c: 0.25 }, keys), "a", "a tie below the top is no tie");
});

test("the multiclass Brier term sums over every option: range [0, 2]", () => {
  const keys = ["a", "b", "c"];
  const p = { a: 0.5, b: 0.3, c: 0.2 };
  close(brierTerm(p, keys, "a"), 0.38); // 0.25 + 0.09 + 0.04
  close(brierTerm(p, keys, "c"), 0.98); // 0.25 + 0.09 + 0.64
  assert.equal(brierTerm({ a: 1, b: 0, c: 0 }, keys, "a"), 0);
  assert.equal(brierTerm({ a: 1, b: 0, c: 0 }, keys, "b"), 2);
});

test("Cohen's kappa, with 'tie' as a category no reference carries", () => {
  // refs A A A B B C, preds A A B B C tie: po = 3/6; pe = (3·2 + 2·2 + 1·1)/36 = 11/36;
  // κ = (1/2 − 11/36)/(1 − 11/36) = 7/25.
  const pairs: Array<[string, string]> = [
    ["A", "A"],
    ["A", "A"],
    ["A", "B"],
    ["B", "B"],
    ["B", "C"],
    ["C", "tie"],
  ];
  assert.equal(cohensKappa(pairs), 0.28);
  assert.equal(cohensKappa([]), null);
  assert.equal(cohensKappa([["A", "A"]]), null, "chance agreement 1: undefined");
  assert.equal(
    cohensKappa([
      ["A", "B"],
      ["B", "A"],
    ]),
    -1,
  );
});

test("reliability buckets below 20 are unmeasured; ECE is unmeasured below n = 200", () => {
  const nineteen = Array.from({ length: 19 }, () => ({ confidence: 0.95, correct: true }));
  let buckets = reliability(nineteen);
  assert.equal(buckets.length, 10);
  assert.deepEqual(buckets[9], {
    lower: 0.9,
    upper: 1,
    n: 19,
    status: "unmeasured",
    meanConfidence: null,
    accuracy: null,
  });
  buckets = reliability([...nineteen, { confidence: 1, correct: false }]);
  assert.equal(buckets[9].status, "measured");
  assert.equal(buckets[9].n, 20);
  close(buckets[9].accuracy, 0.95);
  close(buckets[9].meanConfidence, (19 * 0.95 + 1) / 20);
  assert.equal(reliability([{ confidence: 0.3, correct: true }])[3].n, 1, "floor(10·0.3) = 3");

  const items = [
    ...Array.from({ length: 100 }, (_, i) => ({ confidence: 0.9, correct: i < 90 })),
    ...Array.from({ length: 99 }, (_, i) => ({ confidence: 0.6, correct: i < 30 })),
  ];
  assert.equal(expectedCalibrationError(items), null, "199 items");
  items.push({ confidence: 0.6, correct: false });
  // |0.9 − 0.9|·½ + |0.3 − 0.6|·½ = 0.15
  close(expectedCalibrationError(items), 0.15);
});

test("rounding never yields negative zero", () => {
  assert.ok(Object.is(round6(-1e-9), 0));
  assert.equal(round6(1 / 3), 0.333333);
});
