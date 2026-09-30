import { useLiveResource } from "./live/useLiveResource";

import type { H1ReportResponse } from "@argus/contracts";

/**
 * The H1 shadow-experiment report (gate operator action). Strictly a GET: opening
 * the page never starts collection or calls a model, and nothing here has a
 * mutating counterpart.
 */
export function useDecisionH1() {
  const { data, loading, error, refresh } = useLiveResource<H1ReportResponse | null>(
    "/api/decisions/h1",
    {
      select: (j) => {
        const r = j as Partial<H1ReportResponse> | null;
        return r && typeof r === "object" && r.report && r.collection
          ? (r as H1ReportResponse)
          : null;
      },
      initial: null,
      pollMs: 60_000,
    },
  );
  return { data, loading, error, refresh };
}
