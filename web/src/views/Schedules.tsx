import { useState } from "react";
import { useSchedules } from "../useSchedules";
import { useRuns } from "../useRuns";
import type { ScheduleInput, ScheduleWithNext, Trigger } from "../types";
import { AlertStrip, EmptyState, Page, TriggerFields } from "../ds";
import { CronPanel } from "./Cron";
import { RunRow } from "./RunRow";

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

function triggerSummary(t: Trigger): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (t.kind === "interval") return `every ${t.everyMinutes} min`;
  if (t.kind === "daily") return `daily at ${t.time}`;
  if (t.kind === "windowed") {
    const when =
      t.weekdays && t.weekdays.length > 0 ? t.weekdays.map((d) => days[d]).join(", ") : "every day";
    return `every ${t.everyMinutes} min, ${t.startTime}–${t.endTime}, ${when}`;
  }
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
            {schedule.catchUp && (
              <span
                className="ml-2 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-dim"
                title="A slot missed while Argus was down fires once on recovery"
              >
                catch-up
              </span>
            )}
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
            if (confirm(`Delete schedule "${schedule.name}"?`))
              void run(() => remove(schedule.id))();
          }}
          className="rounded-lg border border-fail/20 px-2.5 py-1 text-xs text-fail hover:bg-fail/10"
        >
          Delete
        </button>
        {!schedule.enabled && <span className="text-xs text-ink-faint">disabled</span>}
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
  const [mode, setMode] = useState<
    { kind: "none" } | { kind: "new" } | { kind: "edit"; id: string }
  >({ kind: "none" });
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
