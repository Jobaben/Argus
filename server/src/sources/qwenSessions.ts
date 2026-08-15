/**
 * Qwen Code transcripts, read into the shape the Sessions view already speaks.
 *
 * Qwen Code files transcripts almost exactly where Claude Code does — one
 * directory deeper, at `projects/<encoded-cwd>/chats/<session-id>.jsonl`, with
 * the *same* encoding of the working directory into a path segment. That is
 * what makes this the least invasive of the three readers: a Qwen session
 * resolves by composing a path from `(project, sessionId)` exactly as a Claude
 * one does, needs no reserved project segment the way a Codex rollout does, and
 * groups by working directory in the list for free.
 *
 * What differs is the *line*. Qwen Code is a Gemini CLI fork, so it inherits
 * Gemini's message vocabulary rather than Claude's:
 *
 *   * `message.parts[]` where Claude has `message.content[]`
 *   * `{ functionCall: { name, args } }` for a tool call, and a separate
 *     `type: "tool_result"` line carrying `{ functionResponse: { response } }`
 *   * `role: "model"` for the assistant
 *   * `type: "system"` lines that are telemetry, not conversation
 *
 * Rather than fork the Sessions view, each line is translated here into the
 * shape the Claude reader consumes and everything downstream stays one code
 * path — the same trade `codexSessions.ts` makes for rollouts.
 *
 * Note the asymmetry with the *live* stream: `qwen -o stream-json` emits Claude
 * Code's envelope verbatim, which is why the runtime's activity derivation needs
 * no translation at all. Only the file on disk is in Gemini's dialect.
 */

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { qwenPaths } from "../qwenHome.js";
import { cached } from "./cache.js";
import type { TranslatedLine } from "./codexSessions.js";

/** Encoded project dirs may begin with "-"; the session id is a UUID-ish token.
 *  Both must be a single safe path segment: no slashes, no ".". */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** The subdirectory Qwen Code keeps a project's transcripts in. */
const CHATS_DIR = "chats";

export interface QwenSessionFile {
  /** The encoded working directory — the same segment Claude Code would use. */
  project: string;
  id: string;
  file: string;
  mtime: number;
}

/**
 * Every readable transcript, newest-first order left to the caller.
 *
 * Cached briefly and shared, because the sessions list and transcript search
 * both want it and would otherwise each re-scan every project directory.
 */
export async function listQwenSessionFiles(): Promise<QwenSessionFile[]> {
  return cached(`qwen-sessions:${qwenPaths.projects()}`, 1500, async () => {
    let projectDirs: string[];
    try {
      const entries = await readdir(qwenPaths.projects(), { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // No Qwen Code home here, which is an ordinary state — not an error.
      return [];
    }

    const nested = await Promise.all(
      projectDirs.map(async (project) => {
        const dir = path.join(qwenPaths.projects(), project, CHATS_DIR);
        let names: string[];
        try {
          names = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
        } catch {
          // A project directory without a `chats/` subdirectory holds only
          // memory and cursor files; nothing to list.
          return [];
        }
        return Promise.all(
          names.map(async (name) => {
            const file = path.join(dir, name);
            let mtime = 0;
            try {
              mtime = (await stat(file)).mtimeMs;
            } catch {
              /* unreadable; keep mtime 0 so it sorts last rather than vanishing */
            }
            return { project, id: name.replace(/\.jsonl$/, ""), file, mtime };
          }),
        );
      }),
    );
    return nested.flat();
  });
}

/**
 * The transcript path for one `(project, sessionId)` pair, or null when either
 * segment is unsafe.
 *
 * Composed rather than looked up — Qwen Code files by project, so there is no
 * index to consult — and guarded the same way the Claude path is: the resolved
 * file must still sit directly inside the project's `chats/` directory, so a
 * crafted segment cannot escape it.
 */
export function qwenSessionFile(project: string, id: string): string | null {
  if (!SEGMENT_RE.test(project) || !SEGMENT_RE.test(id)) return null;
  const dir = path.resolve(qwenPaths.projects(), project, CHATS_DIR);
  const resolved = path.resolve(dir, `${id}.jsonl`);
  return path.dirname(resolved) === dir ? resolved : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The text of a `functionResponse.response`, whichever key the tool used. */
function responseText(raw: unknown): { text: string; isError: boolean } {
  if (typeof raw === "string") return { text: raw, isError: false };
  const r = asRecord(raw);
  if (!r) return { text: "", isError: false };
  if (typeof r.error === "string") return { text: r.error, isError: true };
  for (const key of ["output", "text", "content", "result"]) {
    if (typeof r[key] === "string") return { text: r[key] as string, isError: false };
  }
  // An unrecognized response is still worth showing verbatim rather than as an
  // empty tool result — a transcript reader can make sense of JSON, not of a gap.
  return { text: JSON.stringify(raw), isError: false };
}

type ContentBlock = NonNullable<NonNullable<TranslatedLine["message"]>["content"]>[number];

/** Map Gemini-dialect `parts[]` onto Claude-dialect content blocks. */
function translateParts(raw: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (!Array.isArray(raw)) return blocks;

  for (const item of raw) {
    const part = asRecord(item);
    if (!part) continue;

    if (typeof part.text === "string" && part.text.trim()) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    // A reasoning part, which the Claude reader already knows how to render and
    // the title deriver already knows to skip.
    if (typeof part.thought === "string" && part.thought.trim()) {
      blocks.push({ type: "thinking", thinking: part.thought });
      continue;
    }
    const call = asRecord(part.functionCall);
    if (call) {
      blocks.push({
        type: "tool_use",
        name: typeof call.name === "string" ? call.name : "tool",
        input: call.args ?? {},
      });
      continue;
    }
    const response = asRecord(part.functionResponse);
    if (response) {
      const { text, isError } = responseText(response.response);
      blocks.push({ type: "tool_result", content: text, ...(isError ? { is_error: true } : {}) });
    }
  }
  return blocks;
}

/**
 * Translate one Qwen Code transcript line into the Claude-shaped line the
 * readers expect, or null when it carries nothing a transcript view would show.
 *
 * `type: "system"` lines are Qwen Code's telemetry rather than conversation, so
 * they never become messages — but they are the only place the model name is
 * recorded, and every line carries the run's directory, so they come through as
 * a meta line the summarizer reads both from. That mirrors how a Codex
 * `turn_context` is handled, and keeps the model column populated for a runtime
 * whose messages never name it.
 */
export function translateQwenLine(raw: unknown): TranslatedLine | null {
  const line = asRecord(raw);
  if (!line) return null;
  const timestamp = typeof line.timestamp === "string" ? line.timestamp : undefined;
  const cwd = typeof line.cwd === "string" ? line.cwd : undefined;

  if (line.type === "system") {
    const payload = asRecord(line.systemPayload);
    const event = payload ? asRecord(payload.uiEvent) : null;
    const model = event && typeof event.model === "string" ? event.model : undefined;
    if (!cwd && !model) return null;
    return {
      type: "qwen-meta",
      timestamp,
      ...(cwd ? { cwd } : {}),
      ...(model ? { message: { model } } : {}),
    };
  }

  const message = asRecord(line.message);
  if (!message) return null;
  const blocks = translateParts(message.parts);
  if (blocks.length === 0) return null;

  // Qwen Code names three line types where Claude Code names two: a tool result
  // is its own `tool_result` line rather than a user message carrying one. Both
  // land on "user", which is where the Claude reader already looks for them.
  const isAssistant = line.type === "assistant" || message.role === "model";
  return {
    type: isAssistant ? "assistant" : "user",
    timestamp,
    ...(cwd ? { cwd } : {}),
    // A tool result is not the user talking, and must never become the session
    // title — the same signal Codex's injected instructions come through with.
    ...(line.type === "tool_result" ? { isMeta: true } : {}),
    message: {
      role: isAssistant ? "assistant" : "user",
      content: blocks,
    },
  };
}

/** Translate a whole transcript, dropping the lines that carry nothing to show. */
export function translateQwenTranscript(lines: unknown[]): TranslatedLine[] {
  const out: TranslatedLine[] = [];
  for (const l of lines) {
    const t = translateQwenLine(l);
    if (t) out.push(t);
  }
  return out;
}
