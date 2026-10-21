import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { paths } from "../claudeHome.js";
import { instanceTriggerPayloadPath } from "../harness/invocation.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-instances-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

async function fresh() {
  return import(`./instances.js?${Math.random()}`);
}

const makeInstance = (id: string, pipelineId: string, createdAt: string) => ({
  id,
  pipelineId,
  pipelineName: "feature pipeline",
  status: "running" as const,
  currentPhaseIndex: 0,
  phases: [
    {
      id: "p0",
      name: "P0",
      gated: false,
      status: "running" as const,
      steps: [],
      attempt: 0,
      payload: null,
    },
  ],
  trigger: "manual" as const,
  signalToken: "tok",
  createdAt,
  updatedAt: createdAt,
  endedAt: null,
});

test("writeInstance then readInstance round-trips", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("i1", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  const got = await m.readInstance("i1");
  assert.equal(got?.id, "i1");
  assert.equal(got?.signalToken, "tok");
});

test("readInstances filters by pipeline, newest first", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("a", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  await m.writeInstance(makeInstance("b", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));
  await m.writeInstance(makeInstance("c", "p2", new Date(2026, 5, 30, 11, 0).toISOString()));
  const p1 = await m.readInstances({ pipelineId: "p1" });
  assert.deepEqual(
    p1.map((i: { id: string }) => i.id),
    ["b", "a"],
  );
});

test("pruneInstances keeps only newest N of a pipeline", async () => {
  const m = await fresh();
  for (let i = 0; i < 5; i++) {
    await m.writeInstance(makeInstance(`r${i}`, "p1", new Date(2026, 5, 30, 9, i).toISOString()));
  }
  await m.pruneInstances("p1", 2);
  const left = await m.readInstances({ pipelineId: "p1" });
  assert.deepEqual(
    left.map((i: { id: string }) => i.id),
    ["r4", "r3"],
  );
});

test("ensureTriggerPayloadFile writes the payload once, puts an edited or deleted copy back, and writes nothing without one", async () => {
  const m = await fresh();
  const payload = { task: { id: "T1", files: ["src/a.ts"] }, base: "main" };
  const file = await m.ensureTriggerPayloadFile({ id: "i1", triggerPayload: payload });
  assert.equal(
    file,
    instanceTriggerPayloadPath(paths.invocationsDir(), "i1"),
    "the copy sits in the instance's own invocations folder",
  );
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), payload, "the copy is the payload");

  // Same bytes: nothing is rewritten.
  const past = new Date(2020, 0, 1);
  utimesSync(file, past, past);
  assert.equal(
    await m.ensureTriggerPayloadFile({ id: "i1", triggerPayload: payload }),
    file,
    "the same file is named again",
  );
  assert.ok(
    Math.abs(statSync(file).mtimeMs - past.getTime()) < 1000,
    "an unchanged copy is not rewritten",
  );

  // Edited: put back.
  writeFileSync(file, '{"task":{"id":"T9"}}');
  await m.ensureTriggerPayloadFile({ id: "i1", triggerPayload: payload });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), payload, "an edited copy is restored");

  // Deleted: written again.
  rmSync(file);
  await m.ensureTriggerPayloadFile({ id: "i1", triggerPayload: payload });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), payload, "a deleted copy is restored");

  // No payload (absent, or null as `{{trigger.payload}}` reads it): no file.
  assert.equal(await m.ensureTriggerPayloadFile({ id: "i2" }), null, "no payload, no file");
  assert.equal(
    await m.ensureTriggerPayloadFile({ id: "i3", triggerPayload: null }),
    null,
    "a null payload counts as none",
  );
  for (const id of ["i2", "i3"]) {
    assert.ok(
      !existsSync(instanceTriggerPayloadPath(paths.invocationsDir(), id)),
      `nothing written for ${id}`,
    );
  }

  // A string payload is still JSON, so a script can always parse the file.
  const quoted = await m.ensureTriggerPayloadFile({ id: "i4", triggerPayload: "hello" });
  assert.equal(readFileSync(quoted, "utf8"), '"hello"', "a string payload is written as JSON");
});

test("pruneInstances removes a pruned instance's trigger-payload copy and keeps the others'", async () => {
  const m = await fresh();
  for (let i = 0; i < 3; i++) {
    await m.writeInstance({
      ...makeInstance(`r${i}`, "p1", new Date(2026, 5, 30, 9, i).toISOString()),
      triggerPayload: { task: { id: `T${i}` } },
    });
  }
  const dropped = await m.ensureTriggerPayloadFile(await m.readInstance("r0"));
  const kept = await m.ensureTriggerPayloadFile(await m.readInstance("r2"));
  assert.ok(existsSync(dropped) && existsSync(kept), "both copies were written");
  await m.pruneInstances("p1", 2);
  assert.ok(!existsSync(dropped), "the pruned instance's copy is gone");
  assert.ok(
    !existsSync(path.join(paths.invocationsDir(), "r0")),
    "with the rest of its invocations folder",
  );
  assert.ok(existsSync(kept), "a kept instance's copy stays");
});

test("memo: repeat reads are stable and direct file edits are picked up", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("i1", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  // Prime the memo, then read again — the same content, served from memory,
  // but never the same object: a caller that mutates what it read (the engine
  // does, on the way to a save that may fail) must not change what the next
  // reader sees. Shared identity is how an unsaved transition used to leak.
  const first = await m.readInstance("i1");
  const second = await m.readInstance("i1");
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  first!.status = "aborted";
  assert.equal(
    (await m.readInstance("i1"))?.status,
    "running",
    "an unsaved mutation does not leak",
  );
  // A direct on-disk edit (new mtime) must invalidate the memo entry.
  const file = path.join(home, "argus", "instances", "i1.json");
  const edited = {
    ...makeInstance("i1", "p1", new Date(2026, 5, 30, 9, 0).toISOString()),
    status: "failed",
  };
  const { writeFileSync, utimesSync } = await import("node:fs");
  writeFileSync(file, JSON.stringify(edited));
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  const third = await m.readInstance("i1");
  assert.equal(third?.status, "failed");
});

test("readInstance rejects path-traversal ids", async () => {
  const m = await fresh();
  assert.equal(await m.readInstance("../../../etc/passwd"), null);
  assert.equal(await m.readInstance("a/b"), null);
});

test("a write patches the cached scan instead of discarding it", async () => {
  // A running pipeline writes on every step transition. Each write used to drop
  // the directory-scan cache, so the next reader — board, palette, briefing, or
  // the engine's own reconcile pass — re-stat'ed every retained instance.
  const m = await fresh();
  for (let i = 0; i < 6; i++) {
    await m.writeInstance(makeInstance(`r${i}`, "p1", new Date(2026, 5, 30, 9, i).toISOString()));
  }
  const before = await m.readInstances();
  assert.equal(before.length, 6);

  // Rewriting an existing instance must be visible immediately (read-after-write
  // stays exact) without the cache being thrown away.
  const changed = {
    ...makeInstance("r3", "p1", new Date(2026, 5, 30, 9, 3).toISOString()),
    status: "failed" as const,
  };
  await m.writeInstance(changed);
  const after = await m.readInstances();
  assert.equal(after.length, 6, "no duplicate, no loss");
  assert.equal(after.find((i: { id: string }) => i.id === "r3")?.status, "failed");
  assert.deepEqual(
    after.map((i: { id: string }) => i.id),
    ["r5", "r4", "r3", "r2", "r1", "r0"],
    "still newest-first",
  );
});

test("a brand-new instance appears in an already-warm scan", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("old", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  await m.readInstances(); // warm the scan cache
  await m.writeInstance(makeInstance("new", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));
  const all = await m.readInstances();
  assert.deepEqual(
    all.map((i: { id: string }) => i.id),
    ["new", "old"],
  );
});

test("the cache never hands out an array a caller can mutate", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("a", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  await m.writeInstance(makeInstance("b", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));
  const first = await m.readInstances();
  first.length = 0;
  assert.equal((await m.readInstances()).length, 2);
});

test("the memo holds the whole directory rather than evicting what the next scan wants", async () => {
  // The memo was a 500-entry LRU, which is the pathological policy for a
  // full-directory scan: past the cap it evicted each entry just before the next
  // scan needed it, so a "warm" scan of 1000 files cost 5x a warm scan of 400.
  const m = await fresh();
  const count = 40;
  for (let i = 0; i < count; i++) {
    await m.writeInstance(
      makeInstance(
        `i${String(i).padStart(3, "0")}`,
        "p1",
        new Date(2026, 5, 30, 9, i).toISOString(),
      ),
    );
  }
  const first = await m.readInstances();
  const second = await m.readInstances();
  // Same parsed objects, not re-parsed copies: identity proves the memo served
  // every one of them, not just the tail.
  for (let i = 0; i < count; i++) assert.equal(second[i], first[i], `entry ${i}`);
});

test("forgetting a deleted instance: a pruned id is not served from the memo", async () => {
  const m = await fresh();
  await m.writeInstance(makeInstance("keep", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));
  await m.writeInstance(makeInstance("drop", "p1", new Date(2026, 5, 30, 9, 0).toISOString()));
  await m.readInstances();
  await m.pruneInstances("p1", 1);
  const left = await m.readInstances();
  assert.deepEqual(
    left.map((i: { id: string }) => i.id),
    ["keep"],
  );
  assert.equal(await m.readInstance("drop"), null);
});

// ── worktrees go with the instance ──────────────────────────────────────────

test("pruneInstances removes the instance's worktrees, keeping the branch and any kept tree", async () => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("git", ["--version"]).status !== 0) return;
  const { existsSync, mkdtempSync: mkTmp, writeFileSync } = await import("node:fs");
  const m = await fresh();
  const workspaceMod = await import("../harness/workspace.js");
  const { paths } = await import("../claudeHome.js");

  const git = (dir: string, args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], { cwd: dir });
  const repo = mkTmp(path.join(tmpdir(), "argus-instances-repo-"));
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);

  const root = paths.worktreesDir();
  const dropped = await workspaceMod.createWorktree({
    repoCwd: repo,
    path: path.join(root, "drop", "a-attempt0"),
    branch: "argus/drop/a/0",
    root,
  });
  const kept = await workspaceMod.createWorktree({
    repoCwd: repo,
    path: path.join(root, "drop", "b-attempt0"),
    branch: "argus/drop/b/0",
    root,
  });

  const phase = (id: string, workspace: unknown) => ({
    id,
    name: id,
    gated: false,
    status: "succeeded" as const,
    steps: [],
    attempt: 0,
    payload: null,
    workspace,
  });
  const definition = {
    id: "p1",
    name: "feature pipeline",
    phases: [
      { id: "a", name: "A", cwd: repo, gated: false, steps: [], workspace: { scope: "attempt" } },
      {
        id: "b",
        name: "B",
        cwd: repo,
        gated: false,
        steps: [],
        workspace: { scope: "attempt", keep: true },
      },
    ],
    trigger: null,
    enabled: true,
    overlapPolicy: "skip" as const,
    lastStartedAt: null,
    createdAt: new Date(2026, 5, 30, 8, 0).toISOString(),
    updatedAt: new Date(2026, 5, 30, 8, 0).toISOString(),
  };
  await m.writeInstance({
    ...makeInstance("drop", "p1", new Date(2026, 5, 30, 9, 0).toISOString()),
    status: "succeeded",
    phases: [phase("a", dropped), phase("b", kept)],
    definition,
  });
  await m.writeInstance(makeInstance("keep", "p1", new Date(2026, 5, 30, 10, 0).toISOString()));

  await m.pruneInstances("p1", 1);

  assert.equal(await m.readInstance("drop"), null);
  assert.equal(existsSync(dropped.path), false);
  // The branch outlives the instance record; the kept tree outlives both.
  assert.equal(git(repo, ["rev-parse", "--verify", "argus/drop/a/0"]).status, 0);
  assert.equal(existsSync(kept.path), true);
});
