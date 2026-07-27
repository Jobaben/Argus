import { useMemo, useState } from "react";
import { useSchedules } from "../useSchedules";
import { useRuns } from "../useRuns";
import type { Run, ScheduleInput, ScheduleWithNext } from "../types";
import {
  AlertStrip,
  EmptyState,
  Loading,
  Page,
  SkeletonRows,
  TimeAgo,
  TriggerFields,
  formatCountdown,
  formatTrigger,
  formatMs,
  useClock,
  useTicker,
} from "../ds";
import { CronPanel } from "./Cron";
import { RunRow } from "./RunRow";
import {
  scheduleHealthById,
  summarizeSchedules,
  type ScheduleHealth,
  type ScheduleState,
} from "./scheduleHealth";

/**
 * Countdown to this schedule's next firing, on its own second-resolution clock.
 *
 * The shared 15s clock is right for "4m ago" and wrong here: a countdown that
 * jumps in 15-second steps reads as broken, and this is the number a user watches
 * when they are deciding whether to wait or hit Run now.
 */
function NextFireLabel({ at }: { at: string | null }) {
  const now = useTicker(at !== null);
  if (!at) return <span className="text-ink-faint">no next slot</span>;
  const ms = new Date(at).getTime() - now;
  if (Number.isNaN(ms)) return <span className="text-ink-faint">no next slot</span>;
  return (
    <span title={`Next firing: ${new Date(at).toLocaleString()}`}>
      fires <span className="font-mono text-ink-dim">{formatCountdown(ms)}</span>
    </span>
  );
}

const STATE_PILL: Record<ScheduleState, { label: string; className: string }> = {
  failing: { label: "failing", className: "border-fail/40 bg-fail/10 text-fail" },
  running: { label: "running", className: "border-run/40 bg-run/10 text-run" },
  paused: { label: "paused", className: "border-line bg-ground-2 text-ink-faint" },
  unproven: { label: "never run", className: "border-queue/30 bg-queue/10 text-queue" },
  healthy: { label: "healthy", className: "border-ok/30 bg-ok/10 text-ok" },
};

function StateBadge({ state }: { state: ScheduleState }) {
  const skin = STATE_PILL[state];
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] ${skin.className}`}
    >
      {skin.label}
    </span>
  );
}

type Filter = "all" | "failing" | "paused";

/**
 * The scheduler's own situation line: what it will do next, and what it has been
 * getting wrong.
 *
 * Clicking a count filters the list rather than navigating away — the answer to
 * "which three are failing?" is nine cards down the same page, and sending the
 * user to another tab to find out would cost them the actions they came for.
 * Zero counts are omitted, so anything visible here is worth reading.
 */
function SchedulerSummaryStrip({
  schedules,
  runs,
  filter,
  onFilter,
}: {
  schedules: ScheduleWithNext[];
  runs: Run[];
  filter: Filter;
  onFilter: (f: Filter) => void;
}) {
  // The shared 15s clock, not a 1Hz one: the only sub-tick number here is the
  // countdown, and that owns its own ticker. Re-deriving the whole summary every
  // second to move a "24h" boundary would be a re-render for nothing.
  const now = useClock();
  const summary = useMemo(() => summarizeSchedules(schedules, runs, now), [schedules, runs, now]);
  if (summary.total === 0) return null;

  const chips: { key: Filter; count: number; label: string; className: string }[] = [
    {
      key: "failing",
      count: summary.failing,
      label: "failing",
      className: "border-fail/40 bg-fail/10 text-fail",
    },
    {
      key: "paused",
      count: summary.paused,
      label: "paused",
      className: "border-line bg-ground-2 text-ink-dim",
    },
  ];

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-tile border border-line bg-ground-2 px-4 py-2.5 text-[13px]">
      <button
        type="button"
        onClick={() => onFilter("all")}
        aria-pressed={filter === "all"}
        className={`cursor-pointer rounded-md border px-2.5 py-1 transition ${
          filter === "all" ? "border-line bg-surface-2 text-ink" : "border-transparent text-ink-dim"
        }`}
      >
        <span className="font-mono text-[15px] font-extrabold leading-none">{summary.total}</span>{" "}
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
          schedules
        </span>
      </button>
      {chips
        .filter((c) => c.count > 0)
        .map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onFilter(filter === c.key ? "all" : c.key)}
            aria-pressed={filter === c.key}
            className={`cursor-pointer rounded-md border px-2.5 py-1 transition hover:brightness-125 ${c.className} ${
              filter === c.key ? "ring-1 ring-current" : ""
            }`}
          >
            <span className="text-[15px] font-extrabold leading-none">{c.count}</span>{" "}
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              {c.label}
            </span>
          </button>
        ))}
      {summary.running > 0 && (
        <span className="inline-flex items-center gap-1.5 text-run">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-run opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-run" />
          </span>
          {summary.running} running
        </span>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-ink-dim">
        {summary.recentRuns > 0 ? (
          <span title="Runs that reached a verdict in the last 24 hours">
            <span className="font-mono text-ink">{summary.recentRuns}</span> in 24h
            {summary.recentFailures > 0 && (
              <>
                {" · "}
                <span className="font-mono text-fail">{summary.recentFailures} failed</span>
              </>
            )}
          </span>
        ) : (
          <span className="text-ink-faint">nothing fired in 24h</span>
        )}
        {summary.nextFiring ? (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              next
            </span>
            <span className="max-w-[14rem] truncate">{summary.nextFiring.schedule.name}</span>
            <NextFireLabel at={summary.nextFiring.at} />
          </span>
        ) : (
          <span className="text-ink-faint">nothing armed</span>
        )}
      </div>
    </div>
  );
}

const EMPTY: ScheduleInput = {
  name: "",
  prompt: "",
  cwd: "",
  trigger: { kind: "daily", time: "02:00" },
  overlapPolicy: "skip",
};

function ScheduleForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: ScheduleInput;
  onSubmit: (input: ScheduleInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<ScheduleInput>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(form);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const field =
    "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder-ink-faint";
  const labelCls = "block space-y-1 text-xs font-medium text-ink-dim";
  const valid = form.name.trim() && form.prompt.trim() && form.cwd.trim();

  return (
    <div className="rounded-xl border border-line bg-surface p-5 space-y-3">
      {err && <AlertStrip subject="Error" message={err} />}
      <label className={labelCls}>
        <span>Name</span>
        <input
          className={field}
          placeholder="Nightly audit"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </label>
      <label className={labelCls}>
        <span>Prompt for claude -p</span>
        <textarea
          className={`${field} h-24`}
          placeholder="Review yesterday's changes and summarize risks"
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
        />
      </label>
      <label className={labelCls}>
        <span>Working directory (absolute path)</span>
        <input
          className={field}
          placeholder="/home/you/project"
          value={form.cwd}
          onChange={(e) => setForm({ ...form, cwd: e.target.value })}
        />
      </label>
      <TriggerFields
        fieldClass={field}
        value={form.trigger}
        onChange={(t) => setForm({ ...form, trigger: t ?? { kind: "daily", time: "02:00" } })}
      />

      <label className="flex items-start gap-2 text-xs text-ink-dim">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={form.catchUp ?? false}
          onChange={(e) => setForm({ ...form, catchUp: e.target.checked })}
        />
        <span>
          <span className="font-medium">Catch up a missed run on recovery</span>
          <span className="block text-ink-faint">
            If the machine was asleep (or Argus was down) when a slot came due, fire it once when
            Argus is back instead of skipping to the next slot.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={busy || !valid}
          title={!valid ? "Name, prompt and working directory are required" : undefined}
          onClick={submit}
          className="rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 transition hover:bg-ok/30 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save schedule"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-dim transition hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Median duration of the recent conclusive runs — what "normal" costs, so a
 *  run that is taking four times that is visibly abnormal. Median, not mean: one
 *  pathological 40-minute run should not redefine normal. */
function typicalDuration(runs: Run[]): number | null {
  const durations = runs
    .map((r) => r.durationMs)
    .filter((d): d is number => d != null && Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  return durations[Math.floor(durations.length / 2)];
}

function ScheduleCard({
  schedule,
  health,
  onEdit,
  update,
  remove,
  runNow,
  cancelRun,
}: {
  schedule: ScheduleWithNext;
  health: ScheduleHealth;
  onEdit: () => void;
  update: (id: string, patch: Partial<ScheduleInput>) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  runNow: (id: string) => Promise<unknown>;
  cancelRun: (runId: string) => Promise<unknown>;
}) {
  const { running, runs } = health;
  const recent = runs.slice(0, 5);
  const typical = typicalDuration(recent);
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Wrap an action so a failed Run-now/Enable/Delete surfaces instead of being
  // silently swallowed by a bare `void promise`.
  const run = (fn: () => Promise<unknown>) => async () => {
    setActionErr(null);
    try {
      await fn();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    }
  };

  const failingBorder = health.state === "failing" ? "border-fail/40" : "border-line";

  return (
    <div className={`rounded-xl border bg-surface p-4 ${failingBorder}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-base font-semibold text-ink">{schedule.name}</h3>
            <StateBadge state={health.state} />
            {running.length > 0 && (
              <span className="relative flex h-2 w-2 shrink-0" title="A run is in flight">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-run opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-run" />
              </span>
            )}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
            <span className="text-ink-dim">{formatTrigger(schedule.trigger)}</span>
            <span aria-hidden="true">·</span>
            {schedule.enabled ? (
              <NextFireLabel at={schedule.nextRun} />
            ) : (
              <span title="A paused schedule keeps its computed slot but will not fire">
                paused — will not fire
              </span>
            )}
            {health.lastConclusive && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  ran <TimeAgo iso={health.lastConclusive.endedAt} />
                </span>
              </>
            )}
            {typical != null && (
              <>
                <span aria-hidden="true">·</span>
                <span title="Median duration of the recent runs shown below">
                  ~{formatMs(typical)}
                </span>
              </>
            )}
            {schedule.catchUp && (
              <span
                className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-dim"
                title="A slot missed while Argus was down fires once on recovery"
              >
                catch-up
              </span>
            )}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-ink-faint" title={schedule.cwd}>
            {schedule.cwd}
          </p>
        </div>
      </header>

      {/* The one thing a card must not make you count for yourself. A single
          failure is visible in the rows below; a streak is a different problem
          and deserves to be stated. */}
      {health.consecutiveFailures > 1 && (
        <div className="mt-3 rounded-lg border border-fail/30 bg-fail/10 px-3 py-2 text-xs text-fail">
          <p className="font-medium">{health.consecutiveFailures} consecutive failures</p>
          {health.lastConclusive?.error ? (
            <p className="mt-1 line-clamp-2 font-mono text-[11px] text-fail/85">
              {health.lastConclusive.error.split("\n")[0]}
            </p>
          ) : (
            <p className="mt-1 text-fail/85">Expand a run below for the reason.</p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={run(() => runNow(schedule.id))}
          className="rounded-lg bg-ok/15 px-2.5 py-1 text-xs text-ok ring-1 ring-ok/30 hover:bg-ok/25"
        >
          Run now
        </button>
        <button
          type="button"
          onClick={run(() => update(schedule.id, { enabled: !schedule.enabled }))}
          className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
        >
          {schedule.enabled ? "Disable" : "Enable"}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Delete schedule "${schedule.name}"?`))
              void run(() => remove(schedule.id))();
          }}
          className="rounded-lg border border-fail/20 px-2.5 py-1 text-xs text-fail hover:bg-fail/10"
        >
          Delete
        </button>
      </div>

      {actionErr && (
        <p role="alert" className="mt-2 text-xs text-fail">
          {actionErr}
        </p>
      )}

      {recent.length > 0 ? (
        <div className="mt-4">
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <h4 className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              last {recent.length === 1 ? "run" : `${recent.length} runs`}
            </h4>
            {health.conclusive > 0 && (
              <span
                className="font-mono text-[10px] text-ink-faint"
                title={`${health.failures} of ${health.conclusive} recorded runs failed`}
              >
                {health.conclusive - health.failures}/{health.conclusive} passed
              </span>
            )}
          </div>
          <ul className="space-y-1.5">
            {recent.map((r) => (
              <RunRow key={r.id} run={r} onCancel={cancelRun} />
            ))}
          </ul>
        </div>
      ) : (
        // A schedule with no history is the state a new one is in for hours.
        // Saying so, with the way to test it, beats an empty gap under the card.
        <p className="mt-4 rounded-lg border border-dashed border-line px-3 py-2 text-xs text-ink-faint">
          No runs recorded yet.{" "}
          {schedule.enabled
            ? "It will appear here after the first firing — or press Run now to test it."
            : "Enable it, or press Run now to test it without waiting for a slot."}
        </p>
      )}
    </div>
  );
}

export default function Schedules() {
  const { schedules, loading, error, create, update, remove, runNow, cancelRun } = useSchedules();
  // One run list for every card. Each card used to fetch its own
  // `/api/runs?scheduleId=…`, so a page with twelve schedules opened thirteen
  // requests and kept thirteen conditional polls alive — and still could not
  // answer an aggregate question, because no one held all the runs at once.
  const { runs } = useRuns();
  const [mode, setMode] = useState<
    { kind: "none" } | { kind: "new" } | { kind: "edit"; id: string }
  >({ kind: "none" });
  const [subTab, setSubTab] = useState<"schedules" | "cron">("schedules");
  const [filter, setFilter] = useState<Filter>("all");

  const editing = mode.kind === "edit" ? schedules.find((s) => s.id === mode.id) : undefined;
  const health = useMemo(() => scheduleHealthById(schedules, runs), [schedules, runs]);
  // Pair each visible schedule with its health here, so the card takes both as
  // props and never has to cope with a missing entry.
  const shown = useMemo(
    () =>
      schedules.flatMap((schedule) => {
        const entry = health.get(schedule.id);
        if (!entry) return [];
        if (filter !== "all" && entry.state !== filter) return [];
        return [{ schedule, health: entry }];
      }),
    [schedules, health, filter],
  );

  return (
    <Page
      title="Scheduler"
      actions={
        subTab === "schedules" && mode.kind === "none" ? (
          <button
            type="button"
            onClick={() => setMode({ kind: "new" })}
            className="rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 hover:bg-ok/30"
          >
            + New schedule
          </button>
        ) : null
      }
    >
      <div className="mb-6 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setSubTab("schedules")}
          aria-pressed={subTab === "schedules"}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            subTab === "schedules" ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
          }`}
        >
          Schedules
        </button>
        <button
          type="button"
          onClick={() => setSubTab("cron")}
          aria-pressed={subTab === "cron"}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            subTab === "cron" ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
          }`}
        >
          Cron
        </button>
      </div>

      {subTab === "cron" ? (
        <CronPanel />
      ) : (
        <>
          {error && (
            <div className="mb-6">
              <AlertStrip subject="Error" message={`Couldn't reach the Argus server: ${error}`} />
            </div>
          )}

          {mode.kind === "new" && (
            <div className="mb-6">
              <ScheduleForm
                initial={EMPTY}
                onCancel={() => setMode({ kind: "none" })}
                onSubmit={async (input) => {
                  await create(input);
                  setMode({ kind: "none" });
                }}
              />
            </div>
          )}

          {mode.kind === "edit" && editing && (
            <div className="mb-6">
              <ScheduleForm
                key={editing.id}
                initial={editing}
                onCancel={() => setMode({ kind: "none" })}
                onSubmit={async (input) => {
                  await update(editing.id, input);
                  setMode({ kind: "none" });
                }}
              />
            </div>
          )}

          {!loading && schedules.length > 0 && (
            <SchedulerSummaryStrip
              schedules={schedules}
              runs={runs}
              filter={filter}
              onFilter={setFilter}
            />
          )}

          {loading ? (
            <Loading label="schedules">
              <SkeletonRows count={4} />
            </Loading>
          ) : schedules.length === 0 && mode.kind === "none" ? (
            <EmptyState>
              <p className="text-sm text-ink-dim">No schedules yet.</p>
              <p className="mx-auto mt-2 max-w-md text-xs">
                A schedule is a prompt, a working directory and a cadence: Argus runs{" "}
                <code className="font-mono text-ink-dim">claude -p</code> in that directory on time
                and keeps every run&apos;s transcript, cost and result. A first one worth having is
                a nightly review of yesterday&apos;s commits.
              </p>
              <button
                type="button"
                onClick={() => setMode({ kind: "new" })}
                className="mt-4 rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 hover:bg-ok/30"
              >
                Create your first schedule
              </button>
            </EmptyState>
          ) : shown.length === 0 ? (
            <EmptyState>
              <p className="text-sm text-ink-dim">
                No {filter} schedules — which is the answer you wanted.
              </p>
              <button
                type="button"
                onClick={() => setFilter("all")}
                className="mt-3 text-xs text-queue underline hover:text-ink"
              >
                Show all {schedules.length}
              </button>
            </EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {shown.map(({ schedule: s, health: h }) => (
                <ScheduleCard
                  key={s.id}
                  schedule={s}
                  health={h}
                  onEdit={() => setMode({ kind: "edit", id: s.id })}
                  update={update}
                  remove={remove}
                  runNow={runNow}
                  cancelRun={cancelRun}
                />
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
