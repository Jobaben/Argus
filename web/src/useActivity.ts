import { useLiveResource } from "./live/useLiveResource";

import type { Activity } from "@argus/contracts";

export type { Activity };

/** Loads the prompt-history activity feed, refreshing on "agents:changed". */
export function useActivity() {
  const { data, loading, error, refresh } = useLiveResource<Activity[]>("/api/activity", {
    events: ["agents:changed"],
    select: (j) => (j as { activity?: Activity[] }).activity ?? [],
    initial: [],
  });
  return { activity: data, loading, error, refresh };
}
