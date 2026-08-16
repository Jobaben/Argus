/**
 * Registering the Argus signal hook with Qwen Code.
 *
 * Qwen Code's hooks are Claude Code's, down to the file: a `hooks` object in
 * `settings.json` keyed by event name, each holding groups of
 * `{ type: "command", command }` entries, invoked with a JSON payload on stdin
 * that names the agent's closing words `last_assistant_message`. So Argus
 * installs the *same* `argus-signal.mjs` it installs for Claude Code and Codex,
 * and the hook needs no branch for this runtime.
 *
 * What differs is only where the file lives — `~/.qwen/settings.json`, whose
 * other keys belong to the operator — so the read-modify-write here is the
 * careful kind: a present-but-unparseable file is an error rather than a fresh
 * start, because treating it as `{}` would clobber recoverable settings on the
 * way back out.
 *
 * There is no PreToolUse twin. Qwen Code has no `AskUserQuestion` tool to match
 * on; a gated phase still pauses, because the engine holds the gate open on the
 * phase's *completion* signal rather than on the agent asking a question.
 */

import { mkdir, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { qwenPaths } from "../qwenHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";

interface HookEntry {
  type?: string;
  command?: string;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

/** Absolute, forward-slashed command for the hook, resolved from the Qwen home. */
export function qwenHookCommand(): string {
  return `node "${path.join(qwenPaths.hooksDir(), "argus-signal.mjs").replace(/\\/g, "/")}"`;
}

/** Copies the shipped hook into `~/.qwen/hooks/`. */
export async function copyQwenHookFile(repoHookSrc: string): Promise<void> {
  await mkdir(qwenPaths.hooksDir(), { recursive: true });
  await copyFile(repoHookSrc, path.join(qwenPaths.hooksDir(), "argus-signal.mjs"));
}

/** Reads settings.json; returns {} on any read/parse error (never throws). */
export async function readQwenSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(qwenPaths.settingsFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Read settings.json for a read-modify-WRITE cycle. A missing file is a fresh
 * start ({}), but a present-yet-unparseable file throws — silently treating it
 * as {} would clobber the user's (recoverable) settings on the write-back.
 */
async function readForWrite(): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(qwenPaths.settingsFile(), "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${qwenPaths.settingsFile()} is corrupt; refusing to modify it — repair or remove it first`,
    );
  }
}

/** True when a Stop hook already points at the Argus signal script. */
export function hasArgusStopHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const groups = Array.isArray(hooks?.Stop) ? (hooks.Stop as HookGroup[]) : [];
  return groups.some((g) =>
    (g?.hooks ?? []).some((h) => (h?.command ?? "").includes("argus-signal")),
  );
}

/** Registers the Stop hook, creating settings.json if there isn't one. Idempotent. */
export async function installQwenStopHook(): Promise<void> {
  const settings = await readForWrite();
  if (hasArgusStopHook(settings)) return;
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const stop = (Array.isArray(hooks.Stop) ? hooks.Stop : (hooks.Stop = [])) as HookGroup[];
  stop.push({ matcher: "", hooks: [{ type: "command", command: qwenHookCommand() }] });
  await mkdir(qwenPaths.root(), { recursive: true });
  await atomicWriteJson(qwenPaths.settingsFile(), settings);
}
