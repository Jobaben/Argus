import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { createEngine } from "./pipelineEngine.js";
import type { ArgusConfig } from "./config.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-appengine-"));
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

// A spawn that never resolves — steps stay "running" so the instance sits in a
// deterministic awaiting/running state for the HTTP assertions.
const hangingSpawn = () => ({ pid: 4242, done: new Promise<{ code: number | null }>(() => {}) });

function appWith(over: Partial<Parameters<typeof createEngine>[0]> = {}) {
  const engine = createEngine({
    now: () => new Date(),
    newId: () => `id-${Math.random().toString(36).slice(2)}`,
    spawn: hangingSpawn,
    signalUrlBase: "http://127.0.0.1:7777",
    maxConcurrent: 4,
    ...over,
  });
  const app = createApp({ config, engine, broadcast: () => {}, serveWeb: false });
  return { app, engine };
}

const same = {
  host: "localhost:7777",
  origin: "http://localhost:7777",
  "content-type": "application/json",
};
const loopback = { host: "localhost:7777" };

async function createPipeline(app: ReturnType<typeof appWith>["app"]) {
  const res = await app.request("/api/pipelines", {
    method: "POST",
    headers: same,
    body: JSON.stringify({
      name: "p",
      trigger: null,
      phases: [
        { id: "only", name: "Only", cwd: home, gated: false, steps: [{ name: "s", prompt: "go" }] },
      ],
    }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
}

test("real engine: preflight failure maps to 412 with reasons", async () => {
  const { app } = appWith({ preflight: async () => ({ ok: false, reasons: ["hook missing"] }) });
  const def = await createPipeline(app);
  const res = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  assert.equal(res.status, 412);
  const body = (await res.json()) as { reasons: string[] };
  assert.deepEqual(body.reasons, ["hook missing"]);
});

test("real engine: start → 202, then a bad-token signal → 403", async () => {
  const { app } = appWith();
  const def = await createPipeline(app);
  const start = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  assert.equal(start.status, 202);
  const inst = (await start.json()) as { id: string };

  const sig = await app.request(`/api/instances/${inst.id}/signal`, {
    method: "POST",
    headers: same,
    body: JSON.stringify({ phaseId: "only", runId: "whatever", type: "completed", token: "WRONG" }),
  });
  assert.equal(sig.status, 403);
});

test("real engine: abort → 200, then a second abort → 409", async () => {
  const { app } = appWith();
  const def = await createPipeline(app);
  const start = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  const inst = (await start.json()) as { id: string };

  const first = await app.request(`/api/instances/${inst.id}/abort`, {
    method: "POST",
    headers: same,
  });
  assert.equal(first.status, 200);
  const second = await app.request(`/api/instances/${inst.id}/abort`, {
    method: "POST",
    headers: same,
  });
  assert.equal(second.status, 409);
});

test("real engine: overlap=skip refuses a second concurrent start with 409", async () => {
  const { app } = appWith();
  const def = await createPipeline(app);
  const first = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  assert.equal(first.status, 202);
  const second = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  assert.equal(second.status, 409);
});

test("real engine: instance + overview reads reflect the started instance", async () => {
  const { app } = appWith();
  const def = await createPipeline(app);
  const start = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  const inst = (await start.json()) as { id: string };

  const got = await app.request(`/api/instances/${inst.id}`, { headers: loopback });
  assert.equal(got.status, 200);
  const overview = (await (await app.request("/api/overview", { headers: loopback })).json()) as {
    overview: unknown[];
  };
  assert.equal(overview.overview.length, 1);
});
