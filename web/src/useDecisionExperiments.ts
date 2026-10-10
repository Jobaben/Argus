import { useLiveResource } from "./live/useLiveResource";

import type { H2ReportResponse } from "@argus/contracts";

/**
 * The H2 shadow-experiment report. Strictly a GET: opening the page never starts
 * collection or calls a model, and nothing here has a mutating counterpart.
 */
export function useDecisionExperiments() {
  const { data, loading, error, refresh } = useLiveResource<H2ReportResponse | null>(
    "/api/decisions/h2",
    {
      select: (j) => {
        const r = j as Partial<H2ReportResponse> | null;
        return r && typeof r === "object" && r.report && r.collection
          ? (r as H2ReportResponse)
          : null;
      },
      initial: null,
      pollMs: 60_000,
    },
  );
  return { data, loading, error, refresh };
}
