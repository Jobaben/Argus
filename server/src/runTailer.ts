/**
 * Tails the NDJSON logs of running pipeline steps (written by `claude -p
 * --output-format stream-json --verbose`) and derives compact activity events
 * for the Command Center. The log on disk is the durable source of truth;
 * everything here is in-memory and rebuilt from the log after a restart.
 */

export interface ActivityEvent {
  /** Arrival timestamp, stamped when Argus read the line (events carry none). */
  at: string;
  kind: "init" | "tool" | "text" | "done";
  label: string;
}

const LABEL_MAX = 80;

/** One-line, length-capped label text. */
function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}…` : t;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** "Bash: npm test" / "Edit: foo.ts" / bare tool name for everything else. */
function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return clip(`${name}: ${String(input.command ?? "")}`);
    case "Read":
    case "Edit":
    case "Write":
      return clip(
        `${name}: ${typeof input.file_path === "string" ? basename(input.file_path) : ""}`,
      );
    case "Task":
      return clip(`${name}: ${String(input.description ?? "")}`);
    default:
      return name;
  }
}

/**
 * Map one NDJSON line to zero or more activity events. Unknown, malformed,
 * and uninteresting lines (user/tool_result echoes) yield nothing.
 */
export function deriveActivity(line: string, at: string): ActivityEvent[] {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object") return [];
  if (obj.type === "system" && obj.subtype === "init") {
    return [{ at, kind: "init", label: "session started" }];
  }
  if (obj.type === "result") return [{ at, kind: "done", label: "finished" }];
  if (obj.type !== "assistant") return [];
  const message = obj.message as Record<string, unknown> | undefined;
  const content = Array.isArray(message?.content) ? (message.content as unknown[]) : [];
  const events: ActivityEvent[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    if (block?.type === "tool_use" && typeof block.name === "string") {
      events.push({
        at,
        kind: "tool",
        label: summarizeToolUse(block.name, (block.input ?? {}) as Record<string, unknown>),
      });
    } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      events.push({ at, kind: "text", label: clip(block.text) });
    }
  }
  return events;
}
