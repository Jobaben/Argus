import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createEngine as createEngineUntracked, type EngineDeps } from "./pipelineEngine.js";
import { createPipeline, deletePipeline, validatePipelineInput } from "./sources/pipelines.js";
import { probeInstance, readInstance, readInstances, writeInstance } from "./sources/instances.js";
import { readJournal } from "./sources/journal.js";
import { readGateDecisions } from "./sources/gateDecisions.js";
import { recordRunSpend, updateBudgetConfig } from "./sources/budget.js";
import { hasWaitingGate, inFlight, isLiveTask, resumable } from "./sources/instanceStatus.js";
import { readTransitionLog } from "./transitionLog/store.js";
import { compareIntegrity } from "./transitionLog/fold.js";
import { Tracker } from "./cli/tailCore.js";
import { tick } from "./scheduler.js";
import { paths } from "./claudeHome.js";
import { fakeKill } from "./testPlatform.js";
import { testRunToken } from "./testSignalToken.js";
import type {
  ApprovalCondition,
  InstanceParentRef,
  PhaseChildren,
  PipelineDefinition,
  PipelineInstance,
  SignalType,
} from "./sources/pipelineTypes.js";

/**
 * Spawn phases through the real engine: one child instance per task, started
 * by the id its parent minted, mirrored into the parent and joined.
 *
 * The pure rules (the item check, the order, the transitions) are proved in
 * `sources/children.test.ts` and `spawnTransitions.test.ts`; these prove the
 * engine around them, starting with the start by id every child goes through.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-spawn-engine-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

// Every engine a test creates is drained before the next test starts: its
// detached work resolves its paths from ARGUS_CLAUDE_HOME when it writes, and
// would otherwise land in the next test's home.
const engines: ReturnType<typeof createEngineUntracked>[] = [];
function createEngine(deps: EngineDeps): ReturnType<typeof createEngineUntracked> {
  const e = createEngineUntracked(deps);
  engines.push(e);
  return e;
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.drain()));
});

let counter = 0;
/** Records each launch (its env names the instance and phase, its prompt
 *  what the agent is asked); the process never exits, so no exit handler
 *  runs and every run keeps its slot. */
function recordingSpawn() {
  const calls: { runId: string; cwd: string; prompt: string; env: Record<string, string> }[] = [];
  const spawn: EngineDeps["spawn"] = (run, _log, env) => {
    calls.push({ runId: run.id, cwd: run.cwd, prompt: run.prompt, env });
    return { pid: 1000 + calls.length, done: new Promise<{ code: number | null }>(() => {}) };
  };
  return { spawn, calls };
}

const baseDeps = (over: Partial<EngineDeps> & Pick<EngineDeps, "spawn">): EngineDeps => ({
  now: () => new Date(2026, 9, 21, 12, 0),
  newId: () => `id-${++counter}`,
  signalUrlBase: "http://localhost:7777",
  newSignalToken: testRunToken,
  maxConcurrent: 32,
  tickMs: 30_000,
  kill: fakeKill().kill,
  ...over,
});

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 3000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The journal is appended fire-and-forget: how many entries of `kind` have
 *  landed once at least one has. */
async function journalCount(id: string, kind: string): Promise<number> {
  let n = 0;
  await waitFor(async () => {
    n = (await readJournal(id)).filter((j) => j.kind === kind).length;
    return n > 0;
  }, `a ${kind} entry for ${id}`);
  // Let a second, racing append land before the count is read.
  await new Promise((r) => setTimeout(r, 30));
  return (await readJournal(id)).filter((j) => j.kind === kind).length;
}

/** The pipeline a spawn phase runs once per task. Seeded before any parent. */
async function seedChild(over: Record<string, unknown> = {}, id = "child"): Promise<void> {
  await createPipeline(
    validatePipelineInput({
      name: "task",
      trigger: null,
      phases: [
        { id: "work", name: "Work", cwd: home, gated: false, steps: [{ name: "s", prompt: "go" }] },
      ],
      ...over,
    }),
    new Date(2026, 9, 21, 9, 0),
    id,
  );
}

const PARENT: InstanceParentRef = {
  instanceId: "parent-1",
  pipelineId: "loop",
  phaseId: "tasks",
  index: 0,
  key: "a",
};

// ── start by id and workspaceBase ───────────────────────────────────────────

test("a start by id is idempotent: concurrent and repeated starts return the one instance", async () => {
  await seedChild();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const firing = {
    instanceId: "child-a",
    parent: PARENT,
    triggerPayload: { task: { key: "a" }, key: "a", parent: PARENT },
  };

  const [one, two] = await Promise.all([
    e.start("child", "spawned", firing),
    e.start("child", "spawned", firing),
  ]);
  assert.equal(one?.id, "child-a", "the first start used the minted id");
  assert.equal(two?.id, "child-a", "the second start found the same instance");
  await e.drain();
  assert.equal(rec.calls.length, 1, "one run was launched, not two");
  assert.equal(rec.calls[0].env.ARGUS_INSTANCE_ID, "child-a", "the run belongs to the child");
  assert.equal(
    await journalCount("child-a", "instance.started"),
    1,
    "the instance was started exactly once",
  );

  // The child is live and the pipeline is `skip`: a start by its id is not an
  // overlap (it *is* that instance), while a plain start still is.
  const again = await e.start("child", "spawned", firing);
  assert.equal(again?.id, "child-a", "a later start by id returns the live instance");
  assert.equal(again?.status, "running", "untouched");
  assert.equal(await e.start("child", "manual"), null, "a plain start is still refused");
  await e.drain();
  assert.equal(rec.calls.length, 1, "nothing was launched again");
  assert.equal(
    await journalCount("child-a", "instance.started"),
    1,
    "and nothing was started again",
  );
});

test("a file under the id that cannot be read is never overwritten", async () => {
  await seedChild();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  mkdirSync(paths.instancesDir(), { recursive: true });
  const file = path.join(paths.instancesDir(), "id-x.json");
  writeFileSync(file, "{");

  await assert.rejects(
    e.start("child", "spawned", { instanceId: "id-x", parent: PARENT }),
    /cannot be read/,
    "the start is refused",
  );
  await e.drain();
  assert.equal(readFileSync(file, "utf8"), "{", "the bytes on disk are untouched");
  assert.equal(rec.calls.length, 0, "no run was launched");

  // An id another pipeline's instance already has is refused the same way,
  // never adopted as this pipeline's child.
  await seedChild({ name: "other" }, "other");
  const other = await e.start("other", "manual", { instanceId: "id-y" });
  assert.equal(other?.id, "id-y", "the other pipeline's instance took the id");
  await assert.rejects(
    e.start("child", "spawned", { instanceId: "id-y", parent: PARENT }),
    /cannot be read: instance id-y belongs to pipeline other/,
    "a child is never started over another pipeline's instance",
  );
  await e.drain();
  assert.equal((await readInstance("id-y"))?.pipelineId, "other", "that instance is untouched");
  assert.equal(rec.calls.length, 1, "only the other pipeline's run was launched");
});

test("a spawned child records its parent, its base and its payload", async () => {
  await seedChild();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const payload = { task: { key: "a", title: "Do A" }, key: "a", base: "base-ref", parent: PARENT };

  const started = await e.start("child", "spawned", {
    instanceId: "child-a",
    parent: PARENT,
    workspaceBase: "base-ref",
    triggerPayload: payload,
  });
  assert.equal(started?.id, "child-a", "started under the minted id");
  await e.drain();

  const saved = await readInstance("child-a");
  assert.ok(saved, "the child was saved");
  assert.equal(saved.trigger, "spawned", "it says what started it");
  assert.deepEqual(saved.parent, PARENT, "it names its parent task");
  assert.equal(saved.workspaceBase, "base-ref", "it keeps the base its trees are cut from");
  assert.deepEqual(saved.triggerPayload, payload, "its prompts read the task");
  assert.equal(saved.chainedFrom, undefined, "it was not chained");

  // A start by id of a pipeline that does not exist says what it always said.
  await assert.rejects(
    e.start("missing", "spawned", { instanceId: "child-b", parent: PARENT }),
    /^Error: pipeline not found$/,
    "the message is unchanged",
  );
  assert.equal(await readInstance("child-b"), null, "and nothing was created");
});

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}

const git = (dir: string, args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], {
    cwd: dir,
    encoding: "utf8",
  });

/** A repository on `main` with a branch `base-ref` one commit ahead of it. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-spawn-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  // Checkouts must give back the bytes committed, whatever the host's git
  // says (a Windows runner's system config sets core.autocrlf=true).
  git(dir, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(dir, "README.md"), "base\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["checkout", "-q", "-b", "base-ref"]);
  writeFileSync(path.join(dir, "ahead.txt"), "ahead\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "ahead"]);
  git(dir, ["checkout", "-q", "main"]);
  return dir;
}

test("a spawned child's worktree is cut from its workspaceBase, not its definition's", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = makeRepo();
  const head = (ref: string) => git(repo, ["rev-parse", ref]).stdout.trim();
  assert.notEqual(head("base-ref"), head("main"), "the two refs differ");
  await seedChild({
    overlapPolicy: "allow",
    workspace: { scope: "instance" },
    phases: [
      { id: "work", name: "Work", cwd: repo, gated: false, steps: [{ name: "s", prompt: "go" }] },
    ],
  });
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));

  const child = await e.start("child", "spawned", {
    instanceId: "child-a",
    parent: PARENT,
    workspaceBase: "base-ref",
  });
  assert.ok(child, "the child started");
  await e.drain();
  const saved = await readInstance("child-a");
  assert.equal(saved?.workspace?.base, "base-ref", "the tree records the child's base");
  assert.equal(saved?.workspace?.baseHead, head("base-ref"), "and was cut at that commit");
  assert.equal(rec.calls[0].cwd, saved?.workspace?.path, "the step runs in that tree");
  assert.ok(
    existsSync(path.join(saved!.workspace!.path, "ahead.txt")),
    "the tree holds the base's own commit",
  );

  // Without a workspaceBase the definition's base (here none: HEAD) applies.
  const plain = await e.start("child", "manual");
  assert.ok(plain, "a plain instance started beside it");
  await e.drain();
  const own = await readInstance(plain.id);
  assert.equal(own?.workspace?.base, "HEAD", "the plain instance uses the definition's base");
  assert.equal(own?.workspace?.baseHead, head("main"), "cut from the repository's HEAD");
});

// ── spawn phases: build, plan, start, mirror, join, pause, budget ──────────

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
const NOW = new Date(2026, 9, 21, 12, 0);

const PLAN_SCHEMA = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
    spec: { type: "string" },
  },
};

/** The task pipeline every parent here spawns (`child`): one phase `work`,
 *  no retry, so a failed step fails the child. Seeded before the parent. */
async function seedTaskPipeline(
  over: {
    gated?: boolean;
    overlapPolicy?: "allow" | "skip";
    approveWhen?: ApprovalCondition;
  } = {},
) {
  await createPipeline(
    validatePipelineInput({
      name: "task",
      trigger: null,
      overlapPolicy: over.overlapPolicy ?? "allow",
      phases: [
        {
          id: "work",
          name: "Work",
          cwd: home,
          gated: over.gated ?? false,
          steps: [{ name: "s", prompt: "do the task" }],
          ...(over.approveWhen ? { approveWhen: over.approveWhen } : {}),
        },
      ],
    }),
    new Date(2026, 9, 21, 9, 0),
    "child",
  );
}

/** The parent (`p1`): `plan` declares the task list, `tasks` spawns one
 *  child per task, `ship` runs after the join. */
async function seedParent(spawnOver: Record<string, unknown> = {}) {
  await createPipeline(
    validatePipelineInput({
      name: "loop",
      trigger: null,
      phases: [
        {
          id: "plan",
          name: "Plan",
          cwd: home,
          gated: false,
          steps: [{ name: "s", prompt: "plan" }],
          result: { artifact: "plan", schema: PLAN_SCHEMA },
        },
        {
          id: "tasks",
          name: "Tasks",
          cwd: home,
          needs: ["plan"],
          produces: "children",
          spawn: {
            pipelineId: "child",
            items: { phase: "plan", path: ["tasks"] },
            key: "id",
            dependsOn: "dependsOn",
            ...spawnOver,
          },
        },
        {
          id: "ship",
          name: "Ship",
          cwd: home,
          gated: false,
          needs: ["tasks"],
          steps: [{ name: "s", prompt: "ship" }],
        },
      ],
    }),
    new Date(2026, 9, 21, 9, 0),
    "p1",
  );
}

type Recorder = ReturnType<typeof recordingSpawn>;

/** The latest recorded run of one instance's phase. */
function runOf(rec: Recorder, instanceId: string, phaseId: string) {
  return rec.calls.findLast(
    (c) => c.env.ARGUS_INSTANCE_ID === instanceId && c.env.ARGUS_PHASE_ID === phaseId,
  );
}

/** How many runs of one instance's phase were launched. */
function runsOf(rec: Recorder, instanceId: string, phaseId: string): number {
  return rec.calls.filter(
    (c) => c.env.ARGUS_INSTANCE_ID === instanceId && c.env.ARGUS_PHASE_ID === phaseId,
  ).length;
}

/** Signal the latest run of a phase, once it has been launched; then drain,
 *  unless `drain` is false (a test holding a child's start at a probe). */
async function signal(
  e: ReturnType<typeof createEngine>,
  rec: Recorder,
  instanceId: string,
  phaseId: string,
  type: SignalType,
  extra: { payload?: unknown; result?: unknown } = {},
  drain = true,
) {
  await waitFor(() => !!runOf(rec, instanceId, phaseId), `a run of ${instanceId}/${phaseId}`);
  const runId = runOf(rec, instanceId, phaseId)!.runId;
  const res = await e.onSignal(instanceId, {
    instanceId,
    phaseId,
    runId,
    type,
    token: testRunToken(runId),
    ...extra,
  });
  assert.equal(res.ok, true, `the ${type} signal for ${instanceId}/${phaseId} was taken`);
  if (drain) await e.drain();
}

/** Start the parent and complete its Plan with `tasks` (and `extra` fields). */
async function startPlanned(
  e: ReturnType<typeof createEngine>,
  rec: Recorder,
  tasks: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
  drain = true,
): Promise<string> {
  const parent = await e.start("p1", "manual");
  assert.ok(parent, "the parent started");
  await signal(
    e,
    rec,
    parent.id,
    "plan",
    "completed",
    { payload: MARKED, result: { tasks, ...extra } },
    drain,
  );
  return parent.id;
}

const completeChild = (e: ReturnType<typeof createEngine>, rec: Recorder, childId: string) =>
  signal(e, rec, childId, "work", "completed", { payload: MARKED });
const failChild = (
  e: ReturnType<typeof createEngine>,
  rec: Recorder,
  childId: string,
  reason: string,
) => signal(e, rec, childId, "work", "failed", { payload: { reason } });

/** The saved parent's spawn phase. */
async function spawnPhaseOf(parentId: string) {
  const saved = await readInstance(parentId);
  const phase = saved?.phases.find((p) => p.id === "tasks");
  assert.ok(phase, "the parent has its spawn phase");
  return phase;
}

/** The saved parent's task list. */
async function childrenOf(parentId: string): Promise<PhaseChildren> {
  const phase = await spawnPhaseOf(parentId);
  assert.ok(phase.children, "the spawn phase has its task list");
  return phase.children;
}

/** Wait until the task list reads `states`, position by position. */
async function waitForTasks(parentId: string, states: string[], label: string) {
  await waitFor(async () => {
    const tasks = (await readInstance(parentId))?.phases.find((p) => p.id === "tasks")?.children
      ?.tasks;
    return JSON.stringify(tasks?.map((t) => t.state)) === JSON.stringify(states);
  }, label);
}

async function liveTaskCount(parentId: string): Promise<number> {
  return (await childrenOf(parentId)).tasks.filter((t) => isLiveTask(t.state)).length;
}

async function consistent(id: string): Promise<string> {
  return compareIntegrity(id, await readInstance(id), await readTransitionLog(id)).status;
}

async function childInstances(): Promise<PipelineInstance[]> {
  return readInstances({ pipelineId: "child" });
}

test("tasks run in dependency order, one at a time, and the spawn phase joins", async () => {
  await seedTaskPipeline();
  await seedParent({ title: "title" });
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const items = [
    { id: "a", title: "First" },
    { id: "b", title: "Second", dependsOn: ["a"] },
    { id: "c", title: "Third" },
  ];
  const parentId = await startPlanned(e, rec, items);

  await waitForTasks(parentId, ["running", "pending", "pending"], "a running");
  assert.equal((await childInstances()).length, 1, "exactly one child after Plan");
  assert.equal(await liveTaskCount(parentId), 1, "one task at a time");
  const childIds = [(await childrenOf(parentId)).tasks[0].instanceId!];

  // `b` waited for `a`; once `a` succeeds it is next in list order, before `c`.
  await completeChild(e, rec, childIds[0]);
  await waitForTasks(parentId, ["succeeded", "running", "pending"], "b running after a");
  assert.equal(await liveTaskCount(parentId), 1, "still one task at a time");
  childIds.push((await childrenOf(parentId)).tasks[1].instanceId!);

  await completeChild(e, rec, childIds[1]);
  await waitForTasks(parentId, ["succeeded", "succeeded", "running"], "c running after b");
  assert.equal(await liveTaskCount(parentId), 1, "and again");
  childIds.push((await childrenOf(parentId)).tasks[2].instanceId!);

  await completeChild(e, rec, childIds[2]);
  await waitFor(async () => (await spawnPhaseOf(parentId)).status === "succeeded", "the join");
  await waitFor(() => !!runOf(rec, parentId, "ship"), "ship launched after the join");

  const parent = (await readInstance(parentId))!;
  const phase = parent.phases.find((p) => p.id === "tasks")!;
  const summary = {
    pipelineId: "child",
    tasks: items.map((item, i) => ({
      key: item.id,
      title: item.title,
      state: "succeeded",
      instanceId: childIds[i],
    })),
    counts: { succeeded: 3 },
    notSucceeded: [],
  };
  assert.deepEqual(phase.payload, summary, "the spawn phase's payload is the children summary");
  assert.deepEqual(parent.artifacts?.children, summary, "published under `produces`");
  assert.equal(new Set(childIds).size, 3, "one child per task");
  assert.equal((await childInstances()).length, 3, "and no other");

  for (const [index, item] of items.entries()) {
    const child = (await readInstance(childIds[index]))!;
    assert.equal(child.trigger, "spawned", `child ${item.id} says it was spawned`);
    assert.deepEqual(
      child.parent,
      { instanceId: parentId, pipelineId: "p1", phaseId: "tasks", index, key: item.id },
      `child ${item.id} names its parent task`,
    );
    assert.deepEqual(
      (child.triggerPayload as { task: unknown }).task,
      item,
      `child ${item.id} gets its task whole`,
    );
    assert.equal(await consistent(child.id), "consistent", `child ${item.id}'s log replays`);
  }
  assert.equal(await consistent(parentId), "consistent", "the parent's log replays");
  assert.equal(await journalCount(parentId, "children.started"), 1, "the list was built once");
  assert.equal(await journalCount(parentId, "child.planned"), 3, "each task planned once");
  assert.equal(await journalCount(parentId, "children.joined"), 1, "and the join journalled");
});

test("a failed child blocks its dependents, stops new spawns, and the phase pauses", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const parentId = await startPlanned(e, rec, [
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
    { id: "c" },
  ]);
  await waitForTasks(parentId, ["running", "pending", "pending"], "a running");
  const childA = (await childrenOf(parentId)).tasks[0].instanceId!;

  await failChild(e, rec, childA, "the tests broke");
  await waitFor(async () => (await spawnPhaseOf(parentId)).pause === "children", "the pause");

  const parent = (await readInstance(parentId))!;
  const phase = parent.phases.find((p) => p.id === "tasks")!;
  assert.deepEqual(
    phase.children?.tasks.map((t) => t.state),
    ["failed", "blocked", "pending"],
    "b waits on the failure; c is not started",
  );
  assert.match(String(phase.children?.tasks[0].reason), /the tests broke/, "a says why");
  assert.equal(phase.status, "awaiting-approval", "the spawn phase waits for a person");
  assert.equal(parent.status, "awaiting-approval", "and so does the parent");
  assert.deepEqual(
    (phase.payload as { notSucceeded: string[] }).notSucceeded,
    ["a", "b", "c"],
    "the summary names every task that did not succeed",
  );
  assert.equal((await childInstances()).length, 1, "no child was started for b or c");
  assert.equal(await journalCount(parentId, "children.halted"), 1, "the halt is journalled");
  assert.equal(await consistent(parentId), "consistent", "the parent's log replays");
});

test("a parent whose children wait at their own gates stays running, and is idle", async () => {
  await seedTaskPipeline({ gated: true });
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const parentId = await startPlanned(e, rec, [{ id: "a" }, { id: "b" }]);
  await waitForTasks(parentId, ["running", "pending"], "a running");
  const childA = (await childrenOf(parentId)).tasks[0].instanceId!;

  await completeChild(e, rec, childA);
  await waitForTasks(parentId, ["awaiting-approval", "pending"], "a waits at its gate");
  const parent = (await readInstance(parentId))!;
  const child = (await readInstance(childA))!;
  assert.equal(child.status, "awaiting-approval", "the child waits at its gate");
  assert.equal(parent.status, "running", "the parent stays running");
  assert.equal(
    (await childrenOf(parentId)).tasks[0].waitingPhaseId,
    "work",
    "the task names the child phase that waits",
  );
  assert.equal(hasWaitingGate(parent), false, "the parent has no gate of its own waiting");
  assert.equal(inFlight(parent), false, "and nothing of it moves without a person");

  const parentDef = parent.definition as PipelineDefinition;
  const childDef = child.definition as PipelineDefinition;
  const tracker = new Tracker(() => NOW);
  tracker.applyOverview([
    { definition: parentDef, latest: parent, cost: null, active: [] },
    { definition: childDef, latest: child, cost: null, active: [] },
  ]);
  assert.equal(tracker.isIdle(), true, "`argus tail --until-idle` returns");

  const approved = await e.approve(childA, undefined, { phaseId: "work" });
  assert.equal(approved.ok, true, "the child's gate opens");
  await e.drain();
  await waitForTasks(parentId, ["succeeded", "running"], "a joined and b started");
});

test("a target that allows one instance at a time defers the start until it is free", async () => {
  await seedTaskPipeline({ overlapPolicy: "skip" });
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const unrelated = await e.start("child", "manual");
  assert.ok(unrelated, "an unrelated instance of the task pipeline is live");
  const parentId = await startPlanned(e, rec, [{ id: "a" }]);

  await waitFor(
    async () => !!(await childrenOf(parentId)).tasks[0].deferred,
    "the start is deferred",
  );
  const task = (await childrenOf(parentId)).tasks[0];
  assert.equal(task.state, "planned", "the task stays planned, its id kept");
  assert.match(String(task.deferred?.reason), /overlapPolicy skip/, "and says why it waits");
  assert.equal(await readInstance(task.instanceId!), null, "no child exists yet");
  assert.equal(await journalCount(parentId, "child.deferred"), 1, "the deferral is journalled");

  await signal(e, rec, unrelated.id, "work", "completed", { payload: MARKED });
  await waitFor(
    async () => (await readInstance(unrelated.id))?.status === "succeeded",
    "the unrelated instance finished",
  );
  await e.reconcile();
  await e.drain();
  await waitForTasks(parentId, ["running"], "the child started once the target was free");
  const started = (await childrenOf(parentId)).tasks[0];
  assert.equal(started.instanceId, task.instanceId, "under the id minted at the plan");
  assert.equal(started.deferred, undefined, "the deferral is cleared");
});

test("new children wait while the spend budget's hard stop is on", async () => {
  await seedTaskPipeline();
  await seedParent();
  await updateBudgetConfig({ dailyUsd: 1, blockScheduled: true }, NOW);
  await recordRunSpend({ endedAt: NOW.toISOString(), queuedAt: "", costUsd: 2 }, () => NOW);
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const parentId = await startPlanned(e, rec, [{ id: "a" }, { id: "b" }]);

  await waitForTasks(parentId, ["pending", "pending"], "the list is built");
  assert.equal(await journalCount(parentId, "children.held"), 1, "the hold is journalled");
  assert.ok(
    (await childrenOf(parentId)).tasks.every((t) => !t.instanceId),
    "no child id is minted while the budget holds",
  );
  await e.reconcile();
  await e.drain();
  assert.equal(await journalCount(parentId, "children.held"), 1, "once per hold, not per tick");
  assert.equal((await childInstances()).length, 0, "and no child started");

  await updateBudgetConfig({ dailyUsd: null }, NOW);
  await e.reconcile();
  await e.drain();
  await waitForTasks(parentId, ["running", "pending"], "the first child starts");
  assert.equal(await journalCount(parentId, "children.released"), 1, "the release is journalled");
});

test("an include that makes the payload too large fails the spawn phase as configuration", async () => {
  await seedTaskPipeline();
  await seedParent({ include: { spec: { phase: "plan", path: ["spec"] } } });
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const parentId = await startPlanned(e, rec, [{ id: "a" }], { spec: "x".repeat(70_000) });

  await waitFor(async () => (await spawnPhaseOf(parentId)).status === "failed", "the failure");
  const phase = await spawnPhaseOf(parentId);
  assert.equal(
    (phase.payload as { failureClass?: string }).failureClass,
    "configuration",
    "a definition problem, never retried",
  );
  assert.match(
    String((phase.payload as { reason?: string }).reason),
    /largest include is "spec"/,
    "the reason names the include",
  );
  assert.equal(phase.children, undefined, "no task list was recorded");
  assert.equal((await childInstances()).length, 0, "no child was started");
  assert.equal((await readInstance(parentId))?.status, "failed", "the parent failed");
});

test("a start whose preflight fails waits, and starts once the preflight passes", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  // The parent's own start passes; the child's is refused until `ready`.
  let ready = false;
  let asked = 0;
  const e = createEngine(
    baseDeps({
      spawn: rec.spawn,
      preflight: async () =>
        asked++ === 0 || ready ? { ok: true, reasons: [] } : { ok: false, reasons: ["no git"] },
    }),
  );
  const parentId = await startPlanned(e, rec, [{ id: "a" }]);

  await waitFor(
    async () => !!(await childrenOf(parentId)).tasks[0].deferred,
    "the start is deferred",
  );
  const task = (await childrenOf(parentId)).tasks[0];
  assert.equal(task.state, "planned", "nothing was created, so the task stays planned");
  assert.match(String(task.deferred?.reason), /no git/, "the preflight's reason is kept");
  assert.equal(await readInstance(task.instanceId!), null, "no child exists");

  ready = true;
  await e.reconcile();
  await e.drain();
  await waitForTasks(parentId, ["running"], "the child starts once the preflight passes");
  assert.equal((await childrenOf(parentId)).tasks[0].instanceId, task.instanceId, "same id");
});

// ── gate integration: revive, the pause actions, the parent check, abort ────

/** Case 2's state: `a` failed, `b` (which needs `a`) blocked, `c` never
 *  started, and the spawn phase paused at `children`. */
async function pausedAtChildren(
  e: ReturnType<typeof createEngine>,
  rec: Recorder,
): Promise<{ parentId: string; childA: string }> {
  const parentId = await startPlanned(e, rec, [
    { id: "a" },
    { id: "b", dependsOn: ["a"] },
    { id: "c" },
  ]);
  await waitForTasks(parentId, ["running", "pending", "pending"], "a running");
  const childA = (await childrenOf(parentId)).tasks[0].instanceId!;
  await failChild(e, rec, childA, "the tests broke");
  await waitFor(async () => (await spawnPhaseOf(parentId)).pause === "children", "the pause");
  await waitForTasks(parentId, ["failed", "blocked", "pending"], "a failed, b blocked");
  return { parentId, childA };
}

/** Rewrite a failed child as a person's re-run left it, waiting at its gate,
 *  without the parent having mirrored it. */
async function rewriteAtGate(childId: string): Promise<void> {
  const child = structuredClone((await readInstance(childId))!);
  child.status = "awaiting-approval";
  child.endedAt = null;
  Object.assign(child.phases[0], { status: "awaiting-approval", pause: "gate", payload: null });
  await writeInstance(child);
}

/** Bounded by `waitFor`, so a deadlock fails the test on the timebox rather
 *  than hanging the suite. */
async function drained(e: ReturnType<typeof createEngine>, label: string): Promise<void> {
  let done = false;
  void e.drain().then(() => (done = true));
  await waitFor(() => done, label, 10_000);
}

test("revising a failed child re-runs it, resumes the spawn phase, and the rest follow in order", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const { parentId, childA } = await pausedAtChildren(e, rec);

  const res = await e.revise(childA, "fix it");
  assert.equal(res.ok, true, "the person's revise of the child is taken");
  await e.drain();
  await waitForTasks(parentId, ["running", "pending", "pending"], "a running again, b unblocked");
  const phase = await spawnPhaseOf(parentId);
  assert.equal(phase.status, "running", "the spawn phase runs again");
  assert.equal(phase.pause, undefined, "its pause is gone");
  assert.equal((await readInstance(parentId))?.status, "running", "and so does the parent");
  assert.equal(phase.children?.tasks[0].instanceId, childA, "the task keeps its child");
  const [decision] = (await readGateDecisions(childA)).filter((d) => d.decision === "revise");
  assert.equal(decision.mechanism, "unspecified", "the revise is the caller's, not the parent's");
  assert.equal(decision.parentDecisionId, undefined, "it carries out no parent decision");

  await waitFor(() => runsOf(rec, childA, "work") === 2, "the child's new attempt launched");
  await completeChild(e, rec, childA);
  await waitForTasks(parentId, ["succeeded", "running", "pending"], "b runs after a");
  const childB = (await childrenOf(parentId)).tasks[1].instanceId!;
  await completeChild(e, rec, childB);
  await waitForTasks(parentId, ["succeeded", "succeeded", "running"], "c runs after b");
  const childC = (await childrenOf(parentId)).tasks[2].instanceId!;
  await completeChild(e, rec, childC);
  await waitFor(async () => (await spawnPhaseOf(parentId)).status === "succeeded", "the join");
  await waitFor(() => !!runOf(rec, parentId, "ship"), "ship launched after the join");
  assert.equal((await childInstances()).length, 3, "one child per task, a's re-run included");
  assert.equal(await consistent(parentId), "consistent", "the parent's log replays");
});

test("revising the spawn phase revives a failed child in place, under the parent's decision", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const parentId = await startPlanned(e, rec, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  await waitForTasks(parentId, ["running", "pending", "pending"], "a running");
  const childA = (await childrenOf(parentId)).tasks[0].instanceId!;
  await failChild(e, rec, childA, "flaky");
  await waitFor(async () => (await spawnPhaseOf(parentId)).pause === "children", "the pause");
  await waitForTasks(parentId, ["failed", "pending", "pending"], "nothing new spawned");

  const res = await e.revise(parentId, "again", { phaseId: "tasks" });
  assert.equal(res.ok, true, "the revise of the spawn phase is taken");
  await e.drain();
  await waitForTasks(parentId, ["running", "pending", "pending"], "a revived");
  const task = (await childrenOf(parentId)).tasks[0];
  assert.equal(task.instanceId, childA, "in place: the same child");
  assert.equal(task.previousInstanceIds, undefined, "no child was replaced");
  assert.equal((await spawnPhaseOf(parentId)).attempt, 1, "the spawn phase is on its next attempt");

  const parentRevise = (await readGateDecisions(parentId)).find((d) => d.decision === "revise");
  assert.ok(parentRevise, "the parent's revise is recorded");
  const revises = (await readGateDecisions(childA)).filter((d) => d.decision === "revise");
  assert.equal(revises.length, 1, "the child was revised once");
  assert.equal(revises[0].mechanism, "parent-decision", "carrying out its parent's decision");
  assert.deepEqual(
    revises[0].principal,
    { kind: "system", component: "spawn" },
    "by the spawn phase",
  );
  assert.equal(revises[0].channel, "in-process", "in process");
  assert.equal(revises[0].parentDecisionId, parentRevise.id, "naming the parent's revise");
  assert.equal(revises[0].note, "again", "with the parent's note");
  assert.ok(
    (await readInstance(childA))?.gateDecisionIds?.includes(revises[0].id),
    "linked to the child",
  );
  await waitFor(() => runsOf(rec, childA, "work") === 2, "the revived child's new attempt");
  const prompt = runOf(rec, childA, "work")!.prompt;
  assert.ok(prompt.includes("- After attempt 0: again"), `the note reaches the agent: ${prompt}`);
  assert.equal(await journalCount(parentId, "child.revived"), 1, "the revive is journalled");

  await completeChild(e, rec, childA);
  await waitForTasks(parentId, ["succeeded", "running", "pending"], "b after a");
  await completeChild(e, rec, (await childrenOf(parentId)).tasks[1].instanceId!);
  await waitForTasks(parentId, ["succeeded", "succeeded", "running"], "c after b");
  await completeChild(e, rec, (await childrenOf(parentId)).tasks[2].instanceId!);
  await waitFor(async () => (await spawnPhaseOf(parentId)).status === "succeeded", "the join");
  await waitFor(() => !!runOf(rec, parentId, "ship"), "ship launched after the join");
  assert.equal(
    (await readGateDecisions(childA)).filter((d) => d.decision === "revise").length,
    1,
    "and was never revised again",
  );
  assert.equal(await consistent(parentId), "consistent", "the parent's log replays");
  assert.equal(await consistent(childA), "consistent", "and the child's");
});

test("revising the spawn phase gives an aborted child's task a fresh child", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const parentId = await startPlanned(e, rec, [{ id: "a" }, { id: "b" }]);
  await waitForTasks(parentId, ["running", "pending"], "a running");
  const childA = (await childrenOf(parentId)).tasks[0].instanceId!;

  // A person stops the child itself: allowed whatever its parent waits for.
  const stopped = await e.abort(childA);
  assert.equal(stopped.ok, true, "the abort of a child is never refused by the parent check");
  await e.drain();
  await waitFor(async () => (await spawnPhaseOf(parentId)).pause === "children", "the pause");
  await waitForTasks(parentId, ["aborted", "pending"], "a aborted, b never started");

  const res = await e.revise(parentId, "again", { phaseId: "tasks" });
  assert.equal(res.ok, true, "the revise of the spawn phase is taken");
  await e.drain();
  await waitFor(async () => {
    const t = (await childrenOf(parentId)).tasks[0];
    return t.state === "running" && t.instanceId !== childA;
  }, "a fresh child for a");
  const task = (await childrenOf(parentId)).tasks[0];
  assert.deepEqual(task.previousInstanceIds, [childA], "the aborted child is kept as history");
  assert.equal((await childInstances()).length, 2, "one fresh child, nothing else");

  await e.reconcile();
  await e.drain();
  const old = (await readInstance(childA))!;
  assert.equal(old.status, "aborted", "the aborted child stays aborted");
  assert.deepEqual(
    (await readGateDecisions(childA)).map((d) => d.decision),
    ["abort"],
    "and is never touched again: only the person's abort is on record",
  );
});

test("approving the children pause accepts what succeeded; later decisions on a child are refused", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const { parentId, childA } = await pausedAtChildren(e, rec);

  const withAnswers = await e.approve(parentId, { x: 1 }, { phaseId: "tasks" });
  assert.equal(withAnswers.code, 400, "a children pause takes no answers");
  assert.equal(withAnswers.errorCode, "answers-not-accepted", "and says so in its code");
  assert.deepEqual(await readGateDecisions(parentId), [], "nothing was recorded");
  assert.equal((await spawnPhaseOf(parentId)).pause, "children", "nothing changed");
  // Dropping tasks is a person's call: no automated approval opens this pause.
  const automated = await e.approveAutomatically({
    instanceId: parentId,
    phaseId: "tasks",
    attempt: 0,
    runIds: [],
    verdicts: [],
  });
  assert.equal(automated.code, 409, "an automated approval is refused");
  assert.match(String(automated.error), /waiting on its children/, "and says why");

  const accepted = await e.approve(parentId, undefined, { phaseId: "tasks" });
  assert.equal(accepted.ok, true, "approving accepts the rest");
  await e.drain();
  assert.equal((await spawnPhaseOf(parentId)).status, "succeeded", "the spawn phase succeeded");
  await waitFor(() => !!runOf(rec, parentId, "ship"), "ship launched");
  const summary = (await readInstance(parentId))?.artifacts?.children as {
    notSucceeded: string[];
  };
  assert.deepEqual(summary.notSucceeded, ["a", "b", "c"], "the summary names the dropped tasks");

  const late = await e.revise(childA, "late");
  assert.equal(late.code, 409, "a child its parent no longer waits for is not re-run");
  assert.equal(late.errorCode, "parent-decided", "and the refusal says why in its code");
  assert.match(String(late.error), /spawn phase "tasks" is succeeded/, "and in words");
  assert.deepEqual(
    (await readGateDecisions(childA)).filter((d) => d.decision === "revise"),
    [],
    "nothing was recorded on the child",
  );

  // A re-run that slipped in anyway waits at its gate: approving it is
  // refused the same way; aborting it never is.
  await rewriteAtGate(childA);
  const approveLate = await e.approve(childA, undefined, { phaseId: "work" });
  assert.equal(approveLate.errorCode, "parent-decided", "nor approved");
  const automatedLate = await e.approveAutomatically({
    instanceId: childA,
    phaseId: "work",
    attempt: 0,
    runIds: [],
    verdicts: [],
  });
  assert.equal(automatedLate.errorCode, "parent-decided", "nor approved by a rule");
  assert.deepEqual(
    (await readGateDecisions(childA)).filter((d) => d.decision === "approve"),
    [],
    "and no approval was recorded",
  );
  const abortLate = await e.abort(childA);
  assert.equal(abortLate.ok, true, "abort is exempt from the parent check");
  await e.drain();
  assert.equal((await readInstance(childA))?.status, "aborted", "the child stopped");
});

test("approving the children pause is refused while a re-run child is live, and the sweep stops a late one", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const { parentId, childA } = await pausedAtChildren(e, rec);

  // A person's revise of `a` landed, and the parent has not mirrored it yet.
  const failed = structuredClone((await readInstance(childA))!);
  await writeInstance({ ...failed, status: "running", endedAt: null });
  const refused = await e.approve(parentId, undefined, { phaseId: "tasks" });
  assert.equal(refused.code, 409, "the approval waits for the re-run child");
  assert.equal(refused.errorCode, "children-running", "and says why in its code");
  assert.match(String(refused.error), /task "a" is running again/, "and in words");
  assert.deepEqual(await readGateDecisions(parentId), [], "nothing was recorded");

  // The narrow window that read cannot close: the re-run is saved just after
  // the approval. The sweep stops the child its parent no longer waits for.
  await writeInstance(failed);
  const accepted = await e.approve(parentId, undefined, { phaseId: "tasks" });
  assert.equal(accepted.ok, true, "with the child failed again, the approval is taken");
  await e.drain();
  await rewriteAtGate(childA);
  await e.reconcile();
  await e.drain();
  const swept = (await readInstance(childA))!;
  assert.equal(swept.status, "aborted", "the stray child is aborted");
  assert.equal(swept.abortCause, "parent-aborted", "because of its parent");
  const [abort] = (await readGateDecisions(childA)).filter((d) => d.decision === "abort");
  assert.equal(abort.mechanism, "parent-decision", "carrying out the parent's state");
  assert.equal(abort.parentDecisionId, undefined, "not one decision of it");
  assert.deepEqual(abort.principal, { kind: "system", component: "spawn" }, "by the spawn phase");
  assert.equal(await journalCount(parentId, "child.aborted"), 1, "journalled on the parent");
});

// ── approval conditions (DL-A3) beside spawn phases ─────────────────────────

/** An `approveWhen` command: appends one "x" per poll to `polled`, then exits
 *  with the code written in `code`. Portable to `cmd.exe` (HARNESS §17); the
 *  engines get no `parentEnv`, so `node` is on the poll's `PATH`. */
function condition(polled: string, code: string): ApprovalCondition {
  return {
    kind: "command",
    label: "merged",
    run:
      `node -e "var fs=require('fs'); fs.appendFileSync(process.argv[1], 'x'); ` +
      `process.exit(Number(fs.readFileSync(process.argv[2], 'utf8')))" "${polled}" "${code}"`,
    everySeconds: 30,
    failOnExit: 3,
  };
}
const pollsRun = (polled: string) => (existsSync(polled) ? readFileSync(polled, "utf8").length : 0);
const conditionEntries = async (id: string) =>
  (await readJournal(id)).filter((j) => j.kind === "phase.approval-condition");

test("a passing poll never opens the gate of a child its parent no longer waits for, and is journalled once", async () => {
  const polled = path.join(home, "polls.txt");
  const code = path.join(home, "exit.txt");
  writeFileSync(code, "0");
  await seedTaskPipeline({ gated: true, approveWhen: condition(polled, code) });
  await seedParent();
  const rec = recordingSpawn();
  let clock = NOW.getTime();
  const e = createEngine(baseDeps({ spawn: rec.spawn, now: () => new Date(clock) }));
  const { parentId, childA } = await pausedAtChildren(e, rec);
  const accepted = await e.approve(parentId, undefined, { phaseId: "tasks" });
  assert.equal(accepted.ok, true, "the parent accepted the rest");
  await e.drain();
  // A person's re-run of `a` that slipped in anyway waits at its gate, which
  // its own approveWhen polls: the poll does not know about the parent, the
  // gate decision does.
  await rewriteAtGate(childA);

  await e.pollGates();
  await e.drain();
  assert.equal(pollsRun(polled), 1, "the condition was polled, and exited 0");
  assert.equal(
    (await readInstance(childA))?.phases[0].status,
    "awaiting-approval",
    "the gate did not open",
  );
  assert.deepEqual(
    (await readGateDecisions(childA)).filter((d) => d.decision === "approve"),
    [],
    "no approval was recorded",
  );
  const refusal =
    `${childA} is a spawned child and its parent's spawn phase "tasks" is succeeded; ` +
    "abort it, or start a follow-up instead";
  let entries = await conditionEntries(childA);
  assert.deepEqual(
    entries.map((j) => j.detail),
    [`merged: exit 0, not applied: ${refusal}`],
    "the parent check's refusal is journalled",
  );

  clock += 30_000;
  await e.pollGates();
  await e.drain();
  assert.equal(pollsRun(polled), 2, "polled again: reconcile's sweep, not the poll, stops it");
  assert.equal((await conditionEntries(childA)).length, 1, "the same refusal is journalled once");

  // Its failOnExit is refused on the same terms: the child is not failed either.
  writeFileSync(code, "3");
  clock += 30_000;
  await e.pollGates();
  await e.drain();
  assert.equal(pollsRun(polled), 3, "polled a third time, and exited 3");
  assert.equal(
    (await readInstance(childA))?.phases[0].status,
    "awaiting-approval",
    "the phase did not fail",
  );
  entries = await conditionEntries(childA);
  assert.deepEqual(
    entries.map((j) => j.detail),
    [`merged: exit 0, not applied: ${refusal}`, `merged: exit 3, not applied: ${refusal}`],
    "a new result is journalled",
  );
});

test("a spawn phase at its children pause is never polled, and no rule opens it", async () => {
  const polled = path.join(home, "polls.txt");
  const code = path.join(home, "exit.txt");
  writeFileSync(code, "0");
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const { parentId } = await pausedAtChildren(e, rec);
  // Validation refuses approveWhen on a spawn phase (spawnValidation.test.ts):
  // only a hand-edited snapshot carries one, and even that is never polled.
  const parent = structuredClone((await readInstance(parentId))!);
  const tasksDef = (parent.definition as PipelineDefinition).phases.find((p) => p.id === "tasks");
  assert.ok(tasksDef, "the snapshot has the spawn phase");
  tasksDef.approveWhen = condition(polled, code);
  await writeInstance(parent);

  await e.pollGates();
  await e.drain();
  assert.equal(pollsRun(polled), 0, "the condition never ran");
  assert.deepEqual(await conditionEntries(parentId), [], "and nothing was journalled");

  const automated = await e.approveAutomatically({
    instanceId: parentId,
    phaseId: "tasks",
    attempt: 0,
    runIds: [],
    verdicts: [],
  });
  assert.equal(automated.code, 409, "an automated approval is refused");
  assert.equal(
    automated.error,
    "phase tasks is waiting on its children: approving it drops the tasks that did not " +
      "succeed, which needs a person",
    "naming the children pause",
  );
  assert.deepEqual(await readGateDecisions(parentId), [], "nothing was recorded");
  const phase = await spawnPhaseOf(parentId);
  assert.equal(phase.status, "awaiting-approval", "the spawn phase still waits");
  assert.equal(phase.pause, "children", "at its children pause");
});

test("aborting the parent aborts its live child under the parent's decision, starts no more, and chains nothing from it", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const parentId = await startPlanned(e, rec, [{ id: "a" }, { id: "b" }, { id: "c" }]);
  await waitForTasks(parentId, ["running", "pending", "pending"], "a running");
  const childA = (await childrenOf(parentId)).tasks[0].instanceId!;

  const res = await e.abort(parentId);
  assert.equal(res.ok, true, "the parent is aborted");
  await e.drain();
  await waitFor(async () => (await readInstance(childA))?.status === "aborted", "the cascade");

  const child = (await readInstance(childA))!;
  assert.equal(child.abortCause, "parent-aborted", "the child says why it stopped");
  const parentAbort = (await readGateDecisions(parentId)).find((d) => d.decision === "abort");
  assert.ok(parentAbort, "the parent's abort is recorded");
  const aborts = (await readGateDecisions(childA)).filter((d) => d.decision === "abort");
  assert.equal(aborts.length, 1, "the child was aborted once");
  assert.equal(aborts[0].mechanism, "parent-decision", "carrying out its parent's decision");
  assert.equal(aborts[0].parentDecisionId, parentAbort.id, "naming it");
  assert.deepEqual(
    aborts[0].principal,
    { kind: "system", component: "spawn" },
    "by the spawn phase",
  );

  const tasks = (await childrenOf(parentId)).tasks;
  assert.deepEqual(
    tasks.map((t) => t.state),
    ["aborted", "pending", "pending"],
    "the live task stopped with its parent; the rest never started",
  );
  assert.equal(tasks[0].reason, "aborted with its parent", "and says so");
  assert.equal(await journalCount(parentId, "child.aborted"), 1, "the cascade is journalled");

  await e.reconcile();
  await e.drain();
  assert.equal((await childInstances()).length, 1, "no further child was created");
  assert.equal(
    (await readGateDecisions(childA)).filter((d) => d.decision === "abort").length,
    1,
    "and the child was not aborted again",
  );
  assert.equal(await consistent(parentId), "consistent", "the parent's log replays");

  // An `after` chain on the task pipeline fires for nothing its parent's abort
  // stopped; one on the parent's pipeline still follows an operator's abort.
  const chainOn = (pipelineId: string, id: string) =>
    createPipeline(
      validatePipelineInput({
        name: `after ${pipelineId}`,
        trigger: { kind: "after", pipelineId, on: "any" },
        phases: [
          {
            id: "next",
            name: "Next",
            cwd: home,
            gated: false,
            steps: [{ name: "s", prompt: "go" }],
          },
        ],
      }),
      new Date(2026, 9, 21, 9, 0),
      id,
    );
  await chainOn("child", "after-child");
  await chainOn("p1", "after-loop");
  const chained: { target: string; from: string }[] = [];
  await tick({
    now: () => new Date(2026, 9, 21, 12, 5),
    tickMs: 30_000,
    newId: () => `id-${++counter}`,
    spawn: () => {
      throw new Error("no schedule fires here");
    },
    startPipeline: async (target, _trigger, firing) => {
      chained.push({ target, from: firing.chainedFrom });
      return null;
    },
  });
  assert.deepEqual(
    chained,
    [{ target: "after-loop", from: parentId }],
    "the parent's abort chains; the child it stopped does not",
  );
});

test("deleting the child pipeline mid-run aborts its child, and the parent waits for a person", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  const e = createEngine(baseDeps({ spawn: rec.spawn }));
  const parentId = await startPlanned(e, rec, [{ id: "a" }, { id: "b" }]);
  await waitForTasks(parentId, ["running", "pending"], "a running");
  const childA = (await childrenOf(parentId)).tasks[0].instanceId!;

  // What `DELETE /api/pipelines/child` does: under the pipeline's starts, abort
  // every live instance of it, then delete the definition.
  await e.withStartsHeld("child", async () => {
    for (const i of await childInstances()) {
      if (!resumable(i.status)) continue;
      const res = await e.abort(i.id, { cause: "pipeline-deleted" });
      assert.equal(res.ok, true, `child ${i.id} was aborted`);
    }
    assert.equal(await deletePipeline("child"), true, "the definition was deleted");
  });
  await drained(e, "the engine drains after the delete");

  await waitFor(async () => (await spawnPhaseOf(parentId)).pause === "children", "the pause");
  assert.equal((await readInstance(childA))?.abortCause, "pipeline-deleted", "the child stopped");
  const tasks = (await childrenOf(parentId)).tasks;
  assert.deepEqual(
    tasks.map((t) => t.state),
    ["aborted", "pending"],
    "b was never started",
  );
  assert.equal(tasks[0].reason, "aborted (pipeline-deleted)", "a says why");
  assert.equal((await childInstances()).length, 1, "no other child was created");
});

test("a start that finds its pipeline deleted fails the task for good, never waits forever", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  const e = createEngine(
    baseDeps({
      spawn: rec.spawn,
      childEffectProbe: async (point) => {
        if (point !== "spawn:starting") return;
        held++;
        await gate;
      },
    }),
  );
  const parentId = await startPlanned(e, rec, [{ id: "a" }, { id: "b" }], {}, false);
  await waitFor(() => held === 1, "the first child's start reached its boundary");
  const planned = (await childrenOf(parentId)).tasks[0].instanceId!;

  await e.withStartsHeld("child", async () => {
    assert.equal(await deletePipeline("child"), true, "the definition was deleted");
  });
  release();
  await drained(e, "the engine drains after the refused start");

  await waitFor(async () => (await spawnPhaseOf(parentId)).pause === "children", "the pause");
  const task = (await childrenOf(parentId)).tasks[0];
  assert.equal(task.state, "failed", "the task failed");
  assert.match(String(task.reason), /pipeline child does not exist/, "and says why");
  assert.equal(task.deferred, undefined, "it does not wait for a pipeline that is gone");
  assert.deepEqual(task.previousInstanceIds, [planned], "its id is never used again");
  assert.equal((await probeInstance(planned)).kind, "absent", "and no child was created");
  assert.equal(await journalCount(parentId, "child.refused"), 1, "the refusal is journalled");
});

test("a start held before its start lock while the parent is aborted creates no child", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  const e = createEngine(
    baseDeps({
      spawn: rec.spawn,
      childEffectProbe: async (point) => {
        if (point !== "spawn:starting") return;
        held++;
        await gate;
      },
    }),
  );
  const parentId = await startPlanned(e, rec, [{ id: "a" }], {}, false);
  await waitFor(() => held === 1, "the child's start reached its boundary");
  const planned = (await childrenOf(parentId)).tasks[0].instanceId!;

  assert.equal((await e.abort(parentId)).ok, true, "the parent is aborted meanwhile");
  release();
  await drained(e, "the start and the cascade both finish: no lock waits on another");
  await e.reconcile();
  await drained(e, "and the sweep");

  assert.equal(
    (await probeInstance(planned)).kind,
    "absent",
    "the start asked, and was not wanted",
  );
  assert.deepEqual(await childInstances(), [], "no child exists at all");
  assert.equal((await readInstance(parentId))?.status, "aborted", "the parent stays aborted");
});

test("a start already inside its start lock when the parent is aborted is aborted by the cascade", async () => {
  await seedTaskPipeline();
  await seedParent();
  const rec = recordingSpawn();
  // The preflight runs inside `startInstance`'s start lock, after the parent
  // check: held there, the child's start has decided to go ahead.
  let holdPreflight = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  const e = createEngine(
    baseDeps({
      spawn: rec.spawn,
      preflight: async () => {
        if (holdPreflight) {
          held++;
          await gate;
        }
        return { ok: true, reasons: [] };
      },
    }),
  );
  const parent = await e.start("p1", "manual");
  assert.ok(parent, "the parent started");
  holdPreflight = true;
  await signal(
    e,
    rec,
    parent.id,
    "plan",
    "completed",
    { payload: MARKED, result: { tasks: [{ id: "a" }] } },
    false,
  );
  await waitFor(() => held === 1, "the child's start holds its start lock");
  const planned = (await childrenOf(parent.id)).tasks[0].instanceId!;

  assert.equal((await e.abort(parent.id)).ok, true, "the parent is aborted meanwhile");
  release();
  await drained(e, "the start, then the cascade waiting on its lock, finish");
  await waitFor(async () => (await readInstance(planned))?.status === "aborted", "the cascade");

  const child = (await readInstance(planned))!;
  assert.equal(child.abortCause, "parent-aborted", "the child the start created was aborted");
  const parentAbort = (await readGateDecisions(parent.id)).find((d) => d.decision === "abort");
  const [abort] = (await readGateDecisions(planned)).filter((d) => d.decision === "abort");
  assert.equal(abort.parentDecisionId, parentAbort?.id, "by the cascade of the parent's abort");
  assert.deepEqual(
    (await childInstances()).filter((i) => resumable(i.status)),
    [],
    "no child of the aborted parent is live",
  );
});
