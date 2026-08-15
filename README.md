# 👁️ Argus

Schedule and monitor your coding agents — their jobs, history and results.

Argus reads Claude Code's local state under `~/.claude` (and Codex's under
`~/.codex`) and surfaces it as a live web dashboard — what's running now, what
finished, what failed, and the progress trail behind each one.

It drives **four agent runtimes**: Claude Code (`claude -p`), OpenAI Codex
(`codex exec`), OpenCode (`opencode run`) and Qwen Code (`qwen`). Pick one per
schedule, per one-off launch, per pipeline — or per _phase or step_ inside a
pipeline, so one pipeline can draft on one agent and review on another. The last
two speak OpenAI-compatible endpoints, so a model served locally by
`llama-server`, Ollama or vLLM is a first-class runtime rather than a
workaround. See [Agent runtimes](#agent-runtimes).

📖 **[User Guide](docs/USER-GUIDE.md)** — every feature, with screenshots:
Command Center, Briefing, Chronicle, Scheduler, Monitors, Issues, Pipelines,
Users, Search, and all the monitoring tabs.

## Stack

- **contracts** — every DTO that crosses the HTTP/WebSocket boundary, declared
  once and imported by both sides, so a field added on the server cannot drift
  from the client that reads it. Types only: nothing is emitted, and CI enforces
  that.
- **server** — Node 22 + TypeScript, [Hono](https://hono.dev) HTTP API,
  `chokidar` file-watcher, `ws` WebSocket for live push. It treats the state the
  agent CLIs own (jobs, transcripts, history) as strictly read-only, and
  writes only its **own** state under `~/.claude/argus/` (schedules, pipelines,
  run records) plus, on request, signal hooks under `~/.claude/hooks/` and
  `~/.codex/hooks/`. Everything CLI-specific — argv, output parsing, activity
  vocabulary, hook registration — lives behind one runtime seam in
  `server/src/runtimes/`, so neither agent's quirks leak into the engine.
- **web** — Vite 8 + React 19 + Tailwind CSS v4. One shared socket, one
  live-resource primitive with conditional (`ETag`) reads, one clock, and a lazy
  chunk per route under a CI-enforced size budget. Motion is a system rather than
  a set of flourishes — paired entrances and exits, directional navigation, and
  live lists that show change as change, all transform/opacity only and enforced
  as such in CI. See **[the motion system](docs/MOTION-SYSTEM.md)**.

OS-agnostic: it keys off `os.homedir()` and the encoded project-dir names, never
the absolute paths embedded in the data files (those can be from another OS).

## Agent runtimes

| Argus needs              | Claude Code                    | Codex                                 | OpenCode                        | Qwen Code                          |
| ------------------------ | ------------------------------ | ------------------------------------- | ------------------------------- | ---------------------------------- |
| headless run             | `claude -p`                    | `codex exec`                          | `opencode run`                  | `qwen`                             |
| prompt kept off argv     | stdin                          | stdin, via the `-` prompt placeholder | stdin                           | stdin                              |
| one parseable result     | `--output-format json`         | `--json` (a JSONL event stream)       | `--format json` (NDJSON events) | `-o json`                          |
| live transcript to tail  | `--output-format stream-json`  | the same `--json` stream              | the same `--format json` stream | `-o stream-json`                   |
| model override           | `--model`                      | `--model`                             | `--model <provider>/<model>`    | `--model`                          |
| reasoning override       | CLI/model default              | `-c model_reasoning_effort=…`         | `--variant`                     | model's own                        |
| unattended tool approval | CLI default                    | `--sandbox`                           | `--auto`                        | `--approval-mode yolo`             |
| pipeline outcome signal  | `Stop` hook in `settings.json` | `[[hooks.stop]]` in `config.toml`     | _none — read off the run_       | `Stop` hook in `settings.json`     |
| Argus-owned instructions | `--append-system-prompt`       | prepended to the prompt               | prepended to the prompt         | prepended to the prompt            |
| transcripts on disk      | `projects/<proj>/<id>.jsonl`   | `sessions/YYYY/MM/DD/rollout-*.jsonl` | a private SQLite database       | `projects/<proj>/chats/<id>.jsonl` |

Four differences survive the mapping, and Argus reports them rather than
papering over them:

- **Only Claude Code takes a session id from Argus.** The other three mint their
  own, so Argus reads it back out of the stream (`thread.started`, `sessionID`,
  `session_id`) and patches the run record — the transcript link appears once
  the run has started rather than before it.
- **Codex reports tokens, not dollars.** Argus uses the input, cached-input and
  output breakdown to estimate supported OpenAI models at public API list
  prices. The UI marks per-run Codex dollars with `~`; custom models without a
  known price keep `costUsd: null` rather than receiving a fabricated value.
  Qwen Code reports no cost at all, and Argus leaves it null rather than
  inventing one — the honest answer for a model you are serving yourself.
- **OpenCode has no command hook.** Its extension surface is JavaScript plugins,
  so there is nothing for Argus to register. A pipeline phase on OpenCode
  instead completes from the `ARGUS_OUTCOME` marker on the finished run record —
  the same protocol the hook reads, taken from the run's final message — which
  means the phase advances on the next reconcile tick (`ARGUS_SCHED_TICK_MS`)
  rather than the instant the process exits.
- **OpenCode keeps transcripts in SQLite.** Its sessions live in a private
  schema rather than per-session JSONL, so the Sessions view has nothing to read
  back and says so. Live activity during the run is unaffected — that comes off
  the event stream.

Everything else is at parity: live activity in the Command Center, the Flight
Recorder, gated phases, retries, the Chronicle, monitors and issues. The
Sessions transcript view covers Claude Code and Codex (rollouts are translated
into the same shape).

**Local models.** OpenCode and Qwen Code are the two runtimes that talk to an
OpenAI-compatible endpoint, which is what makes a GPU in the next room usable
from a schedule:

```bash
# llama-server -m qwen3-27b-q5.gguf --port 8080   ← already running
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1  # Qwen Code reads these three
export OPENAI_API_KEY=sk-local
export OPENAI_MODEL=qwen3-27b
argus --agent qwen --open
```

Qwen Code needs no further setup — `OPENAI_MODEL` leads its model picker. For
OpenCode, declare the endpoint as a provider in `~/.config/opencode/opencode.json`
and address the model as `<provider>/<model>`:

```json
{
  "provider": {
    "llama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8080/v1", "apiKey": "sk-local" },
      "models": { "qwen3-27b": { "name": "Qwen3 27B Q5" } }
    }
  }
}
```

then set `ARGUS_OPENCODE_MODELS=llama/qwen3-27b` to put it in the picker.

**Choosing a runtime.** Narrowest wins — step, then phase, then pipeline (or the
schedule / launch form), then `ARGUS_AGENT`, then Claude Code. Nothing is
rewritten on upgrade: a schedule or pipeline that names no runtime keeps running
on Claude Code exactly as before, and every run records which CLI produced it.

**Setup.** The Setup panel installs each runtime's signal hook and reports a
missing CLI — but only for runtimes something on the machine actually uses. A
Codex-only install is never held to "Claude CLI on PATH", and the same goes for
each of the others. For Codex, Argus **appends** a `[[hooks.stop]]` block to
`~/.codex/config.toml` and never rewrites the file; if `[hooks]` already declares
a scalar `stop` key (which would make the block invalid TOML) it reports that
instead of touching anything. Qwen Code's hooks are Claude Code's — same
`settings.json` schema, same payload — so the same `argus-signal.mjs` is
registered under `~/.qwen`, leaving every other key in that file alone.

### Security model

Argus can spawn agents with your credentials, so the HTTP surface is a
privileged single-user control plane:

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
argus --agent codex --open  # Codex-only machine; Claude is not required
```

`argus` makes sure a production build exists (building one on first run),
then serves the UI and API together on one port. Flags: `--open`,
`--agent <claude|codex|opencode|qwen>`, `--port <n>`, `--rebuild`, `--version`,
`--help`; every `ARGUS_*` variable
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

| Variable                    | Default                                | Purpose                                                                                           |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ARGUS_CLAUDE_HOME`         | `~/.claude`                            | Claude Code directory Argus watches. Also holds Argus's own state.                                |
| `ARGUS_CODEX_HOME`          | `~/.codex`                             | Codex directory Argus watches (honours `CODEX_HOME` too).                                         |
| `ARGUS_OPENCODE_HOME`       | `~/.local/share/opencode`              | OpenCode data directory (honours `XDG_DATA_HOME` too).                                            |
| `ARGUS_QWEN_HOME`           | `~/.qwen`                              | Qwen Code directory Argus reads, and installs its Stop hook into.                                 |
| `ARGUS_AGENT`               | `claude`                               | Default runtime (`claude` \| `codex` \| `opencode` \| `qwen`) for anything that doesn't name one. |
| `ARGUS_CLAUDE_BIN`          | `claude`                               | Claude Code executable.                                                                           |
| `ARGUS_CODEX_BIN`           | `codex`                                | Codex executable.                                                                                 |
| `ARGUS_OPENCODE_BIN`        | `opencode`                             | OpenCode executable.                                                                              |
| `ARGUS_QWEN_BIN`            | `qwen`                                 | Qwen Code executable.                                                                             |
| `ARGUS_CODEX_SANDBOX`       | `workspace-write`                      | Codex sandbox mode (`read-only` \| `workspace-write` \| `danger-full-access`).                    |
| `ARGUS_CLAUDE_ARGS`         | _(none)_                               | Extra argv appended to every `claude -p` (simple quoting honoured).                               |
| `ARGUS_CODEX_ARGS`          | _(none)_                               | Extra argv appended to every `codex exec`.                                                        |
| `ARGUS_OPENCODE_ARGS`       | _(none)_                               | Extra argv appended to every `opencode run`.                                                      |
| `ARGUS_QWEN_ARGS`           | _(none)_                               | Extra argv appended to every `qwen` run — `--sandbox` belongs here.                               |
| `ARGUS_CODEX_MODELS`        | _(none)_                               | Extra comma-separated model aliases to add to the built-in Codex model picker.                    |
| `ARGUS_OPENCODE_MODELS`     | _(none)_                               | Comma-separated `<provider>/<model>` ids for the OpenCode picker (free text otherwise).           |
| `ARGUS_QWEN_MODELS`         | _(none)_                               | Extra comma-separated model aliases for the Qwen Code picker (`OPENAI_MODEL` leads it).           |
| `ARGUS_ANALYSIS_RUNTIME`    | `$ARGUS_AGENT`                         | Which CLI answers the bounded analysis passes (autopsy, verdict, diagnose, plan).                 |
| `ARGUS_ANALYSIS_MODEL`      | `haiku` (Claude) / CLI default (Codex) | Model for those passes.                                                                           |
| `ARGUS_PORT`                | `7777`                                 | HTTP/WS port.                                                                                     |
| `ARGUS_HOST`                | `127.0.0.1`                            | Bind interface. A non-loopback bind **requires** `ARGUS_TOKEN` — Argus exits otherwise.           |
| `ARGUS_TOKEN`               | _(unset)_                              | Bearer token required on every request when set.                                                  |
| `ARGUS_ALLOWED_HOSTS`       | _(none)_                               | Extra Host values to accept (behind a proxy).                                                     |
| `ARGUS_ALLOWED_ORIGINS`     | _(none)_                               | Extra Origins to accept for cross-origin browser requests.                                        |
| `ARGUS_MAX_CONCURRENT_RUNS` | `4`                                    | Cap on concurrently spawned pipeline steps.                                                       |
| `ARGUS_SCHED_TICK_MS`       | `30000`                                | Scheduler / reconcile tick interval.                                                              |
| `ARGUS_WEBHOOK_URL`         | _(unset)_                              | POST target for failure + monitor alerts (Slack, mail, …).                                        |

## Data sources

Under `~/.claude` unless noted:

| Source            | Path                                           | Feeds                                 |
| ----------------- | ---------------------------------------------- | ------------------------------------- |
| Background agents | `jobs/<short>/state.json`, `timeline.jsonl`    | status, tempo, progress, results      |
| Live workers      | `daemon/roster.json`, `daemon.status.json`     | which agents are alive right now      |
| Transcripts       | `projects/<proj>/<session>.jsonl`              | Sessions list + full transcript view  |
| Codex transcripts | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | the same list, view and search        |
| Prompt history    | `history.jsonl`                                | global activity feed                  |
| Tasks             | `tasks/<id>/`                                  | task-queue metadata                   |
| Argus schedules   | `argus/schedules.json`                         | Scheduler triggers + run history      |
| Argus pipelines   | `argus/pipelines.json`, `argus/instances/`     | multi-phase pipeline defs + instances |

**Argus's Scheduler** fires its own headless runs (`claude -p`, `codex exec`,
`opencode run` or `qwen`)
on interval / daily / weekly triggers (see the Scheduler tab — create, run-now,
history).
This is distinct from Claude Code's **native cron routines**, which are
session-scoped (harness-managed, visible only via `CronList` inside a live
Claude session) and are **not** stored on disk; Argus, a disk reader, cannot
surface those — the Cron tab explains why.

## API

Full request/response detail lives in [docs/API.md](docs/API.md). The surface
in brief:

| Group             | Endpoints                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health / setup    | `GET /api/health`, `GET /api/runtimes`, `GET /api/setup`, `POST /api/setup/apply`                                                                                                                                                             |
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
