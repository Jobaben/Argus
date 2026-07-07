import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import type { PipelineInstance } from "./pipelineTypes.js";

export const INSTANCE_KEEP = 50;

const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function instancePath(id: string): string {
  return path.join(paths.instancesDir(), `${id}.json`);
}

export async function writeInstance(inst: PipelineInstance): Promise<void> {
  await atomicWriteJson(instancePath(inst.id), inst);
}

export async function readInstance(id: string): Promise<PipelineInstance | null> {
  if (!INSTANCE_ID_RE.test(id)) return null;
  try {
    return JSON.parse(await readFile(instancePath(id), "utf8")) as PipelineInstance;
  } catch {
    return null;
  }
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
  const all = (await Promise.all(names.map((f) => readInstance(f.replace(/\.json$/, ""))))).filter(
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
  await Promise.all(drop.map((i) => rm(instancePath(i.id), { force: true })));
}
