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
 */
export function HeartbeatBar({ beats, slots = 30 }: { beats: Heartbeat[]; slots?: number }) {
  const shown = beats.slice(-slots);
  const pad = Math.max(0, slots - shown.length);
  const newest = shown.length > 0 ? shown[shown.length - 1].runId : null;
  // False on the first render by construction, so a strip does not animate its
  // whole history in on page load — only an *arrival* is an arrival.
  const arrived = useChangeFlash(newest, DURATION.base);
  const flip = useFlip();
  const beat = useSyncedDelay(DURATION.pulse);
  return (
    <div
      role="img"
      aria-label={`Last ${shown.length} runs`}
      // Newest on the right, beside the uptime it adds to; any width the capped
      // slots leave over falls on the left, before the oldest run.
      className="flex h-6 w-full min-w-0 items-end justify-end gap-[3px]"
    >
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${i}`} className={`${SLOT} ${EMPTY}`} />
      ))}
      {shown.map((h) => {
        const tone = toneOf(h);
        // The arrival and the breathing are both `animation`, so a running tick
        // that has just landed grows in first and starts breathing after.
        const motion = arrived && h.runId === newest ? ARRIVE : tone === "run" ? PULSE : "";
        return (
          <span
            key={h.runId}
            ref={flip(h.runId)}
            title={`${new Date(h.at).toLocaleString()} — ${h.status}${
              h.outcome && h.outcome !== "succeeded" ? ` (${h.outcome})` : ""
            }`}
            style={motion === PULSE ? { animationDelay: beat } : undefined}
            className={`${SLOT} h-6 origin-bottom transition-transform duration-(--duration-quick) hover:scale-y-125 ${TICK[tone]} ${motion}`}
          />
        );
      })}
    </div>
  );
}
