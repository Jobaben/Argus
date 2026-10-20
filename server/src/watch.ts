import chokidar from "chokidar";
import path from "node:path";
import { claudeHome, paths } from "./claudeHome.js";
import { codexPaths } from "./codexHome.js";
import { qwenPaths } from "./qwenHome.js";
import { log } from "./log.js";
import { claudeProjectRoots } from "./sources/transcriptRoots.js";

interface Watcher {
  /** Watch one more path from now on. */
  add(target: string): void;
  stop(): Promise<void>;
}

/**
 * Watch a set of paths and invoke `onChange` (trailing-debounced ~150ms)
 * whenever anything relevant changes. All of Argus's watchers share this one
 * debounced-chokidar implementation.
 */
function makeWatcher(targets: string[], onChange: () => void): Watcher {
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };

  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    depth: 3,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });
  watcher
    .on("add", fire)
    .on("change", fire)
    .on("unlink", fire)
    .on("addDir", fire)
    .on("error", (e: unknown) => log.error("watcher error", { err: e }));

  return {
    add: (target) => {
      watcher.add(target);
    },
    stop: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}

/** Watches the Claude Code state that feeds the live-agents view. */
export function watchAgents(onChange: () => void): () => Promise<void> {
  return makeWatcher([paths.jobs(), paths.daemonRoster(), paths.daemonStatus()], onChange).stop;
}

/** Watches the Argus scheduler state (schedules + run records). */
export function watchSchedules(onChange: () => void): () => Promise<void> {
  return makeWatcher([paths.argus()], onChange).stop;
}

/** How often the session watcher looks for a Claude transcript root it is not
 *  watching yet. A pipeline folder's first run streams live within this. */
const ROOT_REFRESH_MS = 15_000;

/** Watches the transcript files so the live-tail transcript view can stream
 *  appended messages as a running agent writes them. Every runtime's tree: a
 *  Codex rollout is nested a day deep (`sessions/YYYY/MM/DD/`), which is inside
 *  the shared watcher's depth limit. A pipeline's own Claude config folder
 *  files its transcripts under `<folder>/projects/` instead, and those roots
 *  only appear as runs record them (sources/transcriptRoots.ts), so the watch
 *  widens to each one the first time it is seen. */
export function watchSessions(
  onChange: () => void,
  roots: () => Promise<string[]> = claudeProjectRoots,
): () => Promise<void> {
  const watched = new Set([paths.projects(), codexPaths.sessions(), qwenPaths.projects()]);
  const watcher = makeWatcher([...watched], onChange);
  let stopped = false;
  const widen = async () => {
    try {
      const found = await roots();
      // A lookup still in flight when the watcher stops must not reopen it.
      if (stopped) return;
      for (const root of found) {
        if (watched.has(root)) continue;
        watched.add(root);
        watcher.add(root);
      }
    } catch (e) {
      log.error("session watcher could not list transcript roots", { err: e });
    }
  };
  void widen();
  const timer = setInterval(() => void widen(), ROOT_REFRESH_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await watcher.stop();
  };
}

/** Watches the installed extensions + usage stats so the Inventory and Stats
 *  views can be push-driven and stop their background polling while live. */
export function watchExtensions(onChange: () => void): () => Promise<void> {
  const root = claudeHome();
  return makeWatcher(
    [
      path.join(root, "agents"),
      path.join(root, "commands"),
      path.join(root, "skills"),
      path.join(root, "plugins"),
      path.join(root, "stats-cache.json"),
    ],
    onChange,
  ).stop;
}
