/**
 * Change-intent orchestration, end to end, with real child processes (Phase 7).
 *
 * Like `verificationE2e.test.ts` this injects no spawn double: `ARGUS_CLAUDE_BIN`
 * points at `fakeAgent.mjs`, the real `defaultPipelineSpawn` starts it, and the
 * real Stop hook POSTs the completion signal over HTTP. The only thing faked is
 * the agent's *judgement* — which is exactly the part Argus must not be
 * trusting anyway.
 *
 * The scenario is the one the phase was designed around:
 *
 *   RULE-42:v1     "Kobra customer comments must not exceed 180 characters"
 *   CONSTRAINT-8:v1 "Comment validation is enforced server-side"
 *   verification    RULE-42:v1 @<head> holds
 *
 *   request        "Kobra now supports 500-character comments."
 *     ↓ change-intent (gated)
 *   proposal       revise RULE-42 → 500, preserve CONSTRAINT-8, decide,
 *                  AC: 500 accepted / 501 rejected / preserved behaviour kept
 *     ↓ human approves
 *   canonical      RULE-42:v2, DECISION-x:v1, and a durable ChangeProposal
 *     ↓
 *   implementation placeholder receives KnowledgeContext + ChangeContext
 *
 * and the assertion that matters most is what does *not* happen: no code is
 * modified, nothing is re-verified, and before the approval RULE-42:v2 does not
 * exist.
 *
 * POSIX only, for the same reasons as the rest of the harness suite.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LEAK_VAR, artifactDirFor, phaseOf, startHarness, waitForInstance } from "./e2eSupport.js";
import {
  commitPhaseSemantics,
  createClaim,
  createEvidence,
  readLedger,
} from "../knowledge/store.js";
import {
  activeRevision,
  changeProposalOfClaim,
  evaluateSupport,
  getClaim,
  ruleConformance,
} from "../knowledge/kernel.js";
import type { ChangeContext, ClaimRef, KnowledgeContext } from "@argus/contracts";

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
const VALIDATOR_SOURCE = [
  "public static class KobraCommentValidator",
  "{",
  "    public const int MaxLength = 180;",
  "}",
  "",
].join("\n");

const REQUEST = {
  id: "CR-1",
  summary: "Kobra now supports 500-character customer comments.",
  details: "Confirmed with the Kobra integration team.",
  scope: { label: "Kobra comments", paths: ["src/Booking"] },
  requestedBy: "product",
};

/** One canonical rule and one canonical constraint, as an accepted discovery
 *  phase would have left them. */
async function seedKnowledge(): Promise<{ rule: ClaimRef; constraint: ClaimRef }> {
  const now = new Date();
  const out: Record<string, ClaimRef> = {};
  for (const [key, id, kind, statement] of [
    ["rule", "RULE-42", "business-rule", "Kobra customer comments must not exceed 180 characters."],
    ["constraint", "CONSTRAINT-8", "constraint", "Comment validation is enforced server-side."],
  ] as const) {
    const claim = await createClaim({ id, kind, statement }, now);
    await createEvidence(
      {
        claim: { id: claim.id, revision: claim.revision },
        direction: "supports",
        source: { type: "human", who: "Kobra domain owner" },
      },
      now,
    );
    out[key] = { id: claim.id, revision: claim.revision };
  }
  return { rule: out.rule, constraint: out.constraint };
}

test(
  "a requested change becomes reviewed intent, then canonical semantics, and stops there",
  posixOnly,
  async (t) => {
    const h = await startHarness({ git: true });
    t.after(() => h.close());

    const { rule, constraint } = await seedKnowledge();
    await mkdir(path.join(h.cwd, "src", "Booking"), { recursive: true });
    await writeFile(path.join(h.cwd, VALIDATOR), VALIDATOR_SOURCE, "utf8");
    spawnSync("git", ["add", "-A"], { cwd: h.cwd, stdio: "ignore" });
    spawnSync("git", ["commit", "-q", "-m", "validator caps comments at 180"], {
      cwd: h.cwd,
      stdio: "ignore",
    });
    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: h.cwd,
      encoding: "utf8",
    }).stdout.trim();

    // The implementation conforms to the rule *today*: the change is requested
    // because the business changed, not because the code is wrong.
    await commitPhaseSemantics(
      [],
      [
        {
          execution: { runId: "run-earlier", instanceId: "inst-earlier", phaseId: "verify" },
          rule,
          outcome: "holds",
          evidence: [{ type: "observation", note: "MaxLength is 180" }],
          gitHead: head,
        },
      ],
      new Date(),
    );

    const def = await h.seed([
      {
        id: "change-intent",
        name: "Change intent",
        gated: true,
        steps: [
          {
            name: "reason",
            prompt: [
              "Work out what the requested change means for the domain.",
              // The agent reads ARGUS_CHANGE_REQUEST_FILE and the context, and
              // answers for the rules it was given: no prompt could name the
              // canonical refs, which is the point.
              "FAKE: propose-change 500 Kobra raised its comment limit to 500.",
            ].join("\n"),
          },
        ],
        knowledgeContext: {
          claims: [
            { id: "RULE-42", revision: "active" },
            { id: "CONSTRAINT-8", revision: "active" },
          ],
        },
        changeIntent: { request: REQUEST },
      },
      {
        id: "implement-placeholder",
        name: "Implement (placeholder)",
        needs: ["change-intent"],
        steps: [
          {
            name: "build",
            prompt: [
              "You would implement the accepted change here. Phase 7 stops before that.",
              "FAKE: read-change-context change-context.json",
              "FAKE: read-context knowledge-context.json",
            ].join("\n"),
          },
        ],
        knowledgeContext: { fromPhases: [{ phaseId: "change-intent" }] },
        changeContext: { fromPhase: "change-intent" },
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    const parked = await waitForInstance(
      started.id,
      (i) => i.phases[0].status === "awaiting-approval",
      "the change-intent phase to park at its gate",
    );

    // ── Before approval: reviewed intent, and nothing else ──────────────────
    const staged = await readLedger();
    assert.equal(getClaim(staged, { id: "RULE-42", revision: 2 }), null, "RULE-42:v2 is absent");
    assert.equal(activeRevision(staged, "RULE-42")?.revision, 1);
    assert.equal(
      staged.claims.some((c) => c.kind === "decision"),
      false,
    );
    assert.deepEqual(staged.changeProposals, []);
    assert.equal(phaseOf(parked, "implement-placeholder").status, "pending");

    const summary = phaseOf(parked, "change-intent").changeIntent;
    assert.equal(summary?.requestId, "CR-1");
    assert.equal(summary?.readiness, "ready");
    assert.equal(summary?.revised, 1);
    assert.equal(summary?.decisions, 1);
    assert.equal(summary?.preserved, 1);
    assert.equal(summary?.acceptanceCriteria, 3);
    assert.equal(summary?.requiresReview, true);

    // ── A human approves ───────────────────────────────────────────────────
    await h.engine.approve(started.id);
    const done = await waitForInstance(
      started.id,
      (i) => i.status !== "running",
      "the instance to settle after approval",
    );
    assert.equal(done.status, "succeeded", JSON.stringify(phaseOf(done, "change-intent").payload));

    const ledger = await readLedger();
    // The rule was revised, not duplicated.
    assert.match(activeRevision(ledger, "RULE-42")!.statement, /500 characters/);
    assert.deepEqual(
      ledger.claims.filter((c) => c.id === "RULE-42").map((c) => c.revision),
      [1, 2],
    );
    // The constraint was preserved without a revision.
    assert.deepEqual(
      ledger.claims.filter((c) => c.id === "CONSTRAINT-8").map((c) => c.revision),
      [1],
    );
    const decision = ledger.claims.find((c) => c.kind === "decision")!;
    assert.equal(evaluateSupport(ledger, { id: decision.id, revision: 1 }), "supported");

    // The durable change provenance: request → proposal → exact revisions.
    assert.equal(ledger.changeProposals.length, 1);
    const accepted = ledger.changeProposals[0];
    assert.equal(accepted.request.summary, REQUEST.summary);
    assert.equal(accepted.readiness, "ready");
    assert.deepEqual(accepted.revised, [{ from: rule, to: { id: "RULE-42", revision: 2 } }]);
    assert.deepEqual(accepted.preserved, [constraint]);
    assert.deepEqual(accepted.decisions, [{ id: decision.id, revision: 1 }]);
    assert.deepEqual(
      accepted.acceptanceCriteria.map((c) => [c.kind, c.relatesTo]),
      [
        ["behavior", [{ id: "RULE-42", revision: 2 }]],
        ["behavior", [{ id: "RULE-42", revision: 2 }]],
        ["regression", [constraint]],
      ],
    );
    assert.equal(changeProposalOfClaim(ledger, { id: "RULE-42", revision: 2 })?.id, accepted.id);

    // ── The downstream run received the accepted intent ─────────────────────
    const dir = artifactDirFor(started.id, "implement-placeholder");
    const context = JSON.parse(
      await readFile(path.join(dir, "change-context.json"), "utf8"),
    ) as ChangeContext;
    assert.equal(context.proposalId, accepted.id);
    assert.equal(context.request.summary, REQUEST.summary);
    assert.deepEqual(context.semanticChanges, accepted.semanticChanges);
    assert.deepEqual(context.preserved, [constraint]);
    assert.equal(context.acceptanceCriteria.length, 3);
    assert.equal(context.unresolved.length, 0);

    // …alongside what the domain now says, on its own channel.
    const knowledge = JSON.parse(
      await readFile(path.join(dir, "knowledge-context.json"), "utf8"),
    ) as KnowledgeContext;
    assert.ok(
      knowledge.claims.some((c) => c.ref === "RULE-42:v2" && /500 characters/.test(c.statement)),
    );
    assert.ok(knowledge.claims.some((c) => c.id === decision.id));
    // References, not restatements: the change context names revisions, and the
    // KnowledgeContext is where their sentences live. (Acceptance criteria are
    // the change's own prose and do belong here — they are not claims.)
    assert.equal(
      (await readFile(path.join(dir, "change-context.json"), "utf8")).includes(
        "must not exceed 500 characters",
      ),
      false,
    );

    // ── Phase 7 stops before implementation ────────────────────────────────
    assert.equal(await readFile(path.join(h.cwd, VALIDATOR), "utf8"), VALIDATOR_SOURCE);
    // Nothing was re-verified, and the old conformance result stands, bound to
    // the revision it was about.
    assert.equal(ledger.verifications.length, 1);
    assert.deepEqual(ledger.verifications[0].rule, rule);
    assert.equal(ruleConformance(ledger, rule, head).status, "holds");
    // The new revision inherits nothing: nobody has verified RULE-42:v2.
    assert.equal(
      ruleConformance(ledger, { id: "RULE-42", revision: 2 }, head).status,
      "unverified",
    );
  },
);
