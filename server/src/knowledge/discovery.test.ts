import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ClaimRef,
  DiscoveryPolicy,
  KnowledgeDelta,
  KnowledgeDeltaRecord,
} from "@argus/contracts";
import { addClaim, addEvidence, emptyLedger, reviseClaim, type KnowledgeLedger } from "./kernel.js";
import { validateKnowledgeDelta } from "./delta.js";
import {
  DISCOVERY_CONTRACT,
  checkDiscoveryDelta,
  checkSourceEvidenceFiles,
  checkSourceEvidenceShape,
  discoveryInstruction,
  fatalDiscoveryWarnings,
  previewKnowledgeDelta,
  sameCommit,
  semanticWarnings,
  summarizeDiscovery,
  withinScope,
  type DiscoveryContext,
} from "./discovery.js";

/**
 * The deterministic half of business-rule discovery, on hand-built deltas and
 * ledgers: which proposals Argus refuses outright, which it merely flags, what
 * a reviewer sees before approving, and — throughout — that nothing here ever
 * decides whether the *meaning* an agent read out of the code is right.
 */

const T0 = "2026-09-19T10:00:00.000Z";
const HEAD = "abc123def4567890abc123def4567890abc123de";
const v = (id: string, revision: number): ClaimRef => ({ id, revision });

const policy = (over: Partial<DiscoveryPolicy> = {}): DiscoveryPolicy => ({
  scope: { paths: ["src/Booking"] },
  ...over,
});

function ctx(over: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return { policy: policy(), repoRoot: null, gitHead: HEAD, ...over };
}

const delta = (raw: unknown): KnowledgeDelta => validateKnowledgeDelta(raw);

function record(d: KnowledgeDelta, over: Partial<KnowledgeDeltaRecord> = {}): KnowledgeDeltaRecord {
  return {
    id: "KD-1",
    runId: "run-A",
    instanceId: "inst-1",
    phaseId: "discover",
    attempt: 0,
    step: "investigate",
    status: "staged",
    receivedAt: T0,
    updatedAt: T0,
    delta: d,
    ...over,
  };
}

/** A rule and its evidence — the shape a well-formed discovery delta has. */
const RULE_WITH_EVIDENCE = {
  schemaVersion: 1,
  claims: [
    {
      localId: "comment-limit",
      kind: "business-rule",
      statement: "Kobra bookings allow a maximum customer comment length of 180 characters.",
    },
  ],
  evidence: [
    {
      claim: { local: "comment-limit" },
      source: {
        type: "source-code",
        path: "src/Booking/KobraAdapter.cs",
        gitHead: HEAD,
        symbol: "KobraAdapter.MapComment",
        startLine: 120,
        endLine: 136,
      },
      note: "truncates the comment at 180",
    },
  ],
};

/** RULE-17:v1 "Kobra comments max = 180", supported by a document. */
function withRule(): KnowledgeLedger {
  let l = emptyLedger();
  l = addClaim(
    l,
    { id: "RULE-17", kind: "business-rule", statement: "Kobra comments max = 180" },
    T0,
  ).ledger;
  l = addEvidence(
    l,
    {
      id: "EV-1",
      claim: v("RULE-17", 1),
      direction: "supports",
      source: { type: "document", uri: "spec://kobra/4.1" },
    },
    T0,
  ).ledger;
  return l;
}

const codes = (ws: { code: string }[]) => ws.map((w) => w.code).sort();

// ── The agent contract ──────────────────────────────────────────────────────

test("the discovery contract distinguishes a rule from an implementation observation", () => {
  assert.match(DISCOVERY_CONTRACT, /business-rule/);
  assert.match(DISCOVERY_CONTRACT, /Substring\(0, 180\)/);
  assert.match(DISCOVERY_CONTRACT, /is not itself one/);
  assert.match(DISCOVERY_CONTRACT, /assumption/);
  assert.match(DISCOVERY_CONTRACT, /Evidence is mandatory/);
  assert.match(DISCOVERY_CONTRACT, /propose a REVISION of that exact claim/);
  // It must not teach the agent to mint identity: that is Argus's job.
  assert.match(DISCOVERY_CONTRACT, /Do not invent canonical ids/);
});

test("the instruction names the phase's bounded scope, and is empty without a policy", () => {
  assert.equal(discoveryInstruction(undefined), "");
  const text = discoveryInstruction(
    policy({ scope: { paths: ["src/Booking", "src/Kobra"], label: "Kobra booking", note: "n" } }),
  );
  assert.match(text, /Scope for this invocation \(Kobra booking\): src\/Booking, src\/Kobra/);
  assert.match(text, /refused and fails this step/);
  assert.match(text, /\nn$/);
  assert.match(discoveryInstruction(policy({ evidence: "warn" })), /flagged for the reviewer/);
  assert.match(discoveryInstruction(policy({ scope: { paths: ["."] } })), /whole working tree/);
});

// ── Scope and commit containment ────────────────────────────────────────────

test('scope containment matches whole segments, and "." admits the tree', () => {
  const scope = { paths: ["src/Booking", "docs/rules.md"] };
  assert.equal(withinScope(scope, "src/Booking/KobraAdapter.cs"), true);
  assert.equal(withinScope(scope, "src/Booking"), true);
  assert.equal(withinScope(scope, "docs/rules.md"), true);
  // A sibling whose name merely starts with the scope is not in it.
  assert.equal(withinScope(scope, "src/BookingLegacy/Old.cs"), false);
  assert.equal(withinScope(scope, "src/Other.cs"), false);
  assert.equal(withinScope({ paths: ["."] }, "anything/at/all.cs"), true);
});

test("commit comparison accepts an abbreviated sha on either side, and nothing else", () => {
  assert.equal(sameCommit(HEAD, HEAD.slice(0, 7)), true);
  assert.equal(sameCommit(HEAD.slice(0, 12), HEAD), true);
  assert.equal(sameCommit(HEAD, HEAD.toUpperCase()), true);
  assert.equal(sameCommit(HEAD, "0000000"), false);
});

// ── Source evidence: structure ──────────────────────────────────────────────

test("source evidence outside the declared scope is a warning, and a fatal one", () => {
  const d = delta({
    ...RULE_WITH_EVIDENCE,
    evidence: [
      {
        claim: { local: "comment-limit" },
        source: { type: "source-code", path: "src/Other/Unrelated.cs", gitHead: HEAD },
      },
    ],
  });
  const ws = checkSourceEvidenceShape(d, ctx());
  assert.deepEqual(codes(ws), ["source-outside-scope"]);
  assert.match(ws[0].message, /outside this phase's discovery scope/);
  assert.equal(fatalDiscoveryWarnings(ws, policy()).length, 1);
});

test("a path that escapes the repository is refused by the delta validator itself", () => {
  // The structural rule lives in `validate.ts`, so an escaping path can never
  // even be staged — a discovery check is defence in depth, not the only gate.
  assert.throws(
    () =>
      delta({
        schemaVersion: 1,
        claims: [{ localId: "r", kind: "business-rule", statement: "s" }],
        evidence: [
          {
            claim: { local: "r" },
            source: { type: "source-code", path: "../../outside/secrets.env" },
          },
        ],
      }),
    /repository-relative POSIX path/,
  );
  for (const bad of ["/etc/passwd", "C:/x", "a/../../b", "a\\b"]) {
    assert.throws(
      () =>
        delta({
          schemaVersion: 1,
          claims: [{ localId: "r", kind: "business-rule", statement: "s" }],
          evidence: [{ claim: { local: "r" }, source: { type: "source-code", path: bad } }],
        }),
      /repository-relative POSIX path/,
      bad,
    );
  }
});

test("an inverted line range and a foreign commit are both refused", () => {
  const d = delta({
    ...RULE_WITH_EVIDENCE,
    evidence: [
      {
        claim: { local: "comment-limit" },
        source: {
          type: "source-code",
          path: "src/Booking/KobraAdapter.cs",
          gitHead: "0000000",
          startLine: 40,
          endLine: 40,
        },
      },
    ],
  });
  const ws = checkSourceEvidenceShape(d, ctx());
  assert.deepEqual(codes(ws), ["source-git-head-mismatch"]);
  // endLine < startLine never reaches here: the validator refuses it first.
  assert.throws(
    () =>
      delta({
        ...RULE_WITH_EVIDENCE,
        evidence: [
          {
            claim: { local: "comment-limit" },
            source: {
              type: "source-code",
              path: "src/Booking/KobraAdapter.cs",
              startLine: 50,
              endLine: 40,
            },
          },
        ],
      }),
    /endLine must not precede startLine/,
  );
});

test("a run with no recorded head leaves an agent-supplied commit unverifiable, not wrong", () => {
  const d = delta(RULE_WITH_EVIDENCE);
  assert.deepEqual(checkSourceEvidenceShape(d, ctx({ gitHead: null })), []);
});

// ── Source evidence: the filesystem ─────────────────────────────────────────

function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), "argus-discovery-"));
  mkdirSync(path.join(root, "src", "Booking"), { recursive: true });
  writeFileSync(path.join(root, "src", "Booking", "KobraAdapter.cs"), "// code\n");
  return root;
}

test("evidence naming a file that is not in the tree is refused — fail closed", async () => {
  const root = repo();
  assert.deepEqual(await checkSourceEvidenceFiles(delta(RULE_WITH_EVIDENCE), root), []);
  const missing = delta({
    ...RULE_WITH_EVIDENCE,
    evidence: [
      {
        claim: { local: "comment-limit" },
        source: { type: "source-code", path: "src/Booking/Gone.cs", gitHead: HEAD },
      },
    ],
  });
  const ws = await checkSourceEvidenceFiles(missing, root);
  assert.deepEqual(codes(ws), ["source-file-missing"]);
  assert.equal(fatalDiscoveryWarnings(ws, policy()).length, 1);
  // A directory is not a source location either.
  const dir = delta({
    ...RULE_WITH_EVIDENCE,
    evidence: [
      { claim: { local: "comment-limit" }, source: { type: "source-code", path: "src/Booking" } },
    ],
  });
  assert.deepEqual(codes(await checkSourceEvidenceFiles(dir, root)), ["source-file-missing"]);
});

/**
 * Phase 5 shipped with this gap and Phase 6 closes it: containment was decided
 * lexically, so a repository-internal symlink pointing *out* of the tree
 * satisfied every rule — relative path, no `..`, and it stats as a file — while
 * the bytes it names are not in the repository and not at the commit the
 * evidence claims. Containment is now decided on the resolved real path.
 */
test("a repository-internal symlink escaping the tree is refused, not silently accepted", async () => {
  const root = repo();
  const outside = mkdtempSync(path.join(tmpdir(), "argus-outside-"));
  writeFileSync(path.join(outside, "Secret.cs"), "// not in the repository\n");
  // scope/link → outside-repo-file.
  symlinkSync(path.join(outside, "Secret.cs"), path.join(root, "src", "Booking", "Linked.cs"));

  const escaped = delta({
    ...RULE_WITH_EVIDENCE,
    evidence: [
      {
        claim: { local: "comment-limit" },
        source: { type: "source-code", path: "src/Booking/Linked.cs", gitHead: HEAD },
      },
    ],
  });
  const ws = await checkSourceEvidenceFiles(escaped, root);
  assert.deepEqual(codes(ws), ["source-path-unsafe"]);
  assert.match(ws[0].message, /resolves outside the run's repository/);
  // And it is fatal: the delta never reaches a reviewer as a candidate.
  assert.equal(fatalDiscoveryWarnings(ws, policy()).length, 1);
  const verdict = await checkDiscoveryDelta(escaped, emptyLedger(), ctx({ repoRoot: root }));
  assert.match(verdict.refusal ?? "", /resolves outside the run's repository/);
});

test("a symlinked directory inside the scope cannot smuggle a path out either", async () => {
  const root = repo();
  const outside = mkdtempSync(path.join(tmpdir(), "argus-outside-dir-"));
  mkdirSync(path.join(outside, "nested"), { recursive: true });
  writeFileSync(path.join(outside, "nested", "Other.cs"), "// elsewhere\n");
  symlinkSync(path.join(outside, "nested"), path.join(root, "src", "Booking", "link"));

  const through = delta({
    ...RULE_WITH_EVIDENCE,
    evidence: [
      {
        claim: { local: "comment-limit" },
        source: { type: "source-code", path: "src/Booking/link/Other.cs", gitHead: HEAD },
      },
    ],
  });
  assert.deepEqual(codes(await checkSourceEvidenceFiles(through, root)), ["source-path-unsafe"]);
});

test("a symlink that stays inside the repository is ordinary evidence", async () => {
  const root = repo();
  symlinkSync(
    path.join(root, "src", "Booking", "KobraAdapter.cs"),
    path.join(root, "src", "Booking", "Alias.cs"),
  );
  const aliased = delta({
    ...RULE_WITH_EVIDENCE,
    evidence: [
      {
        claim: { local: "comment-limit" },
        source: { type: "source-code", path: "src/Booking/Alias.cs", gitHead: HEAD },
      },
    ],
  });
  assert.deepEqual(await checkSourceEvidenceFiles(aliased, root), []);
});

test("with no repository root there is nothing to check, and nothing is claimed", async () => {
  assert.deepEqual(await checkSourceEvidenceFiles(delta(RULE_WITH_EVIDENCE), null), []);
});

// ── The business-rule evidence invariant ────────────────────────────────────

test("a business rule with no evidence is a warning, and fatal under the default policy", () => {
  const d = delta({
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Comments max 180" }],
  });
  const ws = semanticWarnings(d, emptyLedger());
  assert.deepEqual(codes(ws), ["business-rule-without-evidence"]);
  assert.equal(fatalDiscoveryWarnings(ws, policy()).length, 1);
  // `evidence: "warn"` downgrades exactly this, so an author can see the
  // candidate at the gate instead of losing the step.
  assert.equal(fatalDiscoveryWarnings(ws, policy({ evidence: "warn" })).length, 0);
});

test("opposing evidence does not satisfy the invariant: a rule needs support, not mention", () => {
  const d = delta({
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Comments max 180" }],
    evidence: [
      {
        claim: { local: "r" },
        direction: "opposes",
        source: { type: "source-code", path: "src/Booking/KobraAdapter.cs" },
      },
    ],
  });
  assert.deepEqual(codes(semanticWarnings(d, emptyLedger())), ["business-rule-without-evidence"]);
});

test("a justification alone does not satisfy the rule invariant, but does satisfy an assumption", () => {
  const withJustification = delta({
    schemaVersion: 1,
    claims: [
      { localId: "a", kind: "assumption", statement: "The limit is a Kobra constraint" },
      { localId: "r", kind: "business-rule", statement: "Comments max 180" },
    ],
    justifications: [{ conclusion: { local: "r" }, premises: [{ local: "a" }] }],
    evidence: [
      {
        claim: { local: "a" },
        source: { type: "source-code", path: "src/Booking/KobraAdapter.cs" },
      },
    ],
  });
  // The assumption is grounded; the rule is derived but carries no evidence of
  // its own, which the invariant still requires.
  assert.deepEqual(codes(semanticWarnings(withJustification, emptyLedger())), [
    "business-rule-without-evidence",
  ]);
});

test("a bare assumption is flagged for the reviewer but never refused", () => {
  const d = delta({
    schemaVersion: 1,
    claims: [{ localId: "a", kind: "assumption", statement: "The limit comes from Kobra" }],
  });
  const ws = semanticWarnings(d, emptyLedger());
  assert.deepEqual(codes(ws), ["assumption-without-evidence"]);
  assert.equal(fatalDiscoveryWarnings(ws, policy()).length, 0);
});

test("a fact or conclusion with neither evidence nor derivation is flagged, not refused", () => {
  const d = delta({
    schemaVersion: 1,
    claims: [
      { localId: "f", kind: "fact", statement: "Kobra strips HTML" },
      { localId: "c", kind: "conclusion", statement: "Validate at 180" },
    ],
  });
  const ws = semanticWarnings(d, emptyLedger());
  assert.deepEqual(codes(ws), ["claim-without-support", "claim-without-support"]);
  assert.equal(fatalDiscoveryWarnings(ws, policy()).length, 0);
});

// ── Revisions ───────────────────────────────────────────────────────────────

test("a business-rule revision that only rewords the sentence is refused", () => {
  const d = delta({
    schemaVersion: 1,
    revisions: [
      {
        claimId: "RULE-17",
        expectedRevision: 1,
        statement: "Kobra comments max = 500",
        revisionNote: "the code says 500",
      },
    ],
  });
  const ws = semanticWarnings(d, withRule());
  assert.ok(ws.some((w) => w.code === "revision-without-evidence"));
  assert.match(
    ws.find((w) => w.code === "revision-without-evidence")!.message,
    /declares no localId/,
  );
  assert.equal(fatalDiscoveryWarnings(ws, policy()).length, 1);
});

test("a revision with fresh evidence attached to its localId satisfies the invariant", () => {
  const d = delta({
    schemaVersion: 1,
    revisions: [
      {
        claimId: "RULE-17",
        expectedRevision: 1,
        localId: "r2",
        statement: "Kobra comments max = 500",
        revisionNote: "Kobra 4.2 raised the limit",
      },
    ],
    evidence: [
      {
        claim: { local: "r2" },
        source: {
          type: "source-code",
          path: "src/Booking/KobraAdapter.cs",
          gitHead: HEAD,
          startLine: 120,
          endLine: 136,
        },
      },
    ],
  });
  assert.deepEqual(semanticWarnings(d, withRule()), []);
});

test("revising a non-business-rule claim needs no fresh evidence", () => {
  let l = emptyLedger();
  l = addClaim(l, { id: "FACT-2", kind: "fact", statement: "Kobra strips HTML" }, T0).ledger;
  l = addEvidence(
    l,
    {
      id: "EV-1",
      claim: v("FACT-2", 1),
      direction: "supports",
      source: { type: "human", who: "a" },
    },
    T0,
  ).ledger;
  const d = delta({
    schemaVersion: 1,
    revisions: [{ claimId: "FACT-2", expectedRevision: 1, statement: "Kobra escapes HTML" }],
  });
  assert.deepEqual(semanticWarnings(d, l), []);
});

test("a stale precondition and an unsupported target are both surfaced, neither refused", () => {
  let l = withRule();
  l = reviseClaim(l, { id: "RULE-17", statement: "Kobra comments max = 300" }, T0).ledger;
  const d = delta({
    schemaVersion: 1,
    revisions: [{ claimId: "RULE-17", expectedRevision: 1, localId: "r", statement: "max = 500" }],
    evidence: [
      {
        claim: { local: "r" },
        source: { type: "source-code", path: "src/Booking/KobraAdapter.cs" },
      },
    ],
  });
  const ws = semanticWarnings(d, l);
  // v2 carries no evidence of its own, so it is unsupported; and v1 is stale.
  assert.deepEqual(codes(ws), ["revision-stale", "revision-target-unsupported"]);
  assert.equal(fatalDiscoveryWarnings(ws, policy()).length, 0);
});

// ── The duplicate-rule prompt (structural, never semantic) ──────────────────

test("a new rule while supplied rules went unrevised prompts the reviewer, by exact refs only", () => {
  const d = delta(RULE_WITH_EVIDENCE);
  const ws = semanticWarnings(d, withRule(), { supplied: [v("RULE-17", 1)] });
  assert.deepEqual(codes(ws), ["new-rule-while-rules-supplied"]);
  assert.match(ws[0].message, /RULE-17:v1/);
  assert.match(ws[0].message, /check whether one of them is the same logical rule/);
  // It is a prompt, not a verdict: never fatal, and never asserting sameness.
  assert.equal(fatalDiscoveryWarnings(ws, policy()).length, 0);
  assert.doesNotMatch(ws[0].message, /duplicate of/);
});

test("revising the supplied rule instead of duplicating it raises no prompt", () => {
  const d = delta({
    schemaVersion: 1,
    revisions: [{ claimId: "RULE-17", expectedRevision: 1, localId: "r", statement: "max = 500" }],
    evidence: [
      {
        claim: { local: "r" },
        source: { type: "source-code", path: "src/Booking/KobraAdapter.cs" },
      },
    ],
  });
  assert.deepEqual(semanticWarnings(d, withRule(), { supplied: [v("RULE-17", 1)] }), []);
});

test("a supplied claim that is not a business rule does not trigger the prompt", () => {
  let l = withRule();
  l = addClaim(l, { id: "FACT-2", kind: "fact", statement: "Kobra strips HTML" }, T0).ledger;
  const d = delta(RULE_WITH_EVIDENCE);
  assert.deepEqual(semanticWarnings(d, l, { supplied: [v("FACT-2", 1)] }), []);
});

// ── The whole check ─────────────────────────────────────────────────────────

test("checkDiscoveryDelta refuses with one sentence naming every fatal problem", async () => {
  const root = repo();
  const bad = delta({
    schemaVersion: 1,
    claims: [
      { localId: "r", kind: "business-rule", statement: "Comments max 180" },
      { localId: "r2", kind: "business-rule", statement: "Bookings need a customer" },
    ],
    evidence: [
      {
        claim: { local: "r2" },
        // `r` stays uncovered, and this path is both out of scope and absent
        // from the tree — three fatal problems, one sentence.
        source: { type: "source-code", path: "src/Other/Gone.cs" },
      },
    ],
  });
  const verdict = await checkDiscoveryDelta(bad, emptyLedger(), ctx({ repoRoot: root }));
  assert.ok(verdict.refusal);
  assert.match(verdict.refusal, /^discovery: /);
  assert.match(verdict.refusal, /outside this phase's discovery scope/);
  assert.match(verdict.refusal, /does not exist in the run's repository/);
  assert.match(verdict.refusal, /carries no supporting evidence/);
});

test("a well-formed discovery delta is accepted, with no warnings at all", async () => {
  const root = repo();
  const verdict = await checkDiscoveryDelta(
    delta(RULE_WITH_EVIDENCE),
    emptyLedger(),
    ctx({ repoRoot: root }),
  );
  assert.equal(verdict.refusal, null);
  assert.deepEqual(verdict.warnings, []);
});

// ── The candidate preview ───────────────────────────────────────────────────

test("preview: a proposed claim is named local:<id>, never a canonical id it does not have", () => {
  const preview = previewKnowledgeDelta(record(delta(RULE_WITH_EVIDENCE)), emptyLedger());
  assert.equal(preview.proposedClaims.length, 1);
  const claim = preview.proposedClaims[0];
  assert.deepEqual(claim.ref, { display: "local:comment-limit", local: "comment-limit" });
  assert.equal(claim.kind, "business-rule");
  assert.match(claim.statement, /180 characters/);
  // The evidence is gathered under the claim it bears on, so the reviewer
  // reads one block per candidate rather than cross-referencing two lists.
  assert.equal(claim.evidence.length, 1);
  assert.deepEqual(claim.evidence[0].source, {
    type: "source-code",
    path: "src/Booking/KobraAdapter.cs",
    gitHead: HEAD,
    symbol: "KobraAdapter.MapComment",
    startLine: 120,
    endLine: 136,
  });
  assert.equal(claim.evidence[0].direction, "supports");
  // …and is also listed flat, for a scan of evidence alone.
  assert.equal(preview.evidence.length, 1);
  assert.equal(preview.status, "staged");
  assert.equal(preview.deltaId, "KD-1");
  assert.equal(preview.step, "investigate");
});

test("preview: a revision shows what it would replace and what it would become", () => {
  const d = delta({
    schemaVersion: 1,
    revisions: [
      {
        claimId: "RULE-17",
        expectedRevision: 1,
        localId: "r2",
        statement: "Kobra comments max = 500",
        revisionNote: "the adapter truncates at 500",
      },
    ],
    evidence: [
      {
        claim: { local: "r2" },
        source: { type: "source-code", path: "src/Booking/KobraAdapter.cs", gitHead: HEAD },
      },
    ],
  });
  const preview = previewKnowledgeDelta(record(d), withRule());
  const rev = preview.proposedRevisions[0];
  assert.equal(rev.claimId, "RULE-17");
  assert.equal(rev.expectedRevision, 1);
  assert.equal(rev.kind, "business-rule");
  assert.deepEqual(rev.ref, {
    display: "RULE-17:v2 (proposed)",
    claim: v("RULE-17", 2),
    proposed: true,
  });
  assert.deepEqual(rev.current, {
    claim: v("RULE-17", 1),
    statement: "Kobra comments max = 180",
    support: "supported",
    lifecycle: "active",
  });
  assert.equal(rev.statement, "Kobra comments max = 500");
  assert.equal(rev.revisionNote, "the adapter truncates at 500");
  assert.equal(rev.stale, undefined);
  assert.equal(rev.evidence.length, 1);
});

test("preview: a stale revision says so, against the ledger as it stands now", () => {
  let l = withRule();
  l = reviseClaim(l, { id: "RULE-17", statement: "max = 300" }, T0).ledger;
  const d = delta({
    schemaVersion: 1,
    revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "max = 500" }],
  });
  const rev = previewKnowledgeDelta(record(d), l).proposedRevisions[0];
  assert.equal(rev.stale, true);
  assert.deepEqual(rev.current?.claim, v("RULE-17", 2));
});

test("preview: consumed and supplied refs carry their statements while the ledger holds them", () => {
  const d = delta({ schemaVersion: 1, consumed: ["RULE-17:v1"] });
  const preview = previewKnowledgeDelta(record(d, { supplied: [v("RULE-17", 1)] }), withRule());
  assert.deepEqual(preview.consumed, [
    {
      ref: "RULE-17:v1",
      claim: v("RULE-17", 1),
      kind: "business-rule",
      statement: "Kobra comments max = 180",
    },
  ]);
  assert.equal(preview.supplied?.[0].ref, "RULE-17:v1");
  // A revision the ledger no longer holds still previews, without a statement.
  const gone = previewKnowledgeDelta(
    record(delta({ schemaVersion: 1, consumed: ["RULE-99:v3"] })),
    withRule(),
  );
  assert.deepEqual(gone.consumed, [{ ref: "RULE-99:v3", claim: v("RULE-99", 3) }]);
});

test("preview: without an explicit warning set it computes the semantic ones itself", () => {
  const d = delta({
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Comments max 180" }],
  });
  assert.deepEqual(codes(previewKnowledgeDelta(record(d), emptyLedger()).warnings), [
    "business-rule-without-evidence",
  ]);
  // …and takes the caller's when it has them (the engine's include filesystem
  // checks, which a preview cannot make on its own).
  assert.deepEqual(previewKnowledgeDelta(record(d), emptyLedger(), []).warnings, []);
});

test("preview: an unparseable record previews as empty rather than throwing", () => {
  const preview = previewKnowledgeDelta(
    record({ schemaVersion: 1 }, { delta: undefined, status: "rejected", reason: "bad" }),
    null,
  );
  assert.deepEqual(preview.proposedClaims, []);
  assert.deepEqual(preview.proposedRevisions, []);
  assert.equal(preview.status, "rejected");
});

// ── The phase summary ───────────────────────────────────────────────────────

test("the discovery summary counts candidates without copying them", () => {
  const d = delta({
    schemaVersion: 1,
    claims: [
      { localId: "r1", kind: "business-rule", statement: "Comments max 180" },
      { localId: "r2", kind: "business-rule", statement: "Bookings need a customer" },
      { localId: "a", kind: "assumption", statement: "The limit is a Kobra constraint" },
      { localId: "f", kind: "fact", statement: "Kobra strips HTML" },
      { localId: "c", kind: "constraint", statement: "Validate server-side" },
    ],
    revisions: [{ claimId: "RULE-17", expectedRevision: 1, localId: "x", statement: "max = 500" }],
    evidence: [
      { claim: { local: "r1" }, source: { type: "source-code", path: "src/Booking/A.cs" } },
      { claim: { local: "r2" }, source: { type: "source-code", path: "src/Booking/B.cs" } },
      { claim: { local: "x" }, source: { type: "source-code", path: "src/Booking/C.cs" } },
    ],
  });
  const preview = previewKnowledgeDelta(record(d), withRule(), []);
  assert.deepEqual(summarizeDiscovery([preview], [d], true), {
    candidates: 6,
    newRules: 2,
    revisions: 1,
    assumptions: 1,
    facts: 1,
    constraints: 1,
    conclusions: 0,
    evidence: 3,
    warnings: 0,
    requiresReview: true,
  });
  // The summary is counts only: no statement of any candidate is in it.
  const json = JSON.stringify(summarizeDiscovery([preview], [d], false));
  assert.doesNotMatch(json, /Comments max/);
});
