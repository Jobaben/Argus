# Argus — Roadmap

## v0.1 — Live agents slice ✅ (2026-06-16)

- Server: jobs + daemon sources, file-watch, `/api/agents`, `/api/agents/:short/timeline`, `/api/daemon`, `/ws`.
- Web: live dashboard, status pills, live-ping indicators, stat tiles.
- Verified end-to-end against real data incl. live WebSocket propagation.

## v0.2 — Full read coverage (in progress)

Fanned out in parallel; each is an isolated source + view + tab:

- **Sessions / transcripts** — list + per-session detail.
- **Activity feed** — `history.jsonl` timeline.
- **Projects** — overview with session counts + last activity.
- **Stats** — usage aggregates from `stats-cache.json`.
- **Inventory** — agents / commands / skills / plugins.
- **Tasks** — task-queue dirs.
- **Agent detail + timeline** — drill-down view.
- **Search** — substring grep across transcripts.
- **Cron** — honest empty-state (limitation documented).
- **UI kit** — shared presentational primitives.
- **Integration** — tab navigation (hash routing), route registration, build + smoke test.
- **Chronicle** ✅ (2026-07-09) — cross-source swimlane timeline: runs +
  agents + sessions merged into packed lanes over a 1h–7d window
  (`/api/chronicle`, Chronicle tab).
- **Monitors** ✅ (2026-07-10) — Healthchecks/Uptime-Kuma-inspired dead-man's
  switch per schedule: up/late/down/failing derivation with period-scaled
  grace, heartbeat bars, uptime % (`/api/monitors`, Monitors tab). Catches
  the slot where nothing ran — invisible to a runs list.
- **Issues** ✅ (2026-07-10) — Sentry-inspired failure grouping: failed runs
  fingerprinted by normalized error, with resolve/ignore triage and
  auto-reopen on regression (`/api/issues`, Issues tab; triage state in
  `~/.claude/argus/issues.json`).
- **Schedule catch-up** ✅ (2026-07-12) — anacron-style opt-in `catchUp` per
  schedule: a slot missed beyond the firing grace (laptop asleep, Argus down)
  fires once on recovery instead of being dropped; one run per outage.
- **Monitor alerts** ✅ (2026-07-12) — server-side transition detection over
  the Monitors derivation on each scheduler tick: `monitor.down` / `.failing`
  / `.recovered` → `ARGUS_WEBHOOK_URL` + payload-carrying `monitors:alert` WS
  frame → in-app toast + native OS notification.
- **Briefing** ✅ (2026-07-12) — "while you were away" digest: state-now
  attention cards (down/failing monitors, waiting gates, open issues) with a
  nav badge, plus a windowed summary (runs, spend, failures, first-seen
  issues, finished pipelines) since the last **Mark caught up**
  (`/api/briefing` + `/ack`, Briefing tab; ack in
  `~/.claude/argus/briefing.json`).
- **Launch** ✅ (2026-07-13) — one-off `claude -p` runs from the dashboard
  (`POST /api/launch`, Launch tab): prompt + cwd + optional name/model, no
  schedule authored; runs land in the shared `oneoff` bucket with live log,
  cancel and a Reuse refire loop, and flow into Chronicle/Issues/Briefing
  like any other run. `--model` support added to the scheduler spawn.
- **Budget** ✅ (2026-07-13) — spend guardrails (`GET/PUT /api/budget`,
  Budget tab): per-day spend ledger fed at the totals choke point, daily +
  monthly USD limits with warning at 80%, `budget.warning/exceeded/cleared`
  transition alerts (webhook + `budget:alert` WS → toast/native), and an
  opt-in hard stop that records due slots as skipped runs while over budget
  (manual actions never blocked).

## v0.3 — Single-port + packaging

- Serve `web/dist` from the Hono server; collapse to one port for `npm start`.
- `npx argus` entry; `--open` flag.
- Engines/CI pin (Node ≥20), `npm audit` cleanup.
- **Pipeline engine** — event-driven, signal-chained ordered phases with human
  gates; definitions + instances under `~/.claude/argus/`; REST/WS surface;
  reference signal hook. (Command Center wiring tracked separately.)

## v0.4 — Cron host

- Optional long-lived poller (in-session or sidecar) that publishes `CronList`
  output to a watched file, lighting up the cron tab for real.

## v0.5 — Notifications & desktop

- Server-Sent "agent finished/failed" events.
- Tauri shell: tray icon + native notifications when a background agent
  completes or fails.

## Experience & engineering wave (2026-07-26)

Not a feature release — a pass over how the whole thing _feels_ and how it is
built underneath. See the changelog for the itemised list.

- **Command layer** — `⌘K` palette over navigation, entities and actions
  (`GET /api/palette`); `g`-chord destinations; a `?` cheatsheet rendered from
  the same bindings the listener dispatches from.
- **Board** — a situation strip (`GET /api/insight`), a live activity rail that
  includes the runs the board does not own, and a step drawer with a tailing log.
- **One contract** — `@argus/contracts`: every wire DTO declared once, imported
  by both workspaces, types-only and CI-enforced. Replaced ~25 duplicated shapes;
  surfaced two real defects (an unvalidated `AgentStatus`, untyped WS frames).
- **Live layer** — `ETag`/`304` conditional reads with zero-re-render no-ops,
  single-flight coalescing, jittered backoff on both fetch and socket, reconnect
  on tab-visible.
- **Ops** — one structured logger (text or JSON lines), `x-request-id` on every
  response, per-route error boundaries.
- **Performance** — a lazy chunk per route (initial payload 105.7 → 91.5 kB
  gzip) with a size budget in CI.
- **Fit and finish** — shape-matched skeletons everywhere, bidirectional relative
  time (fixing `-7138s ago`), a shared clock so labels stay current, a legible
  Chronicle, a usable phone layout, a notification log behind the bell.
- **Second pass over the remaining views** — the Scheduler leads with a verdict
  per schedule, a health strip and humanised time; Monitors and Issues turn their
  counters into filters; Sessions groups by day and searches with the palette's
  matcher; Budget projects the month and marks the days that broke the daily
  limit; Launch keeps the directory between firings. The derivations behind all of
  it (`scheduleHealth`, `projectMonth`, `sessionList`) are pure and tested.

## Quality backlog

- **A scan is still O(files on disk), even when warm.** Retention-by-membership
  and write-patching removed the two costs that mattered (see the changelog), so
  what remains is one `readdir` plus a `stat` per file whenever the 1500ms TTL
  expires or an external process touches the directory — 57ms at 1200 runs. A
  latest-per-key index would make the hot callers O(pipelines) instead, but it is
  a storage-format change with a migration, and the measured cycle is now 1.5ms,
  so it is no longer the bottleneck it was written up as. Revisit only if a real
  install shows the rescan mattering.
- `deriveName` should consult `nameSource` to avoid raw-prompt titles.
- Transcript parser hardening across all 20 observed message types.
- Resolve the 2 npm criticals; drop leftover Vite demo assets.
- Vitest coverage for each `sources/*` against fixture homes.
- Virtualized lists for large session/activity sets.

## What's next — real demand decides

Argus v0.4 is feature-complete for a single human on their own machines.
The next milestone is deliberately **not chosen yet**. Two candidates, both
real, both non-trivial, and the pinned
[roadmap issue](https://github.com/Jobaben/Argus/issues/20) exists to let
actual usage pick between them:

1. **Remote-ingestion adapter** — watch agents that run where you aren't:
   CI jobs, build boxes, servers. A small shipper tails a remote `~/.claude`
   and streams it into your local Argus, keeping the local-first trust model
   (your dashboard, your disk) while widening what it can see.
2. **Team / fleet edition** — several humans, one pane: shared schedules and
   pipelines, per-user approval gates, and an audit trail of who approved
   what. The read-only Constellation federation that ships today is the
   seed of this.

Vote with a 👍 or a comment on the pinned issue; bugs and feature requests
go to [GitHub issues](https://github.com/Jobaben/Argus/issues) either way.
