import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The Sessions view, end to end, over a Qwen Code transcript.
 *
 * The point of translating Qwen's Gemini-dialect lines into the Claude line
 * shape is that nothing downstream needs a second code path — so these tests
 * exercise the *shared* readers (list, detail, live tail, raw lines, Markdown
 * export, transcript search) against a Qwen transcript and assert they behave
 * as they do for a Claude one.
 *
 * The trickier property is co-existence: Qwen Code encodes the working
 * directory into a project segment exactly as Claude Code does, so a Claude and
 * a Qwen session from the same directory share a project and must both still
 * resolve.
 */

let home: string;
let qwenHome: string;
const SESSION = "0b9b44d9-ee7d-4197-b4c1-c650b17021c0";
const CWD = "/srv/app";
const PROJECT = "-srv-app";

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-qwenread-"));
  qwenHome = path.join(home, "dot-qwen");
  process.env.ARGUS_CLAUDE_HOME = home;
  process.env.ARGUS_QWEN_HOME = qwenHome;
});

/** A fresh module graph per test: the caches are module-level and keyed by path. */
async function fresh() {
  return import(`./sessions.js?${Math.random()}`);
}

const base = { sessionId: SESSION, cwd: CWD, version: "0.21.12" };
const TRANSCRIPT: unknown[] = [
  {
    ...base,
    timestamp: "2026-08-15T21:46:33.771Z",
    type: "user",
    provenance: "real_user",
    message: { role: "user", parts: [{ text: "make the suite green" }] },
  },
  {
    ...base,
    timestamp: "2026-08-15T21:46:33.800Z",
    type: "system",
    subtype: "attribution_snapshot",
    systemPayload: { snapshot: { promptCount: 1 } },
  },
  {
    ...base,
    timestamp: "2026-08-15T21:46:33.901Z",
    type: "system",
    subtype: "ui_telemetry",
    systemPayload: { uiEvent: { "event.name": "qwen-code.api_response", model: "qwen3-27b" } },
  },
  {
    ...base,
    timestamp: "2026-08-15T21:46:34.000Z",
    type: "assistant",
    message: {
      role: "model",
      parts: [
        { functionCall: { id: "c1", name: "run_shell_command", args: { command: "npm test" } } },
      ],
    },
  },
  {
    ...base,
    timestamp: "2026-08-15T21:46:34.100Z",
    type: "tool_result",
    message: {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: "c1",
            name: "run_shell_command",
            response: { output: "12 passing" },
          },
        },
      ],
    },
  },
  {
    ...base,
    timestamp: "2026-08-15T21:46:34.200Z",
    type: "assistant",
    message: { role: "model", parts: [{ text: "all green" }] },
  },
];

function chatsDir(project = PROJECT): string {
  const dir = path.join(qwenHome, "projects", project, "chats");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTranscript(lines: unknown[] = TRANSCRIPT, id = SESSION, project = PROJECT): string {
  const file = path.join(chatsDir(project), `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

/** A Claude transcript in the same project, for the co-existence cases. */
function writeClaudeTranscript(id: string, project = PROJECT): void {
  const dir = path.join(home, "projects", project);
  mkdirSync(dir, { recursive: true });
  const lines = [
    {
      type: "user",
      timestamp: "2026-08-15T20:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "claude side" }] },
    },
  ];
  writeFileSync(
    path.join(dir, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

test("a Qwen transcript appears in the sessions list, filed under its working directory", async () => {
  writeTranscript();
  const m = await fresh();
  const sessions = await m.readSessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, SESSION);
  assert.equal(s.project, PROJECT);
  assert.equal(s.projectLabel, CWD);
  // The model is only ever recorded on a telemetry line, which is exactly why
  // those are translated rather than dropped.
  assert.equal(s.model, "qwen3-27b");
  assert.equal(s.title, "make the suite green");
  // user + tool_use + tool_result + answer. Telemetry lines are not messages.
  assert.equal(s.messageCount, 4);
  assert.equal(s.toolUseCount, 1);
  assert.equal(s.firstActivity, "2026-08-15T21:46:33.771Z");
  assert.equal(s.lastActivity, "2026-08-15T21:46:34.200Z");
});

test("the detail view resolves it by (project, session id), like a Claude transcript", async () => {
  writeTranscript();
  const m = await fresh();
  const detail = await m.readSession(PROJECT, SESSION);
  assert.ok(detail);
  assert.equal(detail.projectLabel, CWD);
  assert.equal(detail.model, "qwen3-27b");
  assert.deepEqual(
    detail.messages.map((x: { type: string }) => x.type),
    ["user", "assistant", "user", "assistant"],
  );
  assert.equal(detail.messages[1].toolName, "run_shell_command");
  assert.equal(detail.messages[2].text, "12 passing");
  assert.equal(detail.messages[3].text, "all green");
});

test("a Claude and a Qwen session share a project without shadowing each other", async () => {
  writeTranscript();
  writeClaudeTranscript("11111111-2222-3333-4444-555555555555");
  const m = await fresh();

  const sessions = await m.readSessions();
  assert.equal(sessions.length, 2, "both runtimes' transcripts are listed");
  assert.deepEqual(
    new Set(sessions.map((s: { project: string }) => s.project)),
    new Set([PROJECT]),
  );

  // Claude Code's path is tried first and wins for its own id; the Qwen path is
  // only composed when there is no Claude transcript by that name.
  const claude = await m.readSession(PROJECT, "11111111-2222-3333-4444-555555555555");
  assert.equal(claude.messages[0].text, "claude side");
  const qwen = await m.readSession(PROJECT, SESSION);
  assert.equal(qwen.messages[0].text, "make the suite green");
});

test("an unknown session in a real project is not found, rather than an empty transcript", async () => {
  writeTranscript();
  const m = await fresh();
  assert.equal(await m.readSession(PROJECT, "99999999-0000-0000-0000-000000000000"), null);
});

test("a crafted project or id segment cannot escape the transcripts directory", async () => {
  writeTranscript();
  const m = await fresh();
  assert.equal(await m.readSession("..", SESSION), null);
  assert.equal(await m.readSession(PROJECT, "../../../etc/passwd"), null);
  assert.equal(await m.readSession(PROJECT, ".."), null);
});

test("the live tail ingests appended lines incrementally, agreeing with a full read", async () => {
  const file = writeTranscript(TRANSCRIPT.slice(0, 4));
  const m = await fresh();

  const first = await m.readSessionTail(PROJECT, SESSION, -1);
  assert.ok(first);
  assert.equal(first.title, "make the suite green");
  assert.equal(first.messages.length, 2, "user turn + the tool call");

  appendFileSync(
    file,
    TRANSCRIPT.slice(4)
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const second = await m.readSessionTail(PROJECT, SESSION, first.lastIndex);
  assert.ok(second);
  assert.deepEqual(
    second.messages.map((x: { text: string | null }) => x.text),
    ["12 passing", "all green"],
  );
  // What the tail built incrementally must match what a cold full read derives.
  const detail = await m.readSession(PROJECT, SESSION);
  assert.equal(second.lastIndex, detail.messages.length - 1);
});

test("raw lines come through translated, so the Flight Recorder reads tool inputs", async () => {
  writeTranscript();
  const m = await fresh();
  const lines = await m.readSessionLines(PROJECT, SESSION);
  const call = lines.find(
    (l: { message?: { content?: { type: string }[] } }) =>
      l.message?.content?.[0]?.type === "tool_use",
  );
  assert.deepEqual(call.message.content[0].input, { command: "npm test" });
});

test("the Markdown export names the model and every turn", async () => {
  writeTranscript();
  const m = await fresh();
  const md = m.sessionToMarkdown(await m.readSession(PROJECT, SESSION));
  assert.match(md, /\*\*Model:\*\* qwen3-27b/);
  assert.match(md, /tool: `run_shell_command`/);
  assert.match(md, /all green/);
});

test("transcript search covers Qwen sessions and files the hit under its directory", async () => {
  writeTranscript();
  const search = await import(`./search.js?${Math.random()}`);
  const hits = await search.searchTranscripts("suite green");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, SESSION);
  assert.equal(hits[0].project, PROJECT);
  assert.match(hits[0].snippet, /make the suite green/);
});

test("a project directory with no chats/ subdirectory is skipped, not an error", async () => {
  mkdirSync(path.join(qwenHome, "projects", "-srv-other", "memory"), { recursive: true });
  writeTranscript();
  const m = await fresh();
  assert.equal((await m.readSessions()).length, 1);
});

test("a malformed line costs one message, not the transcript", async () => {
  const file = writeTranscript();
  appendFileSync(file, "{ not json\n");
  const m = await fresh();
  const detail = await m.readSession(PROJECT, SESSION);
  assert.equal(detail.messages.length, 4);
});
