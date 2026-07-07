import { readFile, readdir, rm, stat } from "node:fs/promises";
import { open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import type { Run } from "./scheduleTypes.js";

export const LOG_CAP_BYTES = 1_048_576; // 1 MB
export const RUN_KEEP = 50;

// Run ids are generated UUIDs; reject anything that could escape the runs dir
// (no dots/slashes allowed, mirroring the session-route segment guard).
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Mirrors Claude Code's project-dir encoding so we can link to transcripts. */
export function encodeProject(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function runLogPath(id: string): string {
  return path.join(paths.runsDir(), `${id}.log`);
}

function runJsonPath(id: string): string {
  return path.join(paths.runsDir(), `${id}.json`);
}

export async function writeRun(run: Run): Promise<void> {
  await atomicWriteJson(runJsonPath(run.id), run);
}

/**
 * Merge a partial patch onto the latest on-disk run and write it back. Reads
 * fresh each call so concurrent writers (the signal path and the spawn
 * completion handler) don't clobber each other's fields. Returns null if the
 * run is gone.
 */
export async function patchRun(id: string, patch: Partial<Run>): Promise<Run | null> {
  const current = await readRunFile(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  await writeRun(next);
  return next;
}

async function readRunFile(id: string): Promise<Run | null> {
  try {
    return JSON.parse(await readFile(runJsonPath(id), "utf8")) as Run;
  } catch {
    return null;
  }
}

export async function readRuns(opts: { scheduleId?: string; limit?: number } = {}): Promise<Run[]> {
  let names: string[];
  try {
    names = (await readdir(paths.runsDir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs = (await Promise.all(names.map((f) => readRunFile(f.replace(/\.json$/, ""))))).filter(
    (r): r is Run => r !== null,
  );
  let out = runs.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  if (opts.scheduleId) out = out.filter((r) => r.scheduleId === opts.scheduleId);
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

/** Reads a run plus the last LOG_CAP_BYTES of its log. */
export async function readRun(id: string): Promise<{ run: Run; log: string } | null> {
  if (!RUN_ID_RE.test(id)) return null;
  const run = await readRunFile(id);
  if (!run) return null;
  let log = "";
  try {
    const file = runLogPath(id);
    const size = (await stat(file)).size;
    const start = Math.max(0, size - LOG_CAP_BYTES);
    const handle = await open(file, "r");
    try {
      const { buffer } = await handle.read({
        buffer: Buffer.alloc(size - start),
        position: start,
      });
      log = (start > 0 ? "…(truncated)…\n" : "") + buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    log = "";
  }
  return { run, log };
}

/** Kill a run's whole process tree if it's alive. `claude` spawns its own
 *  subprocesses (tools, shells); a plain kill on the recorded pid would orphan
 *  them, so use taskkill /T on win32. On POSIX, detached:true makes the child
 *  a group leader, so signal the group, falling back to the single pid.
 *  Returns whether a signal was sent. */
export async function killRunProcess(pid: number | null): Promise<boolean> {
  if (!pid) return false;
  if (process.platform === "win32") {
    const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return res.status === 0;
  }
  try {
    process.kill(-pid);
    return true;
  } catch {
    try {
      process.kill(pid);
      return true;
    } catch {
      return false;
    }
  }
}

/** Cancel a scheduler run: kill its live process and mark it cancelled.
 *  Returns 'not-found' if the run is unknown, 'not-running' if already
 *  terminal, or 'cancelled' on success. */
export async function cancelRun(
  id: string,
  now: Date,
): Promise<"not-found" | "not-running" | "cancelled"> {
  const got = await readRun(id);
  if (!got) return "not-found";
  if (got.run.status !== "running") return "not-running";
  await killRunProcess(got.run.pid);
  const ended = now.toISOString();
  await writeRun({
    ...got.run,
    status: "cancelled",
    endedAt: ended,
    durationMs: got.run.startedAt ? now.getTime() - new Date(got.run.startedAt).getTime() : null,
    error: "cancelled by user",
  });
  return "cancelled";
}

export async function pruneRuns(scheduleId: string, keep: number): Promise<void> {
  const mine = await readRuns({ scheduleId });
  const drop = mine.slice(keep);
  await Promise.all(
    drop.flatMap((r) => [
      rm(runJsonPath(r.id), { force: true }),
      rm(runLogPath(r.id), { force: true }),
    ]),
  );
}
