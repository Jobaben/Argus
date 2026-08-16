/**
 * Test preload: never let a test read — or write — the developer's real agent
 * homes.
 *
 * Almost every test file sets `ARGUS_CLAUDE_HOME` to a fresh temp directory,
 * because the readers resolve their paths from it. Nothing did that for
 * `ARGUS_CODEX_HOME`, and once the Sessions list, transcript search and the
 * setup prerequisites learned to read `~/.codex`, that gap became real: on a
 * machine that actually uses Codex, a test asserting "one session in this temp
 * home" would find the developer's rollouts too and fail — on their box only,
 * which is the least debuggable kind of failure there is.
 *
 * The stakes went up with Qwen Code, whose signal hook Argus *registers* in
 * `~/.qwen/settings.json`: an unscoped `applyAll()` in a test would edit the
 * developer's own CLI configuration. So every agent home Argus knows about is
 * defaulted here, once, which fixes it for every file at the same time and
 * cannot be forgotten by the next test that needs it. A test that wants a
 * *populated* home still sets the variable itself and wins, because this only
 * fills in a value when none was provided.
 *
 * Loaded via `tsx --import` from the `test` scripts, so it runs before any test
 * module — and only under those scripts, so production resolution is untouched.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const [variable, prefix] of [
  ["ARGUS_CODEX_HOME", "argus-test-codex-"],
  ["ARGUS_OPENCODE_HOME", "argus-test-opencode-"],
  ["ARGUS_QWEN_HOME", "argus-test-qwen-"],
] as const) {
  if (!process.env[variable]?.trim()) {
    process.env[variable] = mkdtempSync(path.join(tmpdir(), prefix));
  }
}
