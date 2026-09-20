import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExecutionContextReport,
  PhaseFailurePayload,
  PipelineInstance,
  SuppliedToReport,
} from "@argus/contracts";
import { createEngine } from "../pipelineEngine.js";
import type { Engine } from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance } from "../sources/instances.js";
import { pruneRuns, readInvocation, readRun, runInvocationDir } from "../sources/runs.js";
import { readJournal } from "../sources/journal.js";
import { paths } from "../claudeHome.js";
import {
  createClaim,
  createEvidence,
  createRevision,
  readLedger,
  registerSuppliedContext,
} from "./store.js";
import { readDeltaRecord } from "./staging.js";
import { knowledgeContextFile, sha256Hex } from "./context.js";
import { analyzeImpact } from "./impact.js";
import {
  KnowledgeValidationError,
  suppliedContextOf,
  suppliedToReport,
  emptyLedger,
  recordSuppliedContext,
} from "./kernel.js";

/**
 * Phase 4.1 — durable supplied provenance and context integrity.
 *
 * Two hardenings of the Phase 4 protocol, proven through the engine:
 *
 * 1. **Durable supply.** "Run R was supplied RULE-17:v2" is written into
 *    `knowledge.json` before the process exists, so it outlives the run
 *    record, the invocation directory and the materialized context file —
 *    the operational artifacts retention is allowed to reclaim.
 * 2. **Integrity.** The hash Argus took at launch is re-checked when the
 *    completion is accepted. Changed or vanished bytes refuse the completion
 *    deterministically; a *ledger* that moved on does not.
 *
 * What neither of them may do is turn supply into consumption. Impact stays
 * consumption-based, and that is asserted from both sides here.
 *
 * The agent is a spawn double; its "work" is the test writing (or tampering
 * with) files before signalling.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-knowledge-durable-"));
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
}

function recordingSpawn() {
  const calls: Spawned[] = [];
  const spawn = (
    run: { id: string; cwd: string; prompt: string },
    _log: string,
    env: Record<string, string>,
  ) => {
    calls.push({ runId: run.id, env, prompt: run.prompt });
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
      name: "durable",
      trigger: null,
      phases: phases.map((p) => ({ cwd: home, gated: false, ...p })),
      ...over,
    }),
    NOW,
    "p1",
  );
}

/** A:v1, B:v1, C:v1 — all grounded by a document. */
async function seedLedger() {
  for (const [id, kind, statement] of [
    ["RULE-A", "business-rule", "A"],
    ["RULE-B", "business-rule", "B"],
    ["FACT-C", "fact", "C"],
  ] as const) {
    await createClaim({ id, kind, statement }, NOW);
    await createEvidence(
      {
        claim: { id, revision: 1 },
        direction: "supports",
        source: { type: "document", uri: `spec://${id}` },
      },
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

const failure = (inst: PipelineInstance, phaseId: string) =>
  (inst.phases.find((p) => p.id === phaseId)?.payload ?? {}) as PhaseFailurePayload;

/** Overwrite a 0444 context file the way a careless agent (or a runtime whose
 *  read-only enforcement is best-effort) would. */
function tamper(file: string, text: string) {
  chmodSync(file, 0o644);
  writeFileSync(file, text);
}

// ── Durable supply ──────────────────────────────────────────────────────────

test("durable supply: the exact refs, hash, attempt and time land in knowledge.json before the process starts", async () => {
  await seedLedger();
  await seed([
    {
      id: "implement",
      name: "Implement",
      steps: [{ name: "code", prompt: "p", knowledgeContext: { claims: ["RULE-A", "RULE-B:v1"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];

  // Written by the time the process exists: the spawn double already ran.
  const ledger = await readLedger();
  const supplied = suppliedContextOf(ledger, call.runId);
  assert.ok(supplied);
  assert.deepEqual(supplied.claims, [v("RULE-A", 1), v("RULE-B", 1)]);
  assert.deepEqual(supplied.execution, {
    runId: call.runId,
    instanceId: inst.id,
    phaseId: "implement",
  });
  assert.equal(supplied.attempt, 0);
  assert.equal(supplied.schemaVersion, 1);
  assert.equal(
    supplied.sha256,
    sha256Hex(readFileSync(call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE, "utf8")),
  );
  assert.match(supplied.suppliedAt, /^20/);

  // And it agrees, exactly, with the operational launch record.
  const invocation = (await readInvocation(call.runId))!;
  assert.deepEqual(invocation.knowledgeContext, {
    schemaVersion: 1,
    claims: supplied.claims,
    sha256: supplied.sha256,
  });
});

test("revision stability: a revision created later never retargets the durable record", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  await complete(e, inst, "a", call.runId);
  await e.drain();

  await createRevision("RULE-A", { statement: "A'" }, NOW);
  await createRevision("RULE-A", { statement: "A''" }, NOW);

  const ledger = await readLedger();
  assert.deepEqual(suppliedContextOf(ledger, call.runId)!.claims, [v("RULE-A", 1)]);
  // And the reverse query still answers on the exact revision, not the id.
  assert.deepEqual(
    suppliedToReport(ledger, v("RULE-A", 1)).executions.map((x) => x.execution.runId),
    [call.runId],
  );
  assert.deepEqual(suppliedToReport(ledger, v("RULE-A", 3)).executions, []);
});

test("retry: two attempts keep independent supplied provenance, each on the revision it received", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
      retry: { attempts: 2, backoffSeconds: 0, retryOn: ["signal"] },
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const first = rec.calls[0];
  await e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId: "a",
    runId: first.runId,
    type: "failed",
    token: inst.signalToken,
    payload: { reason: "nope" },
  });
  await e.drain();

  assert.ok((await instance(inst.id)).phases[0].retryAt, "a retry is scheduled");

  // The ledger moves on between the attempts; the retry tick launches attempt 2.
  await createRevision("RULE-A", { statement: "A'" }, NOW);
  await e.reconcile();
  await e.drain();
  assert.equal(rec.calls.length, 2);
  assert.equal((await instance(inst.id)).phases[0].attempt, 1);
  const second = rec.calls[1];
  assert.notEqual(second.runId, first.runId);

  const ledger = await readLedger();
  assert.deepEqual(suppliedContextOf(ledger, first.runId)!.claims, [v("RULE-A", 1)]);
  assert.deepEqual(suppliedContextOf(ledger, second.runId)!.claims, [v("RULE-A", 2)]);
  assert.equal(suppliedContextOf(ledger, first.runId)!.attempt, 0);
  assert.equal(suppliedContextOf(ledger, second.runId)!.attempt, 1);
  assert.deepEqual(
    suppliedToReport(ledger, v("RULE-A", 1)).executions.map((x) => x.execution.runId),
    [first.runId],
  );
});

test("supply is recorded for an attempted invocation that never ran, and says only that", async () => {
  // The chosen invariant (docs/KNOWLEDGE-LEDGER.md §13.10): the durable record
  // attests that Argus materialized and named this context to this attempted
  // invocation — not that the process ran. Here the launch is refused after
  // the context exists, because the runtime cannot enforce the declared
  // profile. The supply is durable; no consumption, production or applied
  // delta ever appears for the run, which is how "prepared" reads differently
  // from "ran".
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
      // `qwen` cannot honour a filesystem restriction; strict enforcement
      // refuses the launch.
      runtime: "qwen",
      capabilities: { filesystem: "read-only", enforcement: "strict" },
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await e.drain();
  assert.equal(rec.calls.length, 0, "nothing was spawned");
  const after = await instance(inst.id);
  assert.equal(after.phases[0].status, "failed");
  assert.equal(failure(after, "a").failureClass, "configuration");

  const runId = after.phases[0].steps[0].runId;
  assert.ok(runId);
  const ledger = await readLedger();
  assert.deepEqual(suppliedContextOf(ledger, runId)!.claims, [v("RULE-A", 1)]);
  assert.deepEqual(ledger.consumptions, []);
  assert.deepEqual(ledger.artifacts, []);
  assert.deepEqual(ledger.deltas, []);
  assert.equal((await readRun(runId))!.run.termination, "spawn-failed");
});

// ── Idempotency and fail-closed ─────────────────────────────────────────────

test("duplicate registration is a no-op; a different context for the same run fails closed", async () => {
  const claims = [v("RULE-A", 1)];
  const sha = "ab".repeat(32);
  const first = recordSuppliedContext(
    emptyLedger(),
    { execution: { runId: "run-1" }, claims, sha256: sha },
    "t1",
  );
  assert.equal(first.added, true);

  const again = recordSuppliedContext(
    first.ledger,
    { execution: { runId: "run-1" }, claims, sha256: sha },
    "t2",
  );
  assert.equal(again.added, false);
  assert.equal(again.ledger, first.ledger);
  assert.equal(again.supplied.suppliedAt, "t1");
  assert.equal(again.ledger.supplied.length, 1);

  assert.throws(
    () =>
      recordSuppliedContext(
        first.ledger,
        { execution: { runId: "run-1" }, claims, sha256: "cd".repeat(32) },
        "t3",
      ),
    (e: unknown) =>
      e instanceof KnowledgeValidationError && /refusing to replace it/.test((e as Error).message),
  );
  assert.throws(
    () =>
      recordSuppliedContext(
        first.ledger,
        { execution: { runId: "run-1" }, claims: [v("RULE-B", 1)], sha256: sha },
        "t3",
      ),
    KnowledgeValidationError,
  );
  // The refusals wrote nothing.
  assert.equal(first.ledger.supplied.length, 1);
});

test("a supplied record is validated like every other ledger write", async () => {
  const base = emptyLedger();
  const bad = (input: Parameters<typeof recordSuppliedContext>[1]) =>
    assert.throws(() => recordSuppliedContext(base, input, "t"), KnowledgeValidationError);
  const sha = "ab".repeat(32);
  bad({
    execution: { runId: "run-1" },
    claims: "not a list" as unknown as [],
    sha256: sha,
  });
  bad({ execution: { runId: "run-1" }, claims: [{ id: "A", revision: 0 }], sha256: sha });
  bad({ execution: { runId: "run-1" }, claims: [{ id: "A", revision: 1 }], sha256: "short" });
  bad({
    execution: { runId: "run-1" },
    claims: [{ id: "A", revision: 1 }],
    sha256: sha.toUpperCase(),
  });
  bad({ execution: { runId: "bad id!" }, claims: [{ id: "A", revision: 1 }], sha256: sha });
  bad({
    execution: { runId: "run-1" },
    claims: [
      { id: "A", revision: 1 },
      { id: "A", revision: 1 },
    ],
    sha256: sha,
  });
  bad({
    execution: { runId: "run-1" },
    claims: [{ id: "A", revision: 1 }],
    sha256: sha,
    attempt: -1,
  });
  assert.deepEqual(base.supplied, []);

  // An *empty* list is not malformed, it is a fact: since Phase 5 a spec can
  // select "whatever the accepted discovery phase committed", and a phase is
  // allowed to have committed nothing. The run still received a context file
  // and Argus still hashed it, so the record exists and says the file held no
  // revisions — which is not the same as a run launched with no context.
  const empty = recordSuppliedContext(
    base,
    { execution: { runId: "run-empty" }, claims: [], sha256: sha },
    "t",
  );
  assert.equal(empty.added, true);
  assert.deepEqual(empty.supplied.claims, []);
  assert.equal(empty.supplied.sha256, sha);

  // A run cannot belong to two instances: the locator conflict is refused the
  // same way it is for a consumption.
  const first = recordSuppliedContext(
    base,
    {
      execution: { runId: "run-1", instanceId: "i1" },
      claims: [{ id: "A", revision: 1 }],
      sha256: sha,
    },
    "t",
  );
  assert.throws(
    () =>
      recordSuppliedContext(
        first.ledger,
        {
          execution: { runId: "run-1", instanceId: "i2" },
          claims: [{ id: "A", revision: 1 }],
          sha256: sha,
        },
        "t",
      ),
    KnowledgeValidationError,
  );
});

test("registering through the store is idempotent across calls, and refuses a conflicting hash", async () => {
  await seedLedger();
  const execution = { runId: "run-9", instanceId: "inst-1", phaseId: "a" };
  const input = { claims: [v("RULE-A", 1)], sha256: "ab".repeat(32), attempt: 0 as number };
  assert.equal((await registerSuppliedContext(execution, input, NOW)).added, true);
  assert.equal((await registerSuppliedContext(execution, input, new Date())).added, false);
  assert.equal((await readLedger()).supplied.length, 1);
  await assert.rejects(
    registerSuppliedContext(execution, { ...input, sha256: "cd".repeat(32) }, new Date()),
    KnowledgeValidationError,
  );
  assert.equal((await readLedger()).supplied.length, 1);
  assert.equal((await readLedger()).supplied[0].sha256, "ab".repeat(32));
});

// ── Retention ───────────────────────────────────────────────────────────────

test("pruning: run, invocation and projection go; the durable supplied record and both queries stay", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A", "RULE-B:v1"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-A:v1"] });
  await complete(e, inst, "a", call.runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");

  const run = (await readRun(call.runId))!.run;
  const sha = suppliedContextOf(await readLedger(), call.runId)!.sha256;

  // Normal retention: keep nothing of this schedule's runs.
  await pruneRuns(run.scheduleId, 0);
  assert.equal(await readRun(call.runId), null);
  assert.equal(await readInvocation(call.runId), null);
  assert.equal(existsSync(runInvocationDir(call.runId)), false);
  assert.equal(existsSync(knowledgeContextFile(call.runId)), false);
  assert.equal(await readDeltaRecord(call.runId), null);

  // "What semantic context did this run receive?" — still exact.
  const ledger = await readLedger();
  const supplied = suppliedContextOf(ledger, call.runId)!;
  assert.deepEqual(supplied.claims, [v("RULE-A", 1), v("RULE-B", 1)]);
  assert.equal(supplied.sha256, sha);
  // "Which runs received RULE-B:v1?" — still lists the pruned run.
  assert.deepEqual(
    suppliedToReport(ledger, v("RULE-B", 1)).executions.map((x) => x.execution.runId),
    [call.runId],
  );
  // And the consumption the applied delta recorded is durable too.
  assert.equal(ledger.consumptions[0].source, "supplied-context");
});

// ── Supplied ≠ consumed, after durability ───────────────────────────────────

test("supplied is not consumed: durable supply holds all three refs, consumption holds one, impact follows consumption", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [
        {
          name: "s",
          prompt: "p",
          knowledgeContext: { claims: ["RULE-A", "RULE-B", "FACT-C"] },
        },
      ],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-B:v1"] });
  await complete(e, inst, "a", call.runId);
  await e.drain();

  const ledger = await readLedger();
  assert.deepEqual(suppliedContextOf(ledger, call.runId)!.claims, [
    v("RULE-A", 1),
    v("RULE-B", 1),
    v("FACT-C", 1),
  ]);
  assert.deepEqual(
    ledger.consumptions.map((c) => c.claim),
    [v("RULE-B", 1)],
  );

  // Revising the supplied-but-unconsumed claim impacts no execution, before
  // or after pruning: durable supply is not dependency provenance.
  await createRevision("RULE-A", { statement: "A'" }, NOW);
  assert.deepEqual(analyzeImpact(await readLedger(), v("RULE-A", 1)).executions, []);
  await pruneRuns((await readRun(call.runId))!.run.scheduleId, 0);
  assert.deepEqual(analyzeImpact(await readLedger(), v("RULE-A", 1)).executions, []);
  // The consumed one still does.
  await createRevision("RULE-B", { statement: "B'" }, NOW);
  assert.deepEqual(
    analyzeImpact(await readLedger(), v("RULE-B", 1)).executions.map((x) => x.execution.runId),
    [call.runId],
  );
});

test("agent-discovered: a claim consumed but never supplied stays agent-discovered, classified from the durable record", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  writeDelta(call, { schemaVersion: 1, consumed: ["FACT-C:v1"] });

  // The operational launch record is gone before the completion is read: the
  // durable record alone must produce the answer.
  rmSync(path.join(runInvocationDir(call.runId), "invocation.json"), { force: true });
  await complete(e, inst, "a", call.runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");
  const ledger = await readLedger();
  assert.deepEqual(ledger.consumptions[0].claim, v("FACT-C", 1));
  assert.equal(ledger.consumptions[0].source, "agent-discovered");
  assert.deepEqual((await readDeltaRecord(call.runId))!.supplied, [v("RULE-A", 1)]);
});

test("classification uses the durable record when the invocation record is unavailable", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-A:v1"] });
  rmSync(path.join(runInvocationDir(call.runId), "invocation.json"), { force: true });
  await complete(e, inst, "a", call.runId);
  await e.drain();
  assert.equal((await readLedger()).consumptions[0].source, "supplied-context");
});

// ── Integrity ───────────────────────────────────────────────────────────────

test("integrity unchanged: an untouched context completes normally and commits its delta", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-A:v1"] });
  await complete(e, inst, "a", call.runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");
  assert.equal((await readLedger()).consumptions.length, 1);
  assert.equal(
    (await readJournal(inst.id)).some((j) => j.kind === "knowledge.integrity"),
    false,
  );
});

test("integrity modified: one changed byte fails the completion deterministically and commits nothing", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  const file = call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE;
  const original = readFileSync(file, "utf8");
  const expected = suppliedContextOf(await readLedger(), call.runId)!.sha256;

  // The agent proposes knowledge *and* rewrites the input it was given.
  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-A:v1"] });
  tamper(file, original.replace("A", "A "));

  await complete(e, inst, "a", call.runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(after.status, "failed");
  const payload = failure(after, "a");
  assert.equal(payload.failureClass, "knowledge-context-integrity");
  assert.match(payload.reason ?? "", /knowledge context integrity/);
  assert.match(payload.reason ?? "", new RegExp(call.runId));
  assert.match(payload.reason ?? "", new RegExp(`expected sha256 ${expected}`));
  assert.match(payload.reason ?? "", new RegExp(sha256Hex(readFileSync(file, "utf8"))));
  assert.ok(payload.reason!.includes(file));
  // Never the contents.
  assert.equal(payload.reason!.includes("RULE-A"), false);

  // Nothing canonical, and the delta was never even staged.
  const ledger = await readLedger();
  assert.deepEqual(ledger.consumptions, []);
  assert.deepEqual(ledger.deltas, []);
  assert.equal(await readDeltaRecord(call.runId), null);
  // The durable supply record stands: history is not what was damaged.
  assert.deepEqual(suppliedContextOf(ledger, call.runId)!.claims, [v("RULE-A", 1)]);
  const entry = (await readJournal(inst.id)).find((j) => j.kind === "knowledge.integrity");
  assert.equal(entry?.runId, call.runId);
  assert.match(entry?.detail ?? "", /^modified: expected sha256 [0-9a-f]{12}, found [0-9a-f]{12}$/);
});

test("integrity deleted: a context file removed during execution fails the completion too", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-A:v1"] });
  rmSync(call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE, { force: true });

  await complete(e, inst, "a", call.runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(after.status, "failed");
  assert.equal(failure(after, "a").failureClass, "knowledge-context-integrity");
  assert.match(failure(after, "a").reason ?? "", /context file is missing/);
  assert.deepEqual((await readLedger()).consumptions, []);
  // Deleting the file did not erase the history.
  assert.deepEqual(suppliedContextOf(await readLedger(), call.runId)!.claims, [v("RULE-A", 1)]);
});

test("integrity is about bytes, not currency: a revision committed while the run is live does not fail it", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  const before = readFileSync(call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE, "utf8");

  // Another run supersedes the supplied revision while this one is running.
  await createRevision("RULE-A", { statement: "A'" }, NOW);
  assert.equal(readFileSync(call.env.ARGUS_KNOWLEDGE_CONTEXT_FILE, "utf8"), before);

  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-A:v1"] });
  await complete(e, inst, "a", call.runId);
  await e.drain();

  // Integrity passed; the run legitimately continued on the historical v1.
  assert.equal((await instance(inst.id)).status, "succeeded");
  const ledger = await readLedger();
  assert.deepEqual(ledger.consumptions[0].claim, v("RULE-A", 1));
  assert.equal(ledger.consumptions[0].source, "supplied-context");
  assert.deepEqual(suppliedContextOf(ledger, call.runId)!.claims, [v("RULE-A", 1)]);
  // Staleness is a *derived* read, not a failure.
  assert.equal(analyzeImpact(ledger, v("RULE-A", 1)).executions[0].execution.runId, call.runId);
});

test("restart between materialization and completion: the check is re-run from disk and registration stays idempotent", async () => {
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const inst = (await engine(rec.spawn).start("p1", "manual"))!;
  const call = rec.calls[0];
  const suppliedBefore = (await readLedger()).supplied;
  assert.equal(suppliedBefore.length, 1);

  // A fresh engine, as after a restart: no in-memory state, the records
  // re-read from disk.
  const e2 = engine(recordingSpawn().spawn);
  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-A:v1"] });
  await complete(e2, inst, "a", call.runId);
  await e2.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");
  // No duplicate record; the same one, unchanged.
  assert.deepEqual((await readLedger()).supplied, suppliedBefore);

  // And the same restart with a tampered file still refuses.
  const rec3 = recordingSpawn();
  const e3 = engine(rec3.spawn);
  const inst3 = (await e3.start("p1", "manual"))!;
  const call3 = rec3.calls[0];
  tamper(call3.env.ARGUS_KNOWLEDGE_CONTEXT_FILE, "{}\n");
  const e4 = engine(recordingSpawn().spawn);
  await complete(e4, inst3, "a", call3.runId);
  await e4.drain();
  assert.equal(failure(await instance(inst3.id), "a").failureClass, "knowledge-context-integrity");
});

// ── Backwards compatibility ─────────────────────────────────────────────────

test("no context: a legacy run creates no supplied record, runs no hash check, and behaves exactly as before", async () => {
  await seedLedger();
  await seed([{ id: "a", name: "A", steps: [{ name: "s", prompt: "p" }] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  assert.equal("ARGUS_KNOWLEDGE_CONTEXT_FILE" in call.env, false);
  assert.deepEqual((await readLedger()).supplied, []);

  writeDelta(call, { schemaVersion: 1, consumed: ["FACT-C:v1"] });
  await complete(e, inst, "a", call.runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");
  const ledger = await readLedger();
  assert.deepEqual(ledger.supplied, []);
  // Positive evidence of an empty supply (the invocation record says so) is
  // not the same as unknown: the consumption is classified, not left blank.
  assert.equal(ledger.consumptions[0].source, "agent-discovered");
  assert.equal(
    (await readJournal(inst.id)).some((j) => j.kind === "knowledge.integrity"),
    false,
  );
});

test("no supplied evidence at all: a hand-registered consumption keeps source undefined", async () => {
  await seedLedger();
  const { registerConsumptions } = await import("./store.js");
  await registerConsumptions({ runId: "run-old" }, { claims: [{ id: "RULE-A" }] }, NOW);
  const ledger = await readLedger();
  assert.equal("source" in ledger.consumptions[0], false);
  assert.equal(suppliedContextOf(ledger, "run-old"), null);
});

// ── The API, after pruning ──────────────────────────────────────────────────

test("the context API distinguishes durable supplied metadata from an unavailable projection", async () => {
  const { createApp } = await import("../app.js");
  const { createAuthService } = await import("../auth.js");
  const { createUserStore } = await import("../userStore.js");
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  writeDelta(call, { schemaVersion: 1, consumed: ["RULE-A:v1"] });
  await complete(e, inst, "a", call.runId);
  await e.drain();

  const app = createApp({
    config: {
      port: 7777,
      host: "127.0.0.1",
      token: null,
      allowedHosts: [],
      allowedOrigins: [],
      maxConcurrentRuns: 4,
      schedulerTickMs: 30000,
      webhookUrl: null,
    },
    engine: e,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth: createAuthService({ store: createUserStore() }),
  });
  const read = async (p: string) => {
    const res = await app.request(p, { headers: { host: "localhost:7777" } });
    return { status: res.status, body: (await res.json()) as never };
  };

  const before: ExecutionContextReport = (
    await read(`/api/knowledge/executions/${call.runId}/context`)
  ).body;
  assert.equal(before.context.projectionAvailable, true);
  assert.ok(before.projection);

  await pruneRuns((await readRun(call.runId))!.run.scheduleId, 0);

  const res = await read(`/api/knowledge/executions/${call.runId}/context`);
  assert.equal(res.status, 200);
  const after: ExecutionContextReport = res.body;
  assert.deepEqual(after.supplied, [v("RULE-A", 1)]);
  assert.equal(after.context.sha256, before.context.sha256);
  assert.equal(after.context.schemaVersion, 1);
  assert.equal(after.context.file, null);
  assert.equal(after.context.projectionAvailable, false);
  assert.equal(after.projection, null);
  assert.deepEqual(after.consumed, [v("RULE-A", 1)]);
  assert.deepEqual(after.comparison.suppliedAndConsumed, [v("RULE-A", 1)]);

  const reverse: SuppliedToReport = (await read(`/api/knowledge/claims/RULE-A:v1/supplied-to`))
    .body;
  assert.deepEqual(
    reverse.executions.map((x) => x.execution.runId),
    [call.runId],
  );
  assert.equal(reverse.executions[0].sha256, before.context.sha256);
});

// ── Purity of the check ─────────────────────────────────────────────────────

test("paths.knowledgeFile survives every pruning path the engine has", async () => {
  // The architecture in one assertion: heavy operational records are prunable,
  // small semantic provenance is not. `pruneRuns` and `pruneInstances` touch
  // neither knowledge.json nor anything under it.
  const { pruneInstances } = await import("../sources/instances.js");
  await seedLedger();
  await seed([
    {
      id: "a",
      name: "A",
      steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: ["RULE-A"] } }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const call = rec.calls[0];
  await complete(e, inst, "a", call.runId);
  await e.drain();

  const before = readFileSync(paths.knowledgeFile(), "utf8");
  await pruneRuns((await readRun(call.runId))!.run.scheduleId, 0);
  await pruneInstances("p1", 0);
  assert.equal(await readInstance(inst.id), null);
  assert.equal(readFileSync(paths.knowledgeFile(), "utf8"), before);
  assert.deepEqual(suppliedContextOf(await readLedger(), call.runId)!.claims, [v("RULE-A", 1)]);
});
