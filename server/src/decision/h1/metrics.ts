import type {
  H1Agreement,
  H1ReferenceLabel,
  H1ReliabilityBucket,
  H2Measured,
} from "@argus/contracts";
import { BUCKETS, cohensKappa, MIN_BUCKET, MIN_ECE_N, round6, wilson, Z95 } from "../h2/metrics.js";

/**
 * The statistics the H1 report prints (RFC §Q.11). Pure and deterministic;
 * n = 0 gives null, never zero. The proportions and κ are the H2 functions.
 */

export interface AgreementSpec {
  columns: string[];
  sentBackColumn: string;
  approveColumn: string;
  /** Columns that count as answered: the two predictions, and `tie` for a model. */
  decidedColumns: string[];
}

export const MODEL_SPEC: AgreementSpec = {
  columns: ["sent-back", "approve", "tie", "abstained", "failed"],
  sentBackColumn: "sent-back",
  approveColumn: "approve",
  decidedColumns: ["sent-back", "approve", "tie"],
};

export const RULES_SPEC: AgreementSpec = {
  columns: ["flag", "no-flag", "insufficient-data"],
  sentBackColumn: "flag",
  approveColumn: "no-flag",
  decidedColumns: ["flag", "no-flag"],
};

export const VERDICT_SPEC: AgreementSpec = {
  columns: ["below-threshold", "qualifies", "not-configured", "ineligible", "insufficient-data"],
  sentBackColumn: "below-threshold",
  approveColumn: "qualifies",
  decidedColumns: ["below-threshold", "qualifies"],
};

const ROWS: H1ReferenceLabel[] = ["sent-back", "not-sent-back"];

/** The binary rule for a model's p = P(sent back): strictly above ½, strictly below, or a tie. */
export function binaryPrediction(p: number): "sent-back" | "approve" | "tie" {
  return p > 0.5 ? "sent-back" : p < 0.5 ? "approve" : "tie";
}

export function agreementOf(
  items: ReadonlyArray<{ label: H1ReferenceLabel; column: string }>,
  spec: AgreementSpec,
): H1Agreement {
  const counts = ROWS.map((row) =>
    spec.columns.map((col) => items.filter((i) => i.label === row && i.column === col).length),
  );
  const decided = new Set(spec.decidedColumns);
  const answered = items.filter((i) => decided.has(i.column));
  const agrees = (i: { label: H1ReferenceLabel; column: string }) =>
    (i.label === "sent-back" && i.column === spec.sentBackColumn) ||
    (i.label === "not-sent-back" && i.column === spec.approveColumn);
  const agree = answered.filter(agrees).length;
  const sentBack = answered.filter((i) => i.label === "sent-back");
  const approved = answered.filter((i) => i.label === "not-sent-back");
  const kappa = cohensKappa(
    answered.map(
      (i) =>
        [i.label === "sent-back" ? spec.sentBackColumn : spec.approveColumn, i.column] as const,
    ),
  );
  return {
    columns: [...spec.columns],
    sentBackColumn: spec.sentBackColumn,
    approveColumn: spec.approveColumn,
    decidedColumns: [...spec.decidedColumns],
    confusion: { rows: [...ROWS], columns: [...spec.columns], counts },
    scored: items.length,
    answered: answered.length,
    coverage: wilson(answered.length, items.length),
    agreementAnswered: wilson(agree, answered.length),
    agreementEndToEnd: wilson(agree, items.length),
    falseClose: wilson(
      sentBack.filter((i) => i.column === spec.approveColumn).length,
      sentBack.length,
    ),
    falseEscalation: wilson(
      approved.filter((i) => i.column === spec.sentBackColumn).length,
      approved.length,
    ),
    kappa:
      kappa === null
        ? {
            status: "unmeasured",
            reason: answered.length
              ? "chance agreement is 1"
              : "no answered item in the scoring set",
          }
        : { status: "measured", value: kappa },
  };
}

export interface BinaryCalibrated {
  p: number;
  /** 1 = the operator sent it back. */
  y: 0 | 1;
}

/** Binary Brier score, mean (p − y)², range [0, 1]. Null for no items. */
export function binaryBrier(items: readonly BinaryCalibrated[]): number | null {
  if (items.length === 0) return null;
  return round6(items.reduce((s, i) => s + (i.p - i.y) ** 2, 0) / items.length);
}

/** Ten equal-width bins over p; bin = min(9, floor(10·p)). Shown only at n ≥ 20. */
export function binaryReliability(
  items: readonly BinaryCalibrated[],
  minBucket = MIN_BUCKET,
): H1ReliabilityBucket[] {
  const bins = Array.from({ length: BUCKETS }, () => ({ n: 0, p: 0, y: 0 }));
  for (const it of items) {
    const b = bins[Math.min(BUCKETS - 1, Math.floor(it.p * BUCKETS))];
    b.n++;
    b.p += it.p;
    b.y += it.y;
  }
  return bins.map((b, i) => {
    const measured = b.n >= minBucket;
    return {
      lower: round6(i / BUCKETS),
      upper: round6((i + 1) / BUCKETS),
      n: b.n,
      status: measured ? "measured" : "unmeasured",
      meanPredicted: measured ? round6(b.p / b.n) : null,
      observedRate: measured ? round6(b.y / b.n) : null,
    };
  });
}

/** n-weighted mean |observed rate − mean p| over non-empty bins; null below `minN`. */
export function binaryEce(items: readonly BinaryCalibrated[], minN = MIN_ECE_N): number | null {
  if (items.length < minN) return null;
  const bins = Array.from({ length: BUCKETS }, () => ({ n: 0, p: 0, y: 0 }));
  for (const it of items) {
    const b = bins[Math.min(BUCKETS - 1, Math.floor(it.p * BUCKETS))];
    b.n++;
    b.p += it.p;
    b.y += it.y;
  }
  let e = 0;
  for (const b of bins) if (b.n > 0) e += (b.n / items.length) * Math.abs(b.y / b.n - b.p / b.n);
  return round6(e);
}

/**
 * AUROC for a rating where a **lower** value is expected to mean "sent back":
 * P(rating of a not-sent-back item > rating of a sent-back item), ties ½ (the
 * Mann–Whitney estimate), with the Hanley–McNeil (1982) 95 % interval.
 */
export function aurocLowerMeansPositive(
  items: ReadonlyArray<{ rating: number; label: H1ReferenceLabel }>,
): H2Measured<{ value: number; ci95: [number, number]; sentBack: number; notSentBack: number }> {
  const pos = items.filter((i) => i.label === "sent-back").map((i) => i.rating);
  const neg = items.filter((i) => i.label === "not-sent-back").map((i) => i.rating);
  if (pos.length === 0 || neg.length === 0) {
    return {
      status: "unmeasured",
      reason: `needs both classes: ${pos.length} sent back, ${neg.length} not sent back`,
    };
  }
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += n > p ? 1 : n === p ? 0.5 : 0;
  const a = wins / (pos.length * neg.length);
  const q1 = a / (2 - a);
  const q2 = (2 * a * a) / (1 + a);
  const se = Math.sqrt(
    Math.max(
      0,
      (a * (1 - a) + (pos.length - 1) * (q1 - a * a) + (neg.length - 1) * (q2 - a * a)) /
        (pos.length * neg.length),
    ),
  );
  return {
    status: "measured",
    value: {
      value: round6(a),
      ci95: [round6(Math.max(0, a - Z95 * se)), round6(Math.min(1, a + Z95 * se))],
      sentBack: pos.length,
      notSentBack: neg.length,
    },
  };
}
