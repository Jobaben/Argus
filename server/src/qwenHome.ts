import os from "node:os";
import path from "node:path";

/**
 * Resolves the Qwen Code home directory (`~/.qwen` by default).
 *
 * Qwen Code has no environment variable of its own for this — unlike Codex's
 * `CODEX_HOME`, `QWEN_DIR` is internal and not read from the environment — so
 * `ARGUS_QWEN_HOME` is the only override, and it moves where Argus *reads* and
 * where it installs the signal hook. Point it somewhere the CLI does not write
 * and the hook simply won't be registered where the CLI looks for it.
 */
export function qwenHome(): string {
  const override = process.env.ARGUS_QWEN_HOME;
  return override && override.trim().length > 0
    ? path.resolve(override)
    : path.join(os.homedir(), ".qwen");
}

export const qwenPaths = {
  root: () => qwenHome(),
  /** Qwen Code's settings file, where the Argus Stop hook is registered. Same
   *  JSON hook schema as Claude Code's `settings.json`. */
  settingsFile: () => path.join(qwenHome(), "settings.json"),
  /** Transcripts, filed `projects/<encoded-cwd>/chats/<session-id>.jsonl`. */
  projects: () => path.join(qwenHome(), "projects"),
  /** Where Argus copies its signal hook for Qwen Code runs. */
  hooksDir: () => path.join(qwenHome(), "hooks"),
};
