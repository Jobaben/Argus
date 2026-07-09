# Argus design system — sync sources

The Argus design system lives in two places:

- **In code**: [`web/src/ds/`](../web/src/ds/) — the React components and
  Tailwind tokens the app actually ships.
- **On claude.ai/design**: the **"Argus Design System"** project — one preview
  card per foundation/component (`foundations/*/index.html`,
  `components/*/index.html`, `brand/*/index.html`), indexed by the first-line
  `<!-- @dsCard group="…" -->` marker compiled into `_ds_manifest.json`.

This directory holds the repo-authored card sources that have been added to
that project from here, mirrored at their exact remote paths. Cards authored
elsewhere are canonical in the remote project and are intentionally **not**
duplicated in the repo.

## Card conventions (match the existing remote cards)

- First line: `<!-- @dsCard group="Components" -->` (groups in use:
  `Foundations`, `Components`, `Brand`).
- A complete, self-contained HTML document — all CSS inlined, no external
  requests (the design pane enforces a strict CSP). Fonts may reference the
  project's own `fonts/*.woff2` by relative path.
- Dark ground (`#0a0f16`), centered demo, `prefers-reduced-motion` guard on
  any animation.

## Syncing

Use the `DesignSync` tool (or the `/design-sync` skill) **incrementally** —
one component at a time, never a wholesale replace:

1. `list_files` on the project to diff structure.
2. `finalize_plan` with only the paths you're adding/updating, plus
   `_ds_manifest.json` when the card list changes.
3. `write_files` from this directory.

When a token or component changes in `web/src/ds/`, update its card in the
same change and re-sync just that card.
