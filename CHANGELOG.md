# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

### Added

- **`argus` CLI** (`bin/argus.mjs`, wired as the package `bin`): one command
  that checks for a production build (building UI + server on first run),
  then starts the single-port server. `--open` launches your browser once
  `/api/health` answers; `--port <n>`, `--rebuild`, `--version`, `--help`;
  all `ARGUS_*` environment variables pass through. Install with
  `npm i -g .` (or `npm link`) from a clone — see the README quick start.

## [0.3.0] - 2026-07-14

### Added

- **Launch — one-off runs** (new "Launch" tab, `POST /api/launch`): fire a
  single `claude -p` run straight from the dashboard — prompt, working
  directory, optional name (defaults to the prompt's first line) and optional
  model (`--model` now supported by the scheduler spawn) — without authoring
  a schedule. One-off runs live in a shared `oneoff` bucket (pruned to the
  usual 50-run window, listed via `GET /api/runs?scheduleId=oneoff`), render
  with the same expandable rows as schedule runs (live-tailing log, cancel,
  transcript link) plus a **Reuse** button that refills the form, and flow
  everywhere runs already go: one "One-off runs" Chronicle lane, Issues
  fingerprinting, the Briefing digest, totals and the budget ledger. The run
  row and model picker were extracted into shared components
  (`views/RunRow`, `ds/ModelSelect`) instead of being duplicated.
- **Budget — spend guardrails** (new "Budget" tab, `GET/PUT /api/budget`):
  every completed run's reported cost is folded into a per-local-day ledger
  (`~/.claude/argus/spend.json`) at the same exactly-once point as the
  all-time totals, so scheduled, manual, one-off and pipeline-step runs all
  count and the numbers survive run-record pruning. Set a daily and/or
  monthly USD limit (`~/.claude/argus/budget.json`): the tab shows
  today/this-month meters, a 30-day spend chart and a state pill
  (`ok`/`warning` ≥ 80%/`exceeded`), and the server emits
  `budget.warning` / `budget.exceeded` / `budget.cleared` transition alerts
  each scheduler tick — webhook + `budget:alert` WS frame → in-app toast and
  native notification, with boot-baseline suppression like monitor alerts.
  An opt-in hard stop (`blockScheduled`) records due schedule slots as
  `skipped` runs ("skipped: spend budget exceeded") instead of firing while
  over budget; manual runs, launches and pipeline starts are never blocked,
  and firing resumes automatically once spend drops under every limit.
- **Catch-up for missed schedules** — anacron-style, opt-in per schedule
  ("Catch up a missed run on recovery" in the Scheduler form, `catchUp` on
  the API). A slot that came due while the machine was asleep or Argus was
  down normally expires with the firing grace and is skipped; with catch-up
  on, the most recent missed slot fires **once** on the next scheduler tick.
  Exactly one recovery run per outage regardless of how many slots were
  missed, never a slot from before the schedule existed, and the catch-up
  run also satisfies the schedule's monitor. Cards show a "catch-up" chip.
- **Monitor alerts** — the dead-man's switch now pages you instead of only
  coloring a tab. The server re-derives monitor health each scheduler tick
  and, on an observed transition, emits `monitor.down` / `monitor.failing` /
  `monitor.recovered`: POSTed to `ARGUS_WEBHOOK_URL` (same payload shape as
  `run.failed`/`pipeline.failed`) and pushed as a payload-carrying
  `monitors:alert` WS frame that the web app surfaces as an in-app toast
  plus a native OS notification (under the already-requested permission).
  The first check after boot is a silent baseline — restarting Argus never
  replays known-bad state — and `late` never alerts (that's grace working).
  The agent-notification toast queue was extracted into a shared
  `useToastQueue` so both sources render through one capped,
  auto-dismissing region.
- **Briefing** — a "while you were away" digest (new "Briefing" tab, first
  after Command Center): state-now attention cards (down/failing monitors,
  pipeline phases awaiting approval, open issues) each deep-linking to the
  owning tab, plus a windowed digest since your last **Mark caught up** —
  run outcomes, token/dollar spend, failures, first-seen issues, and finished
  pipelines. The nav tab carries a red attention-count badge visible from any
  tab. Backed by `GET /api/briefing` (pure derivation over runs, schedules,
  issue triage, and instances; window defaults to 24 h, capped at 7 days) and
  `POST /api/briefing/ack` (acknowledgement stored in Argus-owned
  `~/.claude/argus/briefing.json`, broadcast as `briefing:changed`).
- **The Chronicle** — a cross-source timeline view (new "Chronicle" tab):
  every scheduler run, background agent, and interactive session in a chosen
  window (1h–7d) rendered as swimlane spans on one time axis. Overlapping
  spans pack into extra rows; in-flight work draws open-ended into a "now"
  line with a pulse; bars deep-link to the run's session, the agent detail,
  or the transcript. Backed by `GET /api/chronicle?hours=N`, which merges the
  three sources server-side into packed, attention-sorted groups plus window
  totals (spans, in-flight, failed, run spend).
- Design-system additions for it: a reusable `SegmentedControl` (radio-group
  semantics) and pure timeline layout math (`spanGeometry`/`axisTicks`), both
  covered by tests.
- `useLiveResource` gained `pollAlways` for resources that mix pushed sources
  with time-decaying ones (the Chronicle's session-activity status can change
  with no file event).
- `design/` — repo-side sources for the claude.ai/design "Argus Design
  System" project, with card conventions and an incremental DesignSync
  workflow documented; the Chronicle timeline and segmented-control cards
  were published to the shared project.
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

### Removed

- Leftover Vite scaffold assets (`web/src/assets/hero.png`, `react.svg`,
  `vite.svg`) — never referenced by the app.

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
