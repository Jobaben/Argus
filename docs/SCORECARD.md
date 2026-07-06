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

Scores are re-verified after each improvement wave; see git history for the
per-wave deltas.
