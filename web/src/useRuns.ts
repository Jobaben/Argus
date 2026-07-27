import { useCallback, useMemo } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { Run } from "./types";

/** Lists runs (optionally for one schedule), refreshing on "schedules:changed",
 *  and exposes the cancel action a live run needs. */
export function useRuns(scheduleId?: string) {
  const path = useMemo(
    () => (scheduleId ? `/api/runs?scheduleId=${encodeURIComponent(scheduleId)}` : "/api/runs"),
    [scheduleId],
  );
  const { data, loading, error, refresh } = useLiveResource<Run[]>(path, {
    events: ["schedules:changed", "pipelines:changed"],
    select: (j) => (j as { runs?: Run[] }).runs ?? [],
    initial: [],
  });

  /** Cancels a live run, surfacing the server's own reason on failure. */
  const cancelRun = useCallback(async (runId: string) => {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
  }, []);

  return { runs: data, loading, error, refresh, cancelRun };
}
