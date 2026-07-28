import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { claudeHome } from "./claudeHome.js";
import { watchAgents, watchSchedules, watchExtensions, watchSessions } from "./watch.js";
import { readRuns, killRunProcess } from "./sources/runs.js";
import { createEngine, defaultPipelineSpawn } from "./pipelineEngine.js";
import { startScheduler, isAlive, backfillRunCosts } from "./scheduler.js";
import {
  applyAll as applyPrereqs,
  checkAll as checkPrereqs,
  preflight as preflightPrereqs,
} from "./setup/prereqs.js";
import { assertBindIsSafe, describeListenError, loadConfig } from "./config.js";
import { isUpgradeAllowed } from "./security.js";
import { VERSION } from "./version.js";
import {
  buildAnomalyPayload,
  buildIncidentPayload,
  buildBudgetAlertPayload,
  buildMonitorAlertPayload,
  buildPipelineFailurePayload,
  buildRunFailurePayload,
  postWebhook,
} from "./notify.js";
import { createBudgetWatcher } from "./budgetWatcher.js";
import { createMonitorWatcher } from "./monitorWatcher.js";
import { createWatchtowerWatcher } from "./watchtowerWatcher.js";
import { createAutopsyWatcher } from "./autopsyWatcher.js";
import { createVerdictWatcher } from "./verdictWatcher.js";
import { createSentinelWatcher } from "./sentinelWatcher.js";
import { createVaultWatcher } from "./vaultWatcher.js";
import { deriveConditions, readIncidents } from "./sources/sentinel.js";
import { readSpendLedger } from "./sources/budget.js";
import { buildMonitors } from "./sources/monitors.js";
import { buildIssues, readTriage } from "./sources/issues.js";
import { buildWatchtower, readResets } from "./sources/watchtower.js";
import { readFailureClasses } from "./sources/autopsy.js";
import { failingVerdicts, readVerdicts } from "./sources/verdict.js";
import { readPipelines } from "./sources/pipelines.js";
import { readInstances } from "./sources/instances.js";
import { createAnalysisRunner } from "./sources/analysis.js";
import { readSessionLines } from "./sources/sessions.js";
import { readSchedules } from "./sources/schedules.js";
import { createApp } from "./app.js";
import { createAuthService } from "./auth.js";
import { createUserStore } from "./userStore.js";
import { createRunTailer } from "./runTailer.js";
import { log } from "./log.js";

const config = loadConfig();

// Fail before opening a socket, not after: a process that has already bound an
// unauthenticated public port has already lost.
try {
  assertBindIsSafe(config);
} catch (e) {
  log.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const PORT = config.port;

// broadcast is wired to the WebSocket server created below; it's referenced by
// the engine and app before `wss` exists, so guard the null window.
let wss: WebSocketServer | null = null;
function broadcast(message: unknown) {
  if (!wss) return;
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

const tailer = createRunTailer({ broadcast, now: () => new Date() });

const engine = createEngine({
  now: () => new Date(),
  newId: () => randomUUID(),
  spawn: defaultPipelineSpawn,
  signalUrlBase: `http://127.0.0.1:${PORT}`,
  maxConcurrent: config.maxConcurrentRuns,
  tickMs: config.schedulerTickMs,
  tailer,
  onChange: () => broadcast({ type: "pipelines:changed" }),
  onFailure: (inst) =>
    void postWebhook(
      config.webhookUrl,
      buildPipelineFailurePayload(inst, new Date().toISOString()),
    ),
  preflight: () => preflightPrereqs(),
});

const users = createUserStore();
const auth = createAuthService({ store: users });
// One runner for every bounded `claude -p` analysis pass in the process — the
// on-demand routes and the background watcher share its concurrency and spend
// gate, so "one pass at a time" means one, not one per caller.
const analysis = createAnalysisRunner();
const app = createApp({
  config,
  engine,
  broadcast,
  auth,
  users,
  analysis,
  activity: () => tailer.latest(),
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: config.host }, (info) => {
  log.info("argus listening", {
    version: VERSION,
    url: `http://${config.host}:${info.port}`,
    claudeHome: claudeHome(),
  });
  void auth.isConfigured().then((configured) => {
    if (!configured) {
      log.info(
        "no admin account yet — pipeline editing/running is locked until you create one from the Pipelines tab",
      );
    }
  });
  // Self-setup on boot: auto-install every fixable prerequisite (hook file,
  // Stop/PreToolUse registration, data dirs) so pipelines work out of the box;
  // report anything that still needs a human (missing CLI, corrupt files).
  void checkPrereqs()
    .then(async (before) => {
      const broken = before.prereqs.filter((p) => p.status !== "ok");
      if (broken.length === 0) return before;
      const after = await applyPrereqs();
      const fixed = broken.filter((b) => after.prereqs.find((a) => a.id === b.id)?.status === "ok");
      if (fixed.length > 0) {
        log.info("auto-setup installed prerequisites", {
          installed: fixed.map((f) => f.label).join(", "),
        });
      }
      return after;
    })
    .then((s) => {
      if (!s.ok) {
        const bad = s.prereqs
          .filter((p) => p.status !== "ok")
          .map((p) => `${p.label} (${p.status})`)
          .join(", ");
        log.warn("setup incomplete — open the UI for details", { pending: bad });
      }
    })
    .catch((e: unknown) => log.error("auto-setup failed", { err: e }));
});

// Live updates: push a "changed" ping whenever watched state mutates. The
// upgrade is guarded by the same host/origin/token model as the REST surface
// (Hono middleware does not see raw WebSocket upgrades).
wss = new WebSocketServer({ noServer: true });
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
  wss!.handleUpgrade(req, socket, head, (ws) => wss!.emit("connection", ws, req));
});
wss.on("connection", (ws) => {
  // A client that resets the connection must not crash the server.
  ws.on("error", () => {});
  ws.send(JSON.stringify({ type: "hello" }));
});

const stopWatching = watchAgents(() => broadcast({ type: "agents:changed" }));
const stopWatchingSchedules = watchSchedules(() => broadcast({ type: "schedules:changed" }));
const stopWatchingExtensions = watchExtensions(() => broadcast({ type: "inventory:changed" }));
const stopWatchingSessions = watchSessions(() => broadcast({ type: "sessions:changed" }));
void engine.adopt().catch((e: unknown) => log.error("run adoption failed", { err: e }));
void backfillRunCosts()
  .then((n) => {
    if (n > 0) {
      log.info("backfilled cost/tokens for pre-existing runs", { runs: n });
      broadcast({ type: "pipelines:changed" });
    }
  })
  .catch((e: unknown) => log.error("run cost backfill failed", { err: e }));
// Monitor health is derived on read, so nothing observes it changing — the
// watcher re-derives it each tick and pushes down/failing/recovered
// transitions to the webhook and every connected dashboard.
const monitorWatcher = createMonitorWatcher({
  now: () => new Date(),
  readSchedules,
  readRuns,
  onAlert: (alert) => {
    void postWebhook(config.webhookUrl, buildMonitorAlertPayload(alert));
    broadcast({ type: "monitors:alert", alert });
  },
});
// Budget state is derived on read like monitor health; the watcher pushes
// warning/exceeded/cleared transitions to the same alert channels.
const budgetWatcher = createBudgetWatcher({
  now: () => new Date(),
  onAlert: (alert) => {
    void postWebhook(config.webhookUrl, buildBudgetAlertPayload(alert));
    broadcast({ type: "budget:alert", alert });
  },
});
// Watchtower learns each schedule's and phase's normal envelope from history
// and reports the runs that leave it. Like the two watchers above, the envelope
// is derived on read, so the transition only exists if something diffs it.
const watchtowerWatcher = createWatchtowerWatcher({
  now: () => new Date(),
  readRuns,
  onAnomaly: (anomaly) => {
    void postWebhook(config.webhookUrl, buildAnomalyPayload(anomaly));
    broadcast({ type: "watchtower:anomaly", anomaly });
  },
});
// Every failed run gets a postmortem, one per tick so a backlog drains rather
// than arriving as a spend spike.
const autopsyWatcher = createAutopsyWatcher({
  runner: analysis,
  now: () => new Date(),
  readLines: readSessionLines,
  readRuns,
  onAutopsy: () => broadcast({ type: "issues:changed" }),
});
// Rubric scoring, and the gates that open themselves on a good enough score.
// Out here rather than in the engine: a 90-second model call inside the signal
// path — which holds the instance lock while a child process blocks on the
// response — is how a gate becomes a deadlock.
const verdictWatcher = createVerdictWatcher({
  runner: analysis,
  now: () => new Date(),
  readRuns,
  readSchedules,
  readPipelines,
  readInstances,
  approve: (instanceId) => engine.approve(instanceId),
  onVerdict: () => broadcast({ type: "issues:changed" }),
  onAutoApprove: (instanceId, score) => {
    log.info("gate auto-approved on verdict", { instanceId, score });
    broadcast({ type: "pipelines:changed" });
  },
});
/**
 * Sentinel turns the signals the other features raise into incidents that can
 * be acknowledged, escalated and diagnosed. The conditions are assembled here,
 * from the same derivations the routes serve, so the incident list can never
 * disagree with the Monitors and Issues pages it came from.
 */
const sentinelWatcher = createSentinelWatcher({
  now: () => new Date(),
  conditions: async () => {
    const now = new Date();
    const [runs, schedules, triage, resets, classes, verdicts] = await Promise.all([
      readRuns(),
      readSchedules(),
      readTriage(),
      readResets(),
      readFailureClasses(),
      readVerdicts(),
    ]);
    const { monitors } = buildMonitors(schedules, runs, now);
    const issues = buildIssues(runs, triage, { classes, verdicts: failingVerdicts(verdicts) });
    const { anomalies } = buildWatchtower(runs, resets, now);
    return deriveConditions({
      monitors,
      issues,
      anomalies,
      // "Resolved, then failed again" is the regression rule Issues already
      // uses; reading the triage records directly keeps the two in step.
      resolvedFingerprints: new Set(
        triage.filter((t) => t.state === "resolved").map((t) => t.fingerprint),
      ),
    });
  },
  onAlert: (alert) => {
    if (!alert.suppressed) {
      void postWebhook(config.webhookUrl, buildIncidentPayload(alert));
      broadcast({ type: "sentinel:alert", alert });
    } else {
      // Quiet hours: the record still lands, the bell stays silent.
      broadcast({ type: "sentinel:changed" });
    }
  },
  diagnose: {
    runner: analysis,
    now: () => new Date(),
    context: async (incident) =>
      incident.scheduleId
        ? readRuns({ scheduleId: incident.scheduleId, limit: 10 })
        : readRuns({ limit: 10 }),
  },
});
/**
 * The Vault ingests on the same tick as everything else. It is deliberately
 * last in the chain: it reads what the passes above have just written, and a
 * cache that lags the truth by one tick is fine in a way that a truth lagging
 * its cache would not be.
 */
const vaultWatcher = createVaultWatcher({
  now: () => new Date(),
  readRuns,
  readIncidents,
  readVerdicts,
  readSpend: readSpendLedger,
  readAnomalies: async () => {
    const now = new Date();
    const [runs, resets] = await Promise.all([readRuns(), readResets()]);
    return buildWatchtower(runs, resets, now).anomalies;
  },
});
const scheduler = startScheduler({
  onChange: () => broadcast({ type: "schedules:changed" }),
  onTick: async () => {
    await engine.reconcile();
    await monitorWatcher.check();
    await budgetWatcher.check();
    await watchtowerWatcher.check();
    await autopsyWatcher.check();
    await verdictWatcher.check();
    await sentinelWatcher.check();
    await vaultWatcher.check();
  },
  onFailure: (run) =>
    void postWebhook(config.webhookUrl, buildRunFailurePayload(run, new Date().toISOString())),
});

/** Pipeline step runs are detached by design: they survive a restart and get
 *  re-adopted on the next boot, so shutdown must NOT kill them. Scheduler runs
 *  keep the kill-on-shutdown behavior. */
async function killLiveRuns(): Promise<void> {
  const running = (await readRuns()).filter(
    (r) => r.status === "running" && isAlive(r.pid) && !r.scheduleId.startsWith("pipeline:"),
  );
  await Promise.all(running.map((r) => killRunProcess(r.pid)));
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopWatching();
  await stopWatchingSchedules();
  await stopWatchingExtensions();
  await stopWatchingSessions();
  await scheduler.stop();
  await tailer.stop();
  await killLiveRuns();
  if (wss) {
    for (const client of wss.clients) client.terminate();
    wss.close();
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A failure to bind is fatal and must say so with an exit code: the catch-all
// handler below exists to keep the daemon alive through a stray rejection, which
// is exactly the wrong response to "the port is taken".
server.on("error", (err: NodeJS.ErrnoException) => {
  const fatal = describeListenError(err, config.host, PORT);
  if (fatal === null) {
    log.error("server error", { err });
    return;
  }
  log.error(fatal);
  process.exit(1);
});

// A background rejection or thrown timer must not silently take down the
// daemon or leave it wedged: log and keep serving.
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection", { err: reason });
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException", { err });
});
