import { randomBytes } from "node:crypto";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { buildRecording } from "./recorder.js";
import { formatTimelineEvent } from "./timeline.js";
import {
  computeTrajectorySignals,
  heldSignals,
  judgesTrajectory,
  TRAJECTORY_PROMPT_VERSION,
  trajectoryRubricDigest,
} from "./trajectory.js";
import { parseVerdictResponse, weightedScore, writeVerdict, type VerdictDeps } from "./verdict.js";
import type { Recording, Rubric, TrajectorySignals, Verdict } from "@argus/contracts";
import type { Run } from "./scheduleTypes.js";

/**
 * The trajectory pass: deterministic signals over a run's recording, a check
 * the author may declare over them, and — only when the rubric declares
 * trajectory criteria — one bounded judge call through the shared
 * AnalysisRunner. Stored as a `trajectory` verdict in the verdict store, never
 * mixed with the run's output verdict.
 *
 * Nothing here runs unless a rubric declares `trajectory`: there is no
 * trajectory judging by default.
 */

/** Timeline events quoted: the opening of the run and its tail. */
export const TRAJECTORY_HEAD_EVENTS = 20;
export const TRAJECTORY_TAIL_EVENTS = 60;
export const TRAJECTORY_PROMPT_MAX_CHARS = 24_000;

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Characters of timeline quoted, so the answer instructions after it always fit. */
export const TRAJECTORY_TIMELINE_MAX_CHARS = 14_000;

/**
 * The timeline a trajectory judge reads: the opening of the run and its tail,
 * with the gap said. Lines are dropped from the middle — head and tail kept in
 * proportion — until it fits {@link TRAJECTORY_TIMELINE_MAX_CHARS}.
 */
export function trajectoryTimeline(recording: Recording): string {
  const lines = recording.events.map(formatTimelineEvent);
  let headN = Math.min(TRAJECTORY_HEAD_EVENTS, lines.length);
  let tailN = Math.min(TRAJECTORY_TAIL_EVENTS, lines.length - headN);
  const size = () =>
    lines.slice(0, headN).reduce((n, l) => n + l.length + 1, 0) +
    lines.slice(lines.length - tailN).reduce((n, l) => n + l.length + 1, 0);
  while (size() > TRAJECTORY_TIMELINE_MAX_CHARS && headN + tailN > 1) {
    if (headN * 3 > tailN && headN > 0) headN--;
    else tailN--;
  }
  const gap = lines.length - headN - tailN;
  const head = lines.slice(0, headN);
  const tail = lines.slice(lines.length - tailN);
  return gap > 0 ? [...head, `… ${gap} events omitted …`, ...tail].join("\n") : lines.join("\n");
}

function signalLines(signals: TrajectorySignals): string {
  return signals.signals
    .map(
      (s) =>
        `  - ${s.kind}: ${s.count}${s.observed ? " (observed)" : ""}` +
        (s.examples.length > 0 ? `; e.g. ${s.examples.slice(0, 3).join(" | ")}` : ""),
    )
    .join("\n");
}

/**
 * The trajectory judge prompt. The rubric's trajectory criteria are listed by
 * id, exactly as the output judge's are, so the answer parses with the same
 * validator; the heuristics are quoted as heuristics, so the judge is told
 * what they are and is free to disagree with them.
 */
export function buildTrajectoryPrompt(
  run: Run,
  rubric: Rubric,
  recording: Recording,
  signals: TrajectorySignals,
): string {
  const criteria = (rubric.trajectory?.criteria ?? [])
    .map((c) => `  - id "${c.id}": ${c.label}${c.weight != null ? ` (weight ${c.weight})` : ""}`)
    .join("\n");
  const body = `You are scoring HOW one automated agent run went about its task — its trajectory, not its final output — against a rubric. Answer only with JSON.

WHAT GOOD LOOKS LIKE
${clip(rubric.goal, 2000)}

TRAJECTORY CRITERIA
${criteria}

THE TASK THE AGENT WAS GIVEN
${clip(run.prompt, 3000)}

DETERMINISTIC SIGNALS (heuristics over the recorded events; they can miss things and can flag legitimate work)
${signalLines(signals)}

TIMELINE (offsets are milliseconds/1000 from the run's start${
    recording.truncated ? "; earliest events omitted by the recorder" : ""
  })
${trajectoryTimeline(recording) || "(no transcript events were recorded)"}

Answer with a single JSON object and nothing else:
{
  "criteria": [
    { "id": "<one of the ids above, verbatim>", "score": 0-10, "note": "one sentence" }
  ],
  "summary": "one sentence on the trajectory as a whole"
}

Rules: return exactly one entry per criterion id listed above, using the ids
verbatim. Score 0-10 where 10 fully meets the criterion. Do not return an
overall score. Judge only the trajectory shown; do not speculate about events
not visible here.`;
  return body.length > TRAJECTORY_PROMPT_MAX_CHARS
    ? `${body.slice(0, TRAJECTORY_PROMPT_MAX_CHARS - 1)}…`
    : body;
}

export interface TrajectoryDeps extends VerdictDeps {
  /** Transcript lines for the run, as Autopsy reads them. */
  readLines: (project: string, sessionId: string) => Promise<unknown[]>;
}

/**
 * Analyse one run's trajectory and persist the result, or return null when
 * the runner refused for a transient reason (busy, or the budget hard stop)
 * — nothing is written then, so the run is tried again on a later tick rather
 * than carrying a permanent refusal.
 *
 * Statuses: `skipped` when there is no transcript to read or analysis is
 * disabled; `failed` when the judge produced nothing usable; `ready`
 * otherwise. A check-only rubric is `ready` with a null score. Every
 * non-`ready` status holds an automated approval.
 */
export async function performTrajectoryVerdict(
  run: Run,
  rubric: Rubric,
  deps: TrajectoryDeps,
): Promise<Verdict | null> {
  const lines =
    run.project && run.sessionId ? await deps.readLines(run.project, run.sessionId) : [];
  const recording = buildRecording(run, lines, deps.now());
  const signals = computeTrajectorySignals(recording, run.cwd || null);
  const held = heldSignals(signals, rubric.trajectory?.check?.holdOn ?? []);
  const judged = judgesTrajectory(rubric);
  const minScore = rubric.trajectory?.minScore ?? null;

  const base: Verdict = {
    id: deps.newId?.() ?? `VT-${randomBytes(8).toString("hex")}`,
    kind: "trajectory",
    runId: run.id,
    scheduleId: run.scheduleId,
    scheduleName: run.scheduleName,
    phaseId: run.phaseId ?? null,
    status: "ready",
    at: deps.now().toISOString(),
    score: null,
    criteria: [],
    summary: null,
    regression: false,
    minScore,
    costUsd: null,
    tokens: null,
    durationMs: null,
    error: null,
    rubricDigest: trajectoryRubricDigest(rubric),
    trajectory: { signals, held, judged },
  };

  if (signals.transcript === "missing") {
    return writeVerdict({
      ...base,
      status: "skipped",
      error: `no transcript to read (${recording.unavailable ?? "unavailable"})`,
    });
  }
  if (!judged) return writeVerdict(base);

  const criteriaRubric: Rubric = { goal: rubric.goal, criteria: rubric.trajectory!.criteria! };
  const result = await deps.runner.run(
    {
      kind: "trajectory",
      prompt: buildTrajectoryPrompt(run, rubric, recording, signals),
      cwd: run.cwd || path.dirname(paths.verdictFile()),
    },
    (value) => parseVerdictResponse(value, criteriaRubric),
  );
  if (!result.ok && (result.failure === "busy" || result.failure === "budget-blocked")) {
    return null;
  }

  const metered: Verdict = {
    ...base,
    costUsd: result.costUsd,
    tokens: result.tokens,
    durationMs: result.durationMs,
    provenance: {
      runtime: result.runtime,
      requestedModel: result.requestedModel,
      reportedModel: result.reportedModel,
      promptVersion: TRAJECTORY_PROMPT_VERSION,
    },
  };
  if (!result.ok || !result.value) {
    return writeVerdict({
      ...metered,
      status: result.failure === "disabled" ? "skipped" : "failed",
      error: result.error ?? "the trajectory pass produced nothing",
    });
  }
  const score = weightedScore(criteriaRubric, result.value.criteria);
  return writeVerdict({
    ...metered,
    score,
    criteria: result.value.criteria,
    summary: result.value.summary,
    regression: score !== null && minScore !== null && score < minScore,
  });
}
