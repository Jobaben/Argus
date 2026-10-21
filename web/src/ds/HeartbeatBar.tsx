import { useLayoutEffect, useRef, useState } from "react";
import type { Heartbeat } from "../types";
import { useFlip } from "./flip";
import { DURATION, useChangeFlash, useSyncedDelay } from "./motion";

/** Success is the expected case, so it is drawn a step quieter than failure: a
 *  strip of thirty healthy runs should read as calm, and the one red tick in it
 *  as the thing to look at. */
const TICK: Record<"ok" | "fail" | "run" | "idle", string> = {
  ok: "bg-ok/60",
  fail: "bg-fail",
  run: "bg-run",
  idle: "bg-idle/50",
};

/** A run still in progress breathes on the shared ambient pulse — the same
 *  cycle, and the same phase, as every other live indicator on screen. */
const PULSE = "motion-safe:animate-[pulse_var(--duration-pulse)_ease-in-out_infinite]";
const ARRIVE = "motion-safe:animate-[tick-in_var(--duration-base)_var(--ease-spring)]";

/** One slot: it shares the strip's width up to a cap, so thirty runs read as a
 *  strip on a wide card and still fit, narrower, on a phone. */
const SLOT = "min-w-0.5 max-w-3 flex-1 rounded-full";

/** A slot no run has filled yet is a stub on the baseline, not a bar: drawn as
 *  a grey tick it read as a skipped run, and a monitor with one run looked like
 *  one with thirty. */
const EMPTY = "h-1 bg-line";

/** The narrowest a beat is drawn. Thirty slots in a phone's card were 4px
 *  each — a hairline no finger can hit, on a screen where the tooltip never
 *  shows — so a strip that cannot give every slot this much shows fewer of
 *  them: the newest, each wide enough to tap. */
const MIN_BEAT_PX = 10;
/** The strip's `gap-[3px]`. */
const GAP_PX = 3;

/** How many of `max` slots fit the strip at `MIN_BEAT_PX`, kept up to date as
 *  it resizes. Measured before paint, so a phone never draws thirty first. */
function useSlotsThatFit(max: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(max);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Zero is a strip not laid out (or a test's DOM): keep every slot.
      const width = el.clientWidth;
      if (width > 0) setFit(Math.max(1, Math.floor((width + GAP_PX) / (MIN_BEAT_PX + GAP_PX))));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, Math.min(fit, max)] as const;
}

function toneOf(h: Heartbeat): keyof typeof TICK {
  if (h.outcome === "failed" || h.outcome === "blocked") return "fail";
  switch (h.status) {
    case "succeeded":
      return "ok";
    case "failed":
      return "fail";
    case "running":
      return "run";
    default:
      return "idle"; // skipped / interrupted / cancelled
  }
}

/** What a beat is, said: its run's status (and a work-level outcome that
 *  differs from it), then when. The link's name and its tooltip both. */
function describe(h: Heartbeat): string {
  const status = h.status.charAt(0).toUpperCase() + h.status.slice(1);
  const outcome = h.outcome && h.outcome !== "succeeded" ? ` (${h.outcome})` : "";
  return `${status}${outcome}, ${new Date(h.at).toLocaleString()}`;
}

/** Keys that walk the strip, and where each one goes from index `i` of `n`. */
const STEP: Record<string, (i: number, n: number) => number> = {
  ArrowLeft: (i) => Math.max(0, i - 1),
  ArrowRight: (i, n) => Math.min(n - 1, i + 1),
  Home: () => 0,
  End: (_, n) => n - 1,
};

/**
 * Uptime-Kuma-style heartbeat strip: one tick per run, oldest → newest.
 *
 * A run landing is the single most legible event this product has, and it used to
 * just *appear*: the strip's contents shifted by one slot between frames with
 * nothing to say a beat had happened. Now the whole strip slides left by a slot
 * (FLIP — every tick glides to where the next one pushed it) and the newborn tick
 * grows from the baseline it is measured against. That is a signature you can
 * read from across the room, which is the point of a strip you leave on a second
 * monitor.
 *
 * A running tick used to blink on Tailwind's stock `animate-pulse` — its own 2s
 * rhythm, started whenever the card mounted — so a board of monitors flickered
 * out of step with every other live thing on the page. It now uses the tokenized
 * pulse with a synced delay, like the status pills and the Chronicle's live bars.
 *
 * Each tick is a link to its run, because the red one is the one you want to
 * open. Thirty links per card would be thirty tab stops per monitor, so the
 * strip is one: Tab lands on the newest run (or the one last walked to), the
 * arrow keys and Home and End walk its history, and Enter opens the one in
 * focus. A slot no run has filled yet is not a link.
 */
export function HeartbeatBar({ beats, slots = 30 }: { beats: Heartbeat[]; slots?: number }) {
  const [stripRef, fit] = useSlotsThatFit(slots);
  const shown = beats.slice(-fit);
  const pad = Math.max(0, fit - shown.length);
  const newest = shown.length > 0 ? shown[shown.length - 1].runId : null;
  // False on the first render by construction, so a strip does not animate its
  // whole history in on page load — only an *arrival* is an arrival.
  const arrived = useChangeFlash(newest, DURATION.base);
  const flip = useFlip();
  const beat = useSyncedDelay(DURATION.pulse);
  // The strip's one tab stop: the beat last walked to, while it is still on
  // the strip, or else the newest run. It has to follow focus — left on the
  // newest, Tab from an older beat would land on the newest instead of leaving.
  const [walked, setWalked] = useState<string | null>(null);
  const stop = shown.some((h) => h.runId === walked)
    ? walked
    : (shown.findLast((h) => h.runId)?.runId ?? null);
  return (
    <div
      ref={stripRef}
      role="group"
      aria-label={`Last ${shown.length} runs`}
      onKeyDown={(e) => {
        const step = STEP[e.key];
        if (!step) return;
        const links = [...e.currentTarget.querySelectorAll("a")];
        const at = links.indexOf(document.activeElement as HTMLAnchorElement);
        if (at < 0) return;
        e.preventDefault();
        links[step(at, links.length)].focus();
      }}
      // Newest on the right, beside the uptime it adds to; any width the capped
      // slots leave over falls on the left, before the oldest run.
      className="flex h-6 w-full min-w-0 items-end justify-end gap-[3px]"
    >
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${i}`} aria-hidden="true" className={`${SLOT} ${EMPTY}`} />
      ))}
      {shown.map((h, i) => {
        const tone = toneOf(h);
        // The arrival and the breathing are both `animation`, so a running tick
        // that has just landed grows in first and starts breathing after.
        const motion = arrived && h.runId === newest ? ARRIVE : tone === "run" ? PULSE : "";
        const className = `${SLOT} h-6 origin-bottom transition-transform duration-(--duration-quick) hover:scale-y-125 ${TICK[tone]} ${motion}`;
        const style = motion === PULSE ? { animationDelay: beat } : undefined;
        if (!h.runId) return <span key={`beat-${i}`} className={className} style={style} />;
        const name = describe(h);
        return (
          <a
            key={h.runId}
            ref={flip(h.runId)}
            href={`#/run/${encodeURIComponent(h.runId)}`}
            aria-label={name}
            title={name}
            tabIndex={h.runId === stop ? 0 : -1}
            onFocus={() => setWalked(h.runId)}
            style={style}
            // The hit area spans the gaps and a little above and below, so
            // the strip has no dead pixels between beats.
            className={`${className} relative before:absolute before:-inset-x-[1.5px] before:-inset-y-1 focus-visible:scale-y-125`}
          />
        );
      })}
    </div>
  );
}
