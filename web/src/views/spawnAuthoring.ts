import type { PhaseDef, PhaseStep, SpawnPolicy, SpawnSource } from "../types";

/**
 * Authoring a spawn phase in the pipeline form (DL-A2): a child-pipeline
 * select, and the rest of `spawn` as one JSON field. Pure; the form and its
 * field component hold the state.
 *
 * The JSON is checked only for what makes it a policy at all. Everything that
 * needs the graph or the other pipeline (a source phase's result schema, the
 * key and dependency fields in it, the target's trigger, the limits) is the
 * server's, which answers the save with a 400 that names it.
 */

/** `spawn` minus the pipeline, as the JSON field shows it. */
export type SpawnOptions = Omit<SpawnPolicy, "pipelineId">;

/** The fields the JSON may hold; anything else is refused before the server sees it. */
export const SPAWN_OPTION_KEYS: readonly (keyof SpawnOptions)[] = [
  "items",
  "key",
  "dependsOn",
  "title",
  "maxParallel",
  "maxItems",
  "base",
  "include",
];

/** The JSON text for a policy: two-space, key order as `SPAWN_OPTION_KEYS`. */
export function spawnOptionsText(spawn: SpawnPolicy): string {
  const out: Partial<Record<keyof SpawnOptions, unknown>> = {};
  for (const k of SPAWN_OPTION_KEYS) if (spawn[k] !== undefined) out[k] = spawn[k];
  return JSON.stringify(out, null, 2);
}

export type ParsedSpawn = { ok: true; options: SpawnOptions } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isSource = (v: unknown): v is SpawnSource =>
  isObject(v) &&
  typeof v.phase === "string" &&
  v.phase.trim() !== "" &&
  Array.isArray(v.path) &&
  v.path.every((s) => typeof s === "string");

/**
 * Read the JSON field. Checks only what makes the policy a policy — an object;
 * no `pipelineId` (chosen above); no unknown field; `items` with a non-empty
 * `phase` string and a `path` list of strings; a non-empty `key`; `dependsOn`,
 * `title` and `base` strings; `maxParallel` and `maxItems` positive integers;
 * each `include` value shaped like `items`. The server checks the rest (sources,
 * schemas, limits) when the pipeline is saved.
 */
export function parseSpawnOptions(text: string): ParsedSpawn {
  const fail = (error: string): ParsedSpawn => ({ ok: false, error });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return fail(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(value)) return fail("must be a JSON object");
  if ("pipelineId" in value) return fail("choose the child pipeline above rather than in the JSON");
  const unknown = Object.keys(value).find(
    (k) => !(SPAWN_OPTION_KEYS as readonly string[]).includes(k),
  );
  if (unknown !== undefined) return fail(`unknown field "${unknown}"`);
  if (!isSource(value.items)) return fail(`"items" needs a "phase" and a "path" list`);
  if (typeof value.key !== "string" || value.key.trim() === "") {
    return fail(`"key" names the task field that identifies each task`);
  }
  for (const k of ["dependsOn", "title", "base"] as const) {
    if (value[k] !== undefined && typeof value[k] !== "string") return fail(`"${k}" must be text`);
  }
  for (const k of ["maxParallel", "maxItems"] as const) {
    const n = value[k];
    if (n !== undefined && !(Number.isInteger(n) && (n as number) >= 1)) {
      return fail(`"${k}" must be a whole number of 1 or more`);
    }
  }
  if (value.include !== undefined) {
    if (!isObject(value.include)) return fail(`"include" must be an object of named sources`);
    for (const [name, source] of Object.entries(value.include)) {
      if (!isSource(source)) return fail(`"include.${name}" needs a "phase" and a "path" list`);
    }
  }
  return { ok: true, options: value as unknown as SpawnOptions };
}

/**
 * The phases a spawn phase can read from: its ancestors that declare a result,
 * nearest first (breadth-first over `needs`). `needIds` is the form's own
 * reading of the graph, implicit edges included.
 */
export function spawnSources(
  phases: PhaseDef[],
  phaseId: string,
  needIds: Map<string, string[]>,
): { id: string; name: string }[] {
  const byId = new Map(phases.map((p) => [p.id, p]));
  const seen = new Set([phaseId]);
  const out: { id: string; name: string }[] = [];
  let frontier = needIds.get(phaseId) ?? [];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      const p = byId.get(id);
      if (seen.has(id) || !p) continue;
      seen.add(id);
      if (p.result) out.push({ id, name: p.name.trim() || "unnamed" });
      next.push(...(needIds.get(id) ?? []));
    }
    frontier = next;
  }
  return out;
}

/** A fresh policy: no pipeline yet, the nearest source, the usual task fields. */
export function defaultSpawn(sources: { id: string }[]): SpawnPolicy {
  return {
    pipelineId: "",
    items: { phase: sources[0]?.id ?? "", path: ["tasks"] },
    key: "id",
    dependsOn: "dependsOn",
    title: "title",
  };
}

/** What every phase keeps whichever kind it is. */
const shared = (p: PhaseDef) => ({
  id: p.id,
  name: p.name,
  cwd: p.cwd,
  ...(p.needs !== undefined ? { needs: p.needs } : {}),
  ...(p.produces ? { produces: p.produces } : {}),
});

/** The phase as a spawn phase: only what a spawn phase may declare. */
export function toSpawnPhase(p: PhaseDef, spawn: SpawnPolicy): PhaseDef {
  return { ...shared(p), gated: false, steps: [], spawn };
}

/** Back to steps: the stashed phase (its shared fields brought up to date), or one empty step. */
export function toStepPhase(
  p: PhaseDef,
  stashed: PhaseDef | undefined,
  newStep: () => PhaseStep,
): PhaseDef {
  if (!stashed) return { ...shared(p), gated: false, steps: [newStep()] };
  const { spawn: _spawn, needs: _needs, produces: _produces, ...rest } = stashed;
  return { ...rest, ...shared(p) };
}

/** Why a spawn phase cannot be saved yet, or null. */
export function spawnProblem(spawn: SpawnPolicy, jsonError: string | undefined): string | null {
  if (!spawn.pipelineId) return "needs a child pipeline";
  if (jsonError) return "has task-list settings that are not valid";
  if (!spawn.items.phase) return "needs an earlier phase to read its tasks from";
  return null;
}
