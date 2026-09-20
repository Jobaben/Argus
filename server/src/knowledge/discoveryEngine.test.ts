import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KnowledgeContext, PhaseFailurePayload, PipelineInstance } from "@argus/contracts";
import { createEngine } from "../pipelineEngine.js";
import type { Engine } from "../pipelineEngine.js";
import { createPipeline, readPipelines, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance } from "../sources/instances.js";
import { readInvocation, readRun } from "../sources/runs.js";
import { buildPhaseReview } from "../sources/artifacts.js";
import { readDeltaRecord } from "./staging.js";
import { createClaim, createEvidence, createRevision, readLedger } from "./store.js";
import { claimsProducedByPhase, formatClaimRef, getClaim } from "./kernel.js";
import { analyzeImpact } from "./impact.js";

/**
 * Business-rule discovery through the engine (Phase 5).
 *
 * The whole workflow on a real repository fixture and a real gate:
 *
 *   repository evidence → candidate KnowledgeDelta → gate → canonical rule
 *     → downstream KnowledgeContext → consumption → artifact → ImpactSet
 *
 * Every assertion is on the ledger on disk, the staged record, the persisted
 * instance or the review payload. The agent is a spawn double whose "work" is
 * the test writing the delta file before signalling, so nothing here depends
 * on a model: every provenance and impact transition is computed by Argus.
 */

let home: string;
let repo: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-discovery-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
  repo = makeRepo();
});

const NOW = new Date("2026-09-19T10:00:00.000Z");
let counter = 0;

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * The fixture repository: a booking module whose Kobra adapter truncates the
 * customer comment at 180 characters. Deterministic evidence for exactly one
 * business rule, and one implementation observation that is *not* a rule.
 */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-discovery-repo-"));
  mkdirSync(path.join(dir, "src", "Booking"), { recursive: true });
  writeFileSync(
    path.join(dir, "src", "Booking", "Booking.cs"),
    ["public sealed class Booking", "{", "    public string Comment { get; set; }", "}", ""].join(
      "\n",
    ),
  );
  writeFileSync(
    path.join(dir, "src", "Booking", "KobraAdapter.cs"),
    [
      "public static class KobraAdapter",
      "{",
      "    public const int MaxCustomerCommentLength = 180;",
      "",
      "    public static string MapComment(string comment) =>",
      "        comment.Length > MaxCustomerCommentLength",
      "            ? comment.Substring(0, MaxCustomerCommentLength)",
      "            : comment;",
      "}",
      "",
    ].join("\n"),
  );
  mkdirSync(path.join(dir, "src", "Other"), { recursive: true });
  writeFileSync(path.join(dir, "src", "Other", "Unrelated.cs"), "// nothing to do with booking\n");
  if (gitAvailable()) {
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], {
        cwd: dir,
        stdio: "ignore",
      });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "init");
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
    return { pid: 1000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}

function engine(spawn: ReturnType<typeof recordingSpawn>["spawn"]) {
  return createEngine({
    now: () => new Date(),
    newId: () => `id-${++counter}`,
    spawn,
    signalUrlBase: "http://localhost:7777",
    maxConcurrent: 4,
    tickMs: 30000,
    parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
  });
}

async function seed(phases: Record<string, unknown>[]) {
  return createPipeline(
    validatePipelineInput({
      name: "discovery",
      trigger: null,
      phases: phases.map((p) => ({ cwd: repo, gated: false, ...p })),
    }),
    NOW,
    "p1",
  );
}

const step = (name = "investigate", prompt = "look at the booking module") => ({ name, prompt });

/** The one phase shape the suite reuses: gated discovery over src/Booking. */
const discoverPhase = (over: Record<string, unknown> = {}) => ({
  id: "discover",
  name: "Discover",
  gated: true,
  steps: [step()],
  discovery: { scope: { paths: ["src/Booking"], label: "Kobra booking" } },
  ...over,
});

function writeDelta(call: Spawned, delta: unknown) {
  const file = call.env.ARGUS_KNOWLEDGE_DELTA_FILE;
  assert.ok(file, "the run must be told where its KnowledgeDelta goes");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof delta === "string" ? delta : JSON.stringify(delta));
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

/** The stored definition, for a review that needs the phase's own policy. */
async function definition() {
  return (await readPipelines()).find((p) => p.id === "p1");
}

const phaseOf = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)!;
const failure = (inst: PipelineInstance, id: string) =>
  (phaseOf(inst, id).payload ?? {}) as PhaseFailurePayload;

/** The candidate a well-behaved discovery agent writes for the fixture. */
function candidateRule(head: string | null) {
  return {
    schemaVersion: 1,
    claims: [
      {
        localId: "comment-limit",
        kind: "business-rule",
        statement: "Kobra bookings restrict customer comments to 180 characters.",
      },
    ],
    evidence: [
      {
        claim: { local: "comment-limit" },
        source: {
          type: "source-code",
          path: "src/Booking/KobraAdapter.cs",
          ...(head ? { gitHead: head } : {}),
          symbol: "KobraAdapter.MaxCustomerCommentLength",
          startLine: 3,
          endLine: 8,
        },
        note: "MapComment truncates at MaxCustomerCommentLength",
      },
    ],
    metadata: { summary: "One rule from the Kobra adapter's comment handling." },
  };
}

const businessRules = (ledger: Awaited<ReturnType<typeof readLedger>>) =>
  ledger.claims.filter((c) => c.kind === "business-rule");

// ── Backwards compatibility ─────────────────────────────────────────────────

test("no discovery policy: an ordinary pipeline behaves exactly as it did before Phase 5", async () => {
  await seed([{ id: "plan", name: "Plan", steps: [step("s", "p")] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  // No discovery instructions in the prompt, and no scope talk.
  assert.doesNotMatch((await readRun(rec.calls[0].runId))!.run.prompt, /Business-rule discovery/);
  // A rule with no evidence at all still commits: the invariant is scoped to
  // discovery-mode deltas, so nothing an existing pipeline does changes.
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Some rule" }],
  });
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(phaseOf(after, "plan").knowledge?.status, "applied");
  assert.equal("discovery" in phaseOf(after, "plan"), false);
  assert.equal(businessRules(await readLedger()).length, 1);
});

// ── Candidate versus canonical ──────────────────────────────────────────────

test("a discovered rule is staged, not canonical, until the gate is approved", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].runId;
  const head = (await readInvocation(runId))?.gitHead ?? null;

  // The agent was told what to look for, and where.
  const prompt = (await readRun(runId))!.run.prompt;
  assert.match(prompt, /Business-rule discovery/);
  assert.match(prompt, /Scope for this invocation \(Kobra booking\): src\/Booking/);
  assert.match(prompt, /is not itself one/);

  writeDelta(rec.calls[0], candidateRule(head));
  await complete(e, inst, "discover", runId);
  await e.drain();

  const parked = await instance(inst.id);
  assert.equal(phaseOf(parked, "discover").status, "awaiting-approval");
  assert.equal(phaseOf(parked, "discover").steps[0].knowledgeDelta?.status, "staged");
  // Nothing canonical: the ledger file does not even exist yet.
  assert.equal(existsSync(path.join(home, "argus", "knowledge.json")), false);
  assert.deepEqual(businessRules(await readLedger()), []);

  // The structured summary is on the phase, for routing and status.
  assert.deepEqual(phaseOf(parked, "discover").discovery, {
    candidates: 1,
    newRules: 1,
    revisions: 0,
    assumptions: 0,
    facts: 0,
    constraints: 0,
    conclusions: 0,
    evidence: 1,
    warnings: 0,
    requiresReview: true,
  });

  await e.approve(inst.id);
  await e.drain();
  const done = await instance(inst.id);
  assert.equal(done.status, "succeeded");
  assert.equal(phaseOf(done, "discover").knowledge?.status, "applied");
  assert.equal(phaseOf(done, "discover").discovery?.requiresReview, false);

  const ledger = await readLedger();
  const rule = businessRules(ledger)[0];
  assert.ok(rule);
  assert.match(rule.id, /^RULE-/);
  assert.equal(rule.revision, 1);
  assert.match(rule.statement, /180 characters/);
  assert.deepEqual(rule.producedBy, { runId, instanceId: inst.id, phaseId: "discover" });
  // The evidence is provenance, not a copy of the source.
  const evidence = ledger.evidence.find((ev) => ev.claim.id === rule.id)!;
  assert.deepEqual(evidence.source, {
    type: "source-code",
    path: "src/Booking/KobraAdapter.cs",
    ...(head ? { gitHead: head } : {}),
    symbol: "KobraAdapter.MaxCustomerCommentLength",
    startLine: 3,
    endLine: 8,
  });
  assert.doesNotMatch(JSON.stringify(ledger), /Substring/);
  // The delta's local id never reaches the ledger.
  assert.equal(JSON.stringify(ledger).includes("comment-limit"), false);
});

// ── The evidence invariant ──────────────────────────────────────────────────

test("a business rule proposed with no evidence fails the step and stages nothing", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Comments max 180" }],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(after.status, "failed");
  assert.equal(failure(after, "discover").failureClass, "knowledge-delta");
  assert.match(failure(after, "discover").reason!, /carries no supporting evidence/);
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "rejected");
  assert.equal(existsSync(path.join(home, "argus", "knowledge.json")), false);
});

test('evidence: "warn" downgrades the invariant to a review warning', async () => {
  await seed([
    discoverPhase({ discovery: { scope: { paths: ["src/Booking"] }, evidence: "warn" } }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Comments max 180" }],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  const parked = await instance(inst.id);
  assert.equal(phaseOf(parked, "discover").status, "awaiting-approval");
  assert.equal(phaseOf(parked, "discover").discovery?.warnings, 1);
  const review = await buildPhaseReview(parked, "discover", await definition());
  assert.ok(review.ok);
  assert.deepEqual(
    review.review.knowledge?.[0].warnings.map((w) => w.code),
    ["business-rule-without-evidence"],
  );
});

// ── Source path safety and existence ────────────────────────────────────────

test("evidence escaping the repository is refused before anything is staged", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Comments max 180" }],
    evidence: [
      {
        claim: { local: "r" },
        source: { type: "source-code", path: "../../outside/secrets.env" },
      },
    ],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(failure(after, "discover").failureClass, "knowledge-delta");
  assert.match(failure(after, "discover").reason!, /repository-relative POSIX path/);
  assert.equal(existsSync(path.join(home, "argus", "knowledge.json")), false);
});

test("evidence pointing at a file that is not there is refused — fail closed", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Comments max 180" }],
    evidence: [
      { claim: { local: "r" }, source: { type: "source-code", path: "src/Booking/Ghost.cs" } },
    ],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.match(failure(after, "discover").reason!, /does not exist in the run's repository/);
});

test("evidence outside the declared scope is refused even though the file exists", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Comments max 180" }],
    evidence: [
      { claim: { local: "r" }, source: { type: "source-code", path: "src/Other/Unrelated.cs" } },
    ],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.match(failure(after, "discover").reason!, /outside this phase's discovery scope/);
});

test("a source file removed while the gate waited refuses the commit at the boundary", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeDelta(rec.calls[0], candidateRule(head));
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  assert.equal(phaseOf(await instance(inst.id), "discover").status, "awaiting-approval");

  rmSync(path.join(repo, "src", "Booking", "KobraAdapter.cs"));
  await e.approve(inst.id);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "discover").status, "failed");
  assert.equal(phaseOf(after, "discover").knowledge?.status, "rejected");
  assert.match(failure(after, "discover").reason!, /does not exist in the run's repository/);
  assert.deepEqual(businessRules(await readLedger()), []);
});

test("historical git evidence: the recorded head is stored, and a later commit does not rewrite it", async () => {
  if (!gitAvailable()) return;
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].runId;
  const head = (await readInvocation(runId))!.gitHead;
  assert.ok(head, "a git repository must record a head at launch");
  assert.equal(head, headOf(repo));

  writeDelta(rec.calls[0], candidateRule(head));
  await complete(e, inst, "discover", runId);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  // The repository moves on.
  writeFileSync(path.join(repo, "src", "Booking", "KobraAdapter.cs"), "// rewritten\n");
  spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", "add", "."], { cwd: repo });
  spawnSync(
    "git",
    ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-q", "-m", "move"],
    {
      cwd: repo,
    },
  );
  assert.notEqual(headOf(repo), head);

  // The evidence still names the commit it was read at. Source identity is
  // historical: nothing retargets it.
  const ledger = await readLedger();
  const evidence = ledger.evidence[0];
  assert.equal(
    (evidence.source as { gitHead?: string }).gitHead,
    head,
    "the evidence keeps the commit it was gathered at",
  );
});

test("evidence naming a commit other than the run's is refused", async () => {
  if (!gitAvailable()) return;
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], candidateRule("0000000000000000000000000000000000000000"));
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  assert.match(
    failure(await instance(inst.id), "discover").reason!,
    /names commit 0000000.*but the run was recorded at/,
  );
});

// ── Assumptions ─────────────────────────────────────────────────────────────

test("assumption + evidence → business rule: both relationships survive the commit", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  const source = (p: string) => ({
    type: "source-code",
    path: p,
    ...(head ? { gitHead: head } : {}),
  });
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [
      {
        localId: "kobra-origin",
        kind: "assumption",
        statement:
          "The 180-character limit originates from a Kobra integration constraint rather than an arbitrary implementation choice.",
      },
      {
        localId: "comment-limit",
        kind: "business-rule",
        statement: "Kobra bookings restrict customer comments to 180 characters.",
      },
    ],
    evidence: [
      { claim: { local: "kobra-origin" }, source: source("src/Booking/KobraAdapter.cs") },
      { claim: { local: "comment-limit" }, source: source("src/Booking/KobraAdapter.cs") },
      { claim: { local: "comment-limit" }, source: source("src/Booking/Booking.cs") },
    ],
    justifications: [
      {
        conclusion: { local: "comment-limit" },
        premises: [{ local: "kobra-origin" }],
        note: "the limit is a domain constraint, not a display truncation",
      },
    ],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const ledger = await readLedger();
  const assumption = ledger.claims.find((c) => c.kind === "assumption")!;
  const rule = ledger.claims.find((c) => c.kind === "business-rule")!;
  assert.ok(assumption && rule);
  // The assumption is a claim of its own — never silently folded into the rule.
  assert.match(assumption.id, /^ASSUME-/);
  assert.equal(ledger.justifications.length, 1);
  assert.deepEqual(ledger.justifications[0].conclusion, { id: rule.id, revision: 1 });
  assert.deepEqual(ledger.justifications[0].premises, [{ id: assumption.id, revision: 1 }]);
  assert.equal(ledger.evidence.filter((ev) => ev.claim.id === rule.id).length, 2);
  assert.equal(ledger.evidence.filter((ev) => ev.claim.id === assumption.id).length, 1);

  // The phase's summary counted them separately.
  const done = await instance(inst.id);
  assert.equal(phaseOf(done, "discover").discovery?.newRules, 1);
  assert.equal(phaseOf(done, "discover").discovery?.assumptions, 1);
});

// ── Existing-rule reconciliation ────────────────────────────────────────────

/** RULE-17:v1 "Kobra comments max = 180", grounded on the 4.1 spec. */
async function seedRule() {
  await createClaim(
    { id: "RULE-17", kind: "business-rule", statement: "Kobra comments max = 180" },
    NOW,
  );
  await createEvidence(
    {
      claim: { id: "RULE-17", revision: 1 },
      direction: "supports",
      source: { type: "document", uri: "spec://kobra/4.1" },
    },
    NOW,
  );
}

test("supplied an existing rule, the agent revises it rather than creating a second one", async () => {
  await seedRule();
  await seed([
    discoverPhase({
      steps: [{ ...step(), knowledgeContext: { claims: ["RULE-17"] } }],
    }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].runId;
  const invocation = (await readInvocation(runId))!;
  assert.deepEqual(invocation.knowledgeContext?.claims, [{ id: "RULE-17", revision: 1 }]);

  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    revisions: [
      {
        claimId: "RULE-17",
        expectedRevision: 1,
        localId: "revised",
        statement: "Kobra comments max = 500",
        revisionNote: "the adapter now truncates at 500",
      },
    ],
    evidence: [
      {
        claim: { local: "revised" },
        source: {
          type: "source-code",
          path: "src/Booking/KobraAdapter.cs",
          ...(invocation.gitHead ? { gitHead: invocation.gitHead } : {}),
        },
      },
    ],
    consumed: ["RULE-17:v1"],
  });
  await complete(e, inst, "discover", runId);
  await e.drain();

  // Before approval: still v1, and only v1.
  assert.equal((await readLedger()).claims.filter((c) => c.id === "RULE-17").length, 1);

  await e.approve(inst.id);
  await e.drain();
  const ledger = await readLedger();
  const revisions = ledger.claims.filter((c) => c.id === "RULE-17");
  assert.deepEqual(
    revisions.map((c) => [c.revision, c.statement]),
    [
      [1, "Kobra comments max = 180"],
      [2, "Kobra comments max = 500"],
    ],
  );
  // One logical rule, not two: no second business-rule id was minted.
  assert.deepEqual(new Set(businessRules(ledger).map((c) => c.id)), new Set(["RULE-17"]));
  assert.deepEqual(
    ledger.consumptions.map((c) => [c.claim.id, c.claim.revision, c.source]),
    [["RULE-17", 1, "supplied-context"]],
  );
});

test("a business-rule revision that adds no evidence is refused, however well worded", async () => {
  await seedRule();
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    revisions: [
      {
        claimId: "RULE-17",
        expectedRevision: 1,
        statement: "Kobra comments max = 500",
        revisionNote: "I read the code",
      },
    ],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(failure(after, "discover").failureClass, "knowledge-delta");
  assert.match(
    failure(after, "discover").reason!,
    /no evidence in this delta can support its new statement/,
  );
  // RULE-17 is untouched.
  assert.equal((await readLedger()).claims.filter((c) => c.id === "RULE-17").length, 1);
});

test("stale revision: the rule moved while the gate waited, so the approval fails atomically", async () => {
  await seedRule();
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "extra", kind: "fact", statement: "KobraAdapter truncates comments" }],
    revisions: [{ claimId: "RULE-17", expectedRevision: 1, localId: "r", statement: "max = 500" }],
    evidence: [
      {
        claim: { local: "r" },
        source: {
          type: "source-code",
          path: "src/Booking/KobraAdapter.cs",
          ...(head ? { gitHead: head } : {}),
        },
      },
      {
        claim: { local: "extra" },
        source: {
          type: "source-code",
          path: "src/Booking/Booking.cs",
          ...(head ? { gitHead: head } : {}),
        },
      },
    ],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();

  // Somebody else revises RULE-17 before the gate is approved.
  await createRevision("RULE-17", { statement: "Kobra comments max = 300" }, NOW);

  await e.approve(inst.id);
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(phaseOf(after, "discover").status, "failed");
  assert.equal(phaseOf(after, "discover").knowledge?.status, "rejected");
  assert.match(failure(after, "discover").reason!, /stale-revision|active revision is v2/);
  // Nothing partial: the fact the same delta proposed is not in the ledger.
  const ledger = await readLedger();
  assert.deepEqual(
    ledger.claims.filter((c) => c.kind === "fact"),
    [],
  );
  assert.equal(ledger.claims.filter((c) => c.id === "RULE-17").length, 2);
});

// ── Gate revision and retry ─────────────────────────────────────────────────

test("gate revision: the rejected candidate never becomes canonical and the next attempt proposes afresh", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeDelta(rec.calls[0], {
    ...candidateRule(head),
    claims: [
      {
        localId: "comment-limit",
        kind: "business-rule",
        statement: "KobraAdapter.cs calls Substring(0, 180).",
      },
    ],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();

  // A reviewer sees an implementation observation dressed as a rule, and
  // sends it back.
  await e.revise(inst.id, "that is an implementation detail; state the business rule");
  const revised = await instance(inst.id);
  assert.equal(phaseOf(revised, "discover").attempt, 1);
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "superseded");
  assert.equal(existsSync(path.join(home, "argus", "knowledge.json")), false);

  // The new attempt proposes a corrected rule.
  const second = rec.calls[1];
  assert.ok(second, "the revise launched a fresh run");
  writeDelta(second, candidateRule(head));
  await complete(e, revised, "discover", second.runId);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const ledger = await readLedger();
  const rules = businessRules(ledger);
  assert.equal(rules.length, 1, "only the accepted attempt's rule is canonical");
  assert.match(rules[0].statement, /restrict customer comments to 180/);
  assert.equal(ledger.deltas.length, 1);
  assert.equal(ledger.deltas[0].attempt, 1);
});

test("retry: a failed attempt's candidates are superseded; only the accepted attempt's enter the ledger", async () => {
  await seed([
    discoverPhase({ retry: { attempts: 2, backoffSeconds: 0, retryOn: ["knowledge-delta"] } }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  // Attempt 1: a rule whose evidence is out of scope — refused.
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "r", kind: "business-rule", statement: "Wrong rule" }],
    evidence: [
      { claim: { local: "r" }, source: { type: "source-code", path: "src/Other/Unrelated.cs" } },
    ],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "rejected");

  await e.reconcile();
  await e.drain();
  const second = rec.calls[1];
  assert.ok(second, "the retry launched a second attempt");
  const head = (await readInvocation(second.runId))?.gitHead ?? null;
  writeDelta(second, candidateRule(head));
  await complete(e, await instance(inst.id), "discover", second.runId);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const ledger = await readLedger();
  assert.equal(businessRules(ledger).length, 1);
  assert.match(businessRules(ledger)[0].statement, /restrict customer comments to 180/);
  assert.equal(ledger.deltas.length, 1);
});

// ── The review surface ──────────────────────────────────────────────────────

test("the gate review shows the candidate rules, their evidence and a proposed revision", async () => {
  await seedRule();
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  const source = (p: string) => ({
    type: "source-code",
    path: p,
    ...(head ? { gitHead: head } : {}),
    startLine: 3,
    endLine: 8,
  });
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [
      { localId: "kobra-origin", kind: "assumption", statement: "The limit is a Kobra constraint" },
    ],
    revisions: [
      {
        claimId: "RULE-17",
        expectedRevision: 1,
        localId: "revised",
        statement: "Kobra comments max = 500",
        revisionNote: "the adapter truncates at 500",
      },
    ],
    evidence: [
      { claim: { local: "kobra-origin" }, source: source("src/Booking/Booking.cs") },
      { claim: { local: "revised" }, source: source("src/Booking/KobraAdapter.cs") },
    ],
    metadata: { summary: "One revision and the assumption behind it." },
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();

  const parked = await instance(inst.id);
  const res = await buildPhaseReview(parked, "discover", await definition());
  assert.ok(res.ok);
  const review = res.review;
  assert.equal(review.status, "awaiting-approval");
  assert.equal(review.canApprove, true);
  const preview = review.knowledge![0];
  assert.equal(preview.status, "staged");
  assert.equal(preview.summary, "One revision and the assumption behind it.");

  // The assumption, named honestly as delta-local.
  assert.deepEqual(preview.proposedClaims[0].ref, {
    display: "local:kobra-origin",
    local: "kobra-origin",
  });
  assert.equal(preview.proposedClaims[0].kind, "assumption");
  assert.equal(preview.proposedClaims[0].evidence.length, 1);

  // The revision, with before and after.
  const rev = preview.proposedRevisions[0];
  assert.equal(rev.claimId, "RULE-17");
  assert.equal(rev.current?.statement, "Kobra comments max = 180");
  assert.equal(rev.statement, "Kobra comments max = 500");
  assert.equal(rev.ref.display, "RULE-17:v2 (proposed)");
  assert.equal(rev.evidence[0].source.type, "source-code");
  assert.equal(rev.stale, undefined);

  // The counts a reviewer sees at a glance.
  assert.equal(review.discovery?.candidates, 2);
  assert.equal(review.discovery?.revisions, 1);
  assert.equal(review.discovery?.assumptions, 1);

  // Everything a reviewer needs is here: no transcript required.
  const json = JSON.stringify(review);
  assert.match(json, /Kobra comments max = 500/);
  assert.match(json, /src\/Booking\/KobraAdapter\.cs/);
  assert.match(json, /The limit is a Kobra constraint/);
});

test("the review only shows this attempt's candidates, never the superseded attempt's", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeDelta(rec.calls[0], candidateRule(head));
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  await e.revise(inst.id, "state the business rule, not the call");
  // The new attempt starts with no summary: the old counts describe
  // candidates nobody can accept any more.
  assert.equal("discovery" in phaseOf(await instance(inst.id), "discover"), false);

  // Attempt 2 proposes something different and parks again.
  const second = rec.calls[1];
  assert.ok(second);
  writeDelta(second, {
    ...candidateRule(head),
    claims: [
      {
        localId: "comment-limit",
        kind: "business-rule",
        statement: "Kobra bookings cap the customer comment at 180 characters.",
      },
    ],
  });
  await complete(e, await instance(inst.id), "discover", second.runId);
  await e.drain();

  const parked = await instance(inst.id);
  const res = await buildPhaseReview(parked, "discover", await definition());
  assert.ok(res.ok);
  assert.equal(res.review.attempt, 1);
  assert.equal(res.review.knowledge?.length, 1, "one preview: this attempt's");
  assert.equal(res.review.knowledge![0].runId, second.runId);
  assert.match(res.review.knowledge![0].proposedClaims[0].statement, /cap the customer comment/);
  // The superseded attempt's candidate is nowhere on the review surface.
  assert.doesNotMatch(JSON.stringify(res.review.knowledge), /restrict customer comments/);
});

// ── The same-instance handoff ───────────────────────────────────────────────

const planPhase = (knowledgeContext: unknown, over: Record<string, unknown> = {}) => ({
  id: "plan",
  name: "Plan",
  needs: ["discover"],
  steps: [{ name: "plan", prompt: "plan the change", knowledgeContext }],
  ...over,
});

async function readContextFile(runId: string): Promise<KnowledgeContext> {
  const invocation = (await readInvocation(runId))!;
  assert.ok(invocation.knowledgeContextFile);
  const { readKnowledgeContext } = await import("./context.js");
  const ctx = await readKnowledgeContext(invocation.knowledgeContextFile);
  assert.ok(ctx);
  return ctx;
}

test("a later phase receives exactly the canonical refs the accepted discovery phase committed", async () => {
  await seed([
    discoverPhase(),
    planPhase({ fromPhases: [{ phaseId: "discover", kinds: ["business-rule"] }] }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  // Discovery proposes a fact, an assumption and a rule.
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [
      { localId: "fact", kind: "fact", statement: "KobraAdapter truncates the comment" },
      { localId: "assume", kind: "assumption", statement: "The limit is a Kobra constraint" },
      {
        localId: "rule",
        kind: "business-rule",
        statement: "Kobra bookings restrict customer comments to 180 characters.",
      },
    ],
    evidence: [
      {
        claim: { local: "rule" },
        source: {
          type: "source-code",
          path: "src/Booking/KobraAdapter.cs",
          ...(head ? { gitHead: head } : {}),
        },
      },
      {
        claim: { local: "fact" },
        source: {
          type: "source-code",
          path: "src/Booking/Booking.cs",
          ...(head ? { gitHead: head } : {}),
        },
      },
      {
        claim: { local: "assume" },
        source: {
          type: "source-code",
          path: "src/Booking/KobraAdapter.cs",
          ...(head ? { gitHead: head } : {}),
        },
      },
    ],
  });
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  await e.approve(inst.id);
  await e.drain();

  const ledger = await readLedger();
  const rule = businessRules(ledger)[0];
  const produced = claimsProducedByPhase(ledger, inst.id, "discover");
  assert.equal(produced.length, 3);

  // The planning run got the rule, and only the rule.
  const planCall = rec.calls[1];
  assert.ok(planCall, "the planning phase launched");
  const supplied = (await readInvocation(planCall.runId))!.knowledgeContext!.claims;
  assert.deepEqual(supplied, [{ id: rule.id, revision: 1 }]);
  const ctx = await readContextFile(planCall.runId);
  assert.deepEqual(
    ctx.claims.map((c) => c.ref),
    [formatClaimRef({ id: rule.id, revision: 1 })],
  );
  assert.equal(ctx.claims[0].kind, "business-rule");
  assert.deepEqual(ctx.metadata?.selection, [
    {
      selector: { id: rule.id, revision: 1 },
      resolved: { id: rule.id, revision: 1 },
      fromPhase: "discover",
    },
  ]);
  // The durable supplied record says the same, and survives pruning.
  assert.deepEqual(
    (await readLedger()).supplied.find((s) => s.execution.runId === planCall.runId)?.claims,
    [{ id: rule.id, revision: 1 }],
  );
  // A local id never travels forward.
  assert.equal(JSON.stringify(ctx).includes('"local"'), false);
});

test("no pre-approval leakage: a downstream phase cannot start on staged candidates", async () => {
  // `plan` depends on `discover`, so it cannot even be planned while the gate
  // waits — and the ledger it would read holds nothing until the commit.
  await seed([discoverPhase(), planPhase({ fromPhases: ["discover"] })]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeDelta(rec.calls[0], candidateRule(head));
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();

  const parked = await instance(inst.id);
  assert.equal(phaseOf(parked, "discover").status, "awaiting-approval");
  assert.equal(phaseOf(parked, "plan").status, "pending");
  assert.equal(rec.calls.length, 1, "nothing downstream was launched");
  // And the source of truth agrees: no applied delta, so nothing to hand on.
  assert.deepEqual(claimsProducedByPhase(await readLedger(), inst.id, "discover"), []);

  await e.approve(inst.id);
  await e.drain();
  assert.equal(rec.calls.length, 2);
  const supplied = (await readInvocation(rec.calls[1].runId))!.knowledgeContext!.claims;
  assert.equal(supplied.length, 1);
});

test("a fromPhases selector naming a phase the ledger has nothing for supplies an empty context", async () => {
  await seed([
    { id: "discover", name: "Discover", steps: [step()] },
    planPhase({ fromPhases: ["discover"] }),
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();
  const planCall = rec.calls[1];
  assert.ok(planCall, "the planning phase launched with an empty context");
  const ctx = await readContextFile(planCall.runId);
  assert.deepEqual(ctx.claims, []);
  assert.doesNotMatch(planCall.env.ARGUS_KNOWLEDGE_CONTEXT_FILE ?? "", /^$/);
});

// ── End to end: discovery → planning → implementation → impact ─────────────

test("end to end: a discovered rule flows to implementation, is consumed, and a later revision reaches its artifact", async () => {
  await seed([
    discoverPhase(),
    planPhase({ fromPhases: [{ phaseId: "discover", kinds: ["business-rule"] }] }),
    {
      id: "implement",
      name: "Implement",
      needs: ["plan"],
      steps: [
        {
          name: "code",
          prompt: "implement it",
          knowledgeContext: { fromPhases: [{ phaseId: "discover", kinds: ["business-rule"] }] },
        },
      ],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const discoverRun = rec.calls[0].runId;
  const head = (await readInvocation(discoverRun))?.gitHead ?? null;

  // 1. Discovery proposes the rule from repository evidence.
  writeDelta(rec.calls[0], candidateRule(head));
  await complete(e, inst, "discover", discoverRun);
  await e.drain();
  assert.deepEqual(businessRules(await readLedger()), [], "nothing canonical before approval");

  // 2. The human gate accepts it.
  await e.approve(inst.id);
  await e.drain();
  const rule = businessRules(await readLedger())[0];
  assert.ok(rule);
  const ruleRef = { id: rule.id, revision: 1 };

  // 3. Planning receives the exact canonical ref.
  const planCall = rec.calls[1];
  assert.deepEqual((await readInvocation(planCall.runId))!.knowledgeContext!.claims, [ruleRef]);
  await complete(e, await instance(inst.id), "plan", planCall.runId);
  await e.drain();

  // 4. Implementation receives it, declares it consumed, and records an artifact.
  const implCall = rec.calls[2];
  assert.ok(implCall, "implementation launched");
  assert.deepEqual((await readInvocation(implCall.runId))!.knowledgeContext!.claims, [ruleRef]);
  writeFileSync(path.join(repo, "src", "Booking", "CommentValidator.cs"), "// generated\n");
  writeDelta(implCall, {
    schemaVersion: 1,
    consumed: [formatClaimRef(ruleRef)],
    artifacts: [{ location: "repository", path: "src/Booking/CommentValidator.cs" }],
  });
  await complete(e, await instance(inst.id), "implement", implCall.runId);
  await e.drain();

  const done = await instance(inst.id);
  assert.equal(done.status, "succeeded");
  const ledger = await readLedger();
  // Supplied and consumed are two facts, and the edge is classified.
  assert.deepEqual(
    ledger.consumptions.map((c) => [c.claim.id, c.claim.revision, c.source, c.execution.runId]),
    [[rule.id, 1, "supplied-context", implCall.runId]],
  );
  assert.deepEqual(
    ledger.artifacts.map((a) => [a.artifact.path, a.execution.runId]),
    [["src/Booking/CommentValidator.cs", implCall.runId]],
  );

  // 5. Rediscovery later revises the rule. The impact set reaches the
  //    implementation run and the artifact it produced — computed entirely
  //    from provenance, with no model involved.
  await createRevision(
    rule.id,
    { statement: "Kobra bookings restrict customer comments to 500 characters." },
    NOW,
  );
  const set = analyzeImpact(await readLedger(), ruleRef);
  assert.deepEqual(set.root.conditions, ["superseded"]);
  assert.deepEqual(
    set.executions.map((x) => x.execution.runId),
    [implCall.runId],
  );
  assert.deepEqual(
    set.artifacts.map((a) => a.artifact.path),
    ["src/Booking/CommentValidator.cs"],
  );
  // The historical rule revision is still exactly what the implementation was
  // given: revising it created a record, it did not rewrite one.
  assert.equal(getClaim(await readLedger(), ruleRef)?.statement, rule.statement);
});

// ── Restart ─────────────────────────────────────────────────────────────────

test("restart while awaiting approval: the staged candidates and their preview survive", async () => {
  await seed([discoverPhase()]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const head = (await readInvocation(rec.calls[0].runId))?.gitHead ?? null;
  writeDelta(rec.calls[0], candidateRule(head));
  await complete(e, inst, "discover", rec.calls[0].runId);
  await e.drain();

  // A fresh engine over the same home — nothing in memory carries over.
  const rec2 = recordingSpawn();
  const e2 = engine(rec2.spawn);
  const parked = await instance(inst.id);
  assert.equal(phaseOf(parked, "discover").status, "awaiting-approval");
  assert.equal(phaseOf(parked, "discover").steps[0].knowledgeDelta?.status, "staged");
  assert.equal(phaseOf(parked, "discover").discovery?.newRules, 1);
  const res = await buildPhaseReview(parked, "discover", await definition());
  assert.ok(res.ok);
  assert.equal(res.review.knowledge?.[0].proposedClaims.length, 1);

  await e2.approve(inst.id);
  await e2.drain();
  assert.equal(businessRules(await readLedger()).length, 1);
  assert.equal(phaseOf(await instance(inst.id), "discover").knowledge?.status, "applied");
});
