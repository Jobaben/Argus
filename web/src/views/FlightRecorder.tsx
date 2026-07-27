import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  EmptyState,
  Loading,
  Page,
  SegmentedControl,
  SkeletonRows,
  StatusPill,
  formatMs,
  formatTokens,
  formatUsd,
  prefersReducedMotion,
  runDsStatus,
} from "../ds";
import { useHashRoute } from "../useHashRoute";
import { useRecording } from "../useRecording";
import type { RecorderEvent, RecorderLane, RecorderUnavailable, Recording } from "../types";
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

const LANE_STYLE: Record<RecorderLane, { label: string; bar: string; text: string }> = {
  agent: { label: "Agent", bar: "bg-run", text: "text-run" },
  tool: { label: "Tools", bar: "bg-await", text: "text-await" },
  file: { label: "Files", bar: "bg-ok", text: "text-ok" },
  spend: { label: "Tokens & cost", bar: "bg-queue", text: "text-queue" },
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

/**
 * The 220 shaded columns of one lane.
 *
 * Split out from {@link LaneStrip} on purpose: the playhead moves every frame
 * during playback, and this subtree does not. Keeping it in its own memoized
 * component means a 100× replay re-renders one absolutely-positioned line
 * rather than ~880 spans across four lanes, sixty times a second.
 */
const DensityRow = memo(function DensityRow({ density, bar }: { density: number[]; bar: string }) {
  return (
    <div className="flex h-full w-full">
      {density.map((d, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`h-full flex-1 ${d > 0 ? bar : ""}`}
          style={d > 0 ? { opacity: 0.25 + d * 0.75 } : undefined}
        />
      ))}
    </div>
  );
});

/** One lane's density strip: bounded DOM, shaped like the run. */
function LaneStrip({
  lane,
  events,
  durationMs,
  playheadPct,
}: {
  lane: RecorderLane;
  events: RecorderEvent[];
  durationMs: number;
  playheadPct: number;
}) {
  const density = useMemo(
    () => laneDensity(events, lane, durationMs, TRACK_COLUMNS),
    [events, lane, durationMs],
  );
  const style = LANE_STYLE[lane];
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 truncate text-right font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
        {style.label}
      </span>
      <div className="relative h-5 min-w-0 flex-1 overflow-hidden rounded-sm bg-ground-2">
        <DensityRow density={density} bar={style.bar} />
        <span
          aria-hidden="true"
          className="absolute top-0 h-full w-px bg-ink"
          style={{ left: `${playheadPct}%` }}
        />
      </div>
    </div>
  );
}

function EventGlyph({ event }: { event: RecorderEvent }) {
  const style = LANE_STYLE[event.lane];
  const mark =
    event.kind === "error"
      ? "!"
      : event.kind === "file"
        ? "±"
        : event.kind === "usage"
          ? "$"
          : event.kind === "tool"
            ? "▸"
            : event.kind === "start"
              ? "◆"
              : event.kind === "end"
                ? "■"
                : "·";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex w-4 shrink-0 justify-center font-mono text-[11px] ${event.errored || event.kind === "error" ? "text-fail" : style.text}`}
    >
      {mark}
    </span>
  );
}

/** The event the playhead is parked on, in full. */
function NowPanel({ event }: { event: RecorderEvent | null }) {
  if (!event) {
    return (
      <Card className="min-h-[9rem]">
        <p className="text-sm text-ink-faint">
          Before the first event. Press play, or drag the scrubber, to start the replay.
        </p>
      </Card>
    );
  }
  return (
    <Card className="min-h-[9rem]">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.13em] text-ink-faint">
          {trackTime(event.atMs)}
        </span>
        <span
          className={`font-mono text-[10px] uppercase tracking-[0.13em] ${LANE_STYLE[event.lane].text}`}
        >
          {event.kind}
        </span>
        {event.durationMs != null && (
          <span className="font-mono text-[10px] text-ink-faint">
            took {formatMs(event.durationMs)}
          </span>
        )}
        {(event.errored || event.kind === "error") && (
          <span className="rounded-full bg-fail/14 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.1em] text-fail">
            error
          </span>
        )}
      </div>
      <p className="mb-2 break-words text-sm font-medium text-ink">{event.label}</p>
      {event.path && (
        <p className="mb-2 break-all font-mono text-[11px] text-ink-dim">
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
        <p className="mb-2 font-mono text-[11px] text-ink-dim">
          {event.tokens != null && <>{formatTokens(event.tokens)} tokens this burst</>}
          {event.tokensTotal != null && <> · {formatTokens(event.tokensTotal)} cumulative</>}
          {event.costTotalUsd != null && <> · {formatUsd(event.costTotalUsd)} spent so far</>}
        </p>
      )}
      {event.detail && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ground-2 p-3 font-mono text-[11px] leading-relaxed text-ink-dim">
          {event.detail}
        </pre>
      )}
    </Card>
  );
}

function Totals({ recording }: { recording: Recording }) {
  const t = recording.totals;
  const items: { label: string; value: string; tone?: string }[] = [
    { label: "Tool calls", value: String(t.tools) },
    { label: "File edits", value: String(t.files) },
    { label: "Errors", value: String(t.errors), tone: t.errors > 0 ? "text-fail" : undefined },
    { label: "Tokens", value: t.tokens != null ? formatTokens(t.tokens) : "—" },
    { label: "Cost", value: t.costUsd != null ? formatUsd(t.costUsd) : "—" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {items.map((i) => (
        <div key={i.label} className="rounded-tile border border-line bg-surface px-3 py-2">
          <dt className="font-mono text-[10px] uppercase tracking-[0.13em] text-ink-faint">
            {i.label}
          </dt>
          <dd className={`font-mono text-lg font-bold ${i.tone ?? "text-ink"}`}>{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function FlightRecorder() {
  const segments = useHashRoute();
  const runId = segments[1] ?? null;
  const deepLinkMs = Number(segments[2]);
  const { recording, loading, error } = useRecording(runId);

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]["value"]>("20");
  const [copied, setCopied] = useState(false);
  // The deep-link position is applied exactly once per run: re-applying it on
  // every refresh (a live run refetches as it grows) would yank the scrubber
  // back out from under the person dragging it.
  const seeded = useRef<string | null>(null);

  // Referentially stable when there is no recording: a fresh `[]` per render
  // would invalidate every memo below on every frame of playback.
  const events = recording?.events ?? NO_EVENTS;
  const durationMs = recording?.durationMs ?? 0;
  const failureIndex = recording?.failureIndex ?? null;

  useEffect(() => {
    if (!recording || seeded.current === recording.runId) return;
    seeded.current = recording.runId;
    const wanted = Number.isFinite(deepLinkMs)
      ? Math.max(0, Math.min(recording.durationMs, deepLinkMs))
      : 0;
    setT(wanted);
  }, [recording, deepLinkMs]);

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

  const index = useMemo(() => indexAtTime(events, t), [events, t]);
  const current = index >= 0 ? events[index] : null;

  // Keep the URL pointing at the moment on screen without flooding history:
  // replaceState does not fire `hashchange`, so the router above stays put.
  useEffect(() => {
    if (!runId || !recording) return;
    const handle = window.setTimeout(() => {
      const hash = `#/run/${encodeURIComponent(runId)}/${Math.round(t)}`;
      if (window.location.hash !== hash) {
        window.history.replaceState(null, "", hash);
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [runId, recording, t]);

  const seek = useCallback((ms: number) => {
    setPlaying(false);
    setT(Math.max(0, ms));
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      const next = stepIndex(events, t, dir);
      if (next != null) seek(events[next].atMs);
      else if (dir === 1) seek(durationMs);
      else seek(0);
    },
    [events, t, seek, durationMs],
  );

  const jumpToFailure = useCallback(() => {
    if (failureIndex == null) return;
    seek(events[failureIndex].atMs);
  }, [failureIndex, events, seek]);

  const copyLink = useCallback(() => {
    if (!runId) return;
    const url = `${window.location.origin}${window.location.pathname}#/run/${encodeURIComponent(runId)}/${Math.round(t)}`;
    void navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => setCopied(false),
    );
  }, [runId, t]);

  // Keyboard: space toggles playback, arrows step, f jumps to the failure. Only
  // when focus isn't in a field, so typing in a future filter box is unaffected.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const isRange = el?.tagName === "INPUT" && el.getAttribute("type") === "range";
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !isRange) return;
      // A focused button already activates on space and enter. Handling space
      // here too would toggle playback twice per press — once from the click
      // the browser synthesizes, once from us — leaving the state unchanged and
      // the Play button apparently dead.
      if (el?.closest("button")) return;

      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
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
  }, [step, jumpToFailure]);

  if (!runId) {
    return (
      <Page title="Flight Recorder">
        <EmptyState>
          Open a run from the Chronicle, Issues or the Scheduler to replay it here.
        </EmptyState>
      </Page>
    );
  }

  if (loading && !recording) {
    return (
      <Page title="Flight Recorder">
        <Loading label="recording">
          <SkeletonRows count={6} />
        </Loading>
      </Page>
    );
  }

  if (error || !recording) {
    return (
      <Page title="Flight Recorder">
        <EmptyState>
          {error
            ? `Couldn't load this recording: ${error}`
            : "That run doesn't exist any more — run records are pruned once a schedule has newer ones."}
        </EmptyState>
      </Page>
    );
  }

  const pct = durationMs > 0 ? Math.min(100, (t / durationMs) * 100) : 0;
  const { start, slice } = eventWindow(events, index, WINDOW_SIZE);
  const reduced = prefersReducedMotion();

  return (
    <Page
      title={recording.scheduleName}
      crumbs={[
        { label: "Chronicle", href: "#/chronicle" },
        { label: "Flight Recorder", href: `#/run/${encodeURIComponent(runId)}` },
      ]}
      actions={
        <>
          <StatusPill status={runDsStatus(recording)} />
          <button
            type="button"
            onClick={copyLink}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.1em] text-ink-dim transition hover:text-ink"
          >
            {copied ? "Copied" : "Copy link to moment"}
          </button>
        </>
      }
    >
      <section className="mb-6">
        <Totals recording={recording} />
      </section>

      {recording.events.length === 0 ? (
        <EmptyState>
          {recording.unavailable
            ? UNAVAILABLE_COPY[recording.unavailable]
            : "Nothing was recorded for this run."}
        </EmptyState>
      ) : (
        <>
          <section
            className="mb-6 rounded-tile border border-line bg-surface p-4"
            aria-label="Timeline"
          >
            <div className="mb-3 space-y-1.5">
              {recording.lanes.map((l) => (
                <LaneStrip
                  key={l.lane}
                  lane={l.lane}
                  events={events}
                  durationMs={durationMs}
                  playheadPct={pct}
                />
              ))}
            </div>

            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0" />
              <input
                type="range"
                min={0}
                max={Math.max(1, Math.round(durationMs))}
                step={1}
                value={Math.round(t)}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Scrub the recording"
                aria-valuetext={`${trackTime(t)} of ${trackTime(durationMs)}${current ? ` — ${current.label}` : ""}`}
                className="min-w-0 flex-1 accent-eye"
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => step(-1)}
                aria-label="Previous event"
                className="rounded-md border border-line px-2.5 py-1 font-mono text-xs text-ink-dim transition hover:text-ink"
              >
                ◀◀
              </button>
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                aria-label={playing ? "Pause the replay" : "Play the replay"}
                className="rounded-md border border-line bg-surface-2 px-3 py-1 font-mono text-xs font-bold text-ink transition hover:border-ink-faint/40"
              >
                {playing ? "❚❚ Pause" : "▶ Play"}
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                aria-label="Next event"
                className="rounded-md border border-line px-2.5 py-1 font-mono text-xs text-ink-dim transition hover:text-ink"
              >
                ▶▶
              </button>
              <span className="ml-1 font-mono text-xs tabular-nums text-ink-dim">
                {trackTime(t)} <span className="text-ink-faint">/ {trackTime(durationMs)}</span>
              </span>
              <span className="ml-auto flex items-center gap-2">
                {recording.failureIndex != null && (
                  <button
                    type="button"
                    onClick={jumpToFailure}
                    className="rounded-md border border-fail/40 bg-fail/10 px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-fail transition hover:bg-fail/20"
                  >
                    Jump to failure
                  </button>
                )}
                <SegmentedControl
                  segments={SPEEDS.map((s) => ({ value: s.value, label: s.label }))}
                  value={speed}
                  onChange={(v) => setSpeed(v)}
                  label="Playback speed"
                />
              </span>
            </div>

            {recording.truncated && (
              <p className="mt-3 font-mono text-[11px] text-ink-faint">
                This run was longer than the recorder keeps: the earliest events were dropped, so
                the track starts partway in. Timestamps are still absolute.
              </p>
            )}
            {recording.costEstimated && (
              <p className="mt-1 font-mono text-[11px] text-ink-faint">
                Per-event cost is the run's reported total apportioned by token share — the CLI
                reports one figure for the whole run.
              </p>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
            <section aria-label="Events">
              <ol className="divide-y divide-line overflow-hidden rounded-tile border border-line bg-surface">
                {slice.map((e, i) => {
                  const absolute = start + i;
                  const isCurrent = absolute === index;
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => seek(e.atMs)}
                        aria-current={isCurrent ? "true" : undefined}
                        className={`flex w-full items-start gap-2 px-3 py-1.5 text-left transition ${
                          isCurrent ? "bg-surface-2" : "hover:bg-surface-2/60"
                        } ${reduced ? "" : "duration-(--duration-quick)"}`}
                      >
                        <span className="w-12 shrink-0 font-mono text-[11px] tabular-nums text-ink-faint">
                          {trackTime(e.atMs)}
                        </span>
                        <EventGlyph event={e} />
                        <span
                          className={`min-w-0 flex-1 truncate text-sm ${
                            e.errored || e.kind === "error"
                              ? "text-fail"
                              : isCurrent
                                ? "text-ink"
                                : "text-ink-dim"
                          }`}
                        >
                          {e.label}
                        </span>
                        {e.durationMs != null && (
                          <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                            {formatMs(e.durationMs)}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ol>
              {events.length > slice.length && (
                <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                  Showing {start + 1}–{start + slice.length} of {events.length} events — the list
                  follows the playhead.
                </p>
              )}
            </section>

            <aside aria-label="Current event">
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
