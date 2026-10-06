import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance, writeInstance } from "../sources/instances.js";
import { readJournal } from "../sources/journal.js";
import { readGateDecisions } from "../sources/gateDecisions.js";
import { knowledgeDeltaFile } from "../knowledge/staging.js";
import { readLedger } from "../knowledge/store.js";
import { readTransitionLog } from "../transitionLog/store.js";
import { testRunToken } from "../testSignalToken.js";
import type { PipelineInstance } from "@argus/contracts";

/**
 * Recovery while another phase is paused at a gate (Hardening Item 1, review
 * correction to checkpoint E).
 *
 * The engine's authority while any phase awaits approval, as the live paths
 * already apply it:
 *
 * - work a committed decision ordered still starts — the approval path calls
 *   `startPhases` directly, and a knowledge commit completes its approval;
 * - results wait for the gate decision — agent signals are acknowledged and
 *   dropped (`signals.ts`), and check results are not applied to a paused
 *   instance (`verification.ts`).
 *
 * Recovery follows the same line. A "crash" is discarding an engine and
 * building a fresh one over the same files. Where noted, a crash is injected
 * through the engine's own fault seams (`gateEffectProbe`,
 * `transitionLog.publish`); the second waiting gate is always written on disk,
 * because the engine drops the completion signal that would pause it (it
 * accepts signals only on a `running` instance — a separately tracked
 * limitation).
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-paused-recovery-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
let counter = 0;

function harness() {
  const spawned: Array<{ id: string; phaseId: string }> = [];
  const make = (over: Record<string, unknown> = {}) =>
    createEngine({
      now: () => new Date(),
      newId: () => `r-${++counter}`,
      newSignalToken: testRunToken,
      signalUrlBase: "http://localhost:7777",
      maxConcurrent: 8,
      tickMs: 30000,
      killGraceMs: 600_000,
      kill: () => true,
      spawn: (run: { id: string; phaseId?: string }) => {
        spawned.push({ id: run.id, phaseId: run.phaseId ?? "" });
        return { pid: 999_999, done: new Promise<{ code: number | null }>(() => {}) };
      },
      ...over,
    } as any);
  const launchesOf = (phaseId: string) => spawned.filter((s) => s.phaseId === phaseId).length;
  return { make, spawned, launchesOf };
}

const phase = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});

async function seed(phases: unknown[]) {
  return createPipeline(
    validatePipelineInput({ name: "paused", trigger: null, phases }),
    new Date(),
    "p1",
  );
}

const load = async (id: string) => (await readInstance(id))!;
const phaseOf = (inst: PipelineInstance, id: string) => inst.phases.find((p) => p.id === id)!;
const complete = (e: any, instId: string, phaseId: string, runId: string) =>
  e.onSignal(instId, {
    instanceId: instId,
    phaseId,
    runId,
    type: "completed",
    token: testRunToken(runId),
    payload: MARKED,
  });
async function settle(e: any) {
  await e.drain();
  await new Promise((r) => setTimeout(r, 20));
  await e.drain();
}
async function journalCount(id: string, kind: string): Promise<number> {
  await new Promise((r) => setTimeout(r, 20));
  return (await readJournal(id)).filter((j: any) => j.kind === kind).length;
}

/**
 * Two gates side by side, `x` and `y`, and `z` downstream of `x`. `x` is
 * paused by its real completion signal; `y` is then paused on disk (the
 * engine would drop its signal). The instance is `awaiting-approval`.
 */
async function twoGatesWaiting(h: ReturnType<typeof harness>, xOver: Record<string, unknown> = {}) {
  await seed([
    phase("x", { gated: true, needs: [], ...xOver }),
    phase("y", { gated: true, needs: [] }),
    phase("z", { needs: ["x"] }),
  ]);
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  const xRun = phaseOf(await load(inst.id), "x").steps[0].runId!;
  const yRun = phaseOf(await load(inst.id), "y").steps[0].runId!;
  return { e1, inst, xRun, yRun };
}
async function pauseYOnDisk(instId: string) {
  const both = await load(instId);
  phaseOf(both, "y").status = "awaiting-approval";
  (phaseOf(both, "y") as any).pause = "gate";
  phaseOf(both, "y").steps[0].status = "succeeded";
  both.status = "awaiting-approval";
  await writeInstance(both);
}
/** `y` is still exactly the person's to decide: nothing recovery did touched it. */
async function yUntouched(instId: string) {
  const after = await load(instId);
  assert.equal(phaseOf(after, "y").status, "awaiting-approval", "the waiting gate stays waiting");
  assert.equal(phaseOf(after, "y").attempt, 0);
  const decisions = await readGateDecisions(instId);
  assert.equal(
    decisions.some((d) => d.phases.some((p) => p.phaseId === "y")),
    false,
    "no decision was made on the waiting gate",
  );
}

// ── launches ────────────────────────────────────────────────────────────────

test("FAULT SEAM: an approval interrupted after linking, with another gate waiting, launches its downstream phase on recovery", async () => {
  const h = harness();
  const { e1, inst, xRun } = await twoGatesWaiting(h);
  await complete(e1, inst.id, "x", xRun);
  await settle(e1);
  await pauseYOnDisk(inst.id);
  // The approval of `x` is linked, then the process dies before completing it.
  const e2 = h.make({
    gateEffectProbe: async (point: string) => {
      if (point === "approve:linked") throw new Error("crash");
    },
  });
  assert.equal((await e2.approve(inst.id, undefined, { phaseId: "x" })).ok, false);
  assert.equal(h.launchesOf("z"), 0);

  const e3 = h.make();
  await e3.reconcile();
  await settle(e3);
  assert.equal(
    phaseOf(await load(inst.id), "x").status,
    "succeeded",
    "the decided approval completed",
  );
  assert.equal(h.launchesOf("z"), 1, "what the approval ordered was launched, gate or no gate");
  await e3.reconcile();
  await settle(e3);
  assert.equal(h.launchesOf("z"), 1, "exactly once");
  await yUntouched(inst.id);
});

test("FAULT SEAM: an approval interrupted after its save, with another gate waiting, owes a launch that recovery makes once", async () => {
  const h = harness();
  const { e1, inst, xRun } = await twoGatesWaiting(h);
  await complete(e1, inst.id, "x", xRun);
  await settle(e1);
  await pauseYOnDisk(inst.id);
  const e2 = h.make({
    gateEffectProbe: async (point: string) => {
      if (point === "approve:saved") throw new Error("crash");
    },
  });
  await assert.rejects(e2.approve(inst.id, undefined, { phaseId: "x" }), /crash/);
  const committed = await load(inst.id);
  assert.equal(committed.status, "awaiting-approval");
  assert.equal(committed.pendingGateOperation, undefined, "the approval is complete and saved");
  assert.equal(phaseOf(committed, "z").status, "running", "z was committed running");
  assert.equal(phaseOf(committed, "z").steps[0].runId ?? null, null, "and never launched");

  const e3 = h.make();
  await e3.reconcile();
  await settle(e3);
  assert.equal(h.launchesOf("z"), 1);
  await e3.reconcile();
  await settle(e3);
  assert.equal(h.launchesOf("z"), 1);
  assert.ok((await journalCount(inst.id, "phase.launch-recovered")) >= 1);
  await yUntouched(inst.id);
});

// ── verification ────────────────────────────────────────────────────────────

test("MANUAL STATE: an interrupted check waits while a gate is paused, then runs exactly once after the decision", async () => {
  await seed([
    phase("x", { needs: [], checks: [{ kind: "command", run: "exit 0", label: "ok" }] }),
    phase("y", { gated: true, needs: [] }),
  ]);
  const h = harness();
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  const yRun = phaseOf(await load(inst.id), "y").steps[0].runId!;
  await complete(e1, inst.id, "y", yRun);
  await settle(e1);
  assert.equal((await load(inst.id)).status, "awaiting-approval", "y paused by its real signal");
  // x's checks were running when the process died (hand-written, as in
  // effectRecovery.test.ts).
  const mid = await load(inst.id);
  phaseOf(mid, "x").steps[0].status = "succeeded";
  phaseOf(mid, "x").verification = {
    status: "running",
    startedAt: new Date().toISOString(),
    checks: [],
  };
  await writeInstance(mid);

  const e2 = h.make();
  await e2.reconcile();
  await settle(e2);
  await e2.reconcile();
  await settle(e2);
  // A check result is not applied to a paused instance (verification.ts), so
  // running the checks now would only be thrown away: they wait.
  assert.equal(phaseOf(await load(inst.id), "x").verification?.status, "running");
  assert.equal(await journalCount(inst.id, "phase.verified"), 0);

  assert.equal((await e2.approve(inst.id, undefined, { phaseId: "y" })).ok, true);
  await settle(e2);
  await e2.reconcile();
  await settle(e2);
  await e2.reconcile();
  await settle(e2);
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "x").verification?.status, "passed");
  assert.equal(after.status, "succeeded");
  assert.equal(await journalCount(inst.id, "phase.verified"), 1, "verified exactly once");
});

// ── knowledge ───────────────────────────────────────────────────────────────

function stageDelta(runId: string, statement: string) {
  const file = knowledgeDeltaFile(runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, claims: [{ localId: "c", kind: "fact", statement }] }),
  );
}

test("FAULT SEAM: a knowledge commit interrupted mid-approval commits once while another gate waits", async () => {
  const h = harness();
  const { e1, inst, xRun } = await twoGatesWaiting(h);
  stageDelta(xRun, "once");
  await complete(e1, inst.id, "x", xRun);
  await settle(e1);
  await pauseYOnDisk(inst.id);
  const e2 = h.make({
    gateEffectProbe: async (point: string) => {
      if (point === "approve:linked") throw new Error("crash");
    },
  });
  assert.equal((await e2.approve(inst.id, undefined, { phaseId: "x" })).ok, false);
  assert.equal((await readLedger()).claims.length, 0);

  const e3 = h.make();
  await e3.reconcile();
  await e3.reconcile();
  await settle(e3);
  assert.equal((await readLedger()).claims.length, 1, "committed exactly once, by delta id");
  assert.equal(phaseOf(await load(inst.id), "x").status, "succeeded");
  await yUntouched(inst.id);
});

test("FAULT SEAM: a phase's own knowledge commit interrupted after the ledger write concludes while another gate waits", async () => {
  // No gate operation is involved: an ungated phase that staged a delta
  // commits from the signal path. The crash lands after the ledger write and
  // before the instance records it; then a sibling's real signal pauses the
  // instance before any reconcile ran.
  await seed([phase("x", { needs: [] }), phase("y", { gated: true, needs: [] })]);
  const h = harness();
  let crash = false;
  const e1 = h.make({
    transitionLog: {
      publish: async (i: PipelineInstance) => {
        if (crash && phaseOf(i, "x").knowledge?.status === "applied") {
          throw new Error("crashed after the ledger write");
        }
        await writeInstance(i);
      },
    },
  });
  const inst = (await e1.start("p1", "manual"))!;
  const xRun = phaseOf(await load(inst.id), "x").steps[0].runId!;
  const yRun = phaseOf(await load(inst.id), "y").steps[0].runId!;
  stageDelta(xRun, "own commit");
  crash = true;
  await complete(e1, inst.id, "x", xRun).catch(() => undefined);
  await settle(e1);
  assert.equal(phaseOf(await load(inst.id), "x").knowledge?.status, "pending");
  assert.equal((await readLedger()).claims.length, 1, "the ledger write happened");

  const e2 = h.make();
  await complete(e2, inst.id, "y", yRun);
  await settle(e2);
  const paused = await load(inst.id);
  assert.equal(paused.status, "awaiting-approval", "y paused by its real signal");
  assert.equal(paused.pendingGateOperation, undefined, "no gate operation to complete");

  const e3 = h.make();
  await e3.reconcile();
  await e3.reconcile();
  await settle(e3);
  const after = await load(inst.id);
  assert.equal(phaseOf(after, "x").knowledge?.status, "applied");
  assert.equal(phaseOf(after, "x").status, "succeeded");
  assert.equal((await readLedger()).claims.length, 1, "committed again idempotently: still one");
  await yUntouched(inst.id);
});

// ── what recovery never does ────────────────────────────────────────────────

test("FAULT SEAM: an approval whose link was never published causes nothing, with another gate waiting", async () => {
  const h = harness();
  const { e1, inst, xRun } = await twoGatesWaiting(h);
  await complete(e1, inst.id, "x", xRun);
  await settle(e1);
  await pauseYOnDisk(inst.id);
  const before = await load(inst.id);
  const e2 = h.make({
    transitionLog: {
      publish: async () => {
        throw new Error("never published");
      },
    },
  });
  assert.equal((await e2.approve(inst.id, undefined, { phaseId: "x" })).ok, false);
  const log = (await readTransitionLog(inst.id)).records;
  assert.ok(log[log.length - 1].seq > (before.transitionLog?.seq ?? 0), "a proposal is in the log");

  const e3 = h.make();
  await e3.reconcile();
  await settle(e3);
  const after = await load(inst.id);
  assert.equal(
    phaseOf(after, "x").status,
    "awaiting-approval",
    "the unlinked approval did nothing",
  );
  assert.equal(after.pendingGateOperation, undefined);
  assert.equal(h.launchesOf("z"), 0, "the proposal's launch is never executed");
  await yUntouched(inst.id);
});

test("MANUAL STATE: a planned attempt, an obsolete attempt and a scheduled retry are never launched while a gate waits", async () => {
  await seed([
    phase("a", { needs: [] }),
    phase("b", { needs: [] }),
    phase("c", { needs: [] }),
    phase("y", { gated: true, needs: [] }),
  ]);
  const h = harness();
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  const yRun = phaseOf(await load(inst.id), "y").steps[0].runId!;
  await complete(e1, inst.id, "y", yRun);
  await settle(e1);
  const before = h.spawned.length;
  const s = await load(inst.id);
  // a: its current attempt already planned (it carries a run id).
  // b: a failed attempt whose retry is scheduled for later.
  phaseOf(s, "b").status = "failed";
  phaseOf(s, "b").retryAt = new Date(Date.now() + 3_600_000).toISOString();
  phaseOf(s, "b").steps[0].status = "failed";
  // c: decided — skipped — though its step never got a run.
  phaseOf(s, "c").status = "skipped";
  phaseOf(s, "c").steps[0].runId = null;
  phaseOf(s, "c").steps[0].status = "skipped";
  await writeInstance(s);

  const e2 = h.make();
  await e2.reconcile();
  await settle(e2);
  assert.equal(h.spawned.length, before, "nothing launched");
  await yUntouched(inst.id);
});
