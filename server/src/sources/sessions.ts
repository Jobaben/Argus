import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { KeyedMutex } from "../mutex.js";
import { readJsonl } from "./readJson.js";
import { cached } from "./cache.js";
import { encodeProject } from "./runs.js";
import { codexPaths } from "../codexHome.js";
import {
  CODEX_PROJECT,
  listCodexSessionFiles,
  resolveCodexSessionFile,
  translateRolloutLine,
} from "./codexSessions.js";
import type { SessionDetail, SessionMessage, SessionSummary, SessionTail } from "@argus/contracts";

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
  /** Only on translated Codex lines: the directory the run happened in, which
   *  stands in for the encoded project dir Claude Code would have given us. */
  cwd?: string;
}

export type { SessionDetail, SessionMessage, SessionSummary, SessionTail } from "@argus/contracts";

/**
 * Turns an encoded project directory name back into something readable.
 *
 * The encoding is lossy (separators and spaces both collapse to `-`), so this
 * is a best-effort cosmetic label only — never round-trip it back to disk.
 */
export function decodeProjectLabel(encoded: string): string {
  // Codex has no per-project directory; its sessions share one reserved segment
  // and carry their real directory inside the rollout, which the readers below
  // prefer when they have it.
  if (encoded === CODEX_PROJECT) return "codex";
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
  let cwd: string | null = null;

  for (const line of lines) {
    if (line.timestamp) {
      if (!firstActivity) firstActivity = line.timestamp;
      lastActivity = line.timestamp;
    }
    // Codex reports its directory and model on meta lines rather than in the
    // path, so pick both up wherever they appear.
    if (line.cwd) cwd = line.cwd;
    if (!isMessageLine(line.type)) {
      if (line.message?.model) model = line.message.model;
      continue;
    }
    messageCount++;
    if (line.message?.model) model = line.message.model;
    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const item of content) if (item.type === "tool_use") toolUseCount++;
    }
  }

  // A Codex rollout has no project directory to be filed under, but it does
  // record the directory it ran in — which is the same thing a Claude project
  // segment encodes. Using it means both runtimes' sessions group by working
  // directory in the list, instead of Codex collapsing into one "codex" bucket.
  const filedUnder = project === CODEX_PROJECT && cwd ? encodeProject(cwd) : project;
  return {
    id,
    project: filedUnder,
    projectLabel: cwd ?? decodeProjectLabel(project),
    title: deriveTitle(lines, id),
    messageCount,
    toolUseCount,
    model,
    firstActivity,
    lastActivity,
  };
}

interface TranscriptFile {
  project: string;
  id: string;
  file: string;
  mtime: number;
  /** A Codex rollout, which is translated on read. */
  codex: boolean;
}

async function listSessionFiles(): Promise<TranscriptFile[]> {
  let projectDirs: string[] = [];
  try {
    const entries = await readdir(paths.projects(), { withFileTypes: true });
    projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // No Claude transcripts here — which is an ordinary state on a Codex-only
    // machine, not a reason to stop before the Codex scan below.
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
          return { project, id: f.replace(/\.jsonl$/, ""), file, mtime, codex: false };
        }),
      );
    }),
  );

  const codex = (await listCodexSessionFiles()).map((f) => ({
    project: CODEX_PROJECT,
    id: f.id,
    file: f.file,
    mtime: f.mtime,
    codex: true,
  }));
  return [...all.flat(), ...codex];
}

/** Parse one transcript into the canonical line shape, translating a Codex
 *  rollout on the way through so every reader below sees one format. */
async function readLines(codex: boolean, file: string): Promise<RawLine[]> {
  const raw = await readJsonl<unknown>(file);
  if (!codex) return raw as RawLine[];
  const out: RawLine[] = [];
  for (const line of raw) {
    const translated = translateRolloutLine(line);
    if (translated) out.push(translated as RawLine);
  }
  return out;
}

// Per-file summary memo keyed by (file, mtimeMs). A transcript is only re-read
// and re-parsed when its mtime changes; unchanged files (the common case on a
// busy dashboard) are served from memory, so a cache miss on the list no longer
// re-parses dozens of stable transcripts. Bounded LRU: hits refresh recency, so
// the working set of a busy dashboard never gets evicted by one-off reads.
const SUMMARY_MEMO_MAX = 500;
const summaryMemo = new Map<string, { mtime: number; summary: SessionSummary }>();

async function summarizeFile(entry: TranscriptFile): Promise<SessionSummary> {
  const key = entry.file;
  const hit = summaryMemo.get(key);
  if (hit && hit.mtime === entry.mtime) {
    summaryMemo.delete(key);
    summaryMemo.set(key, hit);
    return hit.summary;
  }
  const lines = await readLines(entry.codex, entry.file);
  const summary = summarize(entry.project, entry.id, lines);
  summaryMemo.delete(key);
  summaryMemo.set(key, { mtime: entry.mtime, summary });
  if (summaryMemo.size > SUMMARY_MEMO_MAX) {
    // Evict least-recently-used (Map preserves insertion order; hits re-insert).
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
// Keyed by both transcript roots as well as the limit, mirroring the runs scan:
// the roots are configurable, so a key that ignored them would serve one home's
// listing for another's (and does, to tests with a home per case).
export async function readSessions(limit = DEFAULT_LIMIT): Promise<SessionSummary[]> {
  const key = `sessions:${limit}:${paths.projects()}:${codexPaths.sessions()}`;
  return cached(key, 1500, () => readSessionsRaw(limit));
}

interface ResolvedSession {
  file: string;
  /** A Codex rollout, which is translated on read. */
  codex: boolean;
}

/**
 * The transcript file behind a `(project, sessionId)` pair.
 *
 * Claude Code's path is composed from the two, guarded so a crafted segment
 * cannot escape `projects/`. Codex files by **date**, not by project, so its
 * rollout is found by id in the index instead — which is what lets a run keep
 * recording its working directory as `project` whichever CLI produced it, and
 * still resolve its transcript. The id is segment-checked either way, and the
 * index only ever holds paths under the Codex home.
 */
async function resolveSessionPath(project: string, id: string): Promise<ResolvedSession | null> {
  if (!PROJECT_SEG_RE.test(project) || !SESSION_ID_RE.test(id)) return null;
  if (project !== CODEX_PROJECT) {
    const base = paths.projects();
    const resolved = path.resolve(base, project, `${id}.jsonl`);
    if (path.dirname(resolved) !== path.resolve(base, project)) return null;
    try {
      await stat(resolved);
      return { file: resolved, codex: false };
    } catch {
      /* no Claude transcript under this project; it may be a Codex session */
    }
  }
  const rollout = await resolveCodexSessionFile(id);
  return rollout ? { file: rollout, codex: true } : null;
}

/**
 * How much of a transcript a raw-line read will pull into memory.
 *
 * A long agentic run can leave a transcript in the hundreds of megabytes — tool
 * results are inlined verbatim — and a route that parses all of it per request
 * is a memory spike waiting for the wrong run to be opened. Consumers of these
 * lines are all bounded anyway (the recorder keeps 2,000 events), so reading the
 * *tail* is not a loss: it is the same trim, done before the allocation instead
 * of after.
 */
export const RAW_LINES_CAP_BYTES = 8 * 1024 * 1024;

/**
 * The unparsed transcript lines for one session, in file order, from at most
 * the last {@link RAW_LINES_CAP_BYTES} of the file.
 *
 * Exposed for derivations that need more than the display-normalized
 * `SessionDetail` carries — the Flight Recorder reads tool inputs, per-message
 * usage and tool-result errors, none of which survive normalization. Returns
 * an empty array for an unreadable or path-rejected session, same as every
 * other reader here: a missing transcript is an empty timeline, not an error.
 *
 * A Codex rollout is translated on the way out, so callers see Claude-shaped
 * lines whichever runtime wrote the transcript. The translation carries roles,
 * text, tool calls and tool results; fields Codex records elsewhere (per-message
 * token usage) simply aren't there, and the derivations already treat those as
 * optional.
 */
export async function readSessionLines(project: string, id: string): Promise<unknown[]> {
  const found = await resolveSessionPath(project, id);
  if (!found) return [];
  const { file } = found;
  const translate = (lines: unknown[]) =>
    found.codex ? lines.map(translateRolloutLine).filter((l) => l !== null) : lines;

  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return [];
  }
  if (size <= RAW_LINES_CAP_BYTES) return translate(await readJsonl<unknown>(file));

  let text: string;
  try {
    const handle = await open(file, "r");
    try {
      const start = size - RAW_LINES_CAP_BYTES;
      const { buffer } = await handle.read({
        buffer: Buffer.alloc(RAW_LINES_CAP_BYTES),
        position: start,
      });
      // The tail starts at a byte offset that lands mid-line; drop everything
      // before the first newline so parsing begins on a line boundary.
      const decoded = buffer.toString("utf8");
      const nl = decoded.indexOf("\n");
      text = nl === -1 ? "" : decoded.slice(nl + 1);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }

  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return translate(out);
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
  const found = await resolveSessionPath(project, id);
  if (!found) return null;

  const lines = await readLines(found.codex, found.file);
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

// Per-file incremental tail state, mirroring runTailer's byte-offset approach:
// the live-tail poll fires on every transcript append (150ms-debounced watcher
// broadcast), so re-reading the whole file per poll is O(file size × polls)
// exactly when the file is largest and hottest. Instead, keep the parsed state
// and consume only appended bytes. `size` always sits on a consumed-line
// boundary; a trailing partial line (writer mid-append) stays unconsumed and is
// re-read on the next poll. A shrunken file, or a same-size mtime change, means
// a rewrite — reparse from byte 0. Bounded LRU: only actively-watched sessions
// occupy entries, but each holds a full parsed transcript, so keep it small.
const TAIL_MEMO_MAX = 8;

interface TailState {
  size: number;
  mtimeMs: number;
  lineCount: number;
  aiTitle: string | null;
  userTitle: string | null;
  model: string | null;
  firstActivity: string | null;
  lastActivity: string | null;
  /** Codex only: the directory the run happened in, used as the project label. */
  cwd: string | null;
  messages: SessionMessage[];
  /** Whether appended bytes must be translated from a Codex rollout first. */
  codex: boolean;
}

const tailMemo = new Map<string, TailState>();
// Two concurrent tails of the same file (e.g. two browser tabs on one session)
// would otherwise interleave at the await points and ingest the same appended
// bytes twice, corrupting the memoized state. Serialize per file.
const tailLocks = new KeyedMutex();

function newTailState(codex: boolean): TailState {
  return {
    size: 0,
    mtimeMs: 0,
    lineCount: 0,
    aiTitle: null,
    userTitle: null,
    model: null,
    firstActivity: null,
    lastActivity: null,
    cwd: null,
    messages: [],
    codex,
  };
}

// Folds one parsed JSONL line into the state, reproducing what summarize() +
// deriveTitle() + the message mapping in readSessionRaw derive from a full
// parse: `aiTitle ?? userTitle` matches deriveTitle's precedence because an
// ai-title anywhere in the file beats user text regardless of order.
function ingestParsed(state: TailState, raw: unknown): void {
  state.lineCount++;
  // A Codex rollout is translated line by line, exactly as the full read does,
  // so a live tail and a reload of the same session agree message for message.
  const parsed = state.codex ? translateRolloutLine(raw) : raw;
  if (!parsed || typeof parsed !== "object") return;
  const line = parsed as RawLine;
  if (line.cwd) state.cwd = line.cwd;
  if (!isMessageLine(line.type) && line.message?.model) state.model = line.message.model;
  if (line.timestamp) {
    if (!state.firstActivity) state.firstActivity = line.timestamp;
    state.lastActivity = line.timestamp;
  }
  if (!state.aiTitle && line.type === "ai-title" && line.aiTitle?.trim()) {
    state.aiTitle = truncate(line.aiTitle.trim(), TITLE_MAX);
  }
  if (!state.userTitle && line.type === "user" && !line.isMeta) {
    const text = extractText(line.message?.content).trim();
    if (text && !text.startsWith("<")) {
      state.userTitle = truncate(text.replace(/\s+/g, " "), TITLE_MAX);
    }
  }
  if (!isMessageLine(line.type)) return;
  if (line.message?.model) state.model = line.message.model;
  state.messages.push(normalizeMessage(line, state.messages.length));
}

function ingestChunk(state: TailState, chunk: string): void {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      ingestParsed(state, JSON.parse(trimmed));
    } catch {
      // skip malformed line (mirrors readJsonl)
    }
  }
}

async function readByteRange(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const { buffer } = await handle.read({ buffer: Buffer.alloc(end - start), position: start });
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Consumes bytes [state.size, size) into the state. Splitting at the newline
 *  byte is UTF-8-safe (0x0A never occurs inside a multi-byte sequence). */
async function ingestAppendedBytes(state: TailState, file: string, size: number): Promise<void> {
  const buf = await readByteRange(file, state.size, size);
  const nl = buf.lastIndexOf(0x0a);
  const head = nl === -1 ? null : buf.subarray(0, nl + 1);
  const rest = buf.subarray(nl + 1);
  if (head) {
    ingestChunk(state, head.toString("utf8"));
    state.size += head.length;
  }
  if (rest.length === 0) return;
  // No trailing newline: either a complete final line (consume it — matches
  // the full-parse behavior of surfacing it immediately) or a writer caught
  // mid-append (leave it; it will be re-read once completed).
  let parsed: unknown;
  try {
    parsed = JSON.parse(rest.toString("utf8").trim());
  } catch {
    return;
  }
  ingestParsed(state, parsed);
  state.size += rest.length;
}

/**
 * Incremental slice of a transcript for the live-tail view: the same canonical,
 * defensively-parsed messages as {@link readSession} (malformed JSONL lines are
 * skipped), returning only those newer than `after`.
 *
 * Deliberately does not use the short-TTL `readSession` cache: freshness is the
 * whole point of a live tail, and a cache hit within the 1500ms window would
 * silently hide just-appended messages — most damagingly the final message
 * before a session goes idle. Freshness comes from the stat + appended-bytes
 * read instead; an unchanged file costs one stat.
 */
export async function readSessionTail(
  project: string,
  id: string,
  after: number,
): Promise<SessionTail | null> {
  const found = await resolveSessionPath(project, id);
  if (!found) return null;
  return tailLocks.withLock(found.file, () =>
    readSessionTailLocked(found.file, found.codex, project, id, after),
  );
}

async function readSessionTailLocked(
  file: string,
  codex: boolean,
  project: string,
  id: string,
  after: number,
): Promise<SessionTail | null> {
  let st;
  try {
    st = await stat(file);
  } catch {
    tailMemo.delete(file);
    return null;
  }

  let state = tailMemo.get(file);
  if (state && (st.size < state.size || (st.size === state.size && st.mtimeMs !== state.mtimeMs))) {
    state = undefined; // truncated or rewritten in place — reparse from scratch
  }
  if (!state) state = newTailState(codex);
  if (st.size > state.size) await ingestAppendedBytes(state, file, st.size);
  state.mtimeMs = st.mtimeMs;

  tailMemo.delete(file);
  tailMemo.set(file, state); // re-insert to refresh LRU recency
  if (tailMemo.size > TAIL_MEMO_MAX) {
    tailMemo.delete(tailMemo.keys().next().value as string);
  }

  // Parity with readSessionRaw: a file with no parseable lines is "not found".
  if (state.lineCount === 0) return null;

  const messages = state.messages.slice(Math.max(0, after + 1));
  return {
    id,
    project,
    projectLabel: state.cwd ?? decodeProjectLabel(project),
    title: state.aiTitle ?? state.userTitle ?? `Session ${id.slice(0, 8)}`,
    model: state.model,
    firstActivity: state.firstActivity,
    lastActivity: state.lastActivity,
    messages,
    lastIndex: state.messages.length ? state.messages.length - 1 : after,
  };
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
