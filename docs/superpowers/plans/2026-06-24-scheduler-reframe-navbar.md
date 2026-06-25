# Scheduler Re-frame — Navbar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-frame Argus around its Scheduler — make it the prominent, default landing tab on a two-row navbar, demote monitoring views (including Cron) to a secondary row, and update identity copy.

**Architecture:** A pure frontend change in `web/`. The flat `TABS` array in `App.tsx` gains a `group` discriminator (`primary` / `monitoring` / `hidden`); the navbar renders two rows by filtering on that group. The default landing tab switches from Agents to Scheduler. Identity copy in the README and `index.html` leads with scheduling. No server, route-id, hook, or view-file changes.

**Tech Stack:** Vite 8 + React 19 + TypeScript + Tailwind CSS v4. Hash-based routing (no router library).

## Global Constraints

- **No test harness exists in `web/`** and none is added (out of scope). The per-task verification gate is: `npm run build` (runs `tsc -b && vite build`) + `npm run lint`, plus a manual visual check against the acceptance criteria via `npm run dev`. Run all `npm` commands from `C:\GIT\argus\web`.
- **Do NOT auto-commit.** Per the repo owner's workflow: at the end of each task, `git add` the changed files and stop — leave them uncommitted for the owner to review and commit in their IDE. The `git add` step is the task's closing step; there is no `git commit` step.
- **Scope is navbar / landing / identity copy only.** Do NOT restyle or alter the internals of any monitoring view (Agents, Sessions, Activity, Projects, Search, Stats, Inventory, Tasks, Cron).
- **No renames of routes, hooks, or files.** The Scheduler tab keeps id `schedules`, route `#/schedules`, and view file `Schedules.tsx`. Only its rendered *label* becomes `Scheduler`.

---

## File Structure

- `web/src/App.tsx` — **Modify.** Owns the `TABS` model, hash routing (`currentTabId`), and the navbar render. All structural changes land here.
- `README.md` — **Modify.** Opening tagline + the stale "cron view out of scope" note.
- `web/index.html` — **Modify.** `<meta name="description">` identity copy.

---

### Task 1: Two-row grouped navbar

Restructure `web/src/App.tsx` so tabs carry a `group`, the navbar renders two rows, the Scheduler is the prominent primary tab, the Detail pseudo-route is hidden from the nav, and the app opens on the Scheduler by default.

**Files:**
- Modify: `web/src/App.tsx` (TABS array ~172-184, `currentTabId` ~186-188, `App` component nav render ~199-225)

**Interfaces:**
- Consumes: existing view components already imported at the top of `App.tsx` (`Schedules`, `AgentsView`, `Sessions`, `ActivityFeed`, `Projects`, `Search`, `Stats`, `Inventory`, `Tasks`, `Cron`, `AgentDetail`). No new imports.
- Produces: a `TabGroup` union type and a `TABS` array where each entry is `{ id: string; label: string; group: TabGroup; render: () => React.ReactNode }`. No exports change — `App` remains the default export.

- [ ] **Step 1: Add the `TabGroup` type and rewrite the `TABS` array**

Replace the existing `TABS` declaration (currently lines ~172-184) with the grouped version below. Order matters: `schedules` is first (primary); monitoring tabs follow in display order with `cron` last; the hidden `agent` route is last overall.

```tsx
type TabGroup = "primary" | "monitoring" | "hidden";

const TABS: { id: string; label: string; group: TabGroup; render: () => React.ReactNode }[] = [
  { id: "schedules", label: "Scheduler", group: "primary", render: () => <Schedules /> },
  { id: "agents", label: "Agents", group: "monitoring", render: () => <AgentsView /> },
  { id: "sessions", label: "Sessions", group: "monitoring", render: () => <Sessions /> },
  { id: "activity", label: "Activity", group: "monitoring", render: () => <ActivityFeed /> },
  { id: "projects", label: "Projects", group: "monitoring", render: () => <Projects /> },
  { id: "search", label: "Search", group: "monitoring", render: () => <Search /> },
  { id: "stats", label: "Stats", group: "monitoring", render: () => <Stats /> },
  { id: "inventory", label: "Inventory", group: "monitoring", render: () => <Inventory /> },
  { id: "tasks", label: "Tasks", group: "monitoring", render: () => <Tasks /> },
  { id: "cron", label: "Cron", group: "monitoring", render: () => <Cron /> },
  { id: "agent", label: "Detail", group: "hidden", render: () => <AgentDetail /> },
];
```

- [ ] **Step 2: Change the default landing tab in `currentTabId`**

Replace the fallback `"agents"` with `"schedules"` so an empty hash opens the Scheduler.

```tsx
function currentTabId(): string {
  return window.location.hash.replace(/^#\/?/, "").split("/")[0] || "schedules";
}
```

- [ ] **Step 3: Update the active-tab fallback and derive the two groups in `App`**

In the `App` component, replace the `tab` lookup so an unknown hash falls back explicitly to the Scheduler (not positional `TABS[0]`), and compute the two rendered groups. Locate:

```tsx
  const tab = TABS.find((t) => t.id === active) ?? TABS[0];
```

Replace with:

```tsx
  const tab = TABS.find((t) => t.id === active) ?? TABS.find((t) => t.id === "schedules")!;
  const primaryTabs = TABS.filter((t) => t.group === "primary");
  const monitoringTabs = TABS.filter((t) => t.group === "monitoring");
```

- [ ] **Step 4: Replace the `<nav>` block with the two-row layout**

Replace the entire existing `<nav>...</nav>` element (currently lines ~203-222) with the two-row version. Top row: identity + prominent primary tab(s). Second row: monitoring tabs, smaller and dimmer, with a divider above. Both rows use `overflow-x-auto` so they scroll on narrow widths.

```tsx
      <nav className="sticky top-0 z-10 border-b border-white/10 bg-[#0a0b0f]/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6">
          <div className="flex items-center gap-3 overflow-x-auto py-2">
            <span className="shrink-0 text-sm font-semibold text-white">👁️ Argus</span>
            <span className="hidden shrink-0 text-xs text-white/40 sm:inline">
              — schedule &amp; monitor Claude agents
            </span>
            <div className="ml-2 flex items-center gap-1">
              {primaryTabs.map((t) => (
                <a
                  key={t.id}
                  href={`#/${t.id}`}
                  className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                    t.id === tab.id
                      ? "bg-white/10 text-white"
                      : "text-white/70 hover:text-white"
                  }`}
                >
                  {t.label}
                </a>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1 overflow-x-auto border-t border-white/5 py-1.5">
            {monitoringTabs.map((t) => (
              <a
                key={t.id}
                href={`#/${t.id}`}
                className={`shrink-0 rounded-md px-2.5 py-1 text-xs transition ${
                  t.id === tab.id
                    ? "bg-white/10 text-white"
                    : "text-white/40 hover:text-white/70"
                }`}
              >
                {t.label}
              </a>
            ))}
          </div>
        </div>
      </nav>
```

- [ ] **Step 5: Typecheck and build**

Run (from `C:\GIT\argus\web`): `npm run build`
Expected: PASS — `tsc -b` reports no type errors and `vite build` completes. If `tsc` flags `agent` as unreachable or a missing group, re-check Step 1's array.

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: PASS — no new ESLint errors. (The non-null assertion in Step 3 is on a literal that always resolves; if the repo's lint config rejects `!`, replace the fallback expression with `?? TABS[0]` and leave a comment that `TABS[0]` is the Scheduler by construction.)

- [ ] **Step 7: Manual visual verification**

Run: `npm run dev`, open http://localhost:5757.
Verify against acceptance criteria:
- Opening with no hash (`/`) lands on the **Scheduler** view (the ⏰ Schedules page), not Agents.
- Navbar shows **two rows**: top row has `👁️ Argus — schedule & monitor Claude agents` and a prominent `Scheduler` tab; second row has Agents, Sessions, Activity, Projects, Search, Stats, Inventory, Tasks, Cron — smaller and dimmer.
- `Cron` appears only on the second row, not as a top-level tab; clicking it still loads the Cron explainer.
- No `Detail` tab appears in either row. Navigating to an agent card (`#/agent/<short>`) still loads the detail view.
- Narrow the window: both rows scroll horizontally rather than wrapping or clipping.

- [ ] **Step 8: Stage for review (no commit)**

Run: `git add web/src/App.tsx`
Then stop and report the change. Do NOT commit — the repo owner reviews and commits.

---

### Task 2: Identity copy

Update the README tagline and the `index.html` meta description to lead with scheduling, and refresh the stale "cron view is out of scope" note now that the Scheduler exists.

**Files:**
- Modify: `README.md` (line 3 tagline; the cron note at ~44-47)
- Modify: `web/index.html` (line 7 `<meta name="description">`)

**Interfaces:**
- Consumes: nothing. Produces: nothing. Documentation/markup copy only — no code depends on these strings.

- [ ] **Step 1: Update the README tagline**

In `README.md`, replace line 3:

```markdown
The all-seeing monitor for your Claude Code agents, jobs, history and results.
```

with:

```markdown
Schedule and monitor your Claude Code agents, jobs, history and results.
```

- [ ] **Step 2: Refresh the stale cron note in the README**

The "Data sources" section currently says a cron view is "intentionally out of scope for v1," which is no longer true. Locate this paragraph (~44-47):

```markdown
**Cron / scheduled routines** are **not** stored on disk — they are
session-scoped (harness-managed, visible only via `CronList` inside a live
Claude session). A cron view would require a polling host process, not a
file-watch, and is intentionally out of scope for v1.
```

Replace it with:

```markdown
**Argus's Scheduler** fires its own headless `claude -p` runs on interval /
daily / weekly triggers (see the Scheduler tab — create, run-now, history).
This is distinct from Claude Code's **native cron routines**, which are
session-scoped (harness-managed, visible only via `CronList` inside a live
Claude session) and are **not** stored on disk; Argus, a disk reader, cannot
surface those — the Cron tab explains why.
```

- [ ] **Step 3: Update the index.html meta description**

In `web/index.html`, replace line 7:

```html
    <meta name="description" content="Argus — the all-seeing monitor for your Claude Code agents" />
```

with:

```html
    <meta name="description" content="Argus — schedule and monitor your Claude Code agents" />
```

- [ ] **Step 4: Verify the build still succeeds**

Run (from `C:\GIT\argus\web`): `npm run build`
Expected: PASS. (No code changed, but `index.html` is Vite's entry — confirm it still builds cleanly.)

- [ ] **Step 5: Stage for review (no commit)**

Run: `git add README.md web/index.html`
Then stop and report. Do NOT commit — the repo owner reviews and commits.

---

## Self-Review

**Spec coverage** (against `2026-06-23-scheduler-reframe-navbar-design.md` acceptance criteria):
1. Default opens on Scheduler → Task 1 Steps 2, 7. ✔
2. Two-row navbar, prominent Scheduler, dimmer monitoring row → Task 1 Steps 4, 7. ✔
3. Cron demoted to monitoring row → Task 1 Step 1 (`group: "monitoring"`), Step 7. ✔
4. Detail hidden from nav but still routable → Task 1 Step 1 (`group: "hidden"`), Step 7. ✔
5. Both rows scroll on narrow widths → Task 1 Step 4 (`overflow-x-auto` on both), Step 7. ✔
6. Scheduler label only; id/route/file unchanged → Task 1 Step 1 (id `schedules`, label `Scheduler`); Global Constraints. ✔
7. README/identity copy leads with scheduling → Task 2 Steps 1-3. ✔
8. No monitoring view internals changed → Global Constraints; only `App.tsx`, `README.md`, `index.html` touched. ✔
9. `npm run build` succeeds → Task 1 Step 5, Task 2 Step 4. ✔

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✔

**Type consistency:** `TabGroup` union (`"primary" | "monitoring" | "hidden"`) defined in Task 1 Step 1 is used consistently in Step 3's `.filter` calls. `tab.id`, `t.id`, `t.label`, `t.group`, `t.render` match the `TABS` element shape throughout. The `schedules` id is used identically in Steps 2, 3, and 7. ✔
