/**
 * Test preload: never let a test read the developer's real agent homes.
 *
 * Almost every test file sets `ARGUS_CLAUDE_HOME` to a fresh temp directory,
 * because the readers resolve their paths from it. Nothing did that for
 * `ARGUS_CODEX_HOME`, and once the Sessions list, transcript search and the
 * setup prerequisites learned to read `~/.codex`, that gap became real: on a
 * machine that actually uses Codex, a test asserting "one session in this temp
 * home" would find the developer's rollouts too and fail — on their box only,
 * which is the least debuggable kind of failure there is.
 *
 * Defaulting the variable here, once, fixes it for every file at the same time
 * and cannot be forgotten by the next test that needs it. A test that wants a
 * *populated* Codex home still sets the variable itself and wins, because this
 * only fills in a value when none was provided.
 *
 * Loaded via `tsx --import` from the `test` scripts, so it runs before any test
 * module — and only under those scripts, so production resolution is untouched.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

if (!process.env.ARGUS_CODEX_HOME?.trim()) {
  process.env.ARGUS_CODEX_HOME = mkdtempSync(path.join(tmpdir(), "argus-test-codex-"));
}
