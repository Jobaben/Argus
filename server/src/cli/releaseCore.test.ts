import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  parseReleaseArgs,
  releaseId,
  renderList,
  rollbackWarning,
  type ReleaseManifest,
} from "./releaseCore.js";

test("parseReleaseArgs: build HEAD by default, or the given ref", () => {
  assert.deepEqual(parseReleaseArgs([]), { kind: "cut", ref: "HEAD" }, "default ref");
  assert.deepEqual(
    parseReleaseArgs(["--ref", "v1.0.0"]),
    { kind: "cut", ref: "v1.0.0" },
    "--ref x",
  );
  assert.deepEqual(parseReleaseArgs(["--ref=main"]), { kind: "cut", ref: "main" }, "--ref=x");
});

test("parseReleaseArgs: --list, --use, --help", () => {
  assert.deepEqual(parseReleaseArgs(["--list"]), { kind: "list" }, "list");
  assert.deepEqual(
    parseReleaseArgs(["--use", "1.0.0-abcdef0"]),
    { kind: "use", id: "1.0.0-abcdef0" },
    "use",
  );
  assert.deepEqual(parseReleaseArgs(["--help"]), { kind: "help" }, "help");
});

test("parseReleaseArgs: rejects what it cannot act on", () => {
  for (const argv of [
    ["--ref"],
    ["--use"],
    ["--use", "../x"],
    ["--bogus"],
    ["--list", "--ref", "x"],
    ["stray"],
  ])
    assert.equal(parseReleaseArgs(argv).kind, "error", `rejects ${argv.join(" ")}`);
});

test("releaseId: version plus the short sha", () => {
  assert.equal(
    releaseId("1.0.0", "abcdef0123456789abcdef0123456789abcdef01"),
    "1.0.0-abcdef0",
    "version-sha7",
  );
});

test("compareVersions: numeric, not lexical", () => {
  assert.ok(compareVersions("1.10.0", "1.9.0") > 0, "1.10 > 1.9");
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0, "equal");
  assert.equal(compareVersions("dev", "1.0.0"), 0, "unparseable compares equal");
});

const m = (id: string, version: string, builtAt = "2026-10-14T00:00:00Z"): ReleaseManifest => ({
  id,
  version,
  sha: "a".repeat(40),
  ref: "HEAD",
  builtAt,
});

test("rollbackWarning: only when moving to an older version", () => {
  assert.equal(rollbackWarning(null, m("1.0.0-a", "1.0.0")), null, "first pin");
  assert.equal(rollbackWarning(m("1.0.0-a", "1.0.0"), m("1.1.0-b", "1.1.0")), null, "forward");
  assert.match(
    rollbackWarning(m("1.1.0-b", "1.1.0"), m("1.0.0-a", "1.0.0")) ?? "",
    /older.*Knowledge Ledger/s,
    "rollback warns",
  );
});

test("renderList: oldest first, the pinned one starred", () => {
  const lines = renderList([m("b", "1.1.0", "2026-10-15"), m("a", "1.0.0", "2026-10-14")], "b");
  assert.equal(lines.length, 2, "two releases");
  assert.match(lines[0], /^ {2}a /, "older first, unstarred");
  assert.match(lines[1], /^\* b /, "pinned starred");
  assert.match(renderList([], null)[0], /no releases/, "empty");
});
