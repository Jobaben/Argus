import { open } from "node:fs/promises";
import { paths } from "../claudeHome.js";
import { cached } from "./cache.js";

/** One raw line in `history.jsonl`. */
interface HistoryEntry {
  display?: string;
  timestamp?: number;
  project?: string;
  sessionId?: string;
}

/** A normalized activity item exposed by the API. */
export interface Activity {
  ts: string;
  text: string;
  project: string;
  cwd: string;
}

// history.jsonl is append-only and only the newest `limit` entries are served,
// so read a bounded tail instead of the whole file (which grows without bound).
// ~256KB comfortably holds >1000 typical entries for a limit of 100.
const TAIL_BYTES = 262_144;

function lastSegment(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function normalize(entry: HistoryEntry): Activity {
  const cwd = entry.project?.trim() ?? "";
  return {
    ts: typeof entry.timestamp === "number" ? new Date(entry.timestamp).toISOString() : "",
    text: entry.display?.trim() ?? "",
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
  return cached(`activity:${limit}`, 1500, async () => {
    let raw: string;
    try {
      raw = await readTail(paths.history(), TAIL_BYTES);
    } catch {
      return [];
    }
    const entries: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as HistoryEntry);
      } catch {
        // skip malformed line
      }
    }
    const normalized = entries.map(normalize).filter((a) => a.text.length > 0);
    return normalized.reverse().slice(0, limit);
  });
}
