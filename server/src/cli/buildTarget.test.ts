import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BuildTargetError,
  POINTER_FILE,
  readPointer,
  RELEASE_MANIFEST,
  releasesRoot,
  resolveBuildRoot,
} from "../../../bin/lib/buildTarget.mjs";
import { RELEASE_MANIFEST as SERVER_MANIFEST } from "../buildInfo.js";

test("releasesRoot: a sibling of the default Claude home", () => {
  assert.equal(
    releasesRoot({}, path.resolve("/u")),
    path.join(path.resolve("/u"), ".claude-argus-releases"),
    "default sits beside ~/.claude",
  );
});

test("releasesRoot: follows ARGUS_CLAUDE_HOME, then CLAUDE_CONFIG_DIR, and ignores blanks", () => {
  const a = path.resolve("/x/home-a");
  const b = path.resolve("/y/home-b");
  assert.equal(
    releasesRoot({ ARGUS_CLAUDE_HOME: a, CLAUDE_CONFIG_DIR: b }, "/u"),
    `${a}-argus-releases`,
    "ARGUS_CLAUDE_HOME wins",
  );
  assert.equal(releasesRoot({ CLAUDE_CONFIG_DIR: b }, "/u"), `${b}-argus-releases`, "config dir");
  assert.equal(
    releasesRoot({ ARGUS_CLAUDE_HOME: "  " }, path.resolve("/u")),
    path.join(path.resolve("/u"), ".claude-argus-releases"),
    "a blank override falls back to the default",
  );
});

test("releasesRoot: never under the work root, even when ARGUS_WORK_DIR is set", () => {
  const work = path.resolve("/work");
  assert.ok(!releasesRoot({ ARGUS_WORK_DIR: work }, "/u").startsWith(work), "not under work dir");
});

test("the launcher and the server agree on the release manifest's name", () => {
  assert.equal(RELEASE_MANIFEST, SERVER_MANIFEST, "one manifest name on both sides");
});

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "argus-target-"));
  const home = path.join(base, ".claude");
  const env = { ARGUS_CLAUDE_HOME: home };
  const root = releasesRoot(env);
  mkdirSync(root, { recursive: true });
  return { env, root, checkout: path.join(base, "checkout") };
}

test("resolveBuildRoot: no pointer runs the checkout with a warning", () => {
  const { env, checkout } = setup();
  const t = resolveBuildRoot({ checkout, env });
  assert.equal(t.kind, "dev", "dev without a pointer");
  assert.equal(t.root, checkout, "the checkout");
  assert.match(t.kind === "dev" ? t.warning : "", /no release is pinned/, "says why");
});

test("resolveBuildRoot: a pointer to a finished release runs it", () => {
  const { env, root, checkout } = setup();
  mkdirSync(path.join(root, "1.0.0-abcdef0"));
  writeFileSync(path.join(root, "1.0.0-abcdef0", RELEASE_MANIFEST), "{}");
  writeFileSync(path.join(root, POINTER_FILE), JSON.stringify({ id: "1.0.0-abcdef0" }));
  assert.deepEqual(
    resolveBuildRoot({ checkout, env }),
    { kind: "release", root: path.join(root, "1.0.0-abcdef0"), id: "1.0.0-abcdef0" },
    "the pinned release",
  );
  assert.equal(resolveBuildRoot({ checkout, env, dev: true }).root, checkout, "--dev wins");
});

test("resolveBuildRoot: a pointer to a missing or unfinished release fails loudly", () => {
  const { env, root, checkout } = setup();
  writeFileSync(path.join(root, POINTER_FILE), JSON.stringify({ id: "1.0.0-abcdef0" }));
  assert.throws(() => resolveBuildRoot({ checkout, env }), /--use.*--dev/s, "missing dir");
  mkdirSync(path.join(root, "1.0.0-abcdef0"));
  assert.throws(() => resolveBuildRoot({ checkout, env }), BuildTargetError, "no manifest");
});

test("readPointer: rejects a pointer that is not JSON or names a path", () => {
  const { root } = setup();
  writeFileSync(path.join(root, POINTER_FILE), "{");
  assert.throws(() => readPointer(root), BuildTargetError, "torn pointer");
  writeFileSync(path.join(root, POINTER_FILE), JSON.stringify({ id: "../escape" }));
  assert.throws(() => readPointer(root), BuildTargetError, "a path is not an id");
});
