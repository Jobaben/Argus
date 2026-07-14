# Argus — HTTP & WebSocket API

Base URL (dev): `http://localhost:7777`. The web client reaches these through the
Vite proxy at `:5757` (same paths). All responses are JSON. All reads are
best-effort: a missing/unreadable source yields an empty collection, not a 500.

## Conventions

- Timestamps are ISO-8601 strings (or epoch-ms where the underlying file uses it,
  noted per endpoint). Relative formatting is the client's job.
- List endpoints return `{ <plural>: [...] }`; detail endpoints return the entity.
- Identifiers: agents use the daemon `short`; sessions use `(project, sessionId)`
  where `project` is the encoded `projects/` dir name.

## Core (v0.1)

### `GET /api/health`

```json
{ "ok": true, "claudeHome": "/home/you/.claude", "service": "argus" }
```

### `GET /api/agents`

Background jobs joined with daemon liveness, newest/live first.

```json
{
  "agents": [
    {
      "short": "59b12afc",
      "status": "working",
      "live": true,
      "tempo": "active",
      "detail": "...",
      "result": null,
      "cwd": "...",
      "inFlight": { "tasks": 0, "queued": 0, "kinds": [] },
      "createdAt": "...",
      "updatedAt": "...",
      "pid": 49616
    }
  ]
}
```

### `GET /api/agents/:short/timeline`

```json
{ "timeline": [{ "at": "...", "state": "done", "detail": "...", "text": "..." }] }
```

### `GET /api/daemon`

```json
{ "supervisorPid": 43460, "updatedAt": 1781249595862, "workers": { "59b12afc": { "pid": 49616 } } }
```

### `WS /ws`

On connect: `{ "type": "hello" }`. On any watched change (debounced ~150ms) the
server pushes one of `{ "type": "agents:changed" }`, `{ "type":
"schedules:changed" }`, `{ "type": "pipelines:changed" }`, `{ "type":
"budget:changed" }` (limits edited), or `{ "type": "inventory:changed" }`
(installed extensions + usage stats). The client re-fetches the relevant
list — change frames carry no payload by design (the server stays the single
source of truth). The payload-carrying frames are
`{ "type": "monitors:alert", "alert": … }` (see
[Monitor alerts](#monitor-alerts)) and `{ "type": "budget:alert", "alert": … }`
(see [Budget alerts](#budget-alerts)), which describe transient events rather
than state. The upgrade is subject to the same host/origin/token checks as
the REST surface.

## Security

All `/api/*` routes and the `/ws` upgrade are gated:

- The `Host` header must be loopback (or in `ARGUS_ALLOWED_HOSTS`) — else `403`.
- Mutating verbs (POST/PUT/PATCH/DELETE) require a same-origin/allowlisted
  `Origin` — else `403`.
- When `ARGUS_TOKEN` is set, every request must send it as
  `Authorization: Bearer <token>` or `X-Argus-Token: <token>` — else `401`.

### Admin authentication (pipelines)

Editing or running a pipeline executes agents with the user's credentials, so
those routes additionally require an **admin session**. Credentials are chosen
on first run and stored in `~/.claude/argus/auth.json` as a salted **scrypt
hash** (never plaintext, file mode `0600`). Sessions are 256-bit random tokens
delivered as an `HttpOnly; SameSite=Strict` cookie (`argus_session`), held
in memory server-side (a restart signs everyone out) and expiring after 12 h.
Five consecutive bad logins lock the login route for 30 s. Non-browser clients
may send the session token as `X-Argus-Session` instead of the cookie.

| Method + path           | Effect                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /api/auth/status`  | `{ configured, authenticated, username }`                                                           |
| `POST /api/auth/setup`  | first-run only: create the admin `{ username, password≥8 }` → `201` + cookie; `409` once one exists |
| `POST /api/auth/login`  | `{ username, password }` → `200` + cookie; `401` bad credentials; `429` locked                      |
| `POST /api/auth/logout` | invalidate the current session                                                                      |

Admin-gated routes (all others are unaffected): `POST/PUT/PATCH/DELETE
/api/pipelines*`, `POST /api/pipelines/:id/start`, and `POST
/api/instances/:id/{approve,revise,abort}`. Unauthenticated calls get `401`
with `code: "auth_required"` (or `"auth_setup_required"` before first-run
setup). `POST /api/instances/:id/signal` is **not** admin-gated — it is called
by headless agent hooks and authenticates with its own per-instance token. To
reset a forgotten password, delete `~/.claude/argus/auth.json` (local file
access is the trust root) and run first-time setup again.

### `GET /api/health`

```json
{ "ok": true, "version": "0.2.0", "claudeHome": "/home/you/.claude", "service": "argus" }
```

## Read coverage (v0.2)

| Endpoint                         | Returns                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `GET /api/sessions`              | recent transcript summaries across projects                 |
| `GET /api/sessions/:project/:id` | full ordered message stream for one session                 |
| `GET /api/activity`              | recent prompts from `history.jsonl`                         |
| `GET /api/projects`              | projects with session counts + last activity                |
| `GET /api/stats`                 | usage aggregates from `stats-cache.json`                    |
| `GET /api/inventory`             | installed agents / commands / skills / plugins              |
| `GET /api/tasks`                 | task-queue directories                                      |
| `GET /api/search?q=`             | substring matches across transcripts                        |
| `GET /api/cron`                  | `{ available: false, reason, howTo }` — see ARCHITECTURE §6 |
| `GET /api/chronicle?hours=N`     | cross-source timeline (see below)                           |

For exact DTO shapes see the corresponding `server/src/sources/*.ts` reader.

### `GET /api/chronicle?hours=N`

Merges scheduler runs, background agents, and sessions into one windowed
timeline. `hours` is clamped to `[1, 336]`, default `24`. Spans are grouped
into swimlanes (one per schedule / project, one shared agents lane) and packed
into rows so spans within a row never overlap; groups with in-flight work sort
first. `endedAt: null` means still in flight — render through `windowEnd`.

```json
{
  "windowStart": "2026-07-08T20:00:00.000Z",
  "windowEnd": "2026-07-09T20:00:00.000Z",
  "groups": [
    {
      "key": "run:sched-1",
      "label": "Nightly triage",
      "kind": "run",
      "rows": [
        [
          {
            "id": "run:r1",
            "kind": "run",
            "label": "Nightly triage",
            "status": "done",
            "startedAt": "…",
            "endedAt": "…",
            "href": "#/schedules",
            "detail": "triaged 14 issues",
            "costUsd": 0.42,
            "tokens": 52000
          }
        ]
      ]
    }
  ],
  "totals": { "spans": 7, "active": 1, "failed": 1, "costUsd": 0.47, "tokens": 60000 }
}
```

## Scheduler

| Method + path                      | Effect                                                             |
| ---------------------------------- | ------------------------------------------------------------------ |
| `GET /api/schedules`               | list schedules, each with a computed `nextRun`                     |
| `POST /api/schedules`              | create a schedule (validated) → `201`                              |
| `PUT /api/schedules/:id`           | patch a schedule → `200`, `404` if unknown                         |
| `DELETE /api/schedules/:id`        | delete a schedule                                                  |
| `POST /api/schedules/:id/run`      | fire now → `202`, or `409` when `overlap=skip` and a run is live   |
| `GET /api/runs?scheduleId=&limit=` | run history (newest first)                                         |
| `GET /api/runs/:id`                | one run plus the tail of its log                                   |
| `POST /api/runs/:id/cancel`        | kill a running run → `200`, `409` if not running, `404` if unknown |

Create/patch body fields: `name`, `prompt`, `cwd` (must exist), `trigger`,
`enabled` (default `true`), `overlapPolicy` (`skip`|`allow`, default `skip`),
and `catchUp` (boolean, default `false`) — when `true`, a slot missed beyond
the firing grace (machine asleep, Argus down) fires **once** on the next
scheduler tick instead of being skipped; only the most recent missed slot is
run.

### `POST /api/launch`

Fire a single one-off `claude -p` run right now — no schedule is created or
touched. Body: `prompt` (required), `cwd` (required, must exist), `name`
(optional — defaults to the prompt's first line, ellipsized at 60 chars), and
`model` (optional model alias/id, passed to the CLI as `--model`). Returns
`202` with the created run record, `400` on validation failure.

One-off runs carry `scheduleId: "oneoff"` and share that bucket: list them
with `GET /api/runs?scheduleId=oneoff` (pruned to the same 50-run window a
schedule gets), read/cancel them through the standard run endpoints, and they
appear as a single "One-off runs" lane in `GET /api/chronicle`. A failed
launch fingerprints into Issues and posts the `run.failed` webhook like any
other run; reported cost feeds the totals and the budget ledger.

## Monitors

### `GET /api/monitors`

Healthchecks-style dead-man's-switch health per schedule, derived from
schedules + runs on every read (no new state). A monitor goes `late`, then
`down`, when an expected slot passes without a covering run — including when
the Argus server itself was not running at the time. Grace is 10% of the
trigger period, clamped to `[5 min, 60 min]`. `heartbeats` are the last 30
runs, oldest → newest; `uptimePct` is succeeded / (succeeded + failed) over
them. Statuses: `up | late | down | failing | paused | pending` (`failing` =
ran on time but the last completed run failed).

```json
{
  "monitors": [
    {
      "scheduleId": "…",
      "name": "Nightly triage",
      "enabled": true,
      "status": "down",
      "uptimePct": 96.7,
      "lastRunAt": "…",
      "lastRunStatus": "succeeded",
      "expectedAt": "…",
      "nextExpected": "…",
      "graceMs": 360000,
      "heartbeats": [{ "runId": "…", "status": "succeeded", "at": "…", "durationMs": 92000 }]
    }
  ],
  "summary": { "up": 3, "late": 0, "down": 1, "failing": 0, "paused": 1, "pending": 0 }
}
```

### Monitor alerts

The server re-derives monitor health on every scheduler tick and diffs it
against the previous tick. Each observed transition into `down` or `failing`,
and each recovery to `up` from one of those, is pushed as a `monitors:alert`
frame on `/ws` **and** POSTed to `ARGUS_WEBHOOK_URL` (when set) with event
`monitor.down` / `monitor.failing` / `monitor.recovered`, in the same payload
shape as the existing `run.failed` / `pipeline.failed` webhook events:

```json
{
  "type": "monitors:alert",
  "alert": {
    "event": "monitor.down",
    "scheduleId": "…",
    "name": "Nightly triage",
    "status": "down",
    "at": "2026-07-12T08:00:30.000Z",
    "detail": "no run covered the slot expected at 2026-07-12T02:00:00.000Z"
  }
}
```

The first check after boot is a silent baseline (no replay of already-bad
monitors), and `late` never alerts — that's the grace period doing its job.

## Budget

Spend guardrails over every costed run. Two Argus-owned files back it:
`~/.claude/argus/budget.json` (limits) and `~/.claude/argus/spend.json` (a
per-local-day ledger, written exactly once per completed run at the same
serialized point that feeds `/api/totals`, so it counts scheduled, manual,
one-off and pipeline-step runs alike and survives run-record pruning; pruned
to the newest 366 day-keys).

| Method + path     | Effect                                                       |
| ----------------- | ------------------------------------------------------------ |
| `GET /api/budget` | limits + derived status + a zero-filled last-30-day ledger   |
| `PUT /api/budget` | patch limits → `200` with the new config + status, `400` bad |

`PUT` body fields (all optional): `dailyUsd` and `monthlyUsd` (positive
number, or `null` to clear), `blockScheduled` (boolean — while any limit is
exceeded, due schedule slots are recorded as `skipped` runs
("skipped: spend budget exceeded") instead of firing; manual runs, launches
and pipeline starts are never blocked). Broadcasts `budget:changed`.

```json
{
  "config": { "dailyUsd": 10, "monthlyUsd": 150, "blockScheduled": true, "updatedAt": "…" },
  "status": {
    "state": "warning",
    "today": { "spentUsd": 8.55, "limitUsd": 10, "ratio": 0.855 },
    "month": { "spentUsd": 49.35, "limitUsd": 150, "ratio": 0.329 },
    "blockScheduled": true
  },
  "days": [{ "date": "2026-07-13", "usd": 8.55, "tokens": 726750, "runs": 12 }]
}
```

`state` is the worst window: `unset` (no limits) | `ok` | `warning` (≥ 80% of
a limit) | `exceeded` (≥ 100%). Windows follow the server's local calendar
day/month, matching schedule triggers.

### Budget alerts

The server re-derives the budget state on every scheduler tick and diffs it
against the previous tick. Each observed transition is pushed as a
`budget:alert` frame on `/ws` **and** POSTed to `ARGUS_WEBHOOK_URL` (when
set) with event `budget.warning` / `budget.exceeded` / `budget.cleared`, in
the same payload shape as the other webhook events:

```json
{
  "type": "budget:alert",
  "alert": {
    "event": "budget.exceeded",
    "state": "exceeded",
    "at": "2026-07-13T08:00:30.000Z",
    "detail": "today $12.40 of $10.00 — scheduled runs are paused"
  }
}
```

The first check after boot is a silent baseline (no replay of a
known-exceeded budget), and `exceeded → warning` stays quiet — you already
heard about the breach; `budget.cleared` fires once spend is back under every
limit.

## Issues

Sentry-style grouping of failed runs (status `failed`/`interrupted`, or
outcome `failed`/`blocked`) by a fingerprint of the normalized error text —
digits, hex ids, UUIDs and timestamps collapse so "timeout after 42s" and
"timeout after 7s" are one issue. Issues derive from runs on every read; the
only persisted state is triage, in `~/.claude/argus/issues.json`.

| Method + path                           | Effect                                                  |
| --------------------------------------- | ------------------------------------------------------- |
| `GET /api/issues`                       | `{ issues, summary: {open, resolved, ignored} }`        |
| `GET /api/issues/:fingerprint`          | one issue plus occurrences (newest first, capped 50)    |
| `POST /api/issues/:fingerprint/resolve` | mark resolved — auto-reopens if a newer failure arrives |
| `POST /api/issues/:fingerprint/ignore`  | mute permanently (until reopened)                       |
| `POST /api/issues/:fingerprint/reopen`  | drop the triage record → back to `open`                 |

Triage mutations broadcast `issues:changed` on `/ws`. Like schedule CRUD,
they sit behind the transport-level guards but need no admin session — triage
cannot execute anything.

## Briefing

The "while you were away" digest: state-now attention items (down/failing
monitors, gated pipeline phases awaiting approval, open issues) plus a
windowed summary of runs, spend, failures, first-seen issues and finished
pipelines since the last acknowledgement. A pure derivation over runs,
schedules, issue triage and instances; the only persisted state is the
acknowledgement timestamp, in `~/.claude/argus/briefing.json`.

| Method + path            | Effect                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| `GET /api/briefing`      | `{ since, generatedAt, attention, attentionCount, window }`             |
| `POST /api/briefing/ack` | stamp now as caught-up → `{ ok, ackAt }`, broadcasts `briefing:changed` |

The window is `max(ackAt, now − 7 d)`, defaulting to the last 24 h when no
acknowledgement exists. `window` carries `totalRuns`, `byStatus`, `costUsd`,
`tokens`, and capped newest-first lists `failures`, `newIssues` (first seen in
window) and `finishedPipelines`. Like issue triage, `ack` needs no admin
session — it cannot execute anything.

## Pipelines (v0.3)

| Method + path                      | Effect                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `GET /api/pipelines`               | list pipeline definitions                                                         |
| `POST /api/pipelines`              | create a definition (validated) — **admin**                                       |
| `PUT /api/pipelines/:id`           | replace a definition — **admin**                                                  |
| `DELETE /api/pipelines/:id`        | delete a definition — **admin**                                                   |
| `POST /api/pipelines/:id/start`    | start an instance manually → `202`, or `409` on overlap — **admin**               |
| `GET /api/pipelines/:id/instances` | instances for a pipeline (newest first)                                           |
| `GET /api/overview`                | command-center rows: `{ definition, latest, cost }` per pipeline, attention-first |
| `GET /api/instances/:id`           | full pipeline instance                                                            |
| `POST /api/instances/:id/signal`   | ingest a signal `{ phaseId, runId, type, token, payload? }`; `403` on bad token   |
| `POST /api/instances/:id/approve`  | advance past a gate (optional `{ answers }`) — **admin**                          |
| `POST /api/instances/:id/revise`   | re-run the current phase (optional `{ note }`) — **admin**                        |
| `POST /api/instances/:id/abort`    | abort the instance — **admin**                                                    |
| `GET /api/setup`                   | prerequisite status `{ ok, prereqs[] }`                                           |
| `POST /api/setup/apply`            | install fixable prerequisites, then re-check → `{ ok, prereqs[] }`                |

WS frame `{ "type": "pipelines:changed" }` is pushed on any pipeline mutation.

In `GET /api/overview`, each entry's `latest.phases[].steps[]` carries
`costUsd`/`tokens` joined from the step's run record, and `cost` is the
instance's total spend `{ usd, tokens }` across **all** of its runs (including
superseded revise attempts). A metric is `null` until at least one run reports
it; `cost` is `null` when the pipeline has never run.

### Emitting signals from a run

The engine spawns each phase's `claude -p` run with `ARGUS_SIGNAL_URL`,
`ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`, `ARGUS_RUN_ID`, and `ARGUS_SIGNAL_TOKEN`.
`hooks/argus-signal.mjs` reads these and POSTs a signal. Register it as a Stop
hook (no arg) to report the run's outcome, and (optionally) as a `PreToolUse`
hook on `AskUserQuestion` invoked as `argus-signal.mjs needs-input` to pause at
a gate.

The Stop hook does **not** assume success. When invoked with no arg it derives
the signal type from the agent's final message: a line matching
`ARGUS_OUTCOME: failed` (or `blocked`) emits `failed`; anything else emits
`completed`. A run that stops cleanly but concluded it failed can therefore fail
its phase instead of being rubber-stamped.

The engine supplies this reporting contract automatically: every step run is
spawned with `claude --append-system-prompt`, injecting a constant instruction
to end the final message with `ARGUS_OUTCOME: <succeeded|failed|blocked>`.
Pipeline authors therefore do **not** write the `ARGUS_OUTCOME` mechanic into
their prompts — they only state each step's acceptance criteria in prose, and
the agent judges success against them. An explicit CLI arg (`needs-input` /
`failed`) always overrides the message-derived type.

> **Important:** a phase advances ONLY on an explicit signal. If a run exits
> without its hook POSTing anything, the reconciler heals it as `failed`
> (process exit is not a success trigger). Register `argus-signal.mjs` as a Stop
> hook so every finished run emits `completed` or `failed`.

Argus surfaces missing prerequisites (including this hook) via `GET /api/setup`;
the web UI's setup banner installs the fixable ones with `POST /api/setup/apply`.

| Env var                     | Meaning                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `ARGUS_STEP_NAME`           | label of the running step, injected into the run's environment |
| `ARGUS_MAX_CONCURRENT_RUNS` | cap on concurrent `claude -p` processes (default 4)            |

## Configuration

| Env var             | Default     | Effect                                                                                            |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `ARGUS_PORT`        | `7777`      | server port (proxy target)                                                                        |
| `ARGUS_CLAUDE_HOME` | `~/.claude` | directory to read/watch                                                                           |
| `CLAUDE_CONFIG_DIR` | —           | fallback override if `ARGUS_CLAUDE_HOME` unset                                                    |
| `ARGUS_WEBHOOK_URL` | —           | POST target for `run.failed`, `pipeline.failed`, and `monitor.*` events (Slack/mail bridge, etc.) |
