import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { OverviewEntry } from "./types";

/** Which paused phase a gate action targets, when a fan-out has several. */
export interface GateActionOptions {
  phaseId?: string;
}

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

  // `phaseId` names which paused phase is meant; absent, the single paused one.
  const approve = useCallback(
    (instanceId: string, opts: GateActionOptions = {}) =>
      act(instanceId, "approve", opts.phaseId ? { phaseId: opts.phaseId } : undefined),
    [act],
  );
  const revise = useCallback(
    (instanceId: string, note?: string, opts: GateActionOptions = {}) =>
      act(
        instanceId,
        "revise",
        note || opts.phaseId
          ? { ...(note ? { note } : {}), ...(opts.phaseId ? { phaseId: opts.phaseId } : {}) }
          : undefined,
      ),
    [act],
  );
  const abort = useCallback((instanceId: string) => act(instanceId, "abort"), [act]);

  return { overview: data, loading, error, live, refresh, approve, revise, abort };
}
