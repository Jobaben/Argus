# Agent runtimes

[Reference](README.md) · [Documentation home](../README.md) · [Getting started](../getting-started/README.md) · [Guides](../guides/README.md)

Argus launches installed agent CLIs and translates their output into shared run records and live activity. Install and authenticate the runtime you intend to use in the same user environment as Argus. Selecting a runtime or adding a model alias does not install a CLI, authenticate an account or establish model availability.

## Runtime differences

| Behavior                     | Claude Code                    | Codex                                   | OpenCode                               | Qwen Code                      |
| ---------------------------- | ------------------------------ | --------------------------------------- | -------------------------------------- | ------------------------------ |
| Runtime ID                   | `claude`                       | `codex`                                 | `opencode`                             | `qwen`                         |
| Headless command             | `claude -p`                    | `codex exec`                            | `opencode run`                         | `qwen` with piped stdin        |
| Prompt delivery              | stdin                          | stdin using final `-` placeholder       | stdin                                  | stdin                          |
| Result format                | `--output-format json`         | `--json` JSONL events                   | `--format json` NDJSON                 | `--output-format json`         |
| Pipeline live output         | `stream-json` plus `--verbose` | Same JSONL stream                       | Same NDJSON stream                     | `--output-format stream-json`  |
| Model override               | `--model`                      | `--model`                               | `--model <provider>/<model>`           | `--model`                      |
| Reasoning override           | CLI/model default              | `-c model_reasoning_effort=…`           | `--variant`                            | Model's own behavior           |
| Ordinary unattended tools    | CLI/profile policy             | `--sandbox`, normally `workspace-write` | `--auto`                               | `--approval-mode yolo`         |
| Completion signal            | `Stop` hook in `settings.json` | `[[hooks.stop]]` in `config.toml`       | Outcome marker read from completed run | `Stop` hook in `settings.json` |
| Argus instructions           | `--append-system-prompt`       | Prepended to stdin prompt               | Prepended to stdin prompt              | Prepended to stdin prompt      |
| Session ID                   | Argus supplies it              | CLI emits `thread.started`              | CLI emits `sessionID`                  | CLI emits `session_id`         |
| Sessions transcript browsing | Yes                            | Yes, translated                         | No: private SQLite schema              | Yes, translated                |
| Dollar cost                  | CLI-reported when available    | Estimated for supported models          | Event-reported when available          | Unknown (`null`)               |
| Analysis model default       | `haiku`                        | CLI default                             | CLI default                            | CLI default                    |

Source adapters: [Claude](../../server/src/runtimes/claude.ts), [Codex](../../server/src/runtimes/codex.ts), [OpenCode](../../server/src/runtimes/opencode.ts), [Qwen](../../server/src/runtimes/qwen.ts). The [registry](../../server/src/runtimes/index.ts) and [adapter contract](../../server/src/runtimes/types.ts) define the common seam. CLI behavior outside these constructed invocations depends on the installed CLI version and account.

All four can provide Command Center activity, Flight Recorder evidence, pipeline gates, retries, Chronicle history, monitors and issues. That shared interface does not imply identical permissions or disk storage. Capability profiles and environment policies map only where the selected CLI can enforce them; limitations are reported. Read the [Harness](../HARNESS.md) before relying on an isolation or tool restriction.

Only Claude accepts the preset Argus session ID. For the other runtimes, Argus patches the run record once the CLI emits its own identifier; transcript links may appear after execution starts. Codex rollouts and Qwen's Gemini-dialect chats are translated to the shared transcript shape on read. OpenCode's private SQLite sessions are not read back by Argus; its event stream still supplies live activity and run results.

OpenCode has a plugin extension surface rather than a compatible command Stop hook. Argus reads the final run's `ARGUS_OUTCOME` marker and advances on a reconciliation tick (`ARGUS_SCHED_TICK_MS`, normally 30 seconds). Missing hooks are therefore not an OpenCode setup defect.

## Choosing a runtime and model

The narrowest runtime choice wins: step → phase → pipeline, or the explicit schedule/launch selection, then `ARGUS_AGENT`, then Claude. A candidate's explicit variant runtime overrides its step's selection. Changing the process default does not migrate stored definitions, but a definition without an explicit runtime inherits that default at launch. Pin a runtime explicitly when changing the default must not affect an existing definition. A pipeline can draft on one runtime and review on another, and every run retains its actual runtime. Sources: [schedule launch](../../server/src/scheduler.ts) and [pipeline launch](../../server/src/engine/launch.ts).

For a Codex-first installation, launch from the checkout without requiring a global installation:

```powershell
# PowerShell 7
$env:ARGUS_AGENT = 'codex'
node bin/argus.mjs --open
```

```bash
export ARGUS_AGENT=codex
node bin/argus.mjs --open
```

The same launcher accepts `--agent codex`. For an installed `argus` command, substitute `argus --agent codex --open`. [Configuration](configuration.md#runtime-selection-and-invocation) lists executable, extra-argument and model-picker overrides. Setup checks the default and runtimes referenced by schedules/pipelines; a Codex-only machine does not need Claude merely to satisfy a runtime check.

Model picker entries are configuration, not account preflight. Extra aliases do not prove that a provider supports them or that your account can use them. Prefer a model already confirmed through your intended CLI environment.

## Local models

OpenCode and Qwen can use an OpenAI-compatible endpoint served by software such as `llama-server`, Ollama or vLLM. The endpoint must already be running and reachable from the Argus process. The examples below assume it serves a model identified as `qwen3-27b` at `http://127.0.0.1:8080/v1`; replace these values with the endpoint's actual model ID and authentication requirements.

### Qwen Code

Qwen reads `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL` from its environment. Set them before starting Argus so the child process inherits them.

```powershell
$env:OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
$env:OPENAI_API_KEY = 'sk-local' # Only for an endpoint configured to accept this value
$env:OPENAI_MODEL = 'qwen3-27b'
node bin/argus.mjs --agent qwen --open
```

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=sk-local # Only for an endpoint configured to accept this value
export OPENAI_MODEL=qwen3-27b
node bin/argus.mjs --agent qwen --open
```

`OPENAI_MODEL` leads Qwen's model picker; `ARGUS_QWEN_MODELS` adds aliases. Argus does not start or download a local model server. Qwen has no per-run reasoning-effort flag: the selected model determines that behavior.

Qwen container sandboxing is an explicit extra argument in `ARGUS_QWEN_ARGS`. A sandbox may not mount result/ledger channel paths or reach Argus's signal endpoint; the runtime reports those limits. Do not assume enabling it provides the same capabilities as a host run. See [Qwen capability mapping](../../server/src/runtimes/qwen.ts) and [Harness environment policies](../HARNESS.md).

### OpenCode

Declare a provider in the effective `opencode.json` configuration file, normally `~/.config/opencode/opencode.json`. Preserve the existing provider and other settings when adding it.

```json
{
  "provider": {
    "llama": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1",
        "apiKey": "sk-local"
      },
      "models": {
        "qwen3-27b": { "name": "Qwen3 27B Q5" }
      }
    }
  }
}
```

Use the provider/model ID to populate the Argus picker:

```powershell
$env:ARGUS_OPENCODE_MODELS = 'llama/qwen3-27b'
node bin/argus.mjs --agent opencode --open
```

```bash
export ARGUS_OPENCODE_MODELS=llama/qwen3-27b
node bin/argus.mjs --agent opencode --open
```

`ARGUS_OPENCODE_HOME` selects the data directory, not this provider config. Config precedence is `OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME/opencode`, then the OS home `.config/opencode` directory. [Path implementation](../../server/src/opencodeHome.ts).

An endpoint running on the host is not `127.0.0.1` inside a Docker container. Container networking and installed CLI/provider dependencies must be configured separately; see [Docker limits](operations.md#docker).

## Cost and outcome interpretation

Codex reports token usage rather than dollars. Argus estimates supported models using the price table in [codex.ts](../../server/src/runtimes/codex.ts); the UI prefixes estimated per-run cost with `~`. Those repository prices are estimates, not a current provider invoice. A custom model without a known price retains `costUsd: null`. Qwen also keeps cost null, even when it supplies token counts. Local serving has infrastructure cost that this field does not measure.

Pipeline success requires the completion protocol and configured verification, not merely a process returning zero. Strict completion expects one unambiguous `ARGUS_OUTCOME: succeeded` marker; the marker is the agent's report. Command/file/artifact/changed-files/trajectory verification can supply independent checks. Optional trajectory rubric holds can withhold automatic approval without changing knowledge authority. See [Harness](../HARNESS.md) and [Pipeline guide](../guides/pipelines.md).

Analysis is a separate invocation used to explain or assess evidence. It has bounded output, time and concurrency, and rejects nonzero exit, unavailable exit code or a runtime error before accepting a structured answer. A favorable-looking analysis response does not repair a failed run. See [Failure and analysis troubleshooting](operations.md#run-failure-and-analysis-failure).
