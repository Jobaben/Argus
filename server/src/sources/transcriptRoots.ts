/**
 * Where Claude Code files its session logs.
 *
 * The CLI writes each transcript under its config home's `projects/`. For the
 * operator's own sessions, and for every pipeline step without a folder of its
 * own, that is `paths.projects()`. A pipeline that names a `claudeConfigDir`
 * moves its Claude steps' CLI home, and their logs with it, to
 * `<folder>/projects/`. Every reader of Claude transcripts — the session list
 * and view, the live tail, search, the projects list, the watcher — scans each
 * of these roots, not only the first.
 *
 * The folders come from the run records (`Run.claudeConfigDir`), never from
 * the current pipeline definitions: a pipeline that is edited or deleted keeps
 * its history for as long as its runs are kept.
 */

import path from "node:path";
import { paths } from "../claudeHome.js";
import { readRuns } from "./runs.js";

/** The operator's own `projects/` first, then each folder's, most recently
 *  used first. Never empty, never duplicated. */
export async function claudeProjectRoots(): Promise<string[]> {
  const roots = [paths.projects()];
  for (const run of await readRuns()) {
    if (!run.claudeConfigDir) continue;
    const root = path.join(run.claudeConfigDir, "projects");
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}
