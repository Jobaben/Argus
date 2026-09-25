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

/**
 * Root of every directory an agent writes into: worktrees, file artifacts,
 * memory and the per-run result / ledger channels (`~/.claude-argus` by
 * default, `ARGUS_WORK_DIR` overrides).
 *
 * Deliberately outside the Claude home: Claude Code protects `~/.claude` and
 * refuses a headless agent's writes under it even with `--add-dir` or
 * `acceptEdits`, so a channel or worktree there can never be written. A sibling
 * of the Claude home rather than a fixed path, so an overridden home (tests,
 * `CLAUDE_CONFIG_DIR`) carries its own work root.
 */
export function argusWorkRoot(): string {
  const override = process.env.ARGUS_WORK_DIR;
  if (override && override.trim().length > 0) return path.resolve(override);
  const home = claudeHome();
  return path.join(path.dirname(home), `${path.basename(home)}-argus`);
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
  budgetFile: () => path.join(claudeHome(), "argus", "budget.json"),
  spendFile: () => path.join(claudeHome(), "argus", "spend.json"),
  issuesFile: () => path.join(claudeHome(), "argus", "issues.json"),
  briefingFile: () => path.join(claudeHome(), "argus", "briefing.json"),
  watchtowerFile: () => path.join(claudeHome(), "argus", "watchtower.json"),
  autopsyFile: () => path.join(claudeHome(), "argus", "autopsies.json"),
  tuningFile: () => path.join(claudeHome(), "argus", "tuning.json"),
  verdictFile: () => path.join(claudeHome(), "argus", "verdicts.json"),
  incidentsFile: () => path.join(claudeHome(), "argus", "incidents.json"),
  sentinelFile: () => path.join(claudeHome(), "argus", "sentinel.json"),
  authFile: () => path.join(claudeHome(), "argus", "auth.json"),
  usersFile: () => path.join(claudeHome(), "argus", "users.json"),
  instancesDir: () => path.join(claudeHome(), "argus", "instances"),
  /** Per-run invocation records and the config files materialized for them. */
  invocationsDir: () => path.join(claudeHome(), "argus", "invocations"),
  /** Per-run result channels: `<runId>/result.json` (`ARGUS_RESULT_FILE`). */
  resultsDir: () => path.join(argusWorkRoot(), "results"),
  /** Per-instance, per-phase directories where step agents leave file artifacts. */
  artifactsDir: () => path.join(argusWorkRoot(), "artifacts"),
  /** Per-instance git worktrees a phase's steps run in, when one is declared. */
  worktreesDir: () => path.join(argusWorkRoot(), "worktrees"),
  /** Per-pipeline durable notes (`<pipelineId>/NOTES.md`), when a pipeline
   *  opts into `memory`. Never created until then, never deleted by Argus. */
  memoryDir: () => path.join(argusWorkRoot(), "memory"),
  vaultFile: () => path.join(claudeHome(), "argus", "vault.sqlite"),
  settingsFile: () => path.join(claudeHome(), "settings.json"),
  hooksDir: () => path.join(claudeHome(), "hooks"),
  /** Dedupe ledger for `after`-triggered chain fires: `{ [sourceInstanceId]: targetId[] }`. */
  chainsFile: () => path.join(claudeHome(), "argus", "chains.json"),
  /** The Knowledge Ledger: the one authoritative store of claims, evidence and
   *  justifications. See docs/KNOWLEDGE-LEDGER.md. */
  knowledgeFile: () => path.join(claudeHome(), "argus", "knowledge.json"),
  /** Per-run KnowledgeDelta staging: `<runId>/delta.json` is the one file an
   *  agent may write (`ARGUS_KNOWLEDGE_DELTA_FILE`); `<runId>/staged.json` is
   *  Argus's record of it. Never canonical — see docs/KNOWLEDGE-LEDGER.md. */
  knowledgeDeltasDir: () => path.join(argusWorkRoot(), "knowledge-deltas"),
  /** Per-run rule-verification staging: `<runId>/verification.json` is the one
   *  file a verification agent may write (`ARGUS_RULE_VERIFICATION_FILE`);
   *  `<runId>/staged.json` is Argus's record of it. Never durable until the
   *  phase is accepted — see docs/KNOWLEDGE-LEDGER.md § Phase 6. */
  ruleVerificationsDir: () => path.join(argusWorkRoot(), "rule-verifications"),
  /** Per-run change-proposal staging: `<runId>/proposal.json` is the one file
   *  a change-intent agent may write (`ARGUS_CHANGE_PROPOSAL_FILE`);
   *  `<runId>/staged.json` is Argus's record of it. Never canonical until the
   *  phase is approved — see docs/KNOWLEDGE-LEDGER.md § Phase 7. */
  changeProposalsDir: () => path.join(argusWorkRoot(), "change-proposals"),
  /** Phase 8: one directory per run, holding the acceptance-verification
   *  document the agent wrote and Argus's staged record of it. */
  acceptanceVerificationsDir: () => path.join(argusWorkRoot(), "acceptance-verifications"),
};
