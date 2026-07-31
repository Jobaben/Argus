/**
 * Claude Code (`claude -p`) — the runtime Argus was built around.
 *
 * Everything here is the behaviour that used to live inline in the scheduler,
 * the pipeline engine, the analysis runner and the run tailer, moved behind the
 * {@link AgentRuntime} seam without a single flag or parse rule changing. The
 * scheduler's `defaultSpawn`, `buildClaudeArgs` and `parseRunEnvelope` all
 * delegate here now, and the exported helpers keep their old names and shapes so
 * the existing tests still describe the same contract.
 */

import { randomUUID } from "node:crypto";
import { claudeHome } from "../claudeHome.js";
import { EMPTY_ENVELOPE, basename, clip, extraArgs } from "./types.js";
import type {
  AgentRuntime,
  AnalysisPlanOptions,
  RunEnvelope,
  RunPlanOptions,
  SpawnPlan,
} from "./types.js";
import type { ActivityEvent } from "@argus/contracts";

/**
 * The default analysis model.
 *
 * A postmortem, a rubric score and an intent plan are all short, structured,
 * low-stakes reads over text that is already in the prompt. Spending the
 * flagship model's price on them is how a helpful background feature turns into
 * a line item, so the cheap fast model is the default.
 */
export const DEFAULT_ANALYSIS_MODEL = "haiku";

function bin(): string {
  return process.env.ARGUS_CLAUDE_BIN?.trim() || "claude";
}

/**
 * `claude -p --output-format json` prints a single JSON envelope as its final
 * output. Parse it out of the captured stdout, tolerant of anything the tool
 * logged before it: try the whole buffer, then fall back to the last balanced
 * top-level `{...}` object. Returns nulls when nothing parses.
 */
export function parseClaudeEnvelope(stdout: string): RunEnvelope {
  const extract = (obj: Record<string, unknown>): RunEnvelope => {
    const usage = (obj.usage ?? {}) as Record<string, unknown>;
    const inTok = Number(usage.input_tokens ?? 0);
    const outTok = Number(usage.output_tokens ?? 0);
    const tokens = Number.isFinite(inTok + outTok) && inTok + outTok > 0 ? inTok + outTok : null;
    const cost = Number(obj.total_cost_usd ?? obj.cost_usd);
    return {
      result: typeof obj.result === "string" ? obj.result : null,
      costUsd: Number.isFinite(cost) ? cost : null,
      tokens,
      isError: typeof obj.is_error === "boolean" ? obj.is_error : null,
      // Claude Code takes the session id Argus hands it, so there is never
      // anything to learn back out of the envelope.
      sessionId: null,
    };
  };
  const text = stdout.trim();
  if (!text) return EMPTY_ENVELOPE;
  try {
    return extract(JSON.parse(text) as Record<string, unknown>);
  } catch {
    // Collect every balanced top-level {...} span with a string-aware depth
    // scan (so braces inside strings and any stray brace emitted AFTER the
    // envelope don't defeat extraction), then take the last span that parses
    // AND looks like the CLI envelope (has result/cost/usage).
    const spans = topLevelObjectSpans(text);
    for (let i = spans.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(text.slice(spans[i][0], spans[i][1] + 1)) as Record<string, unknown>;
        if ("result" in obj || "total_cost_usd" in obj || "cost_usd" in obj || "usage" in obj) {
          return extract(obj);
        }
      } catch {
        /* not valid JSON; try an earlier span */
      }
    }
    return EMPTY_ENVELOPE;
  }
}

/** Byte spans [start,end] of every balanced top-level `{...}` in `text`,
 *  ignoring braces inside JSON strings. */
function topLevelObjectSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push([start, i]);
        start = -1;
      } else if (depth < 0) {
        depth = 0; // stray closing brace; resync
      }
    }
  }
  return spans;
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
 * Map one `--output-format stream-json` line to zero or more activity events.
 * Unknown, malformed, and uninteresting lines (user/tool_result echoes) yield
 * nothing.
 */
export function deriveClaudeActivity(line: string, at: string): ActivityEvent[] {
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
  // Subagent messages (forwarded when CLAUDE_CODE_FORWARD_SUBAGENT_TEXT is set
  // at spawn) carry the spawning Task tool_use id; mark their labels so the
  // Command Center distinguishes them from the main agent's output.
  const prefix = typeof obj.parent_tool_use_id === "string" ? "Subagent: " : "";
  const events: ActivityEvent[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    if (block?.type === "tool_use" && typeof block.name === "string") {
      events.push({
        at,
        kind: "tool",
        label: clip(
          prefix + summarizeToolUse(block.name, (block.input ?? {}) as Record<string, unknown>),
        ),
      });
    } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      events.push({ at, kind: "text", label: clip(prefix + block.text) });
    }
  }
  return events;
}

function modelArgs(model: string | null | undefined): string[] {
  return model && model.trim() ? ["--model", model.trim()] : [];
}

export const claudeRuntime: AgentRuntime = {
  id: "claude",
  label: "Claude Code",
  bin,
  versionArgs: ["--version"],
  home: claudeHome,
  models: () => ["opus", "sonnet", "haiku"],
  capabilities: {
    presetSessionId: true,
    appendSystemPrompt: true,
    reportsCost: true,
    reportsTokens: true,
    signalHook: true,
    liveActivity: true,
    transcripts: true,
  },
  defaultAnalysisModel: () => DEFAULT_ANALYSIS_MODEL,

  /**
   * Runs `claude -p` with a pre-generated session id (so the transcript can be
   * linked) and `--output-format json`, which prints one result envelope we can
   * mine for the result text, cost and tokens.
   */
  batchPlan({ prompt, sessionId, model }: RunPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: [
        "-p",
        "--output-format",
        "json",
        "--session-id",
        sessionId || randomUUID(),
        ...modelArgs(model),
        ...extraArgs(process.env.ARGUS_CLAUDE_ARGS),
      ],
      stdin: prompt,
      env: {},
    };
  },

  /**
   * The pipeline-step form. `stream-json` turns the fd-backed log into a live
   * NDJSON transcript the run tailer can follow; the CLI requires `--verbose`
   * alongside it in `-p` mode.
   */
  streamPlan({ prompt, sessionId, model, systemPrompt }: RunPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--session-id",
        sessionId || randomUUID(),
        ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
        ...modelArgs(model),
        ...extraArgs(process.env.ARGUS_CLAUDE_ARGS),
      ],
      stdin: prompt,
      env: {
        // Opt the CLI into forwarding subagent text/thinking into the
        // stream-json log so the tailer can surface subagent activity. Env var
        // instead of the equivalent --forward-subagent-text flag: older CLIs
        // ignore the var but would reject the unknown flag.
        CLAUDE_CODE_FORWARD_SUBAGENT_TEXT: "1",
      },
    };
  },

  analysisPlan({ prompt, model }: AnalysisPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: [
        "-p",
        "--output-format",
        "json",
        "--session-id",
        randomUUID(),
        ...modelArgs(model || DEFAULT_ANALYSIS_MODEL),
      ],
      stdin: prompt,
      env: {},
    };
  },

  parseEnvelope: parseClaudeEnvelope,
  deriveActivity: deriveClaudeActivity,
};
