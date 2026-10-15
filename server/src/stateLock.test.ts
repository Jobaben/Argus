import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireStateLock,
  judgeHolder,
  probeHolder,
  releaseStateLock,
  sameDirectory,
  STATE_LOCK_FILE,
  STATE_LOCK_GRACE_MS,
  type HolderProbe,
  type StateLockRecord,
} from "./stateLock.js";

const T0 = new Date("2026-10-14T12:00:00.000Z");

function record(over: Partial<StateLockRecord> = {}): StateLockRecord {
  return {
    pid: 4242,
    port: 7777,
    url: "http://127.0.0.1:7777",
    claudeHome: "/home/u/.claude",
    build: null,
    startedAt: T0.toISOString(),
    ...over,
  };
}

const neverProbed = async (): Promise<HolderProbe> => {
  throw new Error("the probe must not run for this row");
};

function judge(over: {
  record?: StateLockRecord | null;
  alive?: boolean;
  ageMs?: number;
  probe?: HolderProbe;
}) {
  return judgeHolder({
    record: over.record === undefined ? record() : over.record,
    selfPid: 1,
    alive: over.alive ?? true,
    ageMs: over.ageMs ?? STATE_LOCK_GRACE_MS + 1,
    probe: over.probe ? async () => over.probe as HolderProbe : neverProbed,
  });
}

test("judgeHolder: a dead pid is stale without probing", async () => {
  assert.equal((await judge({ alive: false })).held, false, "dead pid must be stale");
});

test("judgeHolder: a live pid inside the grace period is held without probing", async () => {
  assert.equal((await judge({ ageMs: 1000 })).held, true, "young lock must be held");
});

test("judgeHolder: a lock naming this process's own pid is stale", async () => {
  const v = await judgeHolder({
    record: record({ pid: 99 }),
    selfPid: 99,
    alive: true,
    ageMs: 0,
    probe: neverProbed,
  });
  assert.equal(v.held, false, "own pid must be stale");
});

test("judgeHolder: health reporting the same claudeHome is held", async () => {
  assert.equal(
    (await judge({ probe: { kind: "same-home" } })).held,
    true,
    "same home must be held",
  );
});

test("judgeHolder: 401, timeout or no token counts as held (decision 4)", async () => {
  const v = await judge({ probe: { kind: "unconfirmed", reason: "health answered 401" } });
  assert.equal(v.held, true, "unconfirmed must be held");
  assert.match(v.reason, /401/, "the reason names what the probe saw");
});

test("judgeHolder: health reporting another claudeHome is stale", async () => {
  const v = await judge({ probe: { kind: "other-home", claudeHome: "/elsewhere" } });
  assert.equal(v.held, false, "another home must be stale");
});

test("judgeHolder: connection refused at the recorded url is stale (pid reuse)", async () => {
  assert.equal((await judge({ probe: { kind: "refused" } })).held, false, "refused must be stale");
});

test("judgeHolder: an unreadable lock is held while young and stale once old", async () => {
  assert.equal((await judge({ record: null, alive: false, ageMs: 10 })).held, true, "young torn");
  assert.equal(
    (await judge({ record: null, alive: false, ageMs: STATE_LOCK_GRACE_MS + 1 })).held,
    false,
    "old torn lock must be stale",
  );
});

function deps(
  dir: string,
  over: { alive?: boolean; probe?: HolderProbe; pid?: number; now?: Date },
) {
  return {
    dir,
    isAlive: () => over.alive ?? true,
    probe: async () => over.probe ?? ({ kind: "unconfirmed", reason: "test" } as HolderProbe),
    now: () => over.now ?? T0,
    pid: over.pid ?? 1000,
  };
}

const mine = { port: 7778, url: "http://127.0.0.1:7778", claudeHome: "/h", build: "dev" };

test("acquireStateLock: creates the directory and the lock, and release removes it", async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "argus-lock-")), "argus");
  const res = await acquireStateLock(mine, deps(dir, {}));
  assert.ok(res.acquired, "an empty state directory must be acquired");
  const file = path.join(dir, STATE_LOCK_FILE);
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as StateLockRecord;
  assert.equal(onDisk.pid, 1000, "the lock records the pid");
  assert.equal(onDisk.url, mine.url, "the lock records the probe url");
  res.release();
  assert.equal(existsSync(file), false, "release removes the lock");
});

test("acquireStateLock: a held lock refuses a second server and is left alone", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-lock-"));
  const first = await acquireStateLock(mine, deps(dir, { pid: 1000 }));
  assert.ok(first.acquired, "first server acquires");
  const second = await acquireStateLock(
    { ...mine, port: 7779, url: "http://127.0.0.1:7779" },
    deps(dir, { pid: 2000, now: new Date(T0.getTime() + 1000) }),
  );
  assert.equal(second.acquired, false, "second server on another port is refused");
  assert.equal(second.acquired ? null : second.holder?.pid, 1000, "the refusal names the holder");
  assert.equal(
    (JSON.parse(readFileSync(first.file, "utf8")) as StateLockRecord).pid,
    1000,
    "the holder's lock is untouched",
  );
});

test("acquireStateLock: a stale lock is replaced", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-lock-"));
  writeFileSync(path.join(dir, STATE_LOCK_FILE), JSON.stringify(record({ pid: 5 })));
  const res = await acquireStateLock(mine, deps(dir, { alive: false }));
  assert.ok(res.acquired, "a dead holder's lock must be taken over");
  assert.equal(
    (JSON.parse(readFileSync(res.file, "utf8")) as StateLockRecord).pid,
    1000,
    "the new lock is ours",
  );
});

test("releaseStateLock: leaves a lock that another process now owns", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-lock-"));
  const file = path.join(dir, STATE_LOCK_FILE);
  writeFileSync(file, JSON.stringify(record({ pid: 7 })));
  releaseStateLock(file, { pid: 1000, startedAt: T0.toISOString() });
  assert.ok(existsSync(file), "someone else's lock must survive our release");
});

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object", "test server has an address");
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

test("sameDirectory: one directory spelled two ways is the same; a missing one is unknown", () => {
  const base = mkdtempSync(path.join(tmpdir(), "argus-lock-home-"));
  const home = path.join(base, ".claude");
  mkdirSync(home);
  assert.equal(sameDirectory(home, path.join(home, ".", "x", "..")), true, "dot segments");
  if (process.platform === "win32")
    assert.equal(sameDirectory(home, home.toUpperCase()), true, "case differs on Windows");
  const other = mkdtempSync(path.join(tmpdir(), "argus-lock-home-"));
  assert.equal(sameDirectory(home, other), false, "two directories");
  assert.equal(sameDirectory(home, path.join(base, "missing")), null, "unresolvable");
});

test("probeHolder: same home, other home, 401, unresolvable and refused", async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "argus-lock-home-"));
  const other = mkdtempSync(path.join(tmpdir(), "argus-lock-home-"));
  let reported = home;
  const { server, url } = await listen((req, res) => {
    if (req.headers.authorization !== "Bearer s3cret") {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, claudeHome: reported }));
  });
  t.after(() => server.close());
  const rec = record({ url });
  assert.deepEqual(await probeHolder(rec, home, "s3cret"), { kind: "same-home" }, "same home");
  assert.equal((await probeHolder(rec, other, "s3cret")).kind, "other-home", "other home");
  assert.equal((await probeHolder(rec, home, null)).kind, "unconfirmed", "no token → 401");
  reported = path.join(home, "gone");
  assert.equal((await probeHolder(rec, home, "s3cret")).kind, "unconfirmed", "unresolvable → held");
  const closed = await listen(() => {});
  await new Promise<void>((r) => closed.server.close(() => r()));
  assert.equal(
    (await probeHolder(record({ url: closed.url }), home, "s3cret")).kind,
    "refused",
    "nothing listening → refused",
  );
});
