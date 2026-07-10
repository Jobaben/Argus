import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAuthService,
  MAX_LOGIN_FAILURES,
  LOCKOUT_MS,
  SESSION_TTL_MS,
} from "./auth.js";
import { createUserStore, type UserStore } from "./userStore.js";

let home: string;
let store: UserStore;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-auth-"));
  process.env.ARGUS_CLAUDE_HOME = home;
  store = createUserStore();
});

/** A controllable clock so expiry/lockout tests don't sleep. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

async function activeUser(username = "usha", password = "correct horse battery") {
  await store.register(username, password, { role: "root", status: "active" });
  return { username, password };
}

test("login issues a role-carrying session for good credentials", async () => {
  const auth = createAuthService({ store });
  const { username, password } = await activeUser();

  const bad = await auth.login(username, "wrong password!");
  assert.deepEqual(bad, { ok: false, reason: "bad-credentials" });
  const wrongUser = await auth.login("admin", password);
  assert.deepEqual(wrongUser, { ok: false, reason: "bad-credentials" });

  const good = await auth.login(username, password);
  assert.ok(good.ok);
  assert.equal(good.role, "root");
  assert.deepEqual(auth.verify(good.token), { username: "usha", role: "root" });
});

test("login before any user exists reports not-configured", async () => {
  const auth = createAuthService({ store });
  assert.deepEqual(await auth.login("usha", "whatever password"), {
    ok: false,
    reason: "not-configured",
  });
});

test("pending users cannot log in until approved", async () => {
  const auth = createAuthService({ store });
  await store.register("alice", "correct horse battery"); // pending member
  assert.deepEqual(await auth.login("alice", "correct horse battery"), {
    ok: false,
    reason: "pending-approval",
  });
  await store.approve("alice");
  const res = await auth.login("alice", "correct horse battery");
  assert.ok(res.ok);
  assert.equal(res.role, "member");
});

test("a correct password on a pending account does not count toward lockout", async () => {
  const auth = createAuthService({ store });
  await store.register("alice", "correct horse battery");
  for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
    await auth.login("alice", "correct horse battery"); // pending-approval each time
  }
  await store.approve("alice");
  const res = await auth.login("alice", "correct horse battery");
  assert.ok(res.ok, "lockout must not have tripped");
});

test("sessions expire after the TTL", async () => {
  const c = clock();
  const auth = createAuthService({ store, now: c.now });
  const { username, password } = await activeUser();
  const res = await auth.login(username, password);
  assert.ok(res.ok);
  c.advance(SESSION_TTL_MS - 1);
  assert.ok(auth.verify(res.token));
  c.advance(2);
  assert.equal(auth.verify(res.token), null);
});

test("repeated failures trip the lockout, which expires", async () => {
  const c = clock();
  const auth = createAuthService({ store, now: c.now });
  const { username, password } = await activeUser();
  for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
    await auth.login(username, "wrong password!!");
  }
  assert.deepEqual(await auth.login(username, password), { ok: false, reason: "locked" });
  c.advance(LOCKOUT_MS + 1);
  const res = await auth.login(username, password);
  assert.ok(res.ok);
});

test("logout and revokeSessions invalidate live sessions", async () => {
  const auth = createAuthService({ store });
  const { username, password } = await activeUser();
  const a = await auth.login(username, password);
  const b = await auth.login(username, password);
  assert.ok(a.ok && b.ok);

  auth.logout(a.token);
  assert.equal(auth.verify(a.token), null);
  assert.ok(auth.verify(b.token), "other session must survive a logout");

  auth.revokeSessions(username);
  assert.equal(auth.verify(b.token), null);
});

test("status reports configured plus the session's identity", async () => {
  const auth = createAuthService({ store });
  assert.deepEqual(await auth.status(null), { configured: false, username: null, role: null });
  const { username, password } = await activeUser();
  const res = await auth.login(username, password);
  assert.ok(res.ok);
  assert.deepEqual(await auth.status(res.token), {
    configured: true,
    username: "usha",
    role: "root",
  });
});
