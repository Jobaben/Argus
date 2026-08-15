/**
 * OpenCode (`opencode run`) — the third runtime.
 *
 * The mapping to Claude Code, feature for feature:
 *
 * | Argus needs                | Claude Code                        | OpenCode                                 |
 * | -------------------------- | ---------------------------------- | ---------------------------------------- |
 * | headless run               | `claude -p`                        | `opencode run`                           |
 * | prompt off argv            | stdin                              | stdin (the `[message..]` positional is   |
 * |                            |                                    | optional and stdin wins when it's empty) |
 * | one parseable result       | `--output-format json`             | `--format json` (an NDJSON event stream) |
 * | live transcript to tail    | `--output-format stream-json`      | the same `--format json` stream          |
 * | model override             | `--model opus`                     | `--model <provider>/<model>`             |
 * | reasoning override         | CLI/model default                  | `--variant` (provider-specific)          |
 * | unattended tool approval   | CLI default                        | `--auto`                                 |
 * | outcome signal             | `Stop` hook in `settings.json`     | *(none — see below)*                     |
 * | Argus-owned instructions   | `--append-system-prompt`           | prepended to the prompt                  |
 * | transcripts on disk        | `projects/<proj>/<id>.jsonl`       | a private SQLite database                |
 *
 * Three differences survive the mapping and are declared as capabilities rather
 * than papered over:
 *
 *   * **No command hook.** OpenCode's extension surface is JavaScript plugins,
 *     not the `command` hooks Claude Code and Codex expose, so there is nothing
 *     for Argus to register and no signal arrives when a phase ends. The engine
 *     falls back to the `ARGUS_OUTCOME` marker on the run record — the same
 *     protocol the hook reads, taken from the run's final message instead — so a
 *     pipeline phase still reaches the right conclusion. It reaches it on the
 *     next reconcile tick rather than the instant the process exits.
 *   * **No caller-chosen session id.** `run` mints a `ses_…` id; `--session`
 *     only *resumes* one. Argus reads the id back out of the stream and patches
 *     the run record, as it does for Codex.
 *   * **Transcripts in SQLite.** OpenCode stores sessions in
 *     `opencode.db`, a private schema rather than per-session JSONL. Argus reads
 *     the live event stream instead, and the Sessions view honestly reports that
 *     it has no transcript to show.
 *
 * Cost, by contrast, needs no estimation: `step-finish` parts carry OpenCode's
 * own `cost` figure, which is exactly `0` for the local-model setups this
 * runtime is most often pointed at.
 */

import { opencodeHome } from "../opencodeHome.js";
import { EMPTY_ENVELOPE, basename, clip, extraArgs } from "./types.js";
import type {
  AgentRuntime,
  AnalysisPlanOptions,
  RunEnvelope,
  RunPlanOptions,
  SpawnPlan,
} from "./types.js";
import type { ActivityEvent, ReasoningEffort } from "@argus/contracts";

/**
 * `--variant` is documented as provider-specific, so this is the subset of
 * Argus's vocabulary OpenCode's own help text names. `xhigh` is deliberately
 * absent: OpenCode spells that tier `max`, and silently rewriting an operator's
 * choice into a different word is worse than not offering it.
 */
const OPENCODE_REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high"];

/** The read-only primary agent OpenCode ships. Analysis passes run under it. */
const PLAN_AGENT = "plan";

function bin(): string {
  return process.env.ARGUS_OPENCODE_BIN?.trim() || "opencode";
}

/**
 * Base argv for every `opencode run`.
 *
 * `--format json` is the only output format Argus reads: it is both the result
 * envelope (the last `text` part plus the `step-finish` totals) and the live
 * transcript the tailer follows, so a batch run and a pipeline step differ only
 * in how the log is consumed.
 *
 * `--auto` because these runs are unattended by construction. Without it
 * OpenCode stops at its first permission prompt on a terminal nobody is
 * watching, which presents as a run that hangs until the process is reaped.
 * `--agent plan` overrides it for analysis passes, which have no business
 * writing to the disk at all.
 */
function runArgs(opts: {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  agent?: string;
}): string[] {
  return [
    "run",
    "--format",
    "json",
    ...(opts.agent ? ["--agent", opts.agent] : ["--auto"]),
    ...(opts.model && opts.model.trim() ? ["--model", opts.model.trim()] : []),
    ...(opts.reasoningEffort ? ["--variant", opts.reasoningEffort] : []),
    ...extraArgs(process.env.ARGUS_OPENCODE_ARGS),
    // No positional message: the prompt goes on stdin, so no shell and no argv
    // ever sees user-authored text.
  ];
}

/** OpenCode has no `--append-system-prompt`, so Argus-owned instructions ride
 *  at the top of the prompt. Same text, same effect, one delivery mechanism. */
function composePrompt(prompt: string, systemPrompt?: string): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
}

interface OpenCodePart {
  type?: string;
  text?: string;
  tool?: string;
  reason?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; total?: number };
  state?: { status?: string; title?: string; input?: Record<string, unknown> };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Fold an `opencode run --format json` NDJSON stream into the one envelope
 * shape the run record stores.
 *
 * Deliberately tolerant: the same file also carries stderr (the pipeline engine
 * points both descriptors at one log) and may start mid-line when only the tail
 * was captured, so anything that isn't a parseable event is skipped rather than
 * failing the parse.
 */
export function parseOpencodeEnvelope(stdout: string): RunEnvelope {
  const text = stdout.trim();
  if (!text) return EMPTY_ENVELOPE;

  let result: string | null = null;
  let sessionId: string | null = null;
  let tokens: number | null = null;
  let costUsd: number | null = null;
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
    if (typeof obj.sessionID === "string") sessionId = obj.sessionID;
    const part = asRecord(obj.part) as OpenCodePart | null;

    switch (obj.type) {
      case "text": {
        // Last text part wins: it is the run's answer, and the message the
        // ARGUS_OUTCOME marker rides on.
        if (part && typeof part.text === "string") result = part.text;
        break;
      }
      case "step_finish": {
        if (!part) break;
        const inTok = Number(part.tokens?.input ?? 0);
        const outTok = Number(part.tokens?.output ?? 0);
        const sum = inTok + outTok;
        if (Number.isFinite(sum) && sum > 0) tokens = (tokens ?? 0) + sum;
        const cost = Number(part.cost);
        if (Number.isFinite(cost)) costUsd = round6((costUsd ?? 0) + cost);
        // A step that finished on `stop` is a clean end of turn unless an error
        // event said otherwise.
        if (part.reason === "stop" && isError === null) isError = false;
        break;
      }
      case "error": {
        isError = true;
        const err = asRecord(obj.error);
        const data = err ? asRecord(err.data) : null;
        const message =
          (data && typeof data.message === "string" ? data.message : null) ??
          (err && typeof err.name === "string" ? err.name : null);
        if (message) errorMessage = message;
        break;
      }
      default:
        break;
    }
  }

  return {
    // With no assistant text to report, the failure text is the closest thing
    // to a result — and it is what the run card would otherwise leave blank.
    result: result ?? errorMessage,
    costUsd,
    tokens,
    isError,
    sessionId,
  };
}

/** `Edit: foo.ts` / `Bash: npm test` / the tool's own title for everything
 *  else, which OpenCode already composes for display. */
function toolLabel(part: OpenCodePart): string {
  const name = String(part.tool ?? "tool");
  const input = part.state?.input ?? {};
  const file = input.filePath ?? input.file_path ?? input.path;
  switch (name) {
    case "bash":
      return clip(`Bash: ${String(input.command ?? part.state?.title ?? "")}`);
    case "read":
    case "edit":
    case "write":
      return clip(
        `${name[0].toUpperCase()}${name.slice(1)}: ${typeof file === "string" ? basename(file) : ""}`,
      );
    case "grep":
    case "glob":
      return clip(`${name[0].toUpperCase()}${name.slice(1)}: ${String(input.pattern ?? "")}`);
    case "task":
      return clip(`Task: ${String(input.description ?? part.state?.title ?? "")}`);
    default: {
      const title = part.state?.title;
      return clip(title ? `${name}: ${title}` : name);
    }
  }
}

/**
 * Map one `opencode run --format json` line to zero or more activity events.
 *
 * OpenCode reports a tool once, on completion, with its input and result
 * already attached — there is no started/completed pair to de-duplicate. A
 * `step-finish` is only an end of *run* when it stopped for good rather than to
 * run the tools it just requested, so only `reason: "stop"` reports as finished.
 */
export function deriveOpencodeActivity(line: string, at: string): ActivityEvent[] {
  let obj: Record<string, unknown> | null;
  try {
    obj = asRecord(JSON.parse(line));
  } catch {
    return [];
  }
  if (!obj) return [];

  if (obj.type === "error") {
    const err = asRecord(obj.error);
    const data = err ? asRecord(err.data) : null;
    const message =
      (data && typeof data.message === "string" ? data.message : null) ??
      (err && typeof err.name === "string" ? err.name : "run failed");
    return [{ at, kind: "text", label: clip(`error: ${message}`) }];
  }

  const part = asRecord(obj.part) as OpenCodePart | null;
  if (!part) return [];

  if (obj.type === "tool_use") return [{ at, kind: "tool", label: toolLabel(part) }];
  if (obj.type === "text") {
    return typeof part.text === "string" && part.text.trim()
      ? [{ at, kind: "text", label: clip(part.text) }]
      : [];
  }
  if (obj.type === "step_finish" && part.reason === "stop") {
    return [{ at, kind: "done", label: "finished" }];
  }
  // `step_start`, `reasoning` and anything OpenCode adds later are deliberately
  // silent: a per-step marker would drown the feed in punctuation.
  return [];
}

/**
 * Model aliases worth offering.
 *
 * OpenCode addresses models as `<provider>/<model>` and its catalogue is
 * whatever the local `opencode.json` configures — for the setup this runtime
 * exists to serve, a llama.cpp server behind an openai-compatible provider,
 * that is a name only the operator knows. So nothing is hardcoded: the free-text
 * field carries it, and `ARGUS_OPENCODE_MODELS` pins the ones a machine uses
 * often into the picker.
 */
function models(): string[] {
  const extras = (process.env.ARGUS_OPENCODE_MODELS ?? "").split(",");
  return [...new Set(extras.map((s) => s.trim()))].filter(Boolean);
}

export const opencodeRuntime: AgentRuntime = {
  id: "opencode",
  label: "OpenCode",
  bin,
  versionArgs: ["--version"],
  home: opencodeHome,
  models,
  reasoningEfforts: () => OPENCODE_REASONING_EFFORTS,
  capabilities: {
    presetSessionId: false,
    appendSystemPrompt: false,
    reportsCost: true,
    reportsTokens: true,
    signalHook: false,
    liveActivity: true,
    transcripts: false,
  },
  // The provider/model catalogue is local configuration, so there is no safe
  // cheap default to name: let OpenCode's own configured model decide unless an
  // operator sets ARGUS_ANALYSIS_MODEL.
  defaultAnalysisModel: () => "",
  // No command hook to register, so the ARGUS_OUTCOME marker on the run record
  // is the completion protocol rather than a backstop for one.
  outcomeFromRecord: true,

  batchPlan({ prompt, model, reasoningEffort, systemPrompt }: RunPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: runArgs({ model, reasoningEffort }),
      stdin: composePrompt(prompt, systemPrompt),
      env: {},
    };
  },

  // `--format json` is already a live NDJSON stream, so a step run and a batch
  // run take the same argv; only the consumer of the log differs.
  streamPlan({ prompt, model, reasoningEffort, systemPrompt }: RunPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: runArgs({ model, reasoningEffort }),
      stdin: composePrompt(prompt, systemPrompt),
      env: {},
    };
  },

  /** Analysis passes read text that is already in the prompt and answer with
   *  JSON; they have no business writing to the disk, so they run under the
   *  read-only `plan` agent rather than with blanket auto-approval. */
  analysisPlan({ prompt, model }: AnalysisPlanOptions): SpawnPlan {
    return {
      bin: bin(),
      args: runArgs({ model, agent: PLAN_AGENT }),
      stdin: prompt,
      env: {},
    };
  },

  parseEnvelope: parseOpencodeEnvelope,
  deriveActivity: deriveOpencodeActivity,
};
