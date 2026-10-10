import { test } from "node:test";
import assert from "node:assert/strict";
import type { AnswerSpace, DecisionAnswer, DecisionOutcome } from "@argus/contracts";
import {
  answerKeys,
  checkOutcome,
  checkStoredAnswer,
  interpretDistribution,
  rawExcerpt,
  type Interpretation,
} from "./answers.js";
import { RESIDUAL_CAUSE_V1 } from "./definitions.js";

const BINARY: AnswerSpace = { shape: "binary" };
const CHOICE = RESIDUAL_CAUSE_V1.answers;
const SCALE: AnswerSpace = {
  shape: "scale",
  points: [{ value: 1 }, { value: 2 }, { value: 3 }],
  sumTolerance: 0.01,
};

const CHOICE_KEYS = answerKeys(CHOICE);

/** A distribution over the choice space: `over` entries, every other key 0. */
function choiceDist(over: Record<string, number>): Record<string, number> {
  const d: Record<string, number> = {};
  for (const k of CHOICE_KEYS) d[k] = 0;
  return { ...d, ...over };
}

function accepted(r: Interpretation) {
  assert.equal(r.ok, true, r.ok ? "" : `refused: ${r.reason}`);
  if (!r.ok) throw new Error("unreachable");
  return r;
}

function refusedReason(r: Interpretation): string {
  assert.equal(r.ok, false, "expected a refusal");
  if (r.ok) throw new Error("unreachable");
  return r.reason;
}

const asAnswer = (v: unknown) => v as DecisionAnswer;
const asOutcome = (v: unknown) => v as DecisionOutcome;

test("the choice space under test has the expected shape", () => {
  assert.equal(CHOICE.shape, "choice");
  assert.equal(CHOICE.shape === "choice" && CHOICE.sumTolerance, 0.02);
  assert.ok(CHOICE_KEYS.length >= 2);
});

// ── interpretDistribution: binary ────────────────────────────────────────────

test("binary: accepts p in [0,1], including both ends", () => {
  for (const p of [0, 0.25, 0.5, 1]) {
    const r = accepted(interpretDistribution(BINARY, p));
    assert.deepEqual(r.answer, { kind: "probability", shape: "binary", p });
    assert.equal(r.normalization, undefined);
  }
});

test("binary: refuses non-numbers, NaN, Infinity and out-of-range values", () => {
  assert.match(refusedReason(interpretDistribution(BINARY, "0.5")), /not a number/);
  assert.match(refusedReason(interpretDistribution(BINARY, Number.NaN)), /not finite/);
  assert.match(
    refusedReason(interpretDistribution(BINARY, Number.POSITIVE_INFINITY)),
    /not finite/,
  );
  assert.match(
    refusedReason(interpretDistribution(BINARY, Number.NEGATIVE_INFINITY)),
    /not finite/,
  );
  assert.match(refusedReason(interpretDistribution(BINARY, -0.1)), /outside \[0, 1\]/);
  assert.match(refusedReason(interpretDistribution(BINARY, 1.1)), /outside \[0, 1\]/);
  for (const bad of [null, undefined, true, {}, [0.5], 10n]) {
    refusedReason(interpretDistribution(BINARY, bad));
  }
});

// ── interpretDistribution: choice ────────────────────────────────────────────

test("choice: an exact distribution is accepted with no normalization field", () => {
  const p = choiceDist({ "prompt-ambiguity": 0.5, "missing-context": 0.25, other: 0.25 });
  const r = accepted(interpretDistribution(CHOICE, p));
  assert.deepEqual(r.answer, { kind: "probability", shape: "choice", p });
  assert.equal("normalization" in r, false);
  assert.equal(r.normalization, undefined);
});

test("choice: a one-hot distribution is accepted", () => {
  const r = accepted(interpretDistribution(CHOICE, choiceDist({ environment: 1 })));
  assert.equal(r.normalization, undefined);
});

test("choice: a missing key is refused", () => {
  const p = choiceDist({ environment: 1 });
  delete p.other;
  assert.match(refusedReason(interpretDistribution(CHOICE, p)), /missing key "other"/);
});

test("choice: an extra key is refused", () => {
  const p = { ...choiceDist({ environment: 1 }), surprise: 0 };
  assert.match(refusedReason(interpretDistribution(CHOICE, p)), /unexpected key "surprise"/);
});

test("choice: a negative value is refused", () => {
  const p = choiceDist({ environment: 1.1, other: -0.1 });
  assert.match(refusedReason(interpretDistribution(CHOICE, p)), /outside \[0, 1\]/);
});

test("choice: a value above 1 is refused", () => {
  const p = choiceDist({ environment: 1.5 });
  assert.match(refusedReason(interpretDistribution(CHOICE, p)), /outside \[0, 1\]/);
});

test("choice: non-number, NaN and Infinity values are refused", () => {
  assert.match(
    refusedReason(
      interpretDistribution(CHOICE, choiceDist({ environment: "1" as unknown as number })),
    ),
    /not a number/,
  );
  assert.match(
    refusedReason(interpretDistribution(CHOICE, choiceDist({ environment: Number.NaN }))),
    /not finite/,
  );
  assert.match(
    refusedReason(interpretDistribution(CHOICE, choiceDist({ environment: Infinity }))),
    /not finite/,
  );
});

test("choice: a non-object distribution is refused", () => {
  for (const bad of [[], [1, 0, 0], null, undefined, 1, "x", new Map()]) {
    assert.match(refusedReason(interpretDistribution(CHOICE, bad)), /not an object/);
  }
});

test("choice: a null-prototype object is accepted", () => {
  const p = Object.assign(Object.create(null) as Record<string, number>, choiceDist({ other: 1 }));
  accepted(interpretDistribution(CHOICE, p));
});

test("choice: a sum of 0.99 is accepted and renormalised, with an audit trail", () => {
  const raw = choiceDist({ "prompt-ambiguity": 0.5, "missing-context": 0.49 });
  const r = accepted(interpretDistribution(CHOICE, raw));
  assert.ok(r.normalization);
  assert.equal(r.normalization.method, "divide-by-sum");
  const rawSum = raw["prompt-ambiguity"] + raw["missing-context"];
  assert.equal(r.normalization.rawSum, rawSum);
  assert.deepEqual(r.normalization.raw, raw);
  assert.equal(r.answer.kind, "probability");
  assert.equal(r.answer.shape, "choice");
  const p = (r.answer as { p: Record<string, number> }).p;
  assert.deepEqual(Object.keys(p).sort(), [...CHOICE_KEYS].sort());
  const sum = Object.values(p).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) <= 1e-9, `normalised sum ${sum}`);
  assert.ok(Math.abs(p["prompt-ambiguity"] - 0.5 / rawSum) <= 1e-12);
  assert.ok(Math.abs(p["missing-context"] - 0.49 / rawSum) <= 1e-12);
  assert.equal(p.other, 0);
});

test("choice: a sum of 1.01 is accepted and renormalised", () => {
  const raw = choiceDist({ environment: 0.51, other: 0.5 });
  const r = accepted(interpretDistribution(CHOICE, raw));
  assert.equal(r.normalization?.method, "divide-by-sum");
  assert.ok(Math.abs((r.normalization?.rawSum ?? 0) - 1.01) <= 1e-12);
  const p = (r.answer as { p: Record<string, number> }).p;
  assert.ok(Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) <= 1e-9);
});

test("choice: a sum of 0.97 (outside tolerance) is refused, and the reason mentions the sum", () => {
  const reason = refusedReason(interpretDistribution(CHOICE, choiceDist({ environment: 0.97 })));
  assert.match(reason, /sum/);
  assert.match(reason, /0\.97/);
});

test("choice: a sum of 1.03 (outside tolerance) is refused", () => {
  const reason = refusedReason(
    interpretDistribution(CHOICE, choiceDist({ environment: 0.5, other: 0.53 })),
  );
  assert.match(reason, /sum/);
});

test("choice: an all-zero distribution is refused", () => {
  assert.match(refusedReason(interpretDistribution(CHOICE, choiceDist({}))), /sum/);
});

test("the stored choice answer is exactly what checkStoredAnswer accepts after renormalising", () => {
  const r = accepted(interpretDistribution(CHOICE, choiceDist({ environment: 0.99 })));
  assert.equal(checkStoredAnswer(CHOICE, r.answer), null);
});

// ── interpretDistribution: scale ─────────────────────────────────────────────

test("scale: keys are the string forms of the points", () => {
  assert.deepEqual(answerKeys(SCALE), ["1", "2", "3"]);
  assert.deepEqual(answerKeys(BINARY), ["p"]);
  assert.deepEqual(
    answerKeys({ shape: "scale", points: [{ value: 0.5 }, { value: -2 }], sumTolerance: 0 }),
    ["0.5", "-2"],
  );
});

test("scale: an exact distribution is accepted", () => {
  const p = { "1": 0.25, "2": 0.5, "3": 0.25 };
  const r = accepted(interpretDistribution(SCALE, p));
  assert.deepEqual(r.answer, { kind: "probability", shape: "scale", p });
  assert.equal(r.normalization, undefined);
});

test("scale: within tolerance is renormalised, outside is refused", () => {
  const r = accepted(interpretDistribution(SCALE, { "1": 0.5, "2": 0.25, "3": 0.255 }));
  assert.equal(r.normalization?.method, "divide-by-sum");
  assert.deepEqual(r.normalization?.raw, { "1": 0.5, "2": 0.25, "3": 0.255 });
  const p = (r.answer as { p: Record<string, number> }).p;
  assert.ok(Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) <= 1e-9);

  // 0.98 is outside this space's 0.01 tolerance, although inside the choice space's 0.02.
  assert.match(
    refusedReason(interpretDistribution(SCALE, { "1": 0.5, "2": 0.25, "3": 0.23 })),
    /sum/,
  );
  assert.match(
    refusedReason(interpretDistribution(SCALE, { "1": 0.5, "2": 0.25, "3": 0.27 })),
    /sum/,
  );
});

test("scale: wrong keys, bad values and non-objects are refused", () => {
  assert.match(
    refusedReason(interpretDistribution(SCALE, { "1": 0.5, "2": 0.5 })),
    /missing key "3"/,
  );
  assert.match(
    refusedReason(interpretDistribution(SCALE, { "1": 0.5, "2": 0.25, "3": 0.25, "4": 0 })),
    /unexpected key "4"/,
  );
  assert.match(
    refusedReason(interpretDistribution(SCALE, { "1": 1.5, "2": -0.5, "3": 0 })),
    /outside \[0, 1\]/,
  );
  assert.match(refusedReason(interpretDistribution(SCALE, [0.3, 0.3, 0.4])), /not an object/);
  assert.match(refusedReason(interpretDistribution(SCALE, 0.5)), /not an object/);
  assert.match(refusedReason(interpretDistribution(SCALE, null)), /not an object/);
});

// ── aliasing ─────────────────────────────────────────────────────────────────

test("the answer does not alias the input (exact distribution)", () => {
  const input = choiceDist({ environment: 0.5, other: 0.5 });
  const snapshot = { ...input };
  const r = accepted(interpretDistribution(CHOICE, input));
  const answer = r.answer as { p: Record<string, number> };
  assert.notEqual(answer.p, input);
  input.environment = 0;
  input.other = 0;
  delete (input as Record<string, unknown>)["tool-misuse"];
  assert.deepEqual(answer.p, snapshot);
});

test("the answer and the audit trail do not alias the input (renormalised)", () => {
  const input = choiceDist({ environment: 0.5, other: 0.49 });
  const snapshot = { ...input };
  const r = accepted(interpretDistribution(CHOICE, input));
  const before = JSON.stringify(r);
  assert.notEqual(r.normalization?.raw, input);
  input.environment = 0.9;
  input.other = 0.05;
  assert.equal(JSON.stringify(r), before);
  assert.deepEqual(r.normalization?.raw, snapshot);
});

// ── checkStoredAnswer ────────────────────────────────────────────────────────

test("checkStoredAnswer accepts a normalised choice answer", () => {
  const p = choiceDist({ environment: 0.75, other: 0.25 });
  assert.equal(checkStoredAnswer(CHOICE, { kind: "probability", shape: "choice", p }), null);
});

test("checkStoredAnswer accepts binary and scale probabilities", () => {
  assert.equal(checkStoredAnswer(BINARY, { kind: "probability", shape: "binary", p: 0.3 }), null);
  assert.equal(
    checkStoredAnswer(SCALE, {
      kind: "probability",
      shape: "scale",
      p: { "1": 0.5, "2": 0.25, "3": 0.25 },
    }),
    null,
  );
});

test("checkStoredAnswer refuses a bad binary probability", () => {
  assert.match(
    checkStoredAnswer(BINARY, { kind: "probability", shape: "binary", p: 2 }) ?? "",
    /outside/,
  );
  assert.match(
    checkStoredAnswer(BINARY, asAnswer({ kind: "probability", shape: "binary", p: "0.5" })) ?? "",
    /not a number/,
  );
});

test("checkStoredAnswer refuses a shape mismatch", () => {
  const reason = checkStoredAnswer(CHOICE, { kind: "probability", shape: "binary", p: 0.5 });
  assert.match(reason ?? "", /does not match/);
  assert.match(
    checkStoredAnswer(BINARY, { kind: "probability", shape: "scale", p: { "1": 1 } }) ?? "",
    /does not match/,
  );
  assert.match(
    checkStoredAnswer(SCALE, {
      kind: "probability",
      shape: "choice",
      p: choiceDist({ other: 1 }),
    }) ?? "",
    /does not match/,
  );
});

test("checkStoredAnswer refuses a stored distribution that sums to 0.99", () => {
  const p = choiceDist({ environment: 0.99 });
  assert.match(
    checkStoredAnswer(CHOICE, { kind: "probability", shape: "choice", p }) ?? "",
    /not 1/,
  );
  // a sum 1e-12 off is floating-point slack, and is accepted
  const slack = choiceDist({ environment: 0.5, other: 0.5 + 1e-12 });
  assert.equal(checkStoredAnswer(CHOICE, { kind: "probability", shape: "choice", p: slack }), null);
});

test("checkStoredAnswer refuses missing keys, extra keys and non-object distributions", () => {
  const missing = choiceDist({ environment: 1 });
  delete missing.other;
  assert.match(
    checkStoredAnswer(CHOICE, { kind: "probability", shape: "choice", p: missing }) ?? "",
    /missing key/,
  );
  assert.match(
    checkStoredAnswer(CHOICE, {
      kind: "probability",
      shape: "choice",
      p: { ...choiceDist({ environment: 1 }), extra: 0 },
    }) ?? "",
    /unexpected key/,
  );
  assert.match(
    checkStoredAnswer(CHOICE, asAnswer({ kind: "probability", shape: "choice", p: [1] })) ?? "",
    /not an object/,
  );
});

test("checkStoredAnswer refuses an unknown kind and a non-object answer", () => {
  assert.match(
    checkStoredAnswer(CHOICE, asAnswer({ kind: "vibes", shape: "choice" })) ?? "",
    /unknown answer kind/,
  );
  assert.match(
    checkStoredAnswer(CHOICE, asAnswer({ shape: "choice", p: {} })) ?? "",
    /unknown answer kind/,
  );
  for (const bad of [null, undefined, 1, "x", []]) {
    assert.match(checkStoredAnswer(CHOICE, asAnswer(bad)) ?? "", /not an object/);
  }
});

test("a rating is refused for a choice or binary space", () => {
  const rating: DecisionAnswer = { kind: "rating", value: 2, scale: { min: 1, max: 3 } };
  assert.match(checkStoredAnswer(CHOICE, rating) ?? "", /only a scale/);
  assert.match(checkStoredAnswer(BINARY, rating) ?? "", /only a scale/);
});

test("a rating is accepted for a scale space when value is within [min, max]", () => {
  for (const value of [1, 1.5, 2, 3]) {
    assert.equal(
      checkStoredAnswer(SCALE, { kind: "rating", value, scale: { min: 1, max: 3 } }),
      null,
    );
  }
});

test("a rating outside its scale is refused", () => {
  assert.match(
    checkStoredAnswer(SCALE, { kind: "rating", value: 3.01, scale: { min: 1, max: 3 } }) ?? "",
    /outside its scale/,
  );
  assert.match(
    checkStoredAnswer(SCALE, { kind: "rating", value: 0.99, scale: { min: 1, max: 3 } }) ?? "",
    /outside its scale/,
  );
});

test("a rating with an empty scale (min >= max) is refused", () => {
  assert.match(
    checkStoredAnswer(SCALE, { kind: "rating", value: 2, scale: { min: 2, max: 2 } }) ?? "",
    /scale is empty/,
  );
  assert.match(
    checkStoredAnswer(SCALE, { kind: "rating", value: 2, scale: { min: 3, max: 1 } }) ?? "",
    /scale is empty/,
  );
});

test("a rating with a non-finite value or bound is refused", () => {
  const scale = { min: 1, max: 3 };
  assert.match(
    checkStoredAnswer(SCALE, { kind: "rating", value: Number.NaN, scale }) ?? "",
    /not finite/,
  );
  assert.match(
    checkStoredAnswer(SCALE, { kind: "rating", value: Infinity, scale }) ?? "",
    /not finite/,
  );
  assert.match(
    checkStoredAnswer(SCALE, { kind: "rating", value: 2, scale: { min: 1, max: Infinity } }) ?? "",
    /not finite/,
  );
  assert.match(
    checkStoredAnswer(SCALE, { kind: "rating", value: 2, scale: { min: -Infinity, max: 3 } }) ?? "",
    /not finite/,
  );
  assert.match(
    checkStoredAnswer(SCALE, asAnswer({ kind: "rating", value: "2", scale })) ?? "",
    /not finite/,
  );
  assert.match(checkStoredAnswer(SCALE, asAnswer({ kind: "rating", value: 2 })) ?? "", /no scale/);
});

// ── checkOutcome ─────────────────────────────────────────────────────────────

const GOOD_ANSWER: DecisionAnswer = {
  kind: "probability",
  shape: "choice",
  p: choiceDist({ environment: 0.5, other: 0.5 }),
};

test("checkOutcome: a valid answered outcome is accepted", () => {
  assert.equal(checkOutcome(CHOICE, { status: "answered", answer: GOOD_ANSWER }), null);
  assert.equal(
    checkOutcome(CHOICE, {
      status: "answered",
      answer: GOOD_ANSWER,
      providerStatistics: { logprob: -0.25, n: 3 },
      rationale: "because",
    }),
    null,
  );
});

test("checkOutcome: answered with an invalid answer returns a reason", () => {
  const bad: DecisionAnswer = { kind: "probability", shape: "binary", p: 0.5 };
  assert.match(checkOutcome(CHOICE, { status: "answered", answer: bad }) ?? "", /does not match/);
  assert.match(checkOutcome(CHOICE, asOutcome({ status: "answered" })) ?? "", /not an object/);
});

test("checkOutcome: answered with a non-finite provider statistic returns a reason", () => {
  for (const v of [Number.NaN, Infinity, -Infinity]) {
    const reason = checkOutcome(CHOICE, {
      status: "answered",
      answer: GOOD_ANSWER,
      providerStatistics: { ok: 1, broken: v },
    });
    assert.match(reason ?? "", /provider statistic "broken" is not finite/);
  }
  assert.match(
    checkOutcome(
      CHOICE,
      asOutcome({ status: "answered", answer: GOOD_ANSWER, providerStatistics: { s: "1" } }),
    ) ?? "",
    /not finite/,
  );
  assert.match(
    checkOutcome(
      CHOICE,
      asOutcome({ status: "answered", answer: GOOD_ANSWER, providerStatistics: [1] }),
    ) ?? "",
    /providerStatistics is not an object/,
  );
});

test("checkOutcome: a non-string rationale returns a reason", () => {
  assert.match(
    checkOutcome(CHOICE, asOutcome({ status: "answered", answer: GOOD_ANSWER, rationale: 5 })) ??
      "",
    /rationale/,
  );
});

test("checkOutcome: abstained needs a reason string", () => {
  assert.equal(checkOutcome(CHOICE, { status: "abstained", reason: "cannot tell" }), null);
  assert.match(checkOutcome(CHOICE, asOutcome({ status: "abstained" })) ?? "", /no reason/);
  assert.match(
    checkOutcome(CHOICE, asOutcome({ status: "abstained", reason: 3 })) ?? "",
    /no reason/,
  );
});

test("checkOutcome: failed with failure and detail strings is accepted", () => {
  assert.equal(
    checkOutcome(CHOICE, { status: "failed", failure: "invalid-answer", detail: "sum was 0.5" }),
    null,
  );
  assert.equal(
    checkOutcome(CHOICE, { status: "failed", failure: "timeout", detail: "", rawExcerpt: "x" }),
    null,
  );
});

test("checkOutcome: failed without a failure code or detail returns a reason", () => {
  assert.match(
    checkOutcome(CHOICE, asOutcome({ status: "failed", failure: "timeout" })) ?? "",
    /no code or detail/,
  );
  assert.match(
    checkOutcome(CHOICE, asOutcome({ status: "failed", detail: "d" })) ?? "",
    /no code or detail/,
  );
});

test("checkOutcome: an unknown status or non-object returns a reason", () => {
  assert.match(
    checkOutcome(CHOICE, asOutcome({ status: "pending" })) ?? "",
    /unknown outcome status/,
  );
  assert.match(checkOutcome(CHOICE, asOutcome({})) ?? "", /unknown outcome status/);
  assert.match(checkOutcome(CHOICE, asOutcome(null)) ?? "", /not an object/);
  assert.match(checkOutcome(CHOICE, asOutcome("answered")) ?? "", /not an object/);
});

// ── rawExcerpt ───────────────────────────────────────────────────────────────

test("rawExcerpt returns short text unchanged and caps at the code-point limit", () => {
  assert.equal(rawExcerpt("hello", 10), "hello");
  assert.equal(rawExcerpt("hello", 5), "hello");
  assert.equal(rawExcerpt("hello", 3), "hel");
  assert.equal(rawExcerpt(""), "");
  assert.equal(rawExcerpt("x".repeat(2001)).length, 2000);
  assert.equal(rawExcerpt("x".repeat(2000)).length, 2000);
  assert.equal(rawExcerpt("x".repeat(5000), 0), "");
});

test("rawExcerpt never splits a surrogate pair", () => {
  const emoji = "\u{1F600}".repeat(5);
  assert.equal(emoji.length, 10);
  const cut = rawExcerpt(emoji, 3);
  assert.equal(cut, "\u{1F600}".repeat(3));
  assert.equal(Array.from(cut).length, 3);
  assert.equal(cut.length, 6);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut));

  assert.equal(rawExcerpt("a\u{1F600}b\u{1F600}", 2), "a\u{1F600}");
  assert.equal(rawExcerpt("a\u{1F600}b\u{1F600}", 1), "a");
  // A cap that falls between the halves of a pair in UTF-16 terms keeps the whole pair or none of it.
  for (let max = 0; max <= 6; max++) {
    const out = rawExcerpt("ab\u{1F600}cd\u{1F600}", max);
    assert.ok(
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out),
      `lone surrogate at max=${max}`,
    );
    assert.ok(Array.from(out).length <= max);
  }
});
