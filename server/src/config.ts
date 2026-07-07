/**
 * Central, validated runtime configuration. Every environment variable Argus
 * honours is parsed here exactly once, with sane fallbacks, so a typo like
 * ARGUS_MAX_CONCURRENT_RUNS=four fails loudly (or falls back) instead of
 * silently disabling a safety limit somewhere deep in the engine.
 */

function intFromEnv(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    console.warn(`[argus] ${name}="${raw}" is not an integer >= ${min}; using ${fallback}`);
    return fallback;
  }
  return n;
}

function listFromEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface ArgusConfig {
  port: number;
  /** Interface to bind. Defaults to loopback so Argus is never exposed to the LAN. */
  host: string;
  /** Optional shared secret; when set, every /api request must present it. */
  token: string | null;
  /** Extra Host header values to accept beyond the loopback set (for reverse proxies). */
  allowedHosts: string[];
  /** Extra Origin values to accept for cross-origin browser requests. */
  allowedOrigins: string[];
  maxConcurrentRuns: number;
  schedulerTickMs: number;
  /** Optional webhook POSTed a JSON payload whenever a run/pipeline fails. */
  webhookUrl: string | null;
}

export function loadConfig(): ArgusConfig {
  return {
    port: intFromEnv("ARGUS_PORT", 7777),
    host: process.env.ARGUS_HOST?.trim() || "127.0.0.1",
    token: process.env.ARGUS_TOKEN?.trim() || null,
    allowedHosts: listFromEnv("ARGUS_ALLOWED_HOSTS"),
    allowedOrigins: listFromEnv("ARGUS_ALLOWED_ORIGINS"),
    maxConcurrentRuns: intFromEnv("ARGUS_MAX_CONCURRENT_RUNS", 4),
    schedulerTickMs: intFromEnv("ARGUS_SCHED_TICK_MS", 30000, 1000),
    webhookUrl: process.env.ARGUS_WEBHOOK_URL?.trim() || null,
  };
}
