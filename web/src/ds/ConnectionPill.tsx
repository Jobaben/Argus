import { useEffect, useState } from "react";
import { liveStatus, reconnectNow, subscribeLive, type LiveStatus } from "../live/liveSocket";
import { useTicker } from "./clock";

/**
 * The connection indicator.
 *
 * "Reconnecting…" forever is the worst possible message when a server is
 * genuinely down: it is indistinguishable from a bug in the dashboard, and it
 * gives the user nothing to do. This shows the actual backoff — "Offline ·
 * retrying in 8s" — and lets them retry immediately, because the one thing they
 * know that the client does not is whether they just fixed the server.
 */
function useLiveStatus(): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(liveStatus);
  useEffect(() => subscribeLive({ onStatus: setStatus }), []);
  return status;
}

/** Seconds until `at`, re-rendered each second. Null when nothing is scheduled.
 *  Derived from the ticker rather than held in its own state, so there is one
 *  source of truth for "now" and no state write inside an effect. */
function useCountdown(at: number | null): number | null {
  const now = useTicker(at !== null);
  if (at === null) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function ConnectionPill({ live }: { live: boolean }) {
  const status = useLiveStatus();
  // The prop is the caller's view of liveness (a data hook's); the module's own
  // status is authoritative for the backoff. They agree in practice; prefer the
  // prop for the dot so the pill matches whatever the page is showing.
  const connected = live || status.live;
  const remaining = useCountdown(connected ? null : status.retryAt);

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        role="status"
        aria-label={
          connected
            ? "Live: connected to the Argus server"
            : remaining === null
              ? "Offline: connecting to the Argus server"
              : `Offline: retrying in ${remaining} seconds`
        }
        className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-xs font-semibold uppercase tracking-[0.08em] transition-colors duration-(--duration-base) ${
          connected ? "border-ok/40 bg-ok/10 text-ok" : "border-fail/40 bg-fail/10 text-fail"
        }`}
      >
        <span className="relative h-2 w-2 rounded-full bg-current">
          {connected && (
            <span className="absolute -inset-1 animate-[ping-ring_1.8s_ease-out_infinite] rounded-full bg-current opacity-50" />
          )}
        </span>
        {connected ? (
          "Live"
        ) : (
          <>
            <span>Offline</span>
            {remaining !== null && remaining > 0 && (
              <span className="font-normal normal-case tracking-normal text-fail/70">
                · retrying in {remaining}s
              </span>
            )}
          </>
        )}
      </span>
      {!connected && (
        <button
          type="button"
          onClick={reconnectNow}
          className="rounded-md border border-line px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-dim transition duration-(--duration-quick) hover:text-ink"
        >
          Retry
        </button>
      )}
    </span>
  );
}
