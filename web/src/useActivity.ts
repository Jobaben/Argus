import { useLiveResource } from "./live/useLiveResource";

export interface Activity {
  ts: string;
  text: string;
  project: string;
  cwd: string;
}

/** Loads the prompt-history activity feed, refreshing on "agents:changed". */
export function useActivity() {
  const { data, loading, error, refresh } = useLiveResource<Activity[]>("/api/activity", {
    events: ["agents:changed"],
    select: (j) => (j as { activity?: Activity[] }).activity ?? [],
    initial: [],
  });
  return { activity: data, loading, error, refresh };
}
