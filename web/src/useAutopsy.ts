import { useCallback, useState } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { AutopsyResponse } from "./types";

const EMPTY: AutopsyResponse = { autopsy: null, eligible: false, unavailable: null };

/**
 * One run's postmortem, plus the two actions that follow from it.
 *
 * Reading is open; producing a postmortem spawns an agent and relaunching
 * spawns a real run, so both of those are admin-gated server-side and the
 * caller surfaces the 401 rather than hiding the buttons — telling someone
 * *why* an action is unavailable beats pretending it doesn't exist.
 */
export function useAutopsy(runId: string | null) {
  const { data, loading, error, refresh } = useLiveResource<AutopsyResponse>(
    runId ? `/api/runs/${encodeURIComponent(runId)}/autopsy` : null,
    {
      events: ["issues:changed"],
      select: (j) => (j && typeof j === "object" ? { ...EMPTY, ...(j as AutopsyResponse) } : EMPTY),
      initial: EMPTY,
    },
  );

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const post = useCallback(async (path: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(path, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const parsed = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(parsed.error ?? `HTTP ${res.status}`);
    }
    return res.json().catch(() => ({}));
  }, []);

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      return await fn();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const analyse = useCallback(async () => {
    if (!runId) return;
    await guard(async () => {
      await post(`/api/runs/${encodeURIComponent(runId)}/autopsy`);
      await refresh();
    });
  }, [runId, guard, post, refresh]);

  /** Fire the proposed prompt as a one-off. Returns the new run id, or null. */
  const relaunch = useCallback(async (): Promise<string | null> => {
    if (!runId) return null;
    const created = (await guard(() =>
      post(`/api/runs/${encodeURIComponent(runId)}/relaunch`),
    )) as { id?: string } | null;
    return created?.id ?? null;
  }, [runId, guard, post]);

  return {
    autopsy: data.autopsy,
    eligible: data.eligible,
    unavailable: data.unavailable,
    loading,
    error,
    busy,
    actionError,
    analyse,
    relaunch,
    refresh,
  };
}
