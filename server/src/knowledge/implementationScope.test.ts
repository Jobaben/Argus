import { test } from "node:test";
import assert from "node:assert/strict";
import type { AcceptedChangeProposal, ClaimRef } from "@argus/contracts";
import {
  addClaim,
  addEvidence,
  emptyLedger,
  recordArtifact,
  recordConsumption,
  recordRuleVerification,
  reviseClaim,
  type KnowledgeLedger,
} from "./kernel.js";
import { deriveImplementationScope, requestScopePaths } from "./implementationScope.js";

/**
 * Deterministic implementation scope (Phase 8), as a pure function of the
 * ledger.
 *
 * The three provenance sources it unions, each with its own machine-readable
 * reason — and the one thing it must never do, which is report an empty scope
 * as "nothing to implement" when what it actually means is "Argus has no
 * record of where this goes".
 */

const NOW = "2026-09-20T10:00:00.000Z";
const ref = (id: string, revision: number): ClaimRef => ({ id, revision });

/** A ledger with RULE-42 at v1, grounded in one source file, consumed by an
 *  earlier implementation run that produced one artifact — then revised to v2
 *  as an accepted change would have revised it. */
function seeded(): { ledger: KnowledgeLedger; accepted: AcceptedChangeProposal } {
  let ledger = emptyLedger();
  ledger = addClaim(
    ledger,
    {
      id: "RULE-42",
      kind: "business-rule",
      statement: "Kobra customer comments must not exceed 180 characters.",
    },
    NOW,
  ).ledger;
  ledger = addEvidence(
    ledger,
    {
      id: "EV-1",
      claim: ref("RULE-42", 1),
      direction: "supports",
      source: { type: "source-code", path: "src/Booking/KobraAdapter.cs", startLine: 10 },
    },
    NOW,
  ).ledger;
  // An earlier implementation run consumed v1 and produced a file.
  ledger = recordConsumption(
    ledger,
    {
      execution: { runId: "run_impl_17", instanceId: "i1", phaseId: "implement" },
      claim: ref("RULE-42", 1),
    },
    NOW,
  ).ledger;
  ledger = recordArtifact(
    ledger,
    {
      execution: { runId: "run_impl_17", instanceId: "i1", phaseId: "implement" },
      artifact: { location: "repository", path: "src/Booking/CustomerCommentValidator.cs" },
    },
    NOW,
  ).ledger;
  // And a verification looked at a third file when it decided v1 conformed.
  ledger = recordRuleVerification(
    ledger,
    {
      id: "RV-1",
      rule: ref("RULE-42", 1),
      outcome: "holds",
      execution: { runId: "run_verify_3", instanceId: "i1", phaseId: "verify" },
      evidence: [{ type: "source-code", path: "src/Booking/CommentLimits.cs" }],
    },
    NOW,
  ).ledger;
  // A constraint the change preserves, grounded in its own file.
  ledger = addClaim(
    ledger,
    { id: "CONSTRAINT-8", kind: "constraint", statement: "Validation is enforced server-side." },
    NOW,
  ).ledger;
  ledger = addEvidence(
    ledger,
    {
      id: "EV-2",
      claim: ref("CONSTRAINT-8", 1),
      direction: "supports",
      source: { type: "source-code", path: "src/Booking/ServerValidation.cs" },
    },
    NOW,
  ).ledger;
  ledger = reviseClaim(
    ledger,
    { id: "RULE-42", statement: "Kobra customer comments must not exceed 500 characters." },
    NOW,
  ).ledger;

  const accepted: AcceptedChangeProposal = {
    id: "CP-12",
    schemaVersion: 1,
    request: {
      id: "CR-1",
      summary: "Kobra now supports 500-character comments.",
      scope: { paths: ["src/Booking"] },
    },
    execution: { runId: "run_intent_1", instanceId: "i1", phaseId: "change-intent" },
    readiness: "ready",
    semanticChanges: [ref("RULE-42", 2)],
    revised: [{ from: ref("RULE-42", 1), to: ref("RULE-42", 2) }],
    created: [],
    decisions: [],
    constraints: [],
    preserved: [ref("CONSTRAINT-8", 1)],
    acceptanceCriteria: [],
    unresolved: [],
    classification: [],
    acceptedAt: NOW,
  };
  return { ledger, accepted };
}

const pathsOf = (scope: { targets: { path: string }[] }) => scope.targets.map((t) => t.path);
const reasonsFor = (
  scope: { targets: { path: string; reasons: { code: string }[] }[] },
  p: string,
) => scope.targets.find((t) => t.path === p)?.reasons.map((r) => r.code) ?? [];

// ── The three provenance sources ────────────────────────────────────────────

test("an ImpactSet artifact enters scope, with the execution that produced it named", () => {
  const { ledger, accepted } = seeded();
  const scope = deriveImplementationScope(ledger, accepted, { now: NOW });

  assert.ok(pathsOf(scope).includes("src/Booking/CustomerCommentValidator.cs"));
  const reason = scope.targets
    .find((t) => t.path === "src/Booking/CustomerCommentValidator.cs")!
    .reasons.find((r) => r.code === "impact-artifact")!;
  assert.deepEqual(reason.claim, ref("RULE-42", 1));
  assert.equal(reason.execution?.runId, "run_impl_17");
  // The consumer execution itself is named too, so a reader can follow it.
  assert.deepEqual(
    scope.impactedExecutions.map((e) => e.runId),
    ["run_impl_17"],
  );
});

test("source-code evidence for a changed rule enters scope, citing the evidence record", () => {
  const { ledger, accepted } = seeded();
  const scope = deriveImplementationScope(ledger, accepted, { now: NOW });
  const reason = scope.targets
    .find((t) => t.path === "src/Booking/KobraAdapter.cs")!
    .reasons.find((r) => r.code === "source-code-evidence")!;
  assert.equal(reason.evidenceId, "EV-1");
  assert.deepEqual(reason.claim, ref("RULE-42", 1));
});

test("the location an accepted verification examined enters scope on its own reason", () => {
  const { ledger, accepted } = seeded();
  const scope = deriveImplementationScope(ledger, accepted, { now: NOW });
  assert.deepEqual(reasonsFor(scope, "src/Booking/CommentLimits.cs"), ["verification-evidence"]);
});

test("the ChangeRequest's own scope is carried through, labelled as the request's", () => {
  const { ledger, accepted } = seeded();
  const scope = deriveImplementationScope(ledger, accepted, { now: NOW });
  assert.deepEqual(reasonsFor(scope, "src/Booking"), ["request-scope"]);
  assert.deepEqual(scope.requestedPaths, ["src/Booking"]);
});

test("a preserved revision's evidence is regression surface, not work", () => {
  const { ledger, accepted } = seeded();
  const scope = deriveImplementationScope(ledger, accepted, { now: NOW });
  const target = scope.targets.find((t) => t.path === "src/Booking/ServerValidation.cs")!;
  assert.deepEqual(
    target.reasons.map((r) => r.code),
    ["preserved-evidence"],
  );
  assert.equal(target.preserveOnly, true);
  // And the work surface is not.
  assert.equal(
    scope.targets.find((t) => t.path === "src/Booking/KobraAdapter.cs")!.preserveOnly,
    false,
  );
});

test("includePreserved: false leaves the regression surface out entirely", () => {
  const { ledger, accepted } = seeded();
  const scope = deriveImplementationScope(ledger, accepted, {
    now: NOW,
    includePreserved: false,
  });
  assert.equal(pathsOf(scope).includes("src/Booking/ServerValidation.cs"), false);
});

test("one path with several reasons keeps all of them, deduplicated", () => {
  const { ledger: seededLedger, accepted } = seeded();
  let ledger = seededLedger;
  // A second evidence record for the same file and the same rule revision.
  ledger = addEvidence(
    ledger,
    {
      id: "EV-3",
      claim: ref("RULE-42", 2),
      direction: "supports",
      source: { type: "source-code", path: "src/Booking/KobraAdapter.cs" },
    },
    NOW,
  ).ledger;
  const scope = deriveImplementationScope(ledger, accepted, { now: NOW });
  const reasons = scope.targets.find((t) => t.path === "src/Booking/KobraAdapter.cs")!.reasons;
  assert.equal(reasons.length, 2);
  assert.deepEqual(new Set(reasons.map((r) => r.evidenceId)), new Set(["EV-1", "EV-3"]));
});

// ── Completeness ────────────────────────────────────────────────────────────

test("every changed rule with provenance reads known-targets", () => {
  const { ledger, accepted } = seeded();
  const scope = deriveImplementationScope(ledger, accepted, { now: NOW });
  assert.equal(scope.completeness, "known-targets");
  assert.deepEqual(scope.withoutTargets, []);
});

test("MANDATORY: a new rule nothing has ever implemented reports scope-incomplete, never an empty 'nothing to do'", () => {
  let ledger = emptyLedger();
  ledger = addClaim(
    ledger,
    { id: "RULE-99", kind: "business-rule", statement: "Refunds require a manager." },
    NOW,
  ).ledger;
  const accepted: AcceptedChangeProposal = {
    id: "CP-13",
    schemaVersion: 1,
    request: { id: "CR-2", summary: "Introduce manager approval for refunds." },
    execution: { runId: "r1", instanceId: "i1", phaseId: "change-intent" },
    readiness: "ready",
    semanticChanges: [ref("RULE-99", 1)],
    revised: [],
    created: [ref("RULE-99", 1)],
    decisions: [],
    constraints: [],
    preserved: [],
    acceptanceCriteria: [],
    unresolved: [],
    classification: [],
    acceptedAt: NOW,
  };
  const scope = deriveImplementationScope(ledger, accepted, { now: NOW });

  // There is genuinely nothing in the ledger to point at …
  assert.deepEqual(scope.targets, []);
  assert.deepEqual(scope.impactedExecutions, []);
  // … and the scope says so, rather than reading as "no implementation required".
  assert.equal(scope.completeness, "scope-incomplete");
  assert.deepEqual(scope.withoutTargets, [ref("RULE-99", 1)]);
});

test("a request's own paths do not make an unimplemented rule read as fully scoped", () => {
  let ledger = emptyLedger();
  ledger = addClaim(
    ledger,
    { id: "RULE-99", kind: "business-rule", statement: "Refunds require a manager." },
    NOW,
  ).ledger;
  const accepted: AcceptedChangeProposal = {
    id: "CP-13",
    schemaVersion: 1,
    request: {
      id: "CR-2",
      summary: "Introduce manager approval for refunds.",
      scope: { paths: ["src/Refunds"] },
    },
    execution: { runId: "r1", instanceId: "i1", phaseId: "change-intent" },
    readiness: "ready",
    semanticChanges: [ref("RULE-99", 1)],
    revised: [],
    created: [ref("RULE-99", 1)],
    decisions: [],
    constraints: [],
    preserved: [],
    acceptanceCriteria: [],
    unresolved: [],
    classification: [],
    acceptedAt: NOW,
  };
  const scope = deriveImplementationScope(ledger, accepted, { now: NOW });
  // The hint reaches the agent …
  assert.deepEqual(pathsOf(scope), ["src/Refunds"]);
  assert.deepEqual(reasonsFor(scope, "src/Refunds"), ["request-scope"]);
  // … and Argus still says its own provenance cannot place the rule.
  assert.equal(scope.completeness, "scope-incomplete");
});

test("a decision claim with no file of its own does not make the scope incomplete", () => {
  const { ledger: base, accepted } = seeded();
  let ledger = base;
  ledger = addClaim(
    ledger,
    { id: "DECISION-1", kind: "decision", statement: "Only for Kobra." },
    NOW,
  ).ledger;
  const withDecision: AcceptedChangeProposal = {
    ...accepted,
    semanticChanges: [...accepted.semanticChanges, ref("DECISION-1", 1)],
    created: [ref("DECISION-1", 1)],
    decisions: [ref("DECISION-1", 1)],
  };
  const scope = deriveImplementationScope(ledger, withDecision, { now: NOW });
  assert.equal(scope.completeness, "known-targets");
});

// ── Determinism ─────────────────────────────────────────────────────────────

test("the same ledger always produces the same document", () => {
  const { ledger, accepted } = seeded();
  const a = deriveImplementationScope(ledger, accepted, { now: NOW });
  const b = deriveImplementationScope(ledger, accepted, { now: NOW });
  assert.deepEqual(a, b);
  // Sorted by path, so the file is stable across runs.
  assert.deepEqual(
    pathsOf(a),
    [...pathsOf(a)].sort((x, y) => x.localeCompare(y)),
  );
});

test("scope derivation mutates nothing", () => {
  const { ledger, accepted } = seeded();
  const before = JSON.stringify(ledger);
  deriveImplementationScope(ledger, accepted, { now: NOW });
  assert.equal(JSON.stringify(ledger), before);
});

test("request scope paths are trimmed and deduplicated", () => {
  assert.deepEqual(
    requestScopePaths({ id: "x", summary: "y", scope: { paths: [" a ", "a", "b"] } }),
    ["a", "b"],
  );
  assert.deepEqual(requestScopePaths(undefined), []);
});
