import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseRunEnvelope } from "../scheduler.js";
import { isSpendBlocked, recordRunSpend } from "./budget.js";
import { log } from "../log.js";

/**
 * The one place Argus asks a model a question about its own state.
 *
 * Four features need this — Autopsy's postmortem, Verdict's judge, Sentinel's
 * diagnostic, Omnibar's planner — and each of them is a way to accidentally
 * spend unbounded money, run unbounded time, or hand a model something it can
 * act on. Rather than four spawn sites with four sets of near-correct guards,
 * everything goes through here and inherits the same ones:
 *
 * **Bounded time.** A hard timeout kills the process group, not just the pid —
 * `claude` spawns children, and killing only the parent leaves them running.
 *
 * **Bounded output.** stdout is capped; past the cap the process is killed
 * rather than allowed to fill memory with a runaway response.
 *
 * **Bounded concurrency.** One analysis pass at a time by default. These are
 * background niceties; they must never compete with the user's actual work for
 * CPU or rate limit.
 *
 * **Bounded spend.** Every pass is metered into the same ledger real runs use,
 * and a pass refuses to start while the budget hard stop is in force. Argus
 * explaining why you are over budget must not be a reason you are over budget.
 *
 * **No tools, by construction of the prompt.** These passes ask for a JSON
 * verdict about text that is supplied inline. The prompt goes in on stdin, never
 * argv, so nothing in it is parsed by a shell.
 *
 * Everything is injectable: `spawn` is a parameter, so the tests exercise the
 * timeout, the output cap, the parse failure and the budget refusal without a
 * CLI on the box.
 */

export const DEFAULT_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

/** What a pass is for. Appears in logs; keeps the ledger explicable. */
export type AnalysisKind = "autopsy" | "verdict" | "diagnose" | "plan";

export interface AnalysisRequest {
  kind: AnalysisKind;
  /** The full prompt. Delivered on stdin. */
  prompt: string;
  /** Working directory for the CLI. Should be a directory that exists. */
  cwd: string;
  /** Model alias/id. Defaults to the configured analysis model. */
  model?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type AnalysisFailure =
  | "disabled"
  | "budget-blocked"
  | "busy"
  | "timeout"
  | "output-cap"
  | "spawn-failed"
  | "no-output"
  | "unparseable";

export interface AnalysisResult<T> {
  ok: boolean;
  value: T | null;
  /** The model's raw text result, for display when parsing failed. */
  raw: string;
  costUsd: number | null;
  tokens: number | null;
  durationMs: number;
  failure: AnalysisFailure | null;
  error: string | null;
}

export interface AnalysisSpawnHandle {
  /** Kills the pass, including any children. */
  kill: () => void;
  done: Promise<{ code: number | null; stdout: string; error: string | null }>;
}

export type AnalysisSpawn = (opts: {
  prompt: string;
  cwd: string;
  model: string;
  maxOutputBytes: number;
}) => AnalysisSpawnHandle;

/**
 * The default analysis model.
 *
 * A postmortem, a rubric score and an intent plan are all short, structured,
 * low-stakes reads over text that is already in the prompt. Spending the
 * flagship model's price on them is how a helpful background feature turns into
 * a line item, so the cheap fast model is the default and every caller can
 * override it.
 */
export const DEFAULT_ANALYSIS_MODEL = "haiku";

export function analysisModel(): string {
  return process.env.ARGUS_ANALYSIS_MODEL?.trim() || DEFAULT_ANALYSIS_MODEL;
}

/** Analysis passes are opt-out: `ARGUS_ANALYSIS=off` disables every one. */
export function analysisEnabled(): boolean {
  return (process.env.ARGUS_ANALYSIS ?? "").trim().toLowerCase() !== "off";
}

/**
 * The real spawn. Mirrors `defaultSpawn` in the scheduler — same flags, same
 * stdin discipline, same detached process group so the whole tree can be
 * signalled — but captures stdout in memory under a cap instead of streaming it
 * to a log file, because an analysis pass's output *is* the result.
 */
export const defaultAnalysisSpawn: AnalysisSpawn = ({ prompt, cwd, model, maxOutputBytes }) => {
  const child = nodeSpawn(
    "claude",
    ["-p", "--output-format", "json", "--session-id", randomUUID(), "--model", model],
    {
      cwd,
      shell: process.platform === "win32",
      detached: process.platform !== "win32",
    },
  );

  child.stdin?.on("error", () => {
    /* the process failed to spawn; the close handler reports it */
  });
  child.stdin?.write(prompt);
  child.stdin?.end();

  let stdout = "";
  let overflowed = false;
  child.stdout?.on("data", (d: Buffer) => {
    if (overflowed) return;
    stdout += d.toString("utf8");
    if (stdout.length > maxOutputBytes) {
      overflowed = true;
      kill();
    }
  });
  // stderr is drained but discarded: it is the CLI's progress chatter, and
  // mixing it into stdout would defeat envelope extraction.
  child.stderr?.resume();

  function kill(): void {
    if (child.pid == null) return;
    try {
      if (process.platform === "win32") child.kill();
      else process.kill(-child.pid);
    } catch {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  const done = new Promise<{ code: number | null; stdout: string; error: string | null }>(
    (resolve) => {
      let settled = false;
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        resolve({ code: null, stdout, error: err.message });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        resolve({
          code,
          stdout,
          error: overflowed ? "output cap exceeded" : null,
        });
      });
    },
  );

  return { kill, done };
};

export interface AnalysisRunnerDeps {
  spawn?: AnalysisSpawn;
  now?: () => Date;
  /** Whether analysis is permitted at all. Defaults to the env switch. */
  enabled?: () => boolean;
  /** Whether the budget hard stop is in force. Defaults to the real check. */
  blocked?: (now: Date) => Promise<boolean>;
  /** Fold this pass's cost into the spend ledger. Defaults to the real ledger. */
  meter?: (costUsd: number | null, tokens: number | null, at: Date) => Promise<void>;
  /** Passes allowed to run at once. Defaults to 1. */
  maxConcurrent?: number;
}

export interface AnalysisRunner {
  /**
   * Run one pass and parse its result. `parse` returns null for a well-formed
   * JSON object that isn't the shape asked for, so a model that answers
   * confidently in the wrong schema is a clean `unparseable`, not a crash.
   */
  run<T>(req: AnalysisRequest, parse: (value: unknown) => T | null): Promise<AnalysisResult<T>>;
  /** How many passes are executing right now. */
  inFlight(): number;
}

function failed<T>(failure: AnalysisFailure, error: string, durationMs = 0): AnalysisResult<T> {
  return {
    ok: false,
    value: null,
    raw: "",
    costUsd: null,
    tokens: null,
    durationMs,
    failure,
    error,
  };
}

/**
 * Pull the first balanced JSON object out of a model's answer.
 *
 * Models wrap JSON in prose and fences no matter how firmly the prompt asks
 * them not to, and "the whole string must parse" turns a perfectly good answer
 * into a failure. Scanning for the first balanced `{…}` — string-aware, so a
 * brace inside a value doesn't end it early — recovers those without accepting
 * garbage: the extracted span still has to parse.
 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function createAnalysisRunner(deps: AnalysisRunnerDeps = {}): AnalysisRunner {
  const spawn = deps.spawn ?? defaultAnalysisSpawn;
  const now = deps.now ?? (() => new Date());
  const enabled = deps.enabled ?? analysisEnabled;
  const blocked = deps.blocked ?? isSpendBlocked;
  const meter =
    deps.meter ??
    ((costUsd, tokens, at) =>
      recordRunSpend({ endedAt: at.toISOString(), queuedAt: at.toISOString(), costUsd, tokens }));
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? 1);

  let running = 0;

  async function run<T>(
    req: AnalysisRequest,
    parse: (value: unknown) => T | null,
  ): Promise<AnalysisResult<T>> {
    if (!enabled()) {
      return failed("disabled", "analysis passes are disabled (ARGUS_ANALYSIS=off)");
    }
    if (running >= maxConcurrent) {
      return failed("busy", "another analysis pass is already running");
    }
    // Claimed here, synchronously, before the first `await`. Incrementing after
    // the budget read let two callers both observe `running === 0` and both
    // spawn — the gate has to be taken in the same tick it is tested in.
    running++;

    const timeoutMs = Math.max(1000, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxOutputBytes = Math.max(1024, req.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    try {
      const startedAt = now();
      if (await blocked(startedAt)) {
        // After the concurrency gate and before the spawn, so a blocked budget
        // costs a ledger read rather than a process.
        return failed<T>("budget-blocked", "the spend budget hard stop is in force");
      }

      const handle = spawn({
        prompt: req.prompt,
        cwd: req.cwd,
        model: req.model ?? analysisModel(),
        maxOutputBytes,
      });
      timer = setTimeout(() => {
        timedOut = true;
        handle.kill();
      }, timeoutMs);

      const res = await handle.done;
      const durationMs = now().getTime() - startedAt.getTime();
      const envelope = parseRunEnvelope(res.stdout);

      // Meter first, unconditionally: a pass that timed out or answered
      // nonsense still cost money, and a ledger that only counts successes
      // understates spend exactly when spend is going wrong.
      if (envelope.costUsd != null || envelope.tokens != null) {
        try {
          await meter(envelope.costUsd, envelope.tokens, now());
        } catch (e) {
          log.error("analysis spend metering failed", { kind: req.kind, err: e });
        }
      }

      const base = {
        raw: envelope.result ?? "",
        costUsd: envelope.costUsd,
        tokens: envelope.tokens,
        durationMs,
      };

      if (timedOut) {
        return {
          ...base,
          ok: false,
          value: null,
          failure: "timeout",
          error: `timed out after ${timeoutMs}ms`,
        };
      }
      if (res.error) {
        const failure: AnalysisFailure =
          res.error === "output cap exceeded" ? "output-cap" : "spawn-failed";
        return { ...base, ok: false, value: null, failure, error: res.error };
      }
      if (!envelope.result?.trim()) {
        return {
          ...base,
          ok: false,
          value: null,
          failure: "no-output",
          error: "the pass produced no result",
        };
      }

      const parsed = extractJsonObject(envelope.result);
      if (parsed === undefined) {
        return {
          ...base,
          ok: false,
          value: null,
          failure: "unparseable",
          error: "the pass did not answer with JSON",
        };
      }
      const value = parse(parsed);
      if (value === null) {
        return {
          ...base,
          ok: false,
          value: null,
          failure: "unparseable",
          error: "the pass answered with JSON in the wrong shape",
        };
      }
      return { ...base, ok: true, value, failure: null, error: null };
    } finally {
      if (timer) clearTimeout(timer);
      running--;
    }
  }

  return { run, inFlight: () => running };
}
