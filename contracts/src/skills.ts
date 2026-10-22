/**
 * Agent skills: the `skills/<name>/` folders Argus ships and installs into
 * the Claude Code and Codex homes (`argus skills`, `GET /api/skills`).
 */

/** The agent CLIs that read a `skills/<name>/SKILL.md` tree under their home. */
export type AgentSkillRuntime = "claude" | "codex";

/**
 * How an installed copy compares with the one this build ships:
 * `missing`, `current` (byte for byte), `outdated` (what an earlier Argus
 * installed, untouched since), `modified` (installed by Argus, then edited),
 * `unmanaged` (installed some other way, and different).
 */
export type AgentSkillState = "missing" | "current" | "outdated" | "modified" | "unmanaged";

export interface AgentSkillStatus {
  skill: string;
  runtime: AgentSkillRuntime;
  /** The installed folder, whether or not it exists. */
  dir: string;
  state: AgentSkillState;
  /** The Argus version that installed it, when its manifest says. */
  installedVersion: string | null;
  /** Whether `argus skills` wrote it (a manifest sits beside it). */
  managed: boolean;
}

/** `GET /api/skills`: every bundled skill in every home an install would write to. */
export interface AgentSkillsResponse {
  skills: AgentSkillStatus[];
  /** Every row is `current`. */
  upToDate: boolean;
}

export interface AgentSkillInstallResult {
  skill: string;
  runtime: AgentSkillRuntime;
  dir: string;
  action: "installed" | "updated" | "unchanged" | "failed";
  /** The state found before installing. */
  was: AgentSkillState;
  /** Where a copy with edits of its own was saved before it was replaced. */
  backup?: string;
  error?: string;
}

/** `POST /api/skills/install`: what it did, then the status it left. */
export interface AgentSkillsInstallResponse extends AgentSkillsResponse {
  ok: boolean;
  results: AgentSkillInstallResult[];
}
