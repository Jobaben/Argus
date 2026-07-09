import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { cached } from "./cache.js";

export interface Project {
  id: string;
  label: string;
  sessionCount: number;
  lastActivity: string | null;
}

/**
 * Decodes an encoded project-dir name back into a friendly path.
 *
 * Claude flattens path separators (and, lossily, literal `-`/space) to `-`,
 * so this is best-effort: it recovers the path shape but not characters the
 * encoding destroyed (e.g. `business-rules-plugin` is indistinguishable from
 * nested `business/rules/plugin`).
 */
function decodeLabel(dir: string): string {
  const windows = dir.match(/^([A-Za-z])--(.*)$/);
  if (windows) {
    const [, drive, rest] = windows;
    return `${drive}:\\${rest.replace(/-/g, "\\")}`;
  }
  if (dir.startsWith("-")) return dir.replace(/-/g, "/");
  return dir;
}

async function newestSessionMtime(dir: string): Promise<number | null> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const sessions = entries.filter((e) => e.endsWith(".jsonl"));
  let newest: number | null = null;
  for (const file of sessions) {
    try {
      const { mtimeMs } = await stat(path.join(dir, file));
      if (newest === null || mtimeMs > newest) newest = mtimeMs;
    } catch {
      // skip unreadable session file
    }
  }
  return newest;
}

async function toProject(id: string): Promise<Project> {
  const dir = path.join(paths.projects(), id);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    // unreadable project dir → reported with zero sessions
  }
  const sessionCount = entries.filter((e) => e.endsWith(".jsonl")).length;

  let lastMs = await newestSessionMtime(dir);
  if (lastMs === null) {
    // No sessions yet: fall back to the directory's own mtime so the card
    // still sorts sensibly rather than sinking to the bottom on null.
    try {
      lastMs = (await stat(dir)).mtimeMs;
    } catch {
      lastMs = null;
    }
  }

  return {
    id,
    label: decodeLabel(id),
    sessionCount,
    lastActivity: lastMs === null ? null : new Date(lastMs).toISOString(),
  };
}

/** Reads every project directory, newest activity first. Stats every session
 *  file, so a short-TTL single-flight cache collapses the refetch burst a
 *  single live broadcast triggers (same pattern as readSessions). */
export async function readProjects(): Promise<Project[]> {
  return cached("projects", 1500, readProjectsRaw);
}

async function readProjectsRaw(): Promise<Project[]> {
  let dirs: string[];
  try {
    const entries = await readdir(paths.projects(), { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const projects = await Promise.all(dirs.map(toProject));
  return projects.sort((a, b) => {
    const av = a.lastActivity ?? "";
    const bv = b.lastActivity ?? "";
    return bv.localeCompare(av);
  });
}
