/**
 * Test-only platform capabilities, probed once per test process.
 *
 * A test that needs something the platform or account cannot provide is
 * skipped with the reason, never silently weakened. Each `…Skip` value is a
 * ready `{ skip }` argument: `false` when the capability is there, otherwise
 * the reason it is not.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function probeSymlinks(): boolean {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(path.join(tmpdir(), "argus-symlink-probe-"));
    writeFileSync(path.join(dir, "file"), "x");
    mkdirSync(path.join(dir, "dir"));
    symlinkSync(path.join(dir, "file"), path.join(dir, "file-link"), "file");
    symlinkSync(path.join(dir, "dir"), path.join(dir, "dir-link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** `{ skip: symlinkSkip }` for a test that creates symbolic links. */
export const symlinkSkip: string | false = probeSymlinks()
  ? false
  : "cannot create symbolic links here (on Windows this needs Developer Mode or administrator rights)";

/** `{ skip: posixModeSkip }` for a test that asserts POSIX permission bits. */
export const posixModeSkip: string | false =
  process.platform === "win32"
    ? "Windows has no POSIX permission bits (stat reports only the read-only attribute)"
    : false;

/**
 * A stand-in for the engine's `kill` dependency. Engine tests use invented
 * pids, and on a real host an invented pid can belong to someone else's
 * process — so an engine test that does not exercise real termination must
 * never reach the real `killRunProcess`.
 */
export function fakeKill(): {
  kill: (pid: number, signal?: NodeJS.Signals) => boolean;
  calls: Array<[number, NodeJS.Signals | undefined]>;
} {
  const calls: Array<[number, NodeJS.Signals | undefined]> = [];
  return {
    calls,
    kill: (pid, signal) => {
      calls.push([pid, signal]);
      return true;
    },
  };
}
