import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveQwenActivity, parseQwenEnvelope, qwenRuntime } from "./qwen.js";

const RESET = { ...process.env };
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (RESET[k] === undefined) delete process.env[k];
      else process.env[k] = RESET[k];
    }
  }
}

const RESULT = {
  type: "result",
  subtype: "success",
  session_id: "9c4ea2e9-2241-417c-b094-6d27ff082b2a",
  is_error: false,
  result: "Listed the tree.\nARGUS_OUTCOME: succeeded",
  usage: { input_tokens: 2468, output_tokens: 112, cache_read_input_tokens: 0 },
};

/** Verbatim shape of `qwen -o stream-json`: Claude Code's envelope, Qwen's tools. */
const STREAM = [
  '{"type":"system","subtype":"init","session_id":"9c4","tools":["glob"],"model":"qwen3-27b"}',
  '{"type":"stream_event","session_id":"9c4","event":{"type":"goal_state"}}',
  '{"type":"assistant","session_id":"9c4","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"run_shell_command","input":{"command":"ls -la"}}]}}',
  '{"type":"user","session_id":"9c4","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"ok"}]}}',
  '{"type":"assistant","session_id":"9c4","message":{"role":"assistant","content":[{"type":"text","text":"Listed the tree."}]}}',
  JSON.stringify(RESULT),
].join("\n");

test("a batch run puts the whole prompt on stdin — never on argv, never split via -p", () => {
  withEnv({ ARGUS_QWEN_BIN: undefined, ARGUS_QWEN_ARGS: undefined }, () => {
    const plan = qwenRuntime.batchPlan({ prompt: "do the thing" });
    assert.equal(plan.bin, "qwen");
    assert.deepEqual(plan.args, ["--output-format", "json", "--approval-mode", "yolo"]);
    assert.equal(plan.stdin, "do the thing");
    // `-p` *appends* to stdin rather than replacing it, so using both would
    // deliver the prompt twice.
    assert.equal(plan.args.includes("-p"), false);
    assert.equal(
      plan.args.some((a) => a.includes("do the thing")),
      false,
    );
  });
});

test("a step run streams NDJSON so the Command Center can follow it live", () => {
  const plan = qwenRuntime.streamPlan({ prompt: "p" });
  assert.equal(plan.args[plan.args.indexOf("--output-format") + 1], "stream-json");
});

test("unattended runs get the full tool set, and silence the banner that would corrupt the log", () => {
  const plan = qwenRuntime.batchPlan({ prompt: "p" });
  assert.equal(plan.args[plan.args.indexOf("--approval-mode") + 1], "yolo");
  // The yolo notice goes to stderr, and the pipeline engine points both
  // descriptors at one log — so left on, it lands mid-transcript.
  assert.equal(plan.env.QWEN_CODE_SUPPRESS_YOLO_WARNING, "1");
});

test("an analysis pass keeps the default approval mode, which withholds shell and write", () => {
  const plan = qwenRuntime.analysisPlan({ prompt: "score this" });
  assert.equal(plan.args[plan.args.indexOf("--approval-mode") + 1], "default");
});

test("the model override becomes --model, and is omitted when unset", () => {
  assert.equal(
    qwenRuntime.batchPlan({ prompt: "p", model: "qwen3-27b" }).args[
      qwenRuntime.batchPlan({ prompt: "p", model: "qwen3-27b" }).args.indexOf("--model") + 1
    ],
    "qwen3-27b",
  );
  assert.equal(qwenRuntime.batchPlan({ prompt: "p" }).args.includes("--model"), false);
  assert.equal(qwenRuntime.batchPlan({ prompt: "p", model: " " }).args.includes("--model"), false);
});

test("Qwen Code has no system-prompt flag, so the contract rides at the top of the prompt", () => {
  const plan = qwenRuntime.streamPlan({ prompt: "step work", systemPrompt: "REPORT OUTCOME" });
  assert.equal(plan.args.includes("--append-system-prompt"), false);
  assert.ok(plan.stdin.startsWith("REPORT OUTCOME"));
  assert.ok(plan.stdin.endsWith("step work"));
});

test("the envelope is read out of the NDJSON stream", () => {
  const env = parseQwenEnvelope(STREAM);
  assert.equal(env.result, "Listed the tree.\nARGUS_OUTCOME: succeeded");
  assert.equal(env.sessionId, "9c4ea2e9-2241-417c-b094-6d27ff082b2a");
  assert.equal(env.tokens, 2468 + 112);
  assert.equal(env.isError, false);
  // No price list for a locally served model, so no invented figure.
  assert.equal(env.costUsd, null);
});

test("the envelope is also read out of `-o json`, which is one line-long array", () => {
  const array = JSON.stringify([{ type: "system", subtype: "init", session_id: "9c4" }, RESULT]);
  const env = parseQwenEnvelope(array);
  assert.equal(env.result, "Listed the tree.\nARGUS_OUTCOME: succeeded");
  assert.equal(env.tokens, 2580);
  // An `init` event at the head of that array must never be mistaken for the
  // outcome — it is an object with a session id and nothing else to say.
  assert.equal(env.sessionId, "9c4ea2e9-2241-417c-b094-6d27ff082b2a");
});

test("stderr around the stream is skipped, not fatal", () => {
  const env = parseQwenEnvelope(`Warning: running headless with --yolo\n${STREAM}`);
  assert.equal(env.tokens, 2580);
});

test("an empty or resultless log yields the empty envelope, never a guess", () => {
  const empty = { result: null, costUsd: null, tokens: null, isError: null, sessionId: null };
  assert.deepEqual(parseQwenEnvelope("   "), empty);
  assert.deepEqual(parseQwenEnvelope('{"type":"assistant","message":{}}'), empty);
});

test("activity reads Qwen's tool vocabulary through the shared stream-json reader", () => {
  const at = "2026-08-15T00:00:00.000Z";
  const events = STREAM.split("\n").flatMap((line) => deriveQwenActivity(line, at));
  assert.deepEqual(events, [
    { at, kind: "init", label: "session started" },
    { at, kind: "tool", label: "Shell: ls -la" },
    { at, kind: "text", label: "Listed the tree." },
    { at, kind: "done", label: "finished" },
  ]);
});

test("file tools are labelled by basename, whichever key the tool spells the path with", () => {
  const at = "t";
  const line = (name: string, input: Record<string, unknown>) =>
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
    });
  assert.equal(
    deriveQwenActivity(line("read_file", { absolute_path: "/repo/src/app.ts" }), at)[0].label,
    "Read: app.ts",
  );
  assert.equal(
    deriveQwenActivity(line("edit", { file_path: "/repo/src/app.ts" }), at)[0].label,
    "Edit: app.ts",
  );
  assert.equal(
    deriveQwenActivity(line("grep_search", { pattern: "TODO" }), at)[0].label,
    "Grep: TODO",
  );
  // A tool Argus has no opinion about still names itself rather than vanishing.
  assert.equal(deriveQwenActivity(line("record_artifact", {}), at)[0].label, "record_artifact");
});

test("Qwen Code declares the gaps the UI has to explain", () => {
  // Its hooks are Claude Code's, down to the payload, so the signal path is the
  // installed one and the run record is never second-guessed behind it.
  assert.equal(qwenRuntime.capabilities.signalHook, true);
  assert.equal(qwenRuntime.outcomeFromRecord, false);
  // It mints its own session id and reports tokens, not dollars.
  assert.equal(qwenRuntime.capabilities.presetSessionId, false);
  // Its transcripts are filed like Claude Code's and translated on read, so the
  // Sessions view has something to show.
  assert.equal(qwenRuntime.capabilities.transcripts, true);
  assert.equal(qwenRuntime.capabilities.reportsTokens, true);
  assert.equal(qwenRuntime.capabilities.reportsCost, false);
  // No per-run reasoning flag: effort is a property of the served model.
  assert.deepEqual(qwenRuntime.reasoningEfforts(), []);
});

test("the model picker leads with whatever the configured endpoint serves", () => {
  withEnv({ OPENAI_MODEL: "qwen3-27b-q5", ARGUS_QWEN_MODELS: "vl-max" }, () => {
    const models = qwenRuntime.models();
    assert.equal(models[0], "qwen3-27b-q5");
    assert.ok(models.includes("qwen3-coder-plus"));
    assert.ok(models.includes("vl-max"));
  });
});
