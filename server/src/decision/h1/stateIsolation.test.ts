import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OverviewEntry } from "@argus/contracts";
import { readResultFile } from "../../../../hooks/argus-signal.mjs";
import { createApp } from "../../app.js";
import type { AuthService } from "../../auth.js";
import { paths } from "../../claudeHome.js";
import type { ArgusConfig } from "../../config.js";
import { evaluateSupport } from "../../knowledge/kernel.js";
import { createClaim, readLedger } from "../../knowledge/store.js";
import { createEngine } from "../../pipelineEngine.js";
import { testRunToken } from "../../testSignalToken.js";
import { createAnalysisRunner, type AnalysisSpawn } from "../../sources/analysis.js";
import { readInstance } from "../../sources/instances.js";
import { writeRun } from "../../sources/runs.js";
import { createUserStore } from "../../userStore.js";
import { fakeKill } from "../../testPlatform.js";
import { settleJournalOrder, transcript, withoutHome } from "../testSupport.js";
import { countAnalysisPasses, createShadowExperiments } from "../experiments.js";
import { readH1ReportResponse } from "./entry.js";
import { endedRun, MIN, PROBE_P } from "../h2/testSupport.js";
import { RESIDUAL_P } from "../testSupport.js";

/**
 * The §H.5 regression for H1 collection (RFC §Q.10): the same gated fixture
 * pipeline, driven through the real HTTP routes and engine to a gate the
 * operator approves, with H1 (and H2) collection on — capturing the gate,
 * making a real shadow call through an injected spawn while it waits — and
 * with both off. Every byte Argus keeps outside the Decision Plane's own
 * directories is identical, and so is what the gate drawer's review route
 * returns while the gate waits: no prediction reaches it.
 */

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
const sameOrigin = {
  host: "localhost:7777",
  origin: "http://localhost:7777",
  "content-type": "application/json",
};
const accepted = (value: boolean) => ({
  predicate: { path: ["accepted"], operator: "equals", value },
});

const pipeline = (cwd: string) => ({
  name: "Release train",
  trigger: null,
  phases: [
    {
      id: "evaluate",
      name: "Evaluate",
      cwd,
      gated: false,
      steps: [{ name: "decide", prompt: "Judge the release candidate." }],
      result: {
        artifact: "evaluation",
        schema: {
          type: "object",
          required: ["accepted"],
          properties: { accepted: { type: "boolean" } },
        },
      },
    },
    {
      id: "publish",
      name: "Publish",
      cwd,
      gated: true,
      steps: [{ name: "ship", prompt: "Ship it." }],
      needs: [{ phase: "evaluate", when: accepted(true) }],
    },
    {
      id: "repair",
      name: "Repair",
      cwd,
      gated: false,
      steps: [{ name: "fix", prompt: "Fix it." }],
      needs: [{ phase: "evaluate", when: accepted(false) }],
    },
  ],
});

const DECISION_DIRS = ["decisions", "decision-experiments", "decision-provider-cwd"];

function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const decisionRoots = new Set(DECISION_DIRS.map((d) => path.join(paths.argus(), d)));
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (decisionRoots.has(f)) continue;
      if (e.isDirectory()) walk(f);
      else out.set(path.relative(root, f), withoutHome(readFileSync(f, "utf8"), root));
    }
  };
  walk(root);
  return out;
}

async function scenario(collect: boolean, work: string) {
  const home = mkdtempSync(path.join(tmpdir(), `argus-h1-state-${collect ? "on" : "off"}-`));
  process.env.ARGUS_CLAUDE_HOME = home;
  mkdirSync(paths.argus(), { recursive: true });
  const T = Date.parse("2026-08-13T10:00:00.000Z");
  let t = T;
  const now = () => new Date(t);

  await createClaim(
    { id: "FACT-1", kind: "fact", statement: "the release notes live in NOTES.md" },
    new Date(T),
  );
  // Two finished runs H2 would sample: a failure and a timeout, each with a transcript.
  for (const [id, over] of [
    ["run-failed", {}],
    ["run-timeout", { termination: "timed-out" as const, exitCode: null }],
  ] as const) {
    const run = endedRun(id, MIN, {
      ...over,
      endedAt: new Date(T + MIN).toISOString(),
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

  // The shadow collection, wired as index.ts wires it, over an injected spawn.
  const shadowSpawns: string[] = [];
  const spawn: AnalysisSpawn = (o) => {
    shadowSpawns.push(o.prompt);
    const p = o.prompt.includes("Will the operator send")
      ? 0.2
      : o.prompt.includes("how did this run end")
        ? PROBE_P
        : RESIDUAL_P;
    const stdout = JSON.stringify({ result: JSON.stringify({ p }), total_cost_usd: 0.001 });
    return { kill() {}, done: Promise.resolve({ code: 0, stdout, error: null }) };
  };
  const runner = countAnalysisPasses(
    createAnalysisRunner({ spawn, now, blocked: async () => false, meter: async () => {} }),
  );
  const env = collect
    ? {
        ARGUS_DECISIONS: "on",
        ARGUS_DECISIONS_H1_COLLECT: "on",
        ARGUS_DECISIONS_H2_COLLECT: "on",
        ARGUS_DECISIONS_H2_RESIDUAL_RATE: "1",
        ARGUS_DECISIONS_H2_PROBE_RATE: "1",
      }
    : {};
  const experiments = createShadowExperiments({ runner, env, now });
  const tick = async (n: number, step = 16 * MIN) => {
    for (let i = 0; i < n; i++) {
      await experiments.check();
      t += step;
    }
  };

  let counter = 0;
  const spawned: Array<{ runId: string; phaseId: string; env: Record<string, string> }> = [];
  const engine = createEngine({
    now: () => new Date(2026, 7, 13, 12, 0),
    newId: () => `id-${++counter}`,
    // Deterministic per-run signal tokens: the two runs being compared must
    // write byte-identical instance records, digests included.
    newSignalToken: testRunToken,
    signalUrlBase: "http://localhost:7777",
    maxConcurrent: 4,
    tickMs: 30000,
    // Invented pids below: never let the real tree kill near them.
    kill: fakeKill().kill,
    spawn: (run, _log, runEnv) => {
      spawned.push({ runId: run.id, phaseId: run.phaseId ?? "", env: runEnv });
      if (runEnv.ARGUS_RESULT_FILE)
        writeFileSync(runEnv.ARGUS_RESULT_FILE, JSON.stringify({ accepted: true }));
      return { pid: 1000 + spawned.length, done: new Promise<{ code: number | null }>(() => {}) };
    },
  });
  const app = createApp({
    config,
    engine,
    broadcast: () => {},
    serveWeb: false,
    users: createUserStore(),
    remoteAddr: () => "127.0.0.1",
    auth: openAuth,
    decisionsH2Status: () => experiments.h2.status(),
    decisionsH1Status: () => experiments.h1.status(),
  });

  await tick(2);
  const created = await app.request("/api/pipelines", {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify(pipeline(work)),
  });
  assert.equal(created.status, 201);
  const def = (await created.json()) as { id: string; createdAt: string; updatedAt: string };
  const id = def.id;
  const started = await app.request(`/api/pipelines/${id}/start`, {
    method: "POST",
    headers: sameOrigin,
  });
  const instanceId = ((await started.json()) as { id: string }).id;
  const token = (await readInstance(instanceId))!.signalToken;
  const signal = async (i: number) => {
    const step = spawned[i];
    const res = await app.request(`/api/instances/${instanceId}/signal`, {
      method: "POST",
      headers: sameOrigin,
      body: JSON.stringify({
        phaseId: step.phaseId,
        runId: step.runId,
        type: "completed",
        // The run's own token, from the environment it was spawned with —
        // exactly what its stop hook would send.
        token: step.env.ARGUS_SIGNAL_TOKEN,
        payload: { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
        ...readResultFile(step.env.ARGUS_RESULT_FILE),
      }),
    });
    assert.equal(res.status, 202);
  };
  const waitSpawn = async (n: number) => {
    for (let i = 0; i < 1000 && spawned.length < n; i++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(spawned.length, n);
  };

  await waitSpawn(1);
  await signal(0);
  await tick(3); // shadow work while the route has been taken and publish waits at its gate
  await waitSpawn(2);
  await signal(1);
  await engine.drain();
  const atGate = await readInstance(instanceId);
  assert.equal(atGate!.phases.find((p) => p.id === "publish")!.status, "awaiting-approval");
  assert.deepEqual(atGate!.routeDecisions![0].selected, ["publish"]);
  await tick(3);
  // What the gate drawer shows while the gate waits, and the blinded report.
  const review = await (
    await app.request(`/api/instances/${instanceId}/phases/publish/review`, { headers: sameOrigin })
  ).text();
  const pendingReport = await app.request("/api/decisions/h1", { headers: sameOrigin });
  assert.equal(pendingReport.status, 200);
  const pendingBody = await pendingReport.text();
  assert.equal((await app.request("/api/decisions/h2", { headers: sameOrigin })).status, 200);
  // An observation a minute before the operator acts, as the 30-second tick
  // would make: the action is bracketed closely enough to vouch for the state.
  await tick(1, MIN);
  const approved = await app.request(`/api/instances/${instanceId}/approve`, {
    method: "POST",
    headers: sameOrigin,
    body: JSON.stringify({}),
  });
  assert.equal(approved.status, 200);
  await engine.drain();
  await tick(3);

  const ledger = await readLedger();
  const finalInstance = (await readInstance(instanceId))!;
  const overview = (
    (await (await app.request("/api/overview", { headers: sameOrigin })).json()) as {
      overview: OverviewEntry[];
    }
  ).overview;
  return {
    home,
    pipelineId: id,
    token,
    // The pipeline route stamps these from the wall clock, whatever H2 does.
    stamps: [def.createdAt, def.updatedAt],
    tree: tree(home),
    shadowSpawns,
    instance: finalInstance,
    overview,
    support: ledger.claims.map((c) => evaluateSupport(ledger, c)),
    report: await readH1ReportResponse(() => experiments.h1.status(), env),
    review,
    pendingBody,
    decisionDirs: DECISION_DIRS.filter((d) => existsSync(path.join(paths.argus(), d))),
  };
}

test("instance, route, gate, ledger, run state and the gate review are identical with H1 collection on and off", async () => {
  const saved = process.env.ARGUS_CLAUDE_HOME;
  try {
    // One working directory for both, so the phase's project slug is the same.
    const work = mkdtempSync(path.join(tmpdir(), "argus-h1-state-work-"));
    const off = await scenario(false, work);
    const on = await scenario(true, work);

    // Collection really ran in one and not the other.
    assert.equal(off.shadowSpawns.length, 0);
    assert.deepEqual(off.decisionDirs, []);
    const gateCalls = on.shadowSpawns.filter((p) => p.includes("Will the operator send"));
    assert.equal(gateCalls.length, 1, "H1 called once while the gate waited");
    assert.equal(on.report.report.census[0].captured, 1);
    assert.equal(on.report.report.census[0].labeled.approve, 1);
    assert.equal(on.report.report.models[0].agreement.scored, 1);
    assert.equal(off.report.report.census[0].captured, 0);
    // Blinded while pending: counts only, no prediction.
    const pending = JSON.parse(on.pendingBody) as {
      report: { pending: { total: number }; models: unknown[] };
    };
    assert.equal(pending.report.pending.total, 1);
    assert.deepEqual(pending.report.models, []);
    assert.ok(!on.pendingBody.includes('"p":0.2'));
    // The gate drawer's review is the same bytes with collection on and off.
    assert.equal(withoutHome(on.review, on.home), withoutHome(off.review, off.home));

    assert.equal(on.instance.status, off.instance.status);
    assert.deepEqual(on.instance.routeDecisions, off.instance.routeDecisions);
    assert.deepEqual(
      on.instance.phases.map((p) => [p.id, p.status]),
      off.instance.phases.map((p) => [p.id, p.status]),
    );
    assert.deepEqual(on.support, off.support);
    assert.deepEqual(on.overview.length, off.overview.length);

    // Byte for byte, outside the plane's own directories. Only the values the
    // server draws at random (the pipeline id, the signal token) or from the
    // wall clock (the definition's stamps) are replaced, each by its exact
    // string, in paths and contents alike. Instance journals are compared
    // with same-instant entries in a fixed order: the engine appends them
    // fire-and-forget, so their order varies between runs whatever H2 does
    // (see `settleJournalOrder`).
    const norm = (r: typeof on) => {
      const swaps: Array<[string, string]> = [
        ...r.stamps.map((v): [string, string] => [v, "<WALL-CLOCK>"]),
        [r.pipelineId, "<PIPELINE>"],
        [r.token, "<TOKEN>"],
      ];
      const fix = (x: string) => swaps.reduce((acc, [from, to]) => acc.split(from).join(to), x);
      return new Map([...r.tree].map(([k, v]) => [fix(k), settleJournalOrder(k, fix(v))]));
    };
    const a = norm(on);
    const b = norm(off);
    const keys = [...a.keys()].sort();
    assert.deepEqual(keys, [...b.keys()].sort(), "the same files exist");
    assert.ok(
      keys.some((k) => k.endsWith("gate-decisions.jsonl")),
      "the gate decision was recorded",
    );
    assert.ok(keys.some((k) => k.endsWith("knowledge.json")));
    assert.ok(
      keys.some((k) => k.includes("runs")),
      "run records are compared",
    );
    for (const k of keys) assert.equal(a.get(k), b.get(k), `${k} differs`);
  } finally {
    process.env.ARGUS_CLAUDE_HOME = saved;
  }
});
