import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { paths } from "../claudeHome.js";

export interface CronDiskHint {
  /** Path (relative to the Claude home root) where the hint was found. */
  path: string;
  /** Why this entry is only a hint and not an authoritative cron source. */
  note: string;
}

export interface CronStatus {
  available: false;
  reason: string;
  howTo: string;
  /** Anything on disk that looked schedule-related, with caveats. */
  diskHints: CronDiskHint[];
}

const SCHEDULE_PATTERN = /cron|routine|schedul/i;

/**
 * Walks the top level of the Claude home for any entry whose name hints at a
 * schedule. These are reported as *hints only*: nothing Claude Code writes to
 * disk is an authoritative store of cron routines, so a match here is almost
 * certainly an unrelated file (e.g. a skill, a log mention) rather than the
 * routines themselves. Kept shallow on purpose — we are not scanning session
 * transcripts, only looking for a dedicated store that would change the answer.
 */
async function findDiskHints(): Promise<CronDiskHint[]> {
  const hints: CronDiskHint[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(paths.root(), { withFileTypes: true });
  } catch {
    return hints;
  }

  for (const entry of entries) {
    if (!SCHEDULE_PATTERN.test(entry.name)) continue;
    const full = path.join(paths.root(), entry.name);
    let kind = entry.isDirectory() ? "directory" : "file";
    try {
      if (!entry.isDirectory() && !entry.isFile()) {
        const s = await stat(full);
        kind = s.isDirectory() ? "directory" : "file";
      }
    } catch {
      // best effort — keep the name-based hint regardless
    }
    hints.push({
      path: entry.name,
      note: `Name-matched ${kind}; not a verified cron store — likely unrelated.`,
    });
  }

  return hints;
}

/**
 * Reports the (un)availability of scheduled / cron routines.
 *
 * Cron routines in Claude Code are session-scoped and only enumerable through
 * the in-session `CronList` tool — they are never persisted to `~/.claude` in a
 * form a file-watcher could read. Argus is a passive disk monitor, so it cannot
 * see them. We still scan the Claude home for any schedule-named store so the
 * answer stays honest if that ever changes.
 */
export async function readCron(): Promise<CronStatus> {
  const diskHints = await findDiskHints();

  return {
    available: false,
    reason:
      "Scheduled / cron routines in Claude Code are session-scoped: they live " +
      "inside a running session and are only enumerable via the in-session " +
      "CronList tool. Claude Code does not persist them to ~/.claude in any " +
      "form a file-watcher can read, so Argus — a passive disk monitor — has " +
      "no on-disk source to surface them from. This is a structural limitation, " +
      "not a missing-file error: there is nothing on disk to watch.",
    howTo:
      "A future polling host could surface them by running a long-lived Claude " +
      "Code session (or a headless agent) that periodically calls the CronList " +
      "tool, then writes the returned routines to a known file under ~/.claude " +
      "(e.g. cron/routines.json). Argus could then watch that file like any " +
      "other source. Until such a host exists, the routines remain invisible " +
      "to disk-based tooling.",
    diskHints,
  };
}
