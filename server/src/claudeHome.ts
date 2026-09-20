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
  /** Per-instance, per-phase directories where step agents leave file artifacts. */
  artifactsDir: () => path.join(claudeHome(), "argus", "artifacts"),
  /** Per-instance git worktrees a phase's steps run in, when one is declared. */
  worktreesDir: () => path.join(claudeHome(), "argus", "worktrees"),
  /** Per-pipeline durable notes (`<pipelineId>/NOTES.md`), when a pipeline
   *  opts into `memory`. Never created until then, never deleted by Argus. */
  memoryDir: () => path.join(claudeHome(), "argus", "memory"),
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
  knowledgeDeltasDir: () => path.join(claudeHome(), "argus", "knowledge-deltas"),
  /** Per-run rule-verification staging: `<runId>/verification.json` is the one
   *  file a verification agent may write (`ARGUS_RULE_VERIFICATION_FILE`);
   *  `<runId>/staged.json` is Argus's record of it. Never durable until the
   *  phase is accepted — see docs/KNOWLEDGE-LEDGER.md § Phase 6. */
  ruleVerificationsDir: () => path.join(claudeHome(), "argus", "rule-verifications"),
  /** Per-run change-proposal staging: `<runId>/proposal.json` is the one file
   *  a change-intent agent may write (`ARGUS_CHANGE_PROPOSAL_FILE`);
   *  `<runId>/staged.json` is Argus's record of it. Never canonical until the
   *  phase is approved — see docs/KNOWLEDGE-LEDGER.md § Phase 7. */
  changeProposalsDir: () => path.join(claudeHome(), "argus", "change-proposals"),
  /** Phase 8: one directory per run, holding the acceptance-verification
   *  document the agent wrote and Argus's staged record of it. */
  acceptanceVerificationsDir: () => path.join(claudeHome(), "argus", "acceptance-verifications"),
};
