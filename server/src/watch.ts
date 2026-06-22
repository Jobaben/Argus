import chokidar from "chokidar";
import { paths } from "./claudeHome.js";

/**
 * Watches the Claude Code state that feeds the live-agents view and invokes
 * `onChange` (debounced) whenever anything relevant changes on disk.
 */
export function watchAgents(onChange: () => void): () => Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };

  const watcher = chokidar.watch(
    [paths.jobs(), paths.daemonRoster(), paths.daemonStatus()],
    {
      ignoreInitial: true,
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    },
  );

  watcher.on("add", fire).on("change", fire).on("unlink", fire).on("addDir", fire);

  return async () => {
    if (timer) clearTimeout(timer);
    await watcher.close();
  };
}

/** Watches the Argus scheduler state (schedules + run records). */
export function watchSchedules(onChange: () => void): () => Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };

  const watcher = chokidar.watch([paths.argus()], {
    ignoreInitial: true,
    depth: 3,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });

  watcher.on("add", fire).on("change", fire).on("unlink", fire).on("addDir", fire);

  return async () => {
    if (timer) clearTimeout(timer);
    await watcher.close();
  };
}
