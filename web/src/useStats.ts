import { useCallback, useEffect, useRef, useState } from "react";

export interface ModelStat {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

export interface DailyStat {
  date: string;
  messages: number;
  sessions: number;
  toolCalls: number;
  tokens: number;
}

export interface PeakHour {
  hour: number;
  count: number;
}

export interface Stats {
  available: boolean;
  lastComputedDate: string | null;
  firstSessionDate: string | null;
  headline: {
    totalSessions: number;
    totalMessages: number;
    totalToolCalls: number;
    totalTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCostUSD: number;
    activeDays: number;
    modelsUsed: number;
  };
  longestSession: {
    sessionId: string | null;
    durationMs: number;
    messageCount: number;
    timestamp: string | null;
  } | null;
  models: ModelStat[];
  daily: DailyStat[];
  peakHours: PeakHour[];
}

interface StatsState {
  stats: Stats | null;
  loading: boolean;
  error: string | null;
}

/** Loads usage stats from the server with loading/error state and a poll refresh. */
export function useStats(): StatsState & { refresh: () => void } {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Stats;
      if (!mounted.current) return;
      setStats(data);
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
    const poll = setInterval(() => void refresh(), 30000);
    return () => {
      mounted.current = false;
      clearInterval(poll);
    };
  }, [refresh]);

  return { stats, loading, error, refresh };
}
