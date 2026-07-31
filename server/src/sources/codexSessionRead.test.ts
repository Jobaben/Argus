import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The Sessions view, end to end, over a Codex rollout.
 *
 * The point of translating rollouts into the Claude line shape is that nothing
 * downstream needs a second code path — so these tests exercise the *shared*
 * readers (list, detail, live tail, raw lines, Markdown export) against a Codex
 * transcript and assert they behave as they do for a Claude one.
 */

let home: string;
let codexHome: string;
const THREAD = "019c7149-aaaa-bbbb-cccc-ddddeeeeffff";
const CWD = "/srv/app";

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-codexread-"));
  codexHome = path.join(home, "dot-codex");
  process.env.ARGUS_CLAUDE_HOME = home;
  process.env.ARGUS_CODEX_HOME = codexHome;
});

/** A fresh module graph per test: the caches are module-level and keyed by path. */
async function fresh() {
  return import(`./sessions.js?${Math.random()}`);
}

const ROLLOUT = [
  {
    timestamp: "2026-07-31T09:00:00.000Z",
    type: "session_meta",
    payload: { id: THREAD, cwd: CWD },
  },
  {
    timestamp: "2026-07-31T09:00:00.500Z",
    type: "turn_context",
    payload: { model: "gpt-5.3-codex" },
  },
  { timestamp: "2026-07-31T09:00:01.000Z", type: "event_msg", payload: { type: "task_started" } },
  {
    timestamp: "2026-07-31T09:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "<instructions>ignore me</instructions>" }],
    },
  },
  {
    timestamp: "2026-07-31T09:00:03.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "make the suite green" }],
    },
  },
  {
    timestamp: "2026-07-31T09:00:04.000Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: '{"command":["npm","test"]}' },
  },
  {
    timestamp: "2026-07-31T09:00:05.000Z",
    type: "response_item",
    payload: { type: "function_call_output", output: "12 passing" },
  },
  {
    timestamp: "2026-07-31T09:00:06.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "all green" }],
    },
  },
];

function writeRollout(lines: unknown[] = ROLLOUT, thread = THREAD): string {
  const dir = path.join(codexHome, "sessions", "2026", "07", "31");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-31T09-00-00-${thread}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("a rollout appears in the sessions list, filed under its working directory", async () => {
  writeRollout();
  const m = await fresh();
  const sessions = await m.readSessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, THREAD);
  // Filed by directory, exactly like a Claude session — not collapsed into one
  // "codex" bucket, which is what the cost and grouping views key off.
  assert.equal(s.project, "-srv-app");
  assert.equal(s.projectLabel, CWD);
  assert.equal(s.model, "gpt-5.3-codex");
  // The developer instructions are meta; the first real user turn is the title.
  assert.equal(s.title, "make the suite green");
  assert.equal(s.messageCount, 5);
  assert.equal(s.toolUseCount, 1);
  assert.equal(s.firstActivity, "2026-07-31T09:00:00.000Z");
  assert.equal(s.lastActivity, "2026-07-31T09:00:06.000Z");
});

test("the detail view resolves it by session id, whatever project segment is used", async () => {
  writeRollout();
  const m = await fresh();
  // Both the encoded working directory (what a run record carries) and the
  // reserved segment (what the list hands back when a rollout has no cwd).
  for (const project of ["-srv-app", "_codex_"]) {
    const detail = await m.readSession(project, THREAD);
    assert.ok(detail, `resolved via ${project}`);
    assert.equal(detail.projectLabel, CWD);
    assert.deepEqual(
      detail.messages.map((x: { role: string | null }) => x.role),
      ["developer", "user", "assistant", "user", "assistant"],
    );
    assert.equal(detail.messages[2].toolName, "shell");
    assert.equal(detail.messages[4].text, "all green");
  }
});

test("an unknown session is still not found, and traversal is still refused", async () => {
  writeRollout();
  const m = await fresh();
  assert.equal(await m.readSession("-srv-app", "no-such-thread"), null);
  assert.equal(await m.readSession("..", THREAD), null);
  assert.equal(await m.readSession("-srv-app", "../../etc/passwd"), null);
});

test("the live tail reports the same messages as a full read", async () => {
  writeRollout();
  const m = await fresh();
  const full = await m.readSession("-srv-app", THREAD);
  const tail = await m.readSessionTail("-srv-app", THREAD, -1);
  assert.ok(tail);
  assert.equal(tail.projectLabel, CWD);
  assert.deepEqual(
    tail.messages.map((x: { text: string | null }) => x.text),
    full.messages.map((x: { text: string | null }) => x.text),
  );
  assert.equal(tail.lastIndex, full.messages.length - 1);
});

test("the tail picks up appended turns without re-reading the file", async () => {
  writeRollout();
  const m = await fresh();
  const first = await m.readSessionTail("_codex_", THREAD, -1);
  assert.equal(first.messages.length, 5);

  writeRollout([
    ...ROLLOUT,
    {
      timestamp: "2026-07-31T09:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "and shipped" }],
      },
    },
  ]);
  const second = await m.readSessionTail("_codex_", THREAD, first.lastIndex);
  assert.equal(second.messages.length, 1);
  assert.equal(second.messages[0].text, "and shipped");
});

test("raw lines come back translated, for the derivations that read them", async () => {
  writeRollout();
  const m = await fresh();
  const lines = (await m.readSessionLines("-srv-app", THREAD)) as {
    type?: string;
    message?: { content?: { type: string; name?: string }[] };
  }[];
  // `event_msg` lines are dropped: a rollout carries every message twice, and
  // the Flight Recorder would otherwise show each one two times.
  assert.deepEqual(
    lines.map((l) => l.type),
    ["codex-meta", "codex-meta", "user", "user", "assistant", "user", "assistant"],
  );
  assert.equal(lines[4].message?.content?.[0]?.name, "shell");
});

test("Markdown export works on a Codex transcript too", async () => {
  writeRollout();
  const m = await fresh();
  const detail = await m.readSession("-srv-app", THREAD);
  const md = m.sessionToMarkdown(detail);
  assert.match(md, /# make the suite green/);
  assert.match(md, /\*\*Model:\*\* gpt-5\.3-codex/);
  assert.match(md, /all green/);
});

test("Claude and Codex sessions coexist in one list", async () => {
  writeRollout();
  const dir = path.join(home, "projects", "-srv-other");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "claude-sess.jsonl"),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-31T10:00:00.000Z",
      message: { role: "user", content: "hello from claude" },
    }) + "\n",
  );
  const m = await fresh();
  const sessions = await m.readSessions();
  assert.deepEqual(
    sessions.map((s: { id: string }) => s.id).sort(),
    ["claude-sess", THREAD].sort(),
  );
});

test("a rollout with no session_meta still lists, under the reserved segment", async () => {
  writeRollout(ROLLOUT.filter((l) => l.type !== "session_meta"));
  const m = await fresh();
  const [s] = await m.readSessions();
  assert.equal(s.project, "_codex_");
  assert.equal(s.projectLabel, "codex");
  assert.ok(await m.readSession("_codex_", THREAD));
});
