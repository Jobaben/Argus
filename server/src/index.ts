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
import { watchAgents } from "./watch.js";

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

async function shutdown() {
  await stopWatching();
  wss.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
