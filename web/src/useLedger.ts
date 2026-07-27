import { useCallback, useState } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { LedgerReport, WhatIfRequest, WhatIfResult } from "./types";

const EMPTY_ATTRIBUTION = {
  slices: [],
  totalUsd: 0,
  totalTokens: 0,
  runs: 0,
  unattributedRuns: 0,
};

const EMPTY: LedgerReport = {
  generatedAt: "",
  windowDays: 30,
  byProject: { dimension: "project", ...EMPTY_ATTRIBUTION },
  bySchedule: { dimension: "schedule", ...EMPTY_ATTRIBUTION },
  byPipeline: { dimension: "pipeline", ...EMPTY_ATTRIBUTION },
  byModel: { dimension: "model", ...EMPTY_ATTRIBUTION },
  forecast: {
    samples: 0,
    dailyUsd: null,
    monthToDateUsd: 0,
    monthEndUsd: null,
    lowUsd: null,
    highUsd: null,
    confidence: null,
    overLimit: false,
    note: "",
  },
  enforcement: { action: null, atRatio: null, model: null, window: null, detail: "" },
};

/** Cost attribution, the month-end forecast, and the what-if simulator. */
export function useLedger() {
  const { data, loading, error, refresh } = useLiveResource<LedgerReport>("/api/ledger", {
    events: ["schedules:changed", "budget:changed", "totals:changed"],
    select: (j) => (j && typeof j === "object" ? { ...EMPTY, ...(j as LedgerReport) } : EMPTY),
    initial: EMPTY,
  });

  const [simulation, setSimulation] = useState<WhatIfResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  const simulate = useCallback(async (request: WhatIfRequest) => {
    setSimulating(true);
    setSimError(null);
    try {
      const res = await fetch("/api/ledger/what-if", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = (await res.json()) as WhatIfResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSimulation(body);
    } catch (e) {
      setSimError(e instanceof Error ? e.message : String(e));
      setSimulation(null);
    } finally {
      setSimulating(false);
    }
  }, []);

  return { report: data, loading, error, refresh, simulation, simulating, simError, simulate };
}
