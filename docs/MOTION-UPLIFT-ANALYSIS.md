# Motion & Feel Uplift — Analysis

**Scope:** An experience analysis of the Argus web app's look, feel, and
animation layer, written from the perspective of a lead UX designer (Apple
fluid-interfaces school) working on a Windows-first product. It proposes the
major goals required to move the _feel_ of the app from its current rubric
grade of **3/10** to **10/10**.

**Hard constraints honored throughout:**

- **No UI redesign.** Layout, information architecture, component anatomy,
  spacing, and typography are untouched by every proposal below.
- **No theme redesign.** The color system (`ground`/`surface`/`ink`/`eye` and
  the semantic status ramp), radii, and type scale stay exactly as they are.
- **No re-litigation of the UX/a11y grading.** The existing accessibility
  posture (focus management, reduced-motion guards, live regions, focus traps)
  is treated as a fixed baseline that every proposal must preserve or extend —
  never trade away.

This is analysis only. Nothing in the app is changed by this document.

> **Status: delivered.** All four goals below have been implemented. This
> document is kept as written — the diagnosis and the plan, unedited, so the
> claims in it stay checkable against the code. For the system as built, and for
> the two places the implementation departed from what is proposed here (the
> mechanism for animating meter fills, and the tiered reduced-motion policy), see
> **[MOTION-SYSTEM.md](MOTION-SYSTEM.md)**.

---

## 1. Where the experience stands today

The codebase already has the _skeleton_ of a motion system — which is exactly
why the felt experience underperforms it. The foundation promises a level of
craft the surfaces don't deliver yet. Grounding facts, by file:

### 1.1 What exists (the foundation)

- **Motion tokens** (`web/src/index.css`): three durations
  (`--duration-quick` 120ms, `--duration-base` 180ms, `--duration-slow`
  320ms), a hard-deceleration `--ease-out-expo`, and a `--ease-spring`
  cubic-bezier with slight overshoot. The comments show real intent: "the UI
  got there before I finished asking."
- **Six keyframes** (`fade-in`, `rise-in`, `slide-up`, `slide-in-right`,
  `shimmer`, plus `pulse`/`sweep`/`ping-ring`), all opacity/transform only —
  correctly compositor-friendly.
- **Three motion helpers** (`web/src/ds/motion.ts`): `useCountUp` (with
  genuinely sophisticated snapping rules), `useChangeFlash` (marks the row
  that changed on a live board), and `staggerDelay` (capped list stagger).
- **A defensible reduced-motion story**: `motion-safe:` prefixes at point of
  use, plus a global `prefers-reduced-motion` kill switch.
- **Entrances in the right places**: route content fades in keyed on the hash
  (`App.tsx:399`), list tiles stagger up (`App.tsx:119-120`), the drawer
  slides in from the right (`Drawer.tsx:79`), the palette rises
  (`CommandPalette.tsx:222`), skeletons shimmer.

### 1.2 Why it still feels like a 3/10

The system has **vocabulary but no grammar**. Individual elements know how to
appear; nothing knows how to _leave_, how to _relate_, or how to _respond_.
Concretely:

1. **Nothing ever exits.** Every overlay in the app unmounts instantly:
   - `Drawer.tsx:113` — `open ? <Panel {...rest} /> : null`. Slides in over
     180ms, vanishes in 0ms.
   - `CommandPalette`, `ShortcutHelp`, `MoreMenu`, the mobile nav sheet
     (`NavBar.tsx:71-117`) — same pattern: animated entrance, teleport exit.
   - **Toasts have no animation at all** (`Toast.tsx`): they pop into the
     bottom-right stack with zero entrance, and when one is dismissed the
     remaining stack snaps upward instantly. For a _notification_ surface —
     whose entire job is to catch the eye gracefully — this is the loudest
     single "unfinished" signal in the app.

2. **All transitions are fades; none are spatial.** The route change is one
   opacity crossfade keyed on the hash. Drilling from an agent tile into
   `#/agent/…`, or from a run row into the Flight Recorder, gives no visual
   account of where the detail came from or how to get back. The nav's active
   pill teleports between tabs (background swap, no slide). The app has deep
   hierarchy (board → tile → detail → run → step drawer) and its motion
   expresses none of it.

3. **Everything is fire-and-forget.** All motion is CSS keyframes with fixed
   durations. Nothing is interruptible: open-then-quickly-close restarts from
   keyframe zero; hover lift (`hover:-translate-y-0.5`) retargets only because
   it's a trivial transition. The "spring" is a cubic-bezier imitation with no
   velocity, so no gesture can ever hand off momentum to it. The drawer cannot
   be swiped; nothing tracks the pointer.

4. **The live board doesn't move like a live board.** This is a real-time
   monitoring product — data arrives over a WebSocket — yet rows insert,
   remove, and reorder as hard jumps. `useChangeFlash` marks _that_ a row
   changed, but a new heartbeat tick simply appears in `HeartbeatBar`, a
   re-sorted fleet snaps to its new order, and a meter's width just becomes
   the new width. The one thing a monitoring dashboard can do that a static
   report can't — _show change as change_ — is mostly unexploited.

5. **Micro-feedback is one-dimensional.** Interactive elements have hover
   color transitions and, on tiles, a hover lift. There are no pressed states
   anywhere, no settle after the lift, no feedback curve on buttons that fire
   real actions (approve gate, run schedule, kill agent). The
   skeleton-to-content handoff is a hard swap: shimmer, then blink, content.

**Rubric summary:** foundation 7/10, application ~2/10 → experienced feel
3/10. The good news: because the tokens, the a11y posture, and the visual
design don't need to change, the entire distance to 10/10 lies in _motion
application_ — the cheapest, most contained kind of uplift there is.

---

## 2. The three major goals

Ordered by rubric leverage. Each is scoped to motion and feel only; no pixel
of static UI changes.

---

### Goal 1 — Close the motion lifecycle: everything that enters must leave

**From 3 → 6. The credibility goal.**

The single strongest "cheap app" tell on any platform is asymmetric motion:
surfaces that glide in and blink out. Users don't consciously notice missing
exits, but they _feel_ them — the illusion of a physical interface collapses
at every dismissal, dozens of times a session. On Windows this is doubly
visible because Fluent-native apps (and the OS shell itself) animate
dismissals everywhere; a web dashboard that doesn't reads as foreign chrome.

**Definition of done — the lifecycle contract:** every surface in the app has
a paired entrance and exit built from the same keyframe family, with exits
faster than entrances (a good rule: exit ≈ 0.7× entrance duration, ease-in
rather than ease-out — things leave with urgency and arrive with a settle).

Specific closures, all mechanical:

| Surface                                   | Today                           | Target                                                                                                                     |
| ----------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Drawer (`Drawer.tsx`)                     | slide-in 180ms / unmount 0ms    | slide-out-right + scrim fade-out, then unmount                                                                             |
| Command palette                           | rise-in 160ms / unmount 0ms     | sink-out (reverse of rise) ~120ms                                                                                          |
| Shortcut help, MoreMenu, mobile nav sheet | fade/rise in / 0ms out          | mirrored exits                                                                                                             |
| Toasts (`Toast.tsx`)                      | **nothing at all**              | slide-up-in with slight overshoot; slide-right-out on dismiss; the remaining stack _re-flows smoothly_ instead of snapping |
| Route content                             | fade-in only; old view vanishes | true crossfade (old settles out as new arrives)                                                                            |
| Skeleton → content                        | hard swap                       | skeleton fades under content as content fades over — one continuous surface, no blink                                      |
| Change flash (`useChangeFlash`)           | background pops on, times out   | flash decays on a curve, so attention is _released_, not cut                                                               |

**Implementation posture (no redesign needed):** the standard
animate-then-unmount pattern (`onAnimationEnd` → unmount, or the View
Transitions API where available) applied to the existing `open ? x : null`
sites; the exit keyframes are the time-reverses of keyframes that already
exist in `index.css`. Reduced-motion users keep instant dismissal — for them
the current behavior is already correct, which is exactly why exits must be
added under `motion-safe:` rather than by slowing everyone down.

**Why this is worth 3 rubric points:** it converts every one of the app's
most frequent interactions (open/close palette, open/close drawer, toast
arrival — the highest-frequency motion events in the product) from "half
animated" to "coherent object behavior." Nothing else buys as much felt
quality per line changed.

---

### Goal 2 — Spatial continuity: motion that explains the hierarchy

**From 6 → 8. The orientation goal.**

Argus is deep: Command Center → agent tile → agent detail → run → Flight
Recorder → step drawer, with a palette that teleports anywhere. Today every
navigation is the same flat crossfade, so the interface has no geography —
each screen replaces the last like slides in a deck. Great-feeling apps use
motion to answer, preconsciously, three questions: _where did this come from,
where did the old thing go, and how do I get back?_

Three sub-programs, none touching layout or theme:

**2a. Directional grammar for navigation.** Define, once: drilling _down_
(tile → detail, row → recorder) slides content subtly forward (old view
settles back ~2% scale and dims as new view arrives from ~8px right); going
_back_ reverses it; _lateral_ tab switches keep the existing crossfade.
Applied at the one route container in `App.tsx:399` plus a
direction flag derived from the existing `TAB_META` roles
(`destination`/`drilldown`) — the metadata needed to infer direction already
exists.

**2b. Shared anchors.** The active-tab pill in `NavBar` should _slide_ between
destinations rather than teleport (one absolutely-positioned indicator
animating `transform`, colors untouched). The drawer should scale its scrim
fade from the clicked row's side of the screen; the palette's selected result
should visibly hand off to the destination (even a 120ms highlight carried
across the transition is enough to close the loop). Where Chromium's View
Transitions API is available — which on a Windows-first deployment (Edge) is
effectively everywhere — element-level `view-transition-name`s on the agent
tile ↔ agent detail header make the tile visibly _become_ the page header.
Progressive enhancement: browsers without it keep today's crossfade.

**2c. Origin-aware overlays.** `rise-in` currently drops every overlay from
the same anonymous "above the page" position. Overlays should originate from
their invoker: the MoreMenu from its button (`transform-origin` at the
trigger), the mobile sheet from the nav edge it belongs to, the step drawer
from the step row's vertical position. Same keyframes, parameterized origin.

**Why this is worth 2 rubric points:** lifecycle symmetry (Goal 1) makes the
app feel _finished_; spatial grammar makes it feel _designed_. It is also the
difference between motion as decoration and motion as information — the
standard the codebase itself sets in `motion.ts`: "animation has to carry
information, or it is decoration that costs the user time." Direction and
origin _are_ information.

---

### Goal 3 — Living-data choreography: the board must move like the system it watches

**From 8 → 9.5. The identity goal.**

This is where Argus can go from "polished dashboard" to "the reason people
leave it on a second monitor." The product's essence is _live state_ — agents
working, runs finishing, monitors failing — and right now state changes are
rendered as discontinuities: a re-sort snaps, a new row pops, a meter jumps.
The motion system should make the data feel continuously alive without ever
becoming noisy. The design intent is a quiet room where _only change moves_.

Concrete choreography, per existing component:

- **FLIP reordering everywhere lists re-sort.** When the fleet re-orders, when
  a schedule's health changes its position, when a toast is dismissed from the
  stack: measure, reorder, invert, play — rows glide to their new positions
  (~180ms, `--ease-out-expo`) instead of teleporting. This single technique
  covers the majority of live-update jank, and it composes with the existing
  `useChangeFlash` (the row glides _and_ flashes: what moved, and why).
- **HeartbeatBar arrival** (`HeartbeatBar.tsx`): a new tick should push the
  strip left by one slot with a short settle, the newborn tick scaling in from
  the baseline — the visual signature of "a run just landed," legible from
  across the room.
- **Status transitions as morphs, not swaps** (`StatusPill`, `AgentTile`):
  a pill going `working → failed` should crossfade its tint over ~180ms rather
  than hard-swap classes; paired with the existing ping-ring on entry to
  `failed`, arrival at a bad state becomes a small, unmistakable event. Colors
  themselves are untouched — only the _transition between_ them is added.
- **Meters and numbers**: `Meter` widths animate to new values (transform
  scaleX, not width); `useCountUp` — currently the app's best motion asset —
  extends to every live numeral (spend, counts, durations) with its existing
  snap rules intact.
- **Ambient liveness with a shared clock**: the `pulse`/`sweep` indicators
  currently free-run and drift out of phase, which reads as clutter when
  several are visible. Synchronizing them (negative `animation-delay` off a
  shared epoch) makes multiple live indicators breathe together — a subtle
  cue that this is one system, not a pile of widgets.
- **Flight Recorder scrub feel**: the scrubbable timeline is the app's most
  direct-manipulation surface; playhead and track should track the pointer
  1:1 with a short velocity settle on release, making replay feel like a
  physical instrument rather than a slider updating a value.

**Guardrails (non-negotiable, and consistent with the existing a11y
posture):** every choreography above is transform/opacity only; anything
continuous respects the existing reduced-motion kill switch; change-driven
motion is rate-limited (a board with 50 updates/second must coalesce, not
strobe — the `useCountUp` "huge jump snaps" rule generalizes: _high-frequency
change degrades to steady state, not to chaos_).

**Why this is worth 1.5 rubric points:** it's the goal that makes the motion
_mean something particular to this product_. Goals 1 and 2 could apply to any
app; Goal 3 is Argus's.

---

### Goal 4 (the last half-point) — Tactility: interruptible, physical response

**From 9.5 → 10. The instrument goal.**

The final grade point is the difference between watching a well-animated app
and _handling_ a responsive one:

- **Interruptibility.** Migrate the overlay and list transitions from
  fire-and-forget CSS keyframes to WAAPI-driven (or CSS `linear()` spring)
  transitions that can be retargeted mid-flight. Open-close-open the drawer
  rapidly and it should reverse from wherever it is, never restart. This is
  the Apple fluid-interfaces core tenet: the interface is continuously
  responsive, never "busy animating."
- **Real springs where `--ease-spring` fakes one today**, so gesture velocity
  can hand off: a drawer flicked closed leaves at flick speed; a scrubbed
  playhead released mid-drag settles with its momentum.
- **Pressed states.** Every actionable control (palette rows, nav pills,
  gate-approve buttons, tile links) gets an `:active` compression
  (~`scale(0.98)`, 60–80ms) — the missing half of the existing hover lift.
  Cheap, universal, and the single most-felt micro-interaction on a desktop
  app where users click hundreds of times a session.
- **A 60/120fps performance budget in CI**: compositor-only properties
  enforced by convention today become enforced by lint/test (the repo already
  runs a CI-enforced chunk-size budget; a motion-property budget is the same
  discipline applied to feel).

---

## 3. Sequencing and the rubric path

| Phase | Goal                                                  | Rubric   | Character of work                       |
| ----- | ----------------------------------------------------- | -------- | --------------------------------------- |
| 1     | Lifecycle symmetry (exits, toasts, crossfades)        | 3 → 6    | Mechanical, low-risk, per-component     |
| 2     | Spatial grammar (direction, shared anchors, origins)  | 6 → 8    | One-time grammar + per-surface adoption |
| 3     | Living-data choreography (FLIP, morphs, shared clock) | 8 → 9.5  | Product-defining, needs guardrails      |
| 4     | Tactility (springs, interruption, pressed states)     | 9.5 → 10 | Craft ceiling, progressive enhancement  |

Cross-cutting, from phase 1 onward:

- **Extend the token vocabulary, don't replace it**: add exit-duration and
  spring-parameter tokens beside the existing three durations; every new
  animation must consume tokens, never inline magic numbers (today
  `CommandPalette.tsx` hardcodes `120ms`/`160ms` beside the token system —
  the uplift should end that drift, not add to it).
- **Document each pattern as a design-system card** in `design/components/`
  (the sync pipeline to the claude.ai/design project already exists), so
  motion is reviewed the way color and type already are.
- **Tiered reduced-motion**: keep the global kill switch as the floor, but
  prefer the finer policy the codebase already gestures at — under reduced
  motion, transform-based choreography disappears while sub-200ms opacity
  fades may remain; instant state change stays fully legible either way.

## 4. What explicitly does _not_ change

To keep the mandate unambiguous: no color, token value, layout, spacing,
typography, icon, copy, component anatomy, navigation structure, or a11y
behavior changes under any goal above. Focus order, focus traps, `aria-live`
regions, and `prefers-reduced-motion` semantics are preserved exactly; every
proposed animation is additive under `motion-safe:` and transform/opacity
only. The uplift is entirely in _when and how things move_ — the app already
knows what it looks like.
