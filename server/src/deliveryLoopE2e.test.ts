/**
 * The delivery loop in miniature (DL-V, offline): the four DL-A features
 * working together the way the plan's target design uses them. A parent plans
 * tasks with a dependency between them and spawns one child per task
 * (DL-A2a). Each child's `build` phase is judged by a task-scope check that
 * reads its task through the trigger payload file (DL-A4), and its `pr` gate
 * opens when a polled command sees the pull request merged (DL-A3). After the
 * join, `learn` reads every child through the children manifest (DL-A2b).
 *
 * The agents are fakes: the spawn double writes what an agent would write and
 * reads what it is handed, and a marker file stands in for the provider saying
 * a pull request merged or was abandoned. No provider, no network. The checks
 * and polls are real commands (`node -e`, through the platform shell), written
 * to run under `cmd.exe` too: JavaScript in double quotes with only single
 * quotes inside, no arrow functions, paths as separate quoted arguments read
 * from `process.argv` (HARNESS.md §17). The engines get no `parentEnv`, so
 * `node` is on their `PATH`.
 *
 * Each feature's edges are proved in its own file (`spawnEngine.test.ts`,
 * `engine/gatePolls.test.ts`, `childrenContextEngine.test.ts`,
 * `engine/checkInputs.test.ts`); these prove that they compose.
 */
import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEngine as createEngineUntracked, type Engine } from "./pipelineEngine.js";
import { createPipeline, validatePipelineInput } from "./sources/pipelines.js";
import { readInstance, readInstances } from "./sources/instances.js";
import { readGateDecisions } from "./sources/gateDecisions.js";
import { readJournal } from "./sources/journal.js";
import { readTransitionLog } from "./transitionLog/store.js";
import { compareIntegrity } from "./transitionLog/fold.js";
import { fakeKill } from "./testPlatform.js";
import { testRunToken } from "./testSignalToken.js";
import type { OperatorSource, PipelineSpawnFn } from "./engine/types.js";
import type {
  ChildrenManifest,
  PhaseFailurePayload,
  PipelineInstance,
  SpawnTriggerPayload,
} from "./sources/pipelineTypes.js";

let home: string;
/** Where the stand-in provider records a pull request merged or abandoned. */
let provider: string;
/** Where each scope check writes down what it read. */
let scopeSeen: string;
let clock: number;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-delivery-loop-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  provider = path.join(home, "provider");
  scopeSeen = path.join(home, "scope");
  mkdirSync(provider);
  mkdirSync(scopeSeen);
  clock = Date.parse("2026-10-22T12:00:00.000Z");
});

// Every engine a test builds stops polling and is drained before the next
// test repoints the home: a poll or a child start still in flight would
// otherwise land there.
const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) e.stopPolls();
  await Promise.all(engines.splice(0).map((e) => e.drain()));
});

const MARKED = { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" };
/** A person, so the decisions they make read `operator`. */
const OPERATOR: OperatorSource = {
  channel: "http",
  principal: { kind: "session", username: "pod-person", role: "admin" },
};

// ── The agents ──────────────────────────────────────────────────────────────

interface Launch {
  runId: string;
  instanceId: string;
  phaseId: string;
}

/** The spawn payload as the child's `build` prompt renders it, on its `TASK` line. */
function payloadIn(prompt: string): SpawnTriggerPayload {
  const line = prompt.split("\n").find((l) => l.startsWith("TASK "));
  assert.ok(line, `the prompt carries the task: ${prompt}`);
  return JSON.parse(line.slice("TASK ".length)) as SpawnTriggerPayload;
}

/**
 * The fake agents. Every launch is recorded and never exits; its pid is this
 * process's, so a reconcile pass never takes it for lost. `build` "changes"
 * the files its task plans (the task read from its prompt, as a real agent
 * reads it) plus any `outOfScope` names for that task, and lists them in
 * `changed.json` in its artifact folder, where the scope check looks. `learn`
 * keeps the children manifest it was handed.
 */
function fakeAgents(outOfScope: Record<string, string[]> = {}) {
  const launches: Launch[] = [];
  const manifests: ChildrenManifest[] = [];
  const spawn: PipelineSpawnFn = (run, _log, env) => {
    launches.push({
      runId: run.id,
      instanceId: env.ARGUS_INSTANCE_ID,
      phaseId: env.ARGUS_PHASE_ID,
    });
    if (env.ARGUS_PHASE_ID === "build") {
      const { key, task } = payloadIn(run.prompt);
      const planned = Array.isArray(task.files) ? (task.files as string[]) : [];
      mkdirSync(env.ARGUS_ARTIFACT_DIR, { recursive: true });
      writeFileSync(
        path.join(env.ARGUS_ARTIFACT_DIR, "changed.json"),
        JSON.stringify([...planned, ...(outOfScope[key] ?? [])]),
      );
    }
    if (env.ARGUS_PHASE_ID === "learn") {
      manifests.push(JSON.parse(readFileSync(env.ARGUS_CHILDREN_FILE, "utf8")) as ChildrenManifest);
    }
    return { pid: process.pid, done: new Promise<{ code: number | null }>(() => {}) };
  };
  const launchesOf = (instanceId: string, phaseId: string) =>
    launches.filter((l) => l.instanceId === instanceId && l.phaseId === phaseId);
  return { spawn, launches, manifests, launchesOf };
}
type Agents = ReturnType<typeof fakeAgents>;

let counter = 0;
function makeEngine(spawn: PipelineSpawnFn): Engine {
  const e = createEngineUntracked({
    now: () => new Date(clock),
    newId: () => `dl-${++counter}`,
    signalUrlBase: "http://localhost:7777",
    newSignalToken: testRunToken,
    maxConcurrent: 32,
    tickMs: 30_000,
    kill: fakeKill().kill,
    spawn,
  });
  engines.push(e);
  return e;
}

// ── The two pipelines ───────────────────────────────────────────────────────

/** `node -e "<js>" "<arg>"…`, portable to `cmd.exe`. */
const node = (js: string, ...args: string[]) =>
  [`node -e "${js}"`, ...args.map((a) => `"${a}"`)].join(" ");

/**
 * The task-scope check (DL-P3's scope script, in miniature): the task comes
 * from the trigger payload file, as the spawn payload delivers it, and the
 * changed files from what `build` left in its artifact folder. A task that
 * plans no files fails (2); a change outside the plan fails (1). It writes
 * what it read to `<seen>/<instance id>.json` first.
 */
const scopeCheck = (seen: string) =>
  node(
    "var fs=require('fs'), p=require('path'), env=process.env;" +
      " var payload=JSON.parse(fs.readFileSync(env.ARGUS_TRIGGER_PAYLOAD_FILE, 'utf8'));" +
      " var changed=JSON.parse(fs.readFileSync(p.join(env.ARGUS_ARTIFACT_DIR, 'changed.json'), 'utf8'));" +
      " fs.writeFileSync(p.join(process.argv[1], env.ARGUS_INSTANCE_ID + '.json')," +
      " JSON.stringify({ key: payload.key, task: payload.task, changed: changed }));" +
      " var planned=payload.task.files;" +
      " if (Array.isArray(planned) === false) { console.log('the task plans no files'); process.exit(2) }" +
      " var outside=changed.filter(function (f) { return planned.indexOf(f) === -1 });" +
      " if (outside.length) { console.log('outside the plan: ' + outside.join(', ')); process.exit(1) }",
    seen,
  );

/**
 * The `pr` gate's condition: the task's key from the trigger payload file,
 * then the provider's word on that task's pull request. Merged opens the gate
 * (exit 0), abandoned fails the phase (3, `failOnExit`), neither yet keeps it
 * waiting (1).
 */
const prMerged = (dir: string) =>
  node(
    "var fs=require('fs'), p=require('path');" +
      " var key=JSON.parse(fs.readFileSync(process.env.ARGUS_TRIGGER_PAYLOAD_FILE, 'utf8')).key;" +
      " var pr=p.join(process.argv[1], key);" +
      " if (fs.existsSync(pr + '.abandoned')) process.exit(3);" +
      " process.exit(fs.existsSync(pr + '.merged') ? 0 : 1)",
    dir,
  );

const merge = (key: string) => writeFileSync(path.join(provider, `${key}.merged`), "");
const abandon = (key: string) => writeFileSync(path.join(provider, `${key}.abandoned`), "");

const PLAN_SCHEMA = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/**
 * `task-loop` (one instance per task): `build` codes the task and is judged
 * by the scope check, then `pr` opens the pull request and waits at its gate
 * until the poll sees it merged. `pr` retries every failure class, so a
 * condition failure that stays failed is the rule, not the lack of a retry.
 *
 * `delivery-loop` (one instance per work item): `plan` returns the tasks,
 * `tasks` spawns one `task-loop` child per task, one at a time, in
 * dependency order; `ship` runs after the join, and `learn` reads the children.
 */
async function seed(): Promise<void> {
  // The child first: a spawn target must exist when its parent is saved.
  await createPipeline(
    validatePipelineInput({
      name: "task loop",
      trigger: null,
      overlapPolicy: "allow",
      phases: [
        {
          id: "build",
          name: "Build",
          cwd: home,
          gated: false,
          steps: [{ name: "code", prompt: "Implement this task.\nTASK {{trigger.payload}}\n" }],
          checks: [{ kind: "command", label: "task scope", run: scopeCheck(scopeSeen) }],
        },
        {
          id: "pr",
          name: "PR",
          cwd: home,
          gated: true,
          needs: ["build"],
          steps: [{ name: "open", prompt: "Open the pull request." }],
          approveWhen: {
            kind: "command",
            label: "pr merged",
            run: prMerged(provider),
            everySeconds: 30,
            failOnExit: 3,
          },
          retry: {
            attempts: 3,
            backoffSeconds: 0,
            retryOn: ["spawn", "exit-code", "signal", "timeout", "verification", "unverified"],
          },
        },
      ],
    }),
    new Date(clock),
    "task-loop",
  );
  await createPipeline(
    validatePipelineInput({
      name: "delivery loop",
      trigger: null,
      phases: [
        {
          id: "plan",
          name: "Plan",
          cwd: home,
          gated: false,
          steps: [{ name: "plan", prompt: "Break the spec into tasks." }],
          result: { artifact: "plan", schema: PLAN_SCHEMA },
        },
        {
          id: "tasks",
          name: "Tasks",
          cwd: home,
          needs: ["plan"],
          produces: "children",
          spawn: {
            pipelineId: "task-loop",
            items: { phase: "plan", path: ["tasks"] },
            key: "id",
            dependsOn: "dependsOn",
            title: "title",
            maxParallel: 1,
          },
        },
        {
          id: "ship",
          name: "Ship",
          cwd: home,
          gated: false,
          needs: ["tasks"],
          steps: [{ name: "ship", prompt: "Ship it." }],
        },
        {
          id: "learn",
          name: "Learn",
          cwd: home,
          gated: false,
          needs: ["ship"],
          childrenContext: { fromPhase: "tasks" },
          steps: [{ name: "retro", prompt: "Learn from every child." }],
        },
      ],
    }),
    new Date(clock),
    "delivery-loop",
  );
}

// ── Driving it ──────────────────────────────────────────────────────────────

async function waitFor(cond: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function load(id: string): Promise<PipelineInstance> {
  const inst = await readInstance(id);
  assert.ok(inst, `instance ${id} is on disk`);
  return inst;
}
const phaseOf = (inst: PipelineInstance, id: string) => {
  const phase = inst.phases.find((p) => p.id === id);
  assert.ok(phase, `${inst.id} has phase ${id}`);
  return phase;
};

async function waitForPhase(id: string, phaseId: string, status: string) {
  await waitFor(
    async () => (await readInstance(id))?.phases.find((p) => p.id === phaseId)?.status === status,
    `${id}/${phaseId} ${status}`,
  );
}

/** Report the latest run of a phase done (once it has launched), then drain. */
async function complete(
  e: Engine,
  agents: Agents,
  instanceId: string,
  phaseId: string,
  result?: unknown,
) {
  await waitFor(
    () => agents.launchesOf(instanceId, phaseId).length > 0,
    `${instanceId}/${phaseId} launched`,
  );
  const runId = agents.launchesOf(instanceId, phaseId).at(-1)!.runId;
  const res = await e.onSignal(instanceId, {
    instanceId,
    phaseId,
    runId,
    type: "completed",
    token: testRunToken(runId),
    payload: MARKED,
    ...(result === undefined ? {} : { result }),
  });
  assert.equal(res.ok, true, `the completion of ${instanceId}/${phaseId} was taken`);
  await e.drain();
}

/** One scheduler tick, 30 s after the last (`index.ts`): reconcile, then
 *  queue the approval polls; drained, so every poll and what it set off has
 *  landed. */
async function tick(e: Engine) {
  clock += 30_000;
  await e.reconcile();
  await e.pollGates();
  await e.drain();
}

/** Start the parent and complete its Plan with `tasks`. */
async function startPlanned(e: Engine, agents: Agents, tasks: object[]): Promise<string> {
  const parent = await e.start("delivery-loop", "manual");
  assert.ok(parent, "the parent started");
  await complete(e, agents, parent.id, "plan", { tasks });
  return parent.id;
}

async function tasksOf(parentId: string) {
  const children = phaseOf(await load(parentId), "tasks").children;
  assert.ok(children, "the spawn phase has its task list");
  return children.tasks;
}

/** Wait until the task list reads `states`, in list order. */
async function waitForTasks(parentId: string, states: string[], label: string) {
  await waitFor(async () => {
    const tasks = (await readInstance(parentId))?.phases.find((p) => p.id === "tasks")?.children
      ?.tasks;
    return JSON.stringify(tasks?.map((t) => t.state)) === JSON.stringify(states);
  }, label);
}

/** A child's `build` reports done and passes its scope check; its `pr` step
 *  opens the pull request; the phase then waits at its gate. */
async function toPrGate(e: Engine, agents: Agents, childId: string) {
  await complete(e, agents, childId, "build");
  await complete(e, agents, childId, "pr");
  await waitForPhase(childId, "pr", "awaiting-approval");
  assert.equal(phaseOf(await load(childId), "pr").pause, "gate", "at its gate, not a question");
}

const conditionEntries = async (id: string) =>
  (await readJournal(id))
    .filter((j) => j.kind === "phase.approval-condition")
    .map((j) => j.detail ?? "");

async function consistent(id: string): Promise<string> {
  return compareIntegrity(id, await readInstance(id), await readTransitionLog(id)).status;
}

/** What one child's scope check read and saw. */
const scopeSeenBy = (childId: string) =>
  JSON.parse(readFileSync(path.join(scopeSeen, `${childId}.json`), "utf8")) as {
    key: string;
    task: Record<string, unknown>;
    changed: string[];
  };

// ── The loop ────────────────────────────────────────────────────────────────

// `b` is listed first and waits for `a`: dependency order, not list order.
const TASKS = [
  { id: "b", title: "Use the helper", files: ["src/b.ts", "test/b.test.ts"], dependsOn: ["a"] },
  { id: "a", title: "Add the helper", files: ["src/a.ts"] },
  { id: "c", title: "Document it", files: ["docs/c.md"] },
];

test("the loop: one child per task in dependency order, each PR gate opened by its poll on the merge, and learn reads every child", async () => {
  await seed();
  const agents = fakeAgents();
  const e = makeEngine(agents.spawn);
  const parentId = await startPlanned(e, agents, TASKS);

  const childOf: Record<string, string> = {};
  const succeeded = new Set<string>();
  for (const key of ["a", "b", "c"]) {
    // Exactly one task is live: this one, every task before it succeeded.
    const states = (live: string) =>
      TASKS.map((t) => (t.id === key ? live : succeeded.has(t.id) ? "succeeded" : "pending"));
    await waitForTasks(parentId, states("running"), `${key} running`);
    const childId = (await tasksOf(parentId)).find((t) => t.key === key)?.instanceId;
    assert.ok(childId, `${key} has its child`);
    childOf[key] = childId;
    assert.equal(
      (await readInstances({ pipelineId: "task-loop" })).length,
      succeeded.size + 1,
      `${key}: one child per task started so far, no other`,
    );

    await toPrGate(e, agents, childId);
    await waitForTasks(parentId, states("awaiting-approval"), `${key} at its PR gate`);
    const parent = await load(parentId);
    assert.equal(parent.status, "running", `${key}: the parent runs while its child waits`);

    // The PR is not merged yet: the poll keeps the gate waiting.
    await tick(e);
    assert.equal(
      phaseOf(await load(childId), "pr").status,
      "awaiting-approval",
      `${key}: not merged, still waiting`,
    );
    assert.deepEqual(await readGateDecisions(childId), [], `${key}: nothing decided yet`);

    // The provider merges it; the next tick's poll sees that and opens the gate.
    merge(key);
    await tick(e);
    await waitFor(
      async () => (await readInstance(childId))?.status === "succeeded",
      `${key}'s child succeeded`,
    );
    succeeded.add(key);
    if (succeeded.size < TASKS.length) {
      assert.equal(
        agents.launchesOf(parentId, "ship").length,
        0,
        `${key}: no ship before the join`,
      );
    }
  }

  // Every child succeeded: the spawn phase joins, then ship, then learn.
  await waitForPhase(parentId, "tasks", "succeeded");
  assert.deepEqual(
    agents.launches.filter((l) => l.phaseId === "build").map((l) => l.instanceId),
    [childOf.a, childOf.b, childOf.c],
    "the children were built a, then b (which needs a), then c",
  );
  await complete(e, agents, parentId, "ship");
  await complete(e, agents, parentId, "learn");
  await waitFor(
    async () => (await readInstance(parentId))?.status === "succeeded",
    "the parent succeeded",
  );
  assert.equal(agents.launchesOf(parentId, "ship").length, 1, "ship ran once");
  assert.equal(agents.launchesOf(parentId, "learn").length, 1, "learn ran once");
  assert.equal((await readInstances({ pipelineId: "task-loop" })).length, 3, "three children");

  for (const task of TASKS) {
    const childId = childOf[task.id];
    const child = await load(childId);
    // DL-A4: the scope check judged the task this child was spawned for.
    assert.deepEqual(
      scopeSeenBy(childId),
      { key: task.id, task, changed: task.files },
      `${task.id}: the scope check read its own task through the payload file`,
    );
    const build = phaseOf(child, "build");
    assert.deepEqual(
      build.verification?.checks.map((c) => [c.label, c.status]),
      [["task scope", "passed"]],
      `${task.id}: the scope check passed`,
    );
    // DL-A3: the merge opened the gate, recorded as the rule that did it.
    const decisions = await readGateDecisions(childId);
    assert.equal(decisions.length, 1, `${task.id}: one gate decision`);
    const [d] = decisions;
    assert.deepEqual(
      [d.decision, d.mechanism, d.channel, d.principal],
      [
        "approve",
        "approval-condition",
        "approval-poll",
        { kind: "system", component: "approval-poll" },
      ],
      `${task.id}: approved by its approval condition`,
    );
    assert.deepEqual(
      [d.condition?.label, d.condition?.exitCode],
      ["pr merged", 0],
      `${task.id}: on the poll's exit 0`,
    );
    assert.deepEqual(child.gateDecisionIds, [d.id], `${task.id}: linked to the child`);
    const entries = await conditionEntries(childId);
    assert.equal(entries.length, 2, `${task.id}: the wait and the approval journalled`);
    assert.equal(entries[0], "pr merged: waiting: exit 1", `${task.id}: first it waited`);
    assert.match(entries[1], /^pr merged: exit 0 in \d+ms: approved the gate$/, `${task.id}: then`);
    assert.equal(await consistent(childId), "consistent", `${task.id}: the child's log replays`);
  }
  assert.equal(await consistent(parentId), "consistent", "the parent's log replays");

  // DL-A2b: learn read every task, its child, its phases and the gate decision.
  assert.equal(agents.manifests.length, 1, "learn's one run was handed the manifest");
  const [m] = agents.manifests;
  assert.deepEqual(m.for, { instanceId: parentId, phaseId: "learn", attempt: 0 }, "for learn");
  assert.deepEqual(
    [m.spawnPhase.id, m.spawnPhase.status, m.spawnPhase.childPipelineId, m.spawnPhase.counts],
    ["tasks", "succeeded", "task-loop", { succeeded: 3 }],
    "the spawn phase joined",
  );
  assert.deepEqual(
    m.tasks.map((t) => [t.index, t.key, t.title, t.dependsOn, t.state, t.child?.instanceId]),
    [
      [0, "b", "Use the helper", ["a"], "succeeded", childOf.b],
      [1, "a", "Add the helper", [], "succeeded", childOf.a],
      [2, "c", "Document it", [], "succeeded", childOf.c],
    ],
    "every task, in list order, with its child",
  );
  for (const [i, t] of m.tasks.entries()) {
    assert.deepEqual(t.task, TASKS[i], `${t.key}: the task as its child received it`);
    assert.equal(t.child?.status, "succeeded", `${t.key}: its child succeeded`);
    assert.deepEqual(
      t.child?.phases?.map((p) => [p.id, p.status, p.verification?.status ?? null]),
      [
        ["build", "succeeded", "passed"],
        ["pr", "succeeded", null],
      ],
      `${t.key}: the child's phases`,
    );
    assert.deepEqual(
      t.child?.decisions?.map((d) => [d.decision, d.mechanism, d.phases, d.effect]),
      [["approve", "approval-condition", [{ phaseId: "pr", attempt: 0 }], "applied"]],
      `${t.key}: the PR gate opened by its approval condition`,
    );
  }
  assert.deepEqual(m.warnings, [], "nothing it could not read");
});

test("an abandoned PR fails its child for good, blocks its dependent, and once a person accepts the rest learn sees the failure", async () => {
  await seed();
  const agents = fakeAgents();
  const e = makeEngine(agents.spawn);
  const parentId = await startPlanned(e, agents, [
    { id: "a", title: "Add the helper", files: ["src/a.ts"] },
    { id: "b", title: "Use the helper", files: ["src/b.ts"], dependsOn: ["a"] },
    { id: "c", title: "Document it", files: ["docs/c.md"] },
  ]);
  await waitForTasks(parentId, ["running", "pending", "pending"], "a running");
  const childA = (await tasksOf(parentId))[0].instanceId!;
  await toPrGate(e, agents, childA);

  // The provider says the PR was abandoned; the next poll exits failOnExit.
  abandon("a");
  await tick(e);
  await waitForPhase(childA, "pr", "failed");
  const child = await load(childA);
  const pr = phaseOf(child, "pr");
  const failure = pr.payload as PhaseFailurePayload;
  assert.equal(failure.failureClass, "approval-condition", "failed by its approval condition");
  assert.equal(failure.reason, 'approval condition "pr merged" exited 3', "saying so");
  assert.equal(pr.retryAt, undefined, "no retry is scheduled, whatever retryOn says");
  assert.equal(child.status, "failed", "the child failed");
  assert.deepEqual(await readGateDecisions(childA), [], "a failure, not a gate decision");

  // The parent: nothing new spawns, the dependent is blocked, a person decides.
  await waitFor(async () => phaseOf(await load(parentId), "tasks").pause === "children", "pause");
  await waitForTasks(parentId, ["failed", "blocked", "pending"], "a failed, b blocked");
  const paused = await load(parentId);
  assert.equal(phaseOf(paused, "tasks").status, "awaiting-approval", "the spawn phase waits");
  assert.equal(paused.status, "awaiting-approval", "and so does the parent");
  assert.match(
    String((await tasksOf(parentId))[0].reason),
    /approval condition "pr merged" exited 3/,
    "a says why",
  );

  // Later ticks neither retry the failed PR phase nor start another child.
  await tick(e);
  await tick(e);
  assert.equal(agents.launchesOf(childA, "pr").length, 1, "the PR phase was never re-run");
  assert.equal((await load(childA)).status, "failed", "the child stays failed");
  assert.equal((await readInstances({ pipelineId: "task-loop" })).length, 1, "no other child");
  assert.equal(agents.launchesOf(parentId, "ship").length, 0, "no ship while it waits");

  // A person accepts the rest: the spawn phase succeeds with what it has.
  const accepted = await e.approve(parentId, undefined, { phaseId: "tasks", source: OPERATOR });
  assert.equal(accepted.ok, true, "approving the children pause accepts the rest");
  await e.drain();
  const tasks = phaseOf(await load(parentId), "tasks");
  assert.equal(tasks.status, "succeeded", "the spawn phase succeeded");
  assert.deepEqual(
    (tasks.payload as { notSucceeded: string[] }).notSucceeded,
    ["a", "b", "c"],
    "naming every task it dropped",
  );
  await complete(e, agents, parentId, "ship");
  await complete(e, agents, parentId, "learn");
  await waitFor(
    async () => (await readInstance(parentId))?.status === "succeeded",
    "the parent succeeded",
  );

  // Learn sees the failed task, why, and the tasks that never ran.
  const [m] = agents.manifests;
  assert.ok(m, "learn was handed the manifest");
  assert.deepEqual(
    [m.spawnPhase.status, m.spawnPhase.counts],
    ["succeeded", { failed: 1, blocked: 1, pending: 1 }],
    "the spawn phase, accepted with one failure",
  );
  assert.deepEqual(
    m.tasks.map((t) => [t.key, t.state, t.child?.instanceId ?? null]),
    [
      ["a", "failed", childA],
      ["b", "blocked", null],
      ["c", "pending", null],
    ],
    "every task, and only a ever had a child",
  );
  const a = m.tasks[0];
  assert.match(String(a.reason), /approval condition "pr merged" exited 3/, "a's reason");
  assert.equal(a.child?.status, "failed", "a's child failed");
  assert.deepEqual(
    a.child?.phases?.map((p) => [p.id, p.status, p.failure?.failureClass ?? null]),
    [
      ["build", "succeeded", null],
      ["pr", "failed", "approval-condition"],
    ],
    "at its PR phase, by its approval condition",
  );
  assert.deepEqual(a.child?.decisions, [], "no gate decision on the child");
  assert.deepEqual(
    m.parent.decisions?.map((d) => [d.decision, d.mechanism, d.phases]),
    [["approve", "operator", [{ phaseId: "tasks", attempt: 0 }]]],
    "the person's acceptance, on the parent's own record",
  );
  assert.equal(await consistent(parentId), "consistent", "the parent's log replays");
  assert.equal(await consistent(childA), "consistent", "and the child's");
});

// The two ways a task-scope check refuses work: a change the task did not
// plan, and a task the plan gave no files, so nothing can be in its scope.
for (const c of [
  {
    does: "changes a file outside its task's plan",
    task: { id: "a", title: "Add the helper", files: ["src/a.ts"] },
    changed: ["src/a.ts", "src/unplanned.ts"],
    exitCode: 1,
    says: /outside the plan: src\/unplanned\.ts/,
  },
  {
    does: "works a task the plan gave no files",
    task: { id: "a", title: "Add the helper" },
    changed: ["src/unplanned.ts"],
    exitCode: 2,
    says: /the task plans no files/,
  },
]) {
  test(`a child whose agent ${c.does} fails its scope check and opens no PR`, async () => {
    await seed();
    const agents = fakeAgents({ a: ["src/unplanned.ts"] });
    const e = makeEngine(agents.spawn);
    const parentId = await startPlanned(e, agents, [
      c.task,
      { id: "b", title: "Use the helper", files: ["src/b.ts"], dependsOn: ["a"] },
    ]);
    await waitForTasks(parentId, ["running", "pending"], "a running");
    const childA = (await tasksOf(parentId))[0].instanceId!;

    await complete(e, agents, childA, "build");
    await waitForPhase(childA, "build", "failed");
    const build = phaseOf(await load(childA), "build");
    assert.equal(
      (build.payload as PhaseFailurePayload).failureClass,
      "verification",
      "a failed check",
    );
    const [check] = build.verification?.checks ?? [];
    assert.deepEqual(
      [check?.label, check?.status, check?.exitCode],
      ["task scope", "failed", c.exitCode],
      "the scope check failed",
    );
    assert.match(String(check?.output), c.says, "saying why");
    assert.deepEqual(
      scopeSeenBy(childA),
      { key: "a", task: c.task, changed: c.changed },
      "it read the task through the payload file",
    );

    await waitForTasks(parentId, ["failed", "blocked"], "a failed, b blocked");
    assert.equal(phaseOf(await load(parentId), "tasks").pause, "children", "the parent waits");
    await tick(e);
    assert.equal(agents.launchesOf(childA, "pr").length, 0, "no PR was opened");
    assert.deepEqual(await conditionEntries(childA), [], "and nothing was polled");
    assert.deepEqual(readdirSync(scopeSeen), [`${childA}.json`], "only a's work was judged");
    assert.equal((await readInstances({ pipelineId: "task-loop" })).length, 1, "one child only");
  });
}
