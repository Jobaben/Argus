import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gitArchiveExtract, runRelease, type ProcResult, type ReleaseIo } from "./release.js";
import { SMOKE_PATHS } from "./releaseCore.js";

function git(cwd: string, ...args: string[]): ProcResult {
  const r = spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=T", ...args], {
    cwd,
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A checkout with one commit: a version, an ignored experiments folder, a source file. */
function checkout(version = "2.0.0"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-release-src-"));
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  // export-ignore is read from the tree being archived, so it must be committed.
  writeFileSync(path.join(dir, ".gitattributes"), "experiments/ export-ignore\n");
  mkdirSync(path.join(dir, "experiments"));
  writeFileSync(path.join(dir, "experiments", "probe.mjs"), "");
  writeFileSync(path.join(dir, "source.txt"), "committed");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

interface Harness {
  io: ReleaseIo;
  out: string[];
  err: string[];
  builds: string[];
}

/** Real git and extraction; the build writes what a real one would, or fails. */
function harness(
  src: string,
  build: (dir: string) => number | void = () => {},
  version = "2.0.0",
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const builds: string[] = [];
  let tick = 0;
  const io: ReleaseIo = {
    checkout: src,
    root: path.join(mkdtempSync(path.join(tmpdir(), "argus-releases-")), "releases"),
    git: async (args, cwd) => git(cwd, ...args),
    extract: gitArchiveExtract(src),
    build: async (dir) => {
      builds.push(dir);
      for (const p of SMOKE_PATHS) {
        const full = path.join(dir, p);
        if (path.extname(p) !== "") {
          mkdirSync(path.dirname(full), { recursive: true });
          writeFileSync(full, "");
        } else mkdirSync(full, { recursive: true });
      }
      writeFileSync(
        path.join(dir, "server", "dist", "version.js"),
        `export const VERSION = ${JSON.stringify(version)};\n`,
      );
      return build(dir) ?? 0;
    },
    importModule: (file) => import(`${pathToFileURL(file).href}?${Math.random()}`),
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, tick++)),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { io, out, err, builds };
}

const pointer = (h: Harness) =>
  JSON.parse(readFileSync(path.join(h.io.root, "current.json"), "utf8")) as {
    id: string;
    previous: string | null;
  };

test("release: extracts the commit, builds it, writes the manifest and pins it", async () => {
  const src = checkout();
  const sha = git(src, "rev-parse", "HEAD").stdout.trim();
  const h = harness(src);
  assert.equal(await runRelease([], h.io), 0, `release succeeds: ${h.err.join("\n")}`);
  const id = `2.0.0-${sha.slice(0, 7)}`;
  const dir = path.join(h.io.root, id);
  assert.equal(readFileSync(path.join(dir, "source.txt"), "utf8"), "committed", "commit extracted");
  assert.equal(existsSync(path.join(dir, "experiments")), false, "export-ignore honoured");
  const manifest = JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8")) as {
    id: string;
    sha: string;
  };
  assert.deepEqual([manifest.id, manifest.sha], [id, sha], "manifest names the release");
  assert.deepEqual(pointer(h), { ...pointer(h), id, previous: null }, "pinned");
});

test("release: uncommitted changes are warned about and left out", async () => {
  const src = checkout();
  writeFileSync(path.join(src, "source.txt"), "edited, not committed");
  const h = harness(src);
  assert.equal(await runRelease([], h.io), 0, "release succeeds");
  assert.ok(
    h.err.some((l) => /uncommitted/.test(l)),
    "warns about uncommitted changes",
  );
  const dir = path.join(h.io.root, pointer(h).id);
  assert.equal(readFileSync(path.join(dir, "source.txt"), "utf8"), "committed", "only the commit");
});

test("release: the same commit again is not rebuilt", async () => {
  const src = checkout();
  const h = harness(src);
  assert.equal(await runRelease([], h.io), 0, `first release: ${h.err.join("; ")}`);
  assert.equal(await runRelease([], h.io), 0, `second release: ${h.err.join("; ")}`);
  assert.equal(h.builds.length, 1, "built once");
  assert.ok(
    h.out.some((l) => /already built/.test(l)),
    "says it was already built",
  );
});

test("release: a failed build leaves no manifest and moves no pointer", async () => {
  const src = checkout();
  const h = harness(src, () => 3);
  assert.equal(await runRelease([], h.io), 1, "release fails");
  assert.ok(
    h.err.some((l) => /build failed \(exit 3\)/.test(l)),
    "says the build failed",
  );
  assert.equal(existsSync(path.join(h.io.root, "current.json")), false, "nothing pinned");
  assert.equal(await runRelease([], { ...h.io, build: harness(src).io.build }), 0, "retry builds");
  assert.ok(
    h.out.some((l) => /removing an unfinished build/.test(l)),
    "the torn folder is replaced",
  );
});

test("release: a build whose version.js disagrees fails the smoke check", async () => {
  const src = checkout();
  const h = harness(src, () => {}, "9.9.9");
  assert.equal(await runRelease([], h.io), 1, "smoke fails");
  assert.ok(
    h.err.some((l) => /reports 9\.9\.9, expected 2\.0\.0/.test(l)),
    "names the mismatch",
  );
  assert.equal(existsSync(path.join(h.io.root, "current.json")), false, "nothing pinned");
});

test("release --use: pins a built release, records the previous one, warns on a rollback", async () => {
  const src = checkout("1.0.0");
  const h = harness(src, () => {}, "1.0.0");
  assert.equal(await runRelease([], h.io), 0, `first release: ${h.err.join("; ")}`);
  const first = pointer(h).id;
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ version: "1.1.0" }));
  git(src, "commit", "-qam", "bump");
  const h2 = harness(src, () => {}, "1.1.0");
  h2.io.root = h.io.root;
  assert.equal(await runRelease([], h2.io), 0, `second release: ${h2.err.join("; ")}`);
  const second = pointer(h).id;
  assert.equal(pointer(h).previous, first, "previous recorded");

  assert.equal(await runRelease(["--use", first], h.io), 0, "roll back");
  assert.equal(pointer(h).id, first, "rolled back");
  assert.ok(
    h.err.some((l) => /older than/.test(l)),
    "rollback warns",
  );
  assert.equal(await runRelease(["--use", "nope-0000000"], h.io), 1, "unknown id fails");

  h.out.length = 0;
  assert.equal(await runRelease(["--list"], h.io), 0, "list");
  assert.deepEqual(
    h.out.map((l) => l.slice(0, 2 + first.length)),
    [`* ${first}`, `  ${second}`],
    "both listed, the pinned one starred",
  );
});

test("release: a ref that is not a commit fails before touching the releases", async () => {
  const h = harness(checkout());
  assert.equal(await runRelease(["--ref", "no-such-ref"], h.io), 1, "fails");
  assert.ok(
    h.err.some((l) => /cannot resolve "no-such-ref"/.test(l)),
    "says why",
  );
  assert.equal(h.builds.length, 0, "nothing built");
});
