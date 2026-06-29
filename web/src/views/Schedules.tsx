import { useEffect, useState } from "react";
import { useSchedules } from "../useSchedules";
import { useRuns } from "../useRuns";
import type { Run, ScheduleInput, ScheduleWithNext, Trigger } from "../types";
import { AlertStrip, EmptyState, StatusPill, runStatusToDsStatus, Page } from "../ds";
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

  return (
    <div className="rounded-xl border border-line bg-surface p-5 space-y-3">
      {err && (
        <AlertStrip subject="Error" message={err} />
      )}
      <input
        className={field}
        placeholder="Name"
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <textarea
        className={`${field} h-24`}
        placeholder="Prompt for claude -p"
        value={form.prompt}
        onChange={(e) => setForm({ ...form, prompt: e.target.value })}
      />
      <input
        className={field}
        placeholder="Working directory (absolute path)"
        value={form.cwd}
        onChange={(e) => setForm({ ...form, cwd: e.target.value })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={`${field} w-auto`}
          value={form.trigger.kind}
          onChange={(e) => {
            const kind = e.target.value as Trigger["kind"];
            setForm({
              ...form,
              trigger:
                kind === "interval"
                  ? { kind, everyMinutes: 60 }
                  : kind === "daily"
                    ? { kind, time: "02:00" }
                    : { kind, time: "02:00", weekday: 1 },
            });
          }}
        >
          <option value="interval">Every N minutes</option>
          <option value="daily">Daily at time</option>
          <option value="weekly">Weekly on day</option>
        </select>

        {form.trigger.kind === "interval" && (
          <input
            type="number"
            min={1}
            className={`${field} w-28`}
            value={form.trigger.everyMinutes ?? 60}
            onChange={(e) =>
              setForm({ ...form, trigger: { kind: "interval", everyMinutes: Number(e.target.value) } })
            }
          />
        )}
        {form.trigger.kind !== "interval" && (
          <input
            type="time"
            className={`${field} w-32`}
            value={form.trigger.time ?? "02:00"}
            onChange={(e) => setForm({ ...form, trigger: { ...form.trigger, time: e.target.value } })}
          />
        )}
        {form.trigger.kind === "weekly" && (
          <select
            className={`${field} w-auto`}
            value={form.trigger.weekday ?? 1}
            onChange={(e) =>
              setForm({ ...form, trigger: { ...form.trigger, weekday: Number(e.target.value) } })
            }
          >
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => (
              <option key={d} value={i}>{d}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={busy}
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

function RunRow({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left"
      >
        <StatusPill status={runStatusToDsStatus(run.status)} />
        <span className="text-xs text-ink-dim">{when(run.startedAt ?? run.queuedAt)}</span>
        {run.durationMs != null && (
          <span className="text-xs text-ink-faint">{Math.round(run.durationMs / 1000)}s</span>
        )}
        {run.trigger === "manual" && <span className="text-xs text-queue">manual</span>}
        <span className="ml-auto text-xs text-ink-faint">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2 text-sm">
          {run.error && <p className="text-fail">{run.error}</p>}
          {run.resultSummary && <p className="text-ok">{run.resultSummary}</p>}
          {run.sessionId && run.project && (
            <a
              href={`#/sessions`}
              className="inline-block font-mono text-xs text-queue hover:underline"
              title="Transcript session id"
            >
              transcript: {run.sessionId.slice(0, 8)}
            </a>
          )}
          <RunLog id={run.id} />
        </div>
      )}
    </li>
  );
}

function RunLog({ id }: { id: string }) {
  const [log, setLog] = useState<string>("loading…");
  // Fetch on expand; live runs also refresh via the list's WS ping re-rendering this.
  useEffect(() => {
    let alive = true;
    void fetch(`/api/runs/${id}`)
      .then((r) => r.json())
      .then((d: { log?: string }) => alive && setLog(d.log || "(no output)"))
      .catch(() => alive && setLog("(could not load log)"));
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-xs text-ink-dim">
      {log}
    </pre>
  );
}

function ScheduleCard({
  schedule,
  onEdit,
  update,
  remove,
  runNow,
}: {
  schedule: ScheduleWithNext;
  onEdit: () => void;
  update: (id: string, patch: Partial<ScheduleInput>) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  runNow: (id: string) => Promise<unknown>;
}) {
  const { runs } = useRuns(schedule.id);
  const running = runs.filter((r) => r.status === "running");
  const recent = runs.slice(0, 5);

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
          onClick={() => void runNow(schedule.id)}
          className="rounded-lg bg-ok/15 px-2.5 py-1 text-xs text-ok ring-1 ring-ok/30 hover:bg-ok/25"
        >
          Run now
        </button>
        <button
          type="button"
          onClick={() => void update(schedule.id, { enabled: !schedule.enabled })}
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
            if (confirm(`Delete schedule "${schedule.name}"?`)) void remove(schedule.id);
          }}
          className="rounded-lg border border-fail/20 px-2.5 py-1 text-xs text-fail hover:bg-fail/10"
        >
          Delete
        </button>
        {!schedule.enabled && (
          <span className="text-xs text-ink-faint">disabled</span>
        )}
      </div>

      {recent.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {recent.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Schedules() {
  const { schedules, loading, error, create, update, remove, runNow } = useSchedules();
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
                  />
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
