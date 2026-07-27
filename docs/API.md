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
