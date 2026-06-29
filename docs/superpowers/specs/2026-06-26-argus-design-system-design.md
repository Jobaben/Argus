# Argus Design System — Design Spec

**Date:** 2026-06-26
**Status:** Approved for planning
**Scope:** Full design system (foundation → primitives → views → Command Center), delivered as a phased migration.

---

## 1. Summary

Argus currently styles its React/Tailwind app with ad-hoc utility classes, a system
sans font, an emoji (👁️) brand mark, and a status→color map that is **duplicated**
across `web/src/App.tsx` and `web/src/components/ui.tsx`. Separately, a designed
visual language exists as a DesignSync gallery of standalone HTML files under
`design-system/` — an "observatory" theme with named tokens, the **Hellix** typeface,
an animated **iris** brand mark, and a richer component set (glowing status tiles,
a kanban "Command Center", sparklines, alert strips, etc.).

This spec formalizes that gallery into a real design system inside the React app and
defines a phased migration off the current ad-hoc styling. The end state: one token
layer (Tailwind v4 `@theme`), one status model, a typed component library in
`web/src/ds/`, all views restyled, and a new flagship Command Center board.

## 2. Goals & non-goals

**Goals**
- Single source of truth for design tokens, wired into Tailwind v4 so the app keeps
  using utility classes.
- One status model shared by every component; eliminate the duplicated color maps.
- A typed React component library (`web/src/ds/`) faithful to the gallery.
- Migrate all existing views to the new language, one view at a time, app working throughout.
- Build the Command Center kanban as a presentational layer with a defined data contract.
- Accessibility: every animation has a `prefers-reduced-motion` off-switch.

**Non-goals**
- No backend/server changes. Argus stays a pure reader of `~/.claude`.
- No new data sources for this spec. The Command Center runs on a stub feed; wiring it
  to real pipeline data is a future spec.
- No light theme. Argus is dark-only (`color-scheme: dark`).
- No component-framework swap (stays React 19 + Tailwind v4 + Vite).

## 3. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Token expression | Tailwind v4 `@theme` | Real utilities (`bg-surface`, `text-run`) + underlying CSS vars; idiomatic, keeps app on utility classes. |
| Spec shape | One spec, phased migration | Keeps the vision coherent; implementation ships incrementally. |
| Command Center data | Aspirational — presentational UI + data contract + stub | No data source exists today; design the UI now, wire later. |
| Gallery lifecycle | Reference now, retire after extraction | `design-system/` is the implementation input; removed once `web/src/ds/` matches (kept in git history). |

## 4. Foundation — token layer

All tokens live once in `web/src/index.css` via Tailwind v4 `@theme`. Each gallery
CSS variable becomes a Tailwind token, generating utilities **and** the underlying
custom property.

```css
@theme {
  /* Ground & surfaces */
  --color-ground: #0a0f16;
  --color-ground-2: #0c121b;
  --color-surface: #121b26;
  --color-surface-2: #16212e;
  --color-line: rgb(146 180 217 / 0.14);

  /* Ink ramp */
  --color-ink: #eaf2fb;
  --color-ink-dim: #9db0c6;
  --color-ink-faint: #62748b;

  /* Brand accent — eye (sparingly: brand + "live" only) */
  --color-eye: #36e3e8;

  /* Semantic status */
  --color-run: #ffb224;    /* working */
  --color-ok: #2fe6a4;     /* done */
  --color-fail: #ff5765;   /* failed */
  --color-queue: #4db5ff;  /* queued */
  --color-idle: #7c8aa0;   /* idle / stopped / unknown */
  --color-await: #b585ff;  /* needs approval */

  /* Type */
  --font-sans: "Hellix", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
  --font-mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;

  /* Radius */
  --radius-tile: 12px;
  --radius-panel: 14px;
}
```

Resulting utilities the app consumes: `bg-ground`, `bg-surface`, `bg-surface-2`,
`border-line`, `text-ink` / `text-ink-dim` / `text-ink-faint`, `text-eye`,
`text-run` / `text-ok` / `text-fail` / `text-queue` / `text-idle` / `text-await`,
`font-sans`, `font-mono`.

### 4.1 Fonts

The three shipped Hellix faces move from `design-system/fonts/` to `web/public/fonts/`
and load via `@font-face` with `font-display: swap`:

| File | weight |
|---|---|
| `Hellix-Regular-ma.woff2` | 400 |
| `Hellix-SemiBold-ma.woff2` | 600 |
| `Hellix-Bold-webfont.woff2` | 700 |

**Open item — Bilia face:** the type gallery references a fourth face
`Hellix-Bilia-SemiBold.woff2` that is **not present** in `design-system/fonts/`.
Treat "Bilia" as optional/decorative; the system falls back to `--font-sans` unless
the file is supplied. No component depends on it.

**Licensing risk:** Hellix is a commercial typeface. Confirm a web/embedding license
covers shipping the woff2 files before Phase 0 ships. If unconfirmed, the fallback
stack (`"Segoe UI", system-ui, …`) keeps the app functional.

### 4.2 Type conventions (system rules)

These two rules are the system's signature and every component must honor them:

1. **Mono is the telemetry voice.** `--font-mono` is used for IDs, timestamps,
   counts, ETAs, status-pill labels, and section labels (uppercase, letter-spaced).
   `--font-sans` (Hellix) is for entity names, headings, and body copy.
2. **The eye is brand-only.** `--color-eye` is reserved for the brand wordmark/mark
   and the "live" indicator. Status meaning is always carried by the run/ok/fail/
   queue/idle/await tokens — never the eye.

Numerals use `font-variant-numeric: tabular-nums` wherever they update live.

### 4.3 Motion & accessibility

Animations defined by the system: status-rail glow, tempo sweep (indeterminate
progress), pulse (await), ping (live dot), and the iris canvas orbit. **Every one
ships with a `@media (prefers-reduced-motion: reduce)` rule that disables it.** This
is mandatory, not optional — the gallery already models it and the spec enforces it
in review.

## 5. Status model — one source of truth

Today the status→color mapping is duplicated in `App.tsx` and `ui.tsx`, and the app's
`AgentStatus` union (`working | done | failed | idle | queued | stopped | unknown`)
**omits** the gallery's `await` ("needs approval") state — the only state with an
action gate and therefore the most important one visually.

The spec introduces a single status module, `web/src/ds/status.ts`:

```ts
export type DsStatus =
  | "working" | "done" | "failed" | "queued" | "idle" | "await";

export interface StatusToken {
  /** Tailwind color token name, e.g. "run" */
  token: "run" | "ok" | "fail" | "queue" | "idle" | "await";
  /** Display label, e.g. "Working", "Needs approval" */
  label: string;
  /** Whether this status emits a glow on the tile rail/badge */
  glow: boolean;
}

export const STATUS: Record<DsStatus, StatusToken>;

/** Maps the app's AgentStatus (incl. stopped/unknown) onto a DsStatus. */
export function toDsStatus(s: AgentStatus): DsStatus;
```

Mapping rules:
- `stopped` and `unknown` → render as `idle`.
- `await` is new; it is set when an agent/job is blocked on human approval (e.g. a
  plan or merge gate). Until a real source provides it, only the Command Center stub
  produces it.
- `glow: true` for `working`, `failed`, `await` (matches the gallery's emphasis).

Every component imports from this module. No component hardcodes a status color.

## 6. Component catalog

A new directory `web/src/ds/` holds the typed component library. Each component is a
faithful React port of its gallery card, consuming tokens via utility classes.

| Gallery card | Component | Disposition | Notes |
|---|---|---|---|
| `foundations/colors` | — | tokens only | becomes `@theme` (§4) |
| `foundations/type` | — | tokens only | fonts + conventions (§4.1–4.2) |
| `brand/iris-mark` | `IrisMark` | new | replaces 👁️ emoji; canvas orbit animation; static fallback under reduced-motion; sizable via prop |
| `components/status-pill` | `StatusPill` | rewrite | replaces existing pill; adds `await` with pulsing dot; driven by `status.ts` |
| `components/connection-pill` | `ConnectionPill` | new | live/reconnecting badge; replaces inline nav badge in `App.tsx` |
| `components/health-counter` | `HealthCounter` | rewrite | replaces `Stat`; large numerals, color per status (run/fail/live) |
| `components/stat-sparkline` | `Sparkline` | new | label + value + inline SVG polyline; for Stats view |
| `components/agent-tile` | `AgentTile` | rewrite | replaces `AgentCard`; status rail + glow, tempo sweep, progress bar, approval gate (Approve/Revise), token/cost meter, live dot |
| `components/scheduler-row` | `SchedulerRow` | rewrite | "next up" rows: name, ETA (eye-colored mono), trigger description |
| `components/alert-strip` | `AlertStrip` | new | failed-run banner; `role="status"`; pulsing badge |
| `components/activity-event` | `ActivityEvent` | rewrite | activity feed row in the new language |

Shared primitives currently in `web/src/components/ui.tsx` are reconciled:
- `StatusPill` → moves to `ds/`, rewritten on `status.ts`.
- `Stat` → superseded by `HealthCounter`.
- `Card` → kept as a thin surface primitive on tokens (`bg-surface`, `border-line`).
- `Section`, `TimeAgo`, `EmptyState` → restyled onto tokens, kept.

Each component exposes a typed props interface, renders no business logic, and is
independently usable (the gallery card is its visual contract).

## 7. Command Center (flagship view)

A new kanban view modeling a 7-phase agent pipeline:

`Brainstorm → Design → Write spec → Impl plan → Implement → Review → Approve · iterate`

Each column holds `AgentTile`s for jobs in that phase. Tiles in the `await` state show
an inline approval gate (Approve / Revise). The board is **presentational only** in
this spec — it renders from a data contract, fed by a stub today:

```ts
export interface PipelinePhase {
  id: string;            // "brainstorm" | "design" | ...
  index: number;         // 1..7
  name: string;          // "Brainstorm"
  tiles: PipelineTile[];
}

export interface PipelineTile {
  jobShort: string | null;
  name: string;
  subId: string;         // mono sub-identifier, e.g. "job 7a1b · 9 directions"
  status: DsStatus;
  detail: string;
  tokens?: number;
  costUsd?: number;
  updatedAt: string | null;
  // gate actions surfaced only when status === "await"
}

export interface PipelineState {
  feature: string;       // "scheduler-prune"
  phases: PipelinePhase[];
}
```

A `usePipeline()` hook returns `PipelineState`. For this spec its implementation is a
static/mock module under `web/src/ds/` (or a `usePipeline.stub.ts`). The hook's shape
is the contract a future "derive pipeline from `~/.claude`" spec must satisfy; the UI
does not change when the data source becomes real.

Approval gate buttons are wired to no-op handlers (with a TODO) since Argus is a
read-only reader today; making them act is out of scope.

## 8. Migration phases

Each phase is independently shippable and leaves the app working.

### Phase 0 — Foundation
- Add `@theme` token block to `web/src/index.css`; keep `color-scheme: dark`.
- Add Hellix `@font-face` declarations; move woff2 to `web/public/fonts/`.
- Add `IrisMark` component (canvas + reduced-motion static fallback).
- Establish the reduced-motion convention.
- **Exit:** app renders on the new palette/font; no layout change required yet.

### Phase 1 — Primitives & status model
- Create `web/src/ds/` with `status.ts`.
- Port `StatusPill`, `ConnectionPill`, `HealthCounter`, `Card`, `Section`,
  `EmptyState`, `TimeAgo` onto tokens + `status.ts`.
- Delete the duplicated `STATUS_STYLE` maps in `App.tsx` and `ui.tsx`.
- Add `await` to the app's status handling via `toDsStatus`.
- **Exit:** no status color is defined outside `status.ts`; primitives consume tokens.

### Phase 2 — Views
Migrate views one at a time (each its own PR/commit):
- App shell/nav → `ARG`**`U`**`S` wordmark + `IrisMark` + `ConnectionPill`.
- Agents → `AgentTile` (replaces `AgentCard`).
- Scheduler → `SchedulerRow` + `AlertStrip` for failures.
- Activity → `ActivityEvent`.
- Stats → `Sparkline` + `HealthCounter`.
- Remaining views (Sessions, Projects, Search, Inventory, Tasks, Cron, AgentDetail)
  → restyle onto tokens/primitives; no bespoke colors.
- **Exit:** every view uses `ds/` components and tokens; no `bg-white/[…]` glass
  surfaces or hardcoded `amber/emerald/rose/slate/sky` status utilities remain.

### Phase 3 — Command Center
- Build the kanban board (§7) with `usePipeline()` stub.
- Add it as a primary nav tab.
- **Exit:** board renders the 7-phase pipeline from stub data; reduced-motion honored.

### Phase 4 — Gallery retirement
- Verify `web/src/ds/` matches the gallery cards.
- Remove `design-system/` from the working tree (preserved in git history).
- **Exit:** React components + their in-app usage are the source of truth.

## 9. Verification

- **Build:** `npm run build` (Vite) passes after each phase.
- **Visual parity:** each ported component visually matches its gallery card (the
  gallery stays available as reference until Phase 4).
- **No duplication:** grep confirms no status color literals outside `ds/status.ts`
  and no `STATUS_STYLE` maps remain in `App.tsx`/`ui.tsx`.
- **Reduced motion:** with `prefers-reduced-motion: reduce`, no animation runs
  (rail glow, tempo sweep, pulse, ping, iris orbit all static).
- **Tokens:** no `bg-white/[0.0x]` glass surfaces or raw hex status colors in `web/src`.

## 10. Risks & open items

| Item | Status | Handling |
|---|---|---|
| Hellix web/embedding license | Open | Confirm before Phase 0 ships; fallback stack keeps app functional. |
| `Hellix-Bilia-SemiBold.woff2` missing | Open | Optional/decorative; falls back to `--font-sans`; no component depends on it. |
| Command Center has no real data | Known | Presentational + data contract + stub; real wiring is a future spec. |
| Approval gate actions | Out of scope | No-op handlers + TODO; Argus is read-only today. |
| `ds/` directory name | Confirmed | New library lives at `web/src/ds/`. |

## 11. Affected files (indicative)

- `web/src/index.css` — `@theme` tokens, `@font-face`, reduced-motion base.
- `web/public/fonts/` — Hellix woff2 (moved from `design-system/fonts/`).
- `web/src/ds/` — new: `status.ts`, `IrisMark`, `StatusPill`, `ConnectionPill`,
  `HealthCounter`, `Sparkline`, `AgentTile`, `SchedulerRow`, `AlertStrip`,
  `ActivityEvent`, `Card`, `Section`, `EmptyState`, `TimeAgo`, `usePipeline` (stub).
- `web/src/components/ui.tsx` — emptied/retired as components move to `ds/`.
- `web/src/App.tsx` — nav shell, wordmark, remove duplicated status map.
- `web/src/views/*` — migrated to `ds/` components.
- `design-system/` — removed in Phase 4.
