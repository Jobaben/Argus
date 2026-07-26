import { useState } from "react";
import { useLaunch } from "../useLaunch";
import type { LaunchInput, Run } from "../types";
import { AlertStrip, EmptyState, Loading, ModelSelect, Page, SkeletonRows, formatUsd } from "../ds";
import { RunRow } from "./RunRow";

const FIELD =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder-ink-faint";
const LABEL = "block space-y-1 text-xs font-medium text-ink-dim";

const EMPTY: LaunchInput = { name: "", prompt: "", cwd: "" };

function LaunchForm({
  form,
  setForm,
  onLaunch,
}: {
  form: LaunchInput;
  setForm: (f: LaunchInput) => void;
  onLaunch: (input: LaunchInput) => Promise<void>;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = form.prompt.trim() && form.cwd.trim();

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onLaunch(form);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-5">
      {err && <AlertStrip subject="Error" message={err} />}
      <label className={LABEL}>
        <span>Prompt for claude -p</span>
        <textarea
          className={`${FIELD} h-28`}
          placeholder="Summarize the open TODOs in this repo and rank them by risk"
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
        />
      </label>
      <label className={LABEL}>
        <span>Working directory (absolute path)</span>
        <input
          className={FIELD}
          placeholder="/home/you/project"
          value={form.cwd}
          onChange={(e) => setForm({ ...form, cwd: e.target.value })}
        />
      </label>
      <div className="flex flex-wrap items-end gap-3">
        <label className={`${LABEL} min-w-56 flex-1`}>
          <span>Name (optional — defaults to the prompt's first line)</span>
          <input
            className={FIELD}
            placeholder="Quick repo audit"
            value={form.name ?? ""}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <ModelSelect
          fieldClass={FIELD}
          label="Model (inherit CLI)"
          value={form.model}
          onChange={(m) => setForm({ ...form, model: m })}
        />
      </div>
      <div className="pt-1">
        <button
          type="button"
          disabled={busy || !valid}
          title={!valid ? "Prompt and working directory are required" : undefined}
          onClick={submit}
          className="rounded-lg bg-ok/20 px-4 py-1.5 text-sm font-medium text-ok ring-1 ring-ok/30 transition hover:bg-ok/30 disabled:opacity-50"
        >
          {busy ? "Launching…" : "▶ Launch"}
        </button>
      </div>
    </div>
  );
}

export default function Launch() {
  const { runs, loading, error, launch, cancelRun } = useLaunch();
  const [form, setForm] = useState<LaunchInput>(EMPTY);
  const live = runs.filter((r) => r.status === "running").length;
  // Null rather than $0.00 when nothing reported a cost: an unpriced list and a
  // free one are different facts.
  const spend = runs.some((r) => r.costUsd != null)
    ? runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
    : null;

  const rerunButton = (run: Run) => (
    <button
      type="button"
      onClick={() =>
        setForm({
          name: run.scheduleName,
          prompt: run.prompt,
          cwd: run.cwd,
          ...(run.model ? { model: run.model } : {}),
        })
      }
      title="Copy this run's prompt, directory and model back into the form"
      className="rounded-md border border-line px-2 py-0.5 text-xs text-ink-dim hover:text-ink"
    >
      Reuse
    </button>
  );

  return (
    <Page title="Launch">
      <p className="mb-4 max-w-prose text-sm text-ink-dim">
        Fire a single <span className="font-mono">claude -p</span> run right now — no schedule
        needed. The run lands below with a live log, and everywhere else runs go: Chronicle, Issues,
        the Briefing.
      </p>

      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}

      <div className="mb-8">
        <LaunchForm
          form={form}
          setForm={setForm}
          onLaunch={async (input) => {
            await launch({
              prompt: input.prompt,
              cwd: input.cwd,
              ...(input.name?.trim() ? { name: input.name.trim() } : {}),
              ...(input.model ? { model: input.model } : {}),
            });
            // Keep the directory and model, clear what was one-shot. People fire
            // several prompts at the same repo in a row; making them retype an
            // absolute path each time was the single most tedious thing here.
            setForm({ ...EMPTY, cwd: input.cwd, ...(input.model ? { model: input.model } : {}) });
          }}
        />
      </div>

      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-dim">
          Recent one-off runs
        </h2>
        {live > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs text-run">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-run opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-run" />
            </span>
            {live} in flight
          </span>
        )}
        {spend != null && (
          <span
            className="ml-auto font-mono text-xs text-ink-faint"
            title="Total reported cost of the runs listed below"
          >
            {formatUsd(spend)} across {runs.length} {runs.length === 1 ? "run" : "runs"}
          </span>
        )}
      </div>
      {loading && runs.length === 0 ? (
        <Loading label="runs">
          <SkeletonRows count={4} />
        </Loading>
      ) : runs.length === 0 ? (
        <EmptyState>
          <p className="text-sm text-ink-dim">Nothing launched yet.</p>
          <p className="mx-auto mt-2 max-w-md text-xs">
            A one-off run is the same machinery a schedule uses, fired once: the log tails live, the
            cost is metered against your budget, and the transcript is kept. Use{" "}
            <strong className="text-ink-dim">Reuse</strong> on any past run to load its prompt back
            into the form.
          </p>
        </EmptyState>
      ) : (
        <ul className="space-y-1.5">
          {runs.map((r) => (
            <li key={r.id} className="space-y-1">
              <p className="truncate px-1 text-xs font-medium text-ink">{r.scheduleName}</p>
              <ul>
                <RunRow run={r} onCancel={cancelRun} extraActions={rerunButton(r)} />
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
