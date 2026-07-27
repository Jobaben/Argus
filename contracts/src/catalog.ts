/** Read-only catalogues derived from Claude Code's own state: transcripts,
 *  projects, usage stats, installed extensions, task dirs, search, cron. */

export interface SessionSummary {
  id: string;
  project: string;
  projectLabel: string;
  title: string;
  messageCount: number;
  toolUseCount: number;
  model: string | null;
  firstActivity: string | null;
  lastActivity: string | null;
}

export interface SessionMessage {
  index: number;
  type: string;
  role: string | null;
  timestamp: string | null;
  model: string | null;
  text: string | null;
  toolName: string | null;
  isError: boolean;
}

export interface SessionDetail {
  id: string;
  project: string;
  projectLabel: string;
  title: string;
  model: string | null;
  firstActivity: string | null;
  lastActivity: string | null;
  messages: SessionMessage[];
}

/** Incremental transcript tail: everything after the client's `after` index. */
export interface SessionTail {
  id: string;
  project: string;
  projectLabel: string;
  title: string;
  model: string | null;
  firstActivity: string | null;
  lastActivity: string | null;
  /** Messages with index strictly greater than the requested `after`. */
  messages: SessionMessage[];
  /** Index of the last message on disk; the client passes it back as `after`. */
  lastIndex: number;
}

export interface Project {
  id: string;
  label: string;
  sessionCount: number;
  lastActivity: string | null;
}

/** A normalized `history.jsonl` entry. */
export interface Activity {
  ts: string;
  text: string;
  project: string;
  cwd: string;
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

/** A markdown-defined item (agent, command, or skill) with parsed frontmatter. */
export interface InventoryItem {
  name: string;
  description: string;
}

/** An installed plugin, derived from `plugins/installed_plugins.json`. */
export interface PluginItem {
  name: string;
  description: string;
  version: string;
  marketplace: string;
}

export interface Inventory {
  agents: InventoryItem[];
  commands: InventoryItem[];
  skills: InventoryItem[];
  plugins: PluginItem[];
}

/** A single task directory under `~/.claude/tasks/<uuid>/`. */
export interface Task {
  id: string;
  highwatermark: number | null;
  locked: boolean;
  fileCount: number;
  updatedAt: string | null;
}

export interface SearchResult {
  project: string;
  projectLabel: string;
  sessionId: string;
  snippet: string;
  type: string;
}

/**
 * A search response, which says when it stopped early.
 *
 * The scan is capped and exits as soon as the cap is reached — that is what
 * keeps a common word from reading every transcript on disk. Without saying so,
 * "100 matches" reads as a count when it is a ceiling.
 */
export interface SearchResponse {
  results: SearchResult[];
  /** The cap that was applied. */
  limit: number;
  /** True when the scan stopped at the cap and more matches may exist. */
  truncated: boolean;
}

export interface CronDiskHint {
  /** Path (relative to the Claude home root) where the hint was found. */
  path: string;
  /** Why this entry is only a hint and not an authoritative cron source. */
  note: string;
}

export interface CronStatus {
  available: false;
  reason: string;
  howTo: string;
  /** Anything on disk that looked schedule-related, with caveats. */
  diskHints: CronDiskHint[];
}
