import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunFailurePayload, buildPipelineFailurePayload, postWebhook } from "./notify.js";
import type { Run } from "./sources/scheduleTypes.js";
import type { PipelineInstance } from "./sources/pipelineTypes.js";

const run = {
  id: "r1",
  scheduleName: "Nightly audit",
  error: "exit code 2",
  exitCode: 2,
} as unknown as Run;

test("run failure payload carries title, detail, id", () => {
  const p = buildRunFailurePayload(run, "2026-07-06T00:00:00Z");
  assert.equal(p.event, "run.failed");
  assert.equal(p.id, "r1");
  assert.match(p.title, /Nightly audit/);
  assert.equal(p.detail, "exit code 2");
});

test("pipeline failure payload names the current phase", () => {
  const inst = {
    id: "i1",
    pipelineName: "Release",
    currentPhaseIndex: 1,
    phases: [{ name: "build" }, { name: "deploy" }],
  } as unknown as PipelineInstance;
  const p = buildPipelineFailurePayload(inst, "2026-07-06T00:00:00Z");
  assert.equal(p.event, "pipeline.failed");
  assert.match(p.detail, /deploy/);
});

test("postWebhook is a no-op with no url and never throws", async () => {
  await postWebhook(null, buildRunFailurePayload(run, "t"));
});

test("postWebhook POSTs the payload as JSON", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  try {
    await postWebhook("http://hook.local/x", buildRunFailurePayload(run, "t"));
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://hook.local/x");
  assert.equal((calls[0].body as { id: string }).id, "r1");
});

test("postWebhook swallows fetch errors", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  try {
    await postWebhook("http://hook.local/x", buildRunFailurePayload(run, "t"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("monitor alert payload maps event, title, detail, id", async () => {
  const { buildMonitorAlertPayload } = await import("./notify.js");
  const p = buildMonitorAlertPayload({
    event: "monitor.down",
    scheduleId: "s1",
    name: "Nightly audit",
    status: "down",
    at: "2026-07-12T08:00:00Z",
    detail: "no run covered the slot expected at 2026-07-12T02:00:00Z",
  });
  assert.equal(p.event, "monitor.down");
  assert.equal(p.id, "s1");
  assert.equal(p.at, "2026-07-12T08:00:00Z");
  assert.match(p.title, /Monitor down: Nightly audit/);
  assert.match(p.detail, /expected at/);
});
