# Install and start Argus

[Documentation index](../README.md) · [First run](first-run.md) · [Feature guides](../guides/README.md)

Argus runs on your computer and starts installed agent CLIs on your behalf. This guide takes you from a source checkout to a local dashboard, then prepares you to launch work. You can use one runtime without installing the other three.

## Prerequisites

| Requirement                                                  | Check                                     | Expected result                                                   |
| ------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------- |
| Node.js **22 or newer**                                      | `node --version`                          | `v22.x` or a later major version                                  |
| npm                                                          | `npm --version`                           | A version number                                                  |
| Git, to obtain the source                                    | `git --version`                           | A version number                                                  |
| One supported agent CLI                                      | Run its version command below             | The CLI starts successfully in the terminal that will start Argus |
| Working provider authentication or local model configuration | Run a small prompt directly with that CLI | A response without a login, credential, or model error            |

Argus uses the current operating-system user's CLI configuration and credentials. Signing in to the Argus dashboard does **not** sign in to an agent provider. Finish the chosen CLI's own installation and authentication first; [Runtime reference](../reference/runtimes.md) explains the four adapters and local model configuration.

| Runtime      | CLI check            | Argus runtime ID |
| ------------ | -------------------- | ---------------- |
| Claude Code  | `claude --version`   | `claude`         |
| OpenAI Codex | `codex --version`    | `codex`          |
| OpenCode     | `opencode --version` | `opencode`       |
| Qwen Code    | `qwen --version`     | `qwen`           |

Have a writable user home and an existing project directory available. Run Argus as the user whose agent sessions you want to see. A fresh installation can have empty history views; an empty view does not mean the server failed.

## 1. Obtain the source and install dependencies

Use the repository URL supplied by your team or repository host. Replace `<repository-url>` below with that URL. These commands work in PowerShell 7 and Bash:

```sh
git clone "<repository-url>" Argus
cd Argus
npm ci
```

If you already have a checkout, open a terminal in its root, where `package.json` and `bin/argus.mjs` live, and run `npm ci` there. Keep the terminal in that directory for the commands in this guide.

**Expected result:** dependencies install using the committed lockfile. Argus does not need a global npm installation or an `argus` command on your PATH.

## 2. Start the dashboard with your runtime

For Codex:

```sh
node bin/argus.mjs --agent codex --open
```

Choose the matching command if you use another runtime:

```sh
node bin/argus.mjs --agent claude --open
node bin/argus.mjs --agent opencode --open
node bin/argus.mjs --agent qwen --open
```

Run **one** of these commands. The launcher builds the web UI and server if either build is missing, starts both on one port, and opens the browser after the server answers its health check. The first build can take longer than subsequent starts.

**Expected result:** the terminal reports `argus listening`, and the dashboard opens at <http://127.0.0.1:7777>. Keep that terminal running. If the browser does not open automatically, visit that address yourself.

The default runtime is Claude Code unless you choose `--agent` or set `ARGUS_AGENT`. Choose your installed runtime explicitly, particularly on a Codex-only machine. You can still choose a different runtime for a later launch, schedule, pipeline, phase, or step.

### Production and development addresses

| Start command                             | Dashboard               | API                                                  | Intended use                                                               |
| ----------------------------------------- | ----------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `node bin/argus.mjs --agent codex --open` | `http://127.0.0.1:7777` | Same address, under `/api`                           | Normal use from the source checkout; launcher checks for a build           |
| `npm run build`, then `npm start`         | `http://127.0.0.1:7777` | Same address                                         | Explicit production build and start; set `ARGUS_AGENT` to choose a runtime |
| `npm run dev`                             | `http://localhost:5757` | Server on port `7777`; Vite proxies `/api` and `/ws` | Working on Argus source; see [Development](../development/README.md)       |

The production launcher defaults to loopback. The development web server has a different bind configuration; use the development instructions when working on Argus itself.

### Optional: choose another port or set environment variables

If port 7777 is occupied:

```sh
node bin/argus.mjs --agent codex --port 7788 --open
```

The dashboard and API will both be at `http://127.0.0.1:7788`. Environment variable syntax depends on your shell.

**PowerShell 7:**

```powershell
$env:ARGUS_AGENT = "codex"
$env:ARGUS_PORT = "7788"
node bin/argus.mjs --open
```

**Bash:**

```bash
ARGUS_AGENT=codex ARGUS_PORT=7788 node bin/argus.mjs --open
```

PowerShell assignments remain set for that terminal session; Bash's inline assignments apply to this command. Command-line `--agent` and `--port` override their environment equivalents. See [Configuration](../reference/configuration.md) for home directories, executable overrides, model lists, and remote access.

## 3. Check the server and setup

For the default local configuration, open <http://127.0.0.1:7777/api/health>. Use your chosen port if you changed it. The JSON should include `"ok": true`, `"service": "argus"`, the version, and the watched Claude and Codex home paths. This confirms the HTTP server is responding; it does not prove your agent credentials work.

At startup, Argus automatically attempts the fixable setup checks. This creates its data directories and installs or refreshes applicable signal hooks in the selected runtime's user configuration:

| Runtime     | Setup integration                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | Copies `argus-signal.mjs` into the Claude hooks directory and registers Stop and AskUserQuestion PreToolUse hooks in `settings.json` |
| Codex       | Copies the hook into the Codex hooks directory and appends the Argus `[[hooks.stop]]` registration to `config.toml`                  |
| Qwen Code   | Copies the hook into the Qwen hooks directory and registers a Stop hook in `settings.json`                                           |
| OpenCode    | Checks the CLI; no command hook is installed, and pipeline completion is read from the finished run                                  |

Argus's own schedules, pipeline definitions, run records, and account records are stored under `~/.claude/argus/` by default, even when you choose Codex. Runtime home overrides and the separate pipeline work directory are described in [Configuration](../reference/configuration.md).

**Expected result:** no **Setup incomplete** banner remains. `GET /api/setup` should report `ok: true`. Checks apply to the default runtime and runtimes named by saved schedules or pipelines; unused runtimes are marked as not checked. Setup checks Node and the relevant CLI, data directories, hooks, and parseable configuration files. It does not authenticate the provider.

If a banner remains, read its per-check detail. **Apply fixes** retries automatic repairs. Install or fix a missing CLI yourself; repair malformed JSON/TOML rather than replacing your configuration blindly. Recheck setup after changing or upgrading a runtime. Argus refuses to append Codex hooks when an existing scalar `stop` key under `[hooks]` conflicts with the required table.

## 4. Create the Argus account for pipeline controls

Open **Pipelines** at `#/pipelines`. On a fresh installation, choose **Create the root account**, supply a username and password of at least eight characters, and select **Create & sign in**. Create the first account from the machine running Argus; the server enforces a local-only bootstrap.

For an existing installation, sign in with an existing account or request one and wait for root approval. The root account manages users; approved members can edit and run pipelines. Pipeline creation, edits, starts, and gate decisions require a signed-in, approved account. See [Administration](../guides/administration.md) for the account flows.

Agent-provider credentials, the Argus account, and an optional `ARGUS_TOKEN` are separate credentials. If you configured `ARGUS_TOKEN`, the browser asks for an Argus login before loading protected dashboard data; API clients need the appropriate bearer token or session. Keep the default local configuration for this walkthrough.

## 5. Launch your first task

Continue with [Your first run](first-run.md). It uses a small, read-only README summary to show the launch form, run log, result, and cancellation controls without creating a recurring schedule.

## Stop and restart

Press **Ctrl+C** in the terminal that started Argus. The server stops accepting requests and stops ordinary scheduled and one-off processes. Pipeline step processes are designed to survive server restart; use the pipeline's **Abort** control if you intend to stop pipeline work. Closing a browser tab does not stop Argus or its runs.

Restart with the same launcher command. If you update Argus source and want a fresh production build, use:

```sh
node bin/argus.mjs --agent codex --rebuild --open
```

See [Operations](../reference/operations.md) for shutdown, restart, retained data, and troubleshooting.

## Troubleshooting

| Symptom                                                    | Next action                                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Node version rejected                                      | Install Node 22 or later; reopen the terminal and check `node --version`                                                         |
| `npm ci` or the build fails                                | Preserve the terminal error, check that you are in the checkout root, and consult [Development](../development/README.md)        |
| Port already in use                                        | Stop the process you intended to replace, or choose `--port 7788`                                                                |
| Browser opens no page                                      | Keep the terminal open, read its startup error, and check the correct production/development address                             |
| CLI check fails                                            | Run the reported executable's version command in the same terminal; check PATH or the runtime's `ARGUS_*_BIN` override           |
| Setup passes but a run reports authentication/model errors | Run that CLI directly as the same user with the same model and directory; setup only checks whether it launches                  |
| Pipeline edit/start asks for login                         | Create the local root account or sign in with an approved account                                                                |
| Sessions or history are empty                              | Confirm the watched home paths and that this user has created sessions; OpenCode has no readable Sessions transcript integration |
| Health request returns 401                                 | Check whether `ARGUS_TOKEN` is set and use your configured authentication; see [Configuration](../reference/configuration.md)    |

Implementation references: [launcher](../../bin/argus.mjs), [setup checks](../../server/src/setup/prereqs.ts), [startup and shutdown](../../server/src/index.ts), and [API authentication](../../server/src/app.ts). A successful setup check and a successful first agent run are separate verification steps.
