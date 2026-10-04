import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { childTreeStopper, signalProcessTree } from "./processTree.js";
import { runCheck } from "./harness/verification.js";
import { NOT_EXITED_ERROR, OUTPUT_CAP_ERROR, spawnAnalysisProcess } from "./sources/analysis.js";

// ── The platform seam, with fake pids and fake kill functions only ─────────
//
// Every pid below is invented, so nothing here may reach a real `process.kill`
// or `taskkill`: each test injects both.

const FAKE_PID = 424_242;

function recorder() {
  const signals: Array<[number, NodeJS.Signals]> = [];
  const taskkills: number[] = [];
  return {
    signals,
    taskkills,
    signal: (pid: number, sig: NodeJS.Signals) => void signals.push([pid, sig]),
    taskkill: async (pid: number) => {
      taskkills.push(pid);
      return true;
    },
  };
}

test("Windows: a tree kill is taskkill /T /F whatever signal was asked for", async () => {
  const r = recorder();
  assert.equal(await signalProcessTree(FAKE_PID, "SIGTERM", { platform: "win32", ...r }), true);
  assert.equal(await signalProcessTree(FAKE_PID, "SIGKILL", { platform: "win32", ...r }), true);
  assert.deepEqual(r.taskkills, [FAKE_PID, FAKE_PID]);
  assert.deepEqual(r.signals, [], "no POSIX signal on Windows");
  assert.equal(
    await signalProcessTree(FAKE_PID, "SIGTERM", {
      platform: "win32",
      taskkill: async () => false,
    }),
    false,
    "a failed taskkill is reported, not assumed to have worked",
  );
});

test("POSIX: a detached child's group is signalled, falling back to the pid", async () => {
  const r = recorder();
  assert.equal(await signalProcessTree(FAKE_PID, "SIGTERM", { platform: "linux", ...r }), true);
  assert.deepEqual(r.signals, [[-FAKE_PID, "SIGTERM"]]);

  const tried: number[] = [];
  const noGroup = (pid: number) => {
    tried.push(pid);
    if (pid < 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  };
  assert.equal(
    await signalProcessTree(FAKE_PID, "SIGKILL", { platform: "linux", signal: noGroup }),
    true,
  );
  assert.deepEqual(tried, [-FAKE_PID, FAKE_PID]);

  const gone = () => {
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  };
  assert.equal(
    await signalProcessTree(FAKE_PID, "SIGTERM", { platform: "linux", signal: gone }),
    false,
  );
});

test("POSIX: a child that shares Argus's group is never signalled as a group", async () => {
  const r = recorder();
  await signalProcessTree(FAKE_PID, "SIGTERM", { platform: "darwin", grouped: false, ...r });
  assert.deepEqual(r.signals, [[FAKE_PID, "SIGTERM"]]);
});

/** A ChildProcess stand-in: an invented pid, pipes that never close on their own. */
function fakeChild() {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const child = Object.assign(ee, {
    pid: FAKE_PID,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unrefs: 0,
    rootKills: [] as Array<NodeJS.Signals | undefined>,
    unref() {
      child.unrefs++;
    },
    kill(sig?: NodeJS.Signals) {
      child.rootKills.push(sig);
      return true;
    },
  });
  return child;
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("stopper (POSIX): SIGTERM to the group, SIGKILL after the grace even once the leader has exited, then the pipes are released", async () => {
  const r = recorder();
  const child = fakeChild();
  let abandoned = 0;
  const stopper = childTreeStopper(child as unknown as ChildProcess, {
    platform: "linux",
    grouped: true,
    graceMs: 30,
    onAbandon: () => abandoned++,
    ...r,
  });
  stopper.stop();
  stopper.stop(); // idempotent
  assert.equal(stopper.stopping, true);
  await tick(5);
  assert.deepEqual(r.signals, [[-FAKE_PID, "SIGTERM"]]);
  // The leader exits but a descendant still holds the pipes: the group is
  // still what the escalation is for.
  child.exitCode = 0;
  await tick(40);
  assert.deepEqual(r.signals, [
    [-FAKE_PID, "SIGTERM"],
    [-FAKE_PID, "SIGKILL"],
  ]);
  assert.equal(abandoned, 0, "not abandoned before the second grace");
  await tick(40);
  assert.equal(abandoned, 1);
  assert.ok(child.stdout.destroyed && child.stderr.destroyed && child.stdin.destroyed);
  assert.equal(child.unrefs, 1);
  assert.deepEqual(r.taskkills, []);
});

test("stopper (Windows): taskkill first, again only while the root can still be walked from", async () => {
  const r = recorder();
  const child = fakeChild();
  let abandoned = 0;
  const stopper = childTreeStopper(child as unknown as ChildProcess, {
    platform: "win32",
    grouped: false,
    graceMs: 30,
    onAbandon: () => abandoned++,
    ...r,
  });
  stopper.stop();
  await tick(5);
  assert.deepEqual(r.taskkills, [FAKE_PID]);
  assert.deepEqual(child.rootKills, [], "the root is not killed alone before the tree");
  await tick(40);
  assert.deepEqual(r.taskkills, [FAKE_PID, FAKE_PID], "root still running: walk it again");
  await tick(40);
  assert.equal(abandoned, 1);
  assert.deepEqual(r.signals, []);

  // Once the root has exited, its descendants cannot be found from it.
  const r2 = recorder();
  const exited = fakeChild();
  const s2 = childTreeStopper(exited as unknown as ChildProcess, {
    platform: "win32",
    grouped: false,
    graceMs: 30,
    onAbandon: () => {},
    ...r2,
  });
  s2.stop();
  await tick(5);
  exited.exitCode = 1;
  await tick(40);
  assert.deepEqual(r2.taskkills, [FAKE_PID]);
  s2.dispose();
});

test("stopper (Windows): a failed taskkill falls back to the root alone", async () => {
  const child = fakeChild();
  const stopper = childTreeStopper(child as unknown as ChildProcess, {
    platform: "win32",
    grouped: false,
    graceMs: 1000,
    onAbandon: () => {},
    taskkill: async () => false,
    signal: () => assert.fail("no POSIX signal on Windows"),
  });
  stopper.stop();
  await tick(5);
  assert.deepEqual(child.rootKills, ["SIGTERM"]);
  stopper.dispose();
});

test("stopper (POSIX): a gone group is never retried as the bare pid; the root only through its handle", async () => {
  const tried: Array<[number, NodeJS.Signals]> = [];
  const groupGone = (pid: number, sig: NodeJS.Signals) => {
    tried.push([pid, sig]);
    throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
  };
  // Root still running: the fallback is the child handle, not process.kill(pid).
  const running = fakeChild();
  const s1 = childTreeStopper(running as unknown as ChildProcess, {
    platform: "linux",
    grouped: true,
    graceMs: 1000,
    onAbandon: () => {},
    signal: groupGone,
  });
  s1.stop();
  await tick(5);
  assert.deepEqual(tried, [[-FAKE_PID, "SIGTERM"]]);
  assert.deepEqual(running.rootKills, ["SIGTERM"]);
  s1.dispose();

  // Root exited (its pid may already be reused): nothing at all is sent to it.
  tried.length = 0;
  const exited = fakeChild();
  exited.exitCode = 0;
  const s2 = childTreeStopper(exited as unknown as ChildProcess, {
    platform: "linux",
    grouped: true,
    graceMs: 20,
    onAbandon: () => {},
    signal: groupGone,
  });
  s2.stop();
  await tick(35);
  assert.deepEqual(tried, [
    [-FAKE_PID, "SIGTERM"],
    [-FAKE_PID, "SIGKILL"],
  ]);
  assert.deepEqual(exited.rootKills, []);
  s2.dispose();
});

test("stopper (Windows): a root that has already exited is never taskkilled — its pid may be reused", async () => {
  const r = recorder();
  const child = fakeChild();
  child.exitCode = 0; // exited; only a descendant still holds the pipes
  let abandoned = 0;
  const stopper = childTreeStopper(child as unknown as ChildProcess, {
    platform: "win32",
    grouped: false,
    graceMs: 20,
    onAbandon: () => abandoned++,
    ...r,
  });
  stopper.stop();
  await tick(60);
  assert.deepEqual(r.taskkills, [], "no taskkill by a pid that is no longer the root's");
  assert.deepEqual(child.rootKills, []);
  assert.equal(abandoned, 1, "still settles, unconfirmed");
  assert.ok(child.stdout.destroyed);
});

test("stopper: a taskkill still in flight at dispose cannot trigger a late fallback", async () => {
  const child = fakeChild();
  let finishTaskkill: (ok: boolean) => void = () => {};
  const stopper = childTreeStopper(child as unknown as ChildProcess, {
    platform: "win32",
    grouped: false,
    graceMs: 1000,
    onAbandon: () => assert.fail("disposed before the ladder ran"),
    taskkill: () => new Promise<boolean>((resolve) => (finishTaskkill = resolve)),
  });
  stopper.stop();
  stopper.dispose(); // the child closed while taskkill was still running
  finishTaskkill(false);
  await tick(10);
  assert.deepEqual(child.rootKills, [], "no root kill after the owner settled");
});

test("stopper: onAbandon runs at most once, however stop and dispose interleave", async () => {
  const r = recorder();
  const child = fakeChild();
  let abandoned = 0;
  const stopper = childTreeStopper(child as unknown as ChildProcess, {
    platform: "linux",
    grouped: true,
    graceMs: 10,
    onAbandon: () => abandoned++,
    ...r,
  });
  stopper.stop();
  await tick(40);
  stopper.stop();
  stopper.dispose();
  await tick(40);
  assert.equal(abandoned, 1);
  assert.deepEqual(r.signals, [
    [-FAKE_PID, "SIGTERM"],
    [-FAKE_PID, "SIGKILL"],
  ]);
});

test("stopper: dispose (the child closed) cancels the escalation", async () => {
  const r = recorder();
  const child = fakeChild();
  let abandoned = 0;
  const stopper = childTreeStopper(child as unknown as ChildProcess, {
    platform: "linux",
    grouped: true,
    graceMs: 20,
    onAbandon: () => abandoned++,
    ...r,
  });
  stopper.stop();
  await tick(5);
  stopper.dispose();
  await tick(60);
  assert.deepEqual(r.signals, [[-FAKE_PID, "SIGTERM"]]);
  assert.equal(abandoned, 0);
  assert.equal(child.stdout.destroyed, false);
});

// ── Real, controlled process trees ───────────────────────────────────────
//
// The fixture spawns its own root and descendant and records the
// descendant's pid; that pid is the only one these tests probe. The real
// kill implementation only ever targets the trees spawned here.

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "processTreeFixture.mjs");
const isWindows = process.platform === "win32";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitDead(pid: number, withinMs: number): Promise<boolean> {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await tick(25);
  }
  return !isAlive(pid);
}

/** A scratch directory and pid file; removing the pid file lets a stray
 *  descendant exit on its own (see the fixture). */
function scratch(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-tree-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, pidFile: path.join(dir, "descendant.pid") };
}

function descendantPid(pidFile: string): number {
  assert.ok(existsSync(pidFile), "the fixture recorded its descendant");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  return pid;
}

test("verification: a timed-out command whose descendant holds the pipe settles, and the descendant is gone", async (t) => {
  const { dir, pidFile } = scratch(t);
  const started = Date.now();
  const res = await runCheck(
    {
      kind: "command",
      run: `node "${FIXTURE}" "${pidFile}" hang`,
      timeoutSeconds: 1,
    },
    { cwd: dir, artifactDir: null, baseline: null, killGraceMs: 300 },
  );
  assert.equal(res.status, "failed");
  assert.match(res.detail, /^timed out after 1s/);
  assert.match(res.output ?? "", /root up/, "output before the deadline is kept");
  assert.ok(Date.now() - started < 10_000);
  const pid = descendantPid(pidFile);
  assert.ok(await waitDead(pid, 5000), `descendant ${pid} survived the tree kill`);
});

function analysisPlan(pidFile: string, mode: string) {
  // On Windows the spawn goes through cmd.exe, which joins argv unquoted.
  const q = (s: string) => (isWindows ? `"${s}"` : s);
  return { bin: "node", args: [q(FIXTURE), q(pidFile), mode], stdin: "", env: {} };
}

test("analysis spawn: normal completion is drained in full on close", async (t) => {
  const { dir, pidFile } = scratch(t);
  const handle = spawnAnalysisProcess(analysisPlan(pidFile, "complete"), {
    cwd: dir,
    maxOutputBytes: 1 << 20,
    killGraceMs: 300,
  });
  const res = await handle.done;
  assert.equal(res.code, 0);
  assert.equal(res.error, null);
  assert.equal(res.stdout.length, 200 * 1024 + "END-MARKER".length);
  assert.ok(res.stdout.endsWith("END-MARKER"));
});

test("analysis spawn: kill() settles done and ends the whole tree", async (t) => {
  const { dir, pidFile } = scratch(t);
  const handle = spawnAnalysisProcess(analysisPlan(pidFile, "hang"), {
    cwd: dir,
    maxOutputBytes: 1 << 20,
    killGraceMs: 300,
  });
  const until = Date.now() + 5000;
  while (!existsSync(pidFile) && Date.now() < until) await tick(25);
  const pid = descendantPid(pidFile);
  handle.kill();
  const res = await handle.done;
  assert.equal(res.error, null, "the tree closed its pipes; no abandonment");
  assert.match(res.stdout, /root up/);
  assert.ok(await waitDead(pid, 5000), `descendant ${pid} survived kill()`);
});

test("analysis spawn: blowing the output cap settles done and ends the whole tree", async (t) => {
  const { dir, pidFile } = scratch(t);
  const handle = spawnAnalysisProcess(analysisPlan(pidFile, "flood"), {
    cwd: dir,
    maxOutputBytes: 1024,
    killGraceMs: 300,
  });
  const res = await handle.done;
  assert.equal(res.error, OUTPUT_CAP_ERROR, "the tree did exit: no uncertainty to report");
  const pid = descendantPid(pidFile);
  assert.ok(await waitDead(pid, 5000), `descendant ${pid} survived the output cap`);
});

test(
  "a descendant out of the tree kill's reach: the owner still settles and the pipes are let go",
  {
    skip: isWindows
      ? "needs a descendant outside the root's process group (setsid); Windows has no process groups"
      : false,
  },
  async (t) => {
    const { dir, pidFile } = scratch(t);
    const verdict = await runCheck(
      { kind: "command", run: `node "${FIXTURE}" "${pidFile}" escape`, timeoutSeconds: 1 },
      { cwd: dir, artifactDir: null, baseline: null, killGraceMs: 200 },
    );
    assert.equal(verdict.status, "failed");
    assert.match(verdict.detail, /process did not exit/);
    const escaped = descendantPid(pidFile);
    // Honest about it: the escaped descendant is still running...
    assert.ok(isAlive(escaped), "the escaped descendant is outside the group by construction");

    const pidFile2 = path.join(dir, "descendant2.pid");
    const handle = spawnAnalysisProcess(analysisPlan(pidFile2, "escape"), {
      cwd: dir,
      maxOutputBytes: 1 << 20,
      killGraceMs: 200,
    });
    const until = Date.now() + 5000;
    while (!existsSync(pidFile2) && Date.now() < until) await tick(25);
    handle.kill();
    const res = await handle.done;
    assert.equal(res.code, null);
    assert.equal(res.error, NOT_EXITED_ERROR);
    const escaped2 = descendantPid(pidFile2);

    // ...and removing the pid files is what lets these two exit (the fixture
    // watches for it), which also proves nothing else was holding them.
    rmSync(pidFile, { force: true });
    rmSync(pidFile2, { force: true });
    assert.ok(await waitDead(escaped, 5000));
    assert.ok(await waitDead(escaped2, 5000));
  },
);

test(
  "output cap, then a tree that will not let go: done settles with the cause and the uncertainty",
  {
    skip: isWindows
      ? "needs a descendant outside the root's process group (setsid); Windows has no process groups"
      : false,
  },
  async (t) => {
    const { dir, pidFile } = scratch(t);
    const handle = spawnAnalysisProcess(analysisPlan(pidFile, "escape-flood"), {
      cwd: dir,
      maxOutputBytes: 1024,
      killGraceMs: 200,
    });
    // Nobody calls kill(): the overflow does, and nothing but the ladder ends it.
    const res = await handle.done;
    assert.equal(res.code, null, "no exit status: the tree was never confirmed to have exited");
    assert.equal(res.error, `${OUTPUT_CAP_ERROR}; ${NOT_EXITED_ERROR}`);
    assert.ok(res.error?.startsWith(OUTPUT_CAP_ERROR), "the cause still leads, for classification");

    const escaped = descendantPid(pidFile);
    assert.ok(isAlive(escaped), "the descendant is outside the group by construction");
    rmSync(pidFile, { force: true });
    assert.ok(await waitDead(escaped, 5000));
  },
);
