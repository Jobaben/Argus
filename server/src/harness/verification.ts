/**
 * Argus's own deterministic checks over a phase's work.
 *
 * Every step of a phase can report success while having done nothing of the
 * sort — an agent's self-report is not evidence. Once every step of a phase
 * signals success, Argus runs the phase's `checks` (see `PhaseCheck` in
 * `@argus/contracts`) itself: run a command, look for a file the phase was
 * supposed to leave, or confirm the working tree actually changed. A failing
 * check fails the phase under the `verification` failure class, distinct from
 * a step's own exit code or timeout.
 *
 * Mirrors the bounded-child-process discipline in `../sources/analysis.ts`:
 * detached process group on POSIX so a timeout kills the whole tree, and a
 * capped rolling output buffer so a runaway command cannot exhaust memory.
 * Nothing in this module ever throws for an expected failure condition —
 * every check produces a `CheckResult`, because the report itself is the
 * evidence a failed phase leaves behind.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CheckResult, PhaseCheck, VerificationReport } from "../sources/pipelineTypes.js";

/** Combined stdout+stderr is capped in memory; only the tail is kept as evidence. */
export const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
/** How much of the captured output survives into the report. */
export const OUTPUT_TAIL_CHARS = 4000;
/** Default wall-clock limit for a `command` check that doesn't set its own. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

/** Names Argus never hands to a check's command — see `../harness/childEnv.ts`. */
const ARGUS_SERVER_SECRETS = ["ARGUS_TOKEN", "ARGUS_WEBHOOK_URL"];

function defaultCheckEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ARGUS_SERVER_SECRETS.includes(name)) continue;
    env[name] = value;
  }
  return env;
}

// ── Working-tree snapshots ───────────────────────────────────────────────────

export interface WorkingTreeSnapshot {
  /** `git rev-parse HEAD`, or null when not a repo / no commits. */
  head: string | null;
  /** Dirty paths (repo-relative, renames use the new path) → identity string:
   *  `${statusCode}:${sha256 of working-copy bytes}` or `${statusCode}:deleted`. */
  dirty: Record<string, string>;
}

function runGit(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = nodeSpawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: null, stdout: Buffer.concat(chunks), stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ code, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

/**
 * Take a snapshot of `cwd`'s git working tree: the current HEAD and, for
 * every dirty path, an identity that changes iff the file's bytes (or its
 * presence) changes. Returns null when `cwd` is not inside a git work tree,
 * or git itself is unavailable — this never throws.
 */
export async function snapshotWorkingTree(cwd: string): Promise<WorkingTreeSnapshot | null> {
  const top = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (top.code !== 0) return null;

  const headRes = await runGit(["rev-parse", "HEAD"], cwd);
  const head = headRes.code === 0 ? headRes.stdout.toString("utf8").trim() : null;

  const statusRes = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
  if (statusRes.code !== 0) return { head, dirty: {} };

  const dirty: Record<string, string> = {};
  const raw = statusRes.stdout.toString("utf8");
  const entries = raw.split("\0").filter((s) => s.length > 0);
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    const statusCode = entry.slice(0, 2);
    let repoRelPath = entry.slice(3);
    i++;
    // Renames/copies carry a second NUL-separated field: the *old* path. The
    // entry's own path (already consumed above) is the new one.
    if (/^[RC]/.test(statusCode)) {
      i++; // skip the old path field
    }
    repoRelPath = repoRelPath.trim();
    const abs = path.join(top.stdout.toString("utf8").trim(), repoRelPath);
    const isDeleted = statusCode.includes("D");
    if (isDeleted) {
      dirty[repoRelPath] = `${statusCode}:deleted`;
      continue;
    }
    try {
      const bytes = await readFile(abs);
      const hash = createHash("sha256").update(bytes).digest("hex");
      dirty[repoRelPath] = `${statusCode}:${hash}`;
    } catch {
      // Vanished between `git status` and our read, or unreadable — treat
      // like a deletion rather than throwing away the whole snapshot.
      dirty[repoRelPath] = `${statusCode}:deleted`;
    }
  }
  return { head, dirty };
}

/**
 * Paths whose identity differs between `baseline` and `current`: added,
 * modified since baseline, deleted, or newly dirty. A path dirty in both
 * snapshots with an identical hash is unchanged and is not reported. Sorted.
 */
export function changedSince(
  baseline: WorkingTreeSnapshot,
  current: WorkingTreeSnapshot,
): string[] {
  const changed = new Set<string>();
  for (const [p, identity] of Object.entries(current.dirty)) {
    if (baseline.dirty[p] !== identity) changed.add(p);
  }
  for (const [p, identity] of Object.entries(baseline.dirty)) {
    if (current.dirty[p] !== identity) changed.add(p);
  }
  return [...changed].sort();
}

// ── Checks ────────────────────────────────────────────────────────────────

export interface CheckContext {
  /** The phase's working directory. */
  cwd: string;
  /** Where the phase's agents were told to write artifacts, or null. */
  artifactDir: string | null;
  /** Working-tree snapshot taken when the phase attempt started; null if unavailable. */
  baseline: WorkingTreeSnapshot | null;
  now?: () => Date;
  /** Default per-command timeout; default 600_000 ms. */
  defaultCommandTimeoutMs?: number;
  /** Environment for command checks. Default: process.env with ARGUS_TOKEN and ARGUS_WEBHOOK_URL removed. */
  env?: Record<string, string>;
}

/** Human label for a check: its own `label`, else a kind-appropriate default. */
export function checkLabel(check: PhaseCheck): string {
  if (check.label) return check.label;
  switch (check.kind) {
    case "command": {
      const clipped =
        check.run.length > 80 - "command: ".length
          ? check.run.slice(0, 80 - "command: ".length)
          : check.run;
      return `command: ${clipped}`;
    }
    case "artifact":
      return `artifact: ${check.path}`;
    case "file":
      return `file: ${check.path}`;
    case "changed-files":
      return "changed files";
  }
}

function result(
  check: PhaseCheck,
  status: "passed" | "failed",
  detail: string,
  durationMs: number,
  extra?: { exitCode?: number | null; output?: string },
): CheckResult {
  return {
    kind: check.kind,
    label: checkLabel(check),
    status,
    detail,
    durationMs,
    ...(extra?.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
    ...(extra?.output !== undefined ? { output: extra.output } : {}),
  };
}

async function runCommandCheck(
  check: Extract<PhaseCheck, { kind: "command" }>,
  ctx: CheckContext,
): Promise<CheckResult> {
  const started = Date.now();
  const resolvedCwd = check.cwd ? path.resolve(ctx.cwd, check.cwd) : ctx.cwd;
  try {
    const st = await stat(resolvedCwd);
    if (!st.isDirectory()) {
      return result(check, "failed", `cwd does not exist: ${resolvedCwd}`, Date.now() - started);
    }
  } catch {
    return result(check, "failed", `cwd does not exist: ${resolvedCwd}`, Date.now() - started);
  }

  const timeoutMs =
    check.timeoutSeconds != null && check.timeoutSeconds > 0
      ? check.timeoutSeconds * 1000
      : (ctx.defaultCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  const env = ctx.env ?? defaultCheckEnv();

  return new Promise<CheckResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(check.run, {
        cwd: resolvedCwd,
        env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e) {
      resolve(
        result(check, "failed", e instanceof Error ? e.message : String(e), Date.now() - started),
      );
      return;
    }

    let output = "";
    let timedOut = false;
    let killedSignal: string | null = null;
    let settled = false;

    function append(chunk: Buffer): void {
      output += chunk.toString("utf8");
      if (output.length > MAX_COMMAND_OUTPUT_BYTES) {
        output = output.slice(output.length - MAX_COMMAND_OUTPUT_BYTES);
      }
    }
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    function killGroup(): void {
      if (child.pid == null) return;
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid);
      } catch {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    function finish(res: CheckResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    }

    child.on("error", (err) => {
      finish(result(check, "failed", err.message, Date.now() - started, { output: tail(output) }));
    });
    child.on("close", (code, signal) => {
      const durationMs = Date.now() - started;
      if (timedOut) {
        finish(
          result(check, "failed", `timed out after ${Math.round(timeoutMs / 1000)}s`, durationMs, {
            exitCode: code,
            output: tail(output),
          }),
        );
        return;
      }
      if (signal) {
        killedSignal = signal;
        finish(
          result(check, "failed", `killed by ${killedSignal}`, durationMs, {
            exitCode: code,
            output: tail(output),
          }),
        );
        return;
      }
      if (code === 0) {
        finish(
          result(check, "passed", `exit 0 in ${durationMs}ms`, durationMs, {
            exitCode: code,
            output: tail(output),
          }),
        );
        return;
      }
      finish(
        result(check, "failed", `exit ${code}`, durationMs, {
          exitCode: code,
          output: tail(output),
        }),
      );
    });
  });
}

function tail(output: string): string {
  return output.length > OUTPUT_TAIL_CHARS
    ? output.slice(output.length - OUTPUT_TAIL_CHARS)
    : output;
}

/** Resolve `requested` under `root`, rejecting an absolute path or an escape. */
function resolveWithin(root: string, requested: string): string | null {
  if (path.isAbsolute(requested)) return null;
  const resolved = path.resolve(root, requested);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

async function runFileLikeCheck(
  check: Extract<PhaseCheck, { kind: "artifact" | "file" }>,
  root: string | null,
): Promise<CheckResult> {
  const started = Date.now();
  const now = () => Date.now() - started;
  if (root === null) {
    return result(check, "failed", "phase has no artifact directory", now());
  }
  if (path.isAbsolute(check.path)) {
    return result(
      check,
      "failed",
      `path escapes ${check.kind === "artifact" ? "artifact directory" : "working directory"}: ${check.path}`,
      now(),
    );
  }
  const resolved = resolveWithin(root, check.path);
  if (resolved === null) {
    return result(
      check,
      "failed",
      `path escapes ${check.kind === "artifact" ? "artifact directory" : "working directory"}: ${check.path}`,
      now(),
    );
  }
  const minBytes = check.minBytes ?? 1;
  let st;
  try {
    st = await stat(resolved);
  } catch {
    return result(check, "failed", "missing", now());
  }
  if (!st.isFile()) {
    return result(check, "failed", "missing", now());
  }
  if (st.size < minBytes) {
    return result(check, "failed", `empty (${st.size} bytes, need ${minBytes})`, now());
  }
  return result(check, "passed", `${st.size} bytes`, now());
}

async function runChangedFilesCheck(
  check: Extract<PhaseCheck, { kind: "changed-files" }>,
  ctx: CheckContext,
): Promise<CheckResult> {
  const started = Date.now();
  const now = () => Date.now() - started;
  if (!ctx.baseline) {
    return result(
      check,
      "failed",
      "no working-tree baseline was recorded (not a git repository?)",
      now(),
    );
  }
  const current = await snapshotWorkingTree(ctx.cwd);
  if (!current) {
    return result(
      check,
      "failed",
      "no working-tree baseline was recorded (not a git repository?)",
      now(),
    );
  }
  const changed = changedSince(ctx.baseline, current);

  if (check.requireChanges && changed.length === 0) {
    return result(check, "failed", "no files changed", now());
  }

  const offending: string[] = [];
  for (const p of changed) {
    const forwardSlash = p.split(path.sep).join("/");
    if (check.allow && check.allow.length > 0) {
      const allowed = check.allow.some((glob) => path.matchesGlob(forwardSlash, glob));
      if (!allowed) {
        offending.push(p);
        continue;
      }
    }
    if (check.deny && check.deny.length > 0) {
      const denied = check.deny.some((glob) => path.matchesGlob(forwardSlash, glob));
      if (denied) {
        offending.push(p);
      }
    }
  }

  if (offending.length > 0) {
    const shown = offending.slice(0, 20);
    return result(
      check,
      "failed",
      `${offending.length} file(s) not allowed: ${shown.join(", ")}${offending.length > shown.length ? ", ..." : ""}`,
      now(),
      { output: changed.slice(0, 200).join("\n") },
    );
  }

  return result(check, "passed", `${changed.length} changed file(s)`, now(), {
    output: changed.slice(0, 200).join("\n"),
  });
}

/** Run one check and return its result. Never throws. */
export async function runCheck(check: PhaseCheck, ctx: CheckContext): Promise<CheckResult> {
  try {
    switch (check.kind) {
      case "command":
        return await runCommandCheck(check, ctx);
      case "artifact":
        return await runFileLikeCheck(check, ctx.artifactDir);
      case "file":
        return await runFileLikeCheck(check, ctx.cwd);
      case "changed-files":
        return await runChangedFilesCheck(check, ctx);
    }
  } catch (e) {
    return result(check, "failed", e instanceof Error ? e.message : String(e), 0);
  }
}

/**
 * Run every check sequentially — never stopping early, because the report
 * itself is the evidence a failed phase leaves behind. Status is "passed" iff
 * every check passed.
 */
export async function runChecks(
  checks: PhaseCheck[],
  ctx: CheckContext,
): Promise<VerificationReport> {
  const now = ctx.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await runCheck(check, ctx));
  }
  const endedAt = now().toISOString();
  const status = results.every((r) => r.status === "passed") ? "passed" : "failed";
  return { status, startedAt, endedAt, checks: results };
}
