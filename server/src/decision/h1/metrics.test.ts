import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agreementOf,
  aurocLowerMeansPositive,
  binaryBrier,
  binaryEce,
  binaryPrediction,
  binaryReliability,
  MODEL_SPEC,
  RULES_SPEC,
  VERDICT_SPEC,
  type BinaryCalibrated,
} from "./metrics.js";

/**
 * The H1 statistics on hand-worked fixtures (RFC §Q.11). Every expected value
 * below was computed by hand (and cross-checked with a separate script), not
 * by the code under test.
 */

test("the binary rule: strictly above ½ is sent back, strictly below is approve, exactly ½ is a tie", () => {
  assert.equal(binaryPrediction(0.51), "sent-back");
  assert.equal(binaryPrediction(1), "sent-back");
  assert.equal(binaryPrediction(0.49), "approve");
  assert.equal(binaryPrediction(0), "approve");
  assert.equal(binaryPrediction(0.5), "tie");
});

test("agreement, coverage, false close and false escalation with ties, abstentions and failures", () => {
  const sb = (column: string) => ({ label: "sent-back" as const, column });
  const ok = (column: string) => ({ label: "not-sent-back" as const, column });
  const items = [
    sb("sent-back"),
    sb("sent-back"),
    sb("approve"),
    sb("tie"),
    sb("abstained"),
    ok("approve"),
    ok("approve"),
    ok("approve"),
    ok("sent-back"),
    ok("failed"),
  ];
  const a = agreementOf(items, MODEL_SPEC);
  assert.deepEqual(a.confusion.counts, [
    [2, 1, 1, 1, 0],
    [1, 3, 0, 0, 1],
  ]);
  assert.equal(a.scored, 10);
  assert.equal(a.answered, 8, "ties are answered; abstentions and failures are not");
  assert.deepEqual(a.coverage, { k: 8, n: 10, value: 0.8, ci95: [0.490162, 0.943318] });
  assert.deepEqual(a.agreementAnswered, { k: 5, n: 8, value: 0.625, ci95: [0.305742, 0.863156] });
  assert.equal(a.agreementEndToEnd.k, 5);
  assert.equal(a.agreementEndToEnd.n, 10);
  // Of the 4 answered sent-back items, 1 was predicted approve; the tie is in the denominator only.
  assert.deepEqual(a.falseClose, { k: 1, n: 4, value: 0.25, ci95: [0.045587, 0.699358] });
  assert.deepEqual(a.falseEscalation, { k: 1, n: 4, value: 0.25, ci95: [0.045587, 0.699358] });
  // po = 5/8; pe = (4/8)(3/8) + (4/8)(4/8) = 28/64; κ = (0.625 − 0.4375) / 0.5625.
  assert.deepEqual(a.kappa, { status: "measured", value: 0.333333 });
});

test("an empty scoring set is unmeasured, never zero", () => {
  const a = agreementOf([], MODEL_SPEC);
  assert.equal(a.agreementAnswered.value, null);
  assert.equal(a.falseClose.ci95, null);
  assert.equal(a.kappa.status, "unmeasured");
  const onlyAbstained = agreementOf([{ label: "sent-back", column: "abstained" }], MODEL_SPEC);
  assert.equal(onlyAbstained.coverage.value, 0);
  assert.equal(onlyAbstained.falseClose.n, 0);
});

test("rule results and Verdict decisions: coverage gaps are columns, never folded into a prediction", () => {
  const r = agreementOf(
    [
      { label: "sent-back", column: "flag" },
      { label: "sent-back", column: "insufficient-data" },
      { label: "not-sent-back", column: "no-flag" },
    ],
    RULES_SPEC,
  );
  assert.equal(r.answered, 2);
  assert.equal(r.agreementAnswered.k, 2);
  assert.equal(r.agreementEndToEnd.n, 3);
  const v = agreementOf(
    [
      { label: "sent-back", column: "qualifies" },
      { label: "sent-back", column: "not-configured" },
      { label: "not-sent-back", column: "below-threshold" },
      { label: "not-sent-back", column: "insufficient-data" },
      { label: "not-sent-back", column: "ineligible" },
    ],
    VERDICT_SPEC,
  );
  assert.deepEqual(v.confusion.counts, [
    [0, 1, 1, 0, 0],
    [1, 0, 0, 1, 1],
  ]);
  assert.equal(v.answered, 2);
  assert.deepEqual(
    [v.falseClose.k, v.falseClose.n],
    [1, 1],
    "would have opened a gate the operator sent back",
  );
  assert.deepEqual([v.falseEscalation.k, v.falseEscalation.n], [1, 1]);
});

test("binary Brier: mean (p − y)²", () => {
  // (0.8−1)² + (0.3−0)² + (0.6−0)² + (0.1−1)² = 0.04 + 0.09 + 0.36 + 0.81 = 1.3; / 4.
  assert.equal(
    binaryBrier([
      { p: 0.8, y: 1 },
      { p: 0.3, y: 0 },
      { p: 0.6, y: 0 },
      { p: 0.1, y: 1 },
    ]),
    0.325,
  );
  assert.equal(binaryBrier([]), null);
});

test("reliability bins are unmeasured below 20 items; ECE is unmeasured below 200", () => {
  const items: BinaryCalibrated[] = [
    ...Array.from({ length: 19 }, () => ({ p: 0.25, y: 1 as const })),
    ...Array.from({ length: 20 }, (_, i) => ({ p: 0.75, y: (i < 15 ? 1 : 0) as 0 | 1 })),
    { p: 1, y: 1 },
  ];
  const b = binaryReliability(items);
  assert.equal(b.length, 10);
  assert.deepEqual(b[2], {
    lower: 0.2,
    upper: 0.3,
    n: 19,
    status: "unmeasured",
    meanPredicted: null,
    observedRate: null,
  });
  assert.deepEqual(b[7], {
    lower: 0.7,
    upper: 0.8,
    n: 20,
    status: "measured",
    meanPredicted: 0.75,
    observedRate: 0.75,
  });
  assert.equal(b[9].n, 1, "p = 1 falls in the last bin");
  assert.equal(binaryEce(items), null);

  // 100 at p = 0.2 with 30 sent back, 100 at p = 0.8 with 70: ½·0.1 + ½·0.1.
  const many: BinaryCalibrated[] = [
    ...Array.from({ length: 100 }, (_, i) => ({ p: 0.2, y: (i < 30 ? 1 : 0) as 0 | 1 })),
    ...Array.from({ length: 100 }, (_, i) => ({ p: 0.8, y: (i < 70 ? 1 : 0) as 0 | 1 })),
  ];
  assert.equal(binaryEce(many), 0.1);
  assert.equal(binaryEce(many.slice(1)), null, "199 items");
});

test("AUROC over a rating where lower means sent back: ties count ½, Hanley–McNeil interval", () => {
  // Sent back rated 3, 5, 7; approved rated 6, 8, 5. Pairs with approved > sent back:
  // 3 → 3 of 3; 5 → 6 and 8, and 5 ties (½); 7 → 8 only. (3 + 2.5 + 1) / 9.
  const r = aurocLowerMeansPositive([
    { rating: 3, label: "sent-back" },
    { rating: 5, label: "sent-back" },
    { rating: 7, label: "sent-back" },
    { rating: 6, label: "not-sent-back" },
    { rating: 8, label: "not-sent-back" },
    { rating: 5, label: "not-sent-back" },
  ]);
  assert.deepEqual(r, {
    status: "measured",
    value: { value: 0.722222, ci95: [0.281, 1], sentBack: 3, notSentBack: 3 },
  });
  const one = aurocLowerMeansPositive([{ rating: 3, label: "sent-back" }]);
  assert.equal(one.status, "unmeasured");
});
