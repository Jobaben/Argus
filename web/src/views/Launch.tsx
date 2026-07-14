import { useState } from "react";
import { useLaunch } from "../useLaunch";
import type { LaunchInput, Run } from "../types";
import { AlertStrip, EmptyState, ModelSelect, Page } from "../ds";
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
            setForm(EMPTY);
          }}
        />
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-dim">
        Recent one-off runs
      </h2>
      {loading ? (
        <p className="text-ink-faint">Loading runs…</p>
      ) : runs.length === 0 ? (
        <EmptyState>Nothing launched yet. Fill in the form and hit Launch.</EmptyState>
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
