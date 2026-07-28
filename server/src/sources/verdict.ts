import path from "node:path";
import { paths } from "../claudeHome.js";
import { createJsonArrayStore } from "./jsonArrayStore.js";
import { median } from "./watchtower.js";
import type { AnalysisRunner } from "./analysis.js";
import type {
  CriterionScore,
  Rubric,
  RubricCriterion,
  Verdict,
  VerdictPoint,
  VerdictReport,
  VerdictTrend,
} from "@argus/contracts";
import type { Run } from "./scheduleTypes.js";

/**
 * Verdict: the judge pass, its rubric validation, and the trend derivation.
 *
 * Exit code 0 means the process ended, not that the work was good. A rubric
 * closes that gap by letting the author say what "good" means for one unit of
 * work; this module scores each output against it.
 *
 * Three deliberate constraints, each of which is the difference between a
 * useful score and a number nobody trusts:
 *
 * **The rubric is authored, never inferred.** A judge asked "was this good?"
 * with no criteria will happily produce a 7 every time. Criteria come from the
 * definition, the prompt names them explicitly, and a score for a criterion
 * that wasn't asked for is dropped.
 *
 * **The overall score is computed here, not by the model.** Asking for a
 * weighted average and trusting it means a judge that scores every criterion
 * 3/10 can still hand back an 8 overall. The weights are the author's; the
 * arithmetic is ours.
 *
 * **A regression is a threshold the author set.** `minScore` is opt-in. With no
 * threshold, Verdict measures and trends and never fails anything — the
 * alternative is a feature that starts opening issues the day it is enabled.
 */

export type {
  CriterionScore,
  Rubric,
  RubricCriterion,
  Verdict,
  VerdictPoint,
  VerdictReport,
  VerdictStatus,
  VerdictTrend,
} from "@argus/contracts";

/** Verdicts retained, mirroring the autopsy store's ceiling. */
export const VERDICT_KEEP = 400;

/** Points kept per trend line. */
export const TREND_POINTS = 30;

/** Output characters quoted into the judge prompt. */
export const OUTPUT_MAX_CHARS = 12_000;
export const PROMPT_MAX_CHARS = 20_000;

export const MAX_CRITERIA = 10;

export class RubricValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RubricValidationError";
  }
}

const store = createJsonArrayStore<Verdict>({
  file: paths.verdictFile,
  label: "verdicts.json",
});

export const readVerdicts = store.read;

export async function readVerdict(runId: string): Promise<Verdict | null> {
  return (await store.read()).find((v) => v.runId === runId) ?? null;
}

export async function writeVerdict(verdict: Verdict): Promise<Verdict> {
  return store.withLock(async () => {
    const list = await store.read();
    const next = [verdict, ...list.filter((v) => v.runId !== verdict.runId)];
    next.sort((a, b) => b.at.localeCompare(a.at));
    await store.write(next.slice(0, VERDICT_KEEP));
    return verdict;
  });
}

// ── Rubric validation ───────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/**
 * Validate an author-supplied rubric. `null`/`undefined` means "no rubric",
 * which is the default and must stay cheap to express.
 */
export function validateRubric(raw: unknown): Rubric | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") throw new RubricValidationError("rubric must be an object");
  const r = raw as Record<string, unknown>;

  if (typeof r.goal !== "string" || !r.goal.trim()) {
    throw new RubricValidationError("rubric.goal is required — say what good means here");
  }
  if (!Array.isArray(r.criteria) || r.criteria.length === 0) {
    throw new RubricValidationError("rubric.criteria must list at least one criterion");
  }
  if (r.criteria.length > MAX_CRITERIA) {
    throw new RubricValidationError(`rubric.criteria is capped at ${MAX_CRITERIA}`);
  }

  const seen = new Set<string>();
  const criteria: RubricCriterion[] = r.criteria.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new RubricValidationError(`criterion ${i + 1} must be an object`);
    }
    const item = c as Record<string, unknown>;
    if (typeof item.id !== "string" || !ID_RE.test(item.id)) {
      throw new RubricValidationError(
        `criterion ${i + 1} needs a lowercase slug id (letters, digits, - and _)`,
      );
    }
    if (seen.has(item.id)) {
      throw new RubricValidationError(`duplicate criterion id "${item.id}"`);
    }
    seen.add(item.id);
    if (typeof item.label !== "string" || !item.label.trim()) {
      throw new RubricValidationError(`criterion "${item.id}" needs a label`);
    }
    const weight = item.weight === undefined ? undefined : Number(item.weight);
    if (weight !== undefined && (!Number.isFinite(weight) || weight <= 0)) {
      throw new RubricValidationError(`criterion "${item.id}" weight must be > 0`);
    }
    return {
      id: item.id,
      label: item.label.trim().slice(0, 200),
      ...(weight === undefined ? {} : { weight }),
    };
  });

  let minScore: number | undefined;
  if (r.minScore !== undefined && r.minScore !== null) {
    const n = Number(r.minScore);
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      throw new RubricValidationError("rubric.minScore must be between 0 and 10");
    }
    minScore = n;
  }

  return {
    goal: r.goal.trim().slice(0, 2000),
    criteria,
    ...(minScore === undefined ? {} : { minScore }),
  };
}

/** `autoApprove` on a gated phase. Requires a rubric to clear. */
export function validateAutoApprove(raw: unknown, hasRubric: boolean) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") throw new RubricValidationError("autoApprove must be an object");
  const n = Number((raw as Record<string, unknown>).verdict);
  if (!Number.isFinite(n) || n < 0 || n > 10) {
    throw new RubricValidationError("autoApprove.verdict must be between 0 and 10");
  }
  if (!hasRubric) {
    throw new RubricValidationError(
      "autoApprove needs a rubric on the same phase to score against",
    );
  }
  return { verdict: n };
}

// ── The judge prompt ────────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The judge prompt.
 *
 * Criteria are enumerated with their exact ids, and the model is told to return
 * one entry per id and nothing else. That is what makes the answer joinable
 * back to the author's rubric rather than a free-form list that has to be
 * fuzzy-matched — and it is why renaming a label keeps the history.
 */
export function buildVerdictPrompt(run: Run, rubric: Rubric): string {
  const output = clip(
    run.resultSummary ?? "(the run produced no result summary)",
    OUTPUT_MAX_CHARS,
  );
  const criteria = rubric.criteria
    .map((c) => `  - id "${c.id}": ${c.label}${c.weight != null ? ` (weight ${c.weight})` : ""}`)
    .join("\n");

  const body = `You are scoring the output of one automated agent run against a rubric. Answer only with JSON.

WHAT GOOD LOOKS LIKE
${clip(rubric.goal, 2000)}

CRITERIA
${criteria}

THE TASK THE AGENT WAS GIVEN
${clip(run.prompt, 3000)}

THE OUTPUT IT PRODUCED
${output}

Answer with a single JSON object and nothing else:
{
  "criteria": [
    { "id": "<one of the ids above, verbatim>", "score": 0-10, "note": "one sentence" }
  ],
  "summary": "one sentence on the output as a whole"
}

Rules: return exactly one entry per criterion id listed above, using the ids
verbatim. Score 0-10 where 10 fully meets the criterion. Do not return an
overall score — it is computed from your per-criterion scores and the author's
weights. Judge only the output shown; do not speculate about work not visible
here.`;

  return body.length > PROMPT_MAX_CHARS ? `${body.slice(0, PROMPT_MAX_CHARS - 1)}…` : body;
}

// ── Response validation and scoring ─────────────────────────────────────────

/**
 * The weighted overall score.
 *
 * Computed here rather than asked for, because a judge that scores every
 * criterion 3/10 will still cheerfully hand back an 8 overall when asked. The
 * weights are the author's; the arithmetic is ours.
 */
export function weightedScore(rubric: Rubric, scores: CriterionScore[]): number | null {
  const byId = new Map(scores.map((s) => [s.id, s.score]));
  let total = 0;
  let weight = 0;
  for (const c of rubric.criteria) {
    const score = byId.get(c.id);
    if (score === undefined) continue;
    const w = c.weight ?? 1;
    total += score * w;
    weight += w;
  }
  if (weight === 0) return null;
  return Math.round((total / weight) * 10) / 10;
}

/**
 * Turn the judge's JSON into per-criterion scores, or null when it isn't one.
 *
 * Scores for criteria the rubric never mentioned are dropped: a judge that
 * invents a criterion is not evidence about the author's rubric. A response
 * that scores *none* of the real criteria is a failure, not a zero.
 */
export function parseVerdictResponse(
  value: unknown,
  rubric: Rubric,
): { criteria: CriterionScore[]; summary: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.criteria)) return null;

  const labels = new Map(rubric.criteria.map((c) => [c.id, c.label]));
  const seen = new Set<string>();
  const criteria: CriterionScore[] = [];
  for (const raw of v.criteria) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id : "";
    const label = labels.get(id);
    if (label === undefined || seen.has(id)) continue;
    const score = Number(c.score);
    if (!Number.isFinite(score)) continue;
    seen.add(id);
    criteria.push({
      id,
      label,
      score: Math.min(10, Math.max(0, Math.round(score * 10) / 10)),
      note: typeof c.note === "string" ? c.note.trim().slice(0, 400) : "",
    });
  }
  if (criteria.length === 0) return null;

  const summary =
    typeof v.summary === "string" && v.summary.trim() ? v.summary.trim().slice(0, 600) : null;
  return { criteria, summary };
}

// ── The pass ────────────────────────────────────────────────────────────────

export interface VerdictDeps {
  runner: AnalysisRunner;
  now: () => Date;
}

/** The unit of work a verdict belongs to. Shares Watchtower's key space so the
 *  two features line up on the same cards. */
export function verdictKey(run: Run): { key: string; scope: "schedule" | "phase"; name: string } {
  if (run.phaseId) {
    return {
      key: `phase:${run.scheduleId}:${run.phaseId}`,
      scope: "phase",
      name: `${run.scheduleName} › ${run.phaseId}`,
    };
  }
  return { key: `schedule:${run.scheduleId}`, scope: "schedule", name: run.scheduleName };
}

/**
 * Score one run against a rubric and persist the result.
 *
 * As with Autopsy, a pass that fails is *still stored* — otherwise the watcher
 * retries the same doomed run every tick and the operator never learns that
 * judging is switched off.
 */
export async function performVerdict(
  run: Run,
  rubric: Rubric,
  deps: VerdictDeps,
): Promise<Verdict> {
  const base: Verdict = {
    runId: run.id,
    scheduleId: run.scheduleId,
    scheduleName: run.scheduleName,
    phaseId: run.phaseId ?? null,
    status: "failed",
    at: deps.now().toISOString(),
    score: null,
    criteria: [],
    summary: null,
    regression: false,
    minScore: rubric.minScore ?? null,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
  };

  const result = await deps.runner.run(
    {
      kind: "verdict",
      prompt: buildVerdictPrompt(run, rubric),
      cwd: run.cwd || path.dirname(paths.verdictFile()),
    },
    (value) => parseVerdictResponse(value, rubric),
  );

  const metered = {
    ...base,
    costUsd: result.costUsd,
    tokens: result.tokens,
    durationMs: result.durationMs,
  };

  if (!result.ok || !result.value) {
    return writeVerdict({
      ...metered,
      status: result.failure === "disabled" ? "skipped" : "failed",
      error: result.error ?? "the judge pass produced nothing",
    });
  }

  const score = weightedScore(rubric, result.value.criteria);
  return writeVerdict({
    ...metered,
    status: "ready",
    score,
    criteria: result.value.criteria,
    summary: result.value.summary,
    regression: score !== null && rubric.minScore != null && score < rubric.minScore,
    error: null,
  });
}

// ── Trends ──────────────────────────────────────────────────────────────────

/**
 * Score history per unit of work.
 *
 * `delta` compares the latest score against the median of everything *before*
 * it, not against the previous run: one noisy judgement should not read as a
 * collapse, and one good run after a bad week should not read as a recovery.
 */
export function buildVerdictTrends(
  verdicts: Verdict[],
  minScores: Map<string, number | null>,
  now: Date,
): VerdictReport {
  const groups = new Map<string, { scope: "schedule" | "phase"; name: string; list: Verdict[] }>();
  for (const v of verdicts) {
    if (v.status !== "ready" || v.score === null) continue;
    const key = v.phaseId ? `phase:${v.scheduleId}:${v.phaseId}` : `schedule:${v.scheduleId}`;
    const name = v.phaseId ? `${v.scheduleName} › ${v.phaseId}` : v.scheduleName;
    const group = groups.get(key);
    if (group) group.list.push(v);
    else groups.set(key, { scope: v.phaseId ? "phase" : "schedule", name, list: [v] });
  }

  const trends: VerdictTrend[] = [];
  for (const [key, group] of groups) {
    const ordered = [...group.list].sort((a, b) => a.at.localeCompare(b.at)).slice(-TREND_POINTS);
    const points: VerdictPoint[] = ordered.map((v) => ({
      runId: v.runId,
      at: v.at,
      score: v.score as number,
      regression: v.regression,
    }));
    const scores = points.map((p) => p.score);
    const latest = scores.length > 0 ? scores[scores.length - 1] : null;
    const priors = scores.slice(0, -1);
    trends.push({
      key,
      scope: group.scope,
      name: group.name,
      points,
      latest,
      median: scores.length > 0 ? median(scores) : null,
      delta:
        latest !== null && priors.length > 0
          ? Math.round((latest - median(priors)) * 10) / 10
          : null,
      minScore: minScores.get(key) ?? null,
      regressions: points.filter((p) => p.regression).length,
    });
  }

  trends.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const latests = trends.map((t) => t.latest).filter((s): s is number => s !== null);
  return {
    generatedAt: now.toISOString(),
    trends,
    summary: {
      scored: trends.reduce((n, t) => n + t.points.length, 0),
      regressions: trends.reduce((n, t) => n + t.regressions, 0),
      average:
        latests.length > 0
          ? Math.round((latests.reduce((a, b) => a + b, 0) / latests.length) * 10) / 10
          : null,
    },
  };
}

/**
 * Runs whose verdict fell below the author's bar, as issue-shaped failures.
 *
 * A quality regression is a failure of the work even though the process
 * succeeded, so it belongs in the same triage surface as a crash rather than in
 * a parallel list nobody checks. The message is deliberately shaped so that
 * repeated regressions of the same unit of work fingerprint together.
 */
export function failingVerdicts(verdicts: Verdict[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of verdicts) {
    if (v.status !== "ready" || !v.regression || v.score === null) continue;
    out.set(
      v.runId,
      `quality below the bar for ${v.scheduleName}${v.phaseId ? ` › ${v.phaseId}` : ""}: ` +
        `scored ${v.score.toFixed(1)}/10 against a minimum of ${(v.minScore ?? 0).toFixed(1)}`,
    );
  }
  return out;
}
