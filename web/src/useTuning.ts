import { useCallback, useState } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { TuningResponse } from "./types";

const EMPTY: TuningResponse = { report: null, unavailable: null };

/**
 * One pipeline's newest tuning report, plus the action that produces one.
 *
 * Reading is open; producing a report spawns one agent pass per phase, so the
 * POST is admin-gated server-side and a 401 surfaces as `actionError` rather
 * than hiding the button. Applying a proposal is not here: it goes through
 * `usePipelines().update`, the same path as a hand edit.
 */
export function useTuning(pipelineId: string | null) {
  const path = pipelineId ? `/api/pipelines/${encodeURIComponent(pipelineId)}/tune` : null;
  const { data, loading, error, refresh } = useLiveResource<TuningResponse>(path, {
    events: ["tuning:changed"],
    select: (j) => (j && typeof j === "object" ? { ...EMPTY, ...(j as TuningResponse) } : EMPTY),
    initial: EMPTY,
  });

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const analyse = useCallback(async () => {
    if (!path) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(path, { method: "POST" });
      if (!res.ok) {
        const parsed = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(parsed.error ?? `HTTP ${res.status}`);
      }
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [path, refresh]);

  return {
    report: data.report,
    unavailable: data.unavailable,
    loading,
    error,
    busy,
    actionError,
    analyse,
    refresh,
  };
}
