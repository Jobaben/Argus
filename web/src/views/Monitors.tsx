import { useState } from "react";
import {
  AlertStrip,
  Card,
  EmptyState,
  HealthCounter,
  HeartbeatBar,
  Loading,
  Page,
  SkeletonGrid,
  TimeAgo,
  formatDuration,
  useClock,
} from "../ds";
import type { ColorToken } from "../ds";
import { useMonitors } from "../useMonitors";
import type { MonitorHealth, MonitorStatus } from "../types";

const PILL: Record<MonitorStatus, { label: string; token: ColorToken }> = {
  up: { label: "Up", token: "ok" },
  late: { label: "Late", token: "await" },
  down: { label: "Down", token: "fail" },
  failing: { label: "Failing", token: "fail" },
  paused: { label: "Paused", token: "idle" },
  pending: { label: "Pending", token: "queue" },
};

const PILL_CLASS: Record<ColorToken, string> = {
  run: "text-run bg-run/12",
  ok: "text-ok bg-ok/12",
  fail: "text-fail bg-fail/14",
  queue: "text-queue bg-queue/12",
  idle: "text-idle bg-idle/12",
  await: "text-await bg-await/14",
};

function MonitorPill({ status }: { status: MonitorStatus }) {
  const { label, token } = PILL[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border border-current px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.13em] ${PILL_CLASS[token]}`}
    >
      {label}
    </span>
  );
}

/** How long ago a missed slot was due, as a bare duration that keeps growing. */
function Overdue({ iso }: { iso: string | null }) {
  const now = useClock();
  if (!iso) return <strong className="font-mono">—</strong>;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return <strong className="font-mono">—</strong>;
  const ms = now - at.getTime();
  return (
    <strong className="font-mono" title={`Slot was due at ${at.toLocaleString()}`}>
      {ms <= 0 ? "moments" : formatDuration(ms)}
    </strong>
  );
}

function MonitorCard({ monitor }: { monitor: MonitorHealth }) {
  const alarming = monitor.status === "down" || monitor.status === "failing";
  return (
    <Card className={alarming ? "border-fail/40" : undefined}>
      <div className="flex items-center gap-3">
        <a
          href="#/schedules"
          className="truncate text-sm font-semibold text-ink hover:underline"
          title={monitor.name}
        >
          {monitor.name}
        </a>
        <span className="ml-auto shrink-0">
          <MonitorPill status={monitor.status} />
        </span>
      </div>
      <div className="mt-3">
        <HeartbeatBar beats={monitor.heartbeats} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
        <span>
          Uptime:{" "}
          <strong
            className={
              monitor.uptimePct !== null && monitor.uptimePct < 100 ? "text-ink" : "text-ok"
            }
          >
            {monitor.uptimePct === null ? "—" : `${monitor.uptimePct}%`}
          </strong>
        </span>
        <span>
          Last run: <TimeAgo iso={monitor.lastRunAt} />
        </span>
        {/* A late or down monitor's headline is *how overdue* it is, not when the
            slot was — "overdue by 2h" is the number you act on. A healthy one
            shows the next slot instead. */}
        {monitor.status === "down" || monitor.status === "late" ? (
          <span className={monitor.status === "down" ? "text-fail" : "text-await"}>
            Overdue by <Overdue iso={monitor.expectedAt} />
          </span>
        ) : (
          monitor.nextExpected && (
            <span>
              Next run: <TimeAgo iso={monitor.nextExpected} />
            </span>
          )
        )}
      </div>
    </Card>
  );
}

/** The counter tiles, in escalation order, each one a filter for its own subset. */
const COUNTERS: { status: MonitorStatus; label: string; alarming?: boolean }[] = [
  { status: "down", label: "Down", alarming: true },
  { status: "failing", label: "Failing", alarming: true },
  { status: "late", label: "Late" },
  { status: "up", label: "Up" },
  { status: "pending", label: "Pending" },
  { status: "paused", label: "Paused" },
];

export default function Monitors() {
  const { monitors, summary, loading, error } = useMonitors();
  const [filter, setFilter] = useState<MonitorStatus | null>(null);
  const shown = filter === null ? monitors : monitors.filter((m) => m.status === filter);

  return (
    <Page title="Monitors" crumbs={[{ label: "Scheduler", href: "#/schedules" }]}>
      <p className="mb-6 text-sm text-ink-faint">
        Dead-man's switch over your schedules — a monitor goes down when a slot passes and nothing
        ran, even if Argus itself was asleep at the time
      </p>

      <section className="mb-8 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {COUNTERS.map(({ status, label, alarming }) => {
          const value = summary[status];
          return (
            <HealthCounter
              key={status}
              label={label}
              value={value}
              tone={
                alarming && value > 0
                  ? "fail"
                  : status === "late" && value > 0
                    ? "run"
                    : status === "up"
                      ? "live"
                      : undefined
              }
              selected={filter === status}
              // A tile with nothing behind it is not a filter — pressing it would
              // clear the list and tell the reader nothing.
              onClick={value > 0 ? () => setFilter(filter === status ? null : status) : undefined}
              title={value > 0 ? `Show only the ${label.toLowerCase()} monitors` : undefined}
            />
          );
        })}
      </section>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Monitors" message={`Couldn't load monitors: ${error}`} />
        </div>
      )}

      {filter !== null && (
        <div className="mb-4 flex items-center gap-3 text-xs text-ink-faint">
          <span>
            Showing {shown.length} {PILL[filter].label.toLowerCase()}{" "}
            {shown.length === 1 ? "monitor" : "monitors"} of {monitors.length}
          </span>
          <button
            type="button"
            onClick={() => setFilter(null)}
            className="text-queue underline hover:text-ink"
          >
            Show all
          </button>
        </div>
      )}

      {loading && monitors.length === 0 ? (
        <Loading label="monitors">
          <SkeletonGrid count={4} columns={2} lines={2} />
        </Loading>
      ) : monitors.length === 0 ? (
        <EmptyState>
          <p className="text-sm text-ink-dim">No monitors yet.</p>
          <p className="mx-auto mt-2 max-w-md text-xs">
            Every schedule gets one automatically: Argus records the slots it expected, so a run
            that never happened is as visible as one that failed.{" "}
            <a href="#/schedules" className="text-queue underline hover:text-ink">
              Create a schedule
            </a>{" "}
            and its monitor appears here.
          </p>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {shown.map((m) => (
            <MonitorCard key={m.scheduleId} monitor={m} />
          ))}
        </div>
      )}
    </Page>
  );
}
