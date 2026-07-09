import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-sdc-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function load(mod: string) {
  return import(`./${mod}.js?${Math.random()}`);
}

function seedTranscript(project: string, id: string, lines: unknown[]) {
  mkdirSync(path.join(home, "projects", project), { recursive: true });
  writeFileSync(
    path.join(home, "projects", project, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n"),
  );
}

test("searchTranscripts: empty query returns nothing", async () => {
  const { searchTranscripts } = await load("search");
  assert.deepEqual(await searchTranscripts("  "), []);
});

test("searchTranscripts: case-insensitive match with a centered snippet", async () => {
  seedTranscript("-home-user-proj", "s1", [
    { type: "user", message: { role: "user", content: "Please fix the WIDGET rendering bug" } },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "unrelated" }] },
    },
  ]);
  const { searchTranscripts } = await load("search");
  const results = await searchTranscripts("widget");
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, "s1");
  assert.match(results[0].snippet.toLowerCase(), /widget/);
});

test("searchTranscripts: honors the result limit", async () => {
  const lines = Array.from({ length: 5 }, (_, i) => ({
    type: "user",
    message: { role: "user", content: `needle ${i}` },
  }));
  seedTranscript("-p", "s1", lines);
  const { searchTranscripts } = await load("search");
  const results = await searchTranscripts("needle", 2);
  assert.equal(results.length, 2);
});

test("searchTranscripts: newest transcripts rank first", async () => {
  // "a-old" sorts first alphabetically; only mtime ordering puts "b-new" first.
  seedTranscript("-p", "a-old", [
    { type: "user", message: { role: "user", content: "token in old" } },
  ]);
  seedTranscript("-p", "b-new", [
    { type: "user", message: { role: "user", content: "token in new" } },
  ]);
  const now = Date.now();
  utimesSync(
    path.join(home, "projects", "-p", "a-old.jsonl"),
    new Date(now - 60_000),
    new Date(now - 60_000),
  );
  utimesSync(path.join(home, "projects", "-p", "b-new.jsonl"), new Date(now), new Date(now));
  const { searchTranscripts } = await load("search");
  const results = await searchTranscripts("token");
  assert.deepEqual(
    results.map((r: { sessionId: string }) => r.sessionId),
    ["b-new", "a-old"],
  );
});

test("readDaemon: empty when no roster file", async () => {
  const { readDaemon } = await load("daemon");
  const snap = await readDaemon();
  assert.equal(snap.supervisorPid, null);
  assert.deepEqual(snap.workers, {});
});

test("readDaemon: parses supervisor + workers from roster.json", async () => {
  mkdirSync(path.join(home, "daemon"), { recursive: true });
  writeFileSync(
    path.join(home, "daemon", "roster.json"),
    JSON.stringify({ supervisorPid: 111, workers: { abc: { pid: 222 } } }),
  );
  const { readDaemon } = await load("daemon");
  const snap = await readDaemon();
  assert.equal(snap.supervisorPid, 111);
  assert.equal(snap.workers.abc.pid, 222);
});

test("readCron: reports unavailable with an explanation and how-to", async () => {
  const { readCron } = await load("cron");
  const cron = await readCron();
  assert.equal(cron.available, false);
  assert.ok(cron.reason.length > 0);
  assert.ok(cron.howTo.length > 0);
});
