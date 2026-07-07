import { useMemo } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { Run } from "./types";

/** Lists runs (optionally for one schedule), refreshing on "schedules:changed". */
export function useRuns(scheduleId?: string) {
  const path = useMemo(
    () => (scheduleId ? `/api/runs?scheduleId=${encodeURIComponent(scheduleId)}` : "/api/runs"),
    [scheduleId],
  );
  const { data, loading, error, refresh } = useLiveResource<Run[]>(path, {
    events: ["schedules:changed"],
    select: (j) => (j as { runs?: Run[] }).runs ?? [],
    initial: [],
  });
  return { runs: data, loading, error, refresh };
}
