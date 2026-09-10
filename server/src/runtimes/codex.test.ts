import { test } from "node:test";
import assert from "node:assert/strict";
import { codexRuntime, estimateCodexCost, parseCodexEnvelope } from "./codex.js";
import { deriveCodexActivity } from "./codex.js";
import type { CapabilityRequest } from "./types.js";
import type { CapabilityProfile } from "@argus/contracts";

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
  withEnv({ ARGUS_CODEX_BIN: undefined }, () => {
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
});

test("the model override becomes --model", () => {
  const plan = codexRuntime.batchPlan({ prompt: "p", model: "gpt-5.3-codex" });
  const i = plan.args.indexOf("--model");
  assert.ok(i > -1);
  assert.equal(plan.args[i + 1], "gpt-5.3-codex");
});

test("the reasoning override becomes an inline Codex config value", () => {
  const plan = codexRuntime.batchPlan({ prompt: "p", reasoningEffort: "high" });
  const i = plan.args.indexOf("-c");
  assert.ok(i > -1);
  assert.equal(plan.args[i + 1], 'model_reasoning_effort="high"');
});

test("Codex exposes current model and reasoning choices to the UI", () => {
  assert.ok(codexRuntime.models().includes("gpt-5.6-sol"));
  assert.ok(codexRuntime.models().includes("gpt-5.6-terra"));
  assert.deepEqual(codexRuntime.reasoningEfforts(), ["minimal", "low", "medium", "high", "xhigh"]);
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

test("Codex cost is estimated from uncached input, cached input, and output tokens", () => {
  const env = parseCodexEnvelope(STREAM, "gpt-5.3-codex");
  assert.equal(env.costUsd, 0.004883);
  assert.equal(
    estimateCodexCost("gpt-5.6-terra", {
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200,
    }),
    0.0046,
  );
});

test("unknown model pricing stays null instead of fabricating a dollar amount", () => {
  assert.equal(parseCodexEnvelope(STREAM, "private-model").costUsd, null);
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

function capRequest(
  profile: CapabilityProfile,
  overrides: Partial<Omit<CapabilityRequest, "profile">> = {},
): CapabilityRequest {
  return {
    profile,
    invocationDir: "/inv",
    cwd: "/work",
    artifactDir: null,
    ...overrides,
  };
}

test("filesystem overrides --sandbox, including ARGUS_CODEX_SANDBOX", () => {
  withEnv({ ARGUS_CODEX_SANDBOX: "danger-full-access" }, () => {
    const plan = codexRuntime.streamPlan({
      prompt: "p",
      capabilities: capRequest({ filesystem: "read-only" }),
    });
    const i = plan.args.indexOf("--sandbox");
    assert.equal(plan.args[i + 1], "read-only");
  });
});

test("filesystem: unrestricted maps to Codex's danger-full-access sandbox", () => {
  const plan = codexRuntime.streamPlan({
    prompt: "p",
    capabilities: capRequest({ filesystem: "unrestricted" }),
  });
  const i = plan.args.indexOf("--sandbox");
  assert.equal(plan.args[i + 1], "danger-full-access");
});

test("no profile.filesystem keeps the env-based sandbox default", () => {
  withEnv({ ARGUS_CODEX_SANDBOX: "danger-full-access" }, () => {
    const plan = codexRuntime.streamPlan({ prompt: "p", capabilities: capRequest({}) });
    const i = plan.args.indexOf("--sandbox");
    assert.equal(plan.args[i + 1], "danger-full-access");
  });
});

test("additionalDirectories becomes a writable_roots -c override", () => {
  const plan = codexRuntime.streamPlan({
    prompt: "p",
    capabilities: capRequest({
      filesystem: "workspace-write",
      additionalDirectories: ["/a", "/b"],
    }),
  });
  const i = plan.args.indexOf("-c");
  assert.ok(i > -1);
  assert.equal(plan.args[i + 1], 'sandbox_workspace_write.writable_roots=["/a","/b"]');
});

test("artifactDir joins writable_roots under workspace-write", () => {
  const plan = codexRuntime.streamPlan({
    prompt: "p",
    capabilities: capRequest(
      { filesystem: "workspace-write", additionalDirectories: ["/a"] },
      { artifactDir: "/artifacts/run-1" },
    ),
  });
  const i = plan.args.indexOf("-c");
  assert.equal(
    plan.args[i + 1],
    'sandbox_workspace_write.writable_roots=["/a","/artifacts/run-1"]',
  );
});

test("read-only with an artifactDir reports a limitation instead of adding it to writable_roots", () => {
  const plan = codexRuntime.streamPlan({
    prompt: "p",
    capabilities: capRequest({ filesystem: "read-only" }, { artifactDir: "/artifacts/run-2" }),
  });
  assert.equal(plan.args.includes("-c"), false);
  assert.ok(plan.limitations?.includes("read-only sandbox prevents writing artifacts"));
});

test("mcpServers becomes dotted -c overrides per server, and is always a limitation", () => {
  const plan = codexRuntime.streamPlan({
    prompt: "p",
    capabilities: capRequest({
      mcpServers: {
        docs: { command: "docs-mcp", args: ["--stdio"], env: { FOO: "bar" } },
        remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
      },
    }),
  });
  const cIdx = (flag: string) =>
    plan.args.findIndex((a, i) => i > 0 && plan.args[i - 1] === "-c" && a === flag);
  assert.ok(cIdx('mcp_servers.docs.command="docs-mcp"') > -1);
  assert.ok(cIdx('mcp_servers.docs.args=["--stdio"]') > -1);
  assert.ok(cIdx('mcp_servers.docs.env.FOO="bar"') > -1);
  assert.ok(cIdx('mcp_servers.remote.url="https://example.com/mcp"') > -1);
  assert.ok(cIdx('mcp_servers.remote.headers.Authorization="Bearer x"') > -1);
  assert.ok(
    plan.limitations?.includes("Codex cannot exclude MCP servers configured in config.toml"),
  );
});

test("an empty mcpServers object still reports the limitation", () => {
  const plan = codexRuntime.streamPlan({
    prompt: "p",
    capabilities: capRequest({ mcpServers: {} }),
  });
  assert.deepEqual(plan.limitations, [
    "Codex cannot exclude MCP servers configured in config.toml",
  ]);
});

test("tools, settingSources, permissionMode and maxTurns are all reported as limitations", () => {
  const plan = codexRuntime.streamPlan({
    prompt: "p",
    capabilities: capRequest({
      tools: { allow: ["Read"] },
      settingSources: ["project"],
      permissionMode: "plan",
      maxTurns: 4,
    }),
  });
  assert.deepEqual(plan.limitations, [
    'Codex cannot enforce "tools" for this invocation',
    'Codex cannot enforce "settingSources" for this invocation',
    'Codex cannot enforce "permissionMode" for this invocation',
    'Codex cannot enforce "maxTurns" for this invocation',
  ]);
});

test("capabilities always add files: [] since Codex writes no config files", () => {
  const plan = codexRuntime.streamPlan({ prompt: "p", capabilities: capRequest({}) });
  assert.deepEqual(plan.files, []);
});

test("hooks are ignored: Codex hooks live only in config.toml", () => {
  const plan = codexRuntime.streamPlan({
    prompt: "p",
    capabilities: capRequest({}, { hooks: { stop: "s", gate: "g" } }),
  });
  assert.equal(plan.args.includes("s"), false);
  assert.equal(plan.args.includes("g"), false);
  assert.deepEqual(plan.limitations, []);
});

test("no capabilities means no files/limitations at all, and argv is unchanged", () => {
  const plan = codexRuntime.streamPlan({ prompt: "p" });
  assert.equal("files" in plan, false);
  assert.equal("limitations" in plan, false);
});
