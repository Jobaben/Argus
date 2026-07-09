import { useMemo, useState } from "react";
import { usePipelines } from "../usePipelines";
import { useOverview } from "../useOverview";
import type { PipelineDefinition, PipelineInput, Trigger } from "../types";
import { AlertStrip, EmptyState, Page, StatusPill, toOverviewRows, type DsStatus } from "../ds";
import { PipelineForm, EMPTY_PIPELINE } from "./PipelineForm";

function triggerSummary(t: Trigger | null): string {
  if (t === null) return "manual";
  if (t.kind === "interval") return `every ${t.everyMinutes} min`;
  if (t.kind === "daily") return `daily at ${t.time}`;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (t.kind === "windowed") {
    const dayStr =
      t.weekdays && t.weekdays.length ? ` (${t.weekdays.map((d) => days[d]).join(", ")})` : "";
    return `every ${t.everyMinutes} min, ${t.startTime}–${t.endTime}${dayStr}`;
  }
  return `weekly ${days[t.weekday ?? 0]} at ${t.time}`;
}

function toInput(def: PipelineDefinition): PipelineInput {
  return {
    name: def.name,
    phases: def.phases,
    trigger: def.trigger,
    enabled: def.enabled,
    overlapPolicy: def.overlapPolicy,
    ...(def.model ? { model: def.model } : {}),
  };
}

function PipelineCard({
  def,
  live,
  onEdit,
  setEnabled,
  remove,
  runNow,
  abort,
}: {
  def: PipelineDefinition;
  live: { badge: DsStatus; activeIds: string[] };
  onEdit: () => void;
  setEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  runNow: (id: string) => Promise<unknown>;
  abort: (id: string) => Promise<unknown>;
}) {
  const abortable = live.activeIds.length > 0;
  const stopLabel = live.activeIds.length > 1 ? `Stop all (${live.activeIds.length})` : "Stop";
  const stopPrompt =
    live.activeIds.length > 1
      ? `Stop all ${live.activeIds.length} running instances of "${def.name}"? In-progress work will be discarded.`
      : `Stop running pipeline "${def.name}"? In-progress work will be discarded.`;
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-ink">{def.name}</h3>
          <p className="mt-0.5 text-xs text-ink-faint">
            {triggerSummary(def.trigger)} · {def.phases.length} phase
            {def.phases.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!def.enabled && <span className="text-xs text-ink-faint">disabled</span>}
          <StatusPill status={live.badge} size="sm" />
        </div>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(!abortable || def.overlapPolicy === "allow") && (
          <button
            type="button"
            onClick={() => void runNow(def.id)}
            className="rounded-lg bg-ok/15 px-2.5 py-1 text-xs text-ok ring-1 ring-ok/30 hover:bg-ok/25"
          >
            Run now
          </button>
        )}
        {abortable && (
          <button
            type="button"
            onClick={() => {
              if (confirm(stopPrompt)) {
                for (const id of live.activeIds) void abort(id);
              }
            }}
            className="rounded-lg bg-fail/15 px-2.5 py-1 text-xs text-fail ring-1 ring-fail/30 hover:bg-fail/25"
          >
            {stopLabel}
          </button>
        )}
        <button
          type="button"
          onClick={() => void setEnabled(def.id, !def.enabled)}
          className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
        >
          {def.enabled ? "Disable" : "Enable"}
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
            if (confirm(`Delete pipeline "${def.name}"?`)) void remove(def.id);
          }}
          className="rounded-lg border border-fail/20 px-2.5 py-1 text-xs text-fail hover:bg-fail/10"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export default function Pipelines() {
  const { pipelines, loading, error, create, update, remove, setEnabled, runNow } = usePipelines();
  const { overview, abort } = useOverview();
  const liveByPipeline = useMemo(() => {
    const m = new Map<string, { badge: DsStatus; activeIds: string[] }>();
    for (const entry of overview) {
      const rows = toOverviewRows(entry);
      const active = rows.filter((r) => r.badge === "working" || r.badge === "await");
      m.set(entry.definition.id, {
        badge: active.some((r) => r.badge === "await") ? "await" : rows[0].badge,
        activeIds: active.map((r) => r.instanceId).filter((id): id is string => id !== null),
      });
    }
    return m;
  }, [overview]);
  const [mode, setMode] = useState<
    { kind: "none" } | { kind: "new" } | { kind: "edit"; id: string }
  >({ kind: "none" });
  const [actionError, setActionError] = useState<string | null>(null);

  const editing = mode.kind === "edit" ? pipelines.find((p) => p.id === mode.id) : undefined;

  const guarded = (fn: (id: string) => Promise<unknown>) => async (id: string) => {
    setActionError(null);
    try {
      await fn(id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Page
      title="Pipelines"
      actions={
        mode.kind === "none" ? (
          <button
            type="button"
            onClick={() => setMode({ kind: "new" })}
            className="rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 hover:bg-ok/30"
          >
            + New pipeline
          </button>
        ) : null
      }
    >
      {error && (
        <div className="mb-6">
          <AlertStrip subject="Error" message={`Couldn't reach the Argus server: ${error}`} />
        </div>
      )}
      {actionError && (
        <div className="mb-6">
          <AlertStrip subject="Couldn't complete that" message={actionError} />
        </div>
      )}

      {mode.kind === "new" && (
        <div className="mb-6">
          <PipelineForm
            initial={EMPTY_PIPELINE}
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
          <PipelineForm
            key={editing.id}
            initial={toInput(editing)}
            onCancel={() => setMode({ kind: "none" })}
            onSubmit={async (input) => {
              await update(editing.id, input);
              setMode({ kind: "none" });
            }}
          />
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading pipelines…</p>
      ) : pipelines.length === 0 && mode.kind === "none" ? (
        <EmptyState>
          No pipelines yet. Create one and it'll appear on the Command Center wall.
        </EmptyState>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {pipelines.map((p) => (
            <PipelineCard
              key={p.id}
              def={p}
              live={liveByPipeline.get(p.id) ?? { badge: "idle", activeIds: [] }}
              onEdit={() => setMode({ kind: "edit", id: p.id })}
              setEnabled={guarded((id) => setEnabled(id, !p.enabled))}
              remove={guarded(remove)}
              runNow={guarded(runNow)}
              abort={guarded(abort)}
            />
          ))}
        </div>
      )}
    </Page>
  );
}
