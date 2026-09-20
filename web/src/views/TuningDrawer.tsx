import { useEffect, useMemo, useRef, useState } from "react";
import { Drawer, StatusPill, type DsStatus } from "../ds";
import { useTuning } from "../useTuning";
import type {
  PhaseTuning,
  PhaseTuningStatus,
  PipelineDefinition,
  PipelineInput,
  TuningProposal,
} from "../types";
import { applyTuningReport, proposalKey } from "./tuningApply";

const PHASE_BADGE: Record<PhaseTuningStatus, DsStatus> = {
  pending: "queued",
  running: "working",
  ready: "done",
  failed: "failed",
  skipped: "stopped",
};

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

const FIELD_LABEL: Record<TuningProposal["field"], string> = {
  model: "model",
  reasoningEffort: "reasoning effort",
  timeoutSeconds: "timeout (s)",
  maxTurns: "max turns",
};

function ProposalRow({
  proposal,
  checked,
  onToggle,
}: {
  proposal: TuningProposal;
  checked: boolean;
  onToggle: () => void;
}) {
  const target = proposal.scope === "phase" ? "phase default" : proposal.stepName;
  const inherited =
    proposal.scope === "step" && proposal.inheritedFrom !== "step"
      ? ` (currently inherited from ${proposal.inheritedFrom})`
      : "";
  return (
    <li className="rounded-lg border border-line bg-ground-2 px-3 py-2">
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-0.5 shrink-0 accent-ok"
          aria-label={`Apply ${FIELD_LABEL[proposal.field]} for ${target}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="font-medium text-ink">{target}</span>
            <span className="text-ink-faint">{FIELD_LABEL[proposal.field]}</span>
            <span className="font-mono text-[11px] text-ink-dim">
              <span className="line-through opacity-70">{proposal.before}</span>
              <span aria-hidden="true"> → </span>
              <span className="text-ink">{proposal.after}</span>
            </span>
          </span>
          <span className="mt-1 block text-xs text-ink-dim">
            {proposal.reason}
            {inherited && <span className="text-ink-faint">{inherited}</span>}
          </span>
        </span>
      </label>
    </li>
  );
}

function PhaseSection({
  phase,
  index,
  selected,
  onToggle,
}: {
  phase: PhaseTuning;
  index: number;
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <section className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <header className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-semibold text-ink">
          <span className="text-ink-faint">{index + 1}. </span>
          {phase.phaseName}
        </h3>
        <StatusPill status={PHASE_BADGE[phase.status]} size="sm" />
      </header>
      {phase.summary && <p className="mt-1 text-xs text-ink-dim">{phase.summary}</p>}
      {phase.status === "running" && (
        <p className="mt-1 text-xs text-ink-faint">Reading this phase's steps…</p>
      )}
      {(phase.status === "failed" || phase.status === "skipped") && phase.error && (
        <p className="mt-1 font-mono text-[11px] text-fail/85">{phase.error}</p>
      )}
      {phase.status === "ready" && phase.proposals.length === 0 && (
        <p className="mt-2 rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok">
          No changes recommended — this phase's settings already fit its steps.
        </p>
      )}
      {phase.proposals.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {phase.proposals.map((p) => {
            const key = proposalKey(p);
            return (
              <ProposalRow
                key={key}
                proposal={p}
                checked={selected.has(key)}
                onToggle={() => onToggle(key)}
              />
            );
          })}
        </ul>
      )}
      {phase.warnings.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {phase.warnings.map((w, i) => (
            <li key={i} className="text-[11px] text-ink-faint">
              {w}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The review surface for one pipeline's tuning pass.
 *
 * Owns the single live subscription for the report — mounted only while open,
 * so a board of twenty pipelines does not carry twenty sockets' worth of
 * refetch. Opening it starts a pass unless one is already running; every
 * proposal is a checkbox, and **Apply selected** hands the merged definition
 * to the caller, which saves it exactly as an edit would. No prompt text is
 * ever rendered here: prompts are input to the analysis, not its output.
 */
export function TuningDrawer({
  def,
  onClose,
  onApply,
}: {
  def: PipelineDefinition;
  onClose: () => void;
  onApply: (input: PipelineInput) => Promise<void>;
}) {
  const { report, unavailable, loading, error, busy, actionError, analyse } = useTuning(def.id);
  // The selection is keyed by report id: a fresh report's proposals are not
  // the ones that were ticked, so a new id reads as an empty selection.
  const [sel, setSel] = useState<{ reportId: string | null; keys: Set<string> }>({
    reportId: null,
    keys: new Set(),
  });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  // One press = one pass. Start it once the first read is in, unless that read
  // shows a pass already running for this pipeline.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || loading || unavailable) return;
    started.current = true;
    if (report?.status !== "running") void analyse();
  }, [loading, unavailable, report?.status, analyse]);

  const reportId = report?.id ?? null;
  const selected: ReadonlySet<string> = sel.reportId === reportId ? sel.keys : EMPTY_SELECTION;

  const total = useMemo(
    () => report?.phases.reduce((n, p) => n + p.proposals.length, 0) ?? 0,
    [report],
  );
  const running = report?.status === "running";

  const toggle = (key: string) =>
    setSel((prev) => {
      const next = new Set(prev.reportId === reportId ? prev.keys : []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { reportId, keys: next };
    });

  const apply = async () => {
    if (!report || selected.size === 0) return;
    setApplying(true);
    setApplyError(null);
    try {
      await onApply(applyTuningReport(def, report, selected));
      onClose();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const subtitle = running
    ? `Analyzing phase ${Math.min(report.phasesDone + 1, report.phasesTotal)} of ${report.phasesTotal}`
    : report
      ? `${total} proposal${total === 1 ? "" : "s"} across ${report.phasesTotal} phase${
          report.phasesTotal === 1 ? "" : "s"
        }`
      : "Settings review";

  return (
    <Drawer
      open
      title={`Analyze · ${def.name}`}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => void analyse()}
            disabled={busy || running || Boolean(unavailable)}
            className="rounded-lg border border-line px-2.5 py-1 text-xs text-ink-dim hover:text-ink disabled:opacity-50"
          >
            Analyze again
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={applying || running || selected.size === 0}
            className="rounded-lg bg-ok/15 px-3 py-1.5 text-xs text-ok ring-1 ring-ok/30 hover:bg-ok/25 disabled:opacity-50"
          >
            Apply selected ({selected.size})
          </button>
        </div>
      }
    >
      <p className="mb-3 text-xs text-ink-faint">
        One agent per phase reads the step prompts and judges whether the model, effort, timeout and
        turn settings fit the work. Prompts are never changed. Nothing is saved until you tick a
        proposal and apply it.
      </p>
      {unavailable && (
        <p className="mb-3 rounded-lg border border-line bg-ground-2 px-3 py-2 text-xs text-ink-dim">
          {unavailable}
        </p>
      )}
      {(error || actionError || applyError) && (
        <p className="mb-3 rounded-lg border border-fail/30 bg-fail/10 px-3 py-2 text-xs text-fail">
          {applyError ?? actionError ?? error}
        </p>
      )}
      {report?.status === "skipped" && report.error && (
        <p className="mb-3 rounded-lg border border-line bg-ground-2 px-3 py-2 text-xs text-ink-dim">
          {report.error}
        </p>
      )}
      {!report && !unavailable && (
        <p className="text-xs text-ink-faint">{loading ? "Loading…" : "Starting the pass…"}</p>
      )}
      {report && (
        <div className="space-y-3">
          {report.phases.map((phase, i) => (
            <PhaseSection
              key={phase.phaseId}
              phase={phase}
              index={i}
              selected={selected}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
    </Drawer>
  );
}
