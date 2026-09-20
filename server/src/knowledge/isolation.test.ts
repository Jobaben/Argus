import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AcceptedChangeProposal,
  ClaimKind,
  ClaimRef,
  KnowledgeScope,
  RunExecutionRef,
} from "@argus/contracts";
import {
  KnowledgeValidationError,
  addClaim,
  addEvidence,
  addJustification,
  emptyLedger,
  evaluateSupport,
  evidenceOf,
  recordArtifact,
  recordChangeProposal,
  recordConsumption,
  recordRuleVerification,
  reviseClaim,
  ruleConformance,
  scopeOfAcceptedChange,
  supportReport,
  verificationsOfClaim,
  type KnowledgeLedger,
} from "./kernel.js";
import { analyzeImpact } from "./impact.js";
import { deriveImplementationScope } from "./implementationScope.js";
import { resolveKnowledgeContext, KnowledgeContextError } from "./context.js";
import { applyKnowledgeDeltas, KnowledgeDeltaError, type DeltaProposal } from "./delta.js";
import { qualifyClaimId, readableScopes, sameScope, sliceOfScope } from "./scope.js";

/**
 * Knowledge-scope isolation: two unrelated projects in one ledger.
 *
 * Every test here is a way one project's knowledge could reach another's
 * pipeline — a colliding rule id, a borrowed piece of evidence, a verification,
 * an impact walk, a materialized context, an implementation scope — asked as
 * the question a person would ask, and answered against a ledger that really
 * does hold both projects at once.
 *
 * The fixture is deliberately adversarial: both projects call their rule
 * `RULE-42`, state the same sentence, and are touched by runs with adjacent
 * ids. Nothing but the scope distinguishes them.
 */

const T0 = "2026-09-19T10:00:00.000Z";
const T1 = "2026-09-19T11:00:00.000Z";

const A: KnowledgeScope = { projectId: "motorit", repositoryId: "git:github.com/motorit/online" };
const B: KnowledgeScope = { projectId: "acme", repositoryId: "git:github.com/acme/kobra" };

/** `RULE-42` as project A's ledger id, and as project B's: two ids, one name. */
const rule = (scope: KnowledgeScope, local = "RULE-42") => qualifyClaimId(local, scope);
const v1 = (id: string): ClaimRef => ({ id, revision: 1 });

class Build {
  ledger: KnowledgeLedger = emptyLedger();
  private n = 0;

  claim(
    scope: KnowledgeScope | undefined,
    local: string,
    kind: ClaimKind = "business-rule",
    statement = "comments are at most 180 characters",
  ): this {
    this.ledger = addClaim(
      this.ledger,
      { id: qualifyClaimId(local, scope), scope, kind, statement },
      T0,
    ).ledger;
    return this;
  }
  revise(ref: string, statement: string): this {
    this.ledger = reviseClaim(this.ledger, { id: ref, statement }, T1).ledger;
    return this;
  }
  evidence(claim: ClaimRef, direction: "supports" | "opposes" = "supports", path?: string): this {
    this.ledger = addEvidence(
      this.ledger,
      {
        id: `EV-${(this.n += 1)}`,
        claim,
        direction,
        source: path ? { type: "source-code", path } : { type: "human", who: "tester" },
      },
      T0,
    ).ledger;
    return this;
  }
  justify(conclusion: ClaimRef, premises: ClaimRef[]): this {
    this.ledger = addJustification(
      this.ledger,
      { id: `J-${(this.n += 1)}`, conclusion, premises, direction: "supports" },
      T0,
    ).ledger;
    return this;
  }
  consume(runId: string, claim: ClaimRef): this {
    this.ledger = recordConsumption(this.ledger, { execution: { runId }, claim }, T0).ledger;
    return this;
  }
  artifact(runId: string, path: string): this {
    this.ledger = recordArtifact(
      this.ledger,
      { execution: { runId }, artifact: { location: "repository", path } },
      T0,
    ).ledger;
    return this;
  }
  verify(runId: string, ruleRef: ClaimRef, outcome: "holds" | "violated"): this {
    this.ledger = recordRuleVerification(
      this.ledger,
      {
        id: `RV-${(this.n += 1)}`,
        execution: { runId },
        rule: ruleRef,
        outcome,
        evidence: [{ type: "observation", note: "read the validator" }],
        gitHead: "abc1234",
      },
      T0,
    ).ledger;
    return this;
  }
}

/** Both projects, each with its own `RULE-42`, each grounded and consumed. */
function twoProjects(): Build {
  return new Build()
    .claim(A, "RULE-42", "business-rule", "motorit comments are at most 180 characters")
    .claim(B, "RULE-42", "business-rule", "kobra comments are at most 180 characters")
    .evidence(v1(rule(A)), "supports", "src/motorit/CommentValidator.cs")
    .evidence(v1(rule(B)), "supports", "src/kobra/CommentValidator.cs");
}

// ── 1. Two unrelated repositories both contain RULE-42 ──────────────────────

test("two unrelated repositories each hold a RULE-42, and they are different claims", () => {
  const { ledger } = twoProjects();
  assert.notEqual(rule(A), rule(B));
  assert.equal(ledger.claims.length, 2);
  // The scope index answers each project with its own, and only its own.
  assert.deepEqual(
    sliceOfScope(ledger, A).claims.map((c) => c.id),
    [rule(A)],
  );
  assert.deepEqual(
    sliceOfScope(ledger, B).claims.map((c) => c.id),
    [rule(B)],
  );
  // Revising one leaves the other untouched at v1 — no shared revision line.
  const revised = new Build();
  revised.ledger = ledger;
  revised.revise(rule(A), "at most 500 characters");
  assert.equal(revised.ledger.claims.filter((c) => c.id === rule(A)).length, 2);
  assert.equal(revised.ledger.claims.filter((c) => c.id === rule(B)).length, 1);
});

test("a query from project A never returns project B's rule", async () => {
  const { ledger } = twoProjects();
  const resolved = resolveKnowledgeContext(
    ledger,
    { claims: [{ id: "RULE-42", revision: "active" }] },
    T0,
    { instanceId: "i-1", phaseStatus: () => null, knowledge: A },
  );
  assert.deepEqual(
    resolved.supplied.map((r) => r.id),
    [rule(A)],
  );
  assert.deepEqual(resolved.context.claims[0].scope, A);
  // And the same selector, from project B, is project B's rule.
  const fromB = resolveKnowledgeContext(
    ledger,
    { claims: [{ id: "RULE-42", revision: "active" }] },
    T0,
    { instanceId: "i-2", phaseStatus: () => null, knowledge: B },
  );
  assert.deepEqual(
    fromB.supplied.map((r) => r.id),
    [rule(B)],
  );
});

// ── 2. Evidence from project B cannot support project A's claim ─────────────

test("evidence from project B contributes nothing to project A's claim", () => {
  const b = twoProjects();
  // Project B's rule is opposed into `contested`; project A's is untouched.
  b.evidence(v1(rule(B)), "opposes");
  assert.equal(evaluateSupport(b.ledger, v1(rule(A))), "supported");
  assert.equal(evaluateSupport(b.ledger, v1(rule(B))), "contested");
  // The support report for A names only A's evidence, by exact record.
  const report = supportReport(b.ledger, v1(rule(A)));
  assert.equal(report.evidence.length, 1);
  assert.deepEqual(report.evidence[0].claim, v1(rule(A)));
  assert.deepEqual(
    evidenceOf(b.ledger, v1(rule(A))).map((e) => e.source),
    [{ type: "source-code", path: "src/motorit/CommentValidator.cs" }],
  );
});

test("a run in project A cannot attach evidence to project B's claim", () => {
  const { ledger } = twoProjects();
  const proposal: DeltaProposal = {
    id: "D-1",
    execution: { runId: "run-a", instanceId: "i-1", phaseId: "p" },
    attempt: 1,
    scope: A,
    delta: {
      schemaVersion: 1,
      evidence: [{ claim: v1(rule(B)), source: { type: "human", who: "agent" } }],
    },
  };
  assert.throws(
    () => applyKnowledgeDeltas(ledger, [proposal], { now: T1, mint: (p) => `${p}-x` }),
    (e: unknown) => e instanceof KnowledgeDeltaError && e.code === "scope",
  );
});

test("a derivation may not cross a knowledge scope", () => {
  const b = twoProjects().claim(A, "CONCLUSION-1", "conclusion", "the limit is enforced");
  assert.throws(
    () => b.justify(v1(rule(A, "CONCLUSION-1")), [v1(rule(B))]),
    (e: unknown) =>
      e instanceof KnowledgeValidationError && /cross a knowledge scope/.test(e.message),
  );
  // The same derivation inside one scope is fine, so the refusal is about the
  // boundary and not about the shape.
  b.justify(v1(rule(A, "CONCLUSION-1")), [v1(rule(A))]);
  assert.equal(b.ledger.justifications.length, 1);
});

// ── 3. A verification in project B cannot satisfy project A's rule ──────────

test("verifying project B's rule says nothing about project A's", () => {
  const b = twoProjects();
  b.verify("run-b", v1(rule(B)), "holds");
  b.verify("run-b2", v1(rule(A)), "violated");
  assert.deepEqual(
    verificationsOfClaim(b.ledger, v1(rule(A))).map((v) => v.outcome),
    ["violated"],
  );
  assert.equal(ruleConformance(b.ledger, v1(rule(A)), "abc1234").status, "violated");
  assert.equal(ruleConformance(b.ledger, v1(rule(B)), "abc1234").status, "holds");
});

test("a project-A rule nobody verified reads unverified, not project B's holds", () => {
  const b = twoProjects();
  b.verify("run-b", v1(rule(B)), "holds");
  const report = ruleConformance(b.ledger, v1(rule(A)), "abc1234");
  assert.equal(report.status, "unverified");
  assert.deepEqual(report.history, []);
});

// ── 4. Impact analysis does not traverse the other project ──────────────────

test("impact for project A does not visit project B's claims, executions or artifacts", () => {
  const b = twoProjects()
    .claim(A, "CONCLUSION-A", "conclusion", "A's conclusion")
    .claim(B, "CONCLUSION-B", "conclusion", "B's conclusion");
  b.justify(v1(rule(A, "CONCLUSION-A")), [v1(rule(A))]);
  b.justify(v1(rule(B, "CONCLUSION-B")), [v1(rule(B))]);
  b.consume("run-a", v1(rule(A)));
  b.consume("run-b", v1(rule(B)));
  b.artifact("run-a", "src/motorit/Booking.cs");
  b.artifact("run-b", "src/kobra/Booking.cs");
  // Supersede both rules, so both projects' graphs have something to report.
  b.revise(rule(A), "at most 500");
  b.revise(rule(B), "at most 500");

  const impact = analyzeImpact(b.ledger, v1(rule(A)));
  assert.deepEqual(
    impact.semantic.affectedClaims.map((c) => c.claim.id),
    [rule(A, "CONCLUSION-A")],
  );
  assert.deepEqual(
    impact.executions.map((e) => e.execution.runId),
    ["run-a"],
  );
  assert.deepEqual(
    impact.artifacts.map((a) => a.artifact.path),
    ["src/motorit/Booking.cs"],
  );
  // Nothing of B appears anywhere in the answer, including the explanations.
  assert.doesNotMatch(JSON.stringify(impact), /kobra|run-b|acme/);
});

// ── 5. KnowledgeContext carries no foreign records ──────────────────────────

test("a KnowledgeContext for project A contains no project-B record at all", () => {
  const b = twoProjects()
    .claim(A, "FACT-1", "fact", "motorit bookings carry comments")
    .claim(B, "FACT-1", "fact", "kobra bookings carry comments");
  const resolved = resolveKnowledgeContext(
    b.ledger,
    {
      claims: [
        { id: "RULE-42", revision: "active" },
        { id: "FACT-1", revision: "active" },
      ],
    },
    T0,
    { instanceId: "i-1", phaseStatus: () => null, knowledge: A },
  );
  assert.deepEqual(resolved.supplied.map((r) => r.id).sort(), [rule(A, "FACT-1"), rule(A)].sort());
  assert.deepEqual(resolved.context.scope, A);
  // The materialized bytes — what the agent actually reads — carry no project-B
  // record at all: no id, no statement, no scope. The filtering happens before
  // materialization, not in the model's judgement.
  assert.doesNotMatch(resolved.text, /kobra|acme/i);
  for (const id of [rule(B), rule(B, "FACT-1")]) assert.equal(resolved.text.includes(id), false);
  for (const c of resolved.context.claims) assert.deepEqual(c.scope, A);
});

test("naming project B's canonical id from project A is refused, not silently served", () => {
  const { ledger } = twoProjects();
  assert.throws(
    () =>
      resolveKnowledgeContext(ledger, { claims: [{ id: rule(B), revision: "active" }] }, T0, {
        instanceId: "i-1",
        phaseStatus: () => null,
        knowledge: A,
      }),
    (e: unknown) => e instanceof KnowledgeContextError && e.code === "out-of-scope",
  );
});

// ── 6. Realization and implementation scope stay in the owning project ──────

test("an implementation scope is derived only from the proposal's own project", () => {
  const b = twoProjects();
  b.consume("run-b", v1(rule(B)));
  b.artifact("run-b", "src/kobra/CommentValidator.cs");
  b.consume("run-a", v1(rule(A)));
  b.artifact("run-a", "src/motorit/BookingMapper.cs");
  b.revise(rule(A), "at most 500");
  b.revise(rule(B), "at most 500");
  // Both projects' verifications cite a file, in their own repositories.
  b.ledger = recordRuleVerification(
    b.ledger,
    {
      id: "RV-B",
      execution: { runId: "run-b3" },
      rule: v1(rule(B)),
      outcome: "violated",
      evidence: [{ type: "source-code", path: "src/kobra/Leaked.cs" }],
    },
    T0,
  ).ledger;

  const accepted: AcceptedChangeProposal = {
    id: "CP-1",
    schemaVersion: 1,
    request: { id: "CR-1", summary: "raise the limit", scope: { paths: ["src/motorit"] } },
    execution: { runId: "run-a9", instanceId: "i-1", phaseId: "intent" },
    readiness: "ready",
    semanticChanges: [{ id: rule(A), revision: 2 }],
    revised: [{ from: v1(rule(A)), to: { id: rule(A), revision: 2 } }],
    created: [],
    decisions: [],
    constraints: [],
    preserved: [],
    acceptanceCriteria: [],
    unresolved: [],
    classification: [],
    acceptedAt: T1,
  };
  const scope = deriveImplementationScope(b.ledger, accepted, { now: T1 });
  assert.deepEqual(scope.scope, A);
  const paths = scope.targets.map((t) => t.path);
  assert.ok(paths.includes("src/motorit/BookingMapper.cs"));
  assert.ok(paths.includes("src/motorit/CommentValidator.cs"));
  // Not one repository-relative path from the other project, from any of the
  // four derivations — impact artifacts, source evidence, verification
  // evidence or the request's own scope.
  assert.doesNotMatch(JSON.stringify(scope), /kobra/);
  assert.deepEqual(
    scope.impactedExecutions.map((e) => e.runId),
    ["run-a"],
  );
});

test("a change proposal's own project is read from its semantics, not its request", () => {
  const b = twoProjects();
  const proposal = recordChangeProposal(
    b.ledger,
    {
      id: "CP-2",
      // A request whose prose talks about the other project changes nothing:
      // ownership follows the semantics the proposal actually touched.
      request: { id: "CR-2", summary: "make kobra and acme behave", requestedBy: "t" },
      execution: { runId: "run-a9", instanceId: "i-1", phaseId: "intent" },
      readiness: "ready",
      semanticChanges: [],
      revised: [],
      created: [],
      decisions: [],
      constraints: [],
      preserved: [v1(rule(A))],
      acceptanceCriteria: [],
      unresolved: [],
      classification: [],
    },
    T1,
  );
  const scope = deriveImplementationScope(proposal.ledger, proposal.proposal, { now: T1 });
  assert.deepEqual(scope.scope, A);
});

// ── 8. Explicit, authorized cross-scope reading ─────────────────────────────

test("an explicitly authorized alsoRead scope can be traversed deliberately", () => {
  const { ledger } = twoProjects();
  const resolved = resolveKnowledgeContext(
    ledger,
    {
      claims: [
        { id: "RULE-42", revision: "active" },
        { id: rule(B), revision: "active" },
      ],
    },
    T0,
    { instanceId: "i-1", phaseStatus: () => null, knowledge: A, alsoRead: [B] },
  );
  assert.deepEqual(
    resolved.supplied.map((r) => r.id),
    [rule(A), rule(B)],
  );
  assert.deepEqual(resolved.context.alsoRead, [B]);
  // The run's own scope still wins for an unqualified name, so authorizing a
  // second scope never changes what `RULE-42` means.
  assert.equal(resolved.context.claims[0].id, rule(A));
});

test("a run may consume an authorized foreign revision but still may not write to it", () => {
  const { ledger } = twoProjects();
  const base = {
    execution: { runId: "run-a", instanceId: "i-1", phaseId: "p" } as RunExecutionRef,
    attempt: 1,
    scope: A,
    alsoRead: [B],
  };
  const consumed = applyKnowledgeDeltas(
    ledger,
    [{ ...base, id: "D-1", delta: { schemaVersion: 1, consumed: [v1(rule(B))] } }],
    { now: T1, mint: (p) => `${p}-x` },
  );
  assert.deepEqual(consumed.results[0].consumptions[0].claim, v1(rule(B)));
  // Reading is not writing: revising the foreign rule is still refused.
  assert.throws(
    () =>
      applyKnowledgeDeltas(
        ledger,
        [
          {
            ...base,
            id: "D-2",
            delta: {
              schemaVersion: 1,
              revisions: [{ claimId: rule(B), expectedRevision: 1, statement: "at most 500" }],
            },
          },
        ],
        { now: T1, mint: (p) => `${p}-x` },
      ),
    (e: unknown) => e instanceof KnowledgeDeltaError && e.code === "scope",
  );
});

test("without alsoRead, consuming another project's revision is refused", () => {
  const { ledger } = twoProjects();
  assert.throws(
    () =>
      applyKnowledgeDeltas(
        ledger,
        [
          {
            id: "D-1",
            execution: { runId: "run-a", instanceId: "i-1", phaseId: "p" },
            attempt: 1,
            scope: A,
            delta: { schemaVersion: 1, consumed: [v1(rule(B))] },
          },
        ],
        { now: T1, mint: (p) => `${p}-x` },
      ),
    (e: unknown) => e instanceof KnowledgeDeltaError && e.code === "scope",
  );
});

test("an explicit whole-ledger impact traversal is available and is not the default", () => {
  const b = twoProjects();
  // A conclusion in project B that rests on nothing but the cross-scope edge
  // below, so walking that edge visibly changes its support and not walking it
  // visibly does not.
  b.claim(B, "CONCLUSION-B", "conclusion", "kobra's limit is enforced");
  // One hand-built cross-scope justification — `addJustification` refuses to
  // create one, so this is the shape of a ledger edited outside Argus. The
  // default traversal still will not walk it; the explicit one will.
  b.ledger = {
    ...b.ledger,
    justifications: [
      {
        id: "J-x",
        conclusion: v1(rule(B, "CONCLUSION-B")),
        premises: [v1(rule(A))],
        direction: "supports",
        createdAt: T0,
      },
    ],
  };
  b.revise(rule(A), "at most 500");
  // Bounded by default: project A's question gets project A's answer, and the
  // foreign edge is not even visited.
  assert.deepEqual(analyzeImpact(b.ledger, v1(rule(A))).semantic.affectedClaims, []);
  // Asked for explicitly, by name, the broader question is answerable.
  const wide = analyzeImpact(b.ledger, v1(rule(A)), { traverse: "ledger" });
  assert.deepEqual(
    wide.semantic.affectedClaims.map((c) => c.claim.id),
    [rule(B, "CONCLUSION-B")],
  );
});

// ── 9. Legacy ledgers: no fabricated ownership ──────────────────────────────

test("a legacy unscoped claim is never adopted by a scoped pipeline", () => {
  const b = new Build().claim(undefined, "RULE-42");
  assert.equal(b.ledger.claims[0].id, "RULE-42");
  assert.equal("scope" in b.ledger.claims[0], false);
  // A scoped pipeline asking for RULE-42 gets `out-of-scope`, never the legacy
  // record: there is no fallback to the global ledger.
  assert.throws(
    () =>
      resolveKnowledgeContext(b.ledger, { claims: [{ id: "RULE-42", revision: "active" }] }, T0, {
        instanceId: "i-1",
        phaseStatus: () => null,
        knowledge: A,
      }),
    (e: unknown) => e instanceof KnowledgeContextError && e.code === "out-of-scope",
  );
  // Even named by its exact id, which is the adversarial spelling.
  assert.throws(
    () =>
      resolveKnowledgeContext(b.ledger, { claims: [{ id: "RULE-42", revision: 1 }] }, T0, {
        instanceId: "i-1",
        phaseStatus: () => null,
        knowledge: A,
      }),
    (e: unknown) => e instanceof KnowledgeContextError && e.code === "out-of-scope",
  );
  // And a scoped run may not revise it either.
  assert.throws(
    () =>
      applyKnowledgeDeltas(
        b.ledger,
        [
          {
            id: "D-1",
            execution: { runId: "run-a", instanceId: "i-1", phaseId: "p" },
            attempt: 1,
            scope: A,
            delta: {
              schemaVersion: 1,
              revisions: [{ claimId: "RULE-42", expectedRevision: 1, statement: "500" }],
            },
          },
        ],
        { now: T1, mint: (p) => `${p}-x` },
      ),
    (e: unknown) => e instanceof KnowledgeDeltaError && e.code === "scope",
  );
});

// ── 10. Unscoped pipelines keep their old behaviour exactly ─────────────────

test("an unscoped pipeline resolves, revises and analyses exactly as before", () => {
  const b = new Build()
    .claim(undefined, "RULE-42")
    .claim(undefined, "CONCLUSION-1", "conclusion", "enforced");
  b.evidence(v1("RULE-42"));
  b.justify(v1("CONCLUSION-1"), [v1("RULE-42")]);
  b.consume("run-legacy", v1("RULE-42"));
  b.artifact("run-legacy", "src/Legacy.cs");
  b.revise("RULE-42", "at most 500");

  const resolved = resolveKnowledgeContext(
    b.ledger,
    { claims: [{ id: "RULE-42", revision: 1 }] },
    T0,
    { instanceId: "i-1", phaseStatus: () => null },
  );
  assert.deepEqual(resolved.supplied, [v1("RULE-42")]);
  assert.equal("scope" in resolved.context, false);
  assert.equal("scope" in resolved.context.claims[0], false);

  const impact = analyzeImpact(b.ledger, v1("RULE-42"));
  assert.deepEqual(
    impact.semantic.affectedClaims.map((c) => c.claim.id),
    ["CONCLUSION-1"],
  );
  assert.deepEqual(
    impact.executions.map((e) => e.execution.runId),
    ["run-legacy"],
  );

  // And an unscoped run still writes into the unscoped ledger unchanged.
  const applied = applyKnowledgeDeltas(
    b.ledger,
    [
      {
        id: "D-1",
        execution: { runId: "run-legacy-2", instanceId: "i-1", phaseId: "p" },
        attempt: 1,
        delta: {
          schemaVersion: 1,
          claims: [{ localId: "r", kind: "business-rule", statement: "new" }],
          consumed: [v1("RULE-42")],
        },
      },
    ],
    { now: T1, mint: (p) => `${p}-mint` },
  );
  assert.equal(applied.results[0].createdClaims[0].claim.id, "RULE-mint");
  assert.equal("scope" in applied.ledger.claims.at(-1)!, false);
});

// ── Adversarial ─────────────────────────────────────────────────────────────

test("a delta creates its claims in its own scope, with ids nothing else can collide with", () => {
  const { ledger } = twoProjects();
  const make = (scope: KnowledgeScope, runId: string, id: string) =>
    applyKnowledgeDeltas(
      ledger,
      [
        {
          id,
          execution: { runId, instanceId: "i", phaseId: "p" },
          attempt: 1,
          scope,
          delta: {
            schemaVersion: 1,
            claims: [{ localId: "r", kind: "business-rule", statement: "same sentence" }],
          },
        },
      ],
      { now: T1, mint: () => "RULE-collide" },
    );
  const fromA = make(A, "run-a", "D-A");
  const fromB = make(B, "run-b", "D-B");
  const idA = fromA.results[0].createdClaims[0].claim.id;
  const idB = fromB.results[0].createdClaims[0].claim.id;
  // The same minted name in two scopes is two canonical ids, so a colliding
  // minter cannot merge two projects' claims.
  assert.notEqual(idA, idB);
  assert.deepEqual(fromA.ledger.claims.find((c) => c.id === idA)?.scope, A);
  assert.deepEqual(fromB.ledger.claims.find((c) => c.id === idB)?.scope, B);
});

test("a revision inherits its claim's scope and cannot be moved to another project", () => {
  const b = twoProjects();
  b.revise(rule(A), "at most 500");
  const v2 = b.ledger.claims.find((c) => c.id === rule(A) && c.revision === 2)!;
  assert.deepEqual(v2.scope, A);
  // There is no input by which a revision could name a different scope: the
  // kernel copies it from the revision being superseded.
  const forced = reviseClaim(
    b.ledger,
    { id: rule(A), statement: "x", ...({ scope: B } as object) },
    T1,
  );
  assert.deepEqual(forced.claim.scope, A);
});

test("a scoped pipeline gets out-of-scope, not unknown-claim, when the name exists elsewhere", () => {
  const { ledger } = twoProjects();
  // The difference matters: `unknown-claim` would invite an author to create a
  // duplicate; `out-of-scope` says the knowledge exists and is not theirs.
  const thrown = (() => {
    try {
      resolveKnowledgeContext(ledger, { claims: [{ id: rule(B), revision: 1 }] }, T0, {
        instanceId: "i",
        phaseStatus: () => null,
        knowledge: A,
      });
    } catch (e) {
      return e as KnowledgeContextError;
    }
    return null;
  })();
  assert.equal(thrown?.code, "out-of-scope");
  assert.match(thrown!.message, /alsoRead/);
});

test("a genuinely unknown id is still unknown-claim, in a scoped pipeline too", () => {
  const { ledger } = twoProjects();
  assert.throws(
    () =>
      resolveKnowledgeContext(ledger, { claims: [{ id: "RULE-999", revision: "active" }] }, T0, {
        instanceId: "i",
        phaseStatus: () => null,
        knowledge: A,
      }),
    (e: unknown) => e instanceof KnowledgeContextError && e.code === "unknown-claim",
  );
});

test("an unscoped pipeline cannot reach scoped knowledge by naming its canonical id", () => {
  const { ledger } = twoProjects();
  assert.throws(
    () =>
      resolveKnowledgeContext(ledger, { claims: [{ id: rule(A), revision: 1 }] }, T0, {
        instanceId: "i",
        phaseStatus: () => null,
      }),
    (e: unknown) => e instanceof KnowledgeContextError && e.code === "out-of-scope",
  );
});

test("two scopes sharing a repository, or a project, are still two scopes", () => {
  const sameRepoOtherProject: KnowledgeScope = { ...A, projectId: "other" };
  const sameProjectOtherRepo: KnowledgeScope = { ...A, repositoryId: "git:github.com/motorit/api" };
  const b = new Build()
    .claim(A, "RULE-42")
    .claim(sameRepoOtherProject, "RULE-42")
    .claim(sameProjectOtherRepo, "RULE-42");
  assert.equal(new Set(b.ledger.claims.map((c) => c.id)).size, 3);
  for (const scope of [A, sameRepoOtherProject, sameProjectOtherRepo]) {
    assert.deepEqual(
      sliceOfScope(b.ledger, scope).claims.map((c) => c.id),
      [qualifyClaimId("RULE-42", scope)],
    );
  }
});

test("an accepted change's own project is what a downstream phase is checked against", () => {
  const b = twoProjects();
  const accepted = recordChangeProposal(
    b.ledger,
    {
      id: "CP-A",
      request: { id: "CR-1", summary: "raise the kobra limit" },
      execution: { runId: "run-a9", instanceId: "i-1", phaseId: "intent" },
      readiness: "ready",
      semanticChanges: [],
      revised: [],
      created: [],
      decisions: [],
      constraints: [],
      preserved: [v1(rule(A))],
      acceptanceCriteria: [],
      unresolved: [],
      classification: [],
    },
    T1,
  );
  // This is the predicate the engine's `changeContext` guard is made of: a
  // phase scoped to B, reading a proposal that belongs to A, is not authorized.
  const owner = scopeOfAcceptedChange(accepted.ledger, accepted.proposal);
  assert.deepEqual(owner, A);
  assert.equal(
    readableScopes({ scope: B }).some((sc) => sameScope(owner, sc)),
    false,
  );
  assert.equal(
    readableScopes({ scope: A }).some((sc) => sameScope(owner, sc)),
    true,
  );
  // And declaring A explicitly is how a B-scoped phase would be allowed to.
  assert.equal(
    readableScopes({ scope: B, alsoRead: [A] }).some((sc) => sameScope(owner, sc)),
    true,
  );
});

test("a change that touched nothing the ledger still holds owns no project", () => {
  const b = twoProjects();
  const accepted = recordChangeProposal(
    b.ledger,
    {
      id: "CP-empty",
      request: { id: "CR-2", summary: "nothing semantic" },
      execution: { runId: "run-a9", instanceId: "i-1", phaseId: "intent" },
      readiness: "needs-input",
      semanticChanges: [],
      revised: [],
      created: [],
      decisions: [],
      constraints: [],
      preserved: [],
      acceptanceCriteria: [],
      unresolved: [],
      classification: [],
    },
    T1,
  );
  // Undefined, not "whichever project asked": a scoped phase is then refused,
  // which is the fail-closed answer.
  assert.equal(scopeOfAcceptedChange(accepted.ledger, accepted.proposal), undefined);
  assert.equal(
    readableScopes({ scope: A }).some((sc) =>
      sameScope(scopeOfAcceptedChange(accepted.ledger, accepted.proposal), sc),
    ),
    false,
  );
});

test("a fromPhases selector never carries a differently-scoped phase's output", () => {
  const b = twoProjects();
  // One instance, two phases, two projects — the shape a phase-level
  // `knowledgeScope` override makes possible. Both phases committed a claim,
  // recorded in the ledger's applied-delta provenance exactly as a real commit
  // would record it.
  b.ledger = {
    ...b.ledger,
    deltas: [
      {
        id: "D-A",
        execution: { runId: "run-a", instanceId: "i-1", phaseId: "discover" },
        attempt: 1,
        appliedAt: T0,
        claims: [v1(rule(A))],
        evidence: [],
        justifications: [],
        consumptions: [],
        artifacts: [],
      },
      {
        id: "D-B",
        execution: { runId: "run-b", instanceId: "i-1", phaseId: "discover" },
        attempt: 1,
        appliedAt: T0,
        claims: [v1(rule(B))],
        evidence: [],
        justifications: [],
        consumptions: [],
        artifacts: [],
      },
    ],
  };
  const resolved = resolveKnowledgeContext(
    b.ledger,
    { fromPhases: [{ phaseId: "discover" }] },
    T0,
    { instanceId: "i-1", phaseStatus: () => "succeeded", knowledge: A },
  );
  // Instance-bounded is not enough on its own; scope decides.
  assert.deepEqual(
    resolved.supplied.map((r) => r.id),
    [rule(A)],
  );
  // And an unscoped phase reading the same provenance gets neither.
  assert.deepEqual(
    resolveKnowledgeContext(b.ledger, { fromPhases: [{ phaseId: "discover" }] }, T0, {
      instanceId: "i-1",
      phaseStatus: () => "succeeded",
    }).supplied,
    [],
  );
});
