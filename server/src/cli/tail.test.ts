/**
 * End-to-end: `runTail` against a stand-in Argus — a bare HTTP server serving
 * canned JSON with ETags, and a `ws` server pushing frames — so the whole loop
 * (health, snapshot, follow, ping → re-read → diff, payload frames, window,
 * until-idle, interruption) is exercised without the real app or a filesystem.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { Run } from "@argus/contracts";
import { bundledSkillPath, installedSkillPath, runTail, type TailIo } from "./tail.js";
import type { TailOptions } from "./tailCore.js";

interface Fake {
  url: string;
  runs: Run[];
  overview: unknown[];
  agents: unknown[];
  activity: Record<string, unknown[]>;
  requests: { path: string; auth: string | null; ifNoneMatch: string | null }[];
  sockets: Set<WebSocket>;
  /** Total connections ever accepted, so a test can wait for *its* socket. */
  connections: number;
  push(frame: unknown): void;
  close(): Promise<void>;
  token: string | null;
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scheduleId: "sched-1",
    scheduleName: "Nightly triage",
    prompt: "p",
    cwd: "/repo",
    status: "running",
    trigger: "scheduled",
    queuedAt: "2026-07-07T10:20:00.000Z",
    startedAt: "2026-07-07T10:20:00.000Z",
    endedAt: null,
    durationMs: null,
    pid: 1,
    exitCode: null,
    sessionId: null,
    project: null,
    resultSummary: null,
    error: null,
    ...over,
  };
}

async function startFake(token: string | null = null): Promise<Fake> {
  const fake: Fake = {
    url: "",
    runs: [],
    overview: [],
    agents: [],
    activity: {},
    requests: [],
    sockets: new Set(),
    connections: 0,
    push: () => {},
    close: async () => {},
    token,
  };
  const etag = (body: string) => `"${createHash("sha1").update(body).digest("base64url")}"`;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const auth = req.headers.authorization ?? null;
    fake.requests.push({
      path: url.pathname + url.search,
      auth,
      ifNoneMatch: (req.headers["if-none-match"] as string | undefined) ?? null,
    });
    if (fake.token && auth !== `Bearer ${fake.token}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", code: "auth_required" }));
      return;
    }
    let body: unknown;
    const m = /^\/api\/runs\/([^/]+)\/activity$/.exec(url.pathname);
    if (url.pathname === "/api/health") body = { ok: true, version: "9.9.9", service: "argus" };
    else if (url.pathname === "/api/runs") body = { runs: fake.runs };
    else if (url.pathname === "/api/overview") body = { overview: fake.overview };
    else if (url.pathname === "/api/agents") body = { agents: fake.agents };
    else if (url.pathname === "/api/insight") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not today" }));
      return;
    } else if (m) body = { events: fake.activity[m[1]] ?? [] };
    else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const text = JSON.stringify(body);
    const tag = etag(text);
    if (req.headers["if-none-match"] === tag) {
      res.writeHead(304, { etag: tag });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", etag: tag });
    res.end(text);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (fake.token && req.headers.authorization !== `Bearer ${fake.token}`) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws) => {
    fake.connections++;
    fake.sockets.add(ws);
    ws.on("close", () => fake.sockets.delete(ws));
    ws.send(JSON.stringify({ type: "hello" }));
  });
  fake.push = (frame) => {
    const data = JSON.stringify(frame);
    for (const ws of fake.sockets) ws.send(data);
  };
  fake.close = async () => {
    for (const ws of fake.sockets) ws.terminate();
    wss.close();
    await new Promise<void>((r) => server.close(() => r()));
  };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  fake.url = `http://127.0.0.1:${addr.port}`;
  return fake;
}

function options(fake: Fake, over: Partial<TailOptions> = {}): TailOptions {
  return {
    url: fake.url,
    token: fake.token,
    forMs: 0,
    untilIdle: false,
    sinceMs: 30 * 60_000,
    json: false,
    context: 3,
    snapshot: true,
    installSkill: null,
    ...over,
  };
}

function io(over: Partial<TailIo> = {}): TailIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    fetch: globalThis.fetch,
    WebSocket,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    now: () => new Date(),
    refreshDebounceMs: 10,
    fallbackRefreshMs: 60_000,
    lines,
    errors,
    ...over,
  };
}

/** Generous by design: a coverage-instrumented run on a two-core CI runner is
 *  several times slower than a laptop, and a wait only lasts as long as it must. */
async function waitFor(pred: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
}

const strip = (l: string) => l.replace(/^\d\d:\d\d:\d\d /, "");

/** Waits for a connection accepted after `before`, and for it to be the only
 *  one left — the previous test's socket may still be closing. */
async function connected(fake: Fake, before: number): Promise<void> {
  await waitFor(() => fake.connections > before && fake.sockets.size === 1);
}

describe("runTail against a stand-in Argus", () => {
  let fake: Fake;
  before(async () => {
    fake = await startFake();
  });
  after(async () => {
    await fake.close();
  });

  it("prints a snapshot and stops when --for is 0", async () => {
    fake.runs = [run()];
    fake.activity = {
      "run-1": [
        { at: "2026-07-07T10:20:01.000Z", kind: "init", label: "session started" },
        { at: "2026-07-07T10:21:00.000Z", kind: "tool", label: "Bash: npm test" },
      ],
    };
    const o = io();
    const code = await runTail(options(fake), o);
    assert.equal(code, 0);
    const lines = o.lines.map(strip);
    assert.match(lines[0], /^▣ Argus 9\.9\.9 at http:\/\/127\.0\.0\.1:\d+ — 1 running$/);
    assert.match(lines[1], /^▶ Nightly triage · running .* · ⚙ Bash: npm test$/);
    assert.equal(lines[2], "  ○ session started");
    assert.equal(lines[3], "  ⚙ Bash: npm test");
    assert.match(lines[4], /^── snapshot only · 0 events · 1 still running$/);
    // The insight read failed with a 500 and the snapshot carried on without it.
    assert.ok(fake.requests.some((r) => r.path === "/api/insight"));
    assert.ok(fake.requests.some((r) => r.path === "/api/runs/run-1/activity"));
  });

  it("a bounded window closes the follow on its own", async () => {
    fake.runs = [run()];
    const o = io();
    const before = fake.connections;
    const done = runTail(options(fake, { forMs: 300, snapshot: false }), o);
    await connected(fake, before);
    assert.equal(await done, 0);
    const lines = o.lines.map(strip);
    assert.equal(lines[0], "👁 following live for 300ms");
    // Elapsed is measured from the first read, so a slow machine may round up.
    assert.match(
      lines[1],
      /^── followed for \d+(ms|s) · 0 events · 1 still running · run `argus tail` again to keep following$/,
    );
  });

  it("follows: pings become diffs and payload frames print, in order", async () => {
    fake.requests = [];
    fake.runs = [run()];
    fake.activity = {};
    // Ended by signal once everything expected has printed, not by a timer:
    // the assertions below must not depend on how fast the runner is.
    const controller = new AbortController();
    const o = io({ signal: controller.signal });
    const before = fake.connections;
    const done = runTail(options(fake, { forMs: null }), o);
    await connected(fake, before);
    // Something ran to completion and something new started.
    fake.runs = [
      run({ status: "succeeded", endedAt: "2026-07-07T10:29:00.000Z", durationMs: 540_000 }),
      run({ id: "run-2", scheduleName: "Deps audit", startedAt: "2026-07-07T10:29:30.000Z" }),
    ];
    fake.push({ type: "schedules:changed" });
    fake.push({ type: "sessions:changed" }); // narrates nothing
    await waitFor(() => o.lines.some((l) => l.includes("Deps audit started")));
    fake.push({
      type: "run:activity",
      runId: "run-2",
      events: [{ at: "2026-07-07T10:29:40.000Z", kind: "tool", label: "Read: README.md" }],
    });
    fake.push({
      type: "monitors:alert",
      alert: {
        event: "monitor.recovered",
        scheduleId: "s",
        name: "Hourly sync",
        status: "up",
        at: "2026-07-07T10:29:41.000Z",
        detail: "ran at 10:29",
      },
    });
    await waitFor(() => o.lines.some((l) => l.includes("Hourly sync")));
    controller.abort();
    const code = await done;
    assert.equal(code, 0);
    const lines = o.lines.map(strip);
    const follow = lines.indexOf("👁 following live (Ctrl-C to stop)");
    assert.ok(follow > 0, `no follow marker in ${lines.join("\n")}`);
    assert.deepEqual(lines.slice(follow + 1, -1), [
      "■ ✓ Nightly triage succeeded in 9m 00s",
      "▶ Deps audit started",
      "⚙ Deps audit · Read: README.md",
      '⚠ monitor "Hourly sync" recovered — ran at 10:29',
    ]);
    assert.match(lines[lines.length - 1], /^── stopped after .* · 4 events · 1 still running$/);
    // The second read of /api/runs was conditional, and the overview re-read
    // (unchanged) came back 304 without being counted as anything.
    const runReads = fake.requests.filter((r) => r.path === "/api/runs?limit=100");
    assert.ok(runReads.length >= 2);
    assert.equal(runReads[0].ifNoneMatch, null);
    assert.ok(runReads[1].ifNoneMatch !== null);
    // The client terminates its socket on exit; the server notices a tick later.
    await waitFor(() => fake.sockets.size === 0);
  });

  it("--until-idle returns as soon as the last run ends, and --json emits objects", async () => {
    fake.runs = [run()];
    const o = io();
    const before = fake.connections;
    const done = runTail(options(fake, { forMs: 10_000, untilIdle: true, json: true }), o);
    await connected(fake, before);
    fake.runs = [run({ status: "failed", endedAt: "2026-07-07T10:29:00.000Z", error: "boom" })];
    fake.push({ type: "pipelines:changed" });
    assert.equal(await done, 0);
    const objects = o.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(
      objects.map((x) => x.kind),
      ["snapshot.summary", "snapshot.running", "tail.start", "run.ended", "tail.end"],
    );
    const ended = objects[3];
    assert.equal(ended.runId, "run-1");
    assert.equal(ended.status, "failed");
    assert.equal(ended.error, "boom");
    assert.equal(objects[4].reason, "idle");
    assert.equal(objects[4].running, 0);
  });

  it("--until-idle with nothing running exits after the snapshot", async () => {
    fake.runs = [];
    const o = io();
    assert.equal(await runTail(options(fake, { forMs: 10_000, untilIdle: true }), o), 0);
    const lines = o.lines.map(strip);
    assert.equal(lines[1], "○ idle — nothing running, and nothing finished in the last 30m 00s");
    assert.match(lines[2], /^── idle after/);
  });

  it("an aborted signal ends the follow as an interruption", async () => {
    fake.runs = [run()];
    const controller = new AbortController();
    const o = io({ signal: controller.signal });
    const before = fake.connections;
    const done = runTail(options(fake, { forMs: null, snapshot: false }), o);
    await connected(fake, before);
    controller.abort();
    assert.equal(await done, 0);
    const lines = o.lines.map(strip);
    assert.equal(lines[0], "👁 following live (Ctrl-C to stop)");
    assert.match(lines[1], /^── stopped after .* · 0 events · 1 still running$/);
  });

  it("reconnects when the socket drops and re-reads what it missed", async () => {
    fake.runs = [run()];
    const controller = new AbortController();
    const o = io({ signal: controller.signal });
    const before = fake.connections;
    const done = runTail(options(fake, { forMs: null }), o);
    await connected(fake, before);
    for (const ws of fake.sockets) ws.terminate();
    fake.runs = [run({ status: "succeeded", endedAt: "2026-07-07T10:29:00.000Z" })];
    await waitFor(() => o.lines.some((l) => l.includes("Nightly triage succeeded")));
    controller.abort();
    assert.equal(await done, 0);
    const lines = o.lines.map(strip);
    assert.ok(lines.some((l) => l.startsWith("↻ live feed dropped — reconnecting")));
  });
});

describe("runTail failure modes", () => {
  it("explains an unreachable Argus and exits 1", async () => {
    const o = io();
    const code = await runTail(
      {
        url: "http://127.0.0.1:1",
        token: null,
        forMs: 0,
        untilIdle: false,
        sinceMs: 1,
        json: false,
        context: 0,
        snapshot: true,
        installSkill: null,
      },
      o,
    );
    assert.equal(code, 1);
    assert.equal(o.lines.length, 0);
    assert.match(
      o.errors[0],
      /no Argus answering at http:\/\/127\.0\.0\.1:1 .* start one with `argus`/,
    );
  });

  it("explains a missing token, and works once the token is supplied", async () => {
    const fake = await startFake("s3cret");
    try {
      const denied = io();
      assert.equal(await runTail(options(fake, { token: null }), denied), 1);
      assert.match(denied.errors[0], /wants a token — set ARGUS_TOKEN/);
      const ok = io();
      assert.equal(await runTail(options(fake), ok), 0);
      assert.match(ok.lines[0], /Argus 9\.9\.9/);
      assert.ok(fake.requests.every((r) => r.path !== "/api/health" || r.auth !== undefined));
    } finally {
      await fake.close();
    }
  });
});

describe("--install-skill", () => {
  const skillOptions = (installSkill: TailOptions["installSkill"]): TailOptions => ({
    url: "http://127.0.0.1:1",
    token: null,
    forMs: 0,
    untilIdle: false,
    sinceMs: 1,
    json: false,
    context: 0,
    snapshot: true,
    installSkill,
  });

  /** Fresh Claude and Codex homes for one test; restores the env afterwards. */
  async function withHomes(
    fn: (homes: { claude: string; codex: string }) => Promise<void>,
  ): Promise<void> {
    const homes = {
      claude: mkdtempSync(path.join(tmpdir(), "argus-skill-claude-")),
      codex: mkdtempSync(path.join(tmpdir(), "argus-skill-codex-")),
    };
    const prev = { claude: process.env.ARGUS_CLAUDE_HOME, codex: process.env.ARGUS_CODEX_HOME };
    process.env.ARGUS_CLAUDE_HOME = homes.claude;
    process.env.ARGUS_CODEX_HOME = homes.codex;
    try {
      await fn(homes);
    } finally {
      for (const [key, value] of [
        ["ARGUS_CLAUDE_HOME", prev.claude],
        ["ARGUS_CODEX_HOME", prev.codex],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const bundled = () => readFileSync(bundledSkillPath(), "utf8");

  it("bare: installs for every CLI found on PATH, and says which it skipped", async () => {
    await withHomes(async (homes) => {
      const o = io({ probe: (rt) => rt === "codex" });
      assert.equal(await runTail(skillOptions("auto"), o), 0);
      assert.equal(readFileSync(installedSkillPath("codex", homes.codex), "utf8"), bundled());
      assert.equal(existsSync(installedSkillPath("claude", homes.claude)), false);
      assert.match(o.lines[0], /installed the argus-tail skill for Codex at .*SKILL\.md/);
      assert.match(o.lines[1], /\$argus-tail in Codex/);
      assert.match(o.lines[2], /skipped Claude Code \(CLI not found on PATH\)/);
    });
  });

  it("bare with nothing on PATH falls back to Claude Code", async () => {
    await withHomes(async (homes) => {
      const o = io({ probe: () => false });
      assert.equal(await runTail(skillOptions("auto"), o), 0);
      assert.equal(readFileSync(installedSkillPath("claude", homes.claude), "utf8"), bundled());
      assert.equal(existsSync(installedSkillPath("codex", homes.codex)), false);
      assert.match(o.lines[1], /\/argus-tail in Claude Code/);
    });
  });

  it("=all installs both regardless of PATH; =codex installs one", async () => {
    await withHomes(async (homes) => {
      const both = io({ probe: () => false });
      assert.equal(await runTail(skillOptions("all"), both), 0);
      assert.equal(readFileSync(installedSkillPath("claude", homes.claude), "utf8"), bundled());
      assert.equal(readFileSync(installedSkillPath("codex", homes.codex), "utf8"), bundled());
      assert.equal(
        both.lines.filter((l) => l.includes("installed the argus-tail skill")).length,
        2,
      );
      assert.equal(
        both.lines.some((l) => l.includes("skipped")),
        false,
      );
    });
    await withHomes(async (homes) => {
      const one = io({ probe: () => true });
      assert.equal(await runTail(skillOptions("codex"), one), 0);
      assert.equal(existsSync(installedSkillPath("codex", homes.codex)), true);
      assert.equal(existsSync(installedSkillPath("claude", homes.claude)), false);
    });
  });

  it("the bundled skill is one file, readable from both the Claude and the Codex repo paths", () => {
    const viaAgents = path.resolve(
      path.dirname(bundledSkillPath()),
      "..",
      "..",
      "..",
      ".agents",
      "skills",
      "argus-tail",
      "SKILL.md",
    );
    assert.equal(readFileSync(viaAgents, "utf8"), bundled());
    assert.match(bundled(), /^---\nname: argus-tail\ndescription: .+\n---\n/);
  });
});
