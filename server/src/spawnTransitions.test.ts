import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abortTransition,
  advance,
  applyApprove,
  applyCandidateSelection,
  applyChildDeferred,
  applyChildRefused,
  applyChildRevived,
  applyChildrenObserved,
  applyChildrenPlan,
  applyChildrenStart,
  applyRevise,
  initInstance,
  type TransitionResult,
} from "./pipelineTransitions.js";
import { buildPhaseChildren, nextSpawns, type ChildObservation } from "./sources/children.js";
import { hasWaitingGate, inFlight } from "./sources/instanceStatus.js";
import { decidedChildren } from "./transitionLog/effects.js";
import type {
  PhaseChildren,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
  ResultSchema,
  SpawnChildrenSummary,
  SpawnPolicy,
} from "./sources/pipelineTypes.js";

/**
 * Spawn phases as pure transitions (DL-A2a): the item check that fails a plan
 * before its gate, and every transition a spawn phase's record goes through.
 * Each one refuses a stale attempt, and a replay of the same input changes
 * nothing and returns no events, so the engine's commit records nothing.
 */

const NOW = "2026-10-22T12:00:00.000Z";
const LATER = "2026-10-22T12:05:00.000Z";

const taskSchema: ResultSchema = {
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
  },
};

/** plan (a result the spawn phase reads) → tasks (the spawn phase) → ship. */
function spawnDef(
  over: Partial<SpawnPolicy> = {},
  planGated = false,
  schema: ResultSchema = taskSchema,
): PipelineDefinition {
  return {
    id: "parent",
    name: "Parent",
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    phases: [
      {
        id: "plan",
        name: "Plan",
        cwd: "/tmp",
        gated: planGated,
        steps: [{ name: "write", prompt: "plan it" }],
        result: { artifact: "plan", schema },
      },
      {
        id: "tasks",
        name: "Tasks",
        cwd: "/tmp",
        gated: false,
        steps: [],
        needs: ["plan"],
        produces: "children",
        spawn: {
          pipelineId: "task-loop",
          items: { phase: "plan", path: ["tasks"] },
          key: "id",
          dependsOn: "dependsOn",
          title: "title",
          ...over,
        },
      },
      {
        id: "ship",
        name: "Ship",
        cwd: "/tmp",
        gated: false,
        needs: ["tasks"],
        steps: [{ name: "go", prompt: "ship {{previous.payload}}" }],
      },
    ],
  };
}

const TASKS = 1;
const SHIP = 2;

/** Plan's single step reports `result` as the engine would deliver it. */
function completePlan(d: PipelineDefinition, inst: PipelineInstance, result: unknown) {
  inst.phases[0].steps[0].runId = "run-0";
  inst.phases[0].steps[0].status = "running";
  return advance(
    d,
    inst,
    {
      instanceId: "i1",
      phaseId: "plan",
      runId: "run-0",
      type: "completed",
      token: "tok",
      result,
    },
    NOW,
  );
}

/** An instance whose Plan succeeded with `tasks`: the spawn phase is running,
 *  with no task list yet. */
function planned(d: PipelineDefinition, tasks: unknown[]): PipelineInstance {
  const { instance } = initInstance(d, "manual", { instanceId: "i1", token: "tok" }, NOW);
  completePlan(d, instance, { tasks });
  assert.equal(instance.phases[TASKS].status, "running", "the spawn phase starts after Plan");
  return instance;
}

function childrenOf(d: PipelineDefinition, inst: PipelineInstance): PhaseChildren {
  const built = buildPhaseChildren(d.phases[TASKS].spawn!, inst, "tasks");
  assert.ok(built.ok, "the task list builds");
  return built.children;
}

/** An instance whose spawn phase has its task list, every task `pending`. */
function started(d: PipelineDefinition, tasks: unknown[]): PipelineInstance {
  const inst = planned(d, tasks);
  const res = applyChildrenStart(d, inst, "tasks", 0, childrenOf(d, inst), NOW);
  assert.equal(res.events?.length, 1, "the task list is recorded");
  return inst;
}

const obs = (
  index: number,
  instanceId: string,
  status: ChildObservation["status"],
  extra: Partial<ChildObservation> = {},
): ChildObservation => ({ index, instanceId, status, ...extra });

const phaseOf = (inst: PipelineInstance): PhaseProgress => inst.phases[TASKS];
const tasksOf = (inst: PipelineInstance) => phaseOf(inst).children!.tasks;
const kinds = (res: TransitionResult) => (res.events ?? []).map((e) => e.kind);

function plan(inst: PipelineInstance, entries: Array<[number, string]>, attempt?: number) {
  return applyChildrenPlan(
    inst,
    "tasks",
    attempt ?? phaseOf(inst).attempt,
    entries.map(([index, instanceId]) => ({ index, instanceId })),
    NOW,
  );
}

function see(d: PipelineDefinition, inst: PipelineInstance, ...observed: ChildObservation[]) {
  return applyChildrenObserved(d, inst, "tasks", phaseOf(inst).attempt, observed, NOW);
}

/** Plan one task and see its child succeed. */
function runToSuccess(d: PipelineDefinition, inst: PipelineInstance, index: number, id: string) {
  assert.equal(plan(inst, [[index, id]]).events?.length, 1, `task ${index} plans`);
  return see(d, inst, obs(index, id, "succeeded"));
}

const ABC = [{ id: "A" }, { id: "B", dependsOn: ["A"] }, { id: "C" }];

// ── The item check ──────────────────────────────────────────────────────────

const LOOSE: ResultSchema = { type: "object" };
const key65 = "k".repeat(65);
const badLists: Array<[string, unknown, Partial<SpawnPolicy>?]> = [
  ["that is not a list", { tasks: { id: "A" } }],
  ["that is empty", { tasks: [] }],
  ["longer than maxItems", { tasks: [{ id: "A" }, { id: "B" }, { id: "C" }] }, { maxItems: 2 }],
  ["with a task that is not an object", { tasks: [{ id: "A" }, "B"] }],
  ["with a task missing its key", { tasks: [{ id: "A" }, { title: "no key" }] }],
  ["with an empty key", { tasks: [{ id: "" }] }],
  ["with a 65-character key", { tasks: [{ id: key65 }] }],
  ["with a duplicate key", { tasks: [{ id: "A" }, { id: "A" }] }],
  ["with an unknown dependency", { tasks: [{ id: "A", dependsOn: ["Z"] }] }],
  ["with a self-dependency", { tasks: [{ id: "A", dependsOn: ["A"] }] }],
  [
    "with a dependency cycle",
    {
      tasks: [
        { id: "A", dependsOn: ["B"] },
        { id: "B", dependsOn: ["A"] },
      ],
    },
  ],
];

for (const [label, result, over] of badLists) {
  test(`item check: a task list ${label} fails Plan before its gate`, () => {
    // The loose schema leaves every case to the item check; a real definition's
    // schema (required at save) catches the shape cases first, just as early.
    const d = spawnDef(over, true, LOOSE);
    const { instance: inst } = initInstance(d, "manual", { instanceId: "i1", token: "t" }, NOW);
    const res = completePlan(d, inst, result);
    assert.equal(inst.phases[0].status, "failed", "Plan fails rather than waiting at its gate");
    assert.match(
      res.routing!.failures[0].reason,
      /the task list for spawn phase "tasks" is not usable/,
      "the failure names the spawn phase",
    );
    assert.match(
      String((inst.phases[0].payload as { reason: string }).reason),
      /not usable/,
      "the reason is on Plan's payload",
    );
    assert.equal(inst.phases[TASKS].status, "pending", "the spawn phase never starts");
  });
}

test("item check: with the declared schema, a list of the wrong shape fails Plan just as early", () => {
  const d = spawnDef({}, true);
  const { instance: inst } = initInstance(d, "manual", { instanceId: "i1", token: "t" }, NOW);
  const res = completePlan(d, inst, { tasks: [{ title: "no key" }] });
  assert.equal(inst.phases[0].status, "failed", "Plan fails rather than waiting at its gate");
  assert.match(res.routing!.failures[0].reason, /does not match the declared schema/);
});

test("item check: a usable list waits at a gated Plan, and starts the spawn phase after an ungated one", () => {
  const gated = spawnDef({}, true);
  const g = initInstance(gated, "manual", { instanceId: "i1", token: "t" }, NOW).instance;
  completePlan(gated, g, { tasks: ABC });
  assert.equal(g.phases[0].status, "awaiting-approval", "a gated Plan pauses at its gate");
  assert.equal(g.phases[TASKS].status, "pending", "the spawn phase waits for the approval");

  const open = spawnDef();
  const o = initInstance(open, "manual", { instanceId: "i1", token: "t" }, NOW).instance;
  const res = completePlan(open, o, { tasks: ABC });
  assert.equal(o.phases[0].status, "succeeded", "an ungated Plan succeeds");
  assert.deepEqual(res.startPhases, [TASKS], "the spawn phase starts");
});

test("item check: a pipeline with no spawn phase is unaffected", () => {
  const d = spawnDef();
  d.phases = [d.phases[0]];
  const { instance: inst } = initInstance(d, "manual", { instanceId: "i1", token: "t" }, NOW);
  completePlan(d, inst, { tasks: [] });
  assert.equal(inst.phases[0].status, "succeeded", "nothing reads the list, so nothing checks it");
});

test("item check: a candidates winner with an unusable list fails the same way", () => {
  const d = spawnDef({}, false, LOOSE);
  d.phases[0].candidates = { count: 2, select: "first-verified" };
  const { instance: inst } = initInstance(d, "manual", { instanceId: "i1", token: "t" }, NOW);
  inst.phases[0].steps = [0, 1].map((i) => ({
    name: "write",
    runId: `run-c${i}`,
    status: "running" as const,
    candidate: i,
  }));
  inst.phases[0].steps[1].status = "succeeded";
  inst.phases[0].steps[1].result = { tasks: [] };
  const res = applyCandidateSelection(d, inst, "plan", 1, [], NOW);
  assert.equal(inst.phases[0].status, "failed", "the winner's list is refused");
  assert.match(
    res.routing!.failures[0].reason,
    /the task list for spawn phase "tasks" is not usable: .*empty/,
    "the same reason as the signal path",
  );
  assert.equal(inst.phases[TASKS].status, "pending", "the spawn phase never starts");
});

// ── initInstance ────────────────────────────────────────────────────────────

test("initInstance: a spawned child records its trigger, parent, base and payload", () => {
  const d = spawnDef();
  const parent = { instanceId: "p-1", pipelineId: "parent", phaseId: "tasks", index: 2, key: "C" };
  const triggerPayload = { task: { id: "C" }, key: "C", base: "main", parent };
  const { instance } = initInstance(d, "spawned", { instanceId: "c-1", token: "t" }, NOW, {
    triggerPayload,
    parent,
    workspaceBase: "main",
  });
  assert.equal(instance.trigger, "spawned");
  assert.deepEqual(instance.parent, parent, "the parent link is stored");
  assert.equal(instance.workspaceBase, "main", "the worktree base is stored");
  assert.deepEqual(instance.triggerPayload, triggerPayload, "the payload is stored");
  const plain = initInstance(d, "manual", { instanceId: "m-1", token: "t" }, NOW).instance;
  assert.equal("parent" in plain, false, "no parent unless spawned");
  assert.equal("workspaceBase" in plain, false, "no base unless given");
});

// ── applyChildrenStart ──────────────────────────────────────────────────────

test("applyChildrenStart records one pending task per item, once", () => {
  const d = spawnDef();
  const long = "A title far longer than the sixty characters a parent keeps for a task";
  const inst = planned(d, [{ id: "A", title: long }, { id: "B", dependsOn: ["A"] }, { id: "C" }]);
  const children = childrenOf(d, inst);
  const res = applyChildrenStart(d, inst, "tasks", 0, children, NOW);
  assert.deepEqual(kinds(res), ["children-started"]);
  assert.equal(res.events![0].detail, "3 tasks");
  assert.equal(res.events![0].phaseId, "tasks", "the event is about the spawn phase");
  const tasks = tasksOf(inst);
  assert.deepEqual(
    tasks.map((t) => [t.key, t.state, t.dependsOn]),
    [
      ["A", "pending", undefined],
      ["B", "pending", [0]],
      ["C", "pending", undefined],
    ],
    "in list order, dependencies as positions",
  );
  assert.equal(tasks[0].title?.length, 60, "the stored title is clipped");
  assert.ok(tasks[0].title?.endsWith("…"), "and says so");
  assert.equal(phaseOf(inst).children?.pipelineId, "task-loop");
  assert.deepEqual(phaseOf(inst).children?.source, { phaseId: "plan", attempt: 0 });

  // A replay changes nothing and records nothing.
  const before = structuredClone(inst);
  const again = applyChildrenStart(d, inst, "tasks", 0, children, LATER);
  assert.equal(again.events, undefined, "no events");
  assert.deepEqual(inst, before, "no change, updatedAt included");
});

test("applyChildrenStart is refused for a stale attempt, a phase not running, another phase and no tasks", () => {
  const d = spawnDef();
  const inst = planned(d, ABC);
  const children = childrenOf(d, inst);
  const before = structuredClone(inst);
  assert.equal(applyChildrenStart(d, inst, "tasks", 1, children, NOW).events, undefined, "stale");
  assert.equal(
    applyChildrenStart(d, inst, "tasks", 0, { ...children, tasks: [] }, NOW).events,
    undefined,
    "an empty list",
  );
  inst.phases[SHIP].status = "running";
  assert.equal(applyChildrenStart(d, inst, "ship", 0, children, NOW).events, undefined, "no spawn");
  inst.phases[SHIP].status = "pending";
  assert.deepEqual(inst, before, "nothing changed");

  const fresh = initInstance(d, "manual", { instanceId: "i1", token: "t" }, NOW).instance;
  const res = applyChildrenStart(d, fresh, "tasks", 0, children, NOW);
  assert.equal(res.events, undefined, "a pending phase is refused");
  assert.equal(fresh.phases[TASKS].children, undefined, "and gets no list");
});

// ── applyChildrenPlan ───────────────────────────────────────────────────────

test("applyChildrenPlan takes only what nextSpawns allows, in order and within the slots", () => {
  const d = spawnDef();
  const inst = started(d, ABC);
  const res = plan(inst, [
    [0, "child-a"],
    [2, "child-c"],
  ]);
  assert.deepEqual(kinds(res), ["children-planned"]);
  assert.equal(res.events![0].detail, "A → child-a");
  assert.deepEqual(
    tasksOf(inst).map((t) => [t.state, t.instanceId]),
    [
      ["planned", "child-a"],
      ["pending", undefined],
      ["pending", undefined],
    ],
    "one slot: A only",
  );

  // A replay plans nothing.
  const before = structuredClone(inst);
  assert.equal(plan(inst, [[0, "child-a"]]).events, undefined, "a replay is a no-op");
  assert.deepEqual(inst, before, "nothing changed");
  // A stale attempt is refused, even with a free slot.
  see(d, inst, obs(0, "child-a", "succeeded"));
  assert.equal(plan(inst, [[1, "child-b"]], 1).events, undefined, "a stale attempt");
  assert.equal(tasksOf(inst)[1].state, "pending");
});

test("applyChildrenPlan waits for dependencies and never reuses an id", () => {
  const d = spawnDef({ maxParallel: 2 });
  const inst = started(d, ABC);
  assert.equal(phaseOf(inst).children?.maxParallel, 2, "two slots, frozen with the list");
  const res = plan(inst, [
    [1, "child-b"],
    [2, "child-c"],
  ]);
  assert.equal(res.events![0].detail, "C → child-c", "B waits for A");
  assert.equal(tasksOf(inst)[1].state, "pending");

  // The instance's own id, a live child's id and a replaced child's id are all taken.
  tasksOf(inst)[2].previousInstanceIds = ["old-c"];
  for (const id of ["i1", "child-c", "old-c"]) {
    assert.equal(plan(inst, [[0, id]]).events, undefined, `${id} is refused`);
  }
  assert.equal(tasksOf(inst)[0].state, "pending");
  assert.equal(plan(inst, [[0, "child-a"]]).events?.length, 1, "a fresh id is taken");
});

test("applyChildrenPlan plans nothing while a task is failed", () => {
  const d = spawnDef({ maxParallel: 2 });
  const inst = started(d, [{ id: "A" }, { id: "B" }, { id: "C" }]);
  plan(inst, [[0, "child-a"]]);
  tasksOf(inst)[0].state = "failed";
  assert.equal(plan(inst, [[2, "child-c"]]).events, undefined, "a failure stops new spawns");
  assert.equal(tasksOf(inst)[2].state, "pending");
});

// ── applyChildrenObserved ───────────────────────────────────────────────────

test("applyChildrenObserved mirrors each child, and the phase joins when every task succeeded", () => {
  const d = spawnDef();
  const inst = started(d, ABC);
  plan(inst, [[0, "child-a"]]);
  let res = see(d, inst, obs(0, "child-a", "running"));
  assert.deepEqual(kinds(res), ["child-observed"]);
  assert.equal(res.events![0].detail, "A: planned → running");
  assert.equal(tasksOf(inst)[0].state, "running");

  res = see(d, inst, obs(0, "child-a", "awaiting-approval", { waitingPhaseId: "review" }));
  assert.equal(tasksOf(inst)[0].state, "awaiting-approval");
  assert.equal(tasksOf(inst)[0].waitingPhaseId, "review", "names the child's waiting phase");
  assert.equal(inst.status, "running", "a child's gate is not the parent's");
  assert.equal(hasWaitingGate(inst), false, "no phase of the parent waits");
  assert.equal(inFlight(inst), false, "the parent only waits on a person");

  // A replay, a stale attempt and someone else's child change nothing.
  const before = structuredClone(inst);
  const waiting = obs(0, "child-a", "awaiting-approval", { waitingPhaseId: "review" });
  assert.equal(see(d, inst, waiting).events, undefined, "a replay");
  assert.equal(
    applyChildrenObserved(d, inst, "tasks", 1, [obs(0, "child-a", "succeeded")], NOW).events,
    undefined,
    "a stale attempt",
  );
  assert.equal(see(d, inst, obs(0, "child-x", "succeeded")).events, undefined, "another id");
  assert.deepEqual(inst, before, "nothing changed");

  res = see(d, inst, obs(0, "child-a", "succeeded"));
  assert.equal(tasksOf(inst)[0].waitingPhaseId, undefined, "the gate is no longer waited on");
  assert.equal(phaseOf(inst).status, "running", "B and C are still to run");
  assert.deepEqual(nextSpawns(phaseOf(inst).children!), [1], "B is ready");

  runToSuccess(d, inst, 1, "child-b");
  plan(inst, [[2, "child-c"]]);
  see(d, inst, obs(2, "child-c", "running"));
  res = see(d, inst, obs(2, "child-c", "succeeded"));
  assert.deepEqual(kinds(res).slice(0, 2), ["child-observed", "phase-succeeded"]);
  assert.equal(phaseOf(inst).status, "succeeded", "the join");
  const summary = phaseOf(inst).payload as SpawnChildrenSummary;
  assert.deepEqual(summary.notSucceeded, [], "nothing dropped");
  assert.deepEqual(summary.counts, { succeeded: 3 });
  assert.deepEqual(inst.artifacts?.children, summary, "published under `produces`");
  assert.deepEqual(res.startPhases, [SHIP], "ship starts");
  assert.equal(see(d, inst, obs(2, "child-c", "succeeded")).events, undefined, "joined once");
});

test("applyChildrenObserved: a missing child is still owed its start, or is gone", () => {
  const d = spawnDef({ maxParallel: 2 });
  const inst = started(d, [{ id: "A" }, { id: "B" }]);
  plan(inst, [
    [0, "child-a"],
    [1, "child-b"],
  ]);
  assert.equal(see(d, inst, obs(0, "child-a", "missing")).events, undefined, "planned: ignored");
  assert.equal(tasksOf(inst)[0].state, "planned");
  see(d, inst, obs(1, "child-b", "running"));
  const res = see(d, inst, obs(1, "child-b", "missing"));
  assert.equal(res.events![0].detail, "B: running → aborted");
  assert.equal(tasksOf(inst)[1].state, "aborted");
  assert.equal(tasksOf(inst)[1].reason, "the child instance is gone");
  assert.equal(phaseOf(inst).status, "running", "A is still live");
});

// ── A failure, the pause, and the three ways out ────────────────────────────

/** [A, B (needs A), C] with A failed: B blocked, the phase paused at `children`. */
function haltedOnA(d: PipelineDefinition): { inst: PipelineInstance; res: TransitionResult } {
  const inst = started(d, ABC);
  plan(inst, [[0, "child-a"]]);
  see(d, inst, obs(0, "child-a", "running"));
  const res = see(d, inst, obs(0, "child-a", "failed", { reason: 'phase "build" failed: red' }));
  return { inst, res };
}

test("a failed child blocks its dependents, and with nothing live the phase pauses at children", () => {
  const d = spawnDef();
  const { inst, res } = haltedOnA(d);
  assert.deepEqual(
    tasksOf(inst).map((t) => t.state),
    ["failed", "blocked", "pending"],
  );
  assert.equal(tasksOf(inst)[0].reason, 'phase "build" failed: red');
  assert.equal(phaseOf(inst).status, "awaiting-approval");
  assert.equal(phaseOf(inst).pause, "children");
  assert.equal(inst.status, "awaiting-approval", "the parent now waits on a person");
  const summary = phaseOf(inst).payload as SpawnChildrenSummary;
  assert.deepEqual(summary.notSucceeded, ["A", "B", "C"]);
  const paused = res.events!.find((e) => e.kind === "phase-paused");
  assert.equal(paused?.detail, "children");
  assert.deepEqual(
    kinds(res).slice(0, 3),
    ["child-observed", "child-observed", "phase-paused"],
    "A failed, B blocked, then the pause",
  );
  assert.equal(plan(inst, [[2, "child-c"]]).events, undefined, "nothing more is planned");
  assert.equal(see(d, inst, obs(0, "child-a", "failed")).events, undefined, "a replay");
});

test("running children finish before the phase pauses", () => {
  const d = spawnDef({ maxParallel: 2 });
  const inst = started(d, [{ id: "A" }, { id: "B" }, { id: "C" }]);
  plan(inst, [
    [0, "child-a"],
    [1, "child-b"],
  ]);
  see(d, inst, obs(0, "child-a", "running"), obs(1, "child-b", "running"));
  see(d, inst, obs(0, "child-a", "failed"));
  assert.equal(phaseOf(inst).status, "running", "B is still running");
  assert.deepEqual(nextSpawns(phaseOf(inst).children!), [], "but C does not start");
  const res = see(d, inst, obs(1, "child-b", "succeeded"));
  assert.equal(phaseOf(inst).pause, "children", "B finished: now the pause");
  assert.ok(kinds(res).includes("phase-paused"));
});

test("re-running the failed child directly resumes the phase", () => {
  const d = spawnDef();
  const { inst } = haltedOnA(d);
  const res = see(d, inst, obs(0, "child-a", "running"));
  assert.ok(kinds(res).includes("children-resumed"), "the pause ends");
  assert.equal(phaseOf(inst).status, "running");
  assert.equal(phaseOf(inst).pause, undefined);
  assert.equal(phaseOf(inst).payload, null, "the summary goes with the pause");
  assert.equal(inst.status, "running");
  assert.deepEqual(
    tasksOf(inst).map((t) => t.state),
    ["running", "pending", "pending"],
    "B is no longer blocked",
  );
  assert.equal(tasksOf(inst)[0].reason, undefined, "the old failure is cleared");
  see(d, inst, obs(0, "child-a", "succeeded"));
  assert.equal(plan(inst, [[1, "child-b"]]).events?.length, 1, "B plans");
});

test("revising the spawn phase revives failed children and re-opens the rest", () => {
  const d = spawnDef({ maxParallel: 2 });
  const inst = started(d, [...ABC, { id: "D" }]);
  plan(inst, [
    [0, "child-a"],
    [2, "child-c"],
  ]);
  see(d, inst, obs(0, "child-a", "running"), obs(2, "child-c", "succeeded"));
  plan(inst, [[3, "child-d"]]);
  see(d, inst, obs(0, "child-a", "failed"), obs(3, "child-d", "aborted"));
  assert.equal(phaseOf(inst).pause, "children", "A failed, D aborted: paused");

  const revised = applyRevise(inst, NOW, "tasks");
  assert.deepEqual(revised.startPhases, [TASKS]);
  assert.equal(phaseOf(inst).attempt, 1);
  assert.equal(applyChildRevived(inst, "tasks", 0, "GD-1", NOW).events, undefined, "stale");
  const res = applyChildRevived(inst, "tasks", 1, "GD-1", NOW);
  assert.deepEqual(kinds(res), ["child-revived"]);
  assert.equal(res.events![0].detail, "1 revived in place, 2 re-opened");
  const [a, b, c, dd] = tasksOf(inst);
  assert.deepEqual([a.state, a.instanceId, a.reviveDecisionId], ["reviving", "child-a", "GD-1"]);
  assert.equal(a.reason, undefined);
  assert.deepEqual([b.state, b.instanceId], ["pending", undefined], "B unblocked");
  assert.deepEqual([c.state, c.instanceId], ["succeeded", "child-c"], "C stays");
  assert.deepEqual(
    [dd.state, dd.instanceId, dd.previousInstanceIds],
    ["pending", undefined, ["child-d"]],
    "D gets a fresh child",
  );
  assert.equal(phaseOf(inst).pause, undefined);
  assert.equal(phaseOf(inst).payload, null);
  assert.equal(applyChildRevived(inst, "tasks", 1, "GD-1", NOW).events, undefined, "a replay");

  // A failure seen before the revive took effect is the one being revived.
  const stillOld = structuredClone(inst);
  assert.equal(see(d, stillOld, obs(0, "child-a", "failed")).events, undefined);
  assert.equal(tasksOf(stillOld)[0].state, "reviving");
  // One the child links to this decision is a new failure.
  see(d, stillOld, obs(0, "child-a", "failed", { revised: true }));
  assert.equal(tasksOf(stillOld)[0].state, "failed");
  // The revived child running again ends the revive.
  see(d, inst, obs(0, "child-a", "running"));
  assert.equal(tasksOf(inst)[0].state, "running");
  assert.equal(tasksOf(inst)[0].reviveDecisionId, undefined);
});

test("approving a children pause accepts the rest, ignoring answers", () => {
  const d = spawnDef();
  const { inst } = haltedOnA(d);
  const summary = phaseOf(inst).payload;
  const res = applyApprove(d, inst, { x: 1 }, NOW, "tasks");
  assert.equal(phaseOf(inst).status, "succeeded");
  assert.deepEqual(phaseOf(inst).payload, summary, "the payload is still the summary");
  assert.deepEqual(inst.artifacts?.children, summary, "and is what the phase publishes");
  assert.deepEqual(res.startPhases, [SHIP], "ship starts");
});

// ── applyChildDeferred and applyChildRefused ────────────────────────────────

test("applyChildDeferred says why a start waits, once per reason", () => {
  const d = spawnDef();
  const inst = started(d, ABC);
  plan(inst, [[0, "child-a"]]);
  const defer = (reason: string, at = NOW, id = "child-a") =>
    applyChildDeferred(inst, "tasks", 0, 0, id, reason, at);
  const res = defer("the spend budget is exceeded");
  assert.deepEqual(kinds(res), ["child-deferred"]);
  assert.deepEqual(tasksOf(inst)[0].deferred, { reason: "the spend budget is exceeded", at: NOW });
  assert.equal(tasksOf(inst)[0].state, "planned", "no state change");

  const before = structuredClone(inst);
  assert.equal(defer("the spend budget is exceeded", LATER).events, undefined, "same reason");
  assert.deepEqual(inst, before, "not even the time moves");
  assert.equal(defer("pipeline task-loop is busy", LATER).events?.length, 1, "a new reason");
  assert.equal(tasksOf(inst)[0].deferred?.at, LATER);
  assert.equal(defer("x", NOW, "child-x").events, undefined, "a wrong id");
  assert.equal(
    applyChildDeferred(inst, "tasks", 1, 0, "child-a", "x", NOW).events,
    undefined,
    "a stale attempt",
  );

  see(d, inst, obs(0, "child-a", "running"));
  assert.equal(tasksOf(inst)[0].deferred, undefined, "a child that moves clears it");
  assert.equal(defer("late").events, undefined, "a running task is refused");
});

test("applyChildRefused fails the task without a child, and halts the phase", () => {
  const d = spawnDef();
  const inst = started(d, ABC);
  plan(inst, [[0, "child-a"]]);
  assert.equal(
    applyChildRefused(d, inst, "tasks", 0, 0, "child-x", "gone", NOW).events,
    undefined,
    "a wrong id",
  );
  assert.equal(
    applyChildRefused(d, inst, "tasks", 1, 0, "child-a", "gone", NOW).events,
    undefined,
    "a stale attempt",
  );
  const res = applyChildRefused(
    d,
    inst,
    "tasks",
    0,
    0,
    "child-a",
    'pipeline "task-loop" is gone',
    NOW,
  );
  const a = tasksOf(inst)[0];
  assert.equal(a.state, "failed");
  assert.equal(a.instanceId, undefined);
  assert.deepEqual(a.previousInstanceIds, ["child-a"], "never used again");
  assert.equal(a.reason, 'not started: pipeline "task-loop" is gone');
  assert.equal(kinds(res)[0], "child-refused");
  assert.equal(phaseOf(inst).pause, "children", "nothing is live: the phase pauses");
  const before = structuredClone(inst);
  assert.equal(
    applyChildRefused(d, inst, "tasks", 0, 0, "child-a", "gone", NOW).events,
    undefined,
    "a replay",
  );
  assert.deepEqual(inst, before);

  // Revised: A is re-opened (it has no child to revive), and a refused revive says so.
  applyRevise(inst, NOW, "tasks");
  applyChildRevived(inst, "tasks", 1, "GD-1", NOW);
  assert.equal(tasksOf(inst)[0].state, "pending", "a refused start gets a fresh child");
  plan(inst, [[0, "child-a2"]]);
  see(d, inst, obs(0, "child-a2", "failed"));
  applyRevise(inst, NOW, "tasks");
  applyChildRevived(inst, "tasks", 2, "GD-2", NOW);
  assert.equal(tasksOf(inst)[0].state, "reviving");
  applyChildRefused(d, inst, "tasks", 2, 0, "child-a2", "the child is gone", NOW);
  assert.equal(tasksOf(inst)[0].reason, "not revived: the child is gone");
  assert.deepEqual(tasksOf(inst)[0].previousInstanceIds, ["child-a", "child-a2"]);
});

// ── Abort ───────────────────────────────────────────────────────────────────

test("aborting the parent marks its live children aborted, and names them for the cascade", () => {
  const d = spawnDef();
  const inst = started(d, ABC);
  plan(inst, [[0, "child-a"]]);
  see(d, inst, obs(0, "child-a", "running"));
  assert.deepEqual(decidedChildren(inst), [], "a running phase still waits for its child");
  const res = abortTransition(inst, NOW);
  assert.ok(kinds(res).includes("abort"));
  assert.deepEqual(
    tasksOf(inst).map((t) => [t.state, t.reason]),
    [
      ["aborted", "aborted with its parent"],
      ["pending", undefined],
      ["pending", undefined],
    ],
  );
  assert.deepEqual(decidedChildren(inst), ["child-a"], "its abort is owed");
});
