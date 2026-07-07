import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { readJsonl } from "./readJson.js";
import { cached } from "./cache.js";

const DEFAULT_LIMIT = 60;
const TITLE_MAX = 100;
const DISPLAY_TEXT_MAX = 4000;
// Encoded project dirs may begin with "-" (Linux home paths); the session id
// is a UUID-ish token. Both must be a single safe path segment: no slashes and
// no "." that could enable traversal.
const PROJECT_SEG_RE = /^[A-Za-z0-9_-]+$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface RawContentItem {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

interface RawMessage {
  role?: string;
  model?: string;
  content?: string | RawContentItem[];
}

interface RawLine {
  type?: string;
  aiTitle?: string;
  isMeta?: boolean;
  timestamp?: string;
  message?: RawMessage;
}

export interface SessionSummary {
  id: string;
  project: string;
  projectLabel: string;
  title: string;
  messageCount: number;
  toolUseCount: number;
  model: string | null;
  firstActivity: string | null;
  lastActivity: string | null;
}

export interface SessionMessage {
  index: number;
  type: string;
  role: string | null;
  timestamp: string | null;
  model: string | null;
  text: string | null;
  toolName: string | null;
  isError: boolean;
}

export interface SessionDetail {
  id: string;
  project: string;
  projectLabel: string;
  title: string;
  model: string | null;
  firstActivity: string | null;
  lastActivity: string | null;
  messages: SessionMessage[];
}

/**
 * Turns an encoded project directory name back into something readable.
 *
 * The encoding is lossy (separators and spaces both collapse to `-`), so this
 * is a best-effort cosmetic label only — never round-trip it back to disk.
 */
export function decodeProjectLabel(encoded: string): string {
  let s = encoded;
  if (s.startsWith("C--")) s = "C:/" + s.slice(3);
  else if (s.startsWith("-")) s = s.slice(1);
  return s.replace(/-/g, "/").replace(/\/+/g, "/");
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).trimEnd() + "…" : text;
}

function extractText(content: string | RawContentItem[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text" && item.text) parts.push(item.text);
    else if (item.type === "thinking" && item.thinking) parts.push(item.thinking);
    else if (item.type === "tool_result") {
      const c = item.content;
      if (typeof c === "string") parts.push(c);
      else if (Array.isArray(c)) {
        for (const sub of c) {
          if (sub && typeof sub === "object" && typeof (sub as RawContentItem).text === "string") {
            parts.push((sub as RawContentItem).text as string);
          }
        }
      }
    }
  }
  return parts.join("\n").trim();
}

function isMessageLine(type: string | undefined): boolean {
  return type === "user" || type === "assistant";
}

function deriveTitle(lines: RawLine[], fallbackId: string): string {
  for (const line of lines) {
    if (line.type === "ai-title" && line.aiTitle?.trim()) {
      return truncate(line.aiTitle.trim(), TITLE_MAX);
    }
  }
  for (const line of lines) {
    if (line.type !== "user" || line.isMeta) continue;
    const text = extractText(line.message?.content).trim();
    if (text && !text.startsWith("<")) return truncate(text.replace(/\s+/g, " "), TITLE_MAX);
  }
  return `Session ${fallbackId.slice(0, 8)}`;
}

function summarize(project: string, id: string, lines: RawLine[]): SessionSummary {
  let messageCount = 0;
  let toolUseCount = 0;
  let model: string | null = null;
  let firstActivity: string | null = null;
  let lastActivity: string | null = null;

  for (const line of lines) {
    if (line.timestamp) {
      if (!firstActivity) firstActivity = line.timestamp;
      lastActivity = line.timestamp;
    }
    if (!isMessageLine(line.type)) continue;
    messageCount++;
    if (line.message?.model) model = line.message.model;
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const item of content) if (item.type === "tool_use") toolUseCount++;
    }
  }

  return {
    id,
    project,
    projectLabel: decodeProjectLabel(project),
    title: deriveTitle(lines, id),
    messageCount,
    toolUseCount,
    model,
    firstActivity,
    lastActivity,
  };
}

async function listSessionFiles(): Promise<
  { project: string; id: string; file: string; mtime: number }[]
> {
  let projectDirs: string[];
  try {
    const entries = await readdir(paths.projects(), { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const all = await Promise.all(
    projectDirs.map(async (project) => {
      const dir = path.join(paths.projects(), project);
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
      } catch {
        return [];
      }
      return Promise.all(
        files.map(async (f) => {
          const file = path.join(dir, f);
          let mtime = 0;
          try {
            mtime = (await stat(file)).mtimeMs;
          } catch {
            /* unreadable; keep mtime 0 */
          }
          return { project, id: f.replace(/\.jsonl$/, ""), file, mtime };
        }),
      );
    }),
  );

  return all.flat();
}

// Per-file summary memo keyed by (file, mtimeMs). A transcript is only re-read
// and re-parsed when its mtime changes; unchanged files (the common case on a
// busy dashboard) are served from memory, so a cache miss on the list no longer
// re-parses dozens of stable transcripts. Bounded so it can't grow unbounded.
const SUMMARY_MEMO_MAX = 500;
const summaryMemo = new Map<string, { mtime: number; summary: SessionSummary }>();

async function summarizeFile(entry: {
  project: string;
  id: string;
  file: string;
  mtime: number;
}): Promise<SessionSummary> {
  const key = entry.file;
  const hit = summaryMemo.get(key);
  if (hit && hit.mtime === entry.mtime) return hit.summary;
  const lines = await readJsonl<RawLine>(entry.file);
  const summary = summarize(entry.project, entry.id, lines);
  summaryMemo.set(key, { mtime: entry.mtime, summary });
  if (summaryMemo.size > SUMMARY_MEMO_MAX) {
    // Evict the oldest insertion (Map preserves insertion order).
    summaryMemo.delete(summaryMemo.keys().next().value as string);
  }
  return summary;
}

/** Recent sessions across all projects, newest first (by last activity). */
async function readSessionsRaw(limit: number): Promise<SessionSummary[]> {
  const files = await listSessionFiles();
  files.sort((a, b) => b.mtime - a.mtime);
  const slice = files.slice(0, Math.max(0, limit));

  const summaries = await Promise.all(slice.map((entry) => summarizeFile(entry)));

  return summaries.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}

// The list read scans dozens of transcript files; a short-TTL single-flight
// cache collapses the burst of refetches a single live broadcast triggers.
export async function readSessions(limit = DEFAULT_LIMIT): Promise<SessionSummary[]> {
  return cached(`sessions:${limit}`, 1500, () => readSessionsRaw(limit));
}

function resolveSessionPath(project: string, id: string): string | null {
  if (!PROJECT_SEG_RE.test(project) || !SESSION_ID_RE.test(id)) return null;
  const base = paths.projects();
  const resolved = path.resolve(base, project, `${id}.jsonl`);
  const expectedDir = path.resolve(base, project);
  if (path.dirname(resolved) !== expectedDir) return null;
  return resolved;
}

function normalizeMessage(line: RawLine, index: number): SessionMessage {
  const content = line.message?.content;
  let toolName: string | null = null;
  let isError = false;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === "tool_use" && item.name) toolName = item.name;
      if (item.type === "tool_result" && item.is_error) isError = true;
    }
  }
  const text = extractText(content);
  return {
    index,
    type: line.type ?? "unknown",
    role: line.message?.role ?? null,
    timestamp: line.timestamp ?? null,
    model: line.message?.model ?? null,
    text: text ? truncate(text, DISPLAY_TEXT_MAX) : null,
    toolName,
    isError,
  };
}

async function readSessionRaw(project: string, id: string): Promise<SessionDetail | null> {
  const file = resolveSessionPath(project, id);
  if (!file) return null;

  const lines = await readJsonl<RawLine>(file);
  if (lines.length === 0) return null;

  const summary = summarize(project, id, lines);
  const messages = lines
    .filter((line) => isMessageLine(line.type))
    .map((line, i) => normalizeMessage(line, i));

  return {
    id,
    project,
    projectLabel: summary.projectLabel,
    title: summary.title,
    model: summary.model,
    firstActivity: summary.firstActivity,
    lastActivity: summary.lastActivity,
    messages,
  };
}

/** Full ordered message list for one session, normalized for display. Cached
 *  with a short TTL + single-flight so a large open transcript that refetches
 *  on every live ping isn't fully re-parsed each time. */
export async function readSession(project: string, id: string): Promise<SessionDetail | null> {
  return cached(`session:${project}:${id}`, 1500, () => readSessionRaw(project, id));
}

/** Render a session transcript as portable Markdown for export/download. */
export function sessionToMarkdown(session: SessionDetail): string {
  const lines: string[] = [
    `# ${session.title || session.id}`,
    "",
    `- **Session:** \`${session.id}\``,
    `- **Project:** ${session.projectLabel}`,
    ...(session.model ? [`- **Model:** ${session.model}`] : []),
    ...(session.firstActivity ? [`- **Started:** ${session.firstActivity}`] : []),
    ...(session.lastActivity ? [`- **Last activity:** ${session.lastActivity}`] : []),
    "",
    "---",
    "",
  ];
  for (const m of session.messages) {
    const who = m.role ?? m.type;
    const tool = m.toolName ? ` · tool: \`${m.toolName}\`` : "";
    const err = m.isError ? " · ⚠️ error" : "";
    const when = m.timestamp ? ` — ${m.timestamp}` : "";
    lines.push(`## ${who}${tool}${err}${when}`, "");
    if (m.text) lines.push(m.text, "");
  }
  return lines.join("\n");
}
