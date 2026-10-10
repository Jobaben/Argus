// A controlled process tree for processTree.test.ts. Never run by Argus.
//
//   node processTreeFixture.mjs <pid-file> <mode>
//
// The root spawns one descendant that inherits its stdout/stderr — the shape
// that keeps an owner's `close` from firing when only the root dies — writes
// the descendant's pid to <pid-file>, then waits. Both ignore SIGTERM, so on
// POSIX only the SIGKILL escalation ends them. Modes:
//
//   hang     the root prints a line and waits forever
//   flood    the root writes far more than any output cap, then waits
//   complete no descendant: writes 200 KiB and a marker, then exits 0
//   escape   POSIX only: the descendant starts its own session (setsid via
//            `detached`), so a group kill cannot reach it — the stand-in for a
//            descendant that is out of reach. The test that uses it lets it
//            exit by removing the pid file.
//   escape-flood  POSIX only: escape and flood together — an unreachable
//            descendant holds the pipe while the root blows the output cap
//
// The descendant only ever exits by being killed or by noticing that the pid
// file has been removed, so a failed test run cannot leave it behind for long.

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [pidFile, mode] = process.argv.slice(2);
process.on("SIGTERM", () => {});

if (mode === "complete") {
  // No tree at all: write more than one pipe buffer, then exit normally.
  process.stdout.write("x".repeat(200 * 1024));
  process.stdout.write("END-MARKER");
  process.exitCode = 0;
} else if (mode === "descendant") {
  // Self-limiting: the test removes the pid file when it is done.
  setInterval(() => {
    if (!existsSync(pidFile)) process.exit(0);
  }, 250);
} else {
  const descendant = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), pidFile, "descendant"],
    {
      stdio: ["ignore", "inherit", "inherit"],
      detached: mode === "escape" || mode === "escape-flood",
      windowsHide: true,
    },
  );
  writeFileSync(pidFile, String(descendant.pid));
  if (mode === "flood" || mode === "escape-flood") process.stdout.write("x".repeat(64 * 1024));
  process.stdout.write("root up\n");
  setInterval(() => {}, 1000);
}
