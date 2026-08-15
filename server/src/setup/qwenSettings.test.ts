import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A fresh `~/.qwen` per case, since the installer is a read-modify-write. */
function freshHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-qwen-settings-"));
  process.env.ARGUS_QWEN_HOME = dir;
  return dir;
}

async function load() {
  // Imported per case so `qwenPaths` resolves against the home just set.
  return import("./qwenSettings.js");
}

function settingsOf(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

test("installing writes a Stop hook Argus recognizes on the next check", async () => {
  const home = freshHome();
  const { hasArgusStopHook, installQwenStopHook, readQwenSettings } = await load();
  assert.equal(hasArgusStopHook(await readQwenSettings()), false);
  await installQwenStopHook();
  assert.equal(hasArgusStopHook(await readQwenSettings()), true);
  const stop = (settingsOf(home).hooks as Record<string, unknown>).Stop as {
    hooks: { type: string; command: string }[];
  }[];
  assert.equal(stop[0].hooks[0].type, "command");
  assert.ok(stop[0].hooks[0].command.includes("argus-signal.mjs"));
});

test("installing twice registers one hook, not two", async () => {
  const home = freshHome();
  const { installQwenStopHook } = await load();
  await installQwenStopHook();
  await installQwenStopHook();
  const stop = (settingsOf(home).hooks as Record<string, unknown>).Stop as unknown[];
  assert.equal(stop.length, 1);
});

test("the operator's other settings and hooks survive the write", async () => {
  const home = freshHome();
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({
      general: { vimMode: true },
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "say done" }] }],
        PreToolUse: [{ matcher: "run_shell_command", hooks: [] }],
      },
    }),
  );
  const { installQwenStopHook } = await load();
  await installQwenStopHook();
  const after = settingsOf(home);
  assert.deepEqual(after.general, { vimMode: true });
  const hooks = after.hooks as Record<string, unknown>;
  const stop = hooks.Stop as { hooks: { command: string }[] }[];
  assert.equal(stop.length, 2, "the operator's own Stop hook must still be there");
  assert.equal(stop[0].hooks[0].command, "say done");
  assert.ok(hooks.PreToolUse, "unrelated events are untouched");
});

test("a corrupt settings.json is refused rather than clobbered", async () => {
  const home = freshHome();
  const file = path.join(home, "settings.json");
  writeFileSync(file, "{ this is not json");
  const { installQwenStopHook } = await load();
  await assert.rejects(installQwenStopHook(), /corrupt/);
  assert.equal(readFileSync(file, "utf8"), "{ this is not json");
});

test("another tool's Stop hook is not mistaken for Argus's", async () => {
  freshHome();
  const { hasArgusStopHook } = await load();
  assert.equal(
    hasArgusStopHook({
      hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "node other.mjs" }] }] },
    }),
    false,
  );
  // A hand-edited file can hold anything; the check reads it, it doesn't trust it.
  assert.equal(hasArgusStopHook({ hooks: { Stop: "argus-signal" } }), false);
  assert.equal(hasArgusStopHook({}), false);
});

test("the hook is copied under the Qwen home, where the CLI will look for it", async () => {
  const home = freshHome();
  const { copyQwenHookFile, qwenHookCommand } = await load();
  const src = path.join(home, "src-argus-signal.mjs");
  writeFileSync(src, "// hook\n");
  await copyQwenHookFile(src);
  assert.equal(readFileSync(path.join(home, "hooks", "argus-signal.mjs"), "utf8"), "// hook\n");
  assert.ok(qwenHookCommand().startsWith('node "'));
  assert.ok(qwenHookCommand().includes("argus-signal.mjs"));
});

test("a missing settings.json is a fresh start, not an error", async () => {
  const home = freshHome();
  mkdirSync(path.join(home, "nested"), { recursive: true });
  const { readQwenSettings, installQwenStopHook, hasArgusStopHook } = await load();
  assert.deepEqual(await readQwenSettings(), {});
  await installQwenStopHook();
  assert.equal(hasArgusStopHook(await readQwenSettings()), true);
});
