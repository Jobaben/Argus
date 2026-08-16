import { test } from "node:test";
import assert from "node:assert/strict";
import { translateQwenLine, translateQwenTranscript } from "./qwenSessions.js";

/**
 * Verbatim lines from a real `~/.qwen/projects/<dir>/chats/<id>.jsonl`, trimmed
 * of the fields no reader touches. The shapes matter more than the values: this
 * is Gemini CLI's dialect, and every assertion below is about turning it into
 * Claude Code's.
 */
const USER = {
  uuid: "a08",
  parentUuid: null,
  sessionId: "s1",
  timestamp: "2026-08-15T21:46:33.771Z",
  type: "user",
  provenance: "real_user",
  cwd: "/srv/app",
  version: "0.21.12",
  message: { role: "user", parts: [{ text: "List the tree." }] },
};
const TELEMETRY = {
  uuid: "137",
  sessionId: "s1",
  timestamp: "2026-08-15T21:46:33.901Z",
  type: "system",
  cwd: "/srv/app",
  subtype: "ui_telemetry",
  systemPayload: {
    uiEvent: { "event.name": "qwen-code.api_response", model: "qwen3-27b", status_code: 200 },
  },
};
const TOOL_CALL = {
  uuid: "fa6",
  sessionId: "s1",
  timestamp: "2026-08-15T21:46:34.000Z",
  type: "assistant",
  cwd: "/srv/app",
  message: {
    role: "model",
    parts: [{ functionCall: { id: "call_1", name: "run_shell_command", args: { command: "ls" } } }],
  },
};
const TOOL_RESULT = {
  uuid: "7b1",
  sessionId: "s1",
  timestamp: "2026-08-15T21:46:34.100Z",
  type: "tool_result",
  cwd: "/srv/app",
  message: {
    role: "user",
    parts: [
      {
        functionResponse: {
          id: "call_1",
          name: "run_shell_command",
          response: { output: "Command: ls\nOutput: src\nExit Code: 0" },
        },
      },
    ],
  },
};
const ANSWER = {
  uuid: "fdd",
  sessionId: "s1",
  timestamp: "2026-08-15T21:46:34.200Z",
  type: "assistant",
  cwd: "/srv/app",
  message: { role: "model", parts: [{ text: "One directory: src." }] },
};

test("a user turn becomes a Claude-shaped user message", () => {
  const line = translateQwenLine(USER);
  assert.equal(line?.type, "user");
  assert.equal(line?.timestamp, "2026-08-15T21:46:33.771Z");
  assert.equal(line?.cwd, "/srv/app");
  assert.deepEqual(line?.message?.content, [{ type: "text", text: "List the tree." }]);
});

test("`role: model` is the assistant, whatever the line calls itself", () => {
  const line = translateQwenLine(ANSWER);
  assert.equal(line?.type, "assistant");
  assert.equal(line?.message?.role, "assistant");
  assert.deepEqual(line?.message?.content, [{ type: "text", text: "One directory: src." }]);
});

test("a functionCall part becomes a tool_use block, arguments intact", () => {
  const line = translateQwenLine(TOOL_CALL);
  assert.equal(line?.type, "assistant");
  assert.deepEqual(line?.message?.content, [
    { type: "tool_use", name: "run_shell_command", input: { command: "ls" } },
  ]);
});

test("a tool_result line becomes a user-side tool_result, and never a session title", () => {
  const line = translateQwenLine(TOOL_RESULT);
  assert.equal(line?.type, "user");
  // Flagged meta for the same reason Codex's injected instructions are: a shell
  // transcript is not what the session should be called.
  assert.equal(line?.isMeta, true);
  assert.deepEqual(line?.message?.content, [
    { type: "tool_result", content: "Command: ls\nOutput: src\nExit Code: 0" },
  ]);
});

test("a failed tool response is flagged, so the transcript can mark it", () => {
  const failed = {
    ...TOOL_RESULT,
    message: {
      role: "user",
      parts: [{ functionResponse: { name: "read_file", response: { error: "ENOENT" } } }],
    },
  };
  assert.deepEqual(translateQwenLine(failed)?.message?.content, [
    { type: "tool_result", content: "ENOENT", is_error: true },
  ]);
});

test("an unrecognized tool response is shown verbatim rather than as a gap", () => {
  const odd = {
    ...TOOL_RESULT,
    message: {
      role: "user",
      parts: [{ functionResponse: { name: "x", response: { rows: [1, 2] } } }],
    },
  };
  assert.equal(translateQwenLine(odd)?.message?.content?.[0].content, '{"rows":[1,2]}');
});

test("a reasoning part comes through as thinking, which the reader already renders", () => {
  const thinking = {
    ...ANSWER,
    message: { role: "model", parts: [{ thought: "Check the tree first." }] },
  };
  assert.deepEqual(translateQwenLine(thinking)?.message?.content, [
    { type: "thinking", thinking: "Check the tree first." },
  ]);
});

test("telemetry carries the model and the directory, and is never a message", () => {
  const line = translateQwenLine(TELEMETRY);
  assert.equal(line?.type, "qwen-meta");
  assert.equal(line?.cwd, "/srv/app");
  assert.equal(line?.message?.model, "qwen3-27b");
  // Only `user` / `assistant` count as messages downstream, so a meta line
  // cannot inflate the message count.
  assert.equal(line?.message?.content, undefined);
});

test("a telemetry line with nothing to contribute is dropped", () => {
  assert.equal(
    translateQwenLine({ type: "system", subtype: "attribution_snapshot", systemPayload: {} }),
    null,
  );
});

test("junk, empty parts and non-objects yield nothing rather than throwing", () => {
  assert.equal(translateQwenLine(null), null);
  assert.equal(translateQwenLine("not a line"), null);
  assert.equal(translateQwenLine({ type: "user" }), null);
  assert.equal(translateQwenLine({ type: "user", message: { role: "user", parts: [] } }), null);
  assert.equal(
    translateQwenLine({ type: "user", message: { role: "user", parts: [{ text: "  " }] } }),
    null,
  );
});

test("a whole transcript translates to the sequence the Sessions view expects", () => {
  const lines = translateQwenTranscript([USER, TELEMETRY, TOOL_CALL, TOOL_RESULT, ANSWER]);
  assert.deepEqual(
    lines.map((l) => l.type),
    ["user", "qwen-meta", "assistant", "user", "assistant"],
  );
});
