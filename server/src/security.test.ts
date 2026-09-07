import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isHostAllowed,
  isOriginAllowed,
  isSelfAuthenticating,
  isSessionBootstrap,
  isUpgradeAllowed,
  securityMiddleware,
} from "./security.js";
import type { ArgusConfig } from "./config.js";

const base: ArgusConfig = {
  port: 7777,
  host: "127.0.0.1",
  token: null,
  allowedHosts: [],
  allowedOrigins: [],
  maxConcurrentRuns: 4,
  schedulerTickMs: 30000,
  webhookUrl: null,
};

test("host allowlist accepts loopback names with any port", () => {
  for (const h of [
    "localhost:7777",
    "127.0.0.1:7777",
    "[::1]:7777",
    "localhost",
    "LOCALHOST:5757",
  ]) {
    assert.equal(isHostAllowed(h, base), true, h);
  }
});

test("host allowlist rejects arbitrary and rebinding hosts", () => {
  assert.equal(isHostAllowed("evil.example.com", base), false);
  assert.equal(isHostAllowed("attacker.com:7777", base), false);
  assert.equal(isHostAllowed(undefined, base), false);
});

test("host allowlist honors ARGUS_ALLOWED_HOSTS", () => {
  const cfg = { ...base, allowedHosts: ["argus.internal"] };
  assert.equal(isHostAllowed("argus.internal:7777", cfg), true);
  assert.equal(isHostAllowed("other.internal", cfg), false);
});

test("origin check permits no-Origin (non-browser) requests", () => {
  assert.equal(isOriginAllowed(undefined, "localhost:7777", base), true);
});

test("origin check permits same-origin and loopback origins", () => {
  assert.equal(isOriginAllowed("http://localhost:7777", "localhost:7777", base), true);
  assert.equal(isOriginAllowed("http://127.0.0.1:5757", "localhost:7777", base), true);
});

test("origin check rejects a cross-site (CSRF) origin", () => {
  assert.equal(isOriginAllowed("https://evil.example.com", "localhost:7777", base), false);
  assert.equal(isOriginAllowed("not-a-url", "localhost:7777", base), false);
});

test("origin check honors ARGUS_ALLOWED_ORIGINS", () => {
  const cfg = { ...base, allowedOrigins: ["https://dash.corp"] };
  assert.equal(isOriginAllowed("https://dash.corp", "dash.corp", cfg), true);
});

test("upgrade guard requires host, origin, and token together", () => {
  const cfg = { ...base, token: "secret" };
  assert.equal(
    isUpgradeAllowed(
      { host: "localhost:7777", origin: "http://localhost:7777", token: "secret" },
      cfg,
    ),
    true,
  );
  // Missing token
  assert.equal(
    isUpgradeAllowed({ host: "localhost:7777", origin: "http://localhost:7777" }, cfg),
    false,
  );
  // Bad host
  assert.equal(
    isUpgradeAllowed({ host: "evil.com", origin: "http://localhost:7777", token: "secret" }, cfg),
    false,
  );
  // Bearer form accepted
  assert.equal(
    isUpgradeAllowed(
      { host: "localhost:7777", origin: "http://localhost:7777", authorization: "Bearer secret" },
      cfg,
    ),
    true,
  );
});

test("the completion signal is self-authenticating for any instance id", () => {
  assert.equal(isSelfAuthenticating("/api/federation/summary"), true);
  assert.equal(
    isSelfAuthenticating("/api/instances/3c1c1b74-d421-4063-b18d-2eb9820d400d/signal"),
    true,
  );
});

test("self-authenticating matching does not spread to neighbouring routes", () => {
  for (const p of [
    "/api/instances/abc/approve",
    "/api/instances/abc/abort",
    "/api/instances/abc/signal/extra",
    "/api/instances//signal",
    "/api/instances",
    "/api/signal",
  ]) {
    assert.equal(isSelfAuthenticating(p), false, p);
  }
});

// ── Account session as an alternative credential ───────────────────────────
// A browser cannot present ARGUS_TOKEN: it is a server-side env var the page
// never learns. Before this, setting the token locked the bundled UI out of
// every /api route, so an exposed bind (which the token is mandatory for) had
// a working API and a dead dashboard.

test("session bootstrap routes are reachable without the shared token", () => {
  for (const p of [
    "/api/auth/status",
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/setup",
    "/api/auth/logout",
  ]) {
    assert.equal(isSessionBootstrap(p), true, p);
  }
});

test("the bootstrap exemption does not spread to other routes", () => {
  for (const p of [
    "/api/auth",
    "/api/auth/status/extra",
    "/api/users",
    "/api/overview",
    "/api/pipelines",
    "/api/auth/login/../../pipelines",
  ]) {
    assert.equal(isSessionBootstrap(p), false, p);
  }
});

test("upgrade guard accepts a valid session in place of the token", () => {
  const cfg = { ...base, token: "secret" };
  const loopback = { host: "localhost:7777", origin: "http://localhost:7777" };
  // A session stands in for the shared secret.
  assert.equal(isUpgradeAllowed(loopback, cfg, true), true);
  // No session and no token is still refused.
  assert.equal(isUpgradeAllowed(loopback, cfg, false), false);
  // A session does not excuse a bad Host (rebinding) or Origin (CSRF).
  assert.equal(isUpgradeAllowed({ ...loopback, host: "evil.com" }, cfg, true), false);
  assert.equal(
    isUpgradeAllowed({ ...loopback, origin: "https://evil.example.com" }, cfg, true),
    false,
  );
});

test("upgrade guard needs no session when no token is configured", () => {
  assert.equal(
    isUpgradeAllowed({ host: "localhost:7777", origin: "http://localhost:7777" }, base, false),
    true,
  );
});

test("middleware accepts a session cookie in place of the shared token", async () => {
  const { Hono } = await import("hono");
  const cfg = { ...base, token: "secret" };
  const app = new Hono();
  // Stand-in for the real verifier: one known-good session cookie value.
  app.use(
    "/api/*",
    securityMiddleware(cfg, (c) => c.req.header("cookie") === "argus_session=good"),
  );
  app.get("/api/overview", (c) => c.json({ ok: true }));
  app.post("/api/pipelines", (c) => c.json({ ok: true }));

  const get = (headers: Record<string, string>) =>
    app.request("http://localhost:7777/api/overview", { headers });

  assert.equal((await get({ host: "localhost:7777" })).status, 401);
  assert.equal((await get({ host: "localhost:7777", cookie: "argus_session=good" })).status, 200);
  assert.equal((await get({ host: "localhost:7777", cookie: "argus_session=stale" })).status, 401);
  assert.equal(
    (await get({ host: "localhost:7777", authorization: "Bearer secret" })).status,
    200,
    "the shared token still works for CLI and proxy clients",
  );

  // A session is not a licence to skip the CSRF origin check on mutations.
  const post = await app.request("http://localhost:7777/api/pipelines", {
    method: "POST",
    headers: {
      host: "localhost:7777",
      cookie: "argus_session=good",
      origin: "https://evil.example.com",
    },
  });
  assert.equal(post.status, 403);
});

test("a token-gated 401 tells the UI a login would fix it", async () => {
  const { Hono } = await import("hono");
  const app = new Hono();
  app.use("/api/*", securityMiddleware({ ...base, token: "secret" }));
  app.get("/api/overview", (c) => c.json({ ok: true }));
  const res = await app.request("http://localhost:7777/api/overview", {
    headers: { host: "localhost:7777" },
  });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { code?: string }).code, "auth_required");
});
