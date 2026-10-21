import { useMemo, useState } from "react";
import {
  AlertStrip,
  Button,
  ButtonLink,
  chipClass,
  EmptyState,
  formatMs,
  formatTokens,
  formatUsd,
  Handoff,
  Icon,
  IconButton,
  Section,
  SegmentedControl,
  SkeletonCounters,
  SkeletonRows,
  TimeAgo,
} from "../ds";
import { useWatchtower } from "../useWatchtower";
import { useVerdictTrends } from "../useVerdict";
import { VerdictSparkline } from "./VerdictPanel";
import type { Anomaly, AnomalyMetric, Baseline, MetricBaseline } from "../types";
import { InfoTip } from "../ds/InfoTip";
import { HealthCounter } from "../ds/HealthCounter";
import { splitEnvelopeName } from "./envelopeName";
import { loadError } from "../live/loadError";

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
 *
 * A warming envelope is drawn in neutral ink rather than green: it is shown, but
 * it is not judging anything yet, and green would claim it was.
 */
function EnvelopeBar({ base, warming }: { base: MetricBaseline; warming: boolean }) {
  const span = base.p95 - base.p05;
  // One sample (or identical ones) has no width; mark the middle rather than
  // pinning the median to the left edge as though it were the minimum.
  const medianPct =
    span > 0 ? Math.min(100, Math.max(0, ((base.median - base.p05) / span) * 100)) : 50;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ground-2">
      <span
        className={`absolute inset-0 rounded-full ${warming ? "bg-ink-faint/20" : "bg-ok/25"}`}
      />
      <span
        aria-hidden="true"
        className={`absolute top-0 h-full w-0.5 -translate-x-1/2 ${warming ? "bg-ink-dim" : "bg-ok"}`}
        style={{ left: `${medianPct}%` }}
      />
    </div>
  );
}

function MetricCell({
  metric,
  base,
  samples,
  warming,
}: {
  metric: AnomalyMetric;
  base: MetricBaseline | null;
  /** The envelope's successful runs: none means nothing to learn from yet. */
  samples: number;
  warming: boolean;
}) {
  // The label repeats per row only below `lg`; at desktop width the panel's
  // header row names the columns once. That header is decorative, so the label
  // stays for screen readers — a value has to say which metric it is.
  const label = <p className="eyebrow mb-1 lg:sr-only">{METRIC_LABEL[metric]}</p>;
  if (!base) {
    // Two reasons for no envelope, with different fixes: every run so far
    // failed (only successes are learned from), or the runtime never sends
    // this metric at all. "Not reported" for both blamed the runtime.
    return (
      <div className="min-w-0">
        {label}
        <p className="text-caption text-ink-faint">
          {samples === 0 ? "No successful runs yet" : "Not reported"}
        </p>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      {label}
      {/* A phone's third of a row has no room for "median" or the run count,
          so they go — from the screen, not from a screen reader. */}
      <p className="truncate text-small font-semibold text-ink">
        {formatMetric(metric, base.median)}{" "}
        <span className="sr-only text-caption font-normal text-ink-faint sm:not-sr-only">
          median
        </span>
      </p>
      {/* An envelope with no spread yet — one run, or several that read the
          same — has no range to draw: the bar was a centred tick under a
          median that already said the number, and "1.9s – 1.9s" said it a
          third time. Compared as printed, so 15m 0s against 15m 0s is no
          spread either. */}
      {formatMetric(metric, base.p95) !== formatMetric(metric, base.p05) ? (
        <>
          <div className="my-1.5">
            <EnvelopeBar base={base} warming={warming} />
          </div>
          <p className="truncate text-caption text-ink-faint">
            {formatMetric(metric, base.p05)} – {formatMetric(metric, base.p95)}
            <span className="sr-only sm:not-sr-only sm:whitespace-nowrap">
              {" "}
              · {base.samples} {base.samples === 1 ? "run" : "runs"}
            </span>
          </p>
        </>
      ) : (
        <p className="mt-1 truncate text-caption text-ink-faint">
          {base.samples === 1 ? (
            <>
              <span className="sr-only sm:not-sr-only">Only </span>1 run so far
            </>
          ) : (
            <>
              {base.samples} runs<span className="sr-only sm:not-sr-only">, no spread yet</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * An envelope's name: the words, and a phase id after them in mono only when
 * the words do not already say it (see `splitEnvelopeName`). The full stored
 * name stays in the tooltip.
 */
function EnvelopeName({ name, phase }: { name: string; phase: boolean }) {
  const { label, id } = phase ? splitEnvelopeName(name) : { label: name, id: null };
  return (
    <span className="flex min-w-0 items-baseline gap-2" title={name}>
      <span className="min-w-0 truncate text-small font-semibold text-ink">{label}</span>
      {id && <span className="shrink-0 font-mono text-caption text-ink-faint">{id}</span>}
    </span>
  );
}

/** Severity in `StatusPill`'s anatomy, with the direction as an arrow. */
function SeverityPill({ anomaly }: { anomaly: Anomaly }) {
  const critical = anomaly.severity === "critical";
  const high = anomaly.direction === "high";
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border pl-1.5 pr-2.5 text-caption font-semibold leading-none ${
        critical ? "border-fail/35 bg-fail/12 text-fail" : "border-await/40 bg-await/12 text-await"
      }`}
    >
      <Icon
        name={high ? "arrow-up" : "arrow-down"}
        size={13}
        strokeWidth={2.25}
        label={high ? "Above its envelope" : "Below its envelope"}
      />
      {critical ? "Critical" : "Warning"}
    </span>
  );
}

/** "z = 21.6" is the evidence, but only to someone who knows what z is. */
function ZScore({ z, align }: { z: number; align: "start" | "end" }) {
  return (
    <InfoTip
      title="Robust z-score"
      align={align}
      trigger={<span className="text-caption text-ink-faint">z = {z.toFixed(1)}</span>}
    >
      How far this run sat from the median, in standard deviations estimated from the median
      absolute deviation — so one odd run in the history cannot widen the envelope. Watchtower flags
      a run beyond 3.5 and calls it critical beyond 7, and only when the value is also a real
      multiple of the median.
    </InfoTip>
  );
}

function AnomalyRow({ anomaly }: { anomaly: Anomaly }) {
  const critical = anomaly.severity === "critical";
  return (
    // The list does not clip (the z-score's explanation has to open past its
    // last row), so the end rows round their own tint to the panel's corners.
    <li
      className={`relative flex flex-col gap-3 px-4 py-3.5 first:rounded-t-tile last:rounded-b-tile sm:flex-row sm:items-center sm:gap-6 ${
        critical ? "bg-fail/[0.05]" : ""
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-3 left-0 w-[3px] rounded-r-full ${critical ? "bg-fail" : "bg-await"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <SeverityPill anomaly={anomaly} />
          <EnvelopeName name={anomaly.name} phase={anomaly.scope === "phase"} />
          <span className="text-caption text-ink-faint">
            <TimeAgo iso={anomaly.at} />
          </span>
        </div>
        <p className="mt-1.5 break-words text-small text-ink-dim">{anomaly.detail}</p>
      </div>
      {/* The score comes before Replay at every width, so tab order follows
          what the eye sees. Its explanation is a fixed-width popover that must
          open towards the room — rightwards from the start of a phone's footer,
          leftwards from beside Replay at a wide row's end — so each layout gets
          its own trigger, and the other is display:none, out of the tab order. */}
      <div className="flex shrink-0 items-center gap-4">
        {anomaly.zScore != null && (
          <>
            <span className="sm:hidden">
              <ZScore z={anomaly.zScore} align="start" />
            </span>
            <span className="hidden sm:inline">
              <ZScore z={anomaly.zScore} align="end" />
            </span>
          </>
        )}
        <ButtonLink
          href={`#/run/${encodeURIComponent(anomaly.runId)}`}
          size="sm"
          icon="replay"
          className="ml-auto sm:ml-0"
        >
          Replay this run
        </ButtonLink>
      </div>
    </li>
  );
}

/** Envelope, three metrics, actions. The panel owns the columns and the
 *  header and every row take them as a subgrid, so they line up while the
 *  actions column is only as wide as the widest row's actions: the reset icon,
 *  or Restore beside it once any row has one. A fixed 9.5rem held Restore's
 *  room on every install and took it from the names, cut at the part that
 *  tells two envelopes apart. The name's 2fr hands that room to it: at the
 *  narrow end of `lg` the metrics keep the width they had, and the name takes
 *  what the fixed column held. */
const ENVELOPE_GRID =
  "lg:grid lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))_auto] lg:gap-x-6";
const ENVELOPE_ROW = "lg:col-span-full lg:grid lg:grid-cols-subgrid lg:gap-x-6";

/** The reset control's reveal: there on a touch screen, which has no hover to
 *  find it by, and on a desktop under the pointer or the keyboard — so the
 *  table is not a column of identical, mildly destructive buttons. */
const REVEAL =
  "transition-opacity duration-(--duration-quick) pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100";

function BaselineRow({
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
    // Below `lg` the name and the actions share the first line and the metrics
    // take the second; at `lg` everything falls into the table's columns.
    <li
      className={`group grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-3 px-4 py-3.5 lg:items-center ${ENVELOPE_ROW}`}
    >
      <div className="min-w-0">
        <EnvelopeName name={baseline.name} phase={baseline.scope === "phase"} />
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-faint">
          <span className={`${chipClass("neutral")} capitalize`}>{baseline.scope}</span>
          {warming ? (
            <span
              className={chipClass("queue")}
              title="Shown, but not judging runs until it has enough successes"
            >
              Warming · {baseline.warmupRemaining} to go
            </span>
          ) : (
            <span className="text-ink-dim">{baseline.samples} samples</span>
          )}
          {baseline.resetAt ? (
            <span>
              reset <TimeAgo iso={baseline.resetAt} />
            </span>
          ) : (
            baseline.since && (
              <span>
                learning since <TimeAgo iso={baseline.since} />
              </span>
            )
          )}
        </div>
      </div>

      <div className="col-span-2 row-start-2 grid grid-cols-3 gap-4 lg:contents">
        {METRICS.map((m) => (
          <MetricCell
            key={m}
            metric={m}
            base={baseline[m]}
            samples={baseline.samples}
            warming={warming}
          />
        ))}
      </div>

      {/* Restore undoes a reset, so it reads as the alternative it is and
          stays in view; Reset is an icon that waits to be looked for. */}
      <div className="col-start-2 row-start-1 flex items-start justify-end gap-1.5 lg:col-start-auto lg:row-start-auto lg:items-center">
        {baseline.resetAt && (
          <Button size="sm" icon="history" disabled={busy} onClick={onRestore}>
            Restore full history
          </Button>
        )}
        <IconButton
          icon="retry"
          label="Reset baseline"
          size="sm"
          disabled={busy}
          onClick={onReset}
          title="Reset baseline — forget every run before now and learn the envelope again"
          className={REVEAL}
        />
      </div>
    </li>
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
      <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
        {report.trends.map((t) => (
          // Name and score share the first line on a phone, the evidence the
          // second; at desktop width it is one row with the score at the end.
          <li
            key={t.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex sm:gap-x-5"
          >
            <span
              className="min-w-0 truncate text-small font-semibold text-ink sm:flex-1"
              title={t.name}
            >
              {t.name}
            </span>
            <span className="text-heading font-semibold text-ink sm:order-last sm:w-16 sm:text-right">
              {t.latest?.toFixed(1) ?? "—"}
              <span className="text-caption font-normal text-ink-faint">/10</span>
            </span>
            <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <VerdictSparkline points={t.points} minScore={t.minScore} />
              {t.delta != null && t.delta !== 0 && (
                <span
                  className={`text-caption ${t.delta < 0 ? "text-fail" : "text-ok"}`}
                  title="Latest score against the median of everything before it"
                >
                  {t.delta > 0 ? "+" : ""}
                  {t.delta.toFixed(1)} vs median
                </span>
              )}
              {t.regressions > 0 && (
                <span className={chipClass("fail")}>{t.regressions} below the bar</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * The Watchtower half of Health. No `Page` of its own: `Health` supplies the
 * heading, the switch to Monitors and the explanation, so this is the content
 * alone. The severity filter sits on the anomaly list's own heading — beside
 * the thing it filters, not up by an intro it had nothing to do with.
 */
export function WatchtowerPanel() {
  const { report, loading, error, refresh, reset, restore } = useWatchtower();
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

  // How close the first envelope is to judging anything — the one number that
  // turns "nothing judged yet" from a shrug into a countdown.
  const warmup = report.baselines.map((b) => b.warmupRemaining).filter((n) => n > 0);
  const nearest = warmup.length > 0 ? Math.min(...warmup) : null;

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
    <>
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Watchtower"
            message={loadError("Watchtower", error)}
            action={
              <Button size="sm" icon="retry" onClick={() => refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}
      {actionError && (
        // Assertive: the reader just pressed a button and is waiting on it.
        <div role="alert" className="mb-6">
          <AlertStrip
            subject="Baseline unchanged"
            message={actionError}
            action={
              <IconButton
                icon="close"
                label="Dismiss"
                size="sm"
                onClick={() => setActionError(null)}
              />
            }
          />
        </div>
      )}

      {/* Counters live inside the handoff, so a first load does not open on a
          row of zeros that claims nothing is wrong before anyone knows. */}
      <Handoff
        busy={loading && report.baselines.length === 0}
        label="baselines"
        skeleton={
          <>
            <SkeletonCounters count={4} />
            <div className="mt-8">
              <SkeletonRows count={4} />
            </div>
          </>
        }
      >
        {report.baselines.length === 0 ? (
          // A failed load is not an empty history; the strip above says so.
          !error && (
            <EmptyState
              icon="activity"
              title="Nothing to learn from yet"
              action={
                <ButtonLink href="#/schedules" variant="primary" icon="plus">
                  Create a schedule
                </ButtonLink>
              }
            >
              Watchtower builds an envelope from each schedule's and each pipeline phase's own
              successful runs, then flags the ones that leave it — it needs {report.warmupRuns || 8}{" "}
              successes before it will say anything.
            </EmptyState>
          )
        ) : (
          <>
            {/* The news first: anomalies (and how many are critical) lead, the
                state of the envelopes follows. */}
            <section
              aria-label="Watchtower summary"
              className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4"
            >
              <HealthCounter label="Anomalies" value={report.summary.anomalies} tone="await" />
              <HealthCounter label="Critical" value={report.summary.critical} tone="fail" />
              {/* Envelopes warm enough to judge a run — not every envelope,
                  which the table below lists, warm or not. */}
              <HealthCounter label="Ready" value={report.summary.ready} tone="ok" />
              <HealthCounter label="Warming up" value={report.summary.warming} tone="queue" />
            </section>

            <Section
              title="Anomalies · last 14 days"
              action={
                report.anomalies.length > 0 && (
                  <SegmentedControl
                    segments={[
                      { value: "all", label: `All ${report.anomalies.length}` },
                      { value: "critical", label: `Critical ${report.summary.critical}` },
                    ]}
                    value={filter}
                    onChange={(v) => setFilter(v)}
                    label="Filter anomalies by severity"
                  />
                )
              }
            >
              {anomalies.length === 0 ? (
                report.summary.ready === 0 ? (
                  <EmptyState compact icon="clock" title="Nothing judged yet">
                    No envelope is warm yet, so nothing is being judged. Watchtower needs a handful
                    of successful runs per schedule before it will flag anything.
                    {nearest != null && (
                      <span className="mt-1 block text-ink-faint">
                        The nearest is {nearest} successful {nearest === 1 ? "run" : "runs"} away.
                      </span>
                    )}
                  </EmptyState>
                ) : filter === "critical" ? (
                  <EmptyState
                    compact
                    title="Nothing critical"
                    action={
                      <Button size="sm" onClick={() => setFilter("all")}>
                        Show the warnings
                      </Button>
                    }
                  >
                    {report.anomalies.length === 1
                      ? "The one anomaly in the last 14 days is a warning."
                      : report.anomalies.length === 2
                        ? "Both anomalies in the last 14 days are warnings."
                        : `All ${report.anomalies.length} anomalies in the last 14 days are warnings.`}
                  </EmptyState>
                ) : (
                  <EmptyState compact tone="calm" icon="check-circle" title="All clear">
                    Every run has landed inside its learned envelope. That is the good outcome.
                  </EmptyState>
                )
              ) : (
                <ul className="divide-y divide-line rounded-tile border border-line bg-surface shadow-raised">
                  {anomalies.map((a) => (
                    <AnomalyRow key={a.id} anomaly={a} />
                  ))}
                </ul>
              )}
            </Section>

            <QualityTrends />

            <Section
              title={`Learned envelopes · ${report.summary.ready} of ${report.baselines.length} ready`}
              action={
                <InfoTip
                  title="What's an envelope?"
                  align="end"
                  // One line, whatever the width: wrapped, the dotted underline ran
                  // under two stray fragments beside a heading that had wrapped too.
                  // A phone has room beside the heading for the short question
                  // only; the popover's own title still names the term.
                  trigger={
                    <span className="whitespace-nowrap text-caption text-ink-faint">
                      <span className="sm:hidden">What&apos;s this?</span>
                      <span className="hidden sm:inline">What&apos;s an envelope?</span>
                    </span>
                  }
                >
                  The median and the 5th–95th percentile of that unit of work's own{" "}
                  <strong className="font-semibold text-ink">successful</strong> runs. Failures are
                  judged against the envelope but never shape it — a crash that died in two seconds
                  is not evidence about how long the work takes.
                </InfoTip>
              }
            >
              <div
                className={`overflow-hidden rounded-tile border border-line bg-surface shadow-raised ${ENVELOPE_GRID}`}
              >
                <div
                  aria-hidden="true"
                  className={`hidden border-b border-line bg-ground-2/60 px-4 py-2 ${ENVELOPE_ROW}`}
                >
                  <span className="eyebrow">Envelope</span>
                  {METRICS.map((m) => (
                    <span key={m} className="eyebrow">
                      {METRIC_LABEL[m]}
                    </span>
                  ))}
                  <span />
                </div>
                <ul className={`divide-y divide-line ${ENVELOPE_ROW}`}>
                  {report.baselines.map((b) => (
                    <BaselineRow
                      key={b.key}
                      baseline={b}
                      busy={busyKey === b.key}
                      onReset={() => void act(b.key, reset)}
                      onRestore={() => void act(b.key, restore)}
                    />
                  ))}
                </ul>
              </div>
            </Section>
          </>
        )}
      </Handoff>
    </>
  );
}

export default WatchtowerPanel;
