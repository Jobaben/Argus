# Argus State-of-the-Art Scorecard

A demanding 1–10 rubric used to drive Argus from a competent hobby dashboard to a
state-of-the-art agent-monitoring product. Each dimension is scored by an
adversarially-verified audit. 10 = truly state of the art; 5 = decent hobby
project; 1 = broken.

| Dimension | Weight | Baseline | Target | What "9+" means |
| --- | --- | --- | --- | --- |
| Security | 3× | 3 | 9 | Loopback-bound by default, auth token, Host-allowlist (anti DNS-rebind), Origin/CSRF guard on mutations + WS, model/arg allowlisting, path-traversal proof. |
| Correctness | 3× | 5 | 9 | No lost-update races, no deadlocks, no unhandled-rejection crashes, resilient WS, reentrancy-guarded scheduler, robust result parsing. |
| DX / Ops | 2× | 4 | 9 | Green CI running *all* tests, real prod boot (compiled + Docker + single-port), error handling + logging, honest docs, formatter, versioning. |
| Performance | 2× | 5 | 9 | Cached reads invalidated by the watcher, one shared socket per tab, no full-tree re-renders, bounded payloads. |
| Product | 2× | 5 | 9 | Failure notifications, cancel/kill runs, cost/token capture, export, deep links, single-port packaging. |
| UX / A11y | 2× | 5 | 9 | Labeled inputs, keyboard-complete menus, AA contrast, deep-linkable routing, responsive, action feedback. |
| Testing | 1× | 6 | 9 | API surface + spawn + source parsers covered; all files actually run. |
| Architecture | 1× | 6.5 | 9 | Shared data layer (no 14 duplicate hooks), single DTO source of truth, deduplicated stores. |

**Weighted baseline ≈ 4.9 → target ≈ 9.0.**

## Result after the improvement waves

Scores below are from an **independent re-audit** — eight fresh agents that
read the actual code (not the commit messages) and re-scored each dimension,
then a polish wave that closed the residuals they flagged.

| Dimension | Baseline | After | What changed |
| --- | --- | --- | --- |
| Security | 3 | 9 | Loopback bind, Host allowlist, Origin/CSRF guard (REST + WS), optional constant-time token, model/arg allowlist, traversal guards. |
| Product | 5 | 9 | Failure webhook (incl. spawn-time failures), cost/token capture, cancel-run, live logs, transcript export, overlap-safe manual run. |
| Correctness | 5 | 8+ | Keyed-mutex serialization (no lost updates), deadlock broken + transition re-locked, tick reentrancy guard, robust result parsing, crash handlers. |
| DX / Ops | 4 | 8+ | Green CI running all 184 server tests, compiled build + Docker + single-port, error boundary + logging, honest docs, formatter, 0.2.0 + CHANGELOG. |
| Performance | 5 | 8+ | One shared socket per tab, no idle polling when live, short-TTL single-flight + mtime-keyed read caches. |
| UX / A11y | 5 | 8+ | Deep-link routing, keyboard-complete menu, AA contrast, labeled inputs, action feedback, responsive. |
| Testing | 6 | 8+ | Testable app factory + API integration suite, source-parser tests, browser E2E; 194 → 297 total tests. |
| Architecture | 6.5 | 8+ | Shared live-data layer (one primitive, not 14 hooks), extracted app factory, deduplicated atomic-write + config modules. |

**Weighted ≈ 8.5, up from ≈ 4.9.** Two dimensions reached a demanding 9;
the rest are a strong 8 with a short, named backlog (e.g. per-file detail
caching, a JSON-array store factory, coverage gating). Verified end-to-end in
Chromium and via the API suite; `npm run check` and `npm run build` are green.

Scores are re-verified after each improvement wave; see git history for the
per-wave deltas.
