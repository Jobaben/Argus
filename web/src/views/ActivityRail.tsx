import { useMemo } from "react";
import type { Run } from "../types";
import type { LiveActivity } from "../useRunActivity";
import {
  STATUS,
  SkeletonRows,
  TimeAgo,
  formatMs,
  formatUsd,
  runDsStatus,
  staggerDelay,
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

/** Static per-token classes: Tailwind scans source text, so an interpolated
 *  `text-${token}` would never be generated. */
const DOT: Record<ColorToken, string> = {
  run: "text-run",
  ok: "text-ok",
  fail: "text-fail",
  queue: "text-queue",
  idle: "text-idle",
  await: "text-await",
};

function StepLine({ label, activity }: { label: string; activity: LiveActivity | null }) {
  return (
    <li className="flex flex-col gap-0.5 border-l-2 border-run/50 pl-2.5">
      <span className="truncate text-[12.5px] font-semibold leading-tight text-ink">{label}</span>
      {activity ? (
        <span className="break-words font-mono text-[10.5px] leading-snug text-ink-dim">
          <span aria-hidden="true">▸ </span>
          {activity.label}
        </span>
      ) : (
        <span className="font-mono text-[10.5px] text-ink-faint">starting…</span>
      )}
    </li>
  );
}

function RunLine({ run, index }: { run: Run; index: number }) {
  const ds = runDsStatus(run);
  const { token, label } = STATUS[ds];
  const cost = run.costUsd ?? null;
  return (
    <li
      style={{ animationDelay: staggerDelay(index, 20, 140) }}
      className="flex flex-col gap-0.5 motion-safe:animate-[slide-up_var(--duration-base)_var(--ease-out-expo)_both]"
    >
      <span className="flex items-baseline gap-2">
        <span aria-hidden="true" className={`text-[9px] leading-none ${DOT[token]}`}>
          ●
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] leading-tight text-ink-dim">
          {run.scheduleName}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint">
          <TimeAgo iso={run.endedAt ?? run.startedAt ?? run.queuedAt} />
        </span>
      </span>
      <span className="flex items-baseline gap-2 pl-[15px] font-mono text-[10px] text-ink-faint">
        <span className={DOT[token]}>{label.toLowerCase()}</span>
        {run.durationMs != null && <span>{formatMs(run.durationMs)}</span>}
        {cost != null && <span>{formatUsd(cost)}</span>}
      </span>
    </li>
  );
}

function Heading({ children, count }: { children: string; count?: number }) {
  return (
    <h2 className="flex items-baseline gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
      {children}
      {count != null && count > 0 && <span className="text-ink-dim">{count}</span>}
    </h2>
  );
}

export function ActivityRail({
  rows,
  liveActivity,
  runs,
  loading,
}: {
  /** The board's rows, for the steps currently running. */
  rows: OverviewRow[];
  liveActivity: Map<string, LiveActivity>;
  runs: Run[];
  loading: boolean;
}) {
  // Every step the board reports as working, flattened with its pipeline name.
  const working = useMemo(
    () =>
      rows.flatMap((row) =>
        row.phases.flatMap((phase) =>
          phase.steps
            .filter((step) => step.status === "working")
            .map((step) => ({
              key: `${row.instanceId ?? row.pipelineId}:${phase.id}:${step.name}`,
              label: `${row.name} · ${step.name}`,
              activity: step.runId ? (liveActivity.get(step.runId) ?? null) : null,
            })),
        ),
      ),
    [rows, liveActivity],
  );

  // Recent runs, newest first, excluding the ones still going — those are either
  // in "Live" above or are scheduler runs the board does not own.
  const recent = useMemo(
    () => runs.filter((run) => run.status !== "running").slice(0, RECENT_LIMIT),
    [runs],
  );
  const inFlightRuns = useMemo(() => runs.filter((run) => run.status === "running"), [runs]);

  return (
    <aside
      aria-label="Live activity"
      className="flex flex-col gap-5 rounded-tile border border-line bg-ground-2 px-4 py-3.5"
    >
      <section className="flex flex-col gap-2.5">
        <Heading count={working.length + inFlightRuns.length}>Live</Heading>
        {working.length === 0 && inFlightRuns.length === 0 ? (
          <p className="text-[12px] leading-snug text-ink-faint">
            Nothing is running. Steps report their tool calls here as they work.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {working.map((step) => (
              <StepLine key={step.key} label={step.label} activity={step.activity} />
            ))}
            {/* Runs the engine owns but the board does not: scheduled firings and
                one-off Launches. Without these the rail claims nothing is
                running while an agent is mid-flight. */}
            {inFlightRuns.map((run) => (
              <StepLine
                key={run.id}
                label={run.scheduleName}
                activity={liveActivity.get(run.id) ?? null}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <Heading>Recent</Heading>
        {loading && recent.length === 0 ? (
          <SkeletonRows count={3} />
        ) : recent.length === 0 ? (
          <p className="text-[12px] leading-snug text-ink-faint">
            No completed runs yet. Scheduled firings, pipeline steps and one-off launches all land
            here.
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {recent.map((run, i) => (
              <RunLine key={run.id} run={run} index={i} />
            ))}
          </ul>
        )}
        <a
          href="#/launch"
          className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint transition duration-(--duration-quick) hover:text-ink"
        >
          All runs →
        </a>
      </section>
    </aside>
  );
}
