# 👁️ Argus

Schedule and monitor your Claude Code agents, jobs, history and results.

Argus reads Claude Code's local state under `~/.claude` and surfaces it as a
live web dashboard — what's running now, what finished, what failed, and the
progress trail behind each one.

📖 **[User Guide](docs/USER-GUIDE.md)** — every feature, with screenshots:
Command Center, Briefing, Chronicle, Scheduler, Monitors, Issues, Pipelines,
Users, Search, and all the monitoring tabs.

## Stack

- **contracts** — every DTO that crosses the HTTP/WebSocket boundary, declared
  once and imported by both sides, so a field added on the server cannot drift
  from the client that reads it. Types only: nothing is emitted, and CI enforces
  that.
- **server** — Node 22 + TypeScript, [Hono](https://hono.dev) HTTP API,
  `chokidar` file-watcher, `ws` WebSocket for live push. It treats the state
  Claude Code owns (jobs, transcripts, history) as strictly read-only, and
  writes only its **own** state under `~/.claude/argus/` (schedules, pipelines,
  run records) plus, on request, signal hooks under `~/.claude/hooks/`.
- **web** — Vite 8 + React 19 + Tailwind CSS v4. One shared socket, one
  live-resource primitive with conditional (`ETag`) reads, one clock, and a lazy
  chunk per route under a CI-enforced size budget. Motion is a system rather than
  a set of flourishes — paired entrances and exits, directional navigation, and
  live lists that show change as change, all transform/opacity only and enforced
  as such in CI. See **[the motion system](docs/MOTION-SYSTEM.md)**.

OS-agnostic: it keys off `os.homedir()` and the encoded project-dir names, never
the absolute paths embedded in the data files (those can be from another OS).

### Security model

Argus can spawn `claude -p` agents with your credentials, so the HTTP surface
is a privileged single-user control plane:

- Binds to **loopback (`127.0.0.1`) only** by default — never the LAN.
- **Host-header allowlist** blocks DNS-rebinding; **Origin checks** on all
  mutating requests block drive-by CSRF; both apply to the WebSocket upgrade.
- Set **`ARGUS_TOKEN`** to require a bearer token. This is **enforced**, not
  advised: with `ARGUS_HOST` pointed at a non-loopback interface and no token,
  the server refuses to start rather than opening an unauthenticated port that
  can execute agents with your credentials.

## Getting around

`⌘K` (`Ctrl K`) opens the command palette: fuzzy search over every destination,
pipeline, schedule, failing monitor, open issue, agent, project and recent
transcript — plus the actions worth doing from a keyboard, like approving a
pipeline waiting at a gate or firing a schedule now. Three characters and Enter
usually gets there.

`?` lists every keyboard shortcut. `g` then a letter jumps to a destination
(`g c` Command Center, `g b` Briefing, `g h` Chronicle, `g l` Launch, `g s`
Scheduler, `g m` Monitors, `g i` Issues, `g p` Pipelines, `g u` Budget, `g a`
Agents); `/` goes to transcript search.

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

### The `argus` command (single port)

```bash
npm i -g .        # or `npm link` — puts `argus` on your PATH
argus --open      # build check, UI + API on :7777, opens your browser
```

`argus` makes sure a production build exists (building one on first run),
then serves the UI and API together on one port. Flags: `--open`,
`--port <n>`, `--rebuild`, `--version`, `--help`; every `ARGUS_*` variable
below is honoured. To install on another machine:

```bash
git clone https://github.com/Jobaben/Argus.git && cd Argus
npm ci && npm i -g .
```

Without a global install, the same thing is `npm run build && npm start`
(or `node bin/argus.mjs`).

Or with Docker (mount your `~/.claude`, publish the port, set a token):

```bash
docker build -t argus .
docker run --rm -p 7777:7777 \
  -e ARGUS_TOKEN=$(openssl rand -hex 16) \
  -v "$HOME/.claude:/data/.claude" \
  argus
```

### Configuration

| Variable                    | Default     | Purpose                                                                                 |
| --------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `ARGUS_CLAUDE_HOME`         | `~/.claude` | Directory Argus watches.                                                                |
| `ARGUS_PORT`                | `7777`      | HTTP/WS port.                                                                           |
| `ARGUS_HOST`                | `127.0.0.1` | Bind interface. A non-loopback bind **requires** `ARGUS_TOKEN` — Argus exits otherwise. |
| `ARGUS_TOKEN`               | _(unset)_   | Bearer token required on every request when set.                                        |
| `ARGUS_ALLOWED_HOSTS`       | _(none)_    | Extra Host values to accept (behind a proxy).                                           |
| `ARGUS_ALLOWED_ORIGINS`     | _(none)_    | Extra Origins to accept for cross-origin browser requests.                              |
| `ARGUS_MAX_CONCURRENT_RUNS` | `4`         | Cap on concurrently spawned pipeline steps.                                             |
| `ARGUS_SCHED_TICK_MS`       | `30000`     | Scheduler / reconcile tick interval.                                                    |
| `ARGUS_WEBHOOK_URL`         | _(unset)_   | POST target for failure + monitor alerts (Slack, mail, …).                              |

## Data sources

| Source            | Path                                        | Feeds                                 |
| ----------------- | ------------------------------------------- | ------------------------------------- |
| Background agents | `jobs/<short>/state.json`, `timeline.jsonl` | status, tempo, progress, results      |
| Live workers      | `daemon/roster.json`, `daemon.status.json`  | which agents are alive right now      |
| Transcripts       | `projects/<proj>/<session>.jsonl`           | Sessions list + full transcript view  |
| Prompt history    | `history.jsonl`                             | global activity feed                  |
| Tasks             | `tasks/<id>/`                               | task-queue metadata                   |
| Argus schedules   | `argus/schedules.json`                      | Scheduler triggers + run history      |
| Argus pipelines   | `argus/pipelines.json`, `argus/instances/`  | multi-phase pipeline defs + instances |

**Argus's Scheduler** fires its own headless `claude -p` runs on interval /
daily / weekly triggers (see the Scheduler tab — create, run-now, history).
This is distinct from Claude Code's **native cron routines**, which are
session-scoped (harness-managed, visible only via `CronList` inside a live
Claude session) and are **not** stored on disk; Argus, a disk reader, cannot
surface those — the Cron tab explains why.

## API

Full request/response detail lives in [docs/API.md](docs/API.md). The surface
in brief:

| Group             | Endpoints                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health / setup    | `GET /api/health`, `GET /api/setup`, `POST /api/setup/apply`                                                                                                                                                                                  |
| Monitoring (read) | `GET /api/agents`, `/agents/:short/timeline`, `/daemon`, `/sessions`, `/sessions/:project/:id`, `/activity`, `/projects`, `/stats`, `/inventory`, `/tasks`, `/search`, `/cron`, `/chronicle`                                                  |
| Scheduler         | `GET/POST /api/schedules`, `PUT/DELETE /api/schedules/:id`, `POST /api/schedules/:id/run`, `POST /api/runs/:id/cancel`, `GET /api/runs`, `/runs/:id`                                                                                          |
| Pipelines         | `GET/POST /api/pipelines`, `PUT/PATCH/DELETE /api/pipelines/:id`, `POST /api/pipelines/:id/start`, `GET /api/pipelines/:id/instances`, `GET /api/overview`, `GET /api/instances/:id`, `POST /api/instances/:id/{signal,approve,revise,abort}` |
| Live push         | `WS /ws` — `{type:"agents:changed"｜"schedules:changed"｜"pipelines:changed"｜"inventory:changed"}`                                                                                                                                           |

## Status

**v0.2** — monitoring (agents, sessions, activity, projects, stats, search,
inventory), the Scheduler (create / run-now / cancel / history), multi-phase
Pipelines (human-gated approve / revise / abort), and the **Chronicle** — a
cross-source swimlane timeline of every run, agent, and session
(`GET /api/chronicle`, Chronicle tab) — all ship. The server is
loopback-hardened, single-port packageable (`npm run build && npm start`), and
Docker-ready. See [docs/SCORECARD.md](docs/SCORECARD.md) for the quality rubric.
