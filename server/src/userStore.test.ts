import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createUserStore,
  verifyPassword,
  AuthValidationError,
  DuplicateUsernameError,
  UnknownUserError,
} from "./userStore.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-users-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

test("register persists a hashed pending member, never the password", async () => {
  const store = createUserStore();
  await store.register("alice", "correct horse battery");

  const file = path.join(home, "argus", "users.json");
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes("correct horse battery"), "plaintext password must not be stored");
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }

  const rec = await store.find("alice");
  assert.ok(rec);
  assert.equal(rec.role, "member");
  assert.equal(rec.status, "pending");
  assert.equal(rec.algorithm, "scrypt");
  assert.equal(await verifyPassword(rec, "correct horse battery"), true);
  assert.equal(await verifyPassword(rec, "wrong password!!"), false);
});

test("register accepts role/status overrides for bootstrap", async () => {
  const store = createUserStore();
  await store.register("Josha", "root password here", { role: "root", status: "active" });
  const rec = await store.find("josha"); // case-insensitive lookup
  assert.ok(rec);
  assert.equal(rec.role, "root");
  assert.equal(rec.status, "active");
});

test("register validates input and rejects duplicates case-insensitively", async () => {
  const store = createUserStore();
  await assert.rejects(() => store.register("", "long enough pass"), AuthValidationError);
  await assert.rejects(() => store.register("bob", "short"), AuthValidationError);
  await store.register("Bob", "long enough pass");
  await assert.rejects(() => store.register("bob", "another password"), DuplicateUsernameError);
  assert.equal(await store.count(), 1);
});

test("approve flips pending to active; unknown user is an error", async () => {
  const store = createUserStore();
  await store.register("alice", "correct horse battery");
  await store.approve("ALICE");
  assert.equal((await store.find("alice"))?.status, "active");
  await assert.rejects(() => store.approve("nobody"), UnknownUserError);
});

test("remove deletes the record; unknown user is an error", async () => {
  const store = createUserStore();
  await store.register("alice", "correct horse battery");
  await store.remove("alice");
  assert.equal(await store.find("alice"), null);
  assert.equal(await store.count(), 0);
  await assert.rejects(() => store.remove("alice"), UnknownUserError);
});

test("list returns summaries without secrets", async () => {
  const store = createUserStore();
  await store.register("alice", "correct horse battery");
  const rows = await store.list();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["createdAt", "role", "status", "username"]);
});

test("legacy single-admin auth.json migrates to a root/active user", async () => {
  // Simulate the pre-multi-user file written by the old AuthService.
  const dir = path.join(home, "argus");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify({
      version: 1,
      username: "Josha",
      algorithm: "scrypt",
      salt: "aa".repeat(16),
      hash: "bb".repeat(64),
      params: { N: 131072, r: 8, p: 1, keyLen: 64 },
      createdAt: "2026-07-10T10:49:40.330Z",
      updatedAt: "2026-07-10T10:49:40.330Z",
    }),
  );

  const store = createUserStore();
  const rec = await store.find("Josha");
  assert.ok(rec, "legacy admin must exist after migration");
  assert.equal(rec.role, "root");
  assert.equal(rec.status, "active");
  assert.equal(rec.salt, "aa".repeat(16));
  // Migration is persisted so auth.json is never needed again.
  const migrated = JSON.parse(readFileSync(path.join(dir, "users.json"), "utf8"));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.users.length, 1);
});
