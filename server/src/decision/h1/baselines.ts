import type { Verdict } from "@argus/contracts";
import type { PhaseDef, PhaseProgress } from "@argus/contracts";
import {
  autoApprovalQualification,
  type QualificationBasisEntry,
} from "../../sources/gatePolicy.js";
import { canonicalDigest } from "../canonical.js";
import type { GateReviewBody } from "./projection.js";

/**
 * The two H1 baselines (RFC §H.3, §Q.6), both retained at capture.
 *
 * Neither is a probability. The deterministic baseline is a rule result, and
 * the Verdict baseline is whether the Phase 0 auto-approval rule would have
 * opened the gate. Its rating is an ordinal score, never read as p.
 */

// ── Deterministic rules, `gate-operator-action.rules` v1 ────────────────────

/**
 * Warning codes that say a staged proposal's grounding or references do not
 * hold up. Advisory codes (an assumption without evidence, a new rule beside
 * supplied ones, no semantic change, open questions, "may already be
 * implemented", "not verified yet") are deliberately absent.
 */
export const GROUNDING_WARNING_CODES: readonly string[] = [
  // knowledge delta
  "business-rule-without-evidence",
  "revision-without-evidence",
  "claim-without-support",
  "revision-target-unsupported",
  "revision-stale",
  "source-file-missing",
  "source-outside-scope",
  "source-path-unsafe",
  "source-git-head-mismatch",
  "source-range-invalid",
  // change proposal
  "selected-rule-unclassified",
  "preserved-and-revised",
  "classification-mismatch",
  "acceptance-criterion-unknown-ref",
  "acceptance-criteria-missing",
  "implementation-already-violates",
  "request-claim-unknown",
];

export const DETERMINISTIC_RULE_IDS = [
  "later-attempt",
  "automatic-retry",
  "unverifiable-result",
  "observation-only-holds",
  "grounding-warning",
  "cost-anomaly",
  "duration-anomaly",
] as const;
export type DeterministicRuleId = (typeof DETERMINISTIC_RULE_IDS)[number];

/** The rule set as data, so its digest names exactly what was applied. */
export const GATE_RULES_V1 = {
  id: "gate-operator-action.rules",
  version: 1,
  rules: [...DETERMINISTIC_RULE_IDS],
  groundingWarningCodes: [...GROUNDING_WARNING_CODES],
  anomalyDirection: "high",
  combine:
    "flag if any rule fires; otherwise insufficient-data if any rule cannot be evaluated; otherwise no-flag",
} as const;
export const GATE_RULES_V1_REF = {
  id: GATE_RULES_V1.id,
  version: GATE_RULES_V1.version,
  digest: canonicalDigest(GATE_RULES_V1).sha256,
};

export type RuleClassification = "flag" | "no-flag" | "insufficient-data";

export interface DeterministicResult {
  rules: { id: string; version: number; digest: string };
  classification: RuleClassification;
  fired: DeterministicRuleId[];
  /** Rule → why it could not be evaluated. */
  unevaluable: Array<{ rule: DeterministicRuleId; reason: string }>;
}

/**
 * Apply the rules to a captured body. Pure, so replay recomputes it from the
 * retained snapshot and reports any difference.
 */
export function applyGateRules(body: GateReviewBody): DeterministicResult {
  const fired = new Set<DeterministicRuleId>();
  const unevaluable: DeterministicResult["unevaluable"] = [];
  const cannot = (rule: DeterministicRuleId, reason: string) => unevaluable.push({ rule, reason });

  if (body.gate.attempt > 0) fired.add("later-attempt");
  if (body.gate.retries > 0) fired.add("automatic-retry");

  const staged = body.staged;
  if (staged.status === "unavailable") {
    for (const r of [
      "unverifiable-result",
      "observation-only-holds",
      "grounding-warning",
    ] as const) {
      cannot(r, `staged records unavailable: ${staged.reason}`);
    }
  } else {
    const missing = [
      ...staged.knowledge.unavailable,
      ...staged.ruleVerifications.unavailable,
      ...staged.changeProposals.unavailable,
      ...staged.acceptance.unavailable,
    ];
    const omitted =
      staged.knowledge.rowsOmitted +
      staged.ruleVerifications.rowsOmitted +
      staged.changeProposals.rowsOmitted +
      staged.acceptance.rowsOmitted +
      staged.ruleVerifications.rows.reduce((s, r) => s + r.entriesOmitted, 0) +
      staged.acceptance.rows.reduce((s, r) => s + r.entriesOmitted, 0);
    const outcomeRows = [
      ...staged.ruleVerifications.rows.map((r) => ({ entries: r.entries, pass: "holds" })),
      ...staged.acceptance.rows.map((r) => ({ entries: r.entries, pass: "satisfied" })),
    ];
    const entries = outcomeRows.flatMap((r) => r.entries.map((e) => ({ ...e, pass: r.pass })));
    const counts =
      staged.ruleVerifications.rows.reduce((s, r) => s + r.counts.unverifiable, 0) +
      staged.acceptance.rows.reduce((s, r) => s + r.counts.unverifiable, 0);
    if (counts > 0 || entries.some((e) => e.outcome === "unverifiable"))
      fired.add("unverifiable-result");
    if (
      entries.some(
        (e) =>
          e.outcome === e.pass &&
          e.evidenceKinds.length > 0 &&
          e.evidenceKinds.every((k) => k === "observation"),
      )
    ) {
      fired.add("observation-only-holds");
    }
    const codes = [
      ...staged.knowledge.rows.flatMap((r) => r.warnings.map((w) => w.code)),
      ...staged.changeProposals.rows.flatMap((r) => r.warnings.map((w) => w.code)),
    ];
    if (codes.some((c) => GROUNDING_WARNING_CODES.includes(c))) fired.add("grounding-warning");
    const incomplete =
      missing.length > 0
        ? `staged record unavailable for ${missing.join(", ")}`
        : omitted > 0
          ? `${omitted} staged rows past the snapshot cap`
          : null;
    if (incomplete) {
      if (!fired.has("unverifiable-result")) cannot("unverifiable-result", incomplete);
      if (!fired.has("observation-only-holds")) cannot("observation-only-holds", incomplete);
      if (!fired.has("grounding-warning")) cannot("grounding-warning", incomplete);
    }
  }

  const an = body.anomalies;
  for (const [rule, metric] of [
    ["cost-anomaly", "cost"],
    ["duration-anomaly", "duration"],
  ] as const) {
    if (an.status === "unavailable") {
      cannot(rule, an.reason);
      continue;
    }
    if (
      an.runs.some((r) => r.anomalies.some((a) => a.metric === metric && a.direction === "high"))
    ) {
      fired.add(rule);
      continue;
    }
    const notReady = an.runs.filter((r) => r.baseline !== "ready").map((r) => r.runId);
    const unlisted = body.gate.relevantRuns.length - an.runs.length;
    if (notReady.length > 0)
      cannot(rule, `no trusted Watchtower baseline for ${notReady.join(", ")}`);
    else if (unlisted > 0) cannot(rule, `${unlisted} relevant runs past the snapshot cap`);
    else if (an.runs.length === 0) cannot(rule, "no relevant run");
  }

  const firedList = DETERMINISTIC_RULE_IDS.filter((r) => fired.has(r));
  const pending = unevaluable.filter((u) => !fired.has(u.rule));
  return {
    rules: { ...GATE_RULES_V1_REF },
    classification:
      firedList.length > 0 ? "flag" : pending.length > 0 ? "insufficient-data" : "no-flag",
    fired: firedList,
    unevaluable: pending,
  };
}

// ── The Verdict baseline, `auto-approval-qualification` v1 ──────────────────

export const QUALIFICATION_V1 = {
  id: "auto-approval-qualification",
  version: 1,
  rule: "sources/gatePolicy.autoApprovalQualification over the current verdicts at capture",
  keeps: [
    "gate pause only",
    "configuration and staging knowledge exclusions",
    "autoApprove bar and rubric declared",
    "rubric binding by digest",
    "every relevant step (selected candidate) succeeded with a run",
    "a current, ready, scored verdict with an id for every relevant run",
    "minimum score over relevant steps against the bar",
  ],
} as const;
export const QUALIFICATION_V1_REF = {
  id: QUALIFICATION_V1.id,
  version: QUALIFICATION_V1.version,
  digest: canonicalDigest(QUALIFICATION_V1).sha256,
};

export type VerdictClassification =
  "qualifies" | "below-threshold" | "not-configured" | "ineligible" | "insufficient-data";

export interface VerdictResult {
  definition: { id: string; version: number; digest: string };
  classification: VerdictClassification;
  /** The reason for anything but a decision. */
  reason: string | null;
  /** The minimum rating over relevant steps, when completely judged. A rating, not p. */
  rating: number | null;
  bar: number | null;
  rubricDigest: string | null;
  basis: QualificationBasisEntry[];
}

/** Whether auto-approval would have opened the gate, over the verdicts current at capture. */
export function verdictBaseline(
  phase: PhaseProgress,
  phaseDef: PhaseDef | undefined,
  currentByRun: ReadonlyMap<string, Verdict>,
): VerdictResult {
  const q = autoApprovalQualification(phase, phaseDef, currentByRun);
  const base = { definition: { ...QUALIFICATION_V1_REF } };
  switch (q.status) {
    case "qualifies":
    case "below-threshold":
      return {
        ...base,
        classification: q.status,
        reason: null,
        rating: q.lowest,
        bar: q.bar,
        rubricDigest: q.rubricDigest,
        basis: q.basis,
      };
    case "insufficient-data":
      return {
        ...base,
        classification: "insufficient-data",
        reason: q.runId ? `${q.reason}:${q.runId}` : q.reason,
        rating: null,
        bar: q.bar,
        rubricDigest: q.rubricDigest,
        basis: [],
      };
    case "not-configured":
      return {
        ...base,
        classification: "not-configured",
        reason: q.reason,
        rating: null,
        bar: null,
        rubricDigest: null,
        basis: [],
      };
    case "ineligible":
      return {
        ...base,
        classification: "ineligible",
        reason: `${q.cause}: ${q.reasons.join(", ")}`,
        rating: null,
        bar: null,
        rubricDigest: null,
        basis: [],
      };
  }
}
