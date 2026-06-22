import { useCallback, useEffect, useRef, useState } from "react";
import type { Run } from "./types";

/** Lists runs (optionally for one schedule), refreshing on the WS ping. */
export function useRuns(scheduleId?: string) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const qs = scheduleId ? `?scheduleId=${encodeURIComponent(scheduleId)}` : "";
      const res = await fetch(`/api/runs${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { runs: Run[] };
      if (!mounted.current) return;
      setRuns(data.runs);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [scheduleId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = setInterval(() => void refresh(), 10000);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "schedules:changed") void refresh();
      } catch {
        /* ignore */
      }
    };
    return () => {
      mounted.current = false;
      clearInterval(poll);
      ws.close();
    };
  }, [refresh]);

  return { runs, loading, error, refresh };
}
