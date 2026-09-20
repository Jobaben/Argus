import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WorkspaceError,
  assertInsideWorktreesRoot,
  createWorktree,
  instanceWorktreesDir,
  plannedRemovals,
  refSegment,
  removeWorktree,
  workspacePolicyFor,
  workspaceTarget,
  worktreeBranch,
  worktreeDirName,
} from "./workspace.js";
import type {
  PhaseDef,
  PipelineDefinition,
  PipelineInstance,
  WorkspaceRecord,
} from "../sources/pipelineTypes.js";

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}

const git = (dir: string, args: string[]) =>
  spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], {
    cwd: dir,
    encoding: "utf8",
  });

/** A repository with one commit and one tracked file. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "argus-ws-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(path.join(dir, "README.md"), "base\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "argus-ws-root-"));
}

// ── Names and paths (pure) ───────────────────────────────────────────────────

test("worktreeDirName: one shared tree per instance, one per attempt otherwise", () => {
  assert.equal(worktreeDirName("instance", "build", 3), "shared");
  assert.equal(worktreeDirName("attempt", "build", 0), "build-attempt0");
  assert.equal(worktreeDirName("attempt", "build", 2), "build-attempt2");
  // A phase id that got past validation cannot leave its directory.
  assert.equal(worktreeDirName("attempt", "../escape", 1), ".._escape-attempt1");
});

test("worktreeBranch: names the instance, the phase and the attempt", () => {
  assert.equal(worktreeBranch("instance", "i1", "build", 0), "argus/i1/shared");
  assert.equal(worktreeBranch("attempt", "i1", "build", 2), "argus/i1/build/2");
});

test("refSegment: keeps a branch component nameable by git", () => {
  assert.equal(refSegment("build"), "build");
  assert.equal(refSegment(".hidden"), "hidden");
  assert.equal(refSegment("thing.lock"), "thing_lock");
  assert.equal(refSegment("a b/c"), "a_b_c");
});

test("workspaceTarget: path under the instance's own directory", () => {
  const target = workspaceTarget({
    root: "/root",
    instanceId: "i1",
    phaseId: "build",
    attempt: 1,
    policy: { scope: "attempt" },
  });
  assert.equal(target.path, path.join("/root", "i1", "build-attempt1"));
  assert.equal(target.branch, "argus/i1/build/1");
  assert.equal(instanceWorktreesDir("/root", "i1"), path.join("/root", "i1"));
});

test("assertInsideWorktreesRoot: the root itself and anything above it are refused", () => {
  assert.throws(() => assertInsideWorktreesRoot("/root", "/root"), WorkspaceError);
  assert.throws(() => assertInsideWorktreesRoot("/root", "/root/../elsewhere"), WorkspaceError);
  assert.throws(() => assertInsideWorktreesRoot("/root", "/etc/passwd"), WorkspaceError);
  assert.doesNotThrow(() => assertInsideWorktreesRoot("/root", "/root/i1/shared"));
});

test("workspacePolicyFor: the phase's policy wins over the pipeline's", () => {
  const def = { workspace: { scope: "instance" as const } };
  assert.deepEqual(workspacePolicyFor(def, undefined), { scope: "instance" });
  assert.deepEqual(workspacePolicyFor(def, { workspace: { scope: "attempt" } }), {
    scope: "attempt",
  });
  assert.equal(workspacePolicyFor({}, {}), undefined);
});

// ── createWorktree / removeWorktree (real repositories) ──────────────────────

test("createWorktree: a real worktree on a new branch, cut from HEAD", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = await makeRepo();
  const root = await makeRoot();
  try {
    const target = workspaceTarget({
      root,
      instanceId: "i1",
      phaseId: "build",
      attempt: 0,
      policy: { scope: "attempt" },
    });
    const record = await createWorktree({ repoCwd: repo, ...target, root });
    assert.equal(record.path, target.path);
    assert.equal(record.branch, "argus/i1/build/0");
    assert.equal(record.base, "HEAD");
    assert.match(record.baseHead, /^[0-9a-f]{40}$/);
    // The base commit's content is there, and the tree is on its own branch.
    assert.equal(await readFile(path.join(target.path, "README.md"), "utf8"), "base\n");
    assert.equal(
      git(target.path, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim(),
      "argus/i1/build/0",
    );
    assert.equal(git(repo, ["rev-parse", record.branch]).stdout.trim(), record.baseHead);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorktree: base names the ref, and an unresolvable one explains itself", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = await makeRepo();
  const root = await makeRoot();
  try {
    const first = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(repo, "later.txt"), "later\n", "utf8");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "later"]);

    const record = await createWorktree({
      repoCwd: repo,
      path: path.join(root, "i1", "a"),
      branch: "argus/i1/a",
      base: first,
      root,
    });
    assert.equal(record.baseHead, first);
    assert.equal(record.base, first);
    // Cut from the first commit: the second commit's file is not in the tree.
    assert.equal(existsSync(path.join(record.path, "later.txt")), false);

    await assert.rejects(
      createWorktree({
        repoCwd: repo,
        path: path.join(root, "i1", "b"),
        branch: "argus/i1/b",
        base: "no-such-ref",
        root,
      }),
      (e: unknown) =>
        e instanceof WorkspaceError && /cannot resolve base "no-such-ref"/.test(e.message),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorktree: a directory that is already the worktree is reused", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = await makeRepo();
  const root = await makeRoot();
  try {
    const input = {
      repoCwd: repo,
      path: path.join(root, "i1", "shared"),
      branch: "argus/i1/shared",
      root,
    };
    const first = await createWorktree(input);
    await writeFile(path.join(first.path, "work.txt"), "in progress\n", "utf8");
    const again = await createWorktree(input);
    assert.deepEqual(again, first);
    // Reuse, not recreate: the uncommitted work is still there.
    assert.equal(await readFile(path.join(first.path, "work.txt"), "utf8"), "in progress\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorktree: an existing branch whose directory is gone is checked out again", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = await makeRepo();
  const root = await makeRoot();
  try {
    const input = {
      repoCwd: repo,
      path: path.join(root, "i1", "shared"),
      branch: "argus/i1/shared",
      root,
    };
    const first = await createWorktree(input);
    await writeFile(path.join(first.path, "committed.txt"), "kept\n", "utf8");
    git(first.path, ["add", "."]);
    git(first.path, ["commit", "-q", "-m", "phase work"]);
    // The directory goes; the branch stays — an Argus restart after a cleanup.
    await removeWorktree({ repoCwd: repo, path: first.path, root });
    assert.equal(existsSync(first.path), false);

    const again = await createWorktree(input);
    assert.equal(again.branch, first.branch);
    // The branch's commits come back with it, rather than being cut afresh.
    assert.equal(await readFile(path.join(again.path, "committed.txt"), "utf8"), "kept\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorktree: a cwd that is not a git work tree is refused, with git's words", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const plain = await mkdtemp(path.join(tmpdir(), "argus-ws-plain-"));
  const root = await makeRoot();
  try {
    await assert.rejects(
      createWorktree({
        repoCwd: plain,
        path: path.join(root, "i1", "shared"),
        branch: "argus/i1/shared",
        root,
      }),
      (e: unknown) =>
        e instanceof WorkspaceError && e.message.includes("is not inside a git work tree"),
    );
  } finally {
    await rm(plain, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorktree: a foreign directory in the way is refused, not clobbered", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = await makeRepo();
  const root = await makeRoot();
  const target = path.join(root, "i1", "shared");
  try {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "someone-elses.txt"), "mine\n", "utf8");
    await assert.rejects(
      createWorktree({ repoCwd: repo, path: target, branch: "argus/i1/shared", root }),
      WorkspaceError,
    );
    assert.equal(existsSync(path.join(target, "someone-elses.txt")), true);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("createWorktree / removeWorktree: a path outside the worktrees root is refused", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = await makeRepo();
  const root = await makeRoot();
  const escape = path.join(root, "..", "elsewhere");
  try {
    await assert.rejects(
      createWorktree({ repoCwd: repo, path: escape, branch: "argus/i1/x", root }),
      WorkspaceError,
    );
    await assert.rejects(removeWorktree({ repoCwd: repo, path: escape, root }), WorkspaceError);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("removeWorktree: the directory goes, the branch stays, and it is idempotent", async (t) => {
  if (!gitAvailable()) return t.skip("git not available");
  const repo = await makeRepo();
  const root = await makeRoot();
  try {
    const record = await createWorktree({
      repoCwd: repo,
      path: path.join(root, "i1", "shared"),
      branch: "argus/i1/shared",
      root,
    });
    // Uncommitted work is exactly what --force is for.
    await writeFile(path.join(record.path, "scratch.txt"), "dirty\n", "utf8");

    await removeWorktree({ repoCwd: repo, path: record.path, root });
    assert.equal(existsSync(record.path), false);
    assert.equal(git(repo, ["rev-parse", "--verify", record.branch]).status, 0);
    assert.ok(!git(repo, ["worktree", "list"]).stdout.includes(record.path));

    // Again, on a path that is already gone.
    await removeWorktree({ repoCwd: repo, path: record.path, root });
    assert.equal(existsSync(record.path), false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

// ── plannedRemovals (pure) ───────────────────────────────────────────────────

const record = (p: string, branch = "argus/i1/b"): WorkspaceRecord => ({
  path: p,
  branch,
  base: "HEAD",
  baseHead: "abc",
});

function defOf(phases: Partial<PhaseDef>[], workspace?: PipelineDefinition["workspace"]) {
  return {
    phases: phases.map((p, i) => ({
      id: p.id ?? `p${i}`,
      name: p.id ?? `p${i}`,
      cwd: p.cwd ?? "/repo",
      steps: [],
      gated: false,
      ...p,
    })) as PhaseDef[],
    ...(workspace ? { workspace } : {}),
  };
}

function instOf(
  phases: { id: string; workspace?: WorkspaceRecord }[],
  workspace?: WorkspaceRecord,
): Pick<PipelineInstance, "phases" | "workspace"> {
  return {
    phases: phases.map((p) => ({
      id: p.id,
      name: p.id,
      gated: false,
      status: "succeeded" as const,
      steps: [],
      attempt: 0,
      payload: null,
      ...(p.workspace ? { workspace: p.workspace } : {}),
    })),
    ...(workspace ? { workspace } : {}),
  };
}

test("plannedRemovals: every attempt tree, in the phase's own repository", () => {
  const def = defOf([
    { id: "a", cwd: "/repo-a", workspace: { scope: "attempt" } },
    { id: "b", cwd: "/repo-b", workspace: { scope: "attempt" } },
  ]);
  const inst = instOf([
    { id: "a", workspace: record("/w/i1/a-attempt0") },
    { id: "b", workspace: record("/w/i1/b-attempt1") },
  ]);
  assert.deepEqual(
    plannedRemovals(def, inst).map((r) => [r.repoCwd, r.path]),
    [
      ["/repo-a", "/w/i1/a-attempt0"],
      ["/repo-b", "/w/i1/b-attempt1"],
    ],
  );
});

test("plannedRemovals: keep leaves the tree alone", () => {
  const def = defOf([{ id: "a", workspace: { scope: "attempt", keep: true } }]);
  const inst = instOf([{ id: "a", workspace: record("/w/i1/a-attempt0") }]);
  assert.deepEqual(plannedRemovals(def, inst), []);
});

test("plannedRemovals: the shared tree is listed once, and kept if any phase keeps it", () => {
  const shared = record("/w/i1/shared", "argus/i1/shared");
  const def = defOf([{ id: "a" }, { id: "b" }], { scope: "instance" });
  const inst = instOf(
    [
      { id: "a", workspace: shared },
      { id: "b", workspace: shared },
    ],
    shared,
  );
  assert.deepEqual(
    plannedRemovals(def, inst).map((r) => r.path),
    ["/w/i1/shared"],
  );

  const keeping = defOf([{ id: "a" }, { id: "b", workspace: { scope: "instance", keep: true } }], {
    scope: "instance",
  });
  assert.deepEqual(plannedRemovals(keeping, inst), []);
});

test("plannedRemovals: nothing recorded, nothing removed", () => {
  assert.deepEqual(plannedRemovals(defOf([{ id: "a" }]), instOf([{ id: "a" }])), []);
});
