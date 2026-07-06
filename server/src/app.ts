import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { claudeHome } from "./claudeHome.js";
import { readAgents, readTimeline } from "./sources/jobs.js";
import { readDaemon } from "./sources/daemon.js";
import { readSessions, readSession, sessionToMarkdown } from "./sources/sessions.js";
import { readActivity } from "./sources/history.js";
import { readProjects } from "./sources/projects.js";
import { readStats } from "./sources/stats.js";
import { readInventory } from "./sources/inventory.js";
import { readTasks } from "./sources/tasks.js";
import { searchTranscripts } from "./sources/search.js";
import { readCron } from "./sources/cron.js";
import {
  createSchedule, deleteSchedule, readSchedulesWithNext, updateSchedule,
  validateInput, validatePatch, ScheduleValidationError, readSchedules,
} from "./sources/schedules.js";
import { readRun, readRuns, cancelRun } from "./sources/runs.js";
import {
  createPipeline, deletePipeline, readPipelines, updatePipeline, validatePipelinePatch,
  validatePipelineInput, PipelineValidationError,
} from "./sources/pipelines.js";
import { readInstance, readInstances } from "./sources/instances.js";
import { buildOverview } from "./sources/overview.js";
import { PreflightError, type Engine } from "./pipelineEngine.js";
import type { PipelineSignal } from "./sources/pipelineTypes.js";
import { defaultSpawn, fireRun, isAlive } from "./scheduler.js";
import type { ArgusConfig } from "./config.js";
import { securityMiddleware } from "./security.js";
import { VERSION } from "./version.js";
import { mountWebApp } from "./static.js";
import { buildRunFailurePayload, postWebhook } from "./notify.js";

export interface AppDeps {
  config: ArgusConfig;
  engine: Engine;
  /** Emit a live-update ping to connected WebSocket clients. */
  broadcast: (message: unknown) => void;
  /** Whether to mount the built SPA (skipped in tests). Defaults to true. */
  serveWeb?: boolean;
}

/**
 * Build the Hono application: security middleware, every /api route, the
 * optional SPA mount, and the error/404 boundary. Pure of process side effects
 * (no listen, no watchers, no scheduler) so it can be exercised with
 * `app.request(...)` in tests.
 */
export function createApp(deps: AppDeps): Hono {
  const { config, engine, broadcast } = deps;
  const app = new Hono();

  const notifyRunFailed = (run: Parameters<typeof buildRunFailurePayload>[0]) =>
    void postWebhook(config.webhookUrl, buildRunFailurePayload(run, new Date().toISOString()));

  app.use("/api/*", securityMiddleware(config));

  app.get("/api/health", (c) =>
    c.json({ ok: true, version: VERSION, claudeHome: claudeHome(), service: "argus" }),
  );

  app.get("/api/setup", async (c) => c.json(await import("./setup/prereqs.js").then((m) => m.checkAll())));
  app.post("/api/setup/apply", async (c) => c.json(await import("./setup/prereqs.js").then((m) => m.applyAll())));

  app.get("/api/agents", async (c) => c.json({ agents: await readAgents() }));
  app.get("/api/agents/:short/timeline", async (c) =>
    c.json({ timeline: await readTimeline(c.req.param("short")) }),
  );
  app.get("/api/daemon", async (c) => c.json(await readDaemon()));

  app.get("/api/sessions", async (c) => c.json({ sessions: await readSessions() }));
  app.get("/api/sessions/:project/:id", async (c) =>
    c.json(await readSession(c.req.param("project"), c.req.param("id"))),
  );
  app.get("/api/sessions/:project/:id/export", async (c) => {
    const session = await readSession(c.req.param("project"), c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    return c.body(sessionToMarkdown(session), 200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="argus-session-${session.id}.md"`,
    });
  });

  app.get("/api/activity", async (c) => c.json({ activity: await readActivity() }));
  app.get("/api/projects", async (c) => c.json({ projects: await readProjects() }));
  app.get("/api/stats", async (c) => c.json(await readStats()));
  app.get("/api/inventory", async (c) => c.json(await readInventory()));
  app.get("/api/tasks", async (c) => c.json({ tasks: await readTasks() }));
  app.get("/api/search", async (c) => c.json({ results: await searchTranscripts(c.req.query("q") ?? "") }));
  app.get("/api/cron", async (c) => c.json(await readCron()));

  app.get("/api/schedules", async (c) => c.json({ schedules: await readSchedulesWithNext(new Date()) }));

  app.post("/api/schedules", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    try {
      const created = await createSchedule(validateInput(body), new Date(), randomUUID());
      return c.json(created, 201);
    } catch (e) {
      if (e instanceof ScheduleValidationError) return c.json({ error: e.message }, 400);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.put("/api/schedules/:id", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
    try {
      const updated = await updateSchedule(c.req.param("id"), validatePatch(body), new Date());
      if (!updated) return c.json({ error: "not found" }, 404);
      return c.json(updated);
    } catch (e) {
      if (e instanceof ScheduleValidationError) return c.json({ error: e.message }, 400);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.delete("/api/schedules/:id", async (c) =>
    (await deleteSchedule(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
  );

  app.post("/api/schedules/:id/run", async (c) => {
    try {
      const schedule = (await readSchedules()).find((s) => s.id === c.req.param("id"));
      if (!schedule) return c.json({ error: "not found" }, 404);
      // Manual runs honour overlap=skip too — Run-now must not bypass the guard.
      if (schedule.overlapPolicy === "skip") {
        const live = (await readRuns({ scheduleId: schedule.id })).some(
          (r) => r.status === "running" && isAlive(r.pid),
        );
        if (live) return c.json({ error: "a run is already in progress (overlap=skip)" }, 409);
      }
      const run = await fireRun(schedule, "manual", {
        now: () => new Date(),
        spawn: defaultSpawn,
        tickMs: config.schedulerTickMs,
        newId: () => randomUUID(),
        onChange: () => broadcast({ type: "schedules:changed" }),
        onFailure: notifyRunFailed,
      });
      return c.json(run, 202);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get("/api/runs", async (c) => {
    const limitRaw = c.req.query("limit");
    const limit = limitRaw && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 100;
    return c.json({ runs: await readRuns({ scheduleId: c.req.query("scheduleId") || undefined, limit }) });
  });

  app.get("/api/runs/:id", async (c) => {
    const got = await readRun(c.req.param("id"));
    return got ? c.json(got) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/runs/:id/cancel", async (c) => {
    const outcome = await cancelRun(c.req.param("id"), new Date());
    if (outcome === "not-found") return c.json({ error: "not found" }, 404);
    if (outcome === "not-running") return c.json({ error: "run is not running" }, 409);
    broadcast({ type: "schedules:changed" });
    return c.json({ ok: true });
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
    (await deletePipeline(c.req.param("id"))) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404),
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

  if (deps.serveWeb !== false) mountWebApp(app);

  app.onError((err, c) => {
    console.error(`[argus] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
