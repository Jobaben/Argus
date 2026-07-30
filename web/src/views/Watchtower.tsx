import { useMemo, useState } from "react";
import {
  Card,
  EmptyState,
  formatMs,
  formatTokens,
  formatUsd,
  Handoff,
  HealthCounter,
  Page,
  Section,
  SegmentedControl,
  SkeletonGrid,
  TimeAgo,
} from "../ds";
import { useWatchtower } from "../useWatchtower";
import { useVerdictTrends } from "../useVerdict";
import { VerdictSparkline } from "./VerdictPanel";
import type { Anomaly, AnomalyMetric, Baseline, MetricBaseline } from "../types";

/**
 * Watchtower.
 *
 * Monitors answer "did it run", Issues answer "did it fail". This answers the
 * question neither does: did it run the way it *usually* runs? The page is
 * organised around that — anomalies first (the news), envelopes second (the
 * evidence) — and every envelope shows its own sample count so a reader can
 * see how much to trust it.
 */

const METRICS: AnomalyMetric[] = ["duration", "cost", "tokens"];

const METRIC_LABEL: Record<AnomalyMetric, string> = {
  duration: "Duration",
  cost: "Cost",
  tokens: "Tokens",
};

function formatMetric(metric: AnomalyMetric, value: number): string {
  if (metric === "duration") return formatMs(value);
  if (metric === "cost") return formatUsd(value);
  return formatTokens(value);
}

/**
 * The envelope as a bar: p05–p95 span with the median marked.
 *
 * Deliberately not a distribution plot. The question a reader has is "how wide
 * is normal, and where is the middle" — two marks answer it, and a histogram of
 * twelve samples would imply a resolution the data does not have.
 */
function EnvelopeBar({ base }: { base: MetricBaseline }) {
  const span = Math.max(base.p95 - base.p05, Number.EPSILON);
  const medianPct = Math.min(100, Math.max(0, ((base.median - base.p05) / span) * 100));
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ground-2">
      <span className="absolute inset-0 rounded-full bg-ok/25" />
      <span
        aria-hidden="true"
        className="absolute top-0 h-full w-0.5 bg-ok"
        style={{ left: `${medianPct}%` }}
      />
    </div>
  );
}

function MetricCell({ metric, base }: { metric: AnomalyMetric; base: MetricBaseline | null }) {
  if (!base) {
    return (
      <div className="rounded-md border border-dashed border-line px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-faint">
          {METRIC_LABEL[metric]}
        </p>
        <p className="font-mono text-xs text-ink-faint">not reported</p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-line px-3 py-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-faint">
        {METRIC_LABEL[metric]}
      </p>
      <p className="font-mono text-sm font-bold text-ink">
        {formatMetric(metric, base.median)}
        <span className="ml-1 text-[10px] font-normal text-ink-faint">median</span>
      </p>
      <div className="my-1.5">
        <EnvelopeBar base={base} />
      </div>
      <p className="font-mono text-[10px] text-ink-faint">
        {formatMetric(metric, base.p05)} – {formatMetric(metric, base.p95)} · {base.samples} runs
      </p>
    </div>
  );
}

function AnomalyRow({ anomaly }: { anomaly: Anomaly }) {
  const critical = anomaly.severity === "critical";
  return (
    <li
      className={`rounded-lg border px-3 py-2.5 ${
        critical ? "border-fail/40 bg-fail/6" : "border-line bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${
            critical
              ? "border-fail/40 bg-fail/12 text-fail"
              : "border-await/40 bg-await/12 text-await"
          }`}
        >
          {anomaly.direction === "high" ? "▲" : "▼"} {anomaly.severity}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {anomaly.name}
        </span>
        <span className="shrink-0 text-xs text-ink-faint">
          <TimeAgo iso={anomaly.at} />
        </span>
      </div>
      <p className="mt-1 font-mono text-[11.5px] text-ink-dim">{anomaly.detail}</p>
      <p className="mt-1 flex flex-wrap items-center gap-3">
        <a
          href={`#/run/${encodeURIComponent(anomaly.runId)}`}
          className="font-mono text-[11px] text-eye hover:underline"
        >
          ▶ replay this run
        </a>
        {anomaly.zScore != null && (
          <span
            className="font-mono text-[10px] text-ink-faint"
            title="Robust z-score: distance from the median in MAD-derived sigmas"
          >
            z = {anomaly.zScore.toFixed(1)}
          </span>
        )}
      </p>
    </li>
  );
}

function BaselineCard({
  baseline,
  onReset,
  onRestore,
  busy,
}: {
  baseline: Baseline;
  onReset: () => void;
  onRestore: () => void;
  busy: boolean;
}) {
  const warming = baseline.warmupRemaining > 0;
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className="min-w-0 flex-1 truncate text-sm font-semibold text-ink"
          title={baseline.name}
        >
          {baseline.name}
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
          {baseline.scope}
        </span>
        {warming ? (
          <span className="shrink-0 rounded-full border border-queue/40 bg-queue/12 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-queue">
            warming · {baseline.warmupRemaining} to go
          </span>
        ) : (
          <span className="shrink-0 rounded-full border border-ok/40 bg-ok/12 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-ok">
            {baseline.samples} samples
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {METRICS.map((m) => (
          <MetricCell key={m} metric={m} base={baseline[m]} />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={onReset}
          className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
          title="Forget every run before now and learn the envelope again"
        >
          Reset baseline
        </button>
        {baseline.resetAt && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onRestore}
              className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink disabled:opacity-50"
            >
              Restore full history
            </button>
            <span className="font-mono text-[10px] text-ink-faint">
              reset <TimeAgo iso={baseline.resetAt} />
            </span>
          </>
        )}
        {baseline.since && !baseline.resetAt && (
          <span className="font-mono text-[10px] text-ink-faint">
            learning since <TimeAgo iso={baseline.since} />
          </span>
        )}
      </div>
    </Card>
  );
}

type Filter = "all" | "critical";

/**
 * Quality trends live on this page rather than one of their own.
 *
 * Watchtower answers "did it behave the way it usually does"; Verdict answers
 * "was the result any good". Same reader, same glance, two halves of the same
 * question — and a rubric that nobody declared costs an empty section rather
 * than a whole empty tab.
 */
function QualityTrends() {
  const { report } = useVerdictTrends();
  if (report.trends.length === 0) return null;
  return (
    <Section title="Quality trends">
      <ul className="space-y-2">
        {report.trends.map((t) => (
          <li
            key={t.key}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-surface px-3 py-2"
          >
            <span
              className="min-w-40 flex-1 truncate text-sm font-semibold text-ink"
              title={t.name}
            >
              {t.name}
            </span>
            <VerdictSparkline points={t.points} minScore={t.minScore} />
            <span className="font-mono text-sm font-bold text-ink">
              {t.latest?.toFixed(1) ?? "—"}
              <span className="text-[10px] font-normal text-ink-faint">/10</span>
            </span>
            {t.delta != null && t.delta !== 0 && (
              <span
                className={`font-mono text-[11px] ${t.delta < 0 ? "text-fail" : "text-ok"}`}
                title="Latest score against the median of everything before it"
              >
                {t.delta > 0 ? "+" : ""}
                {t.delta.toFixed(1)} vs median
              </span>
            )}
            {t.regressions > 0 && (
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-fail">
                {t.regressions} below the bar
              </span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export default function Watchtower() {
  const { report, loading, error, reset, restore } = useWatchtower();
  const [filter, setFilter] = useState<Filter>("all");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const anomalies = useMemo(
    () =>
      filter === "critical"
        ? report.anomalies.filter((a) => a.severity === "critical")
        : report.anomalies,
    [report.anomalies, filter],
  );

  const act = async (key: string, fn: (k: string) => Promise<void>) => {
    setBusyKey(key);
    setActionError(null);
    try {
      await fn(key);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Page
      title="Watchtower"
      crumbs={[{ label: "Monitors", href: "#/monitors" }]}
      actions={
        report.anomalies.length > 0 ? (
          <SegmentedControl
            segments={[
              { value: "all", label: `All ${report.anomalies.length}` },
              { value: "critical", label: `Critical ${report.summary.critical}` },
            ]}
            value={filter}
            onChange={(v) => setFilter(v)}
            label="Filter anomalies by severity"
          />
        ) : undefined
      }
    >
      <section className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HealthCounter label="Envelopes" value={report.summary.ready} tone="live" />
        <HealthCounter label="Warming up" value={report.summary.warming} tone="queue" />
        <HealthCounter label="Anomalies" value={report.summary.anomalies} tone="run" />
        <HealthCounter label="Critical" value={report.summary.critical} tone="fail" />
      </section>

      {error && (
        <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
          Couldn't load Watchtower: {error}
        </div>
      )}
      {actionError && (
        <div
          role="alert"
          className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail"
        >
          {actionError}
        </div>
      )}

      <Handoff
        busy={loading && report.baselines.length === 0}
        label="baselines"
        skeleton={<SkeletonGrid count={4} columns={2} lines={3} />}
      >
        {report.baselines.length === 0 ? (
          <EmptyState>
            Nothing to learn from yet. Watchtower builds an envelope from each schedule's and each
            pipeline phase's own successful runs, then flags the ones that leave it — it needs{" "}
            {report.warmupRuns || 8} successes before it will say anything. Create a schedule and
            let it run a few times.
          </EmptyState>
        ) : (
          <>
            <Section title={`Anomalies · last 14 days`}>
              {anomalies.length === 0 ? (
                <EmptyState>
                  {report.summary.ready === 0
                    ? "No envelope is warm yet, so nothing is being judged. Watchtower needs a handful of successful runs per schedule before it will flag anything."
                    : filter === "critical"
                      ? "No critical anomalies. Switch to All to see the warnings."
                      : "Every run has landed inside its learned envelope. That is the good outcome."}
                </EmptyState>
              ) : (
                <ul className="space-y-2">
                  {anomalies.map((a) => (
                    <AnomalyRow key={a.id} anomaly={a} />
                  ))}
                </ul>
              )}
            </Section>

            <QualityTrends />

            <Section title="Learned envelopes">
              <p className="mb-3 max-w-prose text-sm text-ink-faint">
                Each envelope is the median and the 5th–95th percentile of that unit of work's own{" "}
                <strong className="font-semibold text-ink-dim">successful</strong> runs. Failures
                are judged against the envelope but never shape it — a crash that died in two
                seconds is not evidence about how long the work takes.
              </p>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                {report.baselines.map((b) => (
                  <BaselineCard
                    key={b.key}
                    baseline={b}
                    busy={busyKey === b.key}
                    onReset={() => void act(b.key, reset)}
                    onRestore={() => void act(b.key, restore)}
                  />
                ))}
              </div>
            </Section>
          </>
        )}
      </Handoff>
    </Page>
  );
}
