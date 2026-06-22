# Scheduled Runs, Monitored by Argus — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan
**Topic:** Let Argus create, fire, and monitor scheduled headless Claude runs — showing what is going to happen, what is happening, and what has happened.

## Problem

Argus today is a passive, read-only monitor over files under `~/.claude` (sessions,
jobs, daemon roster, tasks, history). It cannot show scheduled work: Claude Code's
cron routines are session-scoped and never persisted to disk in a watchable form
(`server/src/sources/cron.ts` hard-codes `available: false`), and Argus has no
schedule store of its own.

The user wants to **create scheduled runs that Argus monitors**, with detail about:

- **Going to happen** — upcoming runs and when they will fire.
- **Happening** — runs currently executing, live.
- **Has happened** — past runs with their outcome and detail.

## Decisions (settled during brainstorming)

| Question | Decision |
|---|---|
| What runs on each tick | **Headless Claude runs** (`claude -p "..."` on this machine). |
| Who owns the scheduler | **Argus owns it** — schedules created/edited in Argus; the Argus server fires the runs. Schedules fire only while the server is up (accepted). |
| How a run executes | **Argus spawns `claude -p` directly** as a child process and captures stdout/stderr + exit code. Links to the session transcript Argus already renders. |
| Schedule format | **Simple presets + interval** (every N minutes/hours; daily at HH:MM; weekly on weekday at HH:MM). No raw cron syntax in v1. |
| Process architecture | **Approach A** — scheduler embedded in the existing Argus web-server process, file-backed, stateless re-read each tick. (Rejected: B forked sidecar, C in-memory timers.) |

### Accepted defaults

- **No backfill of missed windows.** If Argus was down across a daily/weekly slot,
  that occurrence is skipped, not replayed. A **"Run now"** action covers manual
  catch-up. (Interval triggers naturally fire once on the next tick when overdue,
  within a short grace window — see §3.)
- **Overlap policy default = `skip`.** If the prior run of the same schedule is still
  alive, the tick records a visible `skipped` run rather than stacking a second.
- **Tick interval = 30s** (`ARGUS_SCHED_TICK_MS`).
- **Retention = last 50 runs per schedule; captured log capped at 1 MB per run.**
- **Transcript linking** via a pre-generated session id handed to the headless run
  (exact CLI flag verified during implementation — see §3).

## Architecture

Approach A: a scheduler module starts inside the existing Argus server (alongside the
Hono HTTP server in `server/src/index.ts`). It re-reads `schedules.json` from disk on
every tick (stateless — live edits take effect without restart) and spawns due runs.
All state lives in files under a new `~/.claude/argus/` directory, consistent with
Argus's existing "read files under `~/.claude`, watch for changes, push a WS ping"
grain. Each run is its own child process, so the scheduler does not block the server
event loop.

This makes Argus no longer purely read-only: it gains write API routes and the ability
to spawn processes. Both are localhost-bound, as the server already is.

## 1. Data model

New directory `~/.claude/argus/` (resolved via the existing `claudeHome()` /
`ARGUS_CLAUDE_HOME` mechanism, so tests can point it at a temp dir).

### `schedules.json` — array of schedule definitions

```jsonc
{
  "id": "uuid",
  "name": "Nightly repo health check",
  "prompt": "Review the repo for failing tests and summarize.",
  "cwd": "C:/GIT/argus",
  "trigger": {
    "kind": "interval" | "daily" | "weekly",
    "everyMinutes": 60,      // interval only
    "time": "02:00",         // daily/weekly only (local time)
    "weekday": 1             // weekly only, 0=Sun..6=Sat
  },
  "enabled": true,
  "overlapPolicy": "skip" | "allow",
  "createdAt": "ISO",
  "updatedAt": "ISO",
  "lastRunAt": "ISO | null",
  "lastRunId": "string | null"
}
```

### `runs/<runId>.json` — one record per execution

```jsonc
{
  "id": "uuid",
  "scheduleId": "uuid",
  "scheduleName": "string",        // snapshot for display even if schedule is later edited/deleted
  "prompt": "string",
  "cwd": "string",
  "status": "running" | "succeeded" | "failed" | "skipped" | "interrupted",
  "trigger": "scheduled" | "manual",
  "queuedAt": "ISO",
  "startedAt": "ISO | null",
  "endedAt": "ISO | null",
  "durationMs": "number | null",
  "pid": "number | null",
  "exitCode": "number | null",
  "sessionId": "string | null",    // click-through to the transcript Argus already renders
  "project": "string | null",      // encoded project dir for the transcript link
  "resultSummary": "string | null",
  "error": "string | null"
}
```

### `runs/<runId>.log`

Raw captured stdout + stderr, capped at 1 MB (truncated with a marker). For display
the run-detail endpoint returns a tail, reusing the existing display-truncation idiom.

## 2. The three states

- **Going to happen** — a pure `nextFireTime(trigger, from)` function computes each
  enabled schedule's next fire time. The UI shows per-schedule "next run" plus an
  ordered upcoming list across all schedules.
- **Happening** — runs with `status: running`, showing live elapsed time; pid tracked
  for liveness.
- **Has happened** — terminal runs (`succeeded`/`failed`/`skipped`/`interrupted`),
  newest first, each with duration, exit code, error, log tail, and a transcript link.

## 3. Scheduler lifecycle (embedded, stateless tick)

`startScheduler()` boots in `index.ts` next to the HTTP server and returns a stop
handle wired into the existing `shutdown()` (SIGINT/SIGTERM) path.

Each tick (default 30s):

1. Read `schedules.json` (corrupt/unreadable → treat as empty, surface error, never
   overwrite — see §7).
2. For each `enabled` schedule, compute `due` from `nextFireTime(trigger, lastRunAt ?? createdAt)`:
   - A schedule is **due** when `nextFire <= now <= nextFire + grace`, where
     `grace = max(2 * tickInterval, 5min)`.
   - If `now > nextFire + grace` (window missed while Argus was down), **advance to the
     next occurrence after now and do not fire** — no backfill.
   - When overdue by less than `grace` (e.g. a brief Argus restart), the schedule
     still fires once on the next tick — this is the only catch-up. Overdue by more
     than `grace` is treated as a missed window and rolls forward with no fire. This
     rule is uniform across all trigger kinds.
3. **Overlap check**: if `overlapPolicy === "skip"` and a run for this schedule is still
   `running` with a live pid, write a `skipped` run (with reason) and continue.
4. **Fire**: write a `running` run record (`startedAt`, `pid`), spawn
   `claude -p "<prompt>"` in `cwd`, and update `schedule.lastRunAt` / `lastRunId`.
5. **On process exit**: update the run — `succeeded` (exit 0) or `failed`, plus
   `endedAt`, `durationMs`, `exitCode`, `resultSummary`/`error`, and `sessionId`.

### Transcript linking

Argus pre-generates the run's session id and passes it to the headless run so the
transcript (written by Claude Code under `~/.claude/projects/<encoded-cwd>/<id>.jsonl`)
can be linked directly into Argus's existing session-detail view. The exact mechanism
— passing `--session-id <uuid>` vs. parsing the id from `--output-format json` on
completion — is verified against the installed CLI during implementation; the run
record stores whatever id is authoritative.

## 4. Crash recovery

On server startup, scan `runs/` for records still marked `running`. For each, check pid
liveness using the same approach the daemon source relies on (`process.kill(pid, 0)`).
If the process is gone (it died with the previous server), mark the run `interrupted`
with `endedAt = now`. No run is left "running forever."

## 5. API and live updates

New routes in `index.ts` — **the first write routes in Argus**, localhost-bound as the
server already is:

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/schedules` | list schedules, each with computed `nextRun` |
| POST | `/api/schedules` | create |
| PUT | `/api/schedules/:id` | update (edit / enable / disable) |
| DELETE | `/api/schedules/:id` | delete |
| POST | `/api/schedules/:id/run` | "Run now" (manual trigger) |
| GET | `/api/runs?scheduleId=&limit=` | recent runs (running + past) |
| GET | `/api/runs/:id` | run detail incl. log tail |

Validation: `name`, `prompt`, `cwd` required; `cwd` must exist; `trigger` validated per
kind. Path segments validated as Argus already does for session routes.

`watch.ts` extends its chokidar watch list to include `~/.claude/argus/`
(`schedules.json` + `runs/`). The scheduler's own run-file writes therefore flow through
the existing debounced WS ping, and the frontend refetches — giving live "running"
updates for free. The run-detail view additionally **polls the log tail every few
seconds while a run is `running`** (full WS log streaming deferred — YAGNI for v1).

## 6. Frontend

A new **Schedules pane**, sibling to the Agents/Sessions panes in `App.tsx`:

- **Schedules list** with a create/edit form: name, prompt, cwd, preset trigger
  (interval / daily@HH:MM / weekly), enable toggle. Each row: trigger summary,
  **next run**, last run status, **Run now**, edit, delete.
- **Runs view** grouped **Running / Recent**: status badge, started, duration, exit
  code, and a link that opens the run's transcript in the existing session-detail view;
  expandable log tail + error.

New hooks `web/src/useSchedules.ts` and `web/src/useRuns.ts` follow the existing
hook-per-source + 10s poll / WS-ping-refetch pattern.

## 7. Error handling and retention

- **Spawn failure** (claude not found, bad cwd) → run marked `failed` with captured
  error; the scheduler tick never throws out.
- **Corrupt `schedules.json`** → surfaced via the API, treated as empty for firing, and
  **never silently overwritten** (writes refuse if the current file cannot be parsed, to
  avoid data loss).
- **Atomic writes**: our own file writes use temp-file + rename to avoid torn reads by
  the watcher.
- **Log cap**: captured log truncated at 1 MB/run with a marker.
- **Retention**: keep the last 50 runs per schedule; prune older run files (`.json` +
  `.log`) after each run completes.

## 8. Structure (SOLID)

New units, each single-purpose:

- `server/src/sources/schedules.ts` — read/write schedule definitions; pure
  `nextFireTime` / `isDue` helpers.
- `server/src/sources/runs.ts` — read/write run records and log; retention pruning.
- `server/src/scheduler.ts` — tick loop, due/overlap decision, spawn, lifecycle.
  Depends on the two sources via their interfaces and takes an injected clock + spawn
  function, so the decision logic is unit-testable without a real clock or real
  `claude` process.
- `web/src/useSchedules.ts`, `web/src/useRuns.ts`, `web/src/views/SchedulesView.tsx`.

Plus route additions in `index.ts` and a watch-path extension in `watch.ts`.

## 9. Testing

- **Pure core (primary):** `nextFireTime(trigger, from)` for interval/daily/weekly
  including the grace window and missed-window advance; the `isDue` decision; the
  overlap decision. Clock-free — `from`/`now` are parameters.
- **Source round-trips:** schedules and runs read/write against a temp dir via
  `ARGUS_CLAUDE_HOME`; retention pruning; corrupt-file refusal.
- **Scheduler tick:** with an injected clock and a fake spawn — asserts due schedules
  fire, overlap is skipped, missed windows do not backfire, exit updates the record.
- Real `claude` spawning stays out of unit tests.

## Out of scope (v1)

- Raw cron expressions (presets + interval only).
- WS streaming of live run output (poll the log tail instead).
- Global concurrency cap across schedules (per-schedule `skip` overlap only).
- Non-Claude (arbitrary shell) scheduled runs.
- Remote/authenticated access (localhost only).
