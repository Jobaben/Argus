import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteFile, renameOver, RENAME_RETRY_DELAYS_MS } from "./atomicWrite.js";

const err = (code: string) => Object.assign(new Error(code), { code });

/** A rename that fails with `code` for its first `failures` calls. */
function flakyRename(code: string, failures: number) {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    rename: async (from: string, to: string) => {
      calls.push([from, to]);
      if (calls.length <= failures) throw err(code);
    },
  };
}

const noSleep = async () => {};

test("Windows: a rename refused while a reader holds the target open is retried until it lands", async () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const r = flakyRename(code, 3);
    await renameOver("t.tmp", "t.json", { rename: r.rename, platform: "win32", sleep: noSleep });
    assert.equal(r.calls.length, 4, `${code}: three refusals, then the rename that lands`);
  }
});

test("Windows: the retries are bounded, and the last refusal is thrown", async () => {
  const r = flakyRename("EPERM", Infinity);
  const slept: number[] = [];
  await assert.rejects(
    renameOver("t.tmp", "t.json", {
      rename: r.rename,
      platform: "win32",
      sleep: async (ms) => void slept.push(ms),
    }),
    { code: "EPERM" },
  );
  assert.equal(r.calls.length, RENAME_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(slept, [...RENAME_RETRY_DELAYS_MS]);
});

test("a real error is never retried, and POSIX never retries at all", async () => {
  const enoent = flakyRename("ENOENT", Infinity);
  await assert.rejects(
    renameOver("t.tmp", "t.json", { rename: enoent.rename, platform: "win32", sleep: noSleep }),
    { code: "ENOENT" },
  );
  assert.equal(enoent.calls.length, 1);

  const posix = flakyRename("EPERM", Infinity);
  await assert.rejects(
    renameOver("t.tmp", "t.json", { rename: posix.rename, platform: "linux", sleep: noSleep }),
    { code: "EPERM" },
  );
  assert.equal(posix.calls.length, 1, "EPERM on POSIX is a real permission error");
});

test("atomicWriteFile replaces the file and leaves no temp sibling behind", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "argus-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "record.json");
  await atomicWriteFile(file, "one");
  await atomicWriteFile(file, "two");
  assert.equal(readFileSync(file, "utf8"), "two");
  assert.deepEqual(readdirSync(dir), ["record.json"]);
});
