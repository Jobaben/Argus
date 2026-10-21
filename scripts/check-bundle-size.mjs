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
 *
 * Raised from 120 to 122 by the harness wave. The board is the default route,
 * so what it needs to draw a phase is shell code: the candidate, workspace and
 * trigger pills in `ds/overviewRow` and `ds/format` added ~0.7 kB gzip. The
 * webhook and chaining editors were kept out of the shell by importing
 * `TriggerFields` directly from its module in the two lazy forms that use it
 * rather than through the `ds` barrel; `main` was already 0.6 kB over before
 * the wave, so the new figure is measured, not padded.
 *
 * Raised from 122 to 130 by the Night Watch design uplift, which measured
 * 128.0 kB after trimming. Where the 6 kB went, against the 121.9 kB it
 * started from:
 *   - the stylesheet, +5.0 kB: Tailwind emits one sheet for every route, lazy
 *     or not, and every view was restyled onto the new scale, surfaces and
 *     states — spread over ~1,500 rules, with no single offender to cut;
 *   - the `ds` chunk, +3.4 kB: the icon set (paths for every glyph the app
 *     used to borrow from the OS's fonts), the Button/IconButton/field
 *     controls, and the restyled primitives the shell draws with;
 *   - the entry chunk, −1.8 kB, net of the Command Center's new "Needs you"
 *     inbox: the command palette and shortcut sheet moved to their own chunk
 *     (fetched just after first paint), and the lazy-only form pickers,
 *     HeartbeatBar, Legend, Tabs, InfoTip and chronicleLayout left the `ds`
 *     barrel, which had been pulling them into the shell.
 * What the first paint actually transfers went down, not up: the same change
 * stopped loading the 20 kB Hellix Bold file (SemiBold now answers for every
 * heavy weight), and fonts are outside this measurement. Two kB of headroom,
 * not ten: the reason for the raise is written down, and the next one should
 * be too.
 *
 * Raised from 130 to 132 by the QA pass that followed, which measured 130.9 kB
 * after its trims. It added about 3.3 kB to the first paint and took 2.2 kB back:
 *   - the Command Center, +~0.8 kB: the reset confirm became a popover that
 *     takes focus, answers Escape and hands focus back; a board that fails to
 *     load says why and marks "Needs you" as partial; the phase graph's
 *     controls moved to a toolbar beside the canvas instead of over its nodes,
 *     and nodes are sized for their markers and never drawn below a legible
 *     scale;
 *   - the shell, +~0.5 kB: focus and a polite announcement on a route change
 *     that lost focus, the auth state following an in-page sign-in, a phone
 *     header that never pushes its controls off screen;
 *   - `live/loadError`, +0.3 kB: an error answer is told apart from an
 *     unreachable server and keeps the server's reason;
 *   - the stylesheet, +0.3 kB, for the above;
 *   - offsets: the peer-machine board, picker and banner (−1.5 kB) and the
 *     orphaned instance's Stop confirm now load only when they are on screen.
 * The headroom is back to 1.1 kB.
 */
const BUDGET_KB = 132;

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
