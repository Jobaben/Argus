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
  ScheduleValidationError,
  readSchedules,
} from "./sources/schedules.js";
import { readRun, readRuns } from "./sources/runs.js";
import { defaultSpawn, fireRun, startScheduler } from "./scheduler.js";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.ARGUS_PORT ?? 7777);

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
  try {
    const body = await c.req.json();
    const input = validateInput(body);
    const created = await createSchedule(input, new Date(), randomUUID());
    return c.json(created, 201);
  } catch (e) {
    if (e instanceof ScheduleValidationError) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.put("/api/schedules/:id", async (c) => {
  try {
    const body = await c.req.json();
    // Full validation when core fields are present; partial enable/disable allowed.
    if ("prompt" in body || "cwd" in body || "trigger" in body || "name" in body) {
      validateInput({ ...body, name: body.name ?? "x", prompt: body.prompt ?? "x", cwd: body.cwd ?? process.cwd() });
    }
    const updated = await updateSchedule(c.req.param("id"), body, new Date());
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
});

app.get("/api/runs", async (c) =>
  c.json({
    runs: await readRuns({
      scheduleId: c.req.query("scheduleId") || undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : 100,
    }),
  }),
);

app.get("/api/runs/:id", async (c) => {
  const got = await readRun(c.req.param("id"));
  return got ? c.json(got) : c.json({ error: "not found" }, 404);
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
