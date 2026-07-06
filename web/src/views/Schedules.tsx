import { Fragment, useEffect, useState } from "react";
import { useSchedules } from "../useSchedules";
import { useRuns } from "../useRuns";
import type { Run, ScheduleInput, ScheduleWithNext, Trigger } from "../types";
import { AlertStrip, EmptyState, StatusPill, parseRunLog, runStatusToDsStatus, Page, TriggerFields } from "../ds";
import { CronPanel } from "./Cron";

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function triggerSummary(t: Trigger): string {
  if (t.kind === "interval") return `every ${t.everyMinutes} min`;
  if (t.kind === "daily") return `daily at ${t.time}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `weekly ${days[t.weekday ?? 0]} at ${t.time}`;
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

  const field = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder-ink-faint";
  const labelCls = "block space-y-1 text-xs font-medium text-ink-dim";
  const valid = form.name.trim() && form.prompt.trim() && form.cwd.trim();

  return (
    <div className="rounded-xl border border-line bg-surface p-5 space-y-3">
      {err && (
        <AlertStrip subject="Error" message={err} />
      )}
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

function formatUsd(v: number): string {
  return v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function RunRow({ run, onCancel }: { run: Run; onCancel?: (runId: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const isRunning = run.status === "running";
  return (
    <li className="rounded-lg border border-line bg-surface">
      <div className="flex w-full items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-3 text-left"
        >
          <StatusPill status={runStatusToDsStatus(run.status)} />
          <span className="text-xs text-ink-dim">{when(run.startedAt ?? run.queuedAt)}</span>
          {run.durationMs != null && (
            <span className="text-xs text-ink-faint">{Math.round(run.durationMs / 1000)}s</span>
          )}
          {run.costUsd != null && (
            <span className="text-xs text-ink-faint" title="Reported run cost">
              {formatUsd(run.costUsd)}
            </span>
          )}
          {run.tokens != null && (
            <span className="text-xs text-ink-faint" title="Total tokens">
              {formatTokens(run.tokens)} tok
            </span>
          )}
          {run.trigger === "manual" && <span className="text-xs text-queue">manual</span>}
        </button>
        {isRunning && onCancel && (
          <button
            type="button"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await onCancel(run.id);
              } finally {
                setCancelling(false);
              }
            }}
            className="rounded-md border border-fail/30 px-2 py-0.5 text-xs text-fail hover:bg-fail/10 disabled:opacity-50"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? "Collapse run" : "Expand run"}
          className="text-xs text-ink-faint"
        >
          {open ? "▲" : "▼"}
        </button>
      </div>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3 text-sm">
          {run.error && (
            <p className="whitespace-pre-wrap leading-relaxed text-fail">{run.error}</p>
          )}
          {run.resultSummary && (
            <p className="max-w-prose whitespace-pre-wrap leading-relaxed text-ok">
              {run.resultSummary}
            </p>
          )}
          {run.sessionId && run.project && (
            <a
              href={`#/sessions/${encodeURIComponent(run.project)}/${encodeURIComponent(run.sessionId)}`}
              className="inline-block font-mono text-xs text-queue hover:underline"
              title="Open this run's transcript"
            >
              transcript: {run.sessionId.slice(0, 8)}
            </a>
          )}
          <RunLog id={run.id} running={isRunning} />
        </div>
      )}
    </li>
  );
}

function RunLog({ id, running }: { id: string; running: boolean }) {
  const [log, setLog] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Fetch on expand, then poll while the run is live so the log tails in real
  // time (a re-render alone won't refetch — the id prop is unchanged).
  useEffect(() => {
    let alive = true;
    const fetchLog = () =>
      fetch(`/api/runs/${id}`)
        .then((r) => r.json())
        .then((d: { log?: string }) => alive && setLog(d.log ?? ""))
        .catch(() => {
          if (alive) {
            setFailed(true);
            setLog("");
          }
        });
    void fetchLog();
    const poll = running ? setInterval(() => void fetchLog(), 3000) : null;
    return () => {
      alive = false;
      if (poll) clearInterval(poll);
    };
  }, [id, running]);

  if (log === null) return <p className="text-xs text-ink-faint">loading…</p>;
  if (failed) return <p className="text-xs text-ink-faint">Couldn't load the run log.</p>;

  const parsed = parseRunLog(log);
  if (parsed.kind === "empty") return null;
  return (
    <div className="rounded-lg bg-black/30 p-3">
      {parsed.truncated && (
        <p className="mb-2 text-[11px] text-ink-faint">Showing the end of a longer log.</p>
      )}
      {parsed.kind === "envelope" ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
          {parsed.fields.map((f) => (
            <Fragment key={f.label}>
              <dt className="text-ink-faint">{f.label}</dt>
              <dd className="font-mono text-ink-dim">{f.value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-dim">
          {parsed.text}
        </pre>
      )}
    </div>
  );
}

function ScheduleCard({
  schedule,
  onEdit,
  update,
  remove,
  runNow,
  cancelRun,
}: {
  schedule: ScheduleWithNext;
  onEdit: () => void;
  update: (id: string, patch: Partial<ScheduleInput>) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  runNow: (id: string) => Promise<unknown>;
  cancelRun: (runId: string) => Promise<unknown>;
}) {
  const { runs } = useRuns(schedule.id);
  const running = runs.filter((r) => r.status === "running");
  const recent = runs.slice(0, 5);
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

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-ink">{schedule.name}</h3>
          <p className="mt-0.5 text-xs text-ink-faint">
            {triggerSummary(schedule.trigger)} · next {when(schedule.nextRun)}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-ink-faint">{schedule.cwd}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {running.length > 0 && (
            <span className="inline-flex items-center gap-1.5 text-xs text-run">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-run opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-run" />
              </span>
              running
            </span>
          )}
        </div>
      </header>

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
            if (confirm(`Delete schedule "${schedule.name}"?`)) void run(() => remove(schedule.id))();
          }}
          className="rounded-lg border border-fail/20 px-2.5 py-1 text-xs text-fail hover:bg-fail/10"
        >
          Delete
        </button>
        {!schedule.enabled && (
          <span className="text-xs text-ink-faint">disabled</span>
        )}
      </div>

      {actionErr && (
        <p role="alert" className="mt-2 text-xs text-fail">
          {actionErr}
        </p>
      )}

      {recent.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {recent.map((r) => (
            <RunRow key={r.id} run={r} onCancel={cancelRun} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Schedules() {
  const { schedules, loading, error, create, update, remove, runNow, cancelRun } = useSchedules();
  const [mode, setMode] = useState<{ kind: "none" } | { kind: "new" } | { kind: "edit"; id: string }>(
    { kind: "none" },
  );
  const [subTab, setSubTab] = useState<"schedules" | "cron">("schedules");

  const editing = mode.kind === "edit" ? schedules.find((s) => s.id === mode.id) : undefined;

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
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            subTab === "schedules" ? "bg-surface-2 text-ink" : "text-ink-dim hover:text-ink"
          }`}
        >
          Schedules
        </button>
        <button
          type="button"
          onClick={() => setSubTab("cron")}
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

          {loading ? (
            <p className="text-ink-faint">Loading schedules…</p>
          ) : schedules.length === 0 && mode.kind === "none" ? (
            <EmptyState>No schedules yet. Create one and Argus will fire it on time.</EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {schedules.map((s) => (
                <ScheduleCard
                    key={s.id}
                    schedule={s}
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
