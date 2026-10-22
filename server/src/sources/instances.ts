import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { atomicWriteFile, atomicWriteJsonDurable } from "./atomicWrite.js";
import { cached, invalidate, patchCached } from "./cache.js";
import { createFileMemo } from "./fileMemo.js";
import { log } from "../log.js";
import { instanceWorktreesDir, plannedRemovals, removeWorktree } from "../harness/workspace.js";
import { instanceTriggerPayloadPath } from "../harness/invocation.js";
import type { PipelineInstance } from "./pipelineTypes.js";

export const INSTANCE_KEEP = 50;

const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function instancePath(id: string): string {
  return path.join(paths.instancesDir(), `${id}.json`);
}

/** See {@link createFileMemo} for why retention is by scan membership. */
const parseMemo = createFileMemo<PipelineInstance>();

async function readParsed(id: string): Promise<PipelineInstance | null> {
  const file = instancePath(id);
  try {
    const st = await stat(file);
    const hit = parseMemo.get(id, st.mtimeMs);
    if (hit) return hit;
    const inst = JSON.parse(await readFile(file, "utf8")) as PipelineInstance;
    parseMemo.set(id, st.mtimeMs, inst);
    return inst;
  } catch {
    return null;
  }
}

// Directory-scan cache, mirroring runs.ts: reconcile() calls readInstances once
// per pipeline definition every tick and /api/overview + /api/briefing fan out
// per broadcast — all within milliseconds, over the same directory. Keyed by
// directory; writes invalidate eagerly, so read-after-write stays exact.
const SCAN_TTL_MS = 1500;

function scanKey(): string {
  return `instances:${paths.instancesDir()}`;
}

/** The scan result with one instance replaced (or inserted), still newest-first. */
function upsert(all: PipelineInstance[], inst: PipelineInstance): PipelineInstance[] {
  const next = all.filter((i) => i.id !== inst.id);
  const at = next.findIndex((i) => i.createdAt.localeCompare(inst.createdAt) < 0);
  next.splice(at === -1 ? next.length : at, 0, inst);
  return next;
}

/**
 * Publish an instance: atomically (a reader sees the old record or the new
 * one, never a mix) and durably (fsynced file, then fsynced directory — see
 * `durable/io.ts` for what that means per platform). The instance save is the
 * commit point of every transition, including a gate decision's link, so it
 * must not be the write that a crash can quietly undo.
 */
export async function writeInstance(inst: PipelineInstance): Promise<void> {
  await atomicWriteJsonDurable(instancePath(inst.id), inst);
  // Drop any memo entry so the next read re-stats — atomic rename gives the
  // file a fresh mtime, but eager eviction makes staleness impossible even on
  // filesystems with coarse mtime resolution.
  parseMemo.forget(inst.id);

  // Patch the cached scan rather than dropping it. A running pipeline writes on
  // every step transition, and each write used to force the next reader — the
  // board, the palette, the briefing, the engine's own reconcile pass — to
  // re-stat the entire directory. Re-reading the one file that changed is the
  // work the write already implies.
  //
  // Read back from disk rather than caching `inst` itself: callers keep mutating
  // the object after handing it here, and a cache holding that reference would
  // change under them.
  const fresh = await readParsed(inst.id);
  if (fresh && patchCached<PipelineInstance[]>(scanKey(), (all) => upsert(all, fresh))) return;
  invalidate(scanKey());
}

/**
 * One instance, as it is on disk — a private copy.
 *
 * The parse memo hands out the same object for as long as the file is
 * unchanged. The engine reads an instance under its lock and then mutates it
 * in place on the way to a save; if that save never happens (a failure part-way
 * through a transition), a shared object would carry the unsaved mutation into
 * every later read in this process — the engine would act on a state that
 * exists nowhere on disk. A copy makes "what the next reader sees" exactly
 * "what was last written". Scans (`readInstances`) stay shared: their callers
 * only read.
 */
export async function readInstance(id: string): Promise<PipelineInstance | null> {
  if (!INSTANCE_ID_RE.test(id)) return null;
  const inst = await readParsed(id);
  return inst ? structuredClone(inst) : null;
}

/** What is on disk under an instance id, without guessing. */
export type InstanceProbe =
  | { kind: "absent" }
  | { kind: "present"; instance: PipelineInstance }
  | { kind: "unreadable"; reason: string };

/**
 * One instance, for a caller that must not mistake a damaged record for a
 * missing one: starting a child by id (where "absent" means "create it"), the
 * retention pin, the parent check and the sweep. Only a file that does not
 * exist is absent. A file that cannot be read, or holds something that is not
 * this instance, is `unreadable`, and so is an id no record can have: the
 * caller waits and asks again, because creating under that id could overwrite
 * a live instance, and pruning on it could delete one a parent still needs.
 *
 * Bypasses the parse memo ({@link readInstance} swallows every error into
 * `null`); what it returns is a private copy, parsed from the file each time.
 */
export async function probeInstance(id: string): Promise<InstanceProbe> {
  if (!INSTANCE_ID_RE.test(id)) {
    return { kind: "unreadable", reason: `invalid instance id "${id}"` };
  }
  let text: string;
  try {
    text = await readFile(instancePath(id), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: e instanceof Error ? e.message : String(e) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      kind: "unreadable",
      reason: `unparseable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { id?: unknown }).id !== id ||
    !Array.isArray((parsed as { phases?: unknown }).phases)
  ) {
    return { kind: "unreadable", reason: "the file does not hold this instance" };
  }
  return { kind: "present", instance: parsed as PipelineInstance };
}

async function scanInstances(): Promise<PipelineInstance[]> {
  let names: string[];
  try {
    names = (await readdir(paths.instancesDir())).filter((f) => f.endsWith(".json"));
  } catch {
    // The directory has gone away; forget what we had rather than serving it.
    parseMemo.retain(new Set());
    return [];
  }
  const ids = names.map((f) => f.replace(/\.json$/, "")).sort();
  const all = (await Promise.all(ids.map(readParsed))).filter(
    (i): i is PipelineInstance => i !== null,
  );
  // Sorted ids, so the ceiling admits the same subset every scan.
  parseMemo.retain(new Set(ids));
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Instances, newest first: all of them, one pipeline's (`pipelineId`), the
 * children one parent spawned (`parentId`, matched on `parent.instanceId`), or
 * both. The objects are the scan's shared ones: read them, never mutate them.
 */
export async function readInstances(
  opts: { pipelineId?: string; parentId?: string; limit?: number } = {},
): Promise<PipelineInstance[]> {
  const all = await cached(scanKey(), SCAN_TTL_MS, scanInstances);
  // Never hand callers the cached array itself: some sort/splice in place.
  // `filter` always returns a new array.
  let out = all.filter(
    (i) =>
      (!opts.pipelineId || i.pipelineId === opts.pipelineId) &&
      (!opts.parentId || i.parent?.instanceId === opts.parentId),
  );
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

/**
 * The isolated worktrees of an instance falling out of retention.
 *
 * Normally they are already gone: the engine removes them as the instance
 * settles. This catches the ones no settlement ever removed — an Argus that
 * stopped mid-run, a removal git refused at the time — because once the
 * instance record is deleted, nothing remembers the directories exist. Never
 * throws: retention must not depend on git.
 */
async function pruneWorktrees(inst: PipelineInstance): Promise<void> {
  const def = inst.definition;
  if (!def) return;
  if (!inst.workspace && !inst.phases.some((p) => p.workspace)) return;
  const recorded = new Set(
    [...inst.phases.map((p) => p.workspace), inst.workspace].flatMap((w) => (w ? [w.path] : [])),
  );
  const plan = plannedRemovals(def, inst);
  let removed = 0;
  for (const removal of plan) {
    try {
      await removeWorktree({ repoCwd: removal.repoCwd, path: removal.path });
      removed++;
    } catch (e) {
      log.warn("pruned instance's worktree could not be removed", {
        instanceId: inst.id,
        path: removal.path,
        err: e,
      });
    }
  }
  // The per-instance directory itself goes only once every tree it held was
  // removed — a `keep` policy (or a removal git refused) keeps the directory.
  if (removed === recorded.size) {
    await rm(instanceWorktreesDir(paths.worktreesDir(), inst.id), {
      recursive: true,
      force: true,
    }).catch(() => {});
  }
}

/**
 * The instance's trigger payload as a file its command checks can read
 * (`ARGUS_TRIGGER_PAYLOAD_FILE`): a JSON copy at
 * `<invocationsDir>/<instanceId>/trigger-payload.json`. A file rather than a
 * variable, because a payload can be 64 KiB and a Windows environment value is
 * capped at 32,767 characters; a copy rather than the instance record, because
 * the record also holds the definition snapshot and its `hookToken`.
 *
 * Called once per verification run, before its first check, and written only
 * when the bytes on disk differ from the payload's, so a run of unchanged
 * checks rewrites nothing, and a copy that was edited or deleted is put back
 * before the next run. Nothing puts it back between one run's checks: a check
 * that runs repository code can change it for the checks after it (HARNESS.md
 * §6, "What a command check is told"). Null, and nothing written, when the
 * instance has no payload (`undefined` or `null`, as `{{trigger.payload}}`
 * reads it). Removed with the instance's folder by {@link pruneInstances}.
 * Throws on an I/O error: the caller's checks must not run on a missing input.
 */
export async function ensureTriggerPayloadFile(
  inst: Pick<PipelineInstance, "id" | "triggerPayload">,
): Promise<string | null> {
  if (inst.triggerPayload === undefined || inst.triggerPayload === null) return null;
  const text = JSON.stringify(inst.triggerPayload, null, 2);
  const file = instanceTriggerPayloadPath(paths.invocationsDir(), inst.id);
  let current: Buffer | null = null;
  try {
    current = await readFile(file);
  } catch {
    /* absent (or unreadable): written below */
  }
  if (!current || !current.equals(Buffer.from(text, "utf8"))) await atomicWriteFile(file, text);
  return file;
}

/**
 * Retention: a pipeline's newest `keep` instances stay, older ones are deleted
 * with everything that belongs to them.
 *
 * A spawned child is kept past the window while its parent's record exists,
 * or cannot be read right now: the parent's spawn phase mirrors it and its
 * gate review links to it. Only a parent record that is provably gone
 * (`probeInstance` reads it as absent) releases the child, so a transient read
 * error never deletes one. Pinned children still count toward `keep`: the
 * window is "the newest N, plus every pinned one older". Pruning a parent does
 * not prune its children; they fall to their own pipeline's window at its next
 * start.
 */
export async function pruneInstances(pipelineId: string, keep: number): Promise<void> {
  const mine = await readInstances({ pipelineId });
  // One read per parent, however many of its children are past the window.
  const parents = new Map<string, Promise<boolean>>();
  const held = (i: PipelineInstance): Promise<boolean> => {
    const parentId = i.parent?.instanceId;
    if (!parentId) return Promise.resolve(false);
    let known = parents.get(parentId);
    if (!known) {
      known = probeInstance(parentId).then((r) => r.kind !== "absent");
      parents.set(parentId, known);
    }
    return known;
  };
  const candidates = mine.slice(keep);
  const pinned = await Promise.all(candidates.map(held));
  const drop = candidates.filter((_, n) => !pinned[n]);
  await Promise.all(
    drop.map(async (i) => {
      // Before the record: the worktrees are found *through* it, and an
      // instance deleted first would leave them on disk with nothing left that
      // knows they exist. A tree whose policy asked to be kept is left alone.
      await pruneWorktrees(i);
      await rm(instancePath(i.id), { force: true });
      // Its transition log is part of the instance: it explains a record that
      // no longer exists, and nothing else ever deletes it.
      await rm(path.join(paths.transitionsDir(), `${i.id}.jsonl`), { force: true });
      // The instance's file artifacts, working-tree baselines and
      // trigger-payload copy go with it.
      await rm(path.join(paths.artifactsDir(), i.id), { recursive: true, force: true });
      await rm(path.join(paths.invocationsDir(), i.id), { recursive: true, force: true });
      parseMemo.forget(i.id);
    }),
  );
  if (drop.length > 0) invalidate(scanKey());
}
