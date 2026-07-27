import type {
  RecorderEvent,
  RecorderLane,
  RecorderLaneSummary,
  RecorderTotals,
  RecorderUnavailable,
  Recording,
} from "@argus/contracts";
import type { Run } from "./scheduleTypes.js";

/**
 * The Flight Recorder derivation: a run's transcript, replayed as a timeline.
 *
 * This module is deliberately pure — `(run, transcript lines, now) → Recording`
 * — so the whole of it is testable without a filesystem, and so the recording
 * can never drift from the transcript it was built from. The route in `app.ts`
 * does the reading; everything interesting happens here.
 *
 * Three things the raw JSONL does not give you, and this does:
 *
 * **A shared clock.** Transcript timestamps are wall-clock strings scattered
 * across lines, some missing. Every event is placed at a millisecond offset
 * from one origin (the run's start), clamped monotonic, so a scrubber position
 * is a well-defined instant rather than a line number.
 *
 * **Causality.** A `tool_use` block and the `tool_result` that answers it are
 * two lines that may be far apart. They are joined here by `tool_use_id`, which
 * is what turns a tool call into a *span* with a duration and an error flag.
 *
 * **Cost.** The CLI reports one `total_cost_usd` for the whole run. Spreading
 * it across the token bursts by share is an apportionment, not a measurement,
 * which is why the recording says so (`costEstimated`) rather than presenting
 * per-event dollars as fact.
 */

/**
 * Events kept per recording. A long agentic run can emit tens of thousands of
 * lines; past a couple of thousand the timeline is denser than a pixel per
 * event and the payload starts to dominate the response. When the cap bites,
 * the *earliest* events go: the end of a run is where failures live, and the
 * origin stays fixed so surviving offsets remain absolute.
 */
export const EVENT_CAP = 2000;

const LABEL_MAX = 120;
const DETAIL_MAX = 800;

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface RawLine {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    model?: string;
    content?: string | RawBlock[];
    usage?: RawUsage;
  };
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function block(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** Line count of a string, treating "" as zero lines rather than one. */
function lineCount(s: unknown): number {
  return typeof s === "string" && s.length > 0 ? s.split("\n").length : 0;
}

/** Added/removed line counts for the edit-shaped tools, best effort. */
export function diffShape(
  tool: string,
  input: Record<string, unknown>,
): {
  added: number;
  removed: number;
} {
  if (tool === "Edit") {
    return { added: lineCount(input.new_string), removed: lineCount(input.old_string) };
  }
  if (tool === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? (input.edits as Record<string, unknown>[]) : [];
    return edits.reduce<{ added: number; removed: number }>(
      (acc, e) => ({
        added: acc.added + lineCount(e?.new_string),
        removed: acc.removed + lineCount(e?.old_string),
      }),
      { added: 0, removed: 0 },
    );
  }
  if (tool === "Write") {
    // A write replaces the file wholesale; the transcript never carries what
    // was there before, so "removed" is unknown rather than zero-and-claimed.
    return { added: lineCount(input.content), removed: 0 };
  }
  if (tool === "NotebookEdit") {
    return { added: lineCount(input.new_source), removed: 0 };
  }
  return { added: 0, removed: 0 };
}

/** The one-line label for a tool call — the same vocabulary the activity rail
 *  uses, so a tool reads identically wherever it appears. */
export function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return clip(`Bash: ${String(input.command ?? "")}`, LABEL_MAX);
    case "Read":
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return clip(
        `${name}: ${typeof input.file_path === "string" ? basename(input.file_path) : (input.notebook_path as string) || ""}`,
        LABEL_MAX,
      );
    case "Task":
      return clip(`Task: ${String(input.description ?? "")}`, LABEL_MAX);
    case "Grep":
    case "Glob":
      return clip(`${name}: ${String(input.pattern ?? "")}`, LABEL_MAX);
    default:
      return name;
  }
}

function usageTokens(usage: RawUsage | undefined): number {
  if (!usage) return 0;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  // Cache reads are billed differently but they *are* tokens moved through the
  // model; counting them keeps the burst sizes on the timeline honest.
  return (
    n(usage.input_tokens) +
    n(usage.output_tokens) +
    n(usage.cache_creation_input_tokens) +
    n(usage.cache_read_input_tokens)
  );
}

/** Flatten a tool_result's content into displayable text. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    const item = raw as RawBlock;
    if (item && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

const LANE_LABEL: Record<RecorderLane, string> = {
  agent: "Agent",
  tool: "Tools",
  file: "Files",
  spend: "Tokens & cost",
};

/** A failure worth anchoring the "jump to failure" control on. Mirrors the
 *  Issues definition so the two features never disagree about what failed. */
function runFailed(run: Run): boolean {
  return (
    run.status === "failed" ||
    run.status === "interrupted" ||
    run.outcome === "failed" ||
    run.outcome === "blocked"
  );
}

function tsOf(line: RawLine): number | null {
  if (typeof line.timestamp !== "string") return null;
  const t = Date.parse(line.timestamp);
  return Number.isFinite(t) ? t : null;
}

/**
 * Build the recording for one run from its transcript lines.
 *
 * `rawLines` is whatever `readSessionLines` returned — unvalidated JSON. Every
 * shape check is defensive: a transcript written by a newer CLI must degrade to
 * fewer events, never to a thrown route.
 */
export function buildRecording(run: Run, rawLines: unknown[], now: Date): Recording {
  const lines = rawLines.filter((l): l is RawLine => !!l && typeof l === "object");

  const firstTs = lines.map((l) => tsOf(l)).find((t): t is number => t !== null) ?? null;
  const startedAtMs = run.startedAt ? Date.parse(run.startedAt) : null;
  const originMs =
    startedAtMs !== null && Number.isFinite(startedAtMs)
      ? startedAtMs
      : (firstTs ?? Date.parse(run.queuedAt));
  const origin = Number.isFinite(originMs) ? originMs : now.getTime();

  const events: RecorderEvent[] = [];
  let seq = 0;
  let lastAtMs = 0;
  // Tool calls awaiting their result line, by tool_use_id.
  const openTools = new Map<string, { index: number; atMs: number }>();
  let tokensTotal = 0;
  let errors = 0;
  let files = 0;
  let tools = 0;

  const push = (
    atMs: number,
    lane: RecorderLane,
    kind: RecorderEvent["kind"],
    label: string,
    extra: Partial<RecorderEvent> = {},
  ): number => {
    // Transcript timestamps can go backwards across resumed sessions; a
    // scrubber over a non-monotonic axis jumps around, so clamp instead.
    const at = Math.max(lastAtMs, Math.max(0, atMs));
    lastAtMs = at;
    events.push({
      id: `e${seq++}`,
      atMs: at,
      at: new Date(origin + at).toISOString(),
      lane,
      kind,
      label,
      ...extra,
    });
    return events.length - 1;
  };

  if (run.startedAt) {
    push(0, "agent", "start", `Run started — ${run.scheduleName}`, {
      detail: block(run.prompt, DETAIL_MAX),
    });
  }

  for (const line of lines) {
    const ts = tsOf(line);
    const atMs = ts === null ? lastAtMs : ts - origin;
    const content = line.message?.content;
    const blocks: RawBlock[] = Array.isArray(content) ? (content as RawBlock[]) : [];

    if (line.type === "assistant") {
      const burst = usageTokens(line.message?.usage);
      for (const b of blocks) {
        if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          push(atMs, "agent", "thinking", clip(b.thinking, LABEL_MAX), {
            detail: block(b.thinking, DETAIL_MAX),
          });
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          push(atMs, "agent", "text", clip(b.text, LABEL_MAX), {
            detail: block(b.text, DETAIL_MAX),
          });
        } else if (b?.type === "tool_use" && typeof b.name === "string") {
          const input = (b.input ?? {}) as Record<string, unknown>;
          const isFile = FILE_TOOLS.has(b.name) && typeof input.file_path === "string";
          const lane: RecorderLane = isFile ? "file" : "tool";
          const shape = isFile ? diffShape(b.name, input) : null;
          const index = push(atMs, lane, isFile ? "file" : "tool", toolLabel(b.name, input), {
            tool: b.name,
            ...(isFile
              ? { path: input.file_path as string, added: shape?.added, removed: shape?.removed }
              : {}),
            ...(b.name === "Bash" && typeof input.command === "string"
              ? { detail: block(input.command, DETAIL_MAX) }
              : {}),
          });
          if (isFile) files++;
          else tools++;
          if (typeof b.id === "string") openTools.set(b.id, { index, atMs: events[index].atMs });
        }
      }
      if (burst > 0) {
        tokensTotal += burst;
        push(atMs, "spend", "usage", `${formatTokens(burst)} tokens`, {
          tokens: burst,
          tokensTotal,
        });
      }
      continue;
    }

    if (line.type === "user") {
      for (const b of blocks) {
        if (b?.type !== "tool_result") continue;
        const open = typeof b.tool_use_id === "string" ? openTools.get(b.tool_use_id) : undefined;
        if (open) {
          openTools.delete(b.tool_use_id as string);
          const target = events[open.index];
          target.durationMs = Math.max(0, Math.max(lastAtMs, atMs) - open.atMs);
          if (b.is_error) {
            target.errored = true;
            errors++;
            const text = resultText(b.content);
            if (text.trim()) target.detail = block(text, DETAIL_MAX);
          }
        } else if (b.is_error) {
          // A result with no matching call (truncated or resumed transcript)
          // still marks a failure moment worth landing the scrubber on.
          errors++;
          push(atMs, "tool", "error", clip(resultText(b.content) || "tool error", LABEL_MAX), {
            errored: true,
            detail: block(resultText(b.content), DETAIL_MAX),
          });
        }
      }
      // The very first non-meta user line is the prompt that started it all;
      // later ones are tool-result envelopes, already handled above.
      if (!line.isMeta && blocks.every((b) => b?.type !== "tool_result")) {
        const text = typeof content === "string" ? content : extractPlainText(blocks);
        if (text.trim() && events.every((e) => e.kind !== "prompt")) {
          push(atMs, "agent", "prompt", clip(text, LABEL_MAX), { detail: block(text, DETAIL_MAX) });
        }
      }
    }
  }

  // Apportion the run's single reported cost across the token bursts. Done in a
  // second pass because the share of each burst is only knowable once the total
  // is: a streaming attribution would have to guess.
  const costEstimated = run.costUsd != null && tokensTotal > 0;
  if (costEstimated) {
    let cumulative = 0;
    for (const e of events) {
      if (e.kind !== "usage" || !e.tokens) continue;
      const share = round6((run.costUsd as number) * (e.tokens / tokensTotal));
      cumulative = round6(cumulative + share);
      e.costUsd = share;
      e.costTotalUsd = cumulative;
      e.label = `${formatTokens(e.tokens)} tokens · ${formatUsd(share)}`;
    }
  }

  // Terminal marker. A running run has no end yet, and its scrubber extends to
  // "now" so the playhead has somewhere to sit while work continues.
  if (run.endedAt) {
    const endMs = Date.parse(run.endedAt);
    const at = Number.isFinite(endMs) ? endMs - origin : lastAtMs;
    const failed = runFailed(run);
    push(at, "agent", failed ? "error" : "end", failed ? terminalLabel(run) : "Run finished", {
      detail: block(run.error ?? run.resultSummary ?? "", DETAIL_MAX) || undefined,
    });
  }

  const totalEvents = events.length;
  const kept = totalEvents > EVENT_CAP ? events.slice(-EVENT_CAP) : events;

  const failureIndex = runFailed(run) ? lastFailureIndex(kept) : null;

  const lanes: RecorderLaneSummary[] = (["agent", "tool", "file", "spend"] as RecorderLane[])
    .map((lane) => ({
      lane,
      label: LANE_LABEL[lane],
      count: kept.filter((e) => e.lane === lane).length,
    }))
    .filter((l) => l.count > 0);

  const endMs = run.endedAt ? Date.parse(run.endedAt) : null;
  const tail =
    endMs !== null && Number.isFinite(endMs)
      ? endMs - origin
      : run.status === "running"
        ? now.getTime() - origin
        : lastAtMs;

  const totals: RecorderTotals = {
    tools,
    files,
    errors,
    tokens: tokensTotal > 0 ? tokensTotal : (run.tokens ?? null),
    costUsd: run.costUsd ?? null,
  };

  return {
    runId: run.id,
    scheduleId: run.scheduleId,
    scheduleName: run.scheduleName,
    status: run.status,
    outcome: run.outcome ?? null,
    sessionId: run.sessionId,
    project: run.project,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: Math.max(0, Math.max(lastAtMs, tail)),
    events: kept,
    lanes,
    failureIndex,
    totals,
    costEstimated,
    truncated: totalEvents > kept.length,
    unavailable: kept.length === 0 ? unavailableReason(run, lines.length) : null,
  };
}

/** The last thing that went wrong, preferring a concrete errored tool call over
 *  the terminal marker — that is the moment worth scrubbing to. */
function lastFailureIndex(events: RecorderEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].errored) return i;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === "error") return i;
  }
  return events.length > 0 ? events.length - 1 : null;
}

function terminalLabel(run: Run): string {
  if (run.error?.trim()) return clip(`Failed — ${run.error}`, LABEL_MAX);
  if (run.outcome === "blocked") return "Blocked";
  if (run.status === "interrupted") return "Interrupted";
  return `Failed${run.exitCode != null ? ` — exit code ${run.exitCode}` : ""}`;
}

function unavailableReason(run: Run, lineCountSeen: number): RecorderUnavailable {
  if (!run.startedAt) return "not-started";
  if (!run.sessionId) return "no-session";
  return lineCountSeen === 0 ? "no-transcript" : "empty-transcript";
}

function extractPlainText(blocks: RawBlock[]): string {
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
