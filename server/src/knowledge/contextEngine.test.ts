import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KnowledgeContext, PhaseFailurePayload, PipelineInstance } from "@argus/contracts";
import { createEngine } from "../pipelineEngine.js";
import type { Engine } from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance } from "../sources/instances.js";
import { readInvocation, readRun, runInvocationDir } from "../sources/runs.js";
import { readJournal } from "../sources/journal.js";
import { createClaim, createEvidence, createRevision, readLedger } from "./store.js";
import { readDeltaRecord } from "./staging.js";
import {
  compareSuppliedConsumed,
  knowledgeContextFile,
  readKnowledgeContext,
  sha256Hex,
} from "./context.js";
import { analyzeImpact } from "./impact.js";
import { executionProvenance } from "./kernel.js";

/**
 * Controlled semantic context delivery through the engine (Phase 4): a step
 * authored with a `knowledgeContext` is launched with a read-only file Argus
 * materialized from one ledger snapshot, the invocation record proves exactly
 * what was supplied, and the agent's later `consumed` declaration is
 * classified against it — without a supplied claim ever becoming a
 * consumption. The agent is a spawn double; its "work" is the test writing
 * the delta file before signalling.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-knowledge-context-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
});

const NOW = new Date("2026-09-19T10:00:00.000Z");
const v = (id: string, revision: number) => ({ id, revision });

let counter = 0;
function deferred() {
  let resolve!: (v: { code: number | null }) => void;
  const promise = new Promise<{ code: number | null }>((r) => (resolve = r));
  return { promise, resolve };
}

interface Spawned {
  runId: string;
  env: Record<string, string>;
  prompt: string;
  cwd: string;
}

function recordingSpawn() {
  const calls: Spawned[] = [];
  const spawn = (
    run: { id: string; cwd: string; prompt: string },
    _log: string,
    env: Record<string, string>,
  ) => {
    calls.push({ runId: run.id, env, prompt: run.prompt, cwd: run.cwd });
    const d = deferred();
    return { pid: 1000 + calls.length, done: d.promise };
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

async function seed(phases: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return createPipeline(
    validatePipelineInput({
      name: "context",
      trigger: null,
      phases: phases.map((p) => ({ cwd: home, gated: false, ...p })),
      ...over,
    }),
    NOW,
    "p1",
  );
}

/** RULE-17:v1 → v2 (v1 superseded), CONSTRAINT-4:v1, FACT-2:v1 — all grounded. */
async function seedLedger() {
  await createClaim({ id: "RULE-17", kind: "business-rule", statement: "Comment max is 180" }, NOW);
  await createRevision(
    "RULE-17",
    { statement: "Comment max is 500", revisionNote: "Kobra 4.2 raised the limit" },
    NOW,
  );
  await createClaim(
    { id: "CONSTRAINT-4", kind: "constraint", statement: "Validation runs server-side" },
    NOW,
  );
  await createClaim({ id: "FACT-2", kind: "fact", statement: "Kobra strips HTML" }, NOW);
  for (const claim of [v("RULE-17", 2), v("CONSTRAINT-4", 1), v("FACT-2", 1)]) {
    await createEvidence(
      { claim, direction: "supports", source: { type: "document", uri: `spec://${claim.id}` } },
      NOW,
    );
  }
}

function writeDelta(call: Spawned, delta: unknown) {
  const file = call.env.ARGUS_KNOWLEDGE_DELTA_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(delta));
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

const refsOf = (ctx: KnowledgeContext | null) => ctx?.claims.map((c) => c.ref) ?? [];

// ── Backwards compatibility ─────────────────────────────────────────────────

test("no semantic context: a legacy step receives no file, no variable, no channel, and its record says so", async () => {
  await seedLedger();
  await seed([{ id: "only", name: "Only", steps: [{ name: "s", prompt: "p" }] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  assert.equal("ARGUS_KNOWLEDGE_CONTEXT_FILE" in call.env, false);
  assert.equal(call.prompt.includes("Semantic context supplied"), false);
  assert.equal(existsSync(knowledgeContextFile(call.runId)), false);
  const invocation = (await readInvocation(call.runId))!;
  assert.equal(invocation.knowledgeContextFile, null);
  assert.equal(invocation.knowledgeContext, null);
  assert.equal(
    invocation.channels?.some((c) => c.kind === "knowledge-context"),
    false,
  );
  assert.deepEqual(
    invocation.channels?.map((c) => c.kind),
    ["knowledge-delta", "artifact-dir"],
  );
  await complete(e, inst, "only", call.runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");
  const kinds = (await readJournal(inst.id)).map((j) => j.kind);
  assert.equal(kinds.includes("knowledge.supplied"), false);
});

// ── Selection, materialization, provenance ──────────────────────────────────

test("exact + active selectors: the run receives exactly the resolved revisions, in a per-run read-only file whose hash is on the invocation record", async () => {
  await seedLedger();
  await seed([
    {
      id: "implement",
      name: "Implement",
      steps: [
        {
          name: "code",
          prompt: "Implement the validator.",
          knowledgeContext: { claims: ["RULE-17", "CONSTRAINT-4:v1"] },
        },
      ],
      capabilities: { filesystem: "workspace-write" },
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];

  // The channel: per run, under its own invocation directory.
  const file = call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE;
  assert.equal(file, knowledgeContextFile(call.runId));
  assert.equal(path.dirname(file), runInvocationDir(call.runId));
  assert.ok(existsSync(file));

  // The document: "active" resolved to v2 and frozen; the exact selector kept v1 of the constraint.
  const text = readFileSync(file, "utf8");
  const ctx = JSON.parse(text) as KnowledgeContext;
  assert.equal(ctx.schemaVersion, 1);
  assert.deepEqual(refsOf(ctx), ["RULE-17:v2", "CONSTRAINT-4:v1"]);
  assert.equal(ctx.claims[0].statement, "Comment max is 500");
  assert.equal(ctx.claims[0].lifecycle, "active");
  assert.equal(ctx.claims[0].support, "supported");
  assert.deepEqual(ctx.metadata?.selection?.[0], {
    selector: { id: "RULE-17", revision: "active" },
    resolved: v("RULE-17", 2),
  });

  // The record: exact refs and the hash of the bytes on disk.
  const invocation = (await readInvocation(call.runId))!;
  assert.equal(invocation.knowledgeContextFile, file);
  assert.deepEqual(invocation.knowledgeContext, {
    schemaVersion: 1,
    claims: [v("RULE-17", 2), v("CONSTRAINT-4", 1)],
    sha256: sha256Hex(text),
  });
  const channel = invocation.channels?.find((c) => c.kind === "knowledge-context");
  assert.deepEqual(channel, {
    kind: "knowledge-context",
    envVar: "ARGUS_KNOWLEDGE_CONTEXT_FILE",
    path: file,
    access: "read",
    required: true,
    status: "granted",
  });
  // Claude Code was told to admit the directory and deny edits under it.
  assert.ok(invocation.args.includes("--add-dir") && invocation.args.includes(path.dirname(file)));
  const denied = invocation.args[invocation.args.indexOf("--disallowedTools") + 1];
  assert.ok(denied.includes(`Edit(//${path.dirname(file)}/**)`));

  // The prompt names what the file holds; the system prompt carries the contract.
  assert.match(
    call.prompt,
    /Semantic context supplied\. Argus has placed 2 canonical claim revisions \(RULE-17:v2, CONSTRAINT-4:v1\)/,
  );
  assert.match(
    invocation.args[invocation.args.indexOf("--append-system-prompt") + 1],
    /ARGUS_KNOWLEDGE_CONTEXT_FILE/,
  );
  const journal = await readJournal(inst.id);
  const supplied = journal.find((j) => j.kind === "knowledge.supplied");
  assert.equal(supplied?.runId, call.runId);
  assert.match(supplied?.detail ?? "", /^RULE-17:v2, CONSTRAINT-4:v1 \(sha256 [0-9a-f]{12}\)$/);
});

test("historical guarantee: a revision created while the agent runs never reaches its context, and the record stays on what it received", async () => {
  await seedLedger();
  await seed([
    {
      id: "implement",
      name: "Implement",
      steps: [{ name: "code", prompt: "p", knowledgeContext: { claims: ["RULE-17"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  const before = readFileSync(call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE, "utf8");

  // The ledger moves on while the agent is running.
  await createRevision("RULE-17", { statement: "Comment max is 1000" }, NOW);
  assert.equal(readFileSync(call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE, "utf8"), before);
  assert.deepEqual((await readInvocation(call.runId))!.knowledgeContext!.claims, [v("RULE-17", 2)]);

  // The agent declares what it was given; the commit records it against v2, not v3.
  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-17:v2"] });
  await complete(e, inst, "implement", call.runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");
  const ledger = await readLedger();
  assert.deepEqual(ledger.consumptions, [
    {
      claim: v("RULE-17", 2),
      execution: { runId: call.runId, instanceId: inst.id, phaseId: "implement" },
      createdAt: ledger.consumptions[0].createdAt,
      source: "supplied-context",
    },
  ]);
  // Inspectable after a "restart": a fresh engine, the records re-read from disk.
  engine(recordingSpawn().spawn);
  const again = (await readInvocation(call.runId))!;
  assert.deepEqual(again.knowledgeContext!.claims, [v("RULE-17", 2)]);
  assert.deepEqual(refsOf(await readKnowledgeContext(again.knowledgeContextFile!)), ["RULE-17:v2"]);
  assert.equal(again.knowledgeContext!.sha256, sha256Hex(before));
  // A *new* attempt would see v3: the snapshot is per phase attempt, not per pipeline.
  const rec2 = recordingSpawn();
  const inst2 = (await engine(rec2.spawn).start("p1", "manual"))!;
  assert.ok(inst2);
  assert.deepEqual(
    refsOf(await readKnowledgeContext(rec2.calls[0].env.ARGUS_KNOWLEDGE_CONTEXT_FILE)),
    ["RULE-17:v3"],
  );
});

test("superseded exact revision and unsupported claim are supplied as requested, with their state exposed", async () => {
  await seedLedger();
  await createClaim(
    { id: "ASSUME-9", kind: "assumption", statement: "Comments are plain text" },
    NOW,
  );
  await seed([
    {
      id: "review",
      name: "Review",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-17:v1", "ASSUME-9"] } }],
    },
  ]);
  const rec = recordingSpawn();
  await engine(rec.spawn).start("p1", "manual");
  const ctx = (await readKnowledgeContext(rec.calls[0].env.ARGUS_KNOWLEDGE_CONTEXT_FILE))!;
  assert.deepEqual(
    ctx.claims.map((c) => [c.ref, c.lifecycle, c.support]),
    [
      ["RULE-17:v1", "superseded", "unsupported"],
      ["ASSUME-9:v1", "active", "unsupported"],
    ],
  );
  assert.equal(ctx.claims[0].supersededBy, "RULE-17:v2");
});

test("phase-level context reaches every step, a step's own replaces it, and each run gets its own file", async () => {
  await seedLedger();
  await seed([
    {
      id: "implement",
      name: "Implement",
      knowledgeContext: { claims: ["RULE-17", "CONSTRAINT-4"] },
      steps: [
        { name: "a", prompt: "p" },
        { name: "b", prompt: "p", knowledgeContext: { claims: ["FACT-2:v1"] } },
        { name: "c", prompt: "p" },
      ],
    },
  ]);
  const rec = recordingSpawn();
  await engine(rec.spawn).start("p1", "manual");
  assert.equal(rec.calls.length, 3);
  const byStep = Object.fromEntries(
    await Promise.all(
      rec.calls.map(async (c) => {
        const inv = (await readInvocation(c.runId))!;
        return [
          inv.step,
          {
            file: c.env.ARGUS_KNOWLEDGE_CONTEXT_FILE,
            refs: refsOf(await readKnowledgeContext(c.env.ARGUS_KNOWLEDGE_CONTEXT_FILE)),
          },
        ];
      }),
    ),
  );
  assert.deepEqual(byStep.a.refs, ["RULE-17:v2", "CONSTRAINT-4:v1"]);
  assert.deepEqual(byStep.b.refs, ["FACT-2:v1"]);
  assert.deepEqual(byStep.c.refs, ["RULE-17:v2", "CONSTRAINT-4:v1"]);
  assert.equal(new Set([byStep.a.file, byStep.b.file, byStep.c.file]).size, 3);
  for (const c of rec.calls)
    assert.equal(path.dirname(c.env.ARGUS_KNOWLEDGE_CONTEXT_FILE), runInvocationDir(c.runId));
});

// ── Validation at launch ────────────────────────────────────────────────────

test("invalid reference: an unknown claim or revision fails the step as configuration before any process starts", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-17:v2", "NOPE-1"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  assert.equal(rec.calls.length, 0, "nothing is spawned");
  const after = await instance(inst.id);
  assert.equal(after.status, "failed");
  const payload = after.phases[0].payload as PhaseFailurePayload;
  assert.equal(payload.failureClass, "configuration");
  assert.match(
    payload.reason ?? "",
    /knowledge context unknown-claim: knowledgeContext\.claims\[1\] \(NOPE-1 \(active\)\): claim NOPE-1 does not exist/,
  );
  const runId = after.phases[0].steps[0].runId!;
  const run = (await readRun(runId))!.run;
  assert.equal(run.status, "failed");
  assert.equal(run.termination, "spawn-failed");
  assert.match(run.error ?? "", /NOPE-1 does not exist/);
  assert.equal(existsSync(knowledgeContextFile(runId)), false);

  await createPipeline(
    validatePipelineInput({
      name: "context-2",
      trigger: null,
      phases: [
        {
          id: "a",
          name: "A",
          cwd: home,
          gated: false,
          steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-17:v7"] } }],
        },
      ],
    }),
    NOW,
    "p2",
  );
  const inst2 = (await e.start("p2", "manual"))!;
  const after2 = await instance(inst2.id);
  assert.equal(after2.status, "failed");
  assert.match(
    (after2.phases[0].payload as PhaseFailurePayload).reason ?? "",
    /unknown-revision: .*revision v7 of RULE-17 does not exist/,
  );
  // Never retried: configuration is not a retryable class.
  await e.reconcile();
  await e.drain();
  assert.equal(rec.calls.length, 0);
});

// ── Supplied ≠ consumed, and impact ─────────────────────────────────────────

test("supplied ≠ consumed: the agent receives A and B, consumes A and discovers C; only A and C become consumption edges, classified; impact follows consumption alone", async () => {
  await seedLedger();
  // A = RULE-17:v2, B = CONSTRAINT-4:v1 (both supplied); C = FACT-2:v1 (discovered).
  await seed([
    {
      id: "implement",
      name: "Implement",
      steps: [
        { name: "code", prompt: "p", knowledgeContext: { claims: ["RULE-17", "CONSTRAINT-4:v1"] } },
      ],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  writeDelta(call, {
    schemaVersion: 1,
    consumed: ["RULE-17:v2", "FACT-2:v1"],
    artifacts: [{ location: "artifact-dir", path: "validator.md" }],
  });
  writeFileSync(path.join(call.env.ARGUS_ARTIFACT_DIR, "validator.md"), "# validator\n");
  await complete(e, inst, "implement", call.runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");

  // The staged record shows supplied and consumed side by side.
  const record = (await readDeltaRecord(call.runId))!;
  assert.equal(record.status, "applied");
  assert.deepEqual(record.supplied, [v("RULE-17", 2), v("CONSTRAINT-4", 1)]);
  assert.deepEqual(record.delta?.consumed, [v("RULE-17", 2), v("FACT-2", 1)]);
  assert.deepEqual(compareSuppliedConsumed(record.supplied!, record.delta!.consumed!), {
    suppliedAndConsumed: [v("RULE-17", 2)],
    suppliedNotConsumed: [v("CONSTRAINT-4", 1)],
    consumedNotSupplied: [v("FACT-2", 1)],
  });

  // The ledger: two consumption edges, classified; none for B.
  const ledger = await readLedger();
  assert.deepEqual(
    ledger.consumptions.map((c) => [c.claim.id, c.source]),
    [
      ["RULE-17", "supplied-context"],
      ["FACT-2", "agent-discovered"],
    ],
  );
  assert.equal(
    ledger.consumptions.some((c) => c.claim.id === "CONSTRAINT-4"),
    false,
  );
  const provenance = executionProvenance(ledger, call.runId)!;
  assert.deepEqual(
    provenance.consumed.map((c) => [c.claim.id, c.source]),
    [
      ["RULE-17", "supplied-context"],
      ["FACT-2", "agent-discovered"],
    ],
  );

  // Impact: changing B (supplied, not consumed) does not touch the run.
  await createRevision("CONSTRAINT-4", { statement: "Validation runs client-side" }, NOW);
  const bImpact = analyzeImpact(await readLedger(), v("CONSTRAINT-4", 1));
  assert.deepEqual(bImpact.root.conditions, ["superseded"]);
  assert.deepEqual(bImpact.executions, []);
  assert.deepEqual(bImpact.artifacts, []);

  // Impact: changing A (consumed) impacts the run and its artifact.
  await createRevision("RULE-17", { statement: "Comment max is 1000" }, NOW);
  const aImpact = analyzeImpact(await readLedger(), v("RULE-17", 2));
  assert.deepEqual(
    aImpact.executions.map((x) => [x.execution.runId, x.reasons, x.consumed]),
    [[call.runId, ["consumed-affected-claim"], [v("RULE-17", 2)]]],
  );
  assert.deepEqual(
    aImpact.artifacts.map((a) => a.artifact),
    [{ location: "artifact-dir", path: "validator.md" }],
  );

  // Impact: changing C (consumed, discovered) impacts the run too — discovery
  // is consumption; supply is not.
  await createRevision("FACT-2", { statement: "Kobra keeps HTML" }, NOW);
  const cImpact = analyzeImpact(await readLedger(), v("FACT-2", 1));
  assert.deepEqual(
    cImpact.executions.map((x) => x.execution.runId),
    [call.runId],
  );
});

test("a run with a context that proposes nothing creates no consumption: supply alone is never dependency provenance", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [
        { name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-17", "CONSTRAINT-4"] } },
      ],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await complete(e, inst, "a", rec.calls[0].runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");
  const ledger = await readLedger();
  assert.deepEqual(ledger.consumptions, []);
  // Supply alone is durable provenance, but it is not *reliance* provenance:
  // the execution has no consumption or production report (Phase 4.1 §5).
  assert.equal(executionProvenance(ledger, rec.calls[0].runId), null);
  assert.deepEqual(ledger.supplied[0].claims, [v("RULE-17", 2), v("CONSTRAINT-4", 1)]);
  await createRevision("RULE-17", { statement: "x" }, NOW);
  assert.deepEqual(analyzeImpact(await readLedger(), v("RULE-17", 2)).executions, []);
});

test("a run launched without a context that consumes a claim records it as agent-discovered", async () => {
  await seedLedger();
  await seed([{ id: "a", name: "A", steps: [{ name: "s", prompt: "p" }] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], { schemaVersion: 1, consumed: ["RULE-17:v2"] });
  await complete(e, inst, "a", rec.calls[0].runId);
  await e.drain();
  const ledger = await readLedger();
  assert.equal(ledger.consumptions[0].source, "agent-discovered");
  assert.deepEqual((await readDeltaRecord(rec.calls[0].runId))!.supplied, []);
});
