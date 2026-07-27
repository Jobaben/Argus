import { useLiveResource } from "./live/useLiveResource";
import type { Recording } from "./types";

const EMPTY: Recording | null = null;

/**
 * One run's Flight Recorder timeline.
 *
 * Refreshes on `schedules:changed` so a recording opened while the run is still
 * in flight keeps growing; the ETag layer means a ping that didn't touch this
 * run costs a 304 and no re-render, which matters because the scrubber holds
 * local playback state a re-render would fight.
 */
export function useRecording(runId: string | null) {
  const { data, loading, error, refresh } = useLiveResource<Recording | null>(
    runId ? `/api/runs/${encodeURIComponent(runId)}/recording` : null,
    {
      events: ["schedules:changed"],
      select: (j) => (j && typeof j === "object" ? (j as Recording) : null),
      initial: EMPTY,
    },
  );
  return { recording: data, loading, error, refresh };
}
