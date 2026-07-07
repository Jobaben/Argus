import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { OverviewEntry } from "./types";

/** Lists the pipeline overview, refreshing on "pipelines:changed", and exposes
 *  the instance gate actions. Actions only POST — the resulting server
 *  broadcast drives the single refresh (no optimistic refetch here). */
export function useOverview() {
  const { data, loading, error, live, refresh } = useLiveResource<OverviewEntry[]>(
    "/api/overview",
    {
      events: ["pipelines:changed"],
      select: (j) =>
        Array.isArray((j as { overview?: OverviewEntry[] }).overview)
          ? (j as { overview: OverviewEntry[] }).overview
          : [],
      initial: [],
    },
  );

  const act = useCallback(
    async (instanceId: string, action: "approve" | "revise" | "abort", body?: unknown) => {
      const res = await fetch(`/api/instances/${instanceId}/${action}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error ?? `HTTP ${res.status}`);
      }
      return res;
    },
    [],
  );

  const approve = useCallback((instanceId: string) => act(instanceId, "approve"), [act]);
  const revise = useCallback(
    (instanceId: string, note?: string) => act(instanceId, "revise", note ? { note } : undefined),
    [act],
  );
  const abort = useCallback((instanceId: string) => act(instanceId, "abort"), [act]);

  return { overview: data, loading, error, live, refresh, approve, revise, abort };
}
