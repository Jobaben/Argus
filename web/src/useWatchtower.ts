import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { WatchtowerReport } from "./types";

const EMPTY: WatchtowerReport = {
  generatedAt: "",
  baselines: [],
  anomalies: [],
  summary: { ready: 0, warming: 0, anomalies: 0, critical: 0 },
  warmupRuns: 0,
};

/**
 * Learned envelopes and the runs that left them.
 *
 * Refreshes on run activity (`schedules:changed`) because a new run is exactly
 * what moves a baseline, and on `watchtower:changed` so a reset from any tab
 * lands here immediately.
 */
export function useWatchtower() {
  const { data, loading, error, refresh } = useLiveResource<WatchtowerReport>("/api/watchtower", {
    events: ["schedules:changed", "watchtower:changed"],
    select: (j) => (j && typeof j === "object" ? { ...EMPTY, ...(j as WatchtowerReport) } : EMPTY),
    initial: EMPTY,
  });

  const mutate = useCallback(
    async (key: string, method: "POST" | "DELETE") => {
      const res = await fetch(`/api/watchtower/${encodeURIComponent(key)}/reset`, { method });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    },
    [refresh],
  );

  const reset = useCallback((key: string) => mutate(key, "POST"), [mutate]);
  const restore = useCallback((key: string) => mutate(key, "DELETE"), [mutate]);

  return { report: data, loading, error, refresh, reset, restore };
}
