/**
 * Qwen Code (`qwen -p`) — the fourth runtime.
 *
 * Qwen Code is a fork of Gemini CLI that speaks an OpenAI-compatible endpoint,
 * which is what makes it the natural way to drive a model served locally
 * (`llama-server`, Ollama, vLLM) from Argus: point `OPENAI_BASE_URL` at
 * `http://127.0.0.1:8080/v1` and the same schedules and pipelines run against a
 * GPU in the next room instead of a vendor API.
 *
 * The mapping to Claude Code, feature for feature:
 *
 * | Argus needs                | Claude Code                        | Qwen Code                                |
 * | -------------------------- | ---------------------------------- | ---------------------------------------- |
 * | headless run               | `claude -p`                        | `qwen` with the prompt on stdin          |
 * | prompt off argv            | stdin                              | stdin (`-p` *appends* to it)             |
 * | one parseable result       | `--output-format json`             | `-o json` (an array of the same events)  |
 * | live transcript to tail    | `--output-format stream-json`      | `-o stream-json` (the same NDJSON)       |
 * | model override             | `--model`                          | `--model`                                |
 * | unattended tool approval   | CLI default                        | `--approval-mode yolo`                   |
 * | outcome signal             | `Stop` hook in `settings.json`     | the same `Stop` hook, same schema        |
 * | Argus-owned instructions   | `--append-system-prompt`           | prepended to the prompt                  |
 * | transcripts on disk        | `projects/<proj>/<id>.jsonl`       | `projects/<proj>/chats/<id>.jsonl`       |
 *
 * The stream envelope is not merely similar to Claude Code's, it is the same
 * one — `{"type":"system","subtype":"init"}`, `assistant` messages carrying
 * `text` and `tool_use` content blocks, a closing `{"type":"result"}` — which is
 * why the activity derivation here is Claude's, handed Qwen's tool names. So is
 * the hook payload: `last_assistant_message` and `background_tasks` arrive
 * exactly as `argus-signal.mjs` already expects, so one hook file serves both.
 *
 * Two differences survive the mapping and are declared as capabilities:
 *
 *   * **No caller-chosen session id.** Qwen Code mints its own UUID and reports
 *     it as `session_id`; `--resume` only resumes an existing one. Argus reads
 *     the id back out of the result and patches the run record, as it does for
 *     Codex and OpenCode.
 *   * **No emitted dollar figure.** The result envelope carries token counts
 *     and no cost, which is the honest answer for a locally served model:
 *     `costUsd` stays null rather than being invented.
 *
 * The transcripts on disk are the one place the two dialects diverge: the file
 * is filed the way Claude Code files one, but its lines are Gemini CLI's
 * (`message.parts[]`, `functionCall`, `role: "model"`). `sources/qwenSessions.ts`
 * translates them, so the Sessions view, transcript search and the Flight
 * Recorder read a Qwen run exactly as they read a Claude one.
 */

import { qwenHome } from "../qwenHome.js";
import { deriveStreamJsonActivity, topLevelObjectSpans } from "./claude.js";
import { EMPTY_ENVELOPE, basename, clip, extraArgs } from "./types.js";
import type {
  AgentRuntime,
  AnalysisPlanOptions,
  RunEnvelope,
  RunPlanOptions,
  SpawnPlan,
} from "./types.js";
import type { ActivityEvent } from "@argus/contracts";

/** Aliases for the models Qwen Code ships pointed at by default. A local
 *  endpoint's model name is whatever the operator loaded, so it comes from
 *  `OPENAI_MODEL` / `ARGUS_QWEN_MODELS` instead of being guessed at here. */
export const DEFAULT_QWEN_MODELS = ["qwen3-coder-plus", "qwen3-coder-flash"];

function bin(): string {
  return process.env.ARGUS_QWEN_BIN?.trim() || "qwen";
}

/**
 * Base argv for every Qwen Code run.
 *
 * No `-p`: the flag *appends* to whatever arrived on stdin rather than
 * replacing it, and a piped stdin is already enough to select headless mode, so
 * the prompt travels one way only — never argv, never split across two places.
 *
 * `--approval-mode yolo` because these runs are unattended by construction.
 * Without it Qwen Code hides the shell, write and edit tools entirely, and an
 * agent asked to fix a test would report back that it has no way to run one.
 * Analysis passes pass `default` instead, which is exactly that read-only tool
 * set.
 */
function qwenArgs(opts: {
  outputFormat: "json" | "stream-json";
  approvalMode: "default" | "yolo";
  model?: string | null;
}): string[] {
  return [
    "--output-format",
    opts.outputFormat,
    "--approval-mode",
    opts.approvalMode,
    ...(opts.model && opts.model.trim() ? ["--model", opts.model.trim()] : []),
    ...extraArgs(process.env.ARGUS_QWEN_ARGS),
  ];
}

/**
 * Environment every Qwen Code run gets.
 *
 * The yolo banner is written to stderr on every unattended start, and the
 * pipeline engine points both descriptors at one log — so left on, it is a
 * warning nobody reads that lands in the middle of the NDJSON transcript the
 * tailer parses. Argus has made the sandbox decision deliberately (see
 * `ARGUS_QWEN_ARGS` for `--sandbox`), so it silences the notice rather than
 * repeating it per run.
 */
function runEnv(): Record<string, string> {
  return { QWEN_CODE_SUPPRESS_YOLO_WARNING: "1" };
}

/** Qwen Code has no `--append-system-prompt`, so Argus-owned instructions ride
 *  at the top of the prompt. Same text, same effect, one delivery mechanism. */
function composePrompt(prompt: string, systemPrompt?: string): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Fold a Qwen Code run's output into the one envelope shape the run record
 * stores.
 *
 * The result object is the same shape in both output formats — one line of the
 * NDJSON under `-o stream-json`, the last element of a single-line JSON array
 * under `-o json` — so rather than branching on the format, this scans the text
 * for balanced top-level objects and takes the last one that says it is the
 * result. That also survives the two things that routinely corrupt a naive
 * parse: interleaved stderr, and a log captured only from its tail.
 */
export function parseQwenEnvelope(stdout: string): RunEnvelope {
  const text = stdout.trim();
  if (!text) return EMPTY_ENVELOPE;

  const spans = topLevelObjectSpans(text);
  for (let i = spans.length - 1; i >= 0; i--) {
    let obj: Record<string, unknown> | null;
    try {
      obj = asRecord(JSON.parse(text.slice(spans[i][0], spans[i][1] + 1)));
    } catch {
      continue;
    }
    if (!obj || obj.type !== "result") continue;

    const usage = asRecord(obj.usage) ?? {};
    const inTok = Number(usage.input_tokens ?? 0);
    const outTok = Number(usage.output_tokens ?? 0);
    const sum = inTok + outTok;
    // Qwen Code reports no cost of its own. A locally served model has none to
    // report, and a hosted one would need a price list Argus does not have.
    const cost = Number(obj.total_cost_usd);
    return {
      result: typeof obj.result === "string" ? obj.result : null,
      costUsd: Number.isFinite(cost) ? cost : null,
      tokens: Number.isFinite(sum) && sum > 0 ? sum : null,
      isError: typeof obj.is_error === "boolean" ? obj.is_error : null,
      sessionId: typeof obj.session_id === "string" ? obj.session_id : null,
    };
  }
  return EMPTY_ENVELOPE;
}

/** "Shell: npm test" / "Read: foo.ts" / bare tool name for everything else —
 *  Claude's summarizer against Qwen Code's tool vocabulary. */
function summarizeQwenTool(name: string, input: Record<string, unknown>): string {
  const file = input.file_path ?? input.absolute_path ?? input.path;
  const named = (label: string, value: unknown) =>
    clip(`${label}: ${typeof value === "string" ? value : ""}`);
  switch (name) {
    case "run_shell_command":
      return named("Shell", input.command);
    case "read_file":
      return clip(`Read: ${typeof file === "string" ? basename(file) : ""}`);
    case "write_file":
      return clip(`Write: ${typeof file === "string" ? basename(file) : ""}`);
    case "edit":
    case "notebook_edit":
      return clip(`Edit: ${typeof file === "string" ? basename(file) : ""}`);
    case "list_directory":
      return clip(`List: ${typeof file === "string" ? basename(file) : ""}`);
    case "glob":
      return named("Glob", input.pattern);
    case "grep_search":
      return named("Grep", input.pattern);
    case "web_fetch":
      return named("Fetch", input.prompt ?? input.url);
    case "agent":
      return named("Agent", input.description ?? input.name);
    case "skill":
      return named("Skill", input.skill ?? input.name);
    case "todo_write":
      return clip(`Todo: ${Array.isArray(input.todos) ? input.todos.length : 0} items`);
    default:
      return name;
  }
}

/** Map one `-o stream-json` line to zero or more activity events. The envelope
 *  is Claude Code's, so the reader is too — only the tool names differ. */
export function deriveQwenActivity(line: string, at: string): ActivityEvent[] {
  return deriveStreamJsonActivity(line, at, summarizeQwenTool);
}

/**
 * Model aliases worth offering.
 *
 * The model a Qwen Code install can actually reach is whichever one its
 * configured endpoint serves — for a local `llama-server`, exactly the one it
 * was started with. `OPENAI_MODEL` is where that name already lives on such a
 * machine, so it leads the list; the built-in aliases follow for installs
 * pointed at Qwen's own API, and `ARGUS_QWEN_MODELS` adds the rest.
 */
function models(): string[] {
  const configured = process.env.OPENAI_MODEL ?? "";
  const extras = (process.env.ARGUS_QWEN_MODELS ?? "").split(",");
  return [...new Set([configured, ...DEFAULT_QWEN_MODELS, ...extras].map((s) => s.trim()))].filter(
    Boolean,
  );
}

export const qwenRuntime: AgentRuntime = {
  id: "qwen",
  label: "Qwen Code",
  bin,
  versionArgs: ["--version"],
  home: qwenHome,
  models,
  // Qwen Code has no per-run reasoning flag; effort is a property of the model
  // the endpoint serves.
  reasoningEfforts: () => [],
  capabilities: {
    presetSessionId: false,
    appendSystemPrompt: false,
    reportsCost: false,
    reportsTokens: true,
    signalHook: true,
    liveActivity: true,
    transcripts: true,
  },
  // Whatever the endpoint serves; a local install has exactly one model loaded
  // and naming a second one would only produce a run that cannot start.
  defaultAnalysisModel: () => "",
  // The Stop hook is authoritative, as it is for Claude Code.
  outcomeFromRecord: false,

  batchPlan({ prompt, model, systemPrompt }: RunPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: qwenArgs({ outputFormat: "json", approvalMode: "yolo", model }),
      stdin: composePrompt(prompt, systemPrompt),
      env: runEnv(),
    };
  },

  streamPlan({ prompt, model, systemPrompt }: RunPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: qwenArgs({ outputFormat: "stream-json", approvalMode: "yolo", model }),
      stdin: composePrompt(prompt, systemPrompt),
      env: runEnv(),
    };
  },

  /** Analysis passes read text that is already in the prompt and answer with
   *  JSON; they have no business writing to the disk, so they run under the
   *  default approval mode, which withholds the shell, write and edit tools. */
  analysisPlan({ prompt, model }: AnalysisPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: qwenArgs({ outputFormat: "json", approvalMode: "default", model }),
      stdin: prompt,
      env: runEnv(),
    };
  },

  parseEnvelope: parseQwenEnvelope,
  deriveActivity: deriveQwenActivity,
};
