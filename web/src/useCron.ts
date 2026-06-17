import { useCallback, useEffect, useRef, useState } from "react";

export interface CronDiskHint {
  path: string;
  note: string;
}

export interface CronStatus {
  available: false;
  reason: string;
  howTo: string;
  diskHints: CronDiskHint[];
}

interface CronState {
  cron: CronStatus | null;
  loading: boolean;
  error: string | null;
}

/**
 * Loads the cron availability status from the server. There is no live source
 * to subscribe to (cron routines never touch disk), so a one-shot fetch with a
 * manual refresh is sufficient — mirrors useAgents' fetch/loading/error shape.
 */
export function useCron(): CronState & { refresh: () => void } {
  const [cron, setCron] = useState<CronStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/cron");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as CronStatus;
      if (!mounted.current) return;
      setCron(data);
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
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  return { cron, loading, error, refresh };
}
