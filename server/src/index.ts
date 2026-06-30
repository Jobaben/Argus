import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { claudeHome } from "./claudeHome.js";
import { readAgents, readTimeline } from "./sources/jobs.js";
import { readDaemon } from "./sources/daemon.js";
import { readSessions, readSession } from "./sources/sessions.js";
import { readActivity } from "./sources/history.js";
import { readProjects } from "./sources/projects.js";
import { readStats } from "./sources/stats.js";
import { readInventory } from "./sources/inventory.js";
import { readTasks } from "./sources/tasks.js";
import { searchTranscripts } from "./sources/search.js";
import { readCron } from "./sources/cron.js";
import { watchAgents, watchSchedules } from "./watch.js";
import {
  createSchedule,
  deleteSchedule,
  readSchedulesWithNext,
  updateSchedule,
  validateInput,
  validatePatch,
  ScheduleValidationError,
  readSchedules,
} from "./sources/schedules.js";
import { readRun, readRuns } from "./sources/runs.js";
import {
  createPipeline, deletePipeline, readPipelines, updatePipeline,
  validatePipelineInput, PipelineValidationError,
} from "./sources/pipelines.js";
import { readInstance, readInstances } from "./sources/instances.js";
import { createEngine, defaultPipelineSpawn } from "./pipelineEngine.js";
import type { PipelineSignal } from "./sources/pipelineTypes.js";
import { defaultSpawn, fireRun, startScheduler } from "./scheduler.js";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.ARGUS_PORT ?? 7777);

const engine = createEngine({
  now: () => new Date(),
  newId: () => randomUUID(),
  spawn: defaultPipelineSpawn,
  signalUrlBase: `http://localhost:${PORT}`,
  maxConcurrent: Number(process.env.ARGUS_MAX_CONCURRENT_RUNS ?? 4),
  tickMs: Number(process.env.ARGUS_SCHED_TICK_MS ?? 30000),
  onChange: () => broadcast({ type: "pipelines:changed" }),
});

const app = new Hono();

app.get("/api/health", (c) =>
  c.json({ ok: true, claudeHome: claudeHome(), service: "argus" }),
);

app.get("/api/agents", async (c) => c.json({ agents: await readAgents() }));

app.get("/api/agents/:short/timeline", async (c) =>
  c.json({ timeline: await readTimeline(c.req.param("short")) }),
);

app.get("/api/daemon", async (c) => c.json(await readDaemon()));

app.get("/api/sessions", async (c) => c.json({ sessions: await readSessions() }));

app.get("/api/sessions/:project/:id", async (c) =>
  c.json(await readSession(c.req.param("project"), c.req.param("id"))),
);

app.get("/api/activity", async (c) => c.json({ activity: await readActivity() }));

app.get("/api/projects", async (c) => c.json({ projects: await readProjects() }));

app.get("/api/stats", async (c) => c.json(await readStats()));

app.get("/api/inventory", async (c) => c.json(await readInventory()));

app.get("/api/tasks", async (c) => c.json({ tasks: await readTasks() }));

app.get("/api/search", async (c) =>
  c.json({ results: await searchTranscripts(c.req.query("q") ?? "") }),
);

app.get("/api/cron", async (c) => c.json(await readCron()));

app.get("/api/schedules", async (c) =>
  c.json({ schedules: await readSchedulesWithNext(new Date()) }),
);

app.post("/api/schedules", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  try {
    const input = validateInput(body);
    const created = await createSchedule(input, new Date(), randomUUID());
    return c.json(created, 201);
  } catch (e) {
    if (e instanceof ScheduleValidationError) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.put("/api/schedules/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  try {
    const patch = validatePatch(body);
    const updated = await updateSchedule(c.req.param("id"), patch, new Date());
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  } catch (e) {
    if (e instanceof ScheduleValidationError) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.delete("/api/schedules/:id", async (c) =>
  (await deleteSchedule(c.req.param("id")))
    ? c.json({ ok: true })
    : c.json({ error: "not found" }, 404),
);

app.post("/api/schedules/:id/run", async (c) => {
  try {
    const all = await readSchedules();
    const schedule = all.find((s) => s.id === c.req.param("id"));
    if (!schedule) return c.json({ error: "not found" }, 404);
    const run = await fireRun(schedule, "manual", {
      now: () => new Date(),
      spawn: defaultSpawn,
      tickMs: Number(process.env.ARGUS_SCHED_TICK_MS ?? 30000),
      newId: () => randomUUID(),
      onChange: () => broadcast({ type: "schedules:changed" }),
    });
    return c.json(run, 202);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.get("/api/runs", async (c) => {
  const limitRaw = c.req.query("limit");
  const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 100;
  return c.json({
    runs: await readRuns({
      scheduleId: c.req.query("scheduleId") || undefined,
      limit,
    }),
  });
});

app.get("/api/runs/:id", async (c) => {
  const got = await readRun(c.req.param("id"));
  return got ? c.json(got) : c.json({ error: "not found" }, 404);
});

app.get("/api/pipelines", async (c) => c.json({ pipelines: await readPipelines() }));

app.post("/api/pipelines", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  try {
    const created = await createPipeline(validatePipelineInput(body), new Date(), randomUUID());
    return c.json(created, 201);
  } catch (e) {
    if (e instanceof PipelineValidationError) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.put("/api/pipelines/:id", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  try {
    const updated = await updatePipeline(c.req.param("id"), validatePipelineInput(body), new Date());
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  } catch (e) {
    if (e instanceof PipelineValidationError) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.delete("/api/pipelines/:id", async (c) =>
  (await deletePipeline(c.req.param("id")))
    ? c.json({ ok: true })
    : c.json({ error: "not found" }, 404),
);

app.post("/api/pipelines/:id/start", async (c) => {
  try {
    const inst = await engine.start(c.req.param("id"), "manual");
    if (!inst) return c.json({ error: "an instance is already running (overlap=skip)" }, 409);
    return c.json(inst, 202);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.get("/api/pipelines/:id/instances", async (c) =>
  c.json({ instances: await readInstances({ pipelineId: c.req.param("id") }) }),
);

app.get("/api/instances/:id", async (c) => {
  const inst = await readInstance(c.req.param("id"));
  return inst ? c.json(inst) : c.json({ error: "not found" }, 404);
});

app.post("/api/instances/:id/signal", async (c) => {
  let body: Partial<PipelineSignal>;
  try { body = (await c.req.json()) as Partial<PipelineSignal>; } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const id = c.req.param("id");
  const signal: PipelineSignal = {
    instanceId: id,
    phaseId: String(body.phaseId ?? ""),
    runId: String(body.runId ?? ""),
    type: (body.type ?? "completed") as PipelineSignal["type"],
    token: String(body.token ?? ""),
    payload: body.payload,
  };
  const res = await engine.onSignal(id, signal);
  return c.json({ ok: res.ok }, res.code as 200 | 202 | 403 | 404);
});

app.post("/api/instances/:id/approve", async (c) => {
  const answers = await c.req.json().then((b) => (b as { answers?: unknown }).answers).catch(() => undefined);
  const res = await engine.approve(c.req.param("id"), answers);
  return c.json({ ok: res.ok }, res.code as 200 | 404 | 409);
});

app.post("/api/instances/:id/revise", async (c) => {
  const note = await c.req.json().then((b) => (b as { note?: string }).note).catch(() => undefined);
  const res = await engine.revise(c.req.param("id"), note);
  return c.json({ ok: res.ok }, res.code as 200 | 404 | 409);
});

app.post("/api/instances/:id/abort", async (c) => {
  const res = await engine.abort(c.req.param("id"));
  return c.json({ ok: res.ok }, res.code as 200 | 404);
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[argus] server on http://localhost:${info.port}`);
  console.log(`[argus] watching ${claudeHome()}`);
});

// Live updates: push a "changed" ping whenever watched state mutates.
const wss = new WebSocketServer({ server: server as never, path: "/ws" });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "hello" }));
});

function broadcast(message: unknown) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

const stopWatching = watchAgents(() => broadcast({ type: "agents:changed" }));
const stopWatchingSchedules = watchSchedules(() =>
  broadcast({ type: "schedules:changed" }),
);
const scheduler = startScheduler({
  onChange: () => broadcast({ type: "schedules:changed" }),
  onTick: () => engine.reconcile(),
});

async function shutdown() {
  await stopWatching();
  await stopWatchingSchedules();
  await scheduler.stop();
  wss.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
