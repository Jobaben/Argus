import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChangeIntentPolicy,
  ChangeProposal,
  ChangeProposalRecord,
  ChangeRequest,
  ClaimRef,
  KnowledgeDeltaApplyResult,
  KnowledgeDeltaRecord,
} from "@argus/contracts";
import {
  addClaim,
  addEvidence,
  emptyLedger,
  recordChangeProposal,
  recordRuleVerification,
  type KnowledgeLedger,
} from "./kernel.js";
import { validateKnowledgeDelta } from "./delta.js";
import {
  CHANGE_INTENT_CONTRACT,
  ChangeProposalError,
  buildChangeContext,
  buildChangeIntentInput,
  changeIntentInstruction,
  changeReadiness,
  changeRuleStates,
  checkChangeProposal,
  fatalChangeWarnings,
  parseChangeProposal,
  previewChangeProposal,
  requestWithIdentity,
  resolveChangeAcceptance,
  selectedChangeRules,
  summarizeChangeIntent,
  validateChangeProposal,
  validateChangeRequest,
  type ChangeIntentContext,
  type ChangeProposalAcceptance,
} from "./changeIntent.js";

/**
 * The deterministic half of change-intent orchestration, on hand-built
 * proposals and ledgers: which proposals Argus refuses outright, which it
 * merely flags, how readiness is decided, what a reviewer sees, and what
 * happens to a delta-local reference at the acceptance boundary.
 *
 * Throughout, the three things Phase 7 keeps apart:
 *
 *   a request     is not a rule
 *   a rule        is not its implementation
 *   a criterion   is not a claim
 */

const T0 = "2026-09-20T10:00:00.000Z";
const HEAD = "abc123def4567890abc123def4567890abc123de";
const OTHER_HEAD = "def4560000000000000000000000000000000000";
const v = (id: string, revision: number): ClaimRef => ({ id, revision });

const request = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
  id: "CR-1",
  summary: "Kobra now supports 500-character customer comments.",
  ...over,
});

/** RULE-42:v1 (supported) and CONSTRAINT-8:v1 (supported): the canonical state
 *  every scenario in this file starts from. */
function seeded(): KnowledgeLedger {
  let ledger = emptyLedger();
  for (const [id, kind, statement] of [
    ["RULE-42", "business-rule", "Kobra customer comments must not exceed 180 characters."],
    ["CONSTRAINT-8", "constraint", "Comment validation is enforced server-side."],
  ] as const) {
    ledger = addClaim(ledger, { id, kind, statement }, T0).ledger;
    ledger = addEvidence(
      ledger,
      {
        id: `EV-${id}`,
        claim: v(id, 1),
        direction: "supports",
        source: { type: "human", who: "domain owner" },
      },
      T0,
    ).ledger;
  }
  return ledger;
}

function ctx(over: Partial<ChangeIntentContext> = {}): ChangeIntentContext {
  return {
    policy: {},
    request: request(),
    selected: [v("RULE-42", 1)],
    gitHead: HEAD,
    ...over,
  };
}

/** The well-formed proposal for the Kobra 180 → 500 scenario. */
const KOBRA_PROPOSAL = {
  schemaVersion: 1,
  semanticDelta: {
    schemaVersion: 1,
    revisions: [
      {
        claimId: "RULE-42",
        expectedRevision: 1,
        statement: "Kobra customer comments must not exceed 500 characters.",
        localId: "r42",
        revisionNote: "Kobra raised its limit.",
      },
    ],
    claims: [
      {
        localId: "d1",
        kind: "decision",
        statement: "The 500-character limit applies only when BookingEngine == Kobra.",
      },
    ],
    evidence: [
      {
        claim: { local: "r42" },
        source: { type: "document", uri: "argus:change-request/CR-1", title: "Kobra 500" },
      },
    ],
    justifications: [
      { conclusion: { local: "d1" }, premises: [{ local: "r42" }, "CONSTRAINT-8:v1"] },
    ],
    consumed: ["RULE-42:v1", "CONSTRAINT-8:v1"],
  },
  preserved: ["CONSTRAINT-8:v1"],
  classification: [{ rule: "RULE-42:v1", disposition: "revised" }],
  acceptanceCriteria: [
    {
      id: "AC-1",
      statement: "A Kobra comment of 500 characters is accepted.",
      kind: "behavior",
      relatesTo: [{ local: "r42" }],
    },
    {
      id: "AC-2",
      statement: "A Kobra comment of 501 characters is rejected.",
      kind: "behavior",
      relatesTo: [{ local: "r42" }],
    },
    {
      id: "AC-3",
      statement: "Non-Kobra comment limits are unchanged.",
      kind: "regression",
      relatesTo: ["CONSTRAINT-8:v1"],
    },
  ],
  metadata: { summary: "Raise the Kobra comment limit to 500." },
};

const proposal = (raw: unknown = KOBRA_PROPOSAL): ChangeProposal => validateChangeProposal(raw);

function record(p: ChangeProposal, over: Partial<ChangeProposalRecord> = {}): ChangeProposalRecord {
  return {
    id: "CP-1",
    runId: "run-A",
    instanceId: "inst-1",
    phaseId: "change",
    attempt: 0,
    step: "reason",
    status: "staged",
    receivedAt: T0,
    updatedAt: T0,
    request: request(),
    selected: [v("RULE-42", 1)],
    gitHead: HEAD,
    proposal: p,
    ...over,
  };
}

function deltaRecord(p: ChangeProposal): KnowledgeDeltaRecord {
  return {
    id: "KD-1",
    runId: "run-A",
    instanceId: "inst-1",
    phaseId: "change",
    attempt: 0,
    step: "reason",
    status: "staged",
    receivedAt: T0,
    updatedAt: T0,
    delta: validateKnowledgeDelta(p.semanticDelta),
  };
}

const codes = (p: ChangeProposal, ledger: KnowledgeLedger | null, c = ctx()) =>
  checkChangeProposal(p, ledger, c).warnings.map((w) => w.code);

// ── The request ─────────────────────────────────────────────────────────────

test("a change request is validated the same way wherever it arrives from", () => {
  const r = validateChangeRequest(
    {
      id: "CR-7",
      summary: "Kobra now supports 500-character comments.",
      details: "Confirmed with the integration team.",
      scope: { paths: ["src/Booking"], label: "Kobra comments" },
      claims: ["RULE-42:v1"],
      constraints: ["validation stays server-side"],
      requestedBy: "product",
    },
    "request",
  );
  assert.equal(r.id, "CR-7");
  assert.deepEqual(r.claims, [v("RULE-42", 1)]);
  assert.deepEqual(r.scope?.paths, ["src/Booking"]);
});

test("a request claim must name an exact revision: a bare id is refused", () => {
  assert.throws(
    () => validateChangeRequest({ summary: "x", claims: ["RULE-42"] }, "request"),
    (e: unknown) => e instanceof ChangeProposalError && /exact revision/.test(e.message),
  );
});

test("a request with no summary is refused: there would be nothing to reason about", () => {
  assert.throws(() => validateChangeRequest({ id: "CR-1" }, "request"), ChangeProposalError);
});

test("a request with no id is given one, keyed to the attempt, and keeps it", () => {
  const minted = requestWithIdentity(validateChangeRequest({ summary: "x" }, "r"), "CR-i-p-0", T0);
  assert.equal(minted.id, "CR-i-p-0");
  assert.equal(minted.receivedAt, T0);
  const authored = requestWithIdentity(request({ id: "CR-9" }), "CR-i-p-0", T0);
  assert.equal(authored.id, "CR-9");
});

// ── Validation of the proposal ──────────────────────────────────────────────

test("the well-formed Kobra proposal validates, and its semantic half is an ordinary delta", () => {
  const p = proposal();
  assert.equal(p.semanticDelta?.revisions?.[0].claimId, "RULE-42");
  assert.equal(p.acceptanceCriteria?.length, 3);
  assert.deepEqual(p.preserved, [v("CONSTRAINT-8", 1)]);
  assert.equal(p.classification?.[0].disposition, "revised");
});

test("a malformed semantic delta refuses the whole proposal under `delta`", () => {
  assert.throws(
    () => proposal({ ...KOBRA_PROPOSAL, semanticDelta: { schemaVersion: 1, revisions: [{}] } }),
    (e: unknown) => e instanceof ChangeProposalError && e.code === "delta",
  );
});

test("acceptance criteria need a kind from the closed vocabulary and at least one reference", () => {
  const bad = (criterion: unknown) =>
    proposal({ ...KOBRA_PROPOSAL, acceptanceCriteria: [criterion] });
  assert.throws(
    () => bad({ id: "AC-1", statement: "x", kind: "vibes", relatesTo: ["RULE-42:v1"] }),
    ChangeProposalError,
  );
  assert.throws(
    () => bad({ id: "AC-1", statement: "x", kind: "behavior", relatesTo: [] }),
    ChangeProposalError,
  );
});

test("two criteria with the same id are refused: a reviewer and the resolver key on them", () => {
  const one = KOBRA_PROPOSAL.acceptanceCriteria[0];
  assert.throws(
    () => proposal({ ...KOBRA_PROPOSAL, acceptanceCriteria: [one, { ...one, statement: "y" }] }),
    ChangeProposalError,
  );
});

test("preserved must name exact revisions: 'whatever RULE-9 becomes' is refused", () => {
  assert.throws(
    () => proposal({ ...KOBRA_PROPOSAL, preserved: ["CONSTRAINT-8"] }),
    ChangeProposalError,
  );
});

test("a document that is not JSON is refused distinctly from one of the wrong shape", () => {
  assert.throws(
    () => parseChangeProposal("{nope"),
    (e: unknown) => e instanceof ChangeProposalError && e.code === "invalid-json",
  );
  assert.throws(
    () => parseChangeProposal(JSON.stringify({ schemaVersion: 2 })),
    (e: unknown) => e instanceof ChangeProposalError && e.code === "schema",
  );
});

// ── Completeness: a supplied rule cannot be silently ignored ────────────────

test("a selected rule with no classification refuses the proposal", () => {
  const p = proposal({ ...KOBRA_PROPOSAL, classification: [] });
  const verdict = checkChangeProposal(p, seeded(), ctx());
  assert.equal(verdict.refusal?.code, "incomplete");
  assert.match(verdict.refusal!.message, /RULE-42:v1 was supplied/);
  assert.ok(fatalChangeWarnings(verdict.warnings, {}).length > 0);
});

test("a classification that disagrees with the delta refuses the proposal", () => {
  // Classified "preserved" while the delta revises it.
  const p = proposal({
    ...KOBRA_PROPOSAL,
    classification: [{ rule: "RULE-42:v1", disposition: "preserved" }],
  });
  const verdict = checkChangeProposal(p, seeded(), ctx());
  assert.equal(verdict.refusal?.code, "contradiction");
  assert.ok(verdict.warnings.some((w) => w.code === "classification-mismatch"));
});

test("a rule classified `revised` that the delta does not revise refuses the proposal", () => {
  const p = proposal({
    schemaVersion: 1,
    classification: [{ rule: "RULE-42:v1", disposition: "revised" }],
  });
  assert.equal(checkChangeProposal(p, seeded(), ctx()).refusal?.code, "contradiction");
});

test("the same claim preserved and revised is a contradiction, not a judgement call", () => {
  const p = proposal({ ...KOBRA_PROPOSAL, preserved: ["RULE-42:v1", "CONSTRAINT-8:v1"] });
  const verdict = checkChangeProposal(p, seeded(), ctx());
  assert.ok(verdict.warnings.some((w) => w.code === "preserved-and-revised"));
  assert.equal(verdict.refusal?.code, "contradiction");
});

test("a criterion naming a local id the delta does not declare refuses the proposal", () => {
  const p = proposal({
    ...KOBRA_PROPOSAL,
    acceptanceCriteria: [
      { id: "AC-1", statement: "x", kind: "behavior", relatesTo: [{ local: "nope" }] },
    ],
  });
  const verdict = checkChangeProposal(p, seeded(), ctx());
  assert.equal(verdict.refusal?.code, "local-reference");
});

test("a criterion naming a revision the ledger does not hold refuses the proposal", () => {
  const p = proposal({
    ...KOBRA_PROPOSAL,
    acceptanceCriteria: [
      { id: "AC-1", statement: "x", kind: "behavior", relatesTo: ["RULE-99:v1"] },
    ],
  });
  assert.equal(checkChangeProposal(p, seeded(), ctx()).refusal?.code, "local-reference");
});

// ── Acceptance criteria: fail-closed by default ─────────────────────────────

test("a business-rule revision with no acceptance criteria is refused by default", () => {
  const p = proposal({ ...KOBRA_PROPOSAL, acceptanceCriteria: [] });
  const verdict = checkChangeProposal(p, seeded(), ctx());
  assert.equal(verdict.refusal?.code, "acceptance-criteria");
  assert.ok(verdict.warnings.some((w) => w.code === "acceptance-criteria-missing"));
});

test('under acceptanceCriteria: "warn" the same proposal is staged, but never ready', () => {
  const p = proposal({ ...KOBRA_PROPOSAL, acceptanceCriteria: [] });
  const policy: ChangeIntentPolicy = { acceptanceCriteria: "warn" };
  const verdict = checkChangeProposal(p, seeded(), ctx({ policy }));
  assert.equal(verdict.refusal, null);
  assert.equal(verdict.readiness, "needs-input");
});

test("a criterion on a *new* business rule covers it by its local id", () => {
  const p = proposal({
    schemaVersion: 1,
    semanticDelta: {
      schemaVersion: 1,
      claims: [{ localId: "n1", kind: "business-rule", statement: "Deposits are 10%." }],
    },
    classification: [{ rule: "RULE-42:v1", disposition: "not-relevant", note: "different area" }],
    acceptanceCriteria: [
      {
        id: "AC-1",
        statement: "A 10% deposit is taken.",
        kind: "behavior",
        relatesTo: [{ local: "n1" }],
      },
    ],
  });
  const verdict = checkChangeProposal(p, seeded(), ctx());
  assert.equal(verdict.refusal, null);
  assert.equal(verdict.readiness, "ready");
});

test("a non-business-rule revision needs no acceptance criterion", () => {
  const p = proposal({
    schemaVersion: 1,
    semanticDelta: {
      schemaVersion: 1,
      revisions: [
        {
          claimId: "CONSTRAINT-8",
          expectedRevision: 1,
          statement: "Validation stays server-side and logged.",
        },
      ],
    },
    classification: [{ rule: "RULE-42:v1", disposition: "not-relevant", note: "unrelated" }],
  });
  assert.equal(checkChangeProposal(p, seeded(), ctx()).refusal, null);
});

// ── Readiness ───────────────────────────────────────────────────────────────

test("the complete Kobra proposal is ready", () => {
  const verdict = checkChangeProposal(proposal(), seeded(), ctx());
  assert.equal(verdict.refusal, null);
  assert.equal(verdict.readiness, "ready");
});

test("an unresolved question makes a proposal needs-input, and no value is invented", () => {
  const p = proposal({
    schemaVersion: 1,
    classification: [{ rule: "RULE-42:v1", disposition: "unresolved" }],
    unresolved: [{ id: "Q-1", question: "What should the new maximum be?" }],
  });
  const verdict = checkChangeProposal(
    p,
    seeded(),
    ctx({ request: request({ summary: "Increase the Kobra comment limit." }) }),
  );
  assert.equal(verdict.refusal, null);
  assert.equal(verdict.readiness, "needs-input");
  assert.equal(p.semanticDelta, undefined);
  assert.ok(verdict.warnings.some((w) => w.code === "unresolved-questions"));
});

test("an `unresolved` classification alone is enough to withhold readiness", () => {
  const p = proposal({
    schemaVersion: 1,
    classification: [{ rule: "RULE-42:v1", disposition: "unresolved" }],
  });
  assert.equal(changeReadiness(p, []), "needs-input");
});

// ── Implementation state is context, never intent ───────────────────────────

/** Seed one conformance result for RULE-42:v1 at `head`. */
function withVerification(
  ledger: KnowledgeLedger,
  outcome: "holds" | "violated",
  head = HEAD,
): KnowledgeLedger {
  return recordRuleVerification(
    ledger,
    {
      id: "RV-1",
      rule: v("RULE-42", 1),
      outcome,
      execution: { runId: "run-verify" },
      evidence: [{ type: "observation", note: "the validator allows 500" }],
      gitHead: head,
    },
    T0,
  ).ledger;
}

test("a rule the code already violates and the change revises warns `change-may-be-implemented`", () => {
  const ledger = withVerification(seeded(), "violated");
  const found = codes(proposal(), ledger);
  assert.ok(found.includes("change-may-be-implemented"));
  assert.equal(found.includes("implementation-already-violates"), false);
});

test("a violated rule the change does NOT revise is a pre-existing defect, and says so", () => {
  const ledger = withVerification(seeded(), "violated");
  const p = proposal({
    schemaVersion: 1,
    classification: [{ rule: "RULE-42:v1", disposition: "not-relevant", note: "unrelated" }],
  });
  const found = codes(p, ledger);
  assert.ok(found.includes("implementation-already-violates"));
});

test("a warning about the implementation never changes the rule's support", () => {
  const ledger = withVerification(seeded(), "violated");
  // The check is pure: it reads the ledger and returns warnings.
  checkChangeProposal(proposal(), ledger, ctx());
  assert.deepEqual(
    ledger.evidence.filter((e) => e.direction === "opposes"),
    [],
  );
  assert.equal(ledger.verifications.length, 1);
  assert.equal(ledger.verifications[0].outcome, "violated");
});

test("no verification at the commit under analysis warns `implementation-unverified`", () => {
  assert.ok(codes(proposal(), seeded()).includes("implementation-unverified"));
  // A verification of a *different* commit does not answer for this one.
  const elsewhere = withVerification(seeded(), "holds", OTHER_HEAD);
  assert.ok(codes(proposal(), elsewhere).includes("implementation-unverified"));
});

test("a rule verified `holds` at this commit raises no implementation warning", () => {
  const found = codes(proposal(), withVerification(seeded(), "holds"));
  assert.equal(found.includes("implementation-unverified"), false);
  assert.equal(found.includes("change-may-be-implemented"), false);
});

// ── No-op and unknown references ────────────────────────────────────────────

test("a request that produces no semantic difference is warned, not refused", () => {
  const p = proposal({
    schemaVersion: 1,
    classification: [{ rule: "RULE-42:v1", disposition: "not-relevant", note: "already says 500" }],
  });
  const verdict = checkChangeProposal(p, seeded(), ctx());
  assert.equal(verdict.refusal, null);
  assert.ok(verdict.warnings.some((w) => w.code === "no-semantic-change"));
});

test("a request naming a revision the ledger does not hold is warned", () => {
  const found = codes(
    proposal(),
    seeded(),
    ctx({ request: request({ claims: [v("RULE-99", 1)] }) }),
  );
  assert.ok(found.includes("request-claim-unknown"));
});

// ── The agent-facing input ──────────────────────────────────────────────────

test("selected rules come from the supplied context and the policy's kinds, never the agent", () => {
  const ledger = seeded();
  const supplied = [v("RULE-42", 1), v("CONSTRAINT-8", 1)];
  assert.deepEqual(selectedChangeRules(ledger, supplied, {}), [v("RULE-42", 1)]);
  assert.deepEqual(selectedChangeRules(ledger, supplied, { kinds: ["constraint"] }), [
    v("CONSTRAINT-8", 1),
  ]);
  assert.deepEqual(selectedChangeRules(ledger, undefined, {}), []);
});

test("the change-intent input carries the request and current conformance, and no more", () => {
  const ledger = withVerification(seeded(), "violated");
  const built = buildChangeIntentInput(ledger, request(), [v("RULE-42", 1)], HEAD, T0);
  assert.equal(built.input.request.summary, request().summary);
  assert.equal(built.relevant.length, 1);
  assert.deepEqual(built.relevant[0], {
    ref: "RULE-42:v1",
    claim: v("RULE-42", 1),
    kind: "business-rule",
    statement: "Kobra customer comments must not exceed 180 characters.",
    support: "supported",
    lifecycle: "active",
    conformance: "violated",
    conformanceAt: HEAD,
    verifiedAt: T0,
  });
  // Support and conformance are both present and never merged: the rule stands
  // while the code is in breach.
  assert.equal(built.relevant[0].support, "supported");
  assert.equal(built.relevant[0].conformance, "violated");
});

test("`unverified` is never reported as `unverifiable`, and never as fine", () => {
  const states = changeRuleStates(seeded(), [v("RULE-42", 1)], HEAD);
  assert.equal(states[0].conformance, "unverified");
  assert.equal(states[0].conformanceAt, undefined);
});

test("the instruction names the request, the accountable rules and the criteria rule", () => {
  const relevant = changeRuleStates(seeded(), [v("RULE-42", 1)], HEAD);
  const text = changeIntentInstruction({}, request(), relevant);
  assert.ok(text.includes(CHANGE_INTENT_CONTRACT));
  assert.ok(text.includes("Kobra now supports 500-character customer comments."));
  assert.ok(text.includes("RULE-42:v1 (supported, implementation unverified)"));
  assert.ok(/MUST carry at least one acceptance criterion/.test(text));
  assert.equal(changeIntentInstruction(undefined, request(), relevant), "");
});

// ── The acceptance boundary: local references stop existing ─────────────────

const APPLIED: KnowledgeDeltaApplyResult = {
  status: "applied",
  deltaId: "KD-1",
  appliedAt: T0,
  createdClaims: [{ localId: "d1", claim: v("DECISION-7", 1) }],
  createdRevisions: [{ localId: "r42", claim: v("RULE-42", 2), supersedes: v("RULE-42", 1) }],
  evidenceIds: [],
  justificationIds: [],
  consumptions: [],
  artifacts: [],
};

function acceptance(over: Partial<ChangeProposalAcceptance> = {}): ChangeProposalAcceptance {
  const p = proposal();
  return {
    id: "CP-1",
    request: request(),
    execution: { runId: "run-A", instanceId: "inst-1", phaseId: "change" },
    attempt: 0,
    deltaId: "KD-1",
    readiness: "ready",
    preserved: p.preserved ?? [],
    acceptanceCriteria: p.acceptanceCriteria ?? [],
    unresolved: p.unresolved ?? [],
    classification: p.classification ?? [],
    ...over,
  };
}

/** The post-commit ledger: RULE-42:v2 and DECISION-7:v1 exist. */
function committed(): KnowledgeLedger {
  let ledger = seeded();
  ledger = addClaim(
    ledger,
    { id: "DECISION-7", kind: "decision", statement: "Only when BookingEngine == Kobra." },
    T0,
  ).ledger;
  ledger = {
    ...ledger,
    claims: [
      ...ledger.claims,
      {
        id: "RULE-42",
        revision: 2,
        kind: "business-rule",
        statement: "Kobra customer comments must not exceed 500 characters.",
        createdAt: T0,
      },
    ],
  };
  return ledger;
}

test("local references resolve to the canonical revisions the commit minted", () => {
  const resolved = resolveChangeAcceptance(acceptance(), APPLIED, committed());
  assert.deepEqual(resolved.revised, [{ from: v("RULE-42", 1), to: v("RULE-42", 2) }]);
  assert.deepEqual(resolved.created, [v("DECISION-7", 1)]);
  assert.deepEqual(resolved.decisions, [v("DECISION-7", 1)]);
  assert.deepEqual(resolved.semanticChanges, [v("DECISION-7", 1), v("RULE-42", 2)]);
  // AC-1 and AC-2 pointed at `local:r42`; they now point at RULE-42:v2.
  assert.deepEqual(resolved.acceptanceCriteria[0].relatesTo, [v("RULE-42", 2)]);
  assert.deepEqual(resolved.acceptanceCriteria[1].relatesTo, [v("RULE-42", 2)]);
  // AC-3 pointed at an existing revision and is unchanged.
  assert.deepEqual(resolved.acceptanceCriteria[2].relatesTo, [v("CONSTRAINT-8", 1)]);
  // Nothing local survives.
  const serialized = JSON.stringify(resolved);
  assert.equal(/"local"/.test(serialized), false);
});

test("a local reference the commit did not create refuses the whole acceptance", () => {
  const broken = acceptance({
    acceptanceCriteria: [
      { id: "AC-1", statement: "x", kind: "behavior", relatesTo: [{ local: "ghost" }] },
    ],
  });
  assert.throws(
    () => resolveChangeAcceptance(broken, APPLIED, committed()),
    /names local id "ghost"/,
  );
});

test("a proposal with no semantic delta resolves to no semantic changes", () => {
  const resolved = resolveChangeAcceptance(
    acceptance({ deltaId: undefined, acceptanceCriteria: [], preserved: [v("CONSTRAINT-8", 1)] }),
    null,
    seeded(),
  );
  assert.deepEqual(resolved.semanticChanges, []);
  assert.deepEqual(resolved.preserved, [v("CONSTRAINT-8", 1)]);
});

// ── The durable record ──────────────────────────────────────────────────────

test("recording an accepted proposal adds one entry and touches nothing else", () => {
  const before = committed();
  const {
    ledger,
    proposal: saved,
    added,
  } = recordChangeProposal(before, resolveChangeAcceptance(acceptance(), APPLIED, before), T0);
  assert.equal(added, true);
  assert.equal(ledger.changeProposals.length, 1);
  assert.equal(saved.request.summary, request().summary);
  for (const key of [
    "claims",
    "evidence",
    "justifications",
    "consumptions",
    "verifications",
  ] as const) {
    assert.deepEqual(ledger[key], before[key]);
  }
});

test("recording the same proposal again is a no-op; a second one for the run is refused", () => {
  const base = committed();
  const first = recordChangeProposal(
    base,
    resolveChangeAcceptance(acceptance(), APPLIED, base),
    T0,
  );
  const again = recordChangeProposal(
    first.ledger,
    resolveChangeAcceptance(acceptance(), APPLIED, first.ledger),
    T0,
  );
  assert.equal(again.added, false);
  assert.equal(again.ledger.changeProposals.length, 1);
  assert.throws(
    () =>
      recordChangeProposal(
        first.ledger,
        resolveChangeAcceptance(acceptance({ id: "CP-2" }), APPLIED, first.ledger),
        T0,
      ),
    /already has accepted change proposal CP-1/,
  );
});

test("an accepted proposal may not name a revision the ledger does not hold", () => {
  const base = seeded();
  assert.throws(
    () => recordChangeProposal(base, resolveChangeAcceptance(acceptance(), APPLIED, base), T0),
    /unknown claim revision/,
  );
});

// ── The downstream handoff ──────────────────────────────────────────────────

test("the change context names canonical refs and restates no claim's sentence", () => {
  const base = committed();
  const { proposal: accepted } = recordChangeProposal(
    base,
    resolveChangeAcceptance(acceptance(), APPLIED, base),
    T0,
  );
  const { context, text } = buildChangeContext(accepted, T0);
  assert.equal(context.proposalId, "CP-1");
  assert.equal(context.readiness, "ready");
  assert.deepEqual(context.semanticChanges, [v("DECISION-7", 1), v("RULE-42", 2)]);
  assert.deepEqual(context.preserved, [v("CONSTRAINT-8", 1)]);
  assert.deepEqual(context.decisions, [v("DECISION-7", 1)]);
  assert.equal(context.acceptanceCriteria.length, 3);
  // The request is carried; the claims' statements are not.
  assert.ok(text.includes("Kobra now supports 500-character customer comments."));
  assert.equal(text.includes("must not exceed 500 characters"), false);
});

// ── The review projection ───────────────────────────────────────────────────

test("the preview shows the request, the current rules with conformance, and the transition", () => {
  const ledger = withVerification(seeded(), "violated");
  const p = proposal();
  const preview = previewChangeProposal(record(p), ledger, deltaRecord(p));
  assert.equal(preview.request.summary, request().summary);
  assert.equal(preview.readiness, "ready");
  assert.deepEqual(
    preview.current.map((r) => [r.ref, r.support, r.conformance]),
    [["RULE-42:v1", "supported", "violated"]],
  );
  assert.equal(preview.semantic?.proposedRevisions[0].claimId, "RULE-42");
  assert.equal(preview.semantic?.proposedRevisions[0].current?.statement.includes("180"), true);
  assert.deepEqual(
    preview.preserved.map((c) => c.ref),
    ["CONSTRAINT-8:v1"],
  );
  assert.equal(preview.acceptanceCriteria.length, 3);
  assert.deepEqual(preview.unresolved, []);
  assert.ok(preview.warnings.some((w) => w.code === "change-may-be-implemented"));
  assert.equal(preview.summary, "Raise the Kobra comment limit to 500.");
});

test("a proposed claim is shown as local: the preview invents no canonical identity", () => {
  const p = proposal();
  const preview = previewChangeProposal(record(p), seeded(), deltaRecord(p));
  assert.deepEqual(
    preview.semantic?.proposedClaims.map((c) => c.ref.display),
    ["local:d1"],
  );
});

test("the summary counts what the gate shows, and says a decision is outstanding", () => {
  const p = proposal();
  const preview = previewChangeProposal(record(p), seeded(), deltaRecord(p));
  const summary = summarizeChangeIntent(preview, true)!;
  assert.equal(summary.requestId, "CR-1");
  assert.equal(summary.readiness, "ready");
  assert.equal(summary.selected, 1);
  assert.equal(summary.revised, 1);
  assert.equal(summary.created, 1);
  assert.equal(summary.decisions, 1);
  assert.equal(summary.preserved, 1);
  assert.equal(summary.acceptanceCriteria, 3);
  assert.equal(summary.unresolved, 0);
  assert.equal(summary.requiresReview, true);
  assert.equal(summarizeChangeIntent(null, true), undefined);
});
