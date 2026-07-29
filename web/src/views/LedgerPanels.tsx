import { useState } from "react";
import { Card, EmptyState, Section, formatTokens, formatUsd } from "../ds";
import { useLedger } from "../useLedger";
import type { Attribution, BudgetAction, CostDimension, Forecast } from "../types";

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

function ShareBar({ share }: { share: number }) {
  return (
    <span
      aria-hidden="true"
      className="block h-1 rounded-full bg-eye/60 transition-[width] duration-(--duration-slow) ease-(--ease-out-expo)"
      style={{ width: `${Math.max(2, Math.round(share * 100))}%` }}
    />
  );
}

function AttributionTable({
  attribution,
  onSimulate,
}: {
  attribution: Attribution;
  onSimulate: (key: string, label: string) => void;
}) {
  if (attribution.slices.length === 0) {
    return (
      <EmptyState>
        No costed runs in this window yet. Cost attribution needs runs that reported a price — the
        CLI reports one per run, so a schedule that has never fired shows nothing here.
      </EmptyState>
    );
  }
  return (
    <>
      <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface">
        {attribution.slices.map((s) => (
          <li key={s.key} className="px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1 truncate text-sm text-ink" title={s.label}>
                {s.label}
              </span>
              <span className="shrink-0 font-mono text-sm font-bold text-ink">
                {formatUsd(s.usd)}
              </span>
              <span className="w-12 shrink-0 text-right font-mono text-[11px] text-ink-faint">
                {Math.round(s.share * 100)}%
              </span>
            </div>
            <div className="mt-1 flex items-center gap-3">
              <span className="min-w-0 flex-1">
                <ShareBar share={s.share} />
              </span>
              <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                {s.runs} run{s.runs === 1 ? "" : "s"} · {formatUsd(s.perRunUsd)} each ·{" "}
                {formatTokens(s.tokens)} tok
              </span>
              {s.key !== "__other__" && (
                <button
                  type="button"
                  onClick={() => onSimulate(s.key, s.label)}
                  className="shrink-0 font-mono text-[10px] uppercase tracking-[0.1em] text-eye hover:underline"
                >
                  what if…
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        {formatUsd(attribution.totalUsd)} across {attribution.runs} costed run
        {attribution.runs === 1 ? "" : "s"}
        {attribution.unattributedRuns > 0 &&
          ` · ${attribution.unattributedRuns} outside this grouping`}
      </p>
    </>
  );
}

function ForecastPanel({ forecast }: { forecast: Forecast }) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-faint">
          Month end
        </span>
        <span
          className={`font-mono text-2xl font-extrabold ${forecast.overLimit ? "text-fail" : "text-ink"}`}
        >
          {forecast.monthEndUsd == null ? "—" : formatUsd(forecast.monthEndUsd)}
        </span>
        {forecast.lowUsd != null && forecast.highUsd != null && (
          <span className="font-mono text-xs text-ink-faint">
            band {formatUsd(forecast.lowUsd)} – {formatUsd(forecast.highUsd)}
          </span>
        )}
        {forecast.confidence != null && (
          <span
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint"
            title="Derived from how tight the daily history is — an erratic month projects less well"
          >
            {Math.round(forecast.confidence * 100)}% confidence
          </span>
        )}
      </div>
      <p className="mt-2 max-w-prose text-sm text-ink-dim">{forecast.note}</p>
      {forecast.dailyUsd != null && (
        <p className="mt-1 font-mono text-[10px] text-ink-faint">
          {formatUsd(forecast.dailyUsd)}/day median over {forecast.samples} full days ·{" "}
          {formatUsd(forecast.monthToDateUsd)} so far this month
        </p>
      )}
    </Card>
  );
}

export function LedgerPanels() {
  const { report, loading, simulation, simulating, simError, simulate } = useLedger();
  const [dimension, setDimension] = useState<CostDimension>("schedule");
  const [target, setTarget] = useState<{ key: string; label: string } | null>(null);
  const [toModel, setToModel] = useState("haiku");

  const active = DIMENSIONS.find((d) => d.key === dimension)!;
  const attribution = active.pick(report);

  return (
    <>
      {/* The forecast moves on a poll and the simulator answers asynchronously;
          both need to reach a reader who is not watching the pixels. */}
      <div aria-live="polite" role="status" className="sr-only">
        {report.forecast.note}
        {simulation?.ok ? ` ${simulation.summary}` : simulation?.unavailable}
      </div>

      <Section title="Forecast">
        <ForecastPanel forecast={report.forecast} />
      </Section>

      {report.enforcement.action && (
        <Section title="Budget policy in force">
          <Card className="border-await/40">
            <p className="text-sm text-ink">
              <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-await">
                {report.enforcement.action}
              </span>{" "}
              — {ACTION_COPY[report.enforcement.action]}
            </p>
            <p className="mt-1 font-mono text-[11px] text-ink-faint">
              {report.enforcement.detail}. Every affected run records this on its own record, so a
              cheap or missing run stays explicable later.
            </p>
          </Card>
        </Section>
      )}

      <Section title={`Where it went · last ${report.windowDays} days`}>
        <div
          role="radiogroup"
          aria-label="Group spend by"
          className="mb-3 inline-flex items-center gap-0.5 rounded-lg border border-line bg-ground-2 p-0.5"
        >
          {DIMENSIONS.map((d) => (
            <button
              key={d.key}
              type="button"
              role="radio"
              aria-checked={d.key === dimension}
              onClick={() => setDimension(d.key)}
              className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] transition ${
                d.key === dimension ? "bg-surface-2 text-ink" : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
        {loading && attribution.slices.length === 0 ? (
          <EmptyState>Reading the run history…</EmptyState>
        ) : (
          <AttributionTable
            attribution={attribution}
            onSimulate={(key, label) => setTarget({ key, label })}
          />
        )}
      </Section>

      {target && (
        <Section title="What if…">
          <Card>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void simulate({ dimension, key: target.key, toModel });
              }}
            >
              <p className="text-sm text-ink">
                Move <strong className="font-semibold">{target.label}</strong> to
              </p>
              <label className="text-xs text-ink-dim">
                <span className="sr-only">Model to move it to</span>
                <input
                  value={toModel}
                  onChange={(e) => setToModel(e.target.value)}
                  placeholder="haiku"
                  className="w-32 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
                />
              </label>
              <button
                type="submit"
                disabled={simulating || !toModel.trim()}
                className="rounded-md border border-eye/40 bg-eye/10 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-eye transition hover:bg-eye/20 disabled:opacity-50"
              >
                {simulating ? "Working…" : "Simulate"}
              </button>
              <button
                type="button"
                onClick={() => setTarget(null)}
                className="font-mono text-[11px] uppercase tracking-[0.1em] text-ink-faint hover:text-ink"
              >
                Close
              </button>
            </form>

            {simError && (
              <p role="alert" className="mt-2 text-sm text-fail">
                {simError}
              </p>
            )}

            {simulation && !simulation.ok && (
              <p className="mt-3 max-w-prose text-sm text-ink-dim">{simulation.unavailable}</p>
            )}

            {simulation?.ok && (
              <div className="mt-3">
                <p className="text-sm font-semibold text-ink">{simulation.summary}</p>
                <p className="mt-1 font-mono text-[11px] text-ink-faint">
                  {simulation.affectedRuns} run{simulation.affectedRuns === 1 ? "" : "s"} ·{" "}
                  {formatUsd(simulation.currentPerRunUsd ?? 0)} →{" "}
                  {formatUsd(simulation.projectedPerRunUsd ?? 0)} each ·{" "}
                  {formatUsd(simulation.currentMonthlyUsd ?? 0)} →{" "}
                  {formatUsd(simulation.projectedMonthlyUsd ?? 0)} per month
                </p>
                <p className="mt-1 max-w-prose text-[11px] text-ink-faint">
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
