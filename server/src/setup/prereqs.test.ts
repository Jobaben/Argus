import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-prereqs-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  return import(`./prereqs.js?${Math.random()}`);
}

function writeSettings(obj: unknown) {
  writeFileSync(path.join(home, "settings.json"), JSON.stringify(obj), "utf8");
}

const find = (list: any[], id: string) => list.find((p) => p.id === id);

test("fresh home reports the signal Stop hook as missing", async () => {
  const m = await fresh();
  const { prereqs, ok } = await m.checkAll();
  assert.equal(find(prereqs, "signal-stop-hook").status, "missing");
  assert.equal(ok, false);
});

test("a registered Stop hook with no installed file reads back as outdated", async () => {
  writeSettings({
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: 'node "x/hooks/argus-signal.mjs"' }] },
      ],
    },
  });
  const m = await fresh();
  const { prereqs } = await m.checkAll();
  assert.equal(find(prereqs, "signal-stop-hook").status, "outdated");
});

test("gate hook registered but with no installed file reads back as outdated", async () => {
  writeSettings({
    hooks: {
      PreToolUse: [
        {
          matcher: "AskUserQuestion",
          hooks: [{ type: "command", command: 'node "x/hooks/argus-signal.mjs" needs-input' }],
        },
      ],
    },
  });
  const m = await fresh();
  const { prereqs } = await m.checkAll();
  assert.equal(find(prereqs, "gate-pretooluse-hook").status, "outdated");
});

test("malformed settings.json is treated as missing, never throws", async () => {
  writeFileSync(path.join(home, "settings.json"), "{ not json", "utf8");
  const m = await fresh();
  const { prereqs } = await m.checkAll();
  assert.equal(find(prereqs, "signal-stop-hook").status, "missing");
});

import { readFileSync, existsSync } from "node:fs";

test("applyAll installs the hook file and a valid Stop entry", async () => {
  const m = await fresh();
  await m.applyAll();
  assert.ok(existsSync(path.join(home, "hooks", "argus-signal.mjs")), "hook file copied");
  const settings = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
  const stopCmds = settings.hooks.Stop.flatMap((g: any) => g.hooks).map((h: any) => h.command);
  assert.ok(
    stopCmds.some((c: string) => c.includes("argus-signal")),
    "Stop hook registered",
  );
  const { prereqs } = await m.checkAll();
  assert.equal(find(prereqs, "signal-stop-hook").status, "ok");
  assert.equal(find(prereqs, "gate-pretooluse-hook").status, "ok");
});

test("applyAll preserves a pre-existing unrelated Stop hook", async () => {
  writeSettings({
    hooks: {
      Stop: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "~/.claude/hooks/bmad-runlog-autoclose.sh", timeout: 5 },
          ],
        },
      ],
    },
  });
  const m = await fresh();
  await m.applyAll();
  const settings = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
  const stopCmds = settings.hooks.Stop.flatMap((g: any) => g.hooks).map((h: any) => h.command);
  assert.ok(
    stopCmds.some((c: string) => c.includes("bmad-runlog-autoclose")),
    "existing hook preserved",
  );
  assert.ok(
    stopCmds.some((c: string) => c.includes("argus-signal")),
    "new hook added",
  );
});

test("applyAll is idempotent — no duplicate entries on re-apply", async () => {
  const m = await fresh();
  await m.applyAll();
  await m.applyAll();
  const settings = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
  const stopCmds = settings.hooks.Stop.flatMap((g: any) => g.hooks)
    .map((h: any) => h.command)
    .filter((c: string) => c.includes("argus-signal"));
  assert.equal(stopCmds.length, 1, "exactly one signal Stop hook");
});

test("applyAll surfaces an apply failure as status error with detail", async () => {
  // Make the Claude home un-creatable: its parent is a file, not a dir.
  const blocker = path.join(home, "blocker");
  writeFileSync(blocker, "x", "utf8");
  process.env.ARGUS_CLAUDE_HOME = path.join(blocker, "claude"); // parent is a file
  const m = await fresh();
  const { ok, prereqs } = await m.applyAll();
  const stop = find(prereqs, "signal-stop-hook");
  assert.equal(stop.status, "error");
  assert.ok(stop.detail && stop.detail.length > 0, "error detail present");
  assert.equal(ok, false);
});

test("a stale installed hook reads as outdated and applyAll refreshes it to ok", async () => {
  // Register both hooks and install a DIFFERENT hook file (simulates version drift).
  writeSettings({
    hooks: {
      Stop: [
        { matcher: "", hooks: [{ type: "command", command: 'node "x/hooks/argus-signal.mjs"' }] },
      ],
      PreToolUse: [
        {
          matcher: "AskUserQuestion",
          hooks: [{ type: "command", command: 'node "x/hooks/argus-signal.mjs" needs-input' }],
        },
      ],
    },
  });
  mkdirSync(path.join(home, "hooks"), { recursive: true });
  writeFileSync(path.join(home, "hooks", "argus-signal.mjs"), "// STALE VERSION\n", "utf8");
  const m = await fresh();
  let prereqs = (await m.checkAll()).prereqs;
  assert.equal(find(prereqs, "signal-stop-hook").status, "outdated");
  assert.equal(find(prereqs, "gate-pretooluse-hook").status, "outdated");

  await m.applyAll();
  prereqs = (await m.checkAll()).prereqs;
  assert.equal(find(prereqs, "signal-stop-hook").status, "ok");
  assert.equal(find(prereqs, "gate-pretooluse-hook").status, "ok");
});

test("argus-data-dir is missing on a fresh home and applyAll creates the dirs", async () => {
  const m = await fresh();
  assert.equal(find((await m.checkAll()).prereqs, "argus-data-dir").status, "missing");
  await m.applyAll();
  assert.ok(existsSync(path.join(home, "argus", "instances")), "instances dir created");
  assert.ok(existsSync(path.join(home, "argus", "runs")), "runs dir created");
  assert.equal(find((await m.checkAll()).prereqs, "argus-data-dir").status, "ok");
});

test("pipelines-parse is ok when absent, error when corrupt", async () => {
  let m = await fresh();
  assert.equal(find((await m.checkAll()).prereqs, "pipelines-parse").status, "ok"); // absent
  mkdirSync(path.join(home, "argus"), { recursive: true });
  writeFileSync(path.join(home, "argus", "pipelines.json"), "{ not json", "utf8");
  m = await fresh();
  const p = find((await m.checkAll()).prereqs, "pipelines-parse");
  assert.equal(p.status, "error");
  assert.ok(p.detail && p.detail.includes("pipelines.json"), "detail names the file");
});

test("settings-parse is error when settings.json is corrupt", async () => {
  writeFileSync(path.join(home, "settings.json"), "{ not json", "utf8");
  const m = await fresh();
  assert.equal(find((await m.checkAll()).prereqs, "settings-parse").status, "error");
});

test("applyAll refuses to clobber a corrupt settings.json", async () => {
  writeFileSync(path.join(home, "settings.json"), "{ not json", "utf8");
  const m = await fresh();
  const { ok, prereqs } = await m.applyAll();
  assert.equal(readFileSync(path.join(home, "settings.json"), "utf8"), "{ not json");
  assert.equal(find(prereqs, "signal-stop-hook").status, "error");
  assert.ok(find(prereqs, "signal-stop-hook").detail.includes("corrupt"));
  assert.equal(ok, false);
});

test("preflight repairs fixable criticals and returns ok when PATH tools resolve", async () => {
  const m = await fresh();
  const res = await m.preflight();
  // node is always on PATH in the test runner; claude may or may not be.
  // The fixable criticals (hooks, data dir) must be repaired regardless.
  assert.ok(
    existsSync(path.join(home, "hooks", "argus-signal.mjs")),
    "hook file installed by preflight",
  );
  assert.ok(existsSync(path.join(home, "argus", "instances")), "data dir created by preflight");
  assert.equal(find((await m.checkAll()).prereqs, "signal-stop-hook").status, "ok");
  assert.ok(Array.isArray(res.reasons));
});

test("probeCommand succeeds for a command on PATH", async () => {
  const m = await fresh();
  const res = m.probeCommand("node");
  assert.equal(res.ok, true);
  assert.equal(res.reason, undefined);
});

test("probeCommand reports why a nonexistent command failed", async () => {
  const m = await fresh();
  const res = m.probeCommand("argus-test-no-such-command-xyz");
  assert.equal(res.ok, false);
  assert.ok(res.reason && res.reason.length > 0, "reason present");
  assert.ok(
    /not found|not recognized|could not be launched|ENOENT/i.test(res.reason),
    `reason explains lookup failure: ${res.reason}`,
  );
});

test("probeCommand reports the exit code of a failing command", async () => {
  const m = await fresh();
  const res = m.probeCommand("node", ["-e", "process.exit(7)"]);
  assert.equal(res.ok, false);
  assert.ok(res.reason?.includes("7"), `reason names exit code: ${res.reason}`);
});

test("probeCommand reports a timeout instead of claiming not-found", async () => {
  const m = await fresh();
  const res = m.probeCommand("node", ["-e", "setTimeout(function(){},10000)"], 500);
  assert.equal(res.ok, false);
  assert.ok(/timed out/i.test(res.reason ?? ""), `reason mentions timeout: ${res.reason}`);
});

test("repairSafeFixables installs the hook file and dirs but never writes settings.json", async () => {
  const m = await fresh();
  await m.repairSafeFixables();
  assert.ok(existsSync(path.join(home, "hooks", "argus-signal.mjs")), "hook file copied");
  assert.ok(existsSync(path.join(home, "argus", "runs")), "runs dir created");
  assert.equal(existsSync(path.join(home, "settings.json")), false, "settings.json NOT written");
});

// ── Runtime scoping ─────────────────────────────────────────────────────────
// Every CLI-and-hooks prerequisite is critical, and `preflight()` refuses a
// pipeline start while a critical one is broken. That makes scoping load-
// bearing rather than cosmetic: without it a Codex-only machine would be
// permanently unable to start anything because Claude Code isn't installed,
// and a Claude-only machine the same in mirror image.

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** A pipelines.json naming a runtime on one of its steps. */
function writePipelineUsing(runtime: string) {
  mkdirSync(path.join(home, "argus"), { recursive: true });
  writeFileSync(
    path.join(home, "argus", "pipelines.json"),
    JSON.stringify([
      {
        id: "p1",
        name: "P",
        phases: [
          {
            id: "a",
            name: "A",
            cwd: home,
            gated: false,
            steps: [{ name: "s", prompt: "p", runtime }],
          },
        ],
        trigger: null,
        enabled: true,
        overlapPolicy: "skip",
        lastStartedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]),
    "utf8",
  );
}

test("Codex prerequisites are not checked while nothing uses Codex", async () => {
  await withEnv(
    { ARGUS_AGENT: "claude", ARGUS_CODEX_HOME: path.join(home, "dot-codex") },
    async () => {
      const m = await fresh();
      const { prereqs } = await m.checkAll();
      assert.equal(find(prereqs, "codex-cli").status, "ok");
      assert.equal(find(prereqs, "codex-signal-hook").status, "ok");
      assert.match(
        find(prereqs, "codex-signal-hook").detail,
        /nothing on this machine runs on Codex/,
      );
    },
  );
});

test("a step that names Codex brings the Codex hook prerequisite into force", async () => {
  writePipelineUsing("codex");
  await withEnv(
    { ARGUS_AGENT: "claude", ARGUS_CODEX_HOME: path.join(home, "dot-codex") },
    async () => {
      const m = await fresh();
      const { prereqs } = await m.checkAll();
      assert.equal(find(prereqs, "codex-signal-hook").status, "missing");
    },
  );
});

test("applying fixes registers the Codex stop hook and installs the hook file", async () => {
  writePipelineUsing("codex");
  const codexHome = path.join(home, "dot-codex");
  await withEnv({ ARGUS_AGENT: "claude", ARGUS_CODEX_HOME: codexHome }, async () => {
    const m = await fresh();
    await m.applyAll();
    const toml = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.match(toml, /\[\[hooks\.stop\]\]/);
    assert.match(toml, /argus-signal\.mjs/);
    assert.ok(existsSync(path.join(codexHome, "hooks", "argus-signal.mjs")), "hook file copied");
    const { prereqs } = await m.checkAll();
    assert.equal(find(prereqs, "codex-signal-hook").status, "ok");
  });
});

test("applying fixes twice leaves exactly one Argus stop hook", async () => {
  writePipelineUsing("codex");
  const codexHome = path.join(home, "dot-codex");
  await withEnv({ ARGUS_AGENT: "claude", ARGUS_CODEX_HOME: codexHome }, async () => {
    const m = await fresh();
    await m.applyAll();
    await m.applyAll();
    const toml = readFileSync(path.join(codexHome, "config.toml"), "utf8");
    assert.equal(toml.match(/\[\[hooks\.stop\]\]/g)?.length, 1);
  });
});

test("Claude prerequisites are not checked on a Codex-only machine", async () => {
  await withEnv(
    { ARGUS_AGENT: "codex", ARGUS_CODEX_HOME: path.join(home, "dot-codex") },
    async () => {
      const m = await fresh();
      const { prereqs } = await m.checkAll();
      assert.equal(find(prereqs, "signal-stop-hook").status, "ok");
      assert.equal(find(prereqs, "gate-pretooluse-hook").status, "ok");
      assert.equal(find(prereqs, "claude-cli").status, "ok");
    },
  );
});

test("a schedule that names Claude brings its hooks back into force", async () => {
  mkdirSync(path.join(home, "argus"), { recursive: true });
  writeFileSync(
    path.join(home, "argus", "schedules.json"),
    JSON.stringify([
      {
        id: "s1",
        name: "S",
        prompt: "p",
        cwd: home,
        trigger: { kind: "daily", time: "02:00" },
        enabled: true,
        overlapPolicy: "skip",
        runtime: "claude",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastRunAt: null,
        lastRunId: null,
      },
    ]),
    "utf8",
  );
  await withEnv(
    { ARGUS_AGENT: "codex", ARGUS_CODEX_HOME: path.join(home, "dot-codex") },
    async () => {
      const m = await fresh();
      const { prereqs } = await m.checkAll();
      assert.equal(find(prereqs, "signal-stop-hook").status, "missing");
    },
  );
});

test("a config.toml with a scalar `stop` under [hooks] is reported, not corrupted", async () => {
  writePipelineUsing("codex");
  const codexHome = path.join(home, "dot-codex");
  mkdirSync(codexHome, { recursive: true });
  const original = '[hooks]\nstop = "echo hi"\n';
  writeFileSync(path.join(codexHome, "config.toml"), original, "utf8");
  await withEnv({ ARGUS_AGENT: "claude", ARGUS_CODEX_HOME: codexHome }, async () => {
    const m = await fresh();
    const { prereqs } = await m.checkAll();
    assert.equal(find(prereqs, "codex-signal-hook").status, "error");
    await m.applyAll();
    assert.equal(readFileSync(path.join(codexHome, "config.toml"), "utf8"), original);
  });
});
