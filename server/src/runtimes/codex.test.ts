import { test } from "node:test";
import assert from "node:assert/strict";
import { codexRuntime, parseCodexEnvelope } from "./codex.js";
import { deriveCodexActivity } from "./codex.js";

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

test("a batch run is `codex exec --json`, sandboxed, reading the prompt from stdin", () => {
  const plan = codexRuntime.batchPlan({ prompt: "do the thing" });
  assert.equal(plan.bin, "codex");
  assert.deepEqual(plan.args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-",
  ]);
  assert.equal(plan.stdin, "do the thing");
  // The prompt is user-authored text; nothing may put it on argv.
  assert.equal(
    plan.args.some((a) => a.includes("do the thing")),
    false,
  );
});

test("the model override becomes --model", () => {
  const plan = codexRuntime.batchPlan({ prompt: "p", model: "gpt-5.3-codex" });
  const i = plan.args.indexOf("--model");
  assert.ok(i > -1);
  assert.equal(plan.args[i + 1], "gpt-5.3-codex");
});

test("no --model when none is set, so the CLI keeps its own default", () => {
  assert.equal(codexRuntime.batchPlan({ prompt: "p" }).args.includes("--model"), false);
  assert.equal(
    codexRuntime.batchPlan({ prompt: "p", model: "  " }).args.includes("--model"),
    false,
  );
});

test("Codex has no system-prompt flag, so the contract rides at the top of the prompt", () => {
  const plan = codexRuntime.streamPlan({ prompt: "step work", systemPrompt: "REPORT OUTCOME" });
  assert.equal(plan.args.includes("--append-system-prompt"), false);
  assert.ok(plan.stdin.startsWith("REPORT OUTCOME"));
  assert.ok(plan.stdin.endsWith("step work"));
});

test("an analysis pass is read-only whatever ordinary runs are allowed to do", () => {
  withEnv({ ARGUS_CODEX_SANDBOX: "danger-full-access" }, () => {
    assert.equal(codexRuntime.batchPlan({ prompt: "p" }).args.includes("danger-full-access"), true);
    const analysis = codexRuntime.analysisPlan({ prompt: "p" });
    const i = analysis.args.indexOf("--sandbox");
    assert.equal(analysis.args[i + 1], "read-only");
  });
});

test("an unrecognized sandbox mode falls back rather than being handed to the CLI", () => {
  withEnv({ ARGUS_CODEX_SANDBOX: "yolo" }, () => {
    const args = codexRuntime.batchPlan({ prompt: "p" }).args;
    assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  });
});

test("ARGUS_CODEX_ARGS is appended before the stdin placeholder", () => {
  withEnv({ ARGUS_CODEX_ARGS: '--profile "my profile" -c web_search=live' }, () => {
    const args = codexRuntime.batchPlan({ prompt: "p" }).args;
    assert.deepEqual(args.slice(-5), ["--profile", "my profile", "-c", "web_search=live", "-"]);
  });
});

test("ARGUS_CODEX_BIN redirects the executable", () => {
  withEnv({ ARGUS_CODEX_BIN: "/opt/bin/codex" }, () => {
    assert.equal(codexRuntime.batchPlan({ prompt: "p" }).bin, "/opt/bin/codex");
  });
});

const STREAM = [
  '{"type":"thread.started","thread_id":"019c7149-abcd"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"i0","type":"command_execution","command":"npm test"}}',
  '{"type":"item.completed","item":{"id":"i0","type":"command_execution","command":"npm test","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"all green"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":900,"output_tokens":300,"reasoning_output_tokens":40}}',
].join("\n");

test("the envelope is folded out of the whole event stream", () => {
  const env = parseCodexEnvelope(STREAM);
  assert.equal(env.result, "all green");
  assert.equal(env.sessionId, "019c7149-abcd");
  assert.equal(env.tokens, 1500);
  assert.equal(env.isError, false);
  // Codex reports tokens, not dollars — a fabricated figure would be worse.
  assert.equal(env.costUsd, null);
});

test("the envelope survives stderr chatter and a torn leading line", () => {
  const noisy = "npm warn something\n" + STREAM.slice(20);
  const env = parseCodexEnvelope(noisy);
  assert.equal(env.result, "all green");
  assert.equal(env.tokens, 1500);
});

test("a failed turn reports the error as the result when there is no agent message", () => {
  const env = parseCodexEnvelope(
    '{"type":"thread.started","thread_id":"t1"}\n' +
      '{"type":"turn.failed","error":{"message":"model overloaded"}}',
  );
  assert.equal(env.isError, true);
  assert.equal(env.result, "model overloaded");
  assert.equal(env.sessionId, "t1");
});

test("an empty or unparseable log is nulls, not a throw", () => {
  assert.deepEqual(parseCodexEnvelope("   "), {
    result: null,
    costUsd: null,
    tokens: null,
    isError: null,
    sessionId: null,
  });
  assert.equal(parseCodexEnvelope("not json at all {").result, null);
});

test("activity: a shell command is announced when it starts, exactly once", () => {
  const at = "2026-07-31T00:00:00.000Z";
  const started = deriveCodexActivity(
    '{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}',
    at,
  );
  assert.deepEqual(started, [{ at, kind: "tool", label: "Shell: npm test" }]);
  // …and not repeated on completion, or the feed would double every command.
  assert.deepEqual(
    deriveCodexActivity(
      '{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}',
      at,
    ),
    [],
  );
});

test("activity: messages, edits, searches and lifecycle events", () => {
  const at = "2026-07-31T00:00:00.000Z";
  const one = (line: string) => deriveCodexActivity(line, at)[0];
  assert.deepEqual(one('{"type":"thread.started","thread_id":"t"}'), {
    at,
    kind: "init",
    label: "session started",
  });
  assert.deepEqual(one('{"type":"turn.completed","usage":{}}'), {
    at,
    kind: "done",
    label: "finished",
  });
  assert.equal(
    one('{"type":"item.completed","item":{"type":"agent_message","text":"hello  there"}}')?.label,
    "hello there",
  );
  assert.equal(
    one(
      '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"/a/b/foo.ts"},{"path":"/a/b/bar.ts"}]}}',
    )?.label,
    "Edit: foo.ts +1",
  );
  assert.equal(
    one('{"type":"item.completed","item":{"type":"web_search","query":"tsc noEmit"}}')?.label,
    "Search: tsc noEmit",
  );
  assert.equal(
    one('{"type":"item.started","item":{"type":"mcp_tool_call","server":"gh","tool":"list_prs"}}')
      ?.label,
    "gh.list_prs",
  );
});

test("activity: reasoning is skipped, matching how thinking blocks are treated", () => {
  const out = deriveCodexActivity(
    '{"type":"item.completed","item":{"type":"reasoning","text":"pondering"}}',
    "2026-07-31T00:00:00.000Z",
  );
  assert.deepEqual(out, []);
});

test("activity: malformed lines yield nothing", () => {
  assert.deepEqual(deriveCodexActivity("{oops", "t"), []);
  assert.deepEqual(deriveCodexActivity("", "t"), []);
});
