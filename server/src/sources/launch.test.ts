import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LaunchValidationError, validateLaunchInput } from "./launch.js";

const cwd = mkdtempSync(path.join(tmpdir(), "argus-launch-"));

test("accepts a minimal launch and trims fields", () => {
  const input = validateLaunchInput({ prompt: "  do the thing  ", cwd });
  assert.equal(input.prompt, "do the thing");
  assert.equal(input.cwd, cwd);
  assert.equal(input.model, undefined);
});

test("derives the name from the prompt's first line when omitted", () => {
  const input = validateLaunchInput({ prompt: "summarize the repo\nsecond line ignored", cwd });
  assert.equal(input.name, "summarize the repo");
});

test("ellipsizes a derived name past 60 chars", () => {
  const input = validateLaunchInput({ prompt: "x".repeat(80), cwd });
  assert.equal(input.name.length, 60);
  assert.ok(input.name.endsWith("…"));
});

test("keeps an explicit name and model", () => {
  const input = validateLaunchInput({ name: " Audit ", prompt: "p", cwd, model: "haiku" });
  assert.equal(input.name, "Audit");
  assert.equal(input.model, "haiku");
});

test("rejects a missing prompt", () => {
  assert.throws(() => validateLaunchInput({ cwd }), LaunchValidationError);
  assert.throws(() => validateLaunchInput({ prompt: "   ", cwd }), LaunchValidationError);
});

test("rejects a missing or nonexistent cwd", () => {
  assert.throws(() => validateLaunchInput({ prompt: "p" }), LaunchValidationError);
  assert.throws(
    () => validateLaunchInput({ prompt: "p", cwd: path.join(cwd, "nope") }),
    LaunchValidationError,
  );
});

test("rejects a blank model and a non-string name", () => {
  assert.throws(
    () => validateLaunchInput({ prompt: "p", cwd, model: "  " }),
    LaunchValidationError,
  );
  assert.throws(() => validateLaunchInput({ prompt: "p", cwd, name: 7 }), LaunchValidationError);
});
