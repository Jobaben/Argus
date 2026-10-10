# Operations and troubleshooting

[Reference](README.md) · [Documentation home](../README.md) · [Getting started](../getting-started/README.md) · [Guides](../guides/README.md)

Use this page to establish which process, build, configuration and state directory you are inspecting before changing anything. The commands shown are instructions for an operator; documentation changes alone do not start or reconfigure a service.

## Startup and build identity

Argus requires Node 22 or newer. In a checkout, install dependencies with `npm ci`. There are two serving modes:

| Mode               | Command                           | Browser URL             | Behavior                                                                                       |
| ------------------ | --------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| Development        | `npm run dev`                     | `http://localhost:5757` | Vite web development server on 5757 proxies API/WS requests to the Node server, normally 7777. |
| Production build   | `npm run build`, then `npm start` | `http://127.0.0.1:7777` | Compiled server serves UI and API on one port.                                                 |
| Checkout launcher  | `node bin/argus.mjs --open`       | `http://127.0.0.1:7777` | Ensures build artifacts exist, then starts compiled production server.                         |
| Installed launcher | `argus --open`                    | `http://127.0.0.1:7777` | Same behavior, using the installed package's checkout/build.                                   |

The launcher builds only when `web/dist/index.html` or `server/dist/index.js` is missing, or when you pass `--rebuild`. It does not compare source timestamps. After source changes, rebuild the intended checkout and restart its server deliberately; `npm start` runs the existing compiled server. Another checkout, global installation or already running process may serve a different build. A successful offline check or staged diff does not prove that the running service contains those changes.

Launcher flags: `--open`, `--agent <claude|codex|opencode|qwen>`, `--port <n>`, `--rebuild`, `--version`, `--help`. The launcher passes environment variables to its child. Installing `argus` globally (`npm i -g .` or `npm link`) changes the user's command environment; a checkout launch avoids needing that installation. [Launcher source](../../bin/argus.mjs), [root scripts](../../package.json).

`--open` probes the loopback health endpoint and opens a loopback URL. A non-loopback-only bind, token-protected health route or startup taking over 20 seconds can make automatic opening time out even when the process is listening. Use the actual configured URL and browser login manually after inspecting the startup log.

## Port and connection problems

1. Read the server's `argus listening` log for the bind address, port and Claude home. Check whether you started development or production mode.
2. Confirm the intended port is reachable. Set `ARGUS_PORT` in the launching terminal, or use `node bin/argus.mjs --port 7780`. Do not terminate an unidentified process merely because it occupies a port.
3. For a custom development API port, start both development processes with the same `ARGUS_PORT`; [web/vite.config.ts](../../web/vite.config.ts) reads it for the proxy target while keeping the browser port at 5757. The proxy targets `localhost`, so a server bound only to another interface needs a deliberately adjusted development setup.
4. If HTTP works but live updates fail, inspect the browser's WebSocket request, login state, Origin and reverse-proxy upgrade handling.

Common startup errors are `EADDRINUSE` (port occupied), `EACCES` (binding permission) and `EADDRNOTAVAIL` (the requested address is not assigned locally). [config.ts](../../server/src/config.ts) formats actionable startup messages. For local-only use, retain `ARGUS_HOST=127.0.0.1`; exposing a bind without `ARGUS_TOKEN` is refused.

For read-only API inspection using an already configured token:

```powershell
$argusHeaders = @{}
if ($env:ARGUS_TOKEN) { $argusHeaders.Authorization = "Bearer $env:ARGUS_TOKEN" }
Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/health' -Headers $argusHeaders
Invoke-RestMethod -Uri 'http://127.0.0.1:7777/api/setup' -Headers $argusHeaders
```

```bash
# Tokenless local default:
curl --fail http://127.0.0.1:7777/api/health
# If this server has a token configured:
curl --fail -H "Authorization: Bearer $ARGUS_TOKEN" http://127.0.0.1:7777/api/setup
```

These reads inspect health/setup; they do not exercise a provider or prove a pipeline can execute.

## Authentication and browser access

The bundled browser UI logs in with an Argus account. It does not provide a field for pasting the shared `ARGUS_TOKEN`; setting a URL query token or localStorage value is not the supported authentication flow. With a token configured, an authenticated account session satisfies the network gate for browser API requests and the WebSocket upgrade. Account bootstrap routes are reachable to create that session.

If the UI requests initial account setup, use its registration/setup flow. If an installation already has users, a newly registered account may need root approval before it can log in; see [Administration](../guides/administration.md). Account sessions use an HttpOnly cookie and expire; restarting Argus also clears its in-memory session table. Log in again after restart.

Pipeline mutation, starts and gate actions require an account session independently of the shared bearer token. A CLI/API call with only `ARGUS_TOKEN` can therefore pass the network gate and still receive `auth_required` or `auth_setup_required`. User administration is root-only. [Routes](../../server/src/app.ts), [account middleware](../../server/src/auth.ts), [browser auth hook](../../web/src/useAuth.ts).

For remote/proxied access, accepted Host values are loopback names plus `ARGUS_ALLOWED_HOSTS`; setting `ARGUS_HOST` does not automatically allow that address as a request Host. Origins are checked separately. A `403 host not allowed` or `403 cross-origin request rejected` is different from a `401` authentication error. Configure only the actual intended proxy hostname and browser Origin. See [Configuration security](configuration.md#server-and-security).

## Missing CLI, authentication or hooks

Setup checks the default runtime and runtimes referenced by stored schedules/pipelines, including phase and step overrides. It does not require every supported CLI to be installed. Selecting Codex as the default avoids a Claude dependency for a genuinely Codex-only configuration; an existing definition that names Claude still needs Claude.

Check executables in the same account and terminal environment used to start Argus:

```powershell
Get-Command claude,codex,opencode,qwen -ErrorAction SilentlyContinue
# Run only the version command for the runtime you intend to use:
codex --version
```

```bash
command -v claude codex opencode qwen
codex --version
```

A CLI found in your interactive terminal can be absent from an IDE, service or container process's PATH. Use the appropriate `ARGUS_*_BIN` override for an installed executable. Version/Setup checks do not establish provider credentials; authenticate the intended CLI using its own supported flow and account before expecting a headless run to succeed. Keep credentials out of pasted diagnostic logs.

Server startup automatically applies fixable prerequisites: application directories, canonical hook copies and hook registrations. The Setup banner reports missing/outdated items and offers **Apply fixes** for fixable ones. A missing CLI is not fixable through this button. [Startup](../../server/src/index.ts), [prerequisite checks](../../server/src/setup/prereqs.ts), [Setup UI](../../web/src/views/SetupBanner.tsx).

Claude and Qwen use Stop hooks in their respective `settings.json`; Codex setup appends `[[hooks.stop]]` in `config.toml`. Codex refuses an incompatible scalar `[hooks].stop` registration rather than rewriting TOML. Present but malformed settings also require investigation. Preserve the original config and inspect the reported error; do not replace the whole file with a minimal Argus example or delete another tool's configuration. OpenCode has no compatible command Stop hook and completes from its finished run record.

Hook location must match the CLI's actual home. An Argus-only directory override that points somewhere the CLI never reads can leave the hook invisible. The run's completion signal uses its scoped signal token and the configured server self URL. If a pipeline reports no completion signal, inspect the hook setup and run output before retrying; a zero process exit is not sufficient. [Hook implementation](../../hooks/argus-signal.mjs), [runtime differences](runtimes.md).

## Empty Sessions or missing history

First inspect the configured homes and ownership table in [Data sources](configuration.md#data-sources-and-ownership). A different OS account, container mount or `ARGUS_*_HOME` can produce an empty list without any data loss. Codex also honors `CODEX_HOME`; Claude honors `CLAUDE_CONFIG_DIR`; OpenCode separates data and config homes. Qwen's Argus override does not relocate Qwen itself.

Confirm the CLI has actually created transcripts in those paths. Claude uses `projects/<project>/<session>.jsonl`; Codex uses dated `sessions/` rollouts and archived rollouts; Qwen uses `projects/<project>/chats/`. Do not edit those CLI-owned transcripts to make discovery work. OpenCode transcript browsing is unavailable because its private SQLite schema is not a JSONL source; use retained run results and live activity instead.

Argus's own schedules and pipeline runs are different from Claude's native session cron routines. Native routines are not persisted in a disk source Argus can enumerate; an empty cron response is not evidence that a live Claude session has no routines. [Sessions guide](../guides/sessions-and-inventory.md).

## Run failure and analysis failure

A process exit, a task outcome and an analysis judgment answer different questions. Inspect the run's retained output, exit code, error envelope, completion signal, verification results and gate state. Do not treat a successful shell/tool event as proof that the entire agent process or task succeeded. Strict completion requires an unambiguous marker; configured verification supplies additional deterministic evidence. See [Harness](../HARNESS.md).

Autopsy/verdict/diagnose/plan invoke a separate bounded analysis process. Analysis can fail because it is disabled, busy, budget-blocked, timed out, exceeded its output cap, could not spawn, returned malformed/no output, exited nonzero, provided no exit code or reported a runtime failure. It rejects those execution failures before parsing an apparently favorable answer. Such a failure does not erase the original run's result or mean no provider cost occurred. [Analysis runner](../../server/src/sources/analysis.ts).

When a fix fails, preserve the error and re-diagnose from the new evidence before another attempt. Check the exact runtime, model, CLI environment, build and retained attempt; repeated retries on the same assumption can repeat the failure and incur additional cost. [Health and quality guide](../guides/health-and-quality.md).

## Unknown cost and budget coverage

`costUsd: null` means unknown, not free. Codex's `~` values are estimates from known token/model pricing; custom models can be unpriced. Qwen reports no dollar cost. The ordinary spend ledger sums known dollar values and cannot represent a provider invoice for unpriced calls. Budget scheduling holds operate against recorded spend and configured policy; they do not establish a universal hard cap covering external tools, unknown costs or in-flight runs. [Budget implementation](../../server/src/sources/budget.ts), [Budget guide](../guides/budget-and-history.md).

Experimental call admission is a separate concern: a possibly called result with unknown spend blocks subsequent rolling-budget admission. Do not convert an uncertain result to zero, remove its invocation identity or resend it to obtain a cleaner answer. The [Decision Ledger report](../argus/decision-ledger-development/report.md) records outstanding production fencing/accounting/permit and recovery prerequisites. H1/H2 collection is off by default; retained reading is distinct from requesting a new provider call. [Experiment guide](../guides/experiments.md).

## Terminal monitoring and gates

`argus tail` is a client of an already running server, not a second daemon. The checkout equivalent is `node bin/argus.mjs tail`. It shares the HTTP and WebSocket data used by the dashboard, turning change notifications into concrete status lines.

```text
argus tail                       # Snapshot, then live updates for 60 seconds
argus tail --for 0               # Snapshot only
argus tail --for 5m --until-idle  # Follow until idle or the time limit
argus tail --json                # One JSON object per line
argus tail --url http://127.0.0.1:7780 --for 0
```

The default URL uses loopback plus `ARGUS_PORT` (7777 when unset); `--url` selects another server. `ARGUS_TOKEN` or `--token` supplies its shared credential. `tail --help` lists every option. Per-tool activity streams for live pipeline steps; schedules and one-off runs show start/finish lines. In non-terminal output the follow window is bounded to 60 seconds by default.

The bundled `argus-tail` skill can be installed explicitly using `argus tail --install-skill`, with `=claude`, `=codex` or `=all` to select destinations. This writes agent skill directories; it is not necessary for reading the tail. Repository copies are [.claude/skills/argus-tail](../../.claude/skills/argus-tail/SKILL.md) and [.agents/skills/argus-tail](../../.agents/skills/argus-tail/SKILL.md).

Terminal gate commands are `argus approve <instanceId> [--phase <id>]` and `argus revise <instanceId> --note "<text>" [--phase <id>]`. These change pipeline state; review the evidence before choosing them. Both require an Argus account using `ARGUS_USER`/`ARGUS_PASSWORD` or an interactive prompt. The session lasts for that call and is not written to disk. A shared token alone does not grant gate authority. See the [Terminal guide](../guides/terminal.md) and [gate client](../../server/src/cli/gate.ts).

## Docker

The [Dockerfile](../../Dockerfile) builds the UI/server on Node 22 and runs compiled artifacts with production server dependencies. It defaults to `ARGUS_HOST=0.0.0.0` inside the container, `ARGUS_CLAUDE_HOME=/data/.claude` and `ARGUS_CODEX_HOME=/data/.codex`. It requires a token because of that bind, even if the published host port is loopback-only.

For an operator-managed local container using an existing token:

```powershell
if (-not $env:ARGUS_TOKEN) { throw 'Set the intended container token before launching.' }
docker build -t argus .
docker run --rm -p 127.0.0.1:7777:7777 `
  -e ARGUS_TOKEN `
  --mount "type=bind,source=$HOME/.claude,target=/data/.claude" `
  argus
```

```bash
: "${ARGUS_TOKEN:?Set the intended container token before launching.}"
docker build -t argus .
docker run --rm -p 127.0.0.1:7777:7777 \
  -e ARGUS_TOKEN \
  --mount "type=bind,source=$HOME/.claude,target=/data/.claude" \
  argus
```

The Claude mount must exist. This writable mount includes Argus state and allows startup setup to attempt changes under the mounted home. Mount the intended Codex home at `/data/.codex` only if needed; configure Qwen/OpenCode homes separately. Map an explicit persistent `ARGUS_WORK_DIR` volume when retaining writable artifacts/worktrees across `--rm` container removal.

The shipped image does not install Claude, Codex, OpenCode or Qwen CLIs, provider credentials, repository workspaces or a model server. Its final stage also does not copy the repository `hooks/` directory used as setup's canonical hook source, so this image alone cannot establish fully functioning hook setup. Hosting the dashboard in Docker is not proof that its scheduler can run agents. A missing mounted Codex directory simply has no Codex sessions to discover.

Agent container containment is not implemented by Argus's harness. Running the Argus server in a container is different from isolating each agent run, and neither removes the consequences of granting mounts or credentials. Validate a deliberately configured image, hook source, CLI environment and repository mounts separately before relying on execution. The documentation reorganization has not launched or validated a live container.

## Backup and restore

For a coherent backup, arrange an operator maintenance window: let active runs finish or deliberately abort them, then stop the Argus process/container and confirm it is stopped before copying state. Prevent concurrent agent writers to retained worktrees/channels during the copy. Preserve these items together:

- The entire `<claudeHome>/argus/` application directory, including definitions, runs, instances, transition logs, invocation records, accounts, knowledge, budgets, journals/snapshots and SQLite vault files or sidecars present in the stopped snapshot.
- The actual `ARGUS_WORK_DIR` root, including artifacts, memory, per-run staging and worktrees. Isolated Git worktrees depend on their repository's Git metadata; preserve the associated repository or use a Git-aware backup strategy as well.
- The configured source repositories and relevant CLI homes/configuration when the recovery scope includes transcripts and hook registrations. Keep credentials and account stores protected.
- The effective environment/path settings, Argus version and build/checkout identity needed to interpret the snapshot.

A restore is an explicit operator action: retain the pre-restore state, keep the target server stopped, restore the matching application/work snapshot and compatible repository metadata, then inspect definitions, pending instances and stored paths before resuming execution. Use appropriate ownership and permissions. Do not mix individual historical stores with current instances or alter CLI-owned transcripts/config files to force agreement.

Argus adopts retained runs on startup. A restored pending/running record may need investigation before execution is allowed to resume; do not restore into an actively executing installation. Saved instance state is the recovery authority; transition logs provide diagnostics and are not replayed as permission to execute effects. Knowledge or decision records with uncertain outcome remain uncertain; recovery must not resend a possibly incurred provider invocation.

This is a storage checklist, not evidence of a completed recovery drill. Production Decision Ledger canary, recovery, disable and rollback drills remain unproven as recorded in the [development runbook](../argus/decision-ledger-development/runbook.md) and [report](../argus/decision-ledger-development/report.md).
