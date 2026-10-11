import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("summary, detail and tail retain valid transcript fields among malformed shapes", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-shapes-"));
  const previousHome = process.env.ARGUS_CLAUDE_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ARGUS_CLAUDE_HOME;
    else process.env.ARGUS_CLAUDE_HOME = previousHome;
    assert.equal(path.dirname(path.resolve(home)), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith("argus-shapes-"));
    rmSync(home, { recursive: true, force: true });
  });
  process.env.ARGUS_CLAUDE_HOME = home;
  const project = "shape-project";
  const id = path.basename(home);
  const dir = path.join(home, "projects", project);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const records = [
    null,
    7,
    "metadata",
    [],
    { type: "ai-title", aiTitle: 12 },
    {
      type: "user",
      timestamp: 42,
      message: {
        role: 4,
        model: {},
        content: [null, 4, { type: "text", text: 8 }, { type: "text", text: "Valid request" }],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          null,
          { type: "thinking", thinking: {} },
          { type: "tool_use", name: "Read", input: { file_path: "a.ts" } },
          { type: "tool_result", is_error: true, content: [null, 9, { text: "Valid result" }] },
        ],
      },
    },
    { type: "ai-title", aiTitle: "Authored title" },
    {
      type: "assistant",
      timestamp: "2026-10-11T01:00:00Z",
      message: { role: "assistant", model: "fixture-model", content: "Finished" },
    },
  ];
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const m = await import(`./sessions.js?${Math.random()}`);
  const summaries = await m.readSessions(101);
  const summary = summaries.find((s: { id: string }) => s.id === id);
  assert.ok(summary);
  assert.equal(summary.title, "Authored title");
  assert.equal(summary.messageCount, 3);
  assert.equal(summary.toolUseCount, 1);
  assert.equal(summary.model, "fixture-model");
  assert.equal(summary.firstActivity, "2026-10-11T01:00:00Z");
  const detail = await m.readSession(project, id);
  const tail = await m.readSessionTail(project, id, -1);
  assert.ok(detail);
  assert.ok(tail);
  assert.deepEqual(tail.messages, detail.messages);
  assert.deepEqual(
    detail.messages.map((msg: { index: number }) => msg.index),
    [0, 1, 2],
  );
  assert.equal(detail.messages[0].text, "Valid request");
  assert.equal(detail.messages[0].role, null);
  assert.equal(detail.messages[1].toolName, "Read");
  assert.equal(detail.messages[1].text, "Valid result");
  assert.equal(detail.messages[1].isError, true);
  assert.match(m.sessionToMarkdown(detail), /Valid result/);
  appendFileSync(
    file,
    JSON.stringify({
      type: "assistant",
      message: { content: [null, { type: "text", text: "Appended" }] },
    }) + "\n",
  );
  const appended = await m.readSessionTail(project, id, 2);
  assert.ok(appended);
  assert.equal(appended.lastIndex, 3);
  assert.equal(appended.messages[0].text, "Appended");
  assert.equal(appended.messages[0].index, 3);
});

test("wrong-shaped message containers do not suppress later valid messages", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-shapes-"));
  const previousHome = process.env.ARGUS_CLAUDE_HOME;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ARGUS_CLAUDE_HOME;
    else process.env.ARGUS_CLAUDE_HOME = previousHome;
    assert.equal(path.dirname(path.resolve(home)), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith("argus-shapes-"));
    rmSync(home, { recursive: true, force: true });
  });
  process.env.ARGUS_CLAUDE_HOME = home;
  const id = path.basename(home);
  const dir = path.join(home, "projects", "shapes");
  mkdirSync(dir, { recursive: true });
  const records = [
    { type: "user", message: null },
    { type: "assistant", message: "bad" },
    { type: "assistant", message: { content: 12, model: false } },
    { type: "user", message: { content: "Real title" } },
  ];
  writeFileSync(path.join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));
  const m = await import(`./sessions.js?${Math.random()}`);
  const detail = await m.readSession("shapes", id);
  const tail = await m.readSessionTail("shapes", id, -1);
  assert.ok(detail);
  assert.ok(tail);
  assert.equal(detail.title, "Real title");
  assert.equal(detail.model, null);
  assert.equal(detail.messages.length, 4);
  assert.deepEqual(tail.messages, detail.messages);
});
