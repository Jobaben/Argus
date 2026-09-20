/**
 * Business-rule verification, end to end, with real child processes (Phase 6).
 *
 * Like `e2e.test.ts` this injects no spawn double: `ARGUS_CLAUDE_BIN` points at
 * `fakeAgent.mjs`, the real `defaultPipelineSpawn` starts it, and the real Stop
 * hook POSTs the completion signal over HTTP to the real signal route. The only
 * thing faked is the agent's *judgement* — which is exactly the part Argus must
 * not be trusting anyway.
 *
 * The scenario is the one the phase was designed around:
 *
 *   RULE-42:v1  "Kobra customer comments must not exceed 180 characters"
 *
 *   implementation enforces 180   → verify → RULE-42:v1 @abc123 holds
 *   implementation changed to 500 → verify → RULE-42:v1 @def456 violated
 *
 * and the assertion that matters most is what does *not* change: after the
 * second run the rule is still `supported`. A bug in the code is not a doubt
 * about the domain.
 *
 * POSIX only, for the same reasons as the rest of the harness suite.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LEAK_VAR, phaseOf, startHarness, waitForInstance } from "./e2eSupport.js";
import { createClaim, createEvidence, createRevision, readLedger } from "../knowledge/store.js";
import { evaluateSupport, formatClaimRef, ruleConformance } from "../knowledge/kernel.js";
import type { ClaimRef } from "@argus/contracts";

after(() => {
  delete process.env.ARGUS_CLAUDE_BIN;
  delete process.env.ARGUS_TOKEN;
  delete process.env[LEAK_VAR];
});

const posixOnly = {
  skip:
    process.platform === "win32"
      ? "POSIX only: this suite relies on process groups, shell hooks and signals"
      : false,
};

const VALIDATOR = "src/Booking/KobraCommentValidator.cs";

function validatorSource(max: number): string {
  return [
    "public static class KobraCommentValidator",
    "{",
    `    public const int MaxLength = ${max};`,
    "",
    "    public static bool IsValid(string comment) =>",
    "        comment is null || comment.Length <= MaxLength;",
    "}",
    "",
  ].join("\n");
}

async function writeValidator(cwd: string, max: number): Promise<void> {
  await mkdir(path.join(cwd, "src", "Booking"), { recursive: true });
  await writeFile(path.join(cwd, VALIDATOR), validatorSource(max), "utf8");
}

function commitAll(dir: string, message: string): string {
  spawnSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir, stdio: "ignore" });
  return spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
}

/** The canonical rule, as an accepted discovery phase would have left it. */
async function seedRule(statement: string): Promise<ClaimRef> {
  const now = new Date();
  const claim = await createClaim({ id: "RULE-42", kind: "business-rule", statement }, now);
  await createEvidence(
    {
      claim: { id: claim.id, revision: claim.revision },
      direction: "supports",
      source: { type: "human", who: "Kobra domain owner" },
    },
    now,
  );
  return { id: claim.id, revision: claim.revision };
}

test(
  "a real verification agent answers for the rule it was supplied, at the commit it ran on",
  posixOnly,
  async (t) => {
    const h = await startHarness({ git: true });
    t.after(() => h.close());

    const rule = await seedRule("Kobra customer comments must not exceed 180 characters.");
    await writeValidator(h.cwd, 180);
    const headHolds = commitAll(h.cwd, "validator caps comments at 180");

    const def = await h.seed([
      {
        id: "verify-rules",
        name: "Verify rules",
        steps: [
          {
            name: "verify",
            prompt: [
              "Check the implementation against the business rules you were given.",
              // The agent reads ARGUS_KNOWLEDGE_CONTEXT_FILE and answers for every
              // rule in it: no prompt could name the refs, which is the point.
              `FAKE: verify-context holds ${VALIDATOR} check:comment-length-tests MaxLength is 180 and IsValid enforces it`,
            ].join("\n"),
          },
        ],
        knowledgeContext: { claims: [{ id: "RULE-42", revision: "active" }] },
        ruleVerification: { holds: "deterministic-check" },
        checks: [
          {
            kind: "command",
            run: `grep -q "MaxLength = 180" ${VALIDATOR}`,
            label: "comment-length-tests",
          },
        ],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const inst = await waitForInstance(
      started.id,
      (i) => i.status !== "running",
      "the verification instance to settle",
    );
    assert.equal(inst.status, "succeeded", JSON.stringify(phaseOf(inst, "verify-rules").payload));
    assert.equal(phaseOf(inst, "verify-rules").verification?.status, "passed");
    assert.deepEqual(phaseOf(inst, "verify-rules").ruleVerification, {
      selected: 1,
      holds: 1,
      violated: 0,
      unverifiable: 0,
      requiresReview: false,
    });

    const afterHolds = await readLedger();
    assert.equal(afterHolds.verifications.length, 1);
    const held = afterHolds.verifications[0];
    assert.deepEqual(held.rule, rule);
    assert.equal(held.outcome, "holds");
    assert.equal(held.repository?.gitHead, headHolds);
    // The agent named the check; Argus bound what actually happened to it.
    const citedCheck = held.evidence.find((e) => e.type === "check");
    assert.ok(citedCheck && citedCheck.type === "check");
    assert.equal(citedCheck.label, "comment-length-tests");
    assert.equal(citedCheck.status, "passed");
    assert.equal(citedCheck.exitCode, 0);
    assert.equal(ruleConformance(afterHolds, rule, headHolds).status, "holds");

    // ── The implementation regresses, the rule does not change ──────────────
    await writeValidator(h.cwd, 500);
    const headViolated = commitAll(h.cwd, "validator now allows 500");
    assert.notEqual(headHolds, headViolated);

    // Before re-verifying: the new commit is unverified, not "holds".
    assert.equal(ruleConformance(afterHolds, rule, headViolated).status, "unverified");

    const def2 = await h.seed([
      {
        id: "verify-rules",
        name: "Verify rules",
        steps: [
          {
            name: "verify",
            prompt: [
              "Check the implementation against the business rules you were given.",
              `FAKE: verify-context violated ${VALIDATOR} MaxLength is 500, so a 400-character comment is accepted`,
            ].join("\n"),
          },
        ],
        knowledgeContext: { claims: [{ id: "RULE-42", revision: "active" }] },
        ruleVerification: {},
      },
    ]);
    const second = await h.engine.start(def2.id, "manual");
    assert.ok(second);
    const inst2 = await waitForInstance(
      second.id,
      (i) => i.status !== "running",
      "the second verification instance to settle",
    );
    assert.equal(inst2.status, "succeeded", JSON.stringify(phaseOf(inst2, "verify-rules").payload));

    const ledger = await readLedger();
    // THE assertion of Phase 6: the code is in breach, the rule is not in doubt.
    assert.equal(evaluateSupport(ledger, rule), "supported");
    assert.equal(
      ledger.evidence.some((e) => e.direction === "opposes"),
      false,
      "a violated implementation must never create opposing evidence on the rule",
    );
    assert.equal(ruleConformance(ledger, rule, headViolated).status, "violated");
    // Both commits coexist; no history was rewritten.
    assert.equal(ruleConformance(ledger, rule, headHolds).status, "holds");
    assert.deepEqual(
      ledger.verifications.map((v) => [v.repository?.gitHead, v.outcome]),
      [
        [headHolds, "holds"],
        [headViolated, "violated"],
      ],
    );

    // ── The business changes: a new revision starts unverified ──────────────
    const v2 = await createRevision(
      "RULE-42",
      {
        statement: "Kobra customer comments must not exceed 500 characters.",
        revisionNote: "Kobra raised the limit",
      },
      new Date(),
    );
    const afterRevision = await readLedger();
    const v2Ref = { id: v2.id, revision: v2.revision };
    assert.equal(ruleConformance(afterRevision, v2Ref, headViolated).status, "unverified");
    // And v1's history is untouched, still bound to v1.
    assert.equal(ruleConformance(afterRevision, rule, headViolated).status, "violated");
    assert.deepEqual(
      afterRevision.verifications.map((v) => formatClaimRef(v.rule)),
      ["RULE-42:v1", "RULE-42:v1"],
    );

    const def3 = await h.seed([
      {
        id: "verify-rules",
        name: "Verify rules",
        steps: [
          {
            name: "verify",
            prompt: [
              "Check the implementation against the business rules you were given.",
              `FAKE: verify-context holds ${VALIDATOR} MaxLength is 500, which is what the rule now says`,
            ].join("\n"),
          },
        ],
        knowledgeContext: { claims: [{ id: "RULE-42", revision: "active" }] },
        ruleVerification: {},
      },
    ]);
    const third = await h.engine.start(def3.id, "manual");
    assert.ok(third);
    await waitForInstance(
      third!.id,
      (i) => i.status !== "running",
      "the third verification instance to settle",
    );

    const final = await readLedger();
    assert.equal(ruleConformance(final, v2Ref, headViolated).status, "holds");
    // v1 @ headHolds → holds, v1 @ headViolated → violated, v2 @ headViolated → holds.
    assert.deepEqual(
      final.verifications.map((v) => [formatClaimRef(v.rule), v.repository?.gitHead, v.outcome]),
      [
        ["RULE-42:v1", headHolds, "holds"],
        ["RULE-42:v1", headViolated, "violated"],
        ["RULE-42:v2", headViolated, "holds"],
      ],
    );
    // Through all of it, both revisions of the rule remain supported.
    assert.equal(evaluateSupport(final, rule), "supported");
    assert.equal(evaluateSupport(final, v2Ref), "unsupported");
  },
);

test(
  "a real verification agent that leaves a supplied rule unanswered fails the phase",
  posixOnly,
  async (t) => {
    const h = await startHarness({ git: true });
    t.after(() => h.close());

    await seedRule("Kobra customer comments must not exceed 180 characters.");
    await writeValidator(h.cwd, 180);
    commitAll(h.cwd, "validator");

    const def = await h.seed([
      {
        id: "verify-rules",
        name: "Verify rules",
        steps: [
          {
            name: "verify",
            prompt: [
              "Check the implementation against the business rules you were given.",
              // A well-formed document that simply says nothing about the rule.
              'FAKE: write-verification {"schemaVersion":1,"verifications":[]}',
            ].join("\n"),
          },
        ],
        knowledgeContext: { claims: [{ id: "RULE-42", revision: "active" }] },
        ruleVerification: {},
      },
    ]);
    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const inst = await waitForInstance(
      started.id,
      (i) => i.status !== "running",
      "the instance to settle",
    );
    assert.equal(inst.status, "failed");
    const payload = (phaseOf(inst, "verify-rules").payload ?? {}) as {
      reason?: string;
      failureClass?: string;
    };
    assert.equal(payload.failureClass, "rule-verification");
    assert.match(payload.reason ?? "", /RULE-42:v1 is missing/);
    assert.deepEqual((await readLedger()).verifications, []);
  },
);
