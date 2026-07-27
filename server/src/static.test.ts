import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { mountWebApp, resolveWebDir } from "./static.js";

let dir: string;
let previous: string | undefined;

function writeIndex(body: string, mtimeSeconds?: number): void {
  const file = path.join(dir, "index.html");
  writeFileSync(file, body);
  // Same-second writes can share an mtime on coarse filesystems; stamping it
  // makes the change unambiguous, which is what a real rebuild produces.
  if (mtimeSeconds !== undefined) utimesSync(file, mtimeSeconds, mtimeSeconds);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "argus-static-"));
  previous = process.env.ARGUS_WEB_DIR;
  process.env.ARGUS_WEB_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.ARGUS_WEB_DIR;
  else process.env.ARGUS_WEB_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveWebDir", () => {
  it("honours ARGUS_WEB_DIR", () => {
    assert.equal(resolveWebDir(), path.resolve(dir));
  });

  it("returns null for an override that does not exist", () => {
    process.env.ARGUS_WEB_DIR = path.join(dir, "nope");
    assert.equal(resolveWebDir(), null);
  });
});

describe("mountWebApp", () => {
  it("serves index.html for a non-API route", async () => {
    writeIndex("<html>v1</html>");
    const app = new Hono();
    mountWebApp(app);
    const res = await app.request("/anything");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /v1/);
  });

  it("picks up a rebuild without a restart", async () => {
    // The real failure this guards: rebuilding the UI under a running Argus used
    // to leave the boot-time HTML in memory, naming content-hashed chunks that no
    // longer existed — every asset 404'd and the app was a blank page.
    writeIndex("<html>old-chunk-a1b2c3</html>", 1_700_000_000);
    const app = new Hono();
    mountWebApp(app);
    assert.match(await (await app.request("/")).text(), /old-chunk/);

    writeIndex("<html>new-chunk-d4e5f6</html>", 1_700_000_060);
    const after = await (await app.request("/")).text();
    assert.match(after, /new-chunk/);
    assert.doesNotMatch(after, /old-chunk/);
  });

  it("keeps serving the last good HTML if the build vanishes mid-flight", async () => {
    writeIndex("<html>v1</html>");
    const app = new Hono();
    mountWebApp(app);
    assert.equal((await app.request("/")).status, 200);

    rmSync(path.join(dir, "index.html"));
    const res = await app.request("/");
    assert.equal(res.status, 200, "a stale page beats a 500");
    assert.match(await res.text(), /v1/);
  });

  it("leaves /api and /ws to their own handlers rather than returning HTML", async () => {
    writeIndex("<html>v1</html>");
    const app = new Hono();
    mountWebApp(app);
    assert.equal((await app.request("/api/unknown")).status, 404);
    assert.equal((await app.request("/ws")).status, 404);
  });

  it("is a no-op with no build, so dev mode is unaffected", () => {
    process.env.ARGUS_WEB_DIR = path.join(dir, "nope");
    const app = new Hono();
    assert.equal(mountWebApp(app), null);
  });

  it("refuses to serve a file outside the build directory", async () => {
    writeIndex("<html>v1</html>");
    const app = new Hono();
    mountWebApp(app);
    // Traversal out of /assets must not reach the filesystem above it.
    const res = await app.request("/assets/..%2f..%2fetc%2fpasswd");
    assert.equal(res.status, 404);
  });
});
