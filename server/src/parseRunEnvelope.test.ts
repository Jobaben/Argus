import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRunEnvelope } from "./scheduler.js";

test("parses a clean JSON envelope with cost and usage", () => {
  const env = JSON.stringify({
    result: "done",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 50 },
  });
  const out = parseRunEnvelope(env);
  assert.equal(out.result, "done");
  assert.equal(out.costUsd, 0.0123);
  assert.equal(out.tokens, 150);
});

test("recovers the envelope when preceded by log noise", () => {
  const noise = "some stderr\nprogress line\n";
  const env = JSON.stringify({ result: "ok", total_cost_usd: 1, usage: { input_tokens: 1, output_tokens: 1 } });
  const out = parseRunEnvelope(noise + env);
  assert.equal(out.result, "ok");
  assert.equal(out.tokens, 2);
});

test("parses a large result that would have overflowed the old 8KB tail", () => {
  const big = "x".repeat(20000);
  const out = parseRunEnvelope(JSON.stringify({ result: big }));
  assert.equal(out.result, big);
  assert.equal(out.costUsd, null);
});

test("returns nulls, not a throw, on unparseable output", () => {
  const out = parseRunEnvelope("not json at all { partial");
  assert.deepEqual(out, { result: null, costUsd: null, tokens: null });
});

test("returns nulls on empty output", () => {
  assert.deepEqual(parseRunEnvelope("   "), { result: null, costUsd: null, tokens: null });
});

test("recovers the envelope despite a stray brace emitted AFTER it", () => {
  const env = JSON.stringify({ result: "ok", total_cost_usd: 0.5, usage: { input_tokens: 3, output_tokens: 4 } });
  const out = parseRunEnvelope(`noise\n${env}\ntrailing } garbage`);
  assert.equal(out.result, "ok");
  assert.equal(out.costUsd, 0.5);
  assert.equal(out.tokens, 7);
});

test("ignores a non-envelope object and picks the real envelope", () => {
  const noise = JSON.stringify({ type: "progress", step: 1 });
  const env = JSON.stringify({ result: "done", usage: { input_tokens: 1, output_tokens: 1 } });
  const out = parseRunEnvelope(`${noise}\n${env}`);
  assert.equal(out.result, "done");
  assert.equal(out.tokens, 2);
});

test("brace inside a string value does not break extraction", () => {
  const env = JSON.stringify({ result: "here is a brace } inside text", usage: { input_tokens: 2, output_tokens: 0 } });
  const out = parseRunEnvelope(`log line\n${env}`);
  assert.equal(out.result, "here is a brace } inside text");
});
