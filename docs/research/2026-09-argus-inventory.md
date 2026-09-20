# Argus — Harness Capability Inventory

Sources: `docs/HARNESS.md`, `docs/ARCHITECTURE.md`, `docs/DATA-MODEL.md`, `docs/API.md`,
`contracts/src/*`, `server/src/harness/*`, `server/src/runtimes/*`,
`server/src/pipelineEngine.ts`, `server/src/pipelineTransitions.ts`, `server/src/scheduler.ts`.

## 1. Workspace isolation — PARTIAL

No git-worktree-per-run and no container isolation exist anywhere in the codebase
(`worktree` does not appear in `server/src` or `contracts/src`). Isolation is:

- **cwd policy**: every phase declares `cwd` (must pre-exist on disk, validated at save
  time); all steps of a phase run there. No per-run copy/branch of the repo.
- **Sandbox flags per runtime**: only Codex has an OS-level sandbox
  (`buildCodexCapabilities`, `server/src/runtimes/codex.ts`) — `filesystem` maps to
  `--sandbox read-only|workspace-write|danger-full-access`, plus
  `-c sandbox_workspace_write.writable_roots=[...]`. Claude Code has **no OS sandbox**;
  `filesystem: "read-only"` is emulated with `--disallowedTools Edit(...)`/deny-Bash
  rules only (`buildClaudeCapabilities`, `server/src/runtimes/claude.ts`) — documented as
  bypassable by any `tools.allow` Bash rule that itself writes files. OpenCode and Qwen
  Code enforce **none** of `CapabilityProfile` (`unsupportedCapabilities()`,
  `server/src/runtimes/types.ts`); every declared key becomes a `limitations` string.
- **Network policy**: none. No egress/network capability key exists in
  `CapabilityProfile` (`contracts/src/pipelines.ts`).
- **Filesystem escape hatch**: `additionalDirectories` (validated to pre-exist,
  absolute) plus a phase's own artifact dir always gets `--add-dir` regardless of
  `filesystem`.
- **Limitation**: HARNESS.md §10 states plainly Codex is "the one runtime with a real
  OS-level boundary"; everything else is convention/tool-permission based.

## 2. Environment policy for the child — FULL

`EnvPolicy` (`contracts/src/pipelines.ts`) + `buildChildEnv`
(`server/src/harness/childEnv.ts`, the single assembly point every runtime routes
through):

- `inherit: "all"` (default) or `"minimal"` (only `MINIMAL_BASELINE`: PATH/HOME/locale/
  temp/TLS-proxy vars + each CLI's own `CLAUDE_*`/`ANTHROPIC_*`/`CODEX_*`/`OPENAI_*`/
  `QWEN_*`/`OPENCODE_*`/`ARGUS_*_HOME`/`ARGUS_*_BIN`).
- `allow`/`deny` (exact name or one trailing-`*` prefix, `matchesEnvPattern`); `allow`
  wins over `deny`. `set` applies last, cannot override reserved names.
- **Always stripped, unconditionally**: `ARGUS_SERVER_SECRETS` = `ARGUS_TOKEN`,
  `ARGUS_WEBHOOK_URL`; and `ARGUS_PER_INVOCATION_IDENTIFIERS` (signal token/URL, result
  file, artifact dir, instance/phase/run id, step name, runtime) are always
  freshly computed, never inherited.
- Secrets are never persisted: `AgentInvocationRecord.envNames`/`envStripped` store
  **names only**; `redactProfile()` (`invocation.ts`) redacts `env.set` values and MCP
  `env`/`headers` values as `"<redacted>"` before writing the record.
- Argus itself holds no API keys/credentials of any kind (documented non-goal, §3/§10).

## 3. Capability profiles / tool permission mapping — PARTIAL (varies sharply by runtime)

`CapabilityProfile` (`contracts/src/pipelines.ts`) is runtime-neutral: `filesystem`,
`tools.{allow,deny}`, `mcpServers`, `additionalDirectories`, `settingSources`,
`permissionMode`, `maxTurns`, `env`, `enforcement`. Merged pipeline→phase→step by key,
narrowest wins, via `resolveCapabilities()` (`server/src/harness/invocation.ts`).

- **Claude Code** (`buildClaudeCapabilities`, `runtimes/claude.ts`): maps to
  `--disallowedTools`/`--allowedTools`, `--mcp-config <path> --strict-mcp-config`,
  `--add-dir`, `--setting-sources`, `--permission-mode`, `--max-turns`; also writes
  Stop/PreToolUse hooks into a per-invocation `settings.json` (`--settings <path>`).
- **Codex** (`buildCodexCapabilities`, `runtimes/codex.ts`): `--sandbox`, `-c
sandbox_workspace_write.writable_roots=[...]`, `-c mcp_servers.<name>.<field>=...`.
  Cannot scope MCP servers exclusively (config.toml servers stay reachable alongside).
- **OpenCode / Qwen Code**: map **zero** keys; every set key becomes a limitation.
- No `--max-budget`-style per-step cost cap flag exists in `CapabilityProfile` — cost
  control lives entirely in the separate Budget/Ledger subsystem (§12), not the
  capability profile.
- `enforcement: "strict"` (default) refuses to launch a step with any unenforced
  limitation, under the `configuration` failure class (never retried); `"best-effort"`
  launches anyway and records the gap.

## 4. Verification checks — FULL, deterministic-only (no LLM-judge check)

`PhaseCheck` (`contracts/src/pipelines.ts`), run by `runChecks()`
(`server/src/harness/verification.ts`) once every step of a phase reports success:

- `command` — shell command, exit 0 passes; capped output (16 KiB in memory, last
  4000 chars kept), own `EnvPolicy`, SIGTERM→grace→SIGKILL on timeout.
- `artifact` — file under the phase's `ARGUS_ARTIFACT_DIR`, `lstat` (no symlink
  following), `minBytes`.
- `file` — same as `artifact` but resolved against the phase `cwd`.
- `changed-files` — git working-tree + commit diff vs. a baseline snapshot taken at
  attempt start (`git status --porcelain=v1 -z`), content-hash identity, `allow`/`deny`
  globs, `requireChanges`.
- Up to 50 checks per phase (`MAX_CHECKS`); all always run (no fail-fast).
- Result: `VerificationReport`/`CheckResult` stored on `PhaseProgress.verification` —
  feeds directly into phase success/failure (`verification` failure class) via
  `pipelineTransitions.ts`'s `applyVerification`.
- **No LLM-judge check kind.** Quality judging exists as a _separate_ opt-in feature,
  Verdict (`contracts/src/verdict.ts`, `server/src/sources/verdict.ts`): a bounded
  `claude -p` rubric pass scores a run 0–10 against author-written criteria, can flag a
  `regression` below `minScore`, and can auto-open a gate (`AutoApprove.verdict`) — but
  it is not one of `PhaseCheck`'s kinds and runs from a watcher tick, not inline in
  verification.

## 5. Retry / self-heal — PARTIAL

`RetryPolicy` (`contracts/src/pipelines.ts`): `attempts`, `backoffSeconds` (doubles
each attempt), `retryOn?: RetryableClass[]` (default `["spawn","exit-code"]`).
`PhaseFailureClass` = `spawn | exit-code | signal | timeout | verification |
configuration` (HARNESS.md §2); `configuration` is never retried.

- **Failure feedback into next attempt**: `retryNote()` (`pipelineEngine.ts`) appends
  the failure reason to the retried prompt, but **only** for `"verification"` and
  `"signal"` classes — the ones with "a considered reason worth repairing against."
  `spawn`/`exit-code`/`timeout` carry nothing back.
- Backoff is exponential (`backoffSeconds` doubling), scheduled via
  `PhaseProgress.retryAt`, survives restart (persisted, not just an in-memory timer).
- **Autopsy** (`contracts/src/autopsy.ts`, `server/src/sources/analysis.ts`) is a
  separate, human-in-the-loop self-heal aid: a bounded postmortem `claude -p` pass over
  a failed run's transcript proposes a `failureClass`, a `promptDelta` (rewritten
  prompt) and rationale — but it is **never applied automatically**; relaunch with the
  proposed prompt requires a human action behind the admin gate.
- **Tuning** (`contracts/src/tuning.ts`) similarly proposes model/reasoningEffort/
  timeout/maxTurns changes per phase but never prompt text, and never auto-applies.

## 6. Test-time scaling — NONE

No parallel-attempt-of-the-same-step + selection/judge, no best-of-N, no voting exists.
Verdict scores a single completed run against a rubric; it does not run multiple
candidates and pick a winner. Retries are sequential replacements of the same attempt
slot, not concurrent alternatives.

## 7. Planning / spec phase — PARTIAL (a pattern, not a first-class feature)

No dedicated "planner" phase type. The pattern is achievable by hand using generic
primitives, exactly as HARNESS.md §9's reference pipeline does: a `gated: true` phase
with `permissionMode` and no `checks`, declaring a `result` (JSON schema-validated via
`PhaseResult`/`ResultSchema`) that a later phase interpolates
(`{{artifacts.plan}}`). "Plan approval gate" = the generic `gated` + approve/revise
mechanism (§11), not a plan-specific concept. Tuning's "Analyze" pass is a settings
planner (proposals only, never plan text/task lists), and Autopsy's `promptDelta` is
a repair-plan proposal — both human-approved, neither a task-list construct.

## 8. Memory across runs — PARTIAL, mostly via artifacts/payloads, not durable memory

- **File artifacts**: every phase attempt gets `~/.claude/argus/artifacts/<instanceId>/
<phaseId>/`, exposed to the agent as `ARGUS_ARTIFACT_DIR` and interpolated as
  `{{artifactDir}}` (own) / `{{artifactDir.<phaseId>}}` (an earlier phase's), from
  `ArtifactDirs.byPhase` built off `PhaseProgress.artifactDir` (HARNESS.md §5). **Cleared
  every attempt** (retry/revise wipes it) — it is not cross-run/cross-pipeline memory,
  only cross-phase within one instance.
- **Payload artifacts**: `produces`/`{{artifacts.<name>}}` publish a phase's validated
  JSON `PhaseResult` onto `PipelineInstance.artifacts`, readable by any later phase by
  name; `{{previous.payload}}` is the immediate predecessor's raw payload
  (`previousPayloadFor`, `server/src/sources/dag.ts`).
- **No persistent cross-instance/cross-pipeline memory or "progress notes" file** feeding
  future runs' prompts is implemented — each `PipelineInstance` snapshots its own
  `PipelineDefinition` at start and instance state does not seed a later, unrelated
  instance's prompts.
- Artifact/invocation directories are pruned with the instance (`pruneInstances`,
  `INSTANCE_KEEP`) or per run (`pruneRuns`), on separate retention windows.

## 9. Context management — PARTIAL

- **Templating variables**: `interpolate()` (`server/src/sources/dag.ts`) supports
  exactly four placeholders: `{{previous.payload}}`, `{{artifacts.<name>}}`,
  `{{artifactDir.<phaseId>}}`, `{{artifactDir}}`. Unknown names interpolate to empty
  string, no error.
- **Size limits**: check output capped (16 KiB in-memory / 4000-char tail), autopsy/
  ledger/verdict output quoted with bounded character caps, but there is **no general
  prompt-size limiter or automatic compaction of prior-phase output** before
  interpolation — a large `{{artifacts.<name>}}` payload is pasted in full (values are
  small validated JSON by convention, not size-checked).
- **`--append-system-prompt` style instruction injection**: not a `CapabilityProfile`
  key; instead Argus injects fixed guidance strings directly into the step prompt text
  (e.g. the `ARGUS_OUTCOME` instruction block, `pipelineEngine.ts` ~L116-180, and the
  "Required artifacts" instruction, ~L156-167) rather than via a runtime system-prompt
  flag.
- **AGENTS.md/CLAUDE.md awareness**: not read/injected by Argus itself; `settingSources`
  controls whether Claude Code loads its **own** `user`/`project`/`local` settings
  files (hooks/MCP/permissions), which is a different mechanism from CLAUDE.md context
  files — those load per the CLI's own native behavior, unaffected by Argus.

## 10. Sub-agents / parallel fan-out — FULL within a pipeline (DAG), no cross-pipeline map

- Pipelines are a DAG (`needs`/`DependencyEdge`, `RouteCondition`), not a linked list;
  a linear pipeline is defined as the degenerate case (`sources/dag.ts`, `resolveNeeds`).
  Multiple phases become ready simultaneously ("a wave") and launch concurrently;
  `startPhases()` (`pipelineEngine.ts`) iterates the wave sequentially only to avoid
  racing writes to the same instance file — the underlying processes run concurrently
  and are capped by a global concurrency semaphore (`MAX_...` constant in
  `pipelineEngine.ts`, "Caps the number of concurrently spawned child processes").
  Multiple **steps within one phase** likewise run concurrently.
- Conditional routing (`RouteDecision`, `RoutePredicate`) lets one phase's result select
  which of several downstream phases run — a fan-out/branch primitive, not a `map`-over-
  a-list primitive. There is no "map this phase over N items" construct; fan-out is
  static (defined by the DAG shape), not data-driven.
- Failure is not immediately terminal for the instance with a fan-out — one branch
  failing lands on that phase; the instance settles only when nothing can progress
  (ARCHITECTURE.md §5, "Replacing a cursor with a graph").

## 11. Human gates / approvals; outcome signalling — FULL

- **Gates**: `PhaseDef.gated: true` pauses the instance at `awaiting-approval` after
  verification passes; `POST /api/instances/:id/approve` (optional `answers`) or
  `/revise` (a human `note` fed back into the reattempt) resume it. `AutoApprove` lets
  a rubric-scored (Verdict) gate open itself unattended above `minScore`/`verdict`
  threshold — computed from a watcher tick calling the engine's ordinary `approve()`
  from outside the lock (deliberately not inline, to avoid a model call deadlocking the
  engine — ARCHITECTURE.md "Where model-backed side effects are allowed to live").
- **Outcome signalling protocol**: two independent channels, engine-authoritative over
  the exit code —
  1. **Stop hook** (`hooks/argus-signal.mjs`, installed into Claude Code's/Qwen Code's
     `settings.json`) POSTs `/api/instances/:id/signal` with `{type: completed|needs-
input|failed}` plus a parsed structured `result`; also a `PreToolUse` hook on
     `AskUserQuestion` signals `needs-input`.
  2. **`ARGUS_OUTCOME` marker** (`ARGUS_OUTCOME: succeeded|failed|blocked [reason]`,
     matched by `OUTCOME_LINE_RE` in `pipelineEngine.ts`) in the agent's final message,
     read on `reconcile()` — the only protocol OpenCode has (`outcomeFromRecord`); a
     best-effort backstop for Codex (whose Stop hook comes from a one-time
     `~/.codex/config.toml` append by Setup, not per-invocation); redundant-but-checked
     for Claude/Qwen (missing marker or conflicting markers is itself flagged).
  - A completion signal, once accepted, is authoritative: a later non-zero exit does
    not unwind the phase — recorded as a `step.exit-mismatch` journal entry instead
    (HARNESS.md §2/§10).

## 12. Timeouts, step/cost budgets — FULL (step-level); PARTIAL (pipeline/global)

- **Timeouts**: `timeoutSeconds` on step (overrides) or phase (default); narrowest wins;
  absent = no limit. Turns into a persisted `Run.deadlineAt`; `expireStep()` SIGTERMs
  the process group, SIGKILLs after `killGraceMs` (default 5000ms); survives restart via
  `reconcile()` re-reading `deadlineAt`. No pipeline-wide or instance-wide wall-clock
  budget field exists — only per-step.
- **Turn budget**: `maxTurns` (`CapabilityProfile`), Claude-Code-only enforcement
  (`--max-turns`).
- **Cost budgets**: separate subsystem, not part of `CapabilityProfile` — no per-step
  `--max-budget` flag. `BudgetConfig` (`contracts/src/budget.ts`): `dailyUsd`/
  `monthlyUsd` ceilings, `blockScheduled`, and a graduated `ladder` (`BudgetLadderStep`,
  `contracts/src/ledger.ts`) — warn → downgrade model → defer slots → hard stop, highest
  matching step wins. Enforcement is recorded onto the affected `Run`
  (`budgetAction`, `modelDowngradedFrom`) so a downgrade months later is explicable
  without correlating against a since-edited policy. `budgetWatcher.ts` diffs
  derived budget state per scheduler tick to raise alerts (webhook + WS), not a
  hard interrupt mid-run — enforcement happens at scheduling time, not by killing an
  in-flight process for cost.

## 13. Observability — FULL

- **`AgentInvocationRecord`** (`~/.claude/argus/invocations/<runId>/invocation.json`,
  written _before_ spawn so even a refused launch leaves one): bin/argv/cwd, env names
  (never values), capabilities as applied + `limitations`, materialized config files,
  artifact dir, timeout/deadline, `gitHead` at launch. Readable via
  `GET /api/runs/:id/invocation`.
- **Journal** (`server/src/sources/journal.ts`, append-only per instance):
  `step.timed-out`, `step.exit-mismatch`, `phase.verifying`, `phase.verified`, etc.
- **Flight Recorder** (`server/src/sources/recorder.ts`): pure `(run, transcript
lines, now) → Recording` — never persisted, recomputed per read, degrades on
  malformed/unfamiliar lines rather than throwing (ARCHITECTURE.md §5).
- **Watchtower** (`contracts/src/watchtower.ts`, `server/src/sources/watchtower.ts`):
  anomaly detection over run metrics (`judge()` against a rolling baseline envelope),
  ids deterministic (`key|metric|runId`) so restart never double-alerts.
- **Verdict / Autopsy / Tuning / Sentinel / Ledger**: each a bounded, capped, persisted
  JSON store (`argus/verdicts.json` capped 400, `argus/autopsies.json` capped 200,
  `argus/tuning.json` capped 50, `argus/incidents.json`, `argus/spend.json`/
  `budget.json`) giving history/trend views.
- **The Vault** (`argus/vault.sqlite`): long-horizon rebuildable cache (FTS5 search,
  idempotent upsert ingest); explicitly never authoritative — JSON wins on conflict.
- **Export/replay**: no explicit "export" or full replay-execution feature found beyond
  reading these records/transcripts via the API; the Flight Recorder's read-only
  reconstruction from stored transcripts is the closest thing to "replay."

## 14. Feedback loops with external systems — PARTIAL (outbound only; no CI/PR ingestion)

- **Webhooks out**: `postWebhook()` (`server/src/notify.ts`) fire-and-forget POSTs a
  JSON payload to `config.webhookUrl` (`ARGUS_WEBHOOK_URL`) on: run failure
  (`buildRunFailurePayload`), monitor alert, budget alert, Watchtower anomaly, Sentinel
  incident.
- **Webhooks/events in**: none found — `Trigger.kind` is a closed set
  (`interval|daily|weekly|windowed`, `contracts/src/schedules.ts`); no webhook-triggered
  or event-triggered pipeline/schedule exists. No GitHub/CI/PR-comment ingestion code
  exists anywhere in `server/src` (only outbound webhook code was found when grepping
  for "github"/"pull request").
- **Federation** (`server/src/federation/`) is a peer-to-peer, pull-only, opt-in summary
  exchange between Argus instances (sealed AES-256-GCM+HMAC envelopes) — not a CI/PR
  integration, and explicitly read-only in every peer view (no cross-machine approve/
  triage).

## 15. Evaluation / regression across runs — PARTIAL

- **Verdict** gives per-run quality scores against an authored rubric, trended over time
  (`VerdictTrend`: latest/median/`delta`, `regressions` count) — the closest thing to a
  regression detector, and it can open an issue-worthy "quality regression" when a score
  drops below `minScore`.
- **Watchtower** flags statistical anomalies (duration/cost/etc.) against a rolling
  baseline per schedule/phase key.
- **Ledger** compares actual historical cost between models (`CostDimension`), refusing
  to answer "what if" without measured data (no price table) and refusing forecasts
  under `MIN_FORECAST_DAYS`.
- No formal "eval suite" or run-to-run diffing of _pipeline output correctness_ beyond
  these three; no A/B or side-by-side run comparison feature was found.

## 16. Scheduling & triggers — PARTIAL

`Schedule`/`Trigger` (`contracts/src/schedules.ts`): `interval|daily|weekly|windowed`
cadence, `catchUp` (anacron-style: `shouldFire()`/`graceMsFor()`,
`server/src/sources/nextFire.ts` — a slot missed beyond grace still fires once rather
than being dropped), manual one-off launch (`POST /api/launch`), `overlapPolicy:
skip|allow`. Pipelines reuse the same `Trigger` type (`PipelineDefinition.trigger`).
**No webhook/event trigger kind and no pipeline chaining-as-a-trigger** (one pipeline's
completion cannot directly fire another schedule/pipeline) was found in the trigger
union — chaining within one pipeline instance is only via the DAG (`needs`)/routing.

## 17. Templates / library — NONE (for pipelines/prompts)

No reusable pipeline-template or prompt-library construct exists in `contracts/src`
(`catalog.ts` is a _read-only catalogue of Claude Code's own on-disk state_ — sessions,
projects, stats, installed agents/commands/skills/plugins — not an Argus pipeline
template gallery). HARNESS.md §9's five-phase pipeline is documentation/a worked
example, not a stored, instantiable template. `agents.ts`'s `template` field
(`contracts/src/agents.ts:34`) refers to a background job's _launch template_ string
from the underlying CLI, unrelated to pipeline templating.

## 18. Reference pipeline (HARNESS.md §9)

A complete five-phase linear pipeline — **investigate → plan (gated) → implement →
verify → review** — demonstrating, in one place, every harness primitive: `read-only`
capability profiles on investigate/review, a `gated` plan phase with a JSON `result`
schema and no checks ("the human approval _is_ its verification"), `workspace-write` +
`additionalDirectories` + an MCP server + a `retry` policy opting `"verification"` into
`retryOn` on implement (paired with a `command` typecheck check and a `requireChanges`
`changed-files` check), a full-suite `command` check on verify, and a read-only,
`Bash`-denied, `permissionMode: "plan"` review phase. The pipeline-level `capabilities`
sets a shared `env: {inherit: "minimal", allow: ["CI_*"]}` and `enforcement: "strict"`
that every phase inherits unless overridden — illustrating narrowest-wins merge.

---

## Test setup

- **Server**: Node's built-in test runner via `tsx`: `npm -w server run test` →
  `tsx --import ./src/testHome.ts --test "src/**/*.test.ts"`. 101 `*.test.ts` files,
  ~1511 top-level `test(`/`it(` call sites (nested subtests not counted).
  Coverage gate: `npm -w server run test:coverage` (`--experimental-test-coverage`,
  thresholds: lines 73%, functions 59%, branches 61%).
- **Web**: Vitest — `npm -w web run test` → `vitest run`. 114 `*.test.ts(x)` files,
  ~1049 `test(`/`it(` call sites. Coverage gate: `npm -w web run test:coverage`.
- **Root**: `npm test` runs server then web tests sequentially.
- ARCHITECTURE.md references a historical "735-test suite" milestone (pre-Weave DAG
  refactor) — current counts above are larger and current as observed in the tree.

## Lint / typecheck / format

- `npm run typecheck` → `contracts`, `server`, `web` each run `tsc` (`--noEmit` for
  server/contracts, `tsc -b` for web) in sequence.
- `npm run lint` → per-workspace `eslint .`.
- `npm run format` / `format:check` → root Prettier over the whole repo.
- Composite: `npm run check` = typecheck + lint + test (no build/coverage).

## CI enforcement (`.github/workflows/ci.yml`)

Single `check` job on push/PR: `npm ci` → typecheck → lint → format:check → `npm test`
→ `node scripts/check-contracts-runtime.mjs` (fails if `@argus/contracts` emits any
runtime JS — it must stay types-only) → server coverage gate → web coverage gate →
`npm run build` (web+server) → `node scripts/check-bundle-size.mjs` (initial gzipped
payload budget) → `node scripts/check-motion-budget.mjs` (CSS motion-property budget,
transform/opacity only). A separate `codeql.yml` runs CodeQL JS/TS analysis on push/PR
and weekly cron.

## Coding conventions observed

- **Contracts-first DTOs**: every boundary-crossing shape lives once in
  `contracts/src/*.ts` (types-only package, enforced by
  `scripts/check-contracts-runtime.mjs`; `index.ts` uses `export type` not `export *`).
  Server-internal-only shapes (on-disk formats, engine state) deliberately stay out of
  `contracts` because the web never observes them.
- **Pure transitions vs. engine (I/O)**: strict split between `pipelineEngine.ts`
  (owns every side effect — spawn, kill, timers, writes) and `pipelineTransitions.ts`
  (pure functions computing what a signal/report _means_ for instance state, no I/O).
  The harness repeats this split: `harness/invocation.ts` "prepares, and only
  prepares" (pure, returns data the engine acts on); `harness/childEnv.ts` is the one
  place environment is assembled; `harness/verification.ts` is the one place checks run.
- **One-module-per-domain (`sources/`)**: `server/src/sources/*.ts`, each file one
  read-domain (jobs, daemon, sessions, stats, verdict, autopsy, watchtower, ledger,
  dag, nextFire, journal, recorder...), exporting plain async functions returning
  normalized DTOs — explicit SRP/DIP/OCP rationale in ARCHITECTURE.md §3.
  Runtimes get the same treatment (`runtimes/claude.ts|codex.ts|opencode.ts|qwen.ts`
  behind one seam in `runtimes/types.ts`+`index.ts`).
- **Test style**: colocated `*.test.ts` beside the module under test (not a separate
  `__tests__` tree), using each ecosystem's native runner (Node's `node:test` for
  server, Vitest for web) rather than Jest/Mocha. Many modules document _why_, not
  just _what_, in header block comments (e.g. `contracts/src/ledger.ts`,
  `contracts/src/autopsy.ts`) — design rationale is written into the source, and
  ARCHITECTURE.md's prose consistently narrates specific past bugs a given design
  choice fixed ("this was a bug before it was a design").
- **Defensive reads / fail-open on data, fail-closed on safety**: every disk read
  degrades to a fallback rather than throwing (`readJson(file, fallback)`); by
  contrast, capability/verification code fails closed (e.g. `changed-files` "cannot be
  evaluated" rather than silently ignoring commits it can't diff; `enforcement:
"strict"` refuses to launch rather than under-enforcing).
