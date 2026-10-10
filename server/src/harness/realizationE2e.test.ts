/**
 * Closed-loop change realization, end to end, with real child processes
 * (Phase 8).
 *
 * Like `changeIntentE2e.test.ts` this injects no spawn double: `ARGUS_CLAUDE_BIN`
 * points at `fakeAgent.mjs`, the real `defaultPipelineSpawn` starts it, the real
 * Stop hook POSTs the completion signal over HTTP, and the phase's deterministic
 * checks are real `node` processes Argus runs itself. The only thing faked is
 * the agent's *judgement* — which is exactly the part Argus must not be trusting.
 *
 * The scenario is the one carried through every phase of the Knowledge Ledger:
 *
 *   RULE-42:v1      "Kobra comments max = 180"          supported, holds @HEAD
 *   CONSTRAINT-8:v1 "Validation is enforced server-side"
 *
 *   request         "Kobra now supports 500-character comments."
 *     ↓ change intent (gated), a human approves
 *   RULE-42:v2      "max = 500"   preserved CONSTRAINT-8:v1
 *   AC-1 500 accepted · AC-2 501 rejected · AC-3 non-Kobra unchanged
 *     ↓ implementation, against KnowledgeContext + ChangeContext + scope
 *   attempt 1       a real defect: 500 is accepted and so is 501
 *     ↓ deterministic checks (syntax, non-Kobra regression) PASS
 *     ↓ verification
 *   RULE-42:v2 → violated · AC-1 satisfied · AC-2 violated · AC-3 satisfied
 *     ↓ targeted remediation, told exactly that
 *   attempt 2       the boundary is enforced
 *     ↓ re-verification
 *   RULE-42:v2 → holds · AC-1 · AC-2 · AC-3 all satisfied
 *   realization     SUCCEEDED, bound to the repository state it examined
 *
 * The assertions that matter most: no LLM-derived claim enters the completion
 * decision, both attempts survive in the durable history, and the rule stays
 * `supported` throughout — a breach is never a doubt.
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
  acceptanceConformance,
  changeRealizationOfPhase,
  evaluateSupport,
  realizationView,
  ruleConformance,
} from "../knowledge/kernel.js";
import type {
  ChangeContext,
  ClaimRef,
  ImplementationScope,
  RemediationContext,
} from "@argus/contracts";

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

const KOBRA = "src/Booking/kobraCommentValidator.mjs";
const LEGACY = "src/Booking/legacyCommentValidator.mjs";

/** The starting implementation: Kobra capped at 180, like the rule says. */
const KOBRA_AT_180 = [
  "export const MaxLength = 180;",
  "export function accepts(n) {",
  "  return n >= 0 && n <= MaxLength;",
  "}",
  "",
].join("\n");

/** The non-Kobra validator the change deliberately preserves. */
const LEGACY_AT_180 = [
  "export const MaxLength = 180;",
  "export function accepts(n) {",
  "  return n >= 0 && n <= MaxLength;",
  "}",
  "",
].join("\n");

/** Two real deterministic checks, deliberately *unrelated to the boundary*:
 *  both modules still parse, and the preserved validator is untouched. They
 *  pass on the defective first attempt, which is the whole point — a green
 *  check suite is not a realized change. */
const SYNTAX_CHECK = [
  "import { accepts as kobra } from '../src/Booking/kobraCommentValidator.mjs';",
  "import { accepts as legacy } from '../src/Booking/legacyCommentValidator.mjs';",
  "if (typeof kobra !== 'function' || typeof legacy !== 'function') process.exit(1);",
  "",
].join("\n");

const REGRESSION_CHECK = [
  "import { MaxLength, accepts } from '../src/Booking/legacyCommentValidator.mjs';",
  "if (MaxLength !== 180) process.exit(1);",
  "if (!accepts(180) || accepts(181)) process.exit(1);",
  "",
].join("\n");

const REQUEST = {
  id: "CR-1",
  summary: "Kobra now supports 500-character customer comments.",
  details: "Confirmed with the Kobra integration team.",
  scope: { label: "Kobra comments", paths: ["src/Booking"] },
  requestedBy: "product",
};

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
        source: { type: "source-code", path: KOBRA },
      },
      now,
    );
    out[key] = { id: claim.id, revision: claim.revision };
  }
  return { rule: out.rule, constraint: out.constraint };
}

test(
  "an accepted business change is implemented, verified, remediated and completed",
  posixOnly,
  async (t) => {
    const h = await startHarness({ git: true });
    t.after(() => h.close());

    const { rule, constraint } = await seedKnowledge();
    await mkdir(path.join(h.cwd, "src", "Booking"), { recursive: true });
    await mkdir(path.join(h.cwd, "scripts"), { recursive: true });
    await writeFile(path.join(h.cwd, KOBRA), KOBRA_AT_180, "utf8");
    await writeFile(path.join(h.cwd, LEGACY), LEGACY_AT_180, "utf8");
    await writeFile(path.join(h.cwd, "scripts", "syntax.mjs"), SYNTAX_CHECK, "utf8");
    await writeFile(path.join(h.cwd, "scripts", "regression.mjs"), REGRESSION_CHECK, "utf8");
    spawnSync("git", ["add", "-A"], { cwd: h.cwd, stdio: "ignore" });
    spawnSync("git", ["commit", "-q", "-m", "validators cap comments at 180"], {
      cwd: h.cwd,
      stdio: "ignore",
    });
    const baseline = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: h.cwd,
      encoding: "utf8",
    }).stdout.trim();

    // The implementation conforms to the rule today: the change is requested
    // because the business changed, not because the code is wrong.
    await commitPhaseSemantics(
      [],
      [
        {
          execution: { runId: "run-baseline", instanceId: "inst-baseline", phaseId: "verify" },
          rule,
          outcome: "holds",
          evidence: [{ type: "source-code", path: KOBRA }],
          gitHead: baseline,
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
        id: "implement",
        name: "Implement",
        needs: ["change-intent"],
        steps: [
          {
            name: "build",
            prompt: [
              "Realize the accepted change in the working tree.",
              // The scope, the change context and the remediation context are
              // all read from the environment: no prompt names a canonical ref.
              "FAKE: read-scope scope.json",
              "FAKE: read-change-context change-context.json",
              // Attempt 1 is deliberately defective; an attempt that finds a
              // RemediationContext corrects it.
              "FAKE: implement-kobra unbounded",
            ].join("\n"),
          },
        ],
        knowledgeContext: { fromPhases: [{ phaseId: "change-intent" }] },
        changeContext: { fromPhase: "change-intent" },
        implementation: { maxAttempts: 2 },
      },
      {
        id: "verify",
        name: "Verify",
        needs: ["implement"],
        steps: [
          {
            name: "check",
            prompt: [
              "Decide whether the implementation satisfies the rules and the accepted criteria.",
              "FAKE: verify-kobra",
            ].join("\n"),
          },
        ],
        knowledgeContext: { fromPhases: [{ phaseId: "change-intent" }] },
        changeContext: { fromPhase: "change-intent" },
        ruleVerification: {},
        acceptanceVerification: { implementationPhase: "implement" },
        checks: [
          { kind: "command", run: "node scripts/syntax.mjs", label: "syntax" },
          { kind: "command", run: "node scripts/regression.mjs", label: "non-kobra-unchanged" },
        ],
      },
    ]);

    const started = await h.engine.start(def.id, "manual");
    assert.ok(started);
    await waitForInstance(
      started.id,
      (i) => i.phases[0].status === "awaiting-approval",
      "the change-intent phase to park at its gate",
    );

    // ── A human approves the intent; the implementation begins ──────────────
    await h.engine.approve(started.id);
    const done = await waitForInstance(
      started.id,
      (i) => i.status !== "running",
      "the realization loop to settle",
      60_000,
    );

    const ledger = await readLedger();
    const accepted = ledger.changeProposals[0];
    assert.ok(accepted, "the change-intent phase should have committed an accepted proposal");

    // ── The implementation run received three separate documents ───────────
    const implDir = artifactDirFor(started.id, "implement");
    const scope = JSON.parse(
      await readFile(path.join(implDir, "scope.json"), "utf8"),
    ) as ImplementationScope;
    const change = JSON.parse(
      await readFile(path.join(implDir, "change-context.json"), "utf8"),
    ) as ChangeContext;
    assert.equal(scope.proposalId, accepted.id);
    assert.equal(change.proposalId, accepted.id);
    // Deterministic scope from provenance Argus already held: the file the
    // rule's own evidence points at, and the request's declared paths.
    assert.ok(scope.targets.some((x) => x.path === KOBRA));
    assert.ok(
      scope.targets
        .find((x) => x.path === KOBRA)!
        .reasons.some((r) => r.code === "source-code-evidence"),
    );
    assert.deepEqual(scope.requestedPaths, ["src/Booking"]);
    assert.equal(scope.completeness, "known-targets");
    // References, not restatements: the scope never repeats what a rule says.
    assert.equal(JSON.stringify(scope).includes("must not exceed"), false);

    // ── The loop converged ─────────────────────────────────────────────────
    const realization = changeRealizationOfPhase(ledger, started.id, "implement");
    assert.ok(realization, "the implementation phase should have opened a realization");
    const view = realizationView(realization);
    assert.equal(
      view.status,
      "succeeded",
      `realization ended ${view.status}: ${realization.outcome?.reason}`,
    );
    assert.equal(done.status, "succeeded");

    // MANDATORY: both attempts are in the durable history, unrewritten.
    assert.equal(realization.attempts.length, 2);
    assert.deepEqual(
      realization.attempts.map((a) => [a.attempt, a.kind, a.outcome]),
      [
        // The class names the *most fundamental* unmet dimension: the rule is
        // violated and AC-2 with it, and remediating the rule is what fixes
        // both. Both facts are recorded in full below.
        [1, "implementation", "rule-violation"],
        [2, "remediation", "succeeded"],
      ],
    );
    const [first, second] = realization.attempts;
    // Attempt 1: the rule was violated and AC-2 with it; AC-1 and AC-3 held.
    assert.deepEqual(
      first.ruleResults.map((r) => [`${r.rule.id}:v${r.rule.revision}`, r.outcome]),
      [["RULE-42:v2", "violated"]],
    );
    assert.deepEqual(
      first.acceptanceResults.map((r) => [r.criterionId, r.outcome]),
      [
        ["AC-1", "satisfied"],
        ["AC-2", "violated"],
        ["AC-3", "satisfied"],
      ],
    );
    // …and its deterministic checks passed, which is exactly why a green check
    // suite can never be the completion test.
    assert.equal(first.technical?.status, "passed");
    assert.deepEqual(new Set(first.technical!.passed), new Set(["syntax", "non-kobra-unchanged"]));
    // Attempt 2: every dimension held.
    assert.deepEqual(
      second.ruleResults.map((r) => r.outcome),
      ["holds"],
    );
    assert.deepEqual(
      second.acceptanceResults.map((r) => r.outcome),
      ["satisfied", "satisfied", "satisfied"],
    );

    // ── The remediation was told exactly what was unmet ─────────────────────
    const remediation = JSON.parse(
      await readFile(path.join(implDir, "remediation-seen.json"), "utf8"),
    ) as RemediationContext;
    assert.equal(remediation.attempt, 2);
    assert.equal(remediation.realizationId, realization.id);
    assert.equal(remediation.previousOutcome, "rule-violation");
    assert.deepEqual(
      remediation.failedCriteria.map((c) => [c.criterionId, c.outcome]),
      [["AC-2", "violated"]],
    );
    assert.deepEqual(
      remediation.failedRules.map((r) => [r.ref, r.outcome]),
      [["RULE-42:v2", "violated"]],
    );
    // And what already held, so the fix does not undo it.
    assert.ok(remediation.satisfied.criteria.includes(`${accepted.id}/AC-1`));
    assert.ok(remediation.satisfied.criteria.includes(`${accepted.id}/AC-3`));

    // ── The implementation really changed the code ─────────────────────────
    const finalSource = await readFile(path.join(h.cwd, KOBRA), "utf8");
    assert.match(finalSource, /MaxLength = 500/);
    assert.match(finalSource, /n <= MaxLength/);
    // …and the preserved, non-Kobra validator is untouched.
    assert.equal(await readFile(path.join(h.cwd, LEGACY), "utf8"), LEGACY_AT_180);

    // ── The durable semantic record ────────────────────────────────────────
    const after = await readLedger();
    const v2 = { id: "RULE-42", revision: 2 };
    // Four accepted conformance results: the baseline on v1, and one per
    // attempt on v2 — none of them rewritten.
    assert.deepEqual(
      after.verifications.map((v) => [`${v.rule.id}:v${v.rule.revision}`, v.outcome]),
      [
        ["RULE-42:v1", "holds"],
        ["RULE-42:v2", "violated"],
        ["RULE-42:v2", "holds"],
      ],
    );
    assert.equal(after.acceptanceVerifications.length, 6);
    assert.equal(
      after.acceptanceVerifications.filter((v) => v.outcome === "violated").length,
      1,
      "attempt 1's violated AC-2 is still there",
    );
    // The success is bound to the repository state that was actually examined.
    const state = realization.outcome!.repository!;
    assert.ok(state.gitHead);
    assert.equal(ruleConformance(after, v2, state.gitHead).status, "holds");
    assert.equal(acceptanceConformance(after, accepted.id, "AC-2", state).status, "satisfied");
    // Every acceptance result names the same state the rule verification did.
    for (const v of after.acceptanceVerifications.filter(
      (x) => x.execution.runId === second.verification[0].runId,
    )) {
      assert.deepEqual(v.repository, state);
    }

    // MANDATORY REGRESSION: a violated implementation never contests the rule.
    assert.equal(evaluateSupport(after, v2), "supported");
    assert.equal(evaluateSupport(after, constraint), "supported");
    assert.equal(
      after.evidence.some((e) => e.direction === "opposes"),
      false,
    );

    // ── No LLM-derived claim entered the completion decision ───────────────
    // The attempt's verdict is computed from the ledger's own records and
    // Argus's own check report; the only agent-authored inputs are the
    // outcomes themselves, each of which had to be complete and cite evidence.
    assert.equal(realization.outcome!.unmetRules.length, 0);
    assert.equal(realization.outcome!.unmetCriteria.length, 0);
    assert.match(realization.outcome!.reason, /every targeted rule holds/);

    // ── Provenance: CP → run → file ────────────────────────────────────────
    const produced = after.artifacts.filter(
      (a) => a.execution.runId === second.implementation[0].runId,
    );
    assert.deepEqual(
      produced.map((a) => a.artifact.path),
      [KOBRA],
      "the implementation run declared the file it produced",
    );
    assert.equal(phaseOf(done, "implement").realization?.attempt, 2);
  },
);
