import type { Heartbeat } from "../types";
import { useFlip } from "./flip";
import { DURATION, useChangeFlash } from "./motion";

const TICK: Record<"ok" | "fail" | "run" | "idle", string> = {
  ok: "bg-ok",
  fail: "bg-fail",
  run: "bg-run animate-pulse",
  idle: "bg-idle/50",
};

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
 */
export function HeartbeatBar({ beats, slots = 30 }: { beats: Heartbeat[]; slots?: number }) {
  const shown = beats.slice(-slots);
  const pad = Math.max(0, slots - shown.length);
  const newest = shown.length > 0 ? shown[shown.length - 1].runId : null;
  // False on the first render by construction, so a strip does not animate its
  // whole history in on page load — only an *arrival* is an arrival.
  const arrived = useChangeFlash(newest, DURATION.base);
  const flip = useFlip();
  return (
    <div role="img" aria-label={`Last ${shown.length} runs`} className="flex items-end gap-[3px]">
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${i}`} className="h-4 w-1.5 rounded-full bg-line/60" />
      ))}
      {shown.map((h) => (
        <span
          key={h.runId}
          ref={flip(h.runId)}
          title={`${new Date(h.at).toLocaleString()} — ${h.status}${
            h.outcome && h.outcome !== "succeeded" ? ` (${h.outcome})` : ""
          }`}
          className={`h-4 w-1.5 origin-bottom rounded-full transition-transform hover:scale-y-125 ${
            TICK[toneOf(h)]
          } ${
            arrived && h.runId === newest
              ? "motion-safe:animate-[tick-in_var(--duration-base)_var(--ease-spring)]"
              : ""
          }`}
        />
      ))}
    </div>
  );
}
