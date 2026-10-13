import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { createEngine } from "./pipelineEngine.js";
import { fakeKill } from "./testPlatform.js";
import type { ArgusConfig } from "./config.js";
import type { AuthService } from "./auth.js";
import { testRunToken } from "./testSignalToken.js";
import { deletePipeline } from "./sources/pipelines.js";
import { readInstance, writeInstance } from "./sources/instances.js";

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

// Always-authenticated stub: these tests exercise the engine's HTTP contract;
// the admin gate itself is covered in app.test.ts / auth.test.ts.
const openAuth: AuthService = {
  isConfigured: async () => true,
  status: async () => ({ configured: true, username: "admin", role: "root" }),
  login: async () => ({ ok: false, reason: "bad-credentials" }),
  verify: () => ({ username: "admin", role: "root" }),
  logout: () => {},
  revokeSessions: () => {},
};

function appWith(over: Partial<Parameters<typeof createEngine>[0]> = {}) {
  const engine = createEngine({
    now: () => new Date(),
    newId: () => `id-${Math.random().toString(36).slice(2)}`,
    spawn: hangingSpawn,
    signalUrlBase: "http://127.0.0.1:7777",
    newSignalToken: testRunToken,
    maxConcurrent: 4,
    kill: fakeKill().kill,
    ...over,
  });
  const app = createApp({ config, engine, broadcast: () => {}, serveWeb: false, auth: openAuth });
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

// A two-phase pipeline; phase A optionally gated so approve/revise can be driven.
async function createTwoPhase(app: ReturnType<typeof appWith>["app"], gated: boolean) {
  const res = await app.request("/api/pipelines", {
    method: "POST",
    headers: same,
    body: JSON.stringify({
      name: "p2",
      trigger: null,
      phases: [
        { id: "a", name: "A", cwd: home, gated, steps: [{ name: "sa", prompt: "go" }] },
        { id: "b", name: "B", cwd: home, gated: false, steps: [{ name: "sb", prompt: "go" }] },
      ],
    }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
}

interface InstanceShape {
  id: string;
  signalToken: string;
  status: string;
  currentPhaseIndex: number;
  abortCause?: string;
  phases: { id: string; status: string; steps: { runId: string; status: string }[] }[];
}

async function getInstance(
  app: ReturnType<typeof appWith>["app"],
  id: string,
): Promise<InstanceShape> {
  const res = await app.request(`/api/instances/${id}`, { headers: loopback });
  assert.equal(res.status, 200);
  return (await res.json()) as InstanceShape;
}

test("real engine: a valid completed signal advances a non-gated phase and spawns the next", async () => {
  const { app } = appWith();
  const def = await createTwoPhase(app, false);
  const start = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  const started = (await start.json()) as { id: string };

  const inst = await getInstance(app, started.id);
  assert.equal(inst.currentPhaseIndex, 0);
  const runId = inst.phases[0].steps[0].runId;

  const sig = await app.request(`/api/instances/${started.id}/signal`, {
    method: "POST",
    headers: same,
    body: JSON.stringify({
      phaseId: "a",
      runId,
      type: "completed",
      token: testRunToken(runId),
      payload: { last_assistant_message: "done\nARGUS_OUTCOME: succeeded" },
    }),
  });
  assert.equal(sig.status, 202);

  // The deferred next-phase start runs under the instance lock; poll briefly.
  let after = await getInstance(app, started.id);
  for (let i = 0; i < 20 && after.currentPhaseIndex !== 1; i++) {
    await new Promise((r) => setTimeout(r, 10));
    after = await getInstance(app, started.id);
  }
  assert.equal(after.currentPhaseIndex, 1);
  assert.equal(after.phases[1].steps.length, 1);
  assert.equal(after.status, "running");
});

test("real engine: gated phase → needs-input pauses, approve advances to the next phase", async () => {
  const { app } = appWith();
  const def = await createTwoPhase(app, true);
  const start = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  const started = (await start.json()) as { id: string };
  const inst = await getInstance(app, started.id);

  const sig = await app.request(`/api/instances/${started.id}/signal`, {
    method: "POST",
    headers: same,
    body: JSON.stringify({
      phaseId: "a",
      runId: inst.phases[0].steps[0].runId,
      type: "needs-input",
      token: testRunToken(inst.phases[0].steps[0].runId),
      payload: "Q?",
    }),
  });
  assert.equal(sig.status, 202);
  assert.equal((await getInstance(app, started.id)).status, "awaiting-approval");

  const approve = await app.request(`/api/instances/${started.id}/approve`, {
    method: "POST",
    headers: same,
    body: JSON.stringify({ answers: "USE TS" }),
  });
  assert.equal(approve.status, 200);
  const after = await getInstance(app, started.id);
  assert.equal(after.currentPhaseIndex, 1);
});

test("real engine: revise re-runs the paused phase (200, back to running)", async () => {
  const { app } = appWith();
  const def = await createTwoPhase(app, true);
  const start = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  const started = (await start.json()) as { id: string };
  const inst = await getInstance(app, started.id);
  await app.request(`/api/instances/${started.id}/signal`, {
    method: "POST",
    headers: same,
    body: JSON.stringify({
      phaseId: "a",
      runId: inst.phases[0].steps[0].runId,
      type: "needs-input",
      token: testRunToken(inst.phases[0].steps[0].runId),
    }),
  });
  assert.equal((await getInstance(app, started.id)).status, "awaiting-approval");

  const revise = await app.request(`/api/instances/${started.id}/revise`, {
    method: "POST",
    headers: same,
    body: JSON.stringify({ note: "try again" }),
  });
  assert.equal(revise.status, 200);
  const after = await getInstance(app, started.id);
  assert.equal(after.status, "running");
  assert.equal(after.currentPhaseIndex, 0);
});

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

// ── Instances whose pipeline was deleted (WS14) ─────────────────────────────

/** Start the two-phase gated pipeline and pause its first phase at the gate. */
async function startPausedAtGate(app: ReturnType<typeof appWith>["app"]) {
  const def = await createTwoPhase(app, true);
  const start = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  const { id } = (await start.json()) as { id: string };
  const runId = (await getInstance(app, id)).phases[0].steps[0].runId;
  const sig = await app.request(`/api/instances/${id}/signal`, {
    method: "POST",
    headers: same,
    body: JSON.stringify({
      phaseId: "a",
      runId,
      type: "needs-input",
      token: testRunToken(runId),
      payload: "Q?",
    }),
  });
  assert.equal(sig.status, 202, "the gate signal is accepted");
  assert.equal((await getInstance(app, id)).status, "awaiting-approval", "A waits at its gate");
  return { pipelineId: def.id, instanceId: id };
}

async function hasPipeline(app: ReturnType<typeof appWith>["app"], id: string) {
  const res = await app.request("/api/pipelines", { headers: loopback });
  return ((await res.json()) as { pipelines: { id: string }[] }).pipelines.some((p) => p.id === id);
}

interface OverviewShape {
  overview: {
    definition: { id: string };
    orphaned?: boolean;
    latest: { id: string; phases: { status: string }[] } | null;
  }[];
}

test("deleting a pipeline aborts its live instances first", async () => {
  const { app } = appWith();
  const { pipelineId, instanceId } = await startPausedAtGate(app);

  const res = await app.request(`/api/pipelines/${pipelineId}`, {
    method: "DELETE",
    headers: same,
  });
  assert.equal(res.status, 200, "the delete succeeds");
  assert.deepEqual(
    ((await res.json()) as { aborted: string[] }).aborted,
    [instanceId],
    "the reply names what it stopped",
  );
  const stopped = await getInstance(app, instanceId);
  assert.equal(stopped.status, "aborted", "the instance is aborted");
  assert.equal(stopped.abortCause, "pipeline-deleted", "and says why, so it chains nothing");
  assert.equal(await hasPipeline(app, pipelineId), false, "the pipeline is deleted");
  const board = (await (
    await app.request("/api/overview", { headers: loopback })
  ).json()) as OverviewShape;
  assert.equal(board.overview.length, 0, "nothing is left on the board");
});

test("a live instance of a deleted pipeline is on the board, counted, and can be aborted", async () => {
  const { app } = appWith();
  const { pipelineId, instanceId } = await startPausedAtGate(app);
  // Deleted behind the route's back, as a pipeline deleted before WS14 was,
  // and with no snapshot, as an instance written before snapshots existed.
  assert.equal(await deletePipeline(pipelineId), true, "the definition is removed");
  const stored = await readInstance(instanceId);
  delete stored!.definition;
  await writeInstance(stored!);

  const board = (await (
    await app.request("/api/overview", { headers: loopback })
  ).json()) as OverviewShape;
  assert.equal(board.overview.length, 1, "the orphan gets a card");
  const [entry] = board.overview;
  assert.equal(entry.orphaned, true, "marked as orphaned");
  assert.equal(entry.definition.id, pipelineId, "under its own pipeline id");
  assert.equal(entry.latest?.id, instanceId, "showing the live instance");

  const insight = (await (await app.request("/api/insight", { headers: loopback })).json()) as {
    counts: { gatesWaiting: number };
  };
  const onBoard = board.overview.filter((e) =>
    e.latest?.phases.some((p) => p.status === "awaiting-approval"),
  ).length;
  assert.equal(insight.counts.gatesWaiting, onBoard, "the gate count matches the board");
  assert.equal(onBoard, 1, "one gate waits");

  const approve = await app.request(`/api/instances/${instanceId}/approve`, {
    method: "POST",
    headers: same,
  });
  assert.equal(
    approve.status,
    404,
    "no definition, no approval: refused before anything is recorded",
  );
  const abort = await app.request(`/api/instances/${instanceId}/abort`, {
    method: "POST",
    headers: same,
  });
  assert.equal(abort.status, 200, "the abort works without the definition");
  const after = (await (
    await app.request("/api/overview", { headers: loopback })
  ).json()) as OverviewShape;
  assert.equal(after.overview.length, 0, "an ended orphan leaves the board");
});

test("a delete whose abort is refused keeps the pipeline", async () => {
  const { app: started, engine } = appWith();
  const { pipelineId, instanceId } = await startPausedAtGate(started);
  // The same store, behind an engine that cannot stop the instance.
  const app = createApp({
    config,
    engine: { ...engine, abort: async () => ({ ok: false, code: 409, error: "held" }) },
    broadcast: () => {},
    serveWeb: false,
    auth: openAuth,
  });

  const res = await app.request(`/api/pipelines/${pipelineId}`, {
    method: "DELETE",
    headers: same,
  });
  assert.equal(res.status, 409, "the delete is refused");
  const body = (await res.json()) as { code: string; instanceId: string };
  assert.equal(body.code, "instance-not-stopped", "says why");
  assert.equal(body.instanceId, instanceId, "names the instance");
  assert.equal(await hasPipeline(app, pipelineId), true, "the definition is kept");
});

// ── Gate decision provenance over HTTP (Phase 0) ────────────────────────────

test("regression: an approval's principal comes from the session; a body claiming to be someone is ignored", async () => {
  const { app } = appWith();
  const def = await createTwoPhase(app, true);
  const start = await app.request(`/api/pipelines/${def.id}/start`, {
    method: "POST",
    headers: same,
  });
  const started = (await start.json()) as { id: string };
  const inst = await getInstance(app, started.id);
  await app.request(`/api/instances/${started.id}/signal`, {
    method: "POST",
    headers: same,
    body: JSON.stringify({
      phaseId: "a",
      runId: inst.phases[0].steps[0].runId,
      type: "needs-input",
      token: testRunToken(inst.phases[0].steps[0].runId),
    }),
  });

  const approve = await app.request(`/api/instances/${started.id}/approve`, {
    method: "POST",
    headers: same,
    body: JSON.stringify({
      actor: "human",
      mechanism: "operator",
      principal: { kind: "session", username: "mallory", role: "root" },
      source: { channel: "http", principal: { kind: "session", username: "mallory" } },
    }),
  });
  assert.equal(approve.status, 200);

  const read = await app.request(`/api/instances/${started.id}/gate-decisions`, {
    headers: loopback,
  });
  assert.equal(read.status, 200);
  const body = (await read.json()) as {
    decisions: Array<{ mechanism: string; channel: string; principal: unknown; effect: string }>;
    undocumented: unknown[];
  };
  assert.equal(body.decisions.length, 1);
  assert.equal(body.decisions[0].mechanism, "operator");
  assert.equal(body.decisions[0].channel, "http");
  assert.deepEqual(body.decisions[0].principal, {
    kind: "session",
    username: "admin",
    role: "root",
  });
  assert.equal(body.decisions[0].effect, "applied");
});

test("the gate-decision read is a 404 for an instance Argus has never heard of", async () => {
  const { app } = appWith();
  const res = await app.request(`/api/instances/nope/gate-decisions`, { headers: loopback });
  assert.equal(res.status, 404);
});
