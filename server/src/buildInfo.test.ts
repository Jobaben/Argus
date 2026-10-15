import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUILD_ROOT, buildLabel, readBuildInfo, RELEASE_MANIFEST } from "./buildInfo.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("readBuildInfo: a directory with a release manifest is a release", () => {
  const root = mkdtempSync(path.join(tmpdir(), "argus-build-"));
  writeFileSync(
    path.join(root, RELEASE_MANIFEST),
    JSON.stringify({ id: "1.0.0-0123456", sha: SHA }),
  );
  const info = readBuildInfo(root, () => {
    throw new Error("a release must not ask git");
  });
  assert.deepEqual(info, { kind: "release", sha: SHA, dir: root, id: "1.0.0-0123456" }, "release");
  assert.equal(buildLabel(info), "1.0.0-0123456", "a release is labelled by its id");
});

test("readBuildInfo: without a manifest it is a dev build with the checkout's HEAD", () => {
  const root = mkdtempSync(path.join(tmpdir(), "argus-build-"));
  const info = readBuildInfo(root, () => SHA);
  assert.deepEqual(info, { kind: "dev", sha: SHA, dir: root }, "dev build");
  assert.equal(buildLabel(info), "dev@0123456", "dev label carries the short sha");
});

test("readBuildInfo: a torn manifest falls back to dev", () => {
  const root = mkdtempSync(path.join(tmpdir(), "argus-build-"));
  writeFileSync(path.join(root, RELEASE_MANIFEST), "{");
  assert.equal(readBuildInfo(root, () => null).kind, "dev", "torn manifest is not a release");
  assert.equal(buildLabel(readBuildInfo(root, () => null)), "dev@unknown", "unknown sha label");
});

test("BUILD_ROOT is the repository root this module runs from", () => {
  assert.ok(
    existsSync(path.join(BUILD_ROOT, "server", "package.json")),
    "BUILD_ROOT holds server/",
  );
  assert.ok(readBuildInfo().dir === BUILD_ROOT, "the default root is BUILD_ROOT");
});
