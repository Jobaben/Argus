import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import type { PipelineInstance } from "./pipelineTypes.js";

export const INSTANCE_KEEP = 50;

const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function instancePath(id: string): string {
  return path.join(paths.instancesDir(), `${id}.json`);
}

// mtime-keyed parse memo. /api/overview and the instances list re-scan the
// whole directory on every poll; an unchanged file (the common case) costs a
// stat instead of a read + JSON.parse. Bounded LRU: hits refresh recency.
const PARSE_MEMO_MAX = 500;
const parseMemo = new Map<string, { mtime: number; inst: PipelineInstance }>();

function memoSet(id: string, mtime: number, inst: PipelineInstance): void {
  parseMemo.delete(id);
  parseMemo.set(id, { mtime, inst });
  if (parseMemo.size > PARSE_MEMO_MAX) {
    parseMemo.delete(parseMemo.keys().next().value as string);
  }
}

async function readParsed(id: string): Promise<PipelineInstance | null> {
  const file = instancePath(id);
  try {
    const st = await stat(file);
    const hit = parseMemo.get(id);
    if (hit && hit.mtime === st.mtimeMs) {
      memoSet(id, hit.mtime, hit.inst); // refresh LRU recency
      return hit.inst;
    }
    const inst = JSON.parse(await readFile(file, "utf8")) as PipelineInstance;
    memoSet(id, st.mtimeMs, inst);
    return inst;
  } catch {
    return null;
  }
}

export async function writeInstance(inst: PipelineInstance): Promise<void> {
  await atomicWriteJson(instancePath(inst.id), inst);
  // Drop any memo entry so the next read re-stats — atomic rename gives the
  // file a fresh mtime, but eager eviction makes staleness impossible even on
  // filesystems with coarse mtime resolution.
  parseMemo.delete(inst.id);
}

export async function readInstance(id: string): Promise<PipelineInstance | null> {
  if (!INSTANCE_ID_RE.test(id)) return null;
  return readParsed(id);
}

export async function readInstances(
  opts: { pipelineId?: string; limit?: number } = {},
): Promise<PipelineInstance[]> {
  let names: string[];
  try {
    names = (await readdir(paths.instancesDir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const all = (await Promise.all(names.map((f) => readParsed(f.replace(/\.json$/, ""))))).filter(
    (i): i is PipelineInstance => i !== null,
  );
  let out = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (opts.pipelineId) out = out.filter((i) => i.pipelineId === opts.pipelineId);
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

export async function pruneInstances(pipelineId: string, keep: number): Promise<void> {
  const mine = await readInstances({ pipelineId });
  const drop = mine.slice(keep);
  await Promise.all(
    drop.map(async (i) => {
      await rm(instancePath(i.id), { force: true });
      parseMemo.delete(i.id);
    }),
  );
}
