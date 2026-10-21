import { useMemo, useState } from "react";
import { useMachineFacet } from "../fleet/useMachineFacet";
import { MachinePicker, PeerBanner, PeerEmpty } from "../fleet/MachineFacet";
import { useChronicle } from "../useChronicle";
import type { ChronicleGroup, ChronicleKind, ChronicleSpan, ChronicleStatus } from "../types";
import {
  AlertStrip,
  Button,
  ButtonLink,
  DURATION,
  EmptyState,
  formatMs,
  formatUsd,
  Handoff,
  Icon,
  Page,
  SegmentedControl,
  SkeletonCounters,
  SkeletonTile,
  TimeAgo,
  useSyncedDelay,
} from "../ds";
import type { IconName } from "../ds";
import { axisTicks, shortenLanePath, spanGeometry, type SpanGeometry } from "../ds/chronicleLayout";
import { Legend, type LegendItem } from "../ds/Legend";
import { withoutOutcome } from "./outcome";
import { HealthCounter } from "../ds/HealthCounter";
import { loadError } from "../live/loadError";

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
  // The same neutral grey, at the weight of a bar that did some work, and
  // dashed: cut short. Identical to idle, the key would show two swatches
  // no bar could be told apart by.
  stopped: "border-dashed bg-idle/25 border-idle/60 text-idle",
};

/**
 * What a lane *is* — a schedule, an agent, a session — as a neutral icon chip.
 * These used to be blue, cyan and violet capitals, which on this page of all
 * pages read as statuses: a "session" lane looked like it was waiting on you.
 * Kind is a category, so it gets no colour; the bars keep the colour, because
 * there it is the status.
 */
const KIND: Record<ChronicleKind, { label: string; icon: IconName }> = {
  run: { label: "Schedule", icon: "calendar" },
  agent: { label: "Agent", icon: "sparkle" },
  session: { label: "Session", icon: "terminal" },
};

function KindChip({ kind }: { kind: ChronicleKind }) {
  const { label, icon } = KIND[kind];
  return (
    <span
      title={label}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-line bg-ground-2/60 text-ink-faint"
    >
      <Icon name={icon} size={12} label={label} />
    </span>
  );
}

/** What each status is called: in the key, and in each bar's tooltip and
 *  name, which used to give the raw token ("done", "working") beneath a key
 *  that said "Succeeded" and "Still running". */
const STATUS_LABEL: Record<ChronicleStatus, string> = {
  done: "Succeeded",
  failed: "Failed",
  working: "Still running",
  queued: "Queued",
  stopped: "Stopped",
  idle: "Idle",
};

/** A bar sample for the key, drawn with the bars' own classes. */
function Swatch({ status }: { status: ChronicleStatus }) {
  return <span className={`h-2.5 w-4 rounded-sm border ${BAR[status]}`} />;
}

/**
 * The key. On a wide window most bars are too short to label, so their colour
 * carries the meaning — which means the colours have to be stated. The
 * still-running mark is drawn the way a live bar actually is (open at the "now"
 * edge, its dot in the bar's own colour); it used to be a cyan dot that no bar
 * on the chart ever showed.
 */
const STATUS_KEY: LegendItem[] = [
  {
    key: "done",
    mark: <Swatch status="done" />,
    label: STATUS_LABEL.done,
    description: "Finished and succeeded.",
  },
  {
    key: "failed",
    mark: <Swatch status="failed" />,
    label: STATUS_LABEL.failed,
    description: "Failed.",
  },
  {
    key: "working",
    mark: (
      <span className={`relative h-2.5 w-5 rounded-l-sm border border-r-0 ${BAR.working}`}>
        <span className="absolute right-0.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-current shadow-[0_0_6px_1px_currentColor]" />
      </span>
    ),
    label: STATUS_LABEL.working,
    description: "In flight: drawn up to now, with a pulsing dot at its open end.",
  },
  {
    key: "queued",
    mark: <Swatch status="queued" />,
    label: STATUS_LABEL.queued,
    description: "Queued.",
  },
  {
    key: "stopped",
    mark: <Swatch status="stopped" />,
    label: STATUS_LABEL.stopped,
    description: "Started, then interrupted, cancelled or stopped before it finished.",
  },
  {
    key: "idle",
    mark: <Swatch status="idle" />,
    label: STATUS_LABEL.idle,
    description: "Skipped or idle.",
  },
];

const KIND_KEY: LegendItem[] = (Object.keys(KIND) as ChronicleKind[]).map((k) => ({
  key: k,
  mark: <Icon name={KIND[k].icon} size={13} className="text-ink-faint" />,
  label: KIND[k].label,
}));

/**
 * The lane label column. Narrower screens stack each label above its lane
 * instead, so the timeline keeps the full width: a fixed 13rem column left a
 * 390px screen about a hundred pixels to draw a day in, and the axis labels
 * landed on each other. The column waits for `md` because below it the 15rem
 * column would leave a track narrower than a phone's.
 */
const LANE_COL = "md:w-60 md:shrink-0 xl:w-72";

function spanTitle(span: ChronicleSpan): string {
  const start = new Date(span.startedAt).toLocaleString();
  const end = span.endedAt ? new Date(span.endedAt).toLocaleString() : "now";
  const parts = [`${span.label}`, `${start} → ${end}`, STATUS_LABEL[span.status]];
  // The tooltip already states the status; the agent's protocol line under its
  // summary said it again in machine form.
  const detail = withoutOutcome(span.detail);
  if (detail) parts.push(detail);
  if (span.costUsd != null) parts.push(formatUsd(span.costUsd));
  return parts.join("\n");
}

/**
 * A pipeline's lane is the pipeline. The server names it after the instance's
 * latest phase ("Release Train · Draft release notes"), which read as though
 * the lane held only that phase when it holds every one; each bar keeps its
 * phase in its own label and tooltip.
 */
function laneLabel(group: ChronicleGroup): string {
  if (!group.key.startsWith("run:pipeline:")) return group.label;
  const cut = group.label.lastIndexOf(" · ");
  return cut > 0 ? group.label.slice(0, cut) : group.label;
}

/** Room between two bars on one sub-row, in percent of the track. */
const PACK_GAP_PCT = 0.3;

/**
 * The lane's bars, packed into sub-rows by where they are *drawn*, not by when
 * they ran. The server packs by time, but a bar is never narrower than its
 * minimum width, so two runs seconds apart — a pipeline's Scan and Triage —
 * landed on one row as one pill over another, and a red outline on a green
 * fill matched no colour in the key. Greedy first-fit, left to right.
 */
function packByRect(
  group: ChronicleGroup,
  windowStartMs: number,
  windowEndMs: number,
): { span: ChronicleSpan; geo: SpanGeometry }[][] {
  const placed = group.rows
    .flat()
    .map((span) => ({
      span,
      geo: spanGeometry(span.startedAt, span.endedAt, windowStartMs, windowEndMs),
    }))
    .filter((p): p is { span: ChronicleSpan; geo: SpanGeometry } => p.geo != null)
    .sort((a, b) => a.geo.left - b.geo.left);
  const rows: { span: ChronicleSpan; geo: SpanGeometry }[][] = [];
  const ends: number[] = [];
  for (const p of placed) {
    const i = ends.findIndex((end) => end + PACK_GAP_PCT <= p.geo.left);
    if (i === -1) {
      rows.push([p]);
      ends.push(p.geo.left + p.geo.width);
    } else {
      rows[i].push(p);
      ends[i] = p.geo.left + p.geo.width;
    }
  }
  return rows;
}

function SpanBar({ span, geo }: { span: ChronicleSpan; geo: SpanGeometry }) {
  // Every still-running span on the timeline breathes on the same beat.
  const beat = useSyncedDelay(DURATION.pulse);
  const body = (
    <>
      {/* Inside the open end when the bar has room for it; on a bar narrower
          than the dot (a live run on a phone's day is a few pixels) it sits
          on the bar's end, the Now line, half outside, rather than being
          clipped to nothing — it is the one mark that says "still running". */}
      {geo.openEnded && (
        <span
          aria-hidden
          style={{ animationDelay: beat }}
          className="absolute right-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 translate-x-1/2 animate-[pulse_var(--duration-pulse)_ease-in-out_infinite] rounded-full bg-current shadow-[0_0_8px_1px_currentColor] @min-[0.875rem]:right-1 @min-[0.875rem]:translate-x-0"
        />
      )}
      {/* A label of a letter or two is unreadable and only muddies the bar's
          colour, which is the primary signal. The bar is its own size
          container, so the label shows once the bar itself is wide enough to
          carry a word — whatever share of whatever track that is — rather than
          guessing from the viewport. */}
      {/* A live bar keeps room for its dot, so the label's ellipsis lands
          before it rather than running underneath. */}
      <span
        className={`hidden truncate pl-1.5 text-micro font-semibold @min-[3rem]:block ${
          geo.openEnded ? "pr-4" : "pr-1.5"
        }`}
      >
        {span.label}
      </span>
    </>
  );
  // Not `overflow-hidden`: the label truncates itself, and the live dot may
  // need to sit past the end of a bar narrower than it.
  const cls = `@container absolute inset-y-0.5 flex items-center rounded-md border ${BAR[span.status]} ${
    geo.openEnded ? "rounded-r-none border-r-0" : ""
  }`;
  const style = { left: `${geo.left}%`, width: `${geo.width}%` };
  return span.href ? (
    <a
      href={span.href}
      title={spanTitle(span)}
      aria-label={`${span.label}, ${STATUS_LABEL[span.status]}`}
      // On a touch screen a day's bar can be a few pixels wide, and its
      // tooltip never shows: the hit area reaches past it on both sides, so a
      // finger can open the run.
      className={`${cls} transition duration-(--duration-quick) hover:brightness-125 pointer-coarse:before:absolute pointer-coarse:before:-inset-x-2.5 pointer-coarse:before:inset-y-0`}
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
  const rows = packByRect(group, windowStartMs, windowEndMs);
  const label = laneLabel(group);
  return (
    <div className="border-t border-line/60 md:flex">
      {/* On a phone the label is a band above the lane; `bg-surface` keeps the
          gridlines from running through its text. */}
      <div
        className={`relative flex items-center gap-2 bg-surface pb-0.5 pt-2 md:h-9 md:bg-transparent md:py-0 md:pr-3 ${LANE_COL}`}
      >
        <KindChip kind={group.kind} />
        <span
          className="min-w-0 flex-1 truncate text-caption font-semibold text-ink-dim"
          title={label}
        >
          {shortenLanePath(label)}
        </span>
        <span className="shrink-0 text-micro text-ink-faint" title="Runs in this lane">
          {spanCount}
        </span>
      </div>
      <div className="min-w-0 flex-1 py-1">
        {rows.map((row, i) => (
          <div key={i} className="relative h-7">
            {row.map(({ span, geo }) => (
              <SpanBar key={span.id} span={span} geo={geo} />
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
      <ul className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface shadow-raised">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <span
              aria-hidden="true"
              className={`h-2.5 w-4 shrink-0 rounded-sm border ${BAR[chronicleStatus(r.status)]}`}
            />
            <span className="min-w-0 flex-1 truncate text-small text-ink">{r.label}</span>
            <span className="shrink-0 text-caption text-ink-faint">
              {r.durationMs != null && `${formatMs(r.durationMs)} · `}
              <TimeAgo iso={r.at} />
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-caption text-ink-faint">
        {runs.length === 1
          ? "The newest run that machine reported"
          : `The newest ${runs.length} runs that machine reported`}{" "}
        — not its whole history.
      </p>
    </>
  );
}

/** A peer sends a run status; the chart's palette is keyed by chronicle status. */
function chronicleStatus(status: string): ChronicleStatus {
  if (status === "failed") return "failed";
  if (status === "succeeded") return "done";
  if (status === "running") return "working";
  if (status === "interrupted" || status === "cancelled") return "stopped";
  return "idle";
}

export default function Chronicle() {
  const facet = useMachineFacet();
  // Not `window`: that name is the global, and shadowing it is a trap for the
  // next person to reach for `window.location` in here.
  const [hours, setHours] = useState<WindowValue>("24");
  const { chronicle, loading, error, refresh } = useChronicle(Number(hours));

  const windowStartMs = useMemo(
    () => new Date(chronicle.windowStart).getTime(),
    [chronicle.windowStart],
  );
  const windowEndMs = useMemo(() => new Date(chronicle.windowEnd).getTime(), [chronicle.windowEnd]);
  const ticks = useMemo(() => axisTicks(windowStartMs, windowEndMs), [windowStartMs, windowEndMs]);
  // On a narrow track every other tick is dropped so they do not land on each
  // other. The axis is a size container, so "narrow" is the track's own width,
  // not the viewport's; past two days a tick reads "Thu 15" or "Aug 15", wider
  // than "14:00", so those need a track half as wide again.
  const longTicks = windowEndMs - windowStartMs > 48 * 3_600_000;
  // Three days alternate noons with the midnights that name the days; every
  // other one of those could leave "12:00 12:00 12:00", so a narrow track
  // keeps the days and drops the noons instead.
  const thinToDays = longTicks && ticks.some((t) => !t.major);
  const hasData = chronicle.groups.length > 0 && Number.isFinite(windowStartMs);
  // The empty state's first offer: the next window up, if there is one.
  const wider = WINDOWS[WINDOWS.findIndex((w) => w.value === hours) + 1];

  return (
    <Page
      title="Chronicle"
      subtitle="What ran, and when: schedule runs, agents and sessions on one timeline."
      // A peer's list is the newest runs it sent, whatever the window, so the
      // control would change nothing there.
      actions={
        facet.peer ? undefined : (
          <SegmentedControl
            label="Time window"
            segments={[...WINDOWS]}
            value={hours}
            onChange={setHours}
          />
        )
      }
    >
      <MachinePicker facet={facet} label="Show the chronicle from" />
      <PeerBanner facet={facet} />

      {facet.peer ? (
        <PeerChronicle facet={facet} />
      ) : (
        <>
          {error && (
            <div className="mb-6">
              <AlertStrip
                subject="Chronicle"
                message={loadError("the Chronicle", error)}
                action={
                  <Button size="sm" icon="retry" onClick={() => refresh()}>
                    Retry
                  </Button>
                }
              />
            </div>
          )}

          {/* The counters are inside the handoff: outside it they rendered as a
              row of zeros on top of the skeleton's own row of placeholder
              counters, two sets at once on every load. */}
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
              // A failed load is not a quiet window; the strip above says what
              // went wrong.
              !error && (
                <EmptyState
                  icon="history"
                  title="Nothing happened in this window"
                  action={
                    <>
                      {wider && (
                        <Button icon="history" onClick={() => setHours(wider.value)}>
                          Widen to {wider.label}
                        </Button>
                      )}
                      <ButtonLink href="#/schedules/oneoff" variant="primary" icon="bolt">
                        Launch a task
                      </ButtonLink>
                    </>
                  }
                >
                  Schedule runs, agents and sessions land here the moment they start.
                </EmptyState>
              )
            ) : (
              <>
                <section
                  aria-label="Totals for this window"
                  className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4"
                >
                  <HealthCounter label="Runs" value={chronicle.totals.spans} />
                  {/* Amber, like the bars it counts — it was cyan, a colour no
                      working bar on the chart ever is. */}
                  <HealthCounter label="In flight" value={chronicle.totals.active} tone="run" />
                  <HealthCounter label="Failed" value={chronicle.totals.failed} tone="fail" />
                  <HealthCounter
                    label="Run spend"
                    value={
                      chronicle.totals.costUsd != null ? formatUsd(chronicle.totals.costUsd) : "—"
                    }
                  />
                </section>

                <div className="rounded-panel border border-line bg-surface px-4 pb-3 pt-3.5 shadow-raised">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                    <Legend variant="inline" label="Run status" items={STATUS_KEY} />
                    <Legend variant="inline" label="Lane kind" items={KIND_KEY} />
                  </div>

                  {/* Axis */}
                  <div className="flex border-t border-line/60 pt-1" aria-hidden>
                    <div className={`hidden md:block ${LANE_COL}`} />
                    <div className="@container relative h-6 min-w-0 flex-1">
                      {ticks.map((t, i) => {
                        // A label is centred on its gridline, except one at the
                        // very start, which would hang half off the panel. One
                        // near the end would run into "Now": dropped there, and
                        // on a narrow track a little further in.
                        const thinned = thinToDays ? !t.major : i % 2 === 1;
                        const visible =
                          t.pct > 94
                            ? "hidden"
                            : t.pct > 85 || (thinned && longTicks)
                              ? "hidden @min-[38rem]:block"
                              : thinned
                                ? "hidden @min-[25rem]:block"
                                : "";
                        return (
                          <span
                            key={t.pct}
                            className={`absolute top-1 whitespace-nowrap text-micro text-ink-faint ${
                              t.pct < 4 ? "" : "-translate-x-1/2"
                            } ${visible}`}
                            style={{ left: `${t.pct}%` }}
                          >
                            {t.label}
                          </span>
                        );
                      })}
                      <span className="absolute right-0 top-1 text-micro font-semibold text-eye">
                        Now
                      </span>
                    </div>
                  </div>

                  {/* Lanes with tick gridlines behind them */}
                  <div className="relative">
                    <div className="pointer-events-none absolute inset-0 flex" aria-hidden>
                      <div className={`hidden md:block ${LANE_COL}`} />
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
              </>
            )}
          </Handoff>
        </>
      )}
    </Page>
  );
}
