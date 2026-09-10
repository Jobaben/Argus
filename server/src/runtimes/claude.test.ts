import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeRuntime } from "./claude.js";
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

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

function request(
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

test("a legacy plan without capabilities is byte-identical to before", () => {
  withEnv({ ARGUS_CLAUDE_ARGS: undefined }, () => {
    const plan = claudeRuntime.streamPlan({
      prompt: "do the work",
      sessionId: SESSION_ID,
      model: "sonnet",
      systemPrompt: "REPORT OUTCOME",
    });
    assert.deepEqual(plan.args, [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      SESSION_ID,
      "--append-system-prompt",
      "REPORT OUTCOME",
      "--model",
      "sonnet",
    ]);
    assert.equal(plan.stdin, "do the work");
    assert.equal("files" in plan, false);
    assert.equal("limitations" in plan, false);

    const batch = claudeRuntime.batchPlan({ prompt: "p", sessionId: SESSION_ID, model: "opus" });
    assert.deepEqual(batch.args, [
      "-p",
      "--output-format",
      "json",
      "--session-id",
      SESSION_ID,
      "--model",
      "opus",
    ]);
    assert.equal("files" in batch, false);
    assert.equal("limitations" in batch, false);
  });
});

test("tools.allow and tools.deny each become one comma-joined flag", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({
      tools: { allow: ["Bash(npm test:*)", "Read"], deny: ["WebFetch"] },
    }),
  });
  const ai = plan.args.indexOf("--allowedTools");
  assert.equal(plan.args[ai + 1], "Bash(npm test:*),Read");
  const di = plan.args.indexOf("--disallowedTools");
  assert.equal(plan.args[di + 1], "WebFetch");
  assert.deepEqual(plan.limitations, []);
});

test("read-only denies edits under cwd and every additional directory", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({
      filesystem: "read-only",
      additionalDirectories: ["/other"],
    }),
  });
  const di = plan.args.indexOf("--disallowedTools");
  assert.ok(di > -1);
  const denied = plan.args[di + 1].split(",");
  assert.deepEqual(denied, ["Edit(///work/**)", "Edit(///other/**)", "Bash"]);
});

test("read-only denies Bash entirely when no Bash rule is allowed", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({ filesystem: "read-only" }),
  });
  const di = plan.args.indexOf("--disallowedTools");
  const denied = plan.args[di + 1].split(",");
  assert.ok(denied.includes("Bash"));
  assert.deepEqual(plan.limitations, []);
});

test("read-only keeps a scoped Bash allow rule without denying Bash", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({
      filesystem: "read-only",
      tools: { allow: ["Bash(npm test:*)"] },
    }),
  });
  const di = plan.args.indexOf("--disallowedTools");
  const denied = plan.args[di + 1].split(",");
  assert.equal(denied.includes("Bash"), false);
  assert.deepEqual(plan.limitations, []);
});

test("read-only with a bare Bash allow rule keeps Bash and reports a limitation", () => {
  for (const bare of ["Bash", "Bash(*)", "Bash(*:*)"]) {
    const plan = claudeRuntime.streamPlan({
      prompt: "p",
      sessionId: SESSION_ID,
      capabilities: request({
        filesystem: "read-only",
        tools: { allow: [bare] },
      }),
    });
    const di = plan.args.indexOf("--disallowedTools");
    const denied = di > -1 ? plan.args[di + 1].split(",") : [];
    assert.equal(denied.includes("Bash"), false, bare);
    assert.deepEqual(plan.limitations, [
      "read-only cannot prevent shell writes while Bash is allowed unrestricted",
    ]);
  }
});

test("workspace-write and unrestricted add no extra deny rules", () => {
  for (const filesystem of ["workspace-write", "unrestricted"] as const) {
    const plan = claudeRuntime.streamPlan({
      prompt: "p",
      sessionId: SESSION_ID,
      capabilities: request({ filesystem }),
    });
    assert.equal(plan.args.includes("--disallowedTools"), false);
    assert.deepEqual(plan.limitations, []);
  }
});

test("mcpServers materializes mcp.json and passes --strict-mcp-config, even when empty", () => {
  const servers = { docs: { command: "docs-mcp", args: ["--stdio"] } };
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({ mcpServers: servers }),
  });
  assert.equal(plan.files?.length, 1);
  assert.equal(plan.files?.[0].path, "/inv/mcp.json");
  assert.deepEqual(JSON.parse(plan.files![0].contents), { mcpServers: servers });
  const mi = plan.args.indexOf("--mcp-config");
  assert.equal(plan.args[mi + 1], "/inv/mcp.json");
  assert.ok(plan.args.includes("--strict-mcp-config"));

  const empty = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({ mcpServers: {} }),
  });
  assert.equal(empty.args.includes("--strict-mcp-config"), true);
  assert.deepEqual(JSON.parse(empty.files![0].contents), { mcpServers: {} });
});

test("hooks materialize settings.json with Stop and PreToolUse(AskUserQuestion) and pass --settings", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request(
      {},
      { hooks: { stop: "argus-signal.mjs stop", gate: "argus-signal.mjs gate" } },
    ),
  });
  const settingsFile = plan.files?.find((f) => f.path === "/inv/settings.json");
  assert.ok(settingsFile);
  const parsed = JSON.parse(settingsFile!.contents);
  assert.deepEqual(parsed, {
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "argus-signal.mjs stop" }] }],
      PreToolUse: [
        {
          matcher: "AskUserQuestion",
          hooks: [{ type: "command", command: "argus-signal.mjs gate" }],
        },
      ],
    },
  });
  const si = plan.args.indexOf("--settings");
  assert.equal(plan.args[si + 1], "/inv/settings.json");
});

test("--add-dir is emitted per additionalDirectories entry, plus artifactDir whenever it's set", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request(
      { additionalDirectories: ["/a", "/b"] },
      { artifactDir: "/artifacts/run-1" },
    ),
  });
  const dirs = plan.args
    .map((a, i) => (a === "--add-dir" ? plan.args[i + 1] : null))
    .filter((v): v is string => v !== null);
  assert.deepEqual(dirs, ["/a", "/b", "/artifacts/run-1"]);
});

test("artifactDir is always added when capabilities is passed, even with no profile fields", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({}, { artifactDir: "/artifacts/run-2" }),
  });
  const ai = plan.args.indexOf("--add-dir");
  assert.equal(plan.args[ai + 1], "/artifacts/run-2");
});

test("no add-dir at all when capabilities is absent, whatever artifactDir would have been", () => {
  const plan = claudeRuntime.streamPlan({ prompt: "p", sessionId: SESSION_ID });
  assert.equal(plan.args.includes("--add-dir"), false);
});

test("settingSources is comma-joined, and an empty array passes an explicit empty-string value", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({ settingSources: ["project", "local"] }),
  });
  const si = plan.args.indexOf("--setting-sources");
  assert.equal(plan.args[si + 1], "project,local");

  const empty = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({ settingSources: [] }),
  });
  const ei = empty.args.indexOf("--setting-sources");
  assert.equal(empty.args[ei + 1], "");
});

test("permissionMode and maxTurns become their own flags", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request({ permissionMode: "plan", maxTurns: 12 }),
  });
  const pi = plan.args.indexOf("--permission-mode");
  assert.equal(plan.args[pi + 1], "plan");
  const mi = plan.args.indexOf("--max-turns");
  assert.equal(plan.args[mi + 1], "12");
});

test("capability args land after model args and before extraArgs, for both plan forms", () => {
  withEnv({ ARGUS_CLAUDE_ARGS: "--extra-flag value" }, () => {
    const plan = claudeRuntime.streamPlan({
      prompt: "p",
      sessionId: SESSION_ID,
      model: "sonnet",
      capabilities: request({ permissionMode: "plan" }),
    });
    const modelIdx = plan.args.indexOf("--model");
    const capIdx = plan.args.indexOf("--permission-mode");
    const extraIdx = plan.args.indexOf("--extra-flag");
    assert.ok(modelIdx < capIdx);
    assert.ok(capIdx < extraIdx);
    assert.deepEqual(plan.args.slice(-2), ["--extra-flag", "value"]);

    const batch = claudeRuntime.batchPlan({
      prompt: "p",
      sessionId: SESSION_ID,
      model: "opus",
      capabilities: request({ permissionMode: "plan" }),
    });
    const bModelIdx = batch.args.indexOf("--model");
    const bCapIdx = batch.args.indexOf("--permission-mode");
    const bExtraIdx = batch.args.indexOf("--extra-flag");
    assert.ok(bModelIdx < bCapIdx);
    assert.ok(bCapIdx < bExtraIdx);
  });
});

test("Claude Code reports no generic limitations for any single supported key", () => {
  const keys: CapabilityProfile[] = [
    { filesystem: "workspace-write" },
    { tools: { allow: ["Read"] } },
    { mcpServers: {} },
    { additionalDirectories: ["/x"] },
    { settingSources: ["project"] },
    { permissionMode: "acceptEdits" },
    { maxTurns: 5 },
  ];
  for (const profile of keys) {
    const plan = claudeRuntime.streamPlan({
      prompt: "p",
      sessionId: SESSION_ID,
      capabilities: request(profile),
    });
    assert.deepEqual(plan.limitations, [], JSON.stringify(profile));
  }
});

// ── Regression: a comma in cwd under read-only reports a limitation ─────────
// Previously a comma in `cwd` (or an additionalDirectories entry) was joined
// straight into the comma-separated --disallowedTools rule list, silently
// splitting the `Edit(//<path>/**)` rule in two and leaving the root writable.

test("read-only with a comma in cwd reports a limitation instead of emitting a split rule", () => {
  const plan = claudeRuntime.streamPlan({
    prompt: "p",
    sessionId: SESSION_ID,
    capabilities: request(
      { filesystem: "read-only" },
      { cwd: "/tmp/a,b", invocationDir: "/i", artifactDir: null },
    ),
  });
  assert.ok(
    plan.limitations?.some((l) => l.includes("containing a comma")),
    JSON.stringify(plan.limitations),
  );
  const di = plan.args.indexOf("--disallowedTools");
  const denied = di > -1 ? plan.args[di + 1].split(",") : [];
  assert.ok(
    !denied.some((d) => d.startsWith("Edit(///tmp/a")),
    `did not expect a split Edit(...) fragment, got ${JSON.stringify(denied)}`,
  );
  // Bash is still denied: the comma only defeats the filesystem deny rule.
  assert.ok(denied.includes("Bash"));
});
