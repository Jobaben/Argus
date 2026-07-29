# Argus — Experience Analysis: the road from 3/10 to 10/10

_A lead-UX-designer's audit of Argus as experienced on Windows. Written against
the code as it stands (branch point `d500dcb`); nothing in the product was
changed. Per the brief, **no recommendation below is a UI or theme redesign** —
every goal concerns language, structure, flow, feedback, forgiveness, and
platform behaviour, all achievable inside the existing visual system._

---

## 1. Framing: how a 9/10 engineering product is a 3/10 experience

`docs/SCORECARD.md` records UX/A11y independently re-audited at 9–10, and the
code deserves it **on the dimensions that rubric measured**: labeled inputs,
keyboard completeness, live regions, deep links, error boundaries. This
analysis grades a different thing: **the experience of a person**, specifically
a newcomer on a Windows machine, from first launch through their first weeks —
what they understand, what they trust, what they can recover from, and how the
product behaves as a citizen of their platform.

On that rubric the product scores low precisely _because_ it was built by and
for its own author. Every screen is correct; almost nothing is learnable.
Every action works; almost none confirms, previews, or forgives. The system
speaks fluent Argus; the user has to already know Argus to be spoken to.

### The rubric

Ten dimensions, graded 1–10 for a first-month Windows user. Weights reflect
that a monitoring product lives or dies on comprehension and trust.

| Dimension                                   | Weight | Today | Evidence anchor                                     |
| ------------------------------------------- | ------ | ----- | --------------------------------------------------- |
| Learnability & mental model                 | 3×     | 2     | §2 — ten unexplained codenames as primary nav        |
| First-run & time-to-first-value             | 3×     | 2     | §3 — no onboarding; permission prompt before purpose |
| Forgiveness (undo, confirm, recovery)       | 2×     | 3     | §5 — one-click kill of live runs; zero undo          |
| Feedback & honesty of state                 | 2×     | 4     | §5 — six silent-failure sites; `stale` never shown   |
| Platform citizenship (Windows)              | 2×     | 3     | §4 — ⌘ leakage, path entry, no OS presence           |
| Attention coherence                         | 2×     | 3     | §6 — six overlapping alert surfaces                  |
| Wayfinding & information architecture       | 1×     | 4     | §2 — 11 flat tabs; unreachable views; sibling crumbs |
| Flow continuity (state under live data)     | 1×     | 5     | §6 — rows vanish under cursor; state not in URL      |
| Micro-interaction craft                     | 1×     | 8     | palette, recorder, change-flash, absent-vs-zero      |
| Accessibility mechanics                     | 1×     | 8     | live regions, focus traps, combobox pattern          |

**Weighted: ≈ 3.2 / 10.** The last two rows are why the product _feels_
polished in a demo and still fails a new user: craft is present at the
millisecond scale and absent at the mental-model scale.

What follows are **five goals**. The first three are the majors the brief
asked for; goals four and five close the remaining distance to 10.

---

## 2. Goal 1 — One mental model: make the product speak the user's language

> Target: a first-time user can name what every screen is for within one
> session, without reading a single external document.

### The problem, evidenced

Argus's primary navigation is a mythology. Of the eleven top-level
destinations (`web/src/App.tsx:133-157`), a majority carry names that describe
nothing about their function: **Chronicle, Watchtower, Sentinel, Briefing,
Command Center** — and behind them **Autopsy, Verdict, Flight Recorder, Vault,
Weave, Ledger, Constellation, Omnibar**. The 1,829-line `docs/USER-GUIDE.md`
that defines all thirty concepts is **never linked from inside the app** — a
grep for any onboarding, tour, glossary, or "learn more" affordance returns
one string, and it belongs to the login panel (`views/AdminAuthPanel.tsx:72`).

The product does teach — but only in empty states
(`views/Schedules.tsx:655-670`, `views/Pipelines.tsx:375-385`,
`views/Watchtower.tsx:342-347`), which means **the explanation of every
concept is destroyed by the first piece of data**. Once one schedule exists,
the definitions of "health", "unproven", "catch-up" are gone forever. The
single sentence that explains how five tabs relate — _"Monitors answer 'did it
run', Issues answer 'did it fail'. This answers the question neither does"_ —
exists only as a **code comment** (`views/Watchtower.tsx:25-26`). It is the
most valuable sentence in the product and no user has ever seen it.

The vocabulary is also internally inconsistent:

- One concept, three names: the nav says **Scheduler**, the sub-tab says
  **Schedules**, the route is `#/schedules` (`App.tsx:138`,
  `views/Schedules.tsx:590`).
- One artifact, four names: the board renders `job <runId>`
  (`views/CommandCenter.tsx:213`), the drawer labels it `job`
  (`views/StepDrawer.tsx:187`), every other surface calls it a **run**
  (`RunRow`, `#/run/<id>`), and cards count **instances**
  (`CommandCenter.tsx:383`) — "instance" is defined nowhere.
- One panel, two words: the heading says **Autopsy**, the body prose says
  **postmortem** throughout (`views/AutopsyPanel.tsx:64` vs `:85-119`).

Wayfinding mirrors the vocabulary problem. Eleven flat primary tabs scroll
horizontally with no grouping (`web/src/NavBar.tsx:159-175` — the code comment
at `:21-30` names the problem and solves it **only on mobile**). Breadcrumbs
exist on 8 of 23 routes and point at **siblings**, not parents: Issues and
Monitors crumb to "Scheduler" (`views/Issues.tsx:232`,
`views/Monitors.tsx:130`), Watchtower and Sentinel crumb to "Monitors" — a
three-deep conceptual hierarchy that only ever displays one level. Three fully
built views are partially or wholly orphaned: **`#/activity` has zero inbound
links in the entire app** (only `App.tsx:154,361` reference it), `#/agents` is
mouse-unreachable whenever zero agents are live (its only mouse entry is a
situation-strip stat rendered only when `count > 0`,
`views/SituationStrip.tsx:204-210`), and Search has no nav presence at all
(`role: "utility"` is filtered out of both the bar and the More menu,
`App.tsx:233,241`).

### The goal, decomposed

1. **Adopt a bilingual naming policy.** Keep the codenames as brand flavour if
   desired, but every destination gets a permanent plain-function subtitle —
   the pattern already proven on Monitors, Issues, and Budget — extended to
   Chronicle, Fleet, Watchtower, and Sentinel, which today have none
   (`views/Chronicle.tsx:215-226`). The rule: **a name may be poetic only if
   the sentence under it is literal.**
2. **Promote the teaching copy from empty states to a persistent, dismissible
   "What is this page?" disclosure on every view** — same copy, same voice,
   just no longer conditional on having no data. Ship the
   Monitors/Issues/Watchtower relationship sentence from
   `Watchtower.tsx:25-26` into the product.
3. **Build an in-app glossary and link the user guide.** The guide's
   per-feature "what it answers" table (`docs/USER-GUIDE.md:27-62`) is already
   a glossary — surface it behind `?` alongside the shortcut sheet, and make
   every codename's first occurrence per view a link into it.
4. **Unify the entity vocabulary.** One decision — "run" — applied everywhere
   `job` and `instance` leak today; define "instance" once where pipelines
   need it.
5. **Group the information architecture by user question, not by feature.**
   The guide already knows the axes — every tab is listed with the question it
   answers. Express that grouping in the nav's structure (e.g. _Do / Watch /
   Explain / Account_ sections in the existing bar and More menu — a
   re-ordering, not a redesign) and make crumbs reflect the real hierarchy
   Scheduler → Monitors → Watchtower/Sentinel.
6. **No orphans.** Every route reachable by keyboard must be reachable by
   mouse (the code's own claim at `App.tsx:248-250`, currently false):
   Activity, Agents, Sessions, and Search need standing entries in the More
   menu or palette-visible destinations.

### Measures

- A five-user hallway test: ≥4 of 5 newcomers correctly describe the purpose
  of every primary tab after 15 minutes, unprompted.
- Zero user-facing occurrences of `job`/`instance` where "run" is meant.
- Every route has ≥1 mouse path and parent-pointing crumbs.

---

## 3. Goal 2 — Design the first hour: from installation to earned trust

> Target: a new user reaches their first successful scheduled run, and
> understands what they are looking at, within 15 minutes — without the
> external guide.

### The problem, evidenced

The first minute is actively hostile in a way the rest of the product never
is. On first load, Argus **requests native notification permission before the
user has done anything** (`web/src/notify/useAgentNotifications.ts:24-28` fires
`Notification.requestPermission()` on mount). The user is asked to trust an
app they cannot yet name, with no pre-prompt explaining what would be sent.
Browsers punish this: a reflexive "Block" is permanent-by-default on both
Chromium and Firefox, silently destroying the product's most valuable channel
(failure alerts while the tab is backgrounded) forever.

The rest of the first session is a void rather than a path:

- The default route is the Command Center, whose first-run content is
  "Nothing needs you" plus "No pipelines defined yet. Create one in the
  Pipelines tab" (`views/CommandCenter.tsx:630-636`) — pointing a newcomer at
  the product's **most advanced** concept (multi-phase gated pipelines) rather
  than its simplest win (one scheduled prompt).
- The SetupBanner says "Setup incomplete" (`views/SetupBanner.tsx:46`) without
  ever saying what setup is _for_ or what breaks without it; when nothing is
  auto-fixable it is a red strip with no action and no guidance (`:27-30`).
  Worse, if the setup check itself fails, the failure is **invisible**:
  `useSetup.ts:16-21` initialises `ok: true` and the captured `error`
  (`:37-45`) is rendered nowhere — a broken check is indistinguishable from a
  passing one.
- There is no sequence. Sign-in (required for every mutation) lives only on
  the Pipelines tab (`views/Pipelines.tsx:332-341`); four other views tell the
  user to "sign in" without linking to where the form is
  (`views/AutopsyPanel.tsx:233-238`, `views/VerdictPanel.tsx:121`,
  `views/Sentinel.tsx:388`, `cmd/useOmnibar.ts:33`).
- Six views greet the newcomer with content-free emptiness: "No task
  directories found yet." (`views/Tasks.tsx:52`), "No projects found yet."
  (`views/Projects.tsx:50`), similarly Inventory, Stats, Users, Cron — in a
  product that elsewhere writes the best empty states I have audited.

### The goal, decomposed

1. **Sequence the first run.** A one-time, dismissible first-session journey
   (not a modal tour — a checklist the product already knows how to derive,
   exactly like SetupBanner derives prerequisites): _create your root account
   → apply setup fixes → launch one one-off run → watch it live → schedule
   it_. Each step deep-links to the existing surface; the checklist retires
   itself permanently once completed. The Launch tab — not Pipelines — is the
   first-win destination, and the existing "A first one worth having is a
   nightly review of yesterday's commits" copy (`views/Schedules.tsx:655-670`)
   is precisely the right voice for it.
2. **Earn the notification permission.** Never request on load. Request at the
   moment the value is self-evident and user-initiated: the first time the
   user launches or schedules a run, with an in-app pre-prompt ("Want to hear
   when this finishes, even with the tab in the background?") so the browser
   dialog arrives pre-justified. Degradation to toasts already works
   (`notify/fireNotification.ts:26-32`).
3. **Make setup explain itself.** The banner states its stakes ("without the
   Stop hook, pipelines can't detect step completion" — copy that already
   exists in the user guide, `docs/USER-GUIDE.md:133-141`), renders the
   `useSetup` error state when the check itself fails, and offers manual
   instructions when nothing is auto-fixable.
4. **Finish the empty-state programme.** The six bare "nothing found yet"
   views adopt the established teaching pattern: what this view shows, where
   its data comes from, and the one action that would populate it.
5. **Route every "sign in to…" message to the sign-in.** One link. The Users
   view already demonstrates the fix (`views/Users.tsx:86-95` — added
   precisely because "this page was otherwise a dead end"); apply it to the
   other four dead ends.

### Measures

- Time-to-first-successful-run for a fresh install: ≤15 minutes, measured on
  a user who has never seen the product.
- Notification grant rate on the deliberate prompt (industry pre-prompt
  baselines put reflexive denial at 60–80% for on-load asks).
- Zero "sign in" strings without an adjacent route to the form.

---

## 4. Goal 3 — Windows citizenship: behave like software that lives here

> Target: on a Windows machine, nothing about Argus reads as a Mac product
> being tolerated in a browser tab.

### The problem, evidenced

The keyboard layer is genuinely platform-aware — `mod` resolves to Ctrl and
renders as "Ctrl K" with the rationale documented (`web/src/cmd/keys.ts:66-84`,
`NavBar.tsx:136-141`: _"showing the wrong one is worse than showing none"_).
That standard makes the residue conspicuous:

- **The palette footer hardcodes `⌘↵ interpret`**
  (`cmd/CommandPalette.tsx:388`) — a Windows user is instructed to press a key
  their keyboard does not have, in the product's flagship power feature, while
  the handler happily accepts Ctrl (`:163`).
- **The documentation is Mac-first**: `README.md` and the user guide lead
  every shortcut mention with `⌘K` (`README.md:46`, `docs/USER-GUIDE.md:60,76`)
  with `Ctrl K` as the parenthetical. For a Windows deployment this is
  backwards in every screenshot, caption, and sentence.
- **Working directories are typed by hand as free text** in all three launch
  surfaces — Launch, Schedules, PipelineForm (`views/Launch.tsx:55`,
  `views/Schedules.tsx:247-250`, `views/PipelineForm.tsx:174`) — with a
  Unix-flavoured placeholder (`/home/you/project`) and no validation of
  existence or absoluteness. On Windows this means hand-typing
  `C:\Users\usha\source\repos\…` into a bare text field, the single most
  error-prone input in the product, and the server's only feedback arrives
  after submission. (The server already validates existence; surface that
  check as the user types, offer recent/known project directories — the
  Projects view already possesses the full list of every directory Claude
  Code has worked in.)
- **Enter does not submit** the Launch, Schedule, or Pipeline forms — they are
  button-click-only (`views/AdminAuthPanel.tsx:34-35` is the sole real
  `<form onSubmit>` among the primary forms). Enter-submits is a
  platform-universal convention; its absence reads as broken on any OS and
  especially so for the keyboard-centric Windows audience this product
  courts.
- **Four Flight Recorder shortcuts (Space/←/→/f) bypass the binding registry
  entirely** (`views/FlightRecorder.tsx:346-372`) — they appear in no
  cheatsheet, and Space's `preventDefault` disables page scrolling on that
  view; `f` leaks into Firefox Quick Find (`:366` lacks preventDefault).
  `/` navigates to global Search even on views that have their own local
  filter box (`cmd/shellBindings.ts:57-61` vs `views/Sessions.tsx:238`) —
  on a view with a filter, `/` should mean _this_ filter.
- **No OS presence.** Argus is a terminal-hosted server plus a browser tab.
  On Windows that means: no Start-menu entry, no tray icon, nothing that
  survives a reboot, and alerting that dies with the tab. The product's own
  design centre — "agents run while you're not looking"
  (`docs/USER-GUIDE.md:224-227`) — is exactly the scenario a closed tab
  defeats. The roadmap already names the remedy (`docs/ROADMAP.md:76-80`,
  v0.5 Tauri shell + tray + native notifications); this goal promotes it from
  roadmap afterthought to experience-critical, with Windows specifics:
  install as an auto-start service or tray app, actionable toast
  notifications (Approve / View directly from the Windows notification), and
  taskbar badge for the attention count the nav already computes
  (`views/Briefing.tsx` badge).

### The goal, decomposed

1. Purge every hardcoded `⌘` from rendered UI through the existing
   `formatKeys` abstraction; re-shoot docs and screenshots platform-neutral
   or Windows-first.
2. Route all shortcuts — including Flight Recorder's — through the binding
   registry so the `?` sheet's "documented ⇔ exists" invariant
   (`cmd/ShortcutHelp.tsx:4-11`) becomes true again; make `/` context-aware.
3. Replace bare-text path entry with validated, suggestion-backed directory
   input fed by the known-projects list; validate on blur, not on submit.
4. Make Enter submit every single-action form.
5. Deliver the OS shell: auto-start, tray presence with attention badge,
   actionable native notifications, graceful sleep/resume messaging (the
   catch-up mechanism already handles the semantics —
   `views/Schedules.tsx:267-273` — the experience should narrate it: "2
   slots were missed while this machine slept; one caught up at 09:14").

### Measures

- Zero `⌘` glyphs rendered on non-Apple platforms; zero shortcuts absent
  from the cheatsheet.
- Path-entry error rate at submission drops to ~0 (errors move to inline
  validation).
- Failure-to-notice time for an overnight failed run with the tab closed:
  from _infinite_ (today) to seconds (tray notification).

---

## 5. Goal 4 — Forgiveness: preview, confirm, undo, and honest feedback

> Target: no action can destroy work or state without warning; no action
> succeeds or fails invisibly; every mistake has a way back.

### The problem, evidenced

The product contains its own gold standard and applies it to exactly one
feature. The Omnibar previews every mutation as a `before → after` table,
applies all-or-nothing, and reports five distinguishable outcomes including
`rolled-back` and `partial` (`cmd/OmnibarIntent.tsx:148-171`,
`useOmnibar.ts:69-76`). Meanwhile, across the rest of the product:

- **Killing a live agent run is one unconfirmed click** (`views/RunRow.tsx:65-81`)
  — and if the cancel _fails_, the `try/finally` has no catch, so the button
  simply resets as if nothing happened.
- **Removing a user** (`views/Users.tsx:38-47`) and **unpairing a machine**
  (`views/Fleet.tsx:66-73`) are immediate, unconfirmed, and irreversible.
- **Deleting a pipeline phase or step** — potentially three hand-typed prompts
  — is one misclick on a `✕` with no confirm and no undo
  (`views/PipelineForm.tsx:152-161, 222-231`).
- The two deletes that _are_ confirmed use the native browser `confirm()`
  dialog (`views/Schedules.tsx:478-487`, `views/Pipelines.tsx:240-248`) —
  the only surface in the product that abandons its own interaction language,
  and (in both cases) without stating consequences. Only Stop-pipeline states
  what will be lost (`views/Pipelines.tsx:110-113`).
- **No confirmed action produces success feedback.** The toast system exists
  and is well-built (`notify/useToastQueue.ts`) but is wired exclusively to
  server-pushed alerts — there is no source for "you just deleted a
  schedule". The one exception proves the pattern's value: "Launched. Watch
  it here." with a link (`views/AutopsyPanel.tsx:207-214`).
- **Six confirmed silent-failure sites**: a failed setup check renders as
  healthy (`useSetup.ts:37-45`); a failed "Mark caught up" is invisible
  (`useBriefing.ts:16-19` never checks `res.ok`); a failed all-time total
  reset is swallowed (`views/CommandCenter.tsx:499-505` — on an action the
  UI itself arms as "irreversible"); a failed run-cancel is silent
  (`RunRow.tsx:69-75`); `views/Issues.tsx:157` carries a no-op
  `.catch(() => {})`; and Fleet's add-peer clears the form even when the add
  failed (`views/Fleet.tsx:248`).
- **Degradation is invisible.** `useLiveResource` computes a `stale` flag
  documented as _"what you are looking at is the last known state"_
  (`live/useLiveResource.ts:14-16`) — and **zero views render it**. No data
  view offers a retry control (every hook exposes `refresh`; no view wires
  it). During an outage, a 20-minute-old board is pixel-identical to a live
  one, apart from a ~2mm pill in the corner (`ds/ConnectionPill.tsx`,
  `NavBar.tsx:205`).
- Undo exists in exactly one place — Watchtower's baseline reset has a true
  inverse ("Restore full history", `views/Watchtower.tsx:194-208`) — which
  demonstrates the team can build it.

### The goal, decomposed

1. **One consequence-stating confirmation pattern** (the board already has it:
   the two-step armed Reset total, `views/CommandCenter.tsx:476-531`) applied
   to every irreversible action — cancel-run, remove-user, unpair, delete —
   always naming what is lost, never via `window.confirm`.
2. **Undo over confirmation wherever state allows it**: soft-delete with a
   toast-hosted Undo for schedules, pipelines, phases/steps, notifications,
   triage. (Issues already has Reopen; Watchtower already has Restore — make
   that the norm.)
3. **Every mutation acknowledges.** Success feedback through the existing
   toast/status channel; failure never swallowed — fix the six silent sites
   and adopt the gate actions' pattern ("Approved — pipeline resuming",
   `views/CommandCenter.tsx:108,140`) as the floor.
4. **Honest staleness.** Render the `stale` flag as a standing "last known
   state, Xm old — Retry" affordance on every data view, wired to the
   `refresh` every hook already exports.
5. **Draft protection.** An unsaved-changes guard on the two long forms
   (PipelineForm loses everything on a stray navigation; Reuse silently
   overwrites a typed draft, `views/Launch.tsx:101-117`).

### Measures

- Zero irreversible actions reachable in one click; zero native `confirm()`.
- Zero mutation paths without success/failure feedback (auditable by grep on
  the fetch helpers).
- Outage test: a user can state, within 5 seconds of looking, that data is
  stale and how old it is.

---

## 6. Goal 5 — One attention model: six alarms into one worklist

> Target: "does anything need me, and what do I do about it?" has exactly one
> answer surface; everything else is a lens onto it.

### The problem, evidenced

Argus currently answers "what needs me?" in **six places with six half-overlapping
vocabularies**: toasts (8-second TTL), the notification bell (session-only,
capped at 50, `notify/notificationLog.ts:33`), the Briefing's attention cards
and nav badge, the Command Center's situation strip, Monitors' down/failing
states, Issues' open groups — plus Sentinel incidents, which exist explicitly
because _"none of them holds the state that makes a signal answerable"_
(`docs/USER-GUIDE.md:1213-1217`). That sentence is the product diagnosing
itself: Sentinel was added as the seventh surface to compensate for the
fragmentation of the other six, and its own docs worry about becoming "a
second inbox" (`:1219-1221`).

The result for the user: the same failed run can appear as a toast, a bell
entry, a Briefing failure row, an Issue occurrence, a red Monitor, a
board-tile failure, _and_ an incident — seven representations, each with its
own triage verb (dismiss, mark caught up, resolve, ignore, acknowledge), and
no indication they are one event. Attention state also doesn't survive:
the bell log is per-tab and in-memory by design (`notificationLog.ts:15-16`),
so the channel that catches "it failed while you were on another tab" forgets
everything on refresh.

Flow continuity has the same fragmentation at small scale: filtered lists
mutate under the user's cursor as live data arrives — a schedule recovering
while filtered to "failing" vanishes without notice
(`views/Schedules.tsx:549-564`; same for Issues, Monitors, Watchtower), the
palette's command list can shift under an armed Enter (`cmd/usePalette.ts:27-32`),
and no filter, sub-tab, or window survives a reload or can be shared —
contradicting the router's own documented claim
(`web/src/live` vs `useHashRoute.ts:30-32`; eight views hold this state in
`useState`). Cross-links, though a genuine strength, are one-directional:
everything points down to a run, but a run never links back to its schedule,
and a schedule links to neither its monitor, its issues, nor its envelope
(`views/RunRow.tsx`, `views/Schedules.tsx:384-528`).

### The goal, decomposed

1. **One canonical attention item.** Every alerting surface renders
   projections of a single underlying item with a single lifecycle
   (new → seen → handled), so acting on it anywhere retires it everywhere.
   The Briefing is the natural home; the strip, bell, badge, and toasts
   become lenses. Sentinel's timeline model is the right spine — extend it
   downmarket instead of keeping it as a separate elite inbox.
2. **Attention state persists.** Acknowledgement outlives the tab (the
   Briefing ack already persists server-side, `~/.claude/argus/briefing.json`
   — the bell should ride the same rail).
3. **Every signal carries its verb.** A failure notification offers the next
   action in place (Retry / Autopsy / Resolve), the way gate toasts could
   offer Approve — closing the loop the product currently leaves to a
   four-tab tour.
4. **Bidirectional entity linking.** Run ↔ schedule ↔ monitor ↔ issues ↔
   envelope, in both directions, so any surface is one click from any
   related one.
5. **Continuity under liveness.** Departing rows under an active filter leave
   a lightweight trace ("2 recovered since you filtered — refresh"), the
   armed palette list doesn't reorder between keystroke and Enter, and
   filters/sub-tabs/windows live in the URL as the router already promises.

### Measures

- One triage action anywhere clears the item from every surface (testable).
- "Failure → understood cause → corrective action" journey: ≤3 clicks from
  any starting surface.
- Zero filter/sub-tab state lost on reload; shared URLs reproduce the view.

---

## 7. Sequencing and what 10/10 looks like

| Wave | Contents | Rubric effect (weighted) |
| ---- | -------- | ------------------------ |
| 1. Honesty & safety (Goal 4 items 1–4, Goal 3 items 1–2) | fixes with no design dependencies: silent failures, staleness, confirmations, ⌘ leakage, shortcut registry | 3.2 → ~5 |
| 2. Language & wayfinding (Goal 1) | naming policy, persistent teaching, glossary, IA grouping, orphan routes | ~5 → ~7 |
| 3. First hour (Goal 2) | sequenced first run, earned permissions, setup narration, empty-state completion | ~7 → ~8 |
| 4. Platform shell (Goal 3 items 3–5) | path input, Enter-submit, tray/service/notifications | ~8 → ~9 |
| 5. One attention model (Goal 5) | unified attention item, persistence, verbs, bidirectional links, URL state | ~9 → 10 |

A 10 on this rubric is concrete and testable: a Windows developer who has
never seen Argus installs it, is walked to a first successful run inside
fifteen minutes, can say what every tab is for by the end of the session, is
told about every failure exactly once — on their terms, through their OS —
can act on it from the notification itself, can undo what they mis-click,
always knows whether what they're reading is live, and can hand any view to a
colleague as a URL. Nothing in that sentence requires a pixel of visual
redesign; all of it is language, sequence, feedback, and platform respect —
which is exactly the layer where this otherwise superbly engineered product
currently loses seven points.

---

## Appendix — evidence index

Every claim above is anchored to the file:line cited inline. The audit that
produced them covered: first-run flow (`App.tsx`, `SetupBanner.tsx`,
`useSetup.ts`), all 23 routes' empty/error/loading states, every mutating
action in `views/`, all four primary forms, the command layer (`cmd/`), the
live layer (`live/`), the notification stack (`notify/`), and the design-system
primitives (`ds/`). Strengths deliberately not re-litigated here — the 304
no-rerender fetch path, the connection pill's honest backoff, per-route error
boundaries, the absent-vs-zero discipline, the Omnibar's preview-confirm, and
the Flight Recorder's moment-level deep links — are the existing patterns each
goal above asks the product to generalise, which is why every recommendation
is achievable without redesigning what anything looks like.
