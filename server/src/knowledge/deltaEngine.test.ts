import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KnowledgeDeltaRecord, PhaseFailurePayload, PipelineInstance } from "@argus/contracts";
import { createEngine } from "../pipelineEngine.js";
import type { Engine } from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance, writeInstance } from "../sources/instances.js";
import { readInvocation, readRun, writeRun } from "../sources/runs.js";
import { knowledgeDeltaDir } from "./staging.js";
import { readJournal } from "../sources/journal.js";
import { createClaim, createEvidence, createRevision, readLedger } from "./store.js";
import { readDeltaRecord, stagedDeltaPath } from "./staging.js";
import { formatClaimRef, getClaim, revisionsOf } from "./kernel.js";
import { analyzeImpact } from "./impact.js";

/**
 * The KnowledgeDelta protocol through the engine: a run writes the file Argus
 * named for it, the completion signal (or the reconcile fallback) stages it,
 * and the phase's acceptance — checks, gate, retry, revise, abort — decides
 * whether it ever becomes canonical. Every scenario asserts on the ledger on
 * disk, the staged record and the persisted instance; the agent is a spawn
 * double whose "work" is the test writing the delta file before signalling.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-knowledge-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
});

const NOW = new Date("2026-09-19T10:00:00.000Z");

let counter = 0;
function deferred() {
  let resolve!: (v: { code: number | null }) => void;
  const promise = new Promise<{ code: number | null }>((r) => (resolve = r));
  return { promise, resolve };
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
    const d = deferred();
    return { pid: 1000 + calls.length, done: d.promise };
  };
  return { spawn, calls };
}

function engine(
  spawn: ReturnType<typeof recordingSpawn>["spawn"],
  over: Record<string, unknown> = {},
) {
  return createEngine({
    now: () => new Date(),
    newId: () => `id-${++counter}`,
    spawn,
    signalUrlBase: "http://localhost:7777",
    maxConcurrent: 4,
    tickMs: 30000,
    parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
    ...over,
  });
}

async function seed(phases: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return createPipeline(
    validatePipelineInput({
      name: "knowledge",
      trigger: null,
      phases: phases.map((p) => ({ cwd: home, gated: false, ...p })),
      ...over,
    }),
    NOW,
    "p1",
  );
}

const step = (name = "s", prompt = "p") => ({ name, prompt });

/** RULE-17:v1, grounded. */
async function seedRule() {
  await createClaim({ id: "RULE-17", kind: "business-rule", statement: "Comment max is 180" }, NOW);
  await createEvidence(
    {
      claim: { id: "RULE-17", revision: 1 },
      direction: "supports",
      source: { type: "document", uri: "spec://kobra" },
    },
    NOW,
  );
}

/** What the agent writes: the file Argus named in the run's environment. */
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

const phaseOf = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)!;
const failure = (inst: PipelineInstance, id: string) =>
  (phaseOf(inst, id).payload ?? {}) as PhaseFailurePayload;

const NEW_CONCLUSION = {
  schemaVersion: 1,
  claims: [{ localId: "c", kind: "conclusion", statement: "Validate comments at 180 characters" }],
  justifications: [{ conclusion: { local: "c" }, premises: ["RULE-17:v1"] }],
};

// ── Backwards compatibility ─────────────────────────────────────────────────

test("no delta: a step that writes no file behaves exactly as before", async () => {
  await seed([{ id: "only", name: "Only", steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  // The run is told where a delta would go, and the directory exists for it.
  assert.ok(
    rec.calls[0].env.ARGUS_KNOWLEDGE_DELTA_FILE.endsWith(
      path.join(rec.calls[0].runId, "delta.json"),
    ),
  );
  assert.ok(existsSync(path.dirname(rec.calls[0].env.ARGUS_KNOWLEDGE_DELTA_FILE)));

  const res = await complete(e, inst, "only", rec.calls[0].runId);
  assert.equal(res.code, 202);
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].status, "succeeded");
  assert.equal("knowledge" in after.phases[0], false);
  assert.equal("knowledgeDelta" in after.phases[0].steps[0], false);
  assert.equal(existsSync(path.join(home, "argus", "knowledge.json")), false);
  assert.equal(await readDeltaRecord(rec.calls[0].runId), null);
  const kinds = (await readJournal(inst.id)).map((j) => j.kind);
  assert.equal(
    kinds.some((k) => k.startsWith("knowledge.")),
    false,
  );
});

test("an empty delta document is treated as no delta", async () => {
  await seed([{ id: "only", name: "Only", steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], { schemaVersion: 1, claims: [] });
  await complete(e, inst, "only", rec.calls[0].runId);
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal("knowledge" in after.phases[0], false);
  assert.equal(await readDeltaRecord(rec.calls[0].runId), null);
});

// ── Ungated phases ──────────────────────────────────────────────────────────

test("ungated, no checks: the delta is staged at completion and applied as the phase succeeds", async () => {
  await seedRule();
  await seed([{ id: "plan", name: "Plan", steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const runId = rec.calls[0].runId;
  writeDelta(rec.calls[0], NEW_CONCLUSION);
  await complete(e, inst, "plan", runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  const phase = after.phases[0];
  assert.equal(phase.status, "succeeded");
  assert.equal(phase.knowledge?.status, "applied");
  assert.deepEqual(phase.knowledge?.deltas, [phase.steps[0].knowledgeDelta!.id]);
  assert.equal(phase.steps[0].knowledgeDelta?.status, "applied");

  const ledger = await readLedger();
  const created = ledger.claims.find((c) => c.kind === "conclusion");
  assert.ok(created);
  assert.match(created.id, /^CONCLUSION-/);
  assert.deepEqual(created.producedBy, { runId, instanceId: inst.id, phaseId: "plan" });
  assert.equal(ledger.justifications.length, 1);
  assert.deepEqual(ledger.justifications[0].premises, [{ id: "RULE-17", revision: 1 }]);
  assert.equal(ledger.deltas.length, 1);
  assert.equal(ledger.deltas[0].execution.runId, runId);
  assert.equal(ledger.deltas[0].attempt, 0);

  const record = (await readDeltaRecord(runId))!;
  assert.equal(record.status, "applied");
  assert.equal(record.id, ledger.deltas[0].id);
  assert.equal(record.instanceId, inst.id);
  assert.equal(record.phaseId, "plan");
  assert.equal(record.attempt, 0);
  assert.equal(record.step, "s");
  assert.deepEqual(record.result?.createdClaims, [
    { localId: "c", claim: { id: created.id, revision: 1 } },
  ]);
  assert.deepEqual(record.result?.justificationIds, [ledger.justifications[0].id]);
  // The local id is nowhere in the canonical ledger.
  assert.equal(JSON.stringify(ledger).includes('"localId"'), false);

  const kinds = (await readJournal(inst.id)).map((j) => j.kind);
  assert.ok(kinds.includes("knowledge.staged"));
  assert.ok(kinds.includes("knowledge.applied"));
  assert.equal((await readRun(runId))?.run.outcome, "succeeded");
});

test("ungated with checks: nothing is canonical until the deterministic checks pass", async () => {
  await seedRule();
  const marker = path.join(home, "checks-may-pass");
  await seed([
    {
      id: "plan",
      name: "Plan",
      steps: [step()],
      checks: [
        { kind: "command", run: `while [ ! -f "${marker}" ]; do sleep 0.02; done`, label: "wait" },
      ],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], NEW_CONCLUSION);
  await complete(e, inst, "plan", rec.calls[0].runId);

  // Agent completed, checks still running: staged, not canonical.
  const held = await instance(inst.id);
  assert.equal(held.phases[0].status, "running");
  assert.equal(held.phases[0].verification?.status, "running");
  assert.equal(held.phases[0].steps[0].knowledgeDelta?.status, "staged");
  assert.equal("knowledge" in held.phases[0], false);
  assert.equal((await readLedger()).claims.length, 1);
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "staged");

  writeFileSync(marker, "go");
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].verification?.status, "passed");
  assert.equal(after.phases[0].knowledge?.status, "applied");
  assert.equal((await readLedger()).claims.length, 2);
});

test("verification failure: a valid staged delta is never applied", async () => {
  await seedRule();
  await seed([
    {
      id: "plan",
      name: "Plan",
      steps: [step()],
      checks: [{ kind: "command", run: "exit 1", label: "tests" }],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], NEW_CONCLUSION);
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(after.phases[0].status, "failed");
  assert.equal(failure(after, "plan").failureClass, "verification");
  assert.equal(after.phases[0].steps[0].knowledgeDelta?.status, "superseded");
  assert.equal("knowledge" in after.phases[0], false);
  assert.equal((await readLedger()).claims.length, 1);
  const record = (await readDeltaRecord(rec.calls[0].runId))!;
  assert.equal(record.status, "superseded");
  assert.match(record.reason!, /attempt 0 failed/);
  assert.ok((await readJournal(inst.id)).some((j) => j.kind === "knowledge.superseded"));
});

test("retry isolation: only the succeeding attempt's delta enters canonical knowledge", async () => {
  await seedRule();
  const marker = path.join(home, "second-attempt");
  await seed([
    {
      id: "plan",
      name: "Plan",
      steps: [step()],
      checks: [{ kind: "command", run: `test -f "${marker}"`, label: "marker" }],
      retry: { attempts: 2, backoffSeconds: 0, retryOn: ["verification"] },
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;

  // Attempt 1 proposes, then fails verification.
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "first", kind: "fact", statement: "from attempt 1" }],
  });
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();
  assert.equal((await instance(inst.id)).phases[0].status, "failed");
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "superseded");

  // The retry launches attempt 2.
  writeFileSync(marker, "go");
  await e.reconcile();
  await e.drain();
  assert.equal(rec.calls.length, 2);
  const attempt2 = await instance(inst.id);
  assert.equal(attempt2.phases[0].attempt, 1);
  assert.equal("knowledgeDelta" in attempt2.phases[0].steps[0], false);

  writeDelta(rec.calls[1], {
    schemaVersion: 1,
    claims: [{ localId: "second", kind: "fact", statement: "from attempt 2" }],
  });
  await complete(e, inst, "plan", rec.calls[1].runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].knowledge?.status, "applied");
  const ledger = await readLedger();
  assert.deepEqual(
    ledger.claims.filter((c) => c.kind === "fact").map((c) => c.statement),
    ["from attempt 2"],
  );
  assert.equal(ledger.deltas.length, 1);
  assert.equal(ledger.deltas[0].attempt, 1);
  assert.equal(ledger.deltas[0].execution.runId, rec.calls[1].runId);
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "superseded");
  assert.equal((await readDeltaRecord(rec.calls[1].runId))?.status, "applied");
});

// ── Gated phases ────────────────────────────────────────────────────────────

test("gated: the ledger is unchanged at awaiting-approval and the delta commits atomically on approve", async () => {
  await seedRule();
  await seed([
    { id: "plan", name: "Plan", gated: true, steps: [step()] },
    { id: "next", name: "Next", steps: [step("n", "{{previous.payload}}")] },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    ...NEW_CONCLUSION,
    consumed: ["RULE-17:v1"],
  });
  await complete(e, inst, "plan", rec.calls[0].runId);

  const waiting = await instance(inst.id);
  assert.equal(waiting.status, "awaiting-approval");
  assert.equal(waiting.phases[0].steps[0].knowledgeDelta?.status, "staged");
  assert.equal((await readLedger()).claims.length, 1);
  assert.equal((await readLedger()).consumptions.length, 0);

  const res = await e.approve(inst.id, { answers: "ship it" });
  assert.equal(res.code, 200);
  const after = await instance(inst.id);
  assert.equal(after.phases[0].status, "succeeded");
  assert.equal(after.phases[0].knowledge?.status, "applied");
  assert.deepEqual(after.phases[0].payload, { answers: "ship it" });
  assert.equal(after.phases[1].status, "running");
  assert.equal(rec.calls.length, 2, "the next phase launches after the commit");
  const ledger = await readLedger();
  assert.equal(ledger.claims.length, 2);
  assert.equal(ledger.justifications.length, 1);
  assert.deepEqual(ledger.consumptions[0].claim, { id: "RULE-17", revision: 1 });
  assert.equal(ledger.consumptions[0].execution.runId, rec.calls[0].runId);
  assert.equal(ledger.deltas.length, 1);
});

test("gate revision: the revised attempt's delta is superseded and the new attempt stages its own", async () => {
  await seedRule();
  await seed([{ id: "plan", name: "Plan", gated: true, steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "old", kind: "fact", statement: "first draft" }],
  });
  await complete(e, inst, "plan", rec.calls[0].runId);
  assert.equal((await instance(inst.id)).status, "awaiting-approval");

  await e.revise(inst.id, "try again");
  assert.equal(rec.calls.length, 2);
  const revised = await instance(inst.id);
  assert.equal(revised.phases[0].attempt, 1);
  assert.equal("knowledgeDelta" in revised.phases[0].steps[0], false);
  const old = (await readDeltaRecord(rec.calls[0].runId))!;
  assert.equal(old.status, "superseded");
  assert.match(old.reason!, /revised/);
  assert.equal((await readLedger()).claims.length, 1);

  writeDelta(rec.calls[1], {
    schemaVersion: 1,
    claims: [{ localId: "new", kind: "fact", statement: "second draft" }],
  });
  await complete(e, inst, "plan", rec.calls[1].runId);
  await e.approve(inst.id);
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  const ledger = await readLedger();
  assert.deepEqual(
    ledger.claims.filter((c) => c.kind === "fact").map((c) => c.statement),
    ["second draft"],
  );
  assert.equal(ledger.deltas.length, 1);
  assert.equal(ledger.deltas[0].attempt, 1);
  // The old proposal is still readable as diagnostic evidence.
  assert.equal(old.delta?.claims?.[0].statement, "first draft");
});

test("abort: a staged delta stays non-canonical", async () => {
  await seedRule();
  await seed([{ id: "plan", name: "Plan", gated: true, steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], NEW_CONCLUSION);
  await complete(e, inst, "plan", rec.calls[0].runId);
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "staged");

  await e.abort(inst.id);
  const after = await instance(inst.id);
  assert.equal(after.status, "aborted");
  assert.equal(after.phases[0].steps[0].knowledgeDelta?.status, "superseded");
  const record = (await readDeltaRecord(rec.calls[0].runId))!;
  assert.equal(record.status, "superseded");
  assert.match(record.reason!, /aborted/);
  assert.equal((await readLedger()).claims.length, 1);
  assert.equal((await readLedger()).deltas.length, 0);
});

// ── Revision concurrency ────────────────────────────────────────────────────

test("stale at commit: the ledger moved while the gate waited, so the approved phase fails and nothing is applied", async () => {
  await seedRule();
  await seed([{ id: "rules", name: "Rules", gated: true, steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "note", kind: "fact", statement: "would have been fine alone" }],
    revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "Comment max is 500" }],
  });
  await complete(e, inst, "rules", rec.calls[0].runId);
  assert.equal((await instance(inst.id)).status, "awaiting-approval");

  // Another change lands before the human approves.
  await createRevision("RULE-17", { statement: "Comment max is 300" }, NOW);

  const res = await e.approve(inst.id);
  assert.equal(res.code, 200);
  const after = await instance(inst.id);
  assert.equal(after.phases[0].status, "failed");
  assert.equal(after.status, "failed");
  assert.equal(failure(after, "rules").failureClass, "knowledge-delta");
  assert.match(
    failure(after, "rules").reason!,
    /expects RULE-17 at v1, but the active revision is v2/,
  );
  assert.equal(after.phases[0].knowledge?.status, "rejected");
  assert.equal(after.phases[0].steps[0].knowledgeDelta?.status, "rejected");

  const ledger = await readLedger();
  assert.deepEqual(
    revisionsOf(ledger, "RULE-17").map((c) => c.statement),
    ["Comment max is 180", "Comment max is 300"],
  );
  assert.equal(
    ledger.claims.some((c) => c.kind === "fact"),
    false,
  );
  assert.equal(ledger.deltas.length, 0);
  const record = (await readDeltaRecord(rec.calls[0].runId))!;
  assert.equal(record.status, "rejected");
  assert.match(record.reason!, /stale-revision/);
  // A person can revise the failed phase; the retry budget is theirs.
  assert.equal((await e.revise(inst.id, "re-derive from v2")).code, 200);
  assert.equal(rec.calls.length, 2);
});

test("stale at intake: a precondition that already fails refuses the step at completion", async () => {
  await seedRule();
  await createRevision("RULE-17", { statement: "Comment max is 300" }, NOW);
  await seed([{ id: "rules", name: "Rules", steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "Comment max is 500" }],
  });
  const res = await complete(e, inst, "rules", rec.calls[0].runId);
  assert.equal(res.code, 202);
  const after = await instance(inst.id);
  assert.equal(after.phases[0].status, "failed");
  assert.equal(after.phases[0].steps[0].status, "failed");
  assert.equal(failure(after, "rules").failureClass, "knowledge-delta");
  assert.match(failure(after, "rules").reason!, /stale-revision/);
  assert.equal((await readRun(rec.calls[0].runId))?.run.outcome, "failed");
  assert.equal((await readLedger()).claims.length, 2);
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "rejected");
  assert.ok((await readJournal(inst.id)).some((j) => j.kind === "knowledge.rejected"));
});

// ── Multi-step phases ───────────────────────────────────────────────────────

for (const order of ["a then b", "b then a"] as const) {
  test(`multi-step conflict (${order}): two deltas revising the same revision fail the phase commit, whichever finished first`, async () => {
    await seedRule();
    await seed([{ id: "plan", name: "Plan", steps: [step("a"), step("b")] }]);
    const rec = recordingSpawn();
    const e = engine(rec.spawn);
    const inst = (await e.start("p1", "manual"))!;
    assert.equal(rec.calls.length, 2);
    const byStep = Object.fromEntries(
      (await instance(inst.id)).phases[0].steps.map((s) => [
        s.name,
        rec.calls.find((c) => c.runId === s.runId)!,
      ]),
    );
    writeDelta(byStep.a, {
      schemaVersion: 1,
      revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "from a" }],
    });
    writeDelta(byStep.b, {
      schemaVersion: 1,
      claims: [{ localId: "extra", kind: "fact", statement: "b also proposed this" }],
      revisions: [{ claimId: "RULE-17", expectedRevision: 1, statement: "from b" }],
    });
    const sequence = order === "a then b" ? [byStep.a, byStep.b] : [byStep.b, byStep.a];
    await complete(e, inst, "plan", sequence[0].runId);
    // Each step's own delta is valid alone, so the first is staged and waits.
    const mid = await instance(inst.id);
    assert.equal(mid.phases[0].status, "running");
    assert.equal((await readLedger()).claims.length, 1);
    await complete(e, inst, "plan", sequence[1].runId);
    await e.drain();

    const after = await instance(inst.id);
    assert.equal(after.phases[0].status, "failed");
    assert.equal(failure(after, "plan").failureClass, "knowledge-delta");
    assert.match(failure(after, "plan").reason!, /both revise RULE-17 from v1/);
    assert.equal(after.phases[0].knowledge?.status, "rejected");
    const ledger = await readLedger();
    assert.equal(revisionsOf(ledger, "RULE-17").length, 1);
    assert.equal(
      ledger.claims.some((c) => c.kind === "fact"),
      false,
    );
    assert.equal(ledger.deltas.length, 0);
    for (const call of [byStep.a, byStep.b]) {
      assert.equal((await readDeltaRecord(call.runId))?.status, "rejected");
    }
  });
}

test("multi-step phase: two non-conflicting deltas commit together as one transition", async () => {
  await seedRule();
  await seed([{ id: "plan", name: "Plan", steps: [step("a"), step("b")] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "x", kind: "fact", statement: "a" }],
  });
  writeDelta(rec.calls[1], {
    schemaVersion: 1,
    claims: [{ localId: "y", kind: "fact", statement: "b" }],
  });
  await complete(e, inst, "plan", rec.calls[1].runId);
  assert.equal((await readLedger()).deltas.length, 0, "the first completion alone commits nothing");
  await complete(e, inst, "plan", rec.calls[0].runId);
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].knowledge?.deltas.length, 2);
  const ledger = await readLedger();
  assert.equal(ledger.deltas.length, 2);
  assert.deepEqual(
    ledger.claims
      .filter((c) => c.kind === "fact")
      .map((c) => c.statement)
      .sort(),
    ["a", "b"],
  );
  // Committed in step order, not completion order.
  assert.deepEqual(
    ledger.deltas.map((d) => d.execution.runId),
    [rec.calls[0].runId, rec.calls[1].runId],
  );
});

// ── Failure behaviour ───────────────────────────────────────────────────────

test("a malformed delta fails the step under the knowledge-delta class rather than vanishing", async () => {
  await seed([{ id: "plan", name: "Plan", steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], "{not json");
  await complete(e, inst, "plan", rec.calls[0].runId);
  const after = await instance(inst.id);
  assert.equal(after.status, "failed");
  assert.equal(after.phases[0].status, "failed");
  assert.equal(failure(after, "plan").failureClass, "knowledge-delta");
  assert.match(failure(after, "plan").reason!, /invalid-json/);
  const record = (await readDeltaRecord(rec.calls[0].runId))!;
  assert.equal(record.status, "rejected");
  assert.equal("delta" in record, false);
  assert.equal(existsSync(path.join(home, "argus", "knowledge.json")), false);
});

test("an unresolved local reference or a cyclic justification refuses the delta at intake", async () => {
  await seedRule();
  await seed([
    { id: "a", name: "A", steps: [step()] },
    { id: "b", name: "B", steps: [step()] },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "c", kind: "conclusion", statement: "c" }],
    justifications: [{ conclusion: { local: "c" }, premises: [{ local: "missing" }] }],
  });
  await complete(e, inst, "a", rec.calls[0].runId);
  const after = await instance(inst.id);
  assert.equal(after.phases[0].status, "failed");
  assert.match(failure(after, "a").reason!, /local-reference.*"missing"/);
  assert.equal((await readLedger()).claims.length, 1);
});

test("a knowledge-delta failure is retryable only on opt-in, and the retry note carries the refusal", async () => {
  await seedRule();
  await seed([
    {
      id: "plan",
      name: "Plan",
      steps: [step()],
      retry: { attempts: 2, backoffSeconds: 0, retryOn: ["knowledge-delta"] },
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], { schemaVersion: 1, consumed: ["RULE-17:v9"] });
  await complete(e, inst, "plan", rec.calls[0].runId);
  const failed = await instance(inst.id);
  assert.equal(failed.phases[0].status, "failed");
  assert.ok(failed.phases[0].retryAt, "a retry is scheduled");
  await e.reconcile();
  await e.drain();
  assert.equal(rec.calls.length, 2);
  const retried = await readRun(rec.calls[1].runId);
  assert.match(retried!.run.prompt, /Previous attempt \(1 of 2\) failed — knowledge-delta:/);
  assert.match(retried!.run.prompt, /RULE-17:v9/);
});

test("a claimed artifact must exist where the run could have produced it", async () => {
  await seed([{ id: "impl", name: "Impl", steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    artifacts: [{ location: "repository", path: "src/Missing.cs" }],
  });
  await complete(e, inst, "impl", rec.calls[0].runId);
  const after = await instance(inst.id);
  assert.equal(after.phases[0].status, "failed");
  assert.match(
    failure(after, "impl").reason!,
    /src\/Missing.cs does not exist in the run's repository/,
  );
});

test("an artifact that exists in the working tree or the artifact directory is recorded", async () => {
  await seed([{ id: "impl", name: "Impl", steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  mkdirSync(path.join(rec.calls[0].cwd, "src"), { recursive: true });
  writeFileSync(path.join(rec.calls[0].cwd, "src", "Validator.cs"), "class V {}");
  writeFileSync(path.join(rec.calls[0].env.ARGUS_ARTIFACT_DIR, "report.md"), "# report");
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    artifacts: [
      { location: "repository", path: "src/Validator.cs" },
      { location: "artifact-dir", path: "report.md" },
    ],
  });
  await complete(e, inst, "impl", rec.calls[0].runId);
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  const ledger = await readLedger();
  assert.deepEqual(ledger.artifacts.map((a) => a.artifact.path).sort(), [
    "report.md",
    "src/Validator.cs",
  ]);
  assert.deepEqual(ledger.artifacts[0].execution, {
    runId: rec.calls[0].runId,
    instanceId: inst.id,
    phaseId: "impl",
  });
});

// ── Reconcile / restart ─────────────────────────────────────────────────────

test("reconcile fallback (Codex): a recovered completion stages and commits the delta like a signal would", async () => {
  await seedRule();
  await seed([{ id: "plan", name: "Plan", steps: [step()] }], { runtime: "codex" });
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], NEW_CONCLUSION);
  const got = await readRun(rec.calls[0].runId);
  await writeRun({
    ...got!.run,
    status: "succeeded",
    exitCode: 0,
    endedAt: new Date().toISOString(),
    resultSummary: "Derived the rule.\nARGUS_OUTCOME: succeeded",
  });
  await e.reconcile();
  await e.drain();
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].knowledge?.status, "applied");
  assert.equal((await readLedger()).claims.length, 2);
  assert.equal((await readRun(rec.calls[0].runId))?.run.outcome, "succeeded");
});

test("reconcile fallback (Codex): a refused delta turns the recovered completion into a knowledge-delta failure", async () => {
  await seed([{ id: "plan", name: "Plan", steps: [step()] }], { runtime: "codex" });
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], { schemaVersion: 1, consumed: ["NOPE:v1"] });
  const got = await readRun(rec.calls[0].runId);
  await writeRun({
    ...got!.run,
    status: "succeeded",
    exitCode: 0,
    endedAt: new Date().toISOString(),
    resultSummary: "Done.\nARGUS_OUTCOME: succeeded",
  });
  await e.reconcile();
  const after = await instance(inst.id);
  assert.equal(after.phases[0].status, "failed");
  assert.equal(failure(after, "plan").failureClass, "knowledge-delta");
  assert.equal((await readRun(rec.calls[0].runId))?.run.outcome, "failed");
});

test("restart: a staged delta survives a new engine process and commits on the later approval", async () => {
  await seedRule();
  await seed([{ id: "plan", name: "Plan", gated: true, steps: [step()] }]);
  const rec = recordingSpawn();
  const e1 = engine(rec.spawn);
  const inst = (await e1.start("p1", "manual"))!;
  writeDelta(rec.calls[0], NEW_CONCLUSION);
  await complete(e1, inst, "plan", rec.calls[0].runId);
  assert.equal((await instance(inst.id)).status, "awaiting-approval");

  // A fresh process, same home: everything it needs is on disk.
  const e2 = engine(recordingSpawn().spawn);
  await e2.reconcile();
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "staged");
  await e2.approve(inst.id);
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].knowledge?.status, "applied");
  assert.equal((await readLedger()).deltas.length, 1);
});

test("restart mid-commit: a phase held pending is committed again by reconcile, idempotently", async () => {
  await seedRule();
  await seed([{ id: "plan", name: "Plan", steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], NEW_CONCLUSION);
  await complete(e, inst, "plan", rec.calls[0].runId);
  const done = await instance(inst.id);
  assert.equal(done.status, "succeeded");
  const ledgerAfterCommit = readFileSync(path.join(home, "argus", "knowledge.json"), "utf8");
  const deltaId = done.phases[0].knowledge!.deltas[0];

  // Rewind the instance and the record to the moment after the ledger write
  // and before the instance write — the state a crash there leaves behind.
  const rewound: PipelineInstance = {
    ...done,
    status: "running",
    endedAt: null,
    phases: done.phases.map((p) => ({
      ...p,
      status: "running",
      knowledge: { status: "pending", deltas: [deltaId], startedAt: p.knowledge!.startedAt },
      steps: p.steps.map((s) => ({ ...s, knowledgeDelta: { id: deltaId, status: "staged" } })),
    })),
  };
  await writeInstance(rewound);
  const record = JSON.parse(
    readFileSync(stagedDeltaPath(rec.calls[0].runId), "utf8"),
  ) as KnowledgeDeltaRecord;
  delete record.result;
  writeFileSync(
    stagedDeltaPath(rec.calls[0].runId),
    JSON.stringify({ ...record, status: "staged" }),
  );

  const e2 = engine(recordingSpawn().spawn);
  await e2.reconcile();
  await e2.drain();
  const healed = await instance(inst.id);
  assert.equal(healed.status, "succeeded");
  assert.equal(healed.phases[0].knowledge?.status, "applied");
  // Nothing was applied twice.
  assert.equal(readFileSync(path.join(home, "argus", "knowledge.json"), "utf8"), ledgerAfterCommit);
  const again = (await readDeltaRecord(rec.calls[0].runId))!;
  assert.equal(again.status, "applied");
  assert.equal(again.result?.deltaId, deltaId);
  assert.equal(again.result?.createdClaims[0].localId, "c");
});

// ── Provenance and impact, end to end ───────────────────────────────────────

test("impact integration: rule revision → changed support → affected decision → consuming run → artifact", async () => {
  await seedRule();
  await seed([
    { id: "plan", name: "Plan", steps: [step()] },
    { id: "implement", name: "Implement", steps: [step()] },
    { id: "rules", name: "Rules", steps: [step()] },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;

  // Run A (plan) derives CONCLUSION → DECISION from RULE-17:v1.
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [
      { localId: "conclusion", kind: "conclusion", statement: "Validate comments at 180" },
      { localId: "decision", kind: "decision", statement: "Implement a 180-character validator" },
    ],
    justifications: [
      { conclusion: { local: "conclusion" }, premises: ["RULE-17:v1"] },
      { conclusion: { local: "decision" }, premises: [{ local: "conclusion" }] },
    ],
    consumed: ["RULE-17:v1"],
  });
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();
  const planRecord = (await readDeltaRecord(rec.calls[0].runId))!;
  assert.equal(planRecord.status, "applied");
  const decision = planRecord.result!.createdClaims.find((c) => c.localId === "decision")!.claim;
  const conclusion = planRecord.result!.createdClaims.find(
    (c) => c.localId === "conclusion",
  )!.claim;
  assert.match(decision.id, /^DECISION-/);

  // Run B (implement) consumes the decision by exact revision and produces the validator.
  assert.equal(rec.calls.length, 2);
  mkdirSync(path.join(rec.calls[1].cwd, "src"), { recursive: true });
  writeFileSync(path.join(rec.calls[1].cwd, "src", "CustomerCommentValidator.cs"), "class V {}");
  writeDelta(rec.calls[1], {
    schemaVersion: 1,
    consumed: [formatClaimRef(decision)],
    artifacts: [{ location: "repository", path: "src/CustomerCommentValidator.cs" }],
  });
  await complete(e, inst, "implement", rec.calls[1].runId);
  await e.drain();

  // Nothing is impacted while the rule is current.
  let ledger = await readLedger();
  assert.deepEqual(analyzeImpact(ledger, { id: "RULE-17", revision: 1 }).root.conditions, []);

  // Run C (rules) revises the rule, from the revision it read.
  assert.equal(rec.calls.length, 3);
  writeDelta(rec.calls[2], {
    schemaVersion: 1,
    revisions: [
      {
        claimId: "RULE-17",
        expectedRevision: 1,
        statement: "Comment max is 500",
        revisionNote: "Kobra 4.2 raised the limit",
      },
    ],
  });
  await complete(e, inst, "rules", rec.calls[2].runId);
  await e.drain();
  assert.equal((await instance(inst.id)).status, "succeeded");

  ledger = await readLedger();
  assert.equal(
    getClaim(ledger, { id: "RULE-17", revision: 2 })?.producedBy?.runId,
    rec.calls[2].runId,
  );
  const impact = analyzeImpact(ledger, { id: "RULE-17", revision: 1 });
  assert.deepEqual(impact.root.conditions, ["superseded"]);
  assert.deepEqual(
    impact.semantic.affectedClaims.map((c) => [
      formatClaimRef(c.claim),
      c.reasons[0],
      c.producedBy?.runId,
    ]),
    [
      [formatClaimRef(conclusion), "premise-superseded", rec.calls[0].runId],
      [formatClaimRef(decision), "premise-unsupported", rec.calls[0].runId],
    ],
  );
  // Run A produced the chain (provenance); runs A and B consumed affected
  // revisions and are the executions whose output needs reevaluation.
  assert.deepEqual(
    impact.executions.map((x) => [x.execution.runId, x.execution.phaseId]),
    [
      [rec.calls[0].runId, "plan"],
      [rec.calls[1].runId, "implement"],
    ],
  );
  assert.deepEqual(impact.artifacts, [
    {
      execution: { runId: rec.calls[1].runId, instanceId: inst.id, phaseId: "implement" },
      artifact: { location: "repository", path: "src/CustomerCommentValidator.cs" },
      reasons: ["produced-by-affected-execution"],
    },
  ]);
  const toArtifact = impact.paths.find((p) => p.target.kind === "artifact")!;
  assert.deepEqual(
    toArtifact.hops.map((h) => h.via),
    ["premise-of", "premise-of", "consumed-by", "produced"],
  );
  // The execution records stayed `succeeded`; only currency changed.
  const after = await instance(inst.id);
  assert.ok(after.phases.every((p) => p.status === "succeeded"));
  // Exact consumption: run B still names the decision's v1, not anything newer.
  assert.deepEqual(
    ledger.consumptions.filter((c) => c.execution.runId === rec.calls[1].runId).map((c) => c.claim),
    [decision],
  );
  // Auditability from the ledger alone: claim ← delta ← run.
  const introducedBy = ledger.deltas.find((d) => d.claims.some((c) => c.id === decision.id))!;
  assert.equal(introducedBy.id, planRecord.id);
  assert.equal(introducedBy.execution.runId, rec.calls[0].runId);
});

// ── Hardening: the channel model at the engine ──────────────────────────────
//
// docs/HARNESS.md § Argus-owned invocation channels. The delta file, the
// result file and the artifact directory are one list the runtime maps; a
// required channel the runtime cannot reach refuses the launch under strict
// enforcement, an optional one is recorded, and a legacy run is untouched.

const DECISION = { artifact: "decision", schema: { type: "object" } };

test("strict enforcement: a result-publishing Codex step under read-only is refused before any process launches", async () => {
  await seed([
    {
      id: "judge",
      name: "Judge",
      runtime: "codex",
      capabilities: { filesystem: "read-only" },
      result: DECISION,
      retry: { attempts: 3, backoffSeconds: 0 },
      steps: [step()],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await e.drain();

  assert.equal(rec.calls.length, 0, "nothing was spawned");
  const after = await instance(inst.id);
  assert.equal(after.status, "failed");
  assert.equal(after.phases[0].status, "failed");
  assert.equal(failure(after, "judge").failureClass, "configuration");
  assert.match(
    failure(after, "judge").reason!,
    /Codex read-only sandbox prevents writing the result file \(ARGUS_RESULT_FILE\)/,
  );
  // Never retried: the definition is what is wrong.
  assert.equal(after.phases[0].retryAt ?? null, null);
  const runId = after.phases[0].steps[0].runId!;
  assert.equal((await readRun(runId))?.run.termination, "spawn-failed");
  // The record says what Argus would have launched, channel by channel.
  const record = (await readInvocation(runId))!;
  const result = record.channels?.find((c) => c.kind === "result");
  assert.equal(result?.required, true);
  assert.equal(result?.status, "unavailable");
  const delta = record.channels?.find((c) => c.kind === "knowledge-delta");
  assert.equal(delta?.required, false);
  assert.equal(delta?.status, "unavailable");
  assert.equal(record.limitations.length, 3);
  // Deterministic: a second instance is refused for the same reason.
  const again = (await e.start("p1", "manual"))!;
  await e.drain();
  assert.equal(rec.calls.length, 0);
  assert.equal(failure(await instance(again.id), "judge").reason, failure(after, "judge").reason);
});

test('strict enforcement: knowledgeDelta: "required" refuses a runtime that cannot write the delta; optional launches with the gap recorded', async () => {
  await seed([
    {
      id: "learn",
      name: "Learn",
      runtime: "codex",
      capabilities: { filesystem: "read-only" },
      knowledgeDelta: "required",
      steps: [step()],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await e.drain();
  assert.equal(rec.calls.length, 0);
  const refused = await instance(inst.id);
  assert.equal(failure(refused, "learn").failureClass, "configuration");
  assert.match(
    failure(refused, "learn").reason!,
    /KnowledgeDelta file \(ARGUS_KNOWLEDGE_DELTA_FILE\)/,
  );
});

test("an optional KnowledgeDelta channel the runtime cannot write launches, with the gap on the record — no silent mismatch", async () => {
  await seed([
    {
      id: "learn",
      name: "Learn",
      runtime: "codex",
      capabilities: { filesystem: "read-only" },
      steps: [step()],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  assert.equal(rec.calls.length, 1);
  assert.ok(rec.calls[0].env.ARGUS_KNOWLEDGE_DELTA_FILE, "the protocol is still offered");
  const record = (await readInvocation(rec.calls[0].runId))!;
  assert.deepEqual(
    record.channels?.map((c) => [c.kind, c.required, c.status]),
    [
      ["knowledge-delta", false, "unavailable"],
      ["artifact-dir", false, "unavailable"],
    ],
  );
  assert.ok(
    record.limitations.includes(
      "Codex read-only sandbox prevents writing the KnowledgeDelta file (ARGUS_KNOWLEDGE_DELTA_FILE)",
    ),
  );
  assert.equal((await instance(inst.id)).phases[0].status, "running");
});

test("best-effort enforcement: the same required channel gap launches and is recorded on the invocation", async () => {
  await seed([
    {
      id: "judge",
      name: "Judge",
      runtime: "codex",
      capabilities: { filesystem: "read-only", enforcement: "best-effort" },
      result: DECISION,
      steps: [step()],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  assert.equal(rec.calls.length, 1);
  assert.equal((await instance(inst.id)).phases[0].status, "running");
  const record = (await readInvocation(rec.calls[0].runId))!;
  const result = record.channels?.find((c) => c.kind === "result");
  assert.ok(result);
  assert.equal(result.status, "unavailable");
  assert.equal(result.required, true);
  assert.equal(
    result.reason,
    "Codex read-only sandbox prevents writing the result file (ARGUS_RESULT_FILE)",
  );
  assert.ok(record.limitations.includes(result.reason ?? ""));
});

/** A working directory that is not Argus's own home: in production the
 *  repository never contains `~/.claude/argus`, and a read-only profile denies
 *  edits under the whole working directory — channels included, if they were
 *  in there (a case the Claude Code adapter reports, see channels.test.ts). */
function workDir(): string {
  return mkdtempSync(path.join(tmpdir(), "argus-knowledge-work-"));
}

test("a supported runtime under a restrictive profile has every channel granted and admitted to its sandbox", async () => {
  const work = workDir();
  await seed([
    {
      id: "judge",
      name: "Judge",
      cwd: work,
      capabilities: { filesystem: "read-only", tools: { allow: ["Read"] } },
      result: DECISION,
      checks: [{ kind: "artifact", path: "report.md" }],
      steps: [step()],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  await e.start("p1", "manual");
  assert.equal(rec.calls.length, 1);
  const call = rec.calls[0];
  const record = (await readInvocation(call.runId))!;
  assert.deepEqual(
    record.channels?.map((c) => [c.kind, c.required, c.status, c.path]),
    [
      ["result", true, "granted", call.env.ARGUS_RESULT_FILE],
      ["knowledge-delta", false, "granted", call.env.ARGUS_KNOWLEDGE_DELTA_FILE],
      ["artifact-dir", true, "granted", call.env.ARGUS_ARTIFACT_DIR],
    ],
  );
  assert.deepEqual(record.limitations, []);
  const added = record.args.filter((_, i) => record.args[i - 1] === "--add-dir");
  assert.deepEqual(added, [
    path.dirname(call.env.ARGUS_RESULT_FILE),
    knowledgeDeltaDir(call.runId),
    call.env.ARGUS_ARTIFACT_DIR,
  ]);
  // The repository itself is still denied under the profile.
  const denied = record.args[record.args.indexOf("--disallowedTools") + 1];
  assert.ok(denied.includes(`Edit(//${work}/**)`));
});

test("Claude Code read-only with the working directory containing Argus's work root: the channels are honestly unavailable", async (t) => {
  // `home` is the phase's cwd and the work root is placed inside it, so every
  // channel sits under the root the read-only rule denies. The required result
  // channel refuses the launch; nothing pretends the result could have been written.
  process.env.ARGUS_WORK_DIR = path.join(home, "work");
  t.after(() => delete process.env.ARGUS_WORK_DIR);
  await seed([
    {
      id: "judge",
      name: "Judge",
      capabilities: { filesystem: "read-only" },
      result: DECISION,
      steps: [step()],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  await e.drain();
  assert.equal(rec.calls.length, 0);
  const after = await instance(inst.id);
  assert.equal(failure(after, "judge").failureClass, "configuration");
  assert.match(
    failure(after, "judge").reason!,
    /Claude Code read-only denies edits under .*, which contains the result file/,
  );
});

test("legacy: a run with no profile records unmanaged channels and an argv without any channel flag", async () => {
  await seed([{ id: "only", name: "Only", steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  await e.start("p1", "manual");
  const record = (await readInvocation(rec.calls[0].runId))!;
  assert.deepEqual(record.limitations, []);
  assert.deepEqual(
    record.channels?.map((c) => [c.kind, c.status]),
    [
      ["knowledge-delta", "unmanaged"],
      ["artifact-dir", "unmanaged"],
    ],
  );
  assert.equal(record.args.includes("--add-dir"), false);
  assert.equal(record.args.includes("--settings"), false);
});

// ── Hardening: artifact provenance is rechecked at the commit boundary ──────

test("an artifact that vanished between intake and commit refuses the whole attempt's commit, and canonical knowledge is unchanged", async () => {
  await seedRule();
  await seed([{ id: "impl", name: "Impl", gated: true, steps: [step("a"), step("b")] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  const before = JSON.stringify(await readLedger());

  // Step a proposes a claim; step b declares an artifact that exists at intake.
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "c", kind: "conclusion", statement: "from a" }],
  });
  const report = path.join(rec.calls[1].env.ARGUS_ARTIFACT_DIR, "report.md");
  writeFileSync(report, "# report");
  writeDelta(rec.calls[1], {
    schemaVersion: 1,
    artifacts: [{ location: "artifact-dir", path: "report.md" }],
  });
  await complete(e, inst, "impl", rec.calls[0].runId);
  await complete(e, inst, "impl", rec.calls[1].runId);
  const waiting = await instance(inst.id);
  assert.equal(waiting.status, "awaiting-approval");
  assert.equal((await readDeltaRecord(rec.calls[1].runId))?.status, "staged");

  // The artifact disappears while the gate waits.
  rmSync(report);

  const res = await e.approve(inst.id);
  assert.equal(res.code, 200);
  const after = await instance(inst.id);
  assert.equal(after.phases[0].status, "failed");
  assert.equal(failure(after, "impl").failureClass, "knowledge-delta");
  assert.match(
    failure(after, "impl").reason!,
    /artifact artifact-dir:report\.md does not exist in the run's artifact-dir/,
  );
  assert.equal(after.phases[0].knowledge?.status, "rejected");
  // Atomic: the sibling's valid claim was not applied either.
  assert.equal(JSON.stringify(await readLedger()), before);
  for (const call of rec.calls) {
    const record = (await readDeltaRecord(call.runId))!;
    assert.equal(record.status, "rejected");
    assert.match(record.reason!, /report\.md does not exist/);
  }
  assert.ok((await readJournal(inst.id)).some((j) => j.kind === "knowledge.rejected"));
});

test("an artifact still present at commit is recorded exactly as before", async () => {
  await seed([{ id: "impl", name: "Impl", gated: true, steps: [step()] }]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeFileSync(path.join(rec.calls[0].env.ARGUS_ARTIFACT_DIR, "report.md"), "# report");
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    artifacts: [{ location: "artifact-dir", path: "report.md" }],
  });
  await complete(e, inst, "impl", rec.calls[0].runId);
  await e.approve(inst.id);
  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.deepEqual(
    (await readLedger()).artifacts.map((a) => a.artifact),
    [{ location: "artifact-dir", path: "report.md" }],
  );
});

// ── Hardening: retry isolation under the channel model ──────────────────────

test("retry under a read-only profile: every attempt gets its own channels, and only the succeeding attempt's delta commits", async () => {
  await seedRule();
  const marker = path.join(home, "second-attempt");
  await seed([
    {
      id: "plan",
      name: "Plan",
      cwd: workDir(),
      capabilities: { filesystem: "read-only", tools: { allow: ["Read"] } },
      steps: [step()],
      checks: [{ kind: "command", run: `test -f "${marker}"`, label: "marker" }],
      retry: { attempts: 2, backoffSeconds: 0, retryOn: ["verification"] },
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  writeDelta(rec.calls[0], {
    schemaVersion: 1,
    claims: [{ localId: "first", kind: "fact", statement: "from attempt 1" }],
  });
  await complete(e, inst, "plan", rec.calls[0].runId);
  await e.drain();
  assert.equal((await readDeltaRecord(rec.calls[0].runId))?.status, "superseded");

  writeFileSync(marker, "go");
  await e.reconcile();
  await e.drain();
  assert.equal(rec.calls.length, 2);
  writeDelta(rec.calls[1], {
    schemaVersion: 1,
    claims: [{ localId: "second", kind: "fact", statement: "from attempt 2" }],
  });
  await complete(e, inst, "plan", rec.calls[1].runId);
  await e.drain();

  assert.equal((await instance(inst.id)).status, "succeeded");
  // Each attempt's record names that attempt's own delta path, granted under
  // the profile — never the other attempt's.
  const records = await Promise.all(rec.calls.map((c) => readInvocation(c.runId)));
  for (const [i, record] of records.entries()) {
    const delta = record!.channels?.find((c) => c.kind === "knowledge-delta");
    assert.ok(delta);
    assert.equal(delta.status, "granted");
    assert.equal(delta.path, rec.calls[i].env.ARGUS_KNOWLEDGE_DELTA_FILE);
    assert.ok(record!.args.includes(knowledgeDeltaDir(rec.calls[i].runId)));
  }
  assert.notEqual(records[0]!.knowledgeDeltaFile, records[1]!.knowledgeDeltaFile);
  const ledger = await readLedger();
  assert.deepEqual(
    ledger.claims.filter((c) => c.kind === "fact").map((c) => c.statement),
    ["from attempt 2"],
  );
  assert.equal((await readDeltaRecord(rec.calls[1].runId))?.status, "applied");
});

// ── Candidate phases ────────────────────────────────────────────────────────

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/** A real repository with one commit, as a candidates phase's `cwd`. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-knowledge-repo-"));
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], {
      cwd: dir,
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

test("candidates: a losing candidate's staged delta is superseded and only the winner's becomes canonical", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  await seedRule();
  const repo = makeRepo();
  await seed([
    {
      id: "impl",
      name: "Implement",
      cwd: repo,
      workspace: { scope: "attempt" },
      checks: [{ kind: "file", path: "done.txt", label: "wrote it" }],
      candidates: { count: 2, select: "first-verified" },
      steps: [step("code")],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn);
  const inst = (await e.start("p1", "manual"))!;
  assert.equal(rec.calls.length, 2);
  const [a, b] = rec.calls;
  assert.notEqual(a.cwd, b.cwd, "each candidate has its own worktree");
  assert.notEqual(a.env.ARGUS_KNOWLEDGE_DELTA_FILE, b.env.ARGUS_KNOWLEDGE_DELTA_FILE);

  // Candidate A proposes knowledge but never writes done.txt: it will fail
  // its checks. Its delta is valid on its own and is staged at completion.
  writeDelta(a, {
    schemaVersion: 1,
    claims: [{ localId: "a", kind: "fact", statement: "candidate A learned this" }],
  });
  await complete(e, inst, "impl", a.runId);
  await e.drain();
  // A's checks failed; the phase is still open (B may yet win). A's delta is
  // staged but not canonical, and cannot become so: only a succeeded step's
  // delta is eligible at the commit, and A's step is retired at selection.
  const mid = await instance(inst.id);
  assert.equal(mid.phases[0].status, "running");
  assert.equal(mid.phases[0].steps[0].verification?.status, "failed");
  assert.equal((await readDeltaRecord(a.runId))?.status, "staged");
  assert.equal((await readLedger()).claims.length, 1, "nothing canonical yet");

  // Candidate B does the work, declares its artifact in its own tree, and wins.
  writeFileSync(path.join(b.cwd, "done.txt"), "ok\n");
  writeDelta(b, {
    schemaVersion: 1,
    claims: [{ localId: "b", kind: "fact", statement: "candidate B learned this" }],
    artifacts: [{ location: "repository", path: "done.txt" }],
  });
  await complete(e, inst, "impl", b.runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].selectedCandidate, 1);
  assert.equal(after.phases[0].knowledge?.status, "applied");
  assert.deepEqual(after.phases[0].knowledge?.deltas, [
    after.phases[0].steps[1].knowledgeDelta!.id,
  ]);
  assert.equal(after.phases[0].steps[0].knowledgeDelta?.status, "superseded");
  assert.equal(after.phases[0].steps[1].knowledgeDelta?.status, "applied");

  const ledger = await readLedger();
  assert.deepEqual(
    ledger.claims.filter((c) => c.kind === "fact").map((c) => c.statement),
    ["candidate B learned this"],
  );
  assert.equal(ledger.deltas.length, 1);
  assert.equal(ledger.deltas[0].execution.runId, b.runId);
  // The artifact recheck at commit ran against the winner's own worktree.
  assert.deepEqual(
    ledger.artifacts.map((x) => [x.execution.runId, x.artifact.path]),
    [[b.runId, "done.txt"]],
  );
  assert.equal((await readDeltaRecord(a.runId))?.status, "superseded");
  assert.equal((await readDeltaRecord(b.runId))?.status, "applied");
  const kinds = (await readJournal(inst.id)).map((j) => j.kind);
  assert.ok(kinds.includes("knowledge.superseded"));
  assert.ok(kinds.includes("knowledge.applied"));
});

test("candidates: a still-running loser is killed before it can stage anything, and the winner's delta commits alone", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = makeRepo();
  await seed([
    {
      id: "impl",
      name: "Implement",
      cwd: repo,
      workspace: { scope: "attempt" },
      checks: [{ kind: "file", path: "done.txt", label: "wrote it" }],
      candidates: { count: 2, select: "first-verified" },
      steps: [step("code")],
    },
  ]);
  const rec = recordingSpawn();
  const e = engine(rec.spawn, { kill: () => true });
  const inst = (await e.start("p1", "manual"))!;
  const [a, b] = rec.calls;
  // A has written its proposal but has not finished when B wins.
  writeDelta(a, {
    schemaVersion: 1,
    claims: [{ localId: "a", kind: "fact", statement: "from the loser" }],
  });
  writeFileSync(path.join(b.cwd, "done.txt"), "ok\n");
  writeDelta(b, {
    schemaVersion: 1,
    claims: [{ localId: "b", kind: "fact", statement: "from the winner" }],
  });
  await complete(e, inst, "impl", b.runId);
  await e.drain();

  const after = await instance(inst.id);
  assert.equal(after.status, "succeeded");
  assert.equal(after.phases[0].steps[0].status, "aborted");
  assert.equal("knowledgeDelta" in after.phases[0].steps[0], false);
  assert.equal(await readDeltaRecord(a.runId), null, "the loser's file was never staged");
  const ledger = await readLedger();
  assert.deepEqual(
    ledger.claims.map((c) => c.statement),
    ["from the winner"],
  );
  // A completion arriving from the killed loser afterwards changes nothing.
  await complete(e, inst, "impl", a.runId);
  assert.equal(await readDeltaRecord(a.runId), null);
  assert.equal((await readLedger()).claims.length, 1);
});
