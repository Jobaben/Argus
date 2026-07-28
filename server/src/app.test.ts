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
import type { AnalysisRunner } from "./sources/analysis.js";

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

test("registration is capped at 20 pending accounts, and freeing a slot re-opens it", async () => {
  const { app } = makeAuthApp();
  const register = (username: string) =>
    app.request("/api/auth/register", {
      method: "POST",
      headers: { ...loopback, "content-type": "application/json" },
      body: JSON.stringify({ username, password: "some password 123" }),
    });

  const boot = await register("Josha");
  assert.equal(boot.status, 201);
  const rootCookie = boot.headers.get("set-cookie")!.split(";")[0];

  for (let i = 0; i < 20; i++) {
    const res = await register(`pending${i}`);
    assert.equal(res.status, 201, `pending${i}`);
  }

  const overflow = await register("overflow");
  assert.equal(overflow.status, 429);

  // Root clears one pending account, freeing a slot.
  const reject = await app.request("/api/users/pending0/reject", {
    method: "POST",
    headers: { ...loopback, cookie: rootCookie },
  });
  assert.equal(reject.status, 200);

  const afterReject = await register("newcomer");
  assert.equal(afterReject.status, 201);
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

test("GET /api/monitors reflects schedule health from runs on disk", async () => {
  const app = makeApp();
  await app.request("/api/schedules", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({
      name: "Watcher",
      prompt: "p",
      cwd: home,
      trigger: { kind: "interval", everyMinutes: 60 },
    }),
  });
  const res = await app.request("/api/monitors", { headers: loopback });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    monitors: { name: string; status: string }[];
    summary: Record<string, number>;
  };
  assert.equal(body.monitors.length, 1);
  assert.equal(body.monitors[0].name, "Watcher");
  assert.equal(body.monitors[0].status, "pending"); // brand new, nothing owed yet
  assert.equal(body.summary.pending, 1);
});

function writeFailedRun(id: string, error: string) {
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  const iso = new Date().toISOString();
  writeFileSync(
    path.join(home, "argus", "runs", `${id}.json`),
    JSON.stringify({
      id,
      scheduleId: "s1",
      scheduleName: "Watcher",
      prompt: "p",
      cwd: "/tmp",
      status: "failed",
      trigger: "scheduled",
      queuedAt: iso,
      startedAt: iso,
      endedAt: iso,
      durationMs: 5,
      pid: null,
      exitCode: 1,
      sessionId: null,
      project: null,
      resultSummary: null,
      error,
    }),
  );
}

test("issues: grouped listing, triage lifecycle, and broadcast", async () => {
  const messages: unknown[] = [];
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: (m) => messages.push(m),
    serveWeb: false,
  });
  writeFailedRun("f1", "timeout after 42s");
  writeFailedRun("f2", "timeout after 7s");

  const list = (await (await app.request("/api/issues", { headers: loopback })).json()) as {
    issues: { fingerprint: string; count: number; state: string }[];
    summary: { open: number };
  };
  assert.equal(list.issues.length, 1);
  assert.equal(list.issues[0].count, 2);
  assert.equal(list.summary.open, 1);
  const fp = list.issues[0].fingerprint;

  const detail = (await (await app.request(`/api/issues/${fp}`, { headers: loopback })).json()) as {
    occurrences: unknown[];
  };
  assert.equal(detail.occurrences.length, 2);

  const resolve = await app.request(`/api/issues/${fp}/resolve`, {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(resolve.status, 200);
  assert.ok(messages.some((m) => (m as { type?: string }).type === "issues:changed"));

  const after = (await (await app.request("/api/issues", { headers: loopback })).json()) as {
    issues: { state: string }[];
  };
  assert.equal(after.issues[0].state, "resolved");

  const reopen = await app.request(`/api/issues/${fp}/reopen`, {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(reopen.status, 200);
  const reopened = (await (await app.request("/api/issues", { headers: loopback })).json()) as {
    issues: { state: string }[];
  };
  assert.equal(reopened.issues[0].state, "open");
});

test("issue triage on unknown or malformed fingerprints is a clean 4xx", async () => {
  const app = makeApp();
  const unknown = await app.request("/api/issues/aaaaaaaaaaaaaaaa/resolve", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(unknown.status, 404);
  const malformed = await app.request("/api/issues/..%2fevil/reopen", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(malformed.status, 400);
});

test("briefing: digest shape, ack round-trip, and broadcast", async () => {
  const messages: unknown[] = [];
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: (m) => messages.push(m),
    serveWeb: false,
  });
  writeFailedRun("b1", "kaboom");

  const first = (await (await app.request("/api/briefing", { headers: loopback })).json()) as {
    since: string;
    attention: { kind: string }[];
    attentionCount: number;
    window: { totalRuns: number; failures: { id: string }[] };
  };
  assert.equal(first.window.totalRuns, 1);
  assert.equal(first.window.failures[0].id, "b1");
  assert.ok(first.attention.some((a) => a.kind === "issue-open"));
  // No ack yet: since defaults to ~24h back.
  assert.ok(Date.now() - Date.parse(first.since) > 23 * 3_600_000);

  const ack = await app.request("/api/briefing/ack", { method: "POST", headers: sameOrigin });
  assert.equal(ack.status, 200);
  const ackBody = (await ack.json()) as { ok: boolean; ackAt: string };
  assert.equal(ackBody.ok, true);
  assert.ok(messages.some((m) => (m as { type?: string }).type === "briefing:changed"));

  const second = (await (await app.request("/api/briefing", { headers: loopback })).json()) as {
    since: string;
    window: { totalRuns: number };
  };
  assert.equal(second.since, ackBody.ackAt);
  assert.equal(second.window.totalRuns, 0); // the failed run predates the ack
});

test("POST /api/launch rejects invalid bodies with 400", async () => {
  const app = makeApp();
  const bad = await app.request("/api/launch", {
    method: "POST",
    headers: { host: "127.0.0.1:7777", "content-type": "application/json" },
    body: JSON.stringify({ cwd: home }),
  });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /prompt/);

  const noCwd = await app.request("/api/launch", {
    method: "POST",
    headers: { host: "127.0.0.1:7777", "content-type": "application/json" },
    body: JSON.stringify({ prompt: "p", cwd: "/definitely/not/a/dir" }),
  });
  assert.equal(noCwd.status, 400);
});

test("GET /api/budget returns config, status and a 30-day ledger", async () => {
  const app = makeApp();
  const res = await app.request("/api/budget", { headers: { host: "127.0.0.1:7777" } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    config: { dailyUsd: number | null };
    status: { state: string };
    days: unknown[];
  };
  assert.equal(body.config.dailyUsd, null);
  assert.equal(body.status.state, "unset");
  assert.equal(body.days.length, 30);
});

test("PUT /api/budget persists limits and rejects bad ones", async () => {
  const app = makeApp();
  const put = await app.request("/api/budget", {
    method: "PUT",
    headers: { host: "127.0.0.1:7777", "content-type": "application/json" },
    body: JSON.stringify({ dailyUsd: 25, blockScheduled: true }),
  });
  assert.equal(put.status, 200);
  const updated = (await put.json()) as { config: { dailyUsd: number; blockScheduled: boolean } };
  assert.equal(updated.config.dailyUsd, 25);
  assert.equal(updated.config.blockScheduled, true);

  const bad = await app.request("/api/budget", {
    method: "PUT",
    headers: { host: "127.0.0.1:7777", "content-type": "application/json" },
    body: JSON.stringify({ dailyUsd: -3 }),
  });
  assert.equal(bad.status, 400);
});

/** A completed run on disk, with whichever metrics the test cares about. */
function writeRunRecord(id: string, over: Record<string, unknown>) {
  mkdirSync(path.join(home, "argus", "runs"), { recursive: true });
  const iso = new Date().toISOString();
  writeFileSync(
    path.join(home, "argus", "runs", `${id}.json`),
    JSON.stringify({
      id,
      scheduleId: "s1",
      scheduleName: "Nightly triage",
      prompt: "p",
      cwd: "/tmp",
      status: "succeeded",
      trigger: "scheduled",
      queuedAt: iso,
      startedAt: iso,
      endedAt: iso,
      durationMs: 60_000,
      pid: null,
      exitCode: 0,
      sessionId: null,
      project: null,
      resultSummary: null,
      error: null,
      costUsd: 0.1,
      tokens: 1000,
      ...over,
    }),
  );
}

test("watchtower: a warm envelope with nothing out of place reports no anomalies", async () => {
  const app = makeApp();
  for (let i = 0; i < 12; i++) {
    writeRunRecord(`w${i}`, { durationMs: 60_000 + (i % 3) * 500, costUsd: 0.1 });
  }

  const warm = (await (await app.request("/api/watchtower", { headers: loopback })).json()) as {
    baselines: { key: string; warmupRemaining: number }[];
    anomalies: unknown[];
    summary: { ready: number };
  };
  assert.equal(warm.baselines.length, 1);
  assert.equal(warm.baselines[0].key, "schedule:s1");
  assert.equal(warm.baselines[0].warmupRemaining, 0);
  assert.equal(warm.summary.ready, 1);
  assert.equal(warm.anomalies.length, 0);
});

test("watchtower: a spike past warm-up is reported as a multiple, not a z-score", async () => {
  const app = makeApp();
  for (let i = 0; i < 12; i++) {
    writeRunRecord(`w${i}`, { durationMs: 60_000 + (i % 3) * 500, costUsd: 0.1 });
  }
  writeRunRecord("spike", { costUsd: 4.2 });

  const body = (await (await app.request("/api/watchtower", { headers: loopback })).json()) as {
    anomalies: { metric: string; detail: string; severity: string }[];
  };
  const cost = body.anomalies.find((a) => a.metric === "cost");
  assert.ok(cost, "the spike was reported");
  assert.match(cost.detail, /× median cost/);
  assert.equal(cost.severity, "critical");
});

test("watchtower: reset forgets prior history, restore brings it back, both broadcast", async () => {
  const messages: unknown[] = [];
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: (m) => messages.push(m),
    serveWeb: false,
  });
  for (let i = 0; i < 12; i++) writeRunRecord(`w${i}`, {});

  const reset = await app.request("/api/watchtower/schedule%3As1/reset", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(reset.status, 200);
  assert.ok(messages.some((m) => (m as { type?: string }).type === "watchtower:changed"));

  const emptied = (await (await app.request("/api/watchtower", { headers: loopback })).json()) as {
    baselines: unknown[];
  };
  assert.equal(emptied.baselines.length, 0, "every sample predates the reset");

  const restore = await app.request("/api/watchtower/schedule%3As1/reset", {
    method: "DELETE",
    headers: sameOrigin,
  });
  assert.equal(restore.status, 200);
  const restored = (await (await app.request("/api/watchtower", { headers: loopback })).json()) as {
    baselines: unknown[];
  };
  assert.equal(restored.baselines.length, 1);

  const again = await app.request("/api/watchtower/schedule%3As1/reset", {
    method: "DELETE",
    headers: sameOrigin,
  });
  assert.equal(again.status, 404, "clearing a reset that is not there is a clean 404");
});

test("watchtower: a key that could escape its namespace is a clean 400", async () => {
  const app = makeApp();
  const res = await app.request("/api/watchtower/..%2fevil/reset", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(res.status, 400);
});

test("briefing surfaces a critical anomaly as an attention item", async () => {
  const app = makeApp();
  for (let i = 0; i < 12; i++) writeRunRecord(`w${i}`, { durationMs: 60_000 + (i % 3) * 500 });
  writeRunRecord("spike", { costUsd: 4.2 });

  const body = (await (await app.request("/api/briefing", { headers: loopback })).json()) as {
    attention: { kind: string; detail: string }[];
    window: { anomalies: { metric: string }[] };
  };
  assert.ok(body.attention.some((a) => a.kind === "anomaly"));
  assert.ok(body.window.anomalies.some((a) => a.metric === "cost"));
});

// ── Autopsy ─────────────────────────────────────────────────────────────────

const AUTOPSY_ANSWER = JSON.stringify({
  failureClass: "tool-error",
  confidence: 0.8,
  why: "The build invoked a binary that is not installed in this environment, so the step exited non-zero.",
  span: { fromSeconds: 1, toSeconds: 2, quote: "1.0s tool [ERROR]" },
  promptDelta: "Install the toolchain first, then build.",
  deltaRationale: "Makes the missing prerequisite explicit.",
});

/** An analysis runner that always answers with the given parsed JSON text. */
function stubAnalysis(answerJson: string): AnalysisRunner {
  return {
    inFlight: () => 0,
    run: async (_req, parse) => {
      const value = parse(JSON.parse(answerJson));
      return value === null
        ? {
            ok: false,
            value: null,
            raw: answerJson,
            costUsd: 0.001,
            tokens: 100,
            durationMs: 5,
            failure: "unparseable" as const,
            error: "wrong shape",
          }
        : {
            ok: true,
            value,
            raw: answerJson,
            costUsd: 0.001,
            tokens: 100,
            durationMs: 5,
            failure: null,
            error: null,
          };
    },
  };
}

function makeAutopsyApp(answerJson = AUTOPSY_ANSWER) {
  return createApp({
    config,
    engine: fakeEngine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth: openAuth,
    analysis: stubAnalysis(answerJson),
  });
}

test("autopsy: a failed run gets a postmortem on demand and it is then readable", async () => {
  const app = makeAutopsyApp();
  writeFailedRun("bad1", "spawn tsc ENOENT");

  const before = (await (
    await app.request("/api/runs/bad1/autopsy", { headers: loopback })
  ).json()) as { autopsy: unknown; eligible: boolean };
  assert.equal(before.autopsy, null);
  assert.equal(before.eligible, true);

  const made = await app.request("/api/runs/bad1/autopsy", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(made.status, 200);
  const body = (await made.json()) as {
    autopsy: {
      status: string;
      failureClass: string;
      promptDelta: string;
      span: { fromMs: number };
    };
  };
  assert.equal(body.autopsy.status, "ready");
  assert.equal(body.autopsy.failureClass, "tool-error");
  // This run has no transcript, so its recording is zero-length and the model's
  // "at one second" is clamped rather than pointing off the end of the track.
  assert.equal(body.autopsy.span.fromMs, 0);
  assert.match(body.autopsy.promptDelta, /Install the toolchain/);

  const after = (await (
    await app.request("/api/runs/bad1/autopsy", { headers: loopback })
  ).json()) as { autopsy: { status: string } | null };
  assert.equal(after.autopsy?.status, "ready");
});

test("autopsy: a successful run is not eligible and cannot be forced", async () => {
  const app = makeAutopsyApp();
  writeRunRecord("good", {});
  const read = (await (
    await app.request("/api/runs/good/autopsy", { headers: loopback })
  ).json()) as { eligible: boolean; unavailable: string };
  assert.equal(read.eligible, false);
  assert.match(read.unavailable, /did not fail/);

  const forced = await app.request("/api/runs/good/autopsy", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(forced.status, 409);
});

test("autopsy: an unknown run is a clean 404 on both verbs", async () => {
  const app = makeAutopsyApp();
  assert.equal((await app.request("/api/runs/nope/autopsy", { headers: loopback })).status, 404);
  assert.equal(
    (await app.request("/api/runs/nope/autopsy", { method: "POST", headers: sameOrigin })).status,
    404,
  );
});

test("autopsy: producing one and relaunching both require an admin session", async () => {
  const lockedOut: AuthService = {
    isConfigured: async () => true,
    status: async () => ({ configured: true, username: null, role: null }),
    login: async () => ({ ok: false, reason: "bad-credentials" }),
    verify: () => null,
    logout: () => {},
    revokeSessions: () => {},
  };
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth: lockedOut,
    analysis: stubAnalysis(AUTOPSY_ANSWER),
  });
  writeFailedRun("bad2", "boom");

  // Reading stays open — the dashboard works signed out.
  assert.equal((await app.request("/api/runs/bad2/autopsy", { headers: loopback })).status, 200);
  assert.equal(
    (await app.request("/api/runs/bad2/autopsy", { method: "POST", headers: sameOrigin })).status,
    401,
  );
  assert.equal(
    (await app.request("/api/runs/bad2/relaunch", { method: "POST", headers: sameOrigin })).status,
    401,
  );
});

test("relaunch refuses when there is no proposed prompt to relaunch with", async () => {
  const app = makeAutopsyApp();
  writeFailedRun("bad3", "boom");
  const res = await app.request("/api/runs/bad3/relaunch", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 409);
});

test("issues: a clustered issue's detail lists every member's occurrences", async () => {
  const app = makeAutopsyApp();
  // Two differently-worded failures that string grouping keeps apart.
  writeFailedRun("c1", "registry request timed out contacting mirror");
  writeFailedRun("c2", "registry request timed out contacting upstream proxy");

  const plain = (await (await app.request("/api/issues", { headers: loopback })).json()) as {
    issues: { fingerprint: string; count: number; members: string[] }[];
  };
  assert.equal(plain.issues.length, 2, "with no autopsies, string grouping stands");

  // Diagnose both as the same class; the pair then clusters.
  for (const id of ["c1", "c2"]) {
    const res = await app.request(`/api/runs/${id}/autopsy`, {
      method: "POST",
      headers: sameOrigin,
    });
    assert.equal(res.status, 200);
  }

  const clustered = (await (await app.request("/api/issues", { headers: loopback })).json()) as {
    issues: { fingerprint: string; count: number; members: string[]; failureClass: string }[];
  };
  assert.equal(clustered.issues.length, 1);
  assert.equal(clustered.issues[0].count, 2);
  assert.equal(clustered.issues[0].failureClass, "tool-error");

  const detail = (await (
    await app.request(`/api/issues/${clustered.issues[0].fingerprint}`, { headers: loopback })
  ).json()) as { occurrences: unknown[] };
  assert.equal(detail.occurrences.length, 2, "both members' occurrences are listed");
});

// ── Verdict ─────────────────────────────────────────────────────────────────

const RUBRIC = {
  goal: "Names every failure and proposes one next step each.",
  criteria: [
    { id: "coverage", label: "Names every new failure", weight: 2 },
    { id: "actionable", label: "Proposes a concrete next step" },
  ],
  minScore: 6,
};

const VERDICT_ANSWER = JSON.stringify({
  criteria: [
    { id: "coverage", score: 8, note: "Both named." },
    { id: "actionable", score: 6, note: "One missing." },
  ],
  summary: "Solid but incomplete.",
});

function writeSchedule(over: Record<string, unknown>) {
  mkdirSync(path.join(home, "argus"), { recursive: true });
  const iso = new Date().toISOString();
  writeFileSync(
    path.join(home, "argus", "schedules.json"),
    JSON.stringify([
      {
        id: "s1",
        name: "Nightly triage",
        prompt: "p",
        cwd: home,
        trigger: { kind: "interval", everyMinutes: 60 },
        enabled: true,
        overlapPolicy: "skip",
        createdAt: iso,
        updatedAt: iso,
        lastRunAt: null,
        lastRunId: null,
        ...over,
      },
    ]),
  );
}

test("verdict: a run under a rubric is scored, and the score is computed from the weights", async () => {
  const app = makeAutopsyApp(VERDICT_ANSWER);
  writeSchedule({ rubric: RUBRIC });
  writeRunRecord("scored", { resultSummary: "Two failures found." });

  const before = (await (
    await app.request("/api/runs/scored/verdict", { headers: loopback })
  ).json()) as { verdict: unknown; rubric: { goal: string } | null };
  assert.equal(before.verdict, null);
  assert.ok(before.rubric);

  const made = await app.request("/api/runs/scored/verdict", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(made.status, 200);
  const body = (await made.json()) as {
    verdict: { status: string; score: number; regression: boolean; criteria: unknown[] };
  };
  assert.equal(body.verdict.status, "ready");
  // (8*2 + 6*1) / 3 = 7.3 — ours, not the model's.
  assert.equal(body.verdict.score, 7.3);
  assert.equal(body.verdict.regression, false);
  assert.equal(body.verdict.criteria.length, 2);
});

test("verdict: a run with no rubric says so, and cannot be forced", async () => {
  const app = makeAutopsyApp(VERDICT_ANSWER);
  writeSchedule({});
  writeRunRecord("unscored", {});

  const read = (await (
    await app.request("/api/runs/unscored/verdict", { headers: loopback })
  ).json()) as { rubric: unknown; unavailable: string };
  assert.equal(read.rubric, null);
  assert.match(read.unavailable, /no rubric/);

  const forced = await app.request("/api/runs/unscored/verdict", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(forced.status, 409);
});

test("verdict: scoring requires an admin session; reading does not", async () => {
  const lockedOut: AuthService = {
    isConfigured: async () => true,
    status: async () => ({ configured: true, username: null, role: null }),
    login: async () => ({ ok: false, reason: "bad-credentials" }),
    verify: () => null,
    logout: () => {},
    revokeSessions: () => {},
  };
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth: lockedOut,
    analysis: stubAnalysis(VERDICT_ANSWER),
  });
  writeSchedule({ rubric: RUBRIC });
  writeRunRecord("gated", {});

  assert.equal((await app.request("/api/runs/gated/verdict", { headers: loopback })).status, 200);
  assert.equal(
    (await app.request("/api/runs/gated/verdict", { method: "POST", headers: sameOrigin })).status,
    401,
  );
});

test("verdict: trends carry the live threshold, not the one stored with the score", async () => {
  const app = makeAutopsyApp(VERDICT_ANSWER);
  writeSchedule({ rubric: RUBRIC });
  writeRunRecord("t1", {});
  await app.request("/api/runs/t1/verdict", { method: "POST", headers: sameOrigin });

  // The author tightens the bar after the fact.
  writeSchedule({ rubric: { ...RUBRIC, minScore: 9 } });
  const body = (await (await app.request("/api/verdicts", { headers: loopback })).json()) as {
    trends: { key: string; latest: number; minScore: number }[];
    summary: { scored: number };
  };
  assert.equal(body.trends.length, 1);
  assert.equal(body.trends[0].key, "schedule:s1");
  assert.equal(body.trends[0].minScore, 9, "the new line applies to the old history");
  assert.equal(body.summary.scored, 1);
});

test("verdict: a quality regression opens an issue even though the run exited 0", async () => {
  const low = JSON.stringify({
    criteria: [
      { id: "coverage", score: 2, note: "misses most" },
      { id: "actionable", score: 1, note: "none" },
    ],
  });
  const app = makeAutopsyApp(low);
  writeSchedule({ rubric: RUBRIC });
  writeRunRecord("bad-quality", { status: "succeeded", exitCode: 0, error: null });

  const before = (await (await app.request("/api/issues", { headers: loopback })).json()) as {
    issues: unknown[];
  };
  assert.equal(before.issues.length, 0, "a clean exit is not an issue on its own");

  await app.request("/api/runs/bad-quality/verdict", { method: "POST", headers: sameOrigin });

  const after = (await (await app.request("/api/issues", { headers: loopback })).json()) as {
    issues: { title: string; count: number }[];
  };
  assert.equal(after.issues.length, 1);
  assert.match(after.issues[0].title, /quality below the bar for Nightly triage/);
});

test("schedules: an invalid rubric is a clean 400, not a 500", async () => {
  const app = makeApp();
  const res = await app.request("/api/schedules", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({
      name: "n",
      prompt: "p",
      cwd: home,
      trigger: { kind: "interval", everyMinutes: 60 },
      rubric: { goal: "g", criteria: [{ id: "Bad Id", label: "x" }] },
    }),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /slug/);
});

test("pipelines: autoApprove without a rubric on the same phase is a clean 400", async () => {
  const app = makeApp();
  const res = await app.request("/api/pipelines", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({
      name: "p",
      trigger: null,
      phases: [
        {
          id: "build",
          name: "Build",
          cwd: home,
          gated: true,
          steps: [{ name: "s", prompt: "p" }],
          autoApprove: { verdict: 8 },
        },
      ],
    }),
  });
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /needs a rubric/);
});

// ── Sentinel ────────────────────────────────────────────────────────────────

function writeIncidentFile(over: Record<string, unknown> = {}) {
  mkdirSync(path.join(home, "argus"), { recursive: true });
  const iso = new Date().toISOString();
  writeFileSync(
    path.join(home, "argus", "incidents.json"),
    JSON.stringify([
      {
        id: "inc1",
        key: "monitor:s1",
        source: "monitor-down",
        severity: "critical",
        title: "Nightly triage",
        detail: "no run covered the expected slot",
        status: "open",
        openedAt: iso,
        updatedAt: iso,
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        level: 0,
        nextEscalationAt: null,
        timeline: [{ at: iso, kind: "opened", detail: "opened", by: "sentinel" }],
        diagnosis: null,
        scheduleId: "s1",
        runId: null,
        fingerprint: null,
        ...over,
      },
    ]),
  );
}

test("sentinel: default policy is served, and updates round-trip", async () => {
  const app = makeApp();
  const initial = (await (await app.request("/api/sentinel", { headers: loopback })).json()) as {
    policy: { enabled: boolean; autoDiagnose: boolean; levels: unknown[] };
    incidents: unknown[];
    inQuietHours: boolean;
  };
  assert.equal(initial.policy.enabled, true);
  assert.equal(initial.policy.autoDiagnose, false, "spawning agents is never the default");
  assert.ok(initial.policy.levels.length >= 2);
  assert.deepEqual(initial.incidents, []);
  assert.equal(initial.inQuietHours, false);

  const put = await app.request("/api/sentinel/policy", {
    method: "PUT",
    headers: sameOrigin,
    body: JSON.stringify({ autoDiagnose: true, quietHours: { start: "22:00", end: "07:00" } }),
  });
  assert.equal(put.status, 200);
  const after = (await (await app.request("/api/sentinel", { headers: loopback })).json()) as {
    policy: { autoDiagnose: boolean; quietHours: { start: string } };
  };
  assert.equal(after.policy.autoDiagnose, true);
  assert.equal(after.policy.quietHours.start, "22:00");
});

test("sentinel: an unusable policy is a clean 400", async () => {
  const app = makeApp();
  const res = await app.request("/api/sentinel/policy", {
    method: "PUT",
    headers: sameOrigin,
    body: JSON.stringify({ quietHours: { start: "99:99", end: "07:00" } }),
  });
  assert.equal(res.status, 400);
});

test("sentinel: acknowledge, note and resolve record who did them", async () => {
  const app = makeApp();
  writeIncidentFile();

  const ack = await app.request("/api/incidents/inc1/ack", { method: "POST", headers: sameOrigin });
  assert.equal(ack.status, 200);
  const acked = (await ack.json()) as { incident: { status: string; acknowledgedBy: string } };
  assert.equal(acked.incident.status, "acknowledged");
  assert.equal(acked.incident.acknowledgedBy, "test");

  const note = await app.request("/api/incidents/inc1/note", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({ note: "PATH fixed on the host" }),
  });
  assert.equal(note.status, 200);
  const noted = (await note.json()) as {
    incident: { timeline: { kind: string; detail: string; by: string }[] };
  };
  const last = noted.incident.timeline.at(-1);
  assert.equal(last?.kind, "note");
  assert.equal(last?.by, "user:test");

  const resolved = await app.request("/api/incidents/inc1/resolve", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({ note: "done" }),
  });
  assert.equal(
    ((await resolved.json()) as { incident: { status: string } }).incident.status,
    "resolved",
  );
});

test("sentinel: an empty note is refused, and an unknown incident is a 404", async () => {
  const app = makeApp();
  writeIncidentFile();
  const empty = await app.request("/api/incidents/inc1/note", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({ note: "   " }),
  });
  assert.equal(empty.status, 400);

  for (const action of ["ack", "resolve", "note", "diagnose"]) {
    const res = await app.request(`/api/incidents/nope/${action}`, {
      method: "POST",
      headers: sameOrigin,
      body: JSON.stringify({ note: "x" }),
    });
    assert.equal(res.status, 404, `${action} on an unknown incident`);
  }
});

test("sentinel: the diagnostic attaches findings and a proposal, and changes nothing else", async () => {
  const app = makeAutopsyApp(
    JSON.stringify({
      findings: "The CLI is not on PATH.",
      remediation: "Fix PATH and re-run.",
      confidence: 0.7,
    }),
  );
  writeIncidentFile();

  const res = await app.request("/api/incidents/inc1/diagnose", {
    method: "POST",
    headers: sameOrigin,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    incident: {
      status: string;
      diagnosis: { status: string; findings: string; remediation: string };
      timeline: { kind: string }[];
    };
  };
  assert.equal(body.incident.diagnosis.status, "ready");
  assert.match(body.incident.diagnosis.findings, /not on PATH/);
  assert.match(body.incident.diagnosis.remediation, /Fix PATH/);
  assert.ok(body.incident.timeline.some((e) => e.kind === "diagnosed"));
  // A proposal, not an action: the incident is still open and unacknowledged.
  assert.equal(body.incident.status, "open");
});

test("sentinel: incident actions require an admin session; reading does not", async () => {
  const lockedOut: AuthService = {
    isConfigured: async () => true,
    status: async () => ({ configured: true, username: null, role: null }),
    login: async () => ({ ok: false, reason: "bad-credentials" }),
    verify: () => null,
    logout: () => {},
    revokeSessions: () => {},
  };
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth: lockedOut,
  });
  writeIncidentFile();

  assert.equal((await app.request("/api/sentinel", { headers: loopback })).status, 200);
  for (const action of ["ack", "resolve", "note", "diagnose"]) {
    const res = await app.request(`/api/incidents/inc1/${action}`, {
      method: "POST",
      headers: sameOrigin,
      body: JSON.stringify({ note: "x" }),
    });
    assert.equal(res.status, 401, `${action} without a session`);
  }
  assert.equal(
    (
      await app.request("/api/sentinel/policy", {
        method: "PUT",
        headers: sameOrigin,
        body: JSON.stringify({ enabled: false }),
      })
    ).status,
    401,
  );
});

// ── Weave ───────────────────────────────────────────────────────────────────

const dagPhase = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  cwd: home,
  gated: false,
  steps: [{ name: "s", prompt: "p" }],
  ...over,
});

async function postPipeline(app: ReturnType<typeof makeApp>, phases: unknown[]) {
  return app.request("/api/pipelines", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({ name: "P", trigger: null, phases }),
  });
}

test("weave: a valid diamond is accepted and its edges round-trip", async () => {
  const app = makeApp();
  const res = await postPipeline(app, [
    dagPhase("plan"),
    dagPhase("build", { needs: ["plan"] }),
    dagPhase("test", { needs: ["plan"] }),
    dagPhase("ship", { needs: ["build", "test"], produces: "release" }),
  ]);
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    phases: { id: string; needs?: string[]; produces?: string }[];
  };
  assert.deepEqual(body.phases[3].needs, ["build", "test"]);
  assert.equal(body.phases[3].produces, "release");
});

test("weave: a cycle is a clean 400 at authoring time, not a run that never finishes", async () => {
  const app = makeApp();
  const res = await postPipeline(app, [
    dagPhase("a", { needs: ["b"] }),
    dagPhase("b", { needs: ["a"] }),
  ]);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /cycle/);
});

test("weave: a dependency that does not exist is named in the error", async () => {
  const app = makeApp();
  const res = await postPipeline(app, [dagPhase("a"), dagPhase("b", { needs: ["ghost"] })]);
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /needs "ghost"/);
});

test("weave: retry policies are validated, and a bad one is a 400", async () => {
  const app = makeApp();
  const ok = await postPipeline(app, [
    dagPhase("a", { retry: { attempts: 3, backoffSeconds: 15, retryOn: ["exit-code"] } }),
  ]);
  assert.equal(ok.status, 201);
  const body = (await ok.json()) as { phases: { retry: { attempts: number } }[] };
  assert.equal(body.phases[0].retry.attempts, 3);

  for (const bad of [
    { attempts: 0, backoffSeconds: 1 },
    { attempts: 99, backoffSeconds: 1 },
    { attempts: 2, backoffSeconds: -1 },
    { attempts: 2, backoffSeconds: 1, retryOn: ["whenever"] },
  ]) {
    const res = await postPipeline(app, [dagPhase("a", { retry: bad })]);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test("weave: an artifact name that could break interpolation is refused", async () => {
  const app = makeApp();
  const res = await postPipeline(app, [dagPhase("a", { produces: "not a name!" })]);
  assert.equal(res.status, 400);
});

test("weave: a pre-Weave linear definition is still accepted unchanged", async () => {
  const app = makeApp();
  const res = await postPipeline(app, [dagPhase("a"), dagPhase("b"), dagPhase("c")]);
  assert.equal(res.status, 201);
  const body = (await res.json()) as { phases: { needs?: string[] }[] };
  // Nothing is written back onto the definition: the linear reading is applied
  // at execution time, so the file stays exactly what the author wrote.
  assert.equal(body.phases[1].needs, undefined);
});

test("weave: an instance's journal is readable, and unknown ids are empty rather than errors", async () => {
  const app = makeApp();
  const res = await app.request("/api/instances/never-existed/journal", { headers: loopback });
  assert.equal(res.status, 200);
  assert.deepEqual(((await res.json()) as { entries: unknown[] }).entries, []);
});

// ── Ledger ──────────────────────────────────────────────────────────────────

test("ledger: attributes spend by every dimension and windows the runs", async () => {
  const app = makeApp();
  writeRunRecord("l1", { costUsd: 0.6, model: "opus", scheduleId: "s1", scheduleName: "A" });
  writeRunRecord("l2", { costUsd: 0.4, model: "haiku", scheduleId: "s2", scheduleName: "B" });

  const body = (await (await app.request("/api/ledger", { headers: loopback })).json()) as {
    windowDays: number;
    bySchedule: { slices: { key: string; usd: number; share: number }[]; totalUsd: number };
    byModel: { slices: { key: string }[] };
    forecast: { note: string };
    enforcement: { action: string | null };
  };
  assert.equal(body.windowDays, 30);
  assert.equal(body.bySchedule.totalUsd, 1);
  assert.equal(body.bySchedule.slices[0].key, "s1");
  assert.equal(body.bySchedule.slices[0].share, 0.6);
  assert.deepEqual(body.byModel.slices.map((s) => s.key).sort(), ["haiku", "opus"]);
  assert.match(body.forecast.note, /not enough to project|On this pace/);
  assert.equal(body.enforcement.action, null);
});

test("ledger: what-if refuses to guess when the target model has never run here", async () => {
  const app = makeApp();
  writeRunRecord("l1", { costUsd: 1, model: "opus", scheduleId: "s1" });

  const res = await app.request("/api/ledger/what-if", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({ dimension: "schedule", key: "s1", toModel: "haiku" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; unavailable: string };
  assert.equal(body.ok, false);
  assert.match(body.unavailable, /never from a price list/);
});

test("ledger: what-if computes the saving from observed costs on both models", async () => {
  const app = makeApp();
  writeRunRecord("l1", { costUsd: 1, model: "opus", scheduleId: "s1" });
  writeRunRecord("l2", { costUsd: 1, model: "opus", scheduleId: "s1" });
  writeRunRecord("l3", { costUsd: 0.1, model: "haiku", scheduleId: "s2" });

  const body = (await (
    await app.request("/api/ledger/what-if", {
      method: "POST",
      headers: sameOrigin,
      body: JSON.stringify({ dimension: "schedule", key: "s1", toModel: "haiku" }),
    })
  ).json()) as { ok: boolean; monthlySavingUsd: number; summary: string; verdictDelta: null };
  assert.equal(body.ok, true);
  assert.ok(body.monthlySavingUsd > 0);
  assert.equal(body.verdictDelta, null, "nothing has been scored, so quality is unmeasured");
  assert.match(body.summary, /saves \$/);
});

test("ledger: a malformed what-if is a clean 400", async () => {
  const app = makeApp();
  for (const bad of [
    { dimension: "nope", key: "s1", toModel: "haiku" },
    { dimension: "schedule", toModel: "haiku" },
    { dimension: "schedule", key: "s1" },
    { dimension: "schedule", key: "s1", toModel: "a/b;rm -rf" },
  ]) {
    const res = await app.request("/api/ledger/what-if", {
      method: "POST",
      headers: sameOrigin,
      body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test("budget: a ladder round-trips, sorted, and a bad one is a 400", async () => {
  const app = makeApp();
  const put = await app.request("/api/budget", {
    method: "PUT",
    headers: sameOrigin,
    body: JSON.stringify({
      dailyUsd: 10,
      ladder: [
        { atRatio: 1, action: "stop" },
        { atRatio: 0.8, action: "warn" },
        { atRatio: 0.9, action: "downgrade", model: "haiku" },
      ],
    }),
  });
  assert.equal(put.status, 200);
  const body = (await put.json()) as { config: { ladder: { action: string }[] } };
  assert.deepEqual(
    body.config.ladder.map((s) => s.action),
    ["warn", "downgrade", "stop"],
    "sorted by threshold, so it reads as it engages",
  );

  const bad = await app.request("/api/budget", {
    method: "PUT",
    headers: sameOrigin,
    body: JSON.stringify({ ladder: [{ atRatio: 0.9, action: "downgrade" }] }),
  });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /needs a model/);
});

test("budget: the ladder's enforcement is reported on the ledger once spend crosses it", async () => {
  const app = makeApp();
  // A $1 limit with $2 spent today: the top step is in force.
  writeRunRecord("l1", { costUsd: 2 });
  mkdirSync(path.join(home, "argus"), { recursive: true });
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  writeFileSync(
    path.join(home, "argus", "spend.json"),
    JSON.stringify({ days: { [key]: { usd: 2, tokens: 100, runs: 1 } } }),
  );
  writeFileSync(
    path.join(home, "argus", "budget.json"),
    JSON.stringify({
      dailyUsd: 1,
      monthlyUsd: null,
      blockScheduled: false,
      ladder: [
        { atRatio: 0.8, action: "warn" },
        { atRatio: 1, action: "defer" },
      ],
      updatedAt: null,
    }),
  );

  const body = (await (await app.request("/api/ledger", { headers: loopback })).json()) as {
    enforcement: { action: string; window: string; detail: string };
  };
  assert.equal(body.enforcement.action, "defer", "the highest matching step, not the first");
  assert.equal(body.enforcement.window, "daily");
  assert.match(body.enforcement.detail, /deferred/);
});

// ── The Vault ───────────────────────────────────────────────────────────────

/** Ingest whatever is currently on disk, the way the tick does. */
async function fillVault() {
  const { closeVault } = await import("./vault/db.js");
  const { ingest } = await import("./vault/ingest.js");
  const { readRuns } = await import("./sources/runs.js");
  closeVault();
  return ingest({
    runs: await readRuns(),
    incidents: [],
    anomalies: [],
    verdicts: [],
    spend: { days: {} },
    now: new Date(),
  });
}

test("vault: reports what it holds, and how much of it the JSON files have dropped", async () => {
  const app = makeApp();
  writeRunRecord("v1", { costUsd: 0.3, resultSummary: "indexed the widget catalogue" });
  assert.equal((await fillVault()).ok, true);

  const status = (await (await app.request("/api/vault", { headers: loopback })).json()) as {
    available: boolean;
    rows: { runs: number };
    beyondRetention: number;
    detail: string;
  };
  assert.equal(status.available, true);
  assert.equal(status.rows.runs, 1);
  // The run is still on disk, so nothing is beyond retention yet.
  assert.equal(status.beyondRetention, 0);
});

test("vault: search finds an ingested run and says what it searched", async () => {
  const app = makeApp();
  writeRunRecord("v1", { resultSummary: "indexed the widget catalogue" });
  await fillVault();

  const res = (await (
    await app.request("/api/vault/search?q=widget", { headers: loopback })
  ).json()) as { available: boolean; hits: { ref: string; related: boolean }[] };
  assert.equal(res.available, true);
  assert.deepEqual(
    res.hits.map((h) => h.ref),
    ["v1"],
  );
  assert.equal(res.hits[0].related, false);
});

test("vault: an empty query is answered, not rejected", async () => {
  const app = makeApp();
  const res = await app.request("/api/vault/search", { headers: loopback });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { hits: unknown[]; detail: string };
  assert.deepEqual(body.hits, []);
  assert.match(body.detail, /two characters/);
});

test("vault: quarters aggregate the ingested history", async () => {
  const app = makeApp();
  writeRunRecord("v1", { costUsd: 0.25 });
  await fillVault();
  const body = (await (await app.request("/api/vault/quarters", { headers: loopback })).json()) as {
    available: boolean;
    quarters: { runs: number; costUsd: number }[];
  };
  assert.equal(body.available, true);
  assert.equal(body.quarters.length, 1);
  assert.equal(body.quarters[0].runs, 1);
  assert.equal(body.quarters[0].costUsd, 0.25);
});

test("vault: the OTLP export is a valid document with derived, stable ids", async () => {
  const app = makeApp();
  writeRunRecord("v1", {});
  await fillVault();
  const first = (await (
    await app.request("/api/vault/otel?days=30", { headers: loopback })
  ).json()) as {
    spans: number;
    days: number;
    capped: boolean;
    resourceSpans: { scopeSpans: { spans: { traceId: string; spanId: string }[] }[] }[];
  };
  assert.equal(first.spans, 1);
  assert.equal(first.days, 30);
  assert.equal(first.capped, false);
  const span = first.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.traceId.length, 32);
  assert.equal(span.spanId.length, 16);

  // Exporting twice must be byte-identical, so a collector receiving both
  // deduplicates rather than double-counting the same run.
  const second = await (await app.request("/api/vault/otel?days=30", { headers: loopback })).json();
  assert.deepEqual(second, first);
});

test("vault: the Chronicle reaches past JSON retention, with live records winning", async () => {
  const app = makeApp();
  writeRunRecord("kept", { resultSummary: "still on disk" });
  await fillVault();

  // The Vault now holds "kept". A long window must not double-count it.
  const long = (await (
    await app.request("/api/chronicle?hours=8760", { headers: loopback })
  ).json()) as { groups: { rows: { id: string }[][] }[] };
  const ids = long.groups.flatMap((g) => g.rows.flat().map((s) => s.id));
  assert.equal(ids.filter((id) => id === "run:kept").length, 1);
});

test("vault: a disabled Vault degrades every long view without erroring", async () => {
  const app = makeApp();
  process.env.ARGUS_VAULT = "off";
  const { closeVault } = await import("./vault/db.js");
  closeVault();
  try {
    const status = (await (await app.request("/api/vault", { headers: loopback })).json()) as {
      available: boolean;
      reason: string;
    };
    assert.equal(status.available, false);
    assert.equal(status.reason, "disabled");

    for (const route of ["/api/vault/quarters", "/api/vault/search?q=widget", "/api/vault/otel"]) {
      assert.equal((await app.request(route, { headers: loopback })).status, 200, route);
    }
    // The Chronicle still answers from the JSON files it does have.
    assert.equal(
      (await app.request("/api/chronicle?hours=8760", { headers: loopback })).status,
      200,
    );
  } finally {
    delete process.env.ARGUS_VAULT;
    closeVault();
  }
});
