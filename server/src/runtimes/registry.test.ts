import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultRuntimeId,
  isRuntimeId,
  parseEnvelopeFor,
  resolveRuntimeId,
  runtimeFor,
} from "./index.js";

const RESET = process.env.ARGUS_AGENT;
function withAgent(value: string | undefined, fn: () => void): void {
  if (value === undefined) delete process.env.ARGUS_AGENT;
  else process.env.ARGUS_AGENT = value;
  try {
    fn();
  } finally {
    if (RESET === undefined) delete process.env.ARGUS_AGENT;
    else process.env.ARGUS_AGENT = RESET;
  }
}

test("Claude Code is the default, so an upgrade never re-points existing work", () => {
  withAgent(undefined, () => assert.equal(defaultRuntimeId(), "claude"));
});

test("ARGUS_AGENT selects the default, case-insensitively", () => {
  withAgent("Codex", () => assert.equal(defaultRuntimeId(), "codex"));
});

test("an unknown ARGUS_AGENT falls back rather than failing every spawn", () => {
  withAgent("gemini", () => assert.equal(defaultRuntimeId(), "claude"));
});

test("resolution is narrowest-wins, skipping absent overrides", () => {
  withAgent("claude", () => {
    // step, phase, pipeline
    assert.equal(resolveRuntimeId("codex", "claude", "claude"), "codex");
    assert.equal(resolveRuntimeId(undefined, "codex", "claude"), "codex");
    assert.equal(resolveRuntimeId(undefined, undefined, "codex"), "codex");
    assert.equal(resolveRuntimeId(undefined, undefined, undefined), "claude");
    assert.equal(resolveRuntimeId(null, null), "claude");
  });
});

test("isRuntimeId rejects anything that isn't a known id", () => {
  assert.equal(isRuntimeId("claude"), true);
  assert.equal(isRuntimeId("codex"), true);
  assert.equal(isRuntimeId("CODEX"), false);
  assert.equal(isRuntimeId(undefined), false);
  assert.equal(isRuntimeId(7), false);
});

test("runtimeFor falls back to the default for an unrecognized id", () => {
  withAgent("claude", () => {
    assert.equal(runtimeFor("codex").id, "codex");
    assert.equal(runtimeFor(undefined).id, "claude");
    assert.equal(runtimeFor("gemini" as never).id, "claude");
  });
});

const CLAUDE_LOG = JSON.stringify({
  result: "done",
  total_cost_usd: 0.5,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const CODEX_LOG = [
  '{"type":"thread.started","thread_id":"t9"}',
  '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
].join("\n");

test("parseEnvelopeFor reads a log the record's runtime names", () => {
  assert.equal(parseEnvelopeFor("claude", CLAUDE_LOG).costUsd, 0.5);
  assert.equal(parseEnvelopeFor("codex", CODEX_LOG).sessionId, "t9");
});

test("parseEnvelopeFor recovers a mislabelled or unlabelled log", () => {
  // A record written before runtimes existed carries no id — and a Codex log
  // still has to parse, or its cost backfill would silently record nothing.
  assert.equal(parseEnvelopeFor(undefined, CODEX_LOG).tokens, 15);
  assert.equal(parseEnvelopeFor("codex", CLAUDE_LOG).result, "done");
});

test("parseEnvelopeFor returns the named runtime's empty answer for junk", () => {
  const out = parseEnvelopeFor("codex", "totally not a log");
  assert.equal(out.result, null);
  assert.equal(out.tokens, null);
  assert.equal(out.isError, null);
});
