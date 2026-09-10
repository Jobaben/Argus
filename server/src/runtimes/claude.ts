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
import { EMPTY_ENVELOPE, basename, clip, extraArgs, unsupportedCapabilities } from "./types.js";
import type {
  AgentRuntime,
  AnalysisPlanOptions,
  CapabilityRequest,
  MaterializedFile,
  RunEnvelope,
  RunPlanOptions,
  SpawnPlan,
} from "./types.js";
import type { ActivityEvent } from "@argus/contracts";

/** Every `CapabilityProfile` key Claude Code can map onto its own invocation —
 *  which is all of them; the one gap (Bash left unrestricted under
 *  `read-only`) is reported as a specific limitation rather than the generic
 *  "cannot enforce" one, so it never appears in this list. */
const CLAUDE_SUPPORTED_CAPABILITIES = [
  "filesystem",
  "tools",
  "mcpServers",
  "additionalDirectories",
  "settingSources",
  "permissionMode",
  "maxTurns",
] as const;

/** A bare, unscoped `Bash` allow rule — one that leaves the shell unrestricted
 *  regardless of `filesystem: "read-only"`. */
function isBareBashRule(rule: string): boolean {
  return rule === "Bash" || rule === "Bash(*)" || rule === "Bash(*:*)";
}

interface ClaudeCapabilityResult {
  args: string[];
  files: MaterializedFile[];
  limitations: string[];
}

/**
 * Maps a {@link CapabilityRequest} onto Claude Code's own flags and config
 * files. Shared by `batchPlan` and `streamPlan` so the two forms can never
 * drift on what a profile means.
 */
function buildClaudeCapabilities(cap: CapabilityRequest | undefined): ClaudeCapabilityResult {
  if (!cap) return { args: [], files: [], limitations: [] };
  const { profile, invocationDir, cwd, artifactDir, hooks } = cap;
  const args: string[] = [];
  const files: MaterializedFile[] = [];
  const limitations = unsupportedCapabilities(profile, "Claude Code", [
    ...CLAUDE_SUPPORTED_CAPABILITIES,
  ]);

  const allow = [...(profile.tools?.allow ?? [])];
  const deny = [...(profile.tools?.deny ?? [])];

  if (profile.filesystem === "read-only") {
    deny.push(`Edit(//${cwd}/**)`);
    for (const dir of profile.additionalDirectories ?? []) deny.push(`Edit(//${dir}/**)`);

    const bashAllowRules = allow.filter((r) => r === "Bash" || r.startsWith("Bash("));
    const hasBareBash = bashAllowRules.some(isBareBashRule);
    const hasScopedBash = bashAllowRules.some((r) => !isBareBashRule(r));
    if (hasBareBash) {
      limitations.push("read-only cannot prevent shell writes while Bash is allowed unrestricted");
    } else if (!hasScopedBash) {
      deny.push("Bash");
    }
    // hasScopedBash && !hasBareBash: Bash stays allowed, but only through the
    // scoped rules the profile named — nothing further to deny.
  }
  // "workspace-write" needs no extra rules: Claude Code's default already
  // scopes edits to cwd + additional dirs. "unrestricted" needs none either.

  if (allow.length) args.push("--allowedTools", allow.join(","));
  if (deny.length) args.push("--disallowedTools", deny.join(","));

  if (profile.mcpServers !== undefined) {
    const mcpPath = `${invocationDir}/mcp.json`;
    files.push({
      path: mcpPath,
      contents: `${JSON.stringify({ mcpServers: profile.mcpServers }, null, 2)}\n`,
    });
    args.push("--mcp-config", mcpPath, "--strict-mcp-config");
  }

  for (const dir of profile.additionalDirectories ?? []) args.push("--add-dir", dir);
  // The engine created artifactDir for this invocation to write into; keep it
  // reachable no matter what the profile said about the rest of the filesystem.
  if (artifactDir) args.push("--add-dir", artifactDir);

  if (profile.settingSources !== undefined) {
    args.push("--setting-sources", profile.settingSources.join(","));
  }
  if (profile.permissionMode) args.push("--permission-mode", profile.permissionMode);
  if (profile.maxTurns !== undefined) args.push("--max-turns", String(profile.maxTurns));

  if (hooks) {
    const settingsPath = `${invocationDir}/settings.json`;
    files.push({
      path: settingsPath,
      contents: `${JSON.stringify(
        {
          hooks: {
            Stop: [{ matcher: "", hooks: [{ type: "command", command: hooks.stop }] }],
            PreToolUse: [
              {
                matcher: "AskUserQuestion",
                hooks: [{ type: "command", command: hooks.gate }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    });
    args.push("--settings", settingsPath);
  }

  return { args, files, limitations };
}

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

/**
 * Byte spans [start,end] of every balanced top-level `{...}` in `text`,
 * ignoring braces inside JSON strings.
 *
 * Exported because it is the one reliable way to find a CLI's result object in
 * a log that also carries stderr, may be truncated to its tail, and — for Qwen
 * Code's `-o json` — prints every event of the run as one line-long JSON array.
 * Array brackets are not tracked, so the objects *inside* one are found too.
 */
export function topLevelObjectSpans(text: string): [number, number][] {
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
 *
 * Shared with Qwen Code, whose `-o stream-json` emits the same envelope — same
 * `system`/`init`, `assistant` content blocks and closing `result` — so only
 * the tool *vocabulary* differs, which is what `summarizeTool` supplies.
 */
export function deriveStreamJsonActivity(
  line: string,
  at: string,
  summarizeTool: (name: string, input: Record<string, unknown>) => string,
): ActivityEvent[] {
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
          prefix + summarizeTool(block.name, (block.input ?? {}) as Record<string, unknown>),
        ),
      });
    } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
      events.push({ at, kind: "text", label: clip(prefix + block.text) });
    }
  }
  return events;
}

/** The Claude Code derivation: the shared stream-json reader, told Claude's
 *  tool names. */
export function deriveClaudeActivity(line: string, at: string): ActivityEvent[] {
  return deriveStreamJsonActivity(line, at, summarizeToolUse);
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
  reasoningEfforts: () => [],
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
  // The Stop hook is the completion protocol here, and it has both halves of
  // the gate (PreToolUse too). Reading an outcome back off the run record would
  // only ever second-guess a signal that already arrived.
  outcomeFromRecord: false,

  /**
   * Runs `claude -p` with a pre-generated session id (so the transcript can be
   * linked) and `--output-format json`, which prints one result envelope we can
   * mine for the result text, cost and tokens.
   */
  batchPlan({ prompt, sessionId, model, capabilities }: RunPlanOptions): SpawnPlan {
    const cap = buildClaudeCapabilities(capabilities);
    return {
      bin: bin(),
      args: [
        "-p",
        "--output-format",
        "json",
        "--session-id",
        sessionId || randomUUID(),
        ...modelArgs(model),
        ...cap.args,
        ...extraArgs(process.env.ARGUS_CLAUDE_ARGS),
      ],
      stdin: prompt,
      env: {},
      ...(capabilities ? { files: cap.files, limitations: cap.limitations } : {}),
    };
  },

  /**
   * The pipeline-step form. `stream-json` turns the fd-backed log into a live
   * NDJSON transcript the run tailer can follow; the CLI requires `--verbose`
   * alongside it in `-p` mode.
   */
  streamPlan({ prompt, sessionId, model, systemPrompt, capabilities }: RunPlanOptions): SpawnPlan {
    const cap = buildClaudeCapabilities(capabilities);
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
        ...cap.args,
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
      ...(capabilities ? { files: cap.files, limitations: cap.limitations } : {}),
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
