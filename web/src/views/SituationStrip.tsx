import type { Situation, ThroughputBucket } from "../types";
import { Skeleton, formatCountdown, formatUsd, useCountUp, useTicker } from "../ds";

/**
 * The one-line answer to "does anything need me?"
 *
 * The board below it is legible per-pipeline but silent in aggregate: you had to
 * scan every card to notice a waiting gate, and visit two other tabs to learn
 * whether monitors were down or the day's spend was near its limit. This strip
 * puts all of it above the board, and — critically — **only shows what is
 * true**: a metric with nothing to report is omitted rather than rendered as a
 * grey zero, so anything visible here is worth reading.
 */

const TONE = {
  attention: {
    text: "text-await",
    border: "border-await/40",
    bg: "bg-await/10",
  },
  bad: { text: "text-fail", border: "border-fail/40", bg: "bg-fail/10" },
  busy: { text: "text-run", border: "border-run/35", bg: "bg-run/10" },
  live: { text: "text-eye", border: "border-eye/35", bg: "bg-eye/10" },
  calm: { text: "text-ink-dim", border: "border-line", bg: "bg-transparent" },
} as const;

type Tone = keyof typeof TONE;

function Stat({
  count,
  label,
  tone,
  href,
}: {
  count: number;
  label: string;
  tone: Tone;
  href: string;
}) {
  const shown = useCountUp(count);
  const skin = TONE[tone];
  return (
    <a
      href={href}
      className={`flex items-baseline gap-1.5 rounded-md border px-2.5 py-1 transition duration-(--duration-quick) hover:brightness-125 ${skin.border} ${skin.bg}`}
    >
      <span className={`text-[15px] font-extrabold leading-none ${skin.text}`}>
        {Math.round(shown)}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </span>
    </a>
  );
}

/**
 * Countdown to the next firing, re-rendered on its own 1s clock.
 *
 * Local because the alternative is re-fetching the whole strip every second to
 * make one label tick.
 */
function NextFire({ at, name, kind }: { at: string; name: string; kind: string }) {
  const now = useTicker();
  const ms = new Date(at).getTime() - now;
  return (
    <span
      className="flex min-w-0 items-baseline gap-1.5"
      title={`Next ${kind}: ${name} at ${new Date(at).toLocaleString()}`}
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">next</span>
      <span className="truncate text-[13px] text-ink-dim">{name}</span>
      <span className="shrink-0 font-mono text-[11px] text-ink">{formatCountdown(ms)}</span>
    </span>
  );
}

/** Spend today against the daily limit, as a bar you can read without numbers. */
function SpendMeter({ spend }: { spend: Situation["spend"] }) {
  const { today, state } = spend;
  const ratio = today.ratio;
  const pct = ratio === null ? null : Math.min(100, Math.round(ratio * 100));
  const tone =
    state === "exceeded"
      ? "bg-fail"
      : state === "warning"
        ? "bg-run"
        : ratio === null
          ? "bg-ink-faint/40"
          : "bg-ok";

  return (
    <span
      className="flex items-center gap-2"
      title={
        today.limitUsd === null
          ? "Spent today. No daily limit set — set one in the Budget tab."
          : `Spent ${formatUsd(today.spentUsd)} of the ${formatUsd(today.limitUsd)} daily limit`
      }
    >
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        today
      </span>
      <span className="font-mono text-[12px] text-ink">{formatUsd(today.spentUsd)}</span>
      {today.limitUsd !== null && (
        <>
          <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-ink-faint/15">
            <span
              className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--duration-slow) ${tone}`}
              style={{ width: `${pct ?? 0}%` }}
            />
          </span>
          <span className="font-mono text-[10px] text-ink-faint">
            of {formatUsd(today.limitUsd)}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * 24h run outcomes as stacked bars.
 *
 * Bars rather than a line: the quantity is a count per hour, and a line implies
 * a continuous signal between samples that does not exist. Failures stack on top
 * of successes so a bad hour is visible by colour at a glance.
 */
function Throughput({ buckets }: { buckets: ThroughputBucket[] }) {
  const peak = Math.max(1, ...buckets.map((b) => b.succeeded + b.failed));
  const totals = buckets.reduce(
    (acc, b) => ({ ok: acc.ok + b.succeeded, bad: acc.bad + b.failed }),
    { ok: 0, bad: 0 },
  );
  return (
    <span
      className="flex items-end gap-[2px]"
      role="img"
      aria-label={`Last 24 hours: ${totals.ok} succeeded, ${totals.bad} failed`}
      title={`Last 24 hours — ${totals.ok} succeeded, ${totals.bad} failed`}
    >
      {buckets.map((bucket) => {
        const total = bucket.succeeded + bucket.failed;
        const height = total === 0 ? 2 : Math.max(3, Math.round((total / peak) * 20));
        const failedShare = total === 0 ? 0 : bucket.failed / total;
        return (
          <span
            key={bucket.at}
            className="flex w-[3px] flex-col justify-end overflow-hidden rounded-[1px]"
            style={{ height: 20 }}
          >
            {total === 0 ? (
              <span className="h-[2px] w-full bg-ink-faint/20" />
            ) : (
              <>
                <span
                  className="w-full bg-fail"
                  style={{ height: `${Math.round(failedShare * height)}px` }}
                />
                <span
                  className="w-full bg-ok/70"
                  style={{ height: `${height - Math.round(failedShare * height)}px` }}
                />
              </>
            )}
          </span>
        );
      })}
    </span>
  );
}

export function SituationStrip({
  situation,
  loading,
}: {
  situation: Situation | null;
  loading: boolean;
}) {
  if (loading && !situation) {
    return (
      <div
        role="status"
        aria-busy="true"
        className="mb-4 flex items-center gap-3 rounded-tile border border-line bg-ground-2 px-4 py-2.5"
      >
        <span className="sr-only">Loading the board situation…</span>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="ml-auto h-5 w-40" />
      </div>
    );
  }
  if (!situation) return null;

  const c = situation.counts;
  // Only what is true: a zero here would be noise competing with the numbers
  // that matter.
  const stats: { count: number; label: string; tone: Tone; href: string }[] = (
    [
      { count: c.gatesWaiting, label: "awaiting you", tone: "attention", href: "#/command" },
      { count: c.failedInstances, label: "failed", tone: "bad", href: "#/command" },
      { count: c.runsInFlight, label: "running", tone: "busy", href: "#/launch" },
      { count: c.liveAgents, label: "live agents", tone: "live", href: "#/agents" },
      { count: c.monitorsDown, label: "down", tone: "bad", href: "#/monitors" },
      { count: c.monitorsFailing, label: "failing", tone: "bad", href: "#/monitors" },
      { count: c.openIssues, label: "open issues", tone: "attention", href: "#/issues" },
    ] satisfies { count: number; label: string; tone: Tone; href: string }[]
  ).filter((s) => s.count > 0);

  const allClear = stats.length === 0;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-tile border border-line bg-ground-2 px-4 py-2.5">
      {allClear ? (
        <span className="flex items-center gap-2 text-[13px] text-ink-dim">
          <span aria-hidden="true" className="text-ok">
            ●
          </span>
          Nothing needs you — no gates waiting, no failures, nothing running.
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {stats.map((s) => (
            <Stat key={s.label} {...s} />
          ))}
        </div>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
        {situation.nextFire && (
          <NextFire
            at={situation.nextFire.at}
            name={situation.nextFire.name}
            kind={situation.nextFire.kind}
          />
        )}
        <SpendMeter spend={situation.spend} />
        <Throughput buckets={situation.throughput} />
      </div>
    </div>
  );
}
