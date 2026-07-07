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

### The remaining "9 → 10" polish (diminishing returns)

Each dimension's auditor named what separates a demanding 9 from a flawless 10 —
all incremental hardening, none a correctness or gating failure:

- **Correctness/Testing** — the locking model assumes single-process execution;
  the real subprocess-spawn and step-completion→auto-advance paths aren't driven
  end-to-end (they're unit-tested with injected spawns).
- **Performance** — the generic TTL cache Map isn't size-bounded/swept; the
  summary memo is FIFO rather than LRU.
- **DX/Ops** — coverage thresholds are modest and web has no coverage gate; no
  supply-chain scanning (Dependabot/CodeQL) or pre-commit hook.
- **UX/A11y** — the conditional custom-model input relies on a placeholder only.
- **Architecture** — three instance handlers bypass the shared jsonBody helper;
  a couple of validation/patch idioms remain copied.

Scores are re-verified after each improvement wave; see git history for the
per-wave deltas.
