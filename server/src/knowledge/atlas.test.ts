import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaimKind, KnowledgeScope } from "@argus/contracts";
import { buildAtlas } from "./atlas.js";
import {
  addClaim,
  addEvidence,
  addJustification,
  emptyLedger,
  recordConsumption,
  reviseClaim,
  type KnowledgeLedger,
} from "./kernel.js";
import { qualifyClaimId } from "./scope.js";

const T0 = "2026-10-08T10:00:00.000Z";
const SCOPE: KnowledgeScope = { projectId: "proj-a", repositoryId: "git:example.com/a/repo" };

function claim(
  ledger: KnowledgeLedger,
  local: string,
  kind: ClaimKind,
  scope?: KnowledgeScope,
): { ledger: KnowledgeLedger; id: string } {
  const id = qualifyClaimId(local, scope);
  return {
    ledger: addClaim(ledger, { id, kind, statement: `${local} holds`, scope }, T0).ledger,
    id,
  };
}

function seeded() {
  let ledger = emptyLedger();
  let r = claim(ledger, "RULE-1", "business-rule", SCOPE);
  ledger = r.ledger;
  const rule = r.id;
  r = claim(ledger, "FACT-1", "fact", SCOPE);
  ledger = r.ledger;
  const fact = r.id;
  r = claim(ledger, "FACT-9", "fact");
  ledger = r.ledger;
  const unscoped = r.id;
  ledger = addEvidence(
    ledger,
    {
      id: "EV-1",
      claim: { id: rule, revision: 1 },
      direction: "supports",
      source: { type: "source-code", path: "src/Rule.cs", startLine: 3, endLine: 9 },
    },
    T0,
  ).ledger;
  ledger = addEvidence(
    ledger,
    {
      id: "EV-2",
      claim: { id: fact, revision: 1 },
      direction: "supports",
      source: { type: "human", who: "owner" },
    },
    T0,
  ).ledger;
  return { ledger, rule, fact, unscoped };
}

test("the whole ledger includes unscoped claims; a scoped atlas never does", () => {
  const { ledger, unscoped } = seeded();
  const whole = buildAtlas(ledger);
  assert.equal(whole.scope, null);
  assert.ok(whole.claims.some((c) => c.id === unscoped));

  const scoped = buildAtlas(ledger, SCOPE);
  assert.deepEqual(scoped.scope, SCOPE);
  assert.equal(scoped.claims.length, 2);
  assert.ok(scoped.claims.every((c) => c.id !== unscoped));
});

test("scopes are listed largest first with unscoped as its own null entry", () => {
  const { ledger } = seeded();
  assert.deepEqual(buildAtlas(ledger, SCOPE).scopes, [
    { scope: SCOPE, claims: 2 },
    { scope: null, claims: 1 },
  ]);
});

test("evidence sits on the exact revision it names", () => {
  const seed = seeded();
  const rule = seed.rule;
  const ledger = reviseClaim(seed.ledger, { id: rule, statement: "RULE-1 changed" }, T0).ledger;
  const revisions = buildAtlas(ledger).claims.filter((c) => c.id === rule);
  const v1 = revisions.find((c) => c.revision === 1)!;
  const v2 = revisions.find((c) => c.revision === 2)!;
  assert.deepEqual(
    v1.evidence.map((e) => e.id),
    ["EV-1"],
  );
  assert.equal(v1.lifecycle, "superseded");
  assert.deepEqual(v2.evidence, []);
  assert.equal(v2.support, "unsupported");
});

test("conformance is unverified for a rule and null for every other kind", () => {
  const { ledger, rule, fact } = seeded();
  const claims = buildAtlas(ledger).claims;
  assert.equal(claims.find((c) => c.id === rule)!.conformance, "unverified");
  assert.equal(claims.find((c) => c.id === fact)!.conformance, null);
});

test("a consumed revision that stops being current is flagged stale", () => {
  const { rule, fact, ...seed } = seeded();
  let ledger = seed.ledger;
  const ruleV1 = { id: rule, revision: 1 };
  ledger = recordConsumption(ledger, { execution: { runId: "run-1" }, claim: ruleV1 }, T0).ledger;
  ledger = recordConsumption(
    ledger,
    { execution: { runId: "run-2" }, claim: { id: fact, revision: 1 } },
    T0,
  ).ledger;

  let byId = new Map(buildAtlas(ledger).claims.map((c) => [`${c.id}:${c.revision}`, c]));
  assert.equal(byId.get(`${rule}:1`)!.consumers, 1);
  assert.equal(byId.get(`${rule}:1`)!.stale, false);

  ledger = reviseClaim(ledger, { id: rule, statement: "RULE-1 changed" }, T0).ledger;
  byId = new Map(buildAtlas(ledger).claims.map((c) => [`${c.id}:${c.revision}`, c]));
  assert.equal(byId.get(`${rule}:1`)!.stale, true);
  assert.equal(byId.get(`${fact}:1`)!.stale, false);
});

test("only justifications concluding a claim in view are returned", () => {
  const { ledger: seededLedger, unscoped } = seeded();
  const r = claim(seededLedger, "CONCLUSION-1", "conclusion");
  const ledger = addJustification(
    r.ledger,
    {
      id: "J-1",
      conclusion: { id: r.id, revision: 1 },
      premises: [{ id: unscoped, revision: 1 }],
      direction: "supports",
    },
    T0,
  ).ledger;
  assert.deepEqual(
    buildAtlas(ledger).justifications.map((j) => j.id),
    ["J-1"],
  );
  assert.deepEqual(buildAtlas(ledger, SCOPE).justifications, []);
});
