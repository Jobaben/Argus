# The Motion System

What Argus's motion layer actually does, and why each part of it is the way it
is. The companion to [MOTION-UPLIFT-ANALYSIS.md](MOTION-UPLIFT-ANALYSIS.md) —
that document is the diagnosis and the plan; this one is the delivered system,
written for whoever adds the next surface.

Nothing here changed a colour, a size, a spacing value, a piece of copy, a
component's anatomy, or an accessibility behaviour. The whole uplift is in _when
and how things move_.

---

## 1. The rules

Five, in the order they get violated.

**1. Everything that enters, leaves.** Every surface has a paired entrance and
exit built from the same travel, with the exit at `--duration-exit` (0.7× the
entrance) and easing _in_ rather than out. Things arrive with a settle and leave
with urgency, because by the time something is leaving you already asked for it
to go. There is no such thing as an animated entrance with an instant exit — that
asymmetry is the loudest "unfinished" tell an interface has, and it is felt at
every dismissal, which is the most frequent thing anybody does.

**2. Motion is transform and opacity.** Nothing animates a property that costs a
layout. `scripts/check-motion-budget.mjs` enforces it in CI over both the
keyframes in `index.css` and the `transition-[…]` utilities in `web/src`, with a
short list of argued exceptions (meter fills and the nav pill, all absolutely
positioned or clipped leaves that cannot move a sibling). This started as a
convention and had already decayed once: `sweep`, the strip on every working step
tile, animated `left` sixty times a second in a file whose own comment claimed
otherwise. Nobody was lying; nothing was checking.

**3. Durations and easings are tokens.** `index.css` declares them; `DURATION`
and `EASE` in `ds/motion.ts` mirror them for the animations JavaScript drives
(the Web Animations API takes milliseconds, not custom properties).
`ds/tokens.test.ts` reads the stylesheet and fails if the two ever disagree. No
animation anywhere inlines a number.

**4. Motion carries information or it does not ship.** Direction says where you
went. Origin says what opened this. A glide says which row moved. A count-up says
a number changed. Anything that says nothing is decoration charged to the user's
time.

**5. Reduced motion resolves instantly — it never animates faster.** The global
`prefers-reduced-motion` kill switch in `index.css` is the floor, and every
JavaScript-driven animation checks `prefersReducedMotion()` as well, because CSS
cannot reach a WAAPI animation or a `::view-transition-*` pseudo-element. For
those users the app behaves exactly as it did before this work: surfaces appear
and disappear at once, lists reorder without gliding, gestures do not throw.

> **A deliberate deviation from the analysis.** §3 of the analysis proposed a
> _tiered_ reduced-motion policy — transform choreography off, sub-200ms opacity
> fades still on. That was not taken. Reduced-motion users have a guarantee today
> (nothing moves, nothing fades) and tiering it would be spending an existing
> accessibility promise to buy polish for people who did not ask for it. The
> analysis's own hard constraint says that posture may be extended but never
> traded away, and this is the one place where the finer policy and that
> constraint disagree.

---

## 2. The primitives

All in `web/src/ds/`.

| Module              | What it is for                                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence.ts`       | `usePresence` keeps a surface mounted through its exit; `useSurfaceMotion` drives one element's entrance and exit reversibly; `useListPresence` does the same for a list whose items are removed by someone else. `SURFACE` is the table of how each kind of surface moves. |
| `flip.ts`           | `useFlip` — First/Last/Invert/Play for any keyed list, so a reorder is visible as a reorder.                                                                                                                                                                                |
| `spring.ts`         | A real damped oscillator: `springLinear()` samples it into a CSS `linear()` easing, `settleFrom()` answers where a flick comes to rest.                                                                                                                                     |
| `gesture.ts`        | `createVelocityTracker` measures pointer velocity over a trailing window; `flickOutcome` decides whether a gesture completes.                                                                                                                                               |
| `direction.ts`      | `routeDirection` — forward, back or lateral, derived from the nav roles that already existed.                                                                                                                                                                               |
| `viewTransition.ts` | The browser View Transitions API as progressive enhancement, plus `transitionName` for shared elements.                                                                                                                                                                     |
| `motion.ts`         | `useCountUp`, `useChangeFlash`, `staggerDelay`, `useSyncedDelay`, and the `DURATION`/`EASE` tokens.                                                                                                                                                                         |

### Why WAAPI and not keyframes for overlays

A CSS keyframe cannot be asked where it currently is. So open-close-open on a
keyframe restarts the entrance from opacity zero — the visual signature of an
interface that is busy animating rather than listening. `useSurfaceMotion` drives
the transition through `element.animate()`, keeps track of where along its travel
the surface visually _is_, and on interruption seeks the opposite animation to
that point. Press ⌘K three times quickly and the palette follows the keystrokes.

That is also why `web/src/test/setup.ts` ships a small WAAPI timing stub for
jsdom, the same way it already ships `scrollIntoView`: without it every test
would take the no-WAAPI fallback and the exit path — the entire point of the
module — would never run.

---

## 3. Adding a surface

An overlay, popover, sheet or drawer:

```tsx
const { present, exited } = usePresence(open);
const scrimRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.scrim);
const panelRef = useSurfaceMotion<HTMLDivElement>(open, SURFACE.rise, exited, "top right");
if (!present) return null;

return (
  <div ref={scrimRef} inert={!open} aria-hidden={open ? undefined : true} …>
    <div ref={panelRef} role="dialog" …>…</div>
  </div>
);
```

Four things that are easy to get wrong:

- **`exited` goes on exactly one element per surface** — the one whose motion
  decides when the surface is really gone. A scrim just follows.
- **`inert` _and_ `aria-hidden` while leaving.** A surface on its way out is a
  picture of a dialog: it must not take a click, a Tab stop or a screen-reader
  announcement. In jsdom `inert` is only an attribute, which is a second reason
  to state it both ways.
- **`motion` must be a stable reference** — a `SURFACE` entry, not an object
  literal. It is an effect dependency, so a fresh object every render restarts
  the animation every render.
- **Pass an `origin`** when the surface belongs to a trigger. An overlay that
  grows out of the button that opened it is saying something; one that grows out
  of an anonymous point above the page is not.

A live list:

```tsx
const flip = useFlip();
rows.map((r) => (
  <li key={r.id} ref={flip(r.id)}>
    …
  </li>
));
```

The key must identify the _row_, not its position — a key that changes when the
row moves is indistinguishable from a different row arriving, and telling those
apart is the entire job.

A control: give it `motion-safe:active:scale-[0.97]` and
`duration-(--duration-press)`. Hover without press is half a micro-interaction,
and on a desktop app people click hundreds of times a session.

---

## 4. What moves, where

**Lifecycle.** Drawer, command palette, shortcut sheet, overflow menu, mobile nav
sheet, notification popover — paired entrance and exit, interruptible. Toasts
arrive on a slight overshoot, leave sideways off the stack's axis, and the stack
closes the gap with FLIP. `Handoff` fades a skeleton out over the content that
replaces it, at every in-place loading region; an early return and a Suspense
fallback keep plain `Loading`, because there is no shared region for a handoff to
happen in and the route transition already covers that swap.

**Spatial.** Route changes are directional: drilling in brings the new view from
the right while the old settles back, going back reverses it, peer destinations
keep the crossfade. Where the browser has View Transitions the old view is really
still on screen for it; where it does not, the arriving view animates its own
entrance. The agent tile and the agent detail heading share a
`view-transition-name`, so the tile becomes the page. The nav's active pill is one
element that slides. Overlays originate at their invoker; the step drawer grows
from the row that opened it.

**Living data.** FLIP on the Command Center board, the schedule list, monitors,
issues, the agent grid, the toast stack and the heartbeat strip. A new heartbeat
tick grows from the baseline while the strip slides left by a slot. Status pills
crossfade their tint instead of hard-swapping it, and arriving at `failed` rings
once. Meter fills animate to their new value; board-level totals count. Every
ambient `pulse`/`sweep`/`ping`/shimmer takes its phase from one shared epoch via
`useSyncedDelay`, so a board with six live indicators shows one rhythm instead of
six.

**Tactility.** The drawer can be flicked away, with the outcome decided from
measured velocity so a fast two-pixel flick dismisses and a slow drag half-way
across does not. The Flight Recorder's lane strips are the scrubber: press to
land, drag to track the pointer 1:1, release to glide to rest with the momentum
you let go with. Pressed states on palette rows, nav pills, menu items, tile
links, gate buttons, transport controls and dialog buttons.

---

## 5. The guardrails

- **Rate limiting.** FLIP retargets rather than queues: a board updating faster
  than it animates converges on the current layout instead of replaying every
  layout it passed through. `useCountUp` snaps on a >20× jump. `useFlip` snaps
  rather than animates a jump over 2000px. High-frequency change degrades to
  steady state, not to chaos.
- **`ds/tokens.test.ts`** fails if a duration or easing drifts between the
  stylesheet and the TypeScript mirror, and asserts the exit ratio itself — an
  exit that becomes slower than its entrance breaks the feel without breaking
  anything a test would otherwise catch.
- **`ds/spring.test.ts`** regenerates the spring and compares it to the
  `--ease-spring-settle` token, so the curve and its CSS form cannot separate.
- **`scripts/check-motion-budget.mjs`** in CI, per rule 2 above. It also fails on
  a _stale_ exception, because an allowance nobody is exercising is a claim
  nobody is checking.
- **Two design-system cards**, `design/foundations/motion-lifecycle` and
  `design/foundations/motion-choreography`, so motion is reviewed the way colour
  and type already are. Both are runnable rather than illustrated: motion
  reviewed as a screenshot is motion nobody reviewed.
