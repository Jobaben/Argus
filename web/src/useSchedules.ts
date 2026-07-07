import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { ScheduleInput, ScheduleWithNext } from "./types";

/** Lists schedules, refreshing on "schedules:changed", plus CRUD + run/cancel. */
export function useSchedules() {
  const { data, loading, error, refresh } = useLiveResource<ScheduleWithNext[]>("/api/schedules", {
    events: ["schedules:changed"],
    select: (j) => (j as { schedules?: ScheduleWithNext[] }).schedules ?? [],
    initial: [],
  });

  const mutate = useCallback(
    async (path: string, method: string, body?: unknown) => {
      const res = await fetch(path, {
        method,
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

  const create = useCallback(
    (input: ScheduleInput) => mutate("/api/schedules", "POST", input),
    [mutate],
  );
  const update = useCallback(
    (id: string, patch: Partial<ScheduleInput>) => mutate(`/api/schedules/${id}`, "PUT", patch),
    [mutate],
  );
  const remove = useCallback((id: string) => mutate(`/api/schedules/${id}`, "DELETE"), [mutate]);
  const runNow = useCallback((id: string) => mutate(`/api/schedules/${id}/run`, "POST"), [mutate]);
  const cancelRun = useCallback(
    (runId: string) => mutate(`/api/runs/${runId}/cancel`, "POST"),
    [mutate],
  );

  return { schedules: data, loading, error, refresh, create, update, remove, runNow, cancelRun };
}
