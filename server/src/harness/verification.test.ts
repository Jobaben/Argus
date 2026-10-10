import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  changedSince,
  checkLabel,
  runCheck,
  runChecks,
  snapshotWorkingTree,
  type CheckContext,
} from "./verification.js";
import type { PhaseCheck } from "../sources/pipelineTypes.js";

function gitAvailable(): boolean {
  try {
    const res = spawnSync("git", ["--version"]);
    return res.status === 0;
  } catch {
    return false;
  }
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-verify-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: dir });
  run(["init", "-q"]);
  run([
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "init",
  ]);
  return dir;
}

function baseCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    cwd: overrides.cwd ?? process.cwd(),
    artifactDir: overrides.artifactDir ?? null,
    baseline: overrides.baseline ?? null,
    ...overrides,
  };
}

// ── checkLabel ────────────────────────────────────────────────────────────

test("checkLabel: uses explicit label when set", () => {
  const check: PhaseCheck = { kind: "command", run: "echo hi", label: "my label" };
  assert.equal(checkLabel(check), "my label");
});

test("checkLabel: command clips to 80 chars", () => {
  const longRun = "x".repeat(200);
  const check: PhaseCheck = { kind: "command", run: longRun };
  const label = checkLabel(check);
  assert.ok(label.length <= 80, `expected <=80 chars, got ${label.length}`);
  assert.ok(label.startsWith("command: "));
});

test("checkLabel: artifact/file/changed-files defaults", () => {
  assert.equal(checkLabel({ kind: "artifact", path: "out.txt" }), "artifact: out.txt");
  assert.equal(checkLabel({ kind: "file", path: "out.txt" }), "file: out.txt");
  assert.equal(checkLabel({ kind: "changed-files" }), "changed files");
});

// ── command checks ───────────────────────────────────────────────────────

test("command check: passes on exit 0", async () => {
  const ctx = baseCtx();
  const res = await runCheck({ kind: "command", run: "exit 0" }, ctx);
  assert.equal(res.status, "passed");
  assert.equal(res.exitCode, 0);
  assert.match(res.detail, /^exit 0 in \d+ms$/);
});

test("command check: fails on nonzero exit", async () => {
  const ctx = baseCtx();
  const res = await runCheck({ kind: "command", run: "exit 3" }, ctx);
  assert.equal(res.status, "failed");
  assert.equal(res.exitCode, 3);
  assert.equal(res.detail, "exit 3");
});

test("command check: times out and kills the process group", async () => {
  const ctx = baseCtx();
  const start = Date.now();
  const res = await runCheck(
    {
      kind: "command",
      run: `node -e "setTimeout(()=>{}, 10000)"`,
      timeoutSeconds: 1,
    },
    ctx,
  );
  const elapsed = Date.now() - start;
  assert.equal(res.status, "failed");
  assert.match(res.detail, /timed out/);
  assert.ok(elapsed < 8000, `expected well under 10s, took ${elapsed}ms`);
});

test("command check: output tail is bounded to the last characters", async () => {
  const ctx = baseCtx();
  // Print far more than the tail window, with a distinguishable final marker.
  const res = await runCheck(
    {
      kind: "command",
      run: `node -e "for (let i=0;i<20000;i++) process.stdout.write('x'); process.stdout.write('END-MARKER')"`,
    },
    ctx,
  );
  assert.equal(res.status, "passed");
  assert.ok(res.output !== undefined);
  assert.ok(res.output!.length <= 4000);
  assert.ok(res.output!.endsWith("END-MARKER"));
});

test("command check: nonexistent cwd fails cleanly", async () => {
  const ctx = baseCtx();
  const res = await runCheck({ kind: "command", run: "exit 0", cwd: "does/not/exist" }, ctx);
  assert.equal(res.status, "failed");
  assert.match(res.detail, /does not exist/);
});

test("command check: a cwd that resolves to a file (not a directory) fails cleanly", async () => {
  const ctx = baseCtx();
  const dir = await mkdtemp(path.join(tmpdir(), "argus-verify-file-"));
  const filePath = path.join(dir, "afile");
  await writeFile(filePath, "x");
  const res = await runCheck(
    { kind: "command", run: "exit 0", cwd: path.relative(ctx.cwd, filePath) },
    ctx,
  );
  assert.equal(res.status, "failed");
  await rm(dir, { recursive: true, force: true });
});

// ── artifact / file checks ────────────────────────────────────────────────

test("artifact check: passes when file present and large enough", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-verify-art-"));
  await writeFile(path.join(dir, "report.txt"), "hello world");
  const ctx = baseCtx({ artifactDir: dir });
  const res = await runCheck({ kind: "artifact", path: "report.txt" }, ctx);
  assert.equal(res.status, "passed");
  assert.equal(res.detail, "11 bytes");
  await rm(dir, { recursive: true, force: true });
});

test("artifact check: fails when missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-verify-art-"));
  const ctx = baseCtx({ artifactDir: dir });
  const res = await runCheck({ kind: "artifact", path: "nope.txt" }, ctx);
  assert.equal(res.status, "failed");
  assert.equal(res.detail, "missing");
  await rm(dir, { recursive: true, force: true });
});

test("artifact check: fails when no artifact directory", async () => {
  const ctx = baseCtx({ artifactDir: null });
  const res = await runCheck({ kind: "artifact", path: "x.txt" }, ctx);
  assert.equal(res.status, "failed");
  assert.equal(res.detail, "phase has no artifact directory");
});

test("artifact check: rejects absolute path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-verify-art-"));
  const ctx = baseCtx({ artifactDir: dir });
  const res = await runCheck({ kind: "artifact", path: "/etc/passwd" }, ctx);
  assert.equal(res.status, "failed");
  assert.match(res.detail, /escapes/);
  await rm(dir, { recursive: true, force: true });
});

test("artifact check: rejects escaping path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-verify-art-"));
  const ctx = baseCtx({ artifactDir: dir });
  const res = await runCheck({ kind: "artifact", path: "../x" }, ctx);
  assert.equal(res.status, "failed");
  assert.match(res.detail, /escapes/);
  await rm(dir, { recursive: true, force: true });
});

test("artifact check: below minBytes fails as empty", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-verify-art-"));
  await writeFile(path.join(dir, "small.txt"), "ab");
  const ctx = baseCtx({ artifactDir: dir });
  const res = await runCheck({ kind: "artifact", path: "small.txt", minBytes: 10 }, ctx);
  assert.equal(res.status, "failed");
  assert.equal(res.detail, "empty (2 bytes, need 10)");
  await rm(dir, { recursive: true, force: true });
});

test("file check: rooted at cwd, not artifactDir", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-verify-file-"));
  const artDir = await mkdtemp(path.join(tmpdir(), "argus-verify-art2-"));
  await writeFile(path.join(dir, "result.json"), "{}");
  const ctx = baseCtx({ cwd: dir, artifactDir: artDir });
  const res = await runCheck({ kind: "file", path: "result.json" }, ctx);
  assert.equal(res.status, "passed");
  // Confirm it did NOT look in artifactDir: put a decoy there with a different name.
  const missing = await runCheck({ kind: "file", path: "notfound.json" }, ctx);
  assert.equal(missing.status, "failed");
  await rm(dir, { recursive: true, force: true });
  await rm(artDir, { recursive: true, force: true });
});

// ── changed-files checks ───────────────────────────────────────────────────

test("changed-files: no baseline fails", async () => {
  const ctx = baseCtx({ baseline: null });
  const res = await runCheck({ kind: "changed-files" }, ctx);
  assert.equal(res.status, "failed");
  assert.match(res.detail, /no working-tree baseline/);
});

test("changed-files: detects a newly created file", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);
  await writeFile(path.join(dir, "new.txt"), "new content");
  const ctx = baseCtx({ cwd: dir, baseline });
  const res = await runCheck({ kind: "changed-files" }, ctx);
  assert.equal(res.status, "passed");
  assert.equal(res.detail, "1 changed file(s)");
  assert.ok(res.output?.includes("new.txt"));
  await rm(dir, { recursive: true, force: true });
});

test("changed-files: modifying an already-dirty file is detected via hash", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  await writeFile(path.join(dir, "dirty.txt"), "version 1");
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);
  assert.ok("dirty.txt" in baseline.dirty);
  await writeFile(path.join(dir, "dirty.txt"), "version 2 - different");
  const ctx = baseCtx({ cwd: dir, baseline });
  const res = await runCheck({ kind: "changed-files" }, ctx);
  assert.equal(res.status, "passed");
  assert.ok(res.output?.includes("dirty.txt"));
  await rm(dir, { recursive: true, force: true });
});

test("changed-files: unchanged dirty file is not reported", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  await writeFile(path.join(dir, "stable.txt"), "stays the same");
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);
  const current = await snapshotWorkingTree(dir);
  assert.ok(current);
  const changed = changedSince(baseline, current);
  assert.deepEqual(changed, []);
  await rm(dir, { recursive: true, force: true });
});

test("changed-files: requireChanges fails when nothing changed", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);
  const ctx = baseCtx({ cwd: dir, baseline });
  const res = await runCheck({ kind: "changed-files", requireChanges: true }, ctx);
  assert.equal(res.status, "failed");
  assert.equal(res.detail, "no files changed");
  await rm(dir, { recursive: true, force: true });
});

test("changed-files: allow glob restricts which paths are acceptable", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.ts"), "code");
  await writeFile(path.join(dir, "readme.md"), "docs");
  const ctx = baseCtx({ cwd: dir, baseline });

  const passing = await runCheck({ kind: "changed-files", allow: ["src/**", "*.md"] }, ctx);
  assert.equal(passing.status, "passed");

  const failing = await runCheck({ kind: "changed-files", allow: ["src/**"] }, ctx);
  assert.equal(failing.status, "failed");
  assert.match(failing.detail, /readme\.md/);
  await rm(dir, { recursive: true, force: true });
});

test("changed-files: deny glob rejects matching paths", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const dir = await makeRepo();
  const baseline = await snapshotWorkingTree(dir);
  assert.ok(baseline);
  await writeFile(path.join(dir, "secret.env"), "TOKEN=x");
  const ctx = baseCtx({ cwd: dir, baseline });
  const res = await runCheck({ kind: "changed-files", deny: ["*.env"] }, ctx);
  assert.equal(res.status, "failed");
  assert.match(res.detail, /secret\.env/);
  await rm(dir, { recursive: true, force: true });
});

// ── runChecks aggregation ──────────────────────────────────────────────────

test("runChecks: runs every check and aggregates status (all pass)", async () => {
  const ctx = baseCtx();
  const checks: PhaseCheck[] = [
    { kind: "command", run: "exit 0" },
    { kind: "command", run: "exit 0" },
  ];
  const report = await runChecks(checks, ctx);
  assert.equal(report.status, "passed");
  assert.equal(report.checks.length, 2);
  assert.ok(report.startedAt);
  assert.ok(report.endedAt);
});

test("runChecks: does not stop early on a failure, and reports failed overall", async () => {
  const ctx = baseCtx();
  const checks: PhaseCheck[] = [
    { kind: "command", run: "exit 1", label: "first" },
    { kind: "command", run: "exit 0", label: "second" },
    { kind: "command", run: "exit 0", label: "third" },
  ];
  const report = await runChecks(checks, ctx);
  assert.equal(report.status, "failed");
  assert.equal(report.checks.length, 3);
  assert.equal(report.checks[0].status, "failed");
  assert.equal(report.checks[1].status, "passed");
  assert.equal(report.checks[2].status, "passed");
});

test("runChecks: uses the injected now() for started/ended timestamps", async () => {
  const times = [new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:05.000Z")];
  let i = 0;
  const ctx = baseCtx({ now: () => times[Math.min(i++, times.length - 1)] });
  const report = await runChecks([{ kind: "command", run: "exit 0" }], ctx);
  assert.equal(report.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(report.endedAt, "2026-01-01T00:00:05.000Z");
});
