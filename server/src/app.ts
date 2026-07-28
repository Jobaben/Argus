import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { claudeHome } from "./claudeHome.js";
import { readAgents, readTimeline } from "./sources/jobs.js";
import { readDaemon } from "./sources/daemon.js";
import {
  readSessions,
  readSession,
  readSessionLines,
  readSessionTail,
  sessionToMarkdown,
} from "./sources/sessions.js";
import { buildRecording } from "./sources/recorder.js";
import {
  isAutopsyEligible,
  performAutopsy,
  readAutopsy,
  readFailureClasses,
  type AutopsyDeps,
} from "./sources/autopsy.js";
import { analysisEnabled, createAnalysisRunner, type AnalysisRunner } from "./sources/analysis.js";
import {
  buildVerdictTrends,
  failingVerdicts,
  performVerdict,
  readVerdict,
  readVerdicts,
} from "./sources/verdict.js";
import { rubricFor } from "./verdictWatcher.js";
import {
  acknowledge,
  addNote,
  attachDiagnosis,
  inQuietHours,
  readIncidents,
  readPolicy,
  resolveByHand,
  summarize,
  updatePolicy,
  validatePolicyPatch,
  withIncidentLock,
  writeIncidents,
  SentinelValidationError,
} from "./sources/sentinel.js";
import { performDiagnosis } from "./sources/diagnose.js";
import { readJournal } from "./sources/journal.js";
import { readActivity } from "./sources/history.js";
import { readProjects } from "./sources/projects.js";
import { readStats } from "./sources/stats.js";
import { readInventory } from "./sources/inventory.js";
import { readTasks } from "./sources/tasks.js";
import { SEARCH_LIMIT, searchTranscripts } from "./sources/search.js";
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
import {
  buildBriefing,
  clampSince,
  readBriefingAck,
  writeBriefingAck,
} from "./sources/briefing.js";
import { readTotals, resetTotals } from "./sources/totals.js";
import {
  BudgetValidationError,
  buildBudgetStatus,
  readBudgetConfig,
  readSpendLedger,
  recentDays,
  updateBudgetConfig,
  validateBudgetPatch,
} from "./sources/budget.js";
import {
  buildWatchtower,
  clearBaselineReset,
  readResets,
  resetBaseline,
  WatchtowerValidationError,
} from "./sources/watchtower.js";
import { buildLedger, whatIf, type WhatIfRequest } from "./sources/ledger.js";
import {
  runsAsRecords,
  runsBetween,
  vaultQuarters,
  vaultSearch,
  vaultStatus,
} from "./vault/query.js";
import { buildOtelExport } from "./vault/otel.js";
import { compileIntent, MAX_INTENT_CHARS, type OmnibarContext } from "./sources/omnibar.js";
import { rememberPlan, takePlan } from "./sources/planStore.js";
import { executePlan } from "./omnibarExecutor.js";
import { buildOverview } from "./sources/overview.js";
import { buildPalette } from "./sources/palette.js";
import { buildSituation } from "./sources/insight.js";
import { PreflightError, type Engine } from "./pipelineEngine.js";
import type { PipelineSignal } from "./sources/pipelineTypes.js";
import type { ActivityEvent } from "./runTailer.js";
import { defaultSpawn, fireOneOff, fireRun, isAlive } from "./scheduler.js";
import { LaunchValidationError, validateLaunchInput } from "./sources/launch.js";
import type { ArgusConfig } from "./config.js";
import { securityMiddleware } from "./security.js";
import { conditionalGet } from "./httpCache.js";
import { requestLog } from "./requestLog.js";
import { log } from "./log.js";
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

/** The window the pruned JSON run files can still answer on their own. */
const JSON_CHRONICLE_HOURS = 336;
/** Roughly five years — the Chronicle's ceiling once the Vault backs it. */
const MAX_CHRONICLE_HOURS = 24 * 365 * 5;
/** Spans per OTLP document. A collector prefers several bounded posts to one
 *  unbounded one, and an uncapped export is a memory spike waiting for a
 *  machine with a long history. */
const OTEL_SPAN_CAP = 5000;

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
  /** Bounded `claude -p` analysis runner (Autopsy). Defaults to the real one. */
  analysis?: AnalysisRunner;
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

  // One runner for every bounded `claude -p` analysis pass this app performs,
  // so they share a single concurrency and spend gate. Injectable for tests.
  const analysis = deps.analysis ?? createAnalysisRunner();
  const autopsyDeps: AutopsyDeps = {
    runner: analysis,
    now: () => new Date(),
    readLines: readSessionLines,
  };

  /**
   * The two model-derived inputs to issue grouping, read together.
   *
   * Every route that builds issues needs both — a diagnosis to cluster by and
   * the quality regressions that belong in the same triage surface as crashes —
   * so reading them in one place keeps the four call sites from drifting.
   */
  async function issueContext() {
    const [classes, verdicts] = await Promise.all([readFailureClasses(), readVerdicts()]);
    return { classes, verdicts: failingVerdicts(verdicts) };
  }

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

  // Order matters: the request id must exist before anything can log with it,
  // and the ETag layer wraps the handler's body, so it sits inside the security
  // gate (a rejected request never gets a tag) but outside every route.
  app.use("/api/*", requestLog());
  app.use("/api/*", securityMiddleware(config));
  app.use("/api/*", conditionalGet());

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
  // Producing a postmortem spawns an agent; relaunching spawns a real run.
  app.on(["POST"], "/api/runs/:id/autopsy", admin);
  app.on(["POST"], "/api/runs/:id/verdict", admin);
  // Incident actions mutate shared operator state; diagnosing spawns an agent.
  app.use("/api/sentinel/policy", admin);
  app.use("/api/incidents/:id/ack", admin);
  app.use("/api/incidents/:id/resolve", admin);
  app.use("/api/incidents/:id/note", admin);
  app.use("/api/incidents/:id/diagnose", admin);
  app.on(["POST"], "/api/runs/:id/relaunch", admin);
  app.use("/api/instances/:id/approve", admin);
  app.use("/api/instances/:id/revise", admin);
  app.use("/api/instances/:id/abort", admin);
  app.use("/api/omnibar/plan", admin);
  app.use("/api/omnibar/execute", admin);

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

  // Spend guardrails: limits + derived state + a chart-ready 30-day ledger.
  app.get("/api/budget", async (c) => {
    const now = new Date();
    const [budgetConfig, ledger] = await Promise.all([readBudgetConfig(), readSpendLedger()]);
    return c.json({
      config: budgetConfig,
      status: buildBudgetStatus(budgetConfig, ledger, now),
      days: recentDays(ledger, now, 30),
    });
  });

  app.put("/api/budget", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      const now = new Date();
      const updated = await updateBudgetConfig(validateBudgetPatch(body.value), now);
      const ledger = await readSpendLedger();
      broadcast({ type: "budget:changed" });
      return c.json({ config: updated, status: buildBudgetStatus(updated, ledger, now) });
    } catch (e) {
      return fail(c, e, BudgetValidationError);
    }
  });

  // ── Ledger ────────────────────────────────────────────────────────────────
  // Where the money went, where it is going, and what a change would do. All
  // reads; the what-if is a POST only because it carries a body.

  app.get("/api/ledger", async (c) => {
    const now = new Date();
    const [runs, budgetConfig, ledger] = await Promise.all([
      readRuns(),
      readBudgetConfig(),
      readSpendLedger(),
    ]);
    const status = buildBudgetStatus(budgetConfig, ledger, now);
    return c.json(buildLedger(runs, ledger, budgetConfig, status, now));
  });

  app.post("/api/ledger/what-if", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    const raw = (body.value ?? {}) as Partial<WhatIfRequest>;
    const dimension = raw.dimension;
    if (
      dimension !== "project" &&
      dimension !== "schedule" &&
      dimension !== "pipeline" &&
      dimension !== "model"
    ) {
      return c.json({ error: "dimension must be project|schedule|pipeline|model" }, 400);
    }
    if (typeof raw.key !== "string" || !raw.key.trim()) {
      return c.json({ error: "key is required" }, 400);
    }
    if (typeof raw.toModel !== "string" || !/^[A-Za-z0-9._ ()-]{1,80}$/.test(raw.toModel)) {
      return c.json({ error: "toModel is required" }, 400);
    }
    const [runs, verdicts] = await Promise.all([readRuns(), readVerdicts()]);
    const windowFloor = Date.now() - 30 * 86_400_000;
    const window = runs.filter((r) => {
      const at = Date.parse(r.endedAt ?? r.startedAt ?? r.queuedAt);
      return Number.isFinite(at) && at >= windowFloor;
    });
    return c.json(
      whatIf(window, verdicts, { dimension, key: raw.key.trim(), toModel: raw.toModel }, 30),
    );
  });

  app.get("/api/inventory", async (c) => c.json(await readInventory()));
  app.get("/api/tasks", async (c) => c.json({ tasks: await readTasks() }));
  // The scan stops at SEARCH_LIMIT, so the response says so rather than letting
  // a ceiling be read as a count.
  app.get("/api/search", async (c) => {
    const results = await searchTranscripts(c.req.query("q") ?? "");
    return c.json({ results, limit: SEARCH_LIMIT, truncated: results.length >= SEARCH_LIMIT });
  });
  app.get("/api/cron", async (c) => c.json(await readCron()));

  /**
   * Cross-source timeline: runs + agents + sessions as packed swimlanes.
   *
   * Past {@link JSON_CHRONICLE_HOURS} the JSON run files no longer hold the
   * answer — they are pruned to the newest 50 per schedule — so the window is
   * filled in from the Vault. Live records always win the merge: the Vault is
   * a cache, and where the two disagree the file is right by definition.
   */
  app.get("/api/chronicle", async (c) => {
    const hoursRaw = Number(c.req.query("hours"));
    const hours = Number.isFinite(hoursRaw)
      ? Math.min(MAX_CHRONICLE_HOURS, Math.max(1, hoursRaw))
      : 24;
    const now = new Date();
    const [liveRuns, agents, sessions] = await Promise.all([
      readRuns(),
      readAgents(),
      readSessions(150),
    ]);
    let runs = liveRuns;
    if (hours > JSON_CHRONICLE_HOURS) {
      const seen = new Set(liveRuns.map((r) => r.id));
      const archived = runsAsRecords(
        runsBetween(now.getTime() - hours * 3_600_000, now.getTime(), 2000),
      ).filter((r) => !seen.has(r.id));
      runs = [...liveRuns, ...archived];
    }
    return c.json(buildChronicle({ runs, agents, sessions }, now, hours * 3_600_000));
  });

  // The Vault: what it holds, the long views it enables, and the export.
  app.get("/api/vault", async (c) => {
    const runs = await readRuns();
    return c.json(vaultStatus(runs.map((r) => r.id)));
  });

  app.get("/api/vault/quarters", (c) => c.json(vaultQuarters()));

  app.get("/api/vault/search", (c) => c.json(vaultSearch((c.req.query("q") ?? "").slice(0, 200))));

  /**
   * OTLP/JSON spans for a window of runs.
   *
   * A plain GET returning a document rather than a push to a collector: Argus
   * does not know where your collector is, and a monitoring tool that phones
   * home by default is a worse citizen than one you have to point at something.
   * `curl … | vector` is the intended shape.
   */
  app.get("/api/vault/otel", (c) => {
    const daysRaw = Number(c.req.query("days"));
    const days = Number.isFinite(daysRaw) ? Math.min(400, Math.max(1, daysRaw)) : 7;
    const to = Date.now();
    const rows = runsBetween(to - days * 86_400_000, to, OTEL_SPAN_CAP);
    const doc = buildOtelExport(rows);
    return c.json({ ...doc, days, capped: rows.length >= OTEL_SPAN_CAP });
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

  // One-off launch: fire a single `claude -p` run right now, no schedule needed.
  app.post("/api/launch", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      const run = await fireOneOff(validateLaunchInput(body.value), {
        now: () => new Date(),
        spawn: defaultSpawn,
        tickMs: config.schedulerTickMs,
        newId: () => randomUUID(),
        onChange: () => broadcast({ type: "schedules:changed" }),
        onFailure: notifyRunFailed,
      });
      return c.json(run, 202);
    } catch (e) {
      return fail(c, e, LaunchValidationError);
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

  // The Flight Recorder: the run's transcript replayed as a scrubbable causal
  // timeline. Derived on every read — the transcript stays the source of truth.
  app.get("/api/runs/:id/recording", async (c) => {
    const got = await readRun(c.req.param("id"));
    if (!got) return c.json({ error: "not found" }, 404);
    const { run } = got;
    const lines =
      run.project && run.sessionId ? await readSessionLines(run.project, run.sessionId) : [];
    return c.json(buildRecording(run, lines, new Date()));
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
    const [runs, triage, ctx] = await Promise.all([readRuns(), readTriage(), issueContext()]);
    const issues = buildIssues(runs, triage, ctx);
    const summary = { open: 0, resolved: 0, ignored: 0 };
    for (const i of issues) summary[i.state]++;
    return c.json({ issues, summary });
  });

  app.get("/api/issues/:fingerprint", async (c) => {
    const fp = c.req.param("fingerprint");
    const [runs, triage, ctx] = await Promise.all([readRuns(), readTriage(), issueContext()]);
    const issue = buildIssues(runs, triage, ctx).find((i) => i.fingerprint === fp);
    if (!issue) return c.json({ error: "not found" }, 404);
    // The whole member set, so a clustered issue lists every occurrence rather
    // than only the ones sharing its representative fingerprint.
    return c.json({ issue, occurrences: issueOccurrences(runs, issue.members, ctx) });
  });

  const triageHandler = (state: "resolved" | "ignored") => async (c: Context) => {
    // Plain `Context` can't infer the :fingerprint param type; missing → "" → 404.
    const fp = c.req.param("fingerprint") ?? "";
    try {
      const [runs, triage, ctx] = await Promise.all([readRuns(), readTriage(), issueContext()]);
      const issue = buildIssues(runs, triage, ctx).find((i) => i.fingerprint === fp);
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

  // ── Sentinel ──────────────────────────────────────────────────────────────
  // Reading incidents is open. Acknowledging, noting and resolving are
  // operator actions on shared state, and dispatching a diagnostic spawns an
  // agent — all admin-gated.

  /** Read the incident, mutate it under the store lock, write it back. */
  async function mutateIncident(
    id: string,
    fn: (
      incident: Awaited<ReturnType<typeof readIncidents>>[number],
    ) => Promise<Awaited<ReturnType<typeof readIncidents>>[number]>,
  ) {
    return withIncidentLock(async () => {
      const list = await readIncidents();
      const idx = list.findIndex((i) => i.id === id);
      if (idx === -1) return null;
      list[idx] = await fn(list[idx]);
      await writeIncidents(list);
      return list[idx];
    });
  }

  app.get("/api/sentinel", async (c) => {
    const now = new Date();
    const [incidents, policy] = await Promise.all([readIncidents(), readPolicy()]);
    return c.json({
      generatedAt: now.toISOString(),
      policy,
      incidents,
      summary: summarize(incidents),
      inQuietHours: inQuietHours(policy.quietHours, now),
    });
  });

  app.put("/api/sentinel/policy", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    try {
      const policy = await updatePolicy(validatePolicyPatch(body.value));
      broadcast({ type: "sentinel:changed" });
      return c.json({ policy });
    } catch (e) {
      return fail(c, e, SentinelValidationError);
    }
  });

  app.post("/api/incidents/:id/ack", async (c) => {
    const who = auth.verify(sessionToken(c))?.username ?? "admin";
    const updated = await mutateIncident(c.req.param("id"), async (i) =>
      acknowledge(i, who, new Date()),
    );
    if (!updated) return c.json({ error: "not found" }, 404);
    broadcast({ type: "sentinel:changed" });
    return c.json({ incident: updated });
  });

  app.post("/api/incidents/:id/resolve", async (c) => {
    const who = auth.verify(sessionToken(c))?.username ?? "admin";
    const note = optionalField<string>(await jsonBody(c), "note") ?? "";
    const updated = await mutateIncident(c.req.param("id"), async (i) =>
      resolveByHand(i, who, note, new Date()),
    );
    if (!updated) return c.json({ error: "not found" }, 404);
    broadcast({ type: "sentinel:changed" });
    return c.json({ incident: updated });
  });

  app.post("/api/incidents/:id/note", async (c) => {
    const who = auth.verify(sessionToken(c))?.username ?? "admin";
    const note = (optionalField<string>(await jsonBody(c), "note") ?? "").trim();
    if (!note) return c.json({ error: "note is required" }, 400);
    const updated = await mutateIncident(c.req.param("id"), async (i) =>
      addNote(i, who, note.slice(0, 2000), new Date()),
    );
    if (!updated) return c.json({ error: "not found" }, 404);
    broadcast({ type: "sentinel:changed" });
    return c.json({ incident: updated });
  });

  /**
   * Dispatch the read-only diagnostic.
   *
   * The pass runs *outside* the store lock — it can take ninety seconds, and
   * holding the incident store for that long would block acknowledgements —
   * then re-reads under the lock before attaching, so a human who acknowledged
   * meanwhile does not lose their edit.
   */
  app.post("/api/incidents/:id/diagnose", async (c) => {
    const id = c.req.param("id");
    const incident = (await readIncidents()).find((i) => i.id === id);
    if (!incident) return c.json({ error: "not found" }, 404);

    const diagnosis = await performDiagnosis(incident, {
      runner: analysis,
      now: () => new Date(),
      context: async (i) =>
        i.scheduleId ? readRuns({ scheduleId: i.scheduleId, limit: 10 }) : readRuns({ limit: 10 }),
    });

    const updated = await mutateIncident(id, async (i) =>
      attachDiagnosis(i, diagnosis, new Date()),
    );
    if (!updated) return c.json({ error: "not found" }, 404);
    broadcast({ type: "sentinel:changed" });
    return c.json({ incident: updated });
  });

  // ── Verdict ───────────────────────────────────────────────────────────────
  // Reading a score is open; producing one spawns an agent, so it is gated.

  app.get("/api/verdicts", async (c) => {
    const [verdicts, schedules, pipelines] = await Promise.all([
      readVerdicts(),
      readSchedules(),
      readPipelines(),
    ]);
    // Thresholds live on the definitions, not on the stored verdicts: an author
    // who tightens the bar should see the new line on the old history.
    const minScores = new Map<string, number | null>();
    for (const s of schedules) {
      minScores.set(`schedule:${s.id}`, s.rubric?.minScore ?? null);
    }
    for (const p of pipelines) {
      for (const phase of p.phases) {
        minScores.set(`phase:pipeline:${p.id}:${phase.id}`, phase.rubric?.minScore ?? null);
      }
    }
    return c.json(buildVerdictTrends(verdicts, minScores, new Date()));
  });

  app.get("/api/runs/:id/verdict", async (c) => {
    const got = await readRun(c.req.param("id"));
    if (!got) return c.json({ error: "not found" }, 404);
    const [schedules, pipelines] = await Promise.all([readSchedules(), readPipelines()]);
    const rubric = rubricFor(got.run, schedules, pipelines);
    return c.json({
      verdict: await readVerdict(got.run.id),
      rubric,
      unavailable: rubric
        ? analysisEnabled()
          ? null
          : "scoring is disabled (ARGUS_ANALYSIS=off)"
        : "no rubric is declared for this unit of work",
    });
  });

  app.post("/api/runs/:id/verdict", async (c) => {
    const got = await readRun(c.req.param("id"));
    if (!got) return c.json({ error: "not found" }, 404);
    const [schedules, pipelines] = await Promise.all([readSchedules(), readPipelines()]);
    const rubric = rubricFor(got.run, schedules, pipelines);
    if (!rubric) {
      return c.json({ error: "no rubric is declared for this unit of work" }, 409);
    }
    const verdict = await performVerdict(got.run, rubric, {
      runner: analysis,
      now: () => new Date(),
    });
    broadcast({ type: "issues:changed" });
    return c.json({ verdict, rubric, unavailable: null });
  });

  // ── Autopsy ───────────────────────────────────────────────────────────────
  // The postmortem is a read; *producing* one spawns an agent and *relaunching*
  // spawns a real run, so both of those sit behind the admin gate alongside the
  // pipeline routes.

  app.get("/api/runs/:id/autopsy", async (c) => {
    const got = await readRun(c.req.param("id"));
    if (!got) return c.json({ error: "not found" }, 404);
    const eligible = isAutopsyEligible(got.run);
    const autopsy = await readAutopsy(got.run.id);
    return c.json({
      autopsy,
      eligible,
      unavailable: eligible
        ? autopsy
          ? null
          : analysisEnabled()
            ? null
            : "postmortems are disabled (ARGUS_ANALYSIS=off)"
        : "this run did not fail, so there is nothing to explain",
    });
  });

  app.post("/api/runs/:id/autopsy", async (c) => {
    const got = await readRun(c.req.param("id"));
    if (!got) return c.json({ error: "not found" }, 404);
    if (!isAutopsyEligible(got.run)) {
      return c.json({ error: "this run did not fail, so there is nothing to explain" }, 409);
    }
    const autopsy = await performAutopsy(got.run, autopsyDeps);
    broadcast({ type: "issues:changed" });
    return c.json({ autopsy, eligible: true, unavailable: null });
  });

  /**
   * Relaunch with the fix: a one-off run using the autopsy's proposed prompt.
   *
   * The delta is never applied silently to the schedule — a model's rewrite of
   * a prompt that spends money unattended is a suggestion, not a migration. It
   * fires once, as a one-off, so the operator can read the result and then
   * decide whether to edit the schedule themselves.
   */
  app.post("/api/runs/:id/relaunch", async (c) => {
    const got = await readRun(c.req.param("id"));
    if (!got) return c.json({ error: "not found" }, 404);
    const body = await jsonBody(c);
    const override = optionalField<string>(body, "prompt");
    const autopsy = await readAutopsy(got.run.id);
    const prompt = (override ?? autopsy?.promptDelta ?? "").trim();
    if (!prompt) {
      return c.json({ error: "no proposed prompt to relaunch with" }, 409);
    }
    try {
      const run = await fireOneOff(
        validateLaunchInput({
          name: `Relaunch: ${got.run.scheduleName}`,
          prompt,
          cwd: got.run.cwd,
          ...(got.run.model ? { model: got.run.model } : {}),
        }),
        {
          now: () => new Date(),
          spawn: defaultSpawn,
          tickMs: config.schedulerTickMs,
          newId: () => randomUUID(),
          onChange: () => broadcast({ type: "schedules:changed" }),
          onFailure: notifyRunFailed,
        },
      );
      return c.json(run, 202);
    } catch (e) {
      return fail(c, e, LaunchValidationError);
    }
  });

  // Learned envelopes per schedule/phase, plus the runs that left them.
  app.get("/api/watchtower", async (c) => {
    const [runs, resets] = await Promise.all([readRuns(), readResets()]);
    return c.json(buildWatchtower(runs, resets, new Date()));
  });

  // "Learn from here." Argus-owned, low-risk state — ungated like issue triage.
  app.post("/api/watchtower/:key/reset", async (c) => {
    try {
      const record = await resetBaseline(c.req.param("key") ?? "", new Date());
      broadcast({ type: "watchtower:changed" });
      return c.json({ ok: true, ...record });
    } catch (e) {
      return fail(c, e, WatchtowerValidationError);
    }
  });

  app.delete("/api/watchtower/:key/reset", async (c) => {
    try {
      if (!(await clearBaselineReset(c.req.param("key") ?? ""))) {
        return c.json({ error: "not found" }, 404);
      }
    } catch (e) {
      return fail(c, e, WatchtowerValidationError);
    }
    broadcast({ type: "watchtower:changed" });
    return c.json({ ok: true });
  });

  // "While you were away": attention items + digest since the last ack.
  app.get("/api/briefing", async (c) => {
    const now = new Date();
    const [runs, schedules, triage, instances, ackAt, resets, ctx] = await Promise.all([
      readRuns(),
      readSchedules(),
      readTriage(),
      readInstances(),
      readBriefingAck(),
      readResets(),
      issueContext(),
    ]);
    const { monitors } = buildMonitors(schedules, runs, now);
    const issues = buildIssues(runs, triage, ctx);
    const { anomalies } = buildWatchtower(runs, resets, now);
    return c.json(
      buildBriefing({ runs, monitors, issues, instances, anomalies }, clampSince(ackAt, now), now),
    );
  });

  // Mark caught up. Argus-owned, low-risk state — ungated like issue triage.
  app.post("/api/briefing/ack", async (c) => {
    const ackAt = await writeBriefingAck(new Date());
    broadcast({ type: "briefing:changed" });
    return c.json({ ok: true, ackAt });
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

  // The board's situation strip: counts, spend against the budget, what fires
  // next, and a 24h throughput sparkline. All derived from the shared caches.
  app.get("/api/insight", async (c) => {
    const now = new Date();
    const [runs, instances, pipelines, schedules, triage, agents, config, ledger, resets, ctx] =
      await Promise.all([
        readRuns(),
        readInstances(),
        readPipelines(),
        readSchedulesWithNext(now),
        readTriage(),
        readAgents(),
        readBudgetConfig(),
        readSpendLedger(),
        readResets(),
        issueContext(),
      ]);
    const { monitors } = buildMonitors(schedules, runs, now);
    return c.json(
      buildSituation(
        {
          runs,
          instances,
          pipelines,
          schedules,
          monitors,
          issues: buildIssues(runs, triage, ctx),
          agents,
          budget: buildBudgetStatus(config, ledger, now),
          anomalies: buildWatchtower(runs, resets, now).anomalies,
        },
        now,
      ),
    );
  });

  // The command palette's search index: one request instead of the seven view
  // payloads the client would otherwise join by hand. Every read below is
  // already served from the shared caches, so this costs little more than the
  // busiest single view.
  app.get("/api/palette", async (c) => {
    const now = new Date();
    const [defs, instances, schedules, runs, triage, agents, projects, sessions, ctx] =
      await Promise.all([
        readPipelines(),
        readInstances(),
        readSchedulesWithNext(now),
        readRuns(),
        readTriage(),
        readAgents(),
        readProjects(),
        readSessions(),
        issueContext(),
      ]);
    const { monitors } = buildMonitors(schedules, runs, now);
    const issues = buildIssues(runs, triage, ctx);
    // Newest instance per pipeline — the one whose badge and gate the palette
    // should reflect.
    const latestByPipeline = new Map<string, (typeof instances)[number]>();
    for (const inst of instances) {
      const seen = latestByPipeline.get(inst.pipelineId);
      if (!seen || inst.createdAt > seen.createdAt) latestByPipeline.set(inst.pipelineId, inst);
    }
    return c.json(
      buildPalette(
        {
          pipelines: defs,
          latestByPipeline,
          schedules,
          monitors,
          issues,
          agents,
          projects,
          sessions,
        },
        now,
      ),
    );
  });

  /**
   * The instance's journal: what happened, in order.
   *
   * The instance record is state and is rewritten in place, so it can say a
   * phase failed but never that it failed, retried, failed again and was
   * revised. This is the history.
   */
  app.get("/api/instances/:id/journal", async (c) =>
    c.json({ entries: await readJournal(c.req.param("id")) }),
  );

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

  // ── Omnibar ───────────────────────────────────────────────────────────────
  // Plan and execute are separate calls on purpose: a plan is a proposal a
  // human reads, and the only thing that turns it into a change is a second,
  // explicit request naming the plan's id. Both are admin-gated — planning
  // spawns an agent, executing mutates.

  /** Everything the planner may name, read fresh for each pass. */
  async function omnibarContext(now: Date): Promise<OmnibarContext> {
    const [schedules, runs, triage, ctx, instances, budget] = await Promise.all([
      readSchedules(),
      readRuns(),
      readTriage(),
      issueContext(),
      readInstances(),
      readBudgetConfig(),
    ]);
    return { schedules, issues: buildIssues(runs, triage, ctx), instances, budget, now };
  }

  app.post("/api/omnibar/plan", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    const raw = (body.value ?? {}) as { intent?: unknown };
    if (typeof raw.intent !== "string" || !raw.intent.trim()) {
      return c.json({ error: "intent is required" }, 400);
    }
    if (raw.intent.length > MAX_INTENT_CHARS) {
      return c.json({ error: `intent is capped at ${MAX_INTENT_CHARS} characters` }, 400);
    }
    const now = new Date();
    const ctx = await omnibarContext(now);
    const response = await compileIntent(raw.intent, ctx, {
      runner: analysis,
      cwd: claudeHome(),
    });
    if (response.plan) rememberPlan(response.plan, now);
    return c.json(response);
  });

  app.post("/api/omnibar/execute", async (c) => {
    const body = await jsonBody(c);
    if (!body.ok) return body.res;
    const raw = (body.value ?? {}) as { planId?: unknown };
    if (typeof raw.planId !== "string" || !raw.planId) {
      return c.json({ error: "planId is required" }, 400);
    }
    const now = new Date();
    const plan = takePlan(raw.planId, now);
    if (!plan) {
      return c.json({
        status: "expired",
        applied: [],
        reversed: [],
        error: null,
        summary: "That plan has expired or was already run. Ask again to get a fresh one.",
      });
    }
    const ctx = await omnibarContext(now);
    const result = await executePlan(plan, ctx, {
      setScheduleEnabled: async (id, enabled) => {
        if (!(await updateSchedule(id, { enabled }, new Date()))) {
          throw new Error(`schedule ${id} no longer exists`);
        }
      },
      setIssueState: async (fingerprint, state) => {
        if (state === "open") {
          await clearTriage(fingerprint);
          return;
        }
        const issue = ctx.issues.find((i) => i.fingerprint === fingerprint);
        if (!issue) throw new Error(`issue ${fingerprint} no longer exists`);
        await setTriage(fingerprint, state, issue.lastSeen, new Date());
      },
      abortInstance: async (id) => {
        const reply = await engine.abort(id);
        if (!reply.ok) throw new Error(reply.error ?? `could not abort ${id}`);
      },
      setBudget: async (patch) => {
        await updateBudgetConfig(validateBudgetPatch(patch), new Date());
      },
    });
    if (result.applied.length > 0 || result.reversed.length > 0) {
      broadcast({ type: "schedules:changed" });
      broadcast({ type: "issues:changed" });
      broadcast({ type: "budget:changed" });
      broadcast({ type: "pipelines:changed" });
    }
    return c.json(result);
  });

  if (deps.serveWeb !== false) mountWebApp(app);

  app.onError((err, c) => {
    // Prefer the request-scoped logger so the line carries the same reqId the
    // client saw in its response header.
    const logger = c.get("log") ?? log;
    logger.error("unhandled route error", { method: c.req.method, path: c.req.path, err });
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}
