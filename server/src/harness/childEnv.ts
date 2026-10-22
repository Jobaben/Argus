/**
 * Environment policy for agent child processes.
 *
 * Argus spawns agent CLIs (claude, codex, opencode, qwen, ...) as child
 * processes to do the actual work of a phase. Historically we handed those
 * processes `{ ...process.env, ...planEnv, ...argusEnv }` — the server's
 * *entire* environment, unfiltered. That is a control-plane leak: the agent
 * we are asking to edit a repo and run shell commands inherits the same
 * `ARGUS_TOKEN` bearer credential Argus uses to authenticate admin requests
 * against itself. An agent that can read its own environment (directly, or
 * indirectly by getting a shell command to print it) can then call back into
 * Argus's HTTP API with full authority — approve its own phases, edit
 * pipeline definitions, or open the harness up to the network. The same goes
 * for `ARGUS_WEBHOOK_URL` and the per-invocation identifiers a nested Argus
 * process could use to impersonate or interfere with a different run
 * (`ARGUS_SIGNAL_TOKEN`, `ARGUS_SIGNAL_URL`, `ARGUS_RESULT_FILE`,
 * `ARGUS_ARTIFACT_DIR`, `ARGUS_WORKSPACE`, `ARGUS_MEMORY_DIR`,
 * `ARGUS_KNOWLEDGE_DELTA_FILE`, `ARGUS_KNOWLEDGE_CONTEXT_FILE`,
 * `ARGUS_RULE_VERIFICATION_FILE`, the `ARGUS_CHANGE_*` files,
 * `ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`, `ARGUS_PHASE_ATTEMPT`, `ARGUS_RUN_ID`,
 * `ARGUS_TRIGGER_PAYLOAD_FILE`).
 *
 * The rule this module enforces: an agent must never be able to administer
 * the harness that runs it. `buildChildEnv` is the one place that assembles
 * a child process's environment, so every runtime should route through it
 * rather than spreading `process.env` by hand. That covers every child Argus
 * starts for a phase: the agent processes, and the phase's command checks.
 *
 * Values are secrets — this module (and its callers) must never log an
 * environment value, only variable *names* (as `passed` / `stripped` do).
 */

import type { EnvPolicy } from "./../sources/pipelineTypes.js";

/**
 * Variables Argus itself uses as secrets or control-plane configuration.
 * Never passed to an agent, under any policy — not even via an explicit
 * `allow` entry. Stripped from the parent environment unconditionally.
 */
export const ARGUS_SERVER_SECRETS: readonly string[] = ["ARGUS_TOKEN", "ARGUS_WEBHOOK_URL"];

/**
 * Per-invocation identifiers that must only ever come from `layers` (the
 * caller's own freshly-computed values for *this* invocation), never be
 * inherited from the parent process's environment. Without this, a nested
 * Argus child process would inherit its parent's identifiers and could
 * impersonate or interfere with the parent's own run.
 */
export const ARGUS_PER_INVOCATION_IDENTIFIERS: readonly string[] = [
  "ARGUS_SIGNAL_TOKEN",
  "ARGUS_SIGNAL_URL",
  "ARGUS_RESULT_FILE",
  "ARGUS_ARTIFACT_DIR",
  "ARGUS_INSTANCE_ID",
  "ARGUS_PHASE_ID",
  // Which attempt of its phase this invocation, or this check, belongs to
  // (0-based). Inherited, a nested child would report its parent's attempt.
  "ARGUS_PHASE_ATTEMPT",
  "ARGUS_RUN_ID",
  "ARGUS_STEP_NAME",
  // The isolated worktree this one invocation runs in.
  "ARGUS_WORKSPACE",
  // The hook keys its Stop-payload handling off this; a wrong value loses the
  // completion signal.
  "ARGUS_RUNTIME",
  // This pipeline's own durable-notes directory (only set when `memory` is
  // enabled) — never inherited, for the same reason as `ARGUS_ARTIFACT_DIR`:
  // a nested Argus child must not write another pipeline's notes.
  "ARGUS_MEMORY_DIR",
  // Where this one run may propose semantic knowledge. Inherited, a nested
  // child could stage a delta under its parent's run identity.
  "ARGUS_KNOWLEDGE_DELTA_FILE",
  // The read-only semantic context Argus supplied to this one run.
  "ARGUS_KNOWLEDGE_CONTEXT_FILE",
  // Where this one run must leave its conformance results.
  "ARGUS_RULE_VERIFICATION_FILE",
  // The change-intent channels (Phase 7): the request this run was given, the
  // proposal it must write, and the accepted intent it implements. Inherited,
  // a nested child could read another run's request or stage a proposal under
  // its parent's run identity.
  "ARGUS_CHANGE_REQUEST_FILE",
  "ARGUS_CHANGE_PROPOSAL_FILE",
  "ARGUS_CHANGE_CONTEXT_FILE",
  // Every revise note of this one run's phase, in full. Inherited, a nested
  // child would read another run's notes as its own.
  "ARGUS_REVISION_NOTES_FILE",
  // The children manifest of this one run's phase. Inherited, a nested child
  // would read another run's children as its own.
  "ARGUS_CHILDREN_FILE",
  // The instance's trigger payload, copied for its command checks. Inherited,
  // a nested child's checks would read another instance's task as their own.
  "ARGUS_TRIGGER_PAYLOAD_FILE",
];

/** The baseline that `inherit: "minimal"` passes through even without `allow`. */
export const MINIMAL_BASELINE: readonly string[] = [
  // Core POSIX shell/process environment.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_*",
  "TERM",
  "TZ",
  "PWD",
  "XDG_*",
  // TLS / proxy configuration agents need to reach the network at all.
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // Agent CLIs' own configuration/auth variables.
  "CLAUDE_*",
  "CLAUDECODE",
  "ANTHROPIC_*",
  "CODEX_*",
  "OPENAI_*",
  "QWEN_*",
  "OPENCODE_*",
  // Argus's own per-runtime home/binary overrides (not secrets).
  "ARGUS_CLAUDE_HOME",
  "ARGUS_CODEX_HOME",
  "ARGUS_OPENCODE_HOME",
  "ARGUS_QWEN_HOME",
  "ARGUS_CLAUDE_BIN",
  "ARGUS_CODEX_BIN",
  "ARGUS_OPENCODE_BIN",
  "ARGUS_QWEN_BIN",
  // Windows essentials.
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "USERNAME",
];

export interface ChildEnv {
  env: Record<string, string>;
  /** Sorted names present in the final child environment. */
  passed: string[];
  /** Sorted names present in the parent but absent from the child (stripped by policy or as an Argus secret). */
  stripped: string[];
}

/**
 * Does `name` match `pattern`? A pattern is either an exact name, or a
 * `PREFIX_*` pattern where a single trailing `*` matches any suffix. Only a
 * trailing `*` is treated as a wildcard — anything else in the pattern is
 * matched literally. Case-sensitive (POSIX environment names are
 * case-sensitive; Windows callers get the Windows-cased names in
 * `MINIMAL_BASELINE` above).
 */
export function matchesEnvPattern(name: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return name.startsWith(prefix);
  }
  return name === pattern;
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesEnvPattern(name, pattern));
}

export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  policy: EnvPolicy | undefined,
  ...layers: Record<string, string>[]
): ChildEnv {
  const parentNames: string[] = [];
  const result: Record<string, string> = {};

  // 1. Start from `parent`, dropping undefined values.
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    parentNames.push(name);
    result[name] = value;
  }

  const allow = policy?.allow ?? [];
  const deny = policy?.deny ?? [];

  for (const name of parentNames) {
    // 2. `inherit: "minimal"` keeps only the baseline or explicit `allow`.
    if (policy?.inherit === "minimal") {
      if (!matchesAny(name, MINIMAL_BASELINE) && !matchesAny(name, allow)) {
        delete result[name];
        continue;
      }
    }

    // 3. `deny` removes, unless `allow` keeps it despite the deny.
    if (matchesAny(name, deny) && !matchesAny(name, allow)) {
      delete result[name];
      continue;
    }
  }

  // 4. Non-overridable removals: Argus's own secrets, and per-invocation
  // identifiers that must come only from `layers`, never be inherited.
  for (const name of [...ARGUS_SERVER_SECRETS, ...ARGUS_PER_INVOCATION_IDENTIFIERS]) {
    delete result[name];
  }

  // 5. Overlay layers (later wins), then `policy.set` last.
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer)) {
      result[name] = value;
    }
  }
  if (policy?.set) {
    for (const [name, value] of Object.entries(policy.set)) {
      result[name] = value;
    }
  }

  // 6. passed / stripped.
  const passed = Object.keys(result).sort();
  const finalNames = new Set(passed);
  const stripped = parentNames.filter((name) => !finalNames.has(name)).sort();

  return { env: result, passed, stripped };
}

/** What a command check is told about the work it judges (`commandInputLayer`). */
export interface CommandInputs {
  instanceId: string;
  phaseId: string;
  /** The phase attempt the work belongs to, 0-based. */
  attempt: number;
  /** The artifact directory the checks read (a candidate's own `c<i>`), or null. */
  artifactDir: string | null;
  /** The worktree the work happened in (a candidate's own), or null for none. */
  workspace: string | null;
  /** The instance's trigger payload file, or null when it has no payload. */
  triggerPayloadFile: string | null;
}

/**
 * What a command check is told about the work it judges, as a `buildChildEnv`
 * layer. The names are the ones an agent step gets, so one script can run in
 * both places; a value Argus does not have is left out, never set empty. Pure:
 * the caller resolves the paths, and writes the trigger payload file first
 * (`ensureTriggerPayloadFile` in `sources/instances.ts`).
 *
 * Every name here is a per-invocation identifier, so a value inherited from
 * Argus's own environment never reaches the check: only this layer sets them.
 */
export function commandInputLayer(inputs: CommandInputs): Record<string, string> {
  const layer: Record<string, string> = {
    ARGUS_INSTANCE_ID: inputs.instanceId,
    ARGUS_PHASE_ID: inputs.phaseId,
    ARGUS_PHASE_ATTEMPT: String(inputs.attempt),
  };
  if (inputs.artifactDir) layer.ARGUS_ARTIFACT_DIR = inputs.artifactDir;
  if (inputs.workspace) layer.ARGUS_WORKSPACE = inputs.workspace;
  if (inputs.triggerPayloadFile) layer.ARGUS_TRIGGER_PAYLOAD_FILE = inputs.triggerPayloadFile;
  return layer;
}
