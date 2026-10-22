import { describe, it, expect } from "vitest";
import type { PhaseDef, SpawnPolicy } from "../types";
import {
  SPAWN_OPTION_KEYS,
  defaultSpawn,
  parseSpawnOptions,
  spawnOptionsText,
  spawnProblem,
  spawnSources,
  toSpawnPhase,
  toStepPhase,
} from "./spawnAuthoring";

const policy: SpawnPolicy = {
  pipelineId: "child",
  items: { phase: "plan", path: ["tasks"] },
  key: "id",
  dependsOn: "after",
  title: "title",
  maxParallel: 1,
  maxItems: 30,
  base: "origin/main",
  include: { spec: { phase: "define", path: ["spec", "path"] } },
};

const errorOf = (value: unknown) => {
  const parsed = parseSpawnOptions(typeof value === "string" ? value : JSON.stringify(value));
  return parsed.ok ? null : parsed.error;
};

describe("parseSpawnOptions", () => {
  it("reads a policy's options, and round-trips the text it writes", () => {
    const text = spawnOptionsText(policy);
    // Every option but the pipeline, which is chosen from a list.
    expect(Object.keys(JSON.parse(text))).toEqual(SPAWN_OPTION_KEYS);
    const parsed = parseSpawnOptions(text);
    expect(parsed).toEqual({ ok: true, options: { ...policy, pipelineId: undefined } });
    const { pipelineId: _id, ...options } = policy;
    expect(parsed.ok && parsed.options).toEqual(options);
    expect(spawnOptionsText({ pipelineId: "c", items: { phase: "p", path: [] }, key: "id" })).toBe(
      '{\n  "items": {\n    "phase": "p",\n    "path": []\n  },\n  "key": "id"\n}',
    );
  });

  it("says what makes the text not a policy", () => {
    const ok = { items: { phase: "plan", path: ["tasks"] }, key: "id" };
    expect(errorOf("{ items")).toMatch(/^not valid JSON: /);
    expect(errorOf([])).toBe("must be a JSON object");
    expect(errorOf("null")).toBe("must be a JSON object");
    expect(errorOf({ ...ok, pipelineId: "x" })).toBe(
      "choose the child pipeline above rather than in the JSON",
    );
    expect(errorOf({ ...ok, parallel: 2 })).toBe('unknown field "parallel"');
    const items = '"items" needs a "phase" and a "path" list';
    expect(errorOf({ key: "id" })).toBe(items);
    expect(errorOf({ ...ok, items: { phase: "plan", path: "tasks" } })).toBe(items);
    expect(errorOf({ ...ok, items: { phase: " ", path: [] } })).toBe(items);
    expect(errorOf({ ...ok, items: { phase: "plan", path: [1] } })).toBe(items);
    expect(errorOf({ ...ok, key: "" })).toBe(
      '"key" names the task field that identifies each task',
    );
    expect(errorOf({ ...ok, key: 3 })).toBe('"key" names the task field that identifies each task');
    expect(errorOf({ ...ok, title: 3 })).toBe('"title" must be text');
    expect(errorOf({ ...ok, dependsOn: ["after"] })).toBe('"dependsOn" must be text');
    expect(errorOf({ ...ok, base: false })).toBe('"base" must be text');
    expect(errorOf({ ...ok, maxParallel: 0 })).toBe(
      '"maxParallel" must be a whole number of 1 or more',
    );
    expect(errorOf({ ...ok, maxItems: 1.5 })).toBe(
      '"maxItems" must be a whole number of 1 or more',
    );
    expect(errorOf({ ...ok, maxItems: "20" })).toBe(
      '"maxItems" must be a whole number of 1 or more',
    );
    expect(errorOf({ ...ok, include: [] })).toBe('"include" must be an object of named sources');
    expect(errorOf({ ...ok, include: { spec: { phase: "define" } } })).toBe(
      '"include.spec" needs a "phase" and a "path" list',
    );
    expect(errorOf(ok)).toBeNull();
  });
});

const phase = (id: string, over: Partial<PhaseDef> = {}): PhaseDef => ({
  id,
  name: id.toUpperCase(),
  cwd: "/repo",
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});
const result = { artifact: "out", schema: { type: "object" as const } };

describe("spawnSources", () => {
  it("lists the ancestors that declare a result, nearest first, never itself or a descendant", () => {
    const phases = [
      phase("define", { result }),
      phase("plan", { result, needs: ["define"] }),
      phase("review", { needs: ["plan"] }),
      phase("tasks", { needs: ["review", "plan"] }),
      phase("ship", { result, needs: ["tasks"] }),
    ];
    const needIds = new Map(
      phases.map((p) => [p.id, (p.needs ?? []).map((d) => (typeof d === "string" ? d : d.phase))]),
    );
    expect(spawnSources(phases, "tasks", needIds)).toEqual([
      { id: "plan", name: "PLAN" },
      { id: "define", name: "DEFINE" },
    ]);
    expect(spawnSources(phases, "define", needIds)).toEqual([]);
    // A dangling dependency, as a hand-edited file might carry, is skipped.
    expect(spawnSources(phases, "x", new Map([["x", ["gone", "plan"]]]))).toEqual([
      { id: "plan", name: "PLAN" },
    ]);
  });

  it("calls an unnamed source unnamed", () => {
    const phases = [phase("a", { result, name: " " }), phase("b")];
    expect(spawnSources(phases, "b", new Map([["b", ["a"]]]))).toEqual([
      { id: "a", name: "unnamed" },
    ]);
  });
});

describe("defaultSpawn", () => {
  it("reads from the nearest source, with the usual task fields", () => {
    expect(defaultSpawn([{ id: "plan" }, { id: "define" }])).toEqual({
      pipelineId: "",
      items: { phase: "plan", path: ["tasks"] },
      key: "id",
      dependsOn: "dependsOn",
      title: "title",
    });
    expect(defaultSpawn([]).items.phase).toBe("");
  });
});

describe("toSpawnPhase and toStepPhase", () => {
  const busy = phase("tasks", {
    name: "Tasks",
    needs: ["plan"],
    produces: "summary",
    gated: true,
    retry: { attempts: 2, backoffSeconds: 30 },
    timeoutSeconds: 600,
    result,
    workspace: { scope: "attempt" },
    candidates: { count: 2, select: "first-verified" },
    autoApprove: { verdict: 8 },
    rubric: { criteria: [] } as unknown as PhaseDef["rubric"],
  });

  it("keeps only what a spawn phase may declare", () => {
    expect(toSpawnPhase(busy, policy)).toEqual({
      id: "tasks",
      name: "Tasks",
      cwd: "/repo",
      needs: ["plan"],
      produces: "summary",
      gated: false,
      steps: [],
      spawn: policy,
    });
    expect(toSpawnPhase(phase("a"), policy)).not.toHaveProperty("needs");
  });

  it("restores the stashed phase with its shared fields brought up to date", () => {
    const spawned = { ...toSpawnPhase(busy, policy), name: "Renamed", cwd: "/elsewhere" };
    const back = toStepPhase(spawned, busy, () => ({ name: "", prompt: "" }));
    expect(back).toEqual({ ...busy, name: "Renamed", cwd: "/elsewhere" });
    expect(back).not.toHaveProperty("spawn");
    // Needs dropped while it was a spawn phase stay dropped.
    const { needs: _needs, ...rootSpawn } = spawned;
    expect(toStepPhase(rootSpawn, busy, () => ({ name: "", prompt: "" }))).not.toHaveProperty(
      "needs",
    );
  });

  it("starts from one empty step with nothing stashed", () => {
    expect(
      toStepPhase(toSpawnPhase(busy, policy), undefined, () => ({ name: "", prompt: "" })),
    ).toEqual({
      id: "tasks",
      name: "Tasks",
      cwd: "/repo",
      needs: ["plan"],
      produces: "summary",
      gated: false,
      steps: [{ name: "", prompt: "" }],
    });
  });
});

describe("spawnProblem", () => {
  it("asks for a child pipeline, then valid settings, then a source", () => {
    expect(spawnProblem({ ...policy, pipelineId: "" }, "bad")).toBe("needs a child pipeline");
    expect(spawnProblem(policy, "not valid JSON: x")).toBe(
      "has task-list settings that are not valid",
    );
    expect(spawnProblem({ ...policy, items: { phase: "", path: ["tasks"] } }, undefined)).toBe(
      "needs an earlier phase to read its tasks from",
    );
    expect(spawnProblem(policy, undefined)).toBeNull();
  });
});
