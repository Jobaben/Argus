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

Motion is a foundation, not a component, and it has two cards:
`foundations/motion-lifecycle` (the paired entrance/exit contract every surface
obeys) and `foundations/motion-choreography` (how a live list shows change as
change). Both are runnable demos, not diagrams — motion reviewed as a
screenshot is motion nobody reviewed. See
[`docs/MOTION-SYSTEM.md`](../docs/MOTION-SYSTEM.md) for the system they card.

## Cards in this directory

Foundations:

- [`foundations/colour`](foundations/colour/index.html) — ground and surfaces
  (`surface-3`, `line-strong`), the ink ramp (`fail-ink`, `await-ink`), the eye
  accent and the six status hues.
- [`foundations/type`](foundations/type/index.html) — the seven-step scale
  (display 26 to micro 11, the floor), Hellix Regular/SemiBold, `eyebrow`,
  `kbd`, and mono for machine text only.
- [`foundations/radii-elevation`](foundations/radii-elevation/index.html) —
  `control` 8 / `tile` 12 / `panel` 16, the `raised` and `overlay` shadows, and
  the focus ring.
- [`foundations/motion-lifecycle`](foundations/motion-lifecycle/index.html) and
  [`foundations/motion-choreography`](foundations/motion-choreography/index.html)
  — durations, easings, paired exits, FLIP and phase-synced ambient motion.

Components:

- [`components/button`](components/button/index.html) — Button, ButtonLink,
  IconButton: variants and sizes.
- [`components/confirm-panel`](components/confirm-panel/index.html) — the
  in-place confirm for destructive actions (ConfirmPanel, useConfirm).
- [`components/empty-state`](components/empty-state/index.html)
- [`components/alert-strip`](components/alert-strip/index.html)
- [`components/status-pill`](components/status-pill/index.html) — StatusPill
  and the status vocabulary in `status.ts`.
- [`components/drawer`](components/drawer/index.html)
- [`components/connection-pill`](components/connection-pill/index.html)
- [`components/segmented-control`](components/segmented-control/index.html)
- [`components/chronicle-timeline`](components/chronicle-timeline/index.html)

## Card conventions (match the existing remote cards)

- First line: `<!-- @dsCard group="Components" -->` (groups in use:
  `Foundations`, `Components`, `Brand`).
- A complete, self-contained HTML document — all CSS inlined, no external
  requests (the design pane enforces a strict CSP). Fonts may reference the
  project's own `fonts/*.woff2` by relative path.
- Dark ground (`#0a0f16`), centered demo, `prefers-reduced-motion` guard on
  any animation.
- Token values copied from `web/src/index.css` into the card's `:root`, never
  invented. Cards obey the rules they document: nothing under 11px, sentence
  case (capitals only in the eyebrow label), Hellix for everything but machine
  text, status colour only for status, icons from the set in `ds/Icon.tsx`.
- The rules and the reasons live in an HTML comment above the demo.

## Syncing

Use the `DesignSync` tool (or the `/design-sync` skill) **incrementally** —
one component at a time, never a wholesale replace:

1. `list_files` on the project to diff structure.
2. `finalize_plan` with only the paths you're adding/updating, plus
   `_ds_manifest.json` when the card list changes.
3. `write_files` from this directory.

When a token or component changes in `web/src/ds/`, update its card in the
same change and re-sync just that card.
