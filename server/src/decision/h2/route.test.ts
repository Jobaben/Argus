import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { H2ReportResponse } from "@argus/contracts";
import { createApp } from "../../app.js";
import type { AuthService } from "../../auth.js";
import { createAutopsyWatcher } from "../../autopsyWatcher.js";
import { paths } from "../../claudeHome.js";
import type { ArgusConfig } from "../../config.js";
import type { Engine } from "../../pipelineEngine.js";
import {
  createAnalysisRunner,
  type AnalysisRunner,
  type AnalysisSpawn,
} from "../../sources/analysis.js";
import { readAutopsies } from "../../sources/autopsy.js";
import { readRuns, writeRun } from "../../sources/runs.js";
import { readSessionLines } from "../../sources/sessions.js";
import { createUserStore } from "../../userStore.js";
import { RESIDUAL_P, transcript } from "../testSupport.js";
import { countAnalysisPasses, createH2Collection, h2Root } from "./entry.js";
import { endedRun, MIN, ON, PROBE_P } from "./testSupport.js";

/**
 * The H2 report route, and H2 collection beside the real Autopsy watcher.
 *
 * Reading the report never collects: no provider call, no runner call, no
 * write. And a shadow call never makes Autopsy see a busy runner, because it
 * waits for a tick on which no other pass started.
 */

let home: string;
const saved: Record<string, string | undefined> = {};
const KEYS = [
  "ARGUS_CLAUDE_HOME",
  "ARGUS_DECISIONS",
  "ARGUS_DECISIONS_H2_COLLECT",
  "ARGUS_ANALYSIS",
  "ARGUS_ANALYSIS_MODEL",
  "ARGUS_ANALYSIS_RUNTIME",
];
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS.slice(1)) delete process.env[k];
  home = mkdtempSync(path.join(tmpdir(), "argus-h2-route-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(paths.argus(), { recursive: true });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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
const openAuth: AuthService = {
  isConfigured: async () => true,
  status: async () => ({ configured: true, username: "ops", role: "root" }),
  login: async () => ({ ok: false, reason: "bad-credentials" }),
  verify: () => ({ username: "ops", role: "root" }),
  logout: () => {},
  revokeSessions: () => {},
};
const signedOut: AuthService = { ...openAuth, verify: () => null };
const loopback = { host: "localhost:7777" };
const throwingRunner: AnalysisRunner = {
  run: () => {
    throw new Error("the report route must never run an analysis pass");
  },
  inFlight: () => 0,
};

function makeApp(over: Partial<ArgusConfig> = {}, auth = openAuth, extra = {}) {
  return createApp({
    config: { ...config, ...over },
    engine: {} as Engine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth,
    analysis: throwingRunner,
    ...extra,
  });
}

const decisionDirs = () =>
  ["decisions", "decision-experiments", "decision-provider-cwd"].filter((d) =>
    existsSync(path.join(paths.argus(), d)),
  );

test("GET /api/decisions/h2 on a fresh home: an empty report, collection off, nothing created", async () => {
  const res = await makeApp().request("/api/decisions/h2", { headers: loopback });
  assert.equal(res.status, 200);
  const body = (await res.json()) as H2ReportResponse;
  assert.equal(body.collection.enabled, false);
  assert.deepEqual(body.collection.reasons, [
    "ARGUS_DECISIONS is not on",
    "ARGUS_DECISIONS_H2_COLLECT is not on",
  ]);
  assert.equal(body.collection.watcher.state, "inactive");
  assert.deepEqual([body.report.probe, body.report.residual], [[], []]);
  assert.equal(body.report.report.id, "decision-h2-report");
  assert.deepEqual(decisionDirs(), []);
});

test("opening the report with collection switched on still collects nothing and calls nothing", async () => {
  process.env.ARGUS_DECISIONS = "on";
  process.env.ARGUS_DECISIONS_H2_COLLECT = "on";
  await writeRun(
    endedRun("run-1", -60 * MIN, { endedAt: new Date(Date.now() - 60 * MIN).toISOString() }),
  );
  const app = makeApp();
  for (let i = 0; i < 3; i++) {
    const res = await app.request("/api/decisions/h2", { headers: loopback });
    assert.equal(res.status, 200);
    const body = (await res.json()) as H2ReportResponse;
    assert.equal(body.collection.enabled, true, "the settings say on");
    assert.equal(body.collection.watcher.state, "inactive", "but no watcher runs in the route");
  }
  assert.deepEqual(decisionDirs(), [], "no ledger, no journal, no provider directory");
});

test("the report route is behind the same auth as every /api read", async () => {
  const app = makeApp({ token: "s3cret" }, signedOut);
  assert.equal((await app.request("/api/decisions/h2", { headers: loopback })).status, 401);
  const ok = await app.request("/api/decisions/h2", {
    headers: { ...loopback, authorization: "Bearer s3cret" },
  });
  assert.equal(ok.status, 200);
});

/** A spawn that answers autopsy, H2 probe and H2 residual prompts, and records which it saw. */
function scriptedSpawn() {
  const kinds: string[] = [];
  const spawn: AnalysisSpawn = (o) => {
    let result: unknown;
    if (o.prompt.includes("closed question about a record Argus keeps")) {
      const probe = o.prompt.includes("how did this run end");
      kinds.push(probe ? "probe" : "residual");
      result = { p: probe ? PROBE_P : RESIDUAL_P, rationale: "SECRET-RATIONALE-TEXT" };
    } else {
      kinds.push("autopsy");
      result = {
        failureClass: "missing-context",
        confidence: 0.7,
        why: "the config file was missing",
      };
    }
    const stdout = JSON.stringify({ result: JSON.stringify(result), total_cost_usd: 0.001 });
    return { kill() {}, done: Promise.resolve({ code: 0, stdout, error: null }) };
  };
  return { spawn, kinds };
}

async function seedFailedRuns(n: number, endedAt: number) {
  for (let i = 0; i < n; i++) {
    const run = endedRun(`run-${i}`, 0, {
      endedAt: new Date(endedAt).toISOString(),
      project: "-repo",
    });
    await writeRun(run);
    const file = path.join(paths.projects(), "-repo", `${run.sessionId}.jsonl`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      transcript()
        .map((l) => JSON.stringify(l))
        .join("\n") + "\n",
    );
  }
}

async function ticks(collect: boolean) {
  const T = Date.now();
  let t = T;
  const now = () => new Date(t);
  const { spawn, kinds } = scriptedSpawn();
  const runner = countAnalysisPasses(
    createAnalysisRunner({ spawn, now, blocked: async () => false, meter: async () => {} }),
  );
  const env = collect
    ? { ...ON, ARGUS_DECISIONS_H2_RESIDUAL_RATE: "1", ARGUS_DECISIONS_H2_PROBE_RATE: "1" }
    : {};
  const h2 = createH2Collection({ runner, env, now });
  const autopsy = createAutopsyWatcher({
    runner,
    now,
    readLines: readSessionLines,
    readRuns: () => readRuns(),
  });
  await h2.watcher.check(); // collection starts before the runs end
  await seedFailedRuns(3, T + MIN);
  const perTick: string[][] = [];
  for (let i = 0; i < 12; i++) {
    t += 16 * MIN;
    const before = kinds.length;
    await autopsy.check(); // the order of index.ts: Autopsy first, H2 last
    await h2.watcher.check();
    perTick.push(kinds.slice(before));
  }
  return { perTick, autopsies: await readAutopsies(), h2 };
}

test("beside the real Autopsy watcher: Autopsy never sees a busy runner, and H2 only runs on ticks Autopsy left idle", async () => {
  const on = await ticks(true);
  for (const a of on.autopsies) {
    assert.equal(a.status, "ready", `autopsy ${a.runId}: ${a.error}`);
  }
  assert.equal(on.autopsies.length, 3);
  for (const tick of on.perTick) {
    assert.ok(tick.length <= 1, `one pass per tick at most: ${tick}`);
  }
  // The three autopsies drain first, one per tick; H2 waits a tick after each.
  const firstShadow = on.perTick.findIndex((k) => k.some((x) => x !== "autopsy"));
  const lastAutopsy = on.perTick.map((k) => k.includes("autopsy")).lastIndexOf(true);
  assert.ok(firstShadow > lastAutopsy, `shadow at ${firstShadow}, autopsy until ${lastAutopsy}`);
  assert.ok(on.perTick.flat().filter((k) => k !== "autopsy").length >= 2);

  // The report is served from what was retained, and carries no rationale or snapshot text.
  const res = await makeApp({}, openAuth, { decisionsH2Status: () => on.h2.status() }).request(
    "/api/decisions/h2",
    {
      headers: loopback,
    },
  );
  const text = await res.text();
  assert.ok(!text.includes("SECRET-RATIONALE-TEXT"), "no model rationale in the report");
  assert.ok(!text.includes("Looking for the config"), "no transcript text in the report");
  const body = JSON.parse(text) as H2ReportResponse;
  assert.equal(body.collection.watcher.state === "inactive", false);
  assert.ok(body.report.probe.length + body.report.residual.length > 0);
  const ledgerBefore = readFileSync(path.join(h2Root(), "collection.jsonl"));
  await makeApp().request("/api/decisions/h2", { headers: loopback });
  assert.deepEqual(
    readFileSync(path.join(h2Root(), "collection.jsonl")),
    ledgerBefore,
    "a read writes nothing",
  );
});

test("Autopsy's records are the same with H2 collection on and off", async () => {
  const strip = (xs: Awaited<ReturnType<typeof readAutopsies>>) =>
    xs.map(({ id: _id, at: _at, ...rest }) => rest).sort((a, b) => (a.runId < b.runId ? -1 : 1));
  const on = strip((await ticks(true)).autopsies);
  home = mkdtempSync(path.join(tmpdir(), "argus-h2-route-off-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(paths.argus(), { recursive: true });
  const off = strip((await ticks(false)).autopsies);
  assert.deepEqual(on, off);
});

test("collection status names the explicit Codex runtime and provider without starting it", async () => {
  const runner = countAnalysisPasses(createAnalysisRunner({ enabled: () => true }));
  const collection = createH2Collection({
    runner,
    env: {
      ...ON,
      ARGUS_DECISIONS_H2_RUNTIME: "codex",
      ARGUS_DECISIONS_H2_MODEL: "gpt-5.6-luna",
      ARGUS_DECISIONS_H2_REASONING_EFFORT: "low",
    },
  });
  assert.equal(collection.status().settings?.provider, "codex-cli");
  assert.equal(collection.status().settings?.runtime, "codex");
  assert.equal(collection.status().settings?.requestedModel, "gpt-5.6-luna");
  assert.equal(collection.status().settings?.reasoningEffort, "low");
});
