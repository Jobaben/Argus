import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// A static import: the store resolves pipelines.json from the per-test home
// lazily, and a cache-busting re-import would hide this file from coverage.
import * as pipelines from "./pipelines.js";

/**
 * Save-time rules for spawn phases (DL-A2a): the phase's own short field list,
 * the `spawn` object's shape, what the graph must guarantee (the task list
 * comes from a phase that finishes first and declares it), and the target
 * pipeline, checked from both sides.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-spawn-validation-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const phase = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});

const taskSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    dependsOn: { type: "array", items: { type: "string" } },
  },
};

const planSchema = {
  type: "object",
  required: ["tasks"],
  properties: { tasks: { type: "array", items: taskSchema }, spec: { type: "object" } },
};

const planPhase = (over: Record<string, unknown> = {}) =>
  phase("plan", { result: { artifact: "plan", schema: planSchema }, ...over });

const spawnOf = (over: Record<string, unknown> = {}) => ({
  pipelineId: "child",
  items: { phase: "plan", path: ["tasks"] },
  key: "id",
  dependsOn: "dependsOn",
  title: "title",
  ...over,
});

/** The spawn phase as an author writes it: no steps, not gated. */
const spawnPhase = (over: Record<string, unknown> = {}) => ({
  id: "tasks",
  name: "Tasks",
  cwd: home,
  needs: ["plan"],
  spawn: spawnOf(),
  ...over,
});

const input = (phases: unknown[], over: Record<string, unknown> = {}) => ({
  name: "Parent",
  trigger: null,
  phases,
  ...over,
});

/** `plan` then a spawn phase whose `spawn` is exactly `spawn`. */
const withSpawn = (spawn: unknown) => input([planPhase(), spawnPhase({ spawn })]);

function refused(raw: unknown, message: string | RegExp, why: string): void {
  assert.throws(
    () => pipelines.validatePipelineInput(raw),
    { name: "PipelineValidationError", message },
    why,
  );
}

// ── The spawn phase's own fields ─────────────────────────────────────────────

test("a spawn phase saves with zero steps and is stored as steps: [], gated: false", () => {
  const out = pipelines.validatePipelineInput(input([planPhase(), spawnPhase()]));
  assert.deepEqual(
    out.phases[1],
    {
      id: "tasks",
      name: "Tasks",
      cwd: home,
      steps: [],
      gated: false,
      needs: ["plan"],
      spawn: {
        pipelineId: "child",
        items: { phase: "plan", path: ["tasks"] },
        key: "id",
        dependsOn: "dependsOn",
        title: "title",
      },
    },
    "the stored phase keeps only what a spawn phase declares",
  );
});

test("steps and gated are accepted as [] / false, null, or absent", () => {
  for (const over of [{ steps: [], gated: false }, { steps: null, gated: null }, {}]) {
    const out = pipelines.validatePipelineInput(input([planPhase(), spawnPhase(over)]));
    assert.deepEqual(out.phases[1].steps, [], `steps stored as [] for ${JSON.stringify(over)}`);
    assert.equal(out.phases[1].gated, false, `gated stored as false for ${JSON.stringify(over)}`);
  }
});

test("spawn is normalized: trimmed, absent optionals absent, an empty include dropped", () => {
  const out = pipelines.validatePipelineInput(
    withSpawn({
      pipelineId: " child ",
      items: { phase: " plan ", path: [" tasks "] },
      key: " id ",
      dependsOn: null,
      title: undefined,
      maxParallel: null,
      include: {},
    }),
  );
  const spawn = out.phases[1].spawn;
  assert.deepEqual(
    spawn,
    { pipelineId: "child", items: { phase: "plan", path: ["tasks"] }, key: "id" },
    "trimmed, with every absent optional left out",
  );
});

test("every spawn field round-trips, in a stable key order", () => {
  const out = pipelines.validatePipelineInput(
    input([
      planPhase(),
      spawnPhase({
        produces: "work",
        spawn: spawnOf({
          maxParallel: 1,
          maxItems: "50",
          base: " origin/main ",
          include: { spec: { phase: "plan", path: ["spec"] }, whole: { phase: "plan", path: [] } },
        }),
      }),
    ]),
  );
  const stored = out.phases[1];
  assert.equal(stored.produces, "work", "produces is kept");
  assert.deepEqual(
    Object.keys(stored.spawn ?? {}),
    [
      "pipelineId",
      "items",
      "key",
      "dependsOn",
      "title",
      "maxParallel",
      "maxItems",
      "base",
      "include",
    ],
    "the key order is fixed",
  );
  assert.equal(stored.spawn?.maxItems, 50, "a numeric string is read as a number");
  assert.equal(stored.spawn?.base, "origin/main", "the base is trimmed");
  assert.deepEqual(
    stored.spawn?.include,
    { spec: { phase: "plan", path: ["spec"] }, whole: { phase: "plan", path: [] } },
    "include keeps every named source",
  );
  // A GET → PUT round trip sends the stored shape back.
  const again = pipelines.validatePipelineInput(JSON.parse(JSON.stringify(out)));
  assert.deepEqual(again.phases, out.phases, "the stored shape validates to itself");
});

const FORBIDDEN: Record<string, unknown> = {
  retry: { attempts: 2 },
  checks: [],
  rubric: {},
  autoApprove: {},
  // A spawn phase's gate is its `children` pause, a person's to decide.
  approveWhen: { kind: "command", run: "exit 0", everySeconds: 30 },
  runtime: "claude",
  timeoutSeconds: 60,
  stallSeconds: 60,
  capabilities: {},
  workspace: { scope: "instance" },
  knowledgeScope: {},
  candidates: {},
  knowledgeDelta: "optional",
  knowledgeContext: {},
  discovery: {},
  ruleVerification: {},
  changeIntent: {},
  changeContext: { fromPhase: "plan" },
  childrenContext: { fromPhase: "plan" },
  implementation: {},
  acceptanceVerification: {},
  result: { artifact: "x", schema: { type: "object" } },
  completion: { marker: "lenient" },
};

test("a spawn phase refuses every field that would belong to an agent", () => {
  for (const [key, value] of Object.entries(FORBIDDEN)) {
    // Refused with advice of its own: see the childrenContext tests below.
    if (key === "childrenContext") continue;
    refused(
      input([planPhase(), spawnPhase({ [key]: value })]),
      `phase 1: a spawn phase runs no agent of its own, so it cannot declare ${key}; ` +
        "put it on the spawned pipeline's phases",
      `${key} is refused on a spawn phase`,
    );
  }
});

test("the same fields set to null are accepted, as absent", () => {
  const nulls = Object.fromEntries(Object.keys(FORBIDDEN).map((k) => [k, null]));
  const out = pipelines.validatePipelineInput(input([planPhase(), spawnPhase(nulls)]));
  for (const key of Object.keys(FORBIDDEN)) {
    assert.equal(key in out.phases[1], false, `${key}: null is dropped`);
  }
});

test("a spawn phase refuses steps and a gate", () => {
  refused(
    input([planPhase(), spawnPhase({ steps: [{ name: "s", prompt: "p" }] })]),
    "phase 1: a spawn phase has no steps; its work runs in the spawned pipeline's instances",
    "a step is refused",
  );
  refused(
    input([planPhase(), spawnPhase({ steps: "none" })]),
    /a spawn phase has no steps/,
    "steps that are not a list are refused",
  );
  refused(
    input([planPhase(), spawnPhase({ gated: true })]),
    "phase 1: a spawn phase cannot be gated; it waits for you by itself when a child fails, " +
      "and each task is reviewed at its child's own gates",
    "gated: true is refused",
  );
});

test("a phase without spawn still needs at least one step", () => {
  refused(
    input([planPhase(), phase("tasks", { steps: [] })]),
    /phase 1: needs at least one step/,
    "zero steps without spawn",
  );
  refused(
    input([planPhase(), phase("tasks", { steps: [], spawn: null })]),
    /phase 1: needs at least one step/,
    "spawn: null is absent",
  );
});

test("a spawn phase's needs and produces are held to the usual rules", () => {
  refused(
    input([planPhase(), spawnPhase({ needs: "plan" })]),
    "phase 1: needs must be a list of phase ids",
    "needs must be a list",
  );
  refused(
    input([planPhase(), spawnPhase({ produces: "no spaces" })]),
    "phase 1: produces must be a short name of letters, digits, - or _",
    "produces is a short name",
  );
});

// ── The spawn object ─────────────────────────────────────────────────────────

test("spawn must be an object of known keys", () => {
  for (const bad of ["child", [], 1, true]) {
    refused(withSpawn(bad), "phase 1: spawn must be an object", `spawn ${JSON.stringify(bad)}`);
  }
  refused(
    withSpawn(spawnOf({ parallel: 2 })),
    'phase 1: spawn has unknown key "parallel"',
    "an unknown key is refused",
  );
});

test("spawn.pipelineId names a pipeline", () => {
  for (const pipelineId of [undefined, "", "  ", 7]) {
    refused(
      withSpawn(spawnOf({ pipelineId })),
      "phase 1: spawn.pipelineId must name the pipeline each child runs",
      `pipelineId ${JSON.stringify(pipelineId)}`,
    );
  }
});

test("spawn.items is { phase, path }", () => {
  for (const items of [undefined, null, "plan", ["plan"]]) {
    refused(
      withSpawn(spawnOf({ items })),
      "phase 1: spawn.items must be an object { phase, path }",
      `items ${JSON.stringify(items)}`,
    );
  }
  refused(
    withSpawn(spawnOf({ items: { phase: "plan", path: [], from: "x" } })),
    'phase 1: spawn.items has unknown key "from"',
    "an unknown items key",
  );
  for (const p of [undefined, "", " ", 3]) {
    refused(
      withSpawn(spawnOf({ items: { phase: p, path: ["tasks"] } })),
      "phase 1: spawn.items.phase must name a phase",
      `items.phase ${JSON.stringify(p)}`,
    );
  }
  for (const p of [undefined, null, "tasks", [1], ["tasks", ""], ["tasks", " "]]) {
    refused(
      withSpawn(spawnOf({ items: { phase: "plan", path: p } })),
      "phase 1: spawn.items.path must be a list of property names ([] for the whole result)",
      `items.path ${JSON.stringify(p)}`,
    );
  }
  refused(
    withSpawn(spawnOf({ items: { phase: "plan", path: Array(9).fill("a") } })),
    "phase 1: spawn.items.path is capped at 8 segments",
    "a path deeper than a result schema can be",
  );
});

test("key, dependsOn and title name task properties", () => {
  for (const key of [undefined, null, "", "  ", 1]) {
    refused(
      withSpawn(spawnOf({ key })),
      "phase 1: spawn.key must name a task property",
      `key ${JSON.stringify(key)} (key is required)`,
    );
  }
  refused(
    withSpawn(spawnOf({ dependsOn: 3 })),
    "phase 1: spawn.dependsOn must name a task property",
    "dependsOn as a number",
  );
  refused(
    withSpawn(spawnOf({ title: [] })),
    "phase 1: spawn.title must name a task property",
    "title as a list",
  );
  refused(
    withSpawn(spawnOf({ dependsOn: "id" })),
    'phase 1: spawn.dependsOn cannot be the key property "id"',
    "dependsOn equal to key",
  );
  refused(
    withSpawn(spawnOf({ title: "dependsOn" })),
    'phase 1: spawn.title cannot be the dependsOn property "dependsOn"',
    "title equal to dependsOn",
  );
  const out = pipelines.validatePipelineInput(withSpawn(spawnOf({ title: "id" })));
  assert.equal(out.phases[1].spawn?.title, "id", "the key may double as the title");
});

test("maxParallel is a whole number, capped at 1 until WS13", () => {
  for (const maxParallel of [0, -1, 1.5, "x"]) {
    refused(
      withSpawn(spawnOf({ maxParallel })),
      "phase 1: spawn.maxParallel must be a whole number of at least 1",
      `maxParallel ${JSON.stringify(maxParallel)}`,
    );
  }
  refused(
    withSpawn(spawnOf({ maxParallel: 2 })),
    "phase 1: spawn.maxParallel is capped at 1 until parallel Claude sessions are safe " +
      "(reliability WS13); children run one at a time",
    "maxParallel 2 is refused until WS13",
  );
  const out = pipelines.validatePipelineInput(withSpawn(spawnOf({ maxParallel: 1 })));
  assert.equal(out.phases[1].spawn?.maxParallel, 1, "maxParallel 1 is accepted");
});

test("maxItems is an integer 1-50", () => {
  for (const maxItems of [0, 51, 2.5, "many"]) {
    refused(
      withSpawn(spawnOf({ maxItems })),
      "phase 1: spawn.maxItems must be an integer 1-50",
      `maxItems ${JSON.stringify(maxItems)}`,
    );
  }
  const out = pipelines.validatePipelineInput(withSpawn(spawnOf({ maxItems: 50 })));
  assert.equal(out.phases[1].spawn?.maxItems, 50, "maxItems 50 is accepted");
});

test("spawn.base is held to the workspace.base rule", () => {
  refused(
    withSpawn(spawnOf({ base: "has space" })),
    'phase 1: spawn.base "has space" is not a valid git ref (no whitespace, no leading "-")',
    "whitespace in a ref",
  );
  refused(
    withSpawn(spawnOf({ base: "-x" })),
    'phase 1: spawn.base "-x" is not a valid git ref (no whitespace, no leading "-")',
    "a ref that reads as a flag",
  );
  refused(
    withSpawn(spawnOf({ base: " " })),
    "phase 1: spawn.base must be a non-empty string",
    "a blank ref",
  );
});

test("spawn.include is up to 16 named { phase, path } sources", () => {
  for (const include of ["spec", ["spec"], 1]) {
    refused(
      withSpawn(spawnOf({ include })),
      "phase 1: spawn.include must be an object of named { phase, path } sources",
      `include ${JSON.stringify(include)}`,
    );
  }
  const many = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [`n${i}`, { phase: "plan", path: [] }]),
  );
  refused(
    withSpawn(spawnOf({ include: many })),
    "phase 1: spawn.include is capped at 16 names",
    "17 names",
  );
  for (const name of ["a b", "x".repeat(41), "a.b"]) {
    refused(
      withSpawn(spawnOf({ include: { [name]: { phase: "plan", path: [] } } })),
      `phase 1: spawn.include name "${name}" must be 1-40 letters, digits, - or _`,
      `include name ${JSON.stringify(name)}`,
    );
  }
  const cases: Array<[unknown, string]> = [
    ["plan", "phase 1: spawn.include.spec must be an object { phase, path }"],
    [{ phase: "plan", path: [], x: 1 }, 'phase 1: spawn.include.spec has unknown key "x"'],
    [{ phase: "", path: [] }, "phase 1: spawn.include.spec.phase must name a phase"],
    [
      { phase: "plan" },
      "phase 1: spawn.include.spec.path must be a list of property names ([] for the whole result)",
    ],
    [
      { phase: "plan", path: Array(9).fill("a") },
      "phase 1: spawn.include.spec.path is capped at 8 segments",
    ],
  ];
  for (const [source, message] of cases) {
    refused(withSpawn(spawnOf({ include: { spec: source } })), message, message);
  }
});

// ── What the graph must guarantee ────────────────────────────────────────────

test("the task list's phase exists, is another phase, and finishes first", () => {
  refused(
    withSpawn(spawnOf({ items: { phase: "nope", path: ["tasks"] } })),
    'phase "tasks": spawn.items.phase names unknown phase "nope"',
    "an unknown phase",
  );
  refused(
    withSpawn(spawnOf({ items: { phase: "tasks", path: ["tasks"] } })),
    'phase "tasks": spawn.items.phase cannot name its own phase',
    "its own phase",
  );
  refused(
    input([planPhase({ needs: [] }), spawnPhase({ needs: [] })]),
    'phase "tasks": spawn.items.phase names "plan", which is not a dependency of this phase; ' +
      "add it to needs so its result exists before any child starts",
    "two roots: plan is not an ancestor",
  );
});

test("a transitive, an implicit linear and a conditional dependency all count", () => {
  pipelines.validatePipelineInput(
    input([planPhase(), phase("review", { needs: ["plan"] }), spawnPhase({ needs: ["review"] })]),
  );
  // No `needs` anywhere: the phases run in list order.
  const linear = { ...spawnPhase() } as Record<string, unknown>;
  delete linear.needs;
  pipelines.validatePipelineInput(input([planPhase(), linear]));
  pipelines.validatePipelineInput(
    input([
      planPhase(),
      spawnPhase({
        needs: [{ phase: "plan", when: { predicate: { path: ["tasks"], operator: "exists" } } }],
      }),
    ]),
  );
});

test("the task list's phase declares a result whose schema declares the path", () => {
  refused(
    input([phase("plan"), spawnPhase()]),
    'phase "tasks": spawn.items.phase names "plan", which declares no result; ' +
      "a spawn phase reads only a validated result",
    "a source with no result",
  );
  refused(
    withSpawn(spawnOf({ items: { phase: "plan", path: ["todo"] } })),
    `phase "tasks": spawn.items.path todo is not declared by phase "plan"'s result schema`,
    "an undeclared path",
  );
  refused(
    withSpawn(spawnOf({ items: { phase: "plan", path: ["tasks", "id"] } })),
    `phase "tasks": spawn.items.path tasks.id is not declared by phase "plan"'s result schema`,
    "a path cannot step into an array",
  );
});

test("the path holds an array of objects", () => {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      loose: { type: "array" },
      labels: { type: "array", items: { type: "string" } },
    },
  };
  const plan = planPhase({ result: { artifact: "plan", schema } });
  const listAt = (p: string[]) =>
    input([plan, spawnPhase({ spawn: spawnOf({ items: { phase: "plan", path: p } }) })]);
  const cases: Array<[string[], string]> = [
    [
      ["name"],
      'name must be an array of objects in phase "plan"\'s result schema (it is a string)',
    ],
    [
      ["loose"],
      'loose must be an array of objects in phase "plan"\'s result schema (it is an array with no items schema)',
    ],
    [
      ["labels"],
      'labels must be an array of objects in phase "plan"\'s result schema (it is an array of strings)',
    ],
    [
      [],
      'the whole result must be an array of objects in phase "plan"\'s result schema (it is an object)',
    ],
  ];
  for (const [p, tail] of cases) {
    refused(listAt(p), `phase "tasks": spawn.items.path ${tail}`, `path ${JSON.stringify(p)}`);
  }
  // A result that is itself the list: `path: []`.
  const listResult = planPhase({
    result: { artifact: "plan", schema: { type: "array", items: taskSchema } },
  });
  const out = pipelines.validatePipelineInput(
    input([listResult, spawnPhase({ spawn: spawnOf({ items: { phase: "plan", path: [] } }) })]),
  );
  assert.deepEqual(out.phases[1].spawn?.items, { phase: "plan", path: [] }, "path [] is accepted");
});

test("key, dependsOn and title are declared on each task with the right types", () => {
  const schema = {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "n"],
          properties: {
            id: { type: "string" },
            n: { type: "number" },
            title: { type: "string" },
            after: { type: "array", items: { type: "number" } },
            size: { type: "number" },
          },
        },
      },
    },
  };
  const plan = planPhase({ result: { artifact: "plan", schema } });
  const spawning = (over: Record<string, unknown>) =>
    input([plan, spawnPhase({ spawn: spawnOf({ dependsOn: undefined, ...over }) })]);
  const tail = `in phase "plan"'s result schema`;
  refused(
    spawning({ key: "slug" }),
    `phase "tasks": spawn.key "slug" must be a required string property of each task ${tail}`,
    "an undeclared key",
  );
  refused(
    spawning({ key: "n" }),
    `phase "tasks": spawn.key "n" must be a required string property of each task ${tail}`,
    "a number key",
  );
  refused(
    spawning({ key: "title", title: undefined }),
    `phase "tasks": spawn.key "title" must be a required string property of each task ${tail}`,
    "a key that is not required",
  );
  refused(
    spawning({ dependsOn: "after" }),
    `phase "tasks": spawn.dependsOn "after" must be declared as an array of strings on each task ${tail}`,
    "dependsOn as an array of numbers",
  );
  refused(
    spawning({ dependsOn: "missing" }),
    `phase "tasks": spawn.dependsOn "missing" must be declared as an array of strings on each task ${tail}`,
    "an undeclared dependsOn",
  );
  refused(
    spawning({ title: "size" }),
    `phase "tasks": spawn.title "size" must be declared as a string property of each task ${tail}`,
    "a number title",
  );
});

test("each include names a path an earlier phase's result declares, of any type", () => {
  const other = phase("other", {
    needs: [],
    result: { artifact: "other", schema: { type: "object" } },
  });
  const including = (include: Record<string, unknown>, extra: unknown[] = []) =>
    input([planPhase(), ...extra, spawnPhase({ spawn: spawnOf({ include }) })]);
  refused(
    including({ x: { phase: "other", path: [] } }, [other]),
    'phase "tasks": spawn.include.x.phase names "other", which is not a dependency of this ' +
      "phase; add it to needs so its result exists before any child starts",
    "an include that is not an ancestor",
  );
  refused(
    including({ x: { phase: "nope", path: [] } }),
    'phase "tasks": spawn.include.x.phase names unknown phase "nope"',
    "an include of an unknown phase",
  );
  refused(
    including({ x: { phase: "tasks", path: [] } }),
    'phase "tasks": spawn.include.x.phase cannot name its own phase',
    "an include of its own phase",
  );
  refused(
    including({ spec: { phase: "plan", path: ["nope"] } }),
    `phase "tasks": spawn.include.spec.path nope is not declared by phase "plan"'s result schema`,
    "an undeclared include path",
  );
  refused(
    input([
      phase("brief", { needs: [] }),
      planPhase({ needs: ["brief"] }),
      spawnPhase({ spawn: spawnOf({ include: { b: { phase: "brief", path: [] } } }) }),
    ]),
    'phase "tasks": spawn.include.b.phase names "brief", which declares no result; ' +
      "a spawn phase reads only a validated result",
    "an include of a phase with no result",
  );
  const out = pipelines.validatePipelineInput(
    including({ whole: { phase: "plan", path: [] }, spec: { phase: "plan", path: ["spec"] } }),
  );
  assert.deepEqual(
    Object.keys(out.phases[1].spawn?.include ?? {}),
    ["whole", "spec"],
    "include path [] and an object path are accepted",
  );
  // A name is the author's, even `__proto__`: it stays a name, and is checked.
  const proto = JSON.parse('{ "__proto__": { "phase": "nope", "path": [] } }') as unknown;
  refused(
    withSpawn(spawnOf({ include: proto })),
    'phase "tasks": spawn.include.__proto__.phase names unknown phase "nope"',
    "an include named __proto__ is not dropped",
  );
});

test("a conditional edge from a spawn phase is refused: it declares no result", () => {
  refused(
    input([
      planPhase(),
      spawnPhase(),
      phase("after", {
        needs: [{ phase: "tasks", when: { predicate: { path: ["x"], operator: "exists" } } }],
      }),
    ]),
    /needs "tasks" conditionally, but phase "tasks" declares no result/,
    "a route on a spawn phase",
  );
});

test("a spawn phase cannot be another spawn phase's task list", () => {
  refused(
    input([
      planPhase(),
      spawnPhase(),
      spawnPhase({
        id: "more",
        needs: ["tasks"],
        spawn: spawnOf({ items: { phase: "tasks", path: [] } }),
      }),
    ]),
    'phase "more": spawn.items.phase names "tasks", which declares no result; ' +
      "a spawn phase reads only a validated result",
    "a spawn phase has no result to read",
  );
});

test("validatePipelinePatch runs the spawn graph checks on a patched phase list", () => {
  assert.throws(
    () =>
      pipelines.validatePipelinePatch({
        phases: [planPhase({ needs: [] }), spawnPhase({ needs: [] })],
      }),
    { name: "PipelineValidationError", message: /which is not a dependency of this phase/ },
    "a patch is held to the same graph rules",
  );
  const patch = pipelines.validatePipelinePatch({ phases: [planPhase(), spawnPhase()] });
  assert.deepEqual(patch.phases?.[1].steps, [], "a valid patch stores the spawn phase");
});

// ── Children context (DL-A2b): a later phase reads the children ────────────

/** `plan`, the spawn phase `tasks`, then `learn` reading its children. */
const withLearn = (learn: Record<string, unknown>, before: unknown[] = []) =>
  input([planPhase(), spawnPhase(), ...before, phase("learn", { needs: ["tasks"], ...learn })]);

test("childrenContext names a spawn phase this phase depends on, and is stored trimmed", () => {
  const out = pipelines.validatePipelineInput(
    withLearn({ childrenContext: { fromPhase: " tasks " } }),
  );
  assert.deepEqual(
    out.phases[2].childrenContext,
    { fromPhase: "tasks" },
    "stored with the phase, trimmed",
  );
  const again = pipelines.validatePipelineInput(JSON.parse(JSON.stringify(out)));
  assert.deepEqual(again.phases, out.phases, "a GET → PUT round trip saves");
  assert.equal(
    "childrenContext" in pipelines.validatePipelineInput(withLearn({})).phases[2],
    false,
    "absent stays absent",
  );
  assert.equal(
    "childrenContext" in
      pipelines.validatePipelineInput(withLearn({ childrenContext: null })).phases[2],
    false,
    "null is absent",
  );
});

test("a linear pipeline needs no needs: every earlier phase is a dependency", () => {
  const out = pipelines.validatePipelineInput(
    input([
      planPhase(),
      spawnPhase({ needs: undefined }),
      phase("learn", { childrenContext: { fromPhase: "tasks" } }),
    ]),
  );
  assert.deepEqual(out.phases[2].childrenContext, { fromPhase: "tasks" }, "accepted");
});

test("childrenContext is held to its shape", () => {
  refused(
    withLearn({ childrenContext: "tasks" }),
    "phase 2: childrenContext must be an object { fromPhase }",
    "a bare string is refused",
  );
  refused(
    withLearn({ childrenContext: ["tasks"] }),
    /phase 2: childrenContext must be an object/,
    "a list is refused",
  );
  refused(
    withLearn({ childrenContext: { fromPhase: "tasks", x: 1 } }),
    'phase 2: childrenContext has unknown key "x"',
    "an unknown key is refused",
  );
  for (const fromPhase of [undefined, "", "  ", 3]) {
    refused(
      withLearn({ childrenContext: { fromPhase } }),
      "phase 2: childrenContext.fromPhase must name a phase",
      `fromPhase ${JSON.stringify(fromPhase)} is refused`,
    );
  }
});

test("childrenContext.fromPhase must be a spawn phase that runs first", () => {
  refused(
    withLearn({ childrenContext: { fromPhase: "nope" } }),
    'phase "learn": childrenContext.fromPhase names unknown phase "nope"',
    "an unknown phase",
  );
  refused(
    withLearn({ childrenContext: { fromPhase: "learn" } }),
    'phase "learn": childrenContext.fromPhase cannot name its own phase',
    "its own phase",
  );
  refused(
    withLearn({ childrenContext: { fromPhase: "plan" } }),
    'phase "learn": childrenContext.fromPhase names "plan", which is not a spawn phase and so starts no children',
    "a phase that spawns nothing",
  );
  refused(
    input([
      planPhase(),
      spawnPhase(),
      phase("learn", { needs: ["plan"], childrenContext: { fromPhase: "tasks" } }),
    ]),
    'phase "learn": childrenContext.fromPhase names "tasks", which is not a dependency of this phase; ' +
      "add it to needs so its children have settled first",
    "a spawn phase beside this one could still be starting children",
  );
  // Through another phase counts.
  const out = pipelines.validatePipelineInput(
    withLearn({ needs: ["ship"], childrenContext: { fromPhase: "tasks" } }, [
      phase("ship", { needs: ["tasks"] }),
    ]),
  );
  assert.deepEqual(out.phases[3].childrenContext, { fromPhase: "tasks" }, "a transitive need");
});

test("a spawn phase cannot declare childrenContext, and is pointed at a later phase", () => {
  refused(
    input([planPhase(), spawnPhase({ childrenContext: { fromPhase: "plan" } })]),
    "phase 1: a spawn phase cannot declare childrenContext; " +
      "put it on a later phase of this pipeline that needs this one",
    "it reads no children of its own, and the spawned pipeline has no spawn phase to name",
  );
  const followed = pipelines.validatePipelineInput(
    withLearn({ childrenContext: { fromPhase: "tasks" } }),
  );
  assert.deepEqual(
    followed.phases[2].childrenContext,
    { fromPhase: "tasks" },
    "the advice, followed, saves",
  );
});

test("validatePipelinePatch applies the childrenContext graph rule to a patched phase list", () => {
  assert.throws(
    () =>
      pipelines.validatePipelinePatch({
        phases: [
          planPhase(),
          spawnPhase(),
          phase("learn", { needs: ["plan"], childrenContext: { fromPhase: "tasks" } }),
        ],
      }),
    { name: "PipelineValidationError", message: /which is not a dependency of this phase/ },
    "a patch is held to the same rule",
  );
  const patch = pipelines.validatePipelinePatch({
    phases: [
      planPhase(),
      spawnPhase(),
      phase("learn", { needs: ["tasks"], childrenContext: { fromPhase: "tasks" } }),
    ],
  });
  assert.deepEqual(
    patch.phases?.[2].childrenContext,
    { fromPhase: "tasks" },
    "a valid patch saves it",
  );
});

// ── Realization: no spawn phase between an implementation and its verifier ───

/** change-intent → implement → … → verify, with `between` in the middle. */
function realization(between: unknown[], after: unknown[] = []) {
  return input([
    phase("change-intent", { gated: true, changeIntent: {} }),
    phase("implement", {
      needs: ["change-intent"],
      changeContext: { fromPhase: "change-intent" },
      implementation: {},
    }),
    ...between,
    phase("verify", {
      needs: [between.length > 0 ? "tasks" : "implement"],
      changeContext: { fromPhase: "change-intent" },
      acceptanceVerification: { implementationPhase: "implement" },
    }),
    ...after,
  ]);
}

test("a spawn phase between an implementation phase and its verifier is refused", () => {
  refused(
    realization([planPhase({ needs: ["implement"] }), spawnPhase()]),
    'phase "tasks": a spawn phase cannot sit between implementation phase "implement" and its ' +
      'acceptance verifier "verify"; a remediation re-verifies an implementation, it does not ' +
      "re-run children",
    "a remediation would re-run the spawn phase",
  );
});

test("a spawn phase outside the realization range is accepted", () => {
  // After the verifier.
  pipelines.validatePipelineInput(
    realization([], [planPhase({ needs: ["verify"] }), spawnPhase()]),
  );
  // Beside it, on a branch of its own.
  pipelines.validatePipelineInput(
    realization([], [planPhase({ needs: [] }), spawnPhase({ needs: ["plan"] })]),
  );
  // Before the implementation: the verifier waits for it, but it does not wait
  // for the implementation.
  pipelines.validatePipelineInput(
    input([
      planPhase({ needs: [] }),
      spawnPhase(),
      phase("change-intent", { needs: ["tasks"], gated: true, changeIntent: {} }),
      phase("implement", {
        needs: ["change-intent"],
        changeContext: { fromPhase: "change-intent" },
        implementation: {},
      }),
      phase("verify", {
        needs: ["implement"],
        changeContext: { fromPhase: "change-intent" },
        acceptanceVerification: { implementationPhase: "implement" },
      }),
    ]),
  );
});

// ── The target pipeline, from both sides ─────────────────────────────────────

const at = new Date("2026-10-21T09:00:00Z");

/** A pipeline a spawn phase can start: one plain phase. */
const childInput = (over: Record<string, unknown> = {}): pipelines.PipelineInput =>
  pipelines.validatePipelineInput({
    name: "Child",
    trigger: null,
    phases: [phase("work")],
    ...over,
  });

const parentInput = (spawn: Record<string, unknown> = {}): pipelines.PipelineInput =>
  pipelines.validatePipelineInput(input([planPhase(), spawnPhase({ spawn: spawnOf(spawn) })]));

async function rejects(save: () => Promise<unknown>, message: string | RegExp, why: string) {
  await assert.rejects(save, { name: "PipelineValidationError", message }, why);
}

test("a parent saves once its target exists, and is refused before", async () => {
  await rejects(
    () => pipelines.createPipeline(parentInput(), at, "parent"),
    'phase "tasks": spawn.pipelineId names an unknown pipeline: child',
    "the target must exist first",
  );
  await pipelines.createPipeline(childInput(), at, "child");
  const parent = await pipelines.createPipeline(parentInput(), at, "parent");
  assert.equal(parent.phases[1].spawn?.pipelineId, "child", "the parent saved");
  const stored = await pipelines.readPipelines();
  assert.deepEqual(
    stored.map((d) => d.id),
    ["child", "parent"],
    "a refused create writes nothing",
  );
});

test("a pipeline cannot spawn itself", async () => {
  await pipelines.createPipeline(childInput(), at, "child");
  await pipelines.createPipeline(parentInput(), at, "parent");
  const patch = pipelines.validatePipelinePatch({
    phases: [planPhase(), spawnPhase({ spawn: spawnOf({ pipelineId: "parent" }) })],
  });
  await rejects(
    () => pipelines.updatePipeline("parent", patch, at),
    'phase "tasks": spawn.pipelineId: a pipeline cannot spawn itself',
    "self-spawn",
  );
});

test("a target with a schedule or an after trigger is refused; none or a webhook is fine", async () => {
  await pipelines.createPipeline(childInput({ name: "Source" }), at, "source");
  const refusedTriggers = [
    { kind: "interval", everyMinutes: 60 },
    { kind: "daily", time: "09:00" },
    { kind: "after", pipelineId: "source", on: "any" },
  ];
  for (const trigger of refusedTriggers) {
    const id = `child-${trigger.kind}`;
    await pipelines.createPipeline(childInput({ trigger }), at, id);
    await rejects(
      () => pipelines.createPipeline(parentInput({ pipelineId: id }), at, `parent-${id}`),
      `phase "tasks": spawn.pipelineId names "Child", which has a "${trigger.kind}" trigger; ` +
        "a spawned pipeline is started by its parent, so its trigger must be none or a webhook",
      `a ${trigger.kind} target`,
    );
  }
  await pipelines.createPipeline(childInput({ trigger: { kind: "webhook" } }), at, "hooked");
  await pipelines.createPipeline(parentInput({ pipelineId: "hooked" }), at, "p-hooked");
  await pipelines.createPipeline(childInput(), at, "plain");
  await pipelines.createPipeline(parentInput({ pipelineId: "plain" }), at, "p-plain");
});

test("spawn phases nest one level deep", async () => {
  await pipelines.createPipeline(childInput({ name: "Leaf" }), at, "leaf");
  await pipelines.createPipeline(
    pipelines.validatePipelineInput(
      input([planPhase(), spawnPhase({ spawn: spawnOf({ pipelineId: "leaf" }) })], {
        name: "Middle",
      }),
    ),
    at,
    "middle",
  );
  await rejects(
    () => pipelines.createPipeline(parentInput({ pipelineId: "middle" }), at, "top"),
    'phase "tasks": spawn.pipelineId names "Middle", which has a spawn phase of its own ' +
      '("tasks"); spawn phases nest one level deep',
    "a target that spawns",
  );
});

test("a target stays a valid target when it is itself edited", async () => {
  await pipelines.createPipeline(childInput({ name: "Leaf" }), at, "leaf");
  await pipelines.createPipeline(childInput(), at, "child");
  await pipelines.createPipeline(parentInput(), at, "parent");
  const spawned = '"Parent" spawns this pipeline from phase "tasks", and this pipeline';

  await rejects(
    () =>
      pipelines.updatePipeline(
        "child",
        pipelines.validatePipelinePatch({ trigger: { kind: "daily", time: "09:00" } }),
        at,
      ),
    `${spawned} has a "daily" trigger; a spawned pipeline is started by its parent, so its ` +
      "trigger must be none or a webhook",
    "a target cannot gain a schedule",
  );
  const hooked = await pipelines.updatePipeline(
    "child",
    pipelines.validatePipelinePatch({ trigger: { kind: "webhook" } }),
    at,
  );
  assert.equal(hooked?.trigger?.kind, "webhook", "a target can gain a webhook");

  await rejects(
    () =>
      pipelines.updatePipeline(
        "child",
        pipelines.validatePipelinePatch({
          phases: [planPhase(), spawnPhase({ spawn: spawnOf({ pipelineId: "leaf" }) })],
        }),
        at,
      ),
    `${spawned} has a spawn phase of its own ("tasks"); spawn phases nest one level deep`,
    "a target cannot gain a spawn phase",
  );
  const renamed = await pipelines.updatePipeline(
    "child",
    pipelines.validatePipelinePatch({ name: "Child v2" }),
    at,
  );
  assert.equal(renamed?.name, "Child v2", "a rename saves");
  const full = await pipelines.updatePipeline(
    "child",
    childInput({ name: "Child v3", trigger: null }),
    at,
  );
  assert.equal(full?.name, "Child v3", "a PUT that keeps it a valid target saves");
});

test("a deleted target: the parent saves again only once its phases are fixed", async () => {
  await pipelines.createPipeline(childInput(), at, "child");
  await pipelines.createPipeline(parentInput(), at, "parent");
  assert.equal(await pipelines.deletePipeline("child"), true, "a target may be deleted");

  const renamed = await pipelines.updatePipeline(
    "parent",
    pipelines.validatePipelinePatch({ name: "Parent v2" }),
    at,
  );
  assert.equal(renamed?.name, "Parent v2", "a patch without phases still saves");
  const disabled = await pipelines.updatePipeline(
    "parent",
    pipelines.validatePipelinePatch({ enabled: false }),
    at,
  );
  assert.equal(disabled?.enabled, false, "toggling enabled still saves");
  await rejects(
    () => pipelines.updatePipeline("parent", parentInput(), at),
    /spawn\.pipelineId names an unknown pipeline: child/,
    "a PUT carries phases, so it names the missing target",
  );

  // Re-created under the same id, the target is held to the rule again.
  await rejects(
    () =>
      pipelines.createPipeline(
        childInput({ trigger: { kind: "interval", everyMinutes: 60 } }),
        at,
        "child",
      ),
    /"Parent v2" spawns this pipeline from phase "tasks", and this pipeline has a "interval" trigger/,
    "the re-created target cannot carry a schedule",
  );
});
