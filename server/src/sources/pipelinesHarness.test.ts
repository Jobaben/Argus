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
