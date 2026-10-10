import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AcceptedChangeProposal,
  ClaimRef,
  ResolvedAcceptanceCriterion,
} from "@argus/contracts";
import {
  AcceptanceVerificationError,
  acceptanceCheckRefusal,
  acceptanceCompletenessRefusal,
  bindAcceptanceChecks,
  checkAcceptanceReport,
  criterionIsRequired,
  parseAcceptanceReport,
  previewAcceptance,
  summarizeAcceptance,
  validateAcceptanceReport,
} from "./acceptance.js";
import {
  acceptanceConformance,
  addClaim,
  emptyLedger,
  formatCriterionRef,
  recordAcceptanceVerification,
  recordChangeProposal,
  type KnowledgeLedger,
} from "./kernel.js";

/**
 * Acceptance-criterion verification (Phase 8), as a pure function of a
 * document, a proposal and a ledger.
 *
 * The invariants the whole dimension exists for:
 *
 * - a criterion is addressed by `(proposal, criterion)`, so CP-11's AC-1 can
 *   never answer CP-12's;
 * - every criterion of the accepted proposal is accounted for, or the whole
 *   document is refused;
 * - a `satisfied` outcome may cite a check, and may not claim one passed.
 */

const NOW = "2026-09-20T10:00:00.000Z";
const ref = (id: string, revision: number): ClaimRef => ({ id, revision });

const criteria: ResolvedAcceptanceCriterion[] = [
  {
    id: "AC-1",
    statement: "A Kobra comment of 500 characters is accepted.",
    kind: "behavior",
    relatesTo: [ref("RULE-42", 2)],
  },
  {
    id: "AC-2",
    statement: "A Kobra comment of 501 characters is rejected.",
    kind: "behavior",
    relatesTo: [ref("RULE-42", 2)],
  },
  {
    id: "AC-3",
    statement: "Non-Kobra comment limits are unchanged.",
    kind: "regression",
    relatesTo: [ref("CONSTRAINT-8", 1)],
  },
];

function proposal(id: string, list = criteria): AcceptedChangeProposal {
  return {
    id,
    schemaVersion: 1,
    request: { id: "CR-1", summary: "Kobra now supports 500-character comments." },
    // One change-intent run produces one accepted proposal, so two proposals
    // are two runs.
    execution: { runId: `run_intent_${id}`, instanceId: "i1", phaseId: "change-intent" },
    readiness: "ready",
    semanticChanges: [ref("RULE-42", 2)],
    revised: [{ from: ref("RULE-42", 1), to: ref("RULE-42", 2) }],
    created: [],
    decisions: [],
    constraints: [],
    preserved: [ref("CONSTRAINT-8", 1)],
    acceptanceCriteria: list,
    unresolved: [],
    classification: [],
    acceptedAt: NOW,
  };
}

/** A ledger holding the claims the proposal names, and the proposal itself. */
function ledgerWith(...proposals: AcceptedChangeProposal[]): KnowledgeLedger {
  let ledger = emptyLedger();
  ledger = addClaim(
    ledger,
    { id: "RULE-42", kind: "business-rule", statement: "max 180" },
    NOW,
  ).ledger;
  ledger = {
    ...ledger,
    claims: [
      ...ledger.claims,
      { id: "RULE-42", revision: 2, kind: "business-rule", statement: "max 500", createdAt: NOW },
      {
        id: "CONSTRAINT-8",
        revision: 1,
        kind: "constraint",
        statement: "server-side",
        createdAt: NOW,
      },
    ],
  };
  for (const p of proposals) {
    ledger = recordChangeProposal(ledger, { ...p, id: p.id }, NOW).ledger;
  }
  return ledger;
}

const ctx = (over: Record<string, unknown> = {}) => ({
  policy: { implementationPhase: "implement" },
  proposalId: "CP-12",
  required: criteria,
  repoRoot: null,
  gitHead: null,
  checkLabels: ["kobra-comment-500", "kobra-comment-501", "non-kobra-unchanged"],
  ...over,
});

const answer = (id: string, outcome: string, over: Record<string, unknown> = {}) => ({
  criterionId: id,
  outcome,
  evidence: outcome === "unverifiable" ? [] : [{ type: "observation", note: "read the code" }],
  ...(outcome === "unverifiable" ? { reason: "no executable expression" } : {}),
  ...over,
});

const report = (list: unknown[], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  criteria: list,
  ...over,
});

// ── Validation ──────────────────────────────────────────────────────────────

test("a well-formed report validates, and a check's status is stripped", () => {
  const out = validateAcceptanceReport(
    report([
      answer("AC-1", "satisfied", {
        evidence: [{ type: "check", label: "kobra-comment-500", status: "passed" }],
      }),
    ]),
  );
  assert.equal(out.criteria.length, 1);
  // The agent named a check; it did not get to say how it went.
  assert.deepEqual(out.criteria[0].evidence, [{ type: "check", label: "kobra-comment-500" }]);
});

test("a satisfied or violated outcome with no evidence is refused", () => {
  for (const outcome of ["satisfied", "violated"]) {
    assert.throws(
      () => validateAcceptanceReport(report([{ criterionId: "AC-1", outcome, evidence: [] }])),
      (e: unknown) => e instanceof AcceptanceVerificationError && e.code === "evidence",
    );
  }
});

test("an unverifiable outcome with no reason is refused", () => {
  assert.throws(
    () =>
      validateAcceptanceReport(
        report([{ criterionId: "AC-1", outcome: "unverifiable", evidence: [] }]),
      ),
    (e: unknown) => e instanceof AcceptanceVerificationError && e.code === "evidence",
  );
});

test("a criterion reported on twice is refused", () => {
  assert.throws(
    () =>
      validateAcceptanceReport(report([answer("AC-1", "satisfied"), answer("AC-1", "violated")])),
    (e: unknown) => e instanceof AcceptanceVerificationError && e.code === "schema",
  );
});

test("invalid JSON is its own code, distinct from a well-formed document of the wrong shape", () => {
  assert.throws(
    () => parseAcceptanceReport("{not json"),
    (e: unknown) => e instanceof AcceptanceVerificationError && e.code === "invalid-json",
  );
  assert.throws(
    () => parseAcceptanceReport(JSON.stringify({ schemaVersion: 2, criteria: [] })),
    (e: unknown) => e instanceof AcceptanceVerificationError && e.code === "schema",
  );
});

// ── Completeness ────────────────────────────────────────────────────────────

test("MANDATORY: a proposal with AC-1..AC-3 whose verification omits AC-3 is refused entirely", async () => {
  const refusal = await checkAcceptanceReport(
    validateAcceptanceReport(report([answer("AC-1", "satisfied"), answer("AC-2", "satisfied")])),
    ctx(),
  );
  assert.equal(refusal?.code, "incomplete");
  assert.match(refusal!.message, /AC-3/);
});

test("MANDATORY: a verification that submits AC-4, which the proposal does not declare, is refused", async () => {
  const refusal = await checkAcceptanceReport(
    validateAcceptanceReport(
      report([
        answer("AC-1", "satisfied"),
        answer("AC-2", "satisfied"),
        answer("AC-3", "satisfied"),
        answer("AC-4", "satisfied"),
      ]),
    ),
    ctx(),
  );
  assert.equal(refusal?.code, "unknown-criterion");
  assert.match(refusal!.message, /AC-4/);
});

test("completeness is decided from the proposal, in both directions", () => {
  assert.equal(
    acceptanceCompletenessRefusal(
      { schemaVersion: 1, criteria: criteria.map((c) => answer(c.id, "satisfied")) as never },
      criteria,
    ),
    null,
  );
});

// ── Proposal identity ───────────────────────────────────────────────────────

test("MANDATORY: an acceptance report written against CP-11 cannot answer CP-12", async () => {
  const refusal = await checkAcceptanceReport(
    validateAcceptanceReport(
      report(
        criteria.map((c) => answer(c.id, "satisfied")),
        { proposalId: "CP-11" },
      ),
    ),
    ctx({ proposalId: "CP-12" }),
  );
  assert.equal(refusal?.code, "unknown-proposal");
  assert.match(refusal!.message, /proposal-scoped/);
});

test("criterion identity is the pair, so two proposals' AC-1 are different records", () => {
  let ledger = ledgerWith(proposal("CP-12"), proposal("CP-11"));
  ledger = recordAcceptanceVerification(
    ledger,
    {
      id: "AV-1",
      proposalId: "CP-12",
      criterionId: "AC-1",
      outcome: "satisfied",
      execution: { runId: "run-a" },
      evidence: [{ type: "observation", note: "ok" }],
    },
    NOW,
  ).ledger;
  assert.equal(acceptanceConformance(ledger, "CP-12", "AC-1").status, "satisfied");
  // CP-11's AC-1 is untouched: nobody looked at it.
  assert.equal(acceptanceConformance(ledger, "CP-11", "AC-1").status, "unverified");
  assert.equal(formatCriterionRef("CP-12", "AC-1"), "CP-12/AC-1");
});

test("a result naming a criterion the proposal does not declare is refused by the kernel too", () => {
  const ledger = ledgerWith(proposal("CP-12"));
  assert.throws(
    () =>
      recordAcceptanceVerification(
        ledger,
        {
          id: "AV-1",
          proposalId: "CP-12",
          criterionId: "AC-9",
          outcome: "satisfied",
          execution: { runId: "run-a" },
          evidence: [{ type: "observation", note: "ok" }],
        },
        NOW,
      ),
    /declares no acceptance criterion AC-9/,
  );
});

test("the statement a record carries comes from the accepted proposal, not the agent", () => {
  const ledger = ledgerWith(proposal("CP-12"));
  const { verification } = recordAcceptanceVerification(
    ledger,
    {
      id: "AV-1",
      proposalId: "CP-12",
      criterionId: "AC-3",
      outcome: "satisfied",
      execution: { runId: "run-a" },
      evidence: [{ type: "observation", note: "ok" }],
    },
    NOW,
  );
  assert.equal(verification.statement, "Non-Kobra comment limits are unchanged.");
  assert.equal(verification.kind, "regression");
});

// ── Check evidence ──────────────────────────────────────────────────────────

test("a cited check the phase does not declare is refused at intake", async () => {
  const refusal = await checkAcceptanceReport(
    validateAcceptanceReport(
      report([
        answer("AC-1", "satisfied", { evidence: [{ type: "check", label: "made-up" }] }),
        answer("AC-2", "satisfied"),
        answer("AC-3", "satisfied"),
      ]),
    ),
    ctx(),
  );
  assert.equal(refusal?.code, "check-reference");
});

test("MANDATORY: an agent cannot forge a check's status — Argus binds its own result", () => {
  const bound = bindAcceptanceChecks(
    [{ type: "check", label: "kobra-comment-501", status: "passed" }],
    [{ label: "kobra-comment-501", status: "failed", exitCode: 1, detail: "501 was accepted" }],
  );
  assert.deepEqual(bound.evidence, [
    {
      type: "check",
      label: "kobra-comment-501",
      status: "failed",
      detail: "501 was accepted",
      exitCode: 1,
    },
  ]);
  // …and a `satisfied` outcome resting on it is refused at the commit boundary.
  assert.match(
    acceptanceCheckRefusal("CP-12", "AC-2", "satisfied", bound.evidence)!,
    /Argus observed failing/,
  );
  // A `violated` outcome citing a failing check is perfectly coherent.
  assert.equal(acceptanceCheckRefusal("CP-12", "AC-2", "violated", bound.evidence), null);
});

test("a cited check the phase's report does not contain is named, not assumed", () => {
  const bound = bindAcceptanceChecks([{ type: "check", label: "never-ran" }], []);
  assert.deepEqual(bound.missing, ["never-ran"]);
});

// ── Policy ──────────────────────────────────────────────────────────────────

test("require: behavioral accepts unverifiable for a regression criterion only", () => {
  const policy = { implementationPhase: "implement", require: "behavioral" as const };
  assert.equal(criterionIsRequired(policy, { kind: "behavior" }), true);
  assert.equal(criterionIsRequired(policy, { kind: "invariant" }), true);
  assert.equal(criterionIsRequired(policy, { kind: "verification" }), true);
  assert.equal(criterionIsRequired(policy, { kind: "regression" }), false);
  // The default requires all of them.
  assert.equal(criterionIsRequired(undefined, { kind: "regression" }), true);
});

// ── Read models ─────────────────────────────────────────────────────────────

test("the preview groups by outcome and shows each criterion's own statement", () => {
  const preview = previewAcceptance({
    id: "AVR-1",
    runId: "run-a",
    instanceId: "i1",
    phaseId: "verify",
    attempt: 0,
    step: "verify",
    status: "staged",
    receivedAt: NOW,
    updatedAt: NOW,
    proposalId: "CP-12",
    required: criteria,
    report: validateAcceptanceReport(
      report([
        answer("AC-1", "satisfied"),
        answer("AC-2", "violated"),
        answer("AC-3", "unverifiable"),
      ]),
    ),
  });
  assert.deepEqual(
    preview.satisfied.map((e) => e.ref),
    ["CP-12/AC-1"],
  );
  assert.deepEqual(
    preview.violated.map((e) => e.statement),
    ["A Kobra comment of 501 characters is rejected."],
  );
  assert.deepEqual(
    preview.unverifiable.map((e) => e.kind),
    ["regression"],
  );
  assert.deepEqual(preview.violated[0].relatesTo, [ref("RULE-42", 2)]);
  assert.deepEqual(preview.missing, []);

  const summary = summarizeAcceptance("CP-12", [preview], true);
  assert.deepEqual(summary, {
    proposalId: "CP-12",
    required: 3,
    satisfied: 1,
    violated: 1,
    unverifiable: 1,
    requiresReview: true,
  });
});

test("conformance is scoped to the repository state, and unverified is never unverifiable", () => {
  let ledger = ledgerWith(proposal("CP-12"));
  const stateA = { gitHead: "abc123abc123abc123abc123abc123abc123abcd" };
  ledger = recordAcceptanceVerification(
    ledger,
    {
      id: "AV-1",
      proposalId: "CP-12",
      criterionId: "AC-1",
      outcome: "satisfied",
      execution: { runId: "run-a" },
      repository: stateA,
      evidence: [{ type: "observation", note: "ok" }],
    },
    NOW,
  ).ledger;
  assert.equal(acceptanceConformance(ledger, "CP-12", "AC-1", stateA).status, "satisfied");
  assert.equal(
    acceptanceConformance(ledger, "CP-12", "AC-1", {
      gitHead: "def456def456def456def456def456def456def4",
    }).status,
    "unverified",
  );
  // And history is the full, unfiltered history however the question is scoped.
  assert.equal(acceptanceConformance(ledger, "CP-12", "AC-1").history.length, 1);
});

test("recording the same result twice is a no-op; a different one is refused", () => {
  let ledger = ledgerWith(proposal("CP-12"));
  const input = {
    id: "AV-1",
    proposalId: "CP-12",
    criterionId: "AC-1",
    outcome: "satisfied" as const,
    execution: { runId: "run-a" },
    evidence: [{ type: "observation" as const, note: "ok" }],
  };
  const first = recordAcceptanceVerification(ledger, input, NOW);
  ledger = first.ledger;
  const again = recordAcceptanceVerification(ledger, { ...input, id: "AV-2" }, NOW);
  assert.equal(again.added, false);
  assert.equal(again.ledger.acceptanceVerifications.length, 1);
  assert.throws(
    () => recordAcceptanceVerification(ledger, { ...input, id: "AV-2", outcome: "violated" }, NOW),
    /refusing to replace it with violated/,
  );
});

test("an acceptance result changes nothing else in the ledger", () => {
  const ledger = ledgerWith(proposal("CP-12"));
  const before = {
    claims: JSON.stringify(ledger.claims),
    evidence: JSON.stringify(ledger.evidence),
    justifications: JSON.stringify(ledger.justifications),
    verifications: JSON.stringify(ledger.verifications),
  };
  const { ledger: after } = recordAcceptanceVerification(
    ledger,
    {
      id: "AV-1",
      proposalId: "CP-12",
      criterionId: "AC-2",
      outcome: "violated",
      execution: { runId: "run-a" },
      evidence: [{ type: "observation", note: "501 was accepted" }],
    },
    NOW,
  );
  assert.equal(JSON.stringify(after.claims), before.claims);
  assert.equal(JSON.stringify(after.evidence), before.evidence);
  assert.equal(JSON.stringify(after.justifications), before.justifications);
  assert.equal(JSON.stringify(after.verifications), before.verifications);
  assert.equal(after.acceptanceVerifications.length, 1);
});
