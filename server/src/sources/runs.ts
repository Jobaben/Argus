import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
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
  await mkdir(paths.runsDir(), { recursive: true });
  const file = runJsonPath(run.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(run, null, 2), "utf8");
  await rename(tmp, file);
}

async function readRunFile(id: string): Promise<Run | null> {
  try {
    return JSON.parse(await readFile(runJsonPath(id), "utf8")) as Run;
  } catch {
    return null;
  }
}

export async function readRuns(
  opts: { scheduleId?: string; limit?: number } = {},
): Promise<Run[]> {
  let names: string[];
  try {
    names = (await readdir(paths.runsDir())).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs = (
    await Promise.all(names.map((f) => readRunFile(f.replace(/\.json$/, ""))))
  ).filter((r): r is Run => r !== null);
  let out = runs.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
  if (opts.scheduleId) out = out.filter((r) => r.scheduleId === opts.scheduleId);
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

/** Reads a run plus the last LOG_CAP_BYTES of its log. */
export async function readRun(
  id: string,
): Promise<{ run: Run; log: string } | null> {
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

/** SIGTERM every run currently recorded as 'running' with a live pid. Returns
 *  the pids signalled. Used on shutdown and by the cancel-run endpoint. */
export async function killRunProcess(pid: number | null): Promise<boolean> {
  if (!pid) return false;
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
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
