import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAuthService,
  AuthValidationError,
  MAX_LOGIN_FAILURES,
  LOCKOUT_MS,
  SESSION_TTL_MS,
} from "./auth.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "argus-auth-"));
  process.env.ARGUS_CLAUDE_HOME = home;
});

/** A controllable clock so expiry/lockout tests don't sleep. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

test("setup persists a hashed credential record, never the password", async () => {
  const auth = createAuthService();
  await auth.setup("usha", "correct horse battery");
  assert.equal(await auth.isConfigured(), true);

  const file = path.join(home, "argus", "auth.json");
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes("correct horse battery"), "plaintext password must not be stored");
  const rec = JSON.parse(raw) as { algorithm: string; salt: string; hash: string };
  assert.equal(rec.algorithm, "scrypt");
  assert.ok(rec.salt.length >= 32);
  assert.ok(rec.hash.length >= 64);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
});

test("setup enforces a minimum password length and rejects a second account", async () => {
  const auth = createAuthService();
  await assert.rejects(() => auth.setup("usha", "short"), AuthValidationError);
  await auth.setup("usha", "long enough password");
  await assert.rejects(() => auth.setup("other", "another password"), AuthValidationError);
});

test("login issues a session for good credentials and rejects bad ones", async () => {
  const auth = createAuthService();
  await auth.setup("usha", "correct horse battery");

  const bad = await auth.login("usha", "wrong password!");
  assert.deepEqual(bad, { ok: false, reason: "bad-credentials" });
  const wrongUser = await auth.login("admin", "correct horse battery");
  assert.deepEqual(wrongUser, { ok: false, reason: "bad-credentials" });

  const good = await auth.login("usha", "correct horse battery");
  assert.ok(good.ok);
  assert.equal(auth.verify(good.token), "usha");
});

test("login before setup reports not-configured", async () => {
  const auth = createAuthService();
  assert.deepEqual(await auth.login("usha", "whatever password"), {
    ok: false,
    reason: "not-configured",
  });
});

test("sessions expire after the TTL", async () => {
  const c = clock();
  const auth = createAuthService({ now: c.now });
  await auth.setup("usha", "correct horse battery");
  const res = await auth.login("usha", "correct horse battery");
  assert.ok(res.ok);
  c.advance(SESSION_TTL_MS - 1);
  assert.equal(auth.verify(res.token), "usha");
  c.advance(2);
  assert.equal(auth.verify(res.token), null);
});

test("logout invalidates the session immediately", async () => {
  const auth = createAuthService();
  await auth.setup("usha", "correct horse battery");
  const res = await auth.login("usha", "correct horse battery");
  assert.ok(res.ok);
  auth.logout(res.token);
  assert.equal(auth.verify(res.token), null);
});

test("verify rejects garbage and empty tokens", async () => {
  const auth = createAuthService();
  assert.equal(auth.verify(null), null);
  assert.equal(auth.verify(""), null);
  assert.equal(auth.verify("not-a-real-token"), null);
});

test("repeated failures lock the account, and the lock expires", async () => {
  const c = clock();
  const auth = createAuthService({ now: c.now });
  await auth.setup("usha", "correct horse battery");

  for (let i = 0; i < MAX_LOGIN_FAILURES; i++) {
    assert.deepEqual(await auth.login("usha", "wrong password!"), {
      ok: false,
      reason: "bad-credentials",
    });
  }
  // Locked: even the correct password is refused without being checked.
  assert.deepEqual(await auth.login("usha", "correct horse battery"), {
    ok: false,
    reason: "locked",
  });
  c.advance(LOCKOUT_MS + 1);
  const res = await auth.login("usha", "correct horse battery");
  assert.ok(res.ok);
});

test("status reflects configuration and the supplied token", async () => {
  const auth = createAuthService();
  assert.deepEqual(await auth.status(null), { configured: false, username: null });
  await auth.setup("usha", "correct horse battery");
  const res = await auth.login("usha", "correct horse battery");
  assert.ok(res.ok);
  assert.deepEqual(await auth.status(res.token), { configured: true, username: "usha" });
  assert.deepEqual(await auth.status(null), { configured: true, username: null });
});
