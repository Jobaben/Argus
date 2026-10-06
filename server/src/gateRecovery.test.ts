import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PipelineInstance } from "@argus/contracts";
import { createEngine, type Engine, type GateEffectPoint } from "./pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "./sources/pipelines.js";
import { readInstance } from "./sources/instances.js";
import { readRun } from "./sources/runs.js";
import { buildGateDecisionsResponse, readGateDecisions } from "./sources/gateDecisions.js";
import { readDeltaRecord } from "./knowledge/staging.js";
import { readLedger } from "./knowledge/store.js";
import { testRunToken } from "./testSignalToken.js";

/**
 * Recovery of interrupted gate decisions (Phase 0 follow-up).
 *
 * Every scenario injects a failure at one exact effect boundary through the
 * engine's `gateEffectProbe` seam — no sleeps, no timing — then discards that
 * engine (the "crash"), builds a fresh one over the same files (the
 * "restart"), and asserts on disk: the decision log, the instance, the staged
 * sidecars, the ledger, and which processes were signalled.
 *
 * Processes are never real. `isAlive` asks `process.kill(pid, 0)`, so a step
 * that should look alive is given this test process's own pid, and a sibling
 * that must never be touched is given the parent's. `kill` is injected and
 * only records.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-gate-recovery-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  mkdirSync(path.join(home, "argus", "instances"), { recursive: true });
});

const NOW = new Date("2026-09-29T10:00:00.000Z");
const ALIVE = process.pid; // the gated phase's straggler
const SIBLING = process.ppid; // a concurrently running sibling branch

let counter = 0;
interface Spawned {
  runId: string;
  env: Record<string, string>;
}

function harness(over: Record<string, unknown> = {}) {
  const calls: Spawned[] = [];
  const killed: number[] = [];
  const spawn = (run: { id: string }, _log: string, env: Record<string, string>) => {
    calls.push({ runId: run.id, env });
    const pid = env.ARGUS_PHASE_ID === "side" ? SIBLING : ALIVE;
    return { pid, done: new Promise<{ code: number | null }>(() => {}) };
  };
  const make = (extra: Record<string, unknown> = {}) =>
    createEngine({
      now: () => new Date(),
      newId: () => `id-${++counter}`,
      spawn,
      signalUrlBase: "http://localhost:7777",
      newSignalToken: testRunToken,
      maxConcurrent: 8,
      tickMs: 30000,
      parentEnv: { PATH: process.env.PATH ?? "/bin", HOME: home },
      kill: (pid: number) => {
        killed.push(pid);
        return true;
      },
      killGraceMs: 60_000,
      ...over,
      ...extra,
    });
  return { calls, killed, make };
}

/** A probe that fails exactly once, at `at`. */
function failAt(at: GateEffectPoint) {
  let fired = false;
  return {
    gateEffectProbe: (point: GateEffectPoint) => {
      if (point === at && !fired) {
        fired = true;
        throw new Error(`injected failure at ${point}`);
      }
    },
  };
}

async function seed(withSibling = false) {
  const phases: Record<string, unknown>[] = [
    {
      id: "build",
      name: "build",
      cwd: home,
      gated: true,
      needs: [],
      steps: [{ name: "s", prompt: "p" }],
    },
  ];
  if (withSibling) {
    phases.push({
      id: "side",
      name: "side",
      cwd: home,
      gated: false,
      needs: [],
      steps: [{ name: "x", prompt: "p" }],
    });
  }
  return createPipeline(validatePipelineInput({ name: "g", trigger: null, phases }), NOW, "p1");
}

async function load(id: string): Promise<PipelineInstance> {
  const inst = await readInstance(id);
  assert.ok(inst);
  return inst;
}
const phaseOf = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)!;

function stageDelta(call: Spawned) {
  const file = call.env.ARGUS_KNOWLEDGE_DELTA_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      claims: [{ localId: "f", kind: "fact", statement: "x" }],
      evidence: [{ claim: { local: "f" }, source: { type: "document", uri: "spec://x" } }],
    }),
  );
}

async function signal(
  e: Engine,
  inst: PipelineInstance,
  phaseId: string,
  runId: string,
  type: "completed" | "needs-input",
) {
  const res = await e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId,
    type,
    token: testRunToken(runId),
    payload: { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
  });
  await e.drain();
  return res;
}

/** Waiting at the `build` gate with a staged delta; optionally a sibling still running. */
async function atGate(
  h: ReturnType<typeof harness>,
  e: Engine,
  opts: { sibling?: boolean; ask?: boolean } = {},
) {
  await seed(opts.sibling);
  const inst = (await e.start("p1", "manual"))!;
  const build = h.calls.find((c) => c.env.ARGUS_PHASE_ID === "build")!;
  stageDelta(build);
  await signal(e, inst, "build", build.runId, opts.ask ? "needs-input" : "completed");
  const waiting = await load(inst.id);
  assert.equal(phaseOf(waiting, "build").status, "awaiting-approval");
  return { inst: waiting, build };
}

async function effects(instanceId: string) {
  const inst = await readInstance(instanceId);
  return buildGateDecisionsResponse(instanceId, inst, await readGateDecisions(instanceId))
    .decisions;
}

// ── Process-termination targets ─────────────────────────────────────────────

test("REPRO: revise stops the revised attempt's live runs, and never a sibling's", async () => {
  const h = harness();
  const e = h.make();
  // A needs-input pause: the agent asked a question and its process is still alive.
  const { inst, build } = await atGate(h, e, { sibling: true, ask: true });
  assert.equal((await readRun(build.runId))?.run.status, "running");
  assert.equal(phaseOf(inst, "side").status, "running");

  const res = await e.revise(inst.id, "no, use postgres");
  assert.equal(res.ok, true);
  assert.deepEqual(h.killed, [ALIVE], "the revised attempt's straggler is stopped");
  assert.ok(!h.killed.includes(SIBLING), "the running sibling is untouched");
  assert.equal((await readRun(build.runId))?.run.termination, "killed");
});

// ── Revise interrupted ──────────────────────────────────────────────────────

test("REPRO: revise interrupted after superseding staged records is not reported as having no effect", async () => {
  const h = harness();
  const { inst, build } = await atGate(h, h.make());
  const crashing = h.make(failAt("revise:superseded"));
  await assert.rejects(crashing.revise(inst.id, "again"));

  // The staged delta was superseded on disk before the failure.
  assert.equal((await readDeltaRecord(build.runId))?.status, "superseded");
  const [d] = await effects(inst.id);
  assert.notEqual(d.effect, "not-applied", "a decision whose effects began is never 'not-applied'");
});

test("REPRO: after an interrupted revise and a restart, the revise completes; the old attempt can no longer be accepted", async () => {
  const h = harness();
  const { inst } = await atGate(h, h.make());
  await assert.rejects(h.make(failAt("revise:superseded")).revise(inst.id, "again"));

  const restarted = h.make();
  await restarted.reconcile();
  await restarted.drain();
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "build").attempt, 1, "the revise was carried through");
  assert.equal(phaseOf(after, "build").status, "running");
  const spawnedForRetry = h.calls.filter((c) => c.env.ARGUS_PHASE_ID === "build").length;
  assert.equal(spawnedForRetry, 2, "exactly one new run for the revised attempt");

  // An operator (or automation) acting on the stale attempt 0 view is refused;
  // the superseded delta never reaches the ledger.
  const stale = await restarted.approve(inst.id, undefined, { attempt: 0 });
  assert.equal(stale.ok, false);
  assert.equal((await readLedger()).claims.length, 0);
  const [d] = await effects(inst.id);
  assert.equal(d.effect, "applied");
});

test("REPRO: an operator retry of the interrupted revise does not revise twice", async () => {
  const h = harness();
  const { inst } = await atGate(h, h.make());
  await assert.rejects(h.make(failAt("revise:superseded")).revise(inst.id, "again"));
  const restarted = h.make();
  const retry = await restarted.revise(inst.id, "again");
  await restarted.drain();
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "build").attempt, 1, "one revise, not two");
  assert.equal(h.calls.filter((c) => c.env.ARGUS_PHASE_ID === "build").length, 2);
  assert.equal(retry.ok, false, "the retry finds the first decision already carried through");
});

test("a revise that fails before its linkage is saved has no effects, and says so", async () => {
  const h = harness();
  const { inst, build } = await atGate(h, h.make());
  await assert.rejects(h.make(failAt("revise:recorded")).revise(inst.id, "again"));
  assert.equal((await readDeltaRecord(build.runId))?.status, "staged", "nothing superseded");
  assert.deepEqual(h.killed, []);
  const [d] = await effects(inst.id);
  assert.equal(d.effect, "not-applied");
  assert.equal(phaseOf(await load(inst.id), "build").attempt, 0);
});

// ── Abort interrupted ───────────────────────────────────────────────────────

test("REPRO: abort interrupted after stopping processes is not 'not-applied', and the instance does not continue", async () => {
  const h = harness();
  const e = h.make();
  const { inst } = await atGate(h, e, { sibling: true });
  await assert.rejects(h.make(failAt("abort:killed")).abort(inst.id));
  assert.ok(h.killed.includes(SIBLING), "the abort stopped the running sibling");
  const [d] = await effects(inst.id);
  assert.notEqual(d.effect, "not-applied");

  // Restart. The sibling's completion signal arrives: it must not advance an
  // instance whose abort was already under way.
  const restarted = h.make();
  const side = h.calls.find((c) => c.env.ARGUS_PHASE_ID === "side")!;
  await signal(restarted, await load(inst.id), "side", side.runId, "completed");
  await restarted.reconcile();
  const after = await load(inst.id);
  assert.equal(after.status, "aborted");
  assert.equal(phaseOf(after, "side").status, "aborted");
  assert.equal((await effects(inst.id))[0].effect, "applied");
});

test("an approval of an attempt whose abort was interrupted is refused after restart", async () => {
  const h = harness();
  const { inst } = await atGate(h, h.make());
  await assert.rejects(h.make(failAt("abort:killed")).abort(inst.id));
  const restarted = h.make();
  const res = await restarted.approve(inst.id);
  assert.equal(res.ok, false);
  assert.equal((await readLedger()).claims.length, 0, "the staged delta is never committed");
  assert.equal((await load(inst.id)).status, "aborted");
});

// ── Approve interrupted ─────────────────────────────────────────────────────

test("approve interrupted after the ledger commit reads applied, and restart concludes it once", async () => {
  const h = harness();
  const { inst } = await atGate(h, h.make());
  await assert.rejects(h.make(failAt("approve:knowledge-settled")).approve(inst.id));
  assert.equal((await readLedger()).claims.length, 1, "committed");
  assert.notEqual((await effects(inst.id))[0].effect, "not-applied");
  const restarted = h.make();
  await restarted.reconcile();
  await restarted.drain();
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "build").status, "succeeded");
  assert.equal((await readLedger()).claims.length, 1, "not committed twice");
  assert.equal((await effects(inst.id))[0].effect, "applied");
});

test("approve that fails before its linkage is saved commits nothing and reads not-applied", async () => {
  const h = harness();
  const { inst } = await atGate(h, h.make());
  await assert.rejects(h.make(failAt("approve:recorded")).approve(inst.id));
  assert.equal((await readLedger()).claims.length, 0);
  assert.equal((await effects(inst.id))[0].effect, "not-applied");
  assert.equal(phaseOf(await load(inst.id), "build").status, "awaiting-approval");
});

// ── Failure right after the link save, before any effect ────────────────────

test("revise interrupted just after linking reads incomplete with nothing done yet, and completes once on restart", async () => {
  const h = harness();
  const { inst, build } = await atGate(h, h.make());
  const res = await h.make(failAt("revise:linked")).revise(inst.id, "again");
  assert.equal(res.code, 500);
  assert.match(res.error ?? "", /linked but not completed/);
  assert.equal((await readDeltaRecord(build.runId))?.status, "staged", "no effect yet");
  const [d] = await effects(inst.id);
  assert.equal(d.effect, "incomplete");

  const restarted = h.make();
  await restarted.reconcile();
  await restarted.drain();
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "build").attempt, 1);
  assert.equal(after.pendingGateOperation, undefined);
  assert.equal((await readDeltaRecord(build.runId))?.status, "superseded");
  assert.equal(h.calls.filter((c) => c.env.ARGUS_PHASE_ID === "build").length, 2);
  assert.equal((await effects(inst.id))[0].effect, "applied");
});

test("abort interrupted just after linking reads incomplete, and the next action on the instance completes it first", async () => {
  const h = harness();
  const { inst } = await atGate(h, h.make(), { sibling: true });
  const res = await h.make(failAt("abort:linked")).abort(inst.id);
  assert.equal(res.code, 500);
  assert.equal(h.killed.length, 0, "no effect yet");
  assert.equal((await effects(inst.id))[0].effect, "incomplete");
  // No reconcile: an operator's approve is the next thing to touch it.
  const restarted = h.make();
  const approve = await restarted.approve(inst.id);
  assert.equal(approve.ok, false, "the abort is completed first, so there is nothing to approve");
  const after = await load(inst.id);
  assert.equal(after.status, "aborted");
  assert.ok(h.killed.includes(SIBLING));
  assert.equal((await readLedger()).claims.length, 0);
  assert.equal((await readGateDecisions(inst.id)).length, 1, "the refused approve records nothing");
});
