import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";

export interface Totals {
  usd: number;
  tokens: number;
  since: string;
}

/** All-time token/cost total across every completed run. Refreshes when runs
 *  finish (they emit "pipelines:changed") and when the total is reset
 *  ("totals:changed"). */
export function useTotals() {
  const { data, loading, error, refresh } = useLiveResource<Totals | null>("/api/totals", {
    events: ["pipelines:changed", "totals:changed"],
    select: (j) => j as Totals,
    initial: null,
    pollMs: 60000,
  });

  const reset = useCallback(async () => {
    const res = await fetch("/api/totals/reset", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }, []);

  return { totals: data, loading, error, reset, refresh };
}
