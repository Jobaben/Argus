import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Claim } from "@argus/contracts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-knowledge-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  // Import after env is set so claudeHome() resolves to the temp dir.
  return import(`./store.js?${Math.random()}`);
}
async function kernel() {
  return import("./kernel.js");
}

const NOW = new Date("2026-09-19T10:00:00.000Z");
const LATER = new Date("2026-09-19T11:00:00.000Z");
const file = () => path.join(home, "argus", "knowledge.json");

test("persist a graph, reload it: identities, revisions and edges are unchanged", async () => {
  const s = await fresh();
  const k = await kernel();

  const fact = await s.createClaim({ id: "FACT-12", kind: "fact", statement: "f" }, NOW);
  const rule = await s.createClaim(
    {
      id: "RULE-7",
      kind: "business-rule",
      statement: "Kobra comment maximum is 180",
      structuredValue: { when: ["field = comment"], then: ["max = 180"] },
    },
    NOW,
  );
  const conclusion = await s.createClaim(
    { kind: "conclusion", statement: "c", producedBy: { instanceId: "inst-1", phaseId: "plan" } },
    NOW,
  );
  assert.equal(fact.revision, 1);
  assert.equal(rule.revision, 1);
  assert.match(conclusion.id, /^CONCLUSION-[0-9a-f]{8}$/);

  const ev = await s.createEvidence(
    { claim: { id: "FACT-12" }, direction: "supports", source: { type: "run", runId: "run-1" } },
    NOW,
  );
  await s.createEvidence(
    {
      claim: { id: "RULE-7" },
      direction: "supports",
      source: { type: "document", uri: "spec://kobra" },
    },
    NOW,
  );
  const j = await s.createJustification(
    {
      conclusion: { id: conclusion.id },
      premises: [{ id: "FACT-12" }, { id: "RULE-7", revision: 1 }],
      direction: "supports",
    },
    NOW,
  );
  // A bare id in a proposal is resolved to the active revision *and stored as
  // that revision*, so the persisted edge never floats.
  assert.deepEqual(j.premises, [
    { id: "FACT-12", revision: 1 },
    { id: "RULE-7", revision: 1 },
  ]);
  assert.deepEqual(ev.claim, { id: "FACT-12", revision: 1 });

  const rule2 = await s.createRevision(
    "RULE-7",
    { statement: "Kobra comment maximum is 500", revisionNote: "policy change" },
    LATER,
  );
  assert.equal(rule2.revision, 2);
  assert.equal(rule2.kind, "business-rule");

  // Reload from disk through a fresh module instance: nothing in memory carries over.
  const before = await s.readLedger();
  const s2 = await fresh();
  const after = await s2.readLedger();
  assert.deepEqual(after, before);
  assert.deepEqual(after, JSON.parse(readFileSync(file(), "utf8")));

  // The reloaded graph answers exactly as the in-memory one did.
  const cRef = { id: conclusion.id, revision: 1 };
  assert.equal(k.evaluateSupport(after, { id: "FACT-12", revision: 1 }), "supported");
  assert.equal(k.lifecycleOf(after, { id: "RULE-7", revision: 1 }), "superseded");
  assert.equal(k.lifecycleOf(after, { id: "RULE-7", revision: 2 }), "active");
  assert.equal(k.evaluateSupport(after, cRef), "unsupported"); // RULE-7:v1 superseded
  assert.deepEqual(k.premisesOf(after, cRef)[0].premises, j.premises);
  assert.deepEqual(k.dependentsOf(after, { id: "RULE-7", revision: 1 }), [cRef]);
  assert.deepEqual(k.dependentsOf(after, { id: "RULE-7", revision: 2 }), []);
  assert.deepEqual(
    after.claims.find((c: Claim) => c.id === "RULE-7" && c.revision === 1)?.structuredValue,
    {
      when: ["field = comment"],
      then: ["max = 180"],
    },
  );

  // The on-disk record stores no derived state.
  for (const c of after.claims) {
    assert.equal("lifecycle" in c, false);
    assert.equal("support" in c, false);
  }
  assert.equal(after.version, 1);
});

test("a missing file reads as an empty ledger and the first write creates it", async () => {
  const s = await fresh();
  assert.deepEqual(await s.readLedger(), {
    version: 1,
    claims: [],
    evidence: [],
    justifications: [],
  });
  await s.createClaim({ id: "A", kind: "fact", statement: "a" }, NOW);
  assert.equal(JSON.parse(readFileSync(file(), "utf8")).claims.length, 1);
});

test("a corrupt or foreign-shaped file is read as empty and never overwritten", async () => {
  const s = await fresh();
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file(), "{ not json");
  assert.deepEqual((await s.readLedger()).claims, []);
  await assert.rejects(
    s.createClaim({ id: "A", kind: "fact", statement: "a" }, NOW),
    /refusing to overwrite/,
  );
  assert.equal(readFileSync(file(), "utf8"), "{ not json");

  writeFileSync(file(), JSON.stringify({ version: 99, claims: [] }));
  await assert.rejects(
    s.createClaim({ id: "A", kind: "fact", statement: "a" }, NOW),
    /refusing to overwrite/,
  );
  assert.equal(JSON.parse(readFileSync(file(), "utf8")).version, 99);
});

test("a refused transition writes nothing", async () => {
  const s = await fresh();
  await s.createClaim({ id: "A", kind: "fact", statement: "a" }, NOW);
  const before = readFileSync(file(), "utf8");
  await assert.rejects(
    s.createJustification(
      { conclusion: { id: "A" }, premises: [{ id: "GHOST" }], direction: "supports" },
      NOW,
    ),
    /unknown claim GHOST/,
  );
  await assert.rejects(
    s.createEvidence(
      {
        claim: { id: "A", revision: 2 },
        direction: "supports",
        source: { type: "human", who: "x" },
      },
      NOW,
    ),
    /unknown claim A:v2/,
  );
  await assert.rejects(s.createRevision("GHOST", { statement: "x" }, NOW), /unknown claim/);
  assert.equal(readFileSync(file(), "utf8"), before);
});

test("concurrent proposals are serialized: no lost update, no duplicate id", async () => {
  const s = await fresh();
  const results = await Promise.allSettled([
    s.createClaim({ id: "SAME", kind: "fact", statement: "one" }, NOW),
    s.createClaim({ id: "SAME", kind: "fact", statement: "two" }, NOW),
    s.createClaim({ id: "OTHER", kind: "fact", statement: "three" }, NOW),
    s.createClaim({ kind: "assumption", statement: "four" }, NOW),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(refused.reason), /already exists/);
  const ledger = await s.readLedger();
  assert.equal(ledger.claims.length, 3);
  assert.equal(ledger.claims.filter((c: Claim) => c.id === "SAME").length, 1);
});

test("minted ids carry the kind prefix; a proposed id is honoured", async () => {
  const s = await fresh();
  const minted = await s.createClaim({ kind: "business-rule", statement: "r" }, NOW);
  assert.match(minted.id, /^RULE-[0-9a-f]{8}$/);
  const named = await s.createClaim({ id: "RULE-17", kind: "business-rule", statement: "r" }, NOW);
  assert.equal(named.id, "RULE-17");
  const ev = await s.createEvidence(
    { claim: { id: "RULE-17" }, direction: "supports", source: { type: "human", who: "me" } },
    NOW,
  );
  assert.match(ev.id, /^EV-[0-9a-f]{8}$/);
});
