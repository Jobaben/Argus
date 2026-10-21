import { useState } from "react";
import {
  AlertStrip,
  Button,
  ButtonLink,
  EmptyState,
  formatDuration,
  Handoff,
  HealthCounter,
  Skeleton,
  SkeletonGrid,
  TimeAgo,
  useClock,
  useFlip,
} from "../ds";
import type { ColorToken } from "../ds";
import { useMonitors } from "../useMonitors";
import type { MonitorHealth, MonitorStatus } from "../types";
import { HeartbeatBar } from "../ds/HeartbeatBar";

const PILL: Record<MonitorStatus, { label: string; token: ColorToken }> = {
  up: { label: "Up", token: "ok" },
  late: { label: "Late", token: "await" },
  down: { label: "Down", token: "fail" },
  failing: { label: "Failing", token: "fail" },
  paused: { label: "Paused", token: "idle" },
  pending: { label: "Pending", token: "queue" },
};

/** The same tints `StatusPill` uses, so a monitor's "Down" and a run's "Failed"
 *  are visibly the same kind of object. */
const PILL_CLASS: Record<ColorToken, string> = {
  run: "text-run bg-run/10 border-run/30",
  ok: "text-ok bg-ok/10 border-ok/25",
  fail: "text-fail bg-fail/12 border-fail/35",
  queue: "text-queue bg-queue/10 border-queue/30",
  idle: "text-ink-dim bg-ink-faint/8 border-line-strong",
  await: "text-await bg-await/12 border-await/40",
};

/**
 * A monitor's status, in `StatusPill`'s anatomy. Not `StatusPill` itself: a
 * monitor's vocabulary is up/late/down, not working/done/failed, and the words
 * are the point.
 */
function MonitorPill({ status }: { status: MonitorStatus }) {
  const { label, token } = PILL[status];
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-caption font-semibold leading-none ${PILL_CLASS[token]}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      {label}
    </span>
  );
}

/**
 * How long ago a missed slot was due, as a duration that keeps growing.
 *
 * At or before the slot itself (a clock a beat behind the server's) there is
 * nothing to be overdue *by*; it used to say "Overdue by moments", which is not
 * a length of time. It says the slot is due instead.
 */
function Overdue({ iso, className }: { iso: string | null; className: string }) {
  const now = useClock();
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return <span className={className}>Overdue</span>;
  const ms = now - at.getTime();
  const title = `Slot was due at ${at.toLocaleString()}`;
  if (ms <= 0) {
    return (
      <span className={className} title={title}>
        Due now
      </span>
    );
  }
  return (
    <span className={className} title={title}>
      Overdue by <strong className="font-semibold">{formatDuration(ms)}</strong>
    </span>
  );
}

/**
 * Uptime that gets louder only as it gets worse. A healthy figure recedes —
 * the pill beside it already says "Up" — so a board of healthy monitors is not
 * a row of green numbers. Under 99% is worth a look, so it steps up to full
 * ink: contrast, not a status hue, since amber here would read as "working".
 * Under 90% the schedule fails more than one run in ten, and that is red.
 */
function uptimeTone(pct: number): string {
  if (pct >= 99) return "text-ink-dim";
  if (pct >= 90) return "text-ink";
  return "text-fail";
}

/** The card's edge carries the alarm, so the grid reads at a glance. The tint
 *  is a gradient (a background *image*) over the surface colour, so the two
 *  never compete for the same property. */
function cardTone(status: MonitorStatus): string {
  if (status === "down" || status === "failing")
    return "border-fail/35 bg-gradient-to-b from-fail/[0.07] to-fail/[0.02]";
  if (status === "late") return "border-await/30 bg-gradient-to-b from-await/[0.05] to-transparent";
  return "border-line";
}

/**
 * The run a card in trouble should open: for a failing monitor, its newest
 * failed run (the one that made it fail); for a late or down one, the last run
 * that did happen, the nearest evidence of what stopped. Healthy cards get none
 * — a row of "Open last run" buttons would bury the one that matters.
 */
function nextRun(monitor: MonitorHealth): { runId: string; label: string } | null {
  const beats = monitor.heartbeats;
  if (monitor.status === "failing") {
    const failed = [...beats]
      .reverse()
      .find(
        (h) =>
          h.status === "failed" ||
          h.status === "interrupted" ||
          h.outcome === "failed" ||
          h.outcome === "blocked",
      );
    return failed ? { runId: failed.runId, label: "Open failed run" } : null;
  }
  if (monitor.status === "down" || monitor.status === "late") {
    const last = beats[beats.length - 1];
    return last ? { runId: last.runId, label: "Open last run" } : null;
  }
  return null;
}

function MonitorCard({
  monitor,
  ref,
}: {
  monitor: MonitorHealth;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const overdue = monitor.status === "down" || monitor.status === "late";
  const next = nextRun(monitor);
  return (
    // Not `Card`: an alarming card needs a different border colour, and a second
    // border utility appended to Card's own loses to it in the stylesheet.
    <div
      ref={ref}
      className={`rounded-tile border bg-surface p-4 shadow-raised ${cardTone(monitor.status)}`}
    >
      <div className="flex items-center gap-3">
        <a
          href="#/schedules"
          className="min-w-0 truncate text-heading font-semibold text-ink underline-offset-2 hover:underline"
          title={monitor.name}
        >
          {monitor.name}
        </a>
        <span className="ml-auto">
          <MonitorPill status={monitor.status} />
        </span>
      </div>

      <div className="mt-3.5 flex items-end gap-4">
        <div className="min-w-0 flex-1">
          <HeartbeatBar beats={monitor.heartbeats} />
        </div>
        {monitor.uptimePct === null ? (
          // Uptime counts finished runs only; until there is one, say so
          // rather than print a dash beside the word.
          <p className="shrink-0 text-right text-caption leading-none text-ink-faint">
            {monitor.heartbeats.length === 0 ? "No runs yet" : "No completed runs yet"}
          </p>
        ) : (
          <p
            className="shrink-0 text-right leading-none"
            title="Share of expected slots that ran and succeeded"
          >
            <span className={`text-heading font-semibold ${uptimeTone(monitor.uptimePct)}`}>
              {monitor.uptimePct}%
            </span>{" "}
            <span className="text-caption text-ink-faint">uptime</span>
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-caption text-ink-faint">
        <span>
          Last run: <TimeAgo iso={monitor.lastRunAt} />
        </span>
        {/* A late or down monitor's headline is *how overdue* it is, not when the
            slot was — "overdue by 2h" is the number you act on. A healthy one
            shows the next slot instead. */}
        {overdue ? (
          <Overdue
            iso={monitor.expectedAt}
            className={monitor.status === "down" ? "text-fail" : "text-await"}
          />
        ) : (
          monitor.nextExpected && (
            <span>
              Next run: <TimeAgo iso={monitor.nextExpected} />
            </span>
          )
        )}
        {/* The page asks "is anything quietly broken?"; a card that answers
            yes says where to look next, rather than leaving the reader on it. */}
        {next && (
          <ButtonLink
            href={`#/run/${encodeURIComponent(next.runId)}`}
            size="sm"
            icon="replay"
            className="-my-1 ml-auto"
            title="Replay this run, with its postmortem"
          >
            {next.label}
          </ButtonLink>
        )}
      </div>
    </div>
  );
}

/**
 * The counter tiles, in escalation order, each one a filter for its own subset.
 * Each tone is its pill's: a "Late" tile in one colour above "Late" pills in
 * another made the reader wonder whether they were the same thing.
 */
const COUNTERS: {
  status: MonitorStatus;
  label: string;
  tone: "fail" | "await" | "ok" | "queue" | "ink";
}[] = [
  { status: "down", label: "Down", tone: "fail" },
  { status: "failing", label: "Failing", tone: "fail" },
  { status: "late", label: "Late", tone: "await" },
  { status: "up", label: "Up", tone: "ok" },
  { status: "pending", label: "Pending", tone: "queue" },
  { status: "paused", label: "Paused", tone: "ink" },
];

/** The loading shape: six counters over the card grid, as they will land. */
function MonitorsSkeleton() {
  return (
    <>
      <div className="mb-8 grid grid-cols-3 gap-3 lg:grid-cols-6">
        {COUNTERS.map((c) => (
          <div
            key={c.status}
            aria-hidden="true"
            className="rounded-tile border border-line bg-surface px-4 py-3.5 shadow-raised"
          >
            <Skeleton className="h-7 w-8" />
            <Skeleton className="mt-3.5 h-2.5 w-14" />
          </div>
        ))}
      </div>
      <SkeletonGrid count={4} columns={2} lines={2} />
    </>
  );
}

/**
 * The Monitors half of Health. No `Page` of its own: `Health` supplies the
 * heading, the switch to Watchtower and the explanation, so this is the content
 * alone.
 */
export function MonitorsPanel() {
  // Rows come and go and change places as health changes; FLIP glides them
  // there instead of letting the list teleport under the reader.
  const flip = useFlip();
  const { monitors, summary, loading, error, refresh } = useMonitors();
  const [filter, setFilter] = useState<MonitorStatus | null>(null);
  const shown = filter === null ? monitors : monitors.filter((m) => m.status === filter);

  return (
    <>
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Monitors"
            message={`Couldn't load monitors: ${error}`}
            action={
              <Button size="sm" icon="retry" onClick={() => refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      {/* Counters live inside the handoff: a row of zeros while the first load
          is in flight is a claim that nothing is down, made before anyone knows. */}
      <Handoff
        busy={loading && monitors.length === 0}
        label="monitors"
        skeleton={<MonitorsSkeleton />}
      >
        {monitors.length === 0 ? (
          // A failed load is not an empty list: the strip above says what went
          // wrong, and "No monitors yet" beneath it would be a second, false story.
          !error && (
            <EmptyState
              icon="activity"
              title="No monitors yet."
              action={
                <ButtonLink href="#/schedules" variant="primary" icon="plus">
                  Create a schedule
                </ButtonLink>
              }
            >
              Every schedule gets one automatically: Argus records the slots it expected, so a run
              that never happened is as visible as one that failed.
            </EmptyState>
          )
        ) : (
          <>
            <section
              aria-label="Monitor status"
              className="mb-8 grid grid-cols-3 gap-3 lg:grid-cols-6"
            >
              {COUNTERS.map(({ status, label, tone }) => {
                const value = summary[status];
                return (
                  <HealthCounter
                    key={status}
                    label={label}
                    value={value}
                    tone={tone}
                    selected={filter === status}
                    // A tile with nothing behind it is not a filter — pressing it would
                    // clear the list and tell the reader nothing.
                    onClick={
                      value > 0 ? () => setFilter(filter === status ? null : status) : undefined
                    }
                    title={value > 0 ? `Show only the ${label.toLowerCase()} monitors` : undefined}
                  />
                );
              })}
            </section>

            {filter !== null && (
              <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-dim">
                <span>
                  Showing {shown.length} {PILL[filter].label.toLowerCase()}{" "}
                  {shown.length === 1 ? "monitor" : "monitors"} of {monitors.length}
                </span>
                <Button size="sm" variant="ghost" icon="close" onClick={() => setFilter(null)}>
                  Show all
                </Button>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {shown.map((m) => (
                <MonitorCard key={m.scheduleId} ref={flip(m.scheduleId)} monitor={m} />
              ))}
            </div>
          </>
        )}
      </Handoff>
    </>
  );
}

export default MonitorsPanel;
