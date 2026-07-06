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
import { readRun, readRuns, killRunProcess } from "./sources/runs.js";
import {
  createPipeline, deletePipeline, readPipelines, updatePipeline, validatePipelinePatch,
  validatePipelineInput, PipelineValidationError,
} from "./sources/pipelines.js";
import { readInstance, readInstances } from "./sources/instances.js";
import { buildOverview } from "./sources/overview.js";
import { createEngine, defaultPipelineSpawn, PreflightError } from "./pipelineEngine.js";
import type { PipelineSignal } from "./sources/pipelineTypes.js";
import { defaultSpawn, fireRun, startScheduler, isAlive } from "./scheduler.js";
import { randomUUID } from "node:crypto";
import {
  checkAll as checkPrereqs, applyAll as applyPrereqs,
  preflight as preflightPrereqs, repairSafeFixables,
} from "./setup/prereqs.js";
import { loadConfig } from "./config.js";
import { securityMiddleware, isUpgradeAllowed } from "./security.js";
import { VERSION } from "./version.js";

const config = loadConfig();
const PORT = config.port;

const engine = createEngine({
  now: () => new Date(),
  newId: () => randomUUID(),
  spawn: defaultPipelineSpawn,
  signalUrlBase: `http://127.0.0.1:${PORT}`,
  maxConcurrent: config.maxConcurrentRuns,
  tickMs: config.schedulerTickMs,
  onChange: () => broadcast({ type: "pipelines:changed" }),
  preflight: () => preflightPrereqs(),
});

const app = new Hono();

// Every API route is gated by the host/origin/token model in security.ts.
app.use("/api/*", securityMiddleware(config));

app.get("/api/health", (c) =>
  c.json({ ok: true, version: VERSION, claudeHome: claudeHome(), service: "argus" }),
);

app.get("/api/setup", async (c) => c.json(await checkPrereqs()));

app.post("/api/setup/apply", async (c) => c.json(await applyPrereqs()));

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
    const input = validatePipelineInput(body);
    const updated = await updatePipeline(c.req.param("id"), { ...input, model: input.model }, new Date());
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  } catch (e) {
    if (e instanceof PipelineValidationError) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.patch("/api/pipelines/:id", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  try {
    const updated = await updatePipeline(c.req.param("id"), validatePipelinePatch(body), new Date());
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
    if (e instanceof PreflightError) return c.json({ error: e.message, reasons: e.reasons }, 412);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

app.get("/api/pipelines/:id/instances", async (c) =>
  c.json({ instances: await readInstances({ pipelineId: c.req.param("id") }) }),
);

app.get("/api/overview", async (c) => {
  const [defs, insts] = await Promise.all([readPipelines(), readInstances()]);
  return c.json({ overview: buildOverview(defs, insts) });
});

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
  return c.json(res.ok ? { ok: true } : { ok: false, error: res.error }, res.code as 200 | 404 | 409);
});

app.post("/api/instances/:id/revise", async (c) => {
  const note = await c.req.json().then((b) => (b as { note?: string }).note).catch(() => undefined);
  const res = await engine.revise(c.req.param("id"), note);
  return c.json(res.ok ? { ok: true } : { ok: false, error: res.error }, res.code as 200 | 404 | 409);
});

app.post("/api/instances/:id/abort", async (c) => {
  const res = await engine.abort(c.req.param("id"));
  return c.json(res.ok ? { ok: true } : { ok: false, error: res.error }, res.code as 200 | 404 | 409);
});

// Catch-all error boundary so a thrown handler returns 500 JSON instead of a
// bare socket hangup, and every failure is logged with its route.
app.onError((err, c) => {
  console.error(`[argus] ${c.req.method} ${c.req.path} failed:`, err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});
app.notFound((c) => c.json({ error: "not found" }, 404));

const server = serve({ fetch: app.fetch, port: PORT, hostname: config.host }, (info) => {
  console.log(`[argus] v${VERSION} on http://${config.host}:${info.port}`);
  console.log(`[argus] watching ${claudeHome()}`);
  if (config.host !== "127.0.0.1" && config.host !== "localhost" && !config.token) {
    console.warn(
      "[argus] WARNING: bound to a non-loopback host without ARGUS_TOKEN — " +
      "anyone who can reach this port can execute agents. Set ARGUS_TOKEN.",
    );
  }
  void repairSafeFixables()
    .then(checkPrereqs)
    .then((s) => {
      if (!s.ok) {
        const bad = s.prereqs.filter((p) => p.status !== "ok").map((p) => `${p.label} (${p.status})`).join(", ");
        console.log(`[argus] setup incomplete — ${bad}. Open the UI to apply fixes.`);
      }
    });
});

// Live updates: push a "changed" ping whenever watched state mutates. The
// upgrade is guarded by the same host/origin/token model as the REST surface
// (Hono middleware does not see raw WebSocket upgrades).
const wss = new WebSocketServer({ noServer: true, path: "/ws" });
server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname !== "/ws") return;
  const allowed = isUpgradeAllowed(
    {
      host: req.headers.host,
      origin: req.headers.origin,
      authorization: req.headers.authorization,
      token: (req.headers["x-argus-token"] as string | undefined) ?? undefined,
    },
    config,
  );
  if (!allowed) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  // A client that resets the connection must not crash the server.
  ws.on("error", () => {});
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

/** Terminate every scheduler/pipeline child still alive, so shutdown does not
 *  orphan `claude -p` processes. */
async function killLiveRuns(): Promise<void> {
  const running = (await readRuns()).filter((r) => r.status === "running" && isAlive(r.pid));
  await Promise.all(running.map((r) => killRunProcess(r.pid)));
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopWatching();
  await stopWatchingSchedules();
  await scheduler.stop();
  await killLiveRuns();
  for (const client of wss.clients) client.terminate();
  wss.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A background rejection or thrown timer must not silently take down the
// daemon or leave it wedged: log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[argus] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[argus] uncaughtException:", err);
});
