/**
 * Effect recovery (Hardening Item 1, checkpoint E).
 *
 * A "crash" here is discarding an engine and building a fresh one over the
 * same files; a "live process" is this test process's own pid, which
 * `isAlive` answers truthfully, and `kill` is a stub that only records. So
 * these establish simulated recovery — what the engine does with the state a
 * crash leaves — not durability across a power cut.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine } from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { readInstance, writeInstance } from "../sources/instances.js";
import { readRun, patchRun } from "../sources/runs.js";
import { readJournal } from "../sources/journal.js";
import { knowledgeDeltaFile } from "../knowledge/staging.js";
import { readLedger } from "../knowledge/store.js";
import { readTransitionLog } from "../transitionLog/store.js";
import { compareIntegrity } from "../transitionLog/fold.js";
import { testRunToken } from "../testSignalToken.js";
import type { PipelineInstance } from "@argus/contracts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-effect-recovery-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const ALIVE = process.pid;
const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
let counter = 0;

function harness(pidFor: (n: number) => number = () => ALIVE) {
  const spawned: string[] = [];
  const terms: number[] = [];
  const spawn = (run: { id: string }) => {
    spawned.push(run.id);
    return { pid: pidFor(spawned.length), done: new Promise<{ code: number | null }>(() => {}) };
  };
  const make = (over: Record<string, unknown> = {}) =>
    createEngine({
      now: () => new Date(),
      newId: () => `r-${++counter}`,
      newSignalToken: testRunToken,
      signalUrlBase: "http://localhost:7777",
      maxConcurrent: 8,
      tickMs: 30000,
      // Long, so only termination requests are counted, never the escalation.
      killGraceMs: 600_000,
      kill: (pid: number, signal?: NodeJS.Signals) => {
        if (!signal) terms.push(pid);
        return true;
      },
      spawn,
      ...over,
    } as any);
  return { make, spawned, terms };
}

async function seed(phases: unknown[]) {
  return createPipeline(
    validatePipelineInput({ name: "rec", trigger: null, phases }),
    new Date(),
    "p1",
  );
}
const phase = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});
const runOf = async (id: string, phaseId: string, i = 0) =>
  (await readInstance(id))!.phases.find((p) => p.id === phaseId)!.steps[i].runId!;
const complete = (e: any, inst: any, phaseId: string, runId: string) =>
  e.onSignal(inst.id, {
    instanceId: inst.id,
    phaseId,
    runId,
    type: "completed",
    token: testRunToken(runId),
    payload: MARKED,
  });
/** The journal is appended fire-and-forget, so wait for the entry to land. */
async function journalHas(id: string, kind: string): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if ((await readJournal(id)).some((j: any) => j.kind === kind)) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}
async function settle(e: any) {
  await e.drain();
  await new Promise((r) => setTimeout(r, 20));
}

// ── termination ──────────────────────────────────────────────────────────────

test("a recorded request to stop a run is not the stop: after a crash, a live process is stopped", async () => {
  await seed([phase("a")]);
  const h = harness();
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  const runId = await runOf(inst.id, "a");
  // The abort recorded its request and its decision, then the process died
  // before the signal went out: the run says `killed`, nobody delivered it.
  await patchRun(runId, { termination: "killed", error: "aborted" });
  const aborted = structuredClone((await readInstance(inst.id))!);
  aborted.status = "aborted";
  aborted.endedAt = new Date().toISOString();
  aborted.phases[0].status = "aborted";
  aborted.phases[0].steps[0].status = "aborted";
  await writeInstance(aborted);
  assert.deepEqual(h.terms, []);

  const e2 = h.make();
  await e2.reconcile();
  assert.deepEqual(h.terms, [ALIVE], "delivered once, by the process that found it");
  assert.equal((await readRun(runId))?.run.error, "aborted", "under the reason it was given");
  assert.ok(await journalHas(inst.id, "step.termination-redelivered"));
  // Delivered by this process now: another pass does not repeat it.
  await e2.reconcile();
  assert.deepEqual(h.terms, [ALIVE]);
});

test("a sibling the post-failure sweep never reached is stopped by reconcile", async () => {
  await seed([
    phase("a", {
      steps: [
        { name: "x", prompt: "x" },
        { name: "y", prompt: "y" },
      ],
    }),
  ]);
  const h = harness();
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  const [x, y] = [await runOf(inst.id, "a", 0), await runOf(inst.id, "a", 1)];
  // The phase failed and was saved; the process died before stopping `y`.
  const failed = structuredClone((await readInstance(inst.id))!);
  failed.status = "failed";
  failed.phases[0].status = "failed";
  failed.phases[0].steps.forEach((s) => (s.status = "failed"));
  await writeInstance(failed);
  await patchRun(x, { outcome: "failed" }); // x reported its own failure

  const e2 = h.make();
  await e2.reconcile();
  assert.equal(h.terms.length, 1, "only the run that never reported is stopped");
  assert.equal((await readRun(y))?.run.termination, "killed");
  assert.equal((await readRun(x))?.run.termination, undefined);
  assert.ok(await journalHas(inst.id, "step.orphan-stopped"));
});

test("an abort in this process is never delivered twice by the sweep that follows", async () => {
  await seed([phase("a"), phase("b", { needs: [] })]);
  const h = harness();
  const e = h.make();
  const inst = (await e.start("p1", "manual"))!;
  assert.equal((await e.abort(inst.id)).code, 200);
  assert.equal(h.terms.length, 2);
  await e.reconcile();
  await e.reconcile();
  assert.equal(h.terms.length, 2, "the sweep leaves what this process already stopped");
});

test("an adopted run past its deadline is stopped once; after another crash it is delivered again", async () => {
  await seed([phase("a", { timeoutSeconds: 1 })]);
  const h = harness();
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  const runId = await runOf(inst.id, "a");
  await patchRun(runId, { deadlineAt: new Date(Date.now() - 1000).toISOString() });

  const e2 = h.make();
  await e2.adopt();
  await e2.reconcile();
  assert.deepEqual(h.terms, [ALIVE]);
  assert.equal((await readRun(runId))?.run.termination, "timed-out");
  await e2.reconcile();
  assert.deepEqual(h.terms, [ALIVE], "not re-sent by the process that sent it");

  // A third process finds the request recorded and the process still alive.
  const e3 = h.make();
  await e3.adopt();
  await e3.reconcile();
  assert.deepEqual(h.terms, [ALIVE, ALIVE]);
  assert.equal((await readRun(runId))?.run.termination, "timed-out", "the first reason stands");
});

// ── the commit point ─────────────────────────────────────────────────────────

test("a crash after the commit point owes a launch, and reconcile makes it exactly once", async () => {
  await seed([phase("a"), phase("b")]);
  const h = harness();
  const { writeInstance: realWrite } = await import("../sources/instances.js");
  let crashAfterPublish = false;
  const e1 = h.make({
    transitionLog: {
      publish: async (i: PipelineInstance) => {
        await realWrite(i);
        if (crashAfterPublish) throw new Error("crashed after publishing");
      },
    },
  });
  const inst = (await e1.start("p1", "manual"))!;
  crashAfterPublish = true;
  await assert.rejects(complete(e1, inst, "a", await runOf(inst.id, "a")));
  await settle(e1);
  const committed = (await readInstance(inst.id))!;
  assert.equal(committed.phases[1].status, "running", "the transition was committed");
  assert.equal(committed.phases[1].steps[0].runId, null, "and its launch never happened");
  assert.equal(h.spawned.length, 1);

  const e2 = h.make();
  await e2.reconcile();
  await settle(e2);
  assert.equal(h.spawned.length, 2, "the owed launch was made");
  await e2.reconcile();
  await settle(e2);
  assert.equal(h.spawned.length, 2, "and only once");
  assert.ok(await journalHas(inst.id, "phase.launch-recovered"));
  const r = compareIntegrity(
    inst.id,
    await readInstance(inst.id),
    await readTransitionLog(inst.id),
  );
  assert.ok(["consistent", "partial"].includes(r.status), r.findings.join("; "));
});

test("a transition the log has but the instance never committed causes nothing", async () => {
  await seed([phase("a"), phase("b")]);
  const h = harness();
  const e1 = h.make({
    transitionLog: {
      publish: async () => {
        throw new Error("never published");
      },
    },
  });
  // Start must publish to exist at all; use a working engine for that.
  const inst = (await h.make().start("p1", "manual"))!;
  await assert.rejects(complete(e1, inst, "a", await runOf(inst.id, "a")));
  const log = (await readTransitionLog(inst.id)).records;
  const proposal = log[log.length - 1];
  assert.ok(proposal.effects.some((ef) => ef.kind === "launch" && ef.phaseId === "b"));
  assert.ok(proposal.seq > (await readInstance(inst.id))!.transitionLog!.seq);

  const e2 = h.make();
  await e2.reconcile();
  await settle(e2);
  assert.equal(h.spawned.length, 1, "the proposal's owed launch is never executed");
  assert.equal((await readInstance(inst.id))!.phases[1].status, "pending");
});

test("two sibling phases owed after a crash are both launched — one attempt's guard holds no other back", async () => {
  await seed([
    phase("root"),
    phase("left", { needs: ["root"] }),
    phase("right", { needs: ["root"] }),
  ]);
  const h = harness();
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  // Committed: both branches running, neither launched (the crash).
  const owed = structuredClone((await readInstance(inst.id))!);
  owed.phases[0].status = "succeeded";
  owed.phases[0].steps[0].status = "succeeded";
  for (const i of [1, 2]) owed.phases[i].status = "running";
  await writeInstance(owed);
  const e2 = h.make();
  await Promise.all([e2.reconcile(), e2.reconcile()]);
  await settle(e2);
  assert.equal(h.spawned.length, 3, "root, then one run for each branch");
  const after = (await readInstance(inst.id))!;
  assert.ok(after.phases[1].steps[0].runId && after.phases[2].steps[0].runId);
});

// ── verification and knowledge ───────────────────────────────────────────────

test("a check interrupted by a crash runs again from the saved instance", async () => {
  await seed([phase("a", { checks: [{ kind: "command", run: "exit 0", label: "ok" }] })]);
  const h = harness();
  const { writeInstance: realWrite } = await import("../sources/instances.js");
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  // Commit "verification running" by hand, as a crash mid-check leaves it.
  const mid = structuredClone((await readInstance(inst.id))!);
  mid.phases[0].steps[0].status = "succeeded";
  mid.phases[0].verification = {
    status: "running",
    startedAt: new Date().toISOString(),
    checks: [],
  };
  await realWrite(mid);
  const e2 = h.make();
  await e2.reconcile();
  await settle(e2);
  const after = (await readInstance(inst.id))!;
  assert.equal(after.phases[0].verification?.status, "passed");
  assert.equal(after.status, "succeeded");
});

test("a knowledge commit interrupted by a crash commits once on recovery", async () => {
  await seed([phase("learn", { gated: true })]);
  const h = harness();
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  const runId = await runOf(inst.id, "learn");
  const file = knowledgeDeltaFile(runId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      claims: [{ localId: "c", kind: "fact", statement: "once" }],
    }),
  );
  await complete(e1, inst, "learn", runId);
  // The approval reaches "knowledge pending" and dies before the ledger write.
  const e2 = h.make({
    gateEffectProbe: async (point: string) => {
      if (point === "approve:linked") throw new Error("crash");
    },
  });
  assert.equal((await e2.approve(inst.id)).ok, false);
  assert.equal((await readLedger()).claims.length, 0);
  const e3 = h.make();
  await e3.reconcile();
  await e3.reconcile();
  await settle(e3);
  assert.equal((await readInstance(inst.id))!.status, "succeeded");
  assert.equal((await readLedger()).claims.length, 1, "committed exactly once, by delta id");
});

// ── compatibility ────────────────────────────────────────────────────────────

test("an instance with no log at all recovers and finishes like any other", async () => {
  await seed([phase("a"), phase("b")]);
  const h = harness();
  const e1 = h.make();
  const inst = (await e1.start("p1", "manual"))!;
  const legacy = (await readInstance(inst.id))!;
  delete legacy.transitionLog;
  await writeInstance(legacy);
  const { rmSync } = await import("node:fs");
  rmSync(path.join(home, "argus", "transitions", `${inst.id}.jsonl`));
  const e2 = h.make();
  await complete(e2, inst, "a", await runOf(inst.id, "a"));
  await settle(e2);
  await complete(e2, inst, "b", await runOf(inst.id, "b"));
  assert.equal((await readInstance(inst.id))!.status, "succeeded");
});
