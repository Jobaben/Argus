import { useLiveResource } from "./live/useLiveResource";

import type { DailyStat, ModelStat, PeakHour, StatsResult } from "@argus/contracts";

export type { DailyStat, ModelStat, PeakHour };
/** The stats payload; named `Stats` in the UI, `StatsResult` on the wire. */
export type Stats = StatsResult;

/** Loads usage stats, refreshing on "inventory:changed" (the server watches
 *  stats-cache.json), with a slow poll fallback while the socket is down. */
export function useStats() {
  const { data, loading, error, refresh } = useLiveResource<Stats | null>("/api/stats", {
    events: ["inventory:changed"],
    select: (j) => j as Stats,
    initial: null,
    pollMs: 60000,
  });
  return { stats: data, loading, error, refresh };
}
