import os from "node:os";
import path from "node:path";

/**
 * Resolves the OpenCode data directory (`~/.local/share/opencode` by default).
 *
 * OpenCode is the one runtime here that splits its state in two the XDG way:
 * configuration lives under `$XDG_CONFIG_HOME/opencode` and the state Argus
 * would want to read — sessions, logs — under `$XDG_DATA_HOME/opencode`. `home()`
 * names the *data* directory, matching what the other runtimes report and what
 * the Setup panel means by "where this runtime keeps its state".
 *
 * Derived from the OS home dir or an explicit override, never from paths
 * embedded in data files, for the same reason as {@link claudeHome}.
 */
export function opencodeHome(): string {
  const override = process.env.ARGUS_OPENCODE_HOME;
  if (override && override.trim().length > 0) return path.resolve(override);
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim().length > 0) return path.join(path.resolve(xdg), "opencode");
  return path.join(os.homedir(), ".local", "share", "opencode");
}

/** OpenCode's config directory, which is *not* under {@link opencodeHome}. */
export function opencodeConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR;
  if (override && override.trim().length > 0) return path.resolve(override);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim().length > 0) return path.join(path.resolve(xdg), "opencode");
  return path.join(os.homedir(), ".config", "opencode");
}

export const opencodePaths = {
  root: () => opencodeHome(),
  /**
   * Session storage. OpenCode keeps transcripts in SQLite rather than as
   * per-session JSONL, which is why the runtime declares `transcripts: false`:
   * the file is here, but it is a private schema Argus does not read.
   */
  database: () => path.join(opencodeHome(), "opencode.db"),
  logs: () => path.join(opencodeHome(), "log"),
  /** Where the provider list and model catalogue are configured. */
  configFile: () => path.join(opencodeConfigDir(), "opencode.json"),
};
