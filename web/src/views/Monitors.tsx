import { AlertStrip, Card, EmptyState, HealthCounter, HeartbeatBar, Page, TimeAgo } from "../ds";
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
        {monitor.status === "down" || monitor.status === "late" ? (
          <span className="text-fail">
            Expected <TimeAgo iso={monitor.expectedAt} />
          </span>
        ) : (
          monitor.nextExpected && (
            <span>
              Next: <TimeAgo iso={monitor.nextExpected} />
            </span>
          )
        )}
      </div>
    </Card>
  );
}

export default function Monitors() {
  const { monitors, summary, loading, error } = useMonitors();

  return (
    <Page title="Monitors" crumbs={[{ label: "Scheduler", href: "#/schedules" }]}>
      <p className="mb-6 text-sm text-ink-faint">
        Dead-man's switch over your schedules — a monitor goes down when a slot passes and nothing
        ran, even if Argus itself was asleep at the time
      </p>

      <section className="mb-8 grid grid-cols-3 gap-3 sm:grid-cols-6">
        <HealthCounter label="Up" value={summary.up} tone="live" />
        <HealthCounter label="Late" value={summary.late} tone={summary.late ? "run" : undefined} />
        <HealthCounter label="Down" value={summary.down} tone={summary.down ? "fail" : undefined} />
        <HealthCounter
          label="Failing"
          value={summary.failing}
          tone={summary.failing ? "fail" : undefined}
        />
        <HealthCounter label="Pending" value={summary.pending} />
        <HealthCounter label="Paused" value={summary.paused} />
      </section>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Monitors" message={`Couldn't load monitors: ${error}`} />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading monitors…</p>
      ) : monitors.length === 0 ? (
        <EmptyState>
          No monitors yet. Every schedule you create in the Scheduler gets one automatically.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {monitors.map((m) => (
            <MonitorCard key={m.scheduleId} monitor={m} />
          ))}
        </div>
      )}
    </Page>
  );
}
