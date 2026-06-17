import path from "node:path";
import { claudeHome } from "../claudeHome.js";
import { readJson } from "./readJson.js";

interface RawDailyActivity {
  date?: string;
  messageCount?: number;
  sessionCount?: number;
  toolCallCount?: number;
}

interface RawDailyModelTokens {
  date?: string;
  tokensByModel?: Record<string, number>;
}

interface RawModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface RawStatsCache {
  version?: number;
  lastComputedDate?: string;
  dailyActivity?: RawDailyActivity[];
  dailyModelTokens?: RawDailyModelTokens[];
  modelUsage?: Record<string, RawModelUsage>;
  totalSessions?: number;
  totalMessages?: number;
  longestSession?: {
    sessionId?: string;
    duration?: number;
    messageCount?: number;
    timestamp?: string;
  };
  firstSessionDate?: string;
  hourCounts?: Record<string, number>;
  totalSpeculationTimeSavedMs?: number;
}

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

export interface StatsResult {
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

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildModels(usage: Record<string, RawModelUsage> | undefined): ModelStat[] {
  if (!usage || typeof usage !== "object") return [];
  return Object.entries(usage)
    .map(([model, u]) => {
      const inputTokens = num(u?.inputTokens);
      const outputTokens = num(u?.outputTokens);
      const cacheReadTokens = num(u?.cacheReadInputTokens);
      const cacheCreationTokens = num(u?.cacheCreationInputTokens);
      return {
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
        webSearchRequests: num(u?.webSearchRequests),
        costUSD: num(u?.costUSD),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

function buildDaily(
  activity: RawDailyActivity[] | undefined,
  tokens: RawDailyModelTokens[] | undefined,
): DailyStat[] {
  const tokensByDate = new Map<string, number>();
  for (const row of tokens ?? []) {
    if (!row?.date) continue;
    let sum = 0;
    for (const v of Object.values(row.tokensByModel ?? {})) sum += num(v);
    tokensByDate.set(row.date, (tokensByDate.get(row.date) ?? 0) + sum);
  }

  const byDate = new Map<string, DailyStat>();
  for (const row of activity ?? []) {
    if (!row?.date) continue;
    byDate.set(row.date, {
      date: row.date,
      messages: num(row.messageCount),
      sessions: num(row.sessionCount),
      toolCalls: num(row.toolCallCount),
      tokens: tokensByDate.get(row.date) ?? 0,
    });
  }
  // Token-only days (no activity entry) still carry meaningful usage.
  for (const [date, t] of tokensByDate) {
    if (byDate.has(date)) continue;
    byDate.set(date, { date, messages: 0, sessions: 0, toolCalls: 0, tokens: t });
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function buildPeakHours(hourCounts: Record<string, number> | undefined): PeakHour[] {
  if (!hourCounts || typeof hourCounts !== "object") return [];
  return Object.entries(hourCounts)
    .map(([hour, count]) => ({ hour: Number(hour), count: num(count) }))
    .filter((h) => Number.isFinite(h.hour))
    .sort((a, b) => a.hour - b.hour);
}

/** Reads the Claude Code usage stats cache into a normalized, defensive shape. */
export async function readStats(): Promise<StatsResult> {
  const file = path.join(claudeHome(), "stats-cache.json");
  const raw = await readJson<RawStatsCache | null>(file, null);

  if (!raw || typeof raw !== "object") {
    return {
      available: false,
      lastComputedDate: null,
      firstSessionDate: null,
      headline: {
        totalSessions: 0,
        totalMessages: 0,
        totalToolCalls: 0,
        totalTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCostUSD: 0,
        activeDays: 0,
        modelsUsed: 0,
      },
      longestSession: null,
      models: [],
      daily: [],
      peakHours: [],
    };
  }

  const models = buildModels(raw.modelUsage);
  const daily = buildDaily(raw.dailyActivity, raw.dailyModelTokens);

  const totalTokens = models.reduce((s, m) => s + m.totalTokens, 0);
  const totalOutputTokens = models.reduce((s, m) => s + m.outputTokens, 0);
  const totalCacheReadTokens = models.reduce((s, m) => s + m.cacheReadTokens, 0);
  const totalCostUSD = models.reduce((s, m) => s + m.costUSD, 0);
  const totalToolCalls = daily.reduce((s, d) => s + d.toolCalls, 0);

  const longest = raw.longestSession;

  return {
    available: true,
    lastComputedDate: raw.lastComputedDate ?? null,
    firstSessionDate: raw.firstSessionDate ?? null,
    headline: {
      totalSessions: num(raw.totalSessions),
      totalMessages: num(raw.totalMessages),
      totalToolCalls,
      totalTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCostUSD,
      activeDays: daily.length,
      modelsUsed: models.length,
    },
    longestSession: longest
      ? {
          sessionId: longest.sessionId ?? null,
          durationMs: num(longest.duration),
          messageCount: num(longest.messageCount),
          timestamp: longest.timestamp ?? null,
        }
      : null,
    models,
    daily,
    peakHours: buildPeakHours(raw.hourCounts),
  };
}
