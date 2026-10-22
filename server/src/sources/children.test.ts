import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPAWN_INCLUDE_NAME_RE,
  SPAWN_KEY_RE,
  blockedTasks,
  buildPhaseChildren,
  buildSpawnPayload,
  childDecisionPhase,
  childObservation,
  childrenOutcome,
  clipText,
  initialTasks,
  nextSpawns,
  parentDecision,
  printSpawnPath,
  readSpawnItems,
  resolveSpawnInclude,
  spawnItemsError,
  spawnItemsOf,
  spawnLimits,
  spawnParentRef,
  spawnPayloadFor,
  spawnPhasesFedBy,
  spawnsMoreOf,
  summarizeChildren,
  taskStateFor,
  type ChildObservation,
} from "./children.js";
import { unorderedNodes } from "./dag.js";
import type {
  InstanceStatus,
  PhaseChildren,
  PhaseDef,
  PhaseProgress,
  PhaseStatus,
  PipelineDefinition,
  PipelineInstance,
  SpawnPolicy,
  SpawnTask,
  SpawnTaskState,
} from "./pipelineTypes.js";

const spawn = (extra: Partial<SpawnPolicy> = {}): SpawnPolicy => ({
  pipelineId: "task",
  items: { phase: "plan", path: ["tasks"] },
  key: "id",
  dependsOn: "after",
  title: "title",
  ...extra,
});

const progress = (
  id: string,
  status: PhaseStatus,
  extra: Partial<PhaseProgress> = {},
): PhaseProgress => ({
  id,
  name: `Phase ${id}`,
  gated: false,
  status,
  steps: [],
  attempt: 1,
  payload: null,
  ...extra,
});

const phaseDef = (id: string, extra: Partial<PhaseDef> = {}): PhaseDef => ({
  id,
  name: id,
  cwd: "/tmp",
  steps: [{ name: "s", prompt: "p" }],
  gated: false,
  ...extra,
});

const definition = (phases: PhaseDef[]): PipelineDefinition => ({
  id: "parent",
  name: "Parent",
  phases,
  trigger: null,
  enabled: true,
  overlapPolicy: "skip",
  lastStartedAt: null,
  createdAt: "2026-10-21T12:00:00.000Z",
  updatedAt: "2026-10-21T12:00:00.000Z",
});

let taskCount = 0;
const task = (state: SpawnTaskState, extra: Partial<SpawnTask> = {}): SpawnTask => ({
  key: `t${++taskCount}`,
  state,
  ...extra,
});

/** A parent with a `plan` phase whose result holds `tasks`, and the spawn phase `build`. */
const parentOf = (planResult: unknown, extra: PhaseProgress[] = []) => ({
  id: "parent-1",
  pipelineId: "parent",
  phases: [
    progress("plan", "succeeded", { attempt: 2, result: planResult }),
    progress("build", "running"),
    ...extra,
  ],
});

const refusal = (check: { ok: boolean; reason?: string }): string | undefined =>
  check.ok ? undefined : check.reason;

// ── The item check ────────────────────────────────────────────────────────────

test("readSpawnItems reads a list: positions, keys, clipped titles and dependencies", () => {
  const list = [
    { id: "a", title: "x".repeat(70) },
    { id: "b", after: ["a", "a"], title: "  Second  " },
    { id: "c", after: null, title: "   " },
    { id: "d", after: ["c", "a"] },
    { id: "e", after: ["f"] },
    { id: "f" },
  ];
  const read = readSpawnItems(spawn(), { tasks: list });
  assert.ok(read.ok, `the list is accepted: ${refusal(read)}`);
  assert.deepEqual(
    read.items.map(({ index, key, title, dependsOn }) => ({ index, key, title, dependsOn })),
    [
      { index: 0, key: "a", title: `${"x".repeat(59)}…`, dependsOn: [] },
      { index: 1, key: "b", title: "Second", dependsOn: [0] },
      { index: 2, key: "c", title: undefined, dependsOn: [] },
      { index: 3, key: "d", title: undefined, dependsOn: [2, 0] },
      { index: 4, key: "e", title: undefined, dependsOn: [5] },
      { index: 5, key: "f", title: undefined, dependsOn: [] },
    ],
    "positions in list order, duplicates dropped, a later task may be waited for",
  );
  assert.equal(read.items[0].title?.length, 60, "a title is clipped to 60 characters");
  assert.ok(!("title" in read.items[2]), "a blank title is no title");
  read.items.forEach((item, i) =>
    assert.equal(item.task, list[i], `task ${i + 1} is the result's own object`),
  );
});

test("readSpawnItems: no dependsOn or title field means no ordering and no titles", () => {
  const read = readSpawnItems(spawn({ dependsOn: undefined, title: undefined }), {
    tasks: [{ id: "a", after: ["b"], title: "A" }, { id: "b" }],
  });
  assert.ok(read.ok, `accepted: ${refusal(read)}`);
  assert.deepEqual(
    read.items.map((i) => [i.dependsOn, i.title]),
    [
      [[], undefined],
      [[], undefined],
    ],
    "the properties are not read",
  );
});

test("readSpawnItems reads the path: the whole result, nested objects, never through a list", () => {
  const top = readSpawnItems(spawn({ items: { phase: "plan", path: [] } }), [{ id: "a" }]);
  assert.ok(top.ok && top.items[0].key === "a", "path [] reads a top-level list");
  const nested = readSpawnItems(spawn({ items: { phase: "plan", path: ["plan", "tasks"] } }), {
    plan: { tasks: [{ id: "a" }, { id: "b" }] },
  });
  assert.ok(nested.ok && nested.items.length === 2, "a nested path reads the list");
  assert.equal(
    refusal(
      readSpawnItems(spawn({ items: { phase: "plan", path: ["plans", "0", "tasks"] } }), {
        plans: [{ tasks: [{ id: "a" }] }],
      }),
    ),
    "the task list at plans.0.tasks is missing",
    "a path through a list is missing",
  );
  assert.equal(
    refusal(readSpawnItems(spawn({ items: { phase: "plan", path: [] } }), { id: "a" })),
    "the task list at the whole result is not a list",
    "the whole result is named as such",
  );
});

test("readSpawnItems refuses every malformed list with a line an agent can act on", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
  const cases: Array<[string, SpawnPolicy, unknown, string]> = [
    ["missing", spawn(), { other: [] }, "the task list at tasks is missing"],
    ["no result at all", spawn(), undefined, "the task list at tasks is missing"],
    ["not a list", spawn(), { tasks: { id: "a" } }, "the task list at tasks is not a list"],
    [
      "empty",
      spawn(),
      { tasks: [] },
      "the task list at tasks is empty; a spawn phase needs at least one task",
    ],
    [
      "over the default maxItems",
      spawn(),
      { tasks: many(21) },
      "the task list at tasks has 21 tasks; at most 20 are allowed (spawn.maxItems)",
    ],
    [
      "over an explicit maxItems",
      spawn({ maxItems: 2 }),
      { tasks: many(3) },
      "the task list at tasks has 3 tasks; at most 2 are allowed (spawn.maxItems)",
    ],
    ["a string task", spawn(), { tasks: [{ id: "a" }, "b"] }, "task 2 is not an object"],
    ["a list task", spawn(), { tasks: [[{ id: "a" }]] }, "task 1 is not an object"],
    ["a null task", spawn(), { tasks: [null] }, "task 1 is not an object"],
    ["no key", spawn(), { tasks: [{ name: "a" }] }, 'task 1 has no "id" string'],
    ["an empty key", spawn(), { tasks: [{ id: "" }] }, 'task 1 has no "id" string'],
    ["a number key", spawn(), { tasks: [{ id: 5 }] }, 'task 1 has no "id" string'],
    ...["a b", "-x", "a".repeat(65)].map((key): [string, SpawnPolicy, unknown, string] => [
      `the key ${key.slice(0, 8)}`,
      spawn(),
      { tasks: [{ id: key }] },
      `task 1: "id" ${JSON.stringify(key)} must be 1-64 letters, digits, ".", "-" or "_" ` +
        `and start with a letter or digit`,
    ]),
    [
      "a duplicate key",
      spawn(),
      { tasks: [{ id: "a" }, { id: "b" }, { id: "a" }] },
      'tasks 1 and 3 share the id "a"; every task needs its own',
    ],
    [
      "a task over 16 KiB (bytes, not characters)",
      spawn(),
      { tasks: [{ id: "big", body: "é".repeat(9000) }] },
      'task "big" is 18022 bytes as JSON; a task may be at most 16384',
    ],
    [
      "dependsOn not a list",
      spawn(),
      { tasks: [{ id: "a" }, { id: "b", after: "a" }] },
      'task "b": "after" must be a list of task ids',
    ],
    [
      "dependsOn holding a number",
      spawn(),
      { tasks: [{ id: "a" }, { id: "b", after: [0] }] },
      'task "b": "after" must be a list of task ids',
    ],
    [
      "a self-dependency",
      spawn(),
      { tasks: [{ id: "a", after: ["a"] }] },
      'task "a" depends on itself',
    ],
    [
      "an unknown dependency",
      spawn(),
      { tasks: [{ id: "a" }, { id: "b", after: ["a", "zz"] }] },
      'task "b" depends on "zz", which is not in the task list',
    ],
    [
      "a 3-cycle and a task behind it",
      spawn(),
      {
        tasks: [
          { id: "c", after: ["b"] },
          { id: "a", after: ["c"] },
          { id: "ok" },
          { id: "b", after: ["a"] },
          { id: "d", after: ["a", "ok"] },
        ],
      },
      "tasks form a dependency cycle: a, b, c, d",
    ],
  ];
  for (const [name, policy, result, message] of cases) {
    assert.equal(refusal(readSpawnItems(policy, result)), message, name);
  }
});

test("the key and include-name patterns", () => {
  for (const ok of ["a", "A1", "1a", "a.b-c_d", "x".repeat(64)]) {
    assert.ok(SPAWN_KEY_RE.test(ok), `${ok.slice(0, 8)} is a key`);
  }
  for (const bad of ["", ".a", "_a", "a/b", "a b", "x".repeat(65)]) {
    assert.ok(!SPAWN_KEY_RE.test(bad), `${bad.slice(0, 8)} is not a key`);
  }
  assert.ok(SPAWN_INCLUDE_NAME_RE.test("spec_path-1"), "an include name");
  assert.ok(!SPAWN_INCLUDE_NAME_RE.test("spec.path"), "no dots in an include name");
  assert.ok(!SPAWN_INCLUDE_NAME_RE.test("x".repeat(41)), "at most 40 characters");
});

test("spawnItemsError asks only the spawn phases that read the phase", () => {
  const plain = definition([phaseDef("plan"), phaseDef("build")]);
  assert.equal(spawnItemsError(plain, "plan", { nothing: true }), null, "no spawn phase");
  const def = definition([
    phaseDef("plan"),
    phaseDef("one", { steps: [], spawn: spawn() }),
    phaseDef("two", { steps: [], spawn: spawn({ items: { phase: "plan", path: ["more"] } }) }),
    phaseDef("other", { steps: [], spawn: spawn({ items: { phase: "design", path: [] } }) }),
  ]);
  assert.equal(
    spawnItemsError(def, "build", { tasks: [] }),
    null,
    "a phase no spawn phase reads is not checked",
  );
  assert.equal(
    spawnItemsError(def, "plan", { tasks: [{ id: "a" }], more: [{ id: "b" }] }),
    null,
    "both lists usable",
  );
  assert.equal(
    spawnItemsError(def, "plan", { tasks: [{ id: "a" }], more: [] }),
    'the task list for spawn phase "two" is not usable: ' +
      "the task list at more is empty; a spawn phase needs at least one task",
    "the failing reader is named",
  );
  assert.equal(
    spawnItemsError(def, "plan", { tasks: "x" }),
    'the task list for spawn phase "one" is not usable: the task list at tasks is not a list',
    "the first failing reader is named",
  );
});

test("unorderedNodes: what Kahn's algorithm cannot order, sorted", () => {
  assert.deepEqual(
    unorderedNodes(
      new Map([
        ["a", []],
        ["b", ["a"]],
        ["c", ["a", "b"]],
      ]),
    ),
    [],
    "acyclic",
  );
  assert.deepEqual(
    unorderedNodes(
      new Map([
        ["z", ["y"]],
        ["y", ["z"]],
        ["w", ["y"]],
        ["a", []],
      ]),
    ),
    ["w", "y", "z"],
    "a cycle and what waits on it",
  );
  assert.deepEqual(
    unorderedNodes(new Map([["a", ["gone"]]])),
    [],
    "a dangling dependency counts as satisfied",
  );
});

test("spawnItemsOf reads the source phase's result, only once it succeeded", () => {
  const ok = spawnItemsOf(spawn(), parentOf({ tasks: [{ id: "a" }] }).phases);
  assert.ok(ok.ok && ok.items[0].key === "a", "a succeeded source");
  assert.equal(
    refusal(spawnItemsOf(spawn(), [progress("plan", "skipped")])),
    'spawn.items: phase "plan" has no result to read (it is skipped)',
    "a skipped source",
  );
  assert.equal(
    refusal(spawnItemsOf(spawn(), [progress("plan", "succeeded")])),
    'spawn.items: phase "plan" has no result to read (it is succeeded)',
    "a source without a result",
  );
  assert.equal(
    refusal(spawnItemsOf(spawn(), [])),
    'spawn.items: phase "plan" has no result to read (it is missing)',
    "no source phase",
  );
  assert.equal(
    refusal(spawnItemsOf(spawn(), parentOf({ tasks: [] }).phases)),
    "the task list at tasks is empty; a spawn phase needs at least one task",
    "the item check runs on the result",
  );
});

test("initialTasks: every task pending, compact", () => {
  const read = readSpawnItems(spawn(), {
    tasks: [
      { id: "a", title: "First" },
      { id: "b", after: ["a"] },
    ],
  });
  assert.ok(read.ok, `accepted: ${refusal(read)}`);
  assert.deepEqual(
    initialTasks(read.items),
    [
      { key: "a", title: "First", state: "pending" },
      { key: "b", dependsOn: [0], state: "pending" },
    ],
    "no empty title or dependsOn is stored",
  );
});

// ── Ordering, blocking and the outcome ────────────────────────────────────────

test("nextSpawns plans ready tasks in list order, as many as there is room for", () => {
  const chain = (states: SpawnTaskState[], maxParallel = 1) =>
    nextSpawns({
      maxParallel,
      tasks: [task(states[0], { dependsOn: [1] }), task(states[1]), task(states[2])],
    });
  assert.deepEqual(chain(["pending", "pending", "pending"]), [1], "a waits for b");
  assert.deepEqual(chain(["pending", "succeeded", "pending"]), [0], "then a, in list order");
  assert.deepEqual(
    chain(["pending", "pending", "pending"], 2),
    [1, 2],
    "two independent tasks at maxParallel 2",
  );
  assert.deepEqual(
    nextSpawns({ maxParallel: 1, tasks: [task("pending"), task("pending")] }),
    [0],
    "independent tasks one at a time",
  );
  for (const live of ["planned", "reviving", "running", "awaiting-approval"] as const) {
    assert.deepEqual(
      nextSpawns({ maxParallel: 1, tasks: [task(live), task("pending")] }),
      [],
      `no room beside a ${live} task`,
    );
  }
  assert.deepEqual(
    nextSpawns({ maxParallel: 2, tasks: [task("running"), task("pending"), task("pending")] }),
    [1],
    "one slot left",
  );
  for (const stopped of ["failed", "aborted"] as const) {
    assert.deepEqual(
      nextSpawns({ maxParallel: 2, tasks: [task("succeeded"), task(stopped), task("pending")] }),
      [],
      `nothing new spawns once a task is ${stopped}`,
    );
  }
  assert.deepEqual(
    nextSpawns({ maxParallel: 1, tasks: [task("pending", { dependsOn: [1] }), task("running")] }),
    [],
    "a dependency still running is not met",
  );
});

test("blockedTasks runs down a chain from a failure, and clears with it", () => {
  assert.deepEqual(
    [
      ...blockedTasks([
        task("failed"),
        task("pending", { dependsOn: [0] }),
        task("pending", { dependsOn: [1] }),
        task("pending"),
        task("succeeded", { dependsOn: [0] }),
      ]),
    ].sort(),
    [1, 2],
    "the chain behind the failure; not the independent task, not a finished one",
  );
  assert.deepEqual(
    [
      ...blockedTasks([
        task("pending", { dependsOn: [2] }),
        task("aborted"),
        task("blocked", { dependsOn: [1] }),
      ]),
    ].sort(),
    [0, 2],
    "an abort blocks too, through a task listed later",
  );
  assert.equal(
    blockedTasks([
      task("reviving"),
      task("blocked", { dependsOn: [0] }),
      task("blocked", { dependsOn: [1] }),
    ]).size,
    0,
    "a failed task being revived unblocks the whole chain",
  );
  assert.equal(blockedTasks([task("pending"), task("running")]).size, 0, "no failure");
});

test("childrenOutcome: joined, still live, or halted for a person", () => {
  const outcome = (tasks: SpawnTask[]) => childrenOutcome({ maxParallel: 1, tasks });
  assert.equal(outcome([task("succeeded"), task("succeeded")]), "succeeded", "all succeeded");
  assert.equal(outcome([task("succeeded"), task("running")]), "live", "a live child");
  assert.equal(outcome([task("succeeded"), task("pending")]), "live", "a plannable task");
  assert.equal(
    outcome([task("failed"), task("running")]),
    "live",
    "running children finish before the pause",
  );
  assert.equal(
    outcome([task("failed"), task("blocked", { dependsOn: [0] }), task("pending")]),
    "halted",
    "a failure with nothing live",
  );
  assert.equal(outcome([task("succeeded"), task("aborted")]), "halted", "an abort");
});

// ── Observing a child ─────────────────────────────────────────────────────────

test("childObservation reads a child's record", () => {
  const child = (
    status: InstanceStatus,
    phases: PhaseProgress[],
    extra: Pick<PipelineInstance, "abortCause"> = {},
  ) => ({
    status,
    phases,
    ...extra,
  });
  assert.deepEqual(
    childObservation(2, "c-1", null),
    { index: 2, instanceId: "c-1", status: "missing" },
    "no file",
  );
  for (const status of ["running", "succeeded"] as const) {
    assert.deepEqual(
      childObservation(0, "c-1", child(status, [progress("p1", status)]), true),
      { index: 0, instanceId: "c-1", status },
      `${status}: nothing more (revised is for a failure only)`,
    );
  }
  assert.deepEqual(
    childObservation(
      0,
      "c-1",
      child("awaiting-approval", [
        progress("p1", "succeeded"),
        progress("p2", "awaiting-approval"),
      ]),
    ),
    { index: 0, instanceId: "c-1", status: "awaiting-approval", waitingPhaseId: "p2" },
    "the waiting phase",
  );
  const failedWith = (payload: unknown, revised = false) =>
    childObservation(
      0,
      "c-1",
      child("failed", [progress("p1", "succeeded"), progress("p2", "failed", { payload })]),
      revised,
    );
  assert.equal(failedWith("  boom  ").reason, 'phase "p2" failed: boom', "a string payload");
  assert.equal(
    failedWith({ reason: "tests failed", class: "verification" }).reason,
    'phase "p2" failed: tests failed',
    "a failure payload's reason",
  );
  assert.equal(
    failedWith(null).reason,
    'phase "p2" failed: no reason recorded',
    "no reason recorded",
  );
  const long = failedWith("x".repeat(500)).reason ?? "";
  assert.equal(long.length, 200, "clipped to 200 characters");
  assert.ok(long.endsWith("…"), "clipped visibly");
  assert.equal(failedWith("boom").revised, undefined, "not revised unless told");
  assert.equal(failedWith("boom", true).revised, true, "revised");
  assert.equal(
    childObservation(0, "c-1", child("failed", [progress("p1", "succeeded")])).reason,
    "failed",
    "no failed phase to name",
  );
  assert.deepEqual(
    childObservation(0, "c-1", child("aborted", [], { abortCause: "parent-aborted" })),
    { index: 0, instanceId: "c-1", status: "aborted", reason: "aborted (parent-aborted)" },
    "the abort cause",
  );
  assert.equal(childObservation(0, "c-1", child("aborted", [])).reason, "aborted", "a plain abort");
});

test("taskStateFor: every cell of the observation table", () => {
  const FAILED = 'phase "p" failed: boom';
  const obs = (status: ChildObservation["status"], extra: Partial<ChildObservation> = {}) =>
    ({
      index: 0,
      instanceId: "c-1",
      status,
      ...(status === "awaiting-approval" ? { waitingPhaseId: "review" } : {}),
      ...(status === "failed" ? { reason: FAILED } : {}),
      ...(status === "aborted" ? { reason: "aborted" } : {}),
      ...extra,
    }) as ChildObservation;
  const RUNNING = { state: "running" };
  const WAITING = { state: "awaiting-approval", waitingPhaseId: "review" };
  const SUCCEEDED = { state: "succeeded" };
  const FAILS = { state: "failed", reason: FAILED };
  const ABORTED = { state: "aborted", reason: "aborted" };
  const GONE = { state: "aborted", reason: "the child instance is gone" };
  type Row = Partial<Record<ChildObservation["status"] | "failed (revised)", object | null>>;
  const table: Record<SpawnTaskState, Row> = {
    planned: {
      running: RUNNING,
      "awaiting-approval": WAITING,
      succeeded: SUCCEEDED,
      failed: FAILS,
      "failed (revised)": FAILS,
      aborted: ABORTED,
      missing: null,
    },
    reviving: {
      running: RUNNING,
      "awaiting-approval": WAITING,
      succeeded: SUCCEEDED,
      failed: null,
      "failed (revised)": FAILS,
      aborted: ABORTED,
      missing: null,
    },
    running: {
      running: null,
      "awaiting-approval": WAITING,
      succeeded: SUCCEEDED,
      failed: FAILS,
      "failed (revised)": FAILS,
      aborted: ABORTED,
      missing: GONE,
    },
    "awaiting-approval": {
      running: RUNNING,
      "awaiting-approval": null,
      succeeded: SUCCEEDED,
      failed: FAILS,
      "failed (revised)": FAILS,
      aborted: ABORTED,
      missing: GONE,
    },
    failed: {
      running: RUNNING,
      "awaiting-approval": WAITING,
      succeeded: SUCCEEDED,
      failed: null,
      "failed (revised)": null,
      aborted: null,
      missing: null,
    },
    pending: {},
    blocked: {},
    succeeded: {},
    aborted: {},
  };
  const columns = [
    "running",
    "awaiting-approval",
    "succeeded",
    "failed",
    "failed (revised)",
    "aborted",
    "missing",
  ] as const;
  for (const [state, row] of Object.entries(table) as Array<[SpawnTaskState, Row]>) {
    const current: Pick<SpawnTask, "state" | "waitingPhaseId" | "reason"> = { state };
    if (state === "awaiting-approval") current.waitingPhaseId = "review";
    if (state === "failed") current.reason = "an older failure";
    for (const column of columns) {
      const observed =
        column === "failed (revised)" ? obs("failed", { revised: true }) : obs(column);
      assert.deepEqual(
        taskStateFor(current, observed),
        row[column] ?? null,
        `${state} task, child ${column}`,
      );
    }
  }
});

test("taskStateFor: a moved gate, a changed reason, and nothing new", () => {
  const waiting = { state: "awaiting-approval" as const, waitingPhaseId: "review" };
  const gate = (phase: string): ChildObservation => ({
    index: 0,
    instanceId: "c-1",
    status: "awaiting-approval",
    waitingPhaseId: phase,
  });
  assert.equal(taskStateFor(waiting, gate("review")), null, "the same gate is no change");
  assert.deepEqual(
    taskStateFor(waiting, gate("merge")),
    { state: "awaiting-approval", waitingPhaseId: "merge" },
    "a later gate of the same child is a change",
  );
  assert.deepEqual(
    taskStateFor(
      { state: "running", reason: "a stale reason" },
      { index: 0, instanceId: "c-1", status: "running" },
    ),
    { state: "running" },
    "a reason that no longer holds is dropped",
  );
});

// ── Payload, summary and the parent check ─────────────────────────────────────

test("resolveSpawnInclude copies named values from earlier results", () => {
  assert.deepEqual(resolveSpawnInclude(spawn(), []), { ok: true }, "no include, no values");
  const phases = [
    progress("design", "succeeded", {
      result: { spec: { path: "docs/spec.md" }, commit: "abc123", list: [1, 2] },
    }),
  ];
  assert.deepEqual(
    resolveSpawnInclude(
      spawn({
        include: {
          spec: { phase: "design", path: ["spec", "path"] },
          commit: { phase: "design", path: ["commit"] },
          list: { phase: "design", path: ["list"] },
          gone: { phase: "design", path: ["nope"] },
          whole: { phase: "design", path: [] },
        },
      }),
      phases,
    ),
    {
      ok: true,
      values: {
        spec: "docs/spec.md",
        commit: "abc123",
        list: [1, 2],
        gone: null,
        whole: { spec: { path: "docs/spec.md" }, commit: "abc123", list: [1, 2] },
      },
    },
    "values, a list leaf, a missing path as null, the whole result",
  );
  // A name is the author's, even `__proto__` (the validator keeps it): it
  // stays an own property, so the child's payload carries it.
  const include = JSON.parse(
    '{ "__proto__": { "phase": "design", "path": ["commit"] } }',
  ) as SpawnPolicy["include"];
  const proto = resolveSpawnInclude(spawn({ include }), phases);
  assert.ok(proto.ok, `resolved: ${refusal(proto)}`);
  assert.deepEqual(Object.keys(proto.values ?? {}), ["__proto__"], "an include named __proto__");
  assert.equal(Object.getPrototypeOf(proto.values), Object.prototype, "is no prototype");
  const payload = buildSpawnPayload({
    spawn: spawn({ include }),
    item: { key: "a", task: { id: "a" } },
    include: proto.values,
    parent: spawnParentRef({ id: "parent-1", pipelineId: "parent" }, "build", {
      index: 0,
      key: "a",
    }),
  });
  assert.ok(payload.ok, `built: ${refusal(payload)}`);
  assert.equal(
    JSON.stringify(payload.payload.include),
    '{"__proto__":"abc123"}',
    "and reaches the child's payload",
  );
  assert.equal(
    refusal(
      resolveSpawnInclude(spawn({ include: { spec: { phase: "design", path: [] } } }), [
        progress("design", "running"),
      ]),
    ),
    'spawn.include.spec: phase "design" has no result to read (it is running)',
    "a source not succeeded",
  );
  assert.equal(
    refusal(resolveSpawnInclude(spawn({ include: { spec: { phase: "design", path: [] } } }), [])),
    'spawn.include.spec: phase "design" has no result to read (it is missing)',
    "no source phase",
  );
});

test("buildSpawnPayload: a fixed key order, omitted extras, a size cap", () => {
  const parent = spawnParentRef({ id: "parent-1", pipelineId: "parent" }, "build", {
    index: 0,
    key: "a",
  });
  assert.deepEqual(
    parent,
    { instanceId: "parent-1", pipelineId: "parent", phaseId: "build", index: 0, key: "a" },
    "the parent link",
  );
  const item = { key: "a", task: { id: "a", goal: "do it" } };
  const full = buildSpawnPayload({
    spawn: spawn({ base: "origin/main" }),
    item,
    include: { spec: "docs/spec.md" },
    parent,
  });
  assert.ok(full.ok, `built: ${refusal(full)}`);
  assert.deepEqual(
    Object.keys(full.payload),
    ["task", "key", "base", "include", "parent"],
    "key order",
  );
  assert.equal(full.bytes, Buffer.byteLength(JSON.stringify(full.payload), "utf8"), "its size");
  assert.equal(full.payload.task, item.task, "the task exactly as the result held it");
  const bare = buildSpawnPayload({ spawn: spawn(), item, include: {}, parent });
  assert.ok(bare.ok, `built: ${refusal(bare)}`);
  assert.deepEqual(Object.keys(bare.payload), ["task", "key", "parent"], "no base, no include");
  const again = buildSpawnPayload({ spawn: spawn(), item, include: {}, parent });
  assert.equal(JSON.stringify(again), JSON.stringify(bare), "deterministic");

  const include = { small: "x", big: "y".repeat(70_000), none: null };
  const over = buildSpawnPayload({ spawn: spawn(), item, include, parent });
  const bytes = Buffer.byteLength(
    JSON.stringify({ task: item.task, key: "a", include, parent }),
    "utf8",
  );
  assert.equal(
    refusal(over),
    `task "a": its spawn payload is ${bytes} bytes, over the 65536-byte cap; ` +
      `the largest include is "big" (70002 bytes)`,
    "over 64 KiB, naming the largest include",
  );
  const huge = buildSpawnPayload({
    spawn: spawn(),
    item: { key: "a", task: { id: "a", body: "z".repeat(70_000) } },
    parent,
  });
  assert.match(refusal(huge) ?? "", /over the 65536-byte cap$/, "no include to name");
});

test("buildPhaseChildren builds the task list, or says why the phase cannot start", () => {
  const inst = parentOf({
    tasks: [
      { id: "a", title: "First" },
      { id: "b", after: ["a"] },
    ],
  });
  assert.deepEqual(
    buildPhaseChildren(spawn(), inst, "build"),
    {
      ok: true,
      children: {
        pipelineId: "task",
        source: { phaseId: "plan", attempt: 2 },
        maxParallel: 1,
        tasks: [
          { key: "a", title: "First", state: "pending" },
          { key: "b", dependsOn: [0], state: "pending" },
        ],
      },
    },
    "every task pending, the source attempt frozen",
  );
  assert.equal(
    refusal(buildPhaseChildren(spawn(), parentOf({ tasks: [] }), "build")),
    'spawn phase "build": the task list at tasks is empty; a spawn phase needs at least one task',
    "the item check, prefixed",
  );
  assert.equal(
    refusal(
      buildPhaseChildren(
        spawn({ include: { spec: { phase: "design", path: ["spec"] } } }),
        inst,
        "build",
      ),
    ),
    'spawn phase "build": spawn.include.spec: phase "design" has no result to read ' +
      "(it is missing)",
    "the include check, prefixed",
  );
  const big = parentOf({ tasks: [{ id: "a" }] }, [
    progress("design", "succeeded", { result: { spec: "s".repeat(70_000) } }),
  ]);
  assert.match(
    refusal(
      buildPhaseChildren(
        spawn({ include: { spec: { phase: "design", path: ["spec"] } } }),
        big,
        "build",
      ),
    ) ?? "",
    /^spawn phase "build": task "a": its spawn payload is \d+ bytes, over the 65536-byte cap; the largest include is "spec"/,
    "an oversized payload fails the phase before any child starts",
  );
});

test("spawnPayloadFor rebuilds one task's payload from the parent's results", () => {
  const inst = parentOf({ tasks: [{ id: "a" }, { id: "b", after: ["a"] }] }, [
    progress("design", "succeeded", { result: { spec: "docs/spec.md" } }),
  ]);
  const policy = spawn({ base: "main", include: { spec: { phase: "design", path: ["spec"] } } });
  const built = spawnPayloadFor(policy, inst, "build", 1, "b");
  assert.ok(built.ok, `built: ${refusal(built)}`);
  assert.deepEqual(
    built.payload,
    {
      task: { id: "b", after: ["a"] },
      key: "b",
      base: "main",
      include: { spec: "docs/spec.md" },
      parent: {
        instanceId: "parent-1",
        pipelineId: "parent",
        phaseId: "build",
        index: 1,
        key: "b",
      },
    },
    "the task, its key, the base, the include and the parent link",
  );
  assert.equal(
    refusal(spawnPayloadFor(policy, inst, "build", 0, "b")),
    'task "b" is no longer at position 1 of the task list',
    "a task that moved",
  );
  assert.equal(
    refusal(spawnPayloadFor(policy, inst, "build", 5, "b")),
    'task "b" is no longer at position 6 of the task list',
    "a position past the end",
  );
  assert.equal(
    refusal(spawnPayloadFor(policy, { ...inst, phases: [] }, "build", 0, "a")),
    'spawn.items: phase "plan" has no result to read (it is missing)',
    "the item check's refusal",
  );
  assert.equal(
    refusal(spawnPayloadFor(policy, { ...inst, phases: inst.phases.slice(0, 2) }, "build", 0, "a")),
    'spawn.include.spec: phase "design" has no result to read (it is missing)',
    "the include's refusal",
  );
});

test("summarizeChildren: every task in order, counts, what did not succeed", () => {
  const children: PhaseChildren = {
    pipelineId: "task",
    source: { phaseId: "plan", attempt: 1 },
    maxParallel: 1,
    tasks: [
      { key: "a", title: "First", state: "succeeded", instanceId: "c-1", dependsOn: [] },
      { key: "b", state: "failed", instanceId: "c-2", reason: "boom" },
      { key: "c", state: "blocked", dependsOn: [1] },
      { key: "d", state: "succeeded", instanceId: "c-4", previousInstanceIds: ["c-3"] },
    ],
  };
  assert.deepEqual(
    summarizeChildren(children),
    {
      pipelineId: "task",
      tasks: [
        { key: "a", title: "First", state: "succeeded", instanceId: "c-1" },
        { key: "b", state: "failed", instanceId: "c-2" },
        { key: "c", state: "blocked" },
        { key: "d", state: "succeeded", instanceId: "c-4" },
      ],
      counts: { succeeded: 2, failed: 1, blocked: 1 },
      notSucceeded: ["b", "c"],
    },
    "the summary",
  );
  assert.deepEqual(
    summarizeChildren({ ...children, tasks: [children.tasks[0]] }).notSucceeded,
    [],
    "empty on a join",
  );
});

test("spawnPhasesFedBy, spawnLimits, clipText and printSpawnPath", () => {
  const phases = [
    phaseDef("plan"),
    phaseDef("one", { steps: [], spawn: spawn() }),
    phaseDef("two", { steps: [], spawn: spawn({ items: { phase: "design", path: [] } }) }),
    phaseDef("three", { steps: [], spawn: spawn() }),
  ];
  assert.deepEqual(
    spawnPhasesFedBy(phases, "plan").map((p) => p.id),
    ["one", "three"],
    "the readers of plan, in order",
  );
  assert.deepEqual(spawnPhasesFedBy(phases, "one"), [], "nothing reads a spawn phase");
  assert.deepEqual(spawnLimits(spawn()), { maxParallel: 1, maxItems: 20 }, "the defaults");
  assert.deepEqual(
    spawnLimits(spawn({ maxParallel: 1, maxItems: 50 })),
    { maxParallel: 1, maxItems: 50 },
    "explicit limits",
  );
  assert.equal(clipText("abc", 3), "abc", "short enough");
  assert.equal(clipText("abcd", 3), "ab…", "clipped to the limit, ellipsis included");
  assert.equal(printSpawnPath(["plan", "tasks"]), "plan.tasks", "a dotted path");
  assert.equal(printSpawnPath([]), "the whole result", "the empty path");
});

test("spawnsMoreOf: a live instance that may still start the pipeline", () => {
  const def = definition([
    phaseDef("plan"),
    phaseDef("build", { steps: [], spawn: spawn() }),
    phaseDef("ship"),
  ]);
  const inst = (status: PhaseStatus | null, withDef = true) =>
    ({
      ...(withDef ? { definition: def } : {}),
      phases: status ? [progress("plan", "succeeded"), progress("build", status)] : [],
    }) as Pick<PipelineInstance, "definition" | "phases">;
  for (const status of ["pending", "running", "awaiting-approval", "failed"] as const) {
    assert.equal(spawnsMoreOf(inst(status), "task"), true, `a spawn phase ${status}`);
  }
  assert.equal(spawnsMoreOf(inst(null), "task"), true, "no progress entry yet");
  for (const status of ["succeeded", "skipped"] as const) {
    assert.equal(spawnsMoreOf(inst(status), "task"), false, `a spawn phase ${status}`);
  }
  assert.equal(spawnsMoreOf(inst("running"), "other"), false, "another target");
  assert.equal(spawnsMoreOf(inst("running", false), "task"), false, "no definition snapshot");
});

test("parentDecision: a child's decision counts only while its parent waits for it", () => {
  const link = {
    instanceId: "parent-1",
    pipelineId: "parent",
    phaseId: "build",
    index: 1,
    key: "b",
  };
  const child = { id: "c-2", parent: link };
  const children = (tasks: SpawnTask[]): PhaseChildren => ({
    pipelineId: "task",
    source: { phaseId: "plan", attempt: 1 },
    maxParallel: 1,
    tasks,
  });
  const live = children([
    { key: "a", state: "failed", instanceId: "c-1" },
    { key: "b", state: "running", instanceId: "c-2" },
  ]);
  const parent = (
    status: InstanceStatus,
    phase: PhaseProgress | null = progress("build", "running", { children: live }),
  ) => ({
    id: "parent-1",
    status,
    phases: [progress("plan", "succeeded"), ...(phase ? [phase] : [])],
  });

  assert.equal(parentDecision({ id: "x" }, parent("running")), null, "not a spawned child");
  assert.equal(parentDecision(child, null), null, "the parent's record is gone");
  assert.equal(parentDecision(child, parent("running")), null, "the spawn phase runs");
  assert.equal(
    parentDecision(
      child,
      parent(
        "awaiting-approval",
        progress("build", "awaiting-approval", {
          pause: "children",
          children: children([
            { key: "a", state: "failed", instanceId: "c-1" },
            { key: "b", state: "reviving", instanceId: "c-2", reviveDecisionId: "GD-1" },
          ]),
        }),
      ),
    ),
    null,
    "paused at children, the task reviving",
  );
  for (const status of ["succeeded", "failed", "aborted"] as const) {
    assert.equal(
      parentDecision(child, parent(status)),
      `its parent parent-1 has ${status}`,
      `a ${status} parent`,
    );
  }
  for (const status of ["succeeded", "skipped", "failed", "pending"] as const) {
    assert.equal(
      parentDecision(child, parent("running", progress("build", status, { children: live }))),
      `its parent's spawn phase "build" is ${status}`,
      `the spawn phase ${status}`,
    );
  }
  assert.equal(
    parentDecision(
      child,
      parent(
        "awaiting-approval",
        progress("build", "awaiting-approval", { pause: "gate", children: live }),
      ),
    ),
    `its parent's spawn phase "build" is awaiting-approval`,
    "a pause that is not the children's",
  );
  assert.equal(
    parentDecision(child, parent("running", null)),
    `its parent's spawn phase "build" is gone`,
    "no spawn phase",
  );
  const withTask = (tasks: SpawnTask[]) =>
    parent("running", progress("build", "running", { children: children(tasks) }));
  const first = { key: "a", state: "succeeded" as const, instanceId: "c-1" };
  assert.equal(
    parentDecision(child, withTask([first, { key: "b", state: "running", instanceId: "c-9" }])),
    'task "b" of its parent now runs in c-9',
    "a newer child replaced this one",
  );
  assert.equal(
    parentDecision(child, withTask([first, { key: "z", state: "running", instanceId: "c-8" }])),
    'task "b" of its parent now runs in c-8',
    "the task at that position has another key",
  );
  assert.equal(
    parentDecision(child, withTask([first])),
    'task "b" of its parent now runs in no instance',
    "no task at that position",
  );
  assert.equal(
    parentDecision(
      child,
      withTask([first, { key: "b", state: "failed", previousInstanceIds: ["c-2"] }]),
    ),
    'task "b" of its parent now runs in no instance',
    "a task whose child was dropped",
  );
});

test("childDecisionPhase: the gate a person would act on, else the failure", () => {
  assert.deepEqual(
    childDecisionPhase({
      phases: [
        progress("p1", "failed"),
        progress("p2", "awaiting-approval", { name: "Review", attempt: 3 }),
      ],
    }),
    { phaseId: "p2", phaseName: "Review", attempt: 3, status: "awaiting-approval" },
    "a waiting gate wins over an earlier failure",
  );
  assert.deepEqual(
    childDecisionPhase({
      phases: [progress("p1", "succeeded"), progress("p2", "failed", { attempt: 2 })],
    }),
    { phaseId: "p2", phaseName: "Phase p2", attempt: 2, status: "failed" },
    "a failure alone",
  );
  assert.equal(
    childDecisionPhase({ phases: [progress("p1", "succeeded"), progress("p2", "running")] }),
    undefined,
    "nothing to act on",
  );
});
