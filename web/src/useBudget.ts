import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { BudgetConfig, BudgetResponse } from "./types";

/** Budget config + derived status + 30-day ledger. Spend moves when runs
 * complete (broadcast as "schedules:changed"/"pipelines:changed"); the config
 * itself broadcasts "budget:changed". */
export function useBudget() {
  const { data, loading, error, refresh } = useLiveResource<BudgetResponse | null>("/api/budget", {
    events: ["budget:changed", "schedules:changed", "pipelines:changed"],
    select: (j) => j as BudgetResponse,
    initial: null,
  });

  const save = useCallback(
    async (patch: Partial<BudgetConfig>) => {
      const res = await fetch("/api/budget", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    },
    [refresh],
  );

  return { budget: data, loading, error, save };
}
