import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import type { ArgusConfig } from "./config.js";
import type { Engine } from "./pipelineEngine.js";
import { createAuthService, type AuthService } from "./auth.js";
import { createUserStore } from "./userStore.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-app-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

const config: ArgusConfig = {
  port: 7777,
  host: "127.0.0.1",
  token: null,
  allowedHosts: [],
  allowedOrigins: [],
  maxConcurrentRuns: 4,
  schedulerTickMs: 30000,
  webhookUrl: null,
};

// A no-op engine — route tests exercise the HTTP contract, not the engine.
const fakeEngine: Engine = {
  start: async () => null,
  onSignal: async () => ({ ok: true, code: 200 }),
  approve: async () => ({ ok: true, code: 200 }),
  revise: async () => ({ ok: true, code: 200 }),
  abort: async () => ({ ok: true, code: 200 }),
  reconcile: async () => {},
  adopt: async () => {},
};

// Always-authenticated root stub for tests that target other routes' behavior.
const openAuth: AuthService = {
  isConfigured: async () => true,
  status: async () => ({ configured: true, username: "test", role: "root" }),
  login: async () => ({ ok: false, reason: "bad-credentials" }),
  verify: () => ({ username: "test", role: "root" }),
  logout: () => {},
  revokeSessions: () => {},
};

function makeApp(over: Partial<ArgusConfig> = {}, auth: AuthService = openAuth) {
  const users = createUserStore();
  return createApp({
    config: { ...config, ...over },
    engine: fakeEngine,
    broadcast: () => {},
    serveWeb: false,
    users,
    remoteAddr: () => "127.0.0.1",
    auth,
  });
}

/** For auth-flow tests that need the real auth service backed by the same store. */
function makeAuthApp(remote = "127.0.0.1") {
  const users = createUserStore();
  const auth = createAuthService({ store: users });
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: () => {},
    serveWeb: false,
    users,
    auth,
    remoteAddr: () => remote,
  });
  return { app, users, auth };
}

const loopback = { host: "localhost:7777" };
const sameOrigin = {
  host: "localhost:7777",
  origin: "http://localhost:7777",
  "content-type": "application/json",
};

test("GET /api/health returns ok + version", async () => {
  const res = await makeApp().request("/api/health", { headers: loopback });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; version: string };
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, "string");
});

test("unknown Host header is rejected with 403", async () => {
  const res = await makeApp().request("/api/health", { headers: { host: "evil.example.com" } });
  assert.equal(res.status, 403);
});

test("cross-origin mutation is rejected with 403", async () => {
  const res = await makeApp().request("/api/schedules", {
    method: "POST",
    headers: {
      host: "localhost:7777",
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(res.status, 403);
});

test("token gate: missing token is 401, correct token passes", async () => {
  const app = makeApp({ token: "s3cret" });
  const denied = await app.request("/api/health", { headers: loopback });
  assert.equal(denied.status, 401);
  const ok = await app.request("/api/health", {
    headers: { ...loopback, authorization: "Bearer s3cret" },
  });
  assert.equal(ok.status, 200);
});

test("GET /api/agents returns an empty list on a fresh home", async () => {
  const res = await makeApp().request("/api/agents", { headers: loopback });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { agents: [] });
});

test("path traversal on the timeline route yields an empty timeline", async () => {
  const res = await makeApp().request("/api/agents/..%2f..%2fetc/timeline", { headers: loopback });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { timeline: [] });
});

test("POST /api/schedules validates the body (400 on bad input)", async () => {
  const res = await makeApp().request("/api/schedules", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({ name: "" }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/schedules creates a schedule (201) and it appears in the list", async () => {
  const app = makeApp();
  const create = await app.request("/api/schedules", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({
      name: "Nightly",
      prompt: "audit",
      cwd: home,
      trigger: { kind: "daily", time: "02:00" },
    }),
  });
  assert.equal(create.status, 201);
  const list = (await (await app.request("/api/schedules", { headers: loopback })).json()) as {
    schedules: { name: string }[];
  };
  assert.equal(list.schedules.length, 1);
  assert.equal(list.schedules[0].name, "Nightly");
});

test("session transcript export renders Markdown with a download header", async () => {
  const proj = "-tmp-proj";
  mkdirSync(path.join(home, "projects", proj), { recursive: true });
  writeFileSync(
    path.join(home, "projects", proj, "sess1.jsonl"),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-06T00:00:00Z",
      message: { role: "user", content: "hello" },
    }) + "\n",
  );
  const res = await makeApp().request(`/api/sessions/${proj}/sess1/export`, { headers: loopback });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /markdown/);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment/);
  assert.match(await res.text(), /# hello/);
});

test("unknown API route returns JSON 404, not HTML", async () => {
  const res = await makeApp().request("/api/nope", { headers: loopback });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "not found" });
});

test("pipeline start overlap returns 409 (engine returns null)", async () => {
  const res = await makeApp().request("/api/pipelines/p1/start", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(res.status, 409);
});

test("GET /api/chronicle returns a windowed, empty-safe timeline", async () => {
  const res = await makeApp().request("/api/chronicle?hours=6", { headers: loopback });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    windowStart: string;
    windowEnd: string;
    groups: unknown[];
    totals: { spans: number };
  };
  assert.deepEqual(body.groups, []);
  assert.equal(body.totals.spans, 0);
  const spanMs = new Date(body.windowEnd).getTime() - new Date(body.windowStart).getTime();
  assert.equal(spanMs, 6 * 3_600_000);
});

test("GET /api/chronicle clamps a bogus hours param to the default", async () => {
  const res = await makeApp().request("/api/chronicle?hours=banana", { headers: loopback });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { windowStart: string; windowEnd: string };
  const spanMs = new Date(body.windowEnd).getTime() - new Date(body.windowStart).getTime();
  assert.equal(spanMs, 24 * 3_600_000);
});

test("GET /api/totals returns the current totals shape", async () => {
  const res = await makeApp().request("/api/totals", { headers: loopback });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { usd: number; tokens: number; since: string };
  assert.equal(typeof body.usd, "number");
  assert.equal(typeof body.tokens, "number");
  assert.equal(typeof body.since, "string");
});

// ── Admin auth on the pipeline surface ──────────────────────────────────────

function realAuthApp() {
  return makeApp({}, createAuthService());
}

/** Pull the argus_session cookie out of a login/setup response. */
function sessionCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = /argus_session=([^;]+)/.exec(raw);
  assert.ok(m, `expected a session cookie, got: ${raw}`);
  return `argus_session=${m[1]}`;
}

test("pipeline mutations are 401 before an admin account exists", async () => {
  const app = realAuthApp();
  for (const [path, method] of [
    ["/api/pipelines", "POST"],
    ["/api/pipelines/p1", "PUT"],
    ["/api/pipelines/p1", "PATCH"],
    ["/api/pipelines/p1", "DELETE"],
    ["/api/pipelines/p1/start", "POST"],
    ["/api/instances/i1/approve", "POST"],
    ["/api/instances/i1/revise", "POST"],
    ["/api/instances/i1/abort", "POST"],
  ] as const) {
    const res = await app.request(path, { method, headers: sameOrigin, body: "{}" });
    assert.equal(res.status, 401, `${method} ${path}`);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "auth_setup_required", `${method} ${path}`);
  }
  // Reads stay open — the dashboard works without a login.
  const list = await app.request("/api/pipelines", { headers: loopback });
  assert.equal(list.status, 200);
});

test("setup → authenticated mutation → logout → 401 again", async () => {
  const { app } = makeAuthApp();

  const setup = await app.request("/api/auth/setup", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({ username: "usha", password: "correct horse battery" }),
  });
  assert.equal(setup.status, 201);
  const cookieHeader = setup.headers.get("set-cookie") ?? "";
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Strict/i);
  const cookie = sessionCookie(setup);

  const start = await app.request("/api/pipelines/p1/start", {
    method: "POST",
    headers: { ...sameOrigin, cookie },
  });
  // Engine stub returns null → 409 overlap; the point is we got past the gate.
  assert.equal(start.status, 409);

  const status = await app.request("/api/auth/status", { headers: { ...loopback, cookie } });
  assert.deepEqual(await status.json(), {
    configured: true,
    authenticated: true,
    username: "usha",
    role: "root",
  });

  const logout = await app.request("/api/auth/logout", {
    method: "POST",
    headers: { ...sameOrigin, cookie },
  });
  assert.equal(logout.status, 200);
  const after = await app.request("/api/pipelines/p1/start", {
    method: "POST",
    headers: { ...sameOrigin, cookie },
  });
  assert.equal(after.status, 401);
});

test("bootstrap register is refused from a non-loopback socket", async () => {
  const { app } = makeAuthApp("10.59.1.99");
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { ...loopback, "content-type": "application/json" },
    body: JSON.stringify({ username: "attacker", password: "attacker password" }),
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { code?: string };
  assert.equal(body.code, "bootstrap_localhost_only");
});

test("after bootstrap, registration creates a pending account that cannot log in", async () => {
  const { app } = makeAuthApp();
  // Bootstrap root from loopback.
  const boot = await app.request("/api/auth/register", {
    method: "POST",
    headers: { ...loopback, "content-type": "application/json" },
    body: JSON.stringify({ username: "Josha", password: "root password here" }),
  });
  assert.equal(boot.status, 201);

  // Second registration — now from anywhere — lands pending.
  const reg = await app.request("/api/auth/register", {
    method: "POST",
    headers: { ...loopback, "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alice password!" }),
  });
  assert.equal(reg.status, 201);
  assert.deepEqual(await reg.json(), { ok: true, pending: true });

  // Pending accounts are told to wait, not let in.
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { ...loopback, "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alice password!" }),
  });
  assert.equal(login.status, 403);
  assert.equal(((await login.json()) as { code?: string }).code, "pending_approval");
});

test("post-bootstrap registration from a non-loopback address lands pending", async () => {
  let remote = "127.0.0.1";
  const users = createUserStore();
  const auth = createAuthService({ store: users });
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: () => {},
    serveWeb: false,
    users,
    auth,
    remoteAddr: () => remote,
  });
  const boot = await app.request("/api/auth/register", {
    method: "POST",
    headers: { ...loopback, "content-type": "application/json" },
    body: JSON.stringify({ username: "Josha", password: "root password here" }),
  });
  assert.equal(boot.status, 201);

  remote = "10.59.1.99";
  const reg = await app.request("/api/auth/register", {
    method: "POST",
    headers: { ...loopback, "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alice password!" }),
  });
  assert.equal(reg.status, 201);
  assert.deepEqual(await reg.json(), { ok: true, pending: true });
  assert.equal((await users.find("alice"))?.status, "pending");
});

test("duplicate registration is a 409", async () => {
  const { app } = makeAuthApp();
  const mk = (username: string) =>
    app.request("/api/auth/register", {
      method: "POST",
      headers: { ...loopback, "content-type": "application/json" },
      body: JSON.stringify({ username, password: "some password 123" }),
    });
  await mk("Josha");
  await mk("alice");
  const dup = await mk("ALICE");
  assert.equal(dup.status, 409);
});

test("root can list, approve, and reject users; members cannot", async () => {
  const { app } = makeAuthApp();
  const boot = await app.request("/api/auth/register", {
    method: "POST",
    headers: { ...loopback, "content-type": "application/json" },
    body: JSON.stringify({ username: "Josha", password: "root password here" }),
  });
  const rootCookie = boot.headers.get("set-cookie")!.split(";")[0];
  await app.request("/api/auth/register", {
    method: "POST",
    headers: { ...loopback, "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alice password!" }),
  });

  // Unauthenticated list → 401.
  assert.equal((await app.request("/api/users", { headers: loopback })).status, 401);

  // Root sees the pending account.
  const list = await app.request("/api/users", {
    headers: { ...loopback, cookie: rootCookie },
  });
  assert.equal(list.status, 200);
  const { users: rows } = (await list.json()) as {
    users: { username: string; status: string }[];
  };
  assert.deepEqual(
    rows.map((u) => [u.username, u.status]),
    [
      ["Josha", "active"],
      ["alice", "pending"],
    ],
  );

  // Approve → alice can log in, but as a member she can't touch /api/users.
  const approve = await app.request("/api/users/alice/approve", {
    method: "POST",
    headers: { ...loopback, cookie: rootCookie },
  });
  assert.equal(approve.status, 200);
  const aliceLogin = await app.request("/api/auth/login", {
    method: "POST",
    headers: { ...loopback, "content-type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "alice password!" }),
  });
  assert.equal(aliceLogin.status, 200);
  const aliceCookie = aliceLogin.headers.get("set-cookie")!.split(";")[0];
  const memberList = await app.request("/api/users", {
    headers: { ...loopback, cookie: aliceCookie },
  });
  assert.equal(memberList.status, 403);

  // Reject kills the account AND its live session.
  const reject = await app.request("/api/users/alice/reject", {
    method: "POST",
    headers: { ...loopback, cookie: rootCookie },
  });
  assert.equal(reject.status, 200);
  const afterReject = await app.request("/api/auth/status", {
    headers: { ...loopback, cookie: aliceCookie },
  });
  assert.equal(((await afterReject.json()) as { authenticated: boolean }).authenticated, false);

  // Root cannot remove itself; unknown users are 404.
  const self = await app.request("/api/users/Josha/reject", {
    method: "POST",
    headers: { ...loopback, cookie: rootCookie },
  });
  assert.equal(self.status, 400);
  const missing = await app.request("/api/users/nobody/approve", {
    method: "POST",
    headers: { ...loopback, cookie: rootCookie },
  });
  assert.equal(missing.status, 404);
});

test("weak setup password is rejected with 400 and no account is created", async () => {
  const app = realAuthApp();
  const res = await app.request("/api/auth/setup", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({ username: "usha", password: "short" }),
  });
  assert.equal(res.status, 400);
  const status = await app.request("/api/auth/status", { headers: loopback });
  assert.deepEqual(await status.json(), {
    configured: false,
    authenticated: false,
    username: null,
    role: null,
  });
});

test("auth login/setup are still subject to the cross-origin guard", async () => {
  const app = realAuthApp();
  const res = await app.request("/api/auth/setup", {
    method: "POST",
    headers: {
      host: "localhost:7777",
      origin: "https://evil.example.com",
      "content-type": "application/json",
    },
    body: JSON.stringify({ username: "mallory", password: "evil password!" }),
  });
  assert.equal(res.status, 403);
});

test("POST /api/totals/reset zeroes totals and broadcasts", async () => {
  const messages: unknown[] = [];
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: (m) => messages.push(m),
    serveWeb: false,
  });
  const res = await app.request("/api/totals/reset", { method: "POST", headers: sameOrigin });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { usd: number; tokens: number };
  assert.equal(body.usd, 0);
  assert.equal(body.tokens, 0);
  assert.ok(messages.some((m) => (m as { type?: string }).type === "totals:changed"));
});
