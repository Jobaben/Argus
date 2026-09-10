import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertBindIsSafe,
  ConfigError,
  describeListenError,
  isExposedBind,
  isLoopbackUrl,
  loadConfig,
  selfBaseUrl,
} from "./config.js";
import type { ArgusConfig } from "./config.js";

function config(over: Partial<ArgusConfig> = {}): ArgusConfig {
  return {
    port: 7777,
    host: "127.0.0.1",
    token: null,
    allowedHosts: [],
    allowedOrigins: [],
    maxConcurrentRuns: 4,
    schedulerTickMs: 30_000,
    webhookUrl: null,
    ...over,
  };
}

describe("isExposedBind", () => {
  it("treats every loopback spelling as private", () => {
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "::1", " 127.0.0.1 "]) {
      assert.equal(isExposedBind(host), false, host);
    }
  });

  it("treats a wildcard or LAN address as exposed", () => {
    for (const host of ["0.0.0.0", "10.59.1.53", "192.168.1.10", "::"]) {
      assert.equal(isExposedBind(host), true, host);
    }
  });
});

describe("assertBindIsSafe", () => {
  it("allows the loopback default with no token", () => {
    assert.doesNotThrow(() => assertBindIsSafe(config()));
  });

  it("refuses an exposed bind with no token", () => {
    // Argus spawns agents with the user's credentials, so this is remote code
    // execution for anyone on the network. The README always called the token
    // mandatory here; now the code agrees.
    assert.throws(() => assertBindIsSafe(config({ host: "0.0.0.0" })), ConfigError);
    assert.throws(() => assertBindIsSafe(config({ host: "10.59.1.53" })), ConfigError);
  });

  it("names both ways out in the message", () => {
    try {
      assertBindIsSafe(config({ host: "0.0.0.0" }));
      assert.fail("expected a ConfigError");
    } catch (e) {
      const message = (e as Error).message;
      assert.match(message, /ARGUS_TOKEN/);
      assert.match(message, /127\.0\.0\.1/);
    }
  });

  it("allows an exposed bind once a token is set", () => {
    assert.doesNotThrow(() => assertBindIsSafe(config({ host: "0.0.0.0", token: "secret" })));
  });
});

describe("loadConfig", () => {
  it("defaults to loopback, so an unconfigured Argus is never on the LAN", () => {
    const previous = process.env.ARGUS_HOST;
    delete process.env.ARGUS_HOST;
    try {
      assert.equal(loadConfig().host, "127.0.0.1");
    } finally {
      if (previous !== undefined) process.env.ARGUS_HOST = previous;
    }
  });
});

describe("selfBaseUrl", () => {
  it("addresses the interface Argus actually bound, not loopback", () => {
    // The regression: with ARGUS_HOST set to a LAN address the socket exists
    // only there, so a completion signal posted to 127.0.0.1 is refused and
    // every pipeline step ends "without emitting a completion signal".
    assert.equal(selfBaseUrl(config({ host: "10.59.1.53" })), "http://10.59.1.53:7777");
  });

  it("keeps the loopback default and a named host verbatim", () => {
    assert.equal(selfBaseUrl(config()), "http://127.0.0.1:7777");
    assert.equal(selfBaseUrl(config({ host: "localhost", port: 8080 })), "http://localhost:8080");
  });

  it("dials loopback for a wildcard bind, which has no address to dial", () => {
    assert.equal(selfBaseUrl(config({ host: "0.0.0.0" })), "http://127.0.0.1:7777");
    assert.equal(selfBaseUrl(config({ host: "::" })), "http://[::1]:7777");
    assert.equal(selfBaseUrl(config({ host: "[::]" })), "http://[::1]:7777");
  });

  it("brackets an IPv6 literal so the URL parses", () => {
    assert.equal(selfBaseUrl(config({ host: "::1" })), "http://[::1]:7777");
    assert.equal(selfBaseUrl(config({ host: "[::1]" })), "http://[::1]:7777");
    assert.equal(selfBaseUrl(config({ host: "fd00::1" })), "http://[fd00::1]:7777");
  });

  it("returns a URL the loopback check and URL parser both accept", () => {
    assert.equal(new URL(selfBaseUrl(config())).port, "7777");
    assert.equal(isLoopbackUrl(selfBaseUrl(config())), true);
    assert.equal(isLoopbackUrl(selfBaseUrl(config({ host: "10.59.1.53" }))), false);
  });
});

describe("describeListenError", () => {
  it("names the fix for a port that is already taken", () => {
    // This used to reach the catch-all uncaughtException handler, which is meant
    // to keep the daemon alive — so Argus logged one internal-looking line and
    // then sat there with nothing bound and no exit code.
    const message = describeListenError({ code: "EADDRINUSE" }, "127.0.0.1", 7777);
    assert.match(message ?? "", /already in use/);
    assert.match(message ?? "", /ARGUS_PORT/);
  });

  it("explains a privileged port and a bogus host", () => {
    assert.match(describeListenError({ code: "EACCES" }, "127.0.0.1", 80) ?? "", /privileges/);
    assert.match(
      describeListenError({ code: "EADDRNOTAVAIL" }, "10.0.0.9", 7777) ?? "",
      /not an address on this machine/,
    );
  });

  it("says nothing about an error that is not a startup failure", () => {
    // Anything else must stay non-fatal, or a transient socket error would take
    // the daemon down.
    assert.equal(describeListenError({ code: "ECONNRESET" }, "127.0.0.1", 7777), null);
    assert.equal(describeListenError(new Error("boom"), "127.0.0.1", 7777), null);
    assert.equal(describeListenError(null, "127.0.0.1", 7777), null);
    assert.equal(describeListenError(undefined, "127.0.0.1", 7777), null);
  });
});
