/**
 * `runGate` against an injected `fetch`: the login → gate call → logout
 * sequence, what each header carries, and how every refusal reads. No server,
 * no terminal, no filesystem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runGate, type GateIo } from "./gate.js";
import type { GateOptions } from "./gateCore.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (seen: Seen) => Response | undefined;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A stand-in Argus: logs in anyone with the right password, records calls. */
function fakeArgus(over: { password?: string; gate?: Handler; loginStatus?: Response } = {}) {
  const calls: Seen[] = [];
  const password = over.password ?? "pw";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const seen: Seen = { url, method: init?.method ?? "GET", headers, body };
    calls.push(seen);
    if (url.endsWith("/api/auth/login")) {
      if (over.loginStatus) return over.loginStatus;
      if (body?.password !== password) {
        return json(401, { error: "invalid username or password" });
      }
      return json(
        200,
        { ok: true, username: body.username, expiresAt: "2026-01-01T00:00:00.000Z" },
        { "set-cookie": "argus_session=sess-1; Path=/; HttpOnly; SameSite=Strict" },
      );
    }
    if (url.endsWith("/api/auth/logout")) return json(200, { ok: true });
    const handled = over.gate?.(seen);
    if (handled) return handled;
    if (headers["x-argus-session"] !== "sess-1") return json(401, { error: "login required" });
    return json(200, { ok: true });
  };
  return { fetch, calls };
}

function io(fetch: typeof globalThis.fetch, over: Partial<GateIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const gateIo: GateIo = {
    fetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    isTTY: false,
    prompt: async () => {
      throw new Error("prompt must not be called");
    },
    env: { ARGUS_USER: "usha", ARGUS_PASSWORD: "pw" } as NodeJS.ProcessEnv,
    ...over,
  };
  return { io: gateIo, out, err };
}

const approve: GateOptions = {
  verb: "approve",
  instanceId: "inst-1",
  phaseId: "review",
  note: null,
  url: "http://argus.test",
  token: "shared",
  json: false,
};

describe("runGate", () => {
  it("logs in, approves with the session header, logs out, and says so", async () => {
    const fake = fakeArgus();
    const my = io(fake.fetch);
    assert.equal(await runGate(approve, my.io), 0);
    assert.deepEqual(
      fake.calls.map((c) => [c.method, new URL(c.url).pathname]),
      [
        ["POST", "/api/auth/login"],
        ["POST", "/api/instances/inst-1/approve"],
        ["POST", "/api/auth/logout"],
      ],
    );
    const [login, gate, logout] = fake.calls;
    assert.equal(login.headers.authorization, "Bearer shared", "the shared token rides every call");
    assert.deepEqual(login.body, { username: "usha", password: "pw" });
    assert.equal(gate.headers["x-argus-session"], "sess-1");
    assert.deepEqual(gate.body, { phaseId: "review" });
    assert.equal(logout.headers["x-argus-session"], "sess-1");
    assert.deepEqual(my.out, ['✓ approved inst-1 at "review" — the pipeline continues']);
    assert.deepEqual(my.err, []);
  });

  it("revise sends the note and the phase", async () => {
    const fake = fakeArgus();
    const my = io(fake.fetch);
    const code = await runGate(
      { ...approve, verb: "revise", note: "tighten the intro", json: true },
      my.io,
    );
    assert.equal(code, 0);
    const gate = fake.calls[1];
    assert.equal(new URL(gate.url).pathname, "/api/instances/inst-1/revise");
    assert.deepEqual(gate.body, { note: "tighten the intro", phaseId: "review" });
    assert.deepEqual(JSON.parse(my.out[0]), {
      ok: true,
      verb: "revise",
      instanceId: "inst-1",
      phaseId: "review",
      status: 200,
    });
  });

  it("asks the terminal for credentials when the environment has none", async () => {
    const fake = fakeArgus();
    const asked: [string, boolean][] = [];
    const my = io(fake.fetch, {
      env: {} as NodeJS.ProcessEnv,
      isTTY: true,
      prompt: async (q, hidden) => {
        asked.push([q, hidden]);
        return hidden ? "pw" : "usha";
      },
    });
    assert.equal(await runGate(approve, my.io), 0);
    assert.deepEqual(asked, [
      ["Argus username: ", false],
      ["Argus password: ", true],
    ]);
    assert.deepEqual(fake.calls[0].body, { username: "usha", password: "pw" });
  });

  it("with no terminal and no environment credentials it stops before touching the server", async () => {
    const fake = fakeArgus();
    const my = io(fake.fetch, { env: {} as NodeJS.ProcessEnv, isTTY: false });
    assert.equal(await runGate(approve, my.io), 1);
    assert.equal(fake.calls.length, 0);
    assert.match(my.err[0], /ARGUS_USER and ARGUS_PASSWORD/);
  });

  it("a refused login never reaches the gate route", async () => {
    const fake = fakeArgus({ password: "other" });
    const my = io(fake.fetch);
    assert.equal(await runGate(approve, my.io), 1);
    assert.equal(fake.calls.length, 1);
    assert.match(my.err[0], /invalid username or password/);
  });

  it("surfaces the server's 409 reason and still logs out", async () => {
    const fake = fakeArgus({
      gate: (seen) =>
        seen.url.includes("/approve")
          ? json(409, { ok: false, error: "instance is not awaiting approval" })
          : undefined,
    });
    const my = io(fake.fetch);
    assert.equal(await runGate(approve, my.io), 1);
    assert.deepEqual(my.err, [
      '✗ could not approve inst-1 at "review": instance is not awaiting approval',
    ]);
    assert.equal(new URL(fake.calls.at(-1)!.url).pathname, "/api/auth/logout");
  });

  it("an unreachable server is one line naming the URL", async () => {
    const my = io(async () => {
      throw new Error("ECONNREFUSED");
    });
    assert.equal(await runGate(approve, my.io), 1);
    assert.match(my.err[0], /no Argus answering at http:\/\/argus\.test \(ECONNREFUSED\)/);
  });

  it("a login that sets no session cookie is refused rather than sent on", async () => {
    const fake = fakeArgus({ loginStatus: json(200, { ok: true }) });
    const my = io(fake.fetch);
    assert.equal(await runGate(approve, my.io), 1);
    assert.equal(fake.calls.length, 1);
    assert.match(my.err[0], /without a session cookie/);
  });
});
