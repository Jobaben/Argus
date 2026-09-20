import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ChangeContext,
  ChangeIntentInput,
  ChangeProposalRecord,
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
import { readProposalRecord } from "./changeStaging.js";
import { readDeltaRecord } from "./staging.js";
import {
  commitPhaseSemantics,
  createClaim,
  createEvidence,
  createRevision,
  readLedger,
} from "./store.js";
import {
  activeRevision,
  changeProposalOfClaim,
  changeProposalsForRequest,
  evaluateSupport,
  getClaim,
  ruleConformance,
} from "./kernel.js";

/**
 * Change-intent orchestration through the engine (Phase 7).
 *
 * The whole workflow on a real gate:
 *
 *   ChangeRequest → change-intent agent → staged ChangeProposal → review
 *     → accepted semantic delta + durable change provenance → ChangeContext
 *
 * Every assertion is on the ledger on disk, the staged record, the persisted
 * instance or the review payload. The agent is a spawn double whose "work" is
 * the test writing the proposal file before signalling, so nothing here
 * depends on a model: every refusal, resolution and commit is computed by
 * Argus.
 *
 * The regressions the suite exists for are the three separations:
 *
 *   a request is not a rule       — nothing is canonical before approval
 *   a rule is not its code        — a violated implementation is warned about,
 *                                   never revised away, and never rewritten
 *   a criterion is not a claim    — acceptance criteria stay out of the graph
 */

let home: string;
let repo: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-change-engine-"));
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

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-change-repo-"));
  mkdirSync(path.join(dir, "src", "Booking"), { recursive: true });
  writeFileSync(path.join(dir, "src", "Booking", "KobraCommentValidator.cs"), "// max 180\n");
  if (gitAvailable()) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

function headOf(dir: string): string | null {
  if (!gitAvailable()) return null;
  const out = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
  return out.status === 0 ? out.stdout.trim() : null;
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
    signalUrlBase: "http://localhost:7778",
    maxConcurrent: 4,
    tickMs: 30000,
    parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
  });
}

async function seed(phases: Record<string, unknown>[]) {
  return createPipeline(
    validatePipelineInput({
      name: "change",
      trigger: null,
      phases: phases.map((p) => ({ cwd: repo, gated: false, ...p })),
    }),
    NOW,
    "p1",
  );
}

const step = (name = "reason", prompt = "work out what changes") => ({ name, prompt });

/** The canonical state every scenario starts from: one supported business rule
 *  and one supported constraint, exactly as an accepted discovery phase would
 *  have left them. */
async function seedKnowledge() {
  if ((await readLedger()).claims.length > 0) return;
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

const REQUEST = {
  id: "CR-1",
  summary: "Kobra now supports 500-character customer comments.",
  details: "The integration team confirmed the new limit.",
  scope: { label: "Kobra comments", paths: ["src/Booking"] },
};

/** The change-intent phase the suite reuses: gated, supplied RULE-42 and
 *  CONSTRAINT-8 through an ordinary KnowledgeContext. */
const changePhase = (over: Record<string, unknown> = {}) => ({
  id: "change",
  name: "Change intent",
  gated: true,
  steps: [step()],
  knowledgeContext: {
    claims: [
      { id: "RULE-42", revision: "active" },
      { id: "CONSTRAINT-8", revision: "active" },
    ],
  },
  changeIntent: { request: REQUEST },
  ...over,
});

/** A downstream placeholder: it receives the accepted intent and implements
 *  nothing. Phase 7 stops here on purpose. */
const implementPhase = (over: Record<string, unknown> = {}) => ({
  id: "implement",
  name: "Implement",
  gated: false,
  needs: ["change"],
  steps: [step("build", "you would implement here")],
  knowledgeContext: { fromPhases: [{ phaseId: "change" }] },
  changeContext: { fromPhase: "change" },
  ...over,
});

/** The well-formed proposal for the Kobra 180 → 500 scenario. */
function kobraProposal(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    semanticDelta: {
      schemaVersion: 1,
      revisions: [
        {
          claimId: "RULE-42",
          expectedRevision: 1,
          statement: "Kobra customer comments must not exceed 500 characters.",
          localId: "r42",
          revisionNote: "Kobra raised its limit to 500.",
        },
      ],
      claims: [
        {
          localId: "d1",
          kind: "decision",
          statement: "The 500-character limit applies only when BookingEngine == Kobra.",
        },
      ],
      evidence: [
        {
          claim: { local: "r42" },
          source: { type: "document", uri: "argus:change-request/CR-1", title: REQUEST.summary },
        },
      ],
      justifications: [
        { conclusion: { local: "d1" }, premises: [{ local: "r42" }, "CONSTRAINT-8:v1"] },
      ],
      consumed: ["RULE-42:v1", "CONSTRAINT-8:v1"],
    },
    preserved: ["CONSTRAINT-8:v1"],
    classification: [{ rule: "RULE-42:v1", disposition: "revised" }],
    acceptanceCriteria: [
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
    ],
    metadata: { summary: "Raise the Kobra limit; keep server-side validation." },
    ...over,
  };
}

function writeProposal(call: Spawned, doc: unknown) {
  const file = call.env.ARGUS_CHANGE_PROPOSAL_FILE;
  assert.ok(file, "a change-intent run must be told where its proposal goes");
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

async function instance(id: string): Promise<PipelineInstance> {
  const inst = await readInstance(id);
  assert.ok(inst);
  return inst;
}

async function definition() {
  return (await readPipelines()).find((p) => p.id === "p1");
}

const phaseOf = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)!;
const failure = (inst: PipelineInstance, id: string) =>
  (phaseOf(inst, id).payload ?? {}) as PhaseFailurePayload;

/** Run the standard scenario up to the gate. */
async function toGate(proposal: unknown = kobraProposal(), phases = [changePhase()]) {
  await seedKnowledge();
  await seed(phases);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeProposal(rec.calls[0], proposal);
  await complete(e, inst, "change", rec.calls[0].runId);
  await e.drain();
  return { rec, e, inst, runId: rec.calls[0].runId };
}

// ── Backwards compatibility ─────────────────────────────────────────────────

test("no changeIntent policy: an ordinary pipeline behaves exactly as before Phase 7", async () => {
  await seed([{ id: "plan", name: "Plan", steps: [step("s", "p")] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  // No channel, no environment variable, no instruction.
  assert.equal(rec.calls[0].env.ARGUS_CHANGE_REQUEST_FILE, undefined);
  assert.equal(rec.calls[0].env.ARGUS_CHANGE_PROPOSAL_FILE, undefined);
  assert.equal(rec.calls[0].env.ARGUS_CHANGE_CONTEXT_FILE, undefined);
  const invocation = await readInvocation(rec.calls[0].runId);
  assert.equal(invocation?.changeRequestFile, null);
  assert.equal(invocation?.changeProposalFile, null);
  assert.equal(
    (invocation?.channels ?? []).some((c) => c.kind.startsWith("change-")),
    false,
  );
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal("changeIntent" in phaseOf(after, "plan"), false);
  assert.deepEqual((await readLedger()).changeProposals, []);
});

test("a changeIntent phase must be gated: an ungated one is refused at authoring", async () => {
  await assert.rejects(
    () =>
      seed([
        {
          id: "change",
          name: "Change",
          gated: false,
          steps: [step()],
          changeIntent: { request: REQUEST },
        },
      ]),
    /must be gated/,
  );
});

test("changeContext must name a change-intent phase this one depends on", async () => {
  await assert.rejects(
    () => seed([changePhase(), implementPhase({ changeContext: { fromPhase: "nope" } })]),
    /unknown phase "nope"/,
  );
  await assert.rejects(
    () =>
      seed([
        { id: "other", name: "Other", steps: [step("s", "p")] },
        changePhase({ needs: ["other"] }),
        implementPhase({ needs: ["change"], changeContext: { fromPhase: "other" } }),
      ]),
    /not a changeIntent phase/,
  );
});

// ── The input: request + current semantics + current conformance ────────────

test("the run receives the request and the conformance of the rules it must classify", async () => {
  await seedKnowledge();
  await seed([changePhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  await e.start("p1", "manual");
  const call = rec.calls[0];

  const requestFile = call.env.ARGUS_CHANGE_REQUEST_FILE;
  assert.ok(requestFile);
  const input = JSON.parse(readFileSync(requestFile, "utf8")) as ChangeIntentInput;
  assert.equal(input.schemaVersion, 1);
  assert.equal(input.request.summary, REQUEST.summary);
  // Accountability follows the supplied context, narrowed to business rules:
  // the constraint is supplied to reason *with*, not to classify.
  assert.deepEqual(
    input.relevant.map((r) => r.ref),
    ["RULE-42:v1"],
  );
  assert.equal(input.relevant[0].support, "supported");
  assert.equal(input.relevant[0].conformance, "unverified");

  // Current semantics arrive on their own channel. The *request* never
  // restates them — that is the separation Phase 7 keeps — while the
  // conformance projection names the rule it is reporting on, which is what
  // makes the gate's CURRENT section readable.
  const contextFile = call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE;
  assert.ok(contextFile);
  assert.ok(readFileSync(contextFile, "utf8").includes("must not exceed 180 characters"));
  assert.equal(JSON.stringify(input.request).includes("must not exceed 180"), false);

  // And the channels are recorded as what they are.
  const invocation = await readInvocation(call.runId);
  const channels = invocation?.channels ?? [];
  assert.equal(channels.find((c) => c.kind === "change-request")?.access, "read");
  assert.equal(channels.find((c) => c.kind === "change-proposal")?.access, "write");
  assert.equal(channels.find((c) => c.kind === "change-proposal")?.required, true);
});

test("a change-intent phase with no request anywhere fails as a configuration error", async () => {
  await seedKnowledge();
  await seed([changePhase({ changeIntent: {} })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "change").status, "failed");
  assert.equal(failure(after, "change").failureClass, "configuration");
  assert.match(String(failure(after, "change").reason), /no ChangeRequest was supplied/);
  assert.equal(rec.calls.length, 0);
});

test("a request supplied at start overrides the pipeline's authored one", async () => {
  await seedKnowledge();
  await seed([changePhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  await e.start("p1", "manual", {
    triggerPayload: {
      changeRequest: { id: "CR-99", summary: "Kobra now supports 800-character comments." },
    },
  });
  const input = JSON.parse(
    readFileSync(rec.calls[0].env.ARGUS_CHANGE_REQUEST_FILE!, "utf8"),
  ) as ChangeIntentInput;
  assert.equal(input.request.id, "CR-99");
  assert.match(input.request.summary, /800/);
});

// ── Nothing is canonical before approval ────────────────────────────────────

test("MANDATORY: a staged proposal mutates no semantics whatsoever", async () => {
  const { inst, runId } = await toGate();
  const parked = await instance(inst.id);
  assert.equal(phaseOf(parked, "change").status, "awaiting-approval");
  assert.equal(phaseOf(parked, "change").steps[0].changeProposal?.status, "staged");

  const ledger = await readLedger();
  // RULE-42 is still v1, there is no decision, and no change provenance.
  assert.equal(activeRevision(ledger, "RULE-42")?.revision, 1);
  assert.equal(getClaim(ledger, { id: "RULE-42", revision: 2 }), null);
  assert.equal(
    ledger.claims.some((c) => c.kind === "decision"),
    false,
  );
  assert.deepEqual(ledger.changeProposals, []);
  assert.deepEqual(ledger.deltas, []);

  // The record beside the run holds the reasoning, and says it is not canonical.
  const record = await readProposalRecord(runId);
  assert.equal(record?.status, "staged");
  assert.equal(record?.readiness, "ready");
  assert.equal(record?.request.id, "CR-1");
  assert.deepEqual(record?.selected, [{ id: "RULE-42", revision: 1 }]);
  // Its semantic half is an ordinary staged KnowledgeDelta.
  const delta = await readDeltaRecord(runId);
  assert.equal(delta?.status, "staged");
  assert.equal(record?.deltaId, delta?.id);
});

test("the phase summary says a decision is outstanding, and what it is about", async () => {
  const { inst } = await toGate();
  const summary = phaseOf(await instance(inst.id), "change").changeIntent;
  assert.deepEqual(summary, {
    requestId: "CR-1",
    readiness: "ready",
    selected: 1,
    revised: 1,
    created: 1,
    decisions: 1,
    preserved: 1,
    acceptanceCriteria: 3,
    unresolved: 0,
    warnings: summary!.warnings,
    requiresReview: true,
  });
});

// ── Approval: the transition becomes canonical, atomically ──────────────────

test("approving revises the exact rule, creates the decision, and records the request", async () => {
  const { e, inst, runId } = await toGate();
  await e.approve(inst.id);
  await e.drain();

  const done = await instance(inst.id);
  assert.equal(phaseOf(done, "change").status, "succeeded");
  assert.equal(phaseOf(done, "change").steps[0].changeProposal?.status, "accepted");

  const ledger = await readLedger();
  // The rule was REVISED, not duplicated: one logical id, two revisions.
  const rule42 = ledger.claims.filter((c) => c.id === "RULE-42");
  assert.deepEqual(
    rule42.map((c) => c.revision),
    [1, 2],
  );
  assert.match(rule42[1].statement, /500 characters/);
  assert.equal(
    ledger.claims.filter((c) => c.kind === "business-rule").length,
    2,
    "a revision, never a second rule about the same thing",
  );
  // The decision exists and is justified from the proposed revision plus the
  // preserved constraint.
  const decision = ledger.claims.find((c) => c.kind === "decision")!;
  assert.match(decision.statement, /BookingEngine == Kobra/);
  const justification = ledger.justifications.find(
    (j) => j.conclusion.id === decision.id && j.conclusion.revision === 1,
  )!;
  assert.deepEqual(justification.premises, [
    { id: "RULE-42", revision: 2 },
    { id: "CONSTRAINT-8", revision: 1 },
  ]);
  assert.equal(evaluateSupport(ledger, { id: decision.id, revision: 1 }), "supported");

  // CONSTRAINT-8 was preserved: no new revision was created to say so.
  assert.deepEqual(
    ledger.claims.filter((c) => c.id === "CONSTRAINT-8").map((c) => c.revision),
    [1],
  );

  // And the durable change provenance.
  assert.equal(ledger.changeProposals.length, 1);
  const accepted = ledger.changeProposals[0];
  assert.equal(accepted.request.id, "CR-1");
  assert.equal(accepted.request.summary, REQUEST.summary);
  assert.equal(accepted.readiness, "ready");
  assert.deepEqual(accepted.revised, [
    { from: { id: "RULE-42", revision: 1 }, to: { id: "RULE-42", revision: 2 } },
  ]);
  assert.deepEqual(accepted.decisions, [{ id: decision.id, revision: 1 }]);
  assert.deepEqual(accepted.preserved, [{ id: "CONSTRAINT-8", revision: 1 }]);
  assert.equal(accepted.execution.runId, runId);
  assert.equal(accepted.execution.phaseId, "change");

  // The sidecar keeps what it became.
  const record = await readProposalRecord(runId);
  assert.equal(record?.status, "accepted");
  assert.equal(record?.result?.proposal.id, accepted.id);
});

test("acceptance criteria resolve to the canonical revision and stay out of the claim graph", async () => {
  const { e, inst } = await toGate();
  await e.approve(inst.id);
  await e.drain();
  const accepted = (await readLedger()).changeProposals[0];

  assert.deepEqual(
    accepted.acceptanceCriteria.map((c) => [c.id, c.kind, c.relatesTo]),
    [
      ["AC-1", "behavior", [{ id: "RULE-42", revision: 2 }]],
      ["AC-2", "behavior", [{ id: "RULE-42", revision: 2 }]],
      ["AC-3", "regression", [{ id: "CONSTRAINT-8", revision: 1 }]],
    ],
  );
  // No local reference survives the commit.
  assert.equal(JSON.stringify(accepted).includes('"local"'), false);
  // And no criterion became a claim.
  const ledger = await readLedger();
  for (const c of accepted.acceptanceCriteria) {
    assert.equal(
      ledger.claims.some((claim) => claim.statement === c.statement),
      false,
      "an acceptance criterion is evidence about a change, never a business rule",
    );
  }
});

test("request provenance: RULE-42:v2 can be traced back to the proposal and the request", async () => {
  const { e, inst } = await toGate();
  await e.approve(inst.id);
  await e.drain();
  const ledger = await readLedger();

  const proposal = changeProposalOfClaim(ledger, { id: "RULE-42", revision: 2 })!;
  assert.equal(proposal.request.summary, REQUEST.summary);
  // The *previous* revision was not caused by this change.
  assert.equal(changeProposalOfClaim(ledger, { id: "RULE-42", revision: 1 }), null);
  assert.deepEqual(
    changeProposalsForRequest(ledger, "CR-1").map((p) => p.id),
    [proposal.id],
  );
  // Change provenance is not justification: nothing about the request lends
  // the rule support.
  assert.equal(
    ledger.justifications.some((j) => j.note?.includes("CR-1")),
    false,
  );
});

test("a later revision does not rewrite the accepted proposal that referenced v2", async () => {
  const { e, inst } = await toGate();
  await e.approve(inst.id);
  await e.drain();
  await createRevision("RULE-42", { statement: "Kobra comments max 600." }, NOW);

  const ledger = await readLedger();
  assert.equal(activeRevision(ledger, "RULE-42")?.revision, 3);
  const accepted = ledger.changeProposals[0];
  assert.deepEqual(accepted.revised, [
    { from: { id: "RULE-42", revision: 1 }, to: { id: "RULE-42", revision: 2 } },
  ]);
  assert.deepEqual(accepted.acceptanceCriteria[0].relatesTo, [{ id: "RULE-42", revision: 2 }]);
  assert.equal(changeProposalOfClaim(ledger, { id: "RULE-42", revision: 3 }), null);
});

// ── Refusals at intake ──────────────────────────────────────────────────────

test("a supplied rule left unclassified rejects the proposal", async () => {
  const { inst, runId } = await toGate(kobraProposal({ classification: [] }));
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "change").status, "failed");
  assert.equal(failure(after, "change").failureClass, "change-proposal");
  assert.match(String(failure(after, "change").reason), /RULE-42:v1 was supplied/);
  assert.equal((await readProposalRecord(runId))?.status, "rejected");
  assert.deepEqual((await readLedger()).changeProposals, []);
  assert.equal(activeRevision(await readLedger(), "RULE-42")?.revision, 1);
});

test("a business-rule revision with no acceptance criteria is refused, fail-closed", async () => {
  const { inst } = await toGate(kobraProposal({ acceptanceCriteria: [] }));
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "change").status, "failed");
  assert.match(String(failure(after, "change").reason), /no acceptance criterion/);
});

test("a change-intent run that writes no proposal fails rather than passing silently", async () => {
  await seedKnowledge();
  await seed([changePhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "change", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "change").status, "failed");
  assert.match(String(failure(after, "change").reason), /wrote no change proposal/);
});

test("a change-intent run may not also write a KnowledgeDelta file", async () => {
  await seedKnowledge();
  await seed([changePhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeProposal(rec.calls[0], kobraProposal());
  const deltaFile = rec.calls[0].env.ARGUS_KNOWLEDGE_DELTA_FILE!;
  mkdirSync(path.dirname(deltaFile), { recursive: true });
  writeFileSync(
    deltaFile,
    JSON.stringify({ schemaVersion: 1, claims: [{ localId: "x", kind: "fact", statement: "y" }] }),
  );
  await complete(e, inst, "change", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "change").status, "failed");
  assert.match(String(failure(after, "change").reason), /not through a separate KnowledgeDelta/);
  assert.deepEqual(
    (await readLedger()).claims.filter((c) => c.kind === "fact"),
    [],
  );
});

// ── Ambiguity ───────────────────────────────────────────────────────────────

const AMBIGUOUS = {
  schemaVersion: 1,
  classification: [{ rule: "RULE-42:v1", disposition: "unresolved" }],
  unresolved: [
    { id: "Q-1", question: "What should the new maximum be? The request does not say." },
  ],
  metadata: { summary: "The requested change does not state the new limit." },
};

test("an ambiguous request produces an unresolved question, not a guessed value", async () => {
  const { inst, runId } = await toGate(AMBIGUOUS);
  const parked = await instance(inst.id);
  assert.equal(phaseOf(parked, "change").status, "awaiting-approval");
  const record = await readProposalRecord(runId);
  assert.equal(record?.readiness, "needs-input");
  assert.equal(record?.proposal?.semanticDelta, undefined);
  assert.equal(phaseOf(parked, "change").changeIntent?.readiness, "needs-input");

  // No business value was invented: the request's own words mention 500, and
  // the proposal — which proposes no semantic change at all — does not.
  assert.equal(JSON.stringify(record?.proposal).includes("500"), false);

  const review = await buildPhaseReview(parked, "change", await definition());
  assert.ok(review.ok);
  const preview = review.review.changeProposals![0];
  assert.deepEqual(
    preview.unresolved.map((q) => q.id),
    ["Q-1"],
  );
  assert.equal(preview.readiness, "needs-input");
});

test("an approved needs-input proposal is durable, and says so forever", async () => {
  const { e, inst } = await toGate(AMBIGUOUS);
  await e.approve(inst.id);
  await e.drain();
  const ledger = await readLedger();
  assert.equal(ledger.changeProposals[0].readiness, "needs-input");
  assert.deepEqual(ledger.changeProposals[0].semanticChanges, []);
  assert.deepEqual(
    ledger.changeProposals[0].unresolved.map((q) => q.id),
    ["Q-1"],
  );
  assert.equal(activeRevision(ledger, "RULE-42")?.revision, 1);
});

// ── The revise gate ─────────────────────────────────────────────────────────

test("revising supersedes the old proposal; a new attempt may propose differently", async () => {
  const { rec, e, inst, runId } = await toGate();
  await e.revise(inst.id, "500 is wrong — the limit is 400.");
  await e.drain();

  assert.equal((await readProposalRecord(runId))?.status, "superseded");
  assert.deepEqual((await readLedger()).changeProposals, []);

  const second = rec.calls[1];
  assert.notEqual(second.runId, runId);
  writeProposal(second, {
    ...kobraProposal(),
    semanticDelta: {
      ...kobraProposal().semanticDelta,
      revisions: [
        {
          claimId: "RULE-42",
          expectedRevision: 1,
          statement: "Kobra customer comments must not exceed 400 characters.",
          localId: "r42",
        },
      ],
    },
  });
  await complete(e, inst, "change", second.runId);
  await e.drain();
  const e2 = engine(rec.spawn);
  await e2.approve(inst.id);
  await e2.drain();

  const ledger = await readLedger();
  assert.match(activeRevision(ledger, "RULE-42")!.statement, /400 characters/);
  assert.equal(ledger.changeProposals.length, 1, "only the accepted attempt is durable");
  assert.equal(ledger.changeProposals[0].execution.runId, second.runId);
});

// ── Optimistic concurrency ──────────────────────────────────────────────────

test("a rule that moved while the gate waited refuses the whole commit, atomically", async () => {
  const { e, inst, runId } = await toGate();
  // Somebody else revises RULE-42 while the proposal sits at its gate.
  await createRevision("RULE-42", { statement: "Kobra comments max 250." }, NOW);

  await e.approve(inst.id);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "change").status, "failed");
  assert.match(String(failure(after, "change").reason), /stale-revision|expects RULE-42 at v1/);

  const ledger = await readLedger();
  // The rule is at the *other* revision; nothing of this proposal landed.
  assert.equal(activeRevision(ledger, "RULE-42")?.revision, 2);
  assert.match(activeRevision(ledger, "RULE-42")!.statement, /250/);
  assert.equal(
    ledger.claims.some((c) => c.kind === "decision"),
    false,
    "no decision from a refused proposal",
  );
  assert.deepEqual(ledger.changeProposals, []);
  assert.equal((await readProposalRecord(runId))?.status, "rejected");
  assert.equal((await readDeltaRecord(runId))?.status, "rejected");
});

// ── Existing defect versus requested change ─────────────────────────────────

/** Record one conformance result for RULE-42:v1 at the repository's head. */
async function seedViolation() {
  await seedKnowledge();
  const head = headOf(repo);
  await commitPhaseSemantics(
    [],
    [
      {
        execution: { runId: "run-earlier", instanceId: "inst-earlier", phaseId: "verify" },
        rule: { id: "RULE-42", revision: 1 },
        outcome: "violated",
        evidence: [{ type: "observation", note: "the validator already allows 500" }],
        ...(head ? { gitHead: head } : {}),
      },
    ],
    NOW,
  );
  return head;
}

test("an implementation that already violates v1 is warned about, never revised away", async () => {
  await seedViolation();
  const { inst } = await toGate();
  const parked = await instance(inst.id);
  const review = await buildPhaseReview(parked, "change", await definition());
  assert.ok(review.ok);
  const preview = review.review.changeProposals![0];

  // The reviewer sees both facts, unmerged: the rule stands, the code does not.
  assert.deepEqual(
    preview.current.map((r) => [r.ref, r.support, r.conformance]),
    [["RULE-42:v1", "supported", "violated"]],
  );
  assert.ok(preview.warnings.some((w) => w.code === "change-may-be-implemented"));

  const before = await readLedger();
  assert.equal(before.verifications.length, 1);
  assert.equal(before.verifications[0].outcome, "violated");
});

test("the rule is revised because of the request, and the violation history stands", async () => {
  const head = await seedViolation();
  const { e, inst } = await toGate();
  await e.approve(inst.id);
  await e.drain();

  const ledger = await readLedger();
  // The revision happened — because the request asked for it.
  assert.match(activeRevision(ledger, "RULE-42")!.statement, /500 characters/);
  assert.equal(ledger.changeProposals[0].request.summary, REQUEST.summary);

  // History is untouched: the violation of v1 is still recorded, against v1.
  assert.equal(ledger.verifications.length, 1);
  const v = ledger.verifications[0];
  assert.deepEqual(v.rule, { id: "RULE-42", revision: 1 });
  assert.equal(v.outcome, "violated");
  assert.equal(v.execution.runId, "run-earlier");
  assert.equal(ruleConformance(ledger, { id: "RULE-42", revision: 1 }).status, "violated");
  // And the new revision inherits nothing: nobody has verified v2.
  assert.equal(ruleConformance(ledger, { id: "RULE-42", revision: 2 }).status, "unverified");
  if (head) {
    assert.equal(
      ruleConformance(ledger, { id: "RULE-42", revision: 2 }, head).status,
      "unverified",
    );
  }
  // The rule's own support never moved.
  assert.equal(evaluateSupport(ledger, { id: "RULE-42", revision: 1 }), "supported");
});

test("an unverified implementation is surfaced deterministically", async () => {
  const { inst } = await toGate();
  const review = await buildPhaseReview(await instance(inst.id), "change", await definition());
  assert.ok(review.ok);
  assert.ok(
    review.review.changeProposals![0].warnings.some((w) => w.code === "implementation-unverified"),
  );
});

// ── A change that changes nothing ───────────────────────────────────────────

test("a request producing no semantic difference is warned and recorded as such", async () => {
  const { e, inst } = await toGate({
    schemaVersion: 1,
    classification: [
      { rule: "RULE-42:v1", disposition: "not-relevant", note: "the rule already permits this" },
    ],
    metadata: { summary: "Nothing to change." },
  });
  const parked = await instance(inst.id);
  const review = await buildPhaseReview(parked, "change", await definition());
  assert.ok(review.ok);
  assert.ok(
    review.review.changeProposals![0].warnings.some((w) => w.code === "no-semantic-change"),
  );
  await e.approve(inst.id);
  await e.drain();
  const ledger = await readLedger();
  assert.deepEqual(ledger.changeProposals[0].semanticChanges, []);
  assert.equal(activeRevision(ledger, "RULE-42")?.revision, 1);
});

// ── The review surface ──────────────────────────────────────────────────────

test("the gate shows request, current, proposed, preserved, criteria and unresolved", async () => {
  const { inst } = await toGate();
  const review = await buildPhaseReview(await instance(inst.id), "change", await definition());
  assert.ok(review.ok);
  const preview = review.review.changeProposals![0];
  assert.equal(preview.request.summary, REQUEST.summary);
  assert.equal(preview.current[0].statement.includes("180"), true);
  assert.equal(preview.semantic?.proposedRevisions[0].statement.includes("500"), true);
  assert.equal(preview.semantic?.proposedRevisions[0].current?.statement.includes("180"), true);
  assert.deepEqual(
    preview.preserved.map((p) => p.ref),
    ["CONSTRAINT-8:v1"],
  );
  assert.deepEqual(
    preview.semantic?.proposedClaims.map((c) => c.kind),
    ["decision"],
  );
  assert.deepEqual(
    preview.acceptanceCriteria.map((c) => c.id),
    ["AC-1", "AC-2", "AC-3"],
  );
  assert.deepEqual(preview.unresolved, []);
  assert.equal(review.review.changeIntent?.readiness, "ready");
});

// ── Restart ─────────────────────────────────────────────────────────────────

test("a proposal staged before a restart survives it and can still be approved", async () => {
  const { inst, runId } = await toGate();
  // A fresh engine over the same home: the staged record is on disk.
  const rec2 = recordingSpawn();
  const e2 = engine(rec2.spawn);
  const reloaded = await instance(inst.id);
  assert.equal(phaseOf(reloaded, "change").status, "awaiting-approval");
  assert.equal((await readProposalRecord(runId))?.status, "staged");

  await e2.approve(inst.id);
  await e2.drain();
  const ledger = await readLedger();
  assert.equal(ledger.changeProposals.length, 1);
  assert.equal(activeRevision(ledger, "RULE-42")?.revision, 2);
});

// ── The downstream handoff ──────────────────────────────────────────────────

test("an implementation run receives the accepted intent — and no staged one can reach it", async () => {
  await seedKnowledge();
  await seed([changePhase(), implementPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeProposal(rec.calls[0], kobraProposal());
  await complete(e, inst, "change", rec.calls[0].runId);
  await e.drain();

  // Parked: the downstream phase has not started and no change context exists.
  const parked = await instance(inst.id);
  assert.equal(phaseOf(parked, "implement").status, "pending");
  assert.equal(rec.calls.length, 1, "no implementation run while the intent is unapproved");
  assert.deepEqual((await readLedger()).changeProposals, []);

  await e.approve(inst.id);
  await e.drain();

  const call = rec.calls[1];
  assert.ok(call, "the implementation phase starts once the intent is accepted");
  const file = call.env.ARGUS_CHANGE_CONTEXT_FILE;
  assert.ok(file);
  const context = JSON.parse(readFileSync(file, "utf8")) as ChangeContext;
  const accepted = (await readLedger()).changeProposals[0];

  assert.equal(context.schemaVersion, 1);
  assert.equal(context.proposalId, accepted.id);
  assert.equal(context.request.summary, REQUEST.summary);
  assert.equal(context.readiness, "ready");
  assert.deepEqual(context.revised, [
    { from: { id: "RULE-42", revision: 1 }, to: { id: "RULE-42", revision: 2 } },
  ]);
  assert.deepEqual(context.preserved, [{ id: "CONSTRAINT-8", revision: 1 }]);
  assert.equal(context.decisions.length, 1);
  assert.deepEqual(
    context.acceptanceCriteria.map((c) => c.id),
    ["AC-1", "AC-2", "AC-3"],
  );
  assert.deepEqual(context.acceptanceCriteria[0].relatesTo, [{ id: "RULE-42", revision: 2 }]);

  // References, not restatements: what RULE-42:v2 *says* arrives through the
  // KnowledgeContext, which the same run also received.
  assert.equal(readFileSync(file, "utf8").includes("must not exceed 500"), false);
  const knowledge = readFileSync(call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE!, "utf8");
  assert.ok(knowledge.includes("must not exceed 500 characters"));

  // Phase 7 stops here: the run implements nothing, and the ledger holds no
  // artifact or conformance result from it.
  const ledger = await readLedger();
  assert.deepEqual(ledger.verifications, []);
  assert.deepEqual(ledger.artifacts, []);
  assert.equal(
    readFileSync(path.join(repo, "src", "Booking", "KobraCommentValidator.cs"), "utf8"),
    "// max 180\n",
  );
});

test("a needs-input proposal may not drive an implementation", async () => {
  await seedKnowledge();
  await seed([changePhase(), implementPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeProposal(rec.calls[0], AMBIGUOUS);
  await complete(e, inst, "change", rec.calls[0].runId);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "change").status, "succeeded");
  assert.equal(phaseOf(after, "implement").status, "failed");
  assert.equal(failure(after, "implement").failureClass, "configuration");
  assert.match(String(failure(after, "implement").reason), /needs-input/);
});

test("requireReady: false lets an author take an unfinished intent downstream deliberately", async () => {
  await seedKnowledge();
  await seed([
    changePhase(),
    implementPhase({ changeContext: { fromPhase: "change", requireReady: false } }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeProposal(rec.calls[0], AMBIGUOUS);
  await complete(e, inst, "change", rec.calls[0].runId);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const context = JSON.parse(
    readFileSync(rec.calls[1].env.ARGUS_CHANGE_CONTEXT_FILE!, "utf8"),
  ) as ChangeContext;
  assert.equal(context.readiness, "needs-input");
  assert.equal(context.unresolved.length, 1);
});

// ── The journal ─────────────────────────────────────────────────────────────

test("the journal records the proposal being staged and accepted", async () => {
  const { e, inst } = await toGate();
  await e.approve(inst.id);
  await e.drain();
  const kinds = (await readJournal(inst.id)).map((entry) => entry.kind);
  assert.ok(kinds.includes("change.staged"));
  assert.ok(kinds.includes("change.accepted"));
});

// ── Staging layout ──────────────────────────────────────────────────────────

test("the proposal is staged per run, beside the delta and never inside the ledger", async () => {
  const { runId } = await toGate();
  const dir = path.join(home, "argus", "change-proposals", runId);
  assert.ok(existsSync(path.join(dir, "proposal.json")), "the agent's document");
  assert.ok(existsSync(path.join(dir, "staged.json")), "Argus's record");
  const record = JSON.parse(
    readFileSync(path.join(dir, "staged.json"), "utf8"),
  ) as ChangeProposalRecord;
  assert.equal(record.status, "staged");
  assert.equal(
    readFileSync(path.join(home, "argus", "knowledge.json"), "utf8").includes("AC-1"),
    false,
  );
});

test("a malformed request supplied at start fails the phase rather than falling back", async () => {
  await seedKnowledge();
  await seed([changePhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual", {
    triggerPayload: { changeRequest: { id: "CR-99" } },
  }))!;
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "change").status, "failed");
  assert.equal(failure(after, "change").failureClass, "configuration");
  assert.match(String(failure(after, "change").reason), /supplied with this instance is invalid/);
  // Silently answering the pipeline's default request instead would have the
  // run answer a different question from the one somebody asked.
  assert.equal(rec.calls.length, 0);
});
