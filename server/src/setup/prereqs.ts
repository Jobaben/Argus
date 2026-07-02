import { readFile, writeFile, mkdir, copyFile, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeHome, paths } from "../claudeHome.js";

export type PrereqStatus = "ok" | "missing" | "error";

export interface PrereqResult {
  id: string;
  label: string;
  status: PrereqStatus;
  fixable: boolean;
  detail?: string;
}

interface Prerequisite {
  id: string;
  label: string;
  fixable: boolean;
  check(): Promise<PrereqResult>;
  apply?(): Promise<void>;
}

/** Absolute, forward-slashed command for the hook, resolved from the Claude home. */
export function hookCommand(arg?: string): string {
  const p = path.join(paths.hooksDir(), "argus-signal.mjs").replace(/\\/g, "/");
  return arg ? `node "${p}" ${arg}` : `node "${p}"`;
}

/** Canonical hook source shipped in the repo: <repo>/hooks/argus-signal.mjs */
const REPO_HOOK_SRC = fileURLToPath(new URL("../../../hooks/argus-signal.mjs", import.meta.url));

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(claudeHome(), { recursive: true });
  const file = paths.settingsFile();
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
  await rename(tmp, file);
}

async function copyHookFile(): Promise<void> {
  await mkdir(paths.hooksDir(), { recursive: true });
  await copyFile(REPO_HOOK_SRC, path.join(paths.hooksDir(), "argus-signal.mjs"));
}

/** Appends a hook group to settings.hooks[event], creating the arrays as needed. */
function pushGroup(settings: Record<string, unknown>, event: string, group: HookGroup): void {
  const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
  const arr = (Array.isArray(hooks[event]) ? hooks[event] : (hooks[event] = [])) as HookGroup[];
  arr.push(group);
}

/** Reads settings.json; returns {} on any read/parse error (never throws). */
export async function readSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(paths.settingsFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface HookGroup { matcher?: string; hooks?: { type?: string; command?: string }[] }

function groupsFor(settings: Record<string, unknown>, event: string): HookGroup[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const arr = hooks?.[event];
  return Array.isArray(arr) ? (arr as HookGroup[]) : [];
}

function commands(groups: HookGroup[]): { matcher: string; command: string }[] {
  return groups.flatMap((g) =>
    (g.hooks ?? []).map((h) => ({ matcher: g.matcher ?? "", command: h.command ?? "" })),
  );
}

function onPath(cmd: string): boolean {
  try {
    const res = spawnSync(cmd, ["--version"], { timeout: 3000, shell: process.platform === "win32" });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

const REGISTRY: Prerequisite[] = [
  {
    id: "signal-stop-hook",
    label: "Signal Stop hook",
    fixable: true,
    async check() {
      const has = commands(groupsFor(await readSettings(), "Stop")).some((c) =>
        c.command.includes("argus-signal"),
      );
      return {
        id: "signal-stop-hook", label: "Signal Stop hook", fixable: true,
        status: has ? "ok" : "missing",
        detail: has ? undefined : "Pipelines can't complete without this hook.",
      };
    },
    async apply() {
      await copyHookFile();
      const settings = await readSettings();
      const present = commands(groupsFor(settings, "Stop")).some((c) => c.command.includes("argus-signal"));
      if (present) return;
      pushGroup(settings, "Stop", { matcher: "", hooks: [{ type: "command", command: hookCommand() }] });
      await writeSettings(settings);
    },
  },
  {
    id: "gate-pretooluse-hook",
    label: "Gate PreToolUse hook",
    fixable: true,
    async check() {
      const has = commands(groupsFor(await readSettings(), "PreToolUse")).some(
        (c) => c.matcher.includes("AskUserQuestion") && c.command.includes("argus-signal") && c.command.includes("needs-input"),
      );
      return {
        id: "gate-pretooluse-hook", label: "Gate PreToolUse hook", fixable: true,
        status: has ? "ok" : "missing",
        detail: has ? undefined : "Gated phases won't pause for approval without this hook.",
      };
    },
    async apply() {
      await copyHookFile();
      const settings = await readSettings();
      const present = commands(groupsFor(settings, "PreToolUse")).some(
        (c) => c.matcher.includes("AskUserQuestion") && c.command.includes("argus-signal") && c.command.includes("needs-input"),
      );
      if (present) return;
      pushGroup(settings, "PreToolUse", { matcher: "AskUserQuestion", hooks: [{ type: "command", command: hookCommand("needs-input") }] });
      await writeSettings(settings);
    },
  },
  {
    id: "claude-cli",
    label: "Claude CLI on PATH",
    fixable: false,
    async check() {
      const ok = onPath("claude");
      return {
        id: "claude-cli", label: "Claude CLI on PATH", fixable: false,
        status: ok ? "ok" : "error",
        detail: ok ? undefined : "`claude` was not found on PATH. Install the Claude CLI.",
      };
    },
  },
  {
    id: "node-runtime",
    label: "Node on PATH",
    fixable: false,
    async check() {
      const ok = onPath("node");
      return {
        id: "node-runtime", label: "Node on PATH", fixable: false,
        status: ok ? "ok" : "error",
        detail: ok ? undefined : "`node` was not found on PATH; hooks run via node.",
      };
    },
  },
];

export async function checkAll(): Promise<{ ok: boolean; prereqs: PrereqResult[] }> {
  const prereqs = await Promise.all(REGISTRY.map((p) => p.check()));
  const ok = prereqs.every((p) => p.status === "ok");
  return { ok, prereqs };
}

export async function applyAll(): Promise<{ ok: boolean; prereqs: PrereqResult[] }> {
  const errors = new Map<string, string>();
  for (const p of REGISTRY) {
    if (!p.fixable || !p.apply) continue;
    const status = await p.check();
    if (status.status !== "missing") continue;
    try {
      await p.apply();
    } catch (e) {
      errors.set(p.id, e instanceof Error ? e.message : String(e));
    }
  }
  const result = await checkAll();
  if (errors.size === 0) return result;
  const prereqs = result.prereqs.map((r) =>
    errors.has(r.id) ? { ...r, status: "error" as const, detail: errors.get(r.id) } : r,
  );
  return { ok: prereqs.every((p) => p.status === "ok"), prereqs };
}

export { REGISTRY, claudeHome };
