import { Button, Card, Icon, Skeleton, chipClass, formatMs, formatUsd } from "../ds";
import { useVerdict } from "../useVerdict";
import type { CriterionScore, Rubric, Verdict, VerdictPoint } from "../types";

/**
 * One run's score against its rubric.
 *
 * The per-criterion breakdown is the point, not the headline number: "7.3"
 * tells you nothing you can act on, while "coverage 8, actionable 4" tells you
 * which half of the rubric the run missed. The overall is shown small, next to
 * the threshold it is being judged against, so the number is always in the
 * context that gives it meaning.
 */

/**
 * Where a score sits. Strong is good news, under the bar (or under 5 when
 * there is no bar) is a failure; a middling score that still clears the bar is
 * neither, and painting it amber or violet would claim a status it does not
 * have. The figure and its bar take their colour from the same answer.
 */
function scoreBand(score: number, minScore: number | null): "fail" | "ok" | "mid" {
  if (minScore != null && score < minScore) return "fail";
  if (score >= 8) return "ok";
  if (score >= 5) return "mid";
  return "fail";
}

const SCORE_TEXT = { fail: "text-fail", ok: "text-ok", mid: "text-ink" } as const;
const SCORE_FILL = { fail: "bg-fail", ok: "bg-ok", mid: "bg-ink-dim" } as const;

const scoreTone = (score: number, minScore: number | null) =>
  SCORE_TEXT[scoreBand(score, minScore)];

/** A 0–10 score as a bar. Ten segments, so the value is countable by eye. */
export function ScoreBar({ score, minScore }: { score: number; minScore: number | null }) {
  const filled = Math.round(score);
  const fill = SCORE_FILL[scoreBand(score, minScore)];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-[2px]"
      role="img"
      aria-label={`${score.toFixed(1)} out of 10`}
    >
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`h-2.5 w-[7px] rounded-[2px] ${i < filled ? fill : "bg-line-strong"}`}
        />
      ))}
    </span>
  );
}

function CriterionRow({ c, minScore }: { c: CriterionScore; minScore: number | null }) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-3">
      <span className="min-w-0 flex-1 basis-48 text-small text-ink" title={c.label}>
        {c.label}
      </span>
      <span className="flex items-center gap-3">
        <ScoreBar score={c.score} minScore={minScore} />
        <span
          className={`w-8 shrink-0 text-right text-small font-semibold tabular-nums ${scoreTone(c.score, minScore)}`}
        >
          {c.score.toFixed(1)}
        </span>
      </span>
      {c.note && <span className="w-full break-words text-caption text-ink-faint">{c.note}</span>}
    </li>
  );
}

/**
 * The run's trajectory judgment, when its rubric declares one: how the agent
 * worked, kept apart from the output score. The signals are heuristics over
 * the recorded events, and are labelled as such.
 */
export function TrajectoryNote({
  rubric,
  trajectory,
}: {
  rubric: Rubric | null;
  trajectory: Verdict | null;
}) {
  if (!rubric?.trajectory && !trajectory) return null;
  let text: string;
  if (!trajectory) {
    text = "Not analysed yet.";
  } else if (trajectory.status !== "ready") {
    text =
      trajectory.status === "skipped"
        ? `Skipped: ${trajectory.error ?? "unavailable"}. An automated approval waits for a person.`
        : `The trajectory pass failed: ${trajectory.error ?? "unknown reason"}.`;
  } else {
    const signals = trajectory.trajectory?.signals;
    const observed = signals?.signals.filter((s) => s.observed).map((s) => s.kind) ?? [];
    const held = trajectory.trajectory?.held ?? [];
    text = [
      trajectory.score != null ? `${trajectory.score.toFixed(1)}/10` : null,
      observed.length > 0
        ? `heuristics observed: ${observed.join(", ")}`
        : signals?.truncated
          ? "no heuristic signal in the events kept — the recording was truncated, so this cannot clear the run"
          : "no heuristic signal observed in the recorded events",
      held.length > 0 ? `check held on ${held.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return (
    <p
      className="mt-3 flex max-w-prose items-start gap-2 text-caption text-ink-dim"
      data-testid="trajectory-note"
    >
      <Icon name="history" size={14} className="mt-px text-ink-faint" />
      <span className="min-w-0">
        <span className="font-semibold text-ink-faint">Trajectory </span>
        {text}
      </span>
    </p>
  );
}

export function VerdictPanel({ runId }: { runId: string }) {
  const { verdict, trajectory, rubric, unavailable, loading, busy, actionError, score } =
    useVerdict(runId);
  const trajectoryNote = <TrajectoryNote rubric={rubric} trajectory={trajectory} />;

  // No rubric means this unit of work opted out; say nothing rather than
  // advertising a feature on every run that will never use it.
  if (!rubric && !verdict) return null;

  const ready = verdict?.status === "ready" && verdict.score != null;
  const heading = (
    <div className="mb-3 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 className="eyebrow flex items-center gap-1.5">
        <Icon name="gauge" size={13} />
        Verdict
      </h2>
      {verdict?.costUsd != null && (
        <span className="ml-auto text-caption text-ink-faint" title="What this scoring pass cost">
          {formatUsd(verdict.costUsd)}
          {verdict.durationMs != null && ` · ${formatMs(verdict.durationMs)}`}
        </span>
      )}
    </div>
  );

  // The overall, set next to the bar it is judged against — the number only
  // means something in that context.
  const headline = ready && verdict.score != null && (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span
        className={`text-title font-semibold tabular-nums ${scoreTone(verdict.score, verdict.minScore)}`}
      >
        {verdict.score.toFixed(1)}
        <span className="ml-0.5 text-small font-normal text-ink-faint">/10</span>
      </span>
      {verdict.minScore != null && (
        <span className={chipClass()}>bar {verdict.minScore.toFixed(1)}</span>
      )}
      {verdict.regression && (
        <span className={chipClass("fail")}>
          <Icon name="arrow-down" size={11} />
          below the bar
        </span>
      )}
    </div>
  );

  const rescore = (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        icon="retry"
        disabled={busy || unavailable != null}
        onClick={() => void score()}
      >
        {busy ? "Scoring…" : verdict ? "Re-score" : "Score this output"}
      </Button>
      {actionError && (
        <span role="alert" className="flex items-center gap-1.5 text-small text-fail">
          <Icon name="alert" size={15} />
          <span className="min-w-0 break-words">
            {actionError}
            {/auth/i.test(actionError) && " — sign in to run agent actions."}
          </span>
        </span>
      )}
    </div>
  );

  if (loading && !verdict) {
    return (
      <Card>
        {heading}
        <p className="text-small text-ink-faint">Looking for a score…</p>
        <Skeleton className="mt-3 h-3 w-3/5" />
        <Skeleton className="mt-2 h-3 w-2/5" />
      </Card>
    );
  }

  if (!verdict || verdict.status !== "ready") {
    return (
      <Card>
        {heading}
        <p className="max-w-prose text-small text-ink-dim">
          {unavailable ??
            (verdict?.status === "skipped"
              ? "Scoring is switched off on this server (ARGUS_ANALYSIS=off)."
              : verdict
                ? `The scoring pass didn't produce a verdict: ${verdict.error ?? "unknown reason"}`
                : "Not scored yet. Argus scores each completed run against this rubric automatically.")}
        </p>
        {rubric && (
          <p className="mt-2 max-w-prose text-caption text-ink-faint">Rubric: {rubric.goal}</p>
        )}
        {trajectoryNote}
        {rescore}
      </Card>
    );
  }

  return (
    <Card>
      {heading}
      {headline}
      {verdict.summary && (
        <p className="mb-3 max-w-prose text-body text-ink-dim">{verdict.summary}</p>
      )}
      <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-ground-2/60">
        {verdict.criteria.map((c) => (
          <CriterionRow key={c.id} c={c} minScore={verdict.minScore} />
        ))}
      </ul>
      {trajectoryNote}
      {rescore}
    </Card>
  );
}

/**
 * A score history as a sparkline.
 *
 * Bars rather than a line: the values are a small discrete range, and a line
 * chart over ten points implies a continuity the data doesn't have. Points
 * below the bar are drawn red, so a run of regressions is visible at a glance
 * without reading a legend.
 */
export function VerdictSparkline({
  points,
  minScore,
}: {
  points: VerdictPoint[];
  minScore: number | null;
}) {
  if (points.length === 0) return null;
  return (
    <span
      className="inline-flex h-8 items-end gap-px"
      role="img"
      aria-label={`Last ${points.length} scores, oldest first: ${points
        .map((p) => p.score.toFixed(1))
        .join(", ")}`}
    >
      {points.map((p) => (
        <span
          key={p.runId}
          aria-hidden="true"
          title={`${p.score.toFixed(1)} — ${new Date(p.at).toLocaleString()}`}
          className={`w-1.5 rounded-[1px] ${p.regression ? "bg-fail" : "bg-ok"}`}
          style={{ height: `${Math.max(6, (p.score / 10) * 100)}%` }}
        />
      ))}
      {minScore != null && (
        <span className="ml-1.5 self-center whitespace-nowrap text-micro text-ink-faint">
          bar {minScore.toFixed(1)}
        </span>
      )}
    </span>
  );
}
