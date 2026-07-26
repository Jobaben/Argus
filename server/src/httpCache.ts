import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/**
 * Conditional GETs for the read API.
 *
 * Argus's client is push-driven: one `pipelines:changed` broadcast wakes every
 * view that cares, and each re-fetches. That is deliberate (the server stays
 * the single source of truth), but it means a burst of frames re-downloads and
 * re-parses payloads that are usually byte-identical to the ones already on
 * screen — and every one of those replaces React state, re-rendering the whole
 * board for no visible change.
 *
 * So every read response carries a strong `ETag` over its body, and a request
 * that arrives with a matching `If-None-Match` gets a bodyless `304`. The
 * client keeps the tag per resource and skips the state update entirely on a
 * 304, which turns a no-op broadcast into a ~100-byte round trip and zero
 * re-renders.
 *
 * `Cache-Control: no-cache` is deliberate: it means "you may store this, but
 * revalidate before reuse" — never serve a monitoring payload from cache
 * without asking. Mutations are left alone; only GET/HEAD is tagged.
 */

/** Weak-ish but cheap: sha256 over the exact bytes we are about to send. */
function computeEtag(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}

/**
 * Parses an `If-None-Match` header and reports whether it covers `etag`.
 * Handles the `*` wildcard, comma-separated lists and `W/` prefixes, per
 * RFC 9110 §13.1.2.
 */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .includes(etag);
}

export function conditionalGet(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") return;
    if (!c.res.ok || c.res.status !== 200) return;
    // Only tag payloads we fully buffer anyway. A streamed or non-JSON body
    // (transcript export, the SPA's assets) is left to its own headers.
    const type = c.res.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) return;

    const body = await c.res.clone().text();
    const etag = computeEtag(body);

    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) {
      c.res = new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "no-cache" },
      });
      return;
    }

    c.res.headers.set("etag", etag);
    c.res.headers.set("cache-control", "no-cache");
  };
}
