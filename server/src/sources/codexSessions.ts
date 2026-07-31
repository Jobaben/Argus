/**
 * Codex transcripts, read into the shape the Sessions view already speaks.
 *
 * Claude Code writes one transcript per session under
 * `projects/<encoded-cwd>/<session-id>.jsonl`. Codex writes a *rollout* under
 * `sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`, in a different
 * vocabulary: each line is `{timestamp, type, payload}` where `type` is
 * `session_meta`, `response_item`, `event_msg` or `turn_context`.
 *
 * Rather than fork the Sessions view — a second list, a second detail route, a
 * second Markdown exporter — the rollout is translated here into the same line
 * shape the Claude reader consumes, and everything downstream stays one code
 * path. Two decisions make that translation faithful:
 *
 *   * **`response_item` only.** A rollout carries the same content twice: once
 *     as conversation items and once as UI events (`event_msg`). Reading only
 *     the former is what keeps every message from appearing twice.
 *   * **A reserved project segment.** Codex has no per-project directory, so its
 *     sessions live under the literal segment `_codex_`. An underscore can never
 *     appear in an encoded Claude project (the encoder maps every non-alphanumeric
 *     to `-`), so the two namespaces cannot collide. The human-readable label
 *     comes from the rollout's own `cwd` instead.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { codexPaths } from "../codexHome.js";
import { cached } from "./cache.js";

/** The reserved project segment every Codex session is filed under. */
export const CODEX_PROJECT = "_codex_";

/** `rollout-2026-02-18T10-06-22-019c7149-….jsonl` → `019c7149-…`. */
const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-([A-Za-z0-9][A-Za-z0-9_-]*)\.jsonl$/;

/** Any `rollout-*.jsonl`, for installs whose filename convention differs. */
const ROLLOUT_LOOSE_RE = /^rollout-(.*)\.jsonl$/;

export interface CodexSessionFile {
  id: string;
  file: string;
  mtime: number;
}

/** The thread id encoded in a rollout filename, or null if it isn't one. */
export function rolloutId(filename: string): string | null {
  const strict = ROLLOUT_RE.exec(filename);
  if (strict) return strict[1];
  const loose = ROLLOUT_LOOSE_RE.exec(filename);
  if (!loose) return null;
  // Fall back to the last dash-separated run that looks like an id, so a
  // filename convention change degrades to "still listed" rather than "gone".
  const tail = loose[1].split("-").slice(-5).join("-");
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tail) ? tail : null;
}

/** Recursively collect `rollout-*.jsonl` under one root. Depth-bounded: the
 *  layout is `YYYY/MM/DD/`, and an unbounded walk of a home directory is how a
 *  listing turns into a stall. */
async function walk(root: string, depth: number, out: CodexSessionFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (depth > 0) await walk(full, depth - 1, out);
      continue;
    }
    const id = rolloutId(e.name);
    if (!id) continue;
    let mtime = 0;
    try {
      mtime = (await stat(full)).mtimeMs;
    } catch {
      /* unreadable; keep mtime 0 so it sorts last rather than disappearing */
    }
    out.push({ id, file: full, mtime });
  }
}

/**
 * Every readable rollout, active and archived.
 *
 * Cached briefly and shared: the sessions list, the detail route and the tail
 * poll all need the id→path map, and each would otherwise re-walk the tree.
 */
export async function listCodexSessionFiles(): Promise<CodexSessionFile[]> {
  return cached(`codex-sessions:${codexPaths.root()}`, 1500, async () => {
    const out: CodexSessionFile[] = [];
    await walk(codexPaths.sessions(), 4, out);
    await walk(codexPaths.archivedSessions(), 4, out);
    return out;
  });
}

/** The rollout file for one thread id, or null when there isn't one. */
export async function resolveCodexSessionFile(id: string): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) return null;
  const files = await listCodexSessionFiles();
  // Newest wins: a resumed thread can appear under more than one date folder.
  let best: CodexSessionFile | null = null;
  for (const f of files) {
    if (f.id !== id) continue;
    if (!best || f.mtime > best.mtime) best = f;
  }
  return best?.file ?? null;
}

/** The line shape the Claude session reader consumes, plus the one field a
 *  rollout supplies that a Claude transcript doesn't: the run's directory. */
export interface TranslatedLine {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  /** Present on translated `session_meta` / `turn_context` lines only. */
  cwd?: string;
  message?: {
    role?: string;
    model?: string;
    content?: {
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
      is_error?: boolean;
    }[];
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Concatenate the text parts of a Responses-API content array. */
function contentText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  const parts: string[] = [];
  for (const item of raw) {
    const r = asRecord(item);
    if (!r) continue;
    if (typeof r.text === "string") parts.push(r.text);
  }
  return parts.join("\n");
}

/**
 * Translate one rollout line into the Claude-shaped line the readers expect, or
 * null when it carries nothing a transcript view would show.
 *
 * Roles other than user/assistant (Codex's `developer` and `system` messages
 * are the injected instructions) come through flagged `isMeta`, which is the
 * same signal the Claude reader uses to keep boilerplate out of session titles.
 */
export function translateRolloutLine(raw: unknown): TranslatedLine | null {
  const line = asRecord(raw);
  if (!line) return null;
  const timestamp = typeof line.timestamp === "string" ? line.timestamp : undefined;
  const payload = asRecord(line.payload);
  if (!payload) return null;

  if (line.type === "session_meta" || line.type === "turn_context") {
    // Some versions nest the meta one level deeper under `payload.payload`.
    const inner = asRecord(payload.payload) ?? payload;
    const cwd = typeof inner.cwd === "string" ? inner.cwd : undefined;
    const model = typeof inner.model === "string" ? inner.model : undefined;
    if (!cwd && !model) return null;
    return {
      type: "codex-meta",
      timestamp,
      ...(cwd ? { cwd } : {}),
      ...(model ? { message: { model } } : {}),
    };
  }

  // Only the conversation items: `event_msg` lines restate the same content as
  // UI events, and translating both would show every message twice.
  if (line.type !== "response_item") return null;

  switch (payload.type) {
    case "message": {
      const role = typeof payload.role === "string" ? payload.role : "user";
      const text = contentText(payload.content);
      if (!text.trim()) return null;
      const isAssistant = role === "assistant";
      return {
        type: isAssistant ? "assistant" : "user",
        timestamp,
        ...(isAssistant || role === "user" ? {} : { isMeta: true }),
        message: { role, content: [{ type: "text", text }] },
      };
    }
    case "reasoning": {
      const text = contentText(payload.summary) || contentText(payload.content);
      if (!text.trim()) return null;
      return {
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: [{ type: "thinking", thinking: text }] },
      };
    }
    case "function_call":
    case "local_shell_call":
    case "custom_tool_call": {
      const name =
        typeof payload.name === "string"
          ? payload.name
          : payload.type === "local_shell_call"
            ? "shell"
            : "tool";
      let input: unknown = payload.arguments ?? payload.action ?? payload.input ?? {};
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = { arguments: input };
        }
      }
      return {
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
      };
    }
    case "function_call_output":
    case "local_shell_call_output":
    case "custom_tool_call_output": {
      const out = payload.output;
      const text = typeof out === "string" ? out : contentText(out);
      return {
        type: "user",
        timestamp,
        message: { role: "user", content: [{ type: "tool_result", content: text }] },
      };
    }
    default:
      return null;
  }
}

/** Translate a whole rollout, dropping the lines that carry nothing to show. */
export function translateRollout(lines: unknown[]): TranslatedLine[] {
  const out: TranslatedLine[] = [];
  for (const l of lines) {
    const t = translateRolloutLine(l);
    if (t) out.push(t);
  }
  return out;
}
