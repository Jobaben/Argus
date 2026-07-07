import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionToMarkdown } from "./sessions.js";
import type { SessionDetail } from "./sessions.js";

const session: SessionDetail = {
  id: "abc123",
  project: "-home-user-proj",
  projectLabel: "proj",
  title: "Fix the widget",
  model: "claude-fable-5",
  firstActivity: "2026-07-06T00:00:00Z",
  lastActivity: "2026-07-06T00:05:00Z",
  messages: [
    {
      index: 0,
      type: "message",
      role: "user",
      timestamp: "2026-07-06T00:00:00Z",
      model: null,
      text: "hi",
      toolName: null,
      isError: false,
    },
    {
      index: 1,
      type: "message",
      role: "assistant",
      timestamp: null,
      model: "claude-fable-5",
      text: "hello",
      toolName: null,
      isError: false,
    },
    {
      index: 2,
      type: "tool_result",
      role: null,
      timestamp: null,
      model: null,
      text: "boom",
      toolName: "Bash",
      isError: true,
    },
  ],
};

test("markdown export includes header, metadata, and each message", () => {
  const md = sessionToMarkdown(session);
  assert.match(md, /^# Fix the widget/);
  assert.match(md, /\*\*Session:\*\* `abc123`/);
  assert.match(md, /\*\*Model:\*\* claude-fable-5/);
  assert.match(md, /## user/);
  assert.match(md, /## assistant/);
  assert.match(md, /tool: `Bash`/);
  assert.match(md, /⚠️ error/);
  assert.match(md, /hello/);
});

test("markdown export omits absent optional metadata", () => {
  const bare: SessionDetail = { ...session, model: null, firstActivity: null, lastActivity: null };
  const md = sessionToMarkdown(bare);
  assert.doesNotMatch(md, /\*\*Model:\*\*/);
  assert.doesNotMatch(md, /\*\*Started:\*\*/);
});
