/**
 * Harness-profile validation added to pipelines.ts: per-step/phase
 * `timeoutSeconds`, `capabilities` (filesystem/tools/mcpServers/
 * additionalDirectories/settingSources/permissionMode/maxTurns/env/
 * enforcement), phase `checks`, and the widened `retry.retryOn`.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-pipelines-harness-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

// A static import: the store resolves its file from the per-test home lazily,
// and a cache-busting re-import would hide this file's execution from coverage.
import * as pipelinesMod from "./pipelines.js";

async function fresh() {
  return pipelinesMod as any;
}

const goodInput = (over: Record<string, unknown> = {}) => ({
  name: "feature pipeline",
  phases: [
    {
      id: "brainstorm",
      name: "Brainstorm",
      cwd: home,
      gated: false,
      steps: [{ name: "bs", prompt: "go" }],
    },
  ],
  trigger: null,
  ...over,
});

const fullCapabilities = (over: Record<string, unknown> = {}) => ({
  filesystem: "workspace-write",
  tools: { allow: ["Bash(npm test:*)", "Edit"], deny: ["Bash(rm -rf *)"] },
  mcpServers: {
    docs: { type: "stdio", command: "docs-server", args: ["--port", "0"], env: { FOO: "bar" } },
    remote: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    },
  },
  additionalDirectories: [home],
  settingSources: ["project", "local"],
  permissionMode: "acceptEdits",
  maxTurns: 40,
  env: {
    inherit: "minimal",
    allow: ["MY_VAR", "PREFIX_*"],
    deny: ["SECRET_*"],
    set: { MY_VAR: "1" },
  },
  enforcement: "best-effort",
  ...over,
});

// ── validateCapabilities ─────────────────────────────────────────────────────

test("validateCapabilities accepts and round-trips a full profile", async () => {
  const m = await fresh();
  const profile = fullCapabilities();
  const out = m.validateCapabilities(profile, "ctx");
  assert.deepEqual(out, profile);
});

test("validateCapabilities returns undefined for null/undefined", async () => {
  const m = await fresh();
  assert.equal(m.validateCapabilities(undefined, "ctx"), undefined);
  assert.equal(m.validateCapabilities(null, "ctx"), undefined);
});

test("validateCapabilities rejects an unknown top-level key", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ bogus: true }, "ctx"),
    /ctx: capabilities has unknown key "bogus"/,
  );
});

test("validateCapabilities rejects a comma in a tool rule", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ tools: { allow: ["a,b"] } }, "ctx"),
    /tool rule "a,b" must not contain a comma/,
  );
});

test("validateCapabilities rejects a newline in a tool rule", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ tools: { deny: ["a\nb"] } }, "ctx"),
    /must not contain a comma/,
  );
});

test("validateCapabilities dedupes tool rules", async () => {
  const m = await fresh();
  const out = m.validateCapabilities({ tools: { allow: ["Edit", "Edit"] } }, "ctx");
  assert.deepEqual(out.tools.allow, ["Edit"]);
});

test("validateCapabilities caps tool rules at 200", async () => {
  const m = await fresh();
  const allow = Array.from({ length: 201 }, (_, i) => `Bash(cmd${i}:*)`);
  assert.throws(() => m.validateCapabilities({ tools: { allow } }, "ctx"), /capped at 200 rules/);
});

test("validateCapabilities rejects reserved env.set names", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ env: { set: { ARGUS_TOKEN: "x" } } }, "ctx"),
    /env\.set must not set reserved variable "ARGUS_TOKEN"/,
  );
  assert.throws(
    () => m.validateCapabilities({ env: { set: { ARGUS_WEBHOOK_URL: "x" } } }, "ctx"),
    /reserved variable "ARGUS_WEBHOOK_URL"/,
  );
  assert.throws(
    () => m.validateCapabilities({ env: { set: { ARGUS_SIGNAL_TOKEN: "x" } } }, "ctx"),
    /reserved variable "ARGUS_SIGNAL_TOKEN"/,
  );
  assert.throws(
    () => m.validateCapabilities({ env: { set: { ARGUS_ARTIFACT_DIR: "x" } } }, "ctx"),
    /reserved variable "ARGUS_ARTIFACT_DIR"/,
  );
});

test("validateCapabilities rejects a bad env allow/deny pattern", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ env: { allow: ["1BAD"] } }, "ctx"),
    /capabilities\.env\.allow entries must be a variable name/,
  );
  assert.throws(
    () => m.validateCapabilities({ env: { deny: ["FOO**"] } }, "ctx"),
    /capabilities\.env\.deny entries must be a variable name/,
  );
});

test("validateCapabilities rejects a bad env.set key", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ env: { set: { "1bad": "x" } } }, "ctx"),
    /must be a valid environment variable name/,
  );
});

test("validateCapabilities rejects a non-absolute additionalDirectories entry", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ additionalDirectories: ["relative/path"] }, "ctx"),
    /additionalDirectories\[0\] does not exist/,
  );
});

test("validateCapabilities rejects a non-existent additionalDirectories entry", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ additionalDirectories: [path.join(home, "nope")] }, "ctx"),
    /additionalDirectories\[0\] does not exist/,
  );
});

test("validateCapabilities rejects an mcp server with neither command nor url", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ mcpServers: { x: { type: "stdio" } } }, "ctx"),
    /mcpServers\["x"\] needs either command \(stdio\) or url \(http\/sse\)/,
  );
});

test("validateCapabilities rejects an invalid mcp server key", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ mcpServers: { "bad key!": { command: "x" } } }, "ctx"),
    /mcpServers key "bad key!"/,
  );
});

test("validateCapabilities accepts an empty mcpServers object (means none)", async () => {
  const m = await fresh();
  const out = m.validateCapabilities({ mcpServers: {} }, "ctx");
  assert.deepEqual(out, { mcpServers: {} });
});

test("validateCapabilities accepts an empty settingSources array (means none)", async () => {
  const m = await fresh();
  const out = m.validateCapabilities({ settingSources: [] }, "ctx");
  assert.deepEqual(out, { settingSources: [] });
});

test("validateCapabilities dedupes settingSources", async () => {
  const m = await fresh();
  const out = m.validateCapabilities({ settingSources: ["user", "user", "local"] }, "ctx");
  assert.deepEqual(out.settingSources, ["user", "local"]);
});

test("validateCapabilities rejects a bad filesystem/permissionMode/enforcement value", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ filesystem: "read-write" }, "ctx"),
    /capabilities\.filesystem must be/,
  );
  assert.throws(
    () => m.validateCapabilities({ permissionMode: "yolo" }, "ctx"),
    /capabilities\.permissionMode must be/,
  );
  assert.throws(
    () => m.validateCapabilities({ enforcement: "lenient" }, "ctx"),
    /capabilities\.enforcement must be/,
  );
});

test("validateCapabilities enforces maxTurns bounds", async () => {
  const m = await fresh();
  assert.equal(m.validateCapabilities({ maxTurns: 1 }, "ctx").maxTurns, 1);
  assert.equal(m.validateCapabilities({ maxTurns: 1000 }, "ctx").maxTurns, 1000);
  assert.throws(
    () => m.validateCapabilities({ maxTurns: 0 }, "ctx"),
    /maxTurns must be an integer 1-1000/,
  );
  assert.throws(
    () => m.validateCapabilities({ maxTurns: 1001 }, "ctx"),
    /maxTurns must be an integer 1-1000/,
  );
  assert.throws(
    () => m.validateCapabilities({ maxTurns: 1.5 }, "ctx"),
    /maxTurns must be an integer 1-1000/,
  );
});

// ── step/phase timeoutSeconds ────────────────────────────────────────────────

test("validation stores step and phase timeoutSeconds at the bounds", async () => {
  const m = await fresh();
  const input = m.validatePipelineInput(
    goodInput({
      phases: [
        {
          id: "x",
          name: "X",
          cwd: home,
          gated: false,
          timeoutSeconds: 86400,
          steps: [{ name: "s", prompt: "p", timeoutSeconds: 1 }],
        },
      ],
    }),
  );
  assert.equal(input.phases[0].timeoutSeconds, 86400);
  assert.equal(input.phases[0].steps[0].timeoutSeconds, 1);
});

test("validation rejects an out-of-range or non-integer timeoutSeconds", async () => {
  const m = await fresh();
  const bad = (timeoutSeconds: unknown) =>
    goodInput({
      phases: [
        {
          id: "x",
          name: "X",
          cwd: home,
          gated: false,
          steps: [{ name: "s", prompt: "p", timeoutSeconds }],
        },
      ],
    });
  assert.throws(() => m.validatePipelineInput(bad(0)), /timeoutSeconds must be an integer 1-86400/);
  assert.throws(
    () => m.validatePipelineInput(bad(86401)),
    /timeoutSeconds must be an integer 1-86400/,
  );
  assert.throws(
    () => m.validatePipelineInput(bad(2.5)),
    /timeoutSeconds must be an integer 1-86400/,
  );
});

test("validation stores step and phase stallSeconds at the bounds", async () => {
  const m = await fresh();
  const input = m.validatePipelineInput(
    goodInput({
      phases: [
        {
          id: "x",
          name: "X",
          cwd: home,
          gated: false,
          stallSeconds: 86400,
          steps: [{ name: "s", prompt: "p", stallSeconds: 30 }],
        },
      ],
    }),
  );
  assert.equal(input.phases[0].stallSeconds, 86400);
  assert.equal(input.phases[0].steps[0].stallSeconds, 30);
});

test("validation rejects a stallSeconds under 30 (a hard-timeout-sized value is not a stall)", async () => {
  const m = await fresh();
  const bad = (stallSeconds: unknown) =>
    goodInput({
      phases: [
        {
          id: "x",
          name: "X",
          cwd: home,
          gated: false,
          stallSeconds,
          steps: [{ name: "s", prompt: "p" }],
        },
      ],
    });
  assert.throws(() => m.validatePipelineInput(bad(29)), /stallSeconds must be an integer 30-86400/);
  assert.throws(() => m.validatePipelineInput(bad(0)), /stallSeconds must be an integer 30-86400/);
  assert.throws(
    () => m.validatePipelineInput(bad(30.5)),
    /stallSeconds must be an integer 30-86400/,
  );
});

test("validation omits timeoutSeconds and capabilities when absent", async () => {
  const m = await fresh();
  const input = m.validatePipelineInput(goodInput());
  assert.ok(!("timeoutSeconds" in input.phases[0]));
  assert.ok(!("capabilities" in input.phases[0]));
  assert.ok(!("timeoutSeconds" in input.phases[0].steps[0]));
  assert.ok(!("capabilities" in input.phases[0].steps[0]));
});

test("validation stores step-level capabilities narrowing the phase's", async () => {
  const m = await fresh();
  const input = m.validatePipelineInput(
    goodInput({
      phases: [
        {
          id: "x",
          name: "X",
          cwd: home,
          gated: false,
          capabilities: { filesystem: "workspace-write" },
          steps: [{ name: "s", prompt: "p", capabilities: { filesystem: "read-only" } }],
        },
      ],
    }),
  );
  assert.deepEqual(input.phases[0].capabilities, { filesystem: "workspace-write" });
  assert.deepEqual(input.phases[0].steps[0].capabilities, { filesystem: "read-only" });
});

// ── retry.retryOn ────────────────────────────────────────────────────────────

test("retry.retryOn accepts timeout and verification", async () => {
  const m = await fresh();
  const input = m.validatePipelineInput(
    goodInput({
      phases: [
        {
          id: "x",
          name: "X",
          cwd: home,
          gated: false,
          retry: { attempts: 3, retryOn: ["timeout", "verification"] },
          steps: [{ name: "s", prompt: "p" }],
        },
      ],
    }),
  );
  assert.deepEqual(input.phases[0].retry.retryOn, ["timeout", "verification"]);
});

test("retry.retryOn still rejects an unknown class", async () => {
  const m = await fresh();
  const bad = goodInput({
    phases: [
      {
        id: "x",
        name: "X",
        cwd: home,
        gated: false,
        retry: { attempts: 2, retryOn: ["bogus"] },
        steps: [{ name: "s", prompt: "p" }],
      },
    ],
  });
  assert.throws(() => m.validatePipelineInput(bad), /retry\.retryOn must be a list of/);
});

// ── validateChecks ───────────────────────────────────────────────────────────

const goodChecks = () => [
  { kind: "command", run: "npm test", cwd: "sub", timeoutSeconds: 120, label: "unit tests" },
  { kind: "artifact", path: "report.json", minBytes: 10 },
  { kind: "file", path: "nested/output.txt" },
  { kind: "changed-files", allow: ["src/**"], deny: ["src/secret/**"], requireChanges: true },
];

test("validateChecks accepts and round-trips a valid list", async () => {
  const m = await fresh();
  const checks = goodChecks();
  const out = m.validateChecks(checks, "phase 0");
  assert.deepEqual(out, checks);
});

test("validateChecks returns undefined for null/undefined", async () => {
  const m = await fresh();
  assert.equal(m.validateChecks(undefined, "phase 0"), undefined);
  assert.equal(m.validateChecks(null, "phase 0"), undefined);
});

test("validateChecks caps the list at 50", async () => {
  const m = await fresh();
  const checks = Array.from({ length: 51 }, () => ({ kind: "file", path: "x.txt" }));
  assert.throws(() => m.validateChecks(checks, "phase 0"), /capped at 50/);
});

test("validateChecks rejects an absolute artifact path", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateChecks([{ kind: "artifact", path: "/etc/passwd" }], "phase 0"),
    /checks\[0\]\.path must be a relative path inside the directory/,
  );
});

test("validateChecks rejects a path with a .. segment", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateChecks([{ kind: "file", path: "../secret.txt" }], "phase 0"),
    /checks\[0\]\.path must be a relative path inside the directory/,
  );
  assert.throws(
    () => m.validateChecks([{ kind: "file", path: "a/../../secret.txt" }], "phase 0"),
    /checks\[0\]\.path must be a relative path inside the directory/,
  );
});

test("validateChecks rejects an unknown kind", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateChecks([{ kind: "bogus" }], "phase 0"),
    /checks\[0\]\.kind must be/,
  );
});

test("validateChecks rejects a command check with no run", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateChecks([{ kind: "command" }], "phase 0"),
    /checks\[0\]\.run must be a non-empty string/,
  );
});

test("validateChecks rejects an unknown key on a check", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateChecks([{ kind: "file", path: "a.txt", run: "nope" }], "phase 0"),
    /checks\[0\] has unknown key "run"/,
  );
});

test("validation wires checks onto a phase and omits them when absent", async () => {
  const m = await fresh();
  const withChecks = m.validatePipelineInput(
    goodInput({
      phases: [
        {
          id: "x",
          name: "X",
          cwd: home,
          gated: false,
          checks: goodChecks(),
          steps: [{ name: "s", prompt: "p" }],
        },
      ],
    }),
  );
  assert.deepEqual(withChecks.phases[0].checks, goodChecks());

  const withoutChecks = m.validatePipelineInput(goodInput());
  assert.ok(!("checks" in withoutChecks.phases[0]));
});

// ── pipeline-level capabilities persistence ─────────────────────────────────

test("createPipeline persists pipeline-level capabilities", async () => {
  const m = await fresh();
  const created = await m.createPipeline(
    m.validatePipelineInput(goodInput({ capabilities: { filesystem: "read-only" } })),
    new Date(2026, 5, 30, 9, 0),
    "p1",
  );
  assert.deepEqual(created.capabilities, { filesystem: "read-only" });
  const [persisted] = await m.readPipelines();
  assert.deepEqual(persisted.capabilities, { filesystem: "read-only" });
});

test("createPipeline omits capabilities when absent", async () => {
  const m = await fresh();
  const created = await m.createPipeline(
    m.validatePipelineInput(goodInput()),
    new Date(2026, 5, 30, 9, 0),
    "p1",
  );
  assert.ok(!("capabilities" in created));
});

test("validatePipelinePatch validates and can clear pipeline-level capabilities", async () => {
  const m = await fresh();
  const patch = m.validatePipelinePatch({ capabilities: { filesystem: "unrestricted" } });
  assert.deepEqual(patch.capabilities, { filesystem: "unrestricted" });
  const cleared = m.validatePipelinePatch({ capabilities: null });
  assert.ok("capabilities" in cleared);
  assert.equal(cleared.capabilities, undefined);
  assert.throws(
    () => m.validatePipelinePatch({ capabilities: { bogus: 1 } }),
    /capabilities has unknown key "bogus"/,
  );
});

test("updatePipeline via patch sets then clears pipeline-level capabilities", async () => {
  const m = await fresh();
  await m.createPipeline(m.validatePipelineInput(goodInput()), new Date(2026, 5, 30, 9, 0), "p1");

  const withCaps = await m.updatePipeline(
    "p1",
    m.validatePipelinePatch({ capabilities: { filesystem: "workspace-write", maxTurns: 20 } }),
    new Date(2026, 5, 30, 10, 0),
  );
  assert.deepEqual(withCaps.capabilities, { filesystem: "workspace-write", maxTurns: 20 });

  const cleared = await m.updatePipeline(
    "p1",
    m.validatePipelinePatch({ capabilities: null }),
    new Date(2026, 5, 30, 11, 0),
  );
  assert.ok(!("capabilities" in cleared));
  const [persisted] = await m.readPipelines();
  assert.ok(!("capabilities" in persisted));
});

// ── Regression: phase id validation, and newly reserved env.set names ───────
// Previously a phase id was accepted whenever it was non-empty after
// trimming — no shape check at all — so an id like "../../x" was stored
// verbatim and later joined straight into a filesystem path (the per-attempt
// artifact directory) with no sanitization.

test("phase id rejects path-hostile shapes and an over-length id, and accepts a normal dotted id", async () => {
  const m = await fresh();
  const withId = (id: string) =>
    goodInput({
      phases: [{ id, name: "X", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] }],
    });

  for (const id of ["../../x", "a/b", "..", "x".repeat(81)]) {
    assert.throws(() => m.validatePipelineInput(withId(id)), /id must be/, id);
  }

  const ok = m.validatePipelineInput(withId("feature-1.a_b"));
  assert.equal(ok.phases[0].id, "feature-1.a_b");
});

test("a whitespace-only phase id is rejected (via the pre-existing 'id is required' check, since trim() empties it)", async () => {
  const m = await fresh();
  const withId = (id: string) =>
    goodInput({
      phases: [{ id, name: "X", cwd: home, gated: false, steps: [{ name: "s", prompt: "p" }] }],
    });
  // Note: this does NOT reach the PHASE_ID_RE "id must be ..." message — a
  // single space trims to "", so the earlier "id is required" check fires
  // first. Still rejected either way; see the written report for detail.
  assert.throws(() => m.validatePipelineInput(withId(" ")), /id is required/);
});

test("env.set rejects ARGUS_RUNTIME and ARGUS_STEP_NAME as reserved per-invocation identifiers", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateCapabilities({ env: { set: { ARGUS_RUNTIME: "x" } } }, "ctx"),
    /reserved variable "ARGUS_RUNTIME"/,
  );
  assert.throws(
    () => m.validateCapabilities({ env: { set: { ARGUS_STEP_NAME: "x" } } }, "ctx"),
    /reserved variable "ARGUS_STEP_NAME"/,
  );
});

test("mcpServers env/headers reject a key with = or a space, and accept a hyphenated header name", async () => {
  const m = await fresh();
  assert.throws(
    () =>
      m.validateCapabilities(
        { mcpServers: { x: { command: "c", env: { "BAD=KEY": "v" } } } },
        "ctx",
      ),
    /invalid key "BAD=KEY"/,
  );
  assert.throws(
    () =>
      m.validateCapabilities(
        { mcpServers: { x: { command: "c", headers: { "X Y": "v" } } } },
        "ctx",
      ),
    /invalid key "X Y"/,
  );
  const out = m.validateCapabilities(
    { mcpServers: { x: { command: "c", headers: { "X-Api-Key": "v" } } } },
    "ctx",
  );
  assert.deepEqual(out.mcpServers.x.headers, { "X-Api-Key": "v" });
});

// ── workspace (isolation) ───────────────────────────────────────────────────

test("workspace: absent stays absent, and a valid policy round-trips", async () => {
  const m = await fresh();
  assert.equal(m.validateWorkspace(undefined, "ctx"), undefined);
  assert.equal(m.validateWorkspace(null, "ctx"), undefined);
  assert.deepEqual(m.validateWorkspace({ scope: "instance" }, "ctx"), { scope: "instance" });
  assert.deepEqual(
    m.validateWorkspace({ scope: "attempt", base: "origin/main", keep: true }, "ctx"),
    { scope: "attempt", base: "origin/main", keep: true },
  );
  // Trimmed, like every other string the validators accept.
  assert.equal(m.validateWorkspace({ scope: "attempt", base: "  main  " }, "ctx").base, "main");
});

test("workspace: scope is one of three values, and unknown keys are rejected", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateWorkspace({}, "ctx"),
    /workspace.scope must be instance \| attempt \| none/,
  );
  assert.throws(() => m.validateWorkspace({ scope: "phase" }, "ctx"), /workspace.scope must be/);
  assert.throws(() => m.validateWorkspace("instance", "ctx"), /workspace must be an object/);
  assert.throws(() => m.validateWorkspace([], "ctx"), /workspace must be an object/);
  assert.throws(
    () => m.validateWorkspace({ scope: "instance", branch: "x" }, "ctx"),
    /workspace has unknown key "branch"/,
  );
});

test("workspace: scope 'none' round-trips, so a phase can opt out of a pipeline-wide policy", async () => {
  const m = await fresh();
  assert.deepEqual(m.validateWorkspace({ scope: "none" }, "ctx"), { scope: "none" });
  const input = m.validatePipelineInput(
    goodInput({
      workspace: { scope: "instance" },
      phases: [
        {
          id: "readonly",
          name: "Readonly",
          cwd: home,
          gated: false,
          workspace: { scope: "none" },
          steps: [{ name: "s", prompt: "go" }],
        },
      ],
    }),
  );
  assert.deepEqual(input.phases[0].workspace, { scope: "none" });
});

test("workspace: base must be a ref, not a flag or several arguments", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateWorkspace({ scope: "attempt", base: "" }, "ctx"),
    /workspace.base must be a non-empty string/,
  );
  assert.throws(
    () => m.validateWorkspace({ scope: "attempt", base: 7 }, "ctx"),
    /workspace.base must be a non-empty string/,
  );
  assert.throws(
    () => m.validateWorkspace({ scope: "attempt", base: "main --force" }, "ctx"),
    /is not a valid git ref/,
  );
  assert.throws(
    () => m.validateWorkspace({ scope: "attempt", base: "-b" }, "ctx"),
    /is not a valid git ref/,
  );
});

test("workspace: keep must be a boolean", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateWorkspace({ scope: "attempt", keep: "yes" }, "ctx"),
    /workspace.keep must be a boolean/,
  );
  assert.deepEqual(m.validateWorkspace({ scope: "attempt", keep: null }, "ctx"), {
    scope: "attempt",
  });
});

test("workspace: accepted on a pipeline and on a phase, and the phase's error names it", async () => {
  const m = await fresh();
  const input = m.validatePipelineInput(
    goodInput({
      workspace: { scope: "instance" },
      phases: [
        {
          id: "brainstorm",
          name: "Brainstorm",
          cwd: home,
          gated: false,
          workspace: { scope: "attempt", base: "main" },
          steps: [{ name: "bs", prompt: "go" }],
        },
      ],
    }),
  );
  assert.deepEqual(input.workspace, { scope: "instance" });
  assert.deepEqual(input.phases[0].workspace, { scope: "attempt", base: "main" });

  assert.throws(
    () =>
      m.validatePipelineInput(
        goodInput({
          phases: [
            {
              id: "brainstorm",
              name: "Brainstorm",
              cwd: home,
              gated: false,
              workspace: { scope: "nope" },
              steps: [{ name: "bs", prompt: "go" }],
            },
          ],
        }),
      ),
    /phase 0: workspace.scope must be/,
  );
});

test("workspace: a patch sets it, and an explicit null clears it", async () => {
  const m = await fresh();
  const def = await m.createPipeline(
    m.validatePipelineInput(goodInput({ workspace: { scope: "instance", keep: true } })),
    new Date(),
    "pw",
  );
  assert.deepEqual(def.workspace, { scope: "instance", keep: true });

  const patched = await m.updatePipeline(
    "pw",
    m.validatePipelinePatch({ workspace: { scope: "attempt" } }),
    new Date(),
  );
  assert.deepEqual(patched.workspace, { scope: "attempt" });

  const cleared = await m.updatePipeline(
    "pw",
    m.validatePipelinePatch({ workspace: null }),
    new Date(),
  );
  assert.equal("workspace" in cleared, false);
});

// ── Context limits and memory ────────────────────────────────────────────────

test("contextLimits: absent stays absent, and a valid override round-trips within bounds", async () => {
  const m = await fresh();
  assert.equal(m.validateContextLimits(undefined, "ctx"), undefined);
  assert.equal(m.validateContextLimits(null, "ctx"), undefined);
  assert.deepEqual(m.validateContextLimits({ placeholderBytes: 32768 }, "ctx"), {
    placeholderBytes: 32768,
  });
  assert.deepEqual(m.validateContextLimits({}, "ctx"), {});
});

test("contextLimits: placeholderBytes is bounded 1 KiB - 256 KiB, and unknown keys are rejected", async () => {
  const m = await fresh();
  assert.throws(
    () => m.validateContextLimits({ placeholderBytes: 1023 }, "ctx"),
    /placeholderBytes must be an integer 1024-262144/,
  );
  assert.throws(
    () => m.validateContextLimits({ placeholderBytes: 262145 }, "ctx"),
    /placeholderBytes must be an integer 1024-262144/,
  );
  assert.throws(
    () => m.validateContextLimits({ tooMuch: 1 }, "ctx"),
    /contextLimits has unknown key "tooMuch"/,
  );
  assert.throws(() => m.validateContextLimits("nope", "ctx"), /contextLimits must be an object/);
});

test("contextLimits: accepted on a pipeline and read back off the definition", async () => {
  const m = await fresh();
  const def = await m.createPipeline(
    m.validatePipelineInput(goodInput({ contextLimits: { placeholderBytes: 4096 } })),
    new Date(),
    "pc",
  );
  assert.deepEqual(def.contextLimits, { placeholderBytes: 4096 });
});

test("memory: off by default, and a valid policy round-trips", async () => {
  const m = await fresh();
  assert.equal(m.validateMemory(undefined, "ctx"), undefined);
  assert.equal(m.validateMemory(null, "ctx"), undefined);
  assert.deepEqual(m.validateMemory({ enabled: true }, "ctx"), { enabled: true });
  assert.deepEqual(m.validateMemory({ enabled: true, maxBytes: 16384 }, "ctx"), {
    enabled: true,
    maxBytes: 16384,
  });
  assert.deepEqual(m.validateMemory({ enabled: false }, "ctx"), { enabled: false });
});

test("memory: enabled is required and must be a boolean, maxBytes is bounded 1-64 KiB", async () => {
  const m = await fresh();
  assert.throws(() => m.validateMemory({}, "ctx"), /memory.enabled must be a boolean/);
  assert.throws(
    () => m.validateMemory({ enabled: "yes" }, "ctx"),
    /memory.enabled must be a boolean/,
  );
  assert.throws(
    () => m.validateMemory({ enabled: true, maxBytes: 1023 }, "ctx"),
    /memory.maxBytes must be an integer 1024-65536/,
  );
  assert.throws(
    () => m.validateMemory({ enabled: true, maxBytes: 65537 }, "ctx"),
    /memory.maxBytes must be an integer 1024-65536/,
  );
  assert.throws(
    () => m.validateMemory({ enabled: true, extra: 1 }, "ctx"),
    /memory has unknown key "extra"/,
  );
});

test("memory: a patch sets it, an explicit null clears it, and it counts as an execution key", async () => {
  const m = await fresh();
  const def = await m.createPipeline(
    m.validatePipelineInput(goodInput({ memory: { enabled: true, maxBytes: 4096 } })),
    new Date(),
    "pm",
  );
  assert.deepEqual(def.memory, { enabled: true, maxBytes: 4096 });

  const patched = await m.updatePipeline(
    "pm",
    m.validatePipelinePatch({ memory: { enabled: false } }),
    new Date(),
  );
  assert.deepEqual(patched.memory, { enabled: false });

  const cleared = await m.updatePipeline(
    "pm",
    m.validatePipelinePatch({ memory: null }),
    new Date(),
  );
  assert.equal("memory" in cleared, false);
});

// ── Candidates ───────────────────────────────────────────────────────────────

/** A one-step phase with attempt-scoped isolation: the shape candidates needs. */
const candidatePhase = (over: Record<string, unknown> = {}) => ({
  id: "impl",
  name: "Implement",
  cwd: home,
  gated: false,
  workspace: { scope: "attempt" },
  steps: [{ name: "code", prompt: "go" }],
  candidates: { count: 3, select: "first-verified" },
  ...over,
});

test("candidates: a well-formed policy round-trips, variants and all", async () => {
  const m = await fresh();
  const input = m.validatePipelineInput(
    goodInput({
      phases: [
        candidatePhase({
          candidates: {
            count: 4,
            select: "cheapest-verified",
            variants: [
              { runtime: "claude", model: "opus" },
              { runtime: "codex", reasoningEffort: "high" },
            ],
          },
        }),
      ],
    }),
  );
  assert.deepEqual(input.phases[0].candidates, {
    count: 4,
    select: "cheapest-verified",
    variants: [
      { runtime: "claude", model: "opus" },
      { runtime: "codex", reasoningEffort: "high" },
    ],
  });
});

test("candidates: count is an integer 2-8 and select is one of the two", async () => {
  const m = await fresh();
  const bad = (candidates: unknown) =>
    m.validatePipelineInput(goodInput({ phases: [candidatePhase({ candidates })] }));
  assert.throws(
    () => bad({ count: 1, select: "first-verified" }),
    /candidates.count must be an integer 2-8/,
  );
  assert.throws(
    () => bad({ count: 9, select: "first-verified" }),
    /candidates.count must be an integer 2-8/,
  );
  assert.throws(
    () => bad({ count: 2.5, select: "first-verified" }),
    /candidates.count must be an integer/,
  );
  assert.throws(() => bad({ count: 2, select: "majority" }), /candidates.select must be/);
  assert.throws(() => bad({ count: 2, select: "first-verified", nope: 1 }), /unknown key "nope"/);
});

test("candidates: a variant's fields are held to the step fields they override", async () => {
  const m = await fresh();
  const variant = (v: unknown) =>
    m.validatePipelineInput(
      goodInput({
        phases: [
          candidatePhase({ candidates: { count: 2, select: "first-verified", variants: [v] } }),
        ],
      }),
    );
  assert.throws(() => variant({ runtime: "gpt" }), /variants\[0\]: runtime must be/);
  assert.throws(() => variant({ model: "--oops" }), /is not a valid model identifier/);
  assert.throws(() => variant({ reasoningEffort: "extreme" }), /reasoningEffort must be/);
  assert.throws(() => variant({ temperature: 1 }), /unknown key "temperature"/);
});

test("candidates: requires exactly one step, and says why", async () => {
  const m = await fresh();
  assert.throws(
    () =>
      m.validatePipelineInput(
        goodInput({
          phases: [
            candidatePhase({
              steps: [
                { name: "a", prompt: "x" },
                { name: "b", prompt: "y" },
              ],
            }),
          ],
        }),
      ),
    /candidates requires exactly one step \(this phase has 2\)/,
  );
});

test("candidates: requires attempt-scoped isolation, from the phase or the pipeline", async () => {
  const m = await fresh();
  // No isolation at all.
  assert.throws(
    () =>
      m.validatePipelineInput(goodInput({ phases: [candidatePhase({ workspace: undefined })] })),
    /candidates requires workspace.scope "attempt".*effective isolation: none/s,
  );
  // Instance-scoped is isolation, but the wrong kind: one tree, shared.
  assert.throws(
    () =>
      m.validatePipelineInput(
        goodInput({ phases: [candidatePhase({ workspace: { scope: "instance" } })] }),
      ),
    /effective isolation: "instance"/,
  );
  // Inherited from the pipeline is fine.
  const ok = m.validatePipelineInput(
    goodInput({
      workspace: { scope: "attempt" },
      phases: [candidatePhase({ workspace: undefined })],
    }),
  );
  assert.equal(ok.phases[0].candidates.count, 3);
});

test("candidates: a patch that removes the isolation the phase relies on is refused", async () => {
  const m = await fresh();
  await m.createPipeline(
    m.validatePipelineInput(
      goodInput({
        workspace: { scope: "attempt" },
        phases: [candidatePhase({ workspace: undefined })],
      }),
    ),
    new Date(),
    "pc",
  );
  // The patch carries no phases at all, so only the merged definition can see
  // that clearing the pipeline's workspace strands the phase's candidates.
  await assert.rejects(
    m.updatePipeline("pc", m.validatePipelinePatch({ workspace: null }), new Date()),
    /candidates requires workspace.scope "attempt"/,
  );
  const still = (await m.readPipelines()).find((p: { id: string }) => p.id === "pc");
  assert.deepEqual(still.workspace, { scope: "attempt" });
});

// ── knowledgeDelta: whether the delta channel is a launch precondition ──────

test("knowledgeDelta: optional | required on a phase, absent by default, anything else refused", async () => {
  const m = await fresh();
  const phase = (over: Record<string, unknown>) => ({
    id: "learn",
    name: "Learn",
    cwd: home,
    gated: false,
    steps: [{ name: "s", prompt: "p" }],
    ...over,
  });
  const plain = m.validatePipelineInput(goodInput({ phases: [phase({})] }));
  assert.equal("knowledgeDelta" in plain.phases[0], false);
  for (const mode of ["optional", "required"]) {
    const ok = m.validatePipelineInput(goodInput({ phases: [phase({ knowledgeDelta: mode })] }));
    assert.equal(ok.phases[0].knowledgeDelta, mode);
  }
  assert.throws(
    () => m.validatePipelineInput(goodInput({ phases: [phase({ knowledgeDelta: "always" })] })),
    /phase 0: knowledgeDelta must be optional \| required/,
  );
  assert.throws(
    () => m.validatePipelineInput(goodInput({ phases: [phase({ knowledgeDelta: true })] })),
    /knowledgeDelta must be/,
  );
});

// ── knowledgeContext: which canonical knowledge a step receives (Phase 4) ───

test("knowledgeContext: accepted on a step and on a phase, normalized to the object form, absent by default", async () => {
  const m = await fresh();
  const phase = (over: Record<string, unknown>) => ({
    id: "implement",
    name: "Implement",
    cwd: home,
    gated: false,
    steps: [{ name: "s", prompt: "p" }],
    ...over,
  });
  const plain = m.validatePipelineInput(goodInput({ phases: [phase({})] }));
  assert.equal("knowledgeContext" in plain.phases[0], false);
  assert.equal("knowledgeContext" in plain.phases[0].steps[0], false);

  const onPhase = m.validatePipelineInput(
    goodInput({
      phases: [phase({ knowledgeContext: { claims: ["RULE-17:v2", "CONSTRAINT-4"] } })],
    }),
  );
  assert.deepEqual(onPhase.phases[0].knowledgeContext, {
    claims: [
      { id: "RULE-17", revision: 2 },
      { id: "CONSTRAINT-4", revision: "active" },
    ],
  });

  const onStep = m.validatePipelineInput(
    goodInput({
      phases: [
        phase({
          steps: [
            {
              name: "s",
              prompt: "p",
              knowledgeContext: { claims: [{ id: "DECISION-3", revision: "active" }] },
            },
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(onStep.phases[0].steps[0].knowledgeContext, {
    claims: [{ id: "DECISION-3", revision: "active" }],
  });
  assert.equal("knowledgeContext" in onStep.phases[0], false);
});

test("knowledgeContext: malformed selectors and duplicate claim ids are refused as 400-class authoring errors", async () => {
  const m = await fresh();
  const phase = (over: Record<string, unknown>) => ({
    id: "implement",
    name: "Implement",
    cwd: home,
    gated: false,
    steps: [{ name: "s", prompt: "p" }],
    ...over,
  });
  const cases: [unknown, RegExp][] = [
    [{ claims: [] }, /phase 0: knowledgeContext.claims must name at least one claim/],
    [
      { claims: ["RULE-17:v2", "RULE-17"] },
      /phase 0: knowledgeContext.claims\[1\]: RULE-17 is already selected by claims\[0\]/,
    ],
    [{ claims: [{ id: "RULE-17" }] }, /revision must be a positive integer or "active"/],
    [{ claims: ["not a ref!"] }, /knowledgeContext.claims\[0\] must be a claim id/],
    ["RULE-17", /knowledgeContext must be an object/],
    [{ claims: ["RULE-17"], tags: ["x"] }, /unknown key "tags"/],
  ];
  for (const [knowledgeContext, re] of cases) {
    assert.throws(
      () => m.validatePipelineInput(goodInput({ phases: [phase({ knowledgeContext })] })),
      (e: unknown) => e instanceof m.PipelineValidationError && re.test((e as Error).message),
      `phase: ${JSON.stringify(knowledgeContext)}`,
    );
  }
  assert.throws(
    () =>
      m.validatePipelineInput(
        goodInput({
          phases: [
            phase({ steps: [{ name: "s", prompt: "p", knowledgeContext: { claims: [] } }] }),
          ],
        }),
      ),
    /phase 0: step "s": knowledgeContext.claims must name at least one claim/,
  );
});

// ── discovery + fromPhases: business-rule discovery authoring (Phase 5) ─────

const discoveryPhases = (over: Record<string, unknown> = {}) => [
  {
    id: "discover",
    name: "Discover",
    cwd: home,
    gated: true,
    steps: [{ name: "investigate", prompt: "look" }],
    ...over,
  },
  {
    id: "plan",
    name: "Plan",
    cwd: home,
    gated: false,
    needs: ["discover"],
    steps: [{ name: "plan", prompt: "plan" }],
  },
];

test("discovery: a scope is accepted, normalized and deduplicated; absent by default", async () => {
  const m = await fresh();
  const plain = m.validatePipelineInput(goodInput({ phases: discoveryPhases() }));
  assert.equal("discovery" in plain.phases[0], false);

  const withScope = m.validatePipelineInput(
    goodInput({
      phases: discoveryPhases({
        discovery: {
          scope: {
            paths: ["src/Booking/", "src/Booking", "src/Kobra"],
            label: "Kobra booking",
            note: "Focus on the comment length.",
          },
          evidence: "required",
        },
      }),
    }),
  );
  assert.deepEqual(withScope.phases[0].discovery, {
    scope: {
      paths: ["src/Booking", "src/Kobra"],
      label: "Kobra booking",
      note: "Focus on the comment length.",
    },
    evidence: "required",
  });
  // "." is the whole tree, and has to be written out.
  const whole = m.validatePipelineInput(
    goodInput({ phases: discoveryPhases({ discovery: { scope: { paths: ["."] } } }) }),
  );
  assert.deepEqual(whole.phases[0].discovery, { scope: { paths: ["."] } });
});

test("discovery: an unsafe or empty scope is a 400-class authoring error", async () => {
  const m = await fresh();
  const cases: [unknown, RegExp][] = [
    [{}, /discovery.scope must be an object/],
    [{ scope: { paths: [] } }, /must name at least one repository-relative path/],
    [{ scope: { paths: ["../outside"] } }, /repository-relative POSIX path/],
    [{ scope: { paths: ["/etc"] } }, /repository-relative POSIX path/],
    [{ scope: { paths: ["src"], extra: 1 } }, /discovery.scope has unknown key "extra"/],
    [{ scope: { paths: ["src"] }, evidence: "maybe" }, /discovery.evidence must be/],
    [{ scope: { paths: ["src"] }, mode: "auto" }, /discovery has unknown key "mode"/],
    ["src", /discovery must be an object/],
  ];
  for (const [discovery, re] of cases) {
    assert.throws(
      () => m.validatePipelineInput(goodInput({ phases: discoveryPhases({ discovery }) })),
      (e: unknown) => e instanceof m.PipelineValidationError && re.test((e as Error).message),
      `discovery: ${JSON.stringify(discovery)}`,
    );
  }
});

test("ruleVerification: the policy is tiny on purpose — the rules come from the context", async () => {
  const m = await fresh();
  // Absent = an ordinary phase.
  assert.equal(
    "ruleVerification" in
      m.validatePipelineInput(goodInput({ phases: discoveryPhases() })).phases[0],
    false,
  );
  const def = m.validatePipelineInput(
    goodInput({
      phases: discoveryPhases({
        ruleVerification: {
          kinds: ["business-rule", "constraint", "business-rule"],
          holds: "deterministic-check",
          note: "Conformance means the booking pipeline enforces it.",
        },
      }),
    }),
  );
  assert.deepEqual(def.phases[0].ruleVerification, {
    kinds: ["business-rule", "constraint"],
    holds: "deterministic-check",
    note: "Conformance means the booking pipeline enforces it.",
  });
  // The empty policy is meaningful: verify the business rules you were given,
  // under the default holds rule.
  assert.deepEqual(
    m.validatePipelineInput(goodInput({ phases: discoveryPhases({ ruleVerification: {} }) }))
      .phases[0].ruleVerification,
    {},
  );
});

test("ruleVerification: a malformed policy is a 400-class authoring error", async () => {
  const m = await fresh();
  const cases: [unknown, RegExp][] = [
    ["strict", /ruleVerification must be an object/],
    [{ rules: ["RULE-1"] }, /ruleVerification has unknown key "rules"/],
    [{ kinds: [] }, /ruleVerification.kinds must name at least one claim kind/],
    [{ kinds: ["widget"] }, /ruleVerification.kinds\[0\] must be one of/],
    [{ holds: "vibes" }, /ruleVerification.holds must be/],
    [{ note: "" }, /ruleVerification.note must be a string/],
  ];
  for (const [ruleVerification, re] of cases) {
    assert.throws(
      () => m.validatePipelineInput(goodInput({ phases: discoveryPhases({ ruleVerification }) })),
      (e: unknown) => e instanceof m.PipelineValidationError && re.test((e as Error).message),
      `ruleVerification: ${JSON.stringify(ruleVerification)}`,
    );
  }
});

test("fromPhases: accepted when the named phase is a dependency, normalized to the object form", async () => {
  const m = await fresh();
  const phases = discoveryPhases();
  (phases[1] as Record<string, unknown>).knowledgeContext = {
    fromPhases: [{ phaseId: "discover", kinds: ["business-rule", "constraint"] }],
  };
  const def = m.validatePipelineInput(goodInput({ phases }));
  assert.deepEqual(def.phases[1].knowledgeContext, {
    fromPhases: [{ phaseId: "discover", kinds: ["business-rule", "constraint"] }],
  });

  // The linear shorthand counts as a dependency too: with no `needs` anywhere,
  // every phase implicitly needs the one before it.
  const linear = m.validatePipelineInput(
    goodInput({
      phases: [
        { id: "discover", name: "D", cwd: home, gated: true, steps: [{ name: "s", prompt: "p" }] },
        {
          id: "plan",
          name: "P",
          cwd: home,
          gated: false,
          steps: [{ name: "s", prompt: "p", knowledgeContext: { fromPhases: ["discover"] } }],
        },
      ],
    }),
  );
  assert.deepEqual(linear.phases[1].steps[0].knowledgeContext, {
    fromPhases: [{ phaseId: "discover" }],
  });
});

test("fromPhases: an unknown phase, its own phase, or one it does not depend on is refused", async () => {
  const m = await fresh();
  const withContext = (knowledgeContext: unknown, onIndex = 1) => {
    const phases = discoveryPhases();
    (phases[onIndex] as Record<string, unknown>).knowledgeContext = knowledgeContext;
    return goodInput({ phases });
  };
  assert.throws(
    () => m.validatePipelineInput(withContext({ fromPhases: ["ghost"] })),
    /phase "plan": knowledgeContext.fromPhases names unknown phase "ghost"/,
  );
  assert.throws(
    () => m.validatePipelineInput(withContext({ fromPhases: ["plan"] })),
    /cannot name its own phase/,
  );
  // A phase that merely sits earlier in the list, with no dependency edge, has
  // no guaranteed ordering — so the handoff would be a race.
  assert.throws(
    () =>
      m.validatePipelineInput(
        goodInput({
          phases: [
            {
              id: "a",
              name: "A",
              cwd: home,
              gated: false,
              needs: [],
              steps: [{ name: "s", prompt: "p" }],
            },
            {
              id: "b",
              name: "B",
              cwd: home,
              gated: false,
              needs: [],
              steps: [{ name: "s", prompt: "p" }],
              knowledgeContext: { fromPhases: ["a"] },
            },
          ],
        }),
      ),
    /is not a dependency of this phase; add it to needs/,
  );
});
