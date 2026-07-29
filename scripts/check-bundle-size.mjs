#!/usr/bin/env node
/**
 * A performance budget for the initial page load.
 *
 * Bundle size regresses the way a lawn grows: never in one visible step. A view
 * imports a date library "just for one format call", a chunk boundary quietly
 * disappears because a lazy route got referenced eagerly somewhere, and six
 * months later the dashboard takes two seconds to appear on a slow link and
 * nobody can point at the commit that did it.
 *
 * So the *initial payload* — the entry chunk, everything it statically imports
 * (whatever `index.html` preloads), and the stylesheet — is measured gzipped and
 * held under a budget. Lazily-loaded route chunks are deliberately excluded:
 * they are the reward for splitting, and counting them would punish it.
 *
 * Raising the budget is a normal thing to do. Doing it in the same commit as the
 * change that needs it, with a reason, is the point.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Gzipped kilobytes the first paint is allowed to cost.
 *
 * Today's payload is ~110 kB, most of it React itself. The ~9% of headroom is
 * deliberate: a budget with no slack fails on unrelated work and gets raised
 * reflexively, which is the same as having no budget. This much catches a new
 * dependency landing in the shell without failing on a few more components.
 *
 * Raised from 110 by the motion uplift, which spent ~10 kB gzip: about 4 kB of
 * new stylesheet (the exit and directional keyframes, the view-transition rules,
 * the sampled spring) and about 6 kB of shell JavaScript (`ds/presence`, `flip`,
 * `spring`, `gesture`, `direction`, `viewTransition`). None of it can be lazy —
 * it is what every route's entrance and exit is built from, so a lazy boundary
 * would make the first navigation the one that does not animate.
 */
const BUDGET_KB = 120;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "web", "dist");
const indexHtml = path.join(distDir, "index.html");

try {
  statSync(indexHtml);
} catch {
  console.error(`No build found at ${path.relative(repoRoot, indexHtml)} — run \`npm run build\`.`);
  process.exit(1);
}

const html = readFileSync(indexHtml, "utf8");

// Everything the browser fetches before it can paint: the entry script, the
// modulepreloaded chunks it statically imports, and the stylesheet.
const referenced = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
const initial = [...new Set(referenced)].filter((f) => f.endsWith(".js") || f.endsWith(".css"));

if (initial.length === 0) {
  console.error("Could not find any asset references in index.html — is the build intact?");
  process.exit(1);
}

const rows = initial
  .map((file) => {
    const raw = readFileSync(path.join(distDir, file));
    return { file, raw: raw.byteLength, gzip: gzipSync(raw).byteLength };
  })
  .sort((a, b) => b.gzip - a.gzip);

const totalGzip = rows.reduce((n, r) => n + r.gzip, 0);
const kb = (bytes) => (bytes / 1024).toFixed(1);

console.log("Initial payload (gzipped):");
for (const row of rows) {
  console.log(`  ${kb(row.gzip).padStart(7)} kB  ${row.file}  (raw ${kb(row.raw)} kB)`);
}
console.log(`  ${"—".repeat(7)}`);
console.log(`  ${kb(totalGzip).padStart(7)} kB  total  (budget ${BUDGET_KB} kB)`);

if (totalGzip > BUDGET_KB * 1024) {
  console.error(
    `\nOver budget by ${kb(totalGzip - BUDGET_KB * 1024)} kB.\n` +
      "Either trim the initial payload — a `lazy()` route boundary is usually the\n" +
      "answer — or raise BUDGET_KB in this script, in the commit that needs it.\n",
  );
  process.exit(1);
}

console.log(`\nWithin budget, ${kb(BUDGET_KB * 1024 - totalGzip)} kB to spare ✓`);
