import { useMemo, useState } from "react";
import { usePipelines } from "../usePipelines";
import { useOverview } from "../useOverview";
import { useAuth } from "../useAuth";
import type { PipelineDefinition, PipelineInput } from "../types";
import {
  AlertStrip,
  EmptyState,
  formatCost,
  formatTrigger,
  Handoff,
  Page,
  SkeletonRows,
  STATUS,
  StatusPill,
  TimeAgo,
  toOverviewRows,
  type DsStatus,
  type OverviewRow,
  type PhasePill,
} from "../ds";
import { PipelineForm, EMPTY_PIPELINE } from "./PipelineForm";
import { AdminAuthPanel } from "./AdminAuthPanel";

/** What the board already knows about this pipeline's latest run. */
interface PipelineLive {
  badge: DsStatus;
  /** Instance ids that a Stop would apply to. */
  activeIds: string[];
  /** The newest row, or null when the pipeline has never run. */
  latest: OverviewRow | null;
}

function toInput(def: PipelineDefinition): PipelineInput {
  return {
    name: def.name,
    phases: def.phases,
    trigger: def.trigger,
    enabled: def.enabled,
    overlapPolicy: def.overlapPolicy,
    ...(def.model ? { model: def.model } : {}),
    ...(def.runtime ? { runtime: def.runtime } : {}),
  };
}

const DOT: Record<DsStatus, string> = {
  working: "bg-run",
  done: "bg-ok",
  failed: "bg-fail",
  queued: "bg-queue",
  idle: "bg-idle",
  await: "bg-await",
  stopped: "bg-idle",
};

/**
 * Where the latest run of this pipeline got to, as one chip per phase.
 *
 * The list used to say "4 phases" and stop, so the only way to learn *which*
 * phase a pipeline was stuck or failing in was to go to the board and find its
 * card. The data was already here — the overview row this list reads for its
 * status pill carries every phase's state — it just was not rendered.
 */
function PhaseStrip({ phases }: { phases: PhasePill[] }) {
  return (
    <ol className="mt-2.5 flex flex-wrap items-center gap-1.5">
      {phases.map((phase, i) => (
        <li
          key={phase.id}
          title={`${i + 1}. ${phase.name} — ${STATUS[phase.status].label.toLowerCase()}${
            phase.activeStep ? ` (${phase.activeStep})` : ""
          }`}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-ground-2 px-2 py-0.5"
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[phase.status]}`}
          />
          <span className="max-w-[11rem] truncate text-[11px] text-ink-dim">{phase.name}</span>
          {phase.steps.length > 1 && (
            <span className="font-mono text-[10px] text-ink-faint">{phase.steps.length}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function PipelineCard({
  def,
  live,
  admin,
  onEdit,
  setEnabled,
  remove,
  runNow,
  abort,
}: {
  def: PipelineDefinition;
  live: PipelineLive;
  /** Edit/run controls only render for an authenticated admin. */
  admin: boolean;
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
  const steps = def.phases.reduce((n, p) => n + p.steps.length, 0);
  const cost = formatCost(live.latest?.cost?.tokens, live.latest?.cost?.usd);
  const failure = live.badge === "failed" ? live.latest?.failure : null;
  const alarming = live.badge === "failed";

  return (
    <div
      className={`rounded-xl border bg-surface p-4 ${alarming ? "border-fail/40" : "border-line"}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-base font-semibold text-ink">{def.name}</h3>
            {!def.enabled && (
              <span
                className="shrink-0 rounded-full border border-line bg-ground-2 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-ink-faint"
                title="A disabled pipeline will not fire on its trigger; Run now still works"
              >
                paused
              </span>
            )}
          </div>
          {/* What the list used to say in full: a trigger and a phase count. The
              rest is what a reader came for — when it last did anything, what it
              cost, and where it is now. */}
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
            <span className="text-ink-dim">{formatTrigger(def.trigger)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {def.phases.length} phase{def.phases.length === 1 ? "" : "s"}, {steps} step
              {steps === 1 ? "" : "s"}
            </span>
            {live.latest?.updatedAt && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  last activity <TimeAgo iso={live.latest.updatedAt} />
                </span>
              </>
            )}
            {cost && (
              <>
                <span aria-hidden="true">·</span>
                <span title="Spend of the latest run, all attempts">{cost}</span>
              </>
            )}
            {def.model && (
              <span className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-dim">
                {def.model}
              </span>
            )}
            {def.runtime && (
              <span
                className="rounded-md border border-line px-1.5 py-0.5 text-[11px] text-ink-dim"
                title="Agent CLI this pipeline's steps run on, unless a phase or step overrides it"
              >
                {def.runtime === "codex" ? "Codex" : "Claude Code"}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Only a *working* pipeline gets the live pulse. `abortable` also covers
              awaiting-approval — which is stopped, waiting for a human — and a
              pulse there would claim work is happening when none is. */}
          {live.badge === "working" && (
            <span className="relative flex h-2 w-2" title="A run is in flight">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-run opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-run" />
            </span>
          )}
          <StatusPill status={live.badge} size="sm" />
        </div>
      </header>

      {live.latest && <PhaseStrip phases={live.latest.phases} />}

      {/* A pipeline with no instance still shows its shape above, every phase
          idle — which says "this is what it will do" rather than nothing at all.
          What it cannot show is a history, so it says so. */}
      {live.latest?.updatedAt == null && (
        <p className="mt-2 text-xs text-ink-faint">
          Never run.{" "}
          {admin ? "Run now fires it once, whatever its trigger says." : "Sign in above to run it."}
        </p>
      )}

      {failure && (
        <p className="mt-2.5 rounded-lg border border-fail/30 bg-fail/10 px-3 py-2 text-xs text-fail">
          {failure.step ? <span className="font-medium">{failure.step}: </span> : null}
          <span className="font-mono text-[11px] text-fail/85">
            {(failure.reason ?? "failed").split("\n")[0]}
          </span>
        </p>
      )}

      {!admin ? null : (
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
      )}
    </div>
  );
}

export default function Pipelines() {
  const { pipelines, loading, error, create, update, remove, setEnabled, runNow } = usePipelines();
  const { overview, abort } = useOverview();
  const auth = useAuth();
  const isAdmin = auth.status?.authenticated === true;
  const liveByPipeline = useMemo(() => {
    const m = new Map<string, PipelineLive>();
    for (const entry of overview) {
      const rows = toOverviewRows(entry);
      const active = rows.filter((r) => r.badge === "working" || r.badge === "await");
      m.set(entry.definition.id, {
        badge: active.some((r) => r.badge === "await") ? "await" : rows[0].badge,
        activeIds: active.map((r) => r.instanceId).filter((id): id is string => id !== null),
        // Prefer a live row over the newest terminal one: while something is
        // running, that is the run the reader is asking about.
        latest: active[0] ?? rows[0],
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
      // A 401 here means the session expired server-side — re-check so the
      // login panel replaces the (now useless) admin controls.
      void auth.refresh();
    }
  };

  return (
    <Page
      title="Pipelines"
      actions={
        isAdmin ? (
          <div className="flex items-center gap-2">
            {mode.kind === "none" && (
              <button
                type="button"
                onClick={() => setMode({ kind: "new" })}
                className="rounded-lg bg-ok/20 px-3 py-1.5 text-sm text-ok ring-1 ring-ok/30 hover:bg-ok/30"
              >
                + New pipeline
              </button>
            )}
            <span className="text-xs text-ink-faint">{auth.status?.username}</span>
            <button
              type="button"
              onClick={() => void auth.logout()}
              className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
            >
              Sign out
            </button>
          </div>
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

      {auth.status && !isAdmin && (
        <div className="mb-6">
          <AdminAuthPanel
            configured={auth.status.configured}
            onLogin={auth.login}
            onSetup={auth.setup}
            onRegister={auth.register}
          />
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

      <Handoff busy={loading} label="pipelines" skeleton={<SkeletonRows count={3} />}>
        {pipelines.length === 0 && mode.kind === "none" ? (
          <EmptyState>
            <p className="text-sm text-ink-dim">No pipelines yet.</p>
            <p className="mx-auto mt-2 max-w-lg text-xs">
              A pipeline is ordered <strong className="text-ink-dim">phases</strong>, each with a
              working directory and one or more steps — a step being one headless agent run, on
              whichever runtime that step, phase or pipeline names. Any phase can be{" "}
              <strong className="text-ink-dim">gated</strong>, which pauses the pipeline there until
              a human approves or sends it back with a note. Once created it appears on the Command
              Center wall, where you approve gates and watch steps as they work.
            </p>
          </EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {pipelines.map((p) => (
              <PipelineCard
                key={p.id}
                def={p}
                live={liveByPipeline.get(p.id) ?? { badge: "idle", activeIds: [], latest: null }}
                admin={isAdmin}
                onEdit={() => setMode({ kind: "edit", id: p.id })}
                setEnabled={guarded((id) => setEnabled(id, !p.enabled))}
                remove={guarded(remove)}
                runNow={guarded(runNow)}
                abort={guarded(abort)}
              />
            ))}
          </div>
        )}
      </Handoff>
    </Page>
  );
}
