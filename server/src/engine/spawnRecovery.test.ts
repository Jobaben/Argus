/**
 * Spawn phases across a crash (DL-A2a): exactly one child per task, by the id
 * the parent saved before the start.
 *
 * A "crash" is discarding an engine and building a fresh one over the same
 * files (`make()`); the injected failure is `childEffectProbe` throwing at one
 * effect boundary (`gateEffectProbe` for a decision on a child, which can also
 * hold it there), or a state a crash would leave written by hand. Processes
 * are never real: the spawn double records each launch, the pid is this test
 * process's own (so a reconcile never takes a run for dead) and `kill` only
 * records.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEngine,
  type ChildEffectPoint,
  type EngineDeps,
  type GateEffectPoint,
} from "../pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "../sources/pipelines.js";
import { probeInstance, readInstance, writeInstance } from "../sources/instances.js";
import { readJournal } from "../sources/journal.js";
import { appendGateDecision, readGateDecisions } from "../sources/gateDecisions.js";
import { paths } from "../claudeHome.js";
import { testRunToken } from "../testSignalToken.js";
import type { PhaseChildren, PipelineInstance } from "../sources/pipelineTypes.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-spawn-recovery-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

// Every engine a test builds, the "crashed" ones included, is drained before
// the next test repoints the home; every gate a test held is released first,
// so a failed assertion never leaves an engine waiting.
const engines: ReturnType<typeof createEngine>[] = [];
const holds: (() => void)[] = [];
afterEach(async () => {
  for (const release of holds.splice(0)) release();
  await Promise.all(engines.splice(0).map((e) => e.drain()));
});

const ALIVE = process.pid;
const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
let counter = 0;

type Engine = ReturnType<typeof createEngine>;

function harness() {
  const calls: { runId: string; env: Record<string, string> }[] = [];
  const spawn: EngineDeps["spawn"] = (run, _log, env) => {
    calls.push({ runId: run.id, env });
    return { pid: ALIVE, done: new Promise<{ code: number | null }>(() => {}) };
  };
  const make = (over: Partial<EngineDeps> = {}): Engine => {
    const e = createEngine({
      now: () => new Date(),
      newId: () => `r-${++counter}`,
      newSignalToken: testRunToken,
      signalUrlBase: "http://localhost:7777",
      maxConcurrent: 8,
      tickMs: 30000,
      // Long, so only termination requests are ever made, never escalated.
      killGraceMs: 600_000,
      kill: () => true,
      spawn,
      ...over,
    });
    engines.push(e);
    return e;
  };
  /** How many runs each instance's phase was launched with. */
  const launches = (instanceId: string, phaseId: string) =>
    calls.filter((c) => c.env.ARGUS_INSTANCE_ID === instanceId && c.env.ARGUS_PHASE_ID === phaseId)
      .length;
  return { calls, make, launches };
}
type Harness = ReturnType<typeof harness>;

/** A probe that fails exactly once, at `at`. */
function failAtChild(at: ChildEffectPoint): Partial<EngineDeps> {
  let fired = false;
  return {
    childEffectProbe: (point) => {
      if (point === at && !fired) {
        fired = true;
        throw new Error(`injected failure at ${point}`);
      }
    },
  };
}

const PLAN_SCHEMA = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  },
};

/** The task pipeline (`child`), then the parent (`p1`): plan → tasks → ship. */
async function seed(): Promise<void> {
  const at = new Date(2026, 9, 21, 9, 0);
  const phase = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: id,
    cwd: home,
    gated: false,
    steps: [{ name: "s", prompt: "p" }],
    ...over,
  });
  await createPipeline(
    validatePipelineInput({
      name: "task",
      trigger: null,
      overlapPolicy: "allow",
      phases: [phase("work")],
    }),
    at,
    "child",
  );
  await createPipeline(
    validatePipelineInput({
      name: "loop",
      trigger: null,
      phases: [
        phase("plan", { result: { artifact: "plan", schema: PLAN_SCHEMA } }),
        {
          id: "tasks",
          name: "tasks",
          cwd: home,
          needs: ["plan"],
          spawn: { pipelineId: "child", items: { phase: "plan", path: ["tasks"] }, key: "id" },
        },
        phase("ship", { needs: ["tasks"] }),
      ],
    }),
    at,
    "p1",
  );
}

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 3000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The journal is appended fire-and-forget, so wait for the entry to land. */
async function journalHas(id: string, kind: string): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    if ((await readJournal(id)).some((j) => j.kind === kind)) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

/** Start the parent and complete its Plan with one task per key. Not drained. */
async function startPlanned(h: Harness, e: Engine, keys: string[]): Promise<string> {
  return startWithPlan(h, e, "p1", { tasks: keys.map((id) => ({ id })) });
}

/** Start `pipelineId` and complete its Plan with `result`. Not drained. */
async function startWithPlan(
  h: Harness,
  e: Engine,
  pipelineId: string,
  result: Record<string, unknown>,
): Promise<string> {
  const parent = await e.start(pipelineId, "manual");
  assert.ok(parent, "the parent started");
  const run = h.calls.find((c) => c.env.ARGUS_INSTANCE_ID === parent.id);
  assert.ok(run, "Plan was launched");
  const res = await e.onSignal(parent.id, {
    instanceId: parent.id,
    phaseId: "plan",
    runId: run.runId,
    type: "completed",
    token: testRunToken(run.runId),
    payload: MARKED,
    result,
  });
  assert.equal(res.ok, true, "Plan's completion was taken");
  return parent.id;
}

/** Signal the latest run of a child's `work` phase. */
async function signalChild(
  h: Harness,
  e: Engine,
  childId: string,
  type: "completed" | "failed",
): Promise<void> {
  const run = h.calls.findLast((c) => c.env.ARGUS_INSTANCE_ID === childId);
  assert.ok(run, `a run of ${childId} was launched`);
  const res = await e.onSignal(childId, {
    instanceId: childId,
    phaseId: "work",
    runId: run.runId,
    type,
    token: testRunToken(run.runId),
    payload: type === "completed" ? MARKED : { reason: "the tests broke" },
  });
  assert.equal(res.ok, true, `the ${type} signal for ${childId} was taken`);
}

/** The child's revise decisions that carry out a decision of its parent. */
async function parentRevises(childId: string) {
  return (await readGateDecisions(childId)).filter(
    (d) => d.decision === "revise" && d.mechanism === "parent-decision",
  );
}

async function childrenOf(parentId: string, phaseId = "tasks"): Promise<PhaseChildren> {
  const children = (await readInstance(parentId))?.phases.find((p) => p.id === phaseId)?.children;
  assert.ok(children, "the spawn phase has its task list");
  return children;
}

/** Every file under the instances folder: the one ground truth for "how many
 *  instances exist", unreadable ones included. */
function instanceFiles(): string[] {
  return readdirSync(paths.instancesDir())
    .filter((f) => f.endsWith(".json"))
    .sort();
}

async function childInstanceIds(): Promise<string[]> {
  const out: string[] = [];
  for (const f of instanceFiles()) {
    const inst = await readInstance(f.slice(0, -".json".length));
    if (inst?.pipelineId === "child") out.push(inst.id);
  }
  return out;
}

/** Hand-write the parent's only task back to `planned` (a crash before the
 *  sync that mirrored its child). */
async function rewindToPlanned(parentId: string): Promise<void> {
  const parent = structuredClone((await readInstance(parentId))!);
  const task = parent.phases.find((p) => p.id === "tasks")!.children!.tasks[0];
  Object.assign(task, { state: "planned" });
  delete task.waitingPhaseId;
  await writeInstance(parent);
}

test("FAULT SEAM: a crash after the plan commit creates exactly one child on recovery", async () => {
  await seed();
  const h = harness();
  const e1 = h.make(failAtChild("spawn:planned"));
  const parentId = await startPlanned(h, e1, ["a"]);
  await e1.drain();

  const task = (await childrenOf(parentId)).tasks[0];
  assert.equal(task.state, "planned", "the plan was committed");
  assert.ok(task.instanceId, "with the child's id");
  const id = task.instanceId;
  assert.equal((await probeInstance(id)).kind, "absent", "and the start never happened");

  const e2 = h.make();
  await e2.reconcile();
  await e2.drain();
  assert.deepEqual(await childInstanceIds(), [id], "exactly one child, under the saved id");
  assert.equal(h.launches(id, "work"), 1, "launched once");
  await waitFor(async () => (await childrenOf(parentId)).tasks[0].state === "running", "mirrored");

  await e2.reconcile();
  await e2.drain();
  assert.deepEqual(await childInstanceIds(), [id], "another pass starts nothing");
  assert.equal(h.launches(id, "work"), 1, "and launches nothing");
});

test("MANUAL STATE: a child that cannot be read is never re-initialized, and is found once it can", async () => {
  await seed();
  const h = harness();
  const e1 = h.make();
  const parentId = await startPlanned(h, e1, ["a"]);
  await e1.drain();
  await waitFor(async () => (await childrenOf(parentId)).tasks[0].state === "running", "running");
  const id = (await childrenOf(parentId)).tasks[0].instanceId!;
  const saved: PipelineInstance = (await readInstance(id))!;

  // The child's file is damaged, and the parent was saved before it mirrored
  // the child: on disk, a planned task whose child exists but cannot be read.
  const file = path.join(paths.instancesDir(), `${id}.json`);
  mkdirSync(paths.instancesDir(), { recursive: true });
  writeFileSync(file, "{");
  await rewindToPlanned(parentId);
  const before = instanceFiles();

  const e2 = h.make();
  await e2.reconcile();
  await e2.drain();
  const task = (await childrenOf(parentId)).tasks[0];
  assert.equal(task.state, "planned", "the task still waits for its child");
  assert.match(String(task.deferred?.reason), /cannot be read/, "and says why");
  assert.equal(readFileSync(file, "utf8"), "{", "the damaged file is untouched");
  assert.deepEqual(instanceFiles(), before, "no other child was created");
  assert.equal(h.launches(id, "work"), 1, "nothing was launched again");
  assert.ok(await journalHas(parentId, "child.deferred"), "the deferral is journalled");

  await writeInstance(saved);
  await e2.reconcile();
  await e2.drain();
  await waitFor(
    async () => (await childrenOf(parentId)).tasks[0].state === "running",
    "the child is found again",
  );
  assert.equal((await childrenOf(parentId)).tasks[0].instanceId, id, "under the same id");
  assert.equal(
    (await readJournal(id)).filter((j) => j.kind === "instance.started").length,
    1,
    "the child was never started a second time",
  );
  assert.equal(h.launches(id, "work"), 1, "nor launched");
});

test("MANUAL STATE: a child that ended while Argus was down joins on reconcile", async () => {
  await seed();
  const h = harness();
  const e1 = h.make();
  const parentId = await startPlanned(h, e1, ["a"]);
  await e1.drain();
  await waitFor(async () => (await childrenOf(parentId)).tasks[0].state === "running", "running");
  const id = (await childrenOf(parentId)).tasks[0].instanceId!;

  // The child finished, and Argus stopped before the parent's sync ran.
  const child = structuredClone((await readInstance(id))!);
  const endedAt = new Date().toISOString();
  child.status = "succeeded";
  child.endedAt = endedAt;
  child.phases[0].status = "succeeded";
  child.phases[0].steps[0].status = "succeeded";
  await writeInstance(child);

  const e2 = h.make();
  await e2.reconcile();
  await e2.drain();
  await waitFor(
    async () =>
      (await readInstance(parentId))?.phases.find((p) => p.id === "tasks")?.status === "succeeded",
    "the join",
  );
  assert.deepEqual(
    (await childrenOf(parentId)).tasks.map((t) => t.state),
    ["succeeded"],
    "the task mirrored the child",
  );
  await waitFor(() => h.launches(parentId, "ship") === 1, "ship launched after the join");
});

test("a concurrent sync and reconcile create one child", async () => {
  await seed();
  const h = harness();
  const e = h.make();
  // Right after Plan's completion, while its launch of the spawn phase is
  // still queued: two reconcile passes race it.
  const parentId = await startPlanned(h, e, ["a"]);
  await Promise.all([e.reconcile(), e.reconcile()]);
  await e.drain();
  const ids = await childInstanceIds();
  assert.equal(ids.length, 1, "one child");
  assert.equal((await childrenOf(parentId)).tasks[0].instanceId, ids[0], "the planned one");
  assert.equal(h.launches(ids[0], "work"), 1, "launched once");
});

test("a start held at its effect boundary is not repeated by reconcile passes", async () => {
  await seed();
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  const e = h.make({
    childEffectProbe: async (point) => {
      if (point !== "spawn:starting") return;
      held++;
      await gate;
    },
  });
  const parentId = await startPlanned(h, e, ["a"]);
  await waitFor(() => held === 1, "the start reached its boundary");

  await Promise.all([e.reconcile(), e.reconcile()]);
  assert.equal(held, 1, "neither pass queued a second start");
  assert.deepEqual(await childInstanceIds(), [], "nothing was created meanwhile");

  release();
  await e.drain();
  const ids = await childInstanceIds();
  assert.equal(ids.length, 1, "one child");
  assert.equal((await childrenOf(parentId)).tasks[0].instanceId, ids[0], "the planned one");
  assert.equal(h.launches(ids[0], "work"), 1, "launched once");
});

test("FAULT SEAM: an instance under the minted id that is not the task's child is never adopted", async () => {
  await seed();
  const h = harness();
  const e1 = h.make(failAtChild("spawn:planned"));
  const parentId = await startPlanned(h, e1, ["a"]);
  await e1.drain();
  const id = (await childrenOf(parentId)).tasks[0].instanceId!;

  // Something else took the id meanwhile: an instance of the same pipeline,
  // started by hand, with no parent.
  const e2 = h.make();
  const stranger = await e2.start("child", "manual", { instanceId: id });
  assert.equal(stranger?.id, id, "the id is taken");
  await e2.drain();

  await e2.reconcile();
  await e2.drain();
  const phase = (await readInstance(parentId))!.phases.find((p) => p.id === "tasks")!;
  const task = phase.children!.tasks[0];
  assert.equal(task.state, "failed", "the task fails rather than adopt another's instance");
  assert.match(String(task.reason), /not this task's child/, "and says why");
  assert.equal(task.instanceId, undefined, "it names no child");
  assert.deepEqual(task.previousInstanceIds, [id], "the id is never used for it again");
  assert.equal(phase.pause, "children", "nothing is live, so the phase waits for a person");
  assert.equal((await readInstance(id))?.parent, undefined, "the stranger is untouched");
  assert.ok(await journalHas(parentId, "child.refused"), "the refusal is journalled");
});

/** Plan `a` and fail its child: the spawn phase waits at `children`. */
async function failedAtChildren(h: Harness, e: Engine): Promise<{ parentId: string; id: string }> {
  const parentId = await startPlanned(h, e, ["a"]);
  await e.drain();
  await waitFor(async () => (await childrenOf(parentId)).tasks[0].state === "running", "running");
  const id = (await childrenOf(parentId)).tasks[0].instanceId!;
  await signalChild(h, e, id, "failed");
  await e.drain();
  await waitFor(
    async () =>
      (await readInstance(parentId))?.phases.find((p) => p.id === "tasks")?.pause === "children",
    "the pause",
  );
  return { parentId, id };
}

test("FAULT SEAM: a crash between the parent's abort and its cascade is finished by the sweep", async () => {
  await seed();
  const h = harness();
  const e1 = h.make(failAtChild("spawn:cascade"));
  const parentId = await startPlanned(h, e1, ["a", "b"]);
  await e1.drain();
  await waitFor(async () => (await childrenOf(parentId)).tasks[0].state === "running", "running");
  const id = (await childrenOf(parentId)).tasks[0].instanceId!;

  assert.equal((await e1.abort(parentId)).ok, true, "the parent is aborted");
  await e1.drain();
  assert.equal((await readInstance(parentId))?.status, "aborted", "the parent's abort is saved");
  assert.equal((await readInstance(id))?.status, "running", "and its child is still live");

  const e2 = h.make();
  await e2.reconcile();
  await e2.drain();
  const child = (await readInstance(id))!;
  assert.equal(child.status, "aborted", "the sweep aborts the child its parent left behind");
  assert.equal(child.abortCause, "parent-aborted", "because of its parent");
  const aborts = (await readGateDecisions(id)).filter((d) => d.decision === "abort");
  assert.equal(aborts.length, 1, "once");
  assert.equal(aborts[0].mechanism, "parent-decision", "carrying out the parent's state");
  assert.equal(aborts[0].parentDecisionId, undefined, "not one decision of it");
  assert.ok(await journalHas(parentId, "child.aborted"), "journalled on the parent");

  await e2.reconcile();
  await e2.drain();
  assert.equal(
    (await readGateDecisions(id)).filter((d) => d.decision === "abort").length,
    1,
    "another pass aborts nothing again",
  );
});

test("MANUAL STATE: a revive interrupted after the child's revise is mirrored, never repeated", async () => {
  await seed();
  const h = harness();
  const e1 = h.make();
  const { parentId, id } = await failedAtChildren(h, e1);

  // The child's revise for the parent's decision GD-x landed; the parent,
  // saved with the task still `reviving` for it, never mirrored it.
  const res = await e1.revise(id, "note", { byParent: { decisionId: "GD-x" } });
  assert.equal(res.ok, true, "the child's revise is taken");
  await e1.drain();
  const parent = structuredClone((await readInstance(parentId))!);
  const task = parent.phases.find((p) => p.id === "tasks")!.children!.tasks[0];
  Object.assign(task, { state: "reviving", reviveDecisionId: "GD-x" });
  await writeInstance(parent);

  const e2 = h.make();
  await e2.reconcile();
  await e2.drain();
  await waitFor(
    async () => (await childrenOf(parentId)).tasks[0].state === "running",
    "the task mirrors the revived child",
  );
  assert.equal((await childrenOf(parentId)).tasks[0].reviveDecisionId, undefined, "revive done");
  const revises = await parentRevises(id);
  assert.equal(revises.length, 1, "exactly one revise carries out the parent's decision");
  assert.equal(revises[0].parentDecisionId, "GD-x", "the interrupted one");
  assert.equal(h.launches(id, "work"), 2, "the child ran twice: its attempt and the revised one");
});

test("MANUAL STATE: a revived child that failed again is not revived a second time", async () => {
  await seed();
  const h = harness();
  const e1 = h.make();
  const { parentId, id } = await failedAtChildren(h, e1);

  // The revise for GD-x took effect and the revived child failed again; the
  // parent, saved with the task still `reviving`, never mirrored either.
  assert.equal((await e1.revise(id, "note", { byParent: { decisionId: "GD-x" } })).ok, true);
  await e1.drain();
  await waitFor(() => h.launches(id, "work") === 2, "the revised attempt launched");
  await signalChild(h, e1, id, "failed");
  await e1.drain();
  await waitFor(async () => (await readInstance(id))?.status === "failed", "failed again");
  const parent = structuredClone((await readInstance(parentId))!);
  const phase = parent.phases.find((p) => p.id === "tasks")!;
  Object.assign(phase, { status: "running", payload: null });
  delete phase.pause;
  Object.assign(phase.children!.tasks[0], { state: "reviving", reviveDecisionId: "GD-x" });
  delete phase.children!.tasks[0].reason;
  parent.status = "running";
  await writeInstance(parent);

  const e2 = h.make();
  await e2.reconcile();
  await e2.drain();
  await waitFor(
    async () => (await childrenOf(parentId)).tasks[0].state === "failed",
    "the task takes the new failure",
  );
  assert.equal(
    (await readInstance(parentId))?.phases.find((p) => p.id === "tasks")?.pause,
    "children",
    "and the spawn phase waits for a person again",
  );
  assert.equal((await parentRevises(id)).length, 1, "the child was not revised again");
  assert.equal(h.launches(id, "work"), 2, "nor launched");
});

test("FAULT SEAM: a crash after the parent's revise save, before the child's revise, revives it once", async () => {
  await seed();
  const h = harness();
  const e1 = h.make(failAtChild("spawn:reviving"));
  const { parentId, id } = await failedAtChildren(h, e1);

  const res = await e1.revise(parentId, "again", { phaseId: "tasks" });
  assert.equal(res.ok, true, "the revise of the spawn phase is taken");
  await e1.drain();
  const task = (await childrenOf(parentId)).tasks[0];
  assert.equal(task.state, "reviving", "the task owes its revive");
  assert.equal((await readInstance(id))?.status, "failed", "the child was not revised");
  assert.deepEqual(await parentRevises(id), [], "and nothing was recorded on it");

  const e2 = h.make();
  await e2.reconcile();
  await e2.drain();
  await waitFor(
    async () => (await childrenOf(parentId)).tasks[0].state === "running",
    "the revived child is mirrored",
  );
  const parentRevise = (await readGateDecisions(parentId)).find((d) => d.decision === "revise");
  const revises = await parentRevises(id);
  assert.equal(revises.length, 1, "revived once");
  assert.equal(revises[0].parentDecisionId, parentRevise?.id, "for the parent's revise");
  assert.equal(revises[0].note, "again", "with its note");
  assert.equal(h.launches(id, "work"), 2, "and launched once more");

  await e2.reconcile();
  await e2.drain();
  assert.equal((await parentRevises(id)).length, 1, "another pass revives nothing");
  assert.equal(h.launches(id, "work"), 2, "nor launches");
});

test("MANUAL STATE: a child owed a revive that cannot be read waits; one that is gone fails its task", async () => {
  await seed();
  const h = harness();
  const e1 = h.make(failAtChild("spawn:reviving"));
  const { parentId, id } = await failedAtChildren(h, e1);
  assert.equal((await e1.revise(parentId, "again", { phaseId: "tasks" })).ok, true);
  await e1.drain();
  assert.equal((await childrenOf(parentId)).tasks[0].state, "reviving", "the revive is owed");

  const file = path.join(paths.instancesDir(), `${id}.json`);
  writeFileSync(file, "{");
  const e2 = h.make();
  await e2.reconcile();
  await e2.drain();
  await waitFor(
    async () => !!(await childrenOf(parentId)).tasks[0].deferred,
    "the revive says why it waits",
  );
  const waiting = (await childrenOf(parentId)).tasks[0];
  assert.equal(waiting.state, "reviving", "the task still owes the revive");
  assert.match(String(waiting.deferred?.reason), /cannot be read/, "because of the read");
  assert.equal(readFileSync(file, "utf8"), "{", "the damaged file is untouched");
  assert.equal(h.launches(id, "work"), 1, "nothing was launched");

  rmSync(file);
  await e2.reconcile();
  await e2.drain();
  await waitFor(
    async () => (await childrenOf(parentId)).tasks[0].state === "failed",
    "the task fails without its child",
  );
  const gone = (await childrenOf(parentId)).tasks[0];
  assert.match(String(gone.reason), /is gone/, "and says why");
  assert.equal(gone.instanceId, undefined, "it names no child");
  assert.deepEqual(gone.previousInstanceIds, [id], "so the next revise starts a fresh one");
  assert.equal(
    (await readInstance(parentId))?.phases.find((p) => p.id === "tasks")?.pause,
    "children",
    "and the spawn phase waits for a person",
  );
});

test("FAULT SEAM: a child that refuses its revive says why on the task, and is asked again", async () => {
  await seed();
  const h = harness();
  let refusals = 0;
  const e = h.make({
    // The child's revise record cannot be written once: the revise is refused.
    recordGateDecision: async (d) => {
      if (d.decision === "revise" && d.mechanism === "parent-decision" && refusals++ === 0) {
        throw new Error("disk full");
      }
      await appendGateDecision(d);
    },
  });
  const { parentId, id } = await failedAtChildren(h, e);
  assert.equal((await e.revise(parentId, "again", { phaseId: "tasks" })).ok, true);
  await e.drain();

  await waitFor(
    async () => !!(await childrenOf(parentId)).tasks[0].deferred,
    "the refusal is said on the task",
  );
  const task = (await childrenOf(parentId)).tasks[0];
  assert.equal(task.state, "reviving", "the revive is still owed");
  assert.match(String(task.deferred?.reason), /refused the revise/, "and the task says why");
  assert.ok(await journalHas(parentId, "child.revive-refused"), "journalled on the parent");
  assert.equal((await readInstance(id))?.status, "failed", "the child is unchanged");

  await e.reconcile();
  await e.drain();
  await waitFor(
    async () => (await childrenOf(parentId)).tasks[0].state === "running",
    "asked again, the child is revived",
  );
  assert.equal((await childrenOf(parentId)).tasks[0].deferred, undefined, "the reason is cleared");
  assert.equal((await parentRevises(id)).length, 1, "one revise took effect");
});

/** A second parent (`p2`) with two spawn phases over the task pipeline, fed
 *  by its Plan's `tasks` and `more`: a save of either phase's child syncs
 *  both phases. */
async function seedTwo(): Promise<void> {
  await seed();
  const list = PLAN_SCHEMA.properties.tasks;
  const spawnPhase = (id: string) => ({
    id,
    name: id,
    cwd: home,
    needs: ["plan"],
    spawn: { pipelineId: "child", items: { phase: "plan", path: [id] }, key: "id" },
  });
  await createPipeline(
    validatePipelineInput({
      name: "two",
      trigger: null,
      phases: [
        {
          id: "plan",
          name: "plan",
          cwd: home,
          gated: false,
          steps: [{ name: "s", prompt: "p" }],
          result: {
            artifact: "plan",
            schema: {
              type: "object",
              required: ["tasks", "more"],
              properties: { tasks: list, more: list },
            },
          },
        },
        spawnPhase("tasks"),
        spawnPhase("more"),
      ],
    }),
    new Date(2026, 9, 21, 9, 0),
    "p2",
  );
}

/** Start `p2` with `a` in `tasks` and `b`, `c` in `more`, then fail `a`: `tasks`
 *  waits at `children` while `b` runs. */
async function failedBesideSibling(
  h: Harness,
  e: Engine,
): Promise<{ parentId: string; a: string; b: string }> {
  const parentId = await startWithPlan(h, e, "p2", {
    tasks: [{ id: "a" }],
    more: [{ id: "b" }, { id: "c" }],
  });
  await e.drain();
  for (const phaseId of ["tasks", "more"]) {
    await waitFor(
      async () => (await childrenOf(parentId, phaseId)).tasks[0].state === "running",
      `${phaseId}: its first child running`,
    );
  }
  const a = (await childrenOf(parentId)).tasks[0].instanceId!;
  const b = (await childrenOf(parentId, "more")).tasks[0].instanceId!;
  await signalChild(h, e, a, "failed");
  await e.drain();
  await waitFor(
    async () =>
      (await readInstance(parentId))?.phases.find((p) => p.id === "tasks")?.pause === "children",
    "the pause",
  );
  return { parentId, a, b };
}

/** A gate probe that holds the first decision on `on(id)`'s instance to reach
 *  `at`, until `release()`. */
function holdGate(at: GateEffectPoint) {
  let target = "";
  let held = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  holds.push(() => release());
  const deps: Partial<EngineDeps> = {
    gateEffectProbe: async (point, instanceId) => {
      if (point !== at || instanceId !== target || held++ > 0) return;
      await gate;
    },
  };
  return {
    deps,
    on: (id: string) => (target = id),
    held: () => held > 0,
    release: () => release(),
  };
}

const halts = async (id: string) =>
  (await readJournal(id)).filter((j) => j.kind === "children.halted").length;

test("FAULT SEAM: a child still applying its revive is no news to its parent's sync", async () => {
  await seedTwo();
  const h = harness();
  const hold = holdGate("revise:linked");
  const e = h.make(hold.deps);
  const { parentId, a, b } = await failedBesideSibling(h, e);
  assert.ok(await journalHas(parentId, "children.halted"), "the pause is journalled");
  const halted = await halts(parentId);

  // The revive of `a` is linked on the child and held there: the child still
  // reads `failed`, with its revise pending.
  hold.on(a);
  assert.equal((await e.revise(parentId, "again", { phaseId: "tasks" })).ok, true);
  await waitFor(hold.held, "the child's revise is linked");
  const child = (await readInstance(a))!;
  assert.equal(child.status, "failed", "the child still reads failed");
  assert.equal(child.pendingGateOperation?.decision, "revise", "its revise not yet applied");

  // `b` finishes meanwhile: its save syncs both spawn phases of the parent.
  await signalChild(h, e, b, "completed");
  await waitFor(
    async () => (await childrenOf(parentId, "more")).tasks[0].state === "succeeded",
    "the sibling is mirrored",
  );
  const phase = (await readInstance(parentId))!.phases.find((p) => p.id === "tasks")!;
  assert.equal(phase.children?.tasks[0].state, "reviving", "the task still owes its revive");
  assert.equal(phase.status, "running", "the spawn phase does not pause again");
  const refused = await e.approve(parentId, undefined, { phaseId: "tasks" });
  assert.equal(refused.code, 409, "so no approval can drop the task meanwhile");

  hold.release();
  await e.drain();
  await waitFor(
    async () => (await childrenOf(parentId)).tasks[0].state === "running",
    "the revived child is mirrored",
  );
  assert.equal((await parentRevises(a)).length, 1, "revived once");
  assert.equal(h.launches(a, "work"), 2, "and launched once more");
  assert.equal(await halts(parentId), halted, "no second halt was journalled");
});

test("FAULT SEAM: a revive whose revise broke after its link waits for gate recovery, quietly", async () => {
  await seedTwo();
  const h = harness();
  let target = "";
  let broke = false;
  const e = h.make({
    gateEffectProbe: (point, instanceId) => {
      if (point === "revise:superseded" && instanceId === target && !broke) {
        broke = true;
        throw new Error(`injected failure at ${point}`);
      }
    },
  });
  const { parentId, a, b } = await failedBesideSibling(h, e);

  // The child's revise is linked, then fails before it is applied: the child
  // reads `failed` with its revise pending until gate recovery completes it.
  target = a;
  assert.equal((await e.revise(parentId, "again", { phaseId: "tasks" })).ok, true);
  await e.drain();
  assert.ok(broke, "the child's revise broke");
  assert.equal((await readInstance(a))?.pendingGateOperation?.decision, "revise", "pending");

  // A sync meanwhile asks for the revive again: it is neither repeated nor
  // refused, and the task is not failed by the failure being revived.
  await signalChild(h, e, b, "completed");
  await e.drain();
  await waitFor(
    async () => (await childrenOf(parentId, "more")).tasks[0].state === "succeeded",
    "the sibling is mirrored",
  );
  const waiting = (await childrenOf(parentId)).tasks[0];
  assert.equal(waiting.state, "reviving", "the task still owes its revive");
  assert.equal(waiting.deferred, undefined, "and says nothing was refused");
  assert.equal(
    (await readJournal(parentId)).filter((j) => j.kind === "child.revive-refused").length,
    0,
    "nor journals it",
  );
  assert.equal(h.launches(a, "work"), 1, "nothing was launched yet");

  await e.reconcile();
  await e.drain();
  await waitFor(
    async () => (await childrenOf(parentId)).tasks[0].state === "running",
    "gate recovery completes the revise, and the task follows",
  );
  assert.equal((await parentRevises(a)).length, 1, "revived once");
  assert.equal(h.launches(a, "work"), 2, "and launched once more");
});

test("FAULT SEAM: approving the children pause is refused while a re-run child's revise is applied", async () => {
  await seed();
  const h = harness();
  const hold = holdGate("revise:linked");
  const e = h.make(hold.deps);
  const { parentId, id } = await failedAtChildren(h, e);

  // A person re-runs the child; its revise is linked and held there, so the
  // child still reads `failed`.
  hold.on(id);
  const rerun = e.revise(id, "retry");
  await waitFor(hold.held, "the child's revise is linked");
  assert.equal((await readInstance(id))?.status, "failed", "the child still reads failed");
  const refused = await e.approve(parentId, undefined, { phaseId: "tasks" });
  assert.equal(refused.code, 409, "the approval waits for the re-run child");
  assert.equal(refused.errorCode, "children-running", "and says why in its code");
  assert.equal(
    (await readGateDecisions(parentId)).filter((d) => d.decision === "approve").length,
    0,
    "nothing was recorded",
  );

  hold.release();
  assert.equal((await rerun).ok, true, "the re-run is taken");
  await e.drain();
  await waitFor(
    async () => (await childrenOf(parentId)).tasks[0].state === "running",
    "the task follows its child",
  );
  const phase = (await readInstance(parentId))!.phases.find((p) => p.id === "tasks")!;
  assert.equal(phase.status, "running", "and the spawn phase resumes");
});

test("MANUAL STATE: a decision on a child whose parent is gone is the operator's; an unreadable parent refuses it", async () => {
  await seed();
  const h = harness();
  const e = h.make();
  const { parentId, id } = await failedAtChildren(h, e);
  const file = path.join(paths.instancesDir(), `${parentId}.json`);
  writeFileSync(file, "{");
  const unreadable = await e.revise(id, "retry");
  assert.equal(unreadable.code, 409, "a parent that cannot be read decides nothing");
  assert.equal(unreadable.errorCode, undefined, "and is no reason a client acts on: try again");
  assert.match(String(unreadable.error), /could not be read/, "it says so");
  assert.equal((await readInstance(id))?.status, "failed", "nothing changed");

  rmSync(file);
  const orphan = await e.revise(id, "retry");
  assert.equal(orphan.ok, true, "with its parent's record gone, the child is the operator's alone");
  await e.drain();
  assert.equal((await probeInstance(parentId)).kind, "absent", "no parent came back");
});
