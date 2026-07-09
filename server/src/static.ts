import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import path from "node:path";
import type { Context, Hono } from "hono";
import { getMimeType } from "hono/utils/mime";

/**
 * Resolve the built web assets. Priority: explicit ARGUS_WEB_DIR, else the
 * sibling `web/dist` relative to the server package. Returns null when no build
 * exists (dev mode — Vite serves the UI and proxies /api here).
 */
export function resolveWebDir(): string | null {
  const override = process.env.ARGUS_WEB_DIR?.trim();
  if (override) return existsSync(override) ? path.resolve(override) : null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // From server/src or server/dist → ../../web/dist
  const candidates = [
    path.resolve(here, "..", "..", "web", "dist"),
    path.resolve(here, "..", "web", "dist"),
  ];
  return candidates.find((c) => existsSync(path.join(c, "index.html"))) ?? null;
}

/** Stream one file from `dir` if it resolves inside it; null → let caller 404. */
function serveFile(c: Context, dir: string, requestPath: string): Response | null {
  const rel = decodeURIComponent(requestPath).replace(/^\/+/, "");
  const file = path.resolve(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) return null;
  let stats;
  try {
    stats = statSync(file);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  c.header("Content-Type", getMimeType(file) ?? "application/octet-stream");
  c.header("Content-Length", String(stats.size));
  return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream, 200);
}

/**
 * Mount the built single-page app on the same origin as the API, so `npm start`
 * serves the whole product on one port. No-op when there is no build.
 * Non-/api routes fall back to index.html (the app uses hash routing).
 *
 * Deliberately avoids `@hono/node-server/serve-static`: its `import "process"`
 * deadlocks under `tsx watch` on Windows (nodejs/node#56537), which made the
 * dev server hang before binding its port.
 */
export function mountWebApp(app: Hono): string | null {
  const dir = resolveWebDir();
  if (!dir) return null;
  const index = readFileSync(path.join(dir, "index.html"), "utf8");
  app.get("/assets/*", (c) => serveFile(c, dir, c.req.path) ?? c.notFound());
  app.get("/vite.svg", (c) => serveFile(c, dir, c.req.path) ?? c.notFound());
  app.get("/favicon.ico", (c) => serveFile(c, dir, c.req.path) ?? c.notFound());
  // SPA fallback for every non-API GET; leave /api and /ws to their handlers
  // (and to the JSON 404) so a missing endpoint doesn't return HTML.
  app.get("*", (c) => {
    const p = c.req.path;
    if (p.startsWith("/api") || p === "/ws") return c.notFound();
    return c.html(index);
  });
  return dir;
}
