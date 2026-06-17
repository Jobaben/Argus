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

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `ARGUS_PORT` | `7777` | server port (proxy target) |
| `ARGUS_CLAUDE_HOME` | `~/.claude` | directory to read/watch |
| `CLAUDE_CONFIG_DIR` | — | fallback override if `ARGUS_CLAUDE_HOME` unset |
