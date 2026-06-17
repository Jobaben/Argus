import { useCallback, useEffect, useRef, useState } from "react";

export interface Activity {
  ts: string;
  text: string;
  project: string;
  cwd: string;
}

interface ActivityState {
  activity: Activity[];
  loading: boolean;
  error: string | null;
}

/**
 * Loads the prompt-history activity feed and keeps it fresh: re-fetches on the
 * server's file-watcher WebSocket signal, with a polling fallback.
 */
export function useActivity(): ActivityState & { refresh: () => void } {
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/activity");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { activity: Activity[] };
      if (!mounted.current) return;
      setActivity(data.activity);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    let ws: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { type?: string };
          if (msg.type === "agents:changed") void refresh();
        } catch {
          /* ignore */
        }
      };
      const drop = () => {
        if (!mounted.current) return;
        retry = setTimeout(connect, 2000);
      };
      ws.onclose = drop;
      ws.onerror = () => ws?.close();
    };
    connect();

    poll = setInterval(() => void refresh(), 10000);

    return () => {
      mounted.current = false;
      ws?.close();
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
    };
  }, [refresh]);

  return { activity, loading, error, refresh };
}
