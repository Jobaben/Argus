/**
 * OpenAI Codex CLI (`codex exec`) — the second runtime.
 *
 * The mapping to Claude Code, feature for feature:
 *
 * | Argus needs                | Claude Code                        | Codex                                    |
 * | -------------------------- | ---------------------------------- | ---------------------------------------- |
 * | headless run               | `claude -p`                        | `codex exec`                             |
 * | prompt off argv            | stdin                              | stdin, via the `-` prompt placeholder    |
 * | one parseable result       | `--output-format json`             | `--json` (a JSONL event stream)          |
 * | live transcript to tail    | `--output-format stream-json`      | the same `--json` stream                 |
 * | model override             | `--model`                          | `--model`                                |
 * | outcome signal             | `Stop` hook in `settings.json`     | `[[hooks.stop]]` in `config.toml`        |
 * | session id                 | `--session-id <uuid>` (we choose)  | reported back as `thread.started`        |
 * | Argus-owned instructions   | `--append-system-prompt`           | prepended to the prompt                  |
 * | transcripts on disk        | `projects/<proj>/<id>.jsonl`       | `sessions/YYYY/MM/DD/rollout-*.jsonl`    |
 *
 * Two differences survive the mapping and are declared as capabilities rather
 * than papered over:
 *
 *   * **No caller-chosen session id.** Codex mints its own thread id, so Argus
 *     reads it back out of the stream and patches the run record once the run
 *     starts. Until then the transcript link is simply not there yet, which is
 *     honest; inventing an id would produce a link to nothing.
 *   * **No dollar figure.** `turn.completed.usage` reports tokens, not money.
 *     Cost stays null for Codex runs, and the Budget view reports what it has
 *     rather than a number nobody can reconcile against an invoice.
 *
 * Codex also runs sandboxed by default. `ARGUS_CODEX_SANDBOX` selects the mode
 * (`workspace-write` by default, matching what an unattended agent needs to do
 * useful work in a checkout); `ARGUS_CODEX_ARGS` is the escape hatch for
 * anything else the local install needs.
 */

import { codexHome } from "../codexHome.js";
import { log } from "../log.js";
import { EMPTY_ENVELOPE, basename, clip, extraArgs } from "./types.js";
import type {
  AgentRuntime,
  AnalysisPlanOptions,
  RunEnvelope,
  RunPlanOptions,
  SpawnPlan,
} from "./types.js";
import type { ActivityEvent } from "@argus/contracts";

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
export const DEFAULT_CODEX_SANDBOX = "workspace-write";

function bin(): string {
  return process.env.ARGUS_CODEX_BIN?.trim() || "codex";
}

/** The sandbox mode for ordinary runs. An unrecognized value is a typo, not a
 *  reason to hand the CLI something it will reject at spawn time. */
export function codexSandbox(): string {
  const raw = process.env.ARGUS_CODEX_SANDBOX?.trim();
  if (!raw) return DEFAULT_CODEX_SANDBOX;
  if (SANDBOX_MODES.has(raw)) return raw;
  log.warn("ignoring invalid ARGUS_CODEX_SANDBOX", {
    value: raw,
    allowed: [...SANDBOX_MODES].join(" | "),
    using: DEFAULT_CODEX_SANDBOX,
  });
  return DEFAULT_CODEX_SANDBOX;
}

/**
 * Base argv for every `codex exec`.
 *
 * `--json` is the only output format Argus reads: it is both the result
 * envelope (last `agent_message` item plus `turn.completed.usage`) and the live
 * transcript the tailer follows, so a batch run and a pipeline step differ only
 * in how the log is consumed.
 *
 * `--skip-git-repo-check` because a schedule's cwd is whatever directory the
 * operator pointed it at; refusing to run outside a repo would make Argus
 * narrower than the CLI it drives.
 */
function execArgs(opts: { sandbox: string; model?: string | null }): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    opts.sandbox,
    ...(opts.model && opts.model.trim() ? ["--model", opts.model.trim()] : []),
    ...extraArgs(process.env.ARGUS_CODEX_ARGS),
    // The prompt placeholder: read it from stdin, so no shell and no argv ever
    // sees user-authored text. Must stay last — it is the positional argument.
    "-",
  ];
}

/** Codex has no `--append-system-prompt`, so Argus-owned instructions ride at
 *  the top of the prompt. Same text, same effect, one delivery mechanism. */
function composePrompt(prompt: string, systemPrompt?: string): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  exit_code?: number;
  server?: string;
  tool?: string;
  query?: string;
  changes?: { path?: string }[];
  items?: unknown[];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Fold a `codex exec --json` JSONL stream into the one envelope shape the run
 * record stores.
 *
 * Deliberately tolerant: the same file also carries stderr (the pipeline engine
 * points both descriptors at one log) and may start mid-line when only the tail
 * was captured, so anything that isn't a parseable event is skipped rather than
 * failing the parse.
 */
export function parseCodexEnvelope(stdout: string): RunEnvelope {
  const text = stdout.trim();
  if (!text) return EMPTY_ENVELOPE;

  let result: string | null = null;
  let sessionId: string | null = null;
  let tokens: number | null = null;
  let isError: boolean | null = null;
  let errorMessage: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    let obj: Record<string, unknown> | null;
    try {
      obj = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!obj) continue;
    switch (obj.type) {
      case "thread.started": {
        if (typeof obj.thread_id === "string") sessionId = obj.thread_id;
        break;
      }
      case "item.completed": {
        const item = asRecord(obj.item) as CodexItem | null;
        if (!item) break;
        // Last agent message wins: it is the run's answer, and the same field
        // the `-o/--output-last-message` file would have received.
        if (item.type === "agent_message" && typeof item.text === "string") result = item.text;
        if (item.type === "error" && typeof item.message === "string") {
          isError = true;
          errorMessage = item.message;
        }
        break;
      }
      case "turn.completed": {
        const usage = asRecord(obj.usage);
        if (usage) {
          const inTok = Number(usage.input_tokens ?? 0);
          const outTok = Number(usage.output_tokens ?? 0);
          const sum = inTok + outTok;
          if (Number.isFinite(sum) && sum > 0) tokens = (tokens ?? 0) + sum;
        }
        // A completed turn is a clean finish unless an error item said otherwise.
        if (isError === null) isError = false;
        break;
      }
      case "turn.failed": {
        isError = true;
        const err = asRecord(obj.error);
        if (err && typeof err.message === "string") errorMessage = err.message;
        break;
      }
      case "error": {
        isError = true;
        if (typeof obj.message === "string") errorMessage = obj.message;
        break;
      }
      default:
        break;
    }
  }

  return {
    // With no agent message to report, the failure text is the closest thing to
    // a result — and it is what the run card would otherwise leave blank.
    result: result ?? errorMessage,
    // Codex reports tokens, not dollars. See the header note.
    costUsd: null,
    tokens,
    isError,
    sessionId,
  };
}

/** `Edit: foo.ts` / `Edit: foo.ts +2` for a multi-file patch. */
function summarizeFileChange(item: CodexItem): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const first = changes.find((c) => typeof c?.path === "string")?.path;
  if (!first) return "Edit";
  const more = changes.length > 1 ? ` +${changes.length - 1}` : "";
  return clip(`Edit: ${basename(first)}${more}`);
}

/** A tool label for one stream item, or null when the item isn't tool activity. */
function toolLabel(item: CodexItem): string | null {
  switch (item.type) {
    case "command_execution":
      return clip(`Shell: ${String(item.command ?? "")}`);
    case "mcp_tool_call":
      return clip(`${String(item.server ?? "mcp")}.${String(item.tool ?? "")}`);
    case "file_change":
      return summarizeFileChange(item);
    case "web_search":
      return clip(`Search: ${String(item.query ?? "")}`);
    case "todo_list":
      return clip(`Todo: ${Array.isArray(item.items) ? item.items.length : 0} items`);
    default:
      return null;
  }
}

/**
 * Map one `codex exec --json` line to zero or more activity events.
 *
 * Which of `item.started` / `item.completed` an item is reported on is chosen
 * per type so nothing is emitted twice: the two long-running kinds (a shell
 * command, an MCP call) are announced when they *start*, because that is the
 * label you want on screen while they run, and everything else — which is
 * effectively instantaneous — is reported when it completes. Reasoning items are
 * skipped, matching the Claude derivation's treatment of thinking blocks.
 */
export function deriveCodexActivity(line: string, at: string): ActivityEvent[] {
  let obj: Record<string, unknown> | null;
  try {
    obj = asRecord(JSON.parse(line));
  } catch {
    return [];
  }
  if (!obj) return [];

  if (obj.type === "thread.started") return [{ at, kind: "init", label: "session started" }];
  if (obj.type === "turn.completed") return [{ at, kind: "done", label: "finished" }];
  if (obj.type === "turn.failed") {
    const err = asRecord(obj.error);
    const msg = err && typeof err.message === "string" ? err.message : "turn failed";
    return [{ at, kind: "text", label: clip(`failed: ${msg}`) }];
  }
  if (obj.type === "error" && typeof obj.message === "string") {
    return [{ at, kind: "text", label: clip(`error: ${obj.message}`) }];
  }

  const started = obj.type === "item.started";
  const completed = obj.type === "item.completed";
  if (!started && !completed) return [];
  const item = asRecord(obj.item) as CodexItem | null;
  if (!item) return [];

  // The two long-running kinds are announced when they start; everything else is
  // instantaneous and is announced when it completes. Reporting each item on
  // exactly one half of its lifecycle is what keeps the feed free of duplicates.
  const streams = item.type === "command_execution" || item.type === "mcp_tool_call";
  if (streams !== started) return [];

  if (item.type === "agent_message") {
    return typeof item.text === "string" && item.text.trim()
      ? [{ at, kind: "text", label: clip(item.text) }]
      : [];
  }
  if (item.type === "error") {
    return typeof item.message === "string"
      ? [{ at, kind: "text", label: clip(`error: ${item.message}`) }]
      : [];
  }
  const label = toolLabel(item);
  return label ? [{ at, kind: "tool", label }] : [];
}

/** Model aliases to offer in a picker. Codex's catalogue moves faster than this
 *  file can, so it is empty by default (the UI keeps its free-text field) and
 *  `ARGUS_CODEX_MODELS` fills it in for an install that wants the shortcut. */
function models(): string[] {
  return (process.env.ARGUS_CODEX_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const codexRuntime: AgentRuntime = {
  id: "codex",
  label: "Codex",
  bin,
  versionArgs: ["--version"],
  home: codexHome,
  models,
  capabilities: {
    presetSessionId: false,
    appendSystemPrompt: false,
    reportsCost: false,
    reportsTokens: true,
    signalHook: true,
    liveActivity: true,
    transcripts: true,
  },
  // Codex's model catalogue is account-dependent, so there is no safe cheap
  // default to name: let the CLI's own configuration decide unless an operator
  // sets ARGUS_ANALYSIS_MODEL.
  defaultAnalysisModel: () => "",

  batchPlan({ prompt, model, systemPrompt }: RunPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: execArgs({ sandbox: codexSandbox(), model }),
      stdin: composePrompt(prompt, systemPrompt),
      env: {},
    };
  },

  // `--json` is already a live NDJSON stream, so a step run and a batch run take
  // the same argv; only the consumer of the log differs.
  streamPlan({ prompt, model, systemPrompt }: RunPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: execArgs({ sandbox: codexSandbox(), model }),
      stdin: composePrompt(prompt, systemPrompt),
      env: {},
    };
  },

  /** Analysis passes read text that is already in the prompt and answer with
   *  JSON; they have no business writing to the disk, so they are read-only
   *  regardless of what ordinary runs are allowed to do. */
  analysisPlan({ prompt, model }: AnalysisPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: execArgs({ sandbox: "read-only", model }),
      stdin: prompt,
      env: {},
    };
  },

  parseEnvelope: parseCodexEnvelope,
  deriveActivity: deriveCodexActivity,
};
