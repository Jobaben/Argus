import path from "node:path";
import { paths } from "../claudeHome.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import { buildRecording } from "./recorder.js";
import type { AnalysisRunner } from "./analysis.js";
import type { Autopsy, AutopsySpan, FailureClass } from "@argus/contracts";
import type { Run } from "./scheduleTypes.js";
import type { Recording } from "@argus/contracts";

/**
 * Autopsy: the bounded postmortem pass, and everything around it that has to be
 * pure enough to test.
 *
 * The shape here is deliberate. Prompt construction, response validation and
 * persistence are three separate exported functions, because each is where a
 * different class of bug lives:
 *
 * - **Prompt construction** is where an unbounded transcript quietly becomes a
 *   40-dollar request. It is capped, and the cap is a constant with a test.
 * - **Validation** is where a model's confident nonsense becomes a stored fact.
 *   Nothing reaches disk that isn't in the closed taxonomy, and every field is
 *   re-derived rather than trusted (`span` is clamped into the recording,
 *   `confidence` into 0–1).
 * - **Persistence** is where an unbounded store quietly becomes a memory leak.
 *   It is capped and pruned.
 */

export type { Autopsy, AutopsySpan, AutopsyStatus, FailureClass } from "@argus/contracts";

/** Autopsies retained. Runs are pruned at 50 per bucket; this comfortably
 *  outlives the runs it describes without growing without bound. */
export const AUTOPSY_KEEP = 200;

/** Recorder events quoted into the prompt. Enough to see the shape of the run;
 *  bounded so a 20,000-event transcript can't write a 20,000-line prompt. */
export const PROMPT_EVENT_CAP = 60;

/** Per-event label budget inside the prompt. */
const EVENT_LABEL_MAX = 200;

/** Hard ceiling on the whole prompt. A pass that would exceed it is trimmed,
 *  never sent oversized. */
export const PROMPT_MAX_CHARS = 24_000;

const FAILURE_CLASSES: readonly FailureClass[] = [
  "prompt-ambiguity",
  "missing-context",
  "tool-error",
  "permission-denied",
  "environment",
  "timeout",
  "rate-limit",
  "model-refusal",
  "bad-output-format",
  "infrastructure",
  "other",
];

const CLASS_SET = new Set<string>(FAILURE_CLASSES);

export function isFailureClass(v: unknown): v is FailureClass {
  return typeof v === "string" && CLASS_SET.has(v);
}

const store = createJsonArrayStore<Autopsy>({
  file: paths.autopsyFile,
  label: "autopsies.json",
});

export const readAutopsies = store.read;

/**
 * Failure class per run id, for Issues' similarity clustering.
 *
 * Only `ready` autopsies contribute: a pass that timed out has no diagnosis,
 * and treating its absent class as a signal would merge unrelated errors.
 */
export async function readFailureClasses(): Promise<Map<string, FailureClass>> {
  const out = new Map<string, FailureClass>();
  for (const a of await store.read()) {
    if (a.status === "ready" && a.failureClass) out.set(a.runId, a.failureClass);
  }
  return out;
}

export async function readAutopsy(runId: string): Promise<Autopsy | null> {
  return (await store.read()).find((a) => a.runId === runId) ?? null;
}

/** Upsert, newest-first, pruned to {@link AUTOPSY_KEEP}. */
export async function writeAutopsy(autopsy: Autopsy): Promise<Autopsy> {
  return store.withLock(async () => {
    const list = await store.read();
    const next = [autopsy, ...list.filter((a) => a.runId !== autopsy.runId)];
    next.sort((a, b) => b.at.localeCompare(a.at));
    await store.write(next.slice(0, AUTOPSY_KEEP));
    return autopsy;
  });
}

/** A run worth an autopsy. Mirrors the Issues definition of failure so the two
 *  features never disagree about what counts; cancelled is user intent. */
export function isAutopsyEligible(run: Run): boolean {
  return (
    run.status === "failed" ||
    run.status === "interrupted" ||
    run.outcome === "failed" ||
    run.outcome === "blocked"
  );
}

// ── Prompt ──────────────────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The postmortem prompt.
 *
 * Two properties matter more than the wording. First, everything the model
 * needs is *inline* — it is never asked to go and look, so the pass needs no
 * tools and cannot touch the repository. Second, the transcript is quoted as a
 * timeline with millisecond offsets, because the span we want back is an offset
 * range: asking for line numbers would mean trusting the model to count.
 */
export function buildAutopsyPrompt(run: Run, recording: Recording): string {
  const tail = recording.events.slice(-PROMPT_EVENT_CAP);
  const timeline = tail
    .map((e) => {
      const secs = (e.atMs / 1000).toFixed(1);
      const mark = e.errored || e.kind === "error" ? " [ERROR]" : "";
      const detail = e.detail ? ` — ${clip(e.detail, EVENT_LABEL_MAX)}` : "";
      return `${secs}s ${e.kind}${mark}: ${clip(e.label, EVENT_LABEL_MAX)}${detail}`;
    })
    .join("\n");

  const body = `You are analysing why one automated agent run failed. Answer only with JSON.

RUN
  name: ${clip(run.scheduleName, 200)}
  status: ${run.status}${run.outcome ? ` (outcome: ${run.outcome})` : ""}
  exit code: ${run.exitCode ?? "none"}
  duration: ${run.durationMs != null ? `${Math.round(run.durationMs / 1000)}s` : "unknown"}
  reported error: ${clip(run.error ?? "(none)", 1000)}
  result summary: ${clip(run.resultSummary ?? "(none)", 1000)}

THE PROMPT IT WAS GIVEN
${clip(run.prompt, 4000)}

TIMELINE (offsets are milliseconds/1000 from the run's start${
    recording.truncated ? "; earliest events omitted" : ""
  })
${timeline || "(no transcript events were recorded)"}

Answer with a single JSON object and nothing else:
{
  "failureClass": one of ${FAILURE_CLASSES.map((c) => `"${c}"`).join(" | ")},
  "confidence": a number from 0 to 1,
  "why": "one paragraph, plain prose, explaining what went wrong and why. No bullet points.",
  "span": { "fromSeconds": number, "toSeconds": number, "quote": "the timeline line where it went wrong, verbatim" },
  "promptDelta": "a complete replacement prompt that would likely avoid this failure, or null if the prompt was not the problem",
  "deltaRationale": "one sentence on what the replacement changes, or null"
}

Rules: pick "other" rather than forcing a class that does not fit. Set
"promptDelta" to null when the failure was environmental or infrastructural —
rewriting the prompt would not have helped. Base the span on the timeline
offsets above; do not invent times outside their range.`;

  return body.length > PROMPT_MAX_CHARS ? `${body.slice(0, PROMPT_MAX_CHARS - 1)}…` : body;
}

// ── Validation ──────────────────────────────────────────────────────────────

function asString(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Turn a model's JSON into an autopsy body, or null when it isn't one.
 *
 * Every value is re-derived rather than trusted: the class must be in the
 * closed set, confidence is clamped to 0–1, and the span is clamped into the
 * recording's actual duration so a hallucinated "the failure was at 40 minutes"
 * on a two-minute run cannot send the scrubber off the end of the track.
 */
export function parseAutopsyResponse(
  value: unknown,
  durationMs: number,
): Pick<
  Autopsy,
  "failureClass" | "confidence" | "why" | "span" | "promptDelta" | "deltaRationale"
> | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!isFailureClass(v.failureClass)) return null;
  const why = asString(v.why, 2000);
  if (!why) return null;

  const rawConfidence = typeof v.confidence === "number" ? v.confidence : NaN;
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : null;

  let span: AutopsySpan | null = null;
  const rawSpan = v.span;
  if (rawSpan && typeof rawSpan === "object") {
    const s = rawSpan as Record<string, unknown>;
    const from = Number(s.fromSeconds);
    const to = Number(s.toSeconds);
    const quote = asString(s.quote, 500);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      const ceiling = Math.max(0, durationMs);
      const fromMs = Math.min(ceiling, Math.max(0, Math.round(from * 1000)));
      const toMs = Math.min(ceiling, Math.max(fromMs, Math.round(to * 1000)));
      span = { fromMs, toMs, quote: quote ?? "" };
    }
  }

  return {
    failureClass: v.failureClass,
    confidence,
    why,
    span,
    promptDelta: asString(v.promptDelta, 8000),
    deltaRationale: asString(v.deltaRationale, 500),
  };
}

// ── The pass ────────────────────────────────────────────────────────────────

export interface AutopsyDeps {
  runner: AnalysisRunner;
  now: () => Date;
  /** Transcript lines for the run, so the recorder can be built. */
  readLines: (project: string, sessionId: string) => Promise<unknown[]>;
}

/**
 * Run the postmortem for one failed run and persist the result.
 *
 * A pass that fails is *still stored*, with `status: "failed"` and the reason.
 * That is deliberate: without it the watcher would retry the same doomed run on
 * every tick, and the operator would never learn that autopsies are disabled or
 * that the CLI is missing.
 */
export async function performAutopsy(run: Run, deps: AutopsyDeps): Promise<Autopsy> {
  const at = deps.now().toISOString();
  const lines =
    run.project && run.sessionId ? await deps.readLines(run.project, run.sessionId) : [];
  const recording = buildRecording(run, lines, deps.now());

  const base: Autopsy = {
    runId: run.id,
    scheduleId: run.scheduleId,
    scheduleName: run.scheduleName,
    status: "failed",
    at,
    failureClass: null,
    confidence: null,
    why: null,
    span: null,
    promptDelta: null,
    deltaRationale: null,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
  };

  const result = await deps.runner.run(
    {
      kind: "autopsy",
      prompt: buildAutopsyPrompt(run, recording),
      // The analysis reads nothing from disk, but the CLI still needs a real
      // directory; the run's own cwd may be gone, so fall back to the Argus dir.
      cwd: run.cwd || path.dirname(paths.autopsyFile()),
    },
    (value) => parseAutopsyResponse(value, recording.durationMs),
  );

  const body: Autopsy = {
    ...base,
    costUsd: result.costUsd,
    tokens: result.tokens,
    durationMs: result.durationMs,
  };

  if (!result.ok || !result.value) {
    return writeAutopsy({
      ...body,
      status: result.failure === "disabled" ? "skipped" : "failed",
      error: result.error ?? "the postmortem pass produced nothing",
    });
  }

  return writeAutopsy({ ...body, ...result.value, status: "ready", error: null });
}
