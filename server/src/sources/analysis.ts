import { spawn as nodeSpawn } from "node:child_process";
import { defaultRuntimeId, isRuntimeId, runtimeFor } from "../runtimes/index.js";
import { isSpendBlocked, recordRunSpend } from "./budget.js";
import { log } from "../log.js";
import { childTreeStopper } from "../processTree.js";
import type { AgentRuntimeId } from "@argus/contracts";

/**
 * The one place Argus asks a model a question about its own state.
 *
 * Four features need this — Autopsy's postmortem, Verdict's judge, Sentinel's
 * diagnostic, Omnibar's planner — and each of them is a way to accidentally
 * spend unbounded money, run unbounded time, or hand a model something it can
 * act on. Rather than four spawn sites with four sets of near-correct guards,
 * everything goes through here and inherits the same ones:
 *
 * **Bounded time.** A hard timeout kills the process tree, not just the pid —
 * an agent CLI spawns children, and killing only the parent leaves them running
 * and holding its stdout. A tree that ignores the request is escalated, and
 * the pass settles even if a descendant never lets go (`../processTree.ts`).
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
export type AnalysisKind =
  "autopsy" | "verdict" | "trajectory" | "diagnose" | "plan" | "tune" | "decide";

export interface AnalysisRequest {
  kind: AnalysisKind;
  /** The full prompt. Delivered on stdin. */
  prompt: string;
  /** Working directory for the CLI. Should be a directory that exists. */
  cwd: string;
  /** Model alias/id. Defaults to the configured analysis model. */
  model?: string;
  /** Which CLI answers. Defaults to `ARGUS_ANALYSIS_RUNTIME`, else the server default. */
  runtime?: AgentRuntimeId;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type AnalysisFailure =
  | "dispatch-refused"
  | "disabled"
  | "budget-blocked"
  | "busy"
  | "timeout"
  | "output-cap"
  | "spawn-failed"
  | "nonzero-exit"
  | "exit-code-unavailable"
  | "runtime-failed"
  | "no-output"
  | "unparseable";

export interface AnalysisResult<T> {
  executionDisposition?: "not-called" | "possibly-called";
  ok: boolean;
  value: T | null;
  /** The model's raw text result, for display when parsing failed. */
  raw: string;
  costUsd: number | null;
  tokens: number | null;
  durationMs: number;
  failure: AnalysisFailure | null;
  error: string | null;
  /** The CLI this pass ran (or would have run) on. */
  runtime: AgentRuntimeId;
  /** The model argument handed to that CLI; null = none (the CLI's own default). */
  requestedModel: string | null;
  /**
   * The model the CLI's result envelope reported. No runtime parser extracts
   * one today, so this is null — "not reported" — and is never back-filled
   * from `requestedModel`.
   */
  reportedModel: string | null;
}

export interface AnalysisSpawnHandle {
  /** Kills the pass, including any children. `done` must still settle afterwards. */
  kill: () => void;
  done: Promise<{ code: number | null; stdout: string; error: string | null }>;
}

export type AnalysisSpawn = (opts: {
  prompt: string;
  cwd: string;
  model: string;
  runtime: AgentRuntimeId;
  maxOutputBytes: number;
}) => AnalysisSpawnHandle;

/**
 * The default analysis model.
 *
 * A postmortem, a rubric score and an intent plan are all short, structured,
 * low-stakes reads over text that is already in the prompt. Spending the
 * flagship model's price on them is how a helpful background feature turns into
 * a line item, so the cheap fast model is the default and every caller can
 * override it. Kept exported at its historical name and value: it is the Claude
 * Code default, and the runtime supplies its own when the pass runs elsewhere.
 */
export const DEFAULT_ANALYSIS_MODEL = "haiku";

/**
 * Which CLI answers the analysis passes.
 *
 * Separate from `ARGUS_AGENT` on purpose: these are short, cheap, read-only
 * questions Argus asks about its own state, and an operator may well want them
 * answered by a different (cheaper, or simply already-authenticated) CLI than
 * the one doing the real work.
 */
export function analysisRuntime(): AgentRuntimeId {
  const raw = process.env.ARGUS_ANALYSIS_RUNTIME?.trim().toLowerCase();
  return isRuntimeId(raw) ? raw : defaultRuntimeId();
}

/** The analysis model for a runtime: the explicit override, else that runtime's
 *  own default (empty string = let the CLI decide). */
export function analysisModel(runtime?: AgentRuntimeId): string {
  const override = process.env.ARGUS_ANALYSIS_MODEL?.trim();
  if (override) return override;
  return runtimeFor(runtime ?? analysisRuntime()).defaultAnalysisModel();
}

/** Analysis passes are opt-out: `ARGUS_ANALYSIS=off` disables every one. */
export function analysisEnabled(): boolean {
  return (process.env.ARGUS_ANALYSIS ?? "").trim().toLowerCase() !== "off";
}

/** `done`'s error when stdout passed `maxOutputBytes` and the pass was killed. */
export const OUTPUT_CAP_ERROR = "output cap exceeded";
/** Appended when the killed tree still held its pipes after the whole ladder:
 *  released, but not confirmed to have exited. */
export const NOT_EXITED_ERROR = "the process did not exit after it was killed";

/** What {@link spawnAnalysisProcess} runs: a runtime's analysis plan, minus the parts it does not use. */
export interface AnalysisProcessPlan {
  bin: string;
  args: string[];
  stdin: string;
  env: Record<string, string>;
}

/**
 * Spawn one bounded analysis process: stdin written and closed, stdout
 * captured under `maxOutputBytes`, stderr drained. `kill()` ends the whole
 * tree (see `../processTree.ts`) and `done` always settles after it — on
 * `close` once the tree has let go of the pipes, or, if a descendant out of
 * reach still holds them after the escalation ladder, with the pipes released
 * and an error saying the process did not exit. Normal completion still waits
 * for `close`, so every byte the process wrote is read.
 */
export function spawnAnalysisProcess(
  plan: AnalysisProcessPlan,
  opts: { cwd: string; maxOutputBytes: number; killGraceMs?: number },
): AnalysisSpawnHandle {
  const child = nodeSpawn(plan.bin, plan.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...plan.env },
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
  });

  child.stdin?.on("error", () => {
    /* the process failed to spawn; the close handler reports it */
  });
  child.stdin?.write(plan.stdin);
  child.stdin?.end();

  let stdout = "";
  let overflowed = false;
  child.stdout?.on("data", (d: Buffer) => {
    if (overflowed) return;
    stdout += d.toString("utf8");
    if (stdout.length > opts.maxOutputBytes) {
      overflowed = true;
      kill();
    }
  });
  // stderr is drained but discarded: it is the CLI's progress chatter, and
  // mixing it into stdout would defeat envelope extraction.
  child.stderr?.resume();

  let settle: (res: {
    code: number | null;
    stdout: string;
    error: string | null;
  }) => void = () => {};
  const stopper = childTreeStopper(child, {
    grouped: process.platform !== "win32",
    graceMs: opts.killGraceMs,
    onAbandon: () =>
      settle({
        code: null,
        stdout,
        // The cause stays first (it classifies the failure); the uncertainty
        // about whether the tree exited is never dropped.
        error: overflowed ? `${OUTPUT_CAP_ERROR}; ${NOT_EXITED_ERROR}` : NOT_EXITED_ERROR,
      }),
  });

  function kill(): void {
    stopper.stop();
  }

  const done = new Promise<{ code: number | null; stdout: string; error: string | null }>(
    (resolve) => {
      let settled = false;
      let runningError: string | null = null;
      settle = (res) => {
        if (settled) return;
        settled = true;
        stopper.dispose();
        resolve(res);
      };
      child.on("error", (err) => {
        // A process that is running when the error arrives still has a tree
        // to end; one that never started resolves now.
        if (child.pid != null && child.exitCode === null && child.signalCode === null) {
          runningError = err.message;
          kill();
          return;
        }
        settle({ code: null, stdout, error: err.message });
      });
      child.on("close", (code) => {
        settle({
          code,
          stdout,
          error: overflowed ? OUTPUT_CAP_ERROR : runningError,
        });
      });
    },
  );

  return { kill, done };
}

/**
 * The real spawn. Mirrors `defaultSpawn` in the scheduler — same runtime seam,
 * same stdin discipline, same detached process group so the whole tree can be
 * signalled — but captures stdout in memory under a cap instead of streaming it
 * to a log file, because an analysis pass's output *is* the result.
 */
export const defaultAnalysisSpawn: AnalysisSpawn = ({
  prompt,
  cwd,
  model,
  runtime,
  maxOutputBytes,
}) => {
  const plan = runtimeFor(runtime).analysisPlan({ prompt, model });
  return spawnAnalysisProcess(plan, { cwd, maxOutputBytes });
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
  runWithAdmission?<T>(
    req: AnalysisRequest,
    parse: (value: unknown) => T | null,
    admission: AnalysisDispatchAdmission,
  ): Promise<AnalysisResult<T>>;
  /** How many passes are executing right now. */
  inFlight(): number;
}

export type DispatchValidation = { ok: true } | { ok: false; detail: string };
export type AnalysisDispatchAdmission = () => Promise<
  { ok: false; detail: string } | { ok: true; validateNow: () => DispatchValidation }
>;

export function dispatchValidationDetail(value: unknown): string | null {
  if (value instanceof Promise) {
    void value.catch(() => {});
    return "asynchronous final dispatch validation is unsupported";
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const check = value as Record<string, unknown>;
    if (!("then" in check) && check.ok === true) return null;
    if (check.ok === false && typeof check.detail === "string" && check.detail.trim())
      return check.detail;
  }
  return "malformed dispatch validation";
}

export async function prepareDispatchAdmission(
  admission: AnalysisDispatchAdmission,
): Promise<() => DispatchValidation> {
  const check = await admission();
  if (
    !check ||
    typeof check !== "object" ||
    Array.isArray(check) ||
    check.ok !== true ||
    typeof check.validateNow !== "function"
  ) {
    throw new Error(dispatchValidationDetail(check) ?? "missing final dispatch validation");
  }
  return check.validateNow;
}

function failed<T>(
  failure: AnalysisFailure,
  error: string,
  who: Pick<AnalysisResult<T>, "runtime" | "requestedModel">,
): AnalysisResult<T> {
  return {
    executionDisposition: "not-called",
    ok: false,
    value: null,
    raw: "",
    costUsd: null,
    tokens: null,
    durationMs: 0,
    failure,
    error,
    ...who,
    reportedModel: null,
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
    admission?: AnalysisDispatchAdmission,
  ): Promise<AnalysisResult<T>> {
    // Resolved before anything can refuse, so even a refusal says which CLI and
    // model it would have asked — a stored "skipped" is then still explicable.
    const runtime = req.runtime ?? analysisRuntime();
    const model = req.model ?? analysisModel(runtime);
    const who = { runtime, requestedModel: model || null };
    if (!enabled()) {
      return failed("disabled", "analysis passes are disabled (ARGUS_ANALYSIS=off)", who);
    }
    if (running >= maxConcurrent) {
      return failed("busy", "another analysis pass is already running", who);
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
        return failed<T>("budget-blocked", "the spend budget hard stop is in force", who);
      }

      const spawnOptions = {
        prompt: req.prompt,
        cwd: req.cwd,
        model,
        runtime,
        maxOutputBytes,
      };
      if (admission !== undefined) {
        try {
          const validateNow = await prepareDispatchAdmission(admission);
          const refusal = dispatchValidationDetail(validateNow());
          if (refusal !== null) return failed<T>("dispatch-refused", refusal, who);
        } catch (error) {
          return failed<T>(
            "dispatch-refused",
            error instanceof Error ? error.message : "dispatch admission failed",
            who,
          );
        }
      }
      const handle = spawn(spawnOptions);
      timer = setTimeout(() => {
        timedOut = true;
        handle.kill();
      }, timeoutMs);

      const res = await handle.done;
      const durationMs = now().getTime() - startedAt.getTime();
      const envelope = runtimeFor(runtime).parseEnvelope(res.stdout);

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
        executionDisposition: "possibly-called" as const,
        raw: envelope.result ?? "",
        costUsd: envelope.costUsd,
        tokens: envelope.tokens,
        durationMs,
        ...who,
        reportedModel: null,
      };

      if (timedOut) {
        return {
          ...base,
          ok: false,
          value: null,
          failure: "timeout",
          // A kill that could not be confirmed (the tree still held its pipes
          // after the escalation) is said so, not folded into a clean timeout.
          error: res.error
            ? `timed out after ${timeoutMs}ms; ${res.error}`
            : `timed out after ${timeoutMs}ms`,
        };
      }
      if (res.error) {
        const failure: AnalysisFailure = res.error.startsWith(OUTPUT_CAP_ERROR)
          ? "output-cap"
          : "spawn-failed";
        return { ...base, ok: false, value: null, failure, error: res.error };
      }
      if (res.code !== 0 || envelope.isError === true) {
        return {
          ...base,
          ok: false,
          value: null,
          failure:
            res.code === null
              ? "exit-code-unavailable"
              : res.code !== 0
                ? "nonzero-exit"
                : "runtime-failed",
          error:
            res.code !== 0
              ? res.code === null
                ? "the process ended without an exit code"
                : `the process exited with code ${res.code}`
              : "the runtime reported a failed inference",
        };
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

  return {
    run: (req, parse) => run(req, parse),
    runWithAdmission: (req, parse, admission) => run(req, parse, async () => admission()),
    inFlight: () => running,
  };
}
