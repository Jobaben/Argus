import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The sources are text, and every tool downstream assumes it.
 *
 * `ds/presence.ts` shipped with two literal NUL bytes in it — a delimiter written
 * as the raw character instead of the `\0` escape. It compiled, it typechecked,
 * prettier called it well-formatted and git stored it as text, so nothing in CI
 * had an opinion. What it did break was everything that sniffs for binary
 * content: `grep` reported "binary file matches" and printed no lines, so a search
 * across the motion layer silently skipped the largest file in it, and `file`
 * called it `data`.
 *
 * That is a bad failure because it is invisible in review — a diff shows nothing
 * where the byte is — and it degrades the tools you would use to find it. Hence a
 * test: control characters do not belong in source, and the escape sequence that
 * does is one character longer.
 */

const srcDir = path.join(__dirname);

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.(tsx?|css)$/.test(entry)) yield full;
  }
}

/** Tab, newline and carriage return are the only control characters that are text. */
function isDisallowed(byte: number): boolean {
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false;
  return byte < 0x20 || byte === 0x7f;
}

describe("source hygiene", () => {
  const files = [...sources(srcDir)];

  it("finds the sources to check at all", () => {
    // A walker that silently matched nothing would make every assertion below
    // pass while checking not one byte.
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no control characters outside tab and newline", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const bytes = readFileSync(file);
      for (let i = 0; i < bytes.length; i++) {
        if (!isDisallowed(bytes[i])) continue;
        const upTo = bytes.subarray(0, i).toString("utf8");
        offenders.push(
          `${path.relative(srcDir, file)}:${upTo.split("\n").length} ` +
            `has 0x${bytes[i].toString(16).padStart(2, "0")} — write it as an escape instead`,
        );
        break; // one report per file is enough to act on
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is valid UTF-8", () => {
    const offenders = files.filter((file) => {
      const bytes = readFileSync(file);
      // A lossy decode substitutes U+FFFD for anything invalid, so a round-trip
      // that changes length is a decode that lost something.
      return Buffer.from(bytes.toString("utf8"), "utf8").length !== bytes.length;
    });
    expect(offenders.map((f) => path.relative(srcDir, f))).toEqual([]);
  });
});
