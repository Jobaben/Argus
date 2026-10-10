import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempRoot } from "../testSupport.js";
import { defaultH1Sources, gatherGateReview } from "./collect.js";
import { gateInstance, gateRun, gateWorld } from "./testSupport.js";

/**
 * The collector over a real git repository (RFC §Q.4): changed files and line
 * counts against the attempt worktree's recorded base, the existing
 * repository-state type, and a read that never rewrites the index.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
    .toString()
    .trim();

function repo() {
  const dir = path.join(tempRoot("argus-h1-git-"), "wt");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(path.join(dir, "keep.txt"), "same\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

function sourcesFor(world: ReturnType<typeof gateWorld>) {
  // Real git readers; the gate world in memory for everything else.
  const real = defaultH1Sources();
  return {
    ...world.sources(),
    workingTree: real.workingTree,
    committedSince: real.committedSince,
    numstat: real.numstat,
  };
}

test("changed files and diff statistics against the worktree base, without reading content or touching the index", async () => {
  const { dir, base } = repo();
  // Committed work, an uncommitted edit and an untracked file.
  writeFileSync(path.join(dir, "b.txt"), "new\n");
  git(dir, "add", "b.txt");
  git(dir, "commit", "-q", "-m", "work");
  writeFileSync(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(path.join(dir, "untracked.txt"), "secret content never read into the body\n");
  // A stat-dirty index: touching a file makes a plain `git status` want to refresh it.
  const index = path.join(dir, ".git", "index");
  const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs };

  const world = gateWorld();
  const inst = gateInstance({
    phase: { workspace: { path: dir, branch: "argus/x", base: "main", baseHead: base } },
  });
  world.put(inst);
  const input = await gatherGateReview(
    sourcesFor(world),
    inst,
    inst.phases[0],
    inst.definition,
    new Date(),
    {},
  );
  const files = input.changes.files;
  assert.equal(files.status, "available");
  assert.deepEqual(files.status === "available" && [...files.paths].sort(), [
    "a.txt",
    "b.txt",
    "untracked.txt",
  ]);
  assert.deepEqual(input.changes.diffStat, {
    status: "available",
    files: 2,
    insertions: 3,
    deletions: 1,
    binary: 0,
  });
  const repoState = input.changes.repository!;
  assert.equal(repoState.gitHead, git(dir, "rev-parse", "HEAD"));
  assert.equal(repoState.workingTree?.dirty, 2);
  assert.ok(!JSON.stringify(input.changes).includes("secret content"));
  assert.deepEqual(readFileSync(index), before.bytes, "the index is not rewritten");
  assert.equal(statSync(index).mtimeMs, before.mtime);
});

test("with no worktree and no recorded baseline, changes are unavailable, never empty", async () => {
  const world = gateWorld();
  const inst = gateInstance();
  world.put(inst);
  world.runs.set("run-a", gateRun("run-a"));
  const input = await gatherGateReview(
    defaultH1Sources(),
    inst,
    inst.phases[0],
    inst.definition,
    new Date(),
    {},
  );
  assert.equal(input.changes.files.status, "unavailable");
  assert.equal(input.changes.diffStat.status, "unavailable");
  assert.equal(input.changes.repository, null);
});

test("a worktree path that is not a git work tree is unavailable", async () => {
  const world = gateWorld();
  const dir = tempRoot("argus-h1-nogit-");
  const inst = gateInstance({
    phase: { workspace: { path: dir, branch: "b", base: "main", baseHead: "0".repeat(40) } },
  });
  world.put(inst);
  const input = await gatherGateReview(
    sourcesFor(world),
    inst,
    inst.phases[0],
    inst.definition,
    new Date(),
    {},
  );
  assert.equal(input.changes.files.status, "unavailable");
});
