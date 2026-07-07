import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

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

/**
 * Mount the built single-page app on the same origin as the API, so `npm start`
 * serves the whole product on one port. No-op when there is no build.
 * Non-/api routes fall back to index.html (the app uses hash routing).
 */
export function mountWebApp(app: Hono): string | null {
  const dir = resolveWebDir();
  if (!dir) return null;
  const index = readFileSync(path.join(dir, "index.html"), "utf8");
  app.use("/assets/*", serveStatic({ root: dir }));
  app.get("/vite.svg", serveStatic({ root: dir }));
  app.get("/favicon.ico", serveStatic({ root: dir }));
  // SPA fallback for every non-API GET; leave /api and /ws to their handlers
  // (and to the JSON 404) so a missing endpoint doesn't return HTML.
  app.get("*", (c) => {
    const p = c.req.path;
    if (p.startsWith("/api") || p === "/ws") return c.notFound();
    return c.html(index);
  });
  return dir;
}
