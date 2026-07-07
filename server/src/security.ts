import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import type { ArgusConfig } from "./config.js";

/** Constant-time string compare — avoids leaking the token via response timing. */
function safeEqual(a: string | null, b: string): boolean {
  if (a === null) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual requires equal lengths; compare against a fixed-length
  // digest-like guard so unequal lengths still take constant work.
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Argus can spawn `claude -p` agents with the user's full credentials, so the
 * HTTP surface is treated as a privileged, single-user control plane. Three
 * layers keep a local-only tool from becoming a remote-code-execution vector:
 *
 *  1. Loopback binding (see config.host) — the socket is not on the LAN.
 *  2. Host-header allowlist — defeats DNS-rebinding, where a malicious page
 *     resolves its own name to 127.0.0.1 and talks to Argus from the browser.
 *  3. Origin check on state-changing verbs — defeats drive-by CSRF, where a
 *     page the user visits POSTs a schedule that Argus then executes.
 *
 * An optional shared token (ARGUS_TOKEN) gates everything for deployments that
 * deliberately bind a non-loopback interface behind a trusted proxy.
 */

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

/** Strip the port and lowercase, so "LocalHost:7777" matches "localhost". */
function hostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  // Bracketed IPv6 literal, optionally with :port after the bracket.
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  return colon === -1 ? h : h.slice(0, colon);
}

export function isHostAllowed(hostHeader: string | undefined, cfg: ArgusConfig): boolean {
  const name = hostname(hostHeader);
  if (!name) return false;
  if (LOOPBACK_HOSTS.has(name)) return true;
  return cfg.allowedHosts.includes(name);
}

/** True when the request's Origin is same-origin or explicitly allowlisted. */
export function isOriginAllowed(
  origin: string | undefined,
  hostHeader: string | undefined,
  cfg: ArgusConfig,
): boolean {
  // No Origin header: non-CORS request (curl, same-origin navigation, server).
  // These cannot be forged cross-site by a browser, so they are permitted.
  if (!origin) return true;
  let originHost: string | null;
  try {
    originHost = hostname(new URL(origin).host);
  } catch {
    return false;
  }
  if (originHost && LOOPBACK_HOSTS.has(originHost)) return true;
  if (originHost === hostname(hostHeader)) return true;
  return cfg.allowedOrigins.includes(origin.toLowerCase());
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

/** Hono middleware enforcing the three-layer model above on every /api route. */
export function securityMiddleware(cfg: ArgusConfig) {
  return async (c: Context, next: Next) => {
    if (!isHostAllowed(c.req.header("host"), cfg)) {
      return c.json({ error: "forbidden: host not allowed" }, 403);
    }
    if (cfg.token) {
      const supplied = bearer(c.req.header("authorization")) ?? c.req.header("x-argus-token") ?? null;
      if (!safeEqual(supplied, cfg.token)) return c.json({ error: "unauthorized" }, 401);
    }
    if (MUTATING.has(c.req.method) && !isOriginAllowed(c.req.header("origin"), c.req.header("host"), cfg)) {
      return c.json({ error: "forbidden: cross-origin request rejected" }, 403);
    }
    await next();
  };
}

/**
 * Guard for the WebSocket upgrade, which bypasses the Hono middleware chain.
 * Applies the same Host + Origin + token checks against the raw upgrade request.
 */
export function isUpgradeAllowed(
  headers: { host?: string; origin?: string; authorization?: string; token?: string },
  cfg: ArgusConfig,
): boolean {
  if (!isHostAllowed(headers.host, cfg)) return false;
  if (!isOriginAllowed(headers.origin, headers.host, cfg)) return false;
  if (cfg.token) {
    const supplied = bearer(headers.authorization) ?? headers.token ?? null;
    if (!safeEqual(supplied, cfg.token)) return false;
  }
  return true;
}
