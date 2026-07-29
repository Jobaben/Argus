import { useMemo, useState } from "react";
import { useMachineFacet } from "../fleet/useMachineFacet";
import { MachinePicker, PeerBanner, PeerEmpty } from "../fleet/MachineFacet";
import { useChronicle } from "../useChronicle";
import type { ChronicleGroup, ChronicleKind, ChronicleSpan, ChronicleStatus } from "../types";
import {
  DURATION,
  EmptyState,
  formatMs,
  formatUsd,
  Handoff,
  HealthCounter,
  Page,
  SegmentedControl,
  SkeletonCounters,
  SkeletonTile,
  TimeAgo,
  useSyncedDelay,
} from "../ds";
import { axisTicks, shortenLanePath, spanGeometry } from "../ds/chronicleLayout";

const WINDOWS = [
  { value: "1", label: "1h" },
  { value: "6", label: "6h" },
  { value: "24", label: "24h" },
  { value: "72", label: "3d" },
  { value: "168", label: "7d" },
  // Past 14 days the JSON run files no longer hold the answer — they keep the
  // newest 50 per schedule — so these windows are served from the Vault. They
  // are offered regardless: without it the range simply returns what the files
  // still have, which is the same behaviour Chronicle always had.
  { value: "2160", label: "90d" },
  { value: "8760", label: "1y" },
] as const;

type WindowValue = (typeof WINDOWS)[number]["value"];

// Static class maps — Tailwind can't see dynamically-built class names.
const BAR: Record<ChronicleStatus, string> = {
  working: "bg-run/25 border-run/60 text-run",
  done: "bg-ok/20 border-ok/50 text-ok",
  failed: "bg-fail/25 border-fail/60 text-fail",
  queued: "bg-queue/20 border-queue/50 text-queue",
  idle: "bg-idle/15 border-idle/40 text-idle",
};

const KIND_LABEL: Record<ChronicleKind, string> = {
  run: "SCHED",
  agent: "AGENT",
  session: "SESSION",
};

const KIND_BADGE: Record<ChronicleKind, string> = {
  run: "text-queue bg-queue/12",
  agent: "text-eye bg-eye/12",
  session: "text-await bg-await/12",
};

function spanTitle(span: ChronicleSpan): string {
  const start = new Date(span.startedAt).toLocaleString();
  const end = span.endedAt ? new Date(span.endedAt).toLocaleString() : "now";
  const parts = [`${span.label}`, `${start} → ${end}`, span.status];
  if (span.detail) parts.push(span.detail);
  if (span.costUsd != null) parts.push(formatUsd(span.costUsd));
  return parts.join("\n");
}

function SpanBar({
  span,
  windowStartMs,
  windowEndMs,
}: {
  span: ChronicleSpan;
  windowStartMs: number;
  windowEndMs: number;
}) {
  // Every still-running span on the timeline breathes on the same beat. Read
  // before the early return below, because hooks are not conditional.
  const beat = useSyncedDelay(DURATION.pulse);
  const geo = spanGeometry(span.startedAt, span.endedAt, windowStartMs, windowEndMs);
  if (!geo) return null;
  // Below this the label is unreadable anyway and just muddies the bar's colour,
  // which is the primary signal. 4% ≈ 55px on a 1400px panel.
  const wide = geo.width > 4;
  const body = (
    <>
      {geo.openEnded && (
        <span
          aria-hidden
          style={{ animationDelay: beat }}
          className="absolute right-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 animate-[pulse_var(--duration-pulse)_ease-in-out_infinite] rounded-full bg-current shadow-[0_0_8px_1px_currentColor]"
        />
      )}
      {wide && <span className="truncate px-1.5 text-[10px] font-semibold">{span.label}</span>}
    </>
  );
  const cls = `absolute inset-y-0.5 flex items-center overflow-hidden rounded border ${BAR[span.status]} ${
    geo.openEnded ? "rounded-r-none border-r-0" : ""
  }`;
  const style = { left: `${geo.left}%`, width: `${geo.width}%` };
  return span.href ? (
    <a
      href={span.href}
      title={spanTitle(span)}
      aria-label={`${span.label}, ${span.status}`}
      className={`${cls} transition hover:brightness-125`}
      style={style}
    >
      {body}
    </a>
  ) : (
    <div title={spanTitle(span)} className={cls} style={style}>
      {body}
    </div>
  );
}

function GroupLanes({
  group,
  windowStartMs,
  windowEndMs,
}: {
  group: ChronicleGroup;
  windowStartMs: number;
  windowEndMs: number;
}) {
  const spanCount = group.rows.reduce((n, row) => n + row.length, 0);
  return (
    <div className="flex border-t border-line/60">
      <div className="flex w-52 shrink-0 items-baseline gap-1.5 py-1.5 pr-3">
        <span
          className={`shrink-0 rounded px-1 py-px font-mono text-[9px] font-bold tracking-[0.1em] ${KIND_BADGE[group.kind]}`}
        >
          {KIND_LABEL[group.kind]}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-xs font-semibold text-ink-dim"
          title={group.label}
        >
          {shortenLanePath(group.label)}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-ink-faint" title="Spans in this lane">
          {spanCount}
        </span>
      </div>
      <div className="min-w-0 flex-1 py-1">
        {group.rows.map((row, i) => (
          <div key={i} className="relative h-7">
            {row.map((span) => (
              <SpanBar
                key={span.id}
                span={span}
                windowStartMs={windowStartMs}
                windowEndMs={windowEndMs}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A peer's recent runs, as a list rather than a timeline.
 *
 * A packed swimlane timeline needs a dense, ordered span set; a peer sends the
 * newest forty runs. Drawing those on the same axis would produce a chart with
 * gaps that mean "not sent" and look like "nothing happened" — the one reading
 * a timeline must never invite. A list cannot make that mistake.
 */
function PeerChronicle({ facet }: { facet: ReturnType<typeof useMachineFacet> }) {
  const runs = facet.peer?.summary?.facets.recentRuns ?? [];
  if (runs.length === 0) return <PeerEmpty what="recent runs" />;
  return (
    <>
      <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
            <span
              aria-hidden="true"
              className={`h-2 w-3 shrink-0 rounded-sm border ${BAR[chronicleStatus(r.status)]}`}
            />
            <span className="min-w-0 flex-1 truncate text-sm text-ink">{r.label}</span>
            <span className="shrink-0 font-mono text-[11px] text-ink-faint">
              {r.durationMs != null && `${formatMs(r.durationMs)} · `}
              <TimeAgo iso={r.at} />
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        the newest {runs.length} runs that machine reported — not its whole history
      </p>
    </>
  );
}

/** A peer sends a run status; the chart's palette is keyed by chronicle status. */
function chronicleStatus(status: string): ChronicleStatus {
  if (status === "failed") return "failed";
  if (status === "succeeded") return "done";
  if (status === "running") return "working";
  return "idle";
}

export default function Chronicle() {
  const facet = useMachineFacet();
  const [window, setWindow] = useState<WindowValue>("24");
  const { chronicle, loading, error } = useChronicle(Number(window));

  const windowStartMs = useMemo(
    () => new Date(chronicle.windowStart).getTime(),
    [chronicle.windowStart],
  );
  const windowEndMs = useMemo(() => new Date(chronicle.windowEnd).getTime(), [chronicle.windowEnd]);
  const ticks = useMemo(() => axisTicks(windowStartMs, windowEndMs), [windowStartMs, windowEndMs]);
  const hasData = chronicle.groups.length > 0 && Number.isFinite(windowStartMs);

  return (
    <Page
      title="Chronicle"
      wide
      actions={
        <SegmentedControl
          label="Time window"
          segments={[...WINDOWS]}
          value={window}
          onChange={setWindow}
        />
      }
    >
      <MachinePicker facet={facet} label="Show the chronicle from" />
      <PeerBanner facet={facet} />

      {facet.peer ? (
        <PeerChronicle facet={facet} />
      ) : (
        <>
          <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <HealthCounter label="Spans" value={chronicle.totals.spans} />
            <HealthCounter label="In flight" value={chronicle.totals.active} tone="live" />
            <HealthCounter label="Failed" value={chronicle.totals.failed} tone="fail" />
            <HealthCounter
              label="Run spend"
              value={chronicle.totals.costUsd != null ? formatUsd(chronicle.totals.costUsd) : "—"}
            />
          </section>

          {error && (
            <div className="mb-6 rounded-tile border border-fail/30 bg-fail/10 px-4 py-3 text-sm text-fail">
              Couldn't reach the Argus server: {error}
            </div>
          )}

          <Handoff
            busy={loading && !hasData}
            label="the chronicle"
            skeleton={
              <>
                <SkeletonCounters count={4} />
                <div className="mt-6">
                  <SkeletonTile lines={8} />
                </div>
              </>
            }
          >
            {!hasData ? (
              <EmptyState>
                Nothing happened in this window. Widen it, or launch an agent and watch it appear.
              </EmptyState>
            ) : (
              <div className="rounded-panel border border-line bg-surface px-4 pb-3 pt-2">
                {/* On a wide window most bars are too short to label, so their colour
              carries the meaning — which means the colours have to be stated. */}
                <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] text-ink-faint">
                  {(
                    [
                      ["done", "succeeded"],
                      ["failed", "failed"],
                      ["working", "in flight"],
                      ["queued", "queued"],
                      ["idle", "idle"],
                    ] as const
                  ).map(([status, label]) => (
                    <span key={status} className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`h-2 w-3 rounded-sm border ${BAR[status]}`}
                      />
                      {label}
                    </span>
                  ))}
                  <span className="ml-auto flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 rounded-full bg-eye shadow-[0_0_8px_1px_var(--color-eye)]"
                    />
                    still running
                  </span>
                </div>

                {/* Axis */}
                <div className="flex" aria-hidden>
                  <div className="w-52 shrink-0" />
                  <div className="relative h-6 min-w-0 flex-1">
                    {ticks.map((t) => (
                      <span
                        key={t.pct}
                        className="absolute top-1 -translate-x-1/2 font-mono text-[10px] text-ink-faint"
                        style={{ left: `${t.pct}%` }}
                      >
                        {t.label}
                      </span>
                    ))}
                    <span className="absolute right-0 top-1 font-mono text-[10px] font-bold text-eye">
                      now
                    </span>
                  </div>
                </div>

                {/* Lanes with tick gridlines behind them */}
                <div className="relative">
                  <div className="pointer-events-none absolute inset-0 flex" aria-hidden>
                    <div className="w-52 shrink-0" />
                    <div className="relative min-w-0 flex-1">
                      {ticks.map(
                        (t) =>
                          t.pct > 0 && (
                            <span
                              key={t.pct}
                              className="absolute inset-y-0 w-px bg-line/60"
                              style={{ left: `${t.pct}%` }}
                            />
                          ),
                      )}
                      <span className="absolute inset-y-0 right-0 w-px bg-eye/50" />
                    </div>
                  </div>
                  {chronicle.groups.map((g) => (
                    <GroupLanes
                      key={g.key}
                      group={g}
                      windowStartMs={windowStartMs}
                      windowEndMs={windowEndMs}
                    />
                  ))}
                </div>
              </div>
            )}
          </Handoff>
        </>
      )}
    </Page>
  );
}
