import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { cached } from "./cache.js";
import { claudeProjectRoots } from "./transcriptRoots.js";
import type { Project } from "@argus/contracts";

export type { Project } from "@argus/contracts";

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

/** One project from every directory filed under its encoded name — one per
 *  Claude root that holds it. */
async function toProject(id: string, dirs: string[]): Promise<Project> {
  let sessionCount = 0;
  let lastMs: number | null = null;
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      // unreadable project dir → contributes no sessions
    }
    sessionCount += entries.filter((e) => e.endsWith(".jsonl")).length;
    const newest = await newestSessionMtime(dir);
    if (newest !== null && (lastMs === null || newest > lastMs)) lastMs = newest;
  }
  if (lastMs === null) {
    // No sessions yet: fall back to the directories' own mtime so the card
    // still sorts sensibly rather than sinking to the bottom on null.
    for (const dir of dirs) {
      try {
        const { mtimeMs } = await stat(dir);
        if (lastMs === null || mtimeMs > lastMs) lastMs = mtimeMs;
      } catch {
        // unreadable; no mtime from this one
      }
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
 *  single live broadcast triggers (same pattern as readSessions, and keyed by
 *  the roots the same way). */
export async function readProjects(): Promise<Project[]> {
  const roots = await claudeProjectRoots();
  return cached(`projects:${JSON.stringify(roots)}`, 1500, () => readProjectsRaw(roots));
}

async function readProjectsRaw(roots: string[]): Promise<Project[]> {
  // One card per encoded directory, whichever roots hold it: a pipeline
  // folder's sessions in a repository count toward that repository's project,
  // beside the operator's own sessions there.
  const dirsById = new Map<string, string[]>();
  for (const root of roots) {
    let names: string[];
    try {
      const entries = await readdir(root, { withFileTypes: true });
      names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      dirsById.set(name, [...(dirsById.get(name) ?? []), path.join(root, name)]);
    }
  }

  const projects = await Promise.all([...dirsById].map(([id, dirs]) => toProject(id, dirs)));
  return projects.sort((a, b) => {
    const av = a.lastActivity ?? "";
    const bv = b.lastActivity ?? "";
    return bv.localeCompare(av);
  });
}
