import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertStrip,
  Button,
  ButtonLink,
  chipClass,
  createVelocityTracker,
  DURATION,
  EmptyState,
  formatMs,
  formatTokens,
  formatUsd,
  Icon,
  IconButton,
  Loading,
  Page,
  prefersReducedMotion,
  runDsStatus,
  SegmentedControl,
  settleFrom,
  Skeleton,
  StatusPill,
  TimeAgo,
  useSyncedDelay,
  useTicker,
  type IconName,
} from "../ds";
import { AutopsyPanel } from "./AutopsyPanel";
import { VerdictPanel } from "./VerdictPanel";
import { useHashRoute } from "../useHashRoute";
import { useRecording } from "../useRecording";
import type {
  RecorderEvent,
  RecorderEventKind,
  RecorderLane,
  RecorderUnavailable,
  Recording,
} from "../types";
import {
  TRACK_COLUMNS,
  eventWindow,
  indexAtTime,
  laneDensity,
  stepIndex,
  trackTime,
} from "./recorderTrack";

/**
 * The Flight Recorder.
 *
 * A run's transcript, playable. The scrubber is the primary control and
 * everything else follows it: the lane strips show where the density was, the
 * list follows the playhead, and the detail panel shows the one event you are
 * parked on. "Jump to failure" is a first-class button rather than a scroll,
 * because on a failed run it is the only place anyone wants to be.
 *
 * The position lives in the URL (`#/run/<id>/<ms>`), so a link to a recording is
 * a link to a *moment* in it — the thing you actually want to paste into a
 * thread when you are asking someone to look at minute four.
 */

/**
 * Lanes are categories, not statuses, so they are drawn in neutral ink. They
 * used to be amber, violet, green and blue — the colours that mean working,
 * waiting on a human, done and queued everywhere else in the app — which made a
 * busy tool lane read as a gate and every file edit as a success. The one
 * colour left on the track is the one that is a status: red, where it failed.
 */
const LANE_LABEL: Record<RecorderLane, string> = {
  agent: "Agent",
  tool: "Tools",
  file: "Files",
  spend: "Tokens & cost",
};

const KIND_ICON: Record<RecorderEventKind, IconName> = {
  start: "flag",
  prompt: "user",
  thinking: "sparkle",
  text: "message",
  tool: "terminal",
  file: "edit",
  usage: "coin",
  error: "alert",
  end: "stop",
};

const KIND_LABEL: Record<RecorderEventKind, string> = {
  start: "Run start",
  prompt: "Prompt",
  thinking: "Thinking",
  text: "Message",
  tool: "Tool call",
  file: "File edit",
  usage: "Usage",
  error: "Error",
  end: "Run end",
};

const SPEEDS = [
  { value: "1", label: "1×" },
  { value: "5", label: "5×" },
  { value: "20", label: "20×" },
  { value: "100", label: "100×" },
] as const;

const WINDOW_SIZE = 41;

const NO_EVENTS: RecorderEvent[] = [];

const UNAVAILABLE_COPY: Record<RecorderUnavailable, string> = {
  "not-started":
    "This run never started, so there is nothing to replay. Skipped runs record why they were skipped on the Scheduler tab.",
  "no-session":
    "This run finished without a transcript session, so only its outcome was recorded. Runs launched before transcript capture look like this.",
  "no-transcript":
    "Argus couldn't find this run's transcript on disk. It may have been pruned, or written under a different Claude home than the one Argus is reading.",
  "empty-transcript":
    "The transcript exists but holds no replayable events yet. If the run just started, this fills in within a few seconds.",
};

function isError(event: RecorderEvent): boolean {
  return event.errored === true || event.kind === "error";
}

const FAILURE_MESSAGE_MAX = 240;

/**
 * What the failure strip says: the failing event's label — minus a leading
 * "Failed —", which the strip's own badge already says — and the first line of
 * its detail when that adds anything. The protocol line an agent prints for
 * the scheduler (`ARGUS_OUTCOME: …`) is not a reason a person needs to read.
 */
function failureSummary(event: RecorderEvent): { subject: string; message: string } {
  const stripped = event.label.replace(/^Failed\s*[—–-]\s*/, "").trim();
  const subject = stripped ? stripped[0].toUpperCase() + stripped.slice(1) : event.label;
  const first =
    (event.detail ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("ARGUS_OUTCOME:")) ?? "";
  const clipped =
    first.length > FAILURE_MESSAGE_MAX ? `${first.slice(0, FAILURE_MESSAGE_MAX - 1)}…` : first;
  return { subject, message: clipped && !subject.includes(clipped) ? clipped : "" };
}

/**
 * Whether an event was read from the transcript rather than written from the
 * run record. The server always brackets a started run with a synthetic start
 * and a terminal end or error (both on the agent lane), so `unavailable` stays
 * null even when the transcript itself was never found — these are the events
 * that prove it was.
 */
function fromTranscript(event: RecorderEvent): boolean {
  if (event.kind === "start" || event.kind === "end") return false;
  return !(event.kind === "error" && event.lane === "agent");
}

/** Where a run came from, as a link back to the list that owns it. There is no
 *  per-schedule or per-pipeline route, so this is the list the run lives in. */
function sourceOf(scheduleId: string): {
  label: string;
  list: string;
  href: string;
  icon: IconName;
} {
  if (scheduleId.startsWith("pipeline:")) {
    return { label: "Pipeline run", list: "Open Pipelines", href: "#/pipelines", icon: "pipeline" };
  }
  if (scheduleId === "oneoff") {
    return {
      label: "One-off run",
      list: "Open one-off runs",
      href: "#/schedules/oneoff",
      icon: "bolt",
    };
  }
  return {
    label: "Scheduled run",
    list: "Open the Scheduler",
    href: "#/schedules",
    icon: "calendar",
  };
}

/**
 * Which of a lane's columns hold a failure. The same quantization as
 * `laneDensity`, so a red column sits exactly on the mark it explains.
 */
function laneErrors(
  events: RecorderEvent[],
  lane: RecorderLane,
  durationMs: number,
  columns: number,
): boolean[] {
  const cols = new Array<boolean>(columns).fill(false);
  if (durationMs <= 0) return cols;
  for (const e of events) {
    if (e.lane !== lane || !isError(e)) continue;
    const col = Math.min(columns - 1, Math.max(0, Math.floor((e.atMs / durationMs) * columns)));
    cols[col] = true;
  }
  return cols;
}

/**
 * The 220 shaded columns of one lane, with its failures marked over them.
 *
 * Split out from {@link LaneStrip} on purpose: the playhead moves every frame
 * during playback, and this subtree does not. Keeping it in its own memoized
 * component means a 100× replay re-renders one absolutely-positioned line
 * rather than ~880 spans across four lanes, sixty times a second.
 *
 * A failure is a fixed-width mark laid over the columns rather than a column
 * coloured red: on a phone a column is under a pixel wide, so a red column was
 * a hairline, and one at the very end sat under the strip's rounded clip. The
 * mark is held inside either edge for the same reason.
 */
/** At least 4px, and never narrower than the column it marks, so no grey edge
 *  of that column shows either side of the red on a wide track. */
const MARK_WIDTH = `max(4px, ${100 / TRACK_COLUMNS}%)`;

const DensityRow = memo(function DensityRow({
  density,
  errors,
}: {
  density: number[];
  errors: boolean[];
}) {
  return (
    <>
      <div className="flex h-full w-full">
        {density.map((d, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={`h-full flex-1 ${d > 0 ? "bg-ink-dim" : ""}`}
            style={d > 0 ? { opacity: 0.22 + d * 0.6 } : undefined}
          />
        ))}
      </div>
      {errors.map((failed, i) =>
        failed ? (
          <span
            key={i}
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 -translate-x-1/2 bg-fail"
            style={{
              width: MARK_WIDTH,
              left: `clamp(calc(${MARK_WIDTH} / 2), ${((i + 0.5) / errors.length) * 100}%, calc(100% - ${MARK_WIDTH} / 2))`,
            }}
          />
        ) : null,
      )}
    </>
  );
});

/**
 * One lane's density strip: bounded DOM, shaped like the run.
 *
 * Also the app's most direct-manipulation surface. The strips *look* like a track
 * you can grab, and until now they were decoration next to a slider — so grabbing
 * one did nothing, which is the specific kind of dead affordance that makes a UI
 * feel like a picture of an instrument. `onScrub` makes the lane itself the
 * control: press anywhere to land there, drag to scrub 1:1 with the pointer.
 *
 * The range input stays exactly as it was and remains the accessible control —
 * this is pointer-only enhancement, added beside the keyboard path rather than in
 * place of it.
 *
 * Renders two cells of the timeline grid — the label and the strip — so every
 * lane and the scrubber share one column edge without a spacer to line them up.
 * On a phone the label sits above its strip instead: beside it, a fixed label
 * column left the track two hundred pixels to show a whole run in.
 */
function LaneStrip({
  lane,
  count,
  events,
  durationMs,
  playheadPct,
  onScrub,
}: {
  lane: RecorderLane;
  count: number;
  events: RecorderEvent[];
  durationMs: number;
  playheadPct: number;
  onScrub: (event: React.PointerEvent<HTMLElement>) => void;
}) {
  const density = useMemo(
    () => laneDensity(events, lane, durationMs, TRACK_COLUMNS),
    [events, lane, durationMs],
  );
  const errors = useMemo(
    () => laneErrors(events, lane, durationMs, TRACK_COLUMNS),
    [events, lane, durationMs],
  );
  return (
    <>
      <span className="mt-2 flex min-w-0 items-baseline gap-1.5 text-caption first:mt-0 sm:mt-0 sm:justify-end">
        <span className="truncate text-ink-dim" title={LANE_LABEL[lane]}>
          {LANE_LABEL[lane]}
        </span>
        <span className="tabular-nums text-ink-faint">{count}</span>
      </span>
      <div
        onPointerDown={onScrub}
        className="relative h-6 min-w-0 cursor-ew-resize touch-none overflow-hidden rounded-md bg-ground-2"
      >
        <DensityRow density={density} errors={errors} />
        {/* A transform rather than `left`: the playhead moves every frame during
            a 100× replay, and `left` would re-lay-out the strip sixty times a
            second to do it. The translated element is full-width so that a
            percentage means a percentage *of the track* — on the 2px line itself
            it would mean 1% of two pixels. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-full will-change-transform"
          style={{ transform: `translateX(${playheadPct}%)` }}
        >
          <span className="block h-full w-0.5 -translate-x-1/2 bg-eye shadow-[0_0_8px_var(--color-eye)]" />
        </span>
      </div>
    </>
  );
}

/**
 * The scrubber: a native range input — the accessible control, with the
 * keyboard semantics a slider promises — dressed as the recorder's own rail.
 * The progress fill is a scaled layer under a transparent track, so playback
 * moves a transform rather than repainting a gradient every frame.
 */
/** The lanes and the scrubber share one grid, so they share one left edge. */
const TRACK_GRID =
  "grid grid-cols-1 items-center gap-y-1 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-x-3 sm:gap-y-1.5";

const RANGE =
  "relative h-6 w-full min-w-0 cursor-pointer appearance-none bg-transparent " +
  "[&::-webkit-slider-runnable-track]:h-6 [&::-webkit-slider-runnable-track]:bg-transparent " +
  "[&::-webkit-slider-thumb]:mt-1 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-ground [&::-webkit-slider-thumb]:bg-eye [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--color-eye),0_0_10px_var(--color-eye)] " +
  "[&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-ground [&::-moz-range-thumb]:bg-eye";

/** The event the playhead is parked on, in full. */
function NowPanel({ event }: { event: RecorderEvent | null }) {
  return (
    <div className="min-h-[10rem] rounded-tile border border-line bg-surface p-4 shadow-raised">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="eyebrow">Current event</h2>
        {event && (
          <span className="text-caption tabular-nums text-ink-faint">{trackTime(event.atMs)}</span>
        )}
      </div>
      {!event ? (
        <p className="flex items-start gap-2 text-small text-ink-faint">
          <Icon name="play" size={15} className="mt-0.5" />
          Before the first event. Press play, or drag the scrubber, to start the replay.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={chipClass(event.kind === "error" ? "fail" : "neutral")}>
              <Icon name={KIND_ICON[event.kind]} size={12} />
              {KIND_LABEL[event.kind]}
            </span>
            {event.tool && event.kind !== "tool" && (
              <span className={chipClass()}>{event.tool}</span>
            )}
            {event.errored && event.kind !== "error" && (
              <span className={chipClass("fail")}>error</span>
            )}
            {event.durationMs != null && (
              <span className="text-caption text-ink-faint">took {formatMs(event.durationMs)}</span>
            )}
          </div>
          <p
            className={`mt-2.5 break-words text-heading font-semibold ${
              isError(event) ? "text-fail-ink" : "text-ink"
            }`}
          >
            {event.label}
          </p>
          {event.path && (
            <p className="mt-2 break-all font-mono text-caption text-ink-dim">
              {event.path}
              {event.added != null && (
                <>
                  {" "}
                  <span className="text-ok">+{event.added}</span>{" "}
                  <span className="text-fail">−{event.removed ?? 0}</span>
                </>
              )}
            </p>
          )}
          {(event.tokens != null || event.costTotalUsd != null) && (
            <p className="mt-2 text-caption text-ink-dim">
              {event.tokens != null && <>{formatTokens(event.tokens)} tokens this burst</>}
              {event.tokensTotal != null && <> · {formatTokens(event.tokensTotal)} cumulative</>}
              {event.costTotalUsd != null && <> · {formatUsd(event.costTotalUsd)} spent so far</>}
            </p>
          )}
          {event.detail && (
            <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-ground-2/60 p-3 font-mono text-caption leading-relaxed text-ink-dim">
              {event.detail}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The run's tally, as one strip under the header: what it did (tool calls, file
 * edits, errors) and what it cost. One panel with hairline cells rather than
 * five outlined boxes; a zero is quiet, and only a non-zero error count is red.
 */
function Totals({ recording }: { recording: Recording }) {
  const t = recording.totals;
  const items: { label: string; value: string; tone: string }[] = [
    {
      label: "Tool calls",
      value: String(t.tools),
      tone: t.tools > 0 ? "text-ink" : "text-ink-faint",
    },
    {
      label: "File edits",
      value: String(t.files),
      tone: t.files > 0 ? "text-ink" : "text-ink-faint",
    },
    {
      // What the count is: tool calls that came back as errors. Labelled
      // "Errors", a failed run read "Errors 0" under a red Failed pill.
      label: "Tool errors",
      value: String(t.errors),
      tone: t.errors > 0 ? "text-fail" : "text-ink-faint",
    },
    {
      label: "Tokens",
      value: t.tokens != null ? formatTokens(t.tokens) : "—",
      tone: t.tokens != null ? "text-ink" : "text-ink-faint",
    },
    {
      label: "Cost",
      value: t.costUsd != null ? formatUsd(t.costUsd) : "—",
      tone: t.costUsd != null ? "text-ink" : "text-ink-faint",
    },
  ];
  return (
    // Six columns on a phone so the five cells land as a row of three over a
    // row of two with no empty cell showing the hairline background through.
    <dl className="mb-6 grid grid-cols-6 gap-px overflow-hidden rounded-tile border border-line bg-line shadow-raised sm:grid-cols-5">
      {items.map((i, n) => (
        <div
          key={i.label}
          className={`bg-surface px-4 py-3 sm:col-span-1 ${n < 3 ? "col-span-2" : "col-span-3"}`}
        >
          <dt className="text-caption text-ink-faint">{i.label}</dt>
          <dd className={`mt-0.5 text-title font-semibold tabular-nums ${i.tone}`}>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The live run's toggle. Pressed, it says so with the eye's breathing dot —
 * cyan is the colour of "live" — and pressing it again parks the playhead where
 * it is. Released, it is the row's one solid button: the way back to the edge.
 */
function FollowLive({ following, onToggle }: { following: boolean; onToggle: () => void }) {
  const beat = useSyncedDelay(DURATION.pulse);
  if (!following) {
    return (
      <Button variant="primary" aria-pressed={false} onClick={onToggle} className="sm:mr-3">
        <span aria-hidden="true" className="h-2 w-2 rounded-full border-[1.5px] border-current" />
        Follow live
      </Button>
    );
  }
  return (
    <Button aria-pressed onClick={onToggle} className="border-eye/40! bg-eye/10! text-eye! sm:mr-3">
      <span
        aria-hidden="true"
        style={{ animationDelay: beat }}
        className="h-2 w-2 rounded-full bg-current motion-safe:animate-[pulse_var(--duration-pulse)_ease-in-out_infinite]"
      />
      Following live
    </Button>
  );
}

/** Status, provenance, start and length — the line under the run's name.
 *  `durationMs` is the recorder's own, which keeps counting while a run is live. */
function RunCaption({ recording, durationMs }: { recording: Recording; durationMs: number }) {
  const source = sourceOf(recording.scheduleId);
  const running = recording.status === "running";
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-caption text-ink-faint">
      <StatusPill status={runDsStatus(recording)} />
      <a
        href={source.href}
        className="inline-flex items-center gap-1.5 rounded-sm text-ink-dim transition-colors duration-(--duration-quick) hover:text-ink"
      >
        <Icon name={source.icon} size={14} />
        {source.label}
      </a>
      {recording.startedAt && (
        <span className="inline-flex items-center gap-1.5">
          <Icon name="flag" size={14} />
          Started <TimeAgo iso={recording.startedAt} />
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <Icon name="clock" size={14} />
        {running ? "Running for" : "Took"}{" "}
        <span className="text-ink-dim">{formatMs(durationMs)}</span>
      </span>
    </span>
  );
}

/**
 * The caption line before the run has loaded: a pill and two facts, in phase
 * with the page's other shimmer. Spans, because Page sets a subtitle in a <p>.
 */
function CaptionSkeleton() {
  const beat = useSyncedDelay(DURATION.shimmer);
  const block = (shape: string) => (
    <span
      aria-hidden="true"
      style={{ animationDelay: beat }}
      className={`skeleton inline-block ${shape}`}
    />
  );
  return (
    <span className="flex h-6 items-center gap-x-3">
      {block("h-6 w-16 rounded-full")}
      {block("h-3 w-24 rounded")}
      {block("h-3 w-20 rounded")}
    </span>
  );
}

/** Shaped like the recorder it stands in for, so nothing jumps when it lands. */
function RecorderSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-6 gap-px overflow-hidden rounded-tile border border-line bg-line sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div
            key={i}
            className={`bg-surface px-4 py-3 sm:col-span-1 ${i < 3 ? "col-span-2" : "col-span-3"}`}
          >
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="mt-2.5 h-4 w-10" />
          </div>
        ))}
      </div>
      <div className="rounded-tile border border-line bg-surface p-4 sm:p-5">
        <Skeleton className="mb-5 h-2.5 w-20" />
        <div className={TRACK_GRID}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="contents">
              <Skeleton className={`h-2.5 w-12 sm:mt-0 sm:ml-auto ${i > 0 ? "mt-3" : "mt-1"}`} />
              <Skeleton className="h-6 w-full rounded-md" />
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-control" />
          <Skeleton className="h-8 w-20 rounded-control" />
          <Skeleton className="h-8 w-8 rounded-control" />
          <Skeleton className="ml-auto h-8 w-40 rounded-control" />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="divide-y divide-line rounded-tile border border-line bg-surface">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5">
              <Skeleton className="h-2.5 w-9" />
              <Skeleton className="h-3.5 w-3.5 rounded-full" />
              <Skeleton className={`h-3 ${i % 2 ? "w-2/5" : "w-3/5"}`} />
            </div>
          ))}
        </div>
        <div className="hidden rounded-tile border border-line bg-surface p-4 lg:block">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="mt-4 h-4 w-3/4" />
          <Skeleton className="mt-3 h-16 w-full rounded-control" />
        </div>
      </div>
    </div>
  );
}

export default function FlightRecorder() {
  const segments = useHashRoute();
  const runId = segments[1] ?? null;
  const deepLinkMs = Number(segments[2]);
  const { recording, loading, error, refresh } = useRecording(runId);

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]["value"]>("20");
  const [copied, setCopied] = useState(false);
  // A live run opens parked on its newest moment and stays there as it grows,
  // until the reader takes the playhead somewhere else. Opened at 00:00 with a
  // Play button, a run that was working read as a finished, empty recording.
  const [following, setFollowing] = useState(false);
  // The node a postmortem with nothing to say is portalled into, below the
  // track. State rather than a ref, so the panel re-renders once it exists.
  const [autopsySlot, setAutopsySlot] = useState<HTMLDivElement | null>(null);
  // The deep-link position is applied exactly once per run: re-applying it on
  // every refresh (a live run refetches as it grows) would yank the scrubber
  // back out from under the person dragging it.
  const seeded = useRef<string | null>(null);

  // Referentially stable when there is no recording: a fresh `[]` per render
  // would invalidate every memo below on every frame of playback.
  const events = recording?.events ?? NO_EVENTS;
  const failureIndex = recording?.failureIndex ?? null;
  const live = recording?.status === "running";
  // A running run's track ends at "now", which the server can only say as of
  // its last answer — and a quiet run may not be refetched for minutes. Between
  // answers the end keeps counting here, so the clock and the track move.
  const now = useTicker(live);
  const startedMs = recording?.startedAt ? Date.parse(recording.startedAt) : Number.NaN;
  const durationMs =
    live && Number.isFinite(startedMs)
      ? Math.max(recording.durationMs, now - startedMs)
      : (recording?.durationMs ?? 0);
  // Where the playhead is: the live edge while following, the reader's own
  // position otherwise.
  const at = following ? durationMs : t;

  useEffect(() => {
    if (!recording || seeded.current === recording.runId) return;
    seeded.current = recording.runId;
    const deepLinked = Number.isFinite(deepLinkMs);
    const wanted = deepLinked ? Math.max(0, Math.min(recording.durationMs, deepLinkMs)) : 0;
    setT(wanted);
    setFollowing(recording.status === "running" && !deepLinked);
  }, [recording, deepLinkMs]);

  // A run that finishes while it is being followed hands the reader its end,
  // not a toggle that no longer has anything to follow.
  if (following && recording && !live) {
    setFollowing(false);
    setT(recording.durationMs);
  }

  // Playback. A wall-clock replay of a 40-minute run is nobody's idea of a good
  // time, so the speed multiplier is part of the control set rather than a
  // hidden constant, and playback stops dead at the end instead of looping.
  useEffect(() => {
    if (!playing || durationMs <= 0) return;
    let raf = 0;
    let last = performance.now();
    const multiplier = Number(speed);
    const tick = (now: number) => {
      const dt = (now - last) * multiplier;
      last = now;
      setT((prev) => {
        const next = prev + dt;
        if (next >= durationMs) {
          setPlaying(false);
          return durationMs;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, durationMs]);

  const index = useMemo(() => indexAtTime(events, at), [events, at]);
  const current = index >= 0 ? events[index] : null;

  // Keep the URL pointing at the moment on screen without flooding history:
  // replaceState does not fire `hashchange`, so the router above stays put.
  // While following a live run the URL names no moment, so a link copied from
  // the address bar opens the run live too.
  useEffect(() => {
    if (!runId || !recording) return;
    const handle = window.setTimeout(() => {
      const hash = `#/run/${encodeURIComponent(runId)}${following ? "" : `/${Math.round(t)}`}`;
      if (window.location.hash !== hash) {
        window.history.replaceState(null, "", hash);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [runId, recording, t, following]);

  const seek = useCallback((ms: number) => {
    setPlaying(false);
    setFollowing(false);
    setT(Math.max(0, ms));
  }, []);

  // At the end — a replay that finished, or the live edge — Play starts over
  // rather than stopping dead on the spot it started from.
  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    setFollowing(false);
    setT(at >= durationMs ? 0 : at);
    setPlaying(true);
  }, [playing, at, durationMs]);

  const toggleFollow = useCallback(() => {
    setPlaying(false);
    if (following) setT(durationMs);
    setFollowing(!following);
  }, [following, durationMs]);

  /**
   * Pointer scrubbing on the lane strips, with a momentum settle on release.
   *
   * Two halves, and the second is the one that makes it feel like an instrument.
   * *During* the drag the playhead tracks the pointer exactly — no easing, no
   * smoothing, because any lag between finger and playhead is felt immediately as
   * the control being a proxy for the thing rather than the thing. *On release*
   * the recording keeps moving briefly in the direction of the flick and decays to
   * rest, so letting go of a fast scrub hands its momentum over instead of
   * stopping dead at the pixel the pointer happened to leave.
   *
   * The glide is deliberately small — capped at 600ms in `settleDuration`, and
   * clamped to the recording — because this is a seek, not a scroll: overshooting
   * the moment you were aiming for would be worse than not gliding at all.
   */
  const scrub = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (durationMs <= 0 || event.button !== 0) return;
      const track = event.currentTarget;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const toMs = (clientX: number) =>
        Math.max(0, Math.min(durationMs, ((clientX - rect.left) / rect.width) * durationMs));

      setPlaying(false);
      setFollowing(false);
      const tracker = createVelocityTracker();
      let last = toMs(event.clientX);
      tracker.sample(last, event.timeStamp);
      setT(last);

      const onMove = (move: PointerEvent) => {
        last = toMs(move.clientX);
        tracker.sample(last, move.timeStamp);
        setT(last);
      };
      const onUp = (up: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (prefersReducedMotion()) return;
        tracker.sample(toMs(up.clientX), up.timeStamp);
        // Velocity is in ms-of-recording per ms-of-wall-clock, which is exactly
        // the unit the glide needs — the track's pixel scale is already baked in.
        const glide = settleFrom(tracker.velocity());
        if (glide.ms === 0) return;
        const from = last;
        const to = Math.max(0, Math.min(durationMs, from + glide.distance));
        const started = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, (now - started) / glide.ms);
          setT(from + (to - from) * (1 - (1 - progress) ** 3));
          if (progress < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [durationMs],
  );

  const step = useCallback(
    (dir: 1 | -1) => {
      const next = stepIndex(events, at, dir);
      if (next != null) seek(events[next].atMs);
      else if (dir === 1) seek(durationMs);
      else seek(0);
    },
    [events, at, seek, durationMs],
  );

  const jumpToFailure = useCallback(() => {
    if (failureIndex == null) return;
    seek(events[failureIndex].atMs);
  }, [failureIndex, events, seek]);

  const copyLink = useCallback(() => {
    if (!runId) return;
    const url = `${window.location.origin}${window.location.pathname}#/run/${encodeURIComponent(runId)}/${Math.round(at)}`;
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  }, [runId, at]);

  // Keyboard: space toggles playback, arrows step, f jumps to the failure. Only
  // when focus isn't in a field, so typing in a future filter box is unaffected.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const isRange = el?.tagName === "INPUT" && el.getAttribute("type") === "range";
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !isRange) return;
      // Already handled — the speed control steps its own segments on the
      // arrows — or a browser chord (Ctrl/⌘ F is find, not "jump to failure").
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      // A focused button already activates on space. Handling space here too
      // would toggle playback twice per press — once from the click the browser
      // synthesizes, once from us — leaving the state unchanged and the Play
      // button apparently dead. Only space, though: after a click focus stays on
      // the button, and the arrows and F have to keep working from there.
      if (e.key === " " && el?.closest("button")) return;

      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight" && !isRange) {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft" && !isRange) {
        e.preventDefault();
        step(-1);
      } else if (e.key.toLowerCase() === "f") {
        jumpToFailure();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, jumpToFailure, togglePlay]);

  if (!runId) {
    return (
      <Page title="Flight Recorder" subtitle="Replay any run, event by event.">
        <EmptyState
          title="No run selected"
          icon="replay"
          action={
            <ButtonLink href="#/chronicle" variant="primary" iconRight="arrow-right">
              Open the Chronicle
            </ButtonLink>
          }
        >
          Open a run from the Chronicle, Issues or the Scheduler to replay it here.
        </EmptyState>
      </Page>
    );
  }

  // The server answers 404 for a run it has no record of — pruned, or never
  // there. That is an answer about the data, not a failed load: a Retry under
  // it could never succeed.
  const notFound = error === "HTTP 404";
  const retry = (
    <Button size="sm" icon="retry" onClick={() => void refresh()}>
      Retry
    </Button>
  );

  if (loading && !recording) {
    return (
      <Page
        title="Flight Recorder"
        // Holds the caption line's height, so the page doesn't drop when the
        // status line lands.
        subtitle={<CaptionSkeleton />}
        crumbs={[{ label: "Chronicle", href: "#/chronicle" }]}
      >
        <Loading label="recording">
          <RecorderSkeleton />
        </Loading>
      </Page>
    );
  }

  // Only a load that produced nothing replaces the page. A live run refetches
  // as it grows, and one failed refresh of a recording already on screen is a
  // strip above it, not a reason to take the replay away.
  if (error && !notFound && !recording) {
    return (
      <Page title="Flight Recorder" crumbs={[{ label: "Chronicle", href: "#/chronicle" }]}>
        <AlertStrip subject="Couldn't load this recording" message={error} action={retry} />
      </Page>
    );
  }

  if (!recording || notFound) {
    return (
      <Page title="Flight Recorder" crumbs={[{ label: "Chronicle", href: "#/chronicle" }]}>
        <EmptyState
          title="Run not found"
          icon="history"
          action={
            <ButtonLink href="#/chronicle" iconRight="arrow-right">
              Open the Chronicle
            </ButtonLink>
          }
        >
          Argus has no record of this run. Run records are pruned once their schedule has newer
          ones, so an older link can outlive the run it pointed to.
        </EmptyState>
      </Page>
    );
  }

  const pct = durationMs > 0 ? Math.min(100, (at / durationMs) * 100) : 0;
  const { start, slice } = eventWindow(events, index, WINDOW_SIZE);
  const reduced = prefersReducedMotion();
  const source = sourceOf(recording.scheduleId);
  const failurePct =
    failureIndex != null && durationMs > 0
      ? Math.min(100, (events[failureIndex].atMs / durationMs) * 100)
      : null;
  // No link to a transcript the recorder could not read: a session id alone is
  // not proof the file is on disk, and the link would land on a 404.
  const transcriptHref =
    recording.project && recording.sessionId && events.some(fromTranscript)
      ? `#/sessions/${encodeURIComponent(recording.project)}/${encodeURIComponent(recording.sessionId)}`
      : null;
  const failureEvent = failureIndex != null ? events[failureIndex] : null;
  const failure = failureEvent ? failureSummary(failureEvent) : null;
  // Where the autopsy goes when all it has to say is that it has nothing to say.
  const autopsyFallback = <div ref={setAutopsySlot} className="mb-6 empty:hidden" />;

  return (
    <Page
      title={recording.scheduleName}
      subtitle={<RunCaption recording={recording} durationMs={durationMs} />}
      crumbs={[{ label: "Chronicle", href: "#/chronicle" }]}
      actions={
        (transcriptHref || live) && (
          <>
            {/* The recorder only watches. Stopping a run is done where it was
                fired from, so a live one links straight back there. */}
            {live && (
              <ButtonLink
                href={source.href}
                size="sm"
                icon={source.icon}
                title="Cancel or re-run it from where it was fired"
              >
                {source.list}
              </ButtonLink>
            )}
            {transcriptHref && (
              <ButtonLink href={transcriptHref} size="sm" icon="terminal">
                Open transcript
              </ButtonLink>
            )}
          </>
        )
      }
    >
      {error && (
        <div className="mb-6">
          <AlertStrip
            subject="Couldn't refresh this recording"
            message={`${error} — showing what was loaded last.`}
            action={retry}
          />
        </div>
      )}

      {/* Why it failed, first. The totals below count tool errors, and a run
          can fail with none of those — an exit code, a refused outcome — so the
          page used to open on "0 errors" under a red pill and leave the reason
          as the last row of the event list. */}
      {failure && failureEvent && (
        <div className="mb-6">
          <AlertStrip
            tone="failed"
            subject={failure.subject}
            message={failure.message}
            when={`at ${trackTime(failureEvent.atMs)}`}
            action={
              <Button size="sm" onClick={jumpToFailure}>
                Jump to failure
              </Button>
            }
          />
        </div>
      )}

      <Totals recording={recording} />

      {/* The postmortem sits above the track on purpose: on a failed run it is
          the summary, and the span it cites is checkable against the timeline
          immediately below it. A pass that produced nothing moves below the
          track instead (`fallbackSlot`): its own error is not the headline. */}
      <div className="mb-6 space-y-4 empty:hidden">
        <AutopsyPanel runId={runId} onSeek={seek} fallbackSlot={autopsySlot} />
        <VerdictPanel runId={runId} />
      </div>

      {recording.events.length === 0 ? (
        <>
          <EmptyState
            title="Nothing to replay"
            icon="replay"
            action={
              recording.unavailable === "empty-transcript" ? (
                <Button icon="retry" onClick={() => void refresh()}>
                  Check again
                </Button>
              ) : recording.unavailable === "no-transcript" ? (
                <ButtonLink href="#/sessions" icon="terminal">
                  Browse transcripts
                </ButtonLink>
              ) : (
                <ButtonLink href={source.href} icon={source.icon}>
                  {source.list}
                </ButtonLink>
              )
            }
          >
            {recording.unavailable
              ? UNAVAILABLE_COPY[recording.unavailable]
              : "Nothing was recorded for this run."}
          </EmptyState>
          <div className="mt-6">{autopsyFallback}</div>
        </>
      ) : (
        <>
          <section
            className="mb-6 rounded-tile border border-line bg-surface p-4 shadow-raised sm:p-5"
            aria-label="Timeline"
          >
            <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              <h2 className="eyebrow">Timeline</h2>
              {/* The shortcuts were real and invisible. A pointer user is the one
                  who would gain most from knowing them, and on a phone there is
                  no keyboard to mention. The keycaps are set at the type floor:
                  the utility's own 0.78em came to 9px inside a caption. */}
              <p className="hidden flex-wrap items-center gap-x-4 gap-y-1 text-caption text-ink-faint sm:flex">
                <span className="inline-flex items-center gap-1.5">
                  <kbd className="kbd text-micro!">Space</kbd> play or pause
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <kbd className="kbd text-micro!">←</kbd>
                  <kbd className="kbd text-micro!">→</kbd> step
                </span>
                {failureIndex != null && (
                  <span className="inline-flex items-center gap-1.5">
                    <kbd className="kbd text-micro!">F</kbd> failure
                  </span>
                )}
              </p>
            </div>

            <div className={TRACK_GRID}>
              {recording.lanes.map((l) => (
                <LaneStrip
                  key={l.lane}
                  lane={l.lane}
                  count={l.count}
                  events={events}
                  durationMs={durationMs}
                  playheadPct={pct}
                  onScrub={scrub}
                />
              ))}

              <span aria-hidden="true" className="hidden sm:block" />
              <div className="relative mt-3 flex min-w-0 items-center sm:mt-1.5">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-surface-3"
                >
                  <span
                    className="block h-full w-full origin-left bg-eye/55 will-change-transform"
                    style={{ transform: `scaleX(${pct / 100})` }}
                  />
                </span>
                {failurePct != null && (
                  <span
                    aria-hidden="true"
                    title="Failure"
                    className="pointer-events-none absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fail"
                    style={{ left: `${failurePct}%` }}
                  />
                )}
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, Math.round(durationMs))}
                  step={1}
                  value={Math.round(at)}
                  onChange={(e) => seek(Number(e.target.value))}
                  aria-label="Scrub the recording"
                  aria-valuetext={`${trackTime(at)} of ${trackTime(durationMs)}${current ? ` — ${current.label}` : ""}`}
                  className={RANGE}
                />
              </div>
            </div>

            {/* Play is the row's one solid button, except on a live run: there
                the live edge is where the reader wants to be, so Follow live
                leads and Play — a replay from the start — steps down. On a
                failed run, the way to the failure is the strip at the top. */}
            <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-3">
              {live && <FollowLive following={following} onToggle={toggleFollow} />}
              <IconButton
                icon="skip-back"
                label="Previous event"
                variant="secondary"
                onClick={() => step(-1)}
              />
              <Button
                variant={live ? "secondary" : "primary"}
                icon={playing ? "pause" : "play"}
                onClick={togglePlay}
                aria-label={playing ? "Pause the replay" : "Play the replay"}
                className="min-w-[5.5rem]"
              >
                {playing ? "Pause" : "Play"}
              </Button>
              <IconButton
                icon="skip-forward"
                label="Next event"
                variant="secondary"
                onClick={() => step(1)}
              />
              <span className="ml-2 text-small tabular-nums text-ink">
                {trackTime(at)} <span className="text-ink-faint">/ {trackTime(durationMs)}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2 sm:ml-auto">
                <SegmentedControl
                  segments={SPEEDS.map((s) => ({ value: s.value, label: s.label }))}
                  value={speed}
                  onChange={(v) => setSpeed(v)}
                  label="Playback speed"
                />
                <Button variant="ghost" icon={copied ? "check" : "link"} onClick={copyLink}>
                  {copied ? (
                    "Copied"
                  ) : (
                    // One flex item, so the button's icon gap doesn't open up
                    // between "link" and "to moment" as well.
                    <span>
                      Copy link<span className="hidden sm:inline"> to moment</span>
                    </span>
                  )}
                </Button>
              </span>
            </div>

            {(recording.truncated || recording.costEstimated) && (
              <div className="mt-4 space-y-1.5 border-t border-line pt-3">
                {recording.truncated && (
                  <p className="flex items-start gap-2 text-caption text-ink-faint">
                    <Icon name="info" size={14} className="mt-px" />
                    This run was longer than the recorder keeps: the earliest events were dropped,
                    so the track starts partway in. Timestamps are still absolute.
                  </p>
                )}
                {recording.costEstimated && (
                  <p className="flex items-start gap-2 text-caption text-ink-faint">
                    <Icon name="info" size={14} className="mt-px" />
                    Per-event cost is the run's reported total apportioned by token share — the CLI
                    reports one figure for the whole run.
                  </p>
                )}
              </div>
            )}
          </section>

          {autopsyFallback}

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
            <section
              aria-label="Events"
              className="overflow-hidden rounded-tile border border-line bg-surface shadow-raised"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3">
                <h2 className="eyebrow">Events</h2>
                <p className="text-caption text-ink-faint">
                  {events.length > slice.length
                    ? `${start + 1}–${start + slice.length} of ${events.length} · follows the playhead`
                    : `${events.length} ${events.length === 1 ? "event" : "events"}`}
                </p>
              </div>
              <ol className="divide-y divide-line">
                {slice.map((e, i) => {
                  const absolute = start + i;
                  const isCurrent = absolute === index;
                  const failed = isError(e);
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => seek(e.atMs)}
                        aria-current={isCurrent ? "true" : undefined}
                        className={`flex w-full items-center gap-3 px-4 py-2 text-left transition ${
                          isCurrent
                            ? "bg-surface-2 shadow-[inset_2px_0_0_var(--color-eye)]"
                            : "hover:bg-surface-2/60"
                        } ${reduced ? "" : "duration-(--duration-quick)"}`}
                      >
                        <span className="w-11 shrink-0 text-caption tabular-nums text-ink-faint">
                          {trackTime(e.atMs)}
                        </span>
                        <Icon
                          name={KIND_ICON[e.kind]}
                          size={15}
                          className={
                            failed ? "text-fail" : isCurrent ? "text-ink" : "text-ink-faint"
                          }
                        />
                        <span
                          className={`min-w-0 flex-1 truncate text-small ${
                            failed ? "text-fail" : isCurrent ? "text-ink" : "text-ink-dim"
                          }`}
                        >
                          {e.label}
                        </span>
                        {e.durationMs != null && (
                          <span className="shrink-0 text-caption tabular-nums text-ink-faint">
                            {formatMs(e.durationMs)}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>

            {/* First on a phone: the event you are parked on is the answer, and
                below a 41-row list it would be a scroll away from the scrubber
                that moves it. Beside the list, and pinned, on a wide screen. */}
            <aside
              aria-label="Current event"
              className="order-first lg:sticky lg:top-20 lg:order-none"
            >
              <NowPanel event={current} />
            </aside>
          </div>

          {/* Announced only while paused: narrating every event during a 100×
              replay would be noise, not access. */}
          <p aria-live="polite" className="sr-only">
            {!playing && current ? `${trackTime(current.atMs)} — ${current.label}` : ""}
          </p>
        </>
      )}
    </Page>
  );
}
