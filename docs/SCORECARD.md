# Argus State-of-the-Art Scorecard

A demanding 1–10 rubric used to drive Argus from a competent hobby dashboard to a
state-of-the-art agent-monitoring product. Each dimension is scored by an
adversarially-verified audit. 10 = truly state of the art; 5 = decent hobby
project; 1 = broken.

| Dimension    | Weight | Baseline | Target | What "9+" means                                                                                                                                             |
| ------------ | ------ | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security     | 3×     | 3        | 9      | Loopback-bound by default, auth token, Host-allowlist (anti DNS-rebind), Origin/CSRF guard on mutations + WS, model/arg allowlisting, path-traversal proof. |
| Correctness  | 3×     | 5        | 9      | No lost-update races, no deadlocks, no unhandled-rejection crashes, resilient WS, reentrancy-guarded scheduler, robust result parsing.                      |
| DX / Ops     | 2×     | 4        | 9      | Green CI running _all_ tests, real prod boot (compiled + Docker + single-port), error handling + logging, honest docs, formatter, versioning.               |
| Performance  | 2×     | 5        | 9      | Cached reads invalidated by the watcher, one shared socket per tab, no full-tree re-renders, bounded payloads.                                              |
| Product      | 2×     | 5        | 9      | Failure notifications, cancel/kill runs, cost/token capture, export, deep links, single-port packaging.                                                     |
| UX / A11y    | 2×     | 5        | 9      | Labeled inputs, keyboard-complete menus, AA contrast, deep-linkable routing, responsive, action feedback.                                                   |
| Testing      | 1×     | 6        | 9      | API surface + spawn + source parsers covered; all files actually run.                                                                                       |
| Architecture | 1×     | 6.5      | 9      | Shared data layer (no 14 duplicate hooks), single DTO source of truth, deduplicated stores.                                                                 |

**Weighted baseline ≈ 4.9 → target ≈ 9.0.**

## Result after the improvement waves

Scores below are from an **independent re-audit** — eight fresh agents that
read the actual code (not the commit messages) and re-scored each dimension,
then a polish wave that closed the residuals they flagged.

| Dimension    | Baseline | Final | What changed                                                                                                                                                |
| ------------ | -------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security     | 3        | 9     | Loopback bind, Host allowlist, Origin/CSRF guard (REST + WS), optional constant-time token, model/arg allowlist, traversal guards.                          |
| Product      | 5        | 9     | Failure webhook (incl. spawn-time failures), cost/token capture, cancel-run, live logs, transcript export, overlap-safe manual run.                         |
| Correctness  | 5        | 9     | Keyed-mutex serialization (no lost updates), deadlock broken + transition re-locked, tick reentrancy guard, robust envelope parsing, crash handlers.        |
| DX / Ops     | 4        | 9     | Green CI (typecheck→lint→format→test→coverage gate→build), compiled build + Docker + single-port, error boundary + logging, honest docs, enforced Prettier. |
| Performance  | 5        | 9     | One shared socket per tab, no idle polling when live, short-TTL single-flight + mtime-keyed read caches, push-driven inventory/stats.                       |
| UX / A11y    | 5        | 9     | Deep-link routing, keyboard-complete menu (aria-current + Tab), AA contrast, labeled inputs, action feedback, responsive.                                   |
| Testing      | 6        | 9     | Testable app factory + real-engine HTTP progression suite, source/search/daemon/cron parser tests, coverage gate, browser E2E; 194 → 314 tests.             |
| Architecture | 6.5      | 9     | Shared live-data layer (one primitive, not 14 hooks), extracted app factory, jsonArrayStore + makeWatcher + atomic-write + config factories.                |

**Weighted 9.0, up from ≈ 4.9.** Every dimension independently re-verified at 9
by fresh agents reading the actual code — "state of the art, minor polish only."
Verified end-to-end in Chromium and via the API suite; `npm run check`,
`npm run build`, and the CI coverage gate are all green.

### UX/A11y 9 → 10 wave (verified)

A goal-directed wave took **UX/A11y from 9 to a re-audited 10** (the rubric
caps at 10 — an "11" does not exist on this scale). A fresh adversarial
auditor scored the code before and after, named every gap, and re-verified
each fix line-by-line:

- **Live monitoring made perceivable to screen readers** (the prior sole
  blocker): a polite live region announces pipeline badge transitions (needs
  approval / failed / completed / resumed), and every gate action announces
  its accepted/failed outcome (`role="status"` / `role="alert"`).
- Global high-contrast `:focus-visible` indicator; skip-to-content link that
  coexists with the hash router; `<main>` landmark focusable; per-route
  `document.title`.
- `aria-expanded` on Inventory/AgentDetail expanders, `aria-pressed` on
  Scheduler sub-tabs, labeled custom-model input, SetupBanner apply failures
  surfaced (`role="alert"` + busy label), Search states in live regions,
  Stats bars exposed via `role="img"` labels, consistent "Inventory" naming,
  actionable empty states, dead scaffolding CSS deleted.
- **Cost visibility (Product):** every Command Center step tile shows its
  run's tokens + USD, each row a Σ latest-run total (revise attempts
  included), the header a grand total — server-joined from run records, with
  a one-time boot backfill for pre-feature runs, all screen-reader labeled.

Remaining non-defect judgment call named by the auditor: sub-10px px-unit
text on the dense board (AA contrast and zoom-scaling verified; standard
dense-dashboard tradeoff).

### The remaining "9 → 10" polish (diminishing returns)

Each dimension's auditor named what separates a demanding 9 from a flawless 10 —
all incremental hardening, none a correctness or gating failure:

- **Correctness/Testing** — the locking model assumes single-process execution;
  the real subprocess-spawn and step-completion→auto-advance paths aren't driven
  end-to-end (they're unit-tested with injected spawns).
- ~~**Performance** — the generic TTL cache Map isn't size-bounded/swept; the
  summary memo is FIFO rather than LRU.~~ _Closed: cache bounded at 256 keys
  with expired-entry sweep; summary memo is true LRU._
- ~~**DX/Ops** — coverage thresholds are modest and web has no coverage gate; no
  supply-chain scanning (Dependabot/CodeQL).~~ _Closed: server gate ratcheted to
  70/58/58, web gate added at 50/75/50 (both just under actual, enforced in CI);
  Dependabot + CodeQL workflows added. A pre-commit hook was deliberately
  skipped — commits are reviewed manually and CI enforces format/lint._
- ~~**UX/A11y** — the conditional custom-model input relies on a placeholder only
  (out of scope: internal tool, a11y de-prioritized by the owner).~~ _Closed in
  the 9 → 10 wave above (labeled, plus the full gap list the re-audit named)._
- ~~**Architecture** — three instance handlers bypass the shared jsonBody helper;
  a couple of validation/patch idioms remain copied.~~ _Closed: signal/approve/
  revise parse through jsonBody; PUT/PATCH pipelines share one handler; engine
  gate replies share one mapper._

### Beyond-the-rubric wave (post-9.0)

Improvements past the audited 9.0 that no dimension demanded but the product
benefits from:

- **Product** — zero-touch setup: all fixable prerequisites (hook file, Stop +
  PreToolUse registration, data dirs) auto-install at boot; the log names what
  was installed and what still needs a human.
- **Correctness** — a corrupt `settings.json` can no longer be clobbered by a
  prerequisite apply: writes refuse when the file exists but does not parse.
- **Correctness/DX** — the server test glob was single-quoted, which Windows
  `cmd` treats literally: `npm test` on Windows ran **zero** tests and exited
  green. Now double-quoted; the full suite runs on every OS.
- **Performance** — instance reads (`/api/overview` and lists) are memoized by
  mtime: unchanged files cost a `stat`, not a read + parse, per poll.

Scores are re-verified after each improvement wave; see git history for the
per-wave deltas.

## Experience & engineering wave (2026-07-26)

No new scores are claimed here: the numbers above came from independent
adversarial audits, and this wave has not had one. What follows is the factual
record of what changed, so a future audit has something to check.

**Where the previous audits were satisfied but the app was not.** Every
dimension above scored 9–10 against its rubric, and the app still took a tab
tour to answer "does anything need me?". The gap was not in the rubric's
categories; it was that the categories were being met _locally_ — each view
correct on its own — with no measure of the experience of using the whole thing.
That is what this wave went after.

### Defects the work surfaced

These were live in the audited-at-9.0 build. Each is now covered by a regression
test:

| Defect                                                                                                                             | Why the audits missed it                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `AgentStatus` passed the on-disk string straight through, so a newer CLI's state would fall through every exhaustive client switch | The union _looked_ authoritative; nothing tested a value outside it           |
| WS frames were untyped on both ends — a renamed event silently stops waking a view                                                 | Both sides matched string literals that happened to agree                     |
| An aborted fetch cleared `loading`, so a first load could render the _empty state_                                                 | Only visible when a load outlasts a blink; StrictMode makes it routine in dev |
| `TimeAgo` assumed the past, printing `-7138s ago` for a monitor's next slot                                                        | Visible only with a future timestamp and a late monitor                       |
| Relative timestamps never updated after first render                                                                               | Requires watching one screen for minutes                                      |
| The board gave each phase ~60px at 390px wide — one letter per line                                                                | Never opened on a phone                                                       |
| Sub-minute Chronicle spans were 0.03% wide: invisible and unhoverable                                                              | Correct maths, unusable result                                                |
| `web` had never been compiled with `strict`                                                                                        | It happened to compile clean, so nothing complained                           |

### Structural changes

- **One contract, not two copies.** ~25 DTOs were declared twice with nothing
  forcing agreement; they now live in a types-only `@argus/contracts` workspace
  imported by both sides, with CI enforcing that it emits no runtime.
- **The push model got cheap.** Conditional (`ETag`) reads with a genuinely
  zero-re-render `304` path, single-flight coalescing, and jittered backoff on
  both the fetch layer and the socket.
- **One logger, one clock, one socket, one fetch primitive.** 25 ad-hoc
  `console.error` calls became a structured logger with per-request ids; three
  private one-second timers and a dozen render-time `Date.now()` calls became one
  shared clock plus an explicit `useTicker`.
- **Failure is scoped.** Per-route error boundaries; a bad shape costs one view.
- **The initial payload is budgeted.** A lazy chunk per route (105.7 → 91.5 kB
  gzip) with a CI gate so it cannot drift back.

### Test coverage

486 server + 422 web tests, up from 419 + 259 at the start of the wave — every
new module tested, and every defect above pinned by a test that names the failure
mode rather than the fix.
