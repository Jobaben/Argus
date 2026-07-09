import { readFile, mkdir, copyFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeHome, paths } from "../claudeHome.js";
import { atomicWriteJson } from "../sources/atomicWrite.js";

export type PrereqStatus = "ok" | "missing" | "outdated" | "error";

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

/** SHA-256 of a file's raw bytes; null if unreadable. */
async function fileHash(p: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(p))
      .digest("hex");
  } catch {
    return null;
  }
}

/** True only when the installed hook exists and its bytes match the repo's canonical source. */
async function installedHookMatchesRepo(): Promise<boolean> {
  const installed = await fileHash(path.join(paths.hooksDir(), "argus-signal.mjs"));
  if (installed === null) return false;
  const repo = await fileHash(REPO_HOOK_SRC);
  return repo !== null && installed === repo;
}

/** Ensures the Argus data directories exist. Idempotent. mkdir -p also creates paths.argus(). */
async function ensureDataDirs(): Promise<void> {
  await mkdir(paths.instancesDir(), { recursive: true });
  await mkdir(paths.runsDir(), { recursive: true });
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  // Delegate to the shared atomic writer (pid+random temp name) rather than a
  // pid-only temp, which would collide between concurrent same-process writers.
  await atomicWriteJson(paths.settingsFile(), settings);
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

/**
 * Read settings.json for a read-modify-WRITE cycle. A missing file is a fresh
 * start ({}), but a present-yet-unparseable file throws — silently treating it
 * as {} would clobber the user's (recoverable) settings on the write-back.
 */
async function readSettingsForWrite(): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(paths.settingsFile(), "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("settings.json is corrupt; refusing to modify it — repair or remove it first");
  }
}

interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

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

/**
 * Probes a CLI by running it (default `--version`). On failure the reason
 * distinguishes not-found, launch errors (EAGAIN, sandbox blocks), timeouts
 * and nonzero exits — collapsing these into "not on PATH" hides the real
 * problem when the process itself can't spawn children.
 */
export function probeCommand(
  cmd: string,
  args: string[] = ["--version"],
  timeoutMs = 3000,
): { ok: boolean; reason?: string } {
  try {
    const res = spawnSync(cmd, args, {
      timeout: timeoutMs,
      shell: process.platform === "win32",
    });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { ok: false, reason: "was not found on PATH" };
      if (code === "ETIMEDOUT") return { ok: false, reason: `timed out after ${timeoutMs}ms` };
      return { ok: false, reason: `could not be launched (${code ?? res.error.message})` };
    }
    if (res.signal) {
      return { ok: false, reason: `timed out after ${timeoutMs}ms (killed with ${res.signal})` };
    }
    if (res.status !== 0) {
      const stderr = String(res.stderr ?? "")
        .trim()
        .split("\n")[0]
        ?.slice(0, 120);
      return {
        ok: false,
        reason: `exited with code ${res.status}${stderr ? `: ${stderr}` : ""}`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const REGISTRY: Prerequisite[] = [
  {
    id: "signal-stop-hook",
    label: "Signal Stop hook",
    fixable: true,
    async check() {
      const registered = commands(groupsFor(await readSettings(), "Stop")).some((c) =>
        c.command.includes("argus-signal"),
      );
      const fresh = await installedHookMatchesRepo();
      const status: PrereqStatus = !registered ? "missing" : !fresh ? "outdated" : "ok";
      return {
        id: "signal-stop-hook",
        label: "Signal Stop hook",
        fixable: true,
        status,
        detail:
          status === "missing"
            ? "Pipelines can't complete without this hook."
            : status === "outdated"
              ? "Installed hook differs from the shipped version — runs may mis-report their outcome. Apply fixes to refresh it."
              : undefined,
      };
    },
    async apply() {
      await copyHookFile();
      const settings = await readSettingsForWrite();
      const present = commands(groupsFor(settings, "Stop")).some((c) =>
        c.command.includes("argus-signal"),
      );
      if (present) return;
      pushGroup(settings, "Stop", {
        matcher: "",
        hooks: [{ type: "command", command: hookCommand() }],
      });
      await writeSettings(settings);
    },
  },
  {
    id: "gate-pretooluse-hook",
    label: "Gate PreToolUse hook",
    fixable: true,
    async check() {
      const registered = commands(groupsFor(await readSettings(), "PreToolUse")).some(
        (c) =>
          c.matcher.includes("AskUserQuestion") &&
          c.command.includes("argus-signal") &&
          c.command.includes("needs-input"),
      );
      const fresh = await installedHookMatchesRepo();
      const status: PrereqStatus = !registered ? "missing" : !fresh ? "outdated" : "ok";
      return {
        id: "gate-pretooluse-hook",
        label: "Gate PreToolUse hook",
        fixable: true,
        status,
        detail:
          status === "missing"
            ? "Gated phases won't pause for approval without this hook."
            : status === "outdated"
              ? "Installed hook differs from the shipped version. Apply fixes to refresh it."
              : undefined,
      };
    },
    async apply() {
      await copyHookFile();
      const settings = await readSettingsForWrite();
      const present = commands(groupsFor(settings, "PreToolUse")).some(
        (c) =>
          c.matcher.includes("AskUserQuestion") &&
          c.command.includes("argus-signal") &&
          c.command.includes("needs-input"),
      );
      if (present) return;
      pushGroup(settings, "PreToolUse", {
        matcher: "AskUserQuestion",
        hooks: [{ type: "command", command: hookCommand("needs-input") }],
      });
      await writeSettings(settings);
    },
  },
  {
    id: "argus-data-dir",
    label: "Argus data directories",
    fixable: true,
    async check() {
      const missing = [paths.argus(), paths.instancesDir(), paths.runsDir()].filter(
        (d) => !existsSync(d),
      );
      return {
        id: "argus-data-dir",
        label: "Argus data directories",
        fixable: true,
        status: missing.length === 0 ? "ok" : "missing",
        detail:
          missing.length === 0
            ? undefined
            : `Missing: ${missing.join(", ")}. Pipelines store instances and run logs here.`,
      };
    },
    async apply() {
      await ensureDataDirs();
    },
  },
  {
    id: "claude-cli",
    label: "Claude CLI on PATH",
    fixable: false,
    async check() {
      const probe = probeCommand("claude");
      return {
        id: "claude-cli",
        label: "Claude CLI on PATH",
        fixable: false,
        status: probe.ok ? "ok" : "error",
        detail: probe.ok ? undefined : `\`claude\` ${probe.reason}. Install the Claude CLI.`,
      };
    },
  },
  {
    id: "node-runtime",
    label: "Node on PATH",
    fixable: false,
    async check() {
      const probe = probeCommand("node");
      return {
        id: "node-runtime",
        label: "Node on PATH",
        fixable: false,
        status: probe.ok ? "ok" : "error",
        detail: probe.ok ? undefined : `\`node\` ${probe.reason}; hooks run via node.`,
      };
    },
  },
  {
    id: "pipelines-parse",
    label: "pipelines.json parses",
    fixable: false,
    async check() {
      const file = paths.pipelinesFile();
      if (!existsSync(file)) {
        return {
          id: "pipelines-parse",
          label: "pipelines.json parses",
          fixable: false,
          status: "ok",
        };
      }
      try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        const valid = Array.isArray(parsed);
        return {
          id: "pipelines-parse",
          label: "pipelines.json parses",
          fixable: false,
          status: valid ? "ok" : "error",
          detail: valid
            ? undefined
            : `${file} is not a JSON array; the engine refuses to write pipelines until this is fixed.`,
        };
      } catch (e) {
        return {
          id: "pipelines-parse",
          label: "pipelines.json parses",
          fixable: false,
          status: "error",
          detail: `${file} could not be parsed (${e instanceof Error ? e.message : String(e)}); the engine refuses to write pipelines until this is fixed.`,
        };
      }
    },
  },
  {
    id: "settings-parse",
    label: "settings.json parses",
    fixable: false,
    async check() {
      const file = paths.settingsFile();
      if (!existsSync(file)) {
        return {
          id: "settings-parse",
          label: "settings.json parses",
          fixable: false,
          status: "ok",
        };
      }
      try {
        JSON.parse(await readFile(file, "utf8"));
        return {
          id: "settings-parse",
          label: "settings.json parses",
          fixable: false,
          status: "ok",
        };
      } catch (e) {
        return {
          id: "settings-parse",
          label: "settings.json parses",
          fixable: false,
          status: "error",
          detail: `${file} could not be parsed (${e instanceof Error ? e.message : String(e)}); hooks can't be read or registered until this is fixed.`,
        };
      }
    },
  },
];

const CRITICAL_IDS = new Set([
  "signal-stop-hook",
  "gate-pretooluse-hook",
  "argus-data-dir",
  "claude-cli",
  "node-runtime",
]);

/**
 * Re-checks the critical prerequisites that make a run's completion signal
 * trustworthy, auto-repairing any fixable ones first. Returns ok=false with
 * human-readable reasons when something critical is still broken. Never throws.
 */
export async function preflight(): Promise<{ ok: boolean; reasons: string[] }> {
  for (const p of REGISTRY) {
    if (!CRITICAL_IDS.has(p.id) || !p.fixable || !p.apply) continue;
    const s = await p.check();
    if (s.status === "missing" || s.status === "outdated") {
      try {
        await p.apply();
      } catch {
        /* surfaced by the re-check below */
      }
    }
  }
  const results = await Promise.all(
    REGISTRY.filter((p) => CRITICAL_IDS.has(p.id)).map((p) =>
      // Defensive: a check() should never throw, but if a future one does,
      // degrade to an error result so preflight stays never-throwing (clean
      // 412 refusal) rather than escaping as a 500.
      p.check().catch((e): PrereqResult => ({
        id: p.id,
        label: p.label,
        fixable: p.fixable,
        status: "error",
        detail: e instanceof Error ? e.message : String(e),
      })),
    ),
  );
  const bad = results.filter((r) => r.status !== "ok");
  return { ok: bad.length === 0, reasons: bad.map((r) => `${r.label}: ${r.detail ?? r.status}`) };
}

/**
 * Repairs only the intrinsically-safe fixables: re-copies the hook file and
 * creates data dirs. NEVER edits settings.json. Used at server startup.
 */
export async function repairSafeFixables(): Promise<void> {
  try {
    await copyHookFile();
  } catch {
    /* re-check by caller surfaces failures */
  }
  try {
    await ensureDataDirs();
  } catch {
    /* idem */
  }
}

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
    if (status.status !== "missing" && status.status !== "outdated") continue;
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
