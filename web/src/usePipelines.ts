import { useCallback, useEffect, useRef, useState } from "react";
import type { PipelineDefinition, PipelineInput } from "./types";

interface State {
  pipelines: PipelineDefinition[];
  loading: boolean;
  error: string | null;
}

/** Lists pipeline definitions, refreshing on the server's "pipelines:changed" WS ping. */
export function usePipelines() {
  const [state, setState] = useState<State>({ pipelines: [], loading: true, error: null });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/pipelines");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { pipelines: PipelineDefinition[] };
      if (mounted.current) setState({ pipelines: data.pipelines, loading: false, error: null });
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

  const create = useCallback((input: PipelineInput) => mutate("/api/pipelines", "POST", input), [mutate]);
  const update = useCallback(
    (id: string, input: PipelineInput) => mutate(`/api/pipelines/${id}`, "PUT", input),
    [mutate],
  );
  const remove = useCallback((id: string) => mutate(`/api/pipelines/${id}`, "DELETE"), [mutate]);
  const setEnabled = useCallback(
    (id: string, enabled: boolean) => mutate(`/api/pipelines/${id}`, "PATCH", { enabled }),
    [mutate],
  );
  const runNow = useCallback((id: string) => mutate(`/api/pipelines/${id}/start`, "POST"), [mutate]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = setInterval(() => void refresh(), 10000);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string };
        if (msg.type === "pipelines:changed") void refresh();
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

  return { ...state, refresh, create, update, remove, setEnabled, runNow };
}
