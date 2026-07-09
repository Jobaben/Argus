import chokidar from "chokidar";
import path from "node:path";
import { claudeHome, paths } from "./claudeHome.js";

/**
 * Watch a set of paths and invoke `onChange` (trailing-debounced ~150ms)
 * whenever anything relevant changes. Returns a stop handle. All three of
 * Argus's watchers share this one debounced-chokidar implementation.
 */
function makeWatcher(targets: string[], onChange: () => void): () => Promise<void> {
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
    .on("error", (e) => console.error("[argus] watcher error:", e));

  return async () => {
    if (timer) clearTimeout(timer);
    await watcher.close();
  };
}

/** Watches the Claude Code state that feeds the live-agents view. */
export function watchAgents(onChange: () => void): () => Promise<void> {
  return makeWatcher([paths.jobs(), paths.daemonRoster(), paths.daemonStatus()], onChange);
}

/** Watches the Argus scheduler state (schedules + run records). */
export function watchSchedules(onChange: () => void): () => Promise<void> {
  return makeWatcher([paths.argus()], onChange);
}

/** Watches the transcript files so the live-tail transcript view can stream
 *  appended messages as a running agent writes them. */
export function watchSessions(onChange: () => void): () => Promise<void> {
  return makeWatcher([paths.projects()], onChange);
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
  );
}
