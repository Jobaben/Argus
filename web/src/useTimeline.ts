import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineEntry } from "./types";

interface TimelineState {
  timeline: TimelineEntry[];
  loading: boolean;
  error: string | null;
}

/**
 * Loads the progress timeline for a single agent and keeps it fresh: re-fetches
 * whenever the server's file-watcher reports a change over the WebSocket, with a
 * polling fallback. Returns an empty timeline when no `short` is supplied.
 */
export function useTimeline(short: string | null): TimelineState & {
  refresh: () => void;
} {
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(short != null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (!short) {
      setTimeline([]);
      setLoading(false);
      setError(null);
      return;
    }
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(short)}/timeline`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { timeline: TimelineEntry[] };
      if (!mounted.current) return;
      setTimeline(data.timeline);
      setError(null);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [short]);

  useEffect(() => {
    mounted.current = true;
    setLoading(short != null);
    void refresh();

    if (!short) return () => void (mounted.current = false);

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
  }, [refresh, short]);

  return { timeline, loading, error, refresh };
}
