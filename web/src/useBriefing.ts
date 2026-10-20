import { useCallback } from "react";
import { useLiveResource } from "./live/useLiveResource";
import type { Briefing } from "./types";

/** The while-you-were-away digest. Owned by App (not the view) so the nav
 *  badge and the Briefing tab share one fetch. Every event that can move the
 *  digest triggers a refetch; monitors decay with time, so keep polling too. */
export function useBriefing() {
  const { data, loading, error, refresh } = useLiveResource<Briefing | null>("/api/briefing", {
    events: ["schedules:changed", "pipelines:changed", "issues:changed", "briefing:changed"],
    select: (j) => j as Briefing,
    initial: null,
    pollAlways: true,
  });

  // Throws the server's own reason, so the Briefing (and the palette's "Mark
  // caught up") can say the window did not reset instead of failing silently.
  const ack = useCallback(async () => {
    const res = await fetch("/api/briefing/ack", { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    refresh();
  }, [refresh]);

  return { briefing: data, loading, error, ack };
}
