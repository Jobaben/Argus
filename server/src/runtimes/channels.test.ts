import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { RUNTIMES, RUNTIME_IDS } from "./index.js";
import { CHANNEL_ENV_VARS, invocationChannels } from "../harness/channels.js";
import type { CapabilityRequest, ChannelOutcome, InvocationChannel } from "./types.js";
import type { AgentRuntimeId, CapabilityProfile, InvocationChannelKind } from "@argus/contracts";

/**
 * The declared behaviour of every runtime for every Argus-owned channel under
 * every filesystem mode — the matrix docs/HARNESS.md § Argus-owned invocation
 * channels documents, pinned here so it is a tested statement rather than a
 * belief. A runtime that starts behaving differently changes this file.
 */

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

/** The three agent → Argus write channels every step may be offered. */
function channels(): InvocationChannel[] {
  return invocationChannels({
    resultFile: "/home/op/.claude/argus/results/run-1/result.json",
    knowledgeDeltaFile: "/home/op/.claude/argus/knowledge-deltas/run-1/delta.json",
    artifactDir: "/home/op/.claude/argus/artifacts/inst/phase",
    memoryDir: null,
    phaseDef: {},
  });
}

function plan(runtime: AgentRuntimeId, profile: CapabilityProfile) {
  const request: CapabilityRequest = {
    profile,
    invocationDir: "/inv",
    cwd: "/work/repo",
    channels: channels(),
  };
  return RUNTIMES[runtime].streamPlan({ prompt: "p", sessionId: "s", capabilities: request });
}

function statuses(outcomes: ChannelOutcome[] | undefined) {
  return Object.fromEntries((outcomes ?? []).map((o) => [o.channel.kind, o.status])) as Record<
    InvocationChannelKind,
    ChannelOutcome["status"]
  >;
}

const ALL_GRANTED = {
  result: "granted",
  "knowledge-delta": "granted",
  "artifact-dir": "granted",
};
const WRITES_UNAVAILABLE = {
  result: "unavailable",
  "knowledge-delta": "unavailable",
  "artifact-dir": "unavailable",
};

const MODES = ["read-only", "workspace-write", "unrestricted"] as const;

// ── The matrix ──────────────────────────────────────────────────────────────

test("every runtime answers for every channel it is handed, in order", () => {
  for (const id of RUNTIME_IDS) {
    for (const filesystem of MODES) {
      const p = plan(id, { filesystem });
      assert.deepEqual(
        p.channels?.map((o) => o.channel.kind),
        ["result", "knowledge-delta", "artifact-dir"],
        `${id} under ${filesystem}`,
      );
      for (const o of p.channels ?? []) {
        if (o.status === "unavailable") {
          assert.match(o.reason ?? "", /\(ARGUS_[A-Z_]+\)$/, `${id}: a reason names the variable`);
        } else {
          assert.equal(o.reason, undefined);
        }
      }
    }
  }
});

test("CHANNEL_ENV_VARS names every channel's variable, in the list's own order", () => {
  const all = invocationChannels({
    resultFile: "/r/result.json",
    knowledgeDeltaFile: "/d/delta.json",
    knowledgeContextFile: "/c/context.json",
    ruleVerificationFile: "/v/verification.json",
    changeRequestFile: "/q/request.json",
    changeProposalFile: "/p/proposal.json",
    changeContextFile: "/x/context.json",
    implementationScopeFile: "/s/scope.json",
    remediationContextFile: "/m/remediation.json",
    acceptanceVerificationFile: "/a/acceptance.json",
    revisionNotesFile: "/n/revision-notes.md",
    childrenFile: "/k/children-manifest.json",
    childArtifacts: [{ dir: "/kids/c1", instanceId: "c1", key: "a" }],
    artifactDir: "/art",
    memoryDir: "/mem",
    phaseDef: {},
  });
  // A child's artifact folder is named inside the children manifest, so it
  // shares ARGUS_CHILDREN_FILE, right after the manifest's own channel.
  assert.deepEqual([...new Set(all.map((c) => c.envVar))], [...CHANNEL_ENV_VARS]);
});

test("the revision-notes file is an optional read channel in its own folder", () => {
  const [notes] = invocationChannels({
    resultFile: null,
    knowledgeDeltaFile: null,
    revisionNotesFile: "/n/revision-notes.md",
    artifactDir: null,
    memoryDir: null,
    phaseDef: {},
  });
  assert.deepEqual(
    {
      kind: notes.kind,
      envVar: notes.envVar,
      access: notes.access,
      required: notes.required,
      dir: notes.dir,
    },
    {
      kind: "revision-notes",
      envVar: "ARGUS_REVISION_NOTES_FILE",
      access: "read",
      required: false,
      dir: "/n",
    },
  );
});

test("Claude Code: --add-dir admits every channel under every filesystem mode", () => {
  for (const filesystem of MODES) {
    const p = plan("claude", { filesystem });
    assert.deepEqual(statuses(p.channels), ALL_GRANTED, filesystem);
    const added = p.args.filter((_, i) => p.args[i - 1] === "--add-dir");
    assert.deepEqual(added, [
      "/home/op/.claude/argus/results/run-1",
      "/home/op/.claude/argus/knowledge-deltas/run-1",
      "/home/op/.claude/argus/artifacts/inst/phase",
    ]);
  }
});

test("Claude Code: a write channel under a read-only-denied root is unavailable, deterministically from the paths", () => {
  // The working directory is the operator's home: Argus's data directory sits
  // beneath it, and the Edit(//home/op/**) deny rule would refuse the writes.
  const request: CapabilityRequest = {
    profile: { filesystem: "read-only" },
    invocationDir: "/inv",
    cwd: "/home/op",
    channels: channels(),
  };
  const p = RUNTIMES.claude.streamPlan({ prompt: "p", sessionId: "s", capabilities: request });
  assert.deepEqual(statuses(p.channels), WRITES_UNAVAILABLE);
  assert.equal(
    p.channels?.[0].reason,
    "Claude Code read-only denies edits under /home/op, which contains the result file (ARGUS_RESULT_FILE)",
  );
  // Under workspace-write the same layout is fine: nothing is denied.
  const rw = RUNTIMES.claude.streamPlan({
    prompt: "p",
    sessionId: "s",
    capabilities: { ...request, profile: { filesystem: "workspace-write" } },
  });
  assert.deepEqual(statuses(rw.channels), ALL_GRANTED);
});

test("Codex: workspace-write names every write channel in writable_roots; read-only cannot; full access needs nothing", () => {
  const rw = plan("codex", { filesystem: "workspace-write" });
  assert.deepEqual(statuses(rw.channels), ALL_GRANTED);
  const roots = rw.args[rw.args.indexOf("-c") + 1];
  assert.equal(
    roots,
    'sandbox_workspace_write.writable_roots=["/home/op/.claude/argus/results/run-1","/home/op/.claude/argus/knowledge-deltas/run-1","/home/op/.claude/argus/artifacts/inst/phase"]',
  );

  const ro = plan("codex", { filesystem: "read-only" });
  assert.deepEqual(statuses(ro.channels), WRITES_UNAVAILABLE);
  assert.equal(
    ro.args.some((arg) => arg.startsWith("sandbox_workspace_write.writable_roots=")),
    false,
  );
  assert.deepEqual(
    ro.channels?.map((o) => o.reason),
    [
      "Codex read-only sandbox prevents writing the result file (ARGUS_RESULT_FILE)",
      "Codex read-only sandbox prevents writing the KnowledgeDelta file (ARGUS_KNOWLEDGE_DELTA_FILE)",
      "Codex read-only sandbox prevents writing the artifact directory (ARGUS_ARTIFACT_DIR)",
    ],
  );
  // Channel availability is not a profile limitation: the profile itself is
  // fully enforceable, and the engine decides what an unreachable channel means.
  assert.deepEqual(ro.limitations, []);

  const full = plan("codex", { filesystem: "unrestricted" });
  assert.deepEqual(statuses(full.channels), ALL_GRANTED);
  assert.equal(full.args.includes("-c"), false);
});

test("Codex: with no filesystem in the profile, the operator's ARGUS_CODEX_SANDBOX decides", () => {
  withEnv({ ARGUS_CODEX_SANDBOX: "read-only" }, () => {
    assert.deepEqual(statuses(plan("codex", {}).channels), WRITES_UNAVAILABLE);
  });
  withEnv({ ARGUS_CODEX_SANDBOX: undefined }, () => {
    const p = plan("codex", {});
    assert.deepEqual(statuses(p.channels), ALL_GRANTED);
    assert.ok(p.args[p.args.indexOf("-c") + 1].includes("knowledge-deltas/run-1"));
  });
  withEnv({ ARGUS_CODEX_SANDBOX: "danger-full-access" }, () => {
    assert.deepEqual(statuses(plan("codex", {}).channels), ALL_GRANTED);
  });
});

test("Codex: a read channel is reachable under every sandbox, read-only included", () => {
  const readChannel: InvocationChannel = {
    kind: "artifact-dir",
    envVar: "ARGUS_CONTEXT_DIR",
    path: "/home/op/.claude/argus/context/run-1",
    dir: "/home/op/.claude/argus/context/run-1",
    access: "read",
    required: true,
    label: "context directory",
  };
  const p = RUNTIMES.codex.streamPlan({
    prompt: "p",
    capabilities: {
      profile: { filesystem: "read-only" },
      invocationDir: "/inv",
      cwd: "/work",
      channels: [readChannel],
    },
  });
  assert.equal(p.channels?.[0].status, "granted");
  assert.equal(
    p.args.some((arg) => arg.startsWith("sandbox_workspace_write.writable_roots=")),
    false,
  );
});

test("OpenCode: unsandboxed, so every channel is reachable — while the profile itself stays unenforceable", () => {
  for (const filesystem of MODES) {
    const p = plan("opencode", { filesystem });
    assert.deepEqual(statuses(p.channels), ALL_GRANTED, filesystem);
    assert.deepEqual(p.limitations, [`OpenCode cannot enforce "filesystem" for this invocation`]);
    // Nothing on argv changes: there is nothing OpenCode can be told about a path.
    assert.deepEqual(p.args, RUNTIMES.opencode.streamPlan({ prompt: "p" }).args);
  }
});

test("Qwen Code: reachable when unsandboxed; every channel unavailable under the CLI's container sandbox", () => {
  withEnv({ ARGUS_QWEN_ARGS: undefined }, () => {
    for (const filesystem of MODES) {
      const p = plan("qwen", { filesystem });
      assert.deepEqual(statuses(p.channels), ALL_GRANTED, filesystem);
      assert.deepEqual(p.limitations, [
        `Qwen Code cannot enforce "filesystem" for this invocation`,
      ]);
    }
  });
  for (const flag of ["--sandbox", "-s", "--sandbox=docker", "--yolo --sandbox"]) {
    withEnv({ ARGUS_QWEN_ARGS: flag }, () => {
      const p = plan("qwen", { filesystem: "workspace-write" });
      assert.deepEqual(statuses(p.channels), WRITES_UNAVAILABLE, flag);
      assert.equal(
        p.channels?.[1].reason,
        "Qwen Code container sandbox (--sandbox in ARGUS_QWEN_ARGS) does not mount the KnowledgeDelta file (ARGUS_KNOWLEDGE_DELTA_FILE)",
      );
    });
  }
  // An unrelated flag is not a sandbox.
  withEnv({ ARGUS_QWEN_ARGS: "--some-flag -x" }, () => {
    assert.deepEqual(statuses(plan("qwen", {}).channels), ALL_GRANTED);
  });
});

test("no channels: every runtime returns an empty verdict list and its argv is unchanged by the channel model", () => {
  for (const id of RUNTIME_IDS) {
    const request: CapabilityRequest = {
      profile: {},
      invocationDir: "/inv",
      cwd: "/work",
      channels: [],
    };
    const p = RUNTIMES[id].streamPlan({ prompt: "p", sessionId: "s", capabilities: request });
    assert.deepEqual(p.channels, [], id);
  }
});

test("without capabilities no runtime reports on channels at all: the legacy plan shape is untouched", () => {
  for (const id of RUNTIME_IDS) {
    const p = RUNTIMES[id].streamPlan({ prompt: "p", sessionId: "s" });
    assert.equal("channels" in p, false, id);
    assert.equal("limitations" in p, false, id);
  }
});

// ── The read channel (Phase 4: KnowledgeContext) ────────────────────────────
//
// Argus → agent. Every runtime must make the file *readable*; the ones that
// can are also asked not to make it *writable*. Granting is about reads, so a
// Codex read-only sandbox — which refuses every write channel — grants it.

const CONTEXT_FILE = "/home/op/.claude/argus/invocations/run-1/knowledge-context.json";

function withContext(): InvocationChannel[] {
  return invocationChannels({
    resultFile: null,
    knowledgeDeltaFile: "/home/op/.claude/argus/knowledge-deltas/run-1/delta.json",
    knowledgeContextFile: CONTEXT_FILE,
    artifactDir: null,
    memoryDir: null,
    phaseDef: {},
  });
}

function planWithContext(runtime: AgentRuntimeId, profile: CapabilityProfile, cwd = "/work/repo") {
  return RUNTIMES[runtime].streamPlan({
    prompt: "p",
    sessionId: "s",
    capabilities: { profile, invocationDir: "/inv", cwd, channels: withContext() },
  });
}

test("read channel: the KnowledgeContext channel is read access, required, and ordered after the delta file", () => {
  const [delta, context] = withContext();
  assert.equal(delta.kind, "knowledge-delta");
  assert.deepEqual(context, {
    kind: "knowledge-context",
    envVar: "ARGUS_KNOWLEDGE_CONTEXT_FILE",
    path: CONTEXT_FILE,
    dir: "/home/op/.claude/argus/invocations/run-1",
    access: "read",
    required: true,
    label: "KnowledgeContext file",
  });
  // Absent when the step has no context: the legacy list is byte-identical.
  assert.deepEqual(
    channels().map((c) => c.kind),
    ["result", "knowledge-delta", "artifact-dir"],
  );
});

test("Claude Code: the context directory is admitted with --add-dir and denied for edits under every filesystem mode", () => {
  for (const filesystem of MODES) {
    const p = planWithContext("claude", { filesystem });
    assert.equal(statuses(p.channels)["knowledge-context"], "granted", filesystem);
    assert.equal(statuses(p.channels)["knowledge-delta"], "granted", filesystem);
    const added = p.args.filter((_, i) => p.args[i - 1] === "--add-dir");
    assert.ok(added.includes("/home/op/.claude/argus/invocations/run-1"), filesystem);
    const di = p.args.indexOf("--disallowedTools");
    const denied = di > -1 ? p.args[di + 1].split(",") : [];
    assert.ok(
      denied.includes("Edit(//home/op/.claude/argus/invocations/run-1/**)"),
      `${filesystem}: the context directory is denied for edits (${denied.join(",")})`,
    );
    // The delta directory stays writable: only the read channel is denied.
    assert.equal(
      denied.some((d) => d.includes("knowledge-deltas")),
      false,
      filesystem,
    );
    assert.deepEqual(p.limitations, []);
  }
});

test("Claude Code: a read channel already under a read-only-denied root needs no second deny rule and stays granted", () => {
  const p = planWithContext("claude", { filesystem: "read-only" }, "/home/op");
  const s = statuses(p.channels);
  assert.equal(s["knowledge-context"], "granted");
  assert.equal(s["knowledge-delta"], "unavailable");
  const denied = p.args[p.args.indexOf("--disallowedTools") + 1].split(",");
  assert.deepEqual(denied, ["Edit(//home/op/**)", "Bash", "PowerShell"]);
});

test("Claude Code: a context path the rule grammar cannot express is readable but reported as a limitation", () => {
  const channel: InvocationChannel = {
    kind: "knowledge-context",
    envVar: "ARGUS_KNOWLEDGE_CONTEXT_FILE",
    path: "/odd,dir/run-1/knowledge-context.json",
    dir: "/odd,dir/run-1",
    access: "read",
    required: true,
    label: "KnowledgeContext file",
  };
  const p = RUNTIMES.claude.streamPlan({
    prompt: "p",
    capabilities: {
      profile: { filesystem: "workspace-write" },
      invocationDir: "/inv",
      cwd: "/work",
      channels: [channel],
    },
  });
  assert.equal(p.channels?.[0].status, "granted");
  assert.deepEqual(p.limitations, [
    "Claude Code cannot deny edits to the KnowledgeContext file (ARGUS_KNOWLEDGE_CONTEXT_FILE): its path contains a comma or newline, or is a UNC share",
  ]);
});

test("Codex: the context file is readable under every sandbox and never named in writable_roots", () => {
  for (const filesystem of MODES) {
    const p = planWithContext("codex", { filesystem });
    assert.equal(statuses(p.channels)["knowledge-context"], "granted", filesystem);
    const ci = p.args.indexOf("-c");
    const roots = ci > -1 ? p.args[ci + 1] : "";
    assert.equal(roots.includes("invocations/run-1"), false, filesystem);
    if (filesystem === "workspace-write") assert.ok(roots.includes("knowledge-deltas/run-1"));
  }
  assert.equal(
    statuses(planWithContext("codex", { filesystem: "read-only" }).channels)["knowledge-delta"],
    "unavailable",
  );
});

test("OpenCode: the context file is reachable (unsandboxed); the profile itself stays unenforceable", () => {
  for (const filesystem of MODES) {
    const p = planWithContext("opencode", { filesystem });
    assert.equal(statuses(p.channels)["knowledge-context"], "granted", filesystem);
    assert.deepEqual(p.limitations, [`OpenCode cannot enforce "filesystem" for this invocation`]);
  }
});

test("Qwen Code: the context file is reachable unsandboxed and unavailable inside the container sandbox, like every channel", () => {
  withEnv({ ARGUS_QWEN_ARGS: undefined }, () => {
    assert.equal(statuses(planWithContext("qwen", {}).channels)["knowledge-context"], "granted");
  });
  withEnv({ ARGUS_QWEN_ARGS: "--sandbox" }, () => {
    const p = planWithContext("qwen", {});
    const context = p.channels?.find((o) => o.channel.kind === "knowledge-context");
    assert.equal(context?.status, "unavailable");
    assert.equal(
      context?.reason,
      "Qwen Code container sandbox (--sandbox in ARGUS_QWEN_ARGS) does not mount the KnowledgeContext file (ARGUS_KNOWLEDGE_CONTEXT_FILE)",
    );
  });
});

// ── The children channels (DL-A2b) ──────────────────────────────────────────
//
// A phase that declares `childrenContext` reads a manifest of an earlier spawn
// phase's children (required: it is the phase's input) and may open each
// child's artifact folder (optional: evidence). All of them are Argus → agent.

const MANIFEST = path.join("/inv", "run-1", "children", "children-manifest.json");

test("the children manifest is a required read channel in its own folder", () => {
  const [manifest] = invocationChannels({
    resultFile: null,
    knowledgeDeltaFile: null,
    childrenFile: MANIFEST,
    artifactDir: null,
    memoryDir: null,
    phaseDef: {},
  });
  assert.deepEqual(manifest, {
    kind: "children-manifest",
    envVar: "ARGUS_CHILDREN_FILE",
    path: MANIFEST,
    dir: path.dirname(MANIFEST),
    access: "read",
    required: true,
    label: "children manifest",
  });
});

test("each child's artifact folder is an optional read channel, after the manifest, in input order", () => {
  const list = invocationChannels({
    resultFile: null,
    knowledgeDeltaFile: null,
    revisionNotesFile: path.join("/inv", "run-1", "notes", "revision-notes.md"),
    childrenFile: MANIFEST,
    childArtifacts: [
      { dir: path.join("/kids", "c1"), instanceId: "c1", key: "a" },
      { dir: path.join("/kids", "c2"), instanceId: "c2", key: "b" },
    ],
    artifactDir: "/art",
    memoryDir: "/mem",
    phaseDef: {},
  });
  assert.deepEqual(
    list.map((c) => c.kind),
    [
      "revision-notes",
      "children-manifest",
      "child-artifacts",
      "child-artifacts",
      "artifact-dir",
      "memory-dir",
    ],
    "the fixed order",
  );
  const [first, second] = list.filter((c) => c.kind === "child-artifacts");
  assert.deepEqual(
    first,
    {
      kind: "child-artifacts",
      envVar: "ARGUS_CHILDREN_FILE",
      path: path.join("/kids", "c1"),
      dir: path.join("/kids", "c1"),
      access: "read",
      required: false,
      label: 'artifact folder of child c1 (task "a")',
    },
    "a folder is granted as itself, never its parent",
  );
  assert.equal(second.path, path.join("/kids", "c2"), "the second child follows the first");
  // Nothing at all without a children context: the legacy list is unchanged.
  assert.deepEqual(
    channels().map((c) => c.kind),
    ["result", "knowledge-delta", "artifact-dir"],
  );
});

/** Two children's folders, Windows-shaped: `toClaudeRulePath` reads the
 *  path's own shape, so this holds on any host. */
const WIN_CHILDREN = [
  { dir: "C:\\Users\\op\\.claude-argus\\artifacts\\child-1", instanceId: "child-1", key: "a" },
  { dir: "C:\\Users\\op\\.claude-argus\\artifacts\\child-2", instanceId: "child-2", key: "b" },
];

function planChildren(profile: CapabilityProfile, cwd: string, kids = WIN_CHILDREN) {
  return RUNTIMES.claude.streamPlan({
    prompt: "p",
    sessionId: "s",
    capabilities: {
      profile,
      invocationDir: "C:\\inv",
      cwd,
      channels: invocationChannels({
        resultFile: null,
        knowledgeDeltaFile: null,
        childArtifacts: kids,
        artifactDir: null,
        memoryDir: null,
        phaseDef: {},
      }),
    },
  });
}

const flagList = (args: string[], flag: string): string[] => {
  const i = args.indexOf(flag);
  return i > -1 ? args[i + 1].split(",") : [];
};

test("Claude Code: Windows child folders are admitted with --add-dir and denied for edits by drive-letter rule", () => {
  const p = planChildren({ filesystem: "workspace-write" }, "C:\\GIT\\repo");
  assert.deepEqual(
    p.channels?.map((o) => o.status),
    ["granted", "granted"],
    "both folders are reachable",
  );
  const added = p.args.filter((_, i) => p.args[i - 1] === "--add-dir");
  assert.deepEqual(
    added,
    WIN_CHILDREN.map((c) => c.dir),
    "each folder is handed over verbatim",
  );
  const denied = flagList(p.args, "--disallowedTools");
  assert.ok(
    denied.includes("Edit(//c/Users/op/.claude-argus/artifacts/child-1/**)"),
    `child-1 is denied for edits (${denied.join(",")})`,
  );
  assert.ok(
    denied.includes("Edit(//c/Users/op/.claude-argus/artifacts/child-2/**)"),
    `child-2 is denied for edits (${denied.join(",")})`,
  );
  assert.equal(
    flagList(p.args, "--allowedTools").some((rule) => rule.includes("artifacts/child-")),
    false,
    "a read channel is never allowed for edits",
  );
  assert.deepEqual(p.limitations, [], "nothing it cannot express");
});

test("Claude Code: a child folder under a read-only-denied root needs no second deny rule, whatever its case", () => {
  const kids = [
    { dir: "c:\\users\\OP\\.claude-argus\\artifacts\\child-1", instanceId: "child-1", key: "a" },
  ];
  const p = planChildren({ filesystem: "read-only" }, "C:\\Users\\op", kids);
  assert.equal(p.channels?.[0].status, "granted", "still readable");
  assert.deepEqual(
    flagList(p.args, "--disallowedTools"),
    ["Edit(//c/Users/op/**)", "Bash", "PowerShell"],
    "the root's own deny rule already covers the folder",
  );
});

test("Codex: the manifest and every child folder are readable under every sandbox and never writable roots", () => {
  const list = invocationChannels({
    resultFile: null,
    knowledgeDeltaFile: "/home/op/.claude/argus/knowledge-deltas/run-1/delta.json",
    childrenFile: "/home/op/.claude/argus/invocations/run-1/children/children-manifest.json",
    childArtifacts: [
      { dir: "/home/op/.claude-argus/artifacts/child-1", instanceId: "child-1", key: "a" },
      { dir: "/home/op/.claude-argus/artifacts/child-2", instanceId: "child-2", key: "b" },
    ],
    artifactDir: null,
    memoryDir: null,
    phaseDef: {},
  });
  for (const filesystem of MODES) {
    const p = RUNTIMES.codex.streamPlan({
      prompt: "p",
      capabilities: {
        profile: { filesystem },
        invocationDir: "/inv",
        cwd: "/work",
        channels: list,
      },
    });
    const children = (p.channels ?? []).filter((o) => o.channel.access === "read");
    assert.deepEqual(
      children.map((o) => [o.channel.kind, o.status]),
      [
        ["children-manifest", "granted"],
        ["child-artifacts", "granted"],
        ["child-artifacts", "granted"],
      ],
      filesystem,
    );
    const ci = p.args.indexOf("-c");
    const roots = ci > -1 ? p.args[ci + 1] : "";
    assert.equal(roots.includes("/children"), false, `${filesystem}: the manifest is not writable`);
    assert.equal(roots.includes("artifacts/child-"), false, `${filesystem}: nor any child folder`);
    if (filesystem === "workspace-write") {
      assert.ok(roots.includes("knowledge-deltas/run-1"), "the write channel still is");
    }
  }
});

test("Qwen Code: inside the container sandbox every children channel is unavailable, naming ARGUS_CHILDREN_FILE", () => {
  withEnv({ ARGUS_QWEN_ARGS: "--sandbox" }, () => {
    const p = RUNTIMES.qwen.streamPlan({
      prompt: "p",
      capabilities: {
        profile: {},
        invocationDir: "/inv",
        cwd: "/work",
        channels: invocationChannels({
          resultFile: null,
          knowledgeDeltaFile: null,
          childrenFile: MANIFEST,
          childArtifacts: [{ dir: path.join("/kids", "c1"), instanceId: "c1", key: "a" }],
          artifactDir: null,
          memoryDir: null,
          phaseDef: {},
        }),
      },
    });
    assert.deepEqual(
      p.channels?.map((o) => o.status),
      ["unavailable", "unavailable"],
    );
    for (const o of p.channels ?? []) {
      assert.match(o.reason ?? "", /\(ARGUS_CHILDREN_FILE\)$/, o.channel.label);
    }
    assert.equal(
      p.channels?.[1].reason,
      'Qwen Code container sandbox (--sandbox in ARGUS_QWEN_ARGS) does not mount the artifact folder of child c1 (task "a") (ARGUS_CHILDREN_FILE)',
    );
  });
});
