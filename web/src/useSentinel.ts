import { useCallback, useState } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { SentinelPolicy, SentinelState } from "./types";

const EMPTY: SentinelState = {
  generatedAt: "",
  policy: {
    enabled: true,
    levels: [],
    quietHours: null,
    quietHoursOverrideCritical: true,
    autoDiagnose: false,
  },
  incidents: [],
  summary: { open: 0, acknowledged: 0, resolved: 0, critical: 0 },
  inQuietHours: false,
};

/**
 * Incidents, the escalation policy, and the operator actions on both.
 *
 * `pollAlways`: escalation is a clock, not an event. Nothing writes to disk
 * between "opened" and "escalated in 30 minutes", so a healthy socket alone
 * cannot keep the countdown honest — the fallback poll is the only thing that
 * will notice the deadline passing while the page is open.
 */
export function useSentinel() {
  const { data, loading, error, refresh } = useLiveResource<SentinelState>("/api/sentinel", {
    events: ["sentinel:changed", "schedules:changed"],
    select: (j) => (j && typeof j === "object" ? { ...EMPTY, ...(j as SentinelState) } : EMPTY),
    initial: EMPTY,
    pollAlways: true,
  });

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const act = useCallback(
    async (id: string, action: "ack" | "resolve" | "note" | "diagnose", body?: unknown) => {
      setBusyId(id);
      setActionError(null);
      try {
        const res = await fetch(`/api/incidents/${encodeURIComponent(id)}/${action}`, {
          method: "POST",
          ...(body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        });
        if (!res.ok) {
          const parsed = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(parsed.error ?? `HTTP ${res.status}`);
        }
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const savePolicy = useCallback(
    async (patch: Partial<SentinelPolicy>) => {
      setActionError(null);
      try {
        const res = await fetch("/api/sentinel/policy", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const parsed = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(parsed.error ?? `HTTP ${res.status}`);
        }
        await refresh();
      } catch (e) {
        setActionError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  return { state: data, loading, error, busyId, actionError, act, savePolicy, refresh };
}
