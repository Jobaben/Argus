import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { decodeProjectLabel } from "./sessions.js";
import { CODEX_PROJECT, listCodexSessionFiles, translateRolloutLine } from "./codexSessions.js";
import { listQwenSessionFiles, translateQwenLine } from "./qwenSessions.js";
import { encodeProject } from "./runs.js";
import type { SearchResult } from "@argus/contracts";

/** The scan cap. Exported so the route can tell the client what it applied. */
export const SEARCH_LIMIT = 100;
const SNIPPET_PAD = 60;
const SNIPPET_MAX = 200;
// How many transcripts are scanned at once. Recent files usually satisfy the
// limit, so batches keep the early exit while overlapping file I/O.
const SCAN_CONCURRENCY = 8;

export type { SearchResult } from "@argus/contracts";

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

/** Which CLI wrote a transcript, and so which dialect its lines are in. */
type TranscriptKind = "claude" | "codex" | "qwen";

/** The translator for a kind, or null when the lines are already canonical. */
function translatorFor(kind: TranscriptKind): ((raw: unknown) => RawLine | null) | null {
  if (kind === "codex") return translateRolloutLine as (raw: unknown) => RawLine | null;
  if (kind === "qwen") return translateQwenLine as (raw: unknown) => RawLine | null;
  return null;
}

interface TranscriptFile {
  project: string;
  sessionId: string;
  file: string;
  mtime: number;
  kind: TranscriptKind;
}

async function listTranscriptFiles(): Promise<TranscriptFile[]> {
  let projectDirs: string[] = [];
  try {
    const entries = await readdir(paths.projects(), { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No Claude transcripts here, which is an ordinary state on a machine that
    // runs another agent — and not a reason to skip the scans below. Returning
    // early is what used to make transcript search silently empty on a
    // Codex-only or Qwen-only install.
  }

  const nested = await Promise.all(
    projectDirs.map(async (project) => {
      const dir = path.join(paths.projects(), project);
      try {
        const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
        return Promise.all(
          files.map(async (f) => {
            const file = path.join(dir, f);
            let mtime = 0;
            try {
              mtime = (await stat(file)).mtimeMs;
            } catch {
              /* unreadable; sinks to the end of the scan order */
            }
            return {
              project,
              sessionId: f.replace(/\.jsonl$/, ""),
              file,
              mtime,
              kind: "claude" as const,
            };
          }),
        );
      } catch {
        return [];
      }
    }),
  );
  // Codex rollouts and Qwen Code chats join the same scan, translated on read,
  // so a transcript search covers every runtime that keeps readable transcripts
  // instead of quietly meaning "Claude transcripts only". Codex is filed by date
  // rather than by project; Qwen Code files by project exactly as Claude does.
  const codex = (await listCodexSessionFiles()).map((f) => ({
    project: CODEX_PROJECT,
    sessionId: f.id,
    file: f.file,
    mtime: f.mtime,
    kind: "codex" as const,
  }));
  const qwen = (await listQwenSessionFiles()).map((f) => ({
    project: f.project,
    sessionId: f.id,
    file: f.file,
    mtime: f.mtime,
    kind: "qwen" as const,
  }));
  return [...nested.flat(), ...codex, ...qwen];
}

/** Scans one transcript line by line, pushing matches until the cap is hit. */
async function scanFile(
  entry: TranscriptFile,
  lowerQ: string,
  out: SearchResult[],
  limit: number,
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(entry.file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  // A Codex rollout opens with its `session_meta`, so by the time any match is
  // found the run's directory is known — which is what lets a Codex hit be
  // filed under the same project a Claude hit from that directory would be.
  let project = entry.project;
  const translate = translatorFor(entry.kind);
  try {
    for await (const raw of rl) {
      if (out.length >= limit) break;
      let line: RawLine | null;
      if (translate) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const translated = translate(parsed) as (RawLine & { cwd?: string }) | null;
        if (translated?.cwd) project = encodeProject(translated.cwd);
        // Fast path, after the meta scan so the directory is not missed.
        if (!raw.toLowerCase().includes(lowerQ)) continue;
        line = translated;
      } else {
        // Fast path: skip lines that can't contain the query at all.
        if (!raw.toLowerCase().includes(lowerQ)) continue;
        try {
          line = JSON.parse(raw) as RawLine;
        } catch {
          continue;
        }
      }
      if (!line) continue;
      const text = lineText(line.message?.content);
      if (!text.toLowerCase().includes(lowerQ)) continue;
      out.push({
        project,
        projectLabel: decodeProjectLabel(project),
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
 * Transcripts are scanned newest-first (recent sessions are both the likeliest
 * matches and the most relevant results) in small concurrent batches, stopping
 * as soon as the limit is reached — so a query that hits in recent files never
 * pays for the long tail of old transcripts. Files are read line by line so a
 * single huge transcript never has to fit in memory; non-matching lines are
 * rejected by a cheap raw-string check before any JSON parsing happens.
 */
export async function searchTranscripts(q: string, limit = SEARCH_LIMIT): Promise<SearchResult[]> {
  const lowerQ = q.trim().toLowerCase();
  if (!lowerQ) return [];

  const files = await listTranscriptFiles();
  files.sort((a, b) => b.mtime - a.mtime);

  const out: SearchResult[] = [];
  for (let i = 0; i < files.length && out.length < limit; i += SCAN_CONCURRENCY) {
    const remaining = limit - out.length;
    const batch = files.slice(i, i + SCAN_CONCURRENCY);
    // Each file collects into its own array; merging in batch order keeps the
    // result order deterministic (newest file first) despite concurrent reads.
    const perFile = await Promise.all(
      batch.map(async (entry) => {
        const found: SearchResult[] = [];
        await scanFile(entry, lowerQ, found, remaining);
        return found;
      }),
    );
    for (const found of perFile) {
      for (const r of found) {
        if (out.length >= limit) break;
        out.push(r);
      }
    }
  }
  return out;
}
