# Configuration and data sources

[Reference](README.md) · [Documentation home](../README.md) · [Getting started](../getting-started/README.md) · [Guides](../guides/README.md)

Set environment variables in the process that starts Argus. A running server retains its startup environment; changing another terminal's variables does not reconfigure it. The development UI and server use different ports; production serves both on the server port. See [Operations](operations.md).

## Server and security

These values are parsed by [server/src/config.ts](../../server/src/config.ts).

| Variable                    | Default     | Meaning                                                                                                                                                                  |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ARGUS_PORT`                | `7777`      | HTTP and WebSocket port. `argus --port <n>` overrides it for the launched server.                                                                                        |
| `ARGUS_HOST`                | `127.0.0.1` | Bind interface. A non-loopback bind requires a nonempty `ARGUS_TOKEN`; otherwise startup refuses.                                                                        |
| `ARGUS_TOKEN`               | Unset       | Shared control-plane credential. API clients can send `Authorization: Bearer <token>` or `x-argus-token`. The browser can instead use its authenticated account session. |
| `ARGUS_ALLOWED_HOSTS`       | Empty       | Additional accepted Host values, comma separated, for example a reverse proxy hostname.                                                                                  |
| `ARGUS_ALLOWED_ORIGINS`     | Empty       | Additional accepted browser Origins, comma separated. Include scheme and port where needed.                                                                              |
| `ARGUS_MAX_CONCURRENT_RUNS` | `4`         | Limit on concurrently spawned pipeline steps.                                                                                                                            |
| `ARGUS_SCHED_TICK_MS`       | `30000`     | Scheduler and pipeline reconciliation interval in milliseconds; minimum accepted value is `1000`.                                                                        |
| `ARGUS_WEBHOOK_URL`         | Unset       | Outbound JSON POST destination for failure and monitor alerts. Configure only a destination you intend to receive those alerts.                                          |

Numeric settings require finite integers above their minimum. Invalid values produce a warning and fall back to the default. The launcher validates `--port` against `1–65535`; the server's environment parser only checks the positive integer minimum. Host and Origin lists are trimmed and lowercased.

Loopback is the default because Argus can execute agents using the local user's credentials. [Security middleware](../../server/src/security.ts) checks Host headers to resist DNS rebinding, and checks Origin on mutating requests to resist cross-origin actions. The WebSocket upgrade applies the same boundary.

The shared token is one layer of authentication. [Account sessions](../../server/src/auth.ts) provide a separate cookie-based login; pipeline edits, starts, approvals, revisions and aborts require an active account even when the caller has `ARGUS_TOKEN`. User administration requires the root role. Sessions are held in memory, so a restart logs users out. See [Authentication troubleshooting](operations.md#authentication-and-browser-access).

There are scoped exceptions to the shared-token gate:

- Account status, setup, registration, login and logout routes must be reachable to establish a session. Their mutating requests still undergo Origin checks.
- Pipeline completion signals authenticate with the run's own signal token. A shared control-plane token does not authorize a completion report.
- `POST /api/hooks/{pipelines,schedules}/:id` authenticates with that definition's `hookToken`. These inbound webhook routes skip the browser Origin check, but retain the Host allowlist. `ARGUS_TOKEN` never replaces their hook token.

Remote webhook delivery requires a reachable bind, the token required for that bind, and an accepted Host value. The webhook sender uses the definition's token. Rotate a leaked token through `POST /api/{pipelines,schedules}/:id/hook-token/rotate`; the old token then stops working. See the [API](../API.md) for contracts and permissions. Remote federation peers also require a pairing secret; startup rejects an unpaired peer outside loopback.

## Homes and work storage

`~` here means the OS user's home returned by `os.homedir()`, such as `C:\Users\<user>` on Windows. Use an actual path in environment variables; the path resolvers do not implement shell `~` expansion. Relative overrides resolve against Argus's process working directory.

| Variable              | Default / fallback                                                               | Meaning                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARGUS_CLAUDE_HOME`   | `CLAUDE_CONFIG_DIR`, then `~/.claude`                                            | Claude state read by Argus; Argus stores its own state in its `argus/` subdirectory, including on Codex-only installations.                                                     |
| `ARGUS_WORK_DIR`      | Sibling of Claude home named `<home-basename>-argus`; normally `~/.claude-argus` | Worktrees, artifacts, memory and result/ledger staging channels written by agents. Keep it outside Claude home, whose protected directories Claude refuses to write headlessly. |
| `ARGUS_CODEX_HOME`    | `CODEX_HOME`, then `~/.codex`                                                    | Codex state Argus reads and hook location.                                                                                                                                      |
| `ARGUS_OPENCODE_HOME` | `$XDG_DATA_HOME/opencode`, then `~/.local/share/opencode`                        | OpenCode data home; distinct from its configuration directory.                                                                                                                  |
| `ARGUS_QWEN_HOME`     | `~/.qwen`                                                                        | Qwen state Argus reads and hook location. Qwen itself has no matching environment override.                                                                                     |

An Argus home override changes where Argus reads and installs hooks; it does not necessarily relocate the CLI's own state. Point both at the same actual installation when running agents. For Claude/Codex, the explicit Argus variable takes precedence over the native fallback variable when present; an explicitly blank Argus override resolves to the ordinary OS default.

OpenCode configuration is resolved separately: `OPENCODE_CONFIG_DIR`, then `$XDG_CONFIG_HOME/opencode`, then `~/.config/opencode`; the provider catalogue is `opencode.json` there. See [Local models](runtimes.md#local-models).

Sources: [Claude and work paths](../../server/src/claudeHome.ts), [Codex paths](../../server/src/codexHome.ts), [OpenCode paths](../../server/src/opencodeHome.ts), [Qwen paths](../../server/src/qwenHome.ts).

## Runtime selection and invocation

| Variable                | Default           | Meaning                                                                                                                                                               |
| ----------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ARGUS_AGENT`           | `claude`          | Default runtime: `claude`, `codex`, `opencode` or `qwen`. The launcher also accepts `--agent <id>`. Invalid environment values warn and fall back to Claude.          |
| `ARGUS_CLAUDE_BIN`      | `claude`          | Claude Code executable.                                                                                                                                               |
| `ARGUS_CODEX_BIN`       | `codex`           | Codex executable.                                                                                                                                                     |
| `ARGUS_OPENCODE_BIN`    | `opencode`        | OpenCode executable.                                                                                                                                                  |
| `ARGUS_QWEN_BIN`        | `qwen`            | Qwen Code executable.                                                                                                                                                 |
| `ARGUS_CODEX_SANDBOX`   | `workspace-write` | Codex sandbox: `read-only`, `workspace-write` or `danger-full-access`. An invalid value warns and falls back. Capability profiles can override the ordinary run mode. |
| `ARGUS_CLAUDE_ARGS`     | Empty             | Additional arguments for ordinary Claude runs.                                                                                                                        |
| `ARGUS_CODEX_ARGS`      | Empty             | Additional arguments for Codex runs; incompatible extras are refused during enforced read-only execution.                                                             |
| `ARGUS_OPENCODE_ARGS`   | Empty             | Additional arguments for OpenCode runs.                                                                                                                               |
| `ARGUS_QWEN_ARGS`       | Empty             | Additional arguments for Qwen runs, including an explicitly chosen `--sandbox`.                                                                                       |
| `ARGUS_CODEX_MODELS`    | Empty             | Comma-separated aliases added to the built-in Codex picker.                                                                                                           |
| `ARGUS_OPENCODE_MODELS` | Empty             | Comma-separated `<provider>/<model>` identifiers for the OpenCode picker; otherwise model entry is free text.                                                         |
| `ARGUS_QWEN_MODELS`     | Empty             | Additional comma-separated Qwen aliases. `OPENAI_MODEL` leads the picker when set.                                                                                    |

Extra-argument strings support simple single/double quoting via [extraArgs](../../server/src/runtimes/types.ts); they are not shell programs. Do not use shell operators or expansions. [Runtime adapters](../../server/src/runtimes/) construct arguments, put user prompts on stdin and report capabilities they cannot enforce. See [Runtime differences](runtimes.md).

Runtime selection is step → phase → pipeline (or schedule/launch selection) → process default → Claude. A candidate's explicit variant runtime takes precedence over its step. Changing the default does not rewrite stored definitions, but definitions without an explicit runtime inherit that process default when launched. With no `ARGUS_AGENT`, that is Claude. Set an explicit runtime on a definition when its CLI choice must stay pinned. Each run records its actual runtime. See [registry](../../server/src/runtimes/index.ts), [schedule launch](../../server/src/scheduler.ts) and [pipeline launch](../../server/src/engine/launch.ts).

## Analysis and experiments

| Variable                     | Default                                                      | Meaning                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ARGUS_ANALYSIS`             | Enabled unless `off`                                         | `off` disables model analysis passes, including the shadow experiments. Ordinary analysis is distinct from experimental collection. |
| `ARGUS_ANALYSIS_RUNTIME`     | `ARGUS_AGENT` / process default                              | CLI for bounded autopsy, verdict, diagnose and plan passes. Invalid values use the default runtime.                                 |
| `ARGUS_ANALYSIS_MODEL`       | `haiku` for Claude; CLI default for Codex, OpenCode and Qwen | Explicit model for analysis passes.                                                                                                 |
| `ARGUS_DECISIONS`            | Off                                                          | Master switch required by Decision Plane background collection.                                                                     |
| `ARGUS_DECISIONS_H2_COLLECT` | Off                                                          | H2 run-outcome shadow collection; also requires the master switch.                                                                  |
| `ARGUS_DECISIONS_H1_COLLECT` | Off                                                          | H1 operator-action shadow collection; also requires the master switch.                                                              |

H1 and H2 share an allowance and do not change gate decisions or Knowledge Ledger support. Their default collection limits are 20 combined calls per rolling 24 hours, at least 15 minutes between calls, and $1 recorded cost per rolling 24 hours; H1 also limits its own calls to 10. Unknown possibly incurred spend blocks later admission rather than proving a zero-dollar call. These are admission controls, not a demonstrated hard monetary cap on an in-flight invocation.

The detailed experiment knobs remain documented in [User Guide §32–33](../USER-GUIDE.md#32-decision-experiments-h2-shadow), with authoritative parsing in [H2 config](../../server/src/decision/h2/config.ts) and [H1 config](../../server/src/decision/h1/config.ts). Reading retained journal assessments makes no model call; requesting a new assessment does. Keeping these switches off is the default. This reference does not authorize experimental provider calls.

Decision Ledger production consumers have additional prerequisites beyond a switch: fresh account/model support, exclusive fenced ownership, durable common atomic accounting, explicit reservation lifetime/revocation, reviewed exact input bytes and recovery/rollback drills. The [development report](../argus/decision-ledger-development/report.md) distinguishes offline verification from live readiness. Production startup currently does not configure the optional advisory reader; the advisory seam returns `503` without that dependency. Offline or staged changes do not establish the identity or behavior of an already running build.

Sources: [analysis runner](../../server/src/sources/analysis.ts), [startup wiring](../../server/src/index.ts), [advisory API wiring](../../server/src/app.ts).

## Data sources and ownership

Paths below are relative to the configured Claude home unless another home is shown.

| Source                       | Path                                                                                       | Used for                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Background agents            | `jobs/<short>/state.json`, `jobs/<short>/timeline.jsonl`                                   | Status, tempo, progress and results                                          |
| Live workers                 | `daemon/roster.json`, `daemon.status.json`                                                 | Worker presence and daemon state                                             |
| Claude transcripts           | `projects/<project>/<session>.jsonl`                                                       | Sessions list and transcript detail                                          |
| Codex transcripts            | `<codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl`, plus `archived_sessions/`               | Translated Sessions list, detail and search                                  |
| Qwen transcripts             | `<qwenHome>/projects/<project>/chats/<session>.jsonl`                                      | Translated Sessions list, detail and search                                  |
| OpenCode sessions            | `<opencodeHome>/opencode.db`                                                               | Private SQLite schema; Argus does not provide transcript browsing            |
| Prompt history               | `history.jsonl`                                                                            | `GET /api/activity` (API)                                                    |
| Tasks                        | `tasks/<id>/`                                                                              | `GET /api/tasks` (API)                                                       |
| Schedules                    | `argus/schedules.json`                                                                     | Argus triggers and run history                                               |
| Pipelines and instances      | `argus/pipelines.json`, `argus/instances/`                                                 | Definitions and durable instance records                                     |
| Runs and transitions         | `argus/runs/`, `argus/transitions/`, `argus/invocations/`                                  | Execution history, diagnostic integrity and invocation provenance            |
| Argus user/application state | `argus/users.json`, budget/spend/knowledge files, `vault.sqlite` and other `argus/` stores | Accounts and retained product data; preserve the entire directory for backup |
| Agent writable outputs       | `<argusWorkRoot>/`                                                                         | Artifacts, result channels, worktrees, pipeline memory and ledger staging    |

CLI jobs, histories and transcripts are read-only input to Argus. Argus owns its application stores and, during setup, writes hook files and registrations in the configured CLI homes. Setup runs automatically on server startup; starting Argus is therefore not a wholly read-only operation. See [Operations](operations.md#missing-cli-authentication-or-hooks).

Sessions use OS home resolution and encoded project-directory names, including transcripts originating on another OS; embedded foreign-machine absolute paths do not override the local data root. Argus's scheduler creates its own headless CLI runs on interval, daily and weekly triggers, with additional webhook and after-pipeline triggers. Claude's native cron routines are session-scoped and not stored as readable disk files: Argus cannot enumerate them. `GET /api/cron` explains that limitation.

For coherent backups, include both Argus application state and the work root; copying only `schedules.json` omits instances, evidence and output provenance. See [Backup and restore](operations.md#backup-and-restore).
