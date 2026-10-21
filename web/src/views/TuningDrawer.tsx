import { Drawer } from "../ds/Drawer";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertStrip,
  Button,
  formatCost,
  Icon,
  Loading,
  Skeleton,
  SkeletonText,
  StatusPill,
  type DsStatus,
} from "../ds";
import { useTuning } from "../useTuning";
import type {
  PhaseTuning,
  PhaseTuningStatus,
  PipelineDefinition,
  PipelineInput,
  TuningProposal,
} from "../types";
import { applyTuningReport, proposalKey } from "./tuningApply";
import { useAsk, type Ask } from "../ds/useAsk";
import { loadError } from "../live/loadError";

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
  // Ticking a proposal is a selection, so it lights in the selection colour —
  // not green, which on this app means "it worked".
  return (
    <li>
      <label
        className={`flex cursor-pointer items-start gap-3 rounded-control border px-3 py-2.5 transition-[border-color,background-color] duration-(--duration-quick) ${
          checked
            ? "border-eye/45 bg-eye/[0.06]"
            : "border-line bg-ground-2/60 hover:border-line-strong"
        }`}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-0.5 h-4 w-4 shrink-0 accent-eye"
          aria-label={`Apply ${FIELD_LABEL[proposal.field]} for ${target}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-small font-semibold text-ink">{target}</span>
            <span className="text-caption text-ink-faint">{FIELD_LABEL[proposal.field]}</span>
            <span className="inline-flex items-center gap-1.5 font-mono text-caption">
              <span className="text-ink-faint line-through">{proposal.before}</span>
              <Icon name="arrow-right" size={12} className="text-ink-faint" />
              <span className="font-semibold text-ink">{proposal.after}</span>
            </span>
          </span>
          <span className="mt-1 block text-small text-ink-dim">
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
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <header className="flex items-center justify-between gap-3">
        <h3 className="min-w-0 truncate text-heading font-semibold text-ink">
          <span className="font-normal text-ink-faint">{index + 1}. </span>
          {phase.phaseName}
        </h3>
        {/* The nearest grey state reads "Stopped", which a phase the pass chose
            not to read never was — so it is named for what it is. */}
        <StatusPill
          status={PHASE_BADGE[phase.status]}
          size="sm"
          label={phase.status === "skipped" ? "Skipped" : undefined}
        />
      </header>
      {phase.summary && <p className="mt-1.5 text-small text-ink-dim">{phase.summary}</p>}
      {phase.status === "running" && (
        <div className="mt-2">
          <p className="text-caption text-ink-faint">Reading this phase's steps…</p>
          <SkeletonText lines={2} className="mt-2" />
        </div>
      )}
      {/* A skip is not a failure: its note is said in the pill's quiet grey,
          and only a failed phase's reason in red. */}
      {phase.status === "failed" && phase.error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-caption text-fail-ink">
          <Icon name="alert" size={14} className="mt-px shrink-0 text-fail" />
          <span className="min-w-0 break-words">{phase.error}</span>
        </p>
      )}
      {phase.status === "skipped" && phase.error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-caption text-ink-dim">
          <Icon name="info" size={14} className="mt-px shrink-0 text-ink-faint" />
          <span className="min-w-0 break-words">{phase.error}</span>
        </p>
      )}
      {phase.status === "ready" && phase.proposals.length === 0 && (
        <p className="mt-2.5 flex items-center gap-2 rounded-control border border-ok/25 bg-ok/[0.06] px-3 py-2 text-small text-ink-dim">
          <Icon name="check-circle" size={16} className="shrink-0 text-ok" />
          No changes recommended — this phase's settings already fit its steps.
        </p>
      )}
      {phase.proposals.length > 0 && (
        <ul className="mt-2.5 space-y-2">
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
        <ul className="mt-2.5 space-y-1">
          {phase.warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-1.5 text-caption text-ink-faint">
              <Icon name="info" size={13} className="mt-px shrink-0" />
              <span className="min-w-0">{w}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The report's shape while it is on its way: one block per phase. */
function ReportSkeleton({ phases, label }: { phases: number; label: string }) {
  return (
    <Loading label="the analysis">
      <p className="mb-4 text-caption text-ink-faint">{label}</p>
      <div className="space-y-5">
        {Array.from({ length: Math.max(1, phases) }, (_, i) => (
          <div key={i} className="space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <SkeletonText lines={2} />
          </div>
        ))}
      </div>
    </Loading>
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
  /** Saves the merged definition; `ask` poses a question above Apply when the
   *  save needs the author's say-so first. */
  onApply: (input: PipelineInput, ask: Ask) => Promise<void>;
}) {
  const { report, unavailable, loading, error, busy, actionError, analyse, refresh } = useTuning(
    def.id,
  );
  // The selection is keyed by report id: a fresh report's proposals are not
  // the ones that were ticked, so a new id reads as an empty selection.
  const [sel, setSel] = useState<{ reportId: string | null; keys: Set<string> }>({
    reportId: null,
    keys: new Set(),
  });
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [ask, question] = useAsk();

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
  const cost = report ? formatCost(report.tokens, report.costUsd) : null;

  const toggle = (key: string) =>
    setSel((prev) => {
      const next = new Set(prev.reportId === reportId ? prev.keys : []);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { reportId, keys: next };
    });

  const apply = async () => {
    if (!report || selected.size === 0 || applying) return;
    setApplying(true);
    setApplyError(null);
    // An author who answers no to a question asked mid-save has not applied
    // anything, so the drawer stays open with their ticks, as the edit form
    // stays open with their edit.
    let declined = false;
    const asking: Ask = async (question) => {
      const yes = await ask(question);
      declined ||= !yes;
      return yes;
    };
    try {
      await onApply(applyTuningReport(def, report, selected), asking);
      if (!declined) onClose();
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
        <div className="flex flex-wrap items-center gap-2">
          {question}
          <Button
            variant="ghost"
            icon="retry"
            onClick={() => void analyse()}
            disabled={busy || running || Boolean(unavailable)}
          >
            Analyze again
          </Button>
          {cost && (
            <span className="text-caption text-ink-faint" title="What this pass has cost so far">
              {cost}
            </span>
          )}
          <Button
            variant="primary"
            icon="check"
            className="ml-auto"
            onClick={() => void apply()}
            // Held by aria while it saves, so it keeps its focus for a
            // question asked mid-save to hand back.
            disabled={running || selected.size === 0}
            aria-disabled={applying || undefined}
          >
            Apply selected ({selected.size})
          </Button>
        </div>
      }
    >
      <p className="mb-5 flex items-start gap-2.5 text-small text-ink-dim">
        <Icon name="sparkle" size={16} className="mt-0.5 shrink-0 text-ink-faint" />
        <span>
          One agent per phase reads the step prompts and judges whether the model, effort, timeout
          and turn settings fit the work. Prompts are never changed. Nothing is saved until you tick
          a proposal and apply it.
        </span>
      </p>
      {unavailable && (
        <p className="mb-4 flex items-start gap-2 rounded-control border border-line bg-ground-2/60 px-3 py-2.5 text-small text-ink-dim">
          <Icon name="info" size={16} className="mt-px shrink-0 text-ink-faint" />
          <span className="min-w-0">{unavailable}</span>
        </p>
      )}
      {(error || actionError || applyError) && (
        <div className="mb-4">
          <AlertStrip
            subject={applyError ? "Couldn't apply" : "Analyze"}
            message={
              applyError ?? actionError ?? (error ? loadError("the tuning report", error) : "")
            }
            // A refused pass is retried by asking again, a failed read by
            // reading again. A failed apply has its retry already: Apply.
            action={
              applyError ? undefined : (
                <Button
                  size="sm"
                  icon="retry"
                  disabled={busy}
                  onClick={() => void (actionError ? analyse() : refresh())}
                >
                  Retry
                </Button>
              )
            }
          />
        </div>
      )}
      {report?.status === "skipped" && report.error && (
        <p className="mb-4 flex items-start gap-2 rounded-control border border-line bg-ground-2/60 px-3 py-2.5 text-small text-ink-dim">
          <Icon name="info" size={16} className="mt-px shrink-0 text-ink-faint" />
          <span className="min-w-0">{report.error}</span>
        </p>
      )}
      {/* The skeleton promises a report on its way; under an error nothing is,
          and a shimmer that never resolves contradicts the strip above it. */}
      {!report && !unavailable && !error && !actionError && (
        <ReportSkeleton
          phases={def.phases.length}
          label={loading ? "Reading the last pass…" : "Starting the pass…"}
        />
      )}
      {report && (
        <div className="space-y-4">
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
