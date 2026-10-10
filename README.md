# Argus

Run and monitor coding agents from one local dashboard. Argus launches one-off tasks, repeats work on schedules, coordinates pipelines with human review, and keeps the history needed to explain their results. It supports Claude Code, Codex, OpenCode and Qwen Code, including local models through compatible runtimes.

**[Start with the documentation](docs/README.md)** — installation, a first-run tutorial, every feature, exact references and development status.

## Quick start

You need **Node.js 22 or newer**, npm, and one installed agent CLI with working provider authentication or a configured local model. From this checkout's root:

```sh
npm ci
node bin/argus.mjs --agent codex --open
```

Replace `codex` with `claude`, `opencode` or `qwen` for your installed runtime. Run one server. The launcher builds missing artifacts and serves the dashboard and API at **http://127.0.0.1:7777**. Keep the terminal open. When updating an existing checkout, add `--rebuild` to avoid reusing an older production build.

Startup attempts automatic setup fixes, including applicable hook registration in the runtime's user configuration. Agent-owned jobs/transcripts are read-only; Argus writes its own state and setup integration. See [installation and setup](docs/getting-started/README.md) for shell-specific configuration, health checks, accounts and shutdown.

Then follow **[Your first run](docs/getting-started/first-run.md)** to launch a small README-summary task and inspect its retained output.

### The `argus` command (single port)

No global installation is required: `node bin/argus.mjs` is the checkout launcher. An optional `npm link` provides the `argus` shorthand on PATH. Use `node bin/argus.mjs --help` for flags. [Operations](docs/reference/operations.md) explains production versus development startup and rebuilding.

### Watching without a browser: `argus tail`

Against an already running server:

```sh
node bin/argus.mjs tail --for 0
node bin/argus.mjs tail --for 60s --json
```

The [terminal guide](docs/guides/terminal.md) also covers bounded live following and authenticated gate approval/revision. Tail does not start a server.

## Getting around

Use **Ctrl K / ⌘K** for the palette and **?** for shortcuts. Start with Briefing to catch up, Scheduler to launch work, and Command Center to inspect pipelines. The [feature map](docs/guides/README.md#feature-map) lists every destination and panel, including features under More.

| Task                                 | Guide                                                           |
| ------------------------------------ | --------------------------------------------------------------- |
| Run once or on a trigger             | [Scheduling](docs/guides/scheduling.md)                         |
| Coordinate steps and review gates    | [Pipelines](docs/guides/pipelines.md)                           |
| Inspect progress and history         | [Monitoring](docs/guides/monitoring.md)                         |
| Diagnose failures and assess quality | [Health and quality](docs/guides/health-and-quality.md)         |
| Manage cost and retained usage       | [Budget and history](docs/guides/budget-and-history.md)         |
| Search conversations and resources   | [Sessions and inventory](docs/guides/sessions-and-inventory.md) |
| Manage accounts or pair machines     | [Administration](docs/guides/administration.md)                 |

## Agent runtimes

Select a runtime explicitly for your first run. More specific step/phase/pipeline or schedule choices override the process default. Adding a model to a picker does not prove your account can use it.

The [runtime reference](docs/reference/runtimes.md) covers CLI behavior, model selection, transcript support, cost estimates and local OpenAI-compatible endpoints. OpenCode has no readable Sessions integration; Qwen dollar costs and unpriced custom models remain unknown.

### Configuration

[Configuration reference](docs/reference/configuration.md): all original runtime, home, model, security, scheduling and decision-experiment environment variables, their defaults and storage ownership.

### Security model

The production server binds to loopback by default. A non-loopback bind requires `ARGUS_TOKEN`; Host and Origin allowlists also apply. Pipeline mutations require an approved account independently of the network token. Read [operations and authentication](docs/reference/operations.md) before remote or Docker deployment.

## The harness

Pipelines support verification, capabilities, dependency graphs, artifacts, isolated worktrees, candidates, bounded context, memory, retries and optional trajectory checks. Agent completion, deterministic verification and human approval remain separate facts. Start with [pipeline recipes](docs/guides/pipelines.md#advanced-feature-recipes), then use the exact [harness protocols](docs/HARNESS.md).

## The Knowledge Ledger

The Knowledge Ledger records exact claim revisions, evidence, justifications and semantic provenance. Its workflows cover business-rule discovery, implementation conformance, change intent and targeted realization. The [Knowledge guide](docs/guides/knowledge.md) explains how to inspect and author these workflows; the [protocol reference](docs/KNOWLEDGE-LEDGER.md) defines their schemas and invariants.

## The Decision Journal and shadow experiments

The Decision Journal retains model assessments separately from knowledge and human decisions. Existing H1/H2 shadow experiments are opt-in: H1 predicts operator actions; H2 compares run predictions with defined references. Neither changes gate authority or knowledge support. See [Experiments](docs/guides/experiments.md).

New Decision Ledger advisory/invocation foundations have [offline development evidence and remaining production prerequisites](docs/development/README.md). Historical study pipelines are archived; retained reports do not prove live activation or calibration.

## Stack

- **contracts:** shared types for the HTTP/WebSocket boundary.
- **server:** Node.js and TypeScript, Hono HTTP API, filesystem readers/watchers, WebSocket updates and scheduler/pipeline engines.
- **web:** React, Vite and Tailwind; shared live resources and a defined motion system.

See [Architecture](docs/ARCHITECTURE.md), [web workspace](web/README.md) and the [contributor workflow](docs/development/README.md#working-on-argus).

## Data sources

Argus reads CLI-owned history under the configured runtime homes and keeps its own state under `<claudeHome>/argus/`. Agent-writable worktrees/artifacts use a separate work directory. The [ownership table](docs/reference/configuration.md#data-sources-and-ownership) and [data model](docs/DATA-MODEL.md) provide exact paths and formats.

## API

[API reference](docs/API.md) documents HTTP requests, WebSocket frames, authentication and errors. [Agent reading guide](docs/AGENT-GUIDE.md) maps AI tasks to their narrowest authoritative sources.

## Status

Use the [development status guide](docs/development/README.md), [changelog](CHANGELOG.md) and the actual running build when assessing availability. The [document catalog](docs/development/catalog.md) includes product docs, research, designs and dated validation evidence.
