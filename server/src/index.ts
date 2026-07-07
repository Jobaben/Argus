import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { claudeHome } from "./claudeHome.js";
import { watchAgents, watchSchedules, watchExtensions } from "./watch.js";
import { readRuns, killRunProcess } from "./sources/runs.js";
import { createEngine, defaultPipelineSpawn } from "./pipelineEngine.js";
import { startScheduler, isAlive } from "./scheduler.js";
import {
  checkAll as checkPrereqs, preflight as preflightPrereqs, repairSafeFixables,
} from "./setup/prereqs.js";
import { loadConfig } from "./config.js";
import { isUpgradeAllowed } from "./security.js";
import { VERSION } from "./version.js";
import { buildPipelineFailurePayload, buildRunFailurePayload, postWebhook } from "./notify.js";
import { createApp } from "./app.js";

const config = loadConfig();
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

const engine = createEngine({
  now: () => new Date(),
  newId: () => randomUUID(),
  spawn: defaultPipelineSpawn,
  signalUrlBase: `http://127.0.0.1:${PORT}`,
  maxConcurrent: config.maxConcurrentRuns,
  tickMs: config.schedulerTickMs,
  onChange: () => broadcast({ type: "pipelines:changed" }),
  onFailure: (inst) =>
    void postWebhook(config.webhookUrl, buildPipelineFailurePayload(inst, new Date().toISOString())),
  preflight: () => preflightPrereqs(),
});

const app = createApp({ config, engine, broadcast });

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
const scheduler = startScheduler({
  onChange: () => broadcast({ type: "schedules:changed" }),
  onTick: () => engine.reconcile(),
  onFailure: (run) => void postWebhook(config.webhookUrl, buildRunFailurePayload(run, new Date().toISOString())),
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
  await stopWatchingExtensions();
  await scheduler.stop();
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

// A background rejection or thrown timer must not silently take down the
// daemon or leave it wedged: log and keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("[argus] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[argus] uncaughtException:", err);
});
