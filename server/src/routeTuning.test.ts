import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import type { ArgusConfig } from "./config.js";
import type { Engine } from "./pipelineEngine.js";
import type { AuthService } from "./auth.js";
import { createUserStore } from "./userStore.js";
import { createPipeline } from "./sources/pipelines.js";
import {
  readTuningReport,
  writeTuningReport,
  seedTuningReport,
  TUNING_STALE_MS,
} from "./sources/tuning.js";
import type { AnalysisRunner } from "./sources/analysis.js";
import type { PipelineDefinition, TuningResponse } from "@argus/contracts";

/**
 * The HTTP contract around a tuning pass: who may start one, what a start
 * returns, and how a second press while one is running is refused. The pass
 * itself is covered in `sources/tuning.test.ts`; here the runner is a stub
 * that answers instantly so the fire-and-forget orchestration can be awaited
 * through the store.
 */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-route-tuning-"));
  mkdirSync(path.join(home, "argus"), { recursive: true });
  process.env.ARGUS_CLAUDE_HOME = home;
  delete process.env.ARGUS_ANALYSIS;
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

const fakeEngine: Engine = {
  start: async () => null,
  onSignal: async () => ({ ok: true, code: 200 }),
  approve: async () => ({ ok: true, code: 200 }),
  revise: async () => ({ ok: true, code: 200 }),
  abort: async () => ({ ok: true, code: 200 }),
  reconcile: async () => {},
  adopt: async () => {},
  drain: async () => {},
};

const openAuth: AuthService = {
  isConfigured: async () => true,
  status: async () => ({ configured: true, username: "test", role: "root" }),
  login: async () => ({ ok: false, reason: "bad-credentials" }),
  verify: () => ({ username: "test", role: "root" }),
  logout: () => {},
  revokeSessions: () => {},
};

const signedOut: AuthService = {
  ...openAuth,
  status: async () => ({ configured: true, username: null, role: null }),
  verify: () => null,
};

/** Answers every pass with "nothing to change", and counts them. */
function stubRunner() {
  let calls = 0;
  const runner: AnalysisRunner = {
    inFlight: () => 0,
    async run(_req, parse) {
      calls++;
      const value = parse({ summary: "fits", proposals: [] });
      return {
        ok: value !== null,
        value,
        raw: "",
        costUsd: 0.001,
        tokens: 100,
        durationMs: 3,
        failure: value === null ? "unparseable" : null,
        error: null,
      };
    },
  };
  return { runner, calls: () => calls };
}

function makeApp(auth: AuthService = openAuth, analysis?: AnalysisRunner) {
  const broadcasts: string[] = [];
  const app = createApp({
    config,
    engine: fakeEngine,
    broadcast: (m) => broadcasts.push((m as { type: string }).type),
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth,
    analysis,
  });
  return { app, broadcasts };
}

const headers = { host: "localhost:7777", origin: "http://localhost:7777" };

async function seedPipeline(): Promise<PipelineDefinition> {
  return createPipeline(
    {
      name: "Nightly",
      trigger: null,
      phases: [
        { id: "a", name: "A", cwd: home, gated: false, steps: [{ name: "s", prompt: "do a" }] },
        { id: "b", name: "B", cwd: home, gated: false, steps: [{ name: "t", prompt: "do b" }] },
      ],
    },
    new Date("2026-09-17T10:00:00.000Z"),
    "p1",
  );
}

async function untilSettled(pipelineId: string) {
  for (let i = 0; i < 200; i++) {
    const r = await readTuningReport(pipelineId);
    if (r && r.status !== "running") return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error("the pass never settled");
}

test("GET /api/pipelines/:id/tune is open and reports no pass yet", async () => {
  const def = await seedPipeline();
  const { app } = makeApp(signedOut);
  const res = await app.request(`/api/pipelines/${def.id}/tune`, { headers });
  assert.equal(res.status, 200);
  const body = (await res.json()) as TuningResponse;
  assert.equal(body.report, null);
  assert.equal(body.unavailable, null);
});

test("GET says why when analysis is disabled", async () => {
  const def = await seedPipeline();
  process.env.ARGUS_ANALYSIS = "off";
  const { app } = makeApp();
  const body = (await (
    await app.request(`/api/pipelines/${def.id}/tune`, { headers })
  ).json()) as TuningResponse;
  assert.match(body.unavailable ?? "", /disabled/);
});

test("GET and POST are 404 for an unknown pipeline", async () => {
  const { app } = makeApp();
  assert.equal((await app.request("/api/pipelines/nope/tune", { headers })).status, 404);
  assert.equal(
    (await app.request("/api/pipelines/nope/tune", { method: "POST", headers })).status,
    404,
  );
});

test("POST is 401 without an admin session", async () => {
  const def = await seedPipeline();
  const { app } = makeApp(signedOut);
  const res = await app.request(`/api/pipelines/${def.id}/tune`, { method: "POST", headers });
  assert.equal(res.status, 401);
  assert.equal(await readTuningReport(def.id), null);
});

test("POST returns 202 with a running seed, then the pass settles and pings", async () => {
  const def = await seedPipeline();
  const { runner, calls } = stubRunner();
  const { app, broadcasts } = makeApp(openAuth, runner);

  const res = await app.request(`/api/pipelines/${def.id}/tune`, { method: "POST", headers });
  assert.equal(res.status, 202);
  const body = (await res.json()) as TuningResponse;
  assert.equal(body.report?.status, "running");
  assert.equal(body.report?.phasesTotal, 2);
  assert.equal(body.report?.phasesDone, 0);
  assert.ok(body.report?.phases.every((p) => p.status === "pending"));

  const settled = await untilSettled(def.id);
  assert.equal(settled.status, "ready");
  assert.equal(calls(), 2);
  assert.deepEqual(
    settled.phases.map((p) => p.status),
    ["ready", "ready"],
  );
  assert.ok(settled.phases.every((p) => p.proposals.length === 0));
  assert.ok(broadcasts.filter((t) => t === "tuning:changed").length >= 3);
  assert.ok(!broadcasts.includes("pipelines:changed"));
});

test("a second POST while a pass is running is 409", async () => {
  const def = await seedPipeline();
  const { runner, calls } = stubRunner();
  const { app } = makeApp(openAuth, runner);

  await writeTuningReport(seedTuningReport(def, "fresh", new Date()));
  const busy = await app.request(`/api/pipelines/${def.id}/tune`, { method: "POST", headers });
  assert.equal(busy.status, 409);
  assert.match(((await busy.json()) as { error: string }).error, /already running/);
  assert.equal(calls(), 0);
});

test("a running report older than the stale window is treated as abandoned", async () => {
  const def = await seedPipeline();
  const { runner } = stubRunner();
  const { app } = makeApp(openAuth, runner);

  await writeTuningReport(
    seedTuningReport(def, "stale", new Date(Date.now() - TUNING_STALE_MS - 1000)),
  );
  const again = await app.request(`/api/pipelines/${def.id}/tune`, { method: "POST", headers });
  assert.equal(again.status, 202);
  const settled = await untilSettled(def.id);
  assert.notEqual(settled.id, "stale");
  assert.equal(settled.status, "ready");
});
