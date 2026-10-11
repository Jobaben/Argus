import { open } from "node:fs/promises";
import { paths } from "../claudeHome.js";
import { cached } from "./cache.js";
import type { Activity } from "@argus/contracts";

export type { Activity } from "@argus/contracts";

// history.jsonl is append-only and only the newest `limit` entries are served,
// so read a bounded tail instead of the whole file (which grows without bound).
// ~256KB comfortably holds >1000 typical entries for a limit of 100.
const TAIL_BYTES = 262_144;

function lastSegment(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function normalize(value: unknown): Activity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.display !== "string") return null;
  if (entry.project != null && typeof entry.project !== "string") return null;
  const text = entry.display.trim();
  if (!text) return null;
  const date = typeof entry.timestamp === "number" ? new Date(entry.timestamp) : null;
  if (date && !Number.isFinite(date.getTime())) return null;
  const cwd = typeof entry.project === "string" ? entry.project.trim() : "";
  return {
    ts: date?.toISOString() ?? "",
    text,
    project: cwd ? lastSegment(cwd) : "",
    cwd,
  };
}

/** Reads the last `maxBytes` of a file; when truncated, drops the partial
 *  first line so parsing starts at a line boundary. */
async function readTail(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const { buffer } = await handle.read({
      buffer: Buffer.alloc(size - start),
      position: start,
    });
    const decoded = buffer.toString("utf8");
    if (start === 0) return decoded;
    const nl = decoded.indexOf("\n");
    return nl === -1 ? "" : decoded.slice(nl + 1);
  } finally {
    await handle.close();
  }
}

/** Reads the prompt history, most recent first, capped at `limit` entries.
 *  Tail-reads the file and caches the burst of live refetches (short TTL). */
export async function readActivity(limit = 100): Promise<Activity[]> {
  const file = paths.history();
  return cached(`activity:${file}:${limit}`, 1500, async () => {
    let raw: string;
    try {
      raw = await readTail(file, TAIL_BYTES);
    } catch {
      return [];
    }
    const entries: Activity[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const activity = normalize(JSON.parse(trimmed));
        if (activity) entries.push(activity);
      } catch {
        // skip malformed line
      }
    }
    return entries.reverse().slice(0, limit);
  });
}
