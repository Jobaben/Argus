import { useLiveResource } from "./live/useLiveResource";
import type { Situation } from "./types";

/**
 * The board's situation strip.
 *
 * Refreshes on everything that can move a number in it. It also polls slowly
 * even while the socket is healthy, because two of its fields decay with the
 * clock rather than with an event: "next fire" counts down, and the throughput
 * sparkline's window slides. A push-only resource would show a stale countdown
 * on an idle board — the one time you are most likely to be reading it.
 */
/**
 * Accepts a payload only if it carries the three fields the strip renders.
 *
 * A cast alone would let a partial or older response through and crash the strip
 * on `counts.gatesWaiting`. Validating at the boundary keeps the view free of
 * defensive `?.` chains: either there is a situation, or there is not.
 */
function toSituation(json: unknown): Situation | null {
  if (typeof json !== "object" || json === null) return null;
  const body = json as Partial<Situation>;
  if (!body.counts || !body.spend || !Array.isArray(body.throughput)) return null;
  return body as Situation;
}

export function useInsight() {
  const { data, loading, error, refresh } = useLiveResource<Situation | null>("/api/insight", {
    events: [
      "pipelines:changed",
      "schedules:changed",
      "issues:changed",
      "budget:changed",
      "agents:changed",
    ],
    select: toSituation,
    initial: null,
    pollMs: 30_000,
    pollAlways: true,
  });
  return { situation: data, loading, error, refresh };
}
