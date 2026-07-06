import { test } from "node:test";
import assert from "node:assert/strict";
import { isHostAllowed, isOriginAllowed, isUpgradeAllowed } from "./security.js";
import type { ArgusConfig } from "./config.js";

const base: ArgusConfig = {
  port: 7777,
  host: "127.0.0.1",
  token: null,
  allowedHosts: [],
  allowedOrigins: [],
  maxConcurrentRuns: 4,
  schedulerTickMs: 30000,
  webhookUrl: null,
};

test("host allowlist accepts loopback names with any port", () => {
  for (const h of ["localhost:7777", "127.0.0.1:7777", "[::1]:7777", "localhost", "LOCALHOST:5757"]) {
    assert.equal(isHostAllowed(h, base), true, h);
  }
});

test("host allowlist rejects arbitrary and rebinding hosts", () => {
  assert.equal(isHostAllowed("evil.example.com", base), false);
  assert.equal(isHostAllowed("attacker.com:7777", base), false);
  assert.equal(isHostAllowed(undefined, base), false);
});

test("host allowlist honors ARGUS_ALLOWED_HOSTS", () => {
  const cfg = { ...base, allowedHosts: ["argus.internal"] };
  assert.equal(isHostAllowed("argus.internal:7777", cfg), true);
  assert.equal(isHostAllowed("other.internal", cfg), false);
});

test("origin check permits no-Origin (non-browser) requests", () => {
  assert.equal(isOriginAllowed(undefined, "localhost:7777", base), true);
});

test("origin check permits same-origin and loopback origins", () => {
  assert.equal(isOriginAllowed("http://localhost:7777", "localhost:7777", base), true);
  assert.equal(isOriginAllowed("http://127.0.0.1:5757", "localhost:7777", base), true);
});

test("origin check rejects a cross-site (CSRF) origin", () => {
  assert.equal(isOriginAllowed("https://evil.example.com", "localhost:7777", base), false);
  assert.equal(isOriginAllowed("not-a-url", "localhost:7777", base), false);
});

test("origin check honors ARGUS_ALLOWED_ORIGINS", () => {
  const cfg = { ...base, allowedOrigins: ["https://dash.corp"] };
  assert.equal(isOriginAllowed("https://dash.corp", "dash.corp", cfg), true);
});

test("upgrade guard requires host, origin, and token together", () => {
  const cfg = { ...base, token: "secret" };
  assert.equal(
    isUpgradeAllowed({ host: "localhost:7777", origin: "http://localhost:7777", token: "secret" }, cfg),
    true,
  );
  // Missing token
  assert.equal(
    isUpgradeAllowed({ host: "localhost:7777", origin: "http://localhost:7777" }, cfg),
    false,
  );
  // Bad host
  assert.equal(
    isUpgradeAllowed({ host: "evil.com", origin: "http://localhost:7777", token: "secret" }, cfg),
    false,
  );
  // Bearer form accepted
  assert.equal(
    isUpgradeAllowed({ host: "localhost:7777", origin: "http://localhost:7777", authorization: "Bearer secret" }, cfg),
    true,
  );
});
