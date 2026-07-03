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
{ "agents": [ { "short": "59b12afc", "status": "working", "live": true,
  "tempo": "active", "detail": "...", "result": null, "cwd": "...",
  "inFlight": { "tasks": 0, "queued": 0, "kinds": [] },
  "createdAt": "...", "updatedAt": "...", "pid": 49616 } ] }
```

### `GET /api/agents/:short/timeline`
```json
{ "timeline": [ { "at": "...", "state": "done", "detail": "...", "text": "..." } ] }
```

### `GET /api/daemon`
```json
{ "supervisorPid": 43460, "updatedAt": 1781249595862, "workers": { "59b12afc": { "pid": 49616 } } }
```

### `WS /ws`
On connect: `{ "type": "hello" }`. On any watched change (debounced ~150ms):
`{ "type": "agents:changed" }`. Client re-fetches the relevant list — frames
carry no payload by design (server stays the single source of truth).

## Read coverage (v0.2)

| Endpoint | Returns |
| --- | --- |
| `GET /api/sessions` | recent transcript summaries across projects |
| `GET /api/sessions/:project/:id` | full ordered message stream for one session |
| `GET /api/activity` | recent prompts from `history.jsonl` |
| `GET /api/projects` | projects with session counts + last activity |
| `GET /api/stats` | usage aggregates from `stats-cache.json` |
| `GET /api/inventory` | installed agents / commands / skills / plugins |
| `GET /api/tasks` | task-queue directories |
| `GET /api/search?q=` | substring matches across transcripts |
| `GET /api/cron` | `{ available: false, reason, howTo }` — see ARCHITECTURE §6 |

> v0.2 endpoint shapes are authored by the buildout fan-out; consult each
> `server/src/sources/*.ts` for the exact DTO until this table is finalized.

## Pipelines (v0.3)

| Method + path | Effect |
| --- | --- |
| `GET /api/pipelines` | list pipeline definitions |
| `POST /api/pipelines` | create a definition (validated) |
| `PUT /api/pipelines/:id` | replace a definition |
| `DELETE /api/pipelines/:id` | delete a definition |
| `POST /api/pipelines/:id/start` | start an instance manually → `202`, or `409` on overlap |
| `GET /api/pipelines/:id/instances` | instances for a pipeline (newest first) |
| `GET /api/instances/:id` | full pipeline instance |
| `POST /api/instances/:id/signal` | ingest a signal `{ phaseId, runId, type, token, payload? }`; `403` on bad token |
| `POST /api/instances/:id/approve` | advance past a gate (optional `{ answers }`) |
| `POST /api/instances/:id/revise` | re-run the current phase (optional `{ note }`) |
| `POST /api/instances/:id/abort` | abort the instance |
| `GET /api/setup` | prerequisite status `{ ok, prereqs[] }` |
| `POST /api/setup/apply` | install fixable prerequisites, then re-check → `{ ok, prereqs[] }` |

WS frame `{ "type": "pipelines:changed" }` is pushed on any pipeline mutation.

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

| Env var | Meaning |
| --- | --- |
| `ARGUS_STEP_NAME` | label of the running step, injected into the run's environment |
| `ARGUS_MAX_CONCURRENT_RUNS` | cap on concurrent `claude -p` processes (default 4) |

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `ARGUS_PORT` | `7777` | server port (proxy target) |
| `ARGUS_CLAUDE_HOME` | `~/.claude` | directory to read/watch |
| `CLAUDE_CONFIG_DIR` | — | fallback override if `ARGUS_CLAUDE_HOME` unset |
