import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { decodeProjectLabel } from "./sessions.js";

const DEFAULT_LIMIT = 100;
const SNIPPET_PAD = 60;
const SNIPPET_MAX = 200;

export interface SearchResult {
  project: string;
  projectLabel: string;
  sessionId: string;
  snippet: string;
  type: string;
}

interface RawContentItem {
  type?: string;
  text?: string;
  thinking?: string;
  content?: unknown;
}

interface RawLine {
  type?: string;
  message?: { content?: string | RawContentItem[] };
}

/** Flattens a transcript line's content into one searchable string. */
function lineText(content: string | RawContentItem[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item.text === "string") parts.push(item.text);
    else if (typeof item.thinking === "string") parts.push(item.thinking);
    else if (typeof item.content === "string") parts.push(item.content);
  }
  return parts.join(" ");
}

/** Builds a centered, length-capped snippet around the first match. */
function makeSnippet(text: string, lowerQ: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const idx = collapsed.toLowerCase().indexOf(lowerQ);
  if (idx === -1) return collapsed.slice(0, SNIPPET_MAX);
  const start = Math.max(0, idx - SNIPPET_PAD);
  const end = Math.min(collapsed.length, idx + lowerQ.length + SNIPPET_PAD);
  let snippet = collapsed.slice(start, end);
  if (start > 0) snippet = "…" + snippet;
  if (end < collapsed.length) snippet = snippet + "…";
  return snippet.slice(0, SNIPPET_MAX);
}

async function listTranscriptFiles(): Promise<
  { project: string; sessionId: string; file: string }[]
> {
  let projectDirs: string[];
  try {
    const entries = await readdir(paths.projects(), { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const nested = await Promise.all(
    projectDirs.map(async (project) => {
      const dir = path.join(paths.projects(), project);
      try {
        const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
        return files.map((f) => ({
          project,
          sessionId: f.replace(/\.jsonl$/, ""),
          file: path.join(dir, f),
        }));
      } catch {
        return [];
      }
    }),
  );
  return nested.flat();
}

/** Scans one transcript line by line, pushing matches until the cap is hit. */
async function scanFile(
  entry: { project: string; sessionId: string; file: string },
  lowerQ: string,
  out: SearchResult[],
  limit: number,
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(entry.file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const raw of rl) {
      if (out.length >= limit) break;
      // Fast path: skip lines that can't contain the query at all.
      if (!raw.toLowerCase().includes(lowerQ)) continue;
      let line: RawLine;
      try {
        line = JSON.parse(raw) as RawLine;
      } catch {
        continue;
      }
      const text = lineText(line.message?.content);
      if (!text.toLowerCase().includes(lowerQ)) continue;
      out.push({
        project: entry.project,
        projectLabel: decodeProjectLabel(entry.project),
        sessionId: entry.sessionId,
        snippet: makeSnippet(text, lowerQ),
        type: line.type ?? "unknown",
      });
    }
  } finally {
    rl.close();
  }
}

/**
 * Case-insensitive plain-substring search across every transcript.
 *
 * Files are read line by line so a single huge transcript never has to fit in
 * memory; non-matching lines are rejected by a cheap raw-string check before
 * any JSON parsing happens.
 */
export async function searchTranscripts(
  q: string,
  limit = DEFAULT_LIMIT,
): Promise<SearchResult[]> {
  const lowerQ = q.trim().toLowerCase();
  if (!lowerQ) return [];

  const files = await listTranscriptFiles();
  const out: SearchResult[] = [];
  for (const entry of files) {
    if (out.length >= limit) break;
    await scanFile(entry, lowerQ, out, limit);
  }
  return out;
}
