# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

### Added

- Command Center cost surfacing: every step tile shows its run's tokens and
  dollar cost, each pipeline row shows the latest run's total (Σ chip, all
  revise attempts included), and the page header shows the grand total across
  every pipeline. `GET /api/overview` now joins `costUsd`/`tokens` onto each
  step and returns a per-instance `cost` total.
- Boot-time cost backfill: terminal runs recorded before cost capture existed
  are patched once from their log envelopes, so historical steps show spend
  immediately after upgrading.
- UX/A11y wave (independently re-audited 9 → 10): a polite live region
  announces pipeline status transitions and gate action outcomes; per-route
  `document.title`; global high-contrast `:focus-visible` outline;
  skip-to-content link + focusable `<main>` landmark; `aria-expanded` /
  `aria-pressed` on expanders and sub-tabs; labeled custom-model input;
  SetupBanner apply failures surfaced with `role="alert"` and a busy label;
  Search states and connection pill in live regions; Stats hour bars exposed
  as labeled images; "Inventory" named consistently; actionable Command
  Center empty state; dead Vite scaffolding CSS removed.

- Auto-setup on boot: every fixable prerequisite (signal hook file, Stop and
  PreToolUse registration, data directories) is installed automatically at
  server start; the log reports what was installed and what still needs a
  human (missing CLI, corrupt files).
- Web test-coverage gate (`npm -w web run test:coverage`, enforced in CI) and
  a raised server coverage gate (70/58/58, ratcheted to just under actual).
- Supply-chain scanning: Dependabot (npm, GitHub Actions, Docker) and a CodeQL
  workflow.

### Fixed

- Pipeline step runs completed by the live tracking path never captured
  cost/tokens/result from the CLI's JSON envelope (only restart-adopted runs
  did); the completion handler now parses the log tail like the reconcile
  path.
- `applyAll`/`preflight` no longer risk clobbering a corrupt-but-recoverable
  `settings.json`: writes now refuse when the file exists but does not parse
  (checks still report it as `settings-parse: error`).
- The server test script used single quotes around its glob, which Windows
  `cmd` passes through literally — `npm test` matched zero files and reported
  a false green. Double-quoted so all 220 tests run on every OS.
- Generated `web/coverage/` output is ignored by git, ESLint, and Prettier.

### Performance

- Pipeline-instance reads (`/api/overview`, instance lists) use an mtime-keyed
  parse memo: unchanged instance files cost a `stat` instead of a read +
  `JSON.parse` on every poll.
- The shared TTL cache is size-bounded (256 keys) with expired-entry sweep;
  the session-summary memo is now true LRU (hits refresh recency).

### Changed

- The three instance-action handlers (`signal`, `approve`, `revise`) parse
  bodies through the shared `jsonBody` helper; pipeline PUT/PATCH share one
  update handler; engine gate replies share one response mapper.

## [0.2.0]

### Hardening (post-audit polish)

- Fix a race the deadlock fix introduced: the detached next-phase start now
  re-acquires the instance lock and re-verifies liveness, so an abort/revise
  landing mid-transition can't be clobbered or orphan spawned children.
- `prereqs.writeSettings` uses the shared atomic writer (pid+random temp)
  instead of a pid-only temp that could collide between concurrent writers.
- Token comparison is constant-time (`crypto.timingSafeEqual`).
- The failure webhook now also fires for runs that fail at spawn time.
- Per-file, mtime-keyed session-summary memoization so a list refetch no longer
  re-parses unchanged transcripts.
- A11y: labeled interval/time trigger inputs and the pipeline revise-note input;
  windowed schedules render an accurate summary string.

### Security

- Server binds to loopback (`127.0.0.1`) by default; `ARGUS_HOST` to override.
- Host-header allowlist (defeats DNS-rebinding) and Origin checks on all
  mutating requests (defeats drive-by CSRF), applied to REST and the WebSocket
  upgrade.
- Optional `ARGUS_TOKEN` bearer-token gate for non-loopback deployments.
- `--model` values validated against an identifier allowlist (argv/shell
  injection); path-traversal guard on the agent-timeline route.

### Fixed

- Lost-update races on pipeline instances and JSON stores eliminated with a
  keyed mutex serializing every read-modify-write.
- Semaphore self-deadlock on the signal path broken by detaching step spawns.
- Scheduler tick reentrancy guard prevents double-fires; `stop()` drains the
  in-flight tick.
- Atomic writes use unique temp names (no same-file collision).
- Run-completion handlers can no longer crash the daemon (unhandled rejection);
  process-level `unhandledRejection`/`uncaughtException` handlers added.
- Robust CLI result parsing (256 KB tail, envelope recovery) — large results no
  longer silently dropped.
- Schedules no longer fire immediately when created within their trigger window.

### Added

- Single-port packaging: `npm run build && npm start` serves UI + API together.
- Compiled server build (`server/dist`) and a multi-stage `Dockerfile`.
- `POST /api/runs/:id/cancel` to kill a running scheduled run.
- Per-run cost (`total_cost_usd`) and token capture.
- `/api/health` reports the version.
- CI workflow (typecheck, lint, test, build); server ESLint; Prettier and
  EditorConfig; `.nvmrc`.
- Quality rubric in `docs/SCORECARD.md`.

## [0.1.0]

- Initial live-agents dashboard: background jobs + daemon liveness, live
  WebSocket refresh, plus the Scheduler and Pipelines verticals.
