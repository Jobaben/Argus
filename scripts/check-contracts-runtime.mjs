#!/usr/bin/env node
/**
 * Guards the one invariant that makes `@argus/contracts` safe to import from
 * both workspaces without a build step: it must emit **no runtime code**.
 *
 * The package is resolved straight from `src/*.ts` through its `exports` map.
 * That works only while every export is erasable (interfaces and type aliases).
 * The moment someone adds a `const`, an enum or a helper function, the server's
 * compiled `dist/` and the web bundle would need to resolve a real module at
 * runtime — and the server build, which does not compile this package, would
 * fail at import time rather than at review time.
 *
 * So: compile the contract for real and assert every emitted file is empty
 * apart from comments and an `export {}` marker.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(path.join(tmpdir(), "argus-contracts-"));

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

try {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      path.join(repoRoot, "contracts", "tsconfig.json"),
      "--noEmit",
      "false",
      "--outDir",
      outDir,
    ],
    { stdio: "inherit", cwd: repoRoot },
  );

  const offenders = walk(outDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => {
      const stripped = readFileSync(f, "utf8")
        // block comments, line comments, the empty-module marker, whitespace
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/^\s*export\s*\{\s*\};?\s*$/gm, "")
        .trim();
      return { file: path.relative(outDir, f), stripped };
    })
    .filter((r) => r.stripped.length > 0);

  if (offenders.length > 0) {
    console.error("\n@argus/contracts emitted runtime code — it must stay types-only:\n");
    for (const o of offenders) {
      console.error(`  ${o.file}:\n    ${o.stripped.split("\n").join("\n    ")}\n`);
    }
    console.error(
      "Move runtime helpers into server/src or web/src; the contract declares shapes only.\n",
    );
    process.exit(1);
  }

  console.log("@argus/contracts is types-only ✓");
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
