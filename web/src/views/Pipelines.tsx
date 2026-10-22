import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { runtimeLabel } from "../useRuntimes";
import { InstancesRunningError, usePipelines } from "../usePipelines";
import { useOverview } from "../useOverview";
import { useAuth } from "../useAuth";
import type { PipelineDefinition, PipelineInput } from "../types";
import {
  AlertStrip,
  Button,
  ButtonLink,
  buttonClass,
  chipClass,
  EmptyState,
  formatCost,
  formatTrigger,
  Handoff,
  Icon,
  Page,
  SkeletonTile,
  STATUS,
  StatusPill,
  TimeAgo,
  toOverviewRows,
  type DsStatus,
  type OverviewGate,
  type OverviewRow,
  type PhasePill,
} from "../ds";
import { PipelineForm, EMPTY_PIPELINE } from "./PipelineForm";
import { AdminAuthPanel } from "./AdminAuthPanel";
import { AccountPrompt } from "./AccountPrompt";
import { CardFooter, FilterChip } from "./CardActions";
import { firstProseLine } from "./outcome";
import { reasonText } from "./failureReason";
import { TuningDrawer } from "./TuningDrawer";
import { toInput } from "./tuningApply";
import { ReliabilityCard } from "./ReliabilityCard";
import AgentSkillsStrip from "./AgentSkillsStrip";
import { InfoTip } from "../ds/InfoTip";
import type { Question } from "../ds/ConfirmPanel";
import { useConfirm } from "../ds/useConfirm";
import type { Ask } from "../ds/useAsk";
import { loadError } from "../live/loadError";

/** A decision this pipeline is waiting on: a gate to approve, or a failed
 *  phase to retry or revise. Both are answered in the Command Center's review
 *  drawer, which the deep link opens directly. */
interface PipelineReview {
  href: string;
  phaseName: string;
  canApprove: boolean;
}

/** What the board already knows about this pipeline's latest run. */
interface PipelineLive {
  badge: DsStatus;
  /** Instance ids that a Stop would apply to. */
  activeIds: string[];
  /** The newest row, or null when the pipeline has never run. */
  latest: OverviewRow | null;
  review: PipelineReview | null;
}

const NEVER_RUN: PipelineLive = { badge: "idle", activeIds: [], latest: null, review: null };

/** What else a Delete does: to the instances running under the pipeline, and
 *  to the pipelines whose spawn phases start it. */
function deleteDetail(running: number, spawned: boolean): string | undefined {
  const which = running === 1 ? "running instance" : `${running} running instances`;
  const parts = [
    running > 0 && `Its ${which} will be stopped first, and in-progress work discarded.`,
    spawned && "Pipelines that spawn it stop starting new ones and wait for you.",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Stop's question and verb, for one running instance or several. */
function stopQuestion(name: string, running: number): Pick<Question, "title" | "confirm"> {
  return running > 1
    ? {
        title: `Stop all ${running} running instances of “${name}”?`,
        confirm: `Stop ${running} instances`,
      }
    : { title: `Stop running pipeline “${name}”?`, confirm: "Stop pipeline" };
}

/**
 * What is said before saving an edit over live instances; the caller adds the
 * verb. Not red: the save discards nothing, it only waits for the next start.
 *
 * The refusal lists the pipeline's own live instances and the live parents of
 * other pipelines whose spawn phases will start more of it (DL-A2). The two
 * differ: its own instances keep the definition they started with, while the
 * children a parent starts from here on run the edit.
 */
function editWhileRunning(
  name: string,
  id: string,
  instances: { pipelineId?: string }[],
): Omit<Question, "confirm"> {
  const own = instances.filter((i) => !i.pipelineId || i.pipelineId === id).length;
  const spawners = instances.length - own;
  const spawning = "of another pipeline will start more instances of";
  if (own === 0) {
    return {
      title: `${spawners === 1 ? "A live instance" : `${spawners} live instances`} ${spawning} “${name}”.`,
      detail: "Those would run this edit.",
      tone: "secondary",
    };
  }
  const which = own === 1 ? "1 instance is" : `${own} instances are`;
  const they = own === 1 ? "It keeps" : "They keep";
  return {
    title: `${which} running under “${name}”.`,
    detail:
      `${they} the definition it started with, so this edit only applies to the next start.` +
      (spawners > 0
        ? " Live instances of another pipeline will also start more of it, and those would run this edit."
        : ""),
    tone: "secondary",
  };
}

/** The latest instance's trigger, when it is worth a chip: how it started, if
 *  not by hand or on the pipeline's own schedule. */
const TRIGGER_TITLE = {
  webhook: "The latest instance was fired by a webhook POST",
  chained: "The latest instance was chained after another pipeline's instance",
  spawned: "The latest instance was started by another pipeline's spawn phase",
} as const;

/** The same deep link the Command Center hands out for a gate. */
function reviewOf(row: OverviewRow | undefined, gate: OverviewGate | undefined) {
  if (!row?.instanceId || row.orphaned || !gate) return null;
  return {
    href: `#/command/${encodeURIComponent(row.instanceId)}/${encodeURIComponent(gate.phaseId)}`,
    phaseName: row.phases.find((p) => p.id === gate.phaseId)?.name ?? gate.phaseId,
    canApprove: gate.canApprove,
  };
}

/** "daily at 02:00" → "Daily at 02:00": the meta line is a sentence fragment. */
function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
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

/** The phases a reader is looking for get their colour on the chip as well as
 *  the dot; finished and upcoming ones stay quiet. */
const CHIP: Partial<Record<DsStatus, string>> = {
  working: "border-run/35 text-ink",
  await: "border-await/40 bg-await/[0.08] text-await-ink",
  failed: "border-fail/35 bg-fail/[0.07] text-fail-ink",
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
    <ol aria-label="Phases of the latest run" className="mt-3 flex flex-wrap items-center gap-1.5">
      {phases.map((phase, i) => (
        <li
          key={phase.id}
          title={`${i + 1}. ${phase.name} — ${STATUS[phase.status].label.toLowerCase()}${
            phase.activeStep ? ` (${phase.activeStep})` : ""
          }`}
          className={`inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-ground-2/60 px-2 ${
            CHIP[phase.status] ?? "border-line text-ink-dim"
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[phase.status]}`}
          />
          <span className="min-w-0 max-w-[12rem] truncate text-caption">{phase.name}</span>
          {phase.steps.length > 1 && (
            <span className="text-micro text-ink-faint">{phase.steps.length}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * A meta line with one separator between every pair of items.
 *
 * Each item carries its own leading dot, and the line is shifted left by one
 * dot's width inside a clipping box — so whichever item starts a line, the
 * first or one that wrapped, has its dot clipped away. A wrapping line of
 * literal separators always left one dangling at the end of a row.
 */
function MetaLine({ items }: { items: ReactNode[] }) {
  return (
    <div className="mt-1.5 overflow-hidden">
      <p className="-ml-4 flex flex-wrap items-center gap-y-1 text-caption text-ink-faint">
        {items.filter(Boolean).map((item, i) => (
          <span
            key={i}
            className="relative pl-4 before:absolute before:left-[5px] before:text-ink-faint/60 before:content-['·']"
          >
            {item}
          </span>
        ))}
      </p>
    </div>
  );
}

/**
 * The card's edge carries the alarm, as a schedule card's does. Waiting on a
 * human is the louder of the two: it is the one state on this page that cannot
 * move until someone acts, and it used to be the quieter card beside a red one.
 */
function cardTone(badge: DsStatus): string {
  if (badge === "await")
    return "border-await/40 bg-surface bg-gradient-to-b from-await/[0.07] to-await/[0.02]";
  if (badge === "failed")
    return "border-fail/35 bg-surface bg-gradient-to-b from-fail/[0.07] to-fail/[0.02]";
  return "border-line bg-surface";
}

function PipelineCard({
  def,
  live,
  spawnedBy,
  admin,
  error,
  editRef,
  onEdit,
  onAnalyze,
  setEnabled,
  remove,
  runNow,
  abort,
}: {
  def: PipelineDefinition;
  live: PipelineLive;
  /** The pipelines whose spawn phases start this one, by name. */
  spawnedBy: string[];
  /** Edit/run controls only render for an authenticated admin. */
  admin: boolean;
  /** The last action on this card that the server refused, said here rather
   *  than at the top of a long page. */
  error: string | null;
  /** The Edit button, so focus can come back to it when the editor closes. */
  editRef: Ref<HTMLButtonElement>;
  onEdit: () => void;
  onAnalyze: () => void;
  setEnabled: (id: string, enabled: boolean) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  runNow: (id: string) => Promise<unknown>;
  abort: (id: string) => Promise<unknown>;
}) {
  const abortable = live.activeIds.length > 0;
  const stopLabel = live.activeIds.length > 1 ? `Stop all (${live.activeIds.length})` : "Stop";
  const confirm = useConfirm();
  const steps = def.phases.reduce((n, p) => n + p.steps.length, 0);
  const cost = formatCost(live.latest?.cost?.tokens, live.latest?.cost?.usd);
  const failure = live.badge === "failed" ? live.latest?.failure : null;
  const [showReliability, setShowReliability] = useState(false);
  const titleId = useId();

  const chips = [
    def.model && (
      <span key="model" className={chipClass()} title="Default model for this pipeline's steps">
        {def.model}
      </span>
    ),
    def.runtime && (
      <span
        key="runtime"
        className={chipClass()}
        title="Agent CLI this pipeline's steps run on, unless a phase or step overrides it"
      >
        {runtimeLabel(def.runtime) || def.runtime}
      </span>
    ),
    live.latest?.trigger && live.latest.trigger in TRIGGER_TITLE && (
      <span
        key="trigger"
        className={chipClass()}
        title={TRIGGER_TITLE[live.latest.trigger as keyof typeof TRIGGER_TITLE]}
      >
        {live.latest.trigger}
      </span>
    ),
  ].filter(Boolean);

  return (
    // Named by its title: every card's footer reads "Run now", "Edit",
    // "Disable", so the card is what tells a screen reader whose they are.
    <article
      aria-labelledby={titleId}
      className={`flex min-w-0 flex-col rounded-tile border shadow-raised ${cardTone(live.badge)}`}
    >
      <div className="min-w-0 px-4 pb-3 pt-4 sm:px-5">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3
                id={titleId}
                className="mr-1 min-w-0 break-words text-title font-semibold text-ink"
              >
                {def.name}
              </h3>
              {!def.enabled && (
                <span
                  className={`${chipClass()} capitalize`}
                  title="A paused pipeline does not fire on its trigger; Run now still works"
                >
                  <Icon name="pause" size={11} />
                  paused
                </span>
              )}
              {chips}
            </div>
            {/* What the list used to say in full: a trigger and a phase count. The
                rest is what a reader came for — when it last did anything, what it
                cost. What it runs on sits beside the name, as chips. */}
            <MetaLine
              items={[
                <span key="trigger" className="text-ink-dim">
                  {sentence(formatTrigger(def.trigger))}
                </span>,
                <span key="shape">
                  {def.phases.length} phase{def.phases.length === 1 ? "" : "s"}, {steps} step
                  {steps === 1 ? "" : "s"}
                </span>,
                live.latest?.updatedAt && (
                  <span key="activity">
                    last activity <TimeAgo iso={live.latest.updatedAt} />
                  </span>
                ),
                cost && (
                  <span key="cost" title="Spend of the latest run, all attempts">
                    {cost}
                  </span>
                ),
                // Its trigger reads "Manual", which is not how a spawn target
                // usually starts.
                spawnedBy.length > 0 && (
                  <span key="spawnedBy" title="A spawn phase of these pipelines starts it">
                    spawned by {spawnedBy.join(", ")}
                  </span>
                ),
              ]}
            />
          </div>
          {/* The pill is the live signal: it breathes while a run works and while
              a gate waits, and is still otherwise. A second ping beside it used
              to claim work was happening on a pipeline that was only waiting. */}
          <StatusPill status={live.badge} />
        </header>

        {live.latest && <PhaseStrip phases={live.latest.phases} />}

        {/* A pipeline with no instance still shows its shape above, every phase
            idle — which says "this is what it will do" rather than nothing at all.
            What it cannot show is a history, so it says so. */}
        {live.latest?.updatedAt == null && (
          <p className="mt-3 flex items-center gap-1.5 text-caption text-ink-faint">
            <Icon name="info" size={14} />
            <span>
              Never run.{" "}
              {admin
                ? "Run now fires it once, whatever its trigger says."
                : "Sign in above to run it."}
            </span>
          </p>
        )}

        {/* The one thing on this page that needs a human gets the loudest
            treatment on it, and a way straight to the decision. */}
        {live.badge === "await" && live.review?.canApprove && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-await/35 bg-await/[0.07] px-3 py-2.5">
            <Icon name="approve" size={18} className="text-await" />
            <p className="min-w-0 flex-1 text-small text-ink-dim">
              <span className="font-semibold text-ink">{live.review.phaseName}</span> is waiting for
              your approval.
            </p>
            <ButtonLink
              href={live.review.href}
              variant="attention"
              size="sm"
              iconRight="arrow-right"
            >
              Review
            </ButtonLink>
          </div>
        )}

        {failure && (
          <div className="mt-3 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-control border border-fail/30 bg-fail/[0.06] px-3 py-2.5">
            <Icon name="alert" size={18} className="mt-px text-fail" />
            <p className="min-w-0 flex-1 break-words text-small text-fail-ink">
              {failure.step ? (
                <span className="font-semibold text-ink">{failure.step}: </span>
              ) : null}
              {/* The first line of prose: a reason that is only the agent's
                  outcome marker reads as the marker's own reason. Told as the
                  board and the drawers tell it, without a "failed:" the red
                  box already says. */}
              <span>{reasonText(firstProseLine(failure.reason)) || "Failed"}</span>
            </p>
            {live.review && !live.review.canApprove && (
              // The box already says "failed"; the button only goes somewhere, so
              // it is not dressed as the destructive action red means on a control.
              <ButtonLink
                href={live.review.href}
                variant="secondary"
                size="sm"
                iconRight="arrow-right"
                title={`Open what ${live.review.phaseName} left behind, then retry or revise it`}
              >
                Review
              </ButtonLink>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowReliability((v) => !v)}
          aria-expanded={showReliability}
          className={buttonClass("ghost", "sm", "mt-2.5")}
        >
          <Icon name="activity" size={14} />
          Reliability
          <Icon
            name="chevron-down"
            size={14}
            className={`text-ink-faint transition-transform duration-(--duration-base) ease-(--ease-out-expo) ${
              showReliability ? "rotate-180" : ""
            }`}
          />
        </button>
        {showReliability && <ReliabilityCard pipelineId={def.id} />}
      </div>

      {admin && (
        <CardFooter
          error={error}
          question={
            confirm.armed === "delete"
              ? confirm.question(
                  {
                    title: `Delete pipeline “${def.name}”?`,
                    detail: deleteDetail(live.activeIds.length, spawnedBy.length > 0),
                    confirm: "Delete pipeline",
                    cancel: "Keep",
                    icon: "trash",
                  },
                  () => void remove(def.id),
                )
              : confirm.armed === "stop"
                ? confirm.question(
                    {
                      ...stopQuestion(def.name, live.activeIds.length),
                      detail: def.phases.some((p) => p.spawn)
                        ? "In-progress work will be discarded, and the instances they spawned are stopped too."
                        : "In-progress work will be discarded.",
                      cancel: "Keep running",
                      icon: "stop",
                    },
                    // The instances running when the answer comes, not when
                    // Stop was pressed.
                    () => {
                      for (const id of live.activeIds) void abort(id);
                    },
                  )
                : null
          }
          manage={
            <>
              <Button
                variant="ghost"
                size="sm"
                icon="power"
                onClick={() => void setEnabled(def.id, !def.enabled)}
                title={
                  def.enabled
                    ? "Pause its trigger. Run now keeps working."
                    : "Let its trigger fire again"
                }
              >
                {def.enabled ? "Disable" : "Enable"}
              </Button>
              <Button
                variant="quiet-danger"
                size="sm"
                icon="trash"
                // Every card's button reads "Delete"; the name says which one.
                aria-label={`Delete ${def.name}`}
                aria-expanded={confirm.armed === "delete"}
                onClick={confirm.toggle("delete")}
              >
                Delete
              </Button>
            </>
          }
        >
          {(!abortable || def.overlapPolicy === "allow") && (
            <Button size="sm" icon="play" onClick={() => void runNow(def.id)}>
              Run now
            </Button>
          )}
          {abortable && (
            <Button
              variant="danger"
              size="sm"
              icon="stop"
              aria-expanded={confirm.armed === "stop"}
              onClick={confirm.toggle("stop")}
            >
              {stopLabel}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon="sparkle"
            onClick={onAnalyze}
            title="Ask one agent per phase whether this pipeline's model and effort settings fit its steps. Prompts are never changed; nothing is saved until you apply a proposal."
          >
            Analyze
          </Button>
          <Button ref={editRef} variant="ghost" size="sm" icon="edit" onClick={onEdit}>
            Edit
          </Button>
        </CardFooter>
      )}
    </article>
  );
}

/**
 * The signed-in admin, and Sign out, behind one control. This page is where an
 * admin signs in, so it is where they can see who they are — but a
 * session-ending action does not belong beside the page's primary button.
 */
function AccountMenu({
  username,
  onSignOut,
}: {
  username: string | null | undefined;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  // Closes like any popover: a press outside it, or Escape (which hands focus
  // back to the control that opened it).
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <Button
        ref={triggerRef}
        variant="ghost"
        size="sm"
        icon="user"
        iconRight="chevron-down"
        aria-expanded={open}
        aria-controls={panelId}
        title="Your account"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="max-w-[10rem] truncate">{username}</span>
      </Button>
      {open && (
        <div
          id={panelId}
          className="absolute left-0 top-full z-20 mt-1.5 w-56 rounded-control border border-line bg-surface-2 p-1.5 shadow-overlay sm:left-auto sm:right-0"
        >
          <p className="truncate px-2 pb-1.5 pt-1 text-caption text-ink-faint">
            Signed in as <span className="font-semibold text-ink-dim">{username}</span>
          </p>
          <Button
            variant="ghost"
            size="sm"
            icon="logout"
            className="w-full justify-start"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            Sign out
          </Button>
        </div>
      )}
    </div>
  );
}

/** What a pipeline is, for a page with none: two sentences and the next
 *  step, with the anatomy on demand. */
function AboutPipelines() {
  return (
    <p className="max-w-xl">
      Ordered <strong className="text-ink">phases</strong> of headless agent runs. Any phase can be{" "}
      <strong className="text-ink">gated</strong>, which pauses the pipeline there until a human
      approves or sends it back with a note.{" "}
      <InfoTip title="What's a pipeline?">
        Each phase has a working directory and one or more steps — a step being one headless agent
        run, on whichever runtime that step, phase or pipeline names. Once created, a pipeline
        appears on the Command Center wall, where you approve gates and watch steps as they work.
      </InfoTip>
    </p>
  );
}

type Filter = "all" | "await" | "failed" | "paused";

/** Which pipelines a filter keeps. */
function matches(filter: Filter, def: PipelineDefinition, live: PipelineLive): boolean {
  if (filter === "all") return true;
  if (filter === "paused") return !def.enabled;
  return live.badge === filter;
}

/**
 * Counts worth a glance before the list, said only when non-zero, each one a
 * filter — waiting on you first, because that is what this page is for. What
 * is working is said but not offered as a filter: its pill already breathes.
 */
function ListSummary({
  pipelines,
  live,
  filter,
  onFilter,
}: {
  pipelines: PipelineDefinition[];
  live: Map<string, PipelineLive>;
  filter: Filter;
  onFilter: (f: Filter) => void;
}) {
  const count = (status: DsStatus) =>
    pipelines.filter((p) => (live.get(p.id) ?? NEVER_RUN).badge === status).length;
  const waiting = count("await");
  const failed = count("failed");
  const working = count("working");
  const paused = pipelines.filter((p) => !p.enabled).length;
  const toggle = (f: Filter) => () => onFilter(filter === f ? "all" : f);
  return (
    <div
      role="group"
      aria-label="Filter pipelines"
      className="mb-4 flex flex-wrap items-center gap-2"
    >
      <FilterChip selected={filter === "all"} onClick={() => onFilter("all")}>
        All <span className="font-semibold text-ink-faint">{pipelines.length}</span>
      </FilterChip>
      {waiting > 0 && (
        <FilterChip selected={filter === "await"} onClick={toggle("await")}>
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-await" />
          {/* The Command Center's words for the same state, on its strip and
              pills: "awaiting you" here read as a different state. */}
          <span className="text-await">
            {waiting} {waiting === 1 ? "needs" : "need"} approval
          </span>
        </FilterChip>
      )}
      {failed > 0 && (
        <FilterChip selected={filter === "failed"} onClick={toggle("failed")}>
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-fail" />
          <span className="text-fail">{failed} failed</span>
        </FilterChip>
      )}
      {paused > 0 && (
        <FilterChip selected={filter === "paused"} onClick={toggle("paused")}>
          {paused} paused
        </FilterChip>
      )}
      {working > 0 && (
        <span className="inline-flex items-center gap-1.5 pl-1 text-caption font-semibold text-run">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
          {working} working
        </span>
      )}
    </div>
  );
}

export default function Pipelines() {
  const {
    pipelines,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    setEnabled,
    runNow,
    rotateHookToken,
  } = usePipelines();
  const { overview, abort } = useOverview();
  const auth = useAuth();
  // Which pipelines spawn each one: a spawn target's card names them.
  const spawnedBy = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const p of pipelines) {
      for (const phase of p.phases) {
        const target = phase.spawn?.pipelineId;
        if (target) m.set(target, (m.get(target) ?? new Set()).add(p.name));
      }
    }
    return m;
  }, [pipelines]);
  const { isAdmin } = auth;
  const liveByPipeline = useMemo(() => {
    const m = new Map<string, PipelineLive>();
    for (const entry of overview) {
      const rows = toOverviewRows(entry);
      const active = rows.filter((r) => r.badge === "working" || r.badge === "await");
      const badge = active.some((r) => r.badge === "await") ? "await" : rows[0].badge;
      const waiting = active.find((r) => r.badge === "await" && r.gates.some((g) => g.canApprove));
      m.set(entry.definition.id, {
        badge,
        activeIds: active.map((r) => r.instanceId).filter((id): id is string => id !== null),
        // Prefer a live row over the newest terminal one: while something is
        // running, that is the run the reader is asking about.
        latest: active[0] ?? rows[0],
        review: waiting
          ? reviewOf(
              waiting,
              waiting.gates.find((g) => g.canApprove),
            )
          : badge === "failed"
            ? reviewOf(rows[0], rows[0].gates[0])
            : null,
      });
    }
    return m;
  }, [overview]);
  const [mode, setMode] = useState<
    { kind: "none" } | { kind: "new" } | { kind: "edit"; id: string } | { kind: "tune"; id: string }
  >({ kind: "none" });
  const [filter, setFilter] = useState<Filter>("all");
  // The card being edited stays on screen whatever the filter says: a filter
  // must never take an open editor, and what was typed in it, away.
  const shown = pipelines.filter(
    (p) =>
      (mode.kind === "edit" && mode.id === p.id) ||
      matches(filter, p, liveByPipeline.get(p.id) ?? NEVER_RUN),
  );
  const [actionError, setActionError] = useState<{ pipelineId: string; message: string } | null>(
    null,
  );

  const tuning = mode.kind === "tune" ? pipelines.find((p) => p.id === mode.id) : undefined;
  const formOpen = mode.kind === "new" || mode.kind === "edit";

  // A form opens in place of the control that opened it, which unmounts (the
  // Edit button goes with its card) or is disabled (New pipeline), so focus
  // would fall back to the top of the document. The form takes the caret when
  // it opens; on the way out, focus goes back to whatever opened it.
  const newButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocus = useRef<(() => HTMLElement | null | undefined) | null>(null);
  const closeForm = (back: () => HTMLElement | null | undefined) => {
    returnFocus.current = back;
    setMode({ kind: "none" });
  };
  useEffect(() => {
    if (mode.kind !== "none" || !returnFocus.current) return;
    const target = returnFocus.current();
    returnFocus.current = null;
    target?.focus();
  }, [mode]);

  /** Save a definition the way the edit form does: refuse-then-confirm when
   *  instances are running under the current one. */
  const saveDefinition = async (def: PipelineDefinition, input: PipelineInput, ask: Ask) => {
    try {
      await update(def.id, input);
    } catch (e) {
      if (!(e instanceof InstancesRunningError)) throw e;
      const question = editWhileRunning(def.name, def.id, e.instances);
      if (!(await ask({ ...question, confirm: "Apply anyway" }))) return;
      await update(def.id, input, { force: true });
    }
  };

  const guarded =
    (pipelineId: string, fn: (id: string) => Promise<unknown>) => async (id: string) => {
      setActionError(null);
      try {
        await fn(id);
      } catch (e) {
        setActionError({ pipelineId, message: e instanceof Error ? e.message : String(e) });
        // A 401 here means the session expired server-side — re-check so the
        // login panel replaces the (now useless) admin controls.
        void auth.refresh();
      }
    };

  return (
    <Page
      title="Pipelines"
      subtitle="Multi-phase agent work: each pipeline's phases, gates and trigger, and where its latest run got to."
      actions={
        isAdmin ? (
          <>
            {/* Who you are, and the way out, folded behind one quiet control:
                Sign out used to sit one button from New pipeline. */}
            <AccountMenu username={auth.status?.username} onSignOut={() => void auth.logout()} />
            {/* Disabled while a form is open rather than removed: removing it
                slid the account control under the pointer that had just
                clicked here. Secondary on an empty page, whose own call to
                action is the one to look at. */}
            <Button
              ref={newButton}
              variant={pipelines.length === 0 && !loading ? "secondary" : "primary"}
              icon="plus"
              disabled={formOpen}
              onClick={() => setMode({ kind: "new" })}
            >
              New pipeline
            </Button>
          </>
        ) : null
      }
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Pipelines"
            message={loadError("pipelines", error)}
            action={
              <Button size="sm" icon="retry" onClick={() => refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}

      {/* Above a list, the way to act on it. An empty page asks for the
          account itself, in its empty state below, so it says so once. */}
      {auth.status && !isAdmin && (pipelines.length > 0 || error !== null) && (
        <div className="mb-6">
          <AdminAuthPanel
            configured={auth.status.configured}
            onLogin={auth.login}
            onSetup={auth.setup}
            onRegister={auth.register}
          />
        </div>
      )}

      <AgentSkillsStrip isAdmin={isAdmin} />

      {mode.kind === "new" && (
        <div className="mb-6">
          <PipelineForm
            initial={EMPTY_PIPELINE}
            pipelines={pipelines}
            autoFocus
            onCancel={() => closeForm(() => newButton.current)}
            onSubmit={async (input) => {
              await create(input);
              closeForm(() => newButton.current);
            }}
          />
        </div>
      )}

      {mode.kind === "tune" && tuning && (
        <TuningDrawer
          key={tuning.id}
          def={tuning}
          onClose={() => setMode({ kind: "none" })}
          onApply={(input, ask) => saveDefinition(tuning, input, ask)}
        />
      )}

      <Handoff
        busy={loading}
        label="pipelines"
        skeleton={
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {[0, 1, 2].map((i) => (
              <SkeletonTile key={i} lines={3} className="min-h-40" />
            ))}
          </div>
        }
      >
        {pipelines.length === 0 && mode.kind === "none" ? (
          // A failed load is not an empty list: the strip above says what
          // happened, and "no pipelines yet" under it would be a second,
          // contradictory answer.
          error ? null : auth.status && !isAdmin ? (
            <AccountPrompt
              configured={auth.status.configured}
              onLogin={auth.login}
              onSetup={auth.setup}
              onRegister={auth.register}
              icon="pipeline"
              title="No pipelines yet"
              signInLabel="Sign in to add one"
            >
              <AboutPipelines />
            </AccountPrompt>
          ) : (
            <EmptyState
              icon="pipeline"
              title="No pipelines yet"
              action={
                isAdmin ? (
                  <Button variant="primary" icon="plus" onClick={() => setMode({ kind: "new" })}>
                    Create your first pipeline
                  </Button>
                ) : undefined
              }
            >
              <AboutPipelines />
            </EmptyState>
          )
        ) : (
          pipelines.length > 0 && (
            <>
              <ListSummary
                pipelines={pipelines}
                live={liveByPipeline}
                filter={filter}
                onFilter={setFilter}
              />
              {shown.length === 0 && (
                <EmptyState
                  compact
                  tone={filter === "paused" ? "neutral" : "calm"}
                  icon={filter === "paused" ? "pause" : "check-circle"}
                  title={
                    filter === "await"
                      ? "Nothing is waiting for you"
                      : filter === "failed"
                        ? "Nothing has failed"
                        : "Nothing is paused"
                  }
                  action={
                    <Button variant="ghost" size="sm" onClick={() => setFilter("all")}>
                      Show all {pipelines.length}
                    </Button>
                  }
                />
              )}
              {/* One column while editing: the editor is full width, and in two
                  columns a card from the right-hand column left an empty cell
                  beside its neighbour when the form took its place. */}
              <div
                className={`grid items-start gap-4 ${mode.kind === "edit" ? "" : "xl:grid-cols-2"}`}
              >
                {shown.map((p) =>
                  // The editor opens where the card was, not at the top of the
                  // page: the reader clicked Edit *here*, and on a long list the
                  // top of the page is somewhere else entirely.
                  mode.kind === "edit" && mode.id === p.id ? (
                    <div key={p.id} className="min-w-0">
                      <PipelineForm
                        initial={toInput(p)}
                        pipelines={pipelines}
                        pipelineId={p.id}
                        hookToken={p.hookToken}
                        autoFocus
                        onRotateHook={() => rotateHookToken(p.id).then(() => {})}
                        onCancel={() => closeForm(() => editButtons.current.get(p.id))}
                        onSubmit={async (input, ask) => {
                          try {
                            await update(p.id, input);
                          } catch (e) {
                            if (!(e instanceof InstancesRunningError)) throw e;
                            // Instances are running under the current definition.
                            // They keep it — each snapshotted it when it started —
                            // so the author is told the edit will not reach them
                            // before it saves. Declining leaves the form open with
                            // the edit intact.
                            const question = editWhileRunning(p.name, p.id, e.instances);
                            const yes = await ask({
                              ...question,
                              confirm: "Save anyway",
                              cancel: "Keep editing",
                            });
                            if (!yes) return;
                            await update(p.id, input, { force: true });
                          }
                          closeForm(() => editButtons.current.get(p.id));
                        }}
                      />
                    </div>
                  ) : (
                    <PipelineCard
                      key={p.id}
                      def={p}
                      live={liveByPipeline.get(p.id) ?? NEVER_RUN}
                      spawnedBy={[...(spawnedBy.get(p.id) ?? [])]}
                      admin={isAdmin}
                      error={actionError?.pipelineId === p.id ? actionError.message : null}
                      editRef={(el) => {
                        if (el) editButtons.current.set(p.id, el);
                        else editButtons.current.delete(p.id);
                      }}
                      onEdit={() => setMode({ kind: "edit", id: p.id })}
                      onAnalyze={() => setMode({ kind: "tune", id: p.id })}
                      setEnabled={guarded(p.id, (id) => setEnabled(id, !p.enabled))}
                      remove={guarded(p.id, remove)}
                      runNow={guarded(p.id, runNow)}
                      abort={guarded(p.id, abort)}
                    />
                  ),
                )}
              </div>
            </>
          )
        )}
      </Handoff>
    </Page>
  );
}
