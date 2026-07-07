import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveActivity } from "./runTailer.js";

const AT = "2026-07-07T10:00:00.000Z";

test("system init line becomes an init event", () => {
  const line = JSON.stringify({ type: "system", subtype: "init", session_id: "s" });
  assert.deepEqual(deriveActivity(line, AT), [
    { at: AT, kind: "init", label: "session started" },
  ]);
});

test("result line becomes a done event", () => {
  const line = JSON.stringify({ type: "result", subtype: "success", is_error: false });
  assert.deepEqual(deriveActivity(line, AT), [{ at: AT, kind: "done", label: "finished" }]);
});

test("assistant tool_use blocks become tool events with per-tool summaries", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "C:\\GIT\\argus\\server\\src\\app.ts" } },
        { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/home/u/proj/foo.ts" } },
        { type: "tool_use", id: "t4", name: "Task", input: { description: "review the diff" } },
        { type: "tool_use", id: "t5", name: "Grep", input: { pattern: "x" } },
      ],
    },
  });
  assert.deepEqual(
    deriveActivity(line, AT).map((e) => e.label),
    ["Bash: npm test", "Read: app.ts", "Edit: foo.ts", "Task: review the diff", "Grep"],
  );
  assert.ok(deriveActivity(line, AT).every((e) => e.kind === "tool"));
});

test("assistant text blocks become text events, clipped to 80 chars", () => {
  const long = "x".repeat(200);
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: long }] },
  });
  const [e] = deriveActivity(line, AT);
  assert.equal(e.kind, "text");
  assert.equal(e.label.length, 80);
  assert.ok(e.label.endsWith("…"));
});

test("whitespace-only text blocks, user lines, and unknown types yield nothing", () => {
  const blank = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "  \n " }] } });
  const user = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } });
  assert.deepEqual(deriveActivity(blank, AT), []);
  assert.deepEqual(deriveActivity(user, AT), []);
  assert.deepEqual(deriveActivity('{"type":"stream_event","event":{}}', AT), []);
});

test("malformed JSON yields nothing", () => {
  assert.deepEqual(deriveActivity("{not json", AT), []);
  assert.deepEqual(deriveActivity("", AT), []);
});

test("multi-line bash commands collapse to one line in the label", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "npm ci\nnpm test" } }] },
  });
  assert.equal(deriveActivity(line, AT)[0].label, "Bash: npm ci npm test");
});
