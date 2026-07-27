import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createLogger } from "./log.js";
import { requestLog } from "./requestLog.js";

interface Line {
  level: string;
  msg: string;
  reqId?: string;
  status?: number;
  ms?: number;
  path?: string;
}

function harness(level: "debug" | "info" = "debug") {
  const lines: Line[] = [];
  const logger = createLogger({
    level,
    format: "json",
    write: (_l, line) => lines.push(JSON.parse(line) as Line),
  });
  let t = 1000;
  const app = new Hono();
  app.use("*", requestLog({ logger, clock: () => (t += 25), newId: () => "fixedid1" }));
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/missing", (c) => c.json({ error: "not found" }, 404));
  app.get("/boom", (c) => c.json({ error: "kaboom" }, 500));
  app.get("/scoped", (c) => {
    c.get("log").info("handler ran", { detail: "x" });
    return c.json({ id: c.get("requestId") });
  });
  return { app, lines };
}

describe("requestLog", () => {
  it("echoes a generated request id back to the caller", async () => {
    const { app } = harness();
    const res = await app.request("/ok");
    assert.equal(res.headers.get("x-request-id"), "fixedid1");
  });

  it("honours an inbound x-request-id so a proxy's trace id wins", async () => {
    const { app, lines } = harness();
    const res = await app.request("/ok", { headers: { "x-request-id": "trace-from-proxy" } });
    assert.equal(res.headers.get("x-request-id"), "trace-from-proxy");
    assert.equal(lines.at(-1)?.reqId, "trace-from-proxy");
  });

  it("caps a hostile inbound id instead of logging unbounded input", async () => {
    const { app } = harness();
    const res = await app.request("/ok", { headers: { "x-request-id": "z".repeat(500) } });
    assert.equal((res.headers.get("x-request-id") ?? "").length, 64);
  });

  it("logs a successful read at debug, so a live dashboard stays quiet by default", async () => {
    const quiet = harness("info");
    await quiet.app.request("/ok");
    assert.deepEqual(quiet.lines, []);

    const verbose = harness("debug");
    await verbose.app.request("/ok");
    assert.equal(verbose.lines.at(-1)?.level, "debug");
    assert.equal(verbose.lines.at(-1)?.status, 200);
  });

  it("logs a 4xx at warn and a 5xx at error regardless of level", async () => {
    const { app, lines } = harness("info");
    await app.request("/missing");
    assert.equal(lines.at(-1)?.level, "warn");
    assert.equal(lines.at(-1)?.status, 404);
    await app.request("/boom");
    assert.equal(lines.at(-1)?.level, "error");
    assert.equal(lines.at(-1)?.status, 500);
  });

  it("records the elapsed time and the path", async () => {
    const { app, lines } = harness();
    await app.request("/ok");
    assert.equal(lines.at(-1)?.ms, 25);
    assert.equal(lines.at(-1)?.path, "/ok");
  });

  it("exposes a request-scoped logger and the id to handlers", async () => {
    const { app, lines } = harness();
    const res = await app.request("/scoped");
    assert.deepEqual(await res.json(), { id: "fixedid1" });
    const handlerLine = lines.find((l) => l.msg === "handler ran");
    assert.equal(handlerLine?.reqId, "fixedid1");
  });
});
