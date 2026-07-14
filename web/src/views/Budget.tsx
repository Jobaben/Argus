import { useState } from "react";
import { useBudget } from "../useBudget";
import type { BudgetConfig, BudgetDay, BudgetState, BudgetWindow } from "../types";
import { AlertStrip, EmptyState, Page, formatUsd } from "../ds";

const FIELD =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder-ink-faint";
const LABEL = "block space-y-1 text-xs font-medium text-ink-dim";

const STATE_STYLE: Record<BudgetState, { label: string; cls: string }> = {
  unset: { label: "no limits set", cls: "bg-surface-2 text-ink-dim" },
  ok: { label: "under budget", cls: "bg-ok/15 text-ok ring-1 ring-ok/30" },
  warning: { label: "approaching limit", cls: "bg-run/15 text-run ring-1 ring-run/30" },
  exceeded: { label: "over budget", cls: "bg-fail/15 text-fail ring-1 ring-fail/30" },
};

function barTone(ratio: number | null): string {
  if (ratio === null) return "bg-line";
  if (ratio >= 1) return "bg-fail";
  if (ratio >= 0.8) return "bg-run";
  return "bg-ok";
}

function WindowCard({ label, window: w }: { label: string; window: BudgetWindow }) {
  const pct = w.ratio === null ? 0 : Math.min(1, w.ratio) * 100;
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-extrabold text-ink">{formatUsd(w.spentUsd)}</span>
        <span className="text-sm text-ink-faint">
          {w.limitUsd != null ? `of ${formatUsd(w.limitUsd)} limit` : "no limit set"}
        </span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-ground-2" aria-hidden="true">
        <div className={`h-full ${barTone(w.ratio)}`} style={{ width: `${pct}%` }} />
      </div>
      {w.limitUsd != null && (
        <p className="mt-2 text-xs text-ink-faint">
          {w.ratio != null && w.ratio >= 1
            ? `${formatUsd(w.spentUsd - w.limitUsd)} over`
            : `${formatUsd(Math.max(0, w.limitUsd - w.spentUsd))} remaining`}
          {w.ratio != null && ` · ${Math.round(w.ratio * 100)}%`}
        </p>
      )}
    </div>
  );
}

function SpendChart({ days }: { days: BudgetDay[] }) {
  const max = Math.max(...days.map((d) => d.usd), 0);
  if (max === 0) {
    return <EmptyState>No spend recorded in the last 30 days.</EmptyState>;
  }
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex h-28 items-end gap-1">
        {days.map((d) => (
          <div
            key={d.date}
            title={`${d.date} · ${formatUsd(d.usd)} · ${d.runs} run${d.runs === 1 ? "" : "s"}`}
            className="flex-1 rounded-t bg-eye/60 transition hover:bg-eye"
            style={{ height: `${d.usd === 0 ? 2 : Math.max(4, (d.usd / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-ink-faint">
        <span>{days[0]?.date}</span>
        <span>{days[days.length - 1]?.date}</span>
      </div>
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
    <div className="max-w-xl space-y-3 rounded-xl border border-line bg-surface p-5">
      {saveErr && <AlertStrip subject="Error" message={saveErr} />}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          <span>Daily limit (USD, empty = none)</span>
          <input
            className={FIELD}
            inputMode="decimal"
            placeholder="10"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
          />
        </label>
        <label className={LABEL}>
          <span>Monthly limit (USD, empty = none)</span>
          <input
            className={FIELD}
            inputMode="decimal"
            placeholder="200"
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
          />
        </label>
      </div>
      <label className="flex items-start gap-2 text-xs text-ink-dim">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={block}
          onChange={(e) => setBlock(e.target.checked)}
        />
        <span>
          <span className="font-medium">Pause scheduled runs while over budget</span>
          <span className="block text-ink-faint">
            Due slots are skipped (visible in the Scheduler as "skipped: spend budget exceeded")
            until spend drops back under every limit — a new day or month, or a raised ceiling.
            Alerts fire either way.
          </span>
        </span>
      </label>
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          disabled={busy || !valid}
          title={!valid ? "Limits must be positive numbers (or empty)" : undefined}
          onClick={submit}
          className="rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 transition hover:bg-ok/30 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save budget"}
        </button>
        {saved && <span className="text-xs text-ok">Saved.</span>}
      </div>
    </div>
  );
}

export default function Budget() {
  const { budget, loading, error, save } = useBudget();
  const state = budget?.status.state ?? "unset";

  return (
    <Page
      title="Budget"
      actions={
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATE_STYLE[state].cls}`}>
          {STATE_STYLE[state].label}
        </span>
      }
    >
      <p className="mb-6 max-w-prose text-sm text-ink-dim">
        Argus spends money unattended — every scheduled, pipelined and one-off{" "}
        <span className="font-mono">claude -p</span> run reports its cost, and it lands in a per-day
        ledger here. Set a daily or monthly USD ceiling to get alerted at 80% and at the limit;
        optionally pause scheduled firings while you're over. Manual actions (Run now, Launch,
        pipeline starts) are never blocked.
      </p>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}

      {loading && !budget ? (
        <p className="text-ink-faint">Loading budget…</p>
      ) : budget ? (
        <>
          <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <WindowCard label="Today" window={budget.status.today} />
            <WindowCard label="This month" window={budget.status.month} />
          </section>

          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-dim">
            Last 30 days
          </h2>
          <div className="mb-8">
            <SpendChart days={budget.days} />
          </div>

          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-dim">
            Limits
          </h2>
          <BudgetForm initial={budget.config} onSave={save} />
        </>
      ) : null}
    </Page>
  );
}
