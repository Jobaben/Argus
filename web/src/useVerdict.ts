import { useCallback, useState } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { Rubric, Verdict, VerdictReport } from "./types";

interface VerdictResponse {
  verdict: Verdict | null;
  rubric: Rubric | null;
  unavailable: string | null;
}

const EMPTY_ONE: VerdictResponse = { verdict: null, rubric: null, unavailable: null };

const EMPTY_REPORT: VerdictReport = {
  generatedAt: "",
  trends: [],
  summary: { scored: 0, regressions: 0, average: null },
};

/** One run's score against its rubric, plus the action to (re)score it. */
export function useVerdict(runId: string | null) {
  const { data, loading, error, refresh } = useLiveResource<VerdictResponse>(
    runId ? `/api/runs/${encodeURIComponent(runId)}/verdict` : null,
    {
      events: ["issues:changed"],
      select: (j) =>
        j && typeof j === "object" ? { ...EMPTY_ONE, ...(j as VerdictResponse) } : EMPTY_ONE,
      initial: EMPTY_ONE,
    },
  );

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const score = useCallback(async () => {
    if (!runId) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/verdict`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [runId, refresh]);

  return { ...data, loading, error, busy, actionError, score, refresh };
}

/** Score trends across every rubric-bearing schedule and phase. */
export function useVerdictTrends() {
  const { data, loading, error, refresh } = useLiveResource<VerdictReport>("/api/verdicts", {
    events: ["issues:changed", "schedules:changed"],
    select: (j) =>
      j && typeof j === "object" ? { ...EMPTY_REPORT, ...(j as VerdictReport) } : EMPTY_REPORT,
    initial: EMPTY_REPORT,
  });
  return { report: data, loading, error, refresh };
}
