import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent } from "./types";

interface AgentsState {
  agents: Agent[];
  loading: boolean;
  error: string | null;
  live: boolean;
}

/**
 * Loads the agent list and keeps it fresh: re-fetches whenever the server's
 * file-watcher reports a change over the WebSocket, with a polling fallback.
 */
export function useAgents(): AgentsState & { refresh: () => void } {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { agents: Agent[] };
      if (!mounted.current) return;
      setAgents(data.agents);
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
      ws.onopen = () => mounted.current && setLive(true);
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
        setLive(false);
        retry = setTimeout(connect, 2000);
      };
      ws.onclose = drop;
      ws.onerror = () => ws?.close();
    };
    connect();

    // Fallback so the view still updates if the socket is unavailable.
    poll = setInterval(() => void refresh(), 10000);

    return () => {
      mounted.current = false;
      ws?.close();
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
    };
  }, [refresh]);

  return { agents, loading, error, live, refresh };
}
