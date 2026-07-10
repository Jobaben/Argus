import type { Heartbeat } from "../types";

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

/** Uptime-Kuma-style heartbeat strip: one tick per run, oldest → newest. */
export function HeartbeatBar({ beats, slots = 30 }: { beats: Heartbeat[]; slots?: number }) {
  const shown = beats.slice(-slots);
  const pad = Math.max(0, slots - shown.length);
  return (
    <div role="img" aria-label={`Last ${shown.length} runs`} className="flex items-end gap-[3px]">
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${i}`} className="h-4 w-1.5 rounded-full bg-line/60" />
      ))}
      {shown.map((h) => (
        <span
          key={h.runId}
          title={`${new Date(h.at).toLocaleString()} — ${h.status}${
            h.outcome && h.outcome !== "succeeded" ? ` (${h.outcome})` : ""
          }`}
          className={`h-4 w-1.5 rounded-full transition-transform hover:scale-y-125 ${TICK[toneOf(h)]}`}
        />
      ))}
    </div>
  );
}
