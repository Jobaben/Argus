import { useCallback, useEffect, useRef, useState } from "react";
import type { ScheduleInput, ScheduleWithNext } from "./types";

interface State {
  schedules: ScheduleWithNext[];
  loading: boolean;
  error: string | null;
}

/** Lists schedules, refreshing on the server's "schedules:changed" WS ping. */
export function useSchedules() {
  const [state, setState] = useState<State>({ schedules: [], loading: true, error: null });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/schedules");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { schedules: ScheduleWithNext[] };
      if (mounted.current) setState({ schedules: data.schedules, loading: false, error: null });
    } catch (e) {
      if (mounted.current) {
        setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }, []);

  const mutate = useCallback(
    async (path: string, method: string, body?: unknown) => {
      const res = await fetch(path, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const msg = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(msg.error ?? `HTTP ${res.status}`);
      }
      await refresh();
      return res;
    },
    [refresh],
  );

  const create = useCallback((input: ScheduleInput) => mutate("/api/schedules", "POST", input), [mutate]);
  const update = useCallback(
    (id: string, patch: Partial<ScheduleInput>) => mutate(`/api/schedules/${id}`, "PUT", patch),
    [mutate],
  );
  const remove = useCallback((id: string) => mutate(`/api/schedules/${id}`, "DELETE"), [mutate]);
  const runNow = useCallback((id: string) => mutate(`/api/schedules/${id}/run`, "POST"), [mutate]);

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

  return { ...state, refresh, create, update, remove, runNow };
}
