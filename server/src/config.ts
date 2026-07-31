import { log } from "./log.js";
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
    log.warn("ignoring invalid environment value", { name, value: raw, min, using: fallback });
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

const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

/** True when this bind address is reachable from outside the machine. */
export function isExposedBind(host: string): boolean {
  return !LOOPBACK_BINDS.has(host.trim().toLowerCase());
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Refuses an unauthenticated bind to a non-loopback interface.
 *
 * Argus spawns agent CLIs with the user's credentials, so an exposed port with
 * no token is remote code execution for anyone on the network. The README has
 * always called `ARGUS_TOKEN` "mandatory" in that case — it was only a warning,
 * which meant the documented promise and the actual behaviour disagreed, and the
 * one you find out about is whichever one bites you.
 */
export function assertBindIsSafe(config: ArgusConfig): void {
  if (!isExposedBind(config.host) || config.token) return;
  throw new ConfigError(
    `refusing to bind ${config.host} without ARGUS_TOKEN.\n` +
      "  Argus can execute agents with your credentials, so an exposed port needs a\n" +
      "  shared secret. Either:\n" +
      "    • set ARGUS_TOKEN=$(openssl rand -hex 16) and pass it as a bearer token, or\n" +
      "    • drop ARGUS_HOST to keep the loopback-only default (127.0.0.1).",
  );
}

/**
 * The same promise, extended to federation.
 *
 * A peer is a machine this server will send its own summary to and accept one
 * from. Over loopback that is a local experiment; over anything else it is a
 * trust relationship, and one without a pairing secret is not a relationship at
 * all — it is an open endpoint that will hand a summary to whoever asks and
 * believe whatever comes back.
 *
 * `assertBindIsSafe` refuses an exposed port with no token for the same reason,
 * and the two checks stay side by side deliberately: a security promise that
 * covers the original feature and not the new one is the promise people
 * actually rely on and the one that is quietly false.
 */
export function assertPeersAreSafe(peers: { label: string; url: string; secret: string }[]): void {
  const unsafe = peers.filter((p) => !p.secret && !isLoopbackUrl(p.url));
  if (unsafe.length === 0) return;
  throw new ConfigError(
    `refusing to start with ${unsafe.length} unpaired remote peer(s): ` +
      `${unsafe.map((p) => p.label || p.url).join(", ")}.\n` +
      "  A peer over a non-loopback URL needs a pairing secret; without one the\n" +
      "  summary exchange is unauthenticated in both directions. Either:\n" +
      "    • pair the machines (Fleet → Pair a machine) and re-add the peer, or\n" +
      "    • remove the peer from ~/.claude/argus/peers.json.",
  );
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    // An unparseable URL is not loopback. Refusing is the safe reading, and the
    // peer validator rejects it on the way in anyway.
    return false;
  }
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

/**
 * The actionable message for a listen error that Argus cannot recover from, or
 * null when the error is not a startup failure.
 *
 * These used to fall through to the catch-all `uncaughtException` handler, whose
 * whole purpose is the opposite — keep the daemon alive through a stray rejection
 * — so a port collision logged one internal-looking line and then sat there: no
 * socket bound, nothing served, and an exit code that never came, so neither the
 * `argus` CLI nor a supervisor could tell it had failed.
 */
export function describeListenError(err: unknown, host: string, port: number): string | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case "EADDRINUSE":
      return `port ${port} is already in use — another Argus, or another program, has it. Stop that process, or start this one on a different port with ARGUS_PORT=<n>.`;
    case "EACCES":
      return `not allowed to bind ${host}:${port}. Ports below 1024 need elevated privileges; pick a higher one with ARGUS_PORT=<n>.`;
    case "EADDRNOTAVAIL":
      return `${host} is not an address on this machine. Set ARGUS_HOST to an interface that exists (127.0.0.1 for local-only).`;
    default:
      return null;
  }
}
