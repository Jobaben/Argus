import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./log.js";

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: { level: string; line: string }[] = [];
  const logger = createLogger({
    now: () => new Date("2026-07-07T18:04:12.000Z"),
    write: (level, line) => lines.push({ level, line }),
    ...opts,
  });
  return { logger, lines };
}

describe("createLogger — text format", () => {
  it("writes an aligned, skimmable line with key=value fields", () => {
    const { logger, lines } = capture({ level: "debug" });
    logger.warn("budget check failed", { runId: "r1", ms: 12 });
    assert.equal(lines[0].line, "18:04:12 WARN  budget check failed  runId=r1  ms=12");
  });

  it("quotes values containing spaces or quotes so fields stay parseable", () => {
    const { logger, lines } = capture();
    logger.info("setup incomplete", { pending: "hook file (missing)" });
    assert.equal(lines[0].line, '18:04:12 INFO  setup incomplete  pending="hook file (missing)"');
  });

  it("keeps an Error's message instead of rendering [object Object]", () => {
    const { logger, lines } = capture();
    logger.error("boom", { err: new Error("EACCES: permission denied") });
    assert.match(lines[0].line, /err="EACCES: permission denied"/);
  });
});

describe("createLogger — json format", () => {
  it("emits one parseable object per line", () => {
    const { logger, lines } = capture({ format: "json" });
    logger.info("argus listening", { url: "http://127.0.0.1:7777" });
    assert.deepEqual(JSON.parse(lines[0].line), {
      ts: "2026-07-07T18:04:12.000Z",
      level: "info",
      msg: "argus listening",
      url: "http://127.0.0.1:7777",
    });
  });

  it("serializes an Error into message/name/stack rather than {}", () => {
    const { logger, lines } = capture({ format: "json" });
    logger.error("failed", { err: new TypeError("bad") });
    const rec = JSON.parse(lines[0].line) as { err: { message: string; name: string } };
    assert.equal(rec.err.message, "bad");
    assert.equal(rec.err.name, "TypeError");
  });
});

describe("createLogger — levels", () => {
  it("drops anything below the configured level", () => {
    const { logger, lines } = capture({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    assert.deepEqual(
      lines.map((l) => l.level),
      ["warn", "error"],
    );
  });

  it("silences everything at level silent", () => {
    const { logger, lines } = capture({ level: "silent" });
    logger.error("still nothing");
    assert.equal(lines.length, 0);
  });

  it("routes each level to its own sink channel", () => {
    const { logger, lines } = capture({ level: "debug" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    assert.deepEqual(
      lines.map((l) => l.level),
      ["debug", "info", "warn", "error"],
    );
  });
});

describe("createLogger — child", () => {
  it("stamps the parent's fields onto every line and lets the call site win", () => {
    const { logger, lines } = capture({ format: "json" });
    const scoped = logger.child({ reqId: "abcd1234" });
    scoped.info("request", { status: 200 });
    scoped.info("request", { reqId: "override" });
    assert.equal((JSON.parse(lines[0].line) as { reqId: string }).reqId, "abcd1234");
    assert.equal((JSON.parse(lines[1].line) as { reqId: string }).reqId, "override");
  });

  it("inherits the parent's level", () => {
    const { logger, lines } = capture({ level: "error" });
    logger.child({ reqId: "x" }).info("dropped");
    assert.equal(lines.length, 0);
  });
});
