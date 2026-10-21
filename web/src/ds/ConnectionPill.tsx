import { useEffect, useState } from "react";
import { liveStatus, reconnectNow, subscribeLive, type LiveStatus } from "../live/liveSocket";
import { useTicker } from "./clock";
import { DURATION, useSyncedDelay } from "./motion";

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
  // Before the first attempt has had its answer there is nothing to report:
  // every page load used to open on a red "Offline" and a Retry, for the
  // fraction of a second the socket takes to connect.
  const connecting = !connected && status.attempt === 0 && status.retryAt === null;
  const remaining = useCountdown(connected ? null : status.retryAt);
  const beat = useSyncedDelay(DURATION.ping);

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        role="status"
        aria-label={
          connected
            ? "Live: connected to the Argus server"
            : connecting
              ? "Connecting to the Argus server"
              : remaining === null
                ? "Offline: connecting to the Argus server"
                : `Offline: retrying in ${remaining} ${remaining === 1 ? "second" : "seconds"}`
        }
        // The label is the first thing to go on a narrow bar: the dot's colour
        // already carries the state, and the words live in the accessible name.
        // Quiet when all is well — a dot and a word, the way a status light on a
        // well-run machine is small — and only a filled red pill when it is not.
        className={`inline-flex h-8 items-center gap-2 rounded-full border px-2 text-caption font-semibold transition-colors duration-(--duration-base) sm:px-3 ${
          connected
            ? "border-transparent text-ok"
            : connecting
              ? "border-transparent text-ink-faint"
              : "border-fail/40 bg-fail/10 text-fail"
        }`}
      >
        <span className="relative h-2 w-2 rounded-full bg-current">
          {connected && (
            <span
              style={{ animationDelay: beat }}
              className="absolute -inset-1 animate-[ping-ring_var(--duration-ping)_ease-out_infinite] rounded-full bg-current opacity-50"
            />
          )}
        </span>
        {connected ? (
          <span className="hidden sm:inline">Live</span>
        ) : connecting ? (
          <span className="hidden sm:inline">Connecting</span>
        ) : (
          <>
            <span className="hidden sm:inline">Offline</span>
            {remaining !== null && remaining > 0 && (
              <span className="hidden font-normal text-fail/75 md:inline">
                · retrying in {remaining}s
              </span>
            )}
          </>
        )}
      </span>
      {/* The one useful thing to do while offline, so on a phone its hit area
          reaches 44px tall without the bar growing to fit it. */}
      {!connected && !connecting && (
        <button
          type="button"
          onClick={reconnectNow}
          className="relative h-7 shrink-0 rounded-control border border-line-strong bg-surface-2 px-2.5 text-caption font-semibold text-ink transition duration-(--duration-quick) hover:bg-surface-3 motion-safe:active:scale-[0.97] max-md:before:absolute max-md:before:-inset-x-[3px] max-md:before:-inset-y-2"
        >
          Retry
        </button>
      )}
    </span>
  );
}
