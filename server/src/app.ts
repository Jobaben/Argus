import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { claudeHome } from "./claudeHome.js";
import { readAgents, readTimeline } from "./sources/jobs.js";
import { readDaemon } from "./sources/daemon.js";
import {
  readSessions,
  readSession,
  readSessionTail,
  sessionToMarkdown,
} from "./sources/sessions.js";
import { readActivity } from "./sources/history.js";
import { readProjects } from "./sources/projects.js";
import { readStats } from "./sources/stats.js";
import { readInventory } from "./sources/inventory.js";
import { readTasks } from "./sources/tasks.js";
import { searchTranscripts } from "./sources/search.js";
import { readCron } from "./sources/cron.js";
import { buildChronicle } from "./sources/chronicle.js";
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
import { readRun, readRuns, cancelRun } from "./sources/runs.js";
import { buildMonitors } from "./sources/monitors.js";
import {
  buildIssues,
  issueOccurrences,
  readTriage,
  setTriage,
  clearTriage,
  IssueValidationError,
} from "./sources/issues.js";
import {
  createPipeline,
  deletePipeline,
  readPipelines,
  updatePipeline,
  validatePipelinePatch,
  validatePipelineInput,
  PipelineValidationError,
} from "./sources/pipelines.js";
import { readInstance, readInstances } from "./sources/instances.js";
import { readTotals, resetTotals } from "./sources/totals.js";
import { buildOverview } from "./sources/overview.js";
import { PreflightError, type Engine } from "./pipelineEngine.js";
import type { PipelineSignal } from "./sources/pipelineTypes.js";
import type { ActivityEvent } from "./runTailer.js";
import { defaultSpawn, fireRun, isAlive } from "./scheduler.js";
import type { ArgusConfig } from "./config.js";
import { securityMiddleware } from "./security.js";
import { setCookie, deleteCookie } from "hono/cookie";
import { getConnInfo } from "@hono/node-server/conninfo";
import {
  createAuthService,
  requireAdmin,
  requireRoot,
  sessionToken,
  AuthValidationError,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type AuthService,
} from "./auth.js";
import {
  createUserStore,
  DuplicateUsernameError,
  UnknownUserError,
  type UserStore,
} from "./userStore.js";
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
  /** Latest activity per running step run, from the run tailer. */
  activity?: () => Map<string, ActivityEvent>;
  /** Admin auth for pipeline edit/run routes. Defaults to the real service. */
  auth?: AuthService;
  /** User accounts backing auth. Defaults to the real store. */
  users?: UserStore;
  /** Socket peer address, injectable for tests. Defaults to the node-server conninfo. */
  remoteAddr?: (c: Context) => string | null;
}

/**
 * Build the Hono application: security middleware, every /api route, the
 * optional SPA mount, and the error/404 boundary. Pure of process side effects
 * (no listen, no watchers, no scheduler) so it can be exercised with
 * `app.request(...)` in tests.
 */
export function createApp(deps: AppDeps): Hono {
  const { config, engine, broadcast } = deps;
  const users = deps.users ?? createUserStore();
  const auth = deps.auth ?? createAuthService({ store: users });
  const remoteAddr =
    deps.remoteAddr ??
    ((c: Context) => {
      try {
        return getConnInfo(c).remote.address ?? null;
      } catch {
        return null; // no socket (e.g. app.request in tests) — fail closed
      }
    });
  const app = new Hono();

  const notifyRunFailed = (run: Parameters<typeof buildRunFailurePayload>[0]) =>
    void postWebhook(config.webhookUrl, buildRunFailurePayload(run, new Date().toISOString()));

  // Parse a JSON body, or short-circuit with a 400. Returns a discriminated
  // result so the handler can `if (!parsed.ok) return parsed.res`.
  async function jsonBody(c: Context) {
    try {
      return { ok: true as const, value: (await c.req.json()) as unknown };
    } catch {
      return { ok: false as const, res: c.json({ error: "invalid JSON body" }, 400) };
    }
  }

  // Map a thrown validation error to 400 and anything else to 500 — the same
  // shape every create/update handler needs.
  function fail(c: Context, e: unknown, ValidationError: new (...a: never[]) => Error) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  // Shared reply shape for engine gate actions (approve / revise / abort).
  function engineReply(c: Context, res: { ok: boolean; code: number; error?: string }) {
    return c.json(
      res.ok ? { ok: true } : { ok: false, error: res.error },
      res.code as 200 | 404 | 409,
    );
  }

  app.use("/api/*", securityMiddleware(config));

  app.get("/api/health", (c) =>
    c.json({ ok: true, version: VERSION, claudeHome: claudeHome(), service: "argus" }),
  );

  // ── Admin auth ────────────────────────────────────────────────────────────
  // Editing or running a pipeline executes agents with the user's credentials,
  // so those routes require an admin session on top of the host/origin layers.

  const setSessionCookie = (c: Context, token: string) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });

  app.get("/api/auth/status", async (c) => {
    const { configured, username, role } = await auth.status(sessionToken(c));
    return c.json({ configured, authenticated: username !== null, username, role });
  });

  const LOOPBACK_ADDRS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  // Unauthenticated endpoint — cap queue growth/DoS from unbounded self-registration.
  const MAX_PENDING_REGISTRATIONS = 20;

  // Self-registration. The very first account is the bootstrap case: it can
  // only be created from the server's own machine (closing the network race
  // for root) and is logged straight in. Everyone after that lands pending
  // until root approves them on the Users page.
  const handleRegister = async (c: Context) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    const { username, password } = (body.value ?? {}) as Record<string, unknown>;

    const bootstrap = (await users.count()) === 0;
    try {
      if (bootstrap) {
        const addr = remoteAddr(c);
        if (!addr || !LOOPBACK_ADDRS.has(addr)) {
          return c.json(
            {
              error: "the first account (root) can only be created from localhost",
              code: "bootstrap_localhost_only",
            },
            403,
          );
        }
        await users.register(username, password, { role: "root", status: "active" });
      } else {
        const pending = (await users.list()).filter((u) => u.status === "pending").length;
        if (pending >= MAX_PENDING_REGISTRATIONS) {
          return c.json(
            { error: "too many pending registrations — ask the root user to clear the queue" },
            429,
          );
        }
        await users.register(username, password);
      }
    } catch (e) {
      if (e instanceof DuplicateUsernameError) return c.json({ error: e.message }, 409);
      if (e instanceof AuthValidationError) return c.json({ error: e.message }, 400);
      throw e;
    }

    if (!bootstrap) return c.json({ ok: true, pending: true }, 201);
    const res = await auth.login(username, password);
    if (!res.ok) return c.json({ error: "setup succeeded but login failed" }, 500);
    setSessionCookie(c, res.token);
    return c.json(
      { ok: true, username: res.username, role: res.role, expiresAt: res.expiresAt },
      201,
    );
  };
  app.post("/api/auth/register", handleRegister);
  // Kept as an alias so an already-open first-run UI keeps working.
  app.post("/api/auth/setup", handleRegister);

  app.post("/api/auth/login", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    const { username, password } = (body.value ?? {}) as Record<string, unknown>;
    const res = await auth.login(username, password);
    if (!res.ok) {
      if (res.reason === "locked") {
        return c.json({ error: "too many failed attempts — try again shortly" }, 429);
      }
      if (res.reason === "not-configured") {
        return c.json({ error: "no admin account yet", code: "auth_setup_required" }, 401);
      }
      if (res.reason === "pending-approval") {
        return c.json({ error: "account awaiting root approval", code: "pending_approval" }, 403);
      }
      return c.json({ error: "invalid username or password" }, 401);
    }
    setSessionCookie(c, res.token);
    return c.json({ ok: true, username: res.username, expiresAt: res.expiresAt });
  });

  app.post("/api/auth/logout", (c) => {
    auth.logout(sessionToken(c));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  const admin = requireAdmin(auth);

  // ── User administration (root only) ────────────────────────────────────────
  const root = requireRoot(auth);
  app.use("/api/users", root);
  app.use("/api/users/:username/approve", root);
  app.use("/api/users/:username/reject", root);

  app.get("/api/users", async (c) => c.json({ users: await users.list() }));

  app.post("/api/users/:username/approve", async (c) => {
    try {
      await users.approve(c.req.param("username"));
    } catch (e) {
      if (e instanceof UnknownUserError) return c.json({ error: e.message }, 404);
      throw e;
    }
    return c.json({ ok: true });
  });

  app.post("/api/users/:username/reject", async (c) => {
    const target = c.req.param("username");
    const self = auth.verify(sessionToken(c));
    if (self && self.username.toLowerCase() === target.toLowerCase()) {
      return c.json({ error: "root cannot remove itself" }, 400);
    }
    try {
      await users.remove(target);
    } catch (e) {
      if (e instanceof UnknownUserError) return c.json({ error: e.message }, 404);
      throw e;
    }
    auth.revokeSessions(target);
    return c.json({ ok: true });
  });

  // Pipeline definitions: mutations only — reads stay open for the dashboard.
  app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/pipelines", admin);
  app.on(["POST", "PUT", "PATCH", "DELETE"], "/api/pipelines/:id", admin);
  app.use("/api/pipelines/:id/start", admin);
  // Instance gate controls run/steer pipelines. /signal is NOT admin-gated:
  // it is called by headless agent hooks and carries its own per-instance
  // token, verified by the engine.
  app.use("/api/instances/:id/approve", admin);
  app.use("/api/instances/:id/revise", admin);
  app.use("/api/instances/:id/abort", admin);

  app.get("/api/setup", async (c) =>
    c.json(await import("./setup/prereqs.js").then((m) => m.checkAll())),
  );
  app.post("/api/setup/apply", async (c) =>
    c.json(await import("./setup/prereqs.js").then((m) => m.applyAll())),
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
  app.get("/api/sessions/:project/:id/tail", async (c) => {
    const raw = Number(c.req.query("after") ?? "-1");
    const after = Number.isFinite(raw) ? raw : -1;
    const tail = await readSessionTail(c.req.param("project"), c.req.param("id"), after);
    return tail ? c.json(tail) : c.json({ error: "not found" }, 404);
  });
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
  app.get("/api/totals", async (c) => c.json(await readTotals()));

  app.post("/api/totals/reset", async (c) => {
    const totals = await resetTotals(() => new Date());
    broadcast({ type: "totals:changed" });
    return c.json(totals);
  });

  app.get("/api/inventory", async (c) => c.json(await readInventory()));
  app.get("/api/tasks", async (c) => c.json({ tasks: await readTasks() }));
  app.get("/api/search", async (c) =>
    c.json({ results: await searchTranscripts(c.req.query("q") ?? "") }),
  );
  app.get("/api/cron", async (c) => c.json(await readCron()));

  // Cross-source timeline: runs + agents + sessions as packed swimlanes.
  app.get("/api/chronicle", async (c) => {
    const hoursRaw = Number(c.req.query("hours"));
    const hours = Number.isFinite(hoursRaw) ? Math.min(336, Math.max(1, hoursRaw)) : 24;
    const [runs, agents, sessions] = await Promise.all([
      readRuns(),
      readAgents(),
      readSessions(150),
    ]);
    return c.json(buildChronicle({ runs, agents, sessions }, new Date(), hours * 3_600_000));
  });

  app.get("/api/schedules", async (c) =>
    c.json({ schedules: await readSchedulesWithNext(new Date()) }),
  );

  app.post("/api/schedules", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      const created = await createSchedule(validateInput(body.value), new Date(), randomUUID());
      return c.json(created, 201);
    } catch (e) {
      return fail(c, e, ScheduleValidationError);
    }
  });

  app.put("/api/schedules/:id", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      const updated = await updateSchedule(
        c.req.param("id"),
        validatePatch(body.value),
        new Date(),
      );
      if (!updated) return c.json({ error: "not found" }, 404);
      return c.json(updated);
    } catch (e) {
      return fail(c, e, ScheduleValidationError);
    }
  });

  app.delete("/api/schedules/:id", async (c) =>
    (await deleteSchedule(c.req.param("id")))
      ? c.json({ ok: true })
      : c.json({ error: "not found" }, 404),
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
    return c.json({
      runs: await readRuns({ scheduleId: c.req.query("scheduleId") || undefined, limit }),
    });
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

  // Dead-man's-switch health per schedule: catches the slot where nothing ran.
  app.get("/api/monitors", async (c) => {
    const [schedules, runs] = await Promise.all([readSchedules(), readRuns()]);
    return c.json(buildMonitors(schedules, runs, new Date()));
  });

  // Failed runs grouped by error fingerprint, Sentry-style.
  app.get("/api/issues", async (c) => {
    const [runs, triage] = await Promise.all([readRuns(), readTriage()]);
    const issues = buildIssues(runs, triage);
    const summary = { open: 0, resolved: 0, ignored: 0 };
    for (const i of issues) summary[i.state]++;
    return c.json({ issues, summary });
  });

  app.get("/api/issues/:fingerprint", async (c) => {
    const fp = c.req.param("fingerprint");
    const [runs, triage] = await Promise.all([readRuns(), readTriage()]);
    const issue = buildIssues(runs, triage).find((i) => i.fingerprint === fp);
    if (!issue) return c.json({ error: "not found" }, 404);
    return c.json({ issue, occurrences: issueOccurrences(runs, fp) });
  });

  const triageHandler = (state: "resolved" | "ignored") => async (c: Context) => {
    // Plain `Context` can't infer the :fingerprint param type; missing → "" → 404.
    const fp = c.req.param("fingerprint") ?? "";
    try {
      const [runs, triage] = await Promise.all([readRuns(), readTriage()]);
      const issue = buildIssues(runs, triage).find((i) => i.fingerprint === fp);
      if (!issue) return c.json({ error: "not found" }, 404);
      await setTriage(fp, state, issue.lastSeen, new Date());
    } catch (e) {
      return fail(c, e, IssueValidationError);
    }
    broadcast({ type: "issues:changed" });
    return c.json({ ok: true });
  };
  app.post("/api/issues/:fingerprint/resolve", triageHandler("resolved"));
  app.post("/api/issues/:fingerprint/ignore", triageHandler("ignored"));

  app.post("/api/issues/:fingerprint/reopen", async (c) => {
    try {
      if (!(await clearTriage(c.req.param("fingerprint")))) {
        return c.json({ error: "not found" }, 404);
      }
    } catch (e) {
      return fail(c, e, IssueValidationError);
    }
    broadcast({ type: "issues:changed" });
    return c.json({ ok: true });
  });

  app.get("/api/pipelines", async (c) => c.json({ pipelines: await readPipelines() }));

  app.post("/api/pipelines", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      const created = await createPipeline(
        validatePipelineInput(body.value),
        new Date(),
        randomUUID(),
      );
      return c.json(created, 201);
    } catch (e) {
      return fail(c, e, PipelineValidationError);
    }
  });

  // PUT replaces via the full-input validator; PATCH merges via the partial one.
  const pipelineUpdateHandler =
    (validate: (v: unknown) => Parameters<typeof updatePipeline>[1]) => async (c: Context) => {
      const body = await jsonBody(c);
      if (!body.ok) return body.res;
      try {
        // Plain `Context` can't infer the :id param type; missing id → "" → 404.
        const updated = await updatePipeline(
          c.req.param("id") ?? "",
          validate(body.value),
          new Date(),
        );
        if (!updated) return c.json({ error: "not found" }, 404);
        return c.json(updated);
      } catch (e) {
        return fail(c, e, PipelineValidationError);
      }
    };

  app.put("/api/pipelines/:id", pipelineUpdateHandler(validatePipelineInput));
  app.patch("/api/pipelines/:id", pipelineUpdateHandler(validatePipelinePatch));

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
    const [defs, insts, runs] = await Promise.all([readPipelines(), readInstances(), readRuns()]);
    return c.json({ overview: buildOverview(defs, insts, runs, deps.activity?.()) });
  });

  app.get("/api/instances/:id", async (c) => {
    const inst = await readInstance(c.req.param("id"));
    return inst ? c.json(inst) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/instances/:id/signal", async (c) => {
    const parsed = await jsonBody(c);
    if (!parsed.ok) return parsed.res;
    const body = parsed.value as Partial<PipelineSignal>;
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

  // Body is optional on approve/revise — a bare POST is a valid approval.
  const optionalField = <T>(body: Awaited<ReturnType<typeof jsonBody>>, key: string) =>
    body.ok && body.value && typeof body.value === "object"
      ? ((body.value as Record<string, unknown>)[key] as T | undefined)
      : undefined;

  app.post("/api/instances/:id/approve", async (c) => {
    const answers = optionalField<unknown>(await jsonBody(c), "answers");
    return engineReply(c, await engine.approve(c.req.param("id"), answers));
  });

  app.post("/api/instances/:id/revise", async (c) => {
    const note = optionalField<string>(await jsonBody(c), "note");
    return engineReply(c, await engine.revise(c.req.param("id"), note));
  });

  app.post("/api/instances/:id/abort", async (c) =>
    engineReply(c, await engine.abort(c.req.param("id"))),
  );

  if (deps.serveWeb !== false) mountWebApp(app);

  app.onError((err, c) => {
    console.error(`[argus] ${c.req.method} ${c.req.path} failed:`, err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
