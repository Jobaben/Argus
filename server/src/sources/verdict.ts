import { createHash, randomBytes } from "node:crypto";
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
import type { RubricTrajectory, TrajectorySignalKind, VerdictKind } from "@argus/contracts";
import { TRAJECTORY_SIGNAL_KINDS } from "./trajectory.js";

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
  VerdictKind,
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

/**
 * Version of {@link buildVerdictPrompt} + {@link parseVerdictResponse}. Bump on
 * any change to either: a score is only comparable with scores produced by the
 * same question, and the version is stamped on every verdict so a trend or an
 * approval can tell them apart.
 */
export const VERDICT_PROMPT_VERSION = 1;

const store = createJsonArrayStore<Verdict>({
  file: paths.verdictFile,
  label: "verdicts.json",
});

/**
 * Every stored judgment of either kind, newest first — a run judged twice
 * appears twice. Consumers that mean one kind filter with {@link verdictKind}
 * or read through {@link currentVerdicts}.
 */
export const readVerdicts = store.read;

/** Which record a stored judgment is. Absent = `output`: every verdict written
 *  before trajectories existed is an output verdict. */
export function verdictKind(v: Pick<Verdict, "kind">): VerdictKind {
  return v.kind === "trajectory" ? "trajectory" : "output";
}

/**
 * The current verdict of one kind per run: the newest judgment of each,
 * whatever its status. Re-judging appends rather than replacing (an earlier
 * judgment may be what explains an earlier approval), so every consumer that
 * means "the verdict for this run" reads through here rather than assuming one
 * per run. `kind` defaults to `output`, so a trajectory judgment is never any
 * existing consumer's "verdict for this run".
 */
export function currentVerdicts(list: Verdict[], kind: VerdictKind = "output"): Verdict[] {
  const newestFirst = list
    .filter((v) => verdictKind(v) === kind)
    .sort((a, b) => b.at.localeCompare(a.at));
  const seen = new Set<string>();
  return newestFirst.filter((v) => {
    if (seen.has(v.runId)) return false;
    seen.add(v.runId);
    return true;
  });
}

/** The current output verdicts (the default), or the current trajectory ones. */
export async function readCurrentVerdicts(kind: VerdictKind = "output"): Promise<Verdict[]> {
  return currentVerdicts(await store.read(), kind);
}

/**
 * Run `fn` with the current verdicts while holding the verdict store's lock —
 * the same lock {@link writeVerdict} takes. Nothing can be written to the
 * store until `fn` settles, so whatever `fn` makes durable is ordered against
 * every verdict write: a write that lands first is in `current`; one that
 * lands later happens after `fn`'s commit. `fn` must not write a verdict
 * (the lock is not re-entrant) and should be short: it blocks judging.
 */
export async function withCurrentVerdicts<T>(
  fn: (current: Verdict[], trajectory: Verdict[]) => Promise<T>,
): Promise<T> {
  return store.withLock(async () => {
    const list = await store.read();
    return fn(currentVerdicts(list), currentVerdicts(list, "trajectory"));
  });
}

export async function readVerdict(
  runId: string,
  kind: VerdictKind = "output",
): Promise<Verdict | null> {
  return currentVerdicts(await store.read(), kind).find((v) => v.runId === runId) ?? null;
}

/**
 * Append one judgment. Never replaces an earlier judgment of the same run.
 * Newest first, stable on equal timestamps (the new record leads), capped at
 * {@link VERDICT_KEEP} in total — output and trajectory judgments together, so
 * declaring a trajectory does not raise how much is retained. An approval that
 * rested on a verdict copies it into the gate decision record, so the cap
 * cannot erase that explanation; a pruned judgment is simply absent, which
 * holds a gate rather than opening one.
 */
export async function writeVerdict(verdict: Verdict): Promise<Verdict> {
  return store.withLock(async () => {
    const list = await store.read();
    const next = [verdict, ...list];
    next.sort((a, b) => b.at.localeCompare(a.at));
    await store.write(next.slice(0, VERDICT_KEEP));
    return verdict;
  });
}

/**
 * sha256 over exactly what the judge is shown of the rubric: goal and the
 * criteria (id, label, weight), in order. `minScore` is excluded — it is a
 * policy threshold applied afterwards, not part of the question.
 */
export function rubricDigest(rubric: Rubric): string {
  const canonical = JSON.stringify({
    goal: rubric.goal,
    criteria: rubric.criteria.map((c) => ({ id: c.id, label: c.label, weight: c.weight ?? 1 })),
  });
  return createHash("sha256").update(canonical).digest("hex");
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
  const criteria = validateCriteria(r.criteria, "rubric.criteria", "criterion");
  const minScore = validateMinScore(r.minScore, "rubric.minScore");
  const trajectory = validateTrajectory(r.trajectory);

  return {
    goal: r.goal.trim().slice(0, 2000),
    criteria,
    ...(minScore === undefined ? {} : { minScore }),
    ...(trajectory === undefined ? {} : { trajectory }),
  };
}

function validateMinScore(raw: unknown, field: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10) {
    throw new RubricValidationError(`${field} must be between 0 and 10`);
  }
  return n;
}

/**
 * `rubric.trajectory`. Absent = no trajectory analysis of any kind. When
 * present it must ask for something: criteria for a judge, a check over the
 * deterministic signals, or both.
 */
function validateTrajectory(raw: unknown): RubricTrajectory | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new RubricValidationError("rubric.trajectory must be an object");
  }
  const t = raw as Record<string, unknown>;
  const criteria =
    t.criteria === undefined || t.criteria === null
      ? undefined
      : validateCriteria(t.criteria, "rubric.trajectory.criteria", "trajectory criterion");
  const minScore = validateMinScore(t.minScore, "rubric.trajectory.minScore");
  if (minScore !== undefined && !criteria) {
    throw new RubricValidationError(
      "rubric.trajectory.minScore needs trajectory criteria to score",
    );
  }
  let holdOn: TrajectorySignalKind[] | undefined;
  if (t.check !== undefined && t.check !== null) {
    const c = t.check as Record<string, unknown>;
    if (typeof c !== "object" || !Array.isArray(c.holdOn) || c.holdOn.length === 0) {
      throw new RubricValidationError(
        "rubric.trajectory.check.holdOn must list at least one signal",
      );
    }
    const known = new Set<string>(TRAJECTORY_SIGNAL_KINDS);
    const seen = new Set<string>();
    for (const k of c.holdOn) {
      if (typeof k !== "string" || !known.has(k)) {
        throw new RubricValidationError(
          `rubric.trajectory.check.holdOn: unknown signal ${JSON.stringify(k)} ` +
            `(one of ${TRAJECTORY_SIGNAL_KINDS.join(", ")})`,
        );
      }
      if (seen.has(k))
        throw new RubricValidationError(`rubric.trajectory.check.holdOn: duplicate "${k}"`);
      seen.add(k);
    }
    holdOn = [...seen] as TrajectorySignalKind[];
  }
  if (!criteria && !holdOn) {
    throw new RubricValidationError(
      "rubric.trajectory must declare criteria, a check, or both — or be left out",
    );
  }
  return {
    ...(criteria ? { criteria } : {}),
    ...(minScore === undefined ? {} : { minScore }),
    ...(holdOn ? { check: { holdOn } } : {}),
  };
}

function validateCriteria(raw: unknown, field: string, noun: string): RubricCriterion[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RubricValidationError(`${field} must list at least one criterion`);
  }
  if (raw.length > MAX_CRITERIA) {
    throw new RubricValidationError(`${field} is capped at ${MAX_CRITERIA}`);
  }
  const seen = new Set<string>();
  return raw.map((c, i) => {
    if (!c || typeof c !== "object") {
      throw new RubricValidationError(`${noun} ${i + 1} must be an object`);
    }
    const item = c as Record<string, unknown>;
    if (typeof item.id !== "string" || !ID_RE.test(item.id)) {
      throw new RubricValidationError(
        `${noun} ${i + 1} needs a lowercase slug id (letters, digits, - and _)`,
      );
    }
    if (seen.has(item.id)) {
      throw new RubricValidationError(`duplicate ${noun} id "${item.id}"`);
    }
    seen.add(item.id);
    if (typeof item.label !== "string" || !item.label.trim()) {
      throw new RubricValidationError(`${noun} "${item.id}" needs a label`);
    }
    const weight = item.weight === undefined ? undefined : Number(item.weight);
    if (weight !== undefined && (!Number.isFinite(weight) || weight <= 0)) {
      throw new RubricValidationError(`${noun} "${item.id}" weight must be > 0`);
    }
    return {
      id: item.id,
      label: item.label.trim().slice(0, 200),
      ...(weight === undefined ? {} : { weight }),
    };
  });
}

/** `autoApprove` on a gated phase. Requires a rubric to clear. */
export function validateAutoApprove(raw: unknown, hasRubric: boolean, judgesTrajectory = false) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") throw new RubricValidationError("autoApprove must be an object");
  const r = raw as Record<string, unknown>;
  const n = Number(r.verdict);
  if (!Number.isFinite(n) || n < 0 || n > 10) {
    throw new RubricValidationError("autoApprove.verdict must be between 0 and 10");
  }
  if (!hasRubric) {
    throw new RubricValidationError(
      "autoApprove needs a rubric on the same phase to score against",
    );
  }
  let trajectory: number | undefined;
  if (r.trajectory !== undefined && r.trajectory !== null) {
    trajectory = Number(r.trajectory);
    if (!Number.isFinite(trajectory) || trajectory < 0 || trajectory > 10) {
      throw new RubricValidationError("autoApprove.trajectory must be between 0 and 10");
    }
    if (!judgesTrajectory) {
      throw new RubricValidationError(
        "autoApprove.trajectory needs trajectory criteria on the phase's rubric",
      );
    }
  }
  return trajectory === undefined ? { verdict: n } : { verdict: n, trajectory };
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
  /** Mints the verdict id. Defaults to a random `V-…`. */
  newId?: () => string;
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
    id: deps.newId?.() ?? `V-${randomBytes(8).toString("hex")}`,
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

  const metered: Verdict = {
    ...base,
    costUsd: result.costUsd,
    tokens: result.tokens,
    durationMs: result.durationMs,
    provenance: {
      runtime: result.runtime,
      requestedModel: result.requestedModel,
      reportedModel: result.reportedModel,
      promptVersion: VERDICT_PROMPT_VERSION,
    },
    rubricDigest: rubricDigest(rubric),
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
  trajectoryMinScores: Map<string, number | null> = new Map(),
): VerdictReport {
  const trends = trendsOf(currentVerdicts(verdicts), minScores);
  // Trajectory scores are a different measurement: their own lines, never
  // averaged into the output summary.
  const trajectoryTrends = trendsOf(currentVerdicts(verdicts, "trajectory"), trajectoryMinScores);
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
    ...(trajectoryTrends.length > 0 ? { trajectoryTrends } : {}),
  };
}

function trendsOf(current: Verdict[], minScores: Map<string, number | null>): VerdictTrend[] {
  const groups = new Map<string, { scope: "schedule" | "phase"; name: string; list: Verdict[] }>();
  // One point per run: a re-judged run contributes its current verdict only.
  for (const v of current) {
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
  return trends;
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
  for (const v of currentVerdicts(verdicts)) {
    if (v.status !== "ready" || !v.regression || v.score === null) continue;
    out.set(
      v.runId,
      `quality below the bar for ${v.scheduleName}${v.phaseId ? ` › ${v.phaseId}` : ""}: ` +
        `scored ${v.score.toFixed(1)}/10 against a minimum of ${(v.minScore ?? 0).toFixed(1)}`,
    );
  }
  return out;
}
