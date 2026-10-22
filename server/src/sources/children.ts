import { unorderedNodes } from "./dag.js";
import { resolvePath } from "./routing.js";
import { isLiveTask, resumable } from "./instanceStatus.js";
import type {
  InstanceParentRef,
  InstanceStatus,
  PhaseChildren,
  PhaseDef,
  PhaseProgress,
  PipelineDefinition,
  PipelineInstance,
  SpawnChildView,
  SpawnChildrenSummary,
  SpawnPolicy,
  SpawnTask,
  SpawnTaskState,
  SpawnTriggerPayload,
} from "./pipelineTypes.js";

/**
 * Spawn phases: one child instance of another pipeline per task, joined.
 *
 * A spawn phase runs no agent. When it starts, it reads a task list from an
 * earlier phase's validated result, starts one instance of `spawn.pipelineId`
 * (a *child*) per task in dependency order, at most `maxParallel` at once, and
 * succeeds once every child has succeeded. A child that fails or is aborted
 * stops new spawns, and once nothing is live the phase pauses for a person
 * (`pause: "children"`).
 *
 * This is the pure half, as functions over a definition and an instance: the
 * limits, the item check, which tasks start next, which are blocked, when the
 * phase is done, what an observation of a child means for its task, the
 * payload a child starts with, the summary the phase publishes, and the check
 * that a decision on a child still counts for its parent. The engine
 * (`engine/children.ts`) owns the locks, the starts and recovery, and asks
 * this module everything else. It lives in `sources/` because the transitions
 * and the validator read it, and neither may import the engine.
 */

// ── Limits ────────────────────────────────────────────────────────────────────

export const SPAWN_DEFAULT_MAX_PARALLEL = 1;
/** Raised only once parallel Claude sessions are safe (reliability WS13). A
 *  constant on purpose: an env flag would let one machine run what another
 *  refuses to save. */
export const SPAWN_MAX_PARALLEL = 1;
export const SPAWN_DEFAULT_MAX_ITEMS = 20;
export const SPAWN_MAX_ITEMS = 50;
export const SPAWN_MAX_INCLUDE = 16;
/** The result schema's own depth bound (`MAX_SCHEMA_DEPTH`, `routeAuthoring.ts`). */
export const SPAWN_PATH_MAX_SEGMENTS = 8;
/** One task as JSON. Checked with the task list, so an oversized task fails
 *  the phase that produced it, before its gate. */
export const SPAWN_ITEM_MAX_BYTES = 16 * 1024;
/** The whole payload a child is started with: the webhook body cap
 *  (`MAX_HOOK_BODY_BYTES`, local to `createApp` in `app.ts`). */
export const SPAWN_PAYLOAD_MAX_BYTES = 64 * 1024;
/** The parent keeps short titles: its record is in its transition log, one
 *  line at most 16 KiB (`transitionLog/fold.ts`). The child gets the task whole. */
export const SPAWN_TITLE_MAX_CHARS = 60;
export const SPAWN_REASON_MAX_CHARS = 200;
/** A task key: the phase-id alphabet, at most 64 characters. Safe as a label, a
 *  path segment or part of a branch name (`task/<spec>/<key>`, DL-P3). */
export const SPAWN_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SPAWN_INCLUDE_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

// ── Small helpers ─────────────────────────────────────────────────────────────

export function spawnLimits(spawn: SpawnPolicy): { maxParallel: number; maxItems: number } {
  return {
    maxParallel: spawn.maxParallel ?? SPAWN_DEFAULT_MAX_PARALLEL,
    maxItems: spawn.maxItems ?? SPAWN_DEFAULT_MAX_ITEMS,
  };
}

/** A source path for messages: `tasks.open`, or "the whole result". */
export function printSpawnPath(path: readonly string[]): string {
  return path.length > 0 ? path.join(".") : "the whole result";
}

/** The spawn phases whose task list comes from `phaseId`'s result. */
export function spawnPhasesFedBy(
  phases: readonly PhaseDef[],
  phaseId: string,
): Array<PhaseDef & { spawn: SpawnPolicy }> {
  return phases.filter(
    (p): p is PhaseDef & { spawn: SpawnPolicy } => p.spawn?.items.phase === phaseId,
  );
}

/** Clip to `max` characters, ending in "…" when clipped. */
export function clipText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The failure reason a phase payload carries: a copy of the module-private
 *  `payloadReason` in `pipelineTransitions.ts`, which this module may not
 *  import (it imports this one). */
function reasonOf(payload: unknown): string | null {
  if (typeof payload === "string") return payload.trim() || null;
  if (payload && typeof payload === "object" && "reason" in payload) {
    const r = (payload as { reason: unknown }).reason;
    return typeof r === "string" ? r.trim() || null : null;
  }
  return null;
}

/** A source phase's result, when it has succeeded with one; else what the
 *  phase is instead (`missing`: the instance has no such phase). */
function succeededResult(
  phases: readonly PhaseProgress[],
  phaseId: string,
): { ok: true; phase: PhaseProgress; result: unknown } | { ok: false; status: string } {
  const phase = phases.find((p) => p.id === phaseId);
  if (!phase || phase.status !== "succeeded" || phase.result === undefined) {
    return { ok: false, status: phase?.status ?? "missing" };
  }
  return { ok: true, phase, result: phase.result };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ── The item check ────────────────────────────────────────────────────────────

/** One task of a spawn phase's list, read and checked. */
export interface SpawnItem {
  index: number;
  key: string;
  /** Clipped to SPAWN_TITLE_MAX_CHARS. */
  title?: string;
  /** Positions of the tasks it waits for: deduplicated, in the order listed. */
  dependsOn: number[];
  /** The task object exactly as the result held it (the child's payload). */
  task: Record<string, unknown>;
}

export type SpawnItemsCheck = { ok: true; items: SpawnItem[] } | { ok: false; reason: string };

/**
 * The task list a spawn phase reads from a result, checked: a list of 1 to
 * `maxItems` objects, each with its own key, none too large, every dependency
 * a key of the list and no dependency cycle. Each refusal is one line an
 * agent can act on; the caller says which spawn phase it is about.
 */
export function readSpawnItems(spawn: SpawnPolicy, result: unknown): SpawnItemsCheck {
  const refuse = (reason: string): SpawnItemsCheck => ({ ok: false, reason });
  const where = printSpawnPath(spawn.items.path);
  const got = resolvePath(result, spawn.items.path);
  if (!got.found || got.value === undefined) return refuse(`the task list at ${where} is missing`);
  if (!Array.isArray(got.value)) return refuse(`the task list at ${where} is not a list`);
  const list: unknown[] = got.value;
  if (list.length === 0) {
    return refuse(`the task list at ${where} is empty; a spawn phase needs at least one task`);
  }
  const { maxItems } = spawnLimits(spawn);
  if (list.length > maxItems) {
    return refuse(
      `the task list at ${where} has ${list.length} tasks; ` +
        `at most ${maxItems} are allowed (spawn.maxItems)`,
    );
  }

  // First pass: each task on its own. Messages count tasks from 1.
  const positions = new Map<string, number>();
  const read: Array<{ item: SpawnItem; depKeys: string[] }> = [];
  for (const [index, task] of list.entries()) {
    const n = index + 1;
    if (!isPlainObject(task)) return refuse(`task ${n} is not an object`);
    const key = task[spawn.key];
    if (typeof key !== "string" || key === "") {
      return refuse(`task ${n} has no "${spawn.key}" string`);
    }
    if (!SPAWN_KEY_RE.test(key)) {
      return refuse(
        `task ${n}: "${spawn.key}" ${JSON.stringify(key)} must be 1-64 letters, digits, ` +
          `".", "-" or "_" and start with a letter or digit`,
      );
    }
    const first = positions.get(key);
    if (first !== undefined) {
      return refuse(
        `tasks ${first + 1} and ${n} share the ${spawn.key} "${key}"; every task needs its own`,
      );
    }
    positions.set(key, index);
    const bytes = Buffer.byteLength(JSON.stringify(task), "utf8");
    if (bytes > SPAWN_ITEM_MAX_BYTES) {
      return refuse(
        `task "${key}" is ${bytes} bytes as JSON; a task may be at most ${SPAWN_ITEM_MAX_BYTES}`,
      );
    }
    let depKeys: string[] = [];
    if (spawn.dependsOn) {
      const raw = task[spawn.dependsOn];
      if (raw !== undefined && raw !== null) {
        if (!Array.isArray(raw) || !raw.every((d) => typeof d === "string")) {
          return refuse(`task "${key}": "${spawn.dependsOn}" must be a list of task ${spawn.key}s`);
        }
        depKeys = [...new Set<string>(raw)];
      }
    }
    const rawTitle = spawn.title ? task[spawn.title] : undefined;
    const title =
      typeof rawTitle === "string" && rawTitle.trim()
        ? clipText(rawTitle.trim(), SPAWN_TITLE_MAX_CHARS)
        : undefined;
    read.push({
      item: { index, key, ...(title ? { title } : {}), dependsOn: [], task },
      depKeys,
    });
  }

  // Second pass: every dependency names another task of the list.
  for (const { item, depKeys } of read) {
    for (const dep of depKeys) {
      if (dep === item.key) return refuse(`task "${item.key}" depends on itself`);
      const at = positions.get(dep);
      if (at === undefined) {
        return refuse(`task "${item.key}" depends on "${dep}", which is not in the task list`);
      }
      item.dependsOn.push(at);
    }
  }
  const cyclic = unorderedNodes(new Map(read.map(({ item, depKeys }) => [item.key, depKeys])));
  if (cyclic.length > 0) return refuse(`tasks form a dependency cycle: ${cyclic.join(", ")}`);
  return { ok: true, items: read.map(({ item }) => item) };
}

/**
 * For `resolvePhaseResult`: why a result fails as the task list of a spawn
 * phase that reads it, or null. Null at once when no spawn phase reads
 * `sourcePhaseId`, so pipelines without spawn phases pay nothing.
 */
export function spawnItemsError(
  def: Pick<PipelineDefinition, "phases">,
  sourcePhaseId: string,
  result: unknown,
): string | null {
  for (const p of spawnPhasesFedBy(def.phases, sourcePhaseId)) {
    const items = readSpawnItems(p.spawn, result);
    if (!items.ok) return `the task list for spawn phase "${p.id}" is not usable: ${items.reason}`;
  }
  return null;
}

/** The item check against the parent's phases, with the source phase read. */
function itemsFrom(
  spawn: SpawnPolicy,
  phases: readonly PhaseProgress[],
): { ok: true; items: SpawnItem[]; source: PhaseProgress } | { ok: false; reason: string } {
  const source = succeededResult(phases, spawn.items.phase);
  if (!source.ok) {
    return {
      ok: false,
      reason:
        `spawn.items: phase "${spawn.items.phase}" has no result to read ` +
        `(it is ${source.status})`,
    };
  }
  const items = readSpawnItems(spawn, source.result);
  return items.ok ? { ok: true, items: items.items, source: source.phase } : items;
}

/** The item check against the parent's phases: the source must have succeeded
 *  with a result (a spawn phase reached through an `allowSkipped` edge may
 *  find it skipped). */
export function spawnItemsOf(
  spawn: SpawnPolicy,
  phases: readonly PhaseProgress[],
): SpawnItemsCheck {
  const read = itemsFrom(spawn, phases);
  return read.ok ? { ok: true, items: read.items } : read;
}

/** The task list as it starts: every task `pending`. */
export function initialTasks(items: readonly SpawnItem[]): SpawnTask[] {
  return items.map((i) => ({
    key: i.key,
    ...(i.title ? { title: i.title } : {}),
    ...(i.dependsOn.length > 0 ? { dependsOn: [...i.dependsOn] } : {}),
    state: "pending",
  }));
}

// ── Ordering, blocking and the outcome ────────────────────────────────────────

const stopsSpawns = (state: SpawnTaskState): boolean => state === "failed" || state === "aborted";

/**
 * The tasks to plan now, by position, in list order: `pending` tasks whose
 * every dependency has succeeded, as many as `maxParallel` leaves room for
 * beside the live ones. None at all once any task failed or was aborted: a
 * failure stops new spawns until a person decides (the `children` pause).
 */
export function nextSpawns(children: Pick<PhaseChildren, "tasks" | "maxParallel">): number[] {
  const { tasks, maxParallel } = children;
  if (tasks.some((t) => stopsSpawns(t.state))) return [];
  const room = maxParallel - tasks.filter((t) => isLiveTask(t.state)).length;
  if (room <= 0) return [];
  const out: number[] = [];
  tasks.forEach((t, i) => {
    if (out.length >= room || t.state !== "pending") return;
    if ((t.dependsOn ?? []).every((d) => tasks[d]?.state === "succeeded")) out.push(i);
  });
  return out;
}

/**
 * Positions of the waiting tasks (`pending` or `blocked`) that depend, directly
 * or through other waiting tasks, on one that failed or was aborted: to a
 * fixed point, so blocking runs down a chain and clearing the failure unblocks
 * the whole chain.
 */
export function blockedTasks(
  tasks: readonly Pick<SpawnTask, "state" | "dependsOn">[],
): Set<number> {
  const blocked = new Set<number>();
  const stops = (d: number) =>
    blocked.has(d) || (tasks[d] !== undefined && stopsSpawns(tasks[d].state));
  let grew = tasks.some((t) => stopsSpawns(t.state));
  while (grew) {
    grew = false;
    tasks.forEach((t, i) => {
      if (blocked.has(i) || (t.state !== "pending" && t.state !== "blocked")) return;
      if ((t.dependsOn ?? []).some(stops)) {
        blocked.add(i);
        grew = true;
      }
    });
  }
  return blocked;
}

export type ChildrenOutcome = "live" | "succeeded" | "halted";

/**
 * `succeeded`: every task succeeded (the phase joins); `live`: a child is live
 * or owed, or a task can be planned; `halted`: nothing is live and nothing can
 * start, yet not every task succeeded (the phase pauses at `children`).
 * Acyclicity guarantees that with no failure and nothing live some pending
 * task is plannable, so `halted` always means a failure or an abort.
 */
export function childrenOutcome(
  children: Pick<PhaseChildren, "tasks" | "maxParallel">,
): ChildrenOutcome {
  if (children.tasks.every((t) => t.state === "succeeded")) return "succeeded";
  if (children.tasks.some((t) => isLiveTask(t.state))) return "live";
  return nextSpawns(children).length > 0 ? "live" : "halted";
}

// ── Observing a child ─────────────────────────────────────────────────────────

/** What the engine read of one task's child. A read that failed for any
 *  reason but "file not found" is not an observation: the engine defers. */
export interface ChildObservation {
  /** The task's position. */
  index: number;
  /** The child read: taken only if it is still the task's current child. */
  instanceId: string;
  status: InstanceStatus | "missing";
  /** `awaiting-approval`: the child's phase waiting at a gate. */
  waitingPhaseId?: string;
  /** `failed`, `aborted`: one line saying why. */
  reason?: string;
  /** `failed` only: the child links a revise whose `parentDecisionId` is the
   *  task's `reviveDecisionId`, so this failure came after the revive. */
  revised?: boolean;
}

/** An observation of one child, from its record (null: the file does not exist). */
export function childObservation(
  index: number,
  instanceId: string,
  child: Pick<PipelineInstance, "status" | "phases" | "abortCause"> | null,
  revised = false,
): ChildObservation {
  if (!child) return { index, instanceId, status: "missing" };
  const obs: ChildObservation = { index, instanceId, status: child.status };
  switch (child.status) {
    case "awaiting-approval": {
      const waiting = child.phases.find((p) => p.status === "awaiting-approval");
      if (waiting) obs.waitingPhaseId = waiting.id;
      break;
    }
    case "failed": {
      const failed = child.phases.find((p) => p.status === "failed");
      obs.reason = failed
        ? clipText(
            `phase "${failed.id}" failed: ${reasonOf(failed.payload) ?? "no reason recorded"}`,
            SPAWN_REASON_MAX_CHARS,
          )
        : "failed";
      if (revised) obs.revised = true;
      break;
    }
    case "aborted":
      obs.reason = child.abortCause ? `aborted (${child.abortCause})` : "aborted";
      break;
    case "running":
    case "succeeded":
      break;
  }
  return obs;
}

/** Why a task whose started child has no record any more is aborted. */
const CHILD_GONE = "the child instance is gone";

/**
 * What an observation makes of a task, or null for no change: the single place
 * the table below lives. `failed` → running, waiting or succeeded is a person
 * re-running that child directly ("re-run one child"); the engine's parent
 * check allows it only while the spawn phase still waits for that child.
 *
 * | Task \ observed     | running | awaiting-approval | succeeded | failed            | aborted | missing |
 * | ------------------- | ------- | ----------------- | --------- | ----------------- | ------- | ------- |
 * | `planned`           | running | awaiting-approval | succeeded | failed            | aborted | —       |
 * | `reviving`          | running | awaiting-approval | succeeded | failed if revised | aborted | —       |
 * | `running`           | —       | awaiting-approval | succeeded | failed            | aborted | aborted |
 * | `awaiting-approval` | running | — (unless moved)  | succeeded | failed            | aborted | aborted |
 * | `failed`            | running | awaiting-approval | succeeded | —                 | —       | —       |
 * | any other           | —       | —                 | —         | —                 | —       | —       |
 *
 * A planned child that is missing is still owed its start, and a reviving one
 * its revive (which refuses it); a started child that is missing was deleted
 * under its parent. A reviving child seen `failed` before its revive took
 * effect is the failure being revived, not a new one.
 */
export function taskStateFor(
  task: Pick<SpawnTask, "state" | "waitingPhaseId" | "reason">,
  obs: ChildObservation,
): Pick<SpawnTask, "state" | "waitingPhaseId" | "reason"> | null {
  switch (task.state) {
    case "planned":
    case "reviving":
    case "running":
    case "awaiting-approval":
    case "failed":
      break;
    case "pending":
    case "blocked":
    case "succeeded":
    case "aborted":
      return null;
  }
  let state: SpawnTaskState;
  let reason = obs.reason;
  switch (obs.status) {
    case "running":
    case "awaiting-approval":
    case "succeeded":
      state = obs.status;
      break;
    case "failed":
      if (task.state === "failed" || (task.state === "reviving" && !obs.revised)) return null;
      state = "failed";
      break;
    case "aborted":
      if (task.state === "failed") return null;
      state = "aborted";
      break;
    case "missing":
      if (task.state !== "running" && task.state !== "awaiting-approval") return null;
      state = "aborted";
      reason = CHILD_GONE;
      break;
  }
  const next: Pick<SpawnTask, "state" | "waitingPhaseId" | "reason"> = { state };
  if (state === "awaiting-approval" && obs.waitingPhaseId) next.waitingPhaseId = obs.waitingPhaseId;
  if ((state === "failed" || state === "aborted") && reason) next.reason = reason;
  const same =
    next.state === task.state &&
    next.waitingPhaseId === task.waitingPhaseId &&
    next.reason === task.reason;
  return same ? null : next;
}

// ── Payload, summary and the parent check ─────────────────────────────────────

/** `spawn.include`, read from the parent's phases. Each source must have
 *  succeeded with a result; a path the result does not hold gives null. */
export function resolveSpawnInclude(
  spawn: SpawnPolicy,
  phases: readonly PhaseProgress[],
): { ok: true; values?: Record<string, unknown> } | { ok: false; reason: string } {
  const entries = Object.entries(spawn.include ?? {});
  if (entries.length === 0) return { ok: true };
  const values: Array<[string, unknown]> = [];
  for (const [name, src] of entries) {
    const source = succeededResult(phases, src.phase);
    if (!source.ok) {
      return {
        ok: false,
        reason:
          `spawn.include.${name}: phase "${src.phase}" has no result to read ` +
          `(it is ${source.status})`,
      };
    }
    const got = resolvePath(source.result, src.path);
    values.push([name, got.found ? (got.value ?? null) : null]);
  }
  // Object.fromEntries keeps every name an own property, `__proto__` included:
  // an assignment would set the object's prototype and drop the value.
  return { ok: true, values: Object.fromEntries(values) };
}

export function spawnParentRef(
  inst: Pick<PipelineInstance, "id" | "pipelineId">,
  phaseId: string,
  item: Pick<SpawnItem, "index" | "key">,
): InstanceParentRef {
  return {
    instanceId: inst.id,
    pipelineId: inst.pipelineId,
    phaseId,
    index: item.index,
    key: item.key,
  };
}

export type SpawnPayloadBuild =
  { ok: true; payload: SpawnTriggerPayload; bytes: number } | { ok: false; reason: string };

/** The payload one child is started with. Deterministic for the same inputs.
 *  Over SPAWN_PAYLOAD_MAX_BYTES it is refused, naming the largest `include`
 *  value: a task alone is at most SPAWN_ITEM_MAX_BYTES, so only `include` can
 *  push it over, which is a definition problem. */
export function buildSpawnPayload(args: {
  spawn: SpawnPolicy;
  item: Pick<SpawnItem, "key" | "task">;
  include?: Record<string, unknown>;
  parent: InstanceParentRef;
}): SpawnPayloadBuild {
  const { spawn, item, include, parent } = args;
  const payload: SpawnTriggerPayload = {
    task: item.task,
    key: item.key,
    ...(spawn.base ? { base: spawn.base } : {}),
    ...(include && Object.keys(include).length > 0 ? { include } : {}),
    parent,
  };
  const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (bytes <= SPAWN_PAYLOAD_MAX_BYTES) return { ok: true, payload, bytes };
  let largest: { name: string; bytes: number } | null = null;
  for (const [name, value] of Object.entries(include ?? {})) {
    const size = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
    if (!largest || size > largest.bytes) largest = { name, bytes: size };
  }
  return {
    ok: false,
    reason:
      `task "${item.key}": its spawn payload is ${bytes} bytes, ` +
      `over the ${SPAWN_PAYLOAD_MAX_BYTES}-byte cap` +
      (largest ? `; the largest include is "${largest.name}" (${largest.bytes} bytes)` : ""),
  };
}

/**
 * The task list a spawn phase starts with, or why it cannot start: the item
 * check, then every task's payload built once, so an oversized `include`
 * fails the phase before any child starts. Reasons are prefixed
 * `spawn phase "<id>": `.
 */
export function buildPhaseChildren(
  spawn: SpawnPolicy,
  inst: Pick<PipelineInstance, "id" | "pipelineId" | "phases">,
  phaseId: string,
): { ok: true; children: PhaseChildren } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({
    ok: false as const,
    reason: `spawn phase "${phaseId}": ${reason}`,
  });
  const read = itemsFrom(spawn, inst.phases);
  if (!read.ok) return refuse(read.reason);
  const include = resolveSpawnInclude(spawn, inst.phases);
  if (!include.ok) return refuse(include.reason);
  for (const item of read.items) {
    const parent = spawnParentRef(inst, phaseId, item);
    const built = buildSpawnPayload({ spawn, item, include: include.values, parent });
    if (!built.ok) return refuse(built.reason);
  }
  return {
    ok: true,
    children: {
      pipelineId: spawn.pipelineId,
      source: { phaseId: read.source.id, attempt: read.source.attempt },
      maxParallel: spawnLimits(spawn).maxParallel,
      tasks: initialTasks(read.items),
    },
  };
}

/** One task's payload, rebuilt from the parent's own results (deterministic:
 *  the source phase has succeeded and cannot be revised while its spawn phase
 *  runs). Refused when the task is no longer at that position. */
export function spawnPayloadFor(
  spawn: SpawnPolicy,
  inst: Pick<PipelineInstance, "id" | "pipelineId" | "phases">,
  phaseId: string,
  index: number,
  key: string,
): SpawnPayloadBuild {
  const read = spawnItemsOf(spawn, inst.phases);
  if (!read.ok) return read;
  const item = read.items[index];
  if (item?.key !== key) {
    return {
      ok: false,
      reason: `task "${key}" is no longer at position ${index + 1} of the task list`,
    };
  }
  const include = resolveSpawnInclude(spawn, inst.phases);
  if (!include.ok) return include;
  const parent = spawnParentRef(inst, phaseId, { index, key });
  return buildSpawnPayload({ spawn, item, include: include.values, parent });
}

/** What a spawn phase publishes when it joins, and holds while paused at `children`. */
export function summarizeChildren(children: PhaseChildren): SpawnChildrenSummary {
  const counts: Partial<Record<SpawnTaskState, number>> = {};
  for (const t of children.tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return {
    pipelineId: children.pipelineId,
    tasks: children.tasks.map((t) => ({
      key: t.key,
      ...(t.title ? { title: t.title } : {}),
      state: t.state,
      ...(t.instanceId ? { instanceId: t.instanceId } : {}),
    })),
    counts,
    notSucceeded: children.tasks.filter((t) => t.state !== "succeeded").map((t) => t.key),
  };
}

/**
 * Whether a live instance may still start instances of `pipelineId`: a spawn
 * phase of the definition it runs (its snapshot) targets that pipeline and has
 * not succeeded or been skipped. A failed or paused spawn phase counts: a
 * revise re-runs it. For the edit guard (`PUT /api/pipelines/:id`).
 */
export function spawnsMoreOf(
  inst: Pick<PipelineInstance, "definition" | "phases">,
  pipelineId: string,
): boolean {
  return (inst.definition?.phases ?? []).some((def) => {
    if (def.spawn?.pipelineId !== pipelineId) return false;
    const status = inst.phases.find((p) => p.id === def.id)?.status ?? "pending";
    return status !== "succeeded" && status !== "skipped";
  });
}

/**
 * Why a decision on a spawned child no longer counts, or null when it may go
 * ahead. A child's work joins its parent only while the parent is live, its
 * spawn phase is running or paused at `children`, and the task at
 * `parent.index` is still keyed `parent.key` and names this child. `parent`
 * null means the parent's record is gone: nothing waits for the child any
 * more, and its decisions are the operator's alone.
 */
export function parentDecision(
  child: Pick<PipelineInstance, "id" | "parent">,
  parent: Pick<PipelineInstance, "id" | "status" | "phases"> | null,
): string | null {
  const link = child.parent;
  if (!link || !parent) return null;
  if (!resumable(parent.status)) return `its parent ${parent.id} has ${parent.status}`;
  const phase = parent.phases.find((p) => p.id === link.phaseId);
  const waits =
    phase?.status === "running" ||
    (phase?.status === "awaiting-approval" && phase.pause === "children");
  if (!phase || !waits) {
    return `its parent's spawn phase "${link.phaseId}" is ${phase ? phase.status : "gone"}`;
  }
  const task = phase.children?.tasks[link.index];
  if (!task || task.key !== link.key || task.instanceId !== child.id) {
    return `task "${link.key}" of its parent now runs in ${task?.instanceId ?? "no instance"}`;
  }
  return null;
}

/** The child phase a person would act on: the first waiting at a gate, else
 *  the first failed (the choice `pausedPhase` makes in
 *  `pipelineTransitions.ts`, copied here because sources never import the
 *  transitions). */
export function childDecisionPhase(
  child: Pick<PipelineInstance, "phases">,
): SpawnChildView["decisionPhase"] {
  const waiting = child.phases.find((p) => p.status === "awaiting-approval");
  const phase = waiting ?? child.phases.find((p) => p.status === "failed");
  if (!phase) return undefined;
  return {
    phaseId: phase.id,
    phaseName: phase.name,
    attempt: phase.attempt,
    status: waiting ? "awaiting-approval" : "failed",
  };
}
