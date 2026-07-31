import { readFile, readdir, rm, stat } from "node:fs/promises";
import { open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { atomicWriteJson } from "./atomicWrite.js";
import { cached, invalidate, patchCached } from "./cache.js";
import { createFileMemo } from "./fileMemo.js";
import type { Run } from "./scheduleTypes.js";

export const LOG_CAP_BYTES = 1_048_576; // 1 MB
export const RUN_KEEP = 50;

// Run ids are generated UUIDs; reject anything that could escape the runs dir
// (no dots/slashes allowed, mirroring the session-route segment guard).
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Mirrors Claude Code's project-dir encoding.
 *
 * Every run records it, whichever CLI ran — it is the run's *working directory*,
 * which is what the cost-by-project dimension, the Vault index and the OTel
 * attribute all mean by "project". Codex files its transcripts by date rather
 * than by directory, so for those it is not also a path to the transcript; the
 * session reader resolves a Codex rollout from the session id instead.
 */
export function encodeProject(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function runLogPath(id: string): string {
  return path.join(paths.runsDir(), `${id}.log`);
}

function runJsonPath(id: string): string {
  return path.join(paths.runsDir(), `${id}.json`);
}

/** See {@link createFileMemo} for why retention is by scan membership. Runs
 *  outnumber instances — RUN_KEEP per schedule, per pipeline bucket and for
 *  one-offs — so this is the directory where the old 500-entry cap bit first. */
const parseMemo = createFileMemo<Run>();

// The directory scan (readdir + a stat per file) is cached under a short TTL:
// one broadcast makes several routes (/api/runs, /monitors, /issues, /briefing,
// /overview, /chronicle) call readRuns() near-simultaneously, and reconcile/
// monitor checks repeat it within one scheduler tick. Keyed by directory so
// tests with per-test homes never collide; writes invalidate eagerly, so
// read-after-write stays exact.
const SCAN_TTL_MS = 1500;

function scanKey(): string {
  return `runs:${paths.runsDir()}`;
}

/** The scan result with one run replaced (or inserted), still newest-first. */
function upsert(all: Run[], run: Run): Run[] {
  const next = all.filter((r) => r.id !== run.id);
  const at = next.findIndex((r) => r.queuedAt.localeCompare(run.queuedAt) < 0);
  next.splice(at === -1 ? next.length : at, 0, run);
  return next;
}

export async function writeRun(run: Run): Promise<void> {
  await atomicWriteJson(runJsonPath(run.id), run);
  // Eager eviction: atomic rename gives a fresh mtime, but dropping the entry
  // makes staleness impossible even on filesystems with coarse mtime resolution.
  parseMemo.forget(run.id);

  // Patch the cached scan rather than dropping it. A live run is written on
  // queue, start and completion, and every pipeline step writes twice more —
  // each of which used to force the next reader (the board, monitors, issues,
  // the briefing, the Chronicle) to re-stat the whole runs directory.
  //
  // Read back from disk rather than caching `run` itself: callers keep mutating
  // the object after handing it here, and a cache holding that reference would
  // change under them.
  const fresh = await readRunFile(run.id);
  if (fresh && patchCached<Run[]>(scanKey(), (all) => upsert(all, fresh))) return;
  invalidate(scanKey());
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
  const file = runJsonPath(id);
  try {
    const st = await stat(file);
    const hit = parseMemo.get(id, st.mtimeMs);
    if (hit) return hit;
    const run = JSON.parse(await readFile(file, "utf8")) as Run;
    parseMemo.set(id, st.mtimeMs, run);
    return run;
  } catch {
    return null;
  }
}

async function scanRuns(): Promise<Run[]> {
  let names: string[];
  try {
    names = (await readdir(paths.runsDir())).filter((f) => f.endsWith(".json"));
  } catch {
    // The directory has gone away; forget what we had rather than serving it.
    parseMemo.retain(new Set());
    return [];
  }
  const ids = names.map((f) => f.replace(/\.json$/, "")).sort();
  const runs = (await Promise.all(ids.map(readRunFile))).filter((r): r is Run => r !== null);
  // Sorted ids, so the ceiling admits the same subset every scan.
  parseMemo.retain(new Set(ids));
  return runs.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
}

export async function readRuns(opts: { scheduleId?: string; limit?: number } = {}): Promise<Run[]> {
  const all = await cached(scanKey(), SCAN_TTL_MS, scanRuns);
  // Never hand callers the cached array itself: some sort/splice in place.
  let out = opts.scheduleId ? all.filter((r) => r.scheduleId === opts.scheduleId) : [...all];
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
      const decoded = buffer.toString("utf8");
      if (start > 0) {
        // The tail read starts at a byte offset that can land mid-line (or
        // mid-JSON-string); drop the partial first line so envelope parsing
        // begins at a line boundary.
        const nl = decoded.indexOf("\n");
        log = "…(truncated)…\n" + (nl === -1 ? decoded : decoded.slice(nl + 1));
      } else {
        log = decoded;
      }
    } finally {
      await handle.close();
    }
  } catch {
    log = "";
  }
  return { run, log };
}

/** Kill a run's whole process tree if it's alive. An agent CLI spawns its own
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
  for (const r of drop) parseMemo.forget(r.id);
  if (drop.length > 0) invalidate(scanKey());
}
