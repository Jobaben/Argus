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
 * `ARGUS_ARTIFACT_DIR`, `ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`,
 * `ARGUS_RUN_ID`).
 *
 * The rule this module enforces: an agent must never be able to administer
 * the harness that runs it. `buildChildEnv` is the one place that assembles
 * a child process's environment, so every runtime should route through it
 * rather than spreading `process.env` by hand.
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
const ARGUS_PER_INVOCATION_IDENTIFIERS: readonly string[] = [
  "ARGUS_SIGNAL_TOKEN",
  "ARGUS_SIGNAL_URL",
  "ARGUS_RESULT_FILE",
  "ARGUS_ARTIFACT_DIR",
  "ARGUS_INSTANCE_ID",
  "ARGUS_PHASE_ID",
  "ARGUS_RUN_ID",
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
