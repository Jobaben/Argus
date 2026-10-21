import type { Situation, ThroughputBucket } from "../types";
import { Icon, Skeleton, formatCountdown, formatUsd, useCountUp, useTicker } from "../ds";

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
    border: "border-await/35 hover:border-await/60",
    bg: "bg-await/10",
  },
  bad: { text: "text-fail", border: "border-fail/35 hover:border-fail/60", bg: "bg-fail/10" },
  busy: { text: "text-run", border: "border-run/30 hover:border-run/55", bg: "bg-run/[0.07]" },
  live: { text: "text-eye", border: "border-eye/30 hover:border-eye/55", bg: "bg-eye/[0.07]" },
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
      className={`flex h-8 items-center gap-2 rounded-control border px-2.5 transition duration-(--duration-quick) motion-safe:active:scale-[0.97] ${skin.border} ${skin.bg}`}
    >
      <span className={`text-[15px] font-semibold leading-none ${skin.text}`}>
        {Math.round(shown)}
      </span>{" "}
      {/* The space is for the accessible name — "3 running", not "3running";
          a flex container draws nothing for it. */}
      <span className="text-small leading-none text-ink-dim">{label}</span>
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
      <Icon name="clock" size={14} className="shrink-0 self-center text-ink-faint" />
      {/* Said, not implied: a bare clock beside a schedule name read as
          "last ran", "running for" or "next" depending on who was looking. */}
      <span className="shrink-0 text-small text-ink-faint">next</span>
      <span className="truncate text-small text-ink-dim">{name}</span>
      <span className="shrink-0 text-small font-semibold text-ink">{formatCountdown(ms)}</span>
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
      <span className="text-small text-ink-faint">today</span>
      <span className="text-small font-semibold text-ink">{formatUsd(today.spentUsd)}</span>
      {today.limitUsd !== null && (
        <>
          <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-ink-faint/15">
            <span
              className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-(--duration-slow) ${tone}`}
              style={{ width: `${pct ?? 0}%` }}
            />
          </span>
          <span className="text-caption text-ink-faint">of {formatUsd(today.limitUsd)}</span>
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
        const height = total === 0 ? 2 : Math.max(3, Math.round((total / peak) * 22));
        const failedShare = total === 0 ? 0 : bucket.failed / total;
        return (
          <span
            key={bucket.at}
            className="flex w-1 flex-col justify-end overflow-hidden rounded-[1.5px]"
            style={{ height: 22 }}
          >
            {total === 0 ? (
              <span className="h-[2px] w-full bg-ink-faint/25" />
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

const noun = (n: number, one: string) => (n === 1 ? one : `${one}s`);

export function SituationStrip({
  situation,
  loading,
  attentionHref = "#/command",
  failedHref = "#/command",
}: {
  situation: Situation | null;
  loading: boolean;
  /**
   * Where "awaiting you" goes. The board passes the first waiting gate's deep
   * link, so the chip opens the review itself rather than linking to the page
   * it is already on.
   */
  attentionHref?: string;
  /** Where "failed" goes; the board passes the first failed instance's review. */
  failedHref?: string;
}) {
  if (loading && !situation) {
    return (
      <div
        role="status"
        aria-busy="true"
        // Shaped like what usually arrives: one row on a wide screen, and on a
        // phone the chips wrapping onto a second row above the telemetry line —
        // so the board below does not jump when the numbers land.
        className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-3 rounded-tile border border-line bg-surface px-4 py-3 shadow-raised"
      >
        <span className="sr-only">Loading the board situation…</span>
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-28 sm:hidden" />
        <Skeleton className="h-5 w-48 sm:ml-auto" />
      </div>
    );
  }
  if (!situation) return null;

  const c = situation.counts;
  // Two kinds of number, kept apart. The left asks something of you — a gate,
  // a failure, a monitor down; the right is the machine going about its work.
  // Only what is true is shown: a zero would be noise competing with the
  // numbers that matter, and the left side's silence is itself the message.
  // Each chip names its noun: "1 failed" beside "1 failing" in the same red
  // left a newcomer to work out that one was a pipeline and one a schedule.
  const attention: { count: number; label: string; tone: Tone; href: string }[] = (
    [
      { count: c.gatesWaiting, label: "awaiting you", tone: "attention", href: attentionHref },
      {
        count: c.failedInstances,
        label: `${noun(c.failedInstances, "pipeline")} failed`,
        tone: "bad",
        href: failedHref,
      },
      {
        count: c.monitorsDown,
        label: `${noun(c.monitorsDown, "monitor")} down`,
        tone: "bad",
        href: "#/health",
      },
      {
        count: c.monitorsFailing,
        label: `${noun(c.monitorsFailing, "schedule")} failing`,
        tone: "bad",
        href: "#/health",
      },
      {
        count: c.openIssues,
        label: `open ${noun(c.openIssues, "issue")}`,
        tone: "attention",
        href: "#/issues",
      },
      {
        count: c.anomalies,
        label: c.anomalies === 1 ? "anomaly" : "anomalies",
        tone: "attention",
        href: "#/health/watchtower",
      },
    ] satisfies { count: number; label: string; tone: Tone; href: string }[]
  ).filter((s) => s.count > 0);
  const activity: { count: number; label: string; tone: Tone; href: string }[] = (
    [
      { count: c.runsInFlight, label: "running", tone: "busy", href: "#/chronicle" },
      { count: c.liveAgents, label: "live agents", tone: "live", href: "#/agents" },
    ] satisfies { count: number; label: string; tone: Tone; href: string }[]
  ).filter((s) => s.count > 0);

  const calm = attention.length === 0;
  const idle = activity.length === 0;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-tile border border-line bg-surface px-4 py-3 shadow-raised">
      {calm ? (
        <span className="flex min-w-0 items-center gap-2.5 text-small text-ink-dim">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ok/12 text-ok">
            <Icon name="check" size={16} strokeWidth={2.25} />
          </span>
          <span>
            <b className="font-semibold text-ink">Nothing needs you</b> — no gates waiting, no
            failures{idle ? ", nothing running" : ""}.
          </span>
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {attention.map((s) => (
            <Stat key={s.label} {...s} />
          ))}
        </div>
      )}
      {!idle && (
        <div className="flex flex-wrap items-center gap-2">
          {activity.map((s) => (
            <Stat key={s.label} {...s} />
          ))}
        </div>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 sm:ml-auto">
        {situation.nextFire && (
          <NextFire
            at={situation.nextFire.at}
            name={situation.nextFire.name}
            kind={situation.nextFire.kind}
          />
        )}
        <SpendMeter spend={situation.spend} />
        {/* Twenty-four 4px bars: a desk-distance glance, not worth a row of a
            phone's height. */}
        <span className="hidden sm:contents">
          <Throughput buckets={situation.throughput} />
        </span>
      </div>
    </div>
  );
}
