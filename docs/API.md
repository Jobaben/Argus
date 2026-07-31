# Argus — HTTP & WebSocket API

Base URL (dev): `http://localhost:7777`. The web client reaches these through the
Vite proxy at `:5757` (same paths). All responses are JSON. All reads are
best-effort: a missing/unreadable source yields an empty collection, not a 500.

## Conventions

- Timestamps are ISO-8601 strings (or epoch-ms where the underlying file uses it,
  noted per endpoint). Relative formatting is the client's job.
- List endpoints return `{ <plural>: [...] }`; detail endpoints return the entity.
- Identifiers: agents use the daemon `short`; sessions use `(project, sessionId)`
  where `project` is the encoded `projects/` dir name. Codex has no per-project
  directory, but its rollouts record the directory the run happened in, so its
  sessions are filed under the same encoded form — a Codex session and a Claude
  session from one repo group together. A rollout with no recorded directory
  falls back to the reserved segment `_codex_` (an underscore can never appear
  in an encoded project, so the two namespaces cannot collide). Detail reads
  resolve a Codex rollout **by session id**, so either segment works.
- **Every shape here is declared once**, in the `@argus/contracts` workspace, and
  imported by both the server that produces it and the web client that consumes
  it. A field added or removed on one side fails `npm run typecheck` on the
  other. Treat this document as prose _about_ those declarations, not as a second
  source of truth.

### Conditional reads (ETag)

Every `200` JSON response to a `GET` carries a strong `ETag` and
`Cache-Control: no-cache` (that is "you may store this, but revalidate before
reuse" — never serve a monitoring payload from cache unasked). Send the tag back
as `If-None-Match` and an unchanged resource answers `304` with no body:

```
$ curl -sD - -o /dev/null localhost:7777/api/agents | grep -i etag
etag: "4jMRIzvVs_jHjFJll3LWvvqNwkP"

$ curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
    -H 'If-None-Match: "4jMRIzvVs_jHjFJll3LWvvqNwkP"' localhost:7777/api/agents
304 0
```

This matters because Argus is push-driven: one `pipelines:changed` broadcast
wakes several views at once, and most of those re-fetches find nothing changed.
The web client keeps the tag per resource and skips its state update entirely on
a `304`, so a no-op broadcast costs a ~100-byte round trip and zero re-renders.

### Request ids

Every response carries `x-request-id`. An inbound `x-request-id` is honoured (so
a proxy's trace id wins), capped at 64 characters. Server-side log lines for the
request — including anything the error boundary writes — carry the same id, so a
UI report can be tied to the exact line. Successful reads log at `debug` (off by
default); `4xx` logs at `warn`, `5xx` at `error`. `ARGUS_LOG_LEVEL` and
`ARGUS_LOG_FORMAT=json` control the output.

## Core (v0.1)

### `GET /api/health`

```json
{
  "ok": true,
  "version": "0.4.0",
  "claudeHome": "/home/you/.claude",
  "codexHome": "/home/you/.codex",
  "service": "argus"
}
```

### `GET /api/runtimes`

Which agent CLIs this server can drive, and what each can and cannot do. Read-
only and unprivileged: the runtime pickers need it before a session exists, and
it discloses nothing beyond "is this CLI installed", which `GET /api/setup`
already reports. The probe result is cached for ~30s, so installing a CLI and
reloading picks it up.

```json
{
  "default": "claude",
  "runtimes": [
    {
      "id": "claude",
      "label": "Claude Code",
      "bin": "claude",
      "home": "/home/you/.claude",
      "available": true,
      "isDefault": true,
      "models": ["opus", "sonnet", "haiku"],
      "capabilities": {
        "presetSessionId": true,
        "appendSystemPrompt": true,
        "reportsCost": true,
        "reportsTokens": true,
        "signalHook": true,
        "liveActivity": true,
        "transcripts": true
      }
    },
    {
      "id": "codex",
      "label": "Codex",
      "bin": "codex",
      "home": "/home/you/.codex",
      "available": false,
      "detail": "`codex` was not found on PATH",
      "isDefault": false,
      "models": [],
      "capabilities": {
        "presetSessionId": false,
        "appendSystemPrompt": false,
        "reportsCost": false,
        "reportsTokens": true,
        "signalHook": true,
        "liveActivity": true,
        "transcripts": true
      }
    }
  ]
}
```

`capabilities` exists so the UI can explain a gap instead of hiding it. The two
that are visible in the data: `presetSessionId: false` means a run's
`sessionId` is null until the CLI reports its own thread id (so the transcript
link appears once the run starts), and `reportsCost: false` means `costUsd` on
that runtime's runs is always null — tokens are reported, dollars are not.

### Naming a runtime

`runtime` is `"claude" | "codex"` and may be set on a schedule, a launch, a
pipeline, a phase, or a single step. Resolution is **narrowest wins**: step,
then phase, then pipeline (or the schedule / launch body), then the server's
`ARGUS_AGENT` default, then `"claude"`. The resolved value is written onto the
run record, so a run started under one default stays explicable after the
default changes.

Omitting the key inherits. On the `PATCH`/`PUT` bodies that support it,
`"runtime": null` **clears** an override (back to inheriting) — omitting the key
leaves the stored value alone. An unrecognized value is a `400`.

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
"issues:changed" }`, `{ "type": "briefing:changed" }`, `{ "type":
"totals:changed" }`, `{ "type": "budget:changed" }` (limits edited),
`{ "type": "sessions:changed" }`, or `{ "type": "inventory:changed" }`
(installed extensions + usage stats). The client re-fetches the relevant
list — change frames carry no payload by design (the server stays the single
source of truth). The payload-carrying frames are
`{ "type": "monitors:alert", "alert": … }` (see
[Monitor alerts](#monitor-alerts)), `{ "type": "budget:alert", "alert": … }`
(see [Budget alerts](#budget-alerts)) and
`{ "type": "run:activity", "runId": …, "events": [...] }` (a tail delta from the
run tailer) — all three describe transient events rather than state, so they
cannot be re-derived from a `GET`. The frame union is declared in
`@argus/contracts` (`LiveFrame`), so a renamed event breaks the build rather than
silently failing to wake a view.

The client validates the payload of the frames that carry one and drops a
malformed batch, but forwards a frame _type_ it does not recognise — so a newer
server can add frames without a client release.

The upgrade is subject to the same host/origin/token checks as the REST surface.
The client reconnects with exponential backoff (1s doubling to a 30s ceiling,
jittered) and immediately when the tab becomes visible or the browser reports it
is back online.

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
| `GET /api/search?q=`             | `{ results, limit, truncated }` — see below                 |
| `GET /api/cron`                  | `{ available: false, reason, howTo }` — see ARCHITECTURE §6 |
| `GET /api/chronicle?hours=N`     | cross-source timeline (see below)                           |

For exact DTO shapes see the corresponding `server/src/sources/*.ts` reader.

### `GET /api/search?q=`

Case-insensitive substring search over transcript message text, newest files
first, stopping as soon as `limit` matches are found — so a common word never
reads every transcript on disk.

```json
{
  "results": [
    { "project": "…", "projectLabel": "…", "sessionId": "…", "snippet": "…", "type": "assistant" }
  ],
  "limit": 100,
  "truncated": true
}
```

`truncated` is the point: the scan exits at the cap, so `results.length === limit`
is a ceiling rather than a count, and a client that renders it as a count is
lying. Argus's own UI says "first 100 matches — narrow the query" when it is set.

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
| `GET /api/runs/:id/recording`      | the run as a Flight Recorder timeline (see below)                  |
| `POST /api/runs/:id/cancel`        | kill a running run → `200`, `409` if not running, `404` if unknown |

Create/patch body fields: `name`, `prompt`, `cwd` (must exist), `trigger`,
`enabled` (default `true`), `overlapPolicy` (`skip`|`allow`, default `skip`),
`runtime` (see [Naming a runtime](#naming-a-runtime)),
and `catchUp` (boolean, default `false`) — when `true`, a slot missed beyond
the firing grace (machine asleep, Argus down) fires **once** on the next
scheduler tick instead of being skipped; only the most recent missed slot is
run.

### `POST /api/launch`

Fire a single one-off headless agent run right now — no schedule is created or
touched. Body: `prompt` (required), `cwd` (required, must exist), `name`
(optional — defaults to the prompt's first line, ellipsized at 60 chars),
`model` (optional model alias/id, passed to the CLI as `--model`), and
`runtime` (optional, see [Naming a runtime](#naming-a-runtime)). Returns
`202` with the created run record, `400` on validation failure.

One-off runs carry `scheduleId: "oneoff"` and share that bucket: list them
with `GET /api/runs?scheduleId=oneoff` (pruned to the same 50-run window a
schedule gets), read/cancel them through the standard run endpoints, and they
appear as a single "One-off runs" lane in `GET /api/chronicle`. A failed
launch fingerprints into Issues and posts the `run.failed` webhook like any
other run; reported cost feeds the totals and the budget ledger.

### `GET /api/runs/:id/recording`

The Flight Recorder timeline for one run: `404` if the run is unknown, else a
`Recording`.

Derived on every read from the run record plus its transcript
(`projects/<project>/<sessionId>.jsonl`). Nothing is persisted, so a recording
can never drift from the transcript it came from.

```jsonc
{
  "runId": "…",
  "scheduleName": "Nightly triage",
  "status": "failed",
  "outcome": null,
  "sessionId": "…",
  "project": "-repo",
  "startedAt": "2026-07-01T10:00:00.000Z",
  "endedAt": "2026-07-01T10:01:30.000Z",
  "durationMs": 90000,
  "events": [
    {
      "id": "e12",
      "atMs": 60000, // offset from the origin, monotonic
      "at": "2026-07-01T10:01:00.000Z",
      "lane": "tool", // agent | tool | file | spend
      "kind": "tool", // start|prompt|thinking|text|tool|file|usage|error|end
      "label": "Bash: npm run build",
      "detail": "…", // command / message / error body, clipped
      "durationMs": 4200, // tool_use → tool_result latency
      "tool": "Bash",
      "errored": true,
    },
  ],
  "lanes": [{ "lane": "tool", "label": "Tools", "count": 2 }],
  "failureIndex": 12, // index into `events`, or null
  "totals": { "tools": 2, "files": 0, "errors": 1, "tokens": 1200, "costUsd": 0.42 },
  "costEstimated": true,
  "truncated": false,
  "unavailable": null, // "no-session" | "no-transcript" | "empty-transcript" | "not-started"
}
```

Semantics worth knowing before you build on it:

- **One clock.** `atMs` is an offset from the run's `startedAt` (falling back
  to the first transcript timestamp), clamped non-decreasing. Transcripts from
  resumed sessions can carry out-of-order stamps; the recorder never lets the
  axis go backwards.
- **Spans, not lines.** A `tool_use` block and the `tool_result` answering it
  are joined by `tool_use_id`; the call carries the resulting `durationMs` and
  `errored` flag. An orphaned errored result still emits its own event.
- **Cost is apportioned.** The CLI reports one `total_cost_usd` per run, so
  per-event `costUsd` is that total split by token share and the response sets
  `costEstimated: true`. With no reported cost, no per-event dollars are
  invented.
- **Bounded.** At most 2,000 events; past that the _earliest_ are dropped and
  `truncated` is `true`. Offsets stay absolute, so surviving events keep their
  real position on the axis.
- **File events** carry `path`, `added` and `removed` line counts derived from
  the tool input (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`). A `Write`
  reports `removed: 0` because the transcript never says what it replaced.

`failureIndex` prefers the last _errored tool call_ over the terminal marker —
it is meant to answer "where did it go wrong", not "did it".

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

## Ledger

Cost attribution, the month-end forecast, the what-if simulator and the
graduated budget policy. Entirely **derived** — the Ledger writes nothing of
its own; it reads `argus/runs/`, `argus/spend.json`, `argus/budget.json` and
`argus/verdicts.json`.

One rule shapes every number below: **there is no price list.** Attribution
sums observed costs, the forecast extrapolates observed days, and the what-if
compares what two models have actually cost on this machine. The cost of that
discipline is that some questions have no answer, and the response types say so
(`unavailable`, `confidence: null`) rather than returning a plausible zero.

### `GET /api/ledger`

ETag'd. Recomputed on read from the last **30 days** of runs.

```json
{
  "generatedAt": "2026-07-20T12:00:00.000Z",
  "windowDays": 30,
  "bySchedule": {
    "dimension": "schedule",
    "slices": [
      {
        "key": "nightly-triage",
        "label": "Nightly triage",
        "usd": 6.0,
        "tokens": 90000,
        "runs": 30,
        "share": 0.75,
        "perRunUsd": 0.2
      }
    ],
    "totalUsd": 8.0,
    "totalTokens": 110000,
    "runs": 40,
    "unattributedRuns": 3
  },
  "byPipeline": { "dimension": "pipeline", "…": "…" },
  "byProject": { "dimension": "project", "…": "…" },
  "byModel": { "dimension": "model", "…": "…" },
  "forecast": {
    "samples": 19,
    "dailyUsd": 5.0,
    "monthToDateUsd": 95.0,
    "monthEndUsd": 150.0,
    "lowUsd": 140.0,
    "highUsd": 175.0,
    "confidence": 0.82,
    "overLimit": false,
    "note": "On this pace the month ends near $150.00, inside the $200.00 limit."
  },
  "enforcement": {
    "action": null,
    "atRatio": null,
    "model": null,
    "window": null,
    "detail": "spend is inside the configured limits"
  }
}
```

**Attribution.** Five dimensions, each computed over the same window so their
totals agree. `agent` is the finest grain that still carries real cost data —
the worker that ran, which for a pipeline is one _phase_. It is not a duplicate
of `pipeline`: that rolls a pipeline into one row, and this breaks it apart, so
"the release train costs $40" becomes "the review phase is $34 of it".

| Dimension  | Slice key                               | Runs it cannot place                  |
| ---------- | --------------------------------------- | ------------------------------------- |
| `schedule` | schedule id (`oneoff` → "One-off runs") | pipeline step runs                    |
| `pipeline` | pipeline id                             | schedule and one-off runs             |
| `project`  | encoded project dir                     | runs with no project                  |
| `model`    | model name, or `(cli default)`          | none — an unpinned model is an answer |

Only runs with a positive `costUsd` are counted. Slices are sorted by spend,
capped at **12**, and the tail folds into a single `__other__` row — a total
that does not add up is worse than a long tail you cannot itemise. `runs` is
every costed run in the window; `unattributedRuns` is how many of those the
dimension could not place, so the totals can be checked.

**Forecast.** `dailyUsd` is the **median** of the ledger's past full days —
median so one runaway backfill day does not set the trend, and past-only because
a partial today would drag the projection down all morning and let it recover on
a daily cycle. `lowUsd`/`highUsd` project the 20th and 80th percentile day
forward. `confidence` is derived from that spread: a statement about how well
this history extrapolates, not about how right the number is. Under **3** full
days every projected field is `null` and `note` explains why; between 3 and 10
the note adds _treat as indicative_.

### `POST /api/ledger/what-if`

```json
{ "dimension": "schedule", "key": "nightly-triage", "toModel": "haiku" }
```

`dimension` must be one of the five; `key` must be non-empty; `toModel` must
match `/^[A-Za-z0-9._ ()-]{1,80}$/`. Anything else is a `400` with an `error`.
A well-formed request that cannot be answered is a **`200` with `ok: false`** —
"I don't know" is a result, not a failure:

```json
{
  "ok": false,
  "unavailable": "no runs on \"haiku\" to compare against — Argus estimates from what a model has actually cost here, never from a price list",
  "label": "Nightly triage",
  "fromModel": "opus",
  "toModel": "haiku",
  "affectedRuns": 30,
  "currentPerRunUsd": null,
  "projectedPerRunUsd": null,
  "monthlySavingUsd": null,
  "currentMonthlyUsd": null,
  "projectedMonthlyUsd": null,
  "verdictDelta": null,
  "verdictSamples": 0,
  "summary": ""
}
```

Three cases return `ok: false`: the slice has no costed runs, it already runs on
the target model, or the target model has never run on this machine.

An answerable request returns medians on both sides (one expensive outlier
should not decide whether a migration looks worthwhile), the slice's observed
run rate extrapolated to 30 days, and a `summary` like
`haiku on Nightly triage saves $41.00/mo at -0.2 Verdict`. `verdictDelta` is the
median score difference **only when both models have Verdict scores**; otherwise
it is `null` with `verdictSamples: 0`, meaning _unmeasured_ — not "no
difference".

### The budget ladder

`BudgetConfig` gains an optional `ladder`, set through `PUT /api/budget`:

```json
{
  "ladder": [
    { "atRatio": 0.8, "action": "warn" },
    { "atRatio": 0.9, "action": "downgrade", "model": "haiku" },
    { "atRatio": 1.0, "action": "defer" },
    { "atRatio": 1.25, "action": "stop" }
  ]
}
```

Validated on write: at most 6 steps, `atRatio` in `(0, 2]`, `action` one of
`warn | downgrade | defer | stop`, and `downgrade` requires a `model`. Steps are
**stored sorted by threshold**, so the ladder reads top-to-bottom as it engages
and an author cannot express "stop at 0.9, warn at 1.0" and be surprised. A
malformed ladder is a `400`; a _corrupt on-disk_ ladder degrades to no ladder
rather than refusing to serve the budget at all.

The step in force is resolved on every scheduler tick:

- The **highest** matching step wins, not the first. With warn@0.8 /
  downgrade@0.9 / stop@1.0, a run at 1.05 must be stopped; a first-match reading
  would only have warned it.
- **Both windows are evaluated** and the more severe verdict applies — a day
  that is fine inside a month that is not should still be governed by the month.

Effects apply to `trigger === "scheduled"` runs only; a manual run is a decision
already made. `defer` writes a `skipped` run instead of firing; `downgrade`
swaps the model; `warn` and `stop` do what they say. The existing
`blockScheduled` hard stop still wins over everything.

**Every affected run records it**: `Run.budgetAction`
(`warn | downgrade | defer | stop`) and, for a downgrade,
`Run.modelDowngradedFrom`. So "why did Tuesday's run use Haiku?" is answerable
from the run record itself, rather than by correlating timestamps against a
policy that has since been edited.

## Constellation

Peer-to-peer federation with no coordinator. Each machine publishes a small
summary of itself and pulls its peers', over a channel that is encrypted and
signed end-to-end with a secret the two of them share.

With no peers configured none of this runs: no outbound requests, no summary
served, nothing published. Federation is opt-in per peer.

State lives in `~/.claude/argus/peers.json`, mode `0600` — it holds long-lived
shared secrets, and no route ever returns one.

### `GET /api/fleet`

Open, like every other read. Self first, then peers by label.

```json
{
  "machines": [
    {
      "isSelf": true,
      "peer": { "id": "…", "label": "Laptop", "url": "", "status": "paired", "…": "…" },
      "summary": {
        "machineId": "…",
        "label": "Laptop",
        "version": "0.4.0",
        "generatedAt": "2026-07-20T12:00:00.000Z",
        "schedules": 3,
        "monitorsDown": 0,
        "monitorsFailing": 1,
        "openIssues": 2,
        "liveInstances": 1,
        "gatedInstances": 0,
        "runsToday": 12,
        "failuresToday": 1,
        "spendTodayUsd": 1.25,
        "spendMonthUsd": 30.4,
        "worstIncident": "critical: Nightly triage is down",
        "facets": {
          "pipelines": [
            {
              "id": "i1",
              "name": "Release train",
              "status": "awaiting-approval",
              "phase": "review"
            }
          ],
          "issues": [{ "fingerprint": "…", "title": "ECONNREFUSED", "count": 9, "lastSeen": "…" }],
          "recentRuns": [
            {
              "id": "r1",
              "label": "Nightly triage",
              "status": "failed",
              "at": "…",
              "durationMs": 60000
            }
          ],
          "budget": { "state": "ok", "dailyLimitUsd": 10, "monthlyLimitUsd": null }
        }
      }
    }
  ],
  "totals": { "machines": 3, "reporting": 2, "openIssues": 5, "…": "…" },
  "soloMode": false,
  "generatedAt": "2026-07-20T12:00:00.000Z"
}
```

`peer.status` is `paired` | `pending` | `stale` | `unauthorized` | `unreachable`.
`unauthorized` and `unreachable` are distinct because a mismatched secret and a
dead machine want different fixes.

**`totals.machines` and `totals.reporting` are both returned, and the difference
is the point.** A total summed over three of five machines is not a fleet total,
and a client that cannot say so will present it as one. A peer that has gone
quiet keeps its last summary, marked stale, rather than silently shrinking the
denominator.

`soloMode` is true when no peers are configured.

**`facets`** is the bounded detail the fleet-wide views read — at most **12**
pipelines, **12** issues (loudest first), **40** recent runs, plus the budget's
limits, with every string clamped. The caps are re-applied to what a peer sends,
not only to what this machine sends: a peer is a machine you trust to be yours,
not one you trust to be correct, and a bug or an older build on the other side
must not be able to make this one render four thousand rows. A summary with no
`facets` at all parses to empty ones, so an older peer degrades to "nothing to
show" rather than throwing.

Three fields never travel: **prompts, working directories and session ids**.

### `GET /api/federation/summary`

The peer-facing endpoint. **Not admin-gated, and not open**: the caller must
send `x-argus-pairing`, a public identifier derived from the shared secret
(`HMAC("argus-pairing-id", secret)`, first 32 hex characters). If this machine
holds no pairing by that name the answer is a `401` that reveals nothing — not
the machine's id, not its label, not whether any pairing exists.

**It is exempt from `ARGUS_TOKEN`.** Federation is only reachable on an exposed
bind, and an exposed bind requires the token, so without the exemption pairing
would only work by giving every peer the bearer that unlocks the whole control
plane — one shared secret granting everything, instead of a per-pair secret
granting one read. The exemption is safe because the route's own authentication
is stronger than the one it replaces, and the route is read-only.

The response is an **envelope**, not a summary:

```json
{
  "v": 1,
  "from": "<machineId>",
  "at": "2026-07-20T12:00:00.000Z",
  "nonce": "base64",
  "iv": "base64",
  "ct": "base64",
  "tag": "base64",
  "sig": "base64"
}
```

- **HKDF-SHA256** derives two independent keys from the pairing secret, one for
  encryption and one for the MAC. One key for both is the classic way to make
  two sound primitives unsound together.
- **AES-256-GCM** encrypts (`iv`, `ct`, `tag`).
- **HMAC-SHA256 over `v|from|at|nonce|iv|ct|tag`** is `sig`. GCM already
  authenticates the ciphertext; this binds the _header_, so `from` and `at`
  cannot be rewritten in flight.
- **`at` and `nonce`** make replay detectable. Envelopes outside ±5 minutes are
  rejected in **both** directions — a far-future timestamp is as much a replay
  tell as a stale one — and a nonce seen inside the window is refused.

Verification order is signature, then freshness, then decrypt: nothing derived
from the envelope is used before it verifies.

### Managing peers

All admin-gated.

| Method + path           | Body                     | Effect                                     |
| ----------------------- | ------------------------ | ------------------------------------------ |
| `POST /api/peers/pair`  | —                        | mint a pairing secret, shown once          |
| `POST /api/peers`       | `{ label, url, secret }` | pair a machine → `201`, `400` on bad input |
| `DELETE /api/peers/:id` | —                        | unpair → `200`, `404` if unknown           |
| `PUT /api/fleet/label`  | `{ label }`              | rename this machine as peers see it        |

`url` must be an absolute `http`/`https` URL — `file:` and friends are refused
by name, because a peer URL is somewhere this server makes outbound requests on
a timer. It is normalized without a trailing slash, so two spellings of one
machine are not two peers. `secret` must be the 64-character pairing code.
Adding a peer broadcasts `fleet:changed`.

At most **24 peers**. A fleet larger than that wants a different product.

### Refuse-to-boot

`assertPeersAreSafe` runs alongside `assertBindIsSafe`: Argus refuses to start
with a peer configured over a **non-loopback URL and no pairing secret**, which
would be an unauthenticated summary exchange in both directions. Loopback peers
without a secret are allowed — that is a local experiment, not a trust
relationship.

### Polling

Peers are pulled once per scheduler tick — pull, not push, so a machine that is
asleep or behind NAT is a peer that did not answer rather than a delivery to
retry. One request per peer per tick, a **4-second timeout**, a **64 KB**
response cap, and no retries. A summary older than **5 minutes** reads as stale.

**Practical note:** a peer must be able to reach this machine, which means
`ARGUS_HOST` beyond loopback, `ARGUS_TOKEN` set, and the peer-facing hostname in
`ARGUS_ALLOWED_HOSTS`. Running the fleet over a VPN or tailnet is the intended
shape.

## Omnibar

Compiling an English sentence into an explicit, reviewable list of mutations,
and applying it only on a second, separate request.

Both routes are **admin-gated**: planning spawns an agent, executing mutates.
Planning goes through the same bounded runner as Autopsy, Verdict and Sentinel's
diagnostic — one pass at a time, 90-second timeout, output capped, metered into
the spend ledger, refused while the budget hard stop is in force.

### `POST /api/omnibar/plan`

```json
{ "intent": "pause everything touching Spectacle" }
```

`intent` is required and capped at 400 characters; anything else is a `400`.
Returns either a plan or an answer:

```json
{
  "mode": "plan",
  "answer": null,
  "plan": {
    "id": "0f1a…",
    "status": "ready",
    "intent": "pause everything touching Spectacle",
    "mutations": [
      {
        "kind": "schedule.disable",
        "targetId": "s_spectacle_nightly",
        "targetLabel": "Spectacle nightly",
        "value": null,
        "before": "enabled",
        "after": "disabled"
      }
    ],
    "warnings": ["dropped \"schedule.disable\": no schedule with id s_ghost"],
    "summary": "Pause the two Spectacle schedules",
    "createdAt": "2026-07-20T12:00:00.000Z",
    "expiresAt": "2026-07-20T12:05:00.000Z"
  }
}
```

`status` is `ready` | `empty` | `unavailable` | `refused`. An `unavailable` plan
still arrives as a plan with an explanatory `summary` (`the spend hard stop is
in force…`, `another analysis pass is running…`) so the client has exactly one
shape to render.

**The closed vocabulary.** `kind` is one of:

| Kind                | `value`                     |
| ------------------- | --------------------------- |
| `schedule.disable`  | `null`                      |
| `schedule.enable`   | `null`                      |
| `issue.resolve`     | `null`                      |
| `issue.ignore`      | `null`                      |
| `instance.abort`    | `null`                      |
| `budget.setDaily`   | dollars, or `null` to clear |
| `budget.setMonthly` | dollars, or `null` to clear |

Anything else the planner emits is dropped into `warnings`. So is any id that is
not in the catalogue the planner was given, and any change that would be a
no-op. **`targetLabel`, `before` and `after` are computed by the server from
live state** — the model supplies only a verb, an id and a value, which are the
three things that can be checked. A plan therefore cannot describe itself
misleadingly.

Duplicate mutations are collapsed: the same change proposed twice is one change,
because a preview that says "2 changes" for one change makes the confirm step
worthless.

An answer looks like:

```json
{
  "mode": "answer",
  "plan": null,
  "answer": {
    "text": "Nightly triage last ran an hour ago and succeeded.",
    "links": [{ "label": "Open", "href": "#/schedules" }]
  }
}
```

Links are filtered to in-app hash routes. A planner emitting `https://…` is
either confused or being used to put a link in front of the user; neither is
supported.

### `POST /api/omnibar/execute`

```json
{ "planId": "0f1a…" }
```

Takes the plan **id**, never the intent — the sentence is never re-interpreted,
so what runs is the list the user approved. Plans are held in memory, are
**single-use**, and expire after five minutes. They are not persisted: a
confirmation surviving a restart would land against state nobody has looked at
since.

```json
{
  "status": "applied",
  "applied": [{ "kind": "schedule.disable", "…": "…" }],
  "reversed": [],
  "error": null,
  "summary": "2 changes applied."
}
```

`status` is one of:

| Status        | Meaning                                                                               |
| ------------- | ------------------------------------------------------------------------------------- |
| `applied`     | Every mutation is in effect.                                                          |
| `stale`       | Nothing attempted; live state no longer matches the preview.                          |
| `expired`     | Nothing attempted; unknown, expired, or already-run plan.                             |
| `rolled-back` | One mutation failed; the earlier ones were reversed. Nothing in effect.               |
| `partial`     | A mutation failed **and** a reversal failed. `applied` lists what is still in effect. |

An unknown or expired `planId` is a **`200` with `status: "expired"`**, not a
`404` — it is an ordinary outcome of a five-minute offer, and the client renders
it in the same place as every other result.

**Execution is a compensating transaction, not an atomic one**, and the API says
so rather than implying otherwise. Argus's state lives in several independent
files. Every mutation is re-validated against live state first (any mismatch
stops the whole plan before anything is attempted), applied in order, and
reversed in reverse order if one fails. `instance.abort` has no inverse — a
killed process does not come back — so a plan containing one can only be unwound
up to that point, which is what `partial` reports.

## The Vault

An embedded analytical store that keeps every run, alert, cost tick and score
past what the JSON files retain. Backed by SQLite at
`~/.claude/argus/vault.sqlite`, using `node:sqlite` — built into Node 22, so
there is nothing to install and nothing to configure.

**It is a rebuildable cache, never a source of truth.** Every ingest is an
upsert keyed by the record's own identity, the JSON files stay authoritative for
anything they still hold, and every route below degrades to an `available:
false` answer rather than an error when the Vault cannot be opened. Set
`ARGUS_VAULT=off` to disable it; every long view falls back to its JSON-only
behaviour.

Ingest runs on the scheduler tick, last in the chain, reading what the other
watchers have just written.

**Monitor and budget transitions are pushed, not polled.** Both are derived on
each tick, diffed against the previous tick in memory, sent to the bell and the
webhook, and then forgotten — there is no file to poll, so the alert handler
hands them to the Vault as they happen. That makes the Vault the only place
that can answer "how often did this monitor flap last quarter". Each is
content-hashed, so a replayed tick cannot report one breach as two, and a
failure to archive is logged and swallowed: an alert that cannot be stored must
not break the alert.

### `GET /api/vault`

ETag'd. What the Vault holds, and whether it is healthy.

```json
{
  "available": true,
  "reason": null,
  "detail": "the Vault is keeping history past what the JSON files retain",
  "rows": { "runs": 1240, "events": 88, "spendDays": 200, "scores": 310 },
  "sizeBytes": 2400000,
  "oldestRunAt": "2025-08-01T00:00:00.000Z",
  "newestRunAt": "2026-07-20T00:00:00.000Z",
  "lastIngestAt": "2026-07-20T12:00:00.000Z",
  "beyondRetention": 940
}
```

`reason` is `no-sqlite` | `open-failed` | `disabled` when `available` is false,
and `detail` always carries a sentence you can show a user.

`beyondRetention` is how many runs the Vault holds that the JSON files no longer
do — reported rather than implied, because it is the only figure that says
whether the feature is earning its keep on this machine.

### `GET /api/vault/quarters`

Calendar-quarter aggregates, newest first. `localtime` boundaries, matching the
wall clock that schedule triggers and budget windows already use.

```json
{
  "available": true,
  "detail": "4 quarters of history",
  "quarters": [
    {
      "key": "2026-Q2",
      "label": "2026 Q2",
      "startAt": "2026-04-01T…",
      "endAt": "2026-06-30T…",
      "runs": 400,
      "succeeded": 380,
      "failed": 20,
      "costUsd": 42.5,
      "tokens": 9000000,
      "medianDurationMs": 90000,
      "medianScore": 7.4
    }
  ]
}
```

`medianDurationMs` and `medianScore` are `null` when nothing in the quarter
finished or was scored. Not zero — a quarter nobody judged has not been judged
badly.

### `GET /api/vault/search?q=…`

Indexed full-text search over runs and alerts, with query expansion.

```json
{
  "available": true,
  "detail": "3 direct, 2 related",
  "query": "backoff",
  "hits": [
    {
      "kind": "run",
      "ref": "r-2f9c",
      "at": "2026-07-20T10:05:00.000Z",
      "title": "Nightly triage",
      "snippet": "…retry backoff exhausted after 3 attempts…",
      "href": "#/sessions/-home-u-proj/sess-1",
      "related": false
    }
  ],
  "relatedTerms": ["quarantine"],
  "limit": 60,
  "truncated": false
}
```

The query is tokenized to alphanumerics and prefix-matched with `AND`, so
`spectac` finds `Spectacle` and nothing a user types can reach FTS5's expression
grammar. A query under two characters is answered with an empty result and an
explanatory `detail`, not a `400`.

**`relatedTerms`** are terms that co-occur with the query in this machine's own
corpus — scored tf-idf: frequent among the documents the query matched, rare
across everything else. Hits reached only through the expansion carry
`related: true`, and the terms are returned so the expansion is auditable. This
is deliberately **not** an embedding model, and nothing in the API or the UI
describes it as one.

### `GET /api/vault/otel?days=N`

OTLP/JSON spans for a window of runs. `days` is clamped to 1–400 (default 7);
the document is capped at 5000 spans and says so with `capped: true`.

```json
{
  "spans": 412,
  "days": 30,
  "capped": false,
  "resourceSpans": [
    {
      "resource": {
        "attributes": [{ "key": "service.name", "value": { "stringValue": "argus" } }]
      },
      "scopeSpans": [{ "scope": { "name": "argus.vault" }, "spans": ["…"] }]
    }
  ]
}
```

- **Ids are derived, not generated** (SHA-256 of the run or instance id), so
  exporting the same window twice is byte-identical and a collector that
  receives both deduplicates instead of double-counting.
- **A pipeline is one trace.** Phase runs share their instance's trace id; a
  schedule run is its own trace.
- **Cost and tokens use `gen_ai.*` semantic conventions**, so they land on
  dashboards a collector already has rather than in Argus-specific fields
  nothing knows how to chart.
- **Status is honest.** `1` for succeeded, `2` for failed (including a
  zero-exit run that _signalled_ failure), and `0` — unset — for skipped,
  cancelled, interrupted and still-running. Reporting a skipped run as ok
  inflates every success rate computed downstream.

It is a GET returning a document rather than a push: Argus does not know where
your collector is, and a monitoring tool that phones home by default is a worse
citizen than one you have to point at something. `curl … | vector` is the
intended shape.

### `GET /api/chronicle?hours=N`

`hours` now accepts up to five years (was 336). Past **336 hours** the pruned
JSON files can no longer answer, so the window is filled in from the Vault, with
live records winning the merge on id. Vault-sourced spans carry no pid, exit
code or session id — the Vault stores what it can answer questions about, and
the fields it never knew are empty rather than guessed.

Without a Vault the long windows simply return what the JSON files still hold,
which is exactly the behaviour Chronicle always had.

## Weave — the pipeline DAG

Pipeline phases carry dependency edges, retry policies and artifact names.
Everything here is optional, and a definition using none of it is a **linear**
pipeline that behaves exactly as it did before Weave.

### Phase fields

```jsonc
{
  "id": "ship",
  "name": "Ship",
  "cwd": "/repo",
  "gated": false,
  "steps": [{ "name": "release", "prompt": "Release {{artifacts.plan}}" }],

  "needs": ["build", "test"], // phase ids this one waits for
  "retry": {
    "attempts": 3, // 1-10, including the first
    "backoffSeconds": 30, // 0-3600, doubles each retry, capped at 1h
    "retryOn": ["spawn", "exit-code"], // default; "signal" is opt-in
  },
  "produces": "release", // publish the payload as an artifact
}
```

**The linear default.** If **no** phase declares `needs`, each phase implicitly
needs the one before it. If **any** phase declares it, the graph is taken at
face value and phases without it are roots. A mixed reading would make the same
definition mean two different things depending on which phase you looked at.
Nothing is written back onto the definition — the linear reading is applied at
execution time, so the stored file stays what the author wrote.

**Validation** happens on create/update and is a `400`, not a runtime hang:
duplicate ids, self-edges, edges to phases that do not exist, duplicate edges,
cycles (the message names the phases in the cycle), and a graph where no phase
can start. `produces` must match `[A-Za-z0-9_-]{1,40}`.

### Execution semantics

- A fan-out starts every newly-ready phase together; a **fan-in waits for every
  dependency**, not the first to arrive.
- A gate in one branch does not stop another. `currentPhaseIndex` is redefined
  as the _most interesting_ live phase — a waiting gate first, then anything
  running, then the last thing that happened — so existing views keep working.
- A failed phase does **not** immediately terminate the instance while a sibling
  is still executing; the instance settles to `failed` when nothing is left that
  could progress. (`succeeded` requires every phase to have succeeded.)
- `POST /api/instances/:id/revise` re-runs only the revised phase and kills only
  that phase's stragglers. `POST /api/instances/:id/abort` stops everything.

### Instance fields

`PhaseProgress` gains `needs` (resolved, so the board can draw the graph without
the definition — which may since have been edited), `retries`, and `retryAt`.
`PipelineInstance` gains `artifacts: Record<string, unknown>`.

### Artifacts

A step prompt may interpolate:

- `{{previous.payload}}` — the payload of this phase's dependency. For a linear
  pipeline this is exactly what it always was.
- `{{artifacts.<name>}}` — any artifact published by a completed phase.

An unknown artifact interpolates to the empty string rather than being left as a
literal marker in the prompt.

### `GET /api/instances/:id/journal`

```json
{
  "entries": [
    { "at": "…", "kind": "instance.started", "detail": "Release train (manual)" },
    { "at": "…", "kind": "phase.started", "phaseId": "build", "attempt": 0, "detail": "2 steps" },
    { "at": "…", "kind": "step.spawned", "phaseId": "build", "runId": "…", "detail": "pid 4212" },
    { "at": "…", "kind": "phase.failed", "phaseId": "build", "detail": "exit-code: exit code 1" },
    {
      "at": "…",
      "kind": "phase.retry-scheduled",
      "phaseId": "build",
      "detail": "attempt 2 of 3 at …"
    },
    { "at": "…", "kind": "phase.retrying", "phaseId": "build", "attempt": 1 }
  ]
}
```

Append-only, one file per instance, capped at 500 returned entries and rotated
past 512 KB. It exists because the instance record is _state_ and is rewritten
in place: it can say a phase failed, but never that it failed, retried, failed
again and was revised. **Nothing reads the journal to decide what to do next** —
it is evidence, and a missing or corrupt one costs the history, never the
pipeline. A torn final line (the only failure mode of an append) costs exactly
one record. An unknown or path-escaping id returns an empty list.

## Sentinel

Incidents, escalation and the read-only diagnostic. Reading is open; every
mutation is **admin-gated**.

| Method + path                      | Effect                                              |
| ---------------------------------- | --------------------------------------------------- |
| `GET /api/sentinel`                | policy, incidents, summary, whether it is quiet now |
| `PUT /api/sentinel/policy`         | patch the escalation policy (admin)                 |
| `POST /api/incidents/:id/ack`      | acknowledge — stops the escalation clock (admin)    |
| `POST /api/incidents/:id/resolve`  | resolve by hand, optional `{ note }` (admin)        |
| `POST /api/incidents/:id/note`     | append a note (admin); `400` when empty             |
| `POST /api/incidents/:id/diagnose` | dispatch the read-only diagnostic (admin)           |

### `GET /api/sentinel`

```jsonc
{
  "generatedAt": "…",
  "policy": {
    "enabled": true,
    "levels": [
      { "afterMinutes": 0, "label": "Notify" },
      { "afterMinutes": 30, "label": "Escalate — still unacknowledged" },
    ],
    "quietHours": null, // or { "start": "22:00", "end": "07:00" }
    "quietHoursOverrideCritical": true,
    "autoDiagnose": false,
  },
  "incidents": [
    {
      "id": "…", // derived from `key`, so a condition never opens twice
      "key": "monitor:s1", // monitor:<id> | issue:<fingerprint> | anomaly:<key>:<metric>
      "source": "monitor-down",
      "severity": "critical",
      "title": "Nightly triage",
      "detail": "no run covered the slot expected at 02:00",
      "status": "open", // open | acknowledged | resolved
      "openedAt": "…",
      "acknowledgedAt": null,
      "acknowledgedBy": null,
      "resolvedAt": null,
      "level": 0,
      "nextEscalationAt": "…", // null once acknowledged or fully climbed
      "timeline": [{ "at": "…", "kind": "opened", "detail": "…", "by": "sentinel" }],
      "diagnosis": null,
      "scheduleId": "s1",
      "runId": null,
      "fingerprint": null,
    },
  ],
  "summary": { "open": 1, "acknowledged": 0, "resolved": 3, "critical": 1 },
  "inQuietHours": false,
}
```

### What opens an incident

Deliberately narrow: a monitor **down** (critical) or **failing** (warning), an
issue that was marked resolved and failed again (a _regression_, critical), or a
**critical** Watchtower anomaly. Mirroring every open issue would make the
incident list a second inbox.

### The state machine

Reconciliation is a pure function of (existing incidents, current conditions,
policy, now), run each scheduler tick:

- A condition with no incident **opens** one. A condition that persists does
  **not** open a second — a monitor down for six hours is one incident with a
  six-hour timeline.
- An **open** incident whose `nextEscalationAt` has passed climbs one level,
  appends an `escalated` entry, and alerts. Acknowledging clears
  `nextEscalationAt`, so it stops climbing.
- A condition that clears **resolves** the incident, once.
- A condition that comes back **reopens** the same incident (new `reopened`
  entry, escalation clock restarted) rather than opening a twin — the history of
  a recurring problem is the useful part.
- Resolving by hand sticks only while the condition is gone; if it is still
  live, the next tick reopens it and the timeline says so.
- Resolved incidents age out after 14 days; timelines cap at 200 entries.

Incidents are **persisted**, unlike the monitor/budget/anomaly watchers' in-memory
snapshots, so a restart resumes mid-incident instead of re-opening everything.

### Quiet hours

`inQuietHours` is evaluated on the **local** clock and wraps past midnight
(22:00–07:00 is the union of "after 22:00" and "before 07:00"). Inside the
window, an alert is marked `suppressed`: it is **not** sent as a
`sentinel:alert` frame and does not POST the webhook, but the timeline entry,
the incident and the escalation clock are all unaffected. `quietHoursOverrideCritical`
(default true) lets criticals ring anyway.

### Alerts

```json
{ "type": "sentinel:alert", "alert": { "event": "incident.escalated", "…": "…" } }
```

Events: `incident.opened`, `incident.escalated`, `incident.acknowledged`,
`incident.resolved`. Suppressed transitions broadcast a payload-free
`sentinel:changed` instead. With `ARGUS_WEBHOOK_URL` set, the same non-suppressed
transitions POST a payload whose `event` matches.

### The diagnostic

`POST /api/incidents/:id/diagnose` runs a bounded pass and attaches:

```jsonc
{
  "at": "…",
  "status": "ready", // ready | failed | skipped
  "findings": "one paragraph, grounded in the incident and its recent runs",
  "remediation": "the single most useful next step, or null",
  "confidence": 0.7,
  "costUsd": 0.001,
  "tokens": 800,
  "error": null,
}
```

It is **read-only by construction**: everything it may consider is inlined into
the prompt, so the pass is never asked to go and look and has nothing to look
with. `remediation` is a proposal — nothing executes it. The pass runs _outside_
the incident store lock (it can take 90 seconds; holding the store that long
would block acknowledgements) and re-reads under the lock before attaching, so a
human acknowledging meanwhile does not lose their edit.

`autoDiagnose` dispatches one diagnostic per tick for freshly-opened incidents
only. It is **off by default**.

## Verdict

Opt-in rubric scoring. Reading is open; producing a score spawns an agent, so
it is **admin-gated**.

| Method + path                | Effect                                                  |
| ---------------------------- | ------------------------------------------------------- |
| `GET /api/verdicts`          | score trends per schedule and phase                     |
| `GET /api/runs/:id/verdict`  | one run's score, its rubric, or why it has neither      |
| `POST /api/runs/:id/verdict` | score now (admin) → `200`; `409` when no rubric applies |

### Declaring a rubric

A rubric hangs off a **schedule** (`rubric` on the create/patch body) or a
**pipeline phase** (`rubric` on the phase). Both are optional; absent means no
scoring at all.

```jsonc
{
  "goal": "A triage summary that names every new failure and proposes one next step each.",
  "criteria": [
    { "id": "coverage", "label": "Names every new failure", "weight": 2 },
    { "id": "actionable", "label": "Proposes a concrete next step" },
  ],
  "minScore": 6, // optional: below this is a regression
}
```

Validation is strict and the errors are `400`, not `500`: `goal` required,
1–10 criteria, ids matching `[a-z0-9][a-z0-9_-]{0,40}` and unique, weights > 0,
`minScore` in 0–10. On a schedule, `"rubric": null` removes an existing one.

A **gated** phase may additionally declare `"autoApprove": { "verdict": 8 }`.
It requires a rubric on the same phase (there is nothing to clear otherwise) and
is refused on an ungated phase — both are `400`.

### `GET /api/runs/:id/verdict`

```jsonc
{
  "verdict": {
    "runId": "…",
    "phaseId": null,
    "status": "ready", // ready | failed | skipped
    "at": "2026-07-20T12:00:00.000Z",
    "score": 7.3, // weighted, computed server-side from your weights
    "criteria": [{ "id": "coverage", "label": "…", "score": 8, "note": "…" }],
    "summary": "…",
    "regression": false,
    "minScore": 6,
    "costUsd": 0.001,
    "tokens": 900,
    "durationMs": 3100,
    "error": null,
  },
  "rubric": { "…": "the rubric in force, or null" },
  "unavailable": null,
}
```

What the server does **not** trust from the judge:

- The **overall score** — it is computed from the author's weights. Asking a
  model for a weighted average and believing it lets a judge that scored every
  criterion 3/10 hand back an 8.
- **Criteria the rubric never mentioned** — dropped.
- **Out-of-range scores** — clamped to 0–10.
- **Labels** — taken from the rubric, so renaming one keeps the history joined
  by id.
- A response scoring **none** of the rubric's criteria is a failure, not a zero.

### `GET /api/verdicts`

```jsonc
{
  "generatedAt": "…",
  "trends": [
    {
      "key": "schedule:s1", // or "phase:pipeline:<id>:<phaseId>" — Watchtower's key space
      "scope": "schedule",
      "name": "Nightly triage",
      "points": [{ "runId": "…", "at": "…", "score": 8, "regression": false }],
      "latest": 5,
      "median": 6.5,
      "delta": -3, // latest vs the median of everything BEFORE it
      "minScore": 6, // read live from the definition, not the stored score
      "regressions": 1,
    },
  ],
  "summary": { "scored": 12, "regressions": 1, "average": 7.1 },
}
```

`delta` compares against the prior median rather than the previous run, so one
noisy judgement is not a collapse and one good run is not a recovery. Thresholds
come from the live definition, so tightening the bar redraws the line against
existing history.

### Regressions become issues

A run whose score falls below `minScore` is grouped in `GET /api/issues`
alongside crashes, titled `quality below the bar for <name>: scored X/10
against a minimum of Y`. A failure of the _work_ belongs in the same triage
surface as a failure of the process, not in a parallel list nobody checks.

### Auto-approving gates

Scoring and gate-opening both run on the scheduler tick, not in the pipeline
engine's signal path — a 90-second model call under the instance lock, inside a
request a child process is blocked on, is how a gate becomes a deadlock. The
cost is up to one tick of latency. The rules:

- No verdict yet → the gate **waits**. Silence is not approval.
- Any judged step **below** the bar → the gate waits for a human, indefinitely.
- Every judged step at or above the bar → approved, logged, and broadcast.
  The phase's **worst** step decides; averaging would let one excellent step
  carry a bad one through a gate set to catch exactly that.

## Autopsy

Bounded `claude -p` postmortems for failed runs. Reading is open; producing one
spawns an agent and relaunching spawns a real run, so both are **admin-gated**
alongside the pipeline routes.

| Method + path                 | Effect                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `GET /api/runs/:id/autopsy`   | the run's postmortem, or why it has none                     |
| `POST /api/runs/:id/autopsy`  | run the pass now (admin) → `200`; `409` if the run succeeded |
| `POST /api/runs/:id/relaunch` | fire the proposed prompt as a one-off (admin) → `202`        |

### `GET /api/runs/:id/autopsy`

```jsonc
{
  "autopsy": {
    "runId": "…",
    "status": "ready", // pending | ready | failed | skipped
    "at": "2026-07-20T12:00:00.000Z",
    "failureClass": "missing-context",
    "confidence": 0.75, // clamped to 0–1, null if the pass gave none
    "why": "One paragraph of prose.",
    "span": { "fromMs": 61000, "toMs": 75000, "quote": "61.0s tool [ERROR]: Bash: npm ci" },
    "promptDelta": "A complete replacement prompt, or null.",
    "deltaRationale": "One sentence, or null.",
    "costUsd": 0.003,
    "tokens": 2200,
    "durationMs": 4200,
    "error": null, // set when status is not "ready"
  },
  "eligible": true, // this run failed and could have one
  "unavailable": null, // why it can't, when it can't
}
```

`failureClass` is a **closed taxonomy**: `prompt-ambiguity`, `missing-context`,
`tool-error`, `permission-denied`, `environment`, `timeout`, `rate-limit`,
`model-refusal`, `bad-output-format`, `infrastructure`, `other`. An answer
outside it is rejected rather than stored — an open-ended class cannot be
clustered, counted or filtered, which is most of the value.

Nothing the model returns is trusted verbatim: `confidence` is clamped to 0–1,
`span` is clamped into the recording's real duration (a hallucinated "at forty
minutes" on a two-minute run becomes the end of the track, not an off-track
scrubber position), and an answer with no `why` is rejected outright.

### `POST /api/runs/:id/relaunch`

Fires the postmortem's `promptDelta` as a **one-off run** in the failed run's
`cwd`, inheriting its model. Body may carry `{ "prompt": "…" }` to override.
`409` when there is no proposed prompt. The schedule is never edited.

### Bounds on every analysis pass

Autopsy shares one bounded runner with the other model-backed features:

- **One pass at a time** across the whole process, claimed synchronously.
- **90-second timeout**, enforced by killing the process _group_.
- **256 KB output cap**; past it the process is killed.
- **Metered into the spend ledger** even when the pass fails — a ledger that
  only counts successes understates spend exactly when spend is going wrong.
- **Refused while the budget hard stop is in force**, before spawning.
- `ARGUS_ANALYSIS=off` disables all of it; `ARGUS_ANALYSIS_MODEL` picks the
  model (a cheap one by default).

Failed runs from the last 24 hours are autopsied automatically, one per
scheduler tick, newest first. A pass that fails is stored as `failed` so the run
is not retried on every tick.

### Issue clustering

With postmortems available, `GET /api/issues` merges differently-worded errors
that describe the same problem. Each issue carries:

- `members` — every exact-string fingerprint merged into it, including its own.
  Length 1 is plain string grouping.
- `failureClass` — the class the members agree on, or null.

The rule: two string groups merge when their normalized-message token overlap
(Jaccard, stopwords and short fragments dropped) clears **0.5 with a shared
failure class**, or **0.7 without one**. Two _different_ known classes never
merge, however similar the wording. The representative fingerprint is the
lexicographically smallest member, so an issue's identity — and its triage
record — survives members arriving or ageing out. With no autopsies present the
output is byte-for-byte what string grouping produced.

`GET /api/issues/:fingerprint` returns occurrences across the whole member set,
not just the representative.

## Watchtower

### `GET /api/watchtower`

Learned envelopes per unit of work, plus the runs that left them. Derived on
every read from run records; the only persisted state is reset markers.

```jsonc
{
  "generatedAt": "2026-07-20T12:00:00.000Z",
  "baselines": [
    {
      "key": "schedule:s1",          // or "phase:pipeline:<id>:<phaseId>"
      "scope": "schedule",           // schedule | phase
      "name": "Nightly triage",
      "samples": 24,                 // successful runs the envelope was learned from
      "warmupRemaining": 0,          // >0 means the envelope exists but will not fire
      "since": "2026-07-01T…",
      "resetAt": null,
      "duration": {
        "metric": "duration",
        "median": 61000,
        "mad": 900,                  // median absolute deviation, unscaled
        "p05": 55000,
        "p95": 70000,
        "min": 54000,
        "max": 71000,
        "samples": 24,
      },
      "cost": { … },                 // null when the runs never reported it
      "tokens": { … },
    },
  ],
  "anomalies": [
    {
      "id": "schedule:s1|cost|<runId>", // deterministic → de-duplication needs no state
      "key": "schedule:s1",
      "scope": "schedule",
      "name": "Nightly triage",
      "runId": "…",
      "scheduleId": "s1",
      "metric": "cost",              // duration | cost | tokens
      "direction": "high",           // high | low
      "severity": "critical",        // warn | critical
      "value": 0.42,
      "median": 0.1,
      "ratio": 4.2,
      "zScore": 21.6,                // null when the sample spread is degenerate
      "at": "2026-07-20T11:00:00.000Z",
      "detail": "4.2× median cost ($0.42 vs $0.10 over 24 runs)",
    },
  ],
  "summary": { "ready": 1, "warming": 0, "anomalies": 1, "critical": 1 },
  "warmupRuns": 8,
}
```

The detection rule, stated once so consumers can reason about it:

- Envelopes are learned from **successful runs only**; failures are judged
  against the envelope but never shape it.
- A value is anomalous when the **robust z-score** (`(value − median) /
(1.4826 × MAD)`) clears ±3.5 **and** the ratio to the median clears 1.5×
  (high) or 0.5× (low). Both must agree — z alone fires constantly on tight
  distributions.
- When every sample is identical the MAD is zero and z is undefined: those
  cases report `zScore: null` and use a ratio-only threshold of 2× / 0.5×.
- `severity` is `critical` at ≥3× (or |z| ≥ 7), else `warn`.
- Nothing fires under 8 successful samples; the shortfall is `warmupRemaining`.
- Window: samples are the most recent 100 runs per key; anomalies are the most
  recent 100 within 14 days.

### `POST /api/watchtower/:key/reset`

"Learn from here." Runs before now stop counting for `key`, for both the
envelope and the evaluation. Returns `{ ok: true, key, resetAt }`, or `400` for
a key outside `[A-Za-z0-9][A-Za-z0-9:_-]{0,199}`. Broadcasts
`watchtower:changed`.

### `DELETE /api/watchtower/:key/reset`

Drops the reset marker, restoring the full history. `404` when there was none.
Broadcasts `watchtower:changed`.

### Anomaly alerts

Newly-observed anomalies push a payload frame rather than a change ping — an
anomaly happens once and cannot be re-derived as "new":

```json
{ "type": "watchtower:anomaly", "anomaly": { "…": "as above" } }
```

Detection is a diff between scheduler ticks, so the first pass after a restart
is a **silent baseline** — a reboot never replays two weeks of anomalies into
the bell. Ids are deterministic, so the same run never alerts twice. When
`ARGUS_WEBHOOK_URL` is set, the same transition POSTs an `anomaly.detected`
payload.

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
`costUsd`/`tokens`/`model`/`runtime` joined from the step's run record, and
`cost` is the instance's total spend `{ usd, tokens }` across **all** of its runs
(including superseded revise attempts). A metric is `null` until at least one run
reports it; `cost` is `null` when the pipeline has never run. `usd` counts only
runs whose runtime reports a dollar figure — Codex reports tokens only, so a
Codex-only instance has `tokens` and a null `usd`.

A definition, a phase (`phases[]`) and a step (`phases[].steps[]`) may each
carry `runtime`; see [Naming a runtime](#naming-a-runtime) for the resolution
order. One pipeline can therefore mix runtimes phase by phase.

### Emitting signals from a run

The engine spawns each phase's run with `ARGUS_SIGNAL_URL`,
`ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`, `ARGUS_RUN_ID`, `ARGUS_SIGNAL_TOKEN` and
`ARGUS_RUNTIME`. `hooks/argus-signal.mjs` reads these and POSTs a signal. One
hook file serves both runtimes:

- **Claude Code** — a `Stop` hook in `settings.json` (no arg) to report the
  run's outcome, and optionally a `PreToolUse` hook on `AskUserQuestion` invoked
  as `argus-signal.mjs needs-input` to pause at a gate early.
- **Codex** — a `[[hooks.stop]]` entry in `~/.codex/config.toml`. There is no
  `PreToolUse` twin: Codex has no AskUserQuestion tool, and a gated phase pauses
  anyway, because the engine holds the gate on the phase's _completion_ signal
  rather than on the agent asking a question.

`POST /api/setup/apply` installs whichever of these the machine needs — and
only those. Each runtime's CLI and hook prerequisites are checked only while
something on the machine uses that runtime, so a Codex-only install is never
held to "Claude CLI on PATH" (and, since these are the checks a pipeline start
refuses on, never blocked by it) and vice versa.

The Stop hook does **not** assume success. When invoked with no arg it derives
the signal type from the agent's final message: a line matching
`ARGUS_OUTCOME: failed` (or `blocked`) emits `failed`; anything else emits
`completed`. A run that stops cleanly but concluded it failed can therefore fail
its phase instead of being rubber-stamped.

The engine supplies this reporting contract automatically: every step run is
spawned with a constant instruction to end the final message with
`ARGUS_OUTCOME: <succeeded|failed|blocked>` — delivered on
`claude --append-system-prompt`, or prepended to the prompt for Codex, which has
no equivalent flag.
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

## Derived views

Two endpoints exist purely to save the client from assembling something out of
five other payloads. Both are pure derivations over state the server already
reads — nothing extra is persisted for either.

### `GET /api/insight`

The Command Center's situation strip: what is in flight, what is blocked on a
human, what it is costing, and what fires next.

```json
{
  "generatedAt": "2026-07-07T10:30:00.000Z",
  "counts": {
    "runsInFlight": 1,
    "gatesWaiting": 1,
    "failedInstances": 0,
    "monitorsDown": 0,
    "monitorsFailing": 2,
    "openIssues": 3,
    "liveAgents": 2
  },
  "spend": {
    "state": "ok",
    "today": { "spentUsd": 3.5, "limitUsd": 25, "ratio": 0.14 },
    "month": { "spentUsd": 80, "limitUsd": 400, "ratio": 0.2 }
  },
  "nextFire": {
    "id": "sch_dep_audit",
    "name": "Dependency audit",
    "kind": "schedule",
    "at": "2026-07-07T12:00:00.000Z"
  },
  "throughput": [{ "at": "2026-07-06T11:00:00.000Z", "succeeded": 2, "failed": 0 }]
}
```

- `gatesWaiting` counts **instances**, not phases: an instance has one current
  phase, so counting phases would double-count a re-run gate.
- `nextFire` compares schedules (which arrive with `nextRun` computed) against
  pipeline definitions (whose triggers are projected from the same anchor the
  scheduler uses), so it agrees with what will actually fire.
- `throughput` is always 24 hour-aligned buckets, oldest first. Fixed-length and
  hour-aligned on purpose: a sparkline whose axis slides with the clock
  flickers, and an empty hour is itself the signal.

### `GET /api/palette`

The command palette's search index — one request instead of the seven view
payloads the client would otherwise join by hand. Deliberately lossy: enough to
find a thing and go to it, never enough to render a view from.

```json
{
  "generatedAt": "2026-07-07T10:30:00.000Z",
  "entries": [
    {
      "kind": "pipeline",
      "id": "pl_release_train",
      "title": "Release train",
      "subtitle": "4 phases · daily 23:00",
      "href": "#/command",
      "badge": "needs approval",
      "severity": "warn",
      "keywords": ["pl_release_train", "pipeline", "Gather changes"],
      "gateInstanceId": "inst_release_1"
    }
  ]
}
```

`kind` is one of `pipeline | schedule | monitor | issue | agent | project |
session`. `severity` (`none | info | warn | error`) is presentation-neutral: the
server knows a monitor is down, the client decides what red means. `keywords` are
searchable but never rendered. `gateInstanceId` and `runnableScheduleId` are what
let the palette offer an action rather than only a jump. Healthy monitors are
omitted (their schedule row already represents them) and transcripts are capped,
so the index cannot grow into a session list.

## Configuration

| Env var             | Default     | Effect                                                                                            |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `ARGUS_PORT`        | `7777`      | server port (proxy target)                                                                        |
| `ARGUS_CLAUDE_HOME` | `~/.claude` | directory to read/watch                                                                           |
| `CLAUDE_CONFIG_DIR` | —           | fallback override if `ARGUS_CLAUDE_HOME` unset                                                    |
| `ARGUS_WEBHOOK_URL` | —           | POST target for `run.failed`, `pipeline.failed`, and `monitor.*` events (Slack/mail bridge, etc.) |
| `ARGUS_VAULT`       | on          | `off` disables the Vault; every long view degrades to its JSON-only behaviour                     |
