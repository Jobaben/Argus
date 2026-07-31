/**
 * Registering the Argus signal hook with the Codex CLI.
 *
 * Claude Code's hooks live in JSON, so Argus parses `settings.json`, adds an
 * entry and writes it back. Codex's live in `~/.codex/config.toml`, and a TOML
 * round-trip through a parser would rewrite the operator's file — losing
 * comments, reordering tables, normalising strings — every time the setup pass
 * runs. That is a bad trade for adding four lines, so this module never
 * rewrites: it reads the text, decides whether the hook is already there, and
 * if not **appends** a fresh `[[hooks.stop]]` block at the end. An
 * array-of-tables header is valid wherever it appears, so appending is a
 * well-formed edit regardless of what precedes it, and everything the operator
 * wrote is byte-for-byte untouched.
 *
 * The one arrangement that would break — a scalar `stop = …` inside `[hooks]`,
 * which makes `[[hooks.stop]]` a type conflict — is detected and reported as an
 * error for a human to resolve, rather than silently corrupting the file.
 */

import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { codexPaths } from "../codexHome.js";

/** Absolute, forward-slashed path of the hook Argus installs for Codex. */
export function codexHookPath(): string {
  return path.join(codexPaths.hooksDir(), "argus-signal.mjs").replace(/\\/g, "/");
}

/** The `command` array Codex invokes. An array, not a string, so no shell
 *  quoting stands between the path and the process. */
export function codexHookCommand(): string[] {
  return ["node", codexHookPath()];
}

/** Minimal TOML basic-string escaping — enough for a filesystem path. */
function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Reads config.toml as text. A missing file is an empty config, not an error. */
export async function readCodexConfig(): Promise<string> {
  try {
    return await readFile(codexPaths.configFile(), "utf8");
  } catch {
    return "";
  }
}

/**
 * True when a `[[hooks.stop]]` block already points at the Argus hook.
 *
 * Matched on the block, not merely on the filename appearing somewhere in the
 * file: a `session_start` hook that happens to log via the same script must not
 * be mistaken for the stop registration Argus needs.
 */
export function hasArgusStopHook(toml: string): boolean {
  for (const block of hookBlocks(toml, "stop")) {
    if (/argus-signal/.test(block)) return true;
  }
  return false;
}

/** The text of each `[[hooks.<event>]]` block in the file, header excluded. */
function hookBlocks(toml: string, event: string): string[] {
  const out: string[] = [];
  const header = new RegExp(`^\\s*\\[\\[\\s*hooks\\.${event}\\s*\\]\\]\\s*$`);
  const subTable = new RegExp(`^\\s*\\[\\s*hooks\\.${event}\\.`);
  const anyHeader = /^\s*\[\[?[^\]]+\]\]?\s*$/;
  let current: string[] | null = null;
  for (const line of toml.split("\n")) {
    if (header.test(line)) {
      if (current) out.push(current.join("\n"));
      current = [];
      continue;
    }
    if (current && anyHeader.test(line)) {
      // A nested `[hooks.<event>.matcher]` sub-table still belongs to this block.
      if (!subTable.test(line)) {
        out.push(current.join("\n"));
        current = null;
        continue;
      }
    }
    current?.push(line);
  }
  if (current) out.push(current.join("\n"));
  return out;
}

/**
 * A `stop` key declared as a scalar under `[hooks]`.
 *
 * TOML forbids the same name being both a value and an array of tables, so an
 * appended `[[hooks.stop]]` would make the whole config unparseable and take
 * Codex down with it. Refusing is the only safe answer.
 */
export function hasConflictingStopKey(toml: string): boolean {
  let inHooks = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (/^\[\[?[^\]]+\]\]?$/.test(line)) {
      inHooks = /^\[\s*hooks\s*\]$/.test(line);
      continue;
    }
    if (inHooks && /^stop\s*=/.test(line)) return true;
  }
  return false;
}

/** The config text with an Argus `[[hooks.stop]]` block appended. Pure. */
export function appendStopHook(toml: string, command: string[]): string {
  const body = [
    "# Added by Argus. Emits a pipeline completion signal when a run stops, so a",
    "# gated phase can pause and a finished phase can advance. Harmless outside a",
    "# pipeline: the hook no-ops when the ARGUS_* environment is absent.",
    "[[hooks.stop]]",
    'name = "argus-signal"',
    `command = [${command.map(tomlString).join(", ")}]`,
    "",
  ].join("\n");
  const base = toml.length === 0 ? "" : toml.endsWith("\n") ? toml : `${toml}\n`;
  return `${base}${base ? "\n" : ""}${body}`;
}

/** Copies the shipped hook into `~/.codex/hooks/`. */
export async function copyCodexHookFile(repoHookSrc: string): Promise<void> {
  await mkdir(codexPaths.hooksDir(), { recursive: true });
  await copyFile(repoHookSrc, path.join(codexPaths.hooksDir(), "argus-signal.mjs"));
}

export class CodexConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexConfigError";
  }
}

/** Registers the stop hook, creating config.toml if there isn't one. Idempotent. */
export async function installCodexStopHook(): Promise<void> {
  const toml = await readCodexConfig();
  if (hasArgusStopHook(toml)) return;
  if (hasConflictingStopKey(toml)) {
    throw new CodexConfigError(
      `${codexPaths.configFile()} declares \`stop\` as a value under [hooks]; ` +
        "Argus can't add a [[hooks.stop]] block beside it. Move that key into a " +
        "[[hooks.stop]] block, then apply fixes again.",
    );
  }
  await mkdir(codexPaths.root(), { recursive: true });
  await writeFile(codexPaths.configFile(), appendStopHook(toml, codexHookCommand()), "utf8");
}
