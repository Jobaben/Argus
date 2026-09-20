import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prepareInvocation,
  resolveCapabilities,
  resolveTimeoutSeconds,
  settleChannels,
} from "./invocation.js";
import { invocationChannels } from "./channels.js";
import { codexRuntime } from "../runtimes/index.js";
import type { InvocationInputs } from "./invocation.js";
import type { InvocationChannel } from "../runtimes/types.js";
import type { Run } from "../sources/scheduleTypes.js";
import type {
  InvocationChannelRecord,
  PhaseDef,
  PhaseStep,
  PipelineDefinition,
} from "../sources/pipelineTypes.js";

/** The result channel alone, as the engine would build it. */
function channelsOf(resultFile: string): InvocationChannel[] {
  return invocationChannels({
    resultFile,
    knowledgeDeltaFile: null,
    artifactDir: null,
    memoryDir: null,
    phaseDef: {},
  });
}

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    scheduleId: "pipeline:p1",
    scheduleName: "P1 · Only",
    prompt: "do the work",
    cwd: "/repo",
    status: "running",
    trigger: "scheduled",
    queuedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    durationMs: null,
    pid: null,
    exitCode: null,
    sessionId: "sess-1",
    runtime: "claude",
    project: null,
    resultSummary: null,
    error: null,
    instanceId: "inst-1",
    phaseId: "only",
    deadlineAt: null,
    ...over,
  };
}

function makeDef(over: Partial<PipelineDefinition> = {}): PipelineDefinition {
  return {
    id: "p1",
    name: "P1",
    phases: [],
    trigger: null,
    enabled: true,
    overlapPolicy: "skip",
    lastStartedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makePhase(over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    id: "only",
    name: "Only",
    cwd: "/repo",
    steps: [],
    gated: false,
    ...over,
  };
}

function makeStep(over: Partial<PhaseStep> = {}): PhaseStep {
  return { name: "s", prompt: "p", ...over };
}

function baseInputs(over: Partial<InvocationInputs> = {}): InvocationInputs {
  return {
    run: makeRun(),
    def: makeDef(),
    phaseDef: makePhase(),
    stepDef: makeStep(),
    instanceId: "inst-1",
    attempt: 0,
    systemPrompt: "SYSTEM PROMPT",
    argusEnv: { ARGUS_SIGNAL_TOKEN: "tok", ARGUS_ARTIFACT_DIR: "/art" },
    invocationDir: "/inv",
    artifactDir: "/art",
    resultFile: null,
    timeoutSeconds: null,
    gitHead: null,
    parentEnv: { PATH: "/bin", HOME: "/h", ARGUS_TOKEN: "secret", MY_SECRET: "x" },
    now: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

// ── resolveCapabilities ──────────────────────────────────────────────────────

test("resolveCapabilities: absent everywhere is undefined", () => {
  assert.equal(resolveCapabilities(makeDef(), makePhase(), makeStep()), undefined);
});

test("resolveCapabilities: a lone pipeline profile is used as-is", () => {
  const def = makeDef({ capabilities: { filesystem: "read-only" } });
  assert.deepEqual(resolveCapabilities(def, makePhase(), makeStep()), { filesystem: "read-only" });
});

test("resolveCapabilities: phase overrides the pipeline on a shared key", () => {
  const def = makeDef({ capabilities: { filesystem: "read-only" } });
  const phase = makePhase({ capabilities: { filesystem: "workspace-write" } });
  assert.deepEqual(resolveCapabilities(def, phase, makeStep()), { filesystem: "workspace-write" });
});

test("resolveCapabilities: distinct keys merge across all three layers, narrowest wins on overlap", () => {
  const def = makeDef({ capabilities: { env: { inherit: "minimal" }, maxTurns: 3 } });
  const phase = makePhase({ capabilities: { filesystem: "read-only" } });
  const step = makeStep({ capabilities: { filesystem: "workspace-write" } });
  assert.deepEqual(resolveCapabilities(def, phase, step), {
    env: { inherit: "minimal" },
    maxTurns: 3,
    filesystem: "workspace-write",
  });
});

test("resolveCapabilities: an empty profile at any layer still counts as declared", () => {
  const def = makeDef({ capabilities: {} });
  assert.deepEqual(resolveCapabilities(def, makePhase(), makeStep()), {});
});

// ── resolveTimeoutSeconds ────────────────────────────────────────────────────

test("resolveTimeoutSeconds: step wins over phase", () => {
  assert.equal(
    resolveTimeoutSeconds(makePhase({ timeoutSeconds: 60 }), makeStep({ timeoutSeconds: 10 })),
    10,
  );
});

test("resolveTimeoutSeconds: falls back to the phase's limit", () => {
  assert.equal(resolveTimeoutSeconds(makePhase({ timeoutSeconds: 60 }), makeStep()), 60);
});

test("resolveTimeoutSeconds: null when neither level sets one", () => {
  assert.equal(resolveTimeoutSeconds(makePhase(), makeStep()), null);
});

// ── prepareInvocation ────────────────────────────────────────────────────────

test("prepareInvocation: envNames are sorted and ARGUS_TOKEN never reaches the child", () => {
  const prepared = prepareInvocation(baseInputs());
  assert.deepEqual(prepared.record.envNames, [...prepared.record.envNames].sort());
  assert.equal(prepared.record.envNames.includes("ARGUS_TOKEN"), false);
  assert.ok(prepared.record.envStripped.includes("ARGUS_TOKEN"));
  assert.equal(prepared.env.ARGUS_TOKEN, undefined);
  assert.equal(prepared.env.PATH, "/bin"); // ordinary vars still pass under the default policy
});

test("prepareInvocation: deadlineAt is now + timeoutSeconds", () => {
  const now = new Date("2026-03-01T10:00:00.000Z");
  const prepared = prepareInvocation(baseInputs({ timeoutSeconds: 30, now }));
  assert.equal(prepared.record.deadlineAt, new Date(now.getTime() + 30_000).toISOString());
});

test("prepareInvocation: deadlineAt is null without a timeout", () => {
  const prepared = prepareInvocation(baseInputs({ timeoutSeconds: null }));
  assert.equal(prepared.record.deadlineAt, null);
});

test("prepareInvocation: blocking carries the limitations only under strict enforcement", () => {
  // OpenCode enforces none of the profile, so any key set produces a limitation.
  const run = makeRun({ runtime: "opencode" });

  const strict = prepareInvocation(
    baseInputs({ run, phaseDef: makePhase({ capabilities: { tools: { allow: ["Read"] } } }) }),
  );
  assert.ok(strict.record.limitations.length > 0);
  assert.deepEqual(strict.blocking, strict.record.limitations);

  const bestEffort = prepareInvocation(
    baseInputs({
      run,
      phaseDef: makePhase({
        capabilities: { tools: { allow: ["Read"] }, enforcement: "best-effort" },
      }),
    }),
  );
  assert.ok(bestEffort.record.limitations.length > 0);
  assert.deepEqual(bestEffort.blocking, []);
});

test("prepareInvocation: a legacy invocation with no capability profile gets none, and no --settings", () => {
  const legacy = prepareInvocation(baseInputs());
  assert.equal(legacy.record.capabilities, null);
  assert.equal(legacy.plan.args.includes("--settings"), false);
});

test("prepareInvocation: capabilities (and hooks) reach the runtime only when a profile is declared", () => {
  const withProfile = prepareInvocation(baseInputs({ phaseDef: makePhase({ capabilities: {} }) }));
  assert.deepEqual(withProfile.record.capabilities, {});
  assert.ok(withProfile.plan.args.includes("--settings"));
});

// ── prepareInvocation: Argus-owned channels ──────────────────────────────────
//
// The channel model (harness/channels.ts, docs/HARNESS.md § Argus-owned
// invocation channels): one list of the paths the agent must reach, mapped by
// the runtime, with required-vs-optional decided by what the phase depends on.

const RESULT = "/home/op/.claude/argus/results/run-1/result.json";
const DELTA = "/home/op/.claude/argus/knowledge-deltas/run-1/delta.json";

const channelStatus = (
  prepared: ReturnType<typeof prepareInvocation>,
  kind: InvocationChannelRecord["kind"],
) => prepared.record.channels?.find((c) => c.kind === kind);

test("channels: a result-publishing step under Claude read-only can still write its result file", () => {
  const prepared = prepareInvocation(
    baseInputs({
      resultFile: RESULT,
      knowledgeDeltaFile: DELTA,
      phaseDef: makePhase({
        capabilities: { filesystem: "read-only", tools: { allow: ["Read"] } },
        result: { artifact: "decision", schema: { type: "object" } },
      }),
    }),
  );
  assert.deepEqual(prepared.blocking, []);
  assert.deepEqual(prepared.record.limitations, []);
  const added = prepared.plan.args.filter((_, i) => prepared.plan.args[i - 1] === "--add-dir");
  assert.ok(
    added.includes("/home/op/.claude/argus/results/run-1"),
    "the result directory is admitted",
  );
  assert.ok(added.includes("/home/op/.claude/argus/knowledge-deltas/run-1"));
  assert.ok(added.includes("/art"));
  // The repository itself stays denied: the channel does not widen the profile.
  const denied = prepared.plan.args[prepared.plan.args.indexOf("--disallowedTools") + 1];
  assert.ok(denied.includes("Edit(///repo/**)"));
  assert.deepEqual(channelStatus(prepared, "result"), {
    kind: "result",
    envVar: "ARGUS_RESULT_FILE",
    path: RESULT,
    access: "write",
    required: true,
    status: "granted",
  });
});

test("channels: Codex workspace-write can write the KnowledgeDelta file while the repository stays sandboxed", () => {
  const prepared = prepareInvocation(
    baseInputs({
      run: makeRun({ runtime: "codex" }),
      knowledgeDeltaFile: DELTA,
      phaseDef: makePhase({ capabilities: { filesystem: "workspace-write" } }),
    }),
  );
  assert.deepEqual(prepared.blocking, []);
  const roots = prepared.plan.args[prepared.plan.args.indexOf("-c") + 1];
  assert.equal(
    roots,
    'sandbox_workspace_write.writable_roots=["/home/op/.claude/argus/knowledge-deltas/run-1","/art"]',
  );
  assert.equal(channelStatus(prepared, "knowledge-delta")?.status, "granted");
  assert.equal(channelStatus(prepared, "knowledge-delta")?.required, false);
});

test("channels: strict enforcement refuses a runtime that cannot deliver a required channel, before any launch", () => {
  const prepared = prepareInvocation(
    baseInputs({
      run: makeRun({ runtime: "codex" }),
      resultFile: RESULT,
      knowledgeDeltaFile: DELTA,
      phaseDef: makePhase({
        capabilities: { filesystem: "read-only" },
        result: { artifact: "decision", schema: { type: "object" } },
      }),
    }),
  );
  // Deterministic: the one required channel blocks; the optional ones are
  // recorded beside it but do not.
  assert.deepEqual(prepared.blocking, [
    "Codex read-only sandbox prevents writing the result file (ARGUS_RESULT_FILE)",
  ]);
  assert.deepEqual(prepared.record.limitations, [
    "Codex read-only sandbox prevents writing the result file (ARGUS_RESULT_FILE)",
    "Codex read-only sandbox prevents writing the KnowledgeDelta file (ARGUS_KNOWLEDGE_DELTA_FILE)",
    "Codex read-only sandbox prevents writing the artifact directory (ARGUS_ARTIFACT_DIR)",
  ]);
  assert.equal(channelStatus(prepared, "result")?.status, "unavailable");
  assert.equal(channelStatus(prepared, "artifact-dir")?.required, false);
  // Same inputs, same verdict: nothing here depends on the environment.
  assert.deepEqual(
    prepareInvocation(
      baseInputs({
        run: makeRun({ runtime: "codex" }),
        resultFile: RESULT,
        knowledgeDeltaFile: DELTA,
        phaseDef: makePhase({
          capabilities: { filesystem: "read-only" },
          result: { artifact: "decision", schema: { type: "object" } },
        }),
      }),
    ).blocking,
    prepared.blocking,
  );
});

test("channels: best-effort launches the same invocation and records the limitation explicitly", () => {
  const prepared = prepareInvocation(
    baseInputs({
      run: makeRun({ runtime: "codex" }),
      resultFile: RESULT,
      knowledgeDeltaFile: DELTA,
      phaseDef: makePhase({
        capabilities: { filesystem: "read-only", enforcement: "best-effort" },
        result: { artifact: "decision", schema: { type: "object" } },
      }),
    }),
  );
  assert.deepEqual(prepared.blocking, []);
  assert.ok(
    prepared.record.limitations.includes(
      "Codex read-only sandbox prevents writing the result file (ARGUS_RESULT_FILE)",
    ),
  );
  assert.deepEqual(channelStatus(prepared, "result"), {
    kind: "result",
    envVar: "ARGUS_RESULT_FILE",
    path: RESULT,
    access: "write",
    required: true,
    status: "unavailable",
    reason: "Codex read-only sandbox prevents writing the result file (ARGUS_RESULT_FILE)",
  });
});

test("channels: an unwritable optional KnowledgeDelta channel never blocks a strict launch — it is recorded", () => {
  const prepared = prepareInvocation(
    baseInputs({
      run: makeRun({ runtime: "codex" }),
      knowledgeDeltaFile: DELTA,
      phaseDef: makePhase({ capabilities: { filesystem: "read-only" } }),
    }),
  );
  assert.deepEqual(prepared.blocking, []);
  assert.deepEqual(prepared.record.limitations, [
    "Codex read-only sandbox prevents writing the KnowledgeDelta file (ARGUS_KNOWLEDGE_DELTA_FILE)",
    "Codex read-only sandbox prevents writing the artifact directory (ARGUS_ARTIFACT_DIR)",
  ]);
  assert.equal(channelStatus(prepared, "knowledge-delta")?.status, "unavailable");
});

test('channels: knowledgeDelta: "required" makes the delta channel a launch precondition', () => {
  const prepared = prepareInvocation(
    baseInputs({
      run: makeRun({ runtime: "codex" }),
      knowledgeDeltaFile: DELTA,
      phaseDef: makePhase({
        capabilities: { filesystem: "read-only" },
        knowledgeDelta: "required",
      }),
    }),
  );
  assert.deepEqual(prepared.blocking, [
    "Codex read-only sandbox prevents writing the KnowledgeDelta file (ARGUS_KNOWLEDGE_DELTA_FILE)",
  ]);
  assert.equal(channelStatus(prepared, "knowledge-delta")?.required, true);
});

test("channels: the artifact directory is required exactly when the phase declares an artifact check", () => {
  const offered = prepareInvocation(
    baseInputs({
      run: makeRun({ runtime: "codex" }),
      phaseDef: makePhase({ capabilities: { filesystem: "read-only" } }),
    }),
  );
  assert.equal(channelStatus(offered, "artifact-dir")?.required, false);
  assert.deepEqual(offered.blocking, []);

  const used = prepareInvocation(
    baseInputs({
      run: makeRun({ runtime: "codex" }),
      phaseDef: makePhase({
        capabilities: { filesystem: "read-only" },
        checks: [{ kind: "artifact", path: "report.md" }],
      }),
    }),
  );
  assert.equal(channelStatus(used, "artifact-dir")?.required, true);
  assert.deepEqual(used.blocking, [
    "Codex read-only sandbox prevents writing the artifact directory (ARGUS_ARTIFACT_DIR)",
  ]);
});

test("channels: a profile limitation and a required channel gap block together; an optional gap rides along in the record only", () => {
  const prepared = prepareInvocation(
    baseInputs({
      run: makeRun({ runtime: "codex" }),
      resultFile: RESULT,
      knowledgeDeltaFile: DELTA,
      phaseDef: makePhase({
        capabilities: { filesystem: "read-only", maxTurns: 3 },
        result: { artifact: "decision", schema: { type: "object" } },
      }),
    }),
  );
  assert.deepEqual(prepared.blocking, [
    'Codex cannot enforce "maxTurns" for this invocation',
    "Codex read-only sandbox prevents writing the result file (ARGUS_RESULT_FILE)",
  ]);
  assert.equal(prepared.record.limitations.length, 4);
});

test("channels: a legacy invocation (no profile) is byte-identical to the runtime's plain plan and claims nothing about channels", () => {
  const run = makeRun({ runtime: "codex" });
  const prepared = prepareInvocation(baseInputs({ run, knowledgeDeltaFile: DELTA }));
  const plain = codexRuntime.streamPlan({
    prompt: run.prompt,
    sessionId: run.sessionId,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    systemPrompt: "SYSTEM PROMPT",
  });
  assert.deepEqual(prepared.plan.args, plain.args);
  assert.equal("channels" in prepared.plan, false);
  assert.deepEqual(prepared.blocking, []);
  assert.deepEqual(prepared.record.limitations, []);
  assert.deepEqual(
    prepared.record.channels?.map((c) => [c.kind, c.status]),
    [
      ["knowledge-delta", "unmanaged"],
      ["artifact-dir", "unmanaged"],
    ],
  );
  // The record still names the paths the agent was handed.
  assert.equal(channelStatus(prepared, "knowledge-delta")?.path, DELTA);
  assert.equal(prepared.record.knowledgeDeltaFile, DELTA);
});

test("channels: a runtime that fails to answer for a channel is treated as unable to deliver it", () => {
  // The totality rule: a plan that maps the profile but says nothing about a
  // channel has not made it reachable, and the gap is reported, not assumed
  // away. A reported verdict is taken as is.
  const channels = channelsOf(RESULT);
  const silent = settleChannels(channels, [], "Some Runtime");
  assert.equal(silent[0].status, "unavailable");
  assert.equal(
    silent[0].reason,
    "Some Runtime did not account for the result file (ARGUS_RESULT_FILE)",
  );
  const absent = settleChannels(channels, undefined, "Some Runtime");
  assert.equal(absent[0].status, "unavailable");
  const answered = settleChannels(
    channels,
    [{ channel: channels[0], status: "granted" }],
    "Some Runtime",
  );
  assert.deepEqual(answered, [{ channel: channels[0], status: "granted" }]);
});

test("invocationChannels: fixed order, directories derived from file paths, required from the phase", () => {
  const list = invocationChannels({
    resultFile: RESULT,
    knowledgeDeltaFile: DELTA,
    artifactDir: "/art",
    memoryDir: "/mem",
    phaseDef: { checks: [{ kind: "artifact", path: "x.md" }], knowledgeDelta: "optional" },
  });
  assert.deepEqual(
    list.map((c) => [c.kind, c.envVar, c.dir, c.access, c.required]),
    [
      ["result", "ARGUS_RESULT_FILE", "/home/op/.claude/argus/results/run-1", "write", true],
      [
        "knowledge-delta",
        "ARGUS_KNOWLEDGE_DELTA_FILE",
        "/home/op/.claude/argus/knowledge-deltas/run-1",
        "write",
        false,
      ],
      ["artifact-dir", "ARGUS_ARTIFACT_DIR", "/art", "write", true],
      ["memory-dir", "ARGUS_MEMORY_DIR", "/mem", "write", true],
    ],
  );
  assert.deepEqual(
    invocationChannels({
      resultFile: null,
      knowledgeDeltaFile: null,
      artifactDir: null,
      memoryDir: null,
      phaseDef: {},
    }),
    [],
  );
});

test("invocationChannels: a verification phase's report channel is required (Phase 6)", () => {
  const verification = "/home/op/.claude/argus/rule-verifications/run-1/verification.json";
  const list = invocationChannels({
    resultFile: null,
    knowledgeDeltaFile: DELTA,
    ruleVerificationFile: verification,
    artifactDir: null,
    memoryDir: null,
    phaseDef: { ruleVerification: {} },
  });
  assert.deepEqual(
    list.map((c) => [c.kind, c.envVar, c.dir, c.access, c.required]),
    [
      [
        "knowledge-delta",
        "ARGUS_KNOWLEDGE_DELTA_FILE",
        "/home/op/.claude/argus/knowledge-deltas/run-1",
        "write",
        // The delta stays optional even here: proposing knowledge is not what
        // a verification phase is for.
        false,
      ],
      [
        "rule-verification",
        "ARGUS_RULE_VERIFICATION_FILE",
        "/home/op/.claude/argus/rule-verifications/run-1",
        "write",
        // Its output, not an optional proposal: a phase that cannot write it
        // has no way to succeed.
        true,
      ],
    ],
  );
  // An ordinary phase is offered no such channel at all.
  assert.equal(
    invocationChannels({
      resultFile: null,
      knowledgeDeltaFile: DELTA,
      artifactDir: null,
      memoryDir: null,
      phaseDef: {},
    }).some((c) => c.kind === "rule-verification"),
    false,
  );
});

// ── prepareInvocation: the KnowledgeContext (Phase 4) ────────────────────────

const CONTEXT_FILE = "/home/op/.claude/argus/invocations/run-1/knowledge-context.json";
const CONTEXT_RECORD = {
  schemaVersion: 1 as const,
  claims: [
    { id: "RULE-17", revision: 2 },
    { id: "CONSTRAINT-4", revision: 1 },
  ],
  sha256: "ab".repeat(32),
};

test("knowledge context: the invocation record carries the file, the exact refs and the hash, and a required read channel", () => {
  const prepared = prepareInvocation(
    baseInputs({
      knowledgeDeltaFile: DELTA,
      knowledgeContext: { file: CONTEXT_FILE, record: CONTEXT_RECORD },
      phaseDef: makePhase({ capabilities: { filesystem: "workspace-write" } }),
    }),
  );
  assert.deepEqual(prepared.blocking, []);
  assert.equal(prepared.record.knowledgeContextFile, CONTEXT_FILE);
  assert.deepEqual(prepared.record.knowledgeContext, CONTEXT_RECORD);
  assert.deepEqual(channelStatus(prepared, "knowledge-context"), {
    kind: "knowledge-context",
    envVar: "ARGUS_KNOWLEDGE_CONTEXT_FILE",
    path: CONTEXT_FILE,
    access: "read",
    required: true,
    status: "granted",
  });
  assert.deepEqual(
    prepared.record.channels?.map((c) => c.kind),
    ["knowledge-delta", "knowledge-context", "artifact-dir"],
  );
  const denied = prepared.plan.args[prepared.plan.args.indexOf("--disallowedTools") + 1];
  assert.ok(denied.includes("Edit(///home/op/.claude/argus/invocations/run-1/**)"));
});

test("knowledge context: absent means no file, no record entry and no channel — the legacy record shape", () => {
  const prepared = prepareInvocation(baseInputs({ knowledgeDeltaFile: DELTA }));
  assert.equal(prepared.record.knowledgeContextFile, null);
  assert.equal(prepared.record.knowledgeContext, null);
  assert.equal(channelStatus(prepared, "knowledge-context"), undefined);
  assert.equal("ARGUS_KNOWLEDGE_CONTEXT_FILE" in prepared.env, false);
});

test("knowledge context: a runtime that cannot deliver the read channel refuses the launch under strict enforcement and records it under best-effort", () => {
  const inputs = (enforcement?: "strict" | "best-effort") =>
    baseInputs({
      run: makeRun({ runtime: "qwen" }),
      knowledgeDeltaFile: DELTA,
      knowledgeContext: { file: CONTEXT_FILE, record: CONTEXT_RECORD },
      phaseDef: makePhase({
        capabilities: { ...(enforcement ? { enforcement } : {}) },
      }),
    });
  const before = process.env.ARGUS_QWEN_ARGS;
  process.env.ARGUS_QWEN_ARGS = "--sandbox";
  try {
    const strict = prepareInvocation(inputs());
    assert.deepEqual(strict.blocking, [
      "Qwen Code container sandbox (--sandbox in ARGUS_QWEN_ARGS) does not mount the KnowledgeContext file (ARGUS_KNOWLEDGE_CONTEXT_FILE)",
    ]);
    assert.equal(channelStatus(strict, "knowledge-context")?.status, "unavailable");
    // The record still says exactly what would have been supplied.
    assert.deepEqual(strict.record.knowledgeContext, CONTEXT_RECORD);

    const lenient = prepareInvocation(inputs("best-effort"));
    assert.deepEqual(lenient.blocking, []);
    assert.ok(lenient.record.limitations.some((l) => l.includes("ARGUS_KNOWLEDGE_CONTEXT_FILE")));
  } finally {
    if (before === undefined) delete process.env.ARGUS_QWEN_ARGS;
    else process.env.ARGUS_QWEN_ARGS = before;
  }
});

test("knowledge context: without a capability profile the channel is offered and recorded unmanaged, exactly like the others", () => {
  const prepared = prepareInvocation(
    baseInputs({ knowledgeContext: { file: CONTEXT_FILE, record: CONTEXT_RECORD } }),
  );
  assert.equal(channelStatus(prepared, "knowledge-context")?.status, "unmanaged");
  assert.deepEqual(prepared.record.knowledgeContext, CONTEXT_RECORD);
  assert.equal(prepared.plan.args.includes("--add-dir"), false);
});
