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

## Quality backlog

- **`/api/overview` instance-storage index** — the overview route calls
  `readInstances()` unfiltered, reading and JSON-parsing every retained instance
  file (~`INSTANCE_KEEP`×N) on every 10s poll and WS push, though `buildOverview`
  keeps only the newest per pipeline. Add a latest-instance index (or
  timestamp-sortable instance filenames) so the route reads N files, not 50×N.
  Negligible at current scale; deferred from the Command Center wiring review
  (2026-06-30). Touches `sources/instances.ts` storage format + the engine's
  write/prune paths, so it warrants its own task.
- `deriveName` should consult `nameSource` to avoid raw-prompt titles.
- Transcript parser hardening across all 20 observed message types.
- Resolve the 2 npm criticals; drop leftover Vite demo assets.
- Vitest coverage for each `sources/*` against fixture homes.
- Virtualized lists for large session/activity sets.
