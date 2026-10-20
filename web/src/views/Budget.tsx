import { useId, useState, type KeyboardEvent } from "react";
import { useMachineFacet } from "../fleet/useMachineFacet";
import { MachinePicker, PeerBanner } from "../fleet/MachineFacet";
import { useBudget } from "../useBudget";
import type { BudgetConfig, BudgetDay, BudgetState, BudgetWindow } from "../types";
import {
  AlertStrip,
  Button,
  Card,
  EmptyState,
  formatUsd,
  Handoff,
  Icon,
  InfoTip,
  Page,
  Section,
  SkeletonTile,
  fieldClass,
  labelClass,
  useClock,
} from "../ds";
import { LedgerPanels } from "./LedgerPanels";

/** Where the budget's alerts fire, as a share of a limit. Drawn on each meter
 *  as a tick, so "approaching" has a place on the bar and not only a word. */
const ALERT_AT = 0.8;

// The state, in the anatomy of `StatusPill`. The words are lower-case in the
// DOM (the server's vocabulary, which the tests pin) and set in sentence case by
// `first-letter:uppercase`, like every other pill in the app.
const STATE_PILL: Record<BudgetState, { label: string; cls: string }> = {
  unset: { label: "no limits set", cls: "border-line-strong bg-ink-faint/8 text-ink-dim" },
  ok: { label: "under budget", cls: "border-ok/25 bg-ok/10 text-ok" },
  warning: { label: "approaching limit", cls: "border-run/30 bg-run/10 text-run" },
  exceeded: { label: "over budget", cls: "border-fail/35 bg-fail/12 text-fail" },
};

type Severity = "ok" | "run" | "fail";

function severity(ratio: number | null): Severity | null {
  if (ratio === null) return null;
  if (ratio >= 1) return "fail";
  if (ratio >= ALERT_AT) return "run";
  return "ok";
}

const FILL: Record<Severity, string> = { ok: "bg-ok/80", run: "bg-run", fail: "bg-fail" };

function StatePill({ state }: { state: BudgetState }) {
  const { label, cls } = STATE_PILL[state];
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-caption font-semibold leading-none ${cls}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span className="inline-block first-letter:uppercase">{label}</span>
    </span>
  );
}

function shortDate(iso: string): string {
  // Ledger days are local calendar days; parse them as local midnight so the
  // label does not slide to the previous day west of UTC.
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * One spend window as a meter: the figure, the ceiling it is measured against,
 * and a bar that says how far along it is, with the 80% alert threshold marked
 * on it.
 *
 * Where the month is heading is the Forecast's job, directly below, and only
 * there: a second month-end figure here would sooner or later disagree with it.
 */
function WindowCard({
  label,
  window: w,
  limitName,
  onSetLimit,
}: {
  label: string;
  window: BudgetWindow;
  /** The ceiling this window is measured against, for the "set one" action. */
  limitName: "daily" | "monthly";
  /** Offered when there is no limit and this machine can set one. */
  onSetLimit?: () => void;
}) {
  const tone = severity(w.ratio);
  const pct = w.ratio === null ? 0 : Math.min(1, w.ratio) * 100;
  return (
    <Card className="relative overflow-hidden">
      {tone && tone !== "ok" && (
        <span
          aria-hidden="true"
          className={`absolute inset-y-3 left-0 w-[3px] rounded-r-full ${tone === "fail" ? "bg-fail" : "bg-run"}`}
        />
      )}
      {/* A fixed height, so a meter with a "% used" caption and one without
          put their figures on the same line. */}
      <div className="flex h-5 items-center justify-between gap-3">
        <h2 className="eyebrow">{label}</h2>
        {w.ratio != null && (
          <span
            className={`text-caption font-semibold leading-none ${
              tone === "fail" ? "text-fail" : tone === "run" ? "text-run" : "text-ink-dim"
            }`}
          >
            {Math.round(w.ratio * 100)}% used
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-display font-semibold text-ink">{formatUsd(w.spentUsd)}</span>
        <span className="text-small text-ink-faint">
          {w.limitUsd != null ? `of ${formatUsd(w.limitUsd)} limit` : "no limit set"}
        </span>
      </div>

      {w.limitUsd != null ? (
        <>
          <div className="relative mt-4 h-2 rounded-full bg-ground-2" aria-hidden="true">
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--duration-slow) ease-(--ease-out-expo) ${
                tone ? FILL[tone] : "bg-line"
              }`}
              style={{ width: `${pct}%` }}
            />
            <span
              className="absolute -inset-y-1 w-px bg-ink-faint/70"
              style={{ left: `${ALERT_AT * 100}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-caption">
            <span className={tone === "fail" ? "font-semibold text-fail-ink" : "text-ink-dim"}>
              {w.ratio != null && w.ratio >= 1
                ? `${formatUsd(w.spentUsd - w.limitUsd)} over`
                : `${formatUsd(Math.max(0, w.limitUsd - w.spentUsd))} remaining`}
            </span>
            <span className="text-ink-faint">Alerts at {ALERT_AT * 100}%</span>
          </div>
        </>
      ) : (
        <div className="mt-4 flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-control bg-ground-2/60 px-3 py-1.5">
          <span className="text-caption text-ink-faint">
            {onSetLimit
              ? "Nothing to measure against, so no alerts fire."
              : "No ceiling is set on that machine."}
          </span>
          {onSetLimit && (
            <Button size="sm" variant="ghost" icon="plus" onClick={onSetLimit}>
              Set a {limitName} limit
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * Rounds a chart's ceiling up to a figure an axis can be labelled with — and
 * whose half is one too, since the axis also marks the midpoint: 25 would put
 * "$12.5" there, so the steps skip it.
 */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const step = [1, 2, 3, 4, 5, 6, 8, 10].find((s) => f <= s) ?? 10;
  return step * exp;
}

function axisUsd(v: number): string {
  if (v === 0) return "$0";
  if (v >= 1) return `$${Number(v.toFixed(1))}`;
  return `$${Number(v.toFixed(3))}`;
}

/**
 * The daily ledger as columns, with the two facts a reader is actually looking
 * for marked rather than left in tooltips: which days broke the daily limit,
 * and where the limit sits relative to the peak.
 *
 * Hovering a column — or arrowing through them with the plot focused — reads
 * that day out in the header; at rest the header holds the window's total.
 * Each column also keeps its full sentence as a `title`, for the pointer that
 * lingers and for the record. The header is only a live region while the plot
 * has focus: a pointer sweeping across the bars should not narrate thirty days.
 */
function SpendChart({ days, dailyLimit }: { days: BudgetDay[]; dailyLimit: number | null }) {
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const peak = Math.max(...days.map((d) => d.usd), 0);
  if (peak === 0) {
    return (
      <EmptyState compact icon="coin" title="No spend in the last 30 days">
        Costs land here as runs report them — a scheduled firing, a pipeline phase or a Launch, any
        of which the CLI prices in its result envelope.
      </EmptyState>
    );
  }
  // A zero or absent ceiling is not a ceiling; collapse both to null once.
  const limit = dailyLimit != null && dailyLimit > 0 ? dailyLimit : null;
  // The limit joins the scale when it is near enough to the peak to say
  // something about headroom; a ceiling ten times the busiest day would only
  // squash the bars into the baseline, so it is stated in words instead.
  const limitOnScale = limit !== null && limit <= peak * 1.5;
  const top = niceCeil(limitOnScale ? Math.max(peak, limit) : peak);
  const ticks = [0, top / 2, top];
  const over = limit === null ? [] : days.filter((d) => d.usd > limit);
  const total = days.reduce((n, d) => n + d.usd, 0);
  const peakDay = days.reduce((a, d) => (d.usd > a.usd ? d : a), days[0]);
  const lastIndex = days.length - 1;
  // Five dates along the bottom: the first, one a week, and the last.
  const labelled = new Set([0, 7, 14, 21, lastIndex].filter((i) => i <= lastIndex));
  const shown = active === null ? null : days[active];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    setActive((i) =>
      Math.max(0, Math.min(lastIndex, (i ?? lastIndex + (step > 0 ? -1 : 1)) + step)),
    );
  };

  return (
    <div className="rounded-tile border border-line bg-surface shadow-raised">
      <div
        className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-2.5"
        aria-live={focused ? "polite" : "off"}
      >
        {shown ? (
          <p className="text-small text-ink-dim">
            <strong className="font-semibold text-ink">{formatUsd(shown.usd)}</strong>{" "}
            {active === lastIndex
              ? `${shortDate(shown.date)} (today, so far)`
              : shortDate(shown.date)}{" "}
            · {shown.runs} run{shown.runs === 1 ? "" : "s"}
            {limit !== null && shown.usd > limit && (
              <span className="text-fail-ink"> · over the daily limit</span>
            )}
          </p>
        ) : (
          <p className="text-small text-ink-dim">
            <strong className="font-semibold text-ink">{formatUsd(total)}</strong> over{" "}
            {days.length} days · busiest {shortDate(peakDay.date)} at {formatUsd(peakDay.usd)}
          </p>
        )}
        {/* The legend: the dashed line's value, said here rather than drawn
            over the plot, where it would cover the newest bars. */}
        {limit !== null && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption">
            {limitOnScale ? (
              <span className="inline-flex items-center gap-1.5 text-ink-dim">
                <span aria-hidden="true" className="w-3 border-t border-dashed border-fail/70" />
                Daily limit {formatUsd(limit)}
              </span>
            ) : (
              <span className="text-ink-faint">
                Daily limit {formatUsd(limit)} — above every day shown
              </span>
            )}
            {over.length > 0 && (
              <span className="inline-flex items-center gap-1.5 font-semibold text-fail-ink">
                <span aria-hidden="true" className="h-2 w-2 rounded-sm bg-fail" />
                {over.length} {over.length === 1 ? "day" : "days"} over the daily limit
              </span>
            )}
          </div>
        )}
      </div>

      <div className="px-4 pb-3 pt-4">
        <div className="flex gap-2">
          {/* Y axis: three clean ticks, so the bars have values to be read against. */}
          <div className="relative h-36 w-9 shrink-0" aria-hidden="true">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute right-0 translate-y-1/2 text-micro text-ink-faint"
                style={{ bottom: `${(t / top) * 100}%` }}
              >
                {axisUsd(t)}
              </span>
            ))}
          </div>
          <div
            role="group"
            aria-label="Daily spend, last 30 days. Use the arrow keys to read each day."
            tabIndex={0}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              setActive(null);
            }}
            onMouseLeave={() => setActive(null)}
            className="relative h-36 min-w-0 flex-1 rounded-sm focus-visible:outline-offset-4"
          >
            {ticks.map((t) => (
              <div
                key={t}
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 border-t ${t === 0 ? "border-line-strong" : "border-line"}`}
                style={{ bottom: `${(t / top) * 100}%` }}
              />
            ))}
            {limitOnScale && limit !== null && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-fail/55"
                style={{ bottom: `${(limit / top) * 100}%` }}
              />
            )}
            <div className="absolute inset-0 flex items-end gap-0.5">
              {days.map((d, i) => {
                const broke = limit !== null && d.usd > limit;
                // The ledger's last day is always today, and today is only partly
                // over — worth marking so a low final bar doesn't read as a quiet day.
                const isToday = i === lastIndex;
                const on = active === i;
                return (
                  <div
                    key={d.date}
                    data-bar=""
                    onMouseEnter={() => setActive(i)}
                    title={`${isToday ? "Today, " : ""}${d.date} · ${formatUsd(d.usd)} · ${d.runs} run${
                      d.runs === 1 ? "" : "s"
                    }${broke ? " · over the daily limit" : ""}`}
                    className="flex h-full min-w-0 flex-1 cursor-default items-end justify-center"
                  >
                    <div
                      className={`w-full max-w-6 rounded-t-[4px] transition-colors duration-(--duration-quick) ${
                        broke
                          ? on
                            ? "bg-fail"
                            : "bg-fail/75"
                          : on
                            ? "bg-ink"
                            : isToday
                              ? "bg-ink-dim/80"
                              : "bg-ink-faint/55"
                      }`}
                      style={{
                        height: d.usd === 0 ? "2px" : `${Math.max(2, (d.usd / top) * 100)}%`,
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        {/* X axis: positioned at the centre of each labelled column. */}
        <div className="relative ml-11 mt-2 h-4" aria-hidden="true">
          {days.map((d, i) =>
            labelled.has(i) ? (
              <span
                key={d.date}
                className={`absolute whitespace-nowrap text-micro ${
                  i === lastIndex ? "text-ink-dim" : "text-ink-faint"
                } ${i === 0 ? "" : i === lastIndex ? "-translate-x-full" : "-translate-x-1/2"}`}
                style={{
                  left:
                    i === 0
                      ? "0%"
                      : i === lastIndex
                        ? "100%"
                        : `${((i + 0.5) / days.length) * 100}%`,
                }}
              >
                {shortDate(d.date)}
              </span>
            ) : null,
          )}
        </div>
      </div>
    </div>
  );
}

const LIMIT_FIELDS = { daily: "budget-daily-limit", monthly: "budget-monthly-limit" } as const;

/** Moves the reader from a meter that has no ceiling to the field that sets it. */
function focusLimit(which: keyof typeof LIMIT_FIELDS) {
  const el = document.getElementById(LIMIT_FIELDS[which]);
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.focus({ preventScroll: true });
}

function LimitField({
  id,
  label,
  value,
  placeholder,
  invalid,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  invalid: boolean;
  onChange: (v: string) => void;
}) {
  const hint = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <div className="relative">
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-small text-ink-faint"
        >
          $
        </span>
        <input
          id={id}
          className={`${fieldClass} h-9 w-full pl-6`}
          inputMode="decimal"
          placeholder={placeholder}
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={hint}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
      <p id={hint} className="text-caption text-ink-faint">
        USD. Leave empty for no limit.
      </p>
    </div>
  );
}

function BudgetForm({
  initial,
  onSave,
}: {
  initial: BudgetConfig;
  onSave: (patch: Partial<BudgetConfig>) => Promise<void>;
}) {
  // Seeded from the server config at first render; afterwards the user owns it.
  const [daily, setDaily] = useState(initial.dailyUsd != null ? String(initial.dailyUsd) : "");
  const [monthly, setMonthly] = useState(
    initial.monthlyUsd != null ? String(initial.monthlyUsd) : "",
  );
  const [block, setBlock] = useState(initial.blockScheduled);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const parseLimit = (v: string): number | null | undefined => {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined; // undefined = invalid
  };

  const dailyVal = parseLimit(daily);
  const monthlyVal = parseLimit(monthly);
  const valid = dailyVal !== undefined && monthlyVal !== undefined;

  const submit = async () => {
    setBusy(true);
    setSaveErr(null);
    setSaved(false);
    try {
      await onSave({
        dailyUsd: dailyVal ?? null,
        monthlyUsd: monthlyVal ?? null,
        blockScheduled: block,
      });
      setSaved(true);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void submit();
        }}
      >
        {saveErr && <AlertStrip subject="Couldn't save the budget" message={saveErr} />}
        <p className="text-small text-ink-dim">
          Alerts fire at {ALERT_AT * 100}% of a limit and again at the limit. Manual actions — Run
          now, One-off, pipeline starts — are never blocked.
        </p>
        {/* The two ceilings and what happens at them, side by side on a wide
            screen: one decision, read in one line. */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)] xl:items-start">
          <LimitField
            id={LIMIT_FIELDS.daily}
            label="Daily limit"
            placeholder="10"
            value={daily}
            invalid={dailyVal === undefined}
            onChange={setDaily}
          />
          <LimitField
            id={LIMIT_FIELDS.monthly}
            label="Monthly limit"
            placeholder="200"
            value={monthly}
            invalid={monthlyVal === undefined}
            onChange={setMonthly}
          />
          <label className="flex cursor-pointer items-start gap-3 rounded-control bg-ground-2/60 px-3 py-3 sm:col-span-2 xl:col-span-1">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-eye"
              checked={block}
              onChange={(e) => setBlock(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-small font-semibold text-ink">
                Pause scheduled runs while over budget
              </span>
              <span className="mt-0.5 block text-caption text-ink-faint">
                Due slots are skipped (visible in the Scheduler as "skipped: spend budget exceeded")
                until spend drops back under every limit — a new day or month, or a raised ceiling.
                Alerts fire either way.
              </span>
            </span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-4">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !valid}
            aria-busy={busy || undefined}
            title={!valid ? "Limits must be positive numbers (or empty)" : undefined}
          >
            {busy ? "Saving…" : "Save budget"}
          </Button>
          {saved && (
            <span className="inline-flex items-center gap-1.5 text-caption font-semibold text-ok">
              <Icon name="check" size={14} />
              Saved.
            </span>
          )}
          {!valid && (
            <span className="text-caption text-fail-ink">
              A limit has to be a positive number, or empty for none.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

/**
 * A peer's budget position, from its summary.
 *
 * Read-only, and the limits form is deliberately absent: a limit is enforced by
 * the machine that holds it, so editing it from here would either not work or
 * would need a whole second write path across the pairing. Naming the machine
 * and linking to it is the honest answer.
 */
function PeerBudget({ facet }: { facet: ReturnType<typeof useMachineFacet> }) {
  const summary = facet.peer?.summary;
  if (!summary) return null;
  const { budget } = summary.facets;
  const win = (spent: number, limit: number | null): BudgetWindow => ({
    spentUsd: spent,
    limitUsd: limit,
    ratio: limit != null && limit > 0 ? spent / limit : null,
  });
  return (
    <>
      <section className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <WindowCard
          label="Today"
          window={win(summary.spendTodayUsd, budget.dailyLimitUsd)}
          limitName="daily"
        />
        <WindowCard
          label="This month"
          window={win(summary.spendMonthUsd, budget.monthlyLimitUsd)}
          limitName="monthly"
        />
      </section>
      <p className="flex max-w-3xl items-start gap-2 text-small text-ink-dim">
        <Icon name="info" size={15} className="mt-0.5 text-ink-faint" />
        <span>
          Limits are enforced by the machine that holds them, so they are shown here and edited
          there. Attribution, the forecast and the what-if simulator read that machine&apos;s own
          run history — open its Argus for those.
        </span>
      </p>
    </>
  );
}

export default function Budget() {
  const facet = useMachineFacet();
  const { budget, loading, error, save } = useBudget();
  // The shared clock, so the projection's "days elapsed" rolls over at midnight
  // without reading the wall clock during render.
  const now = useClock();
  // In peer mode the pill describes the machine being shown, not this one. A
  // peer's state arrives as a plain string (it may run a newer Argus), so only
  // a word this page knows is trusted — an own key, so "toString" is not one.
  // Until the state is known there is no pill: "no limits set" while loading,
  // or after a failed load, would be a claim nobody has checked.
  const peerState = facet.peer?.summary?.facets.budget.state;
  const state: BudgetState | null = facet.peer
    ? peerState != null && Object.hasOwn(STATE_PILL, peerState)
      ? (peerState as BudgetState)
      : null
    : (budget?.status.state ?? null);

  return (
    <Page
      title="Budget"
      subtitle={
        <>
          What the runs Argus launches cost, and whether the month is on course.
          {/* On a line of its own at the left edge, so the explanation opens
              into the page at every width rather than off the side of a phone. */}
          <span className="mt-1 block">
            <InfoTip
              title="About the budget"
              trigger={<span className="text-caption text-ink-faint">How spend is counted</span>}
              footer={
                <>
                  This counts only what Argus launched. Your own interactive Claude Code sessions
                  are metered by the CLI itself and appear under{" "}
                  <a href="#/stats" className="font-semibold text-ink underline underline-offset-2">
                    Stats
                  </a>
                  .
                </>
              }
            >
              Argus spends money unattended — every scheduled, pipelined and one-off run reports
              what it cost, and it lands in a per-day ledger here. Claude Code reports dollars;
              Codex reports tokens only, so its runs contribute to the token totals and not to the
              USD ones. Set a daily or monthly USD ceiling to get alerted at 80% and at the limit;
              optionally pause scheduled firings while you&apos;re over.
            </InfoTip>
          </span>
        </>
      }
      actions={state ? <StatePill state={state} /> : undefined}
    >
      <MachinePicker facet={facet} label="Show budget from" />
      <PeerBanner facet={facet} />

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Budget" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}

      {facet.peer ? (
        <PeerBudget facet={facet} />
      ) : (
        <Handoff
          busy={loading && !budget}
          label="budget"
          skeleton={
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SkeletonTile lines={3} />
                <SkeletonTile lines={3} />
              </div>
              <div className="mt-10">
                <SkeletonTile lines={6} />
              </div>
            </>
          }
        >
          {budget ? (
            <>
              <section aria-label="Spend" className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <WindowCard
                  label="Today"
                  window={budget.status.today}
                  limitName="daily"
                  onSetLimit={() => focusLimit("daily")}
                />
                <WindowCard
                  label="This month"
                  window={budget.status.month}
                  limitName="monthly"
                  onSetLimit={() => focusLimit("monthly")}
                />
              </section>

              {/* The ledger's panels sit between the raw numbers and the
                  controls, in reading order: a policy acting right now, where
                  the month lands, the days behind it, where the money went, and
                  what a change would do — then the limits to act on it. */}
              <LedgerPanels
                month={budget.status.month}
                now={now}
                history={
                  <Section title="Last 30 days">
                    <SpendChart days={budget.days} dailyLimit={budget.config.dailyUsd} />
                  </Section>
                }
              />

              <Section title="Limits">
                <BudgetForm initial={budget.config} onSave={save} />
              </Section>
            </>
          ) : null}
        </Handoff>
      )}
    </Page>
  );
}
