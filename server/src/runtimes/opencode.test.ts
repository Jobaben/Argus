import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveOpencodeActivity, opencodeRuntime, parseOpencodeEnvelope } from "./opencode.js";

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

/** Verbatim shape of `opencode run --format json`, one line per event. */
const LOG = [
  '{"type":"step_start","sessionID":"ses_ff89","part":{"type":"step-start"}}',
  '{"type":"tool_use","sessionID":"ses_ff89","part":{"type":"tool","tool":"bash","callID":"call_1","state":{"status":"completed","input":{"command":"npm test","description":"run tests"},"title":"npm test"}}}',
  '{"type":"step_finish","sessionID":"ses_ff89","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":1290,"input":1234,"output":56,"reasoning":0},"cost":0.002}}',
  '{"type":"text","sessionID":"ses_ff89","part":{"type":"text","text":"All green.\\nARGUS_OUTCOME: succeeded"}}',
  '{"type":"step_finish","sessionID":"ses_ff89","part":{"type":"step-finish","reason":"stop","tokens":{"total":700,"input":600,"output":100,"reasoning":0},"cost":0.001}}',
].join("\n");

test("a batch run is `opencode run --format json`, auto-approving, prompt on stdin", () => {
  withEnv({ ARGUS_OPENCODE_BIN: undefined, ARGUS_OPENCODE_ARGS: undefined }, () => {
    const plan = opencodeRuntime.batchPlan({ prompt: "do the thing" });
    assert.equal(plan.bin, "opencode");
    assert.deepEqual(plan.args, ["run", "--format", "json", "--auto"]);
    assert.equal(plan.stdin, "do the thing");
    // The prompt is user-authored text; nothing may put it on argv. OpenCode's
    // `[message..]` positional exists, and this is why it stays unused.
    assert.equal(
      plan.args.some((a) => a.includes("do the thing")),
      false,
    );
  });
});

test("the model and reasoning overrides become --model and --variant", () => {
  const plan = opencodeRuntime.batchPlan({
    prompt: "p",
    model: "llama/qwen3-27b",
    reasoningEffort: "high",
  });
  assert.equal(plan.args[plan.args.indexOf("--model") + 1], "llama/qwen3-27b");
  assert.equal(plan.args[plan.args.indexOf("--variant") + 1], "high");
});

test("no --model when none is set, so the CLI keeps its own configured default", () => {
  assert.equal(opencodeRuntime.batchPlan({ prompt: "p" }).args.includes("--model"), false);
  assert.equal(
    opencodeRuntime.batchPlan({ prompt: "p", model: "  " }).args.includes("--model"),
    false,
  );
});

test("OpenCode has no system-prompt flag, so the contract rides at the top of the prompt", () => {
  const plan = opencodeRuntime.streamPlan({ prompt: "step work", systemPrompt: "REPORT OUTCOME" });
  assert.equal(plan.args.includes("--append-system-prompt"), false);
  assert.ok(plan.stdin.startsWith("REPORT OUTCOME"));
  assert.ok(plan.stdin.endsWith("step work"));
});

test("an analysis pass runs under the read-only plan agent, never auto-approved", () => {
  const plan = opencodeRuntime.analysisPlan({ prompt: "score this" });
  assert.equal(plan.args[plan.args.indexOf("--agent") + 1], "plan");
  assert.equal(plan.args.includes("--auto"), false);
});

test("ARGUS_OPENCODE_ARGS is appended, honouring simple quoting", () => {
  withEnv({ ARGUS_OPENCODE_ARGS: '--log-level DEBUG --title "nightly audit"' }, () => {
    const args = opencodeRuntime.batchPlan({ prompt: "p" }).args;
    assert.ok(args.includes("--log-level"));
    assert.ok(args.includes("nightly audit"));
  });
});

test("the envelope folds the event stream into one result, cost and token total", () => {
  const env = parseOpencodeEnvelope(LOG);
  assert.equal(env.result, "All green.\nARGUS_OUTCOME: succeeded");
  assert.equal(env.sessionId, "ses_ff89");
  assert.equal(env.tokens, 1234 + 56 + 600 + 100);
  assert.equal(env.costUsd, 0.003);
  assert.equal(env.isError, false);
});

test("an error event is the result when there is no assistant text to report", () => {
  const env = parseOpencodeEnvelope(
    '{"type":"error","sessionID":"ses_1","error":{"name":"UnknownError","data":{"message":"provider not configured"}}}',
  );
  assert.equal(env.isError, true);
  assert.equal(env.result, "provider not configured");
  assert.equal(env.sessionId, "ses_1");
});

test("stderr interleaved with the stream is skipped, not fatal", () => {
  const env = parseOpencodeEnvelope(`warning: something\n${LOG}\nnot json at all`);
  assert.equal(env.result, "All green.\nARGUS_OUTCOME: succeeded");
});

test("an empty or unparseable log yields the empty envelope, never a guess", () => {
  assert.deepEqual(parseOpencodeEnvelope("   "), {
    result: null,
    costUsd: null,
    tokens: null,
    isError: null,
    sessionId: null,
  });
});

test("activity reports tools and text once, and only a real stop as finished", () => {
  const at = "2026-08-15T00:00:00.000Z";
  const events = LOG.split("\n").flatMap((line) => deriveOpencodeActivity(line, at));
  assert.deepEqual(events, [
    { at, kind: "tool", label: "Bash: npm test" },
    { at, kind: "text", label: "All green. ARGUS_OUTCOME: succeeded" },
    { at, kind: "done", label: "finished" },
  ]);
});

test("a malformed line derives nothing rather than throwing at the tailer", () => {
  assert.deepEqual(deriveOpencodeActivity("{not json", "t"), []);
  assert.deepEqual(deriveOpencodeActivity("[]", "t"), []);
});

test("OpenCode declares the gaps the UI has to explain", () => {
  // No command hook to register: the ARGUS_OUTCOME marker on the run record is
  // the completion protocol, which is what `outcomeFromRecord` licenses.
  assert.equal(opencodeRuntime.capabilities.signalHook, false);
  assert.equal(opencodeRuntime.outcomeFromRecord, true);
  // `run` mints its own session id, and transcripts live in a private SQLite
  // schema Argus does not read.
  assert.equal(opencodeRuntime.capabilities.presetSessionId, false);
  assert.equal(opencodeRuntime.capabilities.transcripts, false);
  // Cost comes from OpenCode itself, so it needs no price table to be honest.
  assert.equal(opencodeRuntime.capabilities.reportsCost, true);
});

test("the model picker is free-text unless a machine pins its own", () => {
  withEnv({ ARGUS_OPENCODE_MODELS: undefined }, () => {
    assert.deepEqual(opencodeRuntime.models(), []);
  });
  withEnv({ ARGUS_OPENCODE_MODELS: "llama/qwen3-27b, ollama/devstral" }, () => {
    assert.deepEqual(opencodeRuntime.models(), ["llama/qwen3-27b", "ollama/devstral"]);
  });
});
