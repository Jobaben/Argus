import { paths } from "../claudeHome.js";
import { readJsonl } from "./readJson.js";
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

/** Reads the prompt history, most recent first, capped at `limit` entries.
 *  Parses the whole file, so cache the burst of live refetches (short TTL). */
export async function readActivity(limit = 100): Promise<Activity[]> {
  return cached(`activity:${limit}`, 1500, async () => {
    const entries = await readJsonl<HistoryEntry>(paths.history());
    const normalized = entries.map(normalize).filter((a) => a.text.length > 0);
    return normalized.reverse().slice(0, limit);
  });
}
