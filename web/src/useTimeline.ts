import { useMemo } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { TimelineEntry } from "./types";

/**
 * Loads the progress timeline for a single agent, refreshing on
 * "agents:changed". A null `short` means "no selection" — no fetch, empty list.
 */
export function useTimeline(short: string | null) {
  const path = useMemo(
    () => (short ? `/api/agents/${encodeURIComponent(short)}/timeline` : null),
    [short],
  );
  const { data, loading, error, refresh } = useLiveResource<TimelineEntry[]>(path, {
    events: ["agents:changed"],
    select: (j) => (j as { timeline?: TimelineEntry[] }).timeline ?? [],
    initial: [],
  });
  return { timeline: data, loading, error, refresh };
}
