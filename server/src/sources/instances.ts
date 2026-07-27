import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import { cached, invalidate, patchCached } from "./cache.js";
import { createFileMemo } from "./fileMemo.js";
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

export async function writeInstance(inst: PipelineInstance): Promise<void> {
  await atomicWriteJson(instancePath(inst.id), inst);
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

export async function readInstance(id: string): Promise<PipelineInstance | null> {
  if (!INSTANCE_ID_RE.test(id)) return null;
  return readParsed(id);
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

export async function readInstances(
  opts: { pipelineId?: string; limit?: number } = {},
): Promise<PipelineInstance[]> {
  const all = await cached(scanKey(), SCAN_TTL_MS, scanInstances);
  // Never hand callers the cached array itself: some sort/splice in place.
  let out = opts.pipelineId ? all.filter((i) => i.pipelineId === opts.pipelineId) : [...all];
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

export async function pruneInstances(pipelineId: string, keep: number): Promise<void> {
  const mine = await readInstances({ pipelineId });
  const drop = mine.slice(keep);
  await Promise.all(
    drop.map(async (i) => {
      await rm(instancePath(i.id), { force: true });
      parseMemo.forget(i.id);
    }),
  );
  if (drop.length > 0) invalidate(scanKey());
}
