import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useSchedules } from "../useSchedules";
import { usePipelines } from "../usePipelines";
import { useRuns } from "../useRuns";
import type { Run, ScheduleInput, ScheduleWithNext, Trigger, VerdictTrend } from "../types";
import {
  AlertStrip,
  Button,
  ButtonLink,
  chipClass,
  EmptyState,
  fieldClass,
  formatCountdown,
  formatMs,
  formatTrigger,
  Handoff,
  Icon,
  InfoTip,
  Page,
  ModelSelect,
  prefersReducedMotion,
  ReasoningEffortSelect,
  RubricFields,
  RuntimeBadge,
  RuntimeSelect,
  Skeleton,
  Tabs,
  TimeAgo,
  useClock,
  useFlip,
  useTicker,
} from "../ds";
import { TriggerFields } from "../ds/TriggerFields";
import { runtimeCommand, useRuntimes } from "../useRuntimes";
import { useVerdictTrends } from "../useVerdict";
import { VerdictSparkline } from "./VerdictPanel";
import { AgentFields, controlClass, Field, FormFooter, LaunchPanel } from "./Launch";
import { FactLine, LiveDot, RunRow, type Fact } from "./RunRow";
import { useHashRoute } from "../useHashRoute";
import {
  scheduleHealthById,
  summarizeSchedules,
  type ScheduleHealth,
  type ScheduleState,
} from "./scheduleHealth";

/**
 * Countdown to this schedule's next firing, on its own second-resolution clock.
 *
 * The shared 15s clock is right for "4m ago" and wrong here: a countdown that
 * jumps in 15-second steps reads as broken, and this is the number a user watches
 * when they are deciding whether to wait or hit Run now.
 */
function NextFireLabel({ at }: { at: string | null }) {
  const now = useTicker(at !== null);
  if (!at) return <span className="text-ink-faint">no next slot</span>;
  const ms = new Date(at).getTime() - now;
  if (Number.isNaN(ms)) return <span className="text-ink-faint">no next slot</span>;
  return (
    <span title={`Next firing: ${new Date(at).toLocaleString()}`}>
      fires <span className="text-ink-dim">{formatCountdown(ms)}</span>
    </span>
  );
}

/**
 * The schedule's own health word, in `StatusPill`'s anatomy. Its own map rather
 * than a `StatusPill` because the words are the schedule's ("Failing",
 * "Healthy"), not a run's ("Failed", "Done"). A schedule that has never run is
 * drawn hollow and neutral: it is not queued, and not anything yet.
 */
const STATE_PILL: Record<ScheduleState, { label: string; className: string }> = {
  failing: { label: "Failing", className: "border-fail/35 bg-fail/12 text-fail" },
  running: { label: "Running", className: "border-run/30 bg-run/10 text-run" },
  paused: { label: "Paused", className: "border-line-strong bg-ink-faint/8 text-ink-dim" },
  unproven: { label: "Never run", className: "border-dashed border-line-strong text-ink-faint" },
  healthy: { label: "Healthy", className: "border-ok/25 bg-ok/10 text-ok" },
};

function HealthPill({ state }: { state: ScheduleState }) {
  const skin = STATE_PILL[state];
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border pl-2 pr-2.5 text-caption font-semibold leading-none ${skin.className}`}
    >
      {state === "running" ? (
        <LiveDot />
      ) : (
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            state === "unproven" ? "border border-current" : "bg-current"
          }`}
        />
      )}
      {skin.label}
    </span>
  );
}

type Filter = "all" | "failing" | "paused";

/**
 * A count that filters the list: the button language with a pressed state —
 * a quiet outlined ghost at rest, a lit secondary while its filter is on — so
 * it focuses and presses like every other control here. A count's tone is
 * carried by what it says (the failing count's dot and words are red), not by
 * a skin of its own.
 */
function FilterChip({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      aria-pressed={selected}
      onClick={onClick}
      className={selected ? "" : "border border-line"}
    >
      {children}
    </Button>
  );
}

/**
 * The scheduler's own situation line: what it will do next, and what it has been
 * getting wrong.
 *
 * Clicking a count filters the list rather than navigating away — the answer to
 * "which three are failing?" is nine cards down the same page, and sending the
 * user to another tab to find out would cost them the actions they came for.
 * Zero counts are omitted, so anything visible here is worth reading.
 */
function SchedulerSummaryStrip({
  schedules,
  runs,
  filter,
  onFilter,
}: {
  schedules: ScheduleWithNext[];
  runs: Run[];
  filter: Filter;
  onFilter: (f: Filter) => void;
}) {
  // The shared 15s clock, not a 1Hz one: the only sub-tick number here is the
  // countdown, and that owns its own ticker. Re-deriving the whole summary every
  // second to move a "24h" boundary would be a re-render for nothing.
  const now = useClock();
  const summary = useMemo(() => summarizeSchedules(schedules, runs, now), [schedules, runs, now]);
  if (summary.total === 0) return null;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
      <div role="group" aria-label="Filter schedules" className="flex flex-wrap items-center gap-2">
        <FilterChip selected={filter === "all"} onClick={() => onFilter("all")}>
          All <span className="font-semibold text-ink-faint">{summary.total}</span>
        </FilterChip>
        {summary.failing > 0 && (
          <FilterChip
            selected={filter === "failing"}
            onClick={() => onFilter(filter === "failing" ? "all" : "failing")}
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-fail" />
            <span className="text-fail">{summary.failing} failing</span>
          </FilterChip>
        )}
        {summary.paused > 0 && (
          <FilterChip
            selected={filter === "paused"}
            onClick={() => onFilter(filter === "paused" ? "all" : "paused")}
          >
            {summary.paused} paused
          </FilterChip>
        )}
        {summary.running > 0 && (
          <span className="inline-flex items-center gap-1.5 pl-1 text-caption font-semibold text-run">
            <LiveDot />
            {summary.running} running
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-caption text-ink-faint sm:ml-auto">
        {summary.recentRuns > 0 ? (
          <span title="Runs that reached a verdict in the last 24 hours">
            <span className="font-semibold text-ink-dim">{summary.recentRuns}</span> runs in 24h
            {summary.recentFailures > 0 && (
              <>
                {" · "}
                <span className="font-semibold text-fail">{summary.recentFailures} failed</span>
              </>
            )}
          </span>
        ) : (
          <span>Nothing fired in 24h</span>
        )}
        {summary.nextFiring ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon name="clock" size={13} />
            <span>Next up</span>
            <span className="max-w-[14rem] truncate font-semibold text-ink-dim">
              {summary.nextFiring.schedule.name}
            </span>
            <NextFireLabel at={summary.nextFiring.at} />
          </span>
        ) : (
          <span>Nothing armed</span>
        )}
      </div>
    </div>
  );
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
  editing = false,
  onSubmit,
  onCancel,
  pipelines = [],
  recentCwds = [],
  scheduleId,
  hookToken,
  onRotateHook,
}: {
  initial: ScheduleInput;
  /** Editing a saved schedule rather than authoring a new one. */
  editing?: boolean;
  onSubmit: (input: ScheduleInput) => Promise<void>;
  onCancel: () => void;
  /** Sources for an "after pipeline" trigger — only pipelines may chain. */
  pipelines?: { id: string; name: string }[];
  /** Directories other schedules run in, offered as suggestions. */
  recentCwds?: string[];
  /** This schedule's own id, once saved — undefined while authoring a new one. */
  scheduleId?: string;
  /** Set once this schedule has a webhook trigger and has been saved once. */
  hookToken?: string;
  onRotateHook?: () => Promise<void>;
}) {
  const [form, setForm] = useState<ScheduleInput>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which required fields the user has been in and left, so "Required" shows
  // after a field is skipped rather than on a form nobody has touched yet.
  const [left, setLeft] = useState<{ name?: boolean; prompt?: boolean; cwd?: boolean }>({});
  const { runtimes, default: defaultRuntime } = useRuntimes();
  const active = form.runtime ?? defaultRuntime;
  const runtimeInfo = runtimes.find((runtime) => runtime.id === active);
  const command = runtimeCommand(active);
  const rootRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const whenId = useId();
  const cwdListId = useId();

  // The form opens where it was asked for — in place of the card being edited,
  // or at the top for a new one — so bring it into view and put the caret in
  // its first field, rather than leaving the reader to find it.
  useEffect(() => {
    rootRef.current?.scrollIntoView?.({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    nameRef.current?.focus({ preventScroll: true });
  }, []);

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

  const missing = [
    !form.name.trim() && "a name",
    !form.prompt.trim() && "a prompt",
    !form.cwd.trim() && "a working directory",
  ].filter((m): m is string => Boolean(m));
  const valid = missing.length === 0;
  const invalid = (key: "name" | "prompt" | "cwd") => !!left[key] && !form[key].trim();
  const leave = (key: "name" | "prompt" | "cwd") => () => setLeft((l) => ({ ...l, [key]: true }));

  return (
    <div
      ref={rootRef}
      className="@container scroll-mt-20 rounded-panel border border-eye/25 bg-surface p-5 shadow-raised sm:p-6"
    >
      <div className="mb-6">
        <h2 className="min-w-0 break-words text-title font-semibold text-ink">
          {editing ? `Edit ${initial.name}` : "New schedule"}
        </h2>
        {!editing && (
          <p className="mt-0.5 text-small text-ink-dim">
            A prompt, the directory to run it in, and when.
          </p>
        )}
      </div>

      {/* Laid out by the form's own width, not the window's: the same form
          opens full-width for a new schedule and in a card's column to edit
          one. */}
      <div className="grid gap-x-8 gap-y-6 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-5">
          <div className="grid gap-5 @md:grid-cols-2">
            <Field label="Name" invalid={invalid("name")}>
              {(control) => (
                <input
                  {...control}
                  ref={nameRef}
                  className={`${controlClass} w-full`}
                  placeholder="Nightly audit"
                  aria-invalid={invalid("name") || undefined}
                  value={form.name}
                  onBlur={leave("name")}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              )}
            </Field>
            <Field label="Working directory" hint="absolute path" invalid={invalid("cwd")}>
              {(control) => (
                <input
                  {...control}
                  className={`${controlClass} w-full font-mono`}
                  placeholder="/home/you/project"
                  list={recentCwds.length > 0 ? cwdListId : undefined}
                  aria-invalid={invalid("cwd") || undefined}
                  value={form.cwd}
                  onBlur={leave("cwd")}
                  onChange={(e) => setForm({ ...form, cwd: e.target.value })}
                />
              )}
            </Field>
          </div>
          {recentCwds.length > 0 && (
            <datalist id={cwdListId}>
              {recentCwds.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          )}
          <Field
            label={
              <>
                Prompt for <code className="font-mono font-normal text-ink">{command}</code>
              </>
            }
            invalid={invalid("prompt")}
          >
            {(control) => (
              <textarea
                {...control}
                className={`${fieldClass} min-h-36 w-full resize-y leading-relaxed`}
                placeholder="Review yesterday's changes and summarize risks"
                aria-invalid={invalid("prompt") || undefined}
                value={form.prompt}
                onBlur={leave("prompt")}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
              />
            )}
          </Field>
        </div>

        <div className="min-w-0 space-y-7">
          {/* When it fires and who runs it are two different decisions; they
              used to share one wrapping row, where cadence and agent config
              blurred into a single strip of selects. */}
          <div role="group" aria-labelledby={whenId} className="min-w-0">
            <p id={whenId} className="eyebrow mb-3">
              When it runs
            </p>
            <TriggerFields
              fieldClass={controlClass}
              value={form.trigger}
              onChange={(t) => setForm({ ...form, trigger: t ?? { kind: "daily", time: "02:00" } })}
              pipelines={pipelines}
              hook={
                hookToken && scheduleId && onRotateHook
                  ? {
                      url: `${window.location.origin}/api/hooks/schedules/${scheduleId}`,
                      token: hookToken,
                      onRotate: onRotateHook,
                    }
                  : undefined
              }
            />
            <label className="mt-4 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 cursor-pointer accent-eye"
                checked={form.catchUp ?? false}
                onChange={(e) => setForm({ ...form, catchUp: e.target.checked })}
              />
              <span className="min-w-0">
                <span className="block text-small font-semibold text-ink">
                  Catch up a missed run on recovery
                </span>
                <span className="mt-0.5 block text-caption text-ink-faint">
                  If the machine was asleep (or Argus was down) when a slot came due, fire it once
                  when Argus is back instead of skipping to the next slot.
                </span>
              </span>
            </label>
          </div>

          <AgentFields>
            <RuntimeSelect
              fieldClass={controlClass}
              caption="Runtime"
              label="Runtime (server default)"
              value={form.runtime ?? undefined}
              runtimes={runtimes}
              // Null, not undefined: a PATCH omitting the key leaves the stored
              // override alone, so clearing one has to say so explicitly.
              onChange={(r) =>
                setForm({
                  ...form,
                  runtime: r ?? null,
                  model: null,
                  reasoningEffort: null,
                })
              }
            />
            <ModelSelect
              key={`schedule-model:${active}`}
              fieldClass={controlClass}
              caption="Model"
              label="Model (inherit CLI)"
              value={form.model ?? undefined}
              aliases={runtimeInfo?.models ?? []}
              onChange={(model) => setForm({ ...form, model: model ?? null })}
            />
            <ReasoningEffortSelect
              key={`schedule-effort:${active}`}
              fieldClass={controlClass}
              caption="Effort"
              label="Effort (inherit CLI)"
              value={form.reasoningEffort}
              efforts={runtimeInfo?.reasoningEfforts ?? []}
              onChange={(reasoningEffort) =>
                setForm({ ...form, reasoningEffort: reasoningEffort ?? null })
              }
            />
          </AgentFields>
        </div>
      </div>

      <div className="mt-6">
        <RubricFields
          fieldClass={controlClass}
          value={form.rubric}
          onChange={(rubric) => setForm({ ...form, rubric })}
        />
      </div>

      <FormFooter
        hintId={hintId}
        missing={missing}
        verb="save"
        error={err}
        errorSubject="Couldn't save the schedule"
      >
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          icon="check"
          disabled={busy || !valid}
          aria-describedby={valid ? undefined : hintId}
          onClick={submit}
        >
          {busy ? "Saving…" : "Save schedule"}
        </Button>
      </FormFooter>
    </div>
  );
}

/** Median duration of the recent conclusive runs — what "normal" costs, so a
 *  run that is taking four times that is visibly abnormal. Median, not mean: one
 *  pathological 40-minute run should not redefine normal. */
function typicalDuration(runs: Run[]): number | null {
  const durations = runs
    .map((r) => r.durationMs)
    .filter((d): d is number => d != null && Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  return durations[Math.floor(durations.length / 2)];
}

/**
 * The trigger in words, naming the source pipeline of a chained schedule —
 * "after Release Train" says what "after pipeline (any)" left to be looked up.
 */
function triggerText(trigger: Trigger, pipelines: { id: string; name: string }[]): string {
  if (trigger.kind === "after") {
    const source = pipelines.find((p) => p.id === trigger.pipelineId)?.name;
    if (source)
      return `after ${source}${trigger.on && trigger.on !== "any" ? ` ${trigger.on}` : ""}`;
  }
  return formatTrigger(trigger);
}

/**
 * A schedule's quality trend, on the card.
 *
 * Only when the schedule declares a rubric and something has been scored:
 * Verdict is opt-in per definition, and a sparkline of nothing on every card
 * would advertise the feature at the cost of the page.
 */
function CardVerdict({ trend }: { trend: VerdictTrend | undefined }) {
  if (!trend || trend.points.length === 0 || trend.latest == null) return null;
  const worse = trend.delta != null && trend.delta < 0;
  return (
    <span
      className="flex shrink-0 items-center gap-1.5"
      title={`Verdict ${trend.latest.toFixed(1)}${
        trend.delta == null
          ? ""
          : `, ${trend.delta > 0 ? "+" : ""}${trend.delta.toFixed(1)} on its median`
      }${trend.regressions > 0 ? ` · ${trend.regressions} below the bar` : ""}`}
    >
      <VerdictSparkline points={trend.points} minScore={trend.minScore} />
      <span
        className={`text-caption font-semibold ${
          trend.regressions > 0 ? "text-fail" : worse ? "text-await" : "text-ok"
        }`}
      >
        {trend.latest.toFixed(1)}
      </span>
    </span>
  );
}

/** The card's edge carries the alarm, the way a monitor card's does on Health,
 *  so a failing schedule is findable in the grid before any word is read. */
function cardTone(state: ScheduleState): string {
  if (state === "failing")
    return "border-fail/35 bg-surface bg-gradient-to-b from-fail/[0.07] to-fail/[0.02]";
  return "border-line bg-surface";
}

function ScheduleCard({
  schedule,
  health,
  trend,
  triggerLabel,
  defaultRuntime,
  onEdit,
  update,
  remove,
  runNow,
  cancelRun,
  ref,
  editRef,
}: {
  schedule: ScheduleWithNext;
  health: ScheduleHealth;
  trend: VerdictTrend | undefined;
  /** The trigger in words, resolved against the pipelines it may chain off. */
  triggerLabel: string;
  /** The server's default CLI: only a schedule on a different one is badged. */
  defaultRuntime: ScheduleWithNext["runtime"];
  onEdit: () => void;
  update: (id: string, patch: Partial<ScheduleInput>) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  runNow: (id: string) => Promise<unknown>;
  cancelRun: (runId: string) => Promise<unknown>;
  /** FLIP registration, so the card glides when the list re-orders. */
  ref?: React.Ref<HTMLDivElement>;
  /** The Edit button, so focus can come back to it when the form closes. */
  editRef?: React.Ref<HTMLButtonElement>;
}) {
  const { running, runs } = health;
  const recent = runs.slice(0, 5);
  const typical = typicalDuration(recent);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [pending, setPending] = useState<"run" | "toggle" | "delete" | null>(null);

  // Wrap an action so a failed Run-now/Enable/Delete surfaces instead of being
  // silently swallowed by a bare `void promise`, and so its button can say it
  // is working instead of looking like the click did nothing.
  const act = (what: "run" | "toggle" | "delete", fn: () => Promise<unknown>) => async () => {
    setActionErr(null);
    setPending(what);
    try {
      await fn();
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const lastFailure = health.consecutiveFailures > 1 ? health.lastConclusive : null;
  const eventDriven = schedule.trigger.kind === "webhook" || schedule.trigger.kind === "after";

  // What the trigger line says after the trigger itself.
  const facts: Fact[] = [];
  if (!schedule.enabled) {
    facts.push({
      key: "paused",
      node: (
        <span title="A paused schedule keeps its computed slot but will not fire">
          will not fire until enabled
        </span>
      ),
    });
  } else if (!eventDriven) {
    // A webhook or a chain fires on an event, not a clock: there is no slot to
    // count down to, and "no next slot" read as broken.
    facts.push({ key: "next", node: <NextFireLabel at={schedule.nextRun} /> });
  }
  if (health.lastConclusive) {
    facts.push({
      key: "last",
      node: (
        <span>
          last ran <TimeAgo iso={health.lastConclusive.endedAt} />
        </span>
      ),
    });
  }
  if (typical != null) {
    facts.push({
      key: "typical",
      node: (
        <span title="Median duration of the recent runs shown below">
          typically {formatMs(typical)}
        </span>
      ),
    });
  }
  if (schedule.catchUp) {
    facts.push({
      key: "catch-up",
      bare: true,
      node: (
        <span
          className={`${chipClass()} align-[1px]`}
          title="A slot missed while Argus was down fires once on recovery"
        >
          catch-up
        </span>
      ),
    });
  }
  if (schedule.runtime && schedule.runtime !== defaultRuntime) {
    facts.push({
      key: "runtime",
      bare: true,
      node: (
        <span className="inline-flex align-[1px]">
          <RuntimeBadge
            runtime={schedule.runtime}
            baseline={defaultRuntime}
            title="Runs on a different CLI than the server default"
          />
        </span>
      ),
    });
  }

  return (
    <div
      ref={ref}
      className={`flex min-w-0 flex-col rounded-tile border shadow-raised ${cardTone(health.state)}`}
    >
      <div className="flex-1 p-4 sm:p-5">
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1 basis-64">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h3 className="min-w-0 max-w-full truncate text-title font-semibold text-ink">
                {schedule.name}
              </h3>
              <HealthPill state={health.state} />
              {running.length > 0 && health.state !== "running" && (
                <span
                  className="inline-flex items-center gap-1.5 text-caption font-semibold text-run"
                  title="A run is in flight"
                >
                  <LiveDot />
                  run in flight
                </span>
              )}
              <CardVerdict trend={trend} />
            </div>
            <FactLine
              lead={
                <span className="inline-block max-w-[calc(100%-0.875rem)] truncate align-bottom font-semibold text-ink-dim first-letter:uppercase">
                  {triggerLabel}
                </span>
              }
              facts={facts}
              className="mt-1.5 text-caption leading-5 text-ink-faint"
            />
            {/* The machine half: where it runs, and on which model. Mono, and
                the path gives way first — its tail is in the tooltip. */}
            <p className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-caption text-ink-faint">
              <Icon name="folder" size={13} />
              <span className="min-w-0 truncate" title={schedule.cwd}>
                {schedule.cwd}
              </span>
              {schedule.model && (
                <span className="flex shrink-0 items-center gap-1.5" title="Model override">
                  <span aria-hidden="true">·</span>
                  {schedule.model}
                </span>
              )}
            </p>
          </div>
          <Button
            size="sm"
            icon="play"
            disabled={pending === "run"}
            onClick={act("run", () => runNow(schedule.id))}
            title="Fire this schedule once now, outside its cadence"
          >
            {pending === "run" ? "Starting…" : "Run now"}
          </Button>
        </header>

        {/* The one thing a card must not make you count for yourself. A single
            failure is visible in the rows below; a streak is a different problem
            and deserves to be stated — with the reason, and the way to look. */}
        {lastFailure && (
          <div className="mt-4 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-control border border-fail/25 bg-fail/[0.08] px-3.5 py-3">
            <Icon name="alert" size={16} className="mt-0.5 text-fail" />
            <div className="min-w-0 flex-1 basis-48">
              <p className="text-small font-semibold text-fail">
                {health.consecutiveFailures} consecutive failures
              </p>
              {lastFailure.error ? (
                <p className="mt-1 line-clamp-2 break-words font-mono text-caption text-fail-ink">
                  {lastFailure.error.split("\n")[0]}
                </p>
              ) : (
                <p className="mt-1 text-caption text-fail-ink">
                  Expand a run below for the reason.
                </p>
              )}
            </div>
            <ButtonLink
              href={`#/run/${encodeURIComponent(lastFailure.id)}`}
              variant="ghost"
              size="sm"
              icon="history"
              className="-my-0.5"
            >
              Replay last failure
            </ButtonLink>
          </div>
        )}

        {recent.length > 0 ? (
          <div className="mt-4">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h4 className="eyebrow">
                {recent.length === 1 ? "Last run" : `Last ${recent.length} runs`}
              </h4>
              {health.conclusive > 0 && (
                <span
                  className="text-caption text-ink-faint"
                  title={`${health.failures} of ${health.conclusive} recorded runs failed`}
                >
                  {health.conclusive - health.failures}/{health.conclusive} passed
                </span>
              )}
            </div>
            <ul className="divide-y divide-line overflow-hidden rounded-control border border-line bg-ground-2/60">
              {recent.map((r) => (
                <RunRow key={r.id} run={r} onCancel={cancelRun} />
              ))}
            </ul>
          </div>
        ) : (
          // A schedule with no history is the state a new one is in for hours.
          // Saying so, with the way to test it, beats an empty gap under the card.
          <p className="mt-4 flex items-start gap-2 rounded-control bg-ground-2/60 px-3 py-2.5 text-caption text-ink-faint">
            <Icon name="info" size={14} className="mt-px" />
            <span>
              No runs recorded yet.{" "}
              {schedule.enabled
                ? "It will appear here after the first firing — or press Run now to test it."
                : "Enable it, or press Run now to test it without waiting for a slot."}
            </span>
          </p>
        )}
      </div>

      {/* Managing the schedule is quieter than using it: low-emphasis, at the
          foot of the card, and Delete held apart at the far end. */}
      <footer className="flex flex-wrap items-center gap-1 border-t border-line px-3 py-2 sm:px-4">
        <Button ref={editRef} variant="ghost" size="sm" icon="edit" onClick={onEdit}>
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="power"
          disabled={pending === "toggle"}
          onClick={act("toggle", () => update(schedule.id, { enabled: !schedule.enabled }))}
        >
          {schedule.enabled ? "Disable" : "Enable"}
        </Button>
        {actionErr && (
          <p
            role="alert"
            className="inline-flex min-w-0 items-center gap-1.5 px-2 text-caption text-fail"
          >
            <Icon name="alert" size={13} />
            <span className="min-w-0 break-words">{actionErr}</span>
          </p>
        )}
        <Button
          variant="quiet-danger"
          size="sm"
          icon="trash"
          className="ml-auto"
          disabled={pending === "delete"}
          onClick={() => {
            if (confirm(`Delete schedule "${schedule.name}"?`))
              void act("delete", () => remove(schedule.id))();
          }}
        >
          Delete
        </Button>
      </footer>
    </div>
  );
}

/**
 * The cards, one column or two, as keyed children of one grid.
 *
 * One parent on purpose. The cards used to sit in two independent stacks, so
 * a short card did not leave a hole beside a tall one — but React keeps a
 * child's state only among its own siblings, so every re-sort (a schedule
 * starting to fail, one paused, a filter) remounted whichever cards changed
 * stack: an open edit form lost what had been typed, expanded runs closed, and
 * the tab order ran down one stack and then the other instead of in priority
 * order. A grid keeps every card mounted through a re-order and reads in the
 * order it is drawn; `items-start` stops a short card stretching to match its
 * neighbour, at the cost of a gap under it.
 */
function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">{children}</div>;
}

/** Card-shaped placeholders in the grid the cards will land in. */
function ScheduleSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="rounded-tile border border-line bg-surface p-5 shadow-raised"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-6 w-16 rounded-full" />
            <Skeleton className="ml-auto h-7 w-20 rounded-control" />
          </div>
          <Skeleton className="mt-3 h-2.5 w-3/5" />
          <Skeleton className="mt-2 h-2.5 w-2/5" />
          <div className="mt-5 space-y-2 rounded-control bg-ground-2/60 p-3">
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Where a card sits in the grid: attention first, inert last. */
const RANK: Record<ScheduleState, number> = {
  failing: 0,
  running: 1,
  healthy: 1,
  unproven: 1,
  paused: 2,
};

const TABS: { id: "schedules" | "oneoff"; label: string; href: string }[] = [
  { id: "schedules", label: "Schedules", href: "#/schedules" },
  { id: "oneoff", label: "One-off", href: "#/schedules/oneoff" },
];

/** Each sub-tab's explanation, on demand at the end of the tab rule — the
 *  paragraph that used to open the One-off tab and push the form down. */
function About({ tab }: { tab: "schedules" | "oneoff" }) {
  const cli = (
    <>
      <code className="font-mono">claude -p</code>, <code className="font-mono">codex exec</code>,{" "}
      <code className="font-mono">opencode run</code> or <code className="font-mono">qwen</code>
    </>
  );
  if (tab === "oneoff") {
    return (
      <InfoTip
        title="About one-off runs"
        align="end"
        trigger={<span className="text-caption text-ink-faint">About one-off runs</span>}
      >
        Fire a single headless agent run right now — {cli}, your pick — with no schedule needed. The
        run lands in the list with a live log, and everywhere else runs go: Chronicle, Issues, the
        Briefing.
      </InfoTip>
    );
  }
  return (
    <InfoTip
      title="How schedules work"
      align="end"
      trigger={<span className="text-caption text-ink-faint">How schedules work</span>}
    >
      A schedule is a prompt, a working directory and a cadence: Argus runs your chosen agent —{" "}
      {cli} — in that directory on time, and keeps every run&apos;s transcript, cost and result. A
      schedule can also fire on a webhook call, or after a pipeline finishes.
    </InfoTip>
  );
}

export default function Schedules() {
  // Rows come and go and change places as health changes; FLIP glides them
  // there instead of letting the list teleport under the reader.
  const flip = useFlip();
  const {
    schedules,
    loading,
    error,
    refresh,
    create,
    update,
    remove,
    runNow,
    cancelRun,
    rotateHookToken,
  } = useSchedules();
  // Sources for an "after pipeline" trigger — only pipelines may chain.
  const { pipelines } = usePipelines();
  // One run list for every card. Each card used to fetch its own
  // `/api/runs?scheduleId=…`, so a page with twelve schedules opened thirteen
  // requests and kept thirteen conditional polls alive — and still could not
  // answer an aggregate question, because no one held all the runs at once.
  const { runs } = useRuns();
  // One trends read for the whole page, like the run list above it: a sparkline
  // per card must not become a fetch per card.
  const { report: verdicts } = useVerdictTrends();
  const { default: defaultRuntime } = useRuntimes();
  const trendFor = useMemo(
    () => new Map(verdicts.trends.map((t) => [t.key, t])),
    [verdicts.trends],
  );
  const [mode, setMode] = useState<
    { kind: "none" } | { kind: "new" } | { kind: "edit"; id: string }
  >({ kind: "none" });
  // The sub-tab lives in the hash (`#/schedules`, `#/schedules/oneoff`) so a
  // link to "fire one now" lands on the form and a reload keeps the tab.
  const subTab: "schedules" | "oneoff" = useHashRoute()[1] === "oneoff" ? "oneoff" : "schedules";
  const [filter, setFilter] = useState<Filter>("all");

  // A closing form takes focus down with it, to <body> — the top of the
  // document, a screen away from the card that was being edited. Hand it back
  // to the control that opened the form instead.
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const newButton = useRef<HTMLButtonElement>(null);
  const lastMode = useRef(mode);
  useEffect(() => {
    const was = lastMode.current;
    lastMode.current = mode;
    if (mode.kind !== "none") return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (was.kind === "edit") editButtons.current.get(was.id)?.focus();
    else if (was.kind === "new") newButton.current?.focus();
  }, [mode]);

  const health = useMemo(() => scheduleHealthById(schedules, runs), [schedules, runs]);
  // Pair each visible schedule with its health here, so the card takes both as
  // props and never has to cope with a missing entry. A failing schedule leads
  // and a paused one trails — the one that needs a human first, the one that
  // will not do anything last — and the rest keep the server's order, so a run
  // starting or finishing never moves a card out from under the pointer.
  const shown = useMemo(
    () =>
      schedules
        .flatMap((schedule) => {
          const entry = health.get(schedule.id);
          if (!entry) return [];
          if (filter !== "all" && entry.state !== filter) return [];
          return [{ schedule, health: entry }];
        })
        .sort((a, b) => RANK[a.health.state] - RANK[b.health.state]),
    [schedules, health, filter],
  );
  const recentCwds = useMemo(
    () => [...new Set(schedules.map((s) => s.cwd).filter(Boolean))],
    [schedules],
  );
  const empty = !loading && schedules.length === 0;

  return (
    <Page
      title="Scheduler"
      subtitle="Work Argus runs for you: prompts on a cadence or a trigger, and one-off runs fired by hand."
      actions={
        subTab === "schedules" && mode.kind === "none" ? (
          // The page's one primary action — unless the page is empty, where the
          // empty state's own call to action is the one to look at.
          <Button
            ref={newButton}
            variant={empty ? "secondary" : "primary"}
            icon="plus"
            onClick={() => setMode({ kind: "new" })}
          >
            New schedule
          </Button>
        ) : null
      }
    >
      <Tabs
        label="Scheduler views"
        items={TABS}
        active={subTab}
        trailing={<About tab={subTab} />}
      />

      {subTab === "oneoff" ? (
        <LaunchPanel />
      ) : (
        <>
          {error && (
            <div className="mb-6">
              <AlertStrip
                subject="Couldn't reach the Argus server"
                message={error}
                action={
                  <Button size="sm" icon="retry" onClick={() => void refresh()}>
                    Retry
                  </Button>
                }
              />
            </div>
          )}

          {mode.kind === "new" && (
            <div className="mb-6">
              <ScheduleForm
                initial={EMPTY}
                pipelines={pipelines}
                recentCwds={recentCwds}
                onCancel={() => setMode({ kind: "none" })}
                onSubmit={async (input) => {
                  await create(input);
                  setMode({ kind: "none" });
                }}
              />
            </div>
          )}

          {!loading && schedules.length > 0 && (
            <SchedulerSummaryStrip
              schedules={schedules}
              runs={runs}
              filter={filter}
              onFilter={setFilter}
            />
          )}

          <Handoff busy={loading} label="schedules" skeleton={<ScheduleSkeleton />}>
            {schedules.length === 0 && mode.kind === "none" ? (
              // A load error already says why the list is empty; teaching what a
              // schedule is underneath it would answer the wrong question.
              error ? null : (
                <EmptyState
                  title="No schedules yet."
                  icon="calendar"
                  action={
                    <Button variant="primary" icon="plus" onClick={() => setMode({ kind: "new" })}>
                      Create your first schedule
                    </Button>
                  }
                >
                  A schedule is a prompt, a working directory and a cadence: Argus runs your chosen
                  agent — <code className="font-mono text-ink-dim">claude -p</code>,{" "}
                  <code className="font-mono text-ink-dim">codex exec</code>,{" "}
                  <code className="font-mono text-ink-dim">opencode run</code> or{" "}
                  <code className="font-mono text-ink-dim">qwen</code> — in that directory on time
                  and keeps every run&apos;s transcript, cost and result. A first one worth having
                  is a nightly review of yesterday&apos;s commits.
                </EmptyState>
              )
            ) : shown.length === 0 && schedules.length > 0 ? (
              <EmptyState
                compact
                tone={filter === "failing" ? "calm" : "neutral"}
                icon={filter === "failing" ? "check-circle" : "pause"}
                title={filter === "failing" ? "Nothing is failing." : "Nothing is paused."}
                action={
                  <Button variant="ghost" size="sm" onClick={() => setFilter("all")}>
                    Show all {schedules.length}
                  </Button>
                }
              >
                {filter === "failing"
                  ? "Every schedule's latest run passed."
                  : "Every schedule is enabled and will fire on its next slot."}
              </EmptyState>
            ) : (
              <CardGrid>
                {shown.map(({ schedule: s, health: h }) =>
                  // Edit opens in place of the card, where the click was — it
                  // used to open at the top of the page, a screen away from the
                  // schedule it was changing.
                  mode.kind === "edit" && mode.id === s.id ? (
                    <div key={s.id} ref={flip(s.id)} className="min-w-0">
                      <ScheduleForm
                        editing
                        initial={s}
                        pipelines={pipelines}
                        recentCwds={recentCwds}
                        scheduleId={s.id}
                        hookToken={s.hookToken}
                        onRotateHook={() => rotateHookToken(s.id).then(() => {})}
                        onCancel={() => setMode({ kind: "none" })}
                        onSubmit={async (input) => {
                          await update(s.id, input);
                          setMode({ kind: "none" });
                        }}
                      />
                    </div>
                  ) : (
                    <ScheduleCard
                      key={s.id}
                      ref={flip(s.id)}
                      schedule={s}
                      health={h}
                      trend={trendFor.get(`schedule:${s.id}`)}
                      triggerLabel={triggerText(s.trigger, pipelines)}
                      defaultRuntime={defaultRuntime}
                      onEdit={() => setMode({ kind: "edit", id: s.id })}
                      editRef={(el) => {
                        if (el) editButtons.current.set(s.id, el);
                        else editButtons.current.delete(s.id);
                      }}
                      update={update}
                      remove={remove}
                      runNow={runNow}
                      cancelRun={cancelRun}
                    />
                  ),
                )}
              </CardGrid>
            )}
          </Handoff>
        </>
      )}
    </Page>
  );
}
