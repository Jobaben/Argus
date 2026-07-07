import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";

/** A single task directory under `~/.claude/tasks/<uuid>/`. */
export interface Task {
  id: string;
  highwatermark: number | null;
  locked: boolean;
  fileCount: number;
  updatedAt: string | null;
}

async function listTaskDirs(): Promise<string[]> {
  try {
    const entries = await readdir(paths.tasks(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function parseHighwatermark(raw: string): number | null {
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

async function readTask(id: string): Promise<Task> {
  const dir = path.join(paths.tasks(), id);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    names = [];
  }

  const locked = names.includes(".lock");

  let highwatermark: number | null = null;
  if (names.includes(".highwatermark")) {
    try {
      highwatermark = parseHighwatermark(await readFile(path.join(dir, ".highwatermark"), "utf8"));
    } catch {
      highwatermark = null;
    }
  }

  let updatedAt: string | null = null;
  try {
    updatedAt = (await stat(dir)).mtime.toISOString();
  } catch {
    updatedAt = null;
  }

  return { id, highwatermark, locked, fileCount: names.length, updatedAt };
}

/** Reads every task directory, newest first. */
export async function readTasks(): Promise<Task[]> {
  const ids = await listTaskDirs();
  const tasks = await Promise.all(ids.map((id) => readTask(id)));
  return tasks.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}
