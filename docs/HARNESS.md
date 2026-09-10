# Argus as a harness

Weave gave a pipeline a shape — a DAG of phases with dependencies, retries and
routing. This is about what happens _inside_ one phase's run: what Argus
launches, what it lets that process do, how it decides the process actually
succeeded, and what it writes down so a run can be explained (and reproduced)
after the fact. None of it is required — a phase that declares no
`capabilities`, no `checks` and no `timeoutSeconds` runs exactly as it always
did, on the CLI's own defaults.

The four pieces this document covers live in `server/src/harness/`:

- `invocation.ts` — resolves capabilities, asks the runtime to map them onto
  flags/config, applies the environment policy, and writes down what it did.
- `childEnv.ts` — the one place a child process's environment is assembled.
- `verification.ts` — Argus's own deterministic checks over a phase's work.
- the runtimes (`server/src/runtimes/*.ts`) — map the runtime-neutral
  `CapabilityProfile` onto one CLI's actual flags, and report what they
  couldn't.

Everything here is engine-owned and pipeline-transitions-pure: the engine
(`pipelineEngine.ts`) decides _when_ to launch, kill, verify and retry;
`pipelineTransitions.ts` only ever computes what a given signal or report
_means_ for the instance, with no I/O of its own. See
[ARCHITECTURE.md § The harness layer](ARCHITECTURE.md#the-harness-layer) for
how that split is drawn.

## 1. The execution model

```
PipelineRunner (pipelineEngine.ts)
  │
  │  startPhase(): a phase becomes ready
  ▼
resolve phase → step
  │  runtime  = narrowest wins: step.runtime ?? phase.runtime ?? pipeline.runtime ?? server default
  │  timeout  = narrowest wins: step.timeoutSeconds ?? phase.timeoutSeconds ?? none
  ▼
prepare invocation                              harness/invocation.ts — pure, no I/O
  │
  ├─ resolveCapabilities()                      merge by KEY, narrowest wins:
  │                                               { ...pipeline.capabilities,
  │                                                 ...phase.capabilities,
  │                                                 ...step.capabilities }
  │
  ├─ runtime.streamPlan({ capabilities })        → SpawnPlan { bin, args, stdin, env,
  │                                                            files, limitations }
  │                                               (claude.ts / codex.ts / opencode.ts / qwen.ts
  │                                                map the profile onto their own flags)
  │
  ├─ buildChildEnv(parentEnv, profile.env,       harness/childEnv.ts — the ONE place a
  │                plan.env, argusEnv)            child's environment is assembled
  │
  ├─ materialize config files                    settings.json / mcp.json, under
  │                                               ~/.claude/argus/invocations/<runId>/
  │
  └─ write AgentInvocationRecord                  ~/.claude/argus/invocations/<runId>/invocation.json
  │
  │  strict enforcement + an unenforceable capability → refuse to launch (see §2)
  ▼
spawn headless CLI                               detached process, prompt on stdin,
  │                                               stdout+stderr → one fd-backed log file
  ▼
completion                                       whichever the runtime has:
  │                                                 Stop hook POST /api/instances/:id/signal
  │                                                 ARGUS_OUTCOME marker, read on reconcile
  │                                                 (Codex: best-effort backstop; OpenCode: the
  │                                                  only protocol it has — see API.md)
  ▼
result contract validation                       a phase with a declared `result` validates
  │                                               the step's JSON against its schema
  ▼
deterministic checks ("verification")            harness/verification.ts — runChecks() over
  │                                               the phase's declared `checks`, only once
  │                                               every step has reported success
  ▼
gate?  ──yes──▶ awaiting-approval ──▶ approve / revise
  │no
  ▼
transition ("settle")                            pipelineTransitions.ts — pure; publishes
  │                                               artifacts, evaluates routes, decides status
  ▼
next phases (fan-out)  /  retry (scheduled, backoff)  /  failure (no more attempts)  /  instance done
```

Two things worth naming explicitly because they are easy to miss reading the
code phase by phase:

- **Preparation happens even for a step that never launches.** A capability
  the runtime cannot enforce under strict enforcement is caught in
  `prepareInvocation`, _before_ `deps.spawn` is ever called — the invocation
  record is still written, so "what would Argus have run, and why did it
  refuse" is answered by evidence, not by absence.
- **The engine, not the runtime, owns the environment policy and the
  deadline.** A runtime's `SpawnPlan.env` is one _layer_ `buildChildEnv`
  overlays; enforcement of `timeoutSeconds` (SIGTERM/SIGKILL) is the engine's
  own `setTimeout`/reconcile logic, identical for every runtime.

## 2. Agent completion ≠ phase success

A step's process exiting zero only means the CLI exited cleanly. Whether the
_phase_ succeeded is decided by a longer ladder, and every rung can fail the
phase under its own class:

```
process ends (exit code / OS signal)
        │                                     failureClassOfRecord(): pid==null → "spawn"
        │                                                              else      → "exit-code"
        ▼
agent's own completion signal arrives          Stop hook, or ARGUS_OUTCOME + reconcile fallback
        │                                     agent reported `failed`/`blocked` → "signal"
        ▼
declared result schema validated (if `result`) missing/unparseable/schema-invalid → "signal"
        │                                     (the agent reported, but nothing routable; classed
        │                                      with a bad route condition, under the same policy)
        ▼
deterministic checks run (if `checks`)         a failing CheckResult → "verification"
        │
        ▼
gate opens (if `gated`) or auto-approves
        │
        ▼
succeeded
```

`PhaseFailureClass` (in `@argus/contracts`) is the closed set:

| Class           | Meaning                                                                                                                                                                                          | Retried by default?                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `spawn`         | The process never started — preparing the invocation threw, or `deps.spawn` itself threw. `run.termination = "spawn-failed"`.                                                                    | **Yes**                                                 |
| `exit-code`     | The process ended (any way) without Argus's own timeout and without the agent signalling failure.                                                                                                | **Yes**                                                 |
| `signal`        | The agent's _own_ completion signal declared `failed` or `blocked` — it considered the work and reported on it. (Named for the pipeline `signal` the agent posts, **not** an OS process signal.) | No — opt in via `retry.retryOn`                         |
| `timeout`       | Argus killed the process at its `deadlineAt`.                                                                                                                                                    | No — opt in                                             |
| `verification`  | Every step reported success, but a `checks` entry failed.                                                                                                                                        | No — opt in                                             |
| `configuration` | The declared capability profile could not be enforced under strict enforcement — the step never launched with more capability than its author asked for.                                         | **Never** — the definition is what's wrong, not the run |

`RetryPolicy.retryOn` defaults to `["spawn", "exit-code"]` — the two classes
that plausibly reflect a transient infrastructure hiccup rather than a
considered verdict. An author who wants a flaky test suite retried opts
`"verification"` in explicitly; wanting a `"signal"` failure retried is asking
Argus to re-run a prompt whose own agent already decided it failed, which is
allowed but is rarely what you want.

A retried attempt is told why the previous one failed (`retryNote()` appends
the reason to the prompt) only for `"verification"` and `"signal"` — the two
classes that come with a considered reason worth repairing against;
`"spawn"`/`"exit-code"`/`"timeout"` carry nothing worth restating.

## 3. Capability profiles

`CapabilityProfile` (in `@argus/contracts`) is runtime-neutral: every key
means the same thing regardless of which CLI ends up running the step, and
each runtime maps what it can and reports the rest as a `limitations` string
on the invocation record.

| Key                     | Meaning                                                                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filesystem`            | `"read-only"` (no edits), `"workspace-write"` (edits confined to `cwd` + `additionalDirectories`), `"unrestricted"` (the CLI's own default).                                                                                                                                  |
| `tools`                 | `{ allow?, deny? }` tool-permission rules in the runtime's own grammar (e.g. Claude Code's `Bash(npm test:*)`, `Edit`, `mcp__docs__search`, `Skill(name)`).                                                                                                                   |
| `mcpServers`            | The MCP servers this invocation may use. **Absent** = whatever the CLI is already configured with. **Present — even `{}`** — means exactly these and no others, where the runtime can enforce it.                                                                             |
| `additionalDirectories` | Directories beyond `cwd` the agent may access. Each must already exist (absolute path) — validated at save time.                                                                                                                                                              |
| `settingSources`        | Claude-Code-only: which settings files it loads (`"user"`, `"project"`, `"local"`). Absent = the CLI's default (all three). Naming only `project`/`local` cuts the operator's _global_ settings — and their hooks, MCP servers and permission grants — out of the invocation. |
| `permissionMode`        | Claude Code's `--permission-mode` (`default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk`).                                                                                                                                                                         |
| `maxTurns`              | Cap on agentic turns, integer 1–1000, where the runtime supports one.                                                                                                                                                                                                         |
| `env`                   | An `EnvPolicy` — see §4.                                                                                                                                                                                                                                                      |
| `enforcement`           | `"strict"` (default) or `"best-effort"` — see below.                                                                                                                                                                                                                          |

A profile may be declared on the pipeline, a phase, or a step; they merge
**by key**, narrowest wins (`Object.assign({}, pipelineProfile, phaseProfile,
stepProfile)` — see `resolveCapabilities` in `harness/invocation.ts`), so a
pipeline can set an `env` policy once and one review phase can add
`filesystem: "read-only"` without restating the rest.

```jsonc
{
  "filesystem": "read-only",
  "tools": { "allow": ["Bash(npm test:*)", "Bash(npm run lint:*)"] },
  "mcpServers": {
    "docs": { "type": "stdio", "command": "docs-mcp", "args": ["--repo", "."] },
  },
  "additionalDirectories": ["/path/to/repo/../shared-notes"],
  "settingSources": ["project", "local"],
  "permissionMode": "default",
  "maxTurns": 40,
  "enforcement": "strict",
}
```

### How Claude Code maps a profile (`buildClaudeCapabilities` in `runtimes/claude.ts`)

- `filesystem: "read-only"` → `--disallowedTools` gets `Edit(//<cwd>/**)` and
  `Edit(//<dir>/**)` for every `additionalDirectories` entry, **plus** `Bash`
  itself — unless `tools.allow` already names specific `Bash(...)` rules, in
  which case only those survive and the bare rule is left alone. If
  `tools.allow` contains a **bare** `Bash` (or `Bash(*)` / `Bash(*:*)`) rule,
  Claude Code cannot be made read-only for shell commands at all — that is
  reported as its own limitation string rather than the generic one:
  `"read-only cannot prevent shell writes while Bash is allowed unrestricted"`.
- `tools.allow` / `tools.deny` → `--allowedTools` / `--disallowedTools`
  (comma-joined; a rule may not itself contain a comma).
- `mcpServers` (present, even `{}`) → written to
  `<invocationDir>/mcp.json` as `{ "mcpServers": {...} }`, passed as
  `--mcp-config <path> --strict-mcp-config`.
- `additionalDirectories` → one `--add-dir <dir>` per entry — **and** the
  phase's own artifact directory always gets an `--add-dir` too, regardless of
  `filesystem`, so a read-only step can still leave its declared artifacts.
- `settingSources` → `--setting-sources user,project,local` (only the ones
  named).
- `permissionMode` → `--permission-mode <mode>`.
- `maxTurns` → `--max-turns <n>`.
- Argus's own Stop/PreToolUse hooks (only ever registered when the phase
  declares a capability profile at all) are written to
  `<invocationDir>/settings.json` and passed as `--settings <path>`:

  ```json
  {
    "hooks": {
      "Stop": [
        {
          "matcher": "",
          "hooks": [{ "type": "command", "command": "node \".../argus-signal.mjs\"" }]
        }
      ],
      "PreToolUse": [
        {
          "matcher": "AskUserQuestion",
          "hooks": [{ "type": "command", "command": "node \".../argus-signal.mjs\" needs-input" }]
        }
      ]
    }
  }
  ```

  This points at the hook shipped with _this_ Argus, not the copy Setup
  installs under `~/.claude/hooks/` — a capability-carrying invocation's
  signalling never depends on that install step having run.

### How Codex maps a profile (`buildCodexCapabilities` in `runtimes/codex.ts`)

- `filesystem` → `--sandbox` (`read-only` / `workspace-write` /
  `danger-full-access` for `"unrestricted"`).
- `additionalDirectories` (plus the artifact directory, when
  `filesystem: "workspace-write"`) → `-c
sandbox_workspace_write.writable_roots=[...]`.
- `mcpServers` → one `-c mcp_servers.<name>.<field>=<value>` per field
  (`type`, `command`, `args`, `env.*`, `url`, `headers.*`), TOML-quoted.

### Limitations, per runtime

| Runtime         | What it cannot do                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | Bash stays a bare shell under `read-only` unless `tools.allow` scopes it to specific commands — Claude Code has no OS-level sandbox, only tool permission rules.                                                                                                                                                                                              |
| **Codex**       | `mcpServers` narrows nothing: there is no flag scoping a run to _only_ the declared servers, so whatever is in `config.toml` stays reachable alongside them (`"Codex cannot exclude MCP servers configured in config.toml"`). A `read-only` sandbox with an artifact directory also can't write artifacts (`"read-only sandbox prevents writing artifacts"`). |
| **OpenCode**    | Enforces **none** of `CapabilityProfile`'s keys — every key a profile sets becomes its own limitation string (`"OpenCode cannot enforce \"filesystem\" for this invocation"`, one per key present).                                                                                                                                                           |
| **Qwen Code**   | Same as OpenCode: zero keys supported, every declared key becomes a limitation.                                                                                                                                                                                                                                                                               |

`unsupportedCapabilities()` (in `runtimes/types.ts`) is what produces those
strings — it is handed each runtime's list of keys it _can_ map (empty for
OpenCode and Qwen), and reports every key the profile sets that isn't on that
list. `env` and `enforcement` are never in that list for any runtime: they
are engine-owned (§4), never a runtime's to enforce or report on.

### `enforcement: "strict" | "best-effort"`

Default is `"strict"`. When a resolved profile has any limitation and
enforcement is strict, the step **does not launch** — it fails immediately
under the `configuration` class (never retried; see §2), and the invocation
record still shows what Argus would have run. `"best-effort"` records the
same limitations but launches anyway: useful for a phase whose declared
profile is aspirational (e.g. "prefer read-only" on a runtime that can't do
it) rather than a hard requirement.

### Configuration precedence

Three layers govern what an invocation can actually do, and this feature
narrows only the third:

| Layer                                                                                                | Owns                                                                                                                                | After this change                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GLOBAL USER CONFIG** (`~/.claude/settings.json`, `~/.claude.json`, `~/.codex/config.toml`, …)      | The operator's own hooks, permission grants, and **user-scope MCP servers** (`~/.claude.json`, added via `claude mcp add -s user`). | Still loaded by default. `settingSources` can drop `~/.claude/settings.json` from the invocation (naming only `project`/`local`) — but `~/.claude.json`'s user-scope MCP servers are a **separate file `settingSources` does not touch**; the _only_ way to exclude them is `mcpServers` under `strict-mcp-config`, which replaces the whole MCP server set for that invocation. Declaring no `mcpServers` at all leaves them reachable. |
| **REPOSITORY CONFIG** (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json` in `cwd`) | Project-level hooks, permissions and MCP servers.                                                                                   | Loaded whenever `settingSources` includes `"project"`/`"local"` (the default). A declared `mcpServers` still overrides these via `--strict-mcp-config`.                                                                                                                                                                                                                                                                                  |
| **ARGUS INVOCATION CONFIG** (`~/.claude/argus/invocations/<runId>/{settings,mcp}.json`)              | This one invocation's Stop/PreToolUse hooks, and (when declared) its exact MCP server set.                                          | New. Written fresh per invocation, never reused across attempts.                                                                                                                                                                                                                                                                                                                                                                         |

Credentials are never Argus's concern at any layer: the CLI authenticates
itself exactly as it does outside Argus (its own login, its own
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` if the environment policy passes it
through). Argus holds no API keys of its own and never materializes one into
a config file.

## 4. Environment policy

`EnvPolicy` (in `@argus/contracts`, applied by `harness/childEnv.ts`) governs
what of Argus's _own_ process environment reaches the agent — independent of
which runtime is running, and independent of `enforcement` (a policy is
always applied; there is nothing to "fail to enforce" here).

```jsonc
{
  "inherit": "minimal",
  "allow": ["CI_*", "MY_TOOL_TOKEN"],
  "deny": ["AWS_*"],
  "set": { "NODE_ENV": "test" },
}
```

- `inherit: "all"` (default, and the pre-harness behaviour) — the server's
  whole environment passes through, minus the always-stripped names below.
- `inherit: "minimal"` — only `MINIMAL_BASELINE` (PATH, HOME, locale, temp
  dirs, TLS/proxy variables, and each agent CLI's own `CLAUDE_*` /
  `ANTHROPIC_*` / `CODEX_*` / `OPENAI_*` / `QWEN_*` / `OPENCODE_*` /
  `ARGUS_*_HOME`/`ARGUS_*_BIN` variables) plus whatever `allow` names.
- `allow` / `deny` — variable names, or a `PREFIX_*` pattern (one trailing
  `*`, matched by `matchesEnvPattern`). `deny` removes; `allow` wins over
  `deny` when both match the same name.
- `set` — values fixed for this invocation only, applied last (after `allow`/
  `deny`, after the runtime's own `plan.env`, after Argus's per-invocation
  identifiers) — except it can never overwrite a reserved name (below).

**Always stripped, under every policy, non-overridable even by an explicit
`allow` or `set`:**

- Argus's own secrets: `ARGUS_TOKEN` (the admin bearer token) and
  `ARGUS_WEBHOOK_URL`.
- Per-invocation identifiers, which must come only from this invocation's own
  freshly-computed values, never be inherited from Argus's own process (which
  would let a nested Argus child impersonate or interfere with the run that
  spawned it): `ARGUS_SIGNAL_TOKEN`, `ARGUS_SIGNAL_URL`, `ARGUS_RESULT_FILE`,
  `ARGUS_ARTIFACT_DIR`, `ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`, `ARGUS_RUN_ID`.

The invocation record never stores a variable's _value_ — only names
(`envNames`, sorted; `envStripped`, sorted). Reconstructing what Argus ran
never means reconstructing a secret.

## 5. Artifacts

Every phase attempt gets its own directory for file artifacts, distinct from
the payload artifacts `produces`/`{{artifacts.<name>}}` already carry (see
API.md § Weave):

- `ARGUS_ARTIFACT_DIR` — set on every step's environment, pointing at
  `~/.claude/argus/artifacts/<instanceId>/<phaseId>/`. Argus creates the
  directory, adds it to the runtime's writable set no matter what
  `filesystem` says elsewhere (`--add-dir` for Claude Code; a Codex
  `read-only` sandbox cannot write there at all, which is reported as a
  limitation), and passes it to `checks` of kind `artifact` as their search
  root.
- `{{artifactDir}}` in a step's prompt interpolates to _this phase's own_
  artifact directory; `{{artifactDir.<phaseId>}}` interpolates to an earlier
  phase's (from `ArtifactDirs.byPhase`, built from every phase's
  `PhaseProgress.artifactDir` recorded so far). An unknown phase id
  interpolates to empty, same as an unknown `{{artifacts.<name>}}`.
- **Cleared per attempt.** `startPhase` removes and recreates the directory
  before launching a phase's steps, every attempt (first run, retry, or
  revise) — a file left over from a previous attempt can never satisfy this
  attempt's `checks` or mislead the agent about what it has already done.
- **Pruned with the instance.** `pruneInstances` removes
  `~/.claude/argus/artifacts/<instanceId>/` (and the instance's working-tree
  baselines) together with the instance record once it falls outside the
  per-pipeline retention window (`INSTANCE_KEEP`). Invocation records, by
  contrast, are pruned per _run_ — with `pruneRuns`'s retention window,
  because they are keyed by `runId` — so the two can fall out of retention on
  different schedules.

File artifacts are the counterpart of `produces`/`PhaseResult` payload
artifacts: a payload is a small validated JSON value pasted into a later
prompt; a file artifact is a path a later step reads for itself (a diff, a
report, an investigation write-up too large to interpolate as text).

## 6. Verification checks

`PhaseCheck` (in `@argus/contracts`) is Argus's own evidence that a phase's
declared work actually happened — run once every step of the phase has
reported success (or been recovered as successful — §2), never before, and
never derived from the agent's own words.

| Kind            | Fields                                                                                                                        | Limit / semantics                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`       | `run` (string, ≤4000 chars), `label?`, `cwd?` (resolved against the phase's `cwd`), `timeoutSeconds?` (1–86400; default 600s) | Runs through the shell in `cwd`; exit `0` passes. Combined stdout+stderr is capped at 16 KiB in memory, and only the last 4000 chars survive into the `CheckResult.output`. Runs with Argus's own environment, minus `ARGUS_TOKEN`/`ARGUS_WEBHOOK_URL`. A timeout kills the whole process group (POSIX). |
| `artifact`      | `path` (relative, no `..`, no absolute), `label?`, `minBytes?` (≥0, default 1)                                                | Resolved against the phase's `ARGUS_ARTIFACT_DIR`. Fails if the phase has no artifact directory, the path escapes it, the file is missing, or it's smaller than `minBytes`.                                                                                                                              |
| `file`          | same fields as `artifact`                                                                                                     | Resolved against the phase's own `cwd` instead of the artifact directory — for a file the agent was supposed to leave in the working tree itself.                                                                                                                                                        |
| `changed-files` | `label?`, `allow?` (globs), `deny?` (globs), `requireChanges?` (boolean)                                                      | See below.                                                                                                                                                                                                                                                                                               |

A phase may declare up to 50 checks (`MAX_CHECKS`); they all run, always —
verification never stops at the first failure, because the full report is the
evidence a failed phase leaves behind.

```jsonc
{
  "checks": [
    { "kind": "command", "run": "npm test", "label": "unit tests", "timeoutSeconds": 300 },
    { "kind": "artifact", "path": "report.md", "minBytes": 200 },
    {
      "kind": "changed-files",
      "allow": ["src/**", "docs/**"],
      "deny": ["**/*.lock"],
      "requireChanges": true,
    },
  ],
}
```

**Report shape** (`VerificationReport`), stored on the live phase at
`PhaseProgress.verification`:

```json
{
  "status": "failed",
  "startedAt": "2026-09-10T14:02:00.000Z",
  "endedAt": "2026-09-10T14:02:41.000Z",
  "checks": [
    {
      "kind": "command",
      "label": "unit tests",
      "status": "failed",
      "detail": "exit 1",
      "exitCode": 1,
      "durationMs": 4123,
      "output": "...last 4000 chars of combined stdout+stderr..."
    }
  ]
}
```

While checks are running, `PhaseProgress.verification.status` is `"running"`
with an empty `checks` array — that is what lets `reconcile()` re-run the
checks for a phase whose verification was in flight when Argus itself
restarted, keyed by attempt so a stale report from a superseded attempt can
never apply (`applyVerification` refuses any report for a phase that is no
longer `running` under a `running` verification — an abort, revise or a
competing transition has already decided otherwise). A passing report
concludes the phase exactly as a check-less phase would at its last step's
signal; a failing one fails the phase under the `verification` class, with
the report kept as `phase.verification` — evidence, not just a verdict.

**Changed-files baseline.** When a phase declares a `changed-files` check,
Argus snapshots the working tree (`git status --porcelain`, plus a SHA-256 of
each dirty file's bytes) at the _start_ of the attempt, before any step
launches, and writes it beside the invocation records
(`~/.claude/argus/invocations/<instanceId>/<phaseId>.<attempt>.baseline.json`
— keyed by instance, unlike the per-run invocation directories). At
verification time it snapshots again and reports the paths whose identity
differs — added, modified, deleted, or newly dirty. **A file that was already
dirty before the phase started and comes out with an identical hash is not
"changed"** — only a path whose baseline/current identity actually differs
counts, so a phase run against an already-dirty tree isn't credited (or
blamed) for pre-existing changes it never touched. `requireChanges: true`
fails a phase that changed nothing at all.

**Glob semantics.** `allow`/`deny` globs are matched against each changed
path with Node's own `path.matchesGlob`, after normalizing to forward slashes
(so the check behaves the same on Windows and POSIX). A changed path failing
every `allow` glob (when any are set), or matching any `deny` glob, is
"offending"; any offending path fails the check.

## 7. Timeouts

`timeoutSeconds` may be set on a step (overrides) or a phase (default for
every step in it); absent on both means no limit. A limit turns into a
`deadlineAt` on the `Run` record — `now + timeoutSeconds` at launch — which is
**persisted**, not just held in a timer:

- While the launching server process is alive, `trackStep` sets a plain
  `setTimeout` for the wait until `deadlineAt` and calls `expireStep` when it
  fires.
- `expireStep` records `run.termination = "timed-out"`, sends the process
  group a kill signal, and — after a grace period (`killGraceMs`, default
  5000ms) if it's still alive — escalates to `SIGKILL`. The phase (and any
  sibling steps still running in it) fails under the `timeout` class.
- **Enforcement survives a restart.** `deadlineAt` is read back off the `Run`
  record by `reconcile()`: an adopted run already past its deadline is killed
  on the very next reconcile tick, exactly as if the original timer had fired
  — the deadline is a property of the run, not of the process that happened
  to be watching it.

```json
{
  "id": "run_8f2a",
  "deadlineAt": "2026-09-10T14:15:00.000Z",
  "termination": "timed-out",
  "error": "timed out after 900s"
}
```

## 8. Observability & reproducibility

**`AgentInvocationRecord`** — written to
`~/.claude/argus/invocations/<runId>/invocation.json` _before_ the process is
spawned (so even a refused launch leaves one), and readable via
`GET /api/runs/:id/invocation` (404 when the run predates invocation records,
or is unknown):

```json
{
  "runId": "run_8f2a",
  "instanceId": "inst_71c0",
  "phaseId": "implement",
  "step": "code",
  "attempt": 0,
  "runtime": "claude",
  "bin": "claude",
  "args": ["-p", "--output-format", "stream-json", "--verbose", "--session-id", "…"],
  "cwd": "/path/to/repo",
  "envNames": ["HOME", "PATH", "ANTHROPIC_API_KEY", "ARGUS_ARTIFACT_DIR", "…"],
  "envStripped": ["ARGUS_TOKEN", "ARGUS_WEBHOOK_URL", "AWS_SECRET_ACCESS_KEY"],
  "capabilities": { "filesystem": "workspace-write", "maxTurns": 40 },
  "limitations": [],
  "materializedFiles": ["/home/user/.claude/argus/invocations/run_8f2a/settings.json"],
  "artifactDir": "/home/user/.claude/argus/artifacts/inst_71c0/implement",
  "resultFile": null,
  "timeoutSeconds": 1800,
  "deadlineAt": "2026-09-10T14:32:00.000Z",
  "gitHead": "3f1a9c2e8b0d4f6a7c1e2b3d4f5a6b7c8d9e0f10",
  "startedAt": "2026-09-10T14:02:00.000Z"
}
```

Values of environment variables never appear — only names. `limitations` is
what the chosen runtime could not enforce of the declared profile; empty
means every declared key was honoured (or no profile was declared at all).

**Journal kinds** (`server/src/sources/journal.ts`, append-only, per
instance) that this feature adds:

| Kind              | When                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `step.timed-out`  | A step's process was killed at its `deadlineAt` (live, or discovered on reconcile after a restart). |
| `phase.verifying` | Every step of a phase reported success and Argus started running its `checks`.                      |
| `phase.verified`  | The checks finished — `passed`, or `failed` naming which checks and why.                            |

**`Run.termination`** (`@argus/contracts`) records _how_ a run ended when
Argus knows more than the exit code: `"exited"` (its own doing), `"timed-out"`
(killed at its deadline), `"killed"` (aborted/cancelled/superseded by Argus
for some other reason), `"spawn-failed"` (never started at all — covers both
the `spawn` and `configuration` failure classes, since neither ever produced
a process). Absent means the process simply exited on its own.

## 9. Reference pipeline

A complete, realistic five-phase pipeline using every piece above:
investigate → plan (gated) → implement → verify → review. `cwd` must already
exist on disk for a pipeline to validate — `/path/to/repo` below is a
placeholder; substitute a real, existing directory.

```jsonc
{
  "name": "FeaturePipeline",
  "trigger": null,
  "overlapPolicy": "skip",
  "runtime": "claude",
  "capabilities": {
    // Pipeline-wide default: every phase gets this unless it overrides a key.
    "env": { "inherit": "minimal", "allow": ["CI_*"] },
    "enforcement": "strict",
  },
  "phases": [
    {
      "id": "investigate",
      "name": "Investigate",
      "cwd": "/path/to/repo",
      "gated": false,
      "timeoutSeconds": 900,
      "capabilities": {
        "filesystem": "read-only",
        "tools": { "allow": ["Bash(git log:*)", "Bash(git grep:*)", "Bash(rg:*)"] },
      },
      "steps": [
        {
          "name": "survey",
          "prompt": "Investigate how retries are implemented in this repo. Write your findings to {{artifactDir}}/investigation.md.",
        },
      ],
      "produces": "investigation",
      "checks": [{ "kind": "artifact", "path": "investigation.md", "minBytes": 200 }],
    },
    {
      "id": "plan",
      "name": "Plan",
      "cwd": "/path/to/repo",
      "gated": true,
      "needs": ["investigate"],
      "timeoutSeconds": 600,
      "capabilities": { "filesystem": "read-only", "maxTurns": 20 },
      "steps": [
        {
          "name": "draft-plan",
          "prompt": "Given {{artifacts.investigation}}, draft an implementation plan as JSON: { \"steps\": [...] }.",
        },
      ],
      "result": {
        "artifact": "plan",
        "schema": {
          "type": "object",
          "required": ["steps"],
          "properties": { "steps": { "type": "array", "items": { "type": "string" } } },
        },
      },
    },
    {
      "id": "implement",
      "name": "Implement",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": ["plan"],
      "timeoutSeconds": 3600,
      "retry": {
        "attempts": 2,
        "backoffSeconds": 60,
        "retryOn": ["spawn", "exit-code", "verification"],
      },
      "capabilities": {
        "filesystem": "workspace-write",
        "additionalDirectories": ["/path/to/repo"],
        "mcpServers": {
          "docs": { "type": "stdio", "command": "docs-mcp", "args": ["--repo", "."] },
        },
      },
      "steps": [
        {
          "name": "code",
          "prompt": "Implement {{artifacts.plan}}. Leave a summary at {{artifactDir}}/summary.md.",
        },
      ],
      "checks": [
        {
          "kind": "command",
          "run": "npm run typecheck",
          "label": "typecheck",
          "timeoutSeconds": 300,
        },
        {
          "kind": "changed-files",
          "allow": ["src/**", "docs/**"],
          "deny": ["**/*.lock", "package-lock.json"],
          "requireChanges": true,
        },
      ],
    },
    {
      "id": "verify",
      "name": "Verify",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": ["implement"],
      "timeoutSeconds": 1800,
      "capabilities": { "filesystem": "workspace-write" },
      "steps": [
        { "name": "test", "prompt": "Run the full test suite and fix any failures you caused." },
      ],
      "checks": [
        { "kind": "command", "run": "npm test", "label": "full suite", "timeoutSeconds": 900 },
      ],
    },
    {
      "id": "review",
      "name": "Review",
      "cwd": "/path/to/repo",
      "gated": true,
      "needs": ["verify"],
      "timeoutSeconds": 900,
      "capabilities": {
        "filesystem": "read-only",
        "tools": { "deny": ["Bash"] },
        "permissionMode": "plan",
      },
      "steps": [
        {
          "name": "review",
          "prompt": "Review the diff introduced by {{artifactDir.implement}}/summary.md for correctness and style.",
        },
      ],
    },
  ],
}
```

Notes on why each choice was made, since a reference is only useful if its
choices are legible:

- `investigate` and `review` are `read-only` — neither should ever touch the
  working tree, so read-only is a real constraint here, not a suggestion.
  `review` additionally denies `Bash` outright since it names no scoped
  allow-rule (leaving `Bash` under `read-only` with no `tools.allow` would
  otherwise deny it anyway — stated here for clarity).
- `plan` is `gated`, has no `checks`, and declares a `result` — the human
  approval _is_ its verification.
- `implement` is the only phase whose steps may write, and it's the one with
  both a `command` check (typecheck as a proxy for "compiles") and a
  `changed-files` check (`requireChanges: true` — a no-op "implementation"
  fails the phase).
- `retry.retryOn` on `implement` deliberately opts into `"verification"`: a
  typecheck failure is worth a second attempt with the failure reason handed
  back in the prompt (`retryNote`).
- Only `implement` and `verify` need `workspace-write`; `plan`'s `maxTurns`
  caps a phase that should be a short structured answer, not an open-ended
  session.

## 10. Known limitations / non-goals

- **No OS-level sandbox for Claude Code.** `filesystem: "read-only"` is tool
  permission rules, not a kernel-enforced boundary — a scoped `Bash` rule the
  agent can talk its way around (e.g. a command that itself writes files) is
  not caught by anything here. Codex's sandbox is the one runtime with a real
  OS-level boundary.
- **Bash under read-only, generally.** Even where Argus denies bare `Bash`,
  any `tools.allow` entry scoping specific commands necessarily trusts that
  those commands don't write — Argus does not parse or sandbox the command
  line itself.
- **Codex's Stop hook still comes from `~/.codex/config.toml`, appended once
  by Setup — not per invocation.** Unlike Claude Code and Qwen Code, Codex has
  no per-invocation hook mechanism this feature can use; its completion
  signal depends on the global hook already being installed (or on the
  `ARGUS_OUTCOME`-plus-reconcile fallback, since Codex's `outcomeFromRecord`
  is `true`).
- **OpenCode and Qwen Code have no per-invocation control at all.** Every
  `CapabilityProfile` key set for a step on either runtime becomes a
  limitation string; under `enforcement: "strict"` (the default) that means
  the step simply will not launch. A pipeline mixing runtimes phase-by-phase
  and wanting a capability profile on all of them needs `"best-effort"` on
  the phases that run OpenCode/Qwen, with the understanding that the profile
  there is documentation of intent, not an enforced boundary.
- **`~/.claude.json` user-scope MCP servers are excluded only by declaring
  `mcpServers`.** There is no flag that says "run with none of the operator's
  configured MCP servers" short of naming the exact replacement set.
- **No API keys live in Argus.** Every runtime authenticates itself exactly as
  it would run outside Argus; the environment policy controls whether an
  existing credential variable reaches the child, never issues one.
