import { test } from "node:test";
import assert from "node:assert/strict";
import { rolloutId, translateRollout, translateRolloutLine } from "./codexSessions.js";

test("the thread id comes out of the rollout filename", () => {
  assert.equal(
    rolloutId("rollout-2026-02-18T10-06-22-019c7149-aaaa-bbbb-cccc-ddddeeeeffff.jsonl"),
    "019c7149-aaaa-bbbb-cccc-ddddeeeeffff",
  );
});

test("non-rollout files are ignored", () => {
  assert.equal(rolloutId("history.jsonl"), null);
  assert.equal(rolloutId("config.toml"), null);
});

test("session_meta becomes the line that supplies the project label", () => {
  const line = translateRolloutLine({
    timestamp: "2026-07-31T09:00:00.000Z",
    type: "session_meta",
    payload: { id: "t1", cwd: "/home/u/project", cli_version: "0.130.0" },
  });
  assert.equal(line?.type, "codex-meta");
  assert.equal(line?.cwd, "/home/u/project");
  assert.equal(line?.timestamp, "2026-07-31T09:00:00.000Z");
});

test("session_meta nested one level deeper still resolves", () => {
  const line = translateRolloutLine({
    type: "session_meta",
    payload: { payload: { cwd: "/srv/app" } },
  });
  assert.equal(line?.cwd, "/srv/app");
});

test("turn_context carries the model", () => {
  const line = translateRolloutLine({
    type: "turn_context",
    payload: { model: "gpt-5.3-codex", cwd: "/srv/app" },
  });
  assert.equal(line?.message?.model, "gpt-5.3-codex");
});

test("a user message becomes a user line with plain text content", () => {
  const line = translateRolloutLine({
    timestamp: "2026-07-31T09:00:01.000Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix CI" }] },
  });
  assert.equal(line?.type, "user");
  assert.equal(line?.isMeta, undefined);
  assert.deepEqual(line?.message?.content, [{ type: "text", text: "fix CI" }]);
});

test("an assistant message becomes an assistant line", () => {
  const line = translateRolloutLine({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    },
  });
  assert.equal(line?.type, "assistant");
  assert.equal(line?.message?.role, "assistant");
});

test("developer/system instructions come through flagged isMeta, so titles skip them", () => {
  const line = translateRolloutLine({
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "<instructions>…</instructions>" }],
    },
  });
  assert.equal(line?.type, "user");
  assert.equal(line?.isMeta, true);
});

test("a function call becomes a tool_use block with parsed arguments", () => {
  const line = translateRolloutLine({
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: '{"command":["npm","test"]}' },
  });
  const block = line?.message?.content?.[0];
  assert.equal(block?.type, "tool_use");
  assert.equal(block?.name, "shell");
  assert.deepEqual(block?.input, { command: ["npm", "test"] });
});

test("unparseable call arguments are kept verbatim rather than dropped", () => {
  const line = translateRolloutLine({
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: "not json" },
  });
  assert.deepEqual(line?.message?.content?.[0]?.input, { arguments: "not json" });
});

test("a call output becomes a tool_result", () => {
  const line = translateRolloutLine({
    type: "response_item",
    payload: { type: "function_call_output", output: "3 tests passed" },
  });
  assert.equal(line?.type, "user");
  assert.equal(line?.message?.content?.[0]?.type, "tool_result");
  assert.equal(line?.message?.content?.[0]?.content, "3 tests passed");
});

test("reasoning becomes a thinking block", () => {
  const line = translateRolloutLine({
    type: "response_item",
    payload: { type: "reasoning", summary: [{ type: "summary_text", text: "weighing options" }] },
  });
  assert.equal(line?.message?.content?.[0]?.thinking, "weighing options");
});

test("event_msg lines are dropped, so nothing appears twice", () => {
  // The rollout carries every message both as a response_item and as a UI
  // event; translating both would double the transcript.
  assert.equal(
    translateRolloutLine({ type: "event_msg", payload: { type: "agent_message", message: "hi" } }),
    null,
  );
  assert.equal(
    translateRolloutLine({
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1 } } },
    }),
    null,
  );
});

test("junk lines are skipped rather than throwing", () => {
  assert.equal(translateRolloutLine(null), null);
  assert.equal(translateRolloutLine("a string"), null);
  assert.equal(translateRolloutLine({ type: "response_item" }), null);
  assert.equal(translateRolloutLine({ type: "response_item", payload: { type: "unknown" } }), null);
  assert.deepEqual(translateRollout([null, 1, { nope: true }]), []);
});

test("a whole rollout translates in order, keeping only what a transcript shows", () => {
  const out = translateRollout([
    { type: "session_meta", payload: { cwd: "/srv/app" } },
    { type: "event_msg", payload: { type: "task_started" } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    },
  ]);
  assert.deepEqual(
    out.map((l) => l.type),
    ["codex-meta", "user", "assistant"],
  );
});
