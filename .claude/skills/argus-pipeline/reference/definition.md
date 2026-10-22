# Pipeline definition reference

The authority is the save-time validator, `validatePipelineInput` in
`{{argusRoot}}/server/src/sources/pipelines.ts`, and the types in
`{{argusRoot}}/contracts/src/pipelines.ts`. `argus pipeline validate` runs the
same checks. Where this page and the code disagree, the code wins.

## How the validator treats what you send

- **Unknown keys are dropped without an error** on the pipeline, on a phase, on
  a step, inside `retry`, `result`, a `needs` edge, `when`, `trigger` and
  `capabilities.env`/`tools`. A typo (`dependsOn` on a phase, `timeout` on a
  step) simply disappears. Compare the normalised definition that `validate`
  prints with your draft.
- **Unknown keys are a `400`** inside `capabilities`, `workspace`,
  `candidates` (and its variants), `completion`, `contextLimits`, `memory`,
  `checks[i]`, `approveWhen`, `spawn` (and its sources) and `childrenContext`,
  and on a spawn phase.
- **Coercions.** `gated` and `enabled` go through `Boolean()`, so the string
  `"false"` is `true`. `overlapPolicy` is `"allow"` or else `"skip"`. Numbers
  go through `Number()`. Names, prompts and ids are trimmed.
- **`cwd` and `additionalDirectories` must exist on the machine Argus runs
  on**, at save time.
- **Server-owned fields** (`id`, `hookToken`, `lastStartedAt`, `createdAt`,
  `updatedAt`) are ignored on input, so the JSON `argus pipeline show` prints
  can be sent back unchanged.

## Pipeline fields

| Field             | Type                                          | Default                             | Limits enforced                                                                                                                                                 | Purpose                                                                                                                                         |
| ----------------- | --------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | string                                        | required                            | non-empty                                                                                                                                                       | Shown everywhere; `argus pipeline show` accepts it.                                                                                             |
| `phases`          | `PhaseDef[]`                                  | required                            | at least one; ids unique; graph acyclic                                                                                                                         | The work.                                                                                                                                       |
| `trigger`         | `Trigger \| null`                             | `null` (absent = manual)            | see [Triggers](#triggers)                                                                                                                                       | When Argus starts an instance on its own.                                                                                                       |
| `enabled`         | boolean                                       | `true`                              | —                                                                                                                                                               | Off stops the scheduler, `after` chains and the webhook (`409`). A manual start still works.                                                    |
| `overlapPolicy`   | `"skip" \| "allow"`                           | `"skip"`                            | —                                                                                                                                                               | `skip`: no new instance while one is running or waiting at a gate.                                                                              |
| `runtime`         | `"claude" \| "codex" \| "opencode" \| "qwen"` | server default (`ARGUS_AGENT`)      | one of the four                                                                                                                                                 | Default CLI for every step. Narrowest wins: step, phase, pipeline, server.                                                                      |
| `model`           | string                                        | the CLI's default                   | `^[A-Za-z0-9][A-Za-z0-9._:/-]*$`                                                                                                                                | Default model for every step, whatever its runtime. Set it per step when runtimes are mixed.                                                    |
| `reasoningEffort` | `minimal \| low \| medium \| high \| xhigh`   | the CLI's default                   | one of the five                                                                                                                                                 | Codex and OpenCode only. There is no phase-level field.                                                                                         |
| `capabilities`    | `CapabilityProfile`                           | none (CLI defaults)                 | see [Capabilities](#capabilities-and-environment)                                                                                                               | Default profile, merged by top-level key with phase and step profiles.                                                                          |
| `claudeConfigDir` | absolute path                                 | none (operator's `~/.claude`)       | existing directory; not, and not containing, the operator's Claude home or Argus's work root; no phase `cwd` inside it; no `env.set.CLAUDE_CONFIG_DIR` anywhere | A Claude setup folder of the pipeline's own. [HARNESS §3b]({{argusRoot}}/docs/HARNESS.md#3b-a-claude-setup-folder-per-pipeline-claudeconfigdir) |
| `completion`      | `{ "marker": "required" \| "lenient" }`       | `required`                          | only `marker`                                                                                                                                                   | What a completion must carry. Keep `required`; see [Completion](#completion).                                                                   |
| `workspace`       | `WorkspacePolicy`                             | none (each phase runs in its `cwd`) | see [Workspace](#workspace)                                                                                                                                     | Default git worktree policy.                                                                                                                    |
| `knowledgeScope`  | object                                        | unscoped                            | see the knowledge docs                                                                                                                                          | Which project and repository the pipeline's knowledge belongs to.                                                                               |
| `contextLimits`   | `{ "placeholderBytes": n }`                   | 16384                               | 1024–262144                                                                                                                                                     | Cap on each interpolated placeholder value.                                                                                                     |
| `memory`          | `{ "enabled": bool, "maxBytes"?: n }`         | off                                 | `enabled` required; `maxBytes` 1024–65536, default 8192                                                                                                         | Durable `NOTES.md` shared by the pipeline's instances.                                                                                          |

## Phase fields

| Field                                                                                                                          | Type                                      | Default        | Limits enforced                                                                                                                                       | Purpose                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                                                                                           | string                                    | required       | `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`, unique                                                                                                           | Names directories and branches; edges and placeholders use it.                                                                                                                                   |
| `name`                                                                                                                         | string                                    | required       | non-empty                                                                                                                                             | Display name.                                                                                                                                                                                    |
| `cwd`                                                                                                                          | absolute path                             | required       | must exist now, also on a spawn phase                                                                                                                 | Where steps and checks run (the worktree replaces it when one is declared).                                                                                                                      |
| `steps`                                                                                                                        | `PhaseStep[]`                             | required       | at least one; `[]` only on a spawn phase                                                                                                              | Headless agent runs. **They run concurrently**, not in order.                                                                                                                                    |
| `gated`                                                                                                                        | boolean                                   | `false`        | —                                                                                                                                                     | Wait for a person (or `approveWhen`/`autoApprove`) after the steps, result and checks pass.                                                                                                      |
| `needs`                                                                                                                        | `(string \| DependencyEdge)[]`            | linear         | edges name existing phases, no self-edge, no duplicate, no cycle, at least one root                                                                   | Dependencies. If no phase declares `needs`, each needs the previous one; if any does, phases without it are roots.                                                                               |
| `retry`                                                                                                                        | `{ attempts, backoffSeconds?, retryOn? }` | one attempt    | `attempts` 1–10 (total, including the first); `backoffSeconds` 0–3600, default 30, doubles per retry, capped at 1 h; `retryOn` from the classes below | Automatic re-runs with the failure reason appended to the prompt.                                                                                                                                |
| `completion`                                                                                                                   | `{ "marker": ... }`                       | the pipeline's | only `marker`                                                                                                                                         | Per-phase override.                                                                                                                                                                              |
| `produces`                                                                                                                     | string                                    | none           | `^[A-Za-z0-9_-]{1,40}$`                                                                                                                               | Publish the phase payload as `{{artifacts.<name>}}`.                                                                                                                                             |
| `result`                                                                                                                       | `{ artifact, resultStep?, schema }`       | none           | see [Result and routing](#result-and-routing)                                                                                                         | A validated JSON value the agent writes to `ARGUS_RESULT_FILE`; routes branch on it.                                                                                                             |
| `runtime`                                                                                                                      | runtime id                                | the pipeline's | one of four                                                                                                                                           | Per-phase runtime. There is no phase `model`.                                                                                                                                                    |
| `timeoutSeconds`                                                                                                               | integer                                   | no limit       | 1–86400                                                                                                                                               | Wall-clock limit per step process. Failure class `timeout`.                                                                                                                                      |
| `stallSeconds`                                                                                                                 | integer                                   | off            | 30–86400                                                                                                                                              | Kill a step whose transcript is silent this long. Also class `timeout`.                                                                                                                          |
| `capabilities`                                                                                                                 | `CapabilityProfile`                       | the pipeline's | as below                                                                                                                                              | Merged by top-level key over the pipeline's.                                                                                                                                                     |
| `checks`                                                                                                                       | `PhaseCheck[]`                            | none           | at most 50                                                                                                                                            | Argus's own proof. See [Checks](#checks).                                                                                                                                                        |
| `workspace`                                                                                                                    | `WorkspacePolicy`                         | the pipeline's | as below                                                                                                                                              | Per-phase isolation; `{ "scope": "none" }` opts out.                                                                                                                                             |
| `candidates`                                                                                                                   | `{ count, select, variants? }`            | none           | see [Candidates](#candidates)                                                                                                                         | Best-of-N for a one-step phase.                                                                                                                                                                  |
| `approveWhen`                                                                                                                  | `ApprovalCondition`                       | none           | gated phases only; not on a phase that commits knowledge                                                                                              | A polled command opens the gate. See [approveWhen](#approvewhen).                                                                                                                                |
| `rubric`, `autoApprove`                                                                                                        | objects                                   | none           | `autoApprove` needs `rubric` and `gated`                                                                                                              | Model-scored gate. [API § Declaring a rubric]({{argusRoot}}/docs/API.md#declaring-a-rubric)                                                                                                      |
| `spawn`                                                                                                                        | `SpawnPolicy`                             | none           | see [Spawn](#spawn)                                                                                                                                   | Turns the phase into a spawn phase.                                                                                                                                                              |
| `childrenContext`                                                                                                              | `{ "fromPhase": id }`                     | none           | `fromPhase` is a spawn phase this phase transitively needs                                                                                            | A read-only manifest of the children at `ARGUS_CHILDREN_FILE`.                                                                                                                                   |
| `knowledgeContext`                                                                                                             | `{ claims?, fromPhases? }`                | none           | 1–64 claim selectors; 1–8 `fromPhases`, each a transitive dependency; total 64                                                                        | Canonical knowledge given read-only at `ARGUS_KNOWLEDGE_CONTEXT_FILE`.                                                                                                                           |
| `knowledgeDelta`                                                                                                               | `"optional" \| "required"`                | `optional`     | —                                                                                                                                                     | Whether the launch depends on the delta channel being writable.                                                                                                                                  |
| `knowledgeScope`, `discovery`, `ruleVerification`, `changeIntent`, `changeContext`, `implementation`, `acceptanceVerification` | objects                                   | none           | see the knowledge docs                                                                                                                                | Knowledge Ledger phases. [Knowledge guide]({{argusRoot}}/docs/guides/knowledge.md#authoring-knowledge-workflows), [HARNESS §14]({{argusRoot}}/docs/HARNESS.md#14-business-rule-discovery-phases) |

## Step fields

| Field              | Type                | Default    | Limits enforced  | Purpose                                              |
| ------------------ | ------------------- | ---------- | ---------------- | ---------------------------------------------------- |
| `name`             | string              | required   | non-empty        | Keep it unique in the phase (not checked).           |
| `prompt`           | string              | required   | non-empty        | The whole task. Placeholders below are interpolated. |
| `runtime`          | runtime id          | phase's    | one of four      | Per-step runtime.                                    |
| `model`            | string              | pipeline's | model pattern    | Per-step model.                                      |
| `reasoningEffort`  | effort              | pipeline's | one of five      | Per-step effort (Codex, OpenCode).                   |
| `timeoutSeconds`   | integer             | phase's    | 1–86400          | Overrides the phase.                                 |
| `stallSeconds`     | integer             | phase's    | 30–86400         | Overrides the phase.                                 |
| `capabilities`     | `CapabilityProfile` | phase's    | as below         | Merged by top-level key over phase and pipeline.     |
| `knowledgeContext` | object              | phase's    | as for the phase | Replaces the phase's for this step.                  |

A step has no `cwd`, `checks` or `gated` of its own.

## Triggers

All times are the server's local time. A slot fires only within a grace window
of max(2 scheduler ticks, 5 minutes); pipelines have no catch-up. An interval
is measured from the last start (or creation). The scheduler skips a pipeline
with `enabled: false` or no trigger.

| Shape                                                                                                               | Rules                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `null`                                                                                                              | Manual only: `argus pipeline start`, the UI, or a spawn parent.                                                                                                                                                                                                                                   |
| `{ "kind": "interval", "everyMinutes": 60 }`                                                                        | `everyMinutes` ≥ 1, floored.                                                                                                                                                                                                                                                                      |
| `{ "kind": "daily", "time": "06:30" }`                                                                              | `time` is `HH:MM`.                                                                                                                                                                                                                                                                                |
| `{ "kind": "weekly", "time": "06:30", "weekday": 1 }`                                                               | `weekday` 0–6, 0 = Sunday.                                                                                                                                                                                                                                                                        |
| `{ "kind": "windowed", "startTime": "08:00", "endTime": "17:00", "everyMinutes": 30, "weekdays": [1, 2, 3, 4, 5] }` | Fires every `everyMinutes` from `startTime`; `endTime` exclusive and must differ; an end before the start wraps past midnight; `weekdays` (optional, 0–6) binds to the day the window opens. Pipelines only.                                                                                      |
| `{ "kind": "webhook" }`                                                                                             | No other field (a cadence field is a `400`). Saving mints `hookToken`. Fire with `POST /api/hooks/pipelines/<id>` and `Authorization: Bearer <hookToken>`; `ARGUS_TOKEN` is not accepted there. The JSON body (≤ 64 KiB) becomes `{{trigger.payload}}`. `409` when disabled or busy under `skip`. |
| `{ "kind": "after", "pipelineId": "<id>", "on": "succeeded" \| "failed" \| "any" }`                                 | The source must exist, not be this pipeline, and not chain after this one. `failed` includes aborted. Only instances that ended after this pipeline's last save fire it. Payload `{ sourceInstanceId, sourcePipelineId, status }`.                                                                |

Details: [scheduling guide]({{argusRoot}}/docs/guides/scheduling.md#scheduler),
[API § Webhook and chained triggers]({{argusRoot}}/docs/API.md#webhook-and-chained-triggers-v04).

## Completion

Argus appends its own instruction to every step: end the last message with
`ARGUS_OUTCOME: succeeded`, or `failed` / `blocked` with a one-line reason. Do
not repeat that mechanic in prompts; state the success criteria instead.

| Final message read as | `required` (default)        | `lenient`                        |
| --------------------- | --------------------------- | -------------------------------- |
| `succeeded`           | accepted                    | accepted                         |
| no marker             | refused, class `unverified` | accepted on the signal path only |
| two different markers | refused, class `unverified` | refused, class `unverified`      |
| `failed` / `blocked`  | refused, class `signal`     | refused, class `signal`          |

On the run-record path (Codex fallback, OpenCode), a missing marker is
`unverified` under either policy. A marker is the agent's report, never
verification. [HARNESS §2]({{argusRoot}}/docs/HARNESS.md#completion-policy-the-agents-report-not-verification)

## Retry classes

`retryOn` may name: `spawn`, `exit-code`, `signal`, `timeout`, `verification`,
`unverified`, `knowledge-delta`, `knowledge-context-integrity`,
`rule-verification`, `change-proposal`, `change-context-integrity`,
`acceptance-verification`. Absent, it is `["spawn", "exit-code",
"unverified"]`. An explicit list replaces the default, so name `unverified`
yourself. `configuration` and `approval-condition` are never retried. A
revise resets the retry budget. [HARNESS §2]({{argusRoot}}/docs/HARNESS.md#2-agent-completion--phase-success)

## Result and routing

```json
"result": {
  "artifact": "evaluation",
  "resultStep": "decide",
  "schema": {
    "type": "object",
    "required": ["accepted"],
    "properties": { "accepted": { "type": "boolean" } }
  }
}
```

- `artifact`: `^[A-Za-z0-9_-]{1,40}$`; the validated value is published as
  `{{artifacts.<artifact>}}`.
- `resultStep`: required when the phase has more than one step; must name one.
- `schema`: `type` is `object | array | string | number | boolean | null`;
  `properties` and `required` on objects only, `items` on arrays only, `enum`
  a non-empty list of scalars of the declared type; at most 8 levels deep.
- Argus appends the schema and the `ARGUS_RESULT_FILE` instruction to the
  result step's prompt. A missing, unparseable or schema-invalid file fails
  the phase under `signal`.

A `needs` entry is a phase id string or an edge object:

```json
{ "phase": "evaluate", "when": { "predicate": { "path": ["accepted"], "operator": "equals", "value": true } } }
{ "phase": "repair", "allowSkipped": true }
```

| Field            | Rules                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `when.predicate` | `path`: non-empty list of property names the source schema declares; `operator`: `equals`, `not-equals`, `one-of` (a list), `exists` (no value). The value must fit the leaf's type and enum; objects and arrays cannot be compared. |
| `when.group`     | Names one decision. All members share one source and agree on `exclusive` and `required`.                                                                                                                                            |
| `when.exclusive` | At most one member may match; two fail the source phase. Needs `group`.                                                                                                                                                              |
| `when.required`  | At least one member must match. Needs `group`.                                                                                                                                                                                       |
| `when.default`   | `true` only; taken when nothing else matched; no `predicate`; at most one per group. Needs `group`.                                                                                                                                  |
| `allowSkipped`   | Accept a source that was skipped by routing (a join after alternatives).                                                                                                                                                             |

A `when` needs a `predicate` or `default: true`. The source must declare a
`result`. An unselected target is `skipped`, and the skip travels to anything
that only depended on it. An instance whose phases all succeeded or were
skipped succeeds. A failure is never a skip. A gated deciding phase takes its
route on approval. [API § Outcome routing]({{argusRoot}}/docs/API.md#outcome-routing)

## Checks

Checks run after every step reports success, in order, all of them, in the
phase's worktree (else its `cwd`). A failure fails the phase under
`verification`. Each kind takes only its own keys plus `label` (≤ 120 chars).

| Kind            | Fields                                                                 | Semantics                                                                                                                         |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `command`       | `run` (≤ 4000 chars), `cwd?`, `timeoutSeconds?` (1–86400, default 600) | Shell command; exit 0 passes. Runs under the phase's env policy. `run` is never interpolated. Last 4000 chars of output are kept. |
| `artifact`      | `path` (relative, no `..`), `minBytes?` (≥ 0, default 1)               | A file in the phase's artifact directory. Symlinks fail. Argus tells the agent which files it must leave there.                   |
| `file`          | same as `artifact`                                                     | A file in the phase's working tree.                                                                                               |
| `changed-files` | `allow?`, `deny?` (globs), `requireChanges?`                           | Paths changed since the attempt's baseline, commits included. `requireChanges: true` fails a phase that changed nothing.          |
| `trajectory`    | `thresholds` (signal → max count 0–10000), `requireTranscript?`        | Signals `repetition`, `errors`, `edit-revert`, `path`, `destructive-command`. Can be `not-evaluated`.                             |

[HARNESS §6]({{argusRoot}}/docs/HARNESS.md#6-verification-checks)

## Workspace

`{ "scope": "instance" | "attempt" | "none", "base"?: "<ref>", "keep"?: bool }`

- `instance`: one worktree shared by every phase that uses the policy;
  `attempt`: a fresh one per phase attempt; `none`: run in `cwd`.
- `base`: default `HEAD` of the repository at `cwd`. No whitespace, no leading
  `-`. Argus never fetches.
- `keep`: default `false`. The directory is removed when the instance ends;
  the branch (`argus/<instanceId>/…`) is kept. **Uncommitted work is lost.**
- `phase.workspace ?? pipeline.workspace`: a phase that declares its own
  workspace does not share the pipeline's tree.
- A `cwd` outside a git work tree, or a `base` that does not resolve, fails
  the phase under `configuration`.

[HARNESS §11]({{argusRoot}}/docs/HARNESS.md#11-workspace-isolation)

## Candidates

`{ "count": 2-8, "select": "first-verified" | "cheapest-verified", "variants"?: [{ runtime?, model?, reasoningEffort? }] }`

Requires exactly one step and an effective `workspace.scope: "attempt"`.
Variants cycle when shorter than `count` (at most 8). Each candidate costs a
full run and a concurrency slot. Selection uses `checks` only, so declare
real ones. [HARNESS §12]({{argusRoot}}/docs/HARNESS.md#12-candidates)

## approveWhen

```json
"approveWhen": {
  "kind": "command",
  "run": "node /home/you/argus-checks/pr-merged.mjs",
  "label": "pull request merged",
  "everySeconds": 300,
  "timeoutSeconds": 60,
  "failOnExit": 3
}
```

`run` 1–4000 chars; `label` ≤ 120; `everySeconds` 30–86400 (required);
`timeoutSeconds` 1–600, default 60; `failOnExit` 1–255; `cwd` optional. Exit 0
approves; `failOnExit` fails the phase under `approval-condition` (never
retried); anything else keeps waiting. Runs in the worktree with the check
variables below. Keep the script outside the repository the agent edits, and
read-only. [HARNESS § Approval conditions]({{argusRoot}}/docs/HARNESS.md#approval-conditions)

## Spawn

A spawn phase declares only `id`, `name`, `cwd`, `needs`, `produces` and
`spawn` (`steps: []` and `gated: false` are accepted back).

| Field         | Rules                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipelineId`  | Another existing pipeline, trigger `null` or webhook, with no spawn phase. Checked on create/update and by `validate`.                                                     |
| `items`       | `{ "phase": id, "path": [names] }` (≤ 8 names, `[]` = whole result). The phase is a transitive dependency with a `result` whose schema declares an array of objects there. |
| `key`         | A required string property of each task. Values unique, `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.                                                                               |
| `dependsOn`   | Optional; an array-of-strings property; not the key.                                                                                                                       |
| `title`       | Optional; a string property; not the `dependsOn` property.                                                                                                                 |
| `maxParallel` | Optional; only `1` is accepted for now.                                                                                                                                    |
| `maxItems`    | Optional; 1–50, default 20.                                                                                                                                                |
| `base`        | Optional git ref for every child's worktrees. Never fetched.                                                                                                               |
| `include`     | Optional; ≤ 16 names (`^[A-Za-z0-9_-]{1,40}$`) → `{ phase, path }`; copied into each child's payload.                                                                      |

The task list is checked when the source phase submits its result; a bad list
fails that phase under `signal`, so add `signal` to its `retry.retryOn`. Each
child reads `{{trigger.payload}}` = `{ task, key, base?, include?, parent }`.
[HARNESS §20]({{argusRoot}}/docs/HARNESS.md#20-spawn-phases)

## Capabilities and environment

| Key                     | Values                                                           | Notes                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `filesystem`            | `read-only`, `workspace-write`, `unrestricted`                   | Claude Code: tool rules, not an OS sandbox. Read-only denies bare `Bash`/`PowerShell` unless `tools.allow` scopes them. |
| `tools`                 | `{ allow?, deny? }`, ≤ 200 rules each, no commas                 | The runtime's own grammar, e.g. `Bash(npm test:*)`.                                                                     |
| `mcpServers`            | name → `{ type?, command?, args?, env?, url?, headers? }`        | Present (even `{}`) = exactly these. Needs `command` or `url`.                                                          |
| `additionalDirectories` | absolute existing paths                                          | Extra directories the agent may use.                                                                                    |
| `settingSources`        | subset of `user`, `project`, `local`                             | Claude Code only.                                                                                                       |
| `permissionMode`        | `default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk` | Claude Code only.                                                                                                       |
| `maxTurns`              | 1–1000                                                           | Where the runtime supports it.                                                                                          |
| `env`                   | `{ inherit?: "all" \| "minimal", allow?, deny?, set? }`          | `allow`/`deny`: names or `PREFIX_*`. `set` may not name a reserved `ARGUS_*` variable.                                  |
| `enforcement`           | `strict` (default), `best-effort`                                | Strict refuses a launch the runtime cannot enforce (`configuration`, never retried).                                    |

- Profiles merge **by top-level key**: a phase `env` replaces the pipeline's
  whole `env`.
- OpenCode and Qwen enforce no key: any profile on them needs `best-effort`.
- Codex `read-only` cannot write the result file, artifact or memory
  directory: a strict launch is refused when the phase needs one.
- Under a profile, Argus grants the agent its own channels (result file,
  artifact and memory directories) and lists their paths in the prompt. Do not
  add `Write` or `Bash(printenv:*)` for them.
- **`env.set` values are stored in the definition, which `GET /api/pipelines`
  returns without an account.** Never put a secret there; let the CLI or the
  server environment carry it and pass the name with `env.allow`.

[HARNESS §3]({{argusRoot}}/docs/HARNESS.md#3-capability-profiles),
[§4]({{argusRoot}}/docs/HARNESS.md#4-environment-policy)

## Prompt placeholders

| Placeholder                 | Value                                                                                | Capped |
| --------------------------- | ------------------------------------------------------------------------------------ | ------ |
| `{{previous.payload}}`      | The payload of the phase's dependency (the last one in definition order if several). | yes    |
| `{{artifacts.<name>}}`      | A `produces` payload or a `result` value, by name.                                   | yes    |
| `{{artifactDir}}`           | This phase attempt's file-artifact directory (emptied each attempt).                 | no     |
| `{{artifactDir.<phaseId>}}` | An earlier phase's artifact directory. Not granted to a run under a profile.         | no     |
| `{{trigger.payload}}`       | The instance's trigger payload as JSON: webhook body, `after` payload or spawn task. | yes    |
| `{{memory}}`                | Tail of `NOTES.md` when `memory.enabled`.                                            | yes    |
| `{{previous.instance}}`     | One paragraph on the last settled instance of this pipeline.                         | yes    |

An unknown placeholder becomes empty text. A payload (`produces`,
`{{previous.payload}}`) is the stop hook's report object, which holds the
agent's final message among other fields; for a value a later phase relies
on, use `result`. Capped values are trimmed to `contextLimits.placeholderBytes`
with the full text written to a file the prompt names.
`{{workspace}}` is not a placeholder: the run's `cwd` is the worktree.
[HARNESS §13]({{argusRoot}}/docs/HARNESS.md#placeholders)

## Environment a step sees

| Variable                                                                                                                   | When                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`, `ARGUS_PHASE_ATTEMPT` (0-based), `ARGUS_RUN_ID`, `ARGUS_STEP_NAME`, `ARGUS_RUNTIME` | always                                                  |
| `ARGUS_SIGNAL_URL`, `ARGUS_SIGNAL_TOKEN`                                                                                   | runtimes with a stop hook (not OpenCode); per-run token |
| `ARGUS_ARTIFACT_DIR`                                                                                                       | always                                                  |
| `ARGUS_WORKSPACE`                                                                                                          | the phase runs in a worktree                            |
| `ARGUS_RESULT_FILE`                                                                                                        | the result step of a phase with `result`                |
| `ARGUS_KNOWLEDGE_DELTA_FILE`                                                                                               | always (writing a delta is optional)                    |
| `ARGUS_MEMORY_DIR`                                                                                                         | `memory.enabled`                                        |
| `ARGUS_KNOWLEDGE_CONTEXT_FILE`                                                                                             | `knowledgeContext` declared                             |
| `ARGUS_CHILDREN_FILE`                                                                                                      | `childrenContext` declared                              |
| `ARGUS_REVISION_NOTES_FILE`                                                                                                | revise notes did not all fit the prompt                 |
| `ARGUS_RULE_VERIFICATION_FILE`, `ARGUS_CHANGE_*_FILE`, …                                                                   | the matching knowledge phase kinds                      |

`ARGUS_TOKEN` and `ARGUS_WEBHOOK_URL` are always removed. A step does not get
`ARGUS_TRIGGER_PAYLOAD_FILE`; it reads `{{trigger.payload}}`.

**A `command` check and an `approveWhen` poll** see the phase's env policy
plus `ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`, `ARGUS_PHASE_ATTEMPT`,
`ARGUS_ARTIFACT_DIR`, `ARGUS_WORKSPACE` (when there is a worktree) and
`ARGUS_TRIGGER_PAYLOAD_FILE` (a JSON copy of the payload, when there is one).
[HARNESS § What a command check is told]({{argusRoot}}/docs/HARNESS.md#what-a-command-check-is-told)

## Updating a stored definition

- `argus pipeline update <id> <file>` is a `PUT`. Absent `trigger` becomes
  `null`, absent `enabled` becomes `true`, absent `overlapPolicy` becomes
  `skip`. Absent `model`, `runtime`, `capabilities`, `workspace`, `completion`,
  `memory`, `contextLimits`, `claudeConfigDir` and `knowledgeScope` keep their
  stored value, and `null` there does not clear them either.
- `--patch` is a `PATCH`: only the keys you send change, and `null` clears an
  optional pipeline field. `phases` in a patch replaces the whole list.
- A change to `phases`, `model`, `reasoningEffort`, `runtime`,
  `capabilities`, `claudeConfigDir`, `workspace` or `memory` while an
  instance is live is `409 instances-running`; `--force` saves it for the
  next start. Name, trigger, `enabled`, `overlapPolicy` and `contextLimits`
  save freely.
