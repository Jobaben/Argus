import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ClaimRef,
  RuleVerificationPolicy,
  RuleVerificationRecord,
  RuleVerificationReport,
} from "@argus/contracts";
import {
  addClaim,
  addEvidence,
  emptyLedger,
  evaluateSupport,
  recordRuleVerification,
  reviseClaim,
  ruleConformance,
  verificationsOfClaim,
  verificationsOfRun,
  type KnowledgeLedger,
} from "./kernel.js";
import {
  RULE_VERIFICATION_CONTRACT,
  RuleVerificationError,
  bindCheckEvidence,
  checkRuleVerification,
  completenessRefusal,
  declaredCheckLabels,
  describeReport,
  holdsPolicyRefusal,
  parseRuleVerificationReport,
  previewRuleVerification,
  selectedRules,
  summarizeRuleVerification,
  validateRuleVerificationReport,
  verificationInstruction,
  type VerificationContext,
} from "./ruleVerification.js";
import { checkLabel } from "../harness/verification.js";
import { resolveRepositoryFile } from "./sourcePath.js";

/**
 * Business-rule verification, on hand-built reports, ledgers and repositories.
 *
 * The suite is organized around the one distinction Phase 6 exists to make and
 * keep: **rule support** and **implementation conformance** are different
 * facts, and nothing a verification records may move the first one. Everything
 * else here — completeness, exactness, evidence floors, check linkage, symlink
 * containment — is in service of that: a conformance record Argus cannot
 * substantiate is worse than no record, because somebody would act on it.
 */

const T0 = "2026-09-20T10:00:00.000Z";
const T1 = "2026-09-20T11:00:00.000Z";
const T2 = "2026-09-20T12:00:00.000Z";
const HEAD_A = "abc123def4567890abc123def4567890abc123de";
const HEAD_B = "def4560000000000def4560000000000def45600";
const v = (id: string, revision: number): ClaimRef => ({ id, revision });

/** A ledger with one supported business rule, RULE-42:v1. */
function supportedRule(): KnowledgeLedger {
  let ledger = emptyLedger();
  ledger = addClaim(
    ledger,
    {
      id: "RULE-42",
      kind: "business-rule",
      statement: "Kobra customer comments must not exceed 180 characters.",
    },
    T0,
  ).ledger;
  ledger = addEvidence(
    ledger,
    {
      id: "EV-1",
      claim: v("RULE-42", 1),
      direction: "supports",
      source: { type: "human", who: "domain owner" },
    },
    T0,
  ).ledger;
  return ledger;
}

const report = (raw: unknown): RuleVerificationReport => validateRuleVerificationReport(raw);

const sourceEvidence = (over: Record<string, unknown> = {}) => ({
  type: "source-code",
  path: "src/Booking/KobraAdapter.cs",
  symbol: "KobraAdapter.MaxCustomerCommentLength",
  startLine: 3,
  endLine: 8,
  ...over,
});

const holdsReport = (rule = "RULE-42:v1") => ({
  schemaVersion: 1,
  verifications: [{ rule, outcome: "holds", evidence: [sourceEvidence()] }],
});

function ctx(over: Partial<VerificationContext> = {}): VerificationContext {
  return {
    policy: {},
    selected: [v("RULE-42", 1)],
    repoRoot: null,
    gitHead: HEAD_A,
    checkLabels: [],
    ...over,
  };
}

function stagedRecord(
  r: RuleVerificationReport,
  over: Partial<RuleVerificationRecord> = {},
): RuleVerificationRecord {
  return {
    id: "RV-1",
    runId: "run-A",
    instanceId: "inst-1",
    phaseId: "verify",
    attempt: 0,
    step: "verify",
    status: "staged",
    receivedAt: T0,
    updatedAt: T0,
    selected: [v("RULE-42", 1)],
    gitHead: HEAD_A,
    report: r,
    ...over,
  };
}

/** A repository fixture with one file and one symlink escaping the tree. */
function makeRepo(): { repo: string; outside: string } {
  const repo = mkdtempSync(path.join(tmpdir(), "argus-verify-repo-"));
  const outside = mkdtempSync(path.join(tmpdir(), "argus-verify-outside-"));
  mkdirSync(path.join(repo, "src", "Booking"), { recursive: true });
  writeFileSync(
    path.join(repo, "src", "Booking", "KobraAdapter.cs"),
    ["public static class KobraAdapter", "{", "  public const int Max = 180;", "}", ""].join("\n"),
  );
  writeFileSync(path.join(outside, "secrets.txt"), "not in the repository\n");
  return { repo, outside };
}

// ── The invariant: support and conformance are different facts ──────────────

test("a violated implementation leaves the rule exactly as supported as it was", () => {
  const before = supportedRule();
  assert.equal(evaluateSupport(before, v("RULE-42", 1)), "supported");

  const { ledger: after, verification } = recordRuleVerification(
    before,
    {
      id: "RV-1",
      execution: { runId: "run-A" },
      rule: v("RULE-42", 1),
      outcome: "violated",
      evidence: [{ type: "observation", note: "the validator permits 500 characters" }],
      gitHead: HEAD_A,
    },
    T1,
  );

  // The rule did not move.
  assert.equal(evaluateSupport(after, v("RULE-42", 1)), "supported");
  // And nothing in the support model was written at all: no opposing
  // evidence, no justification, no claim. Exactly one array changed.
  assert.deepEqual(after.evidence, before.evidence);
  assert.deepEqual(after.justifications, before.justifications);
  assert.deepEqual(after.claims, before.claims);
  assert.deepEqual(after.consumptions, before.consumptions);
  assert.equal(after.verifications.length, 1);
  assert.equal(verification.outcome, "violated");
  // Conformance says what support does not.
  assert.equal(ruleConformance(after, v("RULE-42", 1), HEAD_A).status, "violated");
});

// ── The durable record ──────────────────────────────────────────────────────

test("a verification names an exact revision, an execution and a repository revision", () => {
  const { ledger, verification } = recordRuleVerification(
    supportedRule(),
    {
      id: "RV-1",
      execution: { runId: "run-A", instanceId: "inst-1", phaseId: "verify" },
      rule: v("RULE-42", 1),
      outcome: "holds",
      evidence: [{ type: "check", label: "comment-tests", status: "passed", detail: "exit 0" }],
      attempt: 0,
      gitHead: HEAD_A,
      policy: "deterministic-check",
    },
    T1,
  );
  assert.deepEqual(verification.rule, v("RULE-42", 1));
  assert.deepEqual(verification.execution, {
    runId: "run-A",
    instanceId: "inst-1",
    phaseId: "verify",
  });
  assert.deepEqual(verification.repository, { gitHead: HEAD_A });
  assert.equal(verification.createdAt, T1);
  assert.equal(verification.policy, "deterministic-check");
  assert.deepEqual(verificationsOfRun(ledger, "run-A"), [verification]);
});

test("recording the same run's conclusion twice is a no-op; a different one is refused", () => {
  const base = supportedRule();
  const input = {
    id: "RV-1",
    execution: { runId: "run-A" },
    rule: v("RULE-42", 1),
    outcome: "holds" as const,
    evidence: [{ type: "observation" as const, note: "the validator caps at 180" }],
  };
  const first = recordRuleVerification(base, input, T1);
  const again = recordRuleVerification(first.ledger, { ...input, id: "RV-2" }, T2);
  assert.equal(again.added, false);
  assert.equal(again.ledger, first.ledger);
  assert.equal(again.verification.id, "RV-1");
  assert.throws(
    () => recordRuleVerification(first.ledger, { ...input, id: "RV-2", outcome: "violated" }, T2),
    /already verified RULE-42:v1 as holds/,
  );
});

test("a verification of a revision the ledger does not hold is refused", () => {
  assert.throws(
    () =>
      recordRuleVerification(
        supportedRule(),
        {
          id: "RV-1",
          execution: { runId: "run-A" },
          rule: v("RULE-42", 2),
          outcome: "holds",
          evidence: [{ type: "observation", note: "x" }],
        },
        T1,
      ),
    /unknown claim revision RULE-42:v2/,
  );
});

test("holds and violated need evidence; unverifiable needs a reason", () => {
  const base = supportedRule();
  const call = (over: Record<string, unknown>) =>
    recordRuleVerification(
      base,
      {
        id: "RV-1",
        execution: { runId: "run-A" },
        rule: v("RULE-42", 1),
        outcome: "holds",
        evidence: [],
        ...over,
      } as Parameters<typeof recordRuleVerification>[1],
      T1,
    );
  assert.throws(() => call({}), /must cite at least one evidence record/);
  assert.throws(() => call({ outcome: "violated" }), /must cite at least one evidence record/);
  assert.throws(() => call({ outcome: "unverifiable" }), /must give a reason/);
  // An unverifiable outcome with a reason and no evidence is legitimate: it is
  // precisely the "no executable expression exists" case.
  assert.equal(
    call({ outcome: "unverifiable", reason: "no test covers comment length" }).verification.outcome,
    "unverifiable",
  );
});

// ── Revision binding ────────────────────────────────────────────────────────

test("a new rule revision is unverified; the old revision keeps its history", () => {
  let ledger = supportedRule();
  ledger = recordRuleVerification(
    ledger,
    {
      id: "RV-1",
      execution: { runId: "run-A" },
      rule: v("RULE-42", 1),
      outcome: "holds",
      evidence: [{ type: "observation", note: "caps at 180" }],
      gitHead: HEAD_A,
    },
    T1,
  ).ledger;
  ledger = reviseClaim(
    ledger,
    { id: "RULE-42", statement: "Kobra customer comments must not exceed 500 characters." },
    T2,
  ).ledger;

  // v1 keeps its result — historical, never rewritten, never retargeted.
  assert.equal(ruleConformance(ledger, v("RULE-42", 1)).status, "holds");
  assert.equal(verificationsOfClaim(ledger, v("RULE-42", 1)).length, 1);
  // v2 inherits nothing.
  assert.equal(ruleConformance(ledger, v("RULE-42", 2)).status, "unverified");
  assert.deepEqual(verificationsOfClaim(ledger, v("RULE-42", 2)), []);
});

// ── Repository binding ──────────────────────────────────────────────────────

test("conformance at another commit is unverified, not the old commit's answer", () => {
  const ledger = recordRuleVerification(
    supportedRule(),
    {
      id: "RV-1",
      execution: { runId: "run-A" },
      rule: v("RULE-42", 1),
      outcome: "holds",
      evidence: [{ type: "observation", note: "caps at 180" }],
      gitHead: HEAD_A,
    },
    T1,
  ).ledger;

  assert.equal(ruleConformance(ledger, v("RULE-42", 1), HEAD_A).status, "holds");
  assert.equal(ruleConformance(ledger, v("RULE-42", 1), HEAD_B).status, "unverified");
  // An abbreviated sha names the same commit.
  assert.equal(ruleConformance(ledger, v("RULE-42", 1), HEAD_A.slice(0, 8)).status, "holds");
  // Unscoped: the latest recorded outcome, and the report says which commit it
  // was about — a statement about the past, never about HEAD.
  const latest = ruleConformance(ledger, v("RULE-42", 1));
  assert.equal(latest.status, "holds");
  assert.equal(latest.gitHead, undefined);
  assert.equal(latest.latest?.repository?.gitHead, HEAD_A);
});

test("several repository revisions coexist and all stay queryable", () => {
  let ledger = supportedRule();
  const at = (runId: string, outcome: "holds" | "violated", gitHead: string, when: string) => {
    ledger = recordRuleVerification(
      ledger,
      {
        id: `RV-${runId}`,
        execution: { runId },
        rule: v("RULE-42", 1),
        outcome,
        evidence: [{ type: "observation", note: outcome }],
        gitHead,
      },
      when,
    ).ledger;
  };
  const X = HEAD_A;
  const Y = HEAD_B;
  const Z = "0123456789abcdef0123456789abcdef01234567";
  at("run-X", "holds", X, T0);
  at("run-Y", "violated", Y, T1);
  at("run-Z", "holds", Z, T2);

  assert.equal(ruleConformance(ledger, v("RULE-42", 1), X).status, "holds");
  assert.equal(ruleConformance(ledger, v("RULE-42", 1), Y).status, "violated");
  assert.equal(ruleConformance(ledger, v("RULE-42", 1), Z).status, "holds");
  // History is full and unfiltered whichever commit was asked about.
  assert.deepEqual(
    ruleConformance(ledger, v("RULE-42", 1), Y).history.map((h) => h.execution.runId),
    ["run-X", "run-Y", "run-Z"],
  );
  // The rule itself never moved.
  assert.equal(evaluateSupport(ledger, v("RULE-42", 1)), "supported");
});

test("unverified and unverifiable are different answers", () => {
  const never = ruleConformance(supportedRule(), v("RULE-42", 1));
  assert.equal(never.status, "unverified");
  assert.equal(never.latest, undefined);

  const looked = recordRuleVerification(
    supportedRule(),
    {
      id: "RV-1",
      execution: { runId: "run-A" },
      rule: v("RULE-42", 1),
      outcome: "unverifiable",
      evidence: [],
      reason: "no automated test expresses the comment limit",
      gitHead: HEAD_A,
    },
    T1,
  ).ledger;
  const tried = ruleConformance(looked, v("RULE-42", 1), HEAD_A);
  assert.equal(tried.status, "unverifiable");
  assert.equal(tried.latest?.reason, "no automated test expresses the comment limit");
});

// ── Document validation ─────────────────────────────────────────────────────

test("a report names exact revisions only", () => {
  assert.throws(
    () => report(holdsReport("RULE-42")),
    (e: unknown) =>
      e instanceof RuleVerificationError && /must name an exact revision/.test(e.message),
  );
  assert.deepEqual(report(holdsReport()).verifications[0].rule, v("RULE-42", 1));
});

test("an outcome with no evidence, and an unverifiable with no reason, are refused", () => {
  assert.throws(
    () => report({ schemaVersion: 1, verifications: [{ rule: "RULE-42:v1", outcome: "holds" }] }),
    (e: unknown) => e instanceof RuleVerificationError && e.code === "evidence",
  );
  assert.throws(
    () =>
      report({
        schemaVersion: 1,
        verifications: [{ rule: "RULE-42:v1", outcome: "unverifiable", evidence: [] }],
      }),
    /must give a reason/,
  );
});

test("a rule reported on twice, an unknown outcome and a bad schema version are refused", () => {
  assert.throws(
    () =>
      report({
        schemaVersion: 1,
        verifications: [
          { rule: "RULE-42:v1", outcome: "holds", evidence: [sourceEvidence()] },
          { rule: "RULE-42:v1", outcome: "violated", evidence: [sourceEvidence()] },
        ],
      }),
    /reported on twice/,
  );
  assert.throws(
    () =>
      report({
        schemaVersion: 1,
        verifications: [{ rule: "RULE-42:v1", outcome: "probably", evidence: [] }],
      }),
    /outcome must be one of/,
  );
  assert.throws(() => report({ schemaVersion: 2, verifications: [] }), /schemaVersion must be 1/);
  assert.throws(() => parseRuleVerificationReport("{nope"), /not valid JSON/);
});

test("the agent cannot assert that a check passed: status is stripped at validation", () => {
  const parsed = report({
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "holds",
        evidence: [{ type: "check", label: "comment-tests", status: "passed", exitCode: 0 }],
      },
    ],
  });
  assert.deepEqual(parsed.verifications[0].evidence[0], { type: "check", label: "comment-tests" });
});

// ── Completeness ────────────────────────────────────────────────────────────

test("a selected rule left without an outcome refuses the whole proposal", async () => {
  const selected = [v("RULE-A", 1), v("RULE-B", 3), v("RULE-C", 1)];
  const r = report({
    schemaVersion: 1,
    verifications: [
      { rule: "RULE-A:v1", outcome: "holds", evidence: [{ type: "observation", note: "a" }] },
      { rule: "RULE-B:v3", outcome: "violated", evidence: [{ type: "observation", note: "b" }] },
    ],
  });
  const refusal = completenessRefusal(r, selected);
  assert.equal(refusal?.code, "incomplete");
  assert.match(refusal!.message, /RULE-C:v1 is missing/);
  // And the same refusal through the full check, so nothing partial is staged.
  const full = await checkRuleVerification(r, null, ctx({ selected }));
  assert.equal(full?.code, "incomplete");
});

test("a rule the run was never supplied refuses the whole proposal", async () => {
  const r = report({
    schemaVersion: 1,
    verifications: [
      { rule: "RULE-42:v1", outcome: "holds", evidence: [{ type: "observation", note: "a" }] },
      { rule: "RULE-D:v1", outcome: "holds", evidence: [{ type: "observation", note: "d" }] },
    ],
  });
  const refusal = await checkRuleVerification(r, null, ctx());
  assert.equal(refusal?.code, "not-selected");
  assert.match(refusal!.message, /RULE-D:v1 was not supplied to this run/);
});

test("a proposal for the wrong revision of a selected rule is not-selected, never retargeted", async () => {
  const r = report(holdsReport("RULE-42:v1"));
  const refusal = await checkRuleVerification(r, null, ctx({ selected: [v("RULE-42", 2)] }));
  assert.equal(refusal?.code, "incomplete");
  assert.match(refusal!.message, /RULE-42:v2 is missing/);
});

test("selected rules come from the supplied context, filtered by kind", () => {
  let ledger = supportedRule();
  ledger = addClaim(ledger, { id: "FACT-1", kind: "fact", statement: "a fact" }, T0).ledger;
  const supplied = [v("RULE-42", 1), v("FACT-1", 1)];
  // The default asks for an outcome on business rules only: a fact is context
  // to reason *with*, not something an implementation conforms to.
  assert.deepEqual(selectedRules(ledger, supplied, {}), [v("RULE-42", 1)]);
  assert.deepEqual(selectedRules(ledger, supplied, { kinds: ["fact"] }), [v("FACT-1", 1)]);
  // A run supplied nothing is accountable for nothing.
  assert.deepEqual(selectedRules(ledger, undefined, {}), []);
});

// ── Check linkage ───────────────────────────────────────────────────────────

test("a check reference naming no check of this phase is refused", async () => {
  const r = report({
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "holds",
        evidence: [{ type: "check", label: "tests-that-do-not-exist" }],
      },
    ],
  });
  const refusal = await checkRuleVerification(
    r,
    null,
    ctx({ checkLabels: ["customer-comment-tests"] }),
  );
  assert.equal(refusal?.code, "check-reference");
  assert.match(refusal!.message, /this phase does not declare/);
});

test("declaredCheckLabels reads the phase's own labels", () => {
  assert.deepEqual(
    declaredCheckLabels(
      [
        { kind: "command", run: "npm test", label: "customer-comment-tests" },
        { kind: "artifact", path: "report.json" },
      ],
      checkLabel,
    ),
    ["customer-comment-tests", "artifact: report.json"],
  );
});

test("Argus binds the check's real outcome; a cited check missing from the report is named", () => {
  const bound = bindCheckEvidence(
    [{ type: "check", label: "customer-comment-tests", note: "the length test" }],
    [
      {
        label: "customer-comment-tests",
        status: "passed",
        exitCode: 0,
        detail: "exit 0 in 1.2s",
      },
    ],
  );
  assert.deepEqual(bound.missing, []);
  assert.deepEqual(bound.evidence[0], {
    type: "check",
    label: "customer-comment-tests",
    status: "passed",
    detail: "exit 0 in 1.2s",
    exitCode: 0,
    note: "the length test",
  });

  const absent = bindCheckEvidence([{ type: "check", label: "gone" }], []);
  assert.deepEqual(absent.missing, ["gone"]);
});

// ── Policy ──────────────────────────────────────────────────────────────────

test("under deterministic-check, holds must cite a check — and it must have passed", async () => {
  const policy: RuleVerificationPolicy = { holds: "deterministic-check" };
  const noCheck = report({
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "holds",
        evidence: [{ type: "observation", note: "looks ok" }],
      },
    ],
  });
  const refusal = await checkRuleVerification(noCheck, null, ctx({ policy }));
  assert.equal(refusal?.code, "evidence");
  assert.match(refusal!.message, /report it as unverifiable instead/);

  // Cited but failing: refused at the commit boundary, from Argus's report.
  assert.match(
    holdsPolicyRefusal(
      v("RULE-42", 1),
      "holds",
      [{ type: "check", label: "t", status: "failed" }],
      policy,
    ) ?? "",
    /requires a passing deterministic check/,
  );
  assert.equal(
    holdsPolicyRefusal(
      v("RULE-42", 1),
      "holds",
      [{ type: "check", label: "t", status: "passed" }],
      policy,
    ),
    null,
  );
  // Violated and unverifiable are never subject to the holds policy.
  assert.equal(
    holdsPolicyRefusal(v("RULE-42", 1), "violated", [{ type: "observation", note: "x" }], policy),
    null,
  );
  // And under the default policy, an observation is enough for holds.
  assert.equal(await checkRuleVerification(noCheck, null, ctx()), null);
});

// ── Source evidence and symlink containment ─────────────────────────────────

test("source evidence must be a real file inside the repository", async () => {
  const { repo } = makeRepo();
  const good = report({
    schemaVersion: 1,
    verifications: [
      { rule: "RULE-42:v1", outcome: "holds", evidence: [sourceEvidence({ gitHead: HEAD_A })] },
    ],
  });
  assert.equal(await checkRuleVerification(good, null, ctx({ repoRoot: repo })), null);

  const ghost = report({
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "holds",
        evidence: [sourceEvidence({ path: "src/Booking/Ghost.cs" })],
      },
    ],
  });
  const refusal = await checkRuleVerification(ghost, null, ctx({ repoRoot: repo }));
  assert.equal(refusal?.code, "source-evidence");
  assert.match(refusal!.message, /does not exist in the run's repository/);
});

test("source evidence at a commit other than the one Argus recorded is refused", async () => {
  const r = report({
    schemaVersion: 1,
    verifications: [
      { rule: "RULE-42:v1", outcome: "holds", evidence: [sourceEvidence({ gitHead: HEAD_B })] },
    ],
  });
  const refusal = await checkRuleVerification(r, null, ctx({ gitHead: HEAD_A }));
  assert.equal(refusal?.code, "source-evidence");
  assert.match(refusal!.message, /but the run was recorded at/);
});

test("a repository-internal symlink pointing outside the repository is not valid evidence", async () => {
  const { repo, outside } = makeRepo();
  // Every lexical rule is satisfied — the path is repository-relative, has no
  // `..`, and stats happily — and the bytes are not in the repository at all.
  symlinkSync(path.join(outside, "secrets.txt"), path.join(repo, "src", "Booking", "Escape.cs"));
  const escaped = await resolveRepositoryFile(repo, "src/Booking/Escape.cs");
  assert.deepEqual(escaped, { ok: false, reason: "unsafe" });

  const r = report({
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "holds",
        evidence: [sourceEvidence({ path: "src/Booking/Escape.cs" })],
      },
    ],
  });
  const refusal = await checkRuleVerification(r, null, ctx({ repoRoot: repo }));
  assert.equal(refusal?.code, "source-evidence");
  assert.match(refusal!.message, /resolves outside the run's repository/);
});

test("a symlinked directory inside the scope cannot smuggle a path out either", async () => {
  const { repo, outside } = makeRepo();
  mkdirSync(path.join(outside, "nested"), { recursive: true });
  writeFileSync(path.join(outside, "nested", "Other.cs"), "// outside\n");
  symlinkSync(path.join(outside, "nested"), path.join(repo, "src", "Booking", "link"));
  assert.deepEqual(await resolveRepositoryFile(repo, "src/Booking/link/Other.cs"), {
    ok: false,
    reason: "unsafe",
  });
});

test("a repository reached through a symlink is still its own root", async () => {
  const { repo } = makeRepo();
  const alias = path.join(mkdtempSync(path.join(tmpdir(), "argus-verify-alias-")), "repo");
  symlinkSync(repo, alias);
  // Every path inside it resolves to the real tree, which is the same tree.
  const verdict = await resolveRepositoryFile(alias, "src/Booking/KobraAdapter.cs");
  assert.equal(verdict.ok, true);
});

test("a directory is not a file, and an escaping declared path never gets that far", async () => {
  const { repo } = makeRepo();
  assert.deepEqual(await resolveRepositoryFile(repo, "src/Booking"), {
    ok: false,
    reason: "not-a-file",
  });
  assert.deepEqual(await resolveRepositoryFile(repo, "../outside.txt"), {
    ok: false,
    reason: "unsafe",
  });
  assert.deepEqual(await resolveRepositoryFile(repo, "/etc/passwd"), {
    ok: false,
    reason: "unsafe",
  });
});

// ── The delta a verification phase may not write ────────────────────────────

test("a verification phase's delta may not oppose a rule it was supplied to verify", async () => {
  const { validateKnowledgeDelta } = await import("./delta.js");
  const { verificationDeltaRefusal } = await import("./ruleVerification.js");
  const selected = [v("RULE-42", 1)];

  const opposing = validateKnowledgeDelta({
    schemaVersion: 1,
    evidence: [
      {
        claim: "RULE-42:v1",
        direction: "opposes",
        source: { type: "source-code", path: "src/Booking/KobraAdapter.cs" },
        note: "the validator allows 500",
      },
    ],
  });
  const refusal = verificationDeltaRefusal(opposing, selected);
  assert.match(refusal ?? "", /attaches opposing evidence to RULE-42:v1/);
  assert.match(refusal ?? "", /not a reason to doubt the rule/);

  const opposingJustification = validateKnowledgeDelta({
    schemaVersion: 1,
    claims: [{ localId: "obs", kind: "fact", statement: "The validator allows 500" }],
    justifications: [
      { conclusion: "RULE-42:v1", premises: [{ local: "obs" }], direction: "opposes" },
    ],
  });
  assert.match(
    verificationDeltaRefusal(opposingJustification, selected) ?? "",
    /justifies against RULE-42:v1/,
  );
});

test("the guard is narrow: supporting evidence, other rules and new claims are untouched", async () => {
  const { validateKnowledgeDelta } = await import("./delta.js");
  const { verificationDeltaRefusal } = await import("./ruleVerification.js");
  const selected = [v("RULE-42", 1)];

  // Supporting evidence on the verified rule: fine.
  assert.equal(
    verificationDeltaRefusal(
      validateKnowledgeDelta({
        schemaVersion: 1,
        evidence: [{ claim: "RULE-42:v1", source: { type: "human", who: "owner" } }],
      }),
      selected,
    ),
    null,
  );
  // Opposing evidence on a rule this run was NOT asked to verify: not this
  // phase's business, and `opposes` stays a legitimate Phase 1 concept.
  assert.equal(
    verificationDeltaRefusal(
      validateKnowledgeDelta({
        schemaVersion: 1,
        evidence: [
          { claim: "RULE-99:v1", direction: "opposes", source: { type: "human", who: "owner" } },
        ],
      }),
      selected,
    ),
    null,
  );
  // A run supplied no rules has nothing to contaminate.
  assert.equal(
    verificationDeltaRefusal(
      validateKnowledgeDelta({
        schemaVersion: 1,
        evidence: [
          { claim: "RULE-42:v1", direction: "opposes", source: { type: "human", who: "owner" } },
        ],
      }),
      [],
    ),
    null,
  );
});

// ── The review projection ───────────────────────────────────────────────────

test("the preview groups by outcome and shows the rule's own support beside it", () => {
  const ledger = supportedRule();
  const r = report({
    schemaVersion: 1,
    verifications: [
      {
        rule: "RULE-42:v1",
        outcome: "violated",
        evidence: [
          { type: "source-code", path: "src/Booking/KobraAdapter.cs", startLine: 3, endLine: 8 },
        ],
        note: "the adapter allows 500",
      },
    ],
    metadata: { summary: "One rule checked against the Kobra adapter." },
  });
  const preview = previewRuleVerification(stagedRecord(r), ledger);
  assert.equal(preview.holds.length, 0);
  assert.equal(preview.unverifiable.length, 0);
  assert.equal(preview.violated.length, 1);
  const row = preview.violated[0];
  assert.equal(row.ref, "RULE-42:v1");
  assert.equal(row.statement, "Kobra customer comments must not exceed 180 characters.");
  // The whole point of the row: the rule stands, the code does not.
  assert.equal(row.support, "supported");
  assert.equal(row.lifecycle, "active");
  assert.equal(row.outcome, "violated");
  assert.equal(preview.gitHead, HEAD_A);
  assert.deepEqual(preview.missing, []);
  assert.equal(preview.summary, "One rule checked against the Kobra adapter.");
});

test("the preview names a selected rule with no submitted outcome", () => {
  const r = report({ schemaVersion: 1, verifications: [] });
  const preview = previewRuleVerification(
    stagedRecord(r, { status: "rejected", selected: [v("RULE-42", 1)] }),
    supportedRule(),
  );
  assert.deepEqual(preview.missing, ["RULE-42:v1"]);
});

test("the summary counts each outcome, and says whether a decision is outstanding", () => {
  const r = report({
    schemaVersion: 1,
    verifications: [
      { rule: "RULE-42:v1", outcome: "holds", evidence: [{ type: "observation", note: "a" }] },
    ],
  });
  const preview = previewRuleVerification(stagedRecord(r), supportedRule());
  assert.deepEqual(summarizeRuleVerification([preview], true), {
    selected: 1,
    holds: 1,
    violated: 0,
    unverifiable: 0,
    requiresReview: true,
  });
  assert.equal(describeReport(r), "1 holds");
});

// ── The agent-facing contract ───────────────────────────────────────────────

test("the instruction names the exact rules and the phase's holds policy", () => {
  const strict = verificationInstruction({ holds: "deterministic-check" }, [v("RULE-42", 1)]);
  assert.match(strict, /Business-rule verification/);
  assert.match(strict, /Rules to verify: RULE-42:v1/);
  assert.match(strict, /requires a passing deterministic check for holds/);
  const lenient = verificationInstruction({}, [v("RULE-42", 1)]);
  assert.match(lenient, /must cite concrete evidence/);
  // And the contract says outright that a breach is not a reason to doubt the
  // rule — the one thing an agent gets wrong by default.
  assert.match(RULE_VERIFICATION_CONTRACT, /does not mean the rule/);
  // No policy, no instruction: an ordinary phase's prompt is untouched.
  assert.equal(verificationInstruction(undefined, [v("RULE-42", 1)]), "");
});
