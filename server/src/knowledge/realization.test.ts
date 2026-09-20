import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AcceptanceVerification,
  AcceptedChangeProposal,
  ClaimRef,
  RepositoryStateRef,
  RuleVerification,
} from "@argus/contracts";
import {
  addClaim,
  appendRealizationAttempt,
  closeChangeRealization,
  emptyLedger,
  realizationIntentCurrency,
  realizationView,
  repositoryStateIsIdentifiable,
  reviseClaim,
  sameRepositoryState,
  startChangeRealization,
  recordChangeProposal,
  type KnowledgeLedger,
} from "./kernel.js";
import {
  buildRemediationContext,
  evaluateCompletion,
  repositoryStateFrom,
  requiredRules,
  technicalResultFrom,
} from "./realization.js";

/**
 * The completion invariant (Phase 8), as a pure function.
 *
 * `ChangeRealizationComplete` is a conjunction of four independent dimensions
 * plus two preconditions, and every test here is about one of them failing
 * while the others hold — because collapsing any two of them is exactly how a
 * change gets reported as implemented when it is not.
 */

const NOW = "2026-09-20T10:00:00.000Z";
const ref = (id: string, revision: number): ClaimRef => ({ id, revision });
const CLEAN: RepositoryStateRef = { gitHead: "abc123abc123abc123abc123abc123abc123abcd" };

const criteria = [
  {
    id: "AC-1",
    statement: "500 is accepted.",
    kind: "behavior" as const,
    relatesTo: [ref("RULE-42", 2)],
  },
  {
    id: "AC-2",
    statement: "501 is rejected.",
    kind: "behavior" as const,
    relatesTo: [ref("RULE-42", 2)],
  },
  {
    id: "AC-3",
    statement: "Non-Kobra behaviour is unchanged.",
    kind: "regression" as const,
    relatesTo: [ref("CONSTRAINT-8", 1)],
  },
];

const proposal: AcceptedChangeProposal = {
  id: "CP-12",
  schemaVersion: 1,
  request: { id: "CR-1", summary: "Kobra now supports 500-character comments." },
  execution: { runId: "run_intent_1", instanceId: "i1", phaseId: "change-intent" },
  readiness: "ready",
  semanticChanges: [ref("RULE-42", 2)],
  revised: [{ from: ref("RULE-42", 1), to: ref("RULE-42", 2) }],
  created: [],
  decisions: [],
  constraints: [],
  preserved: [ref("CONSTRAINT-8", 1)],
  acceptanceCriteria: criteria,
  unresolved: [],
  classification: [],
  acceptedAt: NOW,
};

function ledger(): KnowledgeLedger {
  let l = emptyLedger();
  l = addClaim(l, { id: "RULE-42", kind: "business-rule", statement: "max 180" }, NOW).ledger;
  l = reviseClaim(l, { id: "RULE-42", statement: "max 500" }, NOW).ledger;
  l = addClaim(l, { id: "CONSTRAINT-8", kind: "constraint", statement: "server-side" }, NOW).ledger;
  l = recordChangeProposal(l, proposal, NOW).ledger;
  return l;
}

const ruleResult = (outcome: RuleVerification["outcome"]): RuleVerification => ({
  id: "RV-1",
  rule: ref("RULE-42", 2),
  outcome,
  execution: { runId: "run_verify_1" },
  repositoryState: CLEAN,
  evidence: [{ type: "observation", note: "read the validator" }],
  createdAt: NOW,
});

const acceptanceResult = (
  criterionId: string,
  outcome: AcceptanceVerification["outcome"],
): AcceptanceVerification => ({
  id: `AV-${criterionId}`,
  proposalId: "CP-12",
  criterionId,
  statement: criteria.find((c) => c.id === criterionId)!.statement,
  kind: criteria.find((c) => c.id === criterionId)!.kind,
  outcome,
  execution: { runId: "run_verify_1" },
  repository: CLEAN,
  evidence: [{ type: "observation", note: "ran it" }],
  createdAt: NOW,
});

const allSatisfied = () => criteria.map((c) => acceptanceResult(c.id, "satisfied"));

function complete(over: Record<string, unknown> = {}) {
  return evaluateCompletion({
    ledger: ledger(),
    proposal,
    implementation: "succeeded",
    technical: { status: "passed", passed: ["typecheck", "tests"], failed: [] },
    implementationState: CLEAN,
    verificationState: CLEAN,
    ruleVerifications: [ruleResult("holds")],
    acceptanceVerifications: allSatisfied(),
    ...over,
  });
}

// ── The conjunction ─────────────────────────────────────────────────────────

test("every dimension holding is the only thing that succeeds", () => {
  const v = complete();
  assert.equal(v.outcome, "succeeded");
  assert.equal(v.remediable, false);
  assert.deepEqual(v.ruleResults, [
    { rule: ref("RULE-42", 2), outcome: "holds", verificationId: "RV-1" },
  ]);
  assert.deepEqual(
    v.acceptanceResults.map((r) => [r.criterionId, r.outcome]),
    [
      ["AC-1", "satisfied"],
      ["AC-2", "satisfied"],
      ["AC-3", "satisfied"],
    ],
  );
});

test("MANDATORY: 'ARGUS_OUTCOME: succeeded' alone is not implementation — a failing check is technical failure", () => {
  const v = complete({
    technical: {
      status: "failed",
      passed: ["typecheck"],
      failed: [{ label: "tests", detail: "1 failing" }],
    },
  });
  assert.equal(v.outcome, "technical-failure");
  assert.match(v.reason, /tests/);
  assert.equal(v.remediable, true);
});

test("MANDATORY: every rule holding and the tests passing is NOT complete while a criterion is violated", () => {
  const v = complete({
    acceptanceVerifications: [
      acceptanceResult("AC-1", "satisfied"),
      acceptanceResult("AC-2", "satisfied"),
      acceptanceResult("AC-3", "violated"),
    ],
  });
  assert.equal(v.outcome, "acceptance-violation");
  assert.match(v.reason, /CP-12\/AC-3/);
  // The rule result is untouched: a failing criterion never rewrites it.
  assert.deepEqual(v.ruleResults[0].outcome, "holds");
  assert.equal(v.remediable, true);
});

test("MANDATORY: every criterion satisfied is NOT complete while a targeted rule is violated", () => {
  const v = complete({ ruleVerifications: [ruleResult("violated")] });
  assert.equal(v.outcome, "rule-violation");
  assert.match(v.reason, /RULE-42:v2 violated/);
  // The criteria results are untouched: the two dimensions never rewrite each
  // other, they are only ever combined.
  assert.deepEqual(
    v.acceptanceResults.map((r) => r.outcome),
    ["satisfied", "satisfied", "satisfied"],
  );
  assert.equal(v.remediable, true);
});

test("a targeted rule nobody verified is unmet, not assumed", () => {
  const v = complete({ ruleVerifications: [] });
  assert.equal(v.outcome, "rule-violation");
  assert.match(v.reason, /RULE-42:v2 unverified/);
});

test("MANDATORY: a required criterion that is unverifiable stops the loop rather than remediating forever", () => {
  const v = complete({
    acceptanceVerifications: [
      acceptanceResult("AC-1", "satisfied"),
      acceptanceResult("AC-2", "satisfied"),
      acceptanceResult("AC-3", "unverifiable"),
    ],
  });
  assert.equal(v.outcome, "acceptance-unverifiable");
  assert.equal(v.remediable, false);
  assert.match(v.reason, /a person is/);
});

test("require: behavioral lets a regression criterion be unverifiable without blocking", () => {
  const v = complete({
    acceptancePolicy: { implementationPhase: "implement", require: "behavioral" },
    acceptanceVerifications: [
      acceptanceResult("AC-1", "satisfied"),
      acceptanceResult("AC-2", "satisfied"),
      acceptanceResult("AC-3", "unverifiable"),
    ],
  });
  assert.equal(v.outcome, "succeeded");
  // …and still records what was actually concluded.
  assert.equal(v.acceptanceResults.find((r) => r.criterionId === "AC-3")!.outcome, "unverifiable");
});

test("a blocker is its own class and stops autonomous remediation", () => {
  const v = complete({ implementation: "blocked" });
  assert.equal(v.outcome, "blocked");
  assert.equal(v.remediable, false);
  assert.match(v.reason, /cannot safely be implemented/);
});

test("the failure classes stay apart: technical before semantic, rules before acceptance", () => {
  // A compile failure is never reported as a rule violation, even when the
  // rules are also unmet: remediating the wrong class wastes the attempt.
  const v = complete({
    implementation: "failed",
    ruleVerifications: [ruleResult("violated")],
    acceptanceVerifications: [acceptanceResult("AC-1", "violated")],
  });
  assert.equal(v.outcome, "technical-failure");
});

// ── Repository-state binding ────────────────────────────────────────────────

test("MANDATORY: two dirty trees at one gitHead are two different states", () => {
  const a = repositoryStateFrom({
    head: "abc123abc123abc123abc123abc123abc123abcd",
    dirty: { "src/a.ts": "hash-one" },
  })!;
  const b = repositoryStateFrom({
    head: "abc123abc123abc123abc123abc123abc123abcd",
    dirty: { "src/a.ts": "hash-two" },
  })!;
  assert.equal(a.gitHead, b.gitHead);
  assert.notEqual(a.workingTree!.snapshotHash, b.workingTree!.snapshotHash);
  assert.equal(sameRepositoryState(a, b), false);
  // And a dirty tree never matches the clean one at the same commit.
  assert.equal(sameRepositoryState(a, { gitHead: a.gitHead }), false);
});

test("the snapshot hash depends on content, not on order or on a clock", () => {
  const one = repositoryStateFrom({ head: null, dirty: { b: "2", a: "1" } })!;
  const two = repositoryStateFrom({ head: null, dirty: { a: "1", b: "2" } })!;
  assert.deepEqual(one, two);
});

test("a tree that is not a repository has no state identity, and says so", () => {
  assert.equal(repositoryStateFrom(null), null);
  assert.equal(repositoryStateIsIdentifiable(undefined), false);
  assert.equal(repositoryStateIsIdentifiable({}), false);
  assert.equal(sameRepositoryState({}, {}), false);
});

test("a truncated snapshot identifies nothing, itself included", () => {
  const t = repositoryStateFrom({ head: "abc1234", dirty: { a: "1" }, truncated: true })!;
  assert.equal(t.workingTree?.truncated, true);
  assert.equal(repositoryStateIsIdentifiable(t), false);
  assert.equal(sameRepositoryState(t, t), false);
});

test("MANDATORY: a verification of a different state proves nothing about this implementation", () => {
  const impl = repositoryStateFrom({ head: CLEAN.gitHead!, dirty: { "src/a.ts": "fixed" } })!;
  const verified = repositoryStateFrom({ head: CLEAN.gitHead!, dirty: { "src/a.ts": "broken" } })!;
  const v = complete({ implementationState: impl, verificationState: verified });
  assert.equal(v.outcome, "state-mismatch");
  assert.equal(v.remediable, false);
  assert.match(v.reason, /not the state the implementation produced/);
});

test("a verification that reported no state at all is a mismatch, not a pass", () => {
  assert.equal(complete({ verificationState: null }).outcome, "state-mismatch");
  assert.equal(complete({ implementationState: null }).outcome, "state-mismatch");
  // Neither side being a repository is the one case that proceeds, with the
  // limitation left explicit rather than a fabricated revision.
  assert.equal(
    complete({ implementationState: null, verificationState: null }).outcome,
    "succeeded",
  );
});

// ── Required rules ──────────────────────────────────────────────────────────

test("only the business rules the change introduced are required; decisions are not", () => {
  let l = ledger();
  l = addClaim(l, { id: "DECISION-1", kind: "decision", statement: "Kobra only" }, NOW).ledger;
  const withDecision = {
    ...proposal,
    semanticChanges: [ref("RULE-42", 2), ref("DECISION-1", 1)],
  };
  assert.deepEqual(requiredRules(l, withDecision), [ref("RULE-42", 2)]);
});

test("a rule the phase's author additionally selected still blocks when it is violated", () => {
  const extra: RuleVerification = {
    id: "RV-2",
    rule: ref("CONSTRAINT-8", 1),
    outcome: "violated",
    execution: { runId: "run_verify_1" },
    repositoryState: CLEAN,
    evidence: [{ type: "observation", note: "moved client-side" }],
    createdAt: NOW,
  };
  const v = complete({ ruleVerifications: [ruleResult("holds"), extra] });
  assert.equal(v.outcome, "rule-violation");
  assert.match(v.reason, /CONSTRAINT-8:v1 violated/);
});

// ── Intent currency ─────────────────────────────────────────────────────────

test("a superseded target is detected, with the supersession named", () => {
  let l = ledger();
  l = reviseClaim(l, { id: "RULE-42", statement: "max 700" }, NOW).ledger;
  const currency = realizationIntentCurrency(l, [ref("RULE-42", 2)]);
  assert.equal(currency.current, false);
  assert.deepEqual(currency.superseded, [{ from: ref("RULE-42", 2), to: ref("RULE-42", 3) }]);
  // And an untouched target is current.
  assert.equal(realizationIntentCurrency(ledger(), [ref("RULE-42", 2)]).current, true);
});

// ── Technical results ───────────────────────────────────────────────────────

test("technical results are merged from Argus's own reports, and absent when there were none", () => {
  assert.equal(technicalResultFrom([undefined, undefined]), undefined);
  const merged = technicalResultFrom([
    {
      status: "passed",
      startedAt: NOW,
      checks: [
        { kind: "command", label: "typecheck", status: "passed", detail: "", durationMs: 1 },
      ],
    },
    {
      status: "failed",
      startedAt: NOW,
      checks: [
        { kind: "command", label: "tests", status: "failed", detail: "1 failing", durationMs: 1 },
      ],
    },
  ])!;
  assert.equal(merged.status, "failed");
  assert.deepEqual(merged.passed, ["typecheck"]);
  assert.deepEqual(merged.failed, [{ label: "tests", detail: "1 failing" }]);
});

// ── The durable record ──────────────────────────────────────────────────────

function opened(maxAttempts = 2) {
  const l = ledger();
  return startChangeRealization(
    l,
    {
      id: "CR-1",
      proposalId: "CP-12",
      target: proposal.semanticChanges,
      instanceId: "i1",
      phaseId: "implement",
      maxAttempts,
      scope: {
        schemaVersion: 1,
        generatedAt: NOW,
        proposalId: "CP-12",
        semanticChanges: proposal.semanticChanges,
        preserved: proposal.preserved,
        targets: [],
        impactedExecutions: [],
        completeness: "known-targets",
        withoutTargets: [],
        requestedPaths: [],
      },
    },
    NOW,
  );
}

const attempt = (n: number, outcome: string) => ({
  attempt: n,
  kind: n === 1 ? ("implementation" as const) : ("remediation" as const),
  implementation: [{ runId: `run_impl_${n}` }],
  verification: [{ runId: `run_verify_${n}` }],
  ruleResults: [],
  acceptanceResults: [],
  outcome: outcome as never,
  startedAt: NOW,
});

test("MANDATORY: a remediation never rewrites the attempt it is remediating", () => {
  const { ledger: base, realization } = opened(3);
  let l = base;
  l = appendRealizationAttempt(l, realization.id, attempt(1, "acceptance-violation")).ledger;
  l = appendRealizationAttempt(l, realization.id, attempt(2, "succeeded")).ledger;
  const after = l.changeRealizations[0];
  assert.deepEqual(
    after.attempts.map((a) => [a.attempt, a.outcome, a.kind]),
    [
      [1, "acceptance-violation", "implementation"],
      [2, "succeeded", "remediation"],
    ],
  );
  // Re-recording attempt 1 identically is a no-op; differently is refused.
  assert.equal(
    appendRealizationAttempt(l, realization.id, attempt(1, "acceptance-violation")).added,
    false,
  );
  assert.throws(
    () => appendRealizationAttempt(l, realization.id, attempt(1, "succeeded")),
    /refusing to replace it/,
  );
});

test("a terminal verdict is written once and never rewritten", () => {
  const { ledger: base, realization } = opened();
  let l = base;
  l = appendRealizationAttempt(l, realization.id, attempt(1, "succeeded")).ledger;
  const close = {
    status: "succeeded" as const,
    repository: CLEAN,
    reason: "everything held",
    unmetRules: [],
    unmetCriteria: [],
    completedAt: NOW,
  };
  l = closeChangeRealization(l, realization.id, close).ledger;
  assert.equal(closeChangeRealization(l, realization.id, close).added, false);
  assert.throws(
    () => closeChangeRealization(l, realization.id, { ...close, status: "failed" }),
    /refusing to rewrite it as failed/,
  );
  // And a closed realization takes no further attempts.
  assert.throws(
    () => appendRealizationAttempt(l, realization.id, attempt(2, "succeeded")),
    /already succeeded/,
  );
});

test("a realization is never retargeted at another proposal", () => {
  const { ledger: base } = opened();
  // A second accepted change, so the refusal below is about retargeting and
  // not merely about an unknown proposal.
  const l = recordChangeProposal(
    base,
    {
      ...proposal,
      id: "CP-13",
      execution: { runId: "run_intent_2", instanceId: "i1", phaseId: "change-intent" },
    },
    NOW,
  ).ledger;
  assert.throws(
    () =>
      startChangeRealization(
        l,
        {
          id: "CR-2",
          proposalId: "CP-13",
          target: [],
          instanceId: "i1",
          phaseId: "implement",
          maxAttempts: 2,
          scope: l.changeRealizations[0].scope,
        },
        NOW,
      ),
    /refusing to retarget/,
  );
  // Opening the same one again is a no-op, which makes a restart safe.
  assert.equal(
    startChangeRealization(l, { ...l.changeRealizations[0], id: "CR-9" }, NOW).added,
    false,
  );
});

test("status is derived from the outcome, never stored twice", () => {
  const { ledger: l, realization } = opened(3);
  assert.equal(realizationView(realization).status, "running");
  assert.equal(realizationView(realization).attemptsRemaining, 3);
  const next = appendRealizationAttempt(
    l,
    realization.id,
    attempt(1, "rule-violation"),
  ).realization;
  assert.equal(realizationView(next).status, "running");
  assert.equal(realizationView(next).attemptsRemaining, 2);
});

// ── Remediation context ─────────────────────────────────────────────────────

test("a remediation is told exactly what is unmet, and what must not be broken", () => {
  const { realization } = opened(3);
  const verdict = complete({
    acceptanceVerifications: [
      acceptanceResult("AC-1", "satisfied"),
      acceptanceResult("AC-2", "violated"),
      acceptanceResult("AC-3", "satisfied"),
    ],
  });
  const ctx = buildRemediationContext({
    realization,
    proposal,
    ledger: ledger(),
    attempt: 2,
    previous: verdict,
    ruleVerifications: [ruleResult("holds")],
    acceptanceVerifications: [
      acceptanceResult("AC-1", "satisfied"),
      acceptanceResult("AC-2", "violated"),
      acceptanceResult("AC-3", "satisfied"),
    ],
    now: NOW,
  });
  assert.equal(ctx.previousOutcome, "acceptance-violation");
  assert.deepEqual(ctx.failedRules, []);
  assert.deepEqual(
    ctx.failedCriteria.map((c) => [c.criterionId, c.outcome, c.statement]),
    [["AC-2", "violated", "501 is rejected."]],
  );
  assert.equal(ctx.failedCriteria[0].ref, "CP-12/AC-2");
  // The successes are named so a remediation does not undo them.
  assert.deepEqual(ctx.satisfied.rules, ["RULE-42:v2"]);
  assert.deepEqual(ctx.satisfied.criteria, ["CP-12/AC-1", "CP-12/AC-3"]);
});

test("a remediation for a rule violation names the rule and its statement", () => {
  const { realization } = opened(3);
  const verdict = complete({ ruleVerifications: [ruleResult("violated")] });
  const ctx = buildRemediationContext({
    realization,
    proposal,
    ledger: ledger(),
    attempt: 2,
    previous: verdict,
    ruleVerifications: [ruleResult("violated")],
    acceptanceVerifications: allSatisfied(),
    now: NOW,
  });
  assert.equal(ctx.failedRules.length, 1);
  assert.equal(ctx.failedRules[0].ref, "RULE-42:v2");
  assert.equal(ctx.failedRules[0].statement, "max 500");
  assert.deepEqual(ctx.failedCriteria, []);
});
