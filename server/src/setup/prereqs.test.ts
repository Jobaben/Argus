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

test("a Stop hook referencing argus-signal reads back as ok", async () => {
  writeSettings({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: 'node "x/hooks/argus-signal.mjs"' }] }] } });
  const m = await fresh();
  const { prereqs } = await m.checkAll();
  assert.equal(find(prereqs, "signal-stop-hook").status, "ok");
});

test("gate hook requires both AskUserQuestion matcher and needs-input", async () => {
  writeSettings({ hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: 'node "x/hooks/argus-signal.mjs" needs-input' }] }] } });
  const m = await fresh();
  const { prereqs } = await m.checkAll();
  assert.equal(find(prereqs, "gate-pretooluse-hook").status, "ok");
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
  assert.ok(stopCmds.some((c: string) => c.includes("argus-signal")), "Stop hook registered");
  const { prereqs } = await m.checkAll();
  assert.equal(find(prereqs, "signal-stop-hook").status, "ok");
  assert.equal(find(prereqs, "gate-pretooluse-hook").status, "ok");
});

test("applyAll preserves a pre-existing unrelated Stop hook", async () => {
  writeSettings({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "~/.claude/hooks/bmad-runlog-autoclose.sh", timeout: 5 }] }] } });
  const m = await fresh();
  await m.applyAll();
  const settings = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
  const stopCmds = settings.hooks.Stop.flatMap((g: any) => g.hooks).map((h: any) => h.command);
  assert.ok(stopCmds.some((c: string) => c.includes("bmad-runlog-autoclose")), "existing hook preserved");
  assert.ok(stopCmds.some((c: string) => c.includes("argus-signal")), "new hook added");
});

test("applyAll is idempotent — no duplicate entries on re-apply", async () => {
  const m = await fresh();
  await m.applyAll();
  await m.applyAll();
  const settings = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
  const stopCmds = settings.hooks.Stop.flatMap((g: any) => g.hooks).map((h: any) => h.command)
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
