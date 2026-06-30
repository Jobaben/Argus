import { useCallback, useEffect, useRef, useState } from "react";
import type { OverviewEntry } from "./types";

interface State {
  overview: OverviewEntry[];
  loading: boolean;
  error: string | null;
}

/** Lists the pipeline overview, refreshing on the "pipelines:changed" WS ping. */
export function useOverview() {
  const [state, setState] = useState<State>({ overview: [], loading: true, error: null });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/overview");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { overview?: OverviewEntry[] };
      const overview = Array.isArray(data.overview) ? data.overview : [];
      if (mounted.current) setState({ overview, loading: false, error: null });
    } catch (e) {
      if (mounted.current) {
        setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }, []);

  // Fire the mutation only. The same server mutation broadcasts
  // "pipelines:changed", and the WS handler below (or the 10s poll fallback)
  // drives the single refresh — so we deliberately do NOT refetch here.
  const act = useCallback(
    async (instanceId: string, action: "approve" | "revise", body?: unknown) => {
      const res = await fetch(`/api/instances/${instanceId}/${action}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error ?? `HTTP ${res.status}`);
      }
      return res;
    },
    [],
  );

  const approve = useCallback((instanceId: string) => act(instanceId, "approve"), [act]);
  const revise = useCallback(
    (instanceId: string, note?: string) => act(instanceId, "revise", note ? { note } : undefined),
    [act],
  );

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
          if (msg.type === "pipelines:changed") void refresh();
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

    // Fallback so the wall still updates if the socket is unavailable.
    poll = setInterval(() => void refresh(), 10000);

    return () => {
      mounted.current = false;
      ws?.close();
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
    };
  }, [refresh]);

  return { ...state, refresh, approve, revise };
}
