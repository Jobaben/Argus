import { useCallback, useEffect, useRef, useState } from "react";

export interface PrereqResult {
  id: string;
  label: string;
  status: "ok" | "missing" | "error";
  fixable: boolean;
  detail?: string;
}

interface SetupState {
  ok: boolean;
  prereqs: PrereqResult[];
  loading: boolean;
  error: string | null;
}

/** Fetches prerequisite status and exposes an apply() that re-checks. */
export function useSetup() {
  const [state, setState] = useState<SetupState>({ ok: true, prereqs: [], loading: true, error: null });
  const mounted = useRef(true);

  const load = useCallback(async (url: string, method: "GET" | "POST") => {
    try {
      const res = await fetch(url, { method });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { ok?: boolean; prereqs?: PrereqResult[] };
      if (mounted.current) {
        setState({ ok: Boolean(data.ok), prereqs: data.prereqs ?? [], loading: false, error: null });
      }
    } catch (e) {
      if (mounted.current) {
        setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
    }
  }, []);

  const refresh = useCallback(() => load("/api/setup", "GET"), [load]);
  const apply = useCallback(() => load("/api/setup/apply", "POST"), [load]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  return { ...state, apply };
}
