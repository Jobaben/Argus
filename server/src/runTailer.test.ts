import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
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

// The tailer resolves log paths through runLogPath(), which keys off
// ARGUS_CLAUDE_HOME — point it at a temp dir and cache-bust the imports,
// mirroring pipelineEngine.test.ts.
async function loadTailer() {
  process.env.ARGUS_CLAUDE_HOME = mkdtempSync(path.join(tmpdir(), "argus-tailer-"));
  const tailerMod = await import(`./runTailer.js?${Math.random()}`);
  const runsMod = await import(`./sources/runs.js?${Math.random()}`);
  const logPath = (id: string) => runsMod.runLogPath(id) as string;
  mkdirSync(path.dirname(logPath("seed")), { recursive: true });
  return { createRunTailer: tailerMod.createRunTailer, logPath };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const toolLine = (cmd: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: cmd } }] },
  }) + "\n";

test("tailer reads appended lines incrementally and exposes the latest event", async () => {
  const { createRunTailer, logPath } = await loadTailer();
  const sent: unknown[] = [];
  const tailer = createRunTailer({
    broadcast: (m: unknown) => sent.push(m),
    now: () => new Date("2026-07-07T10:00:00.000Z"),
    flushMs: 5,
    watch: false,
  });
  writeFileSync(logPath("r1"), toolLine("npm ci"));
  tailer.track("r1", "inst-1");
  await waitFor(() => tailer.latest().get("r1")?.label === "Bash: npm ci");

  appendFileSync(logPath("r1"), toolLine("npm test"));
  tailer.poke("r1");
  await waitFor(() => tailer.latest().get("r1")?.label === "Bash: npm test");
  await waitFor(() => sent.length >= 1);
  const first = sent[0] as { type: string; runId: string; instanceId: string; events: unknown[] };
  assert.equal(first.type, "run:activity");
  assert.equal(first.runId, "r1");
  assert.equal(first.instanceId, "inst-1");
  await tailer.stop();
});

test("a partial trailing line is buffered until its newline arrives", async () => {
  const { createRunTailer, logPath } = await loadTailer();
  const tailer = createRunTailer({ broadcast: () => {}, now: () => new Date(), flushMs: 5, watch: false });
  const full = toolLine("split across reads");
  writeFileSync(logPath("r2"), full.slice(0, 25)); // mid-JSON, no newline
  tailer.track("r2", "inst-2");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tailer.latest().get("r2"), undefined);
  appendFileSync(logPath("r2"), full.slice(25));
  tailer.poke("r2");
  await waitFor(() => tailer.latest().get("r2")?.label === "Bash: split across reads");
  await tailer.stop();
});

test("tracking a run with an existing log rebuilds from disk (adopt path)", async () => {
  const { createRunTailer, logPath } = await loadTailer();
  const tailer = createRunTailer({ broadcast: () => {}, now: () => new Date(), flushMs: 5, watch: false });
  writeFileSync(logPath("r3"), toolLine("first") + toolLine("second"));
  tailer.track("r3", "inst-3");
  await waitFor(() => tailer.latest().get("r3")?.label === "Bash: second");
  await tailer.stop();
});

test("untrack drops state; a missing log file is tolerated", async () => {
  const { createRunTailer, logPath } = await loadTailer();
  const tailer = createRunTailer({ broadcast: () => {}, now: () => new Date(), flushMs: 5, watch: false });
  tailer.track("no-log-yet", "inst-4"); // file does not exist — must not throw
  writeFileSync(logPath("r4"), toolLine("x"));
  tailer.track("r4", "inst-5");
  await waitFor(() => tailer.latest().has("r4"));
  tailer.untrack("r4");
  assert.equal(tailer.latest().has("r4"), false);
  await tailer.stop();
});

test("untrack during an in-flight read suppresses its broadcast", async () => {
  const { createRunTailer, logPath } = await loadTailer();
  const sent: unknown[] = [];
  const tailer = createRunTailer({
    broadcast: (m: unknown) => sent.push(m),
    now: () => new Date(),
    flushMs: 5,
    watch: false,
  });
  writeFileSync(logPath("r6"), toolLine("x"));
  tailer.track("r6", "inst-7"); // poke starts an async read
  tailer.untrack("r6"); // state removed while the read is in flight
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sent.length, 0);
  await tailer.stop();
});

test("broadcast batches events and flushes on the throttle timer", async () => {
  const { createRunTailer, logPath } = await loadTailer();
  const sent: { events: unknown[] }[] = [];
  const tailer = createRunTailer({
    broadcast: (m: unknown) => sent.push(m as { events: unknown[] }),
    now: () => new Date(),
    flushMs: 50,
    watch: false,
  });
  writeFileSync(logPath("r5"), toolLine("a") + toolLine("b") + toolLine("c"));
  tailer.track("r5", "inst-6");
  await waitFor(() => sent.length === 1);
  assert.equal(sent[0].events.length, 3); // one batched flush, not three
  await tailer.stop();
});
