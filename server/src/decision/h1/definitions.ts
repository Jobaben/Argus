import type { DecisionProjection, DecisionQuestion } from "@argus/contracts";
import { BUILTIN_BUILDERS, builtinRegistry } from "../definitions.js";
import type { ProjectionBuilder } from "../projection.js";
import { REDACTION_RULES_V1 } from "../redaction.js";
import type { DecisionRegistry } from "../registry.js";

/**
 * The H1 definitions (RFC §H.3, §Q.1, §Q.4).
 *
 * `gate.operator-action` v1 predicts what the operator will do at a gate. It
 * is a prediction of behaviour, not of correctness: `p` is the probability
 * the answer is yes, and yes is "sent back". It has no consumer.
 *
 * They live in their own registry, `h1Registry()`: the built-in Phase 1
 * definitions plus these. `builtinRegistry()` is unchanged, so the Phase 1
 * report and the H2 report read exactly what they read before.
 */

export const GATE_REVIEW_CAPS = {
  name: 200,
  steps: 8,
  prompt: 4000,
  finalMessage: 4000,
  result: 4000,
  checks: 30,
  checkDetail: 300,
  paths: 100,
  path: 300,
  artifacts: 50,
  stagedRows: 20,
  message: 300,
  anomalies: 16,
} as const;

export const GATE_REVIEW_V1: DecisionProjection = {
  id: "gate-review",
  version: 1,
  subject: "phase-attempt",
  description:
    "A phase attempt paused at an ordinary gate, as the gate drawer's review model and Argus's records show it at capture: relevant step prompts and final messages, the validated result, the verification report, changed files and diff statistics, staged-record previews, Watchtower anomalies, artifacts, attempt and retries. Paths and counts, never file content.",
  maxBytes: 96 * 1024,
  redactionRules: REDACTION_RULES_V1.map((r) => r.id),
  truncation: { rule: "truncate.code-points@1", caps: { ...GATE_REVIEW_CAPS } },
  withheld: [
    "gate-decision-records",
    "gate-decision-ids",
    "pending-gate-operation",
    "verdicts",
    "file-content",
    "check-output",
    "post-capture-state",
  ],
};

export const GATE_OPERATOR_ACTION_V1: DecisionQuestion = {
  id: "gate.operator-action",
  version: 1,
  text: "Will the operator send this phase attempt back (revise or abort) rather than approve it as it stands?",
  answers: { shape: "binary" },
  subject: "phase-attempt",
  projection: { id: GATE_REVIEW_V1.id, version: GATE_REVIEW_V1.version },
  consumers: [],
};

export const H1_QUESTION = { id: GATE_OPERATOR_ACTION_V1.id, version: 1 } as const;

/**
 * The live builder for `gate-review` refuses. An H1 call is always made on
 * the snapshot captured while the gate was eligible (§Q.3), never on one
 * rebuilt at call time, so `service.assess` cannot build this projection.
 */
export const gateReviewLiveBuilder: ProjectionBuilder = {
  id: GATE_REVIEW_V1.id,
  version: GATE_REVIEW_V1.version,
  async project() {
    return {
      ok: false,
      reason: "source-unavailable",
      detail: "gate-review snapshots are captured by H1 collection, never rebuilt at call time",
    };
  },
};

export const H1_BUILDERS: readonly ProjectionBuilder[] = [
  ...BUILTIN_BUILDERS,
  gateReviewLiveBuilder,
];

/** The built-in definitions plus H1's. */
export function h1Registry(): DecisionRegistry {
  const r = builtinRegistry();
  r.registerProjection(GATE_REVIEW_V1);
  r.registerQuestion(GATE_OPERATOR_ACTION_V1);
  return r;
}
