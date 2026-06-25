# Re-frame Argus around the Scheduler — navbar redesign

**Date:** 2026-06-23
**Status:** Approved design, ready for implementation plan
**Scope owner:** Usha Badrkhahan

## Problem

Argus began as a passive, read-only monitor for Claude Code agents. It has
since grown a real **Scheduler** (the `Schedules` view): an active feature that
creates interval/daily/weekly triggers and fires headless `claude -p` runs with
run history, run-now, and enable/disable. That feature — not passive monitoring —
is now the app's main purpose.

Two problems follow from that shift:

1. **The navbar doesn't reflect the new priority.** `Schedules` is the last tab
   in a flat list, behind `Agents` (the default landing tab) and seven other
   read-only monitoring views.
2. **A redundant, confusing `Cron` tab sits as a top-level peer.** The `Cron`
   view is a read-only *explainer*: it states that Claude Code's native cron
   routines are session-scoped and can't be watched from disk, scans `~/.claude`
   for schedule-named files (expecting none), and points at a hypothetical
   future polling host. As a top-level peer of a tab that *does* schedule things,
   it reads as a competing scheduler when it is actually a note about an absence.

## Goal

Re-frame the app so the **Scheduler** is the visible center of gravity, while
keeping every monitoring view one click away. Demote `Cron` from a top-level
peer into the monitoring group so its redundancy disappears without losing its
honest "native cron can't be watched" explainer.

**This re-frame is confined to the navbar, the default landing tab, and identity
copy.** It does NOT restyle or alter any monitoring view's internals (Agents,
Sessions, Cron, etc.).

## Decisions (settled with the user)

| Decision | Choice |
| --- | --- |
| Re-frame ambition | **Full re-frame**: Scheduler becomes home + identity; monitoring tabs demoted into a secondary group. |
| Cron route fate | **Keep, demote** into the monitoring group (not deleted). |
| Layout | **Two rows**: prominent Scheduler + identity on top, monitoring tabs on a thinner second row. |
| Live/reconnecting pill | **Leave in `AgentsView`** — NOT lifted to the navbar (see Rejected alternatives). |
| `Detail` pseudo-tab | **Hidden** from the navbar (still routable from agent cards). |
| Tab rename | Label `Schedules` → **`Scheduler`** (singular). Route id and filename unchanged. |

## Design

### Navbar — two-row header

`web/src/App.tsx` currently renders a single flat row from the `TABS` array. It
becomes a two-row header:

- **Top row:** app identity `👁️ Argus — schedule & monitor Claude agents`, and
  one prominent primary tab: **`Scheduler`** (visually dominant — larger /
  highlighted relative to row-two tabs).
- **Second row** (thinner, dimmer text, divider/border between rows): the
  monitoring tabs in order — **Agents · Sessions · Activity · Projects · Search ·
  Stats · Inventory · Tasks · Cron**.

Both rows must keep horizontal-scroll behavior on narrow widths. The current bar
uses `overflow-x-auto`; the second row (nine tabs) needs the same treatment so
tabs scroll rather than wrap or clip.

### Tab-model refactor

Today `TABS` is a flat `{ id, label, render }[]` and the navbar maps over *all*
of it, which is why the `agent`/`Detail` pseudo-route renders as a dead nav tab.

Add a `group` discriminator to each entry:

```ts
type TabGroup = "primary" | "monitoring" | "hidden";
interface Tab { id: string; label: string; group: TabGroup; render: () => React.ReactNode; }
```

- `"primary"` → `schedules` (top row, prominent).
- `"monitoring"` → `agents`, `sessions`, `activity`, `projects`, `search`,
  `stats`, `inventory`, `tasks`, `cron` (second row).
- `"hidden"` → `agent` (Detail): still in the array so `currentTabId()` routing
  resolves it, but **filtered out** of both rendered rows.

The navbar renders by filtering on `group` instead of iterating the whole array.
Routing logic (`currentTabId()`, the `hashchange` listener, `TABS.find`) is
otherwise untouched.

### Default landing tab

`currentTabId()` currently falls back to `"agents"`. Change the fallback to the
scheduler tab id so the app opens on the Scheduler.

**id vs label — pin explicitly to avoid conflation:**
- Tab **id** stays `"schedules"` (route is `#/schedules`; view file stays
  `Schedules.tsx`; no internal renames).
- Tab **label** renders as `"Scheduler"`.
- `currentTabId()` fallback returns the id `"schedules"`.
- After reordering the `TABS` array, confirm any `TABS[0]` fallback still
  resolves to a valid tab (prefer an explicit `find(t => t.id === "schedules")`
  over positional `TABS[0]` so order changes can't silently break the default).

### Identity copy

- README opening line: change "The all-seeing monitor for your Claude Code
  agents…" to a framing that leads with scheduling, e.g. **"Schedule and monitor
  your Claude Code agents, jobs, history and results."**
- Top navbar identity string: `👁️ Argus — schedule & monitor Claude agents`.
- The README "Cron / scheduled routines are not stored on disk…" note stays
  accurate and can remain; optionally add a one-line pointer that Argus now has
  its own Scheduler (its own runs, distinct from Claude's native session cron).

## Out of scope / rejected alternatives

- **Lifting the live pill to the navbar.** `useAgents()`
  (`web/src/useAgents.ts`) owns its own WebSocket + 10s polling loop. Calling it
  at App level opens a second WS connection; lifting the hook to App and
  threading it down is a refactor beyond the original ask. The Scheduler landing
  already surfaces per-schedule "running" indicators, so a global pill is not
  load-bearing. **Left in `AgentsView` unchanged.**
- **Deleting the Cron route** (view, hook, `server/sources/cron.ts`, endpoint).
  Rejected: the explainer is honest and useful; demotion already removes the
  redundancy.
- **Dropdown or inline-group navbar layouts.** Rejected in favor of two rows.
- **Restyling monitoring views.** The re-frame is navbar/landing/copy only.

## Affected files (anticipated)

- `web/src/App.tsx` — `TABS` model (`group` field), two-row navbar render,
  `currentTabId()` default, `Scheduler` label.
- `README.md` — opening line + identity copy.
- No server changes. No route-id, hook, or view-file renames.

## Acceptance criteria

1. App opens on the **Scheduler** view by default (no hash → Scheduler).
2. Navbar shows two rows: identity + prominent `Scheduler` on top; monitoring
   tabs (incl. `Cron`) on a thinner second row.
3. `Cron` is no longer a top-level/primary tab; it lives among monitoring tabs.
4. The `Detail` pseudo-tab no longer appears in the navbar, but
   `#/agent/<short>` still routes to the detail view from agent cards.
5. Both navbar rows scroll horizontally on narrow widths (no wrap/clip).
6. The Scheduler tab is labelled `Scheduler`; route `#/schedules`, file
   `Schedules.tsx`, and the `schedules` id are unchanged.
7. README/identity copy leads with scheduling.
8. No monitoring view's internals are restyled or otherwise changed.
9. `npm run build` (web) succeeds; no TypeScript errors.
