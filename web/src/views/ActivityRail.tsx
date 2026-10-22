import { useMemo } from "react";
import type { Run } from "../types";
import type { LiveActivity } from "../useRunActivity";
import {
  Icon,
  STATUS,
  SkeletonRows,
  TimeAgo,
  formatElapsed,
  formatMs,
  formatUsd,
  rowTitle,
  runDsStatus,
  runStatusLabel,
  staggerDelay,
  useTicker,
} from "../ds";
import type { ColorToken, OverviewRow } from "../ds";

/**
 * The board's right-hand column: what is happening now, and what just happened.
 *
 * Two problems it solves. The board only shows *pipelines*, so a scheduled run
 * or a one-off Launch was invisible here even while it was burning money. And
 * the board is a wide grid, which left a tall empty gutter on any real display —
 * space that should be carrying the most time-sensitive information in the app.
 *
 * "Live" comes from the run tailer's pushed activity lines, so it moves in real
 * time. "Recent" comes from the run records, so it is never empty on a cold
 * load — a rail that only fills once something happens is a rail nobody trusts.
 */

const RECENT_LIMIT = 8;

/** How long a run may go without a tool call before "Starting…" stops being
 *  the honest word for it. */
const STARTING_MS = 10_000;

/** Static per-token classes: Tailwind scans source text, so an interpolated
 *  `text-${token}` would never be generated. */
const TEXT: Record<ColorToken, string> = {
  run: "text-run",
  ok: "text-ok",
  fail: "text-fail",
  queue: "text-queue",
  idle: "text-idle",
  await: "text-await",
};

const DOT: Record<ColorToken, string> = {
  run: "bg-run",
  ok: "bg-ok",
  fail: "bg-fail",
  queue: "bg-queue",
  idle: "bg-idle",
  await: "bg-await",
};

/** A rail row that goes somewhere: the run's Flight Recorder, when it has one.
 *  The rail used to be a list of dead ends — the most time-sensitive thing on
 *  the page, and nothing in it could be opened. */
function RowLink({ runId, children }: { runId: string | null; children: React.ReactNode }) {
  const shell = "-mx-2 flex flex-col gap-1 rounded-control px-2 py-1.5";
  return runId ? (
    <a
      href={`#/run/${encodeURIComponent(runId)}`}
      className={`${shell} transition-colors duration-(--duration-quick) hover:bg-surface-2`}
    >
      {children}
    </a>
  ) : (
    <div className={shell}>{children}</div>
  );
}

function StepLine({
  label,
  activity,
  runId,
  startedAt,
  twin,
}: {
  label: string;
  activity: LiveActivity | null;
  runId: string | null;
  startedAt: string | null;
  /** Another live row carries the same label, so this one names its run. */
  twin: boolean;
}) {
  // Every live row says how long it has been going. "Starting…" on all of
  // them, whatever their age, made a two-minute step look exactly like one
  // that had just been spawned — and stuck look exactly like fine.
  const now = useTicker(startedAt !== null);
  const ms = startedAt ? now - new Date(startedAt).getTime() : null;
  const elapsed = ms !== null && ms >= 0 ? formatElapsed(ms) : null;
  const starting = ms === null || ms < STARTING_MS;
  return (
    <li className="relative pl-3">
      <span
        aria-hidden="true"
        className="absolute bottom-1.5 left-0 top-1.5 w-[2px] rounded-full bg-run/60"
      />
      <RowLink runId={runId}>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-small font-semibold leading-tight text-ink">
            {label}
          </span>
          {elapsed && (
            <span title="Running for" className="shrink-0 text-caption font-semibold text-run">
              {elapsed}
            </span>
          )}
        </span>
        {activity ? (
          <span className="flex min-w-0 items-start gap-1.5 text-caption leading-snug text-ink-dim">
            <Icon name="activity" size={13} className="mt-px text-run" />
            <span className="min-w-0 break-words font-mono">{activity.label}</span>
          </span>
        ) : (
          <span className="text-caption text-ink-faint">
            {starting ? "Starting…" : "Working"}
            {twin && runId && (
              // Two runs of one schedule read as one row drawn twice; the id
              // is what tells them apart.
              <>
                {" · run "}
                <span className="font-mono">{runId.slice(0, 8)}</span>
              </>
            )}
          </span>
        )}
      </RowLink>
    </li>
  );
}

function RunLine({ run, index }: { run: Run; index: number }) {
  const { token } = STATUS[runDsStatus(run)];
  const label = runStatusLabel(run);
  const cost = run.costUsd ?? null;
  return (
    <li
      style={{ animationDelay: staggerDelay(index, 20, 140) }}
      className="motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]"
    >
      <RowLink runId={run.id}>
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[token]}`} />
          <span className="min-w-0 flex-1 truncate text-small leading-tight text-ink-dim">
            {run.scheduleName}
          </span>
          <span className="shrink-0 text-caption">
            <TimeAgo iso={run.endedAt ?? run.startedAt ?? run.queuedAt} />
          </span>
        </span>
        <span className="flex items-baseline gap-2 pl-3.5 text-caption text-ink-faint">
          <span className={TEXT[token]}>{label}</span>
          {run.durationMs != null && <span>{formatMs(run.durationMs)}</span>}
          {cost != null && <span>{formatUsd(cost)}</span>}
        </span>
      </RowLink>
    </li>
  );
}

function Heading({ children, count }: { children: string; count?: number }) {
  return (
    <h2 className="eyebrow flex items-center gap-2">
      {children}
      {count != null && count > 0 && (
        <span className="rounded-full bg-run/15 px-1.5 py-px text-micro font-semibold tracking-normal text-run">
          {count}
        </span>
      )}
    </h2>
  );
}

export function ActivityRail({
  rows,
  liveActivity,
  runs,
  loading,
  error = false,
}: {
  /** The board's rows, for the steps currently running. */
  rows: OverviewRow[];
  liveActivity: Map<string, LiveActivity>;
  runs: Run[];
  loading: boolean;
  /**
   * The server could not be reached. An empty rail then means "unknown", not
   * "nothing": it must not tell an operator that nothing is running or that
   * nothing ever ran because a request failed.
   */
  error?: boolean;
}) {
  // Every step the board reports as working, flattened with its pipeline name.
  // Keyed by run, not by step name: a best-of-N phase runs N copies of one
  // step under one name, and a key they shared let React duplicate or drop
  // their rows as the board updated. A run is one row, however many times the
  // board reports it.
  const working = useMemo(() => {
    const seen = new Set<string>();
    return rows.flatMap((row) =>
      row.phases.flatMap((phase) =>
        phase.steps.flatMap((step, i) => {
          const runId = step.runId ?? null;
          if (step.status !== "working" || (runId && seen.has(runId))) return [];
          if (runId) seen.add(runId);
          return [
            {
              key: runId ?? `${row.instanceId ?? row.pipelineId}:${phase.id}:${i}`,
              runId,
              startedAt: step.startedAt ?? null,
              label: `${rowTitle(row)} · ${step.name}`,
              activity: runId ? (liveActivity.get(runId) ?? null) : null,
            },
          ];
        }),
      ),
    );
  }, [rows, liveActivity]);

  // Recent runs, newest first, excluding the ones still going — those are either
  // in "Live" above or are scheduler runs the board does not own.
  const recent = useMemo(
    () => runs.filter((run) => run.status !== "running").slice(0, RECENT_LIMIT),
    [runs],
  );
  // Running runs the board does not already show as a working step. A pipeline
  // step's run is *also* a running run, so without this it would appear twice —
  // once under its step name, once under the run's schedule name.
  const inFlightRuns = useMemo(() => {
    const shown = new Set(working.map((step) => step.runId).filter(Boolean));
    return runs.filter((run) => run.status === "running" && !shown.has(run.id));
  }, [runs, working]);

  // Labels that appear more than once among the live rows.
  const twins = useMemo(() => {
    const labels = [...working.map((w) => w.label), ...inFlightRuns.map((r) => r.scheduleName)];
    return new Set(labels.filter((label, i) => labels.indexOf(label) !== i));
  }, [working, inFlightRuns]);

  return (
    <aside
      aria-label="Live activity"
      className="flex min-w-0 flex-col gap-6 rounded-tile border border-line bg-surface px-4 pb-3 pt-4 shadow-raised lg:sticky lg:top-[72px]"
    >
      <section className="flex flex-col gap-2">
        <Heading count={working.length + inFlightRuns.length}>Live</Heading>
        {working.length === 0 && inFlightRuns.length === 0 ? (
          <p className="text-small leading-snug text-ink-faint">
            {error
              ? "Unknown until Argus is reachable again."
              : "Nothing is running. Steps report their tool calls here as they work."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {working.map((step) => (
              <StepLine
                key={step.key}
                label={step.label}
                activity={step.activity}
                runId={step.runId}
                startedAt={step.startedAt}
                twin={twins.has(step.label)}
              />
            ))}
            {/* Runs the engine owns but the board does not: scheduled firings and
                one-off Launches. Without these the rail claims nothing is
                running while an agent is mid-flight. */}
            {inFlightRuns.map((run) => (
              <StepLine
                key={run.id}
                label={run.scheduleName}
                activity={liveActivity.get(run.id) ?? null}
                runId={run.id}
                startedAt={run.startedAt ?? null}
                twin={twins.has(run.scheduleName)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <Heading>Recent</Heading>
        {loading && recent.length === 0 ? (
          <SkeletonRows count={3} />
        ) : recent.length === 0 ? (
          <p className="text-small leading-snug text-ink-faint">
            {error
              ? "Recent runs will show once Argus is reachable again."
              : "No completed runs yet. Scheduled firings, pipeline steps and one-off launches all land here."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {recent.map((run, i) => (
              <RunLine key={run.id} run={run} index={i} />
            ))}
          </ul>
        )}
        {/* The Chronicle, where every run lands: it went to the one-off launch
            form, whose list holds one-off runs only and so read "Nothing
            launched yet" under a rail that had just listed eight. */}
        <a
          href="#/chronicle"
          className="-mx-2 mt-1 flex items-center justify-between rounded-control px-2 py-1.5 text-small font-semibold text-ink-dim transition duration-(--duration-quick) hover:bg-surface-2 hover:text-ink"
        >
          All runs
          <Icon name="arrow-right" size={15} />
        </a>
      </section>
    </aside>
  );
}
