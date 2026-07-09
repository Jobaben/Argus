import { useMemo } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { Chronicle } from "./types";

const EMPTY: Chronicle = {
  windowStart: "",
  windowEnd: "",
  groups: [],
  totals: { spans: 0, active: 0, failed: 0, costUsd: null, tokens: null },
};

/**
 * The cross-source timeline. Sessions have no push event, so keep the fallback
 * poll active alongside the agent/schedule change events.
 */
export function useChronicle(hours: number) {
  const path = useMemo(() => `/api/chronicle?hours=${hours}`, [hours]);
  const { data, loading, error, refresh } = useLiveResource<Chronicle>(path, {
    events: ["agents:changed", "schedules:changed"],
    select: (j) => (j as Chronicle) ?? EMPTY,
    initial: EMPTY,
    pollMs: 15_000,
    pollAlways: true,
  });
  return { chronicle: data, loading, error, refresh };
}
