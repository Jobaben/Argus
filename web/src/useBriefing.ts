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

  const ack = useCallback(async () => {
    await fetch("/api/briefing/ack", { method: "POST" });
    refresh();
  }, [refresh]);

  return { briefing: data, loading, error, ack };
}
