# 👁️ Argus

**The agent-operations control plane for Claude Code — schedule unattended
runs, cap what they can spend, gate the consequential steps behind a human,
and get told when something breaks.**

Claude Code agents increasingly work while nobody is watching: nightly triage,
scheduled dependency audits, multi-phase pipelines that run for hours. Argus
is the thing that watches them. It runs on your machine, reads the state
Claude Code already writes under `~/.claude`, and adds the operational layer
that unattended agents need:

- **Schedule** — fire headless `claude -p` runs on interval / daily / weekly
  triggers, with run history, cancel, and opt-in catch-up for slots missed
  while the machine was asleep.
- **Cap spend** — every run reports its real dollar cost; set daily and
  monthly limits and, if you choose, a hard stop that skips scheduled
  firings while you're over (manual actions are never blocked — a human
  clicking a button is its own authorization).
- **Gate** — multi-phase pipelines pause at human gates: approve, revise
  with feedback, or abort before the next phase spends anything.
- **Alert** — dead-man's-switch monitors catch the schedule slot where
  _nothing ran_ (invisible to any runs list); failures and budget
  transitions reach you as toasts, native notifications, and webhooks.
- **Audit** — failed runs are fingerprinted and grouped into issues
  (twenty timeouts read as one issue ×20, not twenty rows), every run is
  replayable as a scrubbable timeline, and full-text search covers your
  entire agent history.

One binary of scope-honesty up front: Argus is **single-user, local-first,
and Claude Code only** (for now). It is a control plane for _your_ agents on
_your_ machines — not a hosted service, not a team product. A read-only
federation view can pin multiple machines to one dashboard, but each Argus
belongs to one human.

📖 **[User Guide](docs/USER-GUIDE.md)** — every feature in depth:
Command Center, Briefing, Chronicle, Launch, Scheduler, Monitors, Issues,
Pipelines, Budget, Flight Recorder, the Vault, Omnibar, and more.

## Quick start

```bash
git clone https://github.com/Jobaben/Argus.git && cd Argus
node bin/argus.mjs --open
```

That's it. The `argus` entry point installs dependencies and builds on first
run, then serves the dashboard and API together on `http://127.0.0.1:7777`
and opens your browser. No Claude Code state yet? Every tab renders a
teaching empty state that explains what will appear there — never a blank
screen.

Prefer it on your PATH?

```bash
npm i -g .       # then: `argus --open` from anywhere
```

For development (hot reload, separate ports):

```bash
npm install
npm run dev      # server on :7777, web on :5757 (proxied to the API)
```

Or with Docker (mount your `~/.claude`, publish the port, set a token):

```bash
docker build -t argus .
docker run --rm -p 7777:7777 \
  -e ARGUS_TOKEN=$(openssl rand -hex 16) \
  -v "$HOME/.claude:/data/.claude" \
  argus
```

Requires Node ≥ 22.

## Security model

Argus can spawn `claude -p` agents **with your credentials**, so its HTTP
surface is treated as a privileged single-user control plane — locked down
by default rather than by advice:

- Binds to **loopback (`127.0.0.1`) only** by default — never the LAN.
- A **Host-header allowlist** blocks DNS-rebinding; **Origin checks** on all
  mutating requests block drive-by CSRF; both also apply to the WebSocket
  upgrade.
- Set **`ARGUS_TOKEN`** to require a bearer token on every request. This is
  **enforced, not advised**: point `ARGUS_HOST` at a non-loopback interface
  without a token and the server refuses to start rather than open an
  unauthenticated port that can execute agents with your credentials.
- Argus treats everything Claude Code owns (jobs, transcripts, history) as
  **strictly read-only**. It writes only its own state under
  `~/.claude/argus/` and, on request, signal hooks under `~/.claude/hooks/`.

See [SECURITY.md](SECURITY.md) for the disclosure policy.

## How it fits together

- **contracts** — every DTO that crosses the HTTP/WebSocket boundary,
  declared once and imported by both sides, so a field added on the server
  cannot drift from the client that reads it. Types only; CI enforces that
  nothing is emitted.
- **server** — Node 22 + TypeScript, [Hono](https://hono.dev) HTTP API,
  `chokidar` file-watcher, `ws` WebSocket for live push.
- **web** — Vite 8 + React 19 + Tailwind CSS v4. One shared socket, one
  live-resource primitive with conditional (`ETag`) reads, and a lazy chunk
  per route under a CI-enforced size budget.

OS-agnostic: Argus keys off `os.homedir()` and the encoded project-dir names,
never the absolute paths embedded in the data files (those can be from
another OS entirely — a Windows `~/.claude` reads fine on Linux).

### Getting around

`⌘K` (`Ctrl K`) opens the command palette: fuzzy search over every
destination, pipeline, schedule, failing monitor, open issue, agent, project
and recent transcript — plus the actions worth doing from a keyboard, like
approving a pipeline waiting at a gate or firing a schedule now. `?` lists
every keyboard shortcut; `g` then a letter jumps to a tab.

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
| `ARGUS_WEBHOOK_URL`         | _(unset)_   | POST target for failure + monitor + budget alerts (Slack, mail, …).                     |

### Data sources

| Source            | Path                                        | Feeds                                 |
| ----------------- | ------------------------------------------- | ------------------------------------- |
| Background agents | `jobs/<short>/state.json`, `timeline.jsonl` | status, tempo, progress, results      |
| Live workers      | `daemon/roster.json`, `daemon.status.json`  | which agents are alive right now      |
| Transcripts       | `projects/<proj>/<session>.jsonl`           | Sessions list + full transcript view  |
| Prompt history    | `history.jsonl`                             | global activity feed                  |
| Tasks             | `tasks/<id>/`                               | task-queue metadata                   |
| Argus schedules   | `argus/schedules.json`                      | Scheduler triggers + run history      |
| Argus pipelines   | `argus/pipelines.json`, `argus/instances/`  | multi-phase pipeline defs + instances |

**Argus's Scheduler** fires its own headless `claude -p` runs. This is
distinct from Claude Code's **native cron routines**, which are
session-scoped and not stored on disk; Argus, a disk reader, cannot surface
those — the Cron tab explains why.

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

## Feedback, bugs, and what's next

Argus is young and looking for its first real users. If something breaks,
confuses you, or is missing:

- **Bugs** → [open an issue](https://github.com/Jobaben/Argus/issues/new?template=bug_report.yml)
- **Feature requests** → [open an issue](https://github.com/Jobaben/Argus/issues/new?template=feature_request.yml)
- **What gets built next** → the pinned
  [roadmap issue](https://github.com/Jobaben/Argus/issues/20) — two candidate
  directions (a remote-ingestion adapter vs. a team/fleet edition) are
  waiting on real demand to pick between them. Vote with a 👍 or a comment.

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE).
