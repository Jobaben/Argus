import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertStrip,
  Button,
  Card,
  EmptyState,
  Icon,
  IconButton,
  Section,
  SegmentedControl,
  Skeleton,
  chipClass,
  fieldClass,
  formatTokens,
  formatUsd,
} from "../ds";
import { useLedger } from "../useLedger";
import type {
  Attribution,
  BudgetAction,
  BudgetWindow,
  CostDimension,
  Forecast,
  LedgerReport,
} from "../types";
import { projectMonth, type MonthProjection } from "./budgetProjection";

/**
 * The Ledger: where the money went, where it is going, and what a change would
 * do about it.
 *
 * Every number here is measured, and the panels are built so that reads as
 * true. The forecast shows its band and its sample count rather than a single
 * confident figure; the simulator refuses to answer when the target model has
 * never run here, instead of quoting a price list; and the attribution reports
 * runs that cost nothing to attribute, so the totals can be checked.
 */

const DIMENSIONS: { key: CostDimension; label: string; pick: (r: LedgerData) => Attribution }[] = [
  { key: "schedule", label: "Schedule", pick: (r) => r.bySchedule },
  { key: "pipeline", label: "Pipeline", pick: (r) => r.byPipeline },
  { key: "agent", label: "Agent", pick: (r) => r.byAgent },
  { key: "project", label: "Project", pick: (r) => r.byProject },
  { key: "model", label: "Model", pick: (r) => r.byModel },
];

type LedgerData = ReturnType<typeof useLedger>["report"];

const ACTION_COPY: Record<BudgetAction, string> = {
  warn: "Warn only",
  downgrade: "Move scheduled runs to a cheaper model",
  defer: "Defer scheduled slots (manual runs still allowed)",
  stop: "Stop scheduled runs",
};

/** Header and cell classes shared by the attribution table's columns; each
 *  cell adds its own colour and padding, so no two classes fight over one. */
const TH = "eyebrow py-2.5 font-semibold";
const NUM = "py-3 pr-3 text-right align-top text-small";

function ShareBar({ share }: { share: number }) {
  return (
    <span aria-hidden="true" className="block h-1 rounded-full bg-ground-2">
      <span
        className="block h-full rounded-full bg-ink-dim/55 transition-[width] duration-(--duration-slow) ease-(--ease-out-expo)"
        style={{ width: `${Math.max(2, Math.round(share * 100))}%` }}
      />
    </span>
  );
}

/**
 * The slices, ranked, as a table: the cost and its share are the columns read
 * first, so they keep their place at every width; runs, the per-run rate and
 * tokens fold into a line under the name on a phone.
 */
function AttributionTable({
  attribution,
  dimension,
  onSimulate,
  triggerRef,
}: {
  attribution: Attribution;
  dimension: string;
  onSimulate: (key: string, label: string) => void;
  /** Registers each row's "What if…" button, so closing the simulator can hand
   *  focus back to the one that opened it. */
  triggerRef: (key: string) => (el: HTMLButtonElement | null) => void;
}) {
  if (attribution.slices.length === 0) {
    return (
      <EmptyState compact icon="coin" title="No costed runs in this window yet">
        Cost attribution needs runs that reported a price — the CLI reports one per run, so a
        schedule that has never fired shows nothing here.
      </EmptyState>
    );
  }
  return (
    <div className="overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Spend by {dimension.toLowerCase()}, largest first, with each one&apos;s share of the total
        </caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={`${TH} w-8 pl-4 pr-1 text-left sm:w-10 sm:pr-2`}>
              <span aria-hidden="true">#</span>
              <span className="sr-only">Rank</span>
            </th>
            <th scope="col" className={`${TH} pr-3 text-left`}>
              {dimension}
            </th>
            <th scope="col" className={`${TH} hidden w-20 pr-3 text-right md:table-cell`}>
              Runs
            </th>
            <th scope="col" className={`${TH} hidden w-24 pr-3 text-right md:table-cell`}>
              Per run
            </th>
            <th scope="col" className={`${TH} hidden w-24 pr-3 text-right md:table-cell`}>
              Tokens
            </th>
            <th scope="col" className={`${TH} w-20 pr-3 text-right sm:w-24`}>
              Cost
            </th>
            <th scope="col" className={`${TH} hidden w-16 pr-3 text-right sm:table-cell`}>
              Share
            </th>
            <th scope="col" className="w-11 py-2.5 pr-2 sm:w-28 sm:pr-3">
              <span className="sr-only">Simulate</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {attribution.slices.map((s, i) => {
            const other = s.key === "__other__";
            return (
              <tr key={s.key}>
                <td className="py-3 pl-4 pr-1 align-top text-small text-ink-faint sm:pr-2">
                  {other ? "" : i + 1}
                </td>
                {/* max-w-0 lets the label truncate instead of widening the table. */}
                <td className="max-w-0 py-3 pr-3 align-top">
                  <div
                    className={`truncate text-small ${other ? "text-ink-dim" : "font-semibold text-ink"}`}
                    title={s.label}
                  >
                    {s.label}
                  </div>
                  <div className="mt-2">
                    <ShareBar share={s.share} />
                  </div>
                  {/* Each figure keeps its unit: the line wraps between pairs,
                      never inside one. */}
                  <div className="mt-1.5 text-caption text-ink-faint md:hidden">
                    <span className="whitespace-nowrap sm:hidden">
                      {Math.round(s.share * 100)}% ·{" "}
                    </span>
                    <span className="whitespace-nowrap">
                      {s.runs} run{s.runs === 1 ? "" : "s"}
                    </span>{" "}
                    · <span className="whitespace-nowrap">{formatUsd(s.perRunUsd)} each</span> ·{" "}
                    <span className="whitespace-nowrap">{formatTokens(s.tokens)} tok</span>
                  </div>
                </td>
                <td className={`${NUM} hidden text-ink-dim md:table-cell`}>{s.runs}</td>
                <td className={`${NUM} hidden text-ink-dim md:table-cell`}>
                  {formatUsd(s.perRunUsd)}
                </td>
                <td className={`${NUM} hidden text-ink-faint md:table-cell`}>
                  {formatTokens(s.tokens)}
                </td>
                <td className={`${NUM} font-semibold text-ink`}>{formatUsd(s.usd)}</td>
                <td className={`${NUM} hidden text-ink-dim sm:table-cell`}>
                  {Math.round(s.share * 100)}%
                </td>
                <td className="py-2 pr-2 text-right align-top sm:pr-3">
                  {!other && (
                    <Button
                      ref={triggerRef(s.key)}
                      size="sm"
                      variant="ghost"
                      icon="sliders"
                      aria-label={`What if… ${s.label}`}
                      title={`What if ${s.label} ran on another model?`}
                      onClick={() => onSimulate(s.key, s.label)}
                    >
                      <span className="hidden sm:inline">What if…</span>
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Stand-in for the attribution table while the first report is on its way. */
function AttributionLoading() {
  return (
    <div className="rounded-tile border border-line bg-surface px-4 py-3.5 shadow-raised">
      <p className="text-caption text-ink-faint">Reading the run history…</p>
      <div className="mt-3 flex flex-col gap-3.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-4">
            <Skeleton className={`h-3 ${i === 0 ? "w-2/5" : i === 1 ? "w-1/3" : "w-1/4"}`} />
            <Skeleton className="ml-auto h-3 w-14" />
            <Skeleton className="h-3 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}

function shortDay(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The straight-line projection as one sentence — the visible line and the
 *  live region's announcement, so the two never say different things. */
function straightLineSentence(p: MonthProjection, w: BudgetWindow): ReactNode {
  const limit = w.limitUsd != null && w.limitUsd > 0 ? w.limitUsd : null;
  const alreadyOver = w.ratio != null && w.ratio >= 1;
  return (
    <>
      On course for <strong className="font-semibold text-ink">{formatUsd(p.projectedUsd)}</strong>{" "}
      this month
      {/* The crossing day is a forecast only while it is still ahead; once the
          limit is behind the month, the useful figure is how far past it the
          month lands. */}
      {p.exhaustsOn && !alreadyOver ? (
        <>
          {" · "}limit reached around{" "}
          <strong className="font-semibold text-ink">{shortDay(p.exhaustsOn)}</strong>
        </>
      ) : limit != null && p.overLimit ? (
        <>
          {" · "}
          <strong className="font-semibold text-ink">
            {formatUsd(p.projectedUsd - limit)}
          </strong>{" "}
          over the limit
        </>
      ) : limit != null ? (
        <> · inside the {formatUsd(limit)} limit</>
      ) : null}
    </>
  );
}

/** The figure column every forecast shares: eyebrow, the number, its basis. */
function MonthEnd({
  usd,
  overLimit,
  aside,
  basis,
}: {
  usd: number;
  overLimit: boolean;
  aside?: ReactNode;
  basis?: ReactNode;
}) {
  return (
    <div className="shrink-0">
      <div className="flex items-center gap-2">
        <span className="eyebrow">Month end</span>
        {overLimit && <span className={chipClass("fail")}>Over the limit</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`text-display font-semibold ${overLimit ? "text-fail" : "text-ink"}`}>
          {formatUsd(usd)}
        </span>
        {aside}
      </div>
      {basis && <p className="mt-1 text-caption text-ink-faint">{basis}</p>}
    </div>
  );
}

function ForecastCard({ overLimit, children }: { overLimit: boolean; children: ReactNode }) {
  return (
    <Card className="relative overflow-hidden">
      {overLimit && (
        <span
          aria-hidden="true"
          className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-fail"
        />
      )}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8">{children}</div>
    </Card>
  );
}

/**
 * Where the month lands — one figure, from the best basis there is.
 *
 * The ledger's median forecast once it has enough full days to be worth
 * reading; until then, on the Budget page, the straight line through the
 * month so far, labelled as exactly that. Never both: two month-end figures on
 * one page would disagree, and a reader cannot tell which to believe.
 */
function ForecastPanel({
  forecast,
  straight,
  month,
  pending,
}: {
  forecast: Forecast;
  /** The straight-line projection, when the page has a month to draw it from. */
  straight: MonthProjection | null;
  month?: BudgetWindow;
  /** Why the median forecast is not in yet, when it is not for want of days. */
  pending: "loading" | "failed" | null;
}) {
  if (forecast.monthEndUsd != null) {
    return (
      <ForecastCard overLimit={forecast.overLimit}>
        <MonthEnd
          usd={forecast.monthEndUsd}
          overLimit={forecast.overLimit}
          aside={
            forecast.confidence != null && (
              <span
                className="text-caption font-semibold text-ink-dim"
                title="Derived from how tight the daily history is — an erratic month projects less well"
              >
                {Math.round(forecast.confidence * 100)}% confidence
              </span>
            )
          }
          basis={
            forecast.lowUsd != null &&
            forecast.highUsd != null &&
            `band ${formatUsd(forecast.lowUsd)} – ${formatUsd(forecast.highUsd)}`
          }
        />
        <div className="min-w-0 lg:border-l lg:border-line lg:pl-8">
          <p className="max-w-prose text-small text-ink">{forecast.note}</p>
          {forecast.dailyUsd != null && (
            <p className="mt-2 text-caption text-ink-faint">
              {formatUsd(forecast.dailyUsd)}/day median over {forecast.samples} full days ·{" "}
              {formatUsd(forecast.monthToDateUsd)} so far this month
            </p>
          )}
        </div>
      </ForecastCard>
    );
  }

  if (straight && month) {
    return (
      <ForecastCard overLimit={straight.overLimit}>
        <MonthEnd
          usd={straight.projectedUsd}
          overLimit={straight.overLimit}
          basis={`straight-line from ${straight.daysElapsed} ${straight.daysElapsed === 1 ? "day" : "days"}`}
        />
        <div className="min-w-0 lg:border-l lg:border-line lg:pl-8">
          <p className="max-w-prose text-small text-ink-dim">
            {straightLineSentence(straight, month)}
          </p>
          <p className="mt-2 max-w-prose text-caption text-ink-faint">
            {formatUsd(straight.perDayUsd)}/day so far, straight-lined across all{" "}
            {straight.daysInMonth} days.{" "}
            {pending === "loading"
              ? "A median of full days follows once the run history is in."
              : pending === "failed"
                ? null
                : `A median of full days takes over once there are enough of them (${forecast.samples} so far).`}
          </p>
        </div>
      </ForecastCard>
    );
  }

  if (pending === "loading") {
    return (
      <Card>
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </Card>
    );
  }

  // No projection is a state, not a missing number: it says why there is none
  // and what it is waiting for, with the dash standing in for the figure.
  return (
    <Card>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
        <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-start sm:gap-2">
          <span className="eyebrow">Month end</span>
          <span aria-hidden="true" className="text-display font-semibold text-ink-faint">
            —
          </span>
        </div>
        <div className="min-w-0 sm:border-l sm:border-line sm:pl-4">
          <p className="text-heading font-semibold text-ink">No projection yet</p>
          <p className="mt-1 max-w-prose text-small text-ink-dim">{forecast.note}</p>
          <p className="mt-2 text-caption text-ink-faint">
            {formatUsd(forecast.monthToDateUsd)} so far this month. The projection is a median of
            full days, so it waits until it has enough of them to be worth reading.
          </p>
        </div>
      </div>
    </Card>
  );
}

const POLICY_TONE: Record<BudgetAction, "run" | "fail"> = {
  warn: "run",
  downgrade: "run",
  defer: "run",
  stop: "fail",
};

/**
 * A budget policy acting on scheduled runs right now. Automated, so amber — it
 * is Argus working around the budget, not a person being waited on — and red
 * only when it has stopped scheduled work outright.
 */
function PolicyInForce({ enforcement }: { enforcement: LedgerReport["enforcement"] }) {
  const action = enforcement.action;
  if (!action) return null;
  const tone = POLICY_TONE[action];
  return (
    <Section title="Budget policy in force">
      <div
        className={`flex flex-col gap-3 rounded-tile border px-4 py-3.5 shadow-raised sm:flex-row sm:items-start ${
          tone === "fail" ? "border-fail/35 bg-fail/8" : "border-run/35 bg-run/8"
        }`}
      >
        <Icon
          name="shield"
          size={18}
          className={`mt-0.5 ${tone === "fail" ? "text-fail" : "text-run"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-small font-semibold text-ink">{ACTION_COPY[action]}</p>
          {/* The server's detail is a lower-case clause; the paragraph's first
              letter gives it the capital a sentence needs. */}
          <p className="mt-1 max-w-prose text-small text-ink-dim first-letter:uppercase">
            {enforcement.detail}. Every affected run records this on its own record, so a cheap or
            missing run stays explicable later.
          </p>
        </div>
        <span className={`${chipClass(tone)} self-start`}>
          <span className="inline-block first-letter:uppercase">{action}</span>
        </span>
      </div>
    </Section>
  );
}

export function LedgerPanels({
  month,
  now,
  history,
}: {
  /** The month's spend window, for the straight-line projection that stands
   *  in until the median forecast has enough days. */
  month?: BudgetWindow;
  /** The shared clock, so "days elapsed" rolls over at midnight. */
  now?: number;
  /** The page's own day-by-day history, which reads between where the month
   *  is heading and where the money went. */
  history?: ReactNode;
}) {
  const { report, loading, error, refresh, simulation, simulating, simError, simulate } =
    useLedger();
  const [dimension, setDimension] = useState<CostDimension>("schedule");
  const [target, setTarget] = useState<{ key: string; label: string } | null>(null);
  const [toModel, setToModel] = useState("haiku");
  const modelField = useId();
  const modelInput = useRef<HTMLInputElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const triggerRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) triggers.current.set(key, el);
    else triggers.current.delete(key);
  };
  // The simulator opens below the table, often out of view; taking focus to its
  // one field brings it on screen and puts the caret where the next keystroke goes.
  useEffect(() => {
    if (target) modelInput.current?.focus();
  }, [target]);
  // Closing unmounts the focused Close button; focus goes back to the row's
  // "What if…" that opened it rather than dropping to the page.
  const close = () => {
    const key = target?.key;
    setTarget(null);
    if (key != null) requestAnimationFrame(() => triggers.current.get(key)?.focus());
  };

  const active = DIMENSIONS.find((d) => d.key === dimension)!;
  const attribution = active.pick(report);
  // A failure only counts before any report has landed: after that, a failed
  // refresh leaves the last one on screen (stale, not wrong) and retries.
  const failed = error != null && !report.generatedAt;
  const straight = month && now != null ? projectMonth(month, new Date(now)) : null;
  const showStraight = report.forecast.monthEndUsd == null && straight != null && month != null;

  return (
    <>
      {/* The forecast moves on a poll and the simulator answers asynchronously;
          both need to reach a reader who is not watching the pixels. */}
      <div aria-live="polite" role="status" className="sr-only">
        {showStraight ? straightLineSentence(straight, month) : report.forecast.note}
        {simulation?.ok ? ` ${simulation.summary}` : simulation?.unavailable}
      </div>

      {/* A policy acting on your runs right now is the one thing here that is
          happening rather than being reported, so it comes first. */}
      <PolicyInForce enforcement={report.enforcement} />

      {/* After a failed load the forecast and the attribution are unknown, not
          empty: one error says so, in place of panels that would claim "no
          projection" and "no costed runs". */}
      {failed && (
        <div className="mb-10">
          <AlertStrip
            subject="Ledger"
            message={`Couldn't load the median forecast or where the money went: ${error}`}
            action={
              <Button size="sm" icon="retry" onClick={() => refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      {(!failed || showStraight) && (
        <Section title="Forecast">
          <ForecastPanel
            forecast={report.forecast}
            straight={straight}
            month={month}
            pending={failed ? "failed" : loading ? "loading" : null}
          />
        </Section>
      )}

      {history}

      {!failed && (
        <Section title={`Where it went · last ${report.windowDays} days`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <SegmentedControl
              label="Group spend by"
              value={dimension}
              onChange={setDimension}
              segments={DIMENSIONS.map((d) => ({ value: d.key, label: d.label }))}
            />
            {attribution.slices.length > 0 && (
              <p className="text-caption text-ink-faint">
                <strong className="font-semibold text-ink-dim">
                  {formatUsd(attribution.totalUsd)}
                </strong>{" "}
                across {attribution.runs} costed run{attribution.runs === 1 ? "" : "s"}
                {attribution.unattributedRuns > 0 &&
                  ` · ${attribution.unattributedRuns} outside this grouping`}
              </p>
            )}
          </div>
          {loading && attribution.slices.length === 0 ? (
            <AttributionLoading />
          ) : (
            <AttributionTable
              attribution={attribution}
              dimension={active.label}
              onSimulate={(key, label) => setTarget({ key, label })}
              triggerRef={triggerRef}
            />
          )}
        </Section>
      )}

      {target && (
        <Section title="What if…">
          <Card>
            <div className="flex items-start gap-3">
              <form
                className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void simulate({ dimension, key: target.key, toModel });
                }}
              >
                <p className="min-w-0 text-small text-ink-dim">
                  Move <strong className="font-semibold text-ink">{target.label}</strong> to
                </p>
                <label htmlFor={modelField} className="sr-only">
                  Model to move it to
                </label>
                <input
                  ref={modelInput}
                  id={modelField}
                  value={toModel}
                  onChange={(e) => setToModel(e.target.value)}
                  placeholder="haiku"
                  className={`${fieldClass} h-8 w-36`}
                />
                <Button
                  type="submit"
                  icon="sliders"
                  disabled={simulating || !toModel.trim()}
                  aria-busy={simulating || undefined}
                >
                  {simulating ? "Working…" : "Simulate"}
                </Button>
              </form>
              <IconButton icon="close" label="Close" size="sm" onClick={close} />
            </div>

            {simError && (
              <p role="alert" className="mt-3 flex items-start gap-2 text-small text-fail-ink">
                <Icon name="alert" size={15} className="mt-0.5 text-fail" />
                {simError}
              </p>
            )}

            {simulation && !simulation.ok && (
              <div className="mt-4 flex items-start gap-2.5 rounded-control bg-ground-2/60 px-3 py-2.5">
                <Icon name="info" size={15} className="mt-0.5 text-ink-faint" />
                <p className="max-w-prose text-small text-ink-dim">{simulation.unavailable}</p>
              </div>
            )}

            {simulation?.ok && (
              <div className="mt-4 border-t border-line pt-4">
                <p className="text-heading font-semibold text-ink">{simulation.summary}</p>
                <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div className="rounded-control bg-ground-2/60 px-3 py-2.5">
                    <dt className="eyebrow">Runs affected</dt>
                    <dd className="mt-1 text-heading font-semibold text-ink">
                      {simulation.affectedRuns}
                    </dd>
                  </div>
                  <div className="rounded-control bg-ground-2/60 px-3 py-2.5">
                    <dt className="eyebrow">Each run</dt>
                    <dd className="mt-1 flex items-center gap-1.5 text-heading font-semibold text-ink">
                      <span className="text-ink-dim">
                        {formatUsd(simulation.currentPerRunUsd ?? 0)}
                      </span>
                      <Icon name="arrow-right" size={14} className="text-ink-faint" />
                      {formatUsd(simulation.projectedPerRunUsd ?? 0)}
                    </dd>
                  </div>
                  <div className="rounded-control bg-ground-2/60 px-3 py-2.5">
                    <dt className="eyebrow">Each month</dt>
                    <dd className="mt-1 flex items-center gap-1.5 text-heading font-semibold text-ink">
                      <span className="text-ink-dim">
                        {formatUsd(simulation.currentMonthlyUsd ?? 0)}
                      </span>
                      <Icon name="arrow-right" size={14} className="text-ink-faint" />
                      {formatUsd(simulation.projectedMonthlyUsd ?? 0)}
                    </dd>
                  </div>
                </dl>
                <p className="mt-3 max-w-prose text-caption text-ink-faint">
                  {simulation.verdictDelta === null
                    ? "Nothing has scored both models, so the quality effect is unmeasured — not zero."
                    : `Measured across ${simulation.verdictSamples} Verdict score${simulation.verdictSamples === 1 ? "" : "s"}.`}{" "}
                  Both figures come from runs this machine actually made; Argus never estimates from
                  a published price list.
                </p>
              </div>
            )}
          </Card>
        </Section>
      )}
    </>
  );
}
