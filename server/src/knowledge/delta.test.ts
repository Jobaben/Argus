import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaimRef, KnowledgeDelta } from "@argus/contracts";
import {
  addClaim,
  addEvidence,
  addJustification,
  emptyLedger,
  evaluateSupport,
  executionProvenance,
  formatClaimRef,
  getClaim,
  lifecycleOf,
  reviseClaim,
  type KnowledgeLedger,
} from "./kernel.js";
import {
  KnowledgeDeltaError,
  applyKnowledgeDeltas,
  deltaOfClaim,
  isEmptyDelta,
  parseKnowledgeDelta,
  validateKnowledgeDelta,
  type DeltaProposal,
} from "./delta.js";
import { analyzeImpact } from "./impact.js";

/**
 * The KnowledgeDelta protocol's pure half, on hand-built ledgers: what a
 * proposal may say, how local ids become canonical identities, how a stale
 * precondition or a cycle refuses the *whole* delta, and how two proposals
 * in one commit are refused when they contend. No filesystem, no engine.
 */

const T0 = "2026-09-19T10:00:00.000Z";
const T1 = "2026-09-19T10:05:00.000Z";
const v = (id: string, revision: number): ClaimRef => ({ id, revision });

/** A deterministic minter: `RULE-1`, `EV-2`, … in call order. */
function minter() {
  let n = 0;
  return (prefix: string) => `${prefix}-${++n}`;
}

const RUN = { runId: "run-A", instanceId: "inst-1", phaseId: "plan" };

function proposal(delta: unknown, over: Partial<DeltaProposal> = {}): DeltaProposal {
  return {
    id: "KD-1",
    delta: validateKnowledgeDelta(delta),
    execution: RUN,
    attempt: 0,
    ...over,
  };
}

/** RULE-17:v1 grounded on document evidence. */
function withRule(): KnowledgeLedger {
  let l = emptyLedger();
  l = addClaim(
    l,
    { id: "RULE-17", kind: "business-rule", statement: "Comment max is 180" },
    T0,
  ).ledger;
  l = addEvidence(
    l,
    {
      id: "EV-rule",
      claim: v("RULE-17", 1),
      direction: "supports",
      source: { type: "document", uri: "spec://kobra" },
    },
    T0,
  ).ledger;
  return l;
}

function refuses(fn: () => unknown, code: string, pattern: RegExp) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof KnowledgeDeltaError, `expected KnowledgeDeltaError, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    assert.match(e.message, pattern);
    return;
  }
  assert.fail("expected a refusal");
}

// ── Validation ──────────────────────────────────────────────────────────────

test("a delta must carry schemaVersion 1", () => {
  refuses(() => validateKnowledgeDelta({}), "schema", /schemaVersion must be 1/);
  refuses(() => validateKnowledgeDelta({ schemaVersion: 2 }), "schema", /schemaVersion/);
  refuses(() => validateKnowledgeDelta([]), "schema", /must be an object/);
});

test("invalid JSON is its own refusal, distinct from a bad shape", () => {
  refuses(() => parseKnowledgeDelta("{not json"), "invalid-json", /not valid JSON/);
  assert.deepEqual(parseKnowledgeDelta('{"schemaVersion":1}'), { schemaVersion: 1 });
});

test("an empty delta is valid and equivalent to no delta", () => {
  assert.equal(isEmptyDelta(validateKnowledgeDelta({ schemaVersion: 1 })), true);
  assert.equal(
    isEmptyDelta(validateKnowledgeDelta({ schemaVersion: 1, claims: [], consumed: [] })),
    true,
  );
  assert.equal(
    isEmptyDelta(validateKnowledgeDelta({ schemaVersion: 1, consumed: ["RULE-17:v1"] })),
    false,
  );
});

test("agents cannot assert canonical ids, revision numbers or provenance", () => {
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        claims: [{ localId: "c", id: "RULE-99", kind: "fact", statement: "s" }],
      }),
    "schema",
    /claims\[0\]\.id is not allowed/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        claims: [{ localId: "c", kind: "fact", statement: "s", producedBy: { runId: "x" } }],
      }),
    "schema",
    /producedBy is not allowed/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "s", kind: "fact" }],
      }),
    "schema",
    /kind is not allowed.*cannot change/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        revisions: [{ claimId: "RULE-17", expectedRevision: 1, revision: 2, statement: "s" }],
      }),
    "schema",
    /revision is not allowed/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        justifications: [{ conclusion: "A:v1", premises: ["B:v1"], producedBy: { runId: "x" } }],
      }),
    "schema",
    /producedBy is not allowed/,
  );
});

test("a revision proposal needs a positive integer expectedRevision", () => {
  for (const expectedRevision of [undefined, 0, -1, 1.5, "2"]) {
    refuses(
      () =>
        validateKnowledgeDelta({
          schemaVersion: 1,
          revisions: [{ claimId: "RULE-17", expectedRevision, statement: "s" }],
        }),
      "schema",
      /expectedRevision must be a positive integer/,
    );
  }
});

test("references to existing knowledge must be exact revisions, never bare ids", () => {
  for (const bare of ["RULE-17", { id: "RULE-17" }]) {
    refuses(
      () =>
        validateKnowledgeDelta({
          schemaVersion: 1,
          justifications: [{ conclusion: { local: "x" }, premises: [bare] }],
          claims: [{ localId: "x", kind: "conclusion", statement: "s" }],
        }),
      "schema",
      /exact revision/,
    );
    refuses(
      () => validateKnowledgeDelta({ schemaVersion: 1, consumed: [bare] }),
      "schema",
      /exact revision/,
    );
    refuses(
      () =>
        validateKnowledgeDelta({
          schemaVersion: 1,
          evidence: [{ claim: bare, source: { type: "human", who: "me" } }],
        }),
      "schema",
      /exact revision/,
    );
  }
  // The string form of an exact ref is accepted and normalized to the object form.
  const d = validateKnowledgeDelta({ schemaVersion: 1, consumed: ["RULE-17:v2"] });
  assert.deepEqual(d.consumed, [{ id: "RULE-17", revision: 2 }]);
});

test("a consumed list may not name a local claim", () => {
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        claims: [{ localId: "x", kind: "fact", statement: "s" }],
        consumed: [{ local: "x" }],
      }),
    "schema",
    /must name an existing exact revision/,
  );
});

test("local ids are declared once across claims and revisions, and every local reference resolves", () => {
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        claims: [
          { localId: "same", kind: "fact", statement: "a" },
          { localId: "same", kind: "fact", statement: "b" },
        ],
      }),
    "local-reference",
    /"same" is declared twice/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        claims: [{ localId: "same", kind: "fact", statement: "a" }],
        revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "b", localId: "same" }],
      }),
    "local-reference",
    /"same" is declared twice/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        justifications: [{ conclusion: { local: "ghost" }, premises: ["RULE-17:v1"] }],
      }),
    "local-reference",
    /justifications\[0\]\.conclusion names undeclared local id "ghost"/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        evidence: [{ claim: { local: "ghost" }, source: { type: "human", who: "me" } }],
      }),
    "local-reference",
    /evidence\[0\]\.claim names undeclared local id "ghost"/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        claims: [{ localId: "c", kind: "conclusion", statement: "s" }],
        justifications: [{ conclusion: { local: "c" }, premises: [{ local: "nope" }] }],
      }),
    "local-reference",
    /premises\[0\] names undeclared local id "nope"/,
  );
});

test("internal contradictions are refused: one claim revised twice, a revision or artifact listed twice", () => {
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        revisions: [
          { claimId: "RULE-17", expectedRevision: 1, statement: "a" },
          { claimId: "RULE-17", expectedRevision: 1, statement: "b" },
        ],
      }),
    "schema",
    /revised twice in one delta/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({ schemaVersion: 1, consumed: ["A:v1", { id: "A", revision: 1 }] }),
    "schema",
    /A:v1 is listed twice/,
  );
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        artifacts: [
          { location: "repository", path: "src/a.cs" },
          { location: "repository", path: "src/a.cs" },
        ],
      }),
    "schema",
    /listed twice/,
  );
});

test("artifact paths reuse the containment rule: no escape from the run's roots", () => {
  for (const path of ["../../../etc/passwd", "/abs/path", "a/../b", "C:\\x", ""]) {
    refuses(
      () =>
        validateKnowledgeDelta({
          schemaVersion: 1,
          artifacts: [{ location: "repository", path }],
        }),
      "schema",
      /path/,
    );
  }
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        artifacts: [{ location: "artifact-dir", path: "report.md", gitHead: "abcdef1" }],
      }),
    "schema",
    /gitHead only applies to a repository path/,
  );
});

test("sections are bounded", () => {
  refuses(
    () =>
      validateKnowledgeDelta({
        schemaVersion: 1,
        consumed: Array.from({ length: 65 }, (_, i) => `C${i}:v1`),
      }),
    "schema",
    /consumed exceeds 64 entries/,
  );
});

// ── Application ─────────────────────────────────────────────────────────────

test("new claim + justification in one delta: Argus mints the id and resolves the local reference", () => {
  const snapshot = withRule();
  const { ledger, results } = applyKnowledgeDeltas(
    snapshot,
    [
      proposal({
        schemaVersion: 1,
        claims: [
          {
            localId: "new-comment-conclusion",
            kind: "conclusion",
            statement: "Customer comments must be limited to 180 characters",
          },
        ],
        justifications: [
          {
            conclusion: { local: "new-comment-conclusion" },
            premises: [{ id: "RULE-17", revision: 1 }],
          },
        ],
        metadata: { summary: "derived the validation rule" },
      }),
    ],
    { now: T1, mint: minter() },
  );
  const [r] = results;
  assert.equal(r.status, "applied");
  assert.equal(r.deltaId, "KD-1");
  assert.deepEqual(r.createdClaims, [
    { localId: "new-comment-conclusion", claim: { id: "CONCLUSION-1", revision: 1 } },
  ]);
  assert.deepEqual(r.justificationIds, ["J-2"]);

  const c = getClaim(ledger, v("CONCLUSION-1", 1));
  assert.ok(c);
  assert.equal(c.kind, "conclusion");
  // Provenance is Argus's: bound from the run that wrote the file.
  assert.deepEqual(c.producedBy, RUN);
  // No local id anywhere on the canonical record.
  assert.equal("localId" in c, false);
  const j = ledger.justifications.find((x) => x.id === "J-2");
  assert.deepEqual(j?.conclusion, v("CONCLUSION-1", 1));
  assert.deepEqual(j?.premises, [v("RULE-17", 1)]);
  assert.deepEqual(j?.producedBy, RUN);
  assert.equal(evaluateSupport(ledger, v("CONCLUSION-1", 1)), "supported");

  // The ledger's own record of the delta.
  assert.equal(ledger.deltas.length, 1);
  assert.deepEqual(ledger.deltas[0], {
    id: "KD-1",
    execution: RUN,
    attempt: 0,
    appliedAt: T1,
    claims: [v("CONCLUSION-1", 1)],
    evidence: [],
    justifications: ["J-2"],
    consumptions: [],
    artifacts: [],
  });
  assert.equal(deltaOfClaim(ledger, v("CONCLUSION-1", 1))?.id, "KD-1");
  // The snapshot is untouched.
  assert.equal(snapshot.claims.length, 1);
  assert.equal(snapshot.deltas.length, 0);
});

test("a chain of local claims resolves after canonical ids are assigned", () => {
  const { ledger, results } = applyKnowledgeDeltas(
    withRule(),
    [
      proposal({
        schemaVersion: 1,
        claims: [
          { localId: "b", kind: "conclusion", statement: "B" },
          { localId: "c", kind: "decision", statement: "C" },
        ],
        justifications: [
          { conclusion: { local: "b" }, premises: ["RULE-17:v1"] },
          { conclusion: { local: "c" }, premises: [{ local: "b" }] },
        ],
      }),
    ],
    { now: T1, mint: minter() },
  );
  const b = results[0].createdClaims.find((c) => c.localId === "b")!.claim;
  const c = results[0].createdClaims.find((c) => c.localId === "c")!.claim;
  assert.equal(b.id, "CONCLUSION-1");
  assert.equal(c.id, "DECISION-2");
  const jc = ledger.justifications.find((j) => formatClaimRef(j.conclusion) === "DECISION-2:v1");
  assert.deepEqual(jc?.premises, [b]);
  assert.equal(evaluateSupport(ledger, c), "supported");
});

test("a revision with a holding precondition creates the next revision; the same delta may build on it", () => {
  const { ledger, results } = applyKnowledgeDeltas(
    withRule(),
    [
      proposal({
        schemaVersion: 1,
        revisions: [
          {
            claimId: "RULE-17",
            expectedRevision: 1,
            statement: "Comment max is 500",
            revisionNote: "Kobra 4.2 raised the limit",
            localId: "rule-v2",
          },
        ],
        evidence: [
          {
            claim: { local: "rule-v2" },
            source: { type: "document", uri: "spec://kobra/4.2" },
          },
        ],
      }),
    ],
    { now: T1, mint: minter() },
  );
  assert.deepEqual(results[0].createdRevisions, [
    { localId: "rule-v2", claim: v("RULE-17", 2), supersedes: v("RULE-17", 1) },
  ]);
  assert.equal(lifecycleOf(ledger, v("RULE-17", 1)), "superseded");
  assert.equal(getClaim(ledger, v("RULE-17", 2))?.kind, "business-rule");
  assert.equal(getClaim(ledger, v("RULE-17", 2))?.revisionNote, "Kobra 4.2 raised the limit");
  assert.equal(ledger.evidence.find((e) => e.id === "EV-1")?.claim.revision, 2);
  assert.equal(evaluateSupport(ledger, v("RULE-17", 2)), "supported");
});

test("a stale precondition refuses the entire delta: nothing from it enters the ledger", () => {
  // The agent started from v1; another change made v2 before commit.
  const moved = reviseClaim(withRule(), { id: "RULE-17", statement: "max 300" }, T0).ledger;
  const before = JSON.stringify(moved);
  refuses(
    () =>
      applyKnowledgeDeltas(
        moved,
        [
          proposal({
            schemaVersion: 1,
            claims: [{ localId: "c", kind: "conclusion", statement: "valid claim" }],
            revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "max 500" }],
          }),
        ],
        { now: T1, mint: minter() },
      ),
    "stale-revision",
    /expects RULE-17 at v1, but the active revision is v2/,
  );
  assert.equal(JSON.stringify(moved), before);
  assert.equal(moved.claims.length, 2);
  assert.equal(moved.deltas.length, 0);
});

test("a revision of an unknown claim is refused as an unknown reference", () => {
  refuses(
    () =>
      applyKnowledgeDeltas(
        withRule(),
        [
          proposal({
            schemaVersion: 1,
            revisions: [{ claimId: "RULE-NOPE", expectedRevision: 1, statement: "s" }],
          }),
        ],
        { now: T1, mint: minter() },
      ),
    "unknown-reference",
    /unknown claim "RULE-NOPE"/,
  );
});

test("unknown exact references anywhere refuse the delta", () => {
  const snapshot = withRule();
  const cases: [unknown, RegExp][] = [
    [
      { schemaVersion: 1, consumed: ["RULE-17:v9"] },
      /consumed\[0\] names unknown claim revision RULE-17:v9/,
    ],
    [
      {
        schemaVersion: 1,
        evidence: [{ claim: "GHOST:v1", source: { type: "human", who: "me" } }],
      },
      /evidence\[0\]\.claim names unknown/,
    ],
    [
      {
        schemaVersion: 1,
        claims: [{ localId: "c", kind: "conclusion", statement: "s" }],
        justifications: [{ conclusion: { local: "c" }, premises: ["GHOST:v1"] }],
      },
      /premises\[0\] names unknown/,
    ],
  ];
  for (const [delta, pattern] of cases) {
    refuses(
      () => applyKnowledgeDeltas(snapshot, [proposal(delta)], { now: T1, mint: minter() }),
      "unknown-reference",
      pattern,
    );
  }
});

test("atomic failure: a valid claim and valid evidence do not survive an invalid justification", () => {
  // Existing: A → B (J-1). A delta that proposes B → A would close a cycle.
  let l = withRule();
  l = addClaim(l, { id: "A", kind: "fact", statement: "a" }, T0).ledger;
  l = addClaim(l, { id: "B", kind: "conclusion", statement: "b" }, T0).ledger;
  l = addJustification(
    l,
    { id: "J-1", conclusion: v("B", 1), premises: [v("A", 1)], direction: "supports" },
    T0,
  ).ledger;
  const before = JSON.stringify(l);
  refuses(
    () =>
      applyKnowledgeDeltas(
        l,
        [
          proposal({
            schemaVersion: 1,
            claims: [{ localId: "c", kind: "conclusion", statement: "new claim" }],
            evidence: [{ claim: "RULE-17:v1", source: { type: "human", who: "me" } }],
            justifications: [{ conclusion: "A:v1", premises: ["B:v1"] }],
          }),
        ],
        { now: T1, mint: minter() },
      ),
    "ledger",
    /justifications\[0\].*would form a cycle/,
  );
  assert.equal(JSON.stringify(l), before);
  assert.equal(
    l.claims.some((c) => c.statement === "new claim"),
    false,
  );
  assert.equal(l.evidence.length, 1);
  assert.equal(l.justifications.length, 1);
});

test("a cycle formed entirely inside one delta is refused too", () => {
  refuses(
    () =>
      applyKnowledgeDeltas(
        withRule(),
        [
          proposal({
            schemaVersion: 1,
            claims: [
              { localId: "x", kind: "conclusion", statement: "x" },
              { localId: "y", kind: "conclusion", statement: "y" },
            ],
            justifications: [
              { conclusion: { local: "x" }, premises: [{ local: "y" }] },
              { conclusion: { local: "y" }, premises: [{ local: "x" }] },
            ],
          }),
        ],
        { now: T1, mint: minter() },
      ),
    "ledger",
    /would form a cycle/,
  );
});

test("two deltas in one commit revising the same revision are refused deterministically, whatever the order", () => {
  const snapshot = withRule();
  const a = proposal(
    {
      schemaVersion: 1,
      revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "from step A" }],
    },
    { id: "KD-A", execution: { runId: "run-A", instanceId: "inst-1", phaseId: "plan" } },
  );
  const b = proposal(
    {
      schemaVersion: 1,
      claims: [{ localId: "extra", kind: "fact", statement: "unrelated but lost with the rest" }],
      revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "from step B" }],
    },
    { id: "KD-B", execution: { runId: "run-B", instanceId: "inst-1", phaseId: "plan" } },
  );
  let first: string | undefined;
  for (const order of [
    [a, b],
    [b, a],
  ]) {
    try {
      applyKnowledgeDeltas(snapshot, order, { now: T1, mint: minter() });
      assert.fail("expected a conflict");
    } catch (e) {
      assert.ok(e instanceof KnowledgeDeltaError);
      assert.equal(e.code, "conflict");
      assert.match(e.message, /both revise RULE-17 from v1/);
      // Both orders name the same pair (in whichever order), never a winner.
      const named = [...e.message.matchAll(/KD-[AB]/g)]
        .map((m) => m[0])
        .sort()
        .join(",");
      first ??= named;
      assert.equal(named, first);
    }
  }
  assert.equal(snapshot.claims.length, 1);
});

test("two non-conflicting deltas in one commit apply together, each attributed to its own run", () => {
  const { ledger, results } = applyKnowledgeDeltas(
    withRule(),
    [
      proposal(
        { schemaVersion: 1, claims: [{ localId: "a", kind: "fact", statement: "from A" }] },
        { id: "KD-A", execution: { runId: "run-A", instanceId: "inst-1", phaseId: "plan" } },
      ),
      proposal(
        {
          schemaVersion: 1,
          claims: [{ localId: "b", kind: "fact", statement: "from B" }],
          consumed: ["RULE-17:v1"],
        },
        { id: "KD-B", execution: { runId: "run-B", instanceId: "inst-1", phaseId: "plan" } },
      ),
    ],
    { now: T1, mint: minter() },
  );
  assert.equal(results.length, 2);
  assert.equal(getClaim(ledger, results[0].createdClaims[0].claim)?.producedBy?.runId, "run-A");
  assert.equal(getClaim(ledger, results[1].createdClaims[0].claim)?.producedBy?.runId, "run-B");
  assert.deepEqual(
    ledger.deltas.map((d) => d.id),
    ["KD-A", "KD-B"],
  );
  assert.equal(ledger.consumptions[0].execution.runId, "run-B");
});

test("a delta may not depend on a sibling delta's creations: references resolve against the snapshot", () => {
  // Delta A proposes a claim; delta B cannot know A's canonical id, and a
  // guess at it must not resolve even if the minter would have produced it.
  refuses(
    () =>
      applyKnowledgeDeltas(
        withRule(),
        [
          proposal(
            { schemaVersion: 1, claims: [{ localId: "a", kind: "fact", statement: "a" }] },
            { id: "KD-A" },
          ),
          proposal({ schemaVersion: 1, consumed: ["FACT-1:v1"] }, { id: "KD-B" }),
        ],
        { now: T1, mint: minter() },
      ),
    "unknown-reference",
    /KD-B.*FACT-1:v1/,
  );
});

test("exact consumption: the recorded edge names the exact revision and a later revision does not move it", () => {
  let { ledger } = applyKnowledgeDeltas(
    withRule(),
    [proposal({ schemaVersion: 1, consumed: [{ id: "RULE-17", revision: 1 }] })],
    { now: T1, mint: minter() },
  );
  assert.deepEqual(ledger.consumptions[0].claim, v("RULE-17", 1));
  assert.deepEqual(ledger.consumptions[0].execution, RUN);
  ledger = reviseClaim(ledger, { id: "RULE-17", statement: "max 500" }, T1).ledger;
  assert.deepEqual(ledger.consumptions[0].claim, v("RULE-17", 1));
  const prov = executionProvenance(ledger, "run-A")!;
  assert.equal(prov.currency, "stale");
  assert.equal(prov.consumed[0].lifecycle, "superseded");
});

test("artifacts use the Phase 2 production record and carry the run's execution", () => {
  const { ledger, results } = applyKnowledgeDeltas(
    withRule(),
    [
      proposal({
        schemaVersion: 1,
        artifacts: [
          { location: "repository", path: "src/Validator.cs", gitHead: "9f3c2a1" },
          { location: "artifact-dir", path: "report.md" },
        ],
      }),
    ],
    { now: T1, mint: minter() },
  );
  assert.equal(ledger.artifacts.length, 2);
  assert.deepEqual(ledger.artifacts[0].execution, RUN);
  assert.deepEqual(ledger.artifacts[0].artifact, {
    location: "repository",
    path: "src/Validator.cs",
    gitHead: "9f3c2a1",
  });
  assert.equal(results[0].artifacts.length, 2);
  assert.deepEqual(
    ledger.deltas[0].artifacts,
    ledger.artifacts.map((a) => a.artifact),
  );
});

test("committing an already-applied delta again is a no-op with the same result", () => {
  const p = proposal({
    schemaVersion: 1,
    claims: [{ localId: "c", kind: "conclusion", statement: "c" }],
    revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "max 500", localId: "r2" }],
    consumed: ["RULE-17:v1"],
    artifacts: [{ location: "repository", path: "src/a.cs" }],
  });
  const first = applyKnowledgeDeltas(withRule(), [p], { now: T1, mint: minter() });
  const again = applyKnowledgeDeltas(first.ledger, [p], { now: "later", mint: minter() });
  assert.equal(again.ledger, first.ledger);
  assert.deepEqual(again.results, first.results);
});

test("execution provenance answers 'which canonical records came from this run?'", () => {
  const { ledger } = applyKnowledgeDeltas(
    withRule(),
    [
      proposal({
        schemaVersion: 1,
        claims: [{ localId: "d", kind: "decision", statement: "d" }],
        justifications: [{ conclusion: { local: "d" }, premises: ["RULE-17:v1"] }],
        consumed: ["RULE-17:v1"],
        artifacts: [{ location: "repository", path: "src/a.cs" }],
      }),
    ],
    { now: T1, mint: minter() },
  );
  const prov = executionProvenance(ledger, "run-A")!;
  assert.deepEqual(prov.execution, RUN);
  assert.deepEqual(
    prov.produced.claims.map((c) => c.id),
    ["DECISION-1"],
  );
  assert.deepEqual(
    prov.produced.justifications.map((j) => j.id),
    ["J-2"],
  );
  assert.deepEqual(prov.produced.artifacts, [{ location: "repository", path: "src/a.cs" }]);
  assert.deepEqual(
    prov.consumed.map((c) => formatClaimRef(c.claim)),
    ["RULE-17:v1"],
  );
  assert.equal(ledger.deltas[0].execution.runId, "run-A");
});

test("impact integration: rule → conclusion → decision → consuming run → artifact, all through deltas", () => {
  // Run A (plan) derives the chain from RULE-17:v1.
  let ledger = withRule();
  const mint = minter();
  ({ ledger } = applyKnowledgeDeltas(
    ledger,
    [
      proposal(
        {
          schemaVersion: 1,
          claims: [
            { localId: "c", kind: "conclusion", statement: "Validate at 180" },
            { localId: "d", kind: "decision", statement: "Ship the 180 validator" },
          ],
          justifications: [
            { conclusion: { local: "c" }, premises: ["RULE-17:v1"] },
            { conclusion: { local: "d" }, premises: [{ local: "c" }] },
          ],
        },
        { id: "KD-A", execution: { runId: "run-A", instanceId: "inst-1", phaseId: "plan" } },
      ),
    ],
    { now: T1, mint },
  ));
  // Run B (implement) consumes the decision and produces the validator.
  ({ ledger } = applyKnowledgeDeltas(
    ledger,
    [
      proposal(
        {
          schemaVersion: 1,
          consumed: ["DECISION-2:v1"],
          artifacts: [{ location: "repository", path: "src/CustomerCommentValidator.cs" }],
        },
        { id: "KD-B", execution: { runId: "run-B", instanceId: "inst-1", phaseId: "implement" } },
      ),
    ],
    { now: T1, mint },
  ));
  // Nothing is impacted while the rule is current.
  assert.deepEqual(analyzeImpact(ledger, v("RULE-17", 1)).root.conditions, []);

  // A later run revises the rule.
  ({ ledger } = applyKnowledgeDeltas(
    ledger,
    [
      proposal(
        {
          schemaVersion: 1,
          revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "Comment max is 500" }],
        },
        { id: "KD-C", execution: { runId: "run-C", instanceId: "inst-2", phaseId: "rules" } },
      ),
    ],
    { now: T1, mint },
  ));

  const impact = analyzeImpact(ledger, v("RULE-17", 1));
  assert.deepEqual(impact.root.conditions, ["superseded"]);
  assert.deepEqual(
    impact.semantic.affectedClaims.map((c) => [formatClaimRef(c.claim), c.reasons]),
    [
      ["CONCLUSION-1:v1", ["premise-superseded"]],
      ["DECISION-2:v1", ["premise-unsupported"]],
    ],
  );
  assert.deepEqual(
    impact.executions.map((e) => e.execution.runId),
    ["run-B"],
  );
  assert.deepEqual(
    impact.artifacts.map((a) => a.artifact.path),
    ["src/CustomerCommentValidator.cs"],
  );
  assert.equal(
    impact.paths.some(
      (p) =>
        p.target.kind === "artifact" &&
        p.hops.map((h) => h.via).join(">") === "premise-of>premise-of>consumed-by>produced",
    ),
    true,
  );
  // run-A produced the chain and is provenance, not an impacted execution.
  assert.equal(
    impact.executions.some((e) => e.execution.runId === "run-A"),
    false,
  );
  assert.equal(executionProvenance(ledger, "run-B")?.currency, "stale");
});

/** Type-level check that the validated shape is the wire type. */
const _typed: KnowledgeDelta = validateKnowledgeDelta({ schemaVersion: 1 });
void _typed;
