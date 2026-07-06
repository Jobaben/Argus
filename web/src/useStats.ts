import { useLiveResource } from "./live/useLiveResource";

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

/** Loads usage stats. Stats have no push event, so they poll on a 30s timer. */
export function useStats() {
  const { data, loading, error, refresh } = useLiveResource<Stats | null>("/api/stats", {
    select: (j) => j as Stats,
    initial: null,
    pollMs: 30000,
  });
  return { stats: data, loading, error, refresh };
}
