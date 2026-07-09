import os from "node:os";
import path from "node:path";

/**
 * Resolves the Claude Code home directory (`~/.claude` by default).
 *
 * Always derived from the OS home dir or an explicit override — never from
 * absolute paths embedded inside the data files. Those files can carry paths
 * from a different machine/OS (e.g. a Windows `cwd: C:\GIT\...` sitting inside
 * a Linux `~/.claude`), so they are unreliable for locating anything on disk.
 */
export function claudeHome(): string {
  const override = process.env.ARGUS_CLAUDE_HOME ?? process.env.CLAUDE_CONFIG_DIR;
  return override && override.trim().length > 0
    ? path.resolve(override)
    : path.join(os.homedir(), ".claude");
}

export const paths = {
  root: () => claudeHome(),
  jobs: () => path.join(claudeHome(), "jobs"),
  daemonRoster: () => path.join(claudeHome(), "daemon", "roster.json"),
  daemonStatus: () => path.join(claudeHome(), "daemon.status.json"),
  projects: () => path.join(claudeHome(), "projects"),
  history: () => path.join(claudeHome(), "history.jsonl"),
  tasks: () => path.join(claudeHome(), "tasks"),
  argus: () => path.join(claudeHome(), "argus"),
  schedulesFile: () => path.join(claudeHome(), "argus", "schedules.json"),
  runsDir: () => path.join(claudeHome(), "argus", "runs"),
  pipelinesFile: () => path.join(claudeHome(), "argus", "pipelines.json"),
  totalsFile: () => path.join(claudeHome(), "argus", "totals.json"),
  instancesDir: () => path.join(claudeHome(), "argus", "instances"),
  settingsFile: () => path.join(claudeHome(), "settings.json"),
  hooksDir: () => path.join(claudeHome(), "hooks"),
};
