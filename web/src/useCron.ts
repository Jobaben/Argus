import { useLiveResource } from "./live/useLiveResource";

import type { CronDiskHint, CronStatus } from "@argus/contracts";

export type { CronDiskHint, CronStatus };

/**
 * Loads the cron availability status. Cron routines never touch disk and have
 * no live signal, so this is a one-shot fetch (no polling) with manual refresh.
 */
export function useCron() {
  const { data, loading, error, refresh } = useLiveResource<CronStatus | null>("/api/cron", {
    select: (j) => j as CronStatus,
    initial: null,
    pollMs: 0,
  });
  return { cron: data, loading, error, refresh };
}
