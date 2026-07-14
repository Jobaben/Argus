import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { LaunchInput, Run } from "./types";

/** The Launch tab's state: recent one-off runs (refreshing on
 * "schedules:changed", which run completions broadcast) plus fire/cancel. */
export function useLaunch() {
  const { data, loading, error, refresh } = useLiveResource<Run[]>(
    "/api/runs?scheduleId=oneoff&limit=20",
    {
      events: ["schedules:changed"],
      select: (j) => (j as { runs?: Run[] }).runs ?? [],
      initial: [],
    },
  );

  const mutate = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(path, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error ?? `HTTP ${res.status}`);
      }
      await refresh();
      return res;
    },
    [refresh],
  );

  const launch = useCallback((input: LaunchInput) => mutate("/api/launch", input), [mutate]);
  const cancelRun = useCallback((runId: string) => mutate(`/api/runs/${runId}/cancel`), [mutate]);

  return { runs: data, loading, error, launch, cancelRun };
}
