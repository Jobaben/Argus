import os from "node:os";
import path from "node:path";

/**
 * Resolves the Codex CLI home directory (`~/.codex` by default).
 *
 * The mirror of {@link claudeHome}, and derived the same way: from the OS home
 * dir or an explicit override, never from absolute paths embedded in the data
 * files. `CODEX_HOME` is the variable Codex itself honours, so a machine that
 * has already relocated it is picked up without extra configuration;
 * `ARGUS_CODEX_HOME` wins over it for the same reason `ARGUS_CLAUDE_HOME` wins
 * over `CLAUDE_CONFIG_DIR` — pointing Argus somewhere else must not require
 * repointing the CLI.
 */
export function codexHome(): string {
  const override = process.env.ARGUS_CODEX_HOME ?? process.env.CODEX_HOME;
  return override && override.trim().length > 0
    ? path.resolve(override)
    : path.join(os.homedir(), ".codex");
}

export const codexPaths = {
  root: () => codexHome(),
  /** Codex's own TOML config, where the Argus signal hook is registered. */
  configFile: () => path.join(codexHome(), "config.toml"),
  /** Rollout transcripts, nested `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`. */
  sessions: () => path.join(codexHome(), "sessions"),
  /** Archived rollouts, same YYYY/MM/DD shape. */
  archivedSessions: () => path.join(codexHome(), "archived_sessions"),
  /** Prompt history, one JSON object per line. */
  history: () => path.join(codexHome(), "history.jsonl"),
  /** Where Argus copies its signal hook for Codex runs. */
  hooksDir: () => path.join(codexHome(), "hooks"),
};
