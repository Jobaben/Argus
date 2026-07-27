import { Card, formatMs, formatUsd } from "../ds";
import { useVerdict } from "../useVerdict";
import type { CriterionScore, VerdictPoint } from "../types";

/**
 * One run's score against its rubric.
 *
 * The per-criterion breakdown is the point, not the headline number: "7.3"
 * tells you nothing you can act on, while "coverage 8, actionable 4" tells you
 * which half of the rubric the run missed. The overall is shown small, next to
 * the threshold it is being judged against, so the number is always in the
 * context that gives it meaning.
 */

function scoreTone(score: number, minScore: number | null): string {
  if (minScore != null && score < minScore) return "text-fail";
  if (score >= 8) return "text-ok";
  if (score >= 5) return "text-await";
  return "text-fail";
}

/** A 0–10 score as a bar. Ten segments, so the value is countable by eye. */
export function ScoreBar({ score, minScore }: { score: number; minScore: number | null }) {
  const filled = Math.round(score);
  return (
    <span
      className="inline-flex items-center gap-px"
      role="img"
      aria-label={`${score.toFixed(1)} out of 10`}
    >
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`h-2.5 w-1.5 rounded-[1px] ${
            i < filled
              ? minScore != null && score < minScore
                ? "bg-fail"
                : "bg-ok"
              : "bg-ground-2"
          }`}
        />
      ))}
    </span>
  );
}

function CriterionRow({ c, minScore }: { c: CriterionScore; minScore: number | null }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5">
      <span className="min-w-32 flex-1 truncate text-sm text-ink" title={c.label}>
        {c.label}
      </span>
      <ScoreBar score={c.score} minScore={minScore} />
      <span
        className={`w-8 shrink-0 text-right font-mono text-xs font-bold ${scoreTone(c.score, minScore)}`}
      >
        {c.score.toFixed(1)}
      </span>
      {c.note && (
        <span className="w-full break-words font-mono text-[11px] text-ink-faint">{c.note}</span>
      )}
    </li>
  );
}

export function VerdictPanel({ runId }: { runId: string }) {
  const { verdict, rubric, unavailable, loading, busy, actionError, score } = useVerdict(runId);

  // No rubric means this unit of work opted out; say nothing rather than
  // advertising a feature on every run that will never use it.
  if (!rubric && !verdict) return null;

  const heading = (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <span className="font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-ink-faint">
        Verdict
      </span>
      {verdict?.status === "ready" && verdict.score != null && (
        <>
          <span
            className={`font-mono text-lg font-extrabold ${scoreTone(verdict.score, verdict.minScore)}`}
          >
            {verdict.score.toFixed(1)}
            <span className="text-[11px] font-normal text-ink-faint">/10</span>
          </span>
          {verdict.minScore != null && (
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              bar {verdict.minScore.toFixed(1)}
            </span>
          )}
          {verdict.regression && (
            <span className="rounded-full border border-fail/40 bg-fail/12 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-fail">
              below the bar
            </span>
          )}
        </>
      )}
      {verdict?.costUsd != null && (
        <span className="font-mono text-[10px] text-ink-faint" title="What this scoring pass cost">
          {formatUsd(verdict.costUsd)}
          {verdict.durationMs != null && ` · ${formatMs(verdict.durationMs)}`}
        </span>
      )}
    </div>
  );

  const rescore = (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy || unavailable != null}
        onClick={() => void score()}
        className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
      >
        {busy ? "Scoring…" : verdict ? "Re-score" : "Score this output"}
      </button>
      {actionError && (
        <span role="alert" className="text-sm text-fail">
          {actionError}
          {/auth/i.test(actionError) && " — sign in to run agent actions."}
        </span>
      )}
    </div>
  );

  if (loading && !verdict) {
    return (
      <Card>
        {heading}
        <p className="text-sm text-ink-faint">Looking for a score…</p>
      </Card>
    );
  }

  if (!verdict || verdict.status !== "ready") {
    return (
      <Card>
        {heading}
        <p className="max-w-prose text-sm text-ink-dim">
          {unavailable ??
            (verdict?.status === "skipped"
              ? "Scoring is switched off on this server (ARGUS_ANALYSIS=off)."
              : verdict
                ? `The scoring pass didn't produce a verdict: ${verdict.error ?? "unknown reason"}`
                : "Not scored yet. Argus scores each completed run against this rubric automatically.")}
        </p>
        {rubric && (
          <p className="mt-2 max-w-prose text-[11px] text-ink-faint">Rubric: {rubric.goal}</p>
        )}
        {rescore}
      </Card>
    );
  }

  return (
    <Card>
      {heading}
      {verdict.summary && <p className="mb-2 max-w-prose text-sm text-ink">{verdict.summary}</p>}
      <ul className="divide-y divide-line">
        {verdict.criteria.map((c) => (
          <CriterionRow key={c.id} c={c} minScore={verdict.minScore} />
        ))}
      </ul>
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
        <span className="ml-1.5 self-center font-mono text-[10px] text-ink-faint">
          bar {minScore.toFixed(1)}
        </span>
      )}
    </span>
  );
}
