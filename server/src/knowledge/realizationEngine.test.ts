import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AcceptanceVerificationRecord,
  ChangeRealization,
  PhaseFailurePayload,
  PipelineInstance,
} from "@argus/contracts";
import { createEngine } from "../pipelineEngine.js";
import type { Engine } from "../pipelineEngine.js";
import { createPipeline, readPipelines, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance } from "../sources/instances.js";
import { readInvocation } from "../sources/runs.js";
import { buildPhaseReview } from "../sources/artifacts.js";
import { readJournal } from "../sources/journal.js";
import { readAcceptanceRecord } from "./acceptanceStaging.js";
import { createClaim, createEvidence, createRevision, readLedger } from "./store.js";
import {
  acceptanceConformance,
  changeRealizationOfPhase,
  evaluateSupport,
  realizationView,
  ruleConformance,
} from "./kernel.js";

/**
 * Closed-loop change realization through the engine (Phase 8).
 *
 * The whole loop on a real repository fixture, a real gate and the real
 * transitions:
 *
 *   accepted ChangeProposal → implementation run (scope + change context)
 *     → deterministic checks → verification run (rules + criteria)
 *     → the completion invariant → success, targeted remediation, or a
 *       terminal, explained failure
 *
 * Every assertion is on the ledger on disk, the staged records, the persisted
 * instance or the review payload. The agent is a spawn double whose "work" is
 * the test writing the protocol files before signalling, so nothing here
 * depends on a model: every binding, refusal, verdict and transition is
 * computed by Argus.
 */

let home: string;
let repo: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-realize-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
  repo = makeRepo();
});

const NOW = new Date("2026-09-20T10:00:00.000Z");
let counter = 0;

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
function git(dir: string, ...args: string[]) {
  return spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], {
    cwd: dir,
    stdio: "ignore",
  });
}

const VALIDATOR = "src/Booking/KobraCommentValidator.cs";

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-realize-repo-"));
  mkdirSync(path.join(dir, "src", "Booking"), { recursive: true });
  writeFileSync(path.join(dir, VALIDATOR), "public const int MaxLength = 180;\n");
  if (gitAvailable()) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

interface Spawned {
  runId: string;
  env: Record<string, string>;
  cwd: string;
}

function recordingSpawn() {
  const calls: Spawned[] = [];
  const spawn = (run: { id: string; cwd: string }, _log: string, env: Record<string, string>) => {
    calls.push({ runId: run.id, env, cwd: run.cwd });
    return { pid: 3000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}

function engine(spawn: ReturnType<typeof recordingSpawn>["spawn"]) {
  return createEngine({
    now: () => new Date(),
    newId: () => `id-${++counter}`,
    spawn,
    signalUrlBase: "http://localhost:7779",
    // Generous: the spawn double's processes never "finish", so every run of
    // the suite holds its concurrency slot for the whole test.
    maxConcurrent: 64,
    tickMs: 30000,
    parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
  });
}

async function seedPipeline(phases: Record<string, unknown>[]) {
  return createPipeline(
    validatePipelineInput({
      name: "realization",
      trigger: null,
      phases: phases.map((p) => ({ cwd: repo, gated: false, ...p })),
    }),
    NOW,
    "p1",
  );
}

/** The canonical starting state: RULE-42 at 180, CONSTRAINT-8 server-side. */
async function seedKnowledge() {
  for (const [id, kind, statement] of [
    ["RULE-42", "business-rule", "Kobra customer comments must not exceed 180 characters."],
    ["CONSTRAINT-8", "constraint", "Comment validation is enforced server-side."],
  ] as const) {
    const claim = await createClaim({ id, kind, statement }, NOW);
    await createEvidence(
      {
        claim: { id, revision: claim.revision },
        direction: "supports",
        source: { type: "human", who: "domain owner" },
      },
      NOW,
    );
  }
}

const CRITERIA = [
  {
    id: "AC-1",
    statement: "A Kobra comment of 500 characters is accepted.",
    kind: "behavior",
    relatesTo: [{ local: "r42" }],
  },
  {
    id: "AC-2",
    statement: "A Kobra comment of 501 characters is rejected.",
    kind: "behavior",
    relatesTo: [{ local: "r42" }],
  },
  {
    id: "AC-3",
    statement: "Non-Kobra comment limits are unchanged.",
    kind: "regression",
    relatesTo: ["CONSTRAINT-8:v1"],
  },
];

const CHANGE_PROPOSAL = {
  schemaVersion: 1,
  semanticDelta: {
    schemaVersion: 1,
    revisions: [
      {
        claimId: "RULE-42",
        expectedRevision: 1,
        localId: "r42",
        statement: "Kobra customer comments must not exceed 500 characters.",
        revisionNote: "Kobra raised its limit.",
      },
    ],
    evidence: [
      {
        claim: { local: "r42" },
        source: { type: "document", uri: "argus:change-request/CR-1", title: "Kobra 500" },
      },
    ],
  },
  preserved: ["CONSTRAINT-8:v1"],
  classification: [{ rule: "RULE-42:v1", disposition: "revised" }],
  acceptanceCriteria: CRITERIA,
  metadata: { summary: "Raise the Kobra comment limit to 500." },
};

/** The standard three-phase realization pipeline. */
function realizationPipeline(over: Record<string, unknown> = {}) {
  return [
    {
      id: "change-intent",
      name: "Change intent",
      gated: true,
      steps: [{ name: "reason", prompt: "what does this change mean?" }],
      knowledgeContext: {
        claims: [
          { id: "RULE-42", revision: "active" },
          { id: "CONSTRAINT-8", revision: "active" },
        ],
      },
      changeIntent: {
        request: {
          id: "CR-1",
          summary: "Kobra now supports 500-character customer comments.",
          scope: { paths: ["src/Booking"] },
        },
      },
    },
    {
      id: "implement",
      name: "Implement",
      needs: ["change-intent"],
      steps: [{ name: "build", prompt: "realize the accepted change" }],
      knowledgeContext: { fromPhases: [{ phaseId: "change-intent" }] },
      changeContext: { fromPhase: "change-intent" },
      implementation: { maxAttempts: 2 },
      ...((over.implement as Record<string, unknown>) ?? {}),
    },
    {
      id: "verify",
      name: "Verify",
      needs: ["implement"],
      steps: [{ name: "check", prompt: "verify the implementation" }],
      knowledgeContext: { fromPhases: [{ phaseId: "change-intent" }] },
      changeContext: { fromPhase: "change-intent" },
      ruleVerification: {},
      acceptanceVerification: { implementationPhase: "implement" },
      ...((over.verify as Record<string, unknown>) ?? {}),
    },
  ];
}

function writeTo(call: Spawned, envVar: string, doc: unknown) {
  const file = call.env[envVar];
  assert.ok(file, `the run must be told where ${envVar} goes`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
}

async function complete(e: Engine, inst: PipelineInstance, phaseId: string, runId: string) {
  return e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId,
    type: "completed",
    token: inst.signalToken,
    payload: { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
  });
}

async function failRun(
  e: Engine,
  inst: PipelineInstance,
  phaseId: string,
  runId: string,
  reason: string,
) {
  return e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId,
    type: "failed",
    token: inst.signalToken,
    payload: { reason },
  });
}

async function instance(id: string): Promise<PipelineInstance> {
  const inst = await readInstance(id);
  assert.ok(inst);
  return inst;
}
const phaseOf = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)!;
const failureOf = (inst: PipelineInstance, id: string) =>
  (phaseOf(inst, id).payload ?? {}) as PhaseFailurePayload;

/** Drive the change-intent phase to acceptance and return the implementation
 *  run the engine then launched. */
async function toImplementation(
  rec: ReturnType<typeof recordingSpawn>,
  e: Engine,
): Promise<{ inst: PipelineInstance; implCall: Spawned }> {
  const started = (await e.start("p1", "manual"))!;
  writeTo(rec.calls[0], "ARGUS_CHANGE_PROPOSAL_FILE", CHANGE_PROPOSAL);
  await complete(e, started, "change-intent", rec.calls[0].runId);
  await e.drain();
  await e.approve(started.id);
  await e.drain();
  const implCall = rec.calls[1];
  assert.ok(implCall, "the implementation phase should have launched");
  return { inst: started, implCall };
}

const RULE_HOLDS = {
  schemaVersion: 1,
  verifications: [
    {
      rule: "RULE-42:v2",
      outcome: "holds",
      evidence: [{ type: "source-code", path: VALIDATOR }],
      note: "the validator caps at 500",
    },
  ],
};

const acceptance = (outcomes: Record<string, string>, over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  criteria: Object.entries(outcomes).map(([criterionId, outcome]) => ({
    criterionId,
    outcome,
    ...(outcome === "unverifiable"
      ? { evidence: [], reason: "no executable expression exists" }
      : { evidence: [{ type: "source-code", path: VALIDATOR }] }),
  })),
  ...over,
});

const ALL_SATISFIED = acceptance({ "AC-1": "satisfied", "AC-2": "satisfied", "AC-3": "satisfied" });

async function realizationOf(inst: PipelineInstance): Promise<ChangeRealization> {
  const r = changeRealizationOfPhase(await readLedger(), inst.id, "implement");
  assert.ok(r, "the implementation phase should have opened a realization");
  return r;
}

// ── Backwards compatibility ─────────────────────────────────────────────────

test("no implementation policy: an ordinary pipeline behaves exactly as before Phase 8", async () => {
  await seedPipeline([{ id: "plan", name: "Plan", steps: [{ name: "s", prompt: "p" }] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  for (const v of [
    "ARGUS_IMPLEMENTATION_SCOPE_FILE",
    "ARGUS_REMEDIATION_CONTEXT_FILE",
    "ARGUS_ACCEPTANCE_VERIFICATION_FILE",
  ]) {
    assert.equal(rec.calls[0].env[v], undefined, `${v} must not be named`);
  }
  const invocation = await readInvocation(rec.calls[0].runId);
  assert.equal(invocation?.implementationScopeFile, null);
  assert.equal(invocation?.acceptanceVerificationFile, null);
  assert.equal(invocation?.suppliedInputs, undefined);
  assert.equal(
    (invocation?.channels ?? []).some((c) =>
      ["implementation-scope", "remediation-context", "acceptance-verification"].includes(c.kind),
    ),
    false,
  );
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal("realization" in phaseOf(after, "plan"), false);
  assert.equal("acceptanceVerification" in phaseOf(after, "plan"), false);
  const ledger = await readLedger();
  assert.deepEqual(ledger.changeRealizations, []);
  assert.deepEqual(ledger.acceptanceVerifications, []);
});

test("a Phase 7 pipeline that stops at changeContext still behaves exactly as before", async () => {
  await seedKnowledge();
  await seedPipeline([
    realizationPipeline()[0],
    {
      id: "implement",
      name: "Implement",
      needs: ["change-intent"],
      steps: [{ name: "build", prompt: "implement" }],
      knowledgeContext: { fromPhases: [{ phaseId: "change-intent" }] },
      changeContext: { fromPhase: "change-intent" },
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { implCall } = await toImplementation(rec, e);
  // The Phase 7 channel is there; none of Phase 8's is.
  assert.ok(implCall.env.ARGUS_CHANGE_CONTEXT_FILE);
  assert.equal(implCall.env.ARGUS_IMPLEMENTATION_SCOPE_FILE, undefined);
  assert.deepEqual((await readLedger()).changeRealizations, []);
});

// ── The implementation protocol ─────────────────────────────────────────────

test("an implementation run receives KnowledgeContext, ChangeContext and ImplementationScope, on three channels", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline());
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);

  assert.ok(implCall.env.ARGUS_KNOWLEDGE_CONTEXT_FILE);
  assert.ok(implCall.env.ARGUS_CHANGE_CONTEXT_FILE);
  assert.ok(implCall.env.ARGUS_IMPLEMENTATION_SCOPE_FILE);
  // A first attempt has nothing to remediate.
  assert.equal(implCall.env.ARGUS_REMEDIATION_CONTEXT_FILE, undefined);

  // Three separate documents, never one blob.
  const scope = JSON.parse(readFileSync(implCall.env.ARGUS_IMPLEMENTATION_SCOPE_FILE, "utf8"));
  const change = JSON.parse(readFileSync(implCall.env.ARGUS_CHANGE_CONTEXT_FILE, "utf8"));
  const knowledge = JSON.parse(readFileSync(implCall.env.ARGUS_KNOWLEDGE_CONTEXT_FILE, "utf8"));
  assert.equal(scope.proposalId, change.proposalId);
  assert.deepEqual(scope.semanticChanges, [{ id: "RULE-42", revision: 2 }]);
  assert.deepEqual(scope.preserved, [{ id: "CONSTRAINT-8", revision: 1 }]);
  assert.deepEqual(scope.requestedPaths, ["src/Booking"]);
  // The scope carries references and reasons, never restated statements.
  assert.equal(JSON.stringify(scope).includes("must not exceed"), false);
  assert.ok(knowledge.claims.some((c: { ref: string }) => c.ref === "RULE-42:v2"));

  // The realization exists before the agent does.
  const realization = await realizationOf(inst);
  assert.equal(realization.proposalId, change.proposalId);
  assert.deepEqual(realization.target, [{ id: "RULE-42", revision: 2 }]);
  assert.equal(realization.maxAttempts, 2);
  assert.deepEqual(realization.attempts, []);
  assert.equal(realizationView(realization).status, "running");

  const after = await instance(inst.id);
  assert.deepEqual(phaseOf(after, "implement").realization?.attempt, 1);
  assert.equal(phaseOf(after, "implement").realization?.kind, "implementation");
  assert.equal(phaseOf(after, "implement").realization?.id, realization.id);

  const journal = await readJournal(inst.id);
  assert.ok(journal.some((j) => j.kind === "realization.started"));
});

test("the three Argus-owned read inputs are hashed at launch and recorded on the invocation", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline());
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { implCall } = await toImplementation(rec, e);
  const invocation = await readInvocation(implCall.runId);
  const kinds = (invocation?.suppliedInputs ?? []).map((s) => s.kind);
  assert.deepEqual(kinds, ["change-context", "implementation-scope"]);
  for (const input of invocation!.suppliedInputs!) {
    assert.match(input.sha256, /^[0-9a-f]{64}$/);
  }
  // And the channels are declared read-only and required.
  for (const kind of ["change-context", "implementation-scope"]) {
    const channel = (invocation?.channels ?? []).find((c) => c.kind === kind)!;
    assert.equal(channel.access, "read");
    assert.equal(channel.required, true);
  }
});

// ── Successful realization ──────────────────────────────────────────────────

async function driveToSuccess() {
  await seedKnowledge();
  await seedPipeline(realizationPipeline());
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  const verifyCall = rec.calls[2];
  assert.ok(verifyCall, "the verification phase should have launched");
  writeTo(verifyCall, "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(verifyCall, "ARGUS_ACCEPTANCE_VERIFICATION_FILE", ALL_SATISFIED);
  await complete(e, inst, "verify", verifyCall.runId);
  await e.drain();
  return { inst, e, rec, implCall, verifyCall };
}

test("every dimension satisfied: the realization succeeds and is bound to the verified repository state", async () => {
  const { inst, implCall, verifyCall } = await driveToSuccess();
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");

  const realization = await realizationOf(after);
  const view = realizationView(realization);
  assert.equal(view.status, "succeeded");
  assert.equal(realization.attempts.length, 1);
  const [attempt] = realization.attempts;
  assert.equal(attempt.outcome, "succeeded");
  assert.equal(attempt.kind, "implementation");
  assert.deepEqual(
    attempt.implementation.map((r) => r.runId),
    [implCall.runId],
  );
  assert.deepEqual(
    attempt.verification.map((r) => r.runId),
    [verifyCall.runId],
  );
  assert.deepEqual(
    attempt.ruleResults.map((r) => [`${r.rule.id}:v${r.rule.revision}`, r.outcome]),
    [["RULE-42:v2", "holds"]],
  );
  assert.deepEqual(
    attempt.acceptanceResults.map((r) => [r.criterionId, r.outcome]),
    [
      ["AC-1", "satisfied"],
      ["AC-2", "satisfied"],
      ["AC-3", "satisfied"],
    ],
  );
  // Success names a repository revision.
  if (gitAvailable()) {
    assert.ok(realization.outcome?.repository?.gitHead);
    assert.equal(realization.outcome!.repository!.gitHead, attempt.repository?.gitHead);
  }

  // The durable semantic records, on their own two arrays.
  const ledger = await readLedger();
  assert.equal(ledger.verifications.length, 1);
  assert.equal(ledger.acceptanceVerifications.length, 3);
  assert.equal(ruleConformance(ledger, { id: "RULE-42", revision: 2 }).status, "holds");
  assert.equal(acceptanceConformance(ledger, realization.proposalId, "AC-3").status, "satisfied");
  // And the rule's own support is untouched by any of it.
  assert.equal(evaluateSupport(ledger, { id: "RULE-42", revision: 2 }), "supported");

  const journal = await readJournal(inst.id);
  assert.ok(journal.some((j) => j.kind === "realization.implementation-completed"));
  assert.ok(journal.some((j) => j.kind === "realization.verification-completed"));
  assert.ok(journal.some((j) => j.kind === "realization.succeeded"));
});

test("acceptance results are staged, not durable, until the phase is accepted", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ verify: { gated: true } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  const verifyCall = rec.calls[2];
  writeTo(verifyCall, "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(verifyCall, "ARGUS_ACCEPTANCE_VERIFICATION_FILE", ALL_SATISFIED);
  await complete(e, inst, "verify", verifyCall.runId);
  await e.drain();

  const parked = await instance(inst.id);
  assert.equal(phaseOf(parked, "verify").status, "awaiting-approval");
  assert.equal(phaseOf(parked, "verify").steps[0].acceptanceVerification?.status, "staged");
  assert.deepEqual(phaseOf(parked, "verify").acceptanceVerification, {
    proposalId: (await realizationOf(parked)).proposalId,
    required: 3,
    satisfied: 3,
    violated: 0,
    unverifiable: 0,
    requiresReview: true,
  });
  assert.deepEqual((await readLedger()).acceptanceVerifications, []);
  // …and the realization is still running: nothing has been decided.
  assert.equal(realizationView(await realizationOf(parked)).status, "running");

  // The reviewer sees both dimensions, side by side and unmerged.
  const def = (await readPipelines()).find((p) => p.id === "p1");
  const review = await buildPhaseReview(parked, "verify", def);
  assert.ok(review.ok);
  assert.equal(review.review.ruleVerifications?.[0].holds.length, 1);
  assert.equal(review.review.acceptanceVerifications?.[0].satisfied.length, 3);
  assert.equal(review.review.acceptanceVerifications?.[0].satisfied[0].ref.includes("/AC-1"), true);

  await e.approve(inst.id, undefined, { phaseId: "verify" });
  await e.drain();
  assert.equal((await readLedger()).acceptanceVerifications.length, 3);
  assert.equal(realizationView(await realizationOf(await instance(inst.id))).status, "succeeded");
});

// ── Technical failure ───────────────────────────────────────────────────────

test("an implementation that fails technically closes out with no semantic result at all", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await failRun(e, inst, "implement", implCall.runId, "the project does not compile");
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "implement").status, "failed");
  // The verification phase never ran.
  assert.equal(phaseOf(after, "verify").status, "pending");
  assert.equal(rec.calls.length, 2);

  const realization = await realizationOf(after);
  assert.equal(realizationView(realization).status, "failed");
  assert.equal(realization.attempts[0].outcome, "technical-failure");
  assert.deepEqual(realization.attempts[0].verification, []);
  // No false semantic close-out: nothing was verified, so nothing is recorded.
  const ledger = await readLedger();
  assert.deepEqual(ledger.verifications, []);
  assert.deepEqual(ledger.acceptanceVerifications, []);
  assert.deepEqual(
    realization.outcome?.unmetRules.map((r) => r.outcome),
    ["unverified"],
  );
});

test("a blocked implementation stops the loop rather than remediating", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline());
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await failRun(e, inst, "implement", implCall.runId, "blocked: the Kobra API contract is missing");
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realization.attempts[0].outcome, "blocked");
  assert.equal(realizationView(realization).status, "failed");
  assert.match(realization.outcome!.reason, /cannot safely be implemented/);
  // Two attempts were configured and the second was deliberately not taken.
  assert.equal(realization.attempts.length, 1);
  assert.equal(rec.calls.length, 2);
});

// ── Rule violation ──────────────────────────────────────────────────────────

const RULE_VIOLATED = {
  schemaVersion: 1,
  verifications: [
    {
      rule: "RULE-42:v2",
      outcome: "violated",
      evidence: [{ type: "source-code", path: VALIDATOR }],
      note: "the validator still caps at 180",
    },
  ],
};

test("a violated rule with every criterion satisfied needs remediation, and leaves the rule supported", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline());
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_VIOLATED);
  writeTo(rec.calls[2], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", ALL_SATISFIED);
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realization.attempts[0].outcome, "rule-violation");
  // A second, targeted attempt was launched rather than the whole pipeline.
  assert.equal(rec.calls.length, 4);
  assert.equal(rec.calls[3].env.ARGUS_REMEDIATION_CONTEXT_FILE !== undefined, true);
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "change-intent").status, "succeeded");
  assert.equal(phaseOf(after, "implement").status, "running");

  // MANDATORY REGRESSION: a violated implementation does not contest the rule.
  const ledger = await readLedger();
  assert.equal(evaluateSupport(ledger, { id: "RULE-42", revision: 2 }), "supported");
  assert.equal(
    ledger.evidence.some((ev) => ev.direction === "opposes"),
    false,
  );
});

// ── Acceptance violation ────────────────────────────────────────────────────

test("MANDATORY: every rule holding with AC-3 violated is not a completed change", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(
    rec.calls[2],
    "ARGUS_ACCEPTANCE_VERIFICATION_FILE",
    acceptance({ "AC-1": "satisfied", "AC-2": "satisfied", "AC-3": "violated" }),
  );
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realization.attempts[0].outcome, "acceptance-violation");
  assert.equal(realizationView(realization).status, "failed");
  assert.match(realization.outcome!.reason, /AC-3/);
  assert.deepEqual(
    realization.outcome!.unmetCriteria.map((c) => c.criterionId),
    ["AC-3"],
  );
  // The rule result is untouched and durable: it holds, and the change is
  // still not complete.
  const ledger = await readLedger();
  assert.equal(ruleConformance(ledger, { id: "RULE-42", revision: 2 }).status, "holds");
  assert.equal(realization.outcome!.unmetRules.length, 0);
});

test("a required criterion that is unverifiable ends the realization rather than looping", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 3 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(
    rec.calls[2],
    "ARGUS_ACCEPTANCE_VERIFICATION_FILE",
    acceptance({ "AC-1": "satisfied", "AC-2": "satisfied", "AC-3": "unverifiable" }),
  );
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realization.attempts[0].outcome, "acceptance-unverifiable");
  assert.equal(realizationView(realization).status, "failed");
  // Attempts remained, and were deliberately not used.
  assert.equal(realization.attempts.length, 1);
  assert.equal(rec.calls.length, 3);
  assert.match(realization.outcome!.reason, /a person is/);
});

// ── Remediation ─────────────────────────────────────────────────────────────

test("remediation is targeted at the failed criterion, and the failed attempt stays history", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline());
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(
    rec.calls[2],
    "ARGUS_ACCEPTANCE_VERIFICATION_FILE",
    acceptance({ "AC-1": "satisfied", "AC-2": "violated", "AC-3": "satisfied" }),
  );
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  // Attempt 2: a remediation run, told exactly what is unmet.
  const remediation = rec.calls[3];
  assert.ok(remediation.env.ARGUS_REMEDIATION_CONTEXT_FILE);
  const ctx = JSON.parse(readFileSync(remediation.env.ARGUS_REMEDIATION_CONTEXT_FILE, "utf8"));
  assert.equal(ctx.attempt, 2);
  assert.equal(ctx.previousOutcome, "acceptance-violation");
  assert.deepEqual(ctx.failedRules, []);
  assert.deepEqual(
    ctx.failedCriteria.map((c: { criterionId: string }) => c.criterionId),
    ["AC-2"],
  );
  assert.deepEqual(ctx.satisfied.rules, ["RULE-42:v2"]);
  assert.equal(ctx.satisfied.criteria.length, 2);
  // The scope it receives is the same frozen scope, not a re-derived one.
  const scope = JSON.parse(readFileSync(remediation.env.ARGUS_IMPLEMENTATION_SCOPE_FILE!, "utf8"));
  assert.equal(scope.proposalId, ctx.proposalId);
  const after1 = await instance(inst.id);
  assert.equal(phaseOf(after1, "implement").realization?.attempt, 2);
  assert.equal(phaseOf(after1, "implement").realization?.kind, "remediation");

  await complete(e, inst, "implement", remediation.runId);
  await e.drain();
  writeTo(rec.calls[4], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(rec.calls[4], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", ALL_SATISFIED);
  await complete(e, inst, "verify", rec.calls[4].runId);
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realizationView(realization).status, "succeeded");
  // MANDATORY: the failed attempt is still there, unrewritten.
  assert.deepEqual(
    realization.attempts.map((a) => [a.attempt, a.kind, a.outcome]),
    [
      [1, "implementation", "acceptance-violation"],
      [2, "remediation", "succeeded"],
    ],
  );
  assert.deepEqual(
    realization.attempts[0].acceptanceResults.map((r) => [r.criterionId, r.outcome]),
    [
      ["AC-1", "satisfied"],
      ["AC-2", "violated"],
      ["AC-3", "satisfied"],
    ],
  );
  // And so are the durable results of both attempts: nothing is overwritten.
  const ledger = await readLedger();
  assert.equal(ledger.acceptanceVerifications.length, 6);
  assert.equal(
    ledger.acceptanceVerifications.filter(
      (v) => v.criterionId === "AC-2" && v.outcome === "violated",
    ).length,
    1,
  );
  const journal = await readJournal(inst.id);
  assert.ok(journal.some((j) => j.kind === "realization.remediation-started"));
});

test("the remediation bound is the author's, and exhausting it is terminal, not another retry", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 2 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  const failOnce = async (implRunId: string, verifyIndex: number) => {
    await complete(e, inst, "implement", implRunId);
    await e.drain();
    writeTo(rec.calls[verifyIndex], "ARGUS_RULE_VERIFICATION_FILE", RULE_VIOLATED);
    writeTo(rec.calls[verifyIndex], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", ALL_SATISFIED);
    await complete(e, inst, "verify", rec.calls[verifyIndex].runId);
    await e.drain();
  };
  await failOnce(implCall.runId, 2);
  await failOnce(rec.calls[3].runId, 4);

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realization.attempts.length, 2);
  assert.equal(realizationView(realization).status, "failed");
  assert.match(realization.outcome!.reason, /2-attempt budget is exhausted/);
  // No third implementation was launched: the loop is bounded.
  assert.equal(rec.calls.length, 5);
  // And the phase's own retry budget was never touched by any of it.
  assert.equal(phaseOf(await instance(inst.id), "implement").retries, 0);
});

// ── Stale intent ────────────────────────────────────────────────────────────

test("a semantic target superseded while the implementation ran is never reported as current completion", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline());
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  // The business moves on while the verification runs.
  await createRevision(
    "RULE-42",
    { statement: "Kobra customer comments must not exceed 700 characters." },
    NOW,
  );
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(rec.calls[2], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", ALL_SATISFIED);
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realizationView(realization).status, "stale");
  assert.equal(realization.attempts[0].outcome, "stale-intent");
  assert.match(realization.outcome!.reason, /RULE-42:v2 → RULE-42:v3/);
  // No remediation: more code is not the answer to a change of intent.
  assert.equal(rec.calls.length, 3);
  // The verification of v2 stays historically true, bound to v2.
  const ledger = await readLedger();
  assert.equal(ruleConformance(ledger, { id: "RULE-42", revision: 2 }).status, "holds");
  assert.equal(ruleConformance(ledger, { id: "RULE-42", revision: 3 }).status, "unverified");
  const journal = await readJournal(inst.id);
  assert.ok(journal.some((j) => j.kind === "realization.stale"));
});

test("an implementation whose target is already superseded is refused before any agent starts", async () => {
  await seedKnowledge();
  // A gated phase between the accepted intent and the implementation, so the
  // domain can legitimately move on while a person deliberates — which is
  // exactly when the preflight has to catch it.
  const [intent, implement, verify] = realizationPipeline();
  await seedPipeline([
    intent,
    {
      id: "hold",
      name: "Hold",
      gated: true,
      needs: ["change-intent"],
      steps: [{ name: "wait", prompt: "wait" }],
    },
    { ...implement, needs: ["hold"] },
    verify,
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const started = (await e.start("p1", "manual"))!;
  writeTo(rec.calls[0], "ARGUS_CHANGE_PROPOSAL_FILE", CHANGE_PROPOSAL);
  await complete(e, started, "change-intent", rec.calls[0].runId);
  await e.drain();
  await e.approve(started.id, undefined, { phaseId: "change-intent" });
  await e.drain();
  await complete(e, started, "hold", rec.calls[1].runId);
  await e.drain();

  // The business moves on while the gate waits.
  await createRevision(
    "RULE-42",
    { statement: "Kobra customer comments must not exceed 700 characters." },
    NOW,
  );
  await e.approve(started.id, undefined, { phaseId: "hold" });
  await e.drain();

  const after = await instance(started.id);
  const failure = failureOf(after, "implement");
  assert.equal(phaseOf(after, "implement").status, "failed");
  assert.equal(failure.failureClass, "configuration");
  assert.match(String(failure.reason), /no longer the active revision/);
  // No agent was launched for the stale attempt, and no realization attempt
  // was recorded for work that never happened.
  assert.equal(rec.calls.length, 2);
  const realization = changeRealizationOfPhase(await readLedger(), started.id, "implement");
  assert.equal(realization, null);
});

// ── Context integrity ───────────────────────────────────────────────────────

test("a ChangeContext modified during the run fails the completion deterministically", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  const file = implCall.env.ARGUS_CHANGE_CONTEXT_FILE!;
  // Argus publishes the file read-only, so tampering with it takes the same
  // step an outside hand would have to take. Writing straight over it only
  // works when the suite happens to run as root.
  assert.equal(statSync(file).mode & 0o777, 0o444);
  chmodSync(file, 0o644);
  writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "implement").status, "failed");
  assert.equal(failureOf(after, "implement").failureClass, "change-context-integrity");
  assert.match(String(failureOf(after, "implement").reason), /change-context file changed/);
  assert.equal(phaseOf(after, "verify").status, "pending");
});

test("an ImplementationScope that disappears during the run fails the completion too", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  const { rmSync } = await import("node:fs");
  rmSync(implCall.env.ARGUS_IMPLEMENTATION_SCOPE_FILE!);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(failureOf(after, "implement").failureClass, "change-context-integrity");
  assert.match(
    String(failureOf(after, "implement").reason),
    /implementation-scope file is missing/,
  );
});

// ── Completeness of the acceptance answer ───────────────────────────────────

test("a verification that omits a criterion refuses the whole staged result", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(
    rec.calls[2],
    "ARGUS_ACCEPTANCE_VERIFICATION_FILE",
    acceptance({ "AC-1": "satisfied", "AC-2": "satisfied" }),
  );
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.equal(failureOf(after, "verify").failureClass, "acceptance-verification");
  assert.match(String(failureOf(after, "verify").reason), /AC-3.*missing/s);
  // Nothing became durable — not even the rule result that was fine.
  const ledger = await readLedger();
  assert.deepEqual(ledger.acceptanceVerifications, []);
  assert.deepEqual(ledger.verifications, []);
  const record = (await readAcceptanceRecord(rec.calls[2].runId)) as AcceptanceVerificationRecord;
  assert.equal(record.status, "rejected");
});

test("a verification that writes no acceptance file at all is refused, not treated as silence", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(failureOf(after, "verify").failureClass, "acceptance-verification");
  assert.match(String(failureOf(after, "verify").reason), /wrote no acceptance-verification file/);
});

// ── Repository-state identity ───────────────────────────────────────────────

test("MANDATORY: a verification that examined a different dirty tree at the same commit proves nothing", async (t) => {
  if (!gitAvailable()) return t.skip("git is unavailable");
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  // The implementation edits the validator without committing: gitHead is
  // unchanged, and the tree is now a *different* state at that head.
  writeFileSync(path.join(repo, VALIDATOR), "public const int MaxLength = 500;\n");
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  // Something edits it again before the verification reports: whatever the
  // verifier looked at, it is not what the implementation produced.
  writeFileSync(path.join(repo, VALIDATOR), "public const int MaxLength = 501;\n");
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(rec.calls[2], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", ALL_SATISFIED);
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realization.attempts[0].outcome, "state-mismatch");
  assert.equal(realizationView(realization).status, "failed");
  assert.match(realization.outcome!.reason, /not the state the implementation produced/);
  // The two states shared one commit and were still told apart.
  const ledger = await readLedger();
  const recorded = ledger.acceptanceVerifications[0].repository!;
  assert.equal(recorded.gitHead, realization.attempts[0].repository?.gitHead);
  assert.notEqual(
    recorded.workingTree?.snapshotHash,
    realization.attempts[0].repository?.workingTree?.snapshotHash,
  );
});

test("a dirty implementation the verification actually examined succeeds, bound to that exact state", async (t) => {
  if (!gitAvailable()) return t.skip("git is unavailable");
  await seedKnowledge();
  await seedPipeline(realizationPipeline());
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  writeFileSync(path.join(repo, VALIDATOR), "public const int MaxLength = 500;\n");
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(rec.calls[2], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", ALL_SATISFIED);
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realizationView(realization).status, "succeeded");
  const state = realization.outcome!.repository!;
  assert.ok(state.gitHead);
  assert.equal(state.workingTree?.dirty, 1);
  // The conformance question, asked at that exact state, answers `holds`; the
  // clean commit it shares a head with does not.
  const ledger = await readLedger();
  const rule = { id: "RULE-42", revision: 2 };
  assert.equal(ruleConformance(ledger, rule, state.gitHead).status, "holds");
  assert.equal(
    acceptanceConformance(ledger, realization.proposalId, "AC-1", state).status,
    "satisfied",
  );
  assert.equal(
    acceptanceConformance(ledger, realization.proposalId, "AC-1", { gitHead: state.gitHead })
      .status,
    "unverified",
    "a result about a dirty tree never answers a question about the bare commit",
  );
});

// ── Forged check evidence ───────────────────────────────────────────────────

test("MANDATORY: an agent's claim about a check is stripped; Argus binds its own observed result", async () => {
  await seedKnowledge();
  await seedPipeline(
    realizationPipeline({
      verify: { checks: [{ kind: "command", run: "exit 0", label: "kobra-boundary" }] },
    }),
  );
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(rec.calls[2], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", {
    schemaVersion: 1,
    criteria: [
      {
        criterionId: "AC-1",
        outcome: "satisfied",
        // The agent tries to say how the check went. It does not get to.
        evidence: [
          { type: "check", label: "kobra-boundary", status: "failed", exitCode: 9, detail: "lies" },
        ],
      },
      {
        criterionId: "AC-2",
        outcome: "satisfied",
        evidence: [{ type: "check", label: "kobra-boundary" }],
      },
      {
        criterionId: "AC-3",
        outcome: "satisfied",
        evidence: [{ type: "observation", note: "unchanged" }],
      },
    ],
  });
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  const ledger = await readLedger();
  const record = ledger.acceptanceVerifications.find((v) => v.criterionId === "AC-1")!;
  const cited = record.evidence.find((x) => x.type === "check")!;
  assert.equal(cited.type === "check" && cited.status, "passed");
  assert.equal(cited.type === "check" && cited.exitCode, 0);
  // The detail is Argus's own one-line result, not the agent's sentence.
  assert.match(String(cited.type === "check" && cited.detail), /^exit 0/);
  assert.equal(String(cited.type === "check" && cited.detail).includes("lies"), false);
  assert.equal(realizationView(await realizationOf(await instance(inst.id))).status, "succeeded");
});

test("an acceptance result citing a check the phase does not declare is refused", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(rec.calls[2], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", {
    schemaVersion: 1,
    criteria: [
      {
        criterionId: "AC-1",
        outcome: "satisfied",
        evidence: [{ type: "check", label: "invented" }],
      },
      {
        criterionId: "AC-2",
        outcome: "satisfied",
        evidence: [{ type: "observation", note: "ok" }],
      },
      {
        criterionId: "AC-3",
        outcome: "satisfied",
        evidence: [{ type: "observation", note: "ok" }],
      },
    ],
  });
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(failureOf(after, "verify").failureClass, "acceptance-verification");
  assert.match(String(failureOf(after, "verify").reason), /check-reference/);
  assert.deepEqual((await readLedger()).acceptanceVerifications, []);
});

test("an acceptance report naming another accepted change is refused", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(rec.calls[2], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", {
    ...ALL_SATISFIED,
    proposalId: "CP-SOMEBODY-ELSE",
  });
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(failureOf(after, "verify").failureClass, "acceptance-verification");
  assert.match(String(failureOf(after, "verify").reason), /proposal-scoped/);
});

// ── Authoring ───────────────────────────────────────────────────────────────
//
// Every rule here is an authoring error that would otherwise surface as a
// launch refusal on a live instance at 3am. They are refused where the author
// can see them: when the pipeline is saved.

const authoring = (phases: Record<string, unknown>[]) =>
  validatePipelineInput({
    name: "realization",
    trigger: null,
    phases: phases.map((p) => ({ cwd: repo, gated: false, ...p })),
  });

test("an implementation phase without a changeContext is refused at authoring", () => {
  const [intent, implement, verify] = realizationPipeline();
  assert.throws(
    () => authoring([intent, { ...implement, changeContext: undefined }, verify]),
    /must also declare changeContext/,
  );
});

test("an acceptanceVerification phase without a changeContext is refused at authoring", () => {
  const [intent, implement, verify] = realizationPipeline();
  assert.throws(
    () => authoring([intent, implement, { ...verify, changeContext: undefined }]),
    /must also declare changeContext/,
  );
});

test("an implementation phase with no verifier is refused: nothing would ever decide the change", () => {
  const [intent, implement] = realizationPipeline();
  assert.throws(
    () => authoring([intent, implement]),
    /needs a later phase declaring acceptanceVerification/,
  );
});

test("a verifier naming a phase that is not an implementation phase is refused", () => {
  const [intent, implement, verify] = realizationPipeline();
  assert.throws(
    () =>
      authoring([
        intent,
        { ...implement, implementation: undefined },
        { ...verify, acceptanceVerification: { implementationPhase: "implement" } },
      ]),
    /declares no implementation policy/,
  );
});

test("a verifier that is not downstream of the implementation it verifies is refused", () => {
  const [intent, implement, verify] = realizationPipeline();
  assert.throws(
    () => authoring([intent, implement, { ...verify, needs: ["change-intent"] }]),
    /is not a dependency of this phase/,
  );
});

test("the two halves must answer for the same accepted change", () => {
  const [intent, implement, verify] = realizationPipeline();
  assert.throws(
    () =>
      authoring([
        intent,
        { ...intent, id: "other-intent", name: "Other" },
        implement,
        {
          ...verify,
          changeContext: { fromPhase: "other-intent" },
          needs: ["implement", "other-intent"],
        },
      ]),
    /both halves of a realization must answer for the same accepted change/,
  );
});

test("maxAttempts is bounded, and an unbounded loop cannot be authored", () => {
  const [intent, implement, verify] = realizationPipeline();
  for (const bad of [0, -1, 99, 1.5]) {
    assert.throws(
      () => authoring([intent, { ...implement, implementation: { maxAttempts: bad } }, verify]),
      /maxAttempts must be an integer between 1 and 8/,
      `maxAttempts ${bad}`,
    );
  }
  assert.doesNotThrow(() =>
    authoring([intent, { ...implement, implementation: { maxAttempts: 1 } }, verify]),
  );
});

test("an unknown key on either policy is refused rather than silently ignored", () => {
  const [intent, implement, verify] = realizationPipeline();
  assert.throws(
    () => authoring([intent, { ...implement, implementation: { retries: 3 } }, verify]),
    /implementation has unknown key "retries"/,
  );
  assert.throws(
    () =>
      authoring([
        intent,
        implement,
        { ...verify, acceptanceVerification: { implementationPhase: "implement", strict: true } },
      ]),
    /acceptanceVerification has unknown key "strict"/,
  );
});

// ── No realization is left running forever ──────────────────────────────────

test("aborting the instance closes the realization rather than leaving it running", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline());
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst } = await toImplementation(rec, e);
  assert.equal(realizationView(await realizationOf(await instance(inst.id))).status, "running");

  await e.abort(inst.id);
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realizationView(realization).status, "failed");
  assert.match(realization.outcome!.reason, /the instance was aborted/);
  // The attempt that was in flight is recorded as what it was — an
  // implementation that did not complete — and no remediation follows.
  assert.deepEqual(
    realization.attempts.map((a) => [a.attempt, a.outcome]),
    [[1, "technical-failure"]],
  );
  assert.deepEqual((await readLedger()).acceptanceVerifications, []);
});

test("a verification phase that never reaches a verdict still ends the attempt", async () => {
  await seedKnowledge();
  await seedPipeline(realizationPipeline({ implement: { implementation: { maxAttempts: 1 } } }));
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  await failRun(e, inst, "verify", rec.calls[2].runId, "the verifier crashed");
  await e.drain();

  const realization = await realizationOf(await instance(inst.id));
  assert.equal(realization.attempts[0].outcome, "technical-failure");
  assert.equal(realizationView(realization).status, "failed");
  // Nothing semantic was recorded for an attempt nobody verified.
  const ledger = await readLedger();
  assert.deepEqual(ledger.verifications, []);
  assert.deepEqual(ledger.acceptanceVerifications, []);
  assert.deepEqual(
    realization.outcome!.unmetRules.map((r) => r.outcome),
    ["unverified"],
  );
});

test("a commit refused over an acceptance result fails under the acceptance class, not the rule one", async () => {
  await seedKnowledge();
  await seedPipeline(
    realizationPipeline({
      implement: { implementation: { maxAttempts: 1 } },
      verify: { gated: true, checks: [{ kind: "command", run: "exit 0", label: "boundary" }] },
    }),
  );
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const { inst, implCall } = await toImplementation(rec, e);
  await complete(e, inst, "implement", implCall.runId);
  await e.drain();
  writeTo(rec.calls[2], "ARGUS_RULE_VERIFICATION_FILE", RULE_HOLDS);
  writeTo(rec.calls[2], "ARGUS_ACCEPTANCE_VERIFICATION_FILE", ALL_SATISFIED);
  await complete(e, inst, "verify", rec.calls[2].runId);
  await e.drain();

  // The accepted change is removed from under the staged results while the
  // gate waits: the commit can no longer record a criterion of it.
  const { mutateLedger } = await import("./store.js");
  await mutateLedger((ledger) => ({
    ledger: { ...ledger, changeProposals: [] },
    result: null,
  }));
  await e.approve(inst.id, undefined, { phaseId: "verify" });
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "verify").status, "failed");
  assert.equal(failureOf(after, "verify").failureClass, "acceptance-verification");
  assert.match(String(failureOf(after, "verify").reason), /acceptance-verification commit refused/);
  // Nothing landed — not the rule result either.
  const ledger = await readLedger();
  assert.deepEqual(ledger.verifications, []);
  assert.deepEqual(ledger.acceptanceVerifications, []);
});
