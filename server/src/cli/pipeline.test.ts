/**
 * `argus pipeline` against an injected `fetch`: which verbs log in, the call
 * each one makes, what it prints, and how refusals read. No server, no
 * terminal, no filesystem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PipelineDefinition } from "@argus/contracts";
import { runPipeline, type PipelineIo } from "./pipeline.js";
import {
  findPipeline,
  parsePipelineArgs,
  triggerText,
  type PipelineCliOptions,
  type PipelineCommand,
} from "./pipelineCore.js";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const def = (over: Partial<PipelineDefinition> = {}): PipelineDefinition => ({
  id: "p-1",
  name: "Nightly",
  phases: [{ id: "a", name: "A", cwd: "/r", gated: false, steps: [{ name: "s", prompt: "p" }] }],
  trigger: { kind: "daily", time: "02:00" },
  enabled: true,
  overlapPolicy: "skip",
  hookToken: "secret-hook-token",
  lastStartedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

/** A stand-in Argus: one account, a store of two pipelines, scripted replies. */
function fakeArgus(reply: (seen: Seen) => Response | undefined = () => undefined) {
  const calls: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const seen: Seen = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(seen);
    if (seen.path === "/api/auth/login") {
      return json(200, { ok: true }, { "set-cookie": "argus_session=sess-1; Path=/; HttpOnly" });
    }
    if (seen.path === "/api/auth/logout") return json(200, { ok: true });
    const scripted = reply(seen);
    if (scripted) return scripted;
    if (seen.path === "/api/pipelines" && seen.method === "GET") {
      return json(200, {
        pipelines: [def(), def({ id: "p-2", name: "Delivery", trigger: null, enabled: false })],
      });
    }
    if (headers["x-argus-session"] !== "sess-1") return json(401, { error: "login required" });
    return json(200, { ok: true });
  };
  return { fetch, calls };
}

function io(fetch: typeof globalThis.fetch, files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const pio: PipelineIo = {
    fetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    isTTY: false,
    prompt: async () => {
      throw new Error("prompt must not be called");
    },
    env: { ARGUS_USER: "usha", ARGUS_PASSWORD: "pw" } as NodeJS.ProcessEnv,
    readFile: async (f) => {
      if (f in files) return files[f];
      throw new Error("ENOENT");
    },
  };
  return { io: pio, out, err };
}

const opts = (command: PipelineCommand, json = false): PipelineCliOptions => ({
  command,
  url: "http://argus.test",
  token: "shared",
  json,
});

const route = (calls: Seen[]) => calls.map((c) => `${c.method} ${c.path}`);

describe("argus pipeline reads", () => {
  it("list needs no login and prints one line per pipeline", async () => {
    const fake = fakeArgus();
    const my = io(fake.fetch);
    assert.equal(await runPipeline(opts({ verb: "list" }), my.io), 0);
    assert.deepEqual(route(fake.calls), ["GET /api/pipelines"]);
    assert.equal(fake.calls[0].headers.authorization, "Bearer shared");
    assert.deepEqual(my.out, [
      "p-1  Nightly · daily 02:00 · enabled · 1 phase",
      "p-2  Delivery · manual · paused · 1 phase",
    ]);
  });

  it("show finds by id or name and never prints the webhook token", async () => {
    const fake = fakeArgus();
    const my = io(fake.fetch);
    assert.equal(await runPipeline(opts({ verb: "show", ref: "delivery" }), my.io), 0);
    const shown = JSON.parse(my.out.join("\n")) as PipelineDefinition;
    assert.equal(shown.id, "p-2");
    assert.equal("hookToken" in shown, false);

    const missing = io(fake.fetch);
    assert.equal(await runPipeline(opts({ verb: "show", ref: "nope" }), missing.io), 1);
    assert.match(missing.err[0], /no pipeline with id or name "nope"/);
  });

  it("runtimes prints what each CLI offers", async () => {
    const fake = fakeArgus((s) =>
      s.path === "/api/runtimes"
        ? json(200, {
            default: "claude",
            runtimes: [
              {
                id: "claude",
                label: "Claude Code",
                available: true,
                isDefault: true,
                models: ["opus"],
                reasoningEfforts: [],
              },
              {
                id: "codex",
                label: "Codex",
                available: false,
                detail: "`codex` was not found on PATH",
                isDefault: false,
                models: [],
                reasoningEfforts: ["low"],
              },
            ],
          })
        : undefined,
    );
    const my = io(fake.fetch);
    assert.equal(await runPipeline(opts({ verb: "runtimes" }), my.io), 0);
    assert.deepEqual(my.out, [
      "claude (default) · Claude Code · available · models: opus · reasoning efforts: none",
      "codex · Codex · not available (`codex` was not found on PATH) · models: the CLI's own · reasoning efforts: low",
    ]);
  });
});

describe("argus pipeline writes", () => {
  it("validate logs in, posts the file to the validate route, logs out", async () => {
    const fake = fakeArgus((s) =>
      s.path.startsWith("/api/pipelines/validate")
        ? json(200, { valid: true, pipeline: { name: "Nightly", phases: [{}, {}] } })
        : undefined,
    );
    const my = io(fake.fetch, { "p.json": '{"name":"Nightly"}' });
    assert.equal(
      await runPipeline(opts({ verb: "validate", file: "p.json", as: "p-1" }), my.io),
      0,
    );
    assert.deepEqual(route(fake.calls), [
      "POST /api/auth/login",
      "POST /api/pipelines/validate?id=p-1",
      "POST /api/auth/logout",
    ]);
    assert.deepEqual(fake.calls[1].body, { name: "Nightly" });
    assert.equal(fake.calls[1].headers["x-argus-session"], "sess-1");
    assert.deepEqual(my.out, ['✓ valid — "Nightly", 2 phases; nothing was saved']);
  });

  it("an invalid definition reads as the server's reason, exit 1", async () => {
    const fake = fakeArgus((s) =>
      s.path === "/api/pipelines/validate"
        ? json(400, { error: 'phase "b": needs "x", which is not a phase' })
        : undefined,
    );
    const my = io(fake.fetch, { "p.json": "{}" });
    assert.equal(await runPipeline(opts({ verb: "validate", file: "p.json", as: null }), my.io), 1);
    assert.deepEqual(my.err, [
      '✗ the server refused it: phase "b": needs "x", which is not a phase',
    ]);
  });

  it("a file that is not JSON fails before any login", async () => {
    const fake = fakeArgus();
    const my = io(fake.fetch, { "p.json": "{ nope" });
    assert.equal(await runPipeline(opts({ verb: "create", file: "p.json" }), my.io), 1);
    assert.deepEqual(fake.calls, []);
    assert.match(my.err[0], /p\.json is not valid JSON/);
  });

  it("create prints the new id; a webhook pipeline also names its URL, not its token", async () => {
    const fake = fakeArgus((s) =>
      s.path === "/api/pipelines" && s.method === "POST"
        ? json(201, def({ id: "p-9", trigger: { kind: "webhook" } }))
        : undefined,
    );
    const my = io(fake.fetch, { "p.json": "{}" });
    assert.equal(await runPipeline(opts({ verb: "create", file: "p.json" }), my.io), 0);
    assert.equal(my.out[0], "✓ created p-9 — Nightly · webhook · enabled · 1 phase");
    assert.match(my.out[1], /POST http:\/\/argus\.test\/api\/hooks\/pipelines\/p-9/);
    assert.equal(my.out.join("\n").includes("secret-hook-token"), false);
  });

  it("update is PUT, --patch is PATCH, --force adds force=1; a held edit names --force", async () => {
    const fake = fakeArgus((s) => {
      if (s.path === "/api/pipelines/p-1" && s.method === "PUT") {
        return json(409, {
          error:
            '1 instance is running under "Nightly". They keep the definition they started with; this edit applies to the next start only. Repeat with ?force=1 to save it anyway.',
          code: "instances-running",
        });
      }
      if (s.path.startsWith("/api/pipelines/p-1")) return json(200, def());
      return undefined;
    });
    const held = io(fake.fetch, { "p.json": "{}" });
    assert.equal(
      await runPipeline(
        opts({ verb: "update", id: "p-1", file: "p.json", patch: false, force: false }),
        held.io,
      ),
      1,
    );
    assert.match(held.err[0], /applies to the next start only\. Add --force to save it anyway\.$/);

    const patched = io(fake.fetch, { "p.json": "{}" });
    assert.equal(
      await runPipeline(
        opts({ verb: "update", id: "p-1", file: "p.json", patch: true, force: true }),
        patched.io,
      ),
      0,
    );
    assert.ok(route(fake.calls).includes("PATCH /api/pipelines/p-1?force=1"));
    assert.deepEqual(patched.out, ["✓ saved p-1 — the next instance runs this definition"]);
  });

  it("start reports the instance, and a preflight refusal with its reasons", async () => {
    let refuse = false;
    const fake = fakeArgus((s) => {
      if (s.path !== "/api/pipelines/p-1/start") return undefined;
      return refuse
        ? json(412, { error: "preflight failed", reasons: ["cwd /r does not exist"] })
        : json(202, { id: "i-7", pipelineName: "Nightly" });
    });
    const ok = io(fake.fetch);
    assert.equal(await runPipeline(opts({ verb: "start", id: "p-1" }), ok.io), 0);
    assert.deepEqual(ok.out, ['✓ started instance i-7 of "Nightly" — follow it with `argus tail`']);
    refuse = true;
    const no = io(fake.fetch);
    assert.equal(await runPipeline(opts({ verb: "start", id: "p-1" }), no.io), 1);
    assert.deepEqual(no.err, ["✗ preflight failed: cwd /r does not exist"]);
  });

  it("without credentials and no terminal, it says what to set", async () => {
    const fake = fakeArgus();
    const my = io(fake.fetch);
    my.io.env = {} as NodeJS.ProcessEnv;
    assert.equal(await runPipeline(opts({ verb: "start", id: "p-1" }), my.io), 1);
    assert.match(my.err[0], /ARGUS_USER and ARGUS_PASSWORD/);
    assert.deepEqual(fake.calls, []);
  });
});

describe("pipeline core", () => {
  const env = { ARGUS_PORT: "7788", ARGUS_TOKEN: "t" } as NodeJS.ProcessEnv;

  it("parses verbs, files, stdin and flags", () => {
    const v = parsePipelineArgs(["validate", "-", "--as", "p-1", "--json"], env);
    assert.ok(v.kind === "ok");
    if (v.kind === "ok") {
      assert.deepEqual(v.options.command, { verb: "validate", file: "-", as: "p-1" });
      assert.equal(v.options.url, "http://127.0.0.1:7788");
      assert.equal(v.options.token, "t");
      assert.equal(v.options.json, true);
    }
    const u = parsePipelineArgs(["update", "p-1", "def.json", "--patch", "--force"], env);
    assert.ok(
      u.kind === "ok" &&
        u.options.command.verb === "update" &&
        u.options.command.patch &&
        u.options.command.force,
    );
    assert.equal(parsePipelineArgs([], env).kind, "help");
  });

  it("refuses what does not fit the verb", () => {
    for (const argv of [
      ["frob"],
      ["show"],
      ["create", "a", "b"],
      ["start", "p", "--patch"],
      ["list", "--as", "x"],
      ["validate", "f", "--as"],
    ]) {
      assert.equal(parsePipelineArgs(argv, env).kind, "error", argv.join(" "));
    }
  });

  it("finds by id, then by a unique name, and names the ids when a name is shared", () => {
    const defs = [def(), def({ id: "p-2", name: "nightly" })];
    assert.equal(findPipeline(defs, "p-2").ok, true);
    const shared = findPipeline(defs, "NIGHTLY");
    assert.equal(shared.ok, false);
    if (!shared.ok) assert.match(shared.error, /p-1, p-2/);
  });

  it("summarises every trigger kind", () => {
    assert.equal(triggerText({ trigger: null }), "manual");
    assert.equal(triggerText({ trigger: { kind: "interval", everyMinutes: 30 } }), "every 30m");
    assert.equal(
      triggerText({ trigger: { kind: "weekly", weekday: 1, time: "09:00" } }),
      "Mon 09:00",
    );
    assert.equal(
      triggerText({
        trigger: {
          kind: "windowed",
          everyMinutes: 15,
          startTime: "07:00",
          endTime: "15:00",
          weekdays: [1, 2],
        },
      }),
      "every 15m 07:00–15:00 Mon,Tue",
    );
    assert.equal(
      triggerText({ trigger: { kind: "after", pipelineId: "p-1", on: "any" } }),
      "after p-1 (any)",
    );
  });
});
