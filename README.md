# 👁️ Argus

The all-seeing monitor for your Claude Code agents, jobs, history and results.

Argus reads Claude Code's local state under `~/.claude` and surfaces it as a
live web dashboard — what's running now, what finished, what failed, and the
progress trail behind each one.

## Stack

- **server** — Node 22 + TypeScript, [Hono](https://hono.dev) HTTP API,
  `chokidar` file-watcher, `ws` WebSocket for live push. Pure reader: it never
  writes to `~/.claude`.
- **web** — Vite 8 + React 19 + Tailwind CSS v4.

OS-agnostic: it keys off `os.homedir()` and the encoded project-dir names, never
the absolute paths embedded in the data files (those can be from another OS).

## Quick start

```bash
npm install
npm run dev      # server on :7777, web on :5757 (proxied to the API)
```

Open http://localhost:5757.

Override the watched directory or port:

```bash
ARGUS_CLAUDE_HOME=/path/to/.claude ARGUS_PORT=7777 npm run dev
```

## Data sources

| Source | Path | Feeds |
| --- | --- | --- |
| Background agents | `jobs/<short>/state.json`, `timeline.jsonl` | status, tempo, progress, results |
| Live workers | `daemon/roster.json`, `daemon.status.json` | which agents are alive right now |
| Transcripts | `projects/<proj>/<session>.jsonl` | history + full results *(planned)* |
| Prompt history | `history.jsonl` | global activity feed *(planned)* |
| Tasks | `tasks/<id>/` | task-queue metadata *(planned)* |

**Cron / scheduled routines** are **not** stored on disk — they are
session-scoped (harness-managed, visible only via `CronList` inside a live
Claude session). A cron view would require a polling host process, not a
file-watch, and is intentionally out of scope for v1.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/health` | service + resolved `claudeHome` |
| `GET /api/agents` | merged background jobs + daemon liveness |
| `GET /api/agents/:short/timeline` | progress timeline for one agent |
| `GET /api/daemon` | raw daemon roster snapshot |
| `WS  /ws` | pushes `{type:"agents:changed"}` on any watched change |

## Status

v0.1 — **live agents** vertical slice complete (jobs + daemon, live WebSocket
refresh). Next: agent detail + timeline view, transcript history, activity feed.
