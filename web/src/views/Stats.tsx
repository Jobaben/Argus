import { useMemo } from "react";
import {
  useStats,
  type DailyStat,
  type ModelStat,
  type PeakHour,
} from "../useStats";

function compact(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n}`;
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="text-xs uppercase tracking-wide text-white/40">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-white/30">{hint}</div>}
    </div>
  );
}

function ModelRow({ model, max }: { model: ModelStat; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((model.totalTokens / max) * 100)) : 0;
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-mono text-sm text-white">{shortModel(model.model)}</span>
        <span className="shrink-0 text-sm font-semibold text-sky-300">
          {compact(model.totalTokens)} tok
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-sky-400/70" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/45">
        <span>in {compact(model.inputTokens)}</span>
        <span className="text-emerald-300/70">out {compact(model.outputTokens)}</span>
        <span>cache rd {compact(model.cacheReadTokens)}</span>
        <span>cache cr {compact(model.cacheCreationTokens)}</span>
        {model.webSearchRequests > 0 && (
          <span className="text-amber-300/70">{model.webSearchRequests} web</span>
        )}
      </div>
    </div>
  );
}

function DailyRow({ day, max }: { day: DailyStat; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((day.tokens / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5 text-xs">
      <span className="w-24 shrink-0 font-mono text-white/55">{day.date}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-emerald-400/60" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-16 shrink-0 text-right text-white/55">{compact(day.tokens)}</span>
      <span className="w-20 shrink-0 text-right text-white/40">{day.messages} msgs</span>
    </div>
  );
}

function HourBar({ peak, max }: { peak: PeakHour; max: number }) {
  const h = max > 0 ? Math.max(4, Math.round((peak.count / max) * 100)) : 0;
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <div className="flex h-24 w-full items-end">
        <div
          className="w-full rounded-t bg-amber-400/60"
          style={{ height: `${h}%` }}
          title={`${peak.count} sessions`}
        />
      </div>
      <span className="text-[10px] text-white/35">{peak.hour}</span>
    </div>
  );
}

export default function Stats() {
  const { stats, loading, error } = useStats();

  const maxModelTokens = useMemo(
    () => (stats ? Math.max(0, ...stats.models.map((m) => m.totalTokens)) : 0),
    [stats],
  );
  const recentDaily = useMemo(() => {
    if (!stats) return [];
    return [...stats.daily].slice(-30).reverse();
  }, [stats]);
  const maxDailyTokens = useMemo(
    () => Math.max(0, ...recentDaily.map((d) => d.tokens)),
    [recentDaily],
  );
  const maxHour = useMemo(
    () => (stats ? Math.max(0, ...stats.peakHours.map((p) => p.count)) : 0),
    [stats],
  );

  return (
    <div>
      <header className="mb-6">
        <h2 className="text-2xl font-bold text-white">Usage stats</h2>
        <p className="mt-1 text-sm text-white/45">
          Aggregate Claude Code usage across all projects
          {stats?.lastComputedDate && (
            <span className="text-white/30"> · computed {stats.lastComputedDate}</span>
          )}
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          Couldn’t reach the Argus server: {error}
        </div>
      )}

      {loading ? (
        <p className="text-white/40">Loading stats…</p>
      ) : !stats || !stats.available ? (
        <div className="rounded-xl border border-dashed border-white/15 px-6 py-16 text-center text-white/40">
          No usage stats found yet.
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Sessions" value={compact(stats.headline.totalSessions)} />
            <Stat label="Messages" value={compact(stats.headline.totalMessages)} />
            <Stat label="Tool calls" value={compact(stats.headline.totalToolCalls)} />
            <Stat label="Total tokens" value={compact(stats.headline.totalTokens)} />
            <Stat
              label="Output tokens"
              value={compact(stats.headline.totalOutputTokens)}
            />
            <Stat
              label="Cache reads"
              value={compact(stats.headline.totalCacheReadTokens)}
            />
            <Stat label="Active days" value={`${stats.headline.activeDays}`} />
            <Stat label="Models used" value={`${stats.headline.modelsUsed}`} />
          </section>

          {(stats.headline.totalCostUSD > 0 || stats.longestSession) && (
            <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {stats.headline.totalCostUSD > 0 && (
                <Stat
                  label="Total cost"
                  value={`$${stats.headline.totalCostUSD.toFixed(2)}`}
                />
              )}
              {stats.longestSession && (
                <Stat
                  label="Longest session"
                  value={fmtDuration(stats.longestSession.durationMs)}
                  hint={`${stats.longestSession.messageCount} msgs`}
                />
              )}
              {stats.firstSessionDate && (
                <Stat
                  label="First session"
                  value={new Date(stats.firstSessionDate).toLocaleDateString()}
                />
              )}
            </section>
          )}

          {stats.models.length > 0 && (
            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/40">
                By model
              </h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {stats.models.map((m) => (
                  <ModelRow key={m.model} model={m} max={maxModelTokens} />
                ))}
              </div>
            </section>
          )}

          {stats.peakHours.length > 0 && (
            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/40">
                Activity by hour
              </h3>
              <div className="flex items-end gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-4">
                {stats.peakHours.map((p) => (
                  <HourBar key={p.hour} peak={p} max={maxHour} />
                ))}
              </div>
            </section>
          )}

          {recentDaily.length > 0 && (
            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/40">
                Recent daily activity
              </h3>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                {recentDaily.map((d) => (
                  <DailyRow key={d.date} day={d} max={maxDailyTokens} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
