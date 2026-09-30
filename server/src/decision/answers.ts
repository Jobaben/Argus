import type {
  AnswerNormalization,
  AnswerSpace,
  DecisionAnswer,
  DecisionOutcome,
} from "@argus/contracts";

/**
 * Answer validation against a registered, closed answer space (RFC §G.2, §O.4).
 *
 * Two entry points, kept apart on purpose:
 *
 * - `interpretDistribution` turns what a provider *said* into a stored
 *   answer. It accepts a distribution that sums to 1 within the question's
 *   `sumTolerance`, renormalises it, and returns the raw values and raw sum
 *   so the renormalisation stays auditable. Anything else is refused.
 * - `checkStoredAnswer` re-validates an answer that is about to be appended,
 *   whichever provider produced it (mocks included). A stored probability
 *   distribution must already sum to 1 within floating-point slack.
 *
 * A refusal is a reason string, never an exception: the caller turns it into
 * an honest `failed: invalid-answer` outcome.
 */

/** Floating-point slack for an already-normalised stored distribution. */
export const STORED_SUM_EPSILON = 1e-9;

export type Interpretation =
  | { ok: true; answer: DecisionAnswer; normalization?: AnswerNormalization }
  | { ok: false; reason: string };

/** The keys a distribution over this space must have, exactly. */
export function answerKeys(space: AnswerSpace): string[] {
  switch (space.shape) {
    case "binary":
      return ["p"];
    case "choice":
      return space.options.map((o) => o.id);
    case "scale":
      return space.points.map((p) => String(p.value));
  }
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function probabilityValue(key: string, v: unknown): string | null {
  if (typeof v !== "number") return `"${key}" is not a number`;
  if (!Number.isFinite(v)) return `"${key}" is not finite`;
  if (v < 0 || v > 1) return `"${key}" is outside [0, 1]`;
  return null;
}

/** Keys exactly equal to `expected`: none missing, none extra. */
function closedKeys(obj: Record<string, unknown>, expected: string[]): string | null {
  const want = new Set(expected);
  for (const k of Object.keys(obj)) {
    if (!want.has(k)) return `unexpected key "${k}"`;
  }
  for (const k of expected) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) return `missing key "${k}"`;
  }
  return null;
}

/** Sum in the answer space's declared key order, so the result is order-stable. */
function orderedSum(p: Record<string, number>, keys: string[]): number {
  let s = 0;
  for (const k of keys) s += p[k];
  return s;
}

/**
 * Interpret a provider's raw distribution. `raw` is the `p` value the
 * provider returned: a number for `binary`, an object keyed by option id or
 * scale point for `choice` / `scale`.
 */
export function interpretDistribution(space: AnswerSpace, raw: unknown): Interpretation {
  if (space.shape === "binary") {
    const bad = probabilityValue("p", raw);
    if (bad) return { ok: false, reason: bad };
    return { ok: true, answer: { kind: "probability", shape: "binary", p: raw as number } };
  }
  if (!isPlainRecord(raw)) return { ok: false, reason: "the distribution is not an object" };
  const keys = answerKeys(space);
  const keyError = closedKeys(raw, keys);
  if (keyError) return { ok: false, reason: keyError };
  for (const k of keys) {
    const bad = probabilityValue(k, raw[k]);
    if (bad) return { ok: false, reason: bad };
  }
  const values = raw as Record<string, number>;
  const sum = orderedSum(values, keys);
  if (!(Math.abs(sum - 1) <= space.sumTolerance)) {
    return {
      ok: false,
      reason: `the distribution sums to ${sum}, outside 1 ± ${space.sumTolerance}`,
    };
  }
  if (sum <= 0) return { ok: false, reason: "the distribution sums to zero" };
  // Copy in declared order: the stored object never aliases provider output.
  const copy: Record<string, number> = {};
  for (const k of keys) copy[k] = values[k];
  if (sum === 1) {
    return { ok: true, answer: { kind: "probability", shape: space.shape, p: copy } };
  }
  const normalised: Record<string, number> = {};
  for (const k of keys) normalised[k] = copy[k] / sum;
  return {
    ok: true,
    answer: { kind: "probability", shape: space.shape, p: normalised },
    normalization: { method: "divide-by-sum", rawSum: sum, raw: copy },
  };
}

/** Re-validate a stored-form answer against its space. Null = valid. */
export function checkStoredAnswer(space: AnswerSpace, answer: DecisionAnswer): string | null {
  if (!isPlainRecord(answer)) return "the answer is not an object";
  if (answer.kind === "rating") {
    // A rating is an ordinal position; it is only meaningful on a declared scale.
    if (space.shape !== "scale") return "a rating answers only a scale question";
    const { value, scale } = answer;
    if (!isPlainRecord(scale)) return "the rating has no scale";
    for (const [k, v] of [
      ["value", value],
      ["scale.min", scale.min],
      ["scale.max", scale.max],
    ] as const) {
      if (typeof v !== "number" || !Number.isFinite(v)) return `rating ${k} is not finite`;
    }
    if (!(scale.min < scale.max)) return "the rating scale is empty";
    if (value < scale.min || value > scale.max) return "the rating is outside its scale";
    return null;
  }
  if (answer.kind !== "probability") return "unknown answer kind";
  if (answer.shape !== space.shape) {
    return `answer shape "${String(answer.shape)}" does not match "${space.shape}"`;
  }
  if (space.shape === "binary") return probabilityValue("p", answer.p);
  if (!isPlainRecord(answer.p)) return "the distribution is not an object";
  const keys = answerKeys(space);
  const keyError = closedKeys(answer.p, keys);
  if (keyError) return keyError;
  for (const k of keys) {
    const bad = probabilityValue(k, answer.p[k]);
    if (bad) return bad;
  }
  const sum = orderedSum(answer.p as Record<string, number>, keys);
  if (!(Math.abs(sum - 1) <= STORED_SUM_EPSILON)) {
    return `the stored distribution sums to ${sum}, not 1`;
  }
  return null;
}

/** Validate an outcome's shape and, when answered, its answer. Null = valid. */
export function checkOutcome(space: AnswerSpace, outcome: DecisionOutcome): string | null {
  if (!isPlainRecord(outcome)) return "the outcome is not an object";
  switch (outcome.status) {
    case "answered": {
      const bad = checkStoredAnswer(space, outcome.answer);
      if (bad) return bad;
      if (outcome.providerStatistics !== undefined) {
        if (!isPlainRecord(outcome.providerStatistics))
          return "providerStatistics is not an object";
        for (const [k, v] of Object.entries(outcome.providerStatistics)) {
          if (typeof v !== "number" || !Number.isFinite(v)) {
            return `provider statistic "${k}" is not finite`;
          }
        }
      }
      if (outcome.rationale !== undefined && typeof outcome.rationale !== "string") {
        return "rationale is not a string";
      }
      return null;
    }
    case "abstained":
      return typeof outcome.reason === "string" ? null : "abstention has no reason";
    case "failed":
      return typeof outcome.failure === "string" && typeof outcome.detail === "string"
        ? null
        : "failure has no code or detail";
    default:
      return "unknown outcome status";
  }
}

/** A bounded excerpt of raw provider output, for a failed outcome's audit trail. */
export function rawExcerpt(raw: string, max = 2000): string {
  const cps = Array.from(raw);
  return cps.length > max ? cps.slice(0, max).join("") : raw;
}
