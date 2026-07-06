# 👁️ Argus

Schedule and monitor your Claude Code agents, jobs, history and results.

Argus reads Claude Code's local state under `~/.claude` and surfaces it as a
live web dashboard — what's running now, what finished, what failed, and the
progress trail behind each one.

## Stack

- **server** — Node 22 + TypeScript, [Hono](https://hono.dev) HTTP API,
  `chokidar` file-watcher, `ws` WebSocket for live push. It treats the state
  Claude Code owns (jobs, transcripts, history) as strictly read-only, and
  writes only its **own** state under `~/.claude/argus/` (schedules, pipelines,
  run records) plus, on request, signal hooks under `~/.claude/hooks/`.
- **web** — Vite 8 + React 19 + Tailwind CSS v4.

OS-agnostic: it keys off `os.homedir()` and the encoded project-dir names, never
the absolute paths embedded in the data files (those can be from another OS).

### Security model

Argus can spawn `claude -p` agents with your credentials, so the HTTP surface
is a privileged single-user control plane:

- Binds to **loopback (`127.0.0.1`) only** by default — never the LAN.
- **Host-header allowlist** blocks DNS-rebinding; **Origin checks** on all
  mutating requests block drive-by CSRF; both apply to the WebSocket upgrade.
- Set **`ARGUS_TOKEN`** to require a bearer token — mandatory if you override
  `ARGUS_HOST` to expose a non-loopback interface.

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

### Production (single port)

```bash
npm run build     # bundles the web UI and compiles the server to JS
npm start         # serves the UI + API together on :7777
```

Or with Docker (mount your `~/.claude`, publish the port, set a token):

```bash
docker build -t argus .
docker run --rm -p 7777:7777 \
  -e ARGUS_TOKEN=$(openssl rand -hex 16) \
  -v "$HOME/.claude:/data/.claude" \
  argus
```

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARGUS_CLAUDE_HOME` | `~/.claude` | Directory Argus watches. |
| `ARGUS_PORT` | `7777` | HTTP/WS port. |
| `ARGUS_HOST` | `127.0.0.1` | Bind interface. Non-loopback requires `ARGUS_TOKEN`. |
| `ARGUS_TOKEN` | *(unset)* | Bearer token required on every request when set. |
| `ARGUS_ALLOWED_HOSTS` | *(none)* | Extra Host values to accept (behind a proxy). |
| `ARGUS_ALLOWED_ORIGINS` | *(none)* | Extra Origins to accept for cross-origin browser requests. |
| `ARGUS_MAX_CONCURRENT_RUNS` | `4` | Cap on concurrently spawned pipeline steps. |
| `ARGUS_SCHED_TICK_MS` | `30000` | Scheduler / reconcile tick interval. |

## Data sources

| Source | Path | Feeds |
| --- | --- | --- |
| Background agents | `jobs/<short>/state.json`, `timeline.jsonl` | status, tempo, progress, results |
| Live workers | `daemon/roster.json`, `daemon.status.json` | which agents are alive right now |
| Transcripts | `projects/<proj>/<session>.jsonl` | Sessions list + full transcript view |
| Prompt history | `history.jsonl` | global activity feed |
| Tasks | `tasks/<id>/` | task-queue metadata |
| Argus schedules | `argus/schedules.json` | Scheduler triggers + run history |
| Argus pipelines | `argus/pipelines.json`, `argus/instances/` | multi-phase pipeline defs + instances |

**Argus's Scheduler** fires its own headless `claude -p` runs on interval /
daily / weekly triggers (see the Scheduler tab — create, run-now, history).
This is distinct from Claude Code's **native cron routines**, which are
session-scoped (harness-managed, visible only via `CronList` inside a live
Claude session) and are **not** stored on disk; Argus, a disk reader, cannot
surface those — the Cron tab explains why.

## API

Full request/response detail lives in [docs/API.md](docs/API.md). The surface
in brief:

| Group | Endpoints |
| --- | --- |
| Health / setup | `GET /api/health`, `GET /api/setup`, `POST /api/setup/apply` |
| Monitoring (read) | `GET /api/agents`, `/agents/:short/timeline`, `/daemon`, `/sessions`, `/sessions/:project/:id`, `/activity`, `/projects`, `/stats`, `/inventory`, `/tasks`, `/search`, `/cron` |
| Scheduler | `GET/POST /api/schedules`, `PUT/DELETE /api/schedules/:id`, `POST /api/schedules/:id/run`, `POST /api/runs/:id/cancel`, `GET /api/runs`, `/runs/:id` |
| Pipelines | `GET/POST /api/pipelines`, `PUT/PATCH/DELETE /api/pipelines/:id`, `POST /api/pipelines/:id/start`, `GET /api/pipelines/:id/instances`, `GET /api/overview`, `GET /api/instances/:id`, `POST /api/instances/:id/{signal,approve,revise,abort}` |
| Live push | `WS /ws` — `{type:"agents:changed"｜"schedules:changed"｜"pipelines:changed"}` |

## Status

**v0.2** — monitoring (agents, sessions, activity, projects, stats, search,
inventory), the Scheduler (create / run-now / cancel / history), and multi-phase
Pipelines (human-gated approve / revise / abort) all ship. The server is
loopback-hardened, single-port packageable (`npm run build && npm start`), and
Docker-ready. See [docs/SCORECARD.md](docs/SCORECARD.md) for the quality rubric.
