#!/usr/bin/env node
/**
 * A performance budget for *feel*, in the same spirit as the initial-payload one
 * next to it.
 *
 * The rule the motion layer is built on is that animation runs on the compositor:
 * `transform`, `opacity` and `filter` can be handed to the GPU and animated
 * without the main thread re-laying-out or repainting the page. Animate `width`,
 * `top`, `margin` or `height` instead and every frame costs a layout — which on a
 * dashboard whose whole job is to be left open, updating, is the difference
 * between 120fps and a fan spinning up.
 *
 * That rule was a convention, and conventions decay silently. It had already
 * decayed once: `sweep` — the indeterminate strip on every working step tile —
 * animated `left`, sixty times a second, for a decoration, in a file whose own
 * comment claimed every keyframe here was "opacity/transform only". Nobody was
 * lying; nothing was checking.
 *
 * So this checks. Two things:
 *
 *  1. No `@keyframes` in any stylesheet under `web/src/**` may animate a
 *     non-compositor property.
 *  2. No `transition-[…]` utility in `web/src/**` may name one, except at the
 *     sites listed in ALLOWED_LAYOUT_TRANSITIONS below — each of which is a
 *     deliberate, argued exception rather than an oversight.
 *  3. No `transition-all` anywhere. It is the hole rule 2 cannot see: an
 *     arbitrary-value utility names the properties it animates and so can be
 *     checked, whereas `transition-all` animates every property that changes —
 *     `width`, `height`, `top` included — while naming none of them. There are
 *     none today; this is what keeps it that way.
 *
 * Raising the budget is a normal thing to do. Doing it here, in the commit that
 * needs it, with the reason written down, is the point.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = path.join(repoRoot, "web", "src");

/** Everything the compositor can animate on its own, plus the harmless ones. */
const COMPOSITOR_SAFE = new Set([
  "transform",
  "opacity",
  "filter",
  "backdrop-filter",
  "background-position",
  "color",
  "background-color",
  "border-color",
  "box-shadow",
  "outline-color",
  "fill",
  "stroke",
  "scale",
  "rotate",
  "translate",
]);

/**
 * The argued exceptions.
 *
 * All four are meter fills: a leaf element inside an `overflow-hidden` track,
 * with no siblings a width change could move. The analysis proposed `scaleX`
 * instead, and `scaleX` was the wrong call here — every one of these fills is
 * `rounded-full`, and scaling one horizontally turns its cap from a circle into an
 * ellipse. That is a change to what the app *looks* like, and "no pixel of static
 * UI changes" is the harder constraint of the two. A width transition on a 2px
 * strip costs one clipped repaint and moves nothing.
 */
const ALLOWED_LAYOUT_TRANSITIONS = [
  { file: "views/Budget.tsx", property: "width", why: "budget window meter fill" },
  { file: "views/Stats.tsx", property: "width", why: "per-model and per-day meter fills" },
  { file: "views/LedgerPanels.tsx", property: "width", why: "attribution share fill" },
  { file: "views/SituationStrip.tsx", property: "width", why: "today's spend meter fill" },
  {
    file: "NavBar.tsx",
    property: "width",
    why: "the active-tab pill is absolutely positioned and must become the width of the tab it slides to",
  },
];

const failures = [];

function* walk(dir, match) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full, match);
    else if (match(entry)) yield full;
  }
}

const relativeToWeb = (file) => `web/src/${path.relative(webSrc, file).split(path.sep).join("/")}`;

// ── 1. Keyframes ────────────────────────────────────────────────────────────
// Every stylesheet, not just `index.css`: a second one is exactly where a
// non-compositor keyframe would land next, and finding it should not depend on
// somebody remembering to widen this script at the same time.
for (const file of walk(webSrc, (entry) => entry.endsWith(".css"))) {
  const css = readFileSync(file, "utf8");
  for (const block of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = block;
    for (const declaration of body.matchAll(/^\s*([a-z-]+)\s*:/gm)) {
      const property = declaration[1];
      if (!COMPOSITOR_SAFE.has(property)) {
        failures.push(
          `${relativeToWeb(file)}  @keyframes ${name} animates \`${property}\`, which is not compositor-only.`,
        );
      }
    }
  }
}

// ── 2. Transition utilities ─────────────────────────────────────────────────

const allowed = new Set(ALLOWED_LAYOUT_TRANSITIONS.map((a) => `${a.file}:${a.property}`));
const usedExceptions = new Set();

const isSource = (entry) => /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry);

for (const file of walk(webSrc, isSource)) {
  const relative = path.relative(webSrc, file).split(path.sep).join("/");
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/transition-\[([a-z,_-]+)\]/g)) {
    for (const raw of match[1].split(",")) {
      const property = raw.trim().replace(/_/g, "-");
      if (property === "" || COMPOSITOR_SAFE.has(property)) continue;
      const key = `${relative}:${property}`;
      if (allowed.has(key)) {
        usedExceptions.add(key);
        continue;
      }
      failures.push(
        `web/src/${relative}  transitions \`${property}\`, which costs a layout every frame.\n` +
          `      Use a transform, or add it to ALLOWED_LAYOUT_TRANSITIONS in this script with the reason.`,
      );
    }
  }
  // ── 3. `transition-all` ───────────────────────────────────────────────────
  // No exception list: naming the properties you animate is the whole point, and
  // `transition-all` is the one utility that refuses to. There is always a
  // narrower spelling.
  for (const _ of source.matchAll(/\btransition-all\b/g)) {
    failures.push(
      `web/src/${relative}  uses \`transition-all\`, which animates whatever happens to change —\n` +
        `      layout properties included — and names none of it, so this budget cannot check it.\n` +
        `      Name the properties instead: \`transition-[opacity,transform]\`.`,
    );
  }
}

// A stale exception is a claim nobody is checking any more; drop it.
for (const exception of ALLOWED_LAYOUT_TRANSITIONS) {
  const key = `${exception.file}:${exception.property}`;
  if (!usedExceptions.has(key)) {
    failures.push(
      `ALLOWED_LAYOUT_TRANSITIONS lists ${key} ("${exception.why}") but nothing transitions it any more — remove the exception.`,
    );
  }
}

console.log("Motion property budget:");
console.log(`  keyframes checked in every web/src/**/*.css`);
console.log(`  ${ALLOWED_LAYOUT_TRANSITIONS.length} argued layout-transition exceptions`);

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):\n`);
  for (const failure of failures) console.error(`  • ${failure}`);
  console.error(
    "\nMotion in Argus is transform/opacity only. That is what makes it free to leave\n" +
      "a dashboard open all day; a layout-animating frame is not.\n",
  );
  process.exit(1);
}

console.log("\nEvery animation is compositor-only ✓");
