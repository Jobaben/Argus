---
name: argus-pipeline
description: Create, change, repair or review an Argus pipeline definition (phases, steps, gates, triggers, checks, worktrees, retries, routing, spawn phases) and get it running. Use when someone wants Argus to run agent work as a pipeline, asks why a pipeline failed or never started, or wants an existing pipeline edited, scheduled or enabled.
---

# Authoring Argus pipelines

An Argus pipeline is a JSON definition: **phases** (a DAG, linear by default),
each with a working directory and one or more **steps**. A step is one fresh
headless agent run (Claude Code, Codex, OpenCode or Qwen Code). Argus decides
whether a phase succeeded from the agent's outcome marker, an optional
structured result, its own **checks** and, on a **gated** phase, a person.

This skill reads the same in Claude Code (`/argus-pipeline`) and Codex
(`$argus-pipeline`). The goal: a definition that saves on the first try and
does what was meant on its first run.

Paths below that start with `{{argusRoot}}` point into the Argus build this
skill came from. If they still show the placeholder itself, you are reading
the copy inside the Argus repository: use its root.

Next to this file: [definition.md](reference/definition.md) (every field,
default, limit, trigger, check, placeholder and environment variable),
[recipes.md](reference/recipes.md) (complete definitions that pass the
validator) and [troubleshooting.md](reference/troubleshooting.md) (validator
messages, run failures, gates, where the evidence is).

## The commands

```bash
argus pipeline runtimes [--json]            # installed runtimes, their models and efforts
argus pipeline list [--json]                # every definition: id, name, trigger, enabled, phases
argus pipeline show <id|name>               # the stored definition as JSON
argus pipeline validate <file|-> [--as <id>]  # every save-time check, no save: normalised definition or the 400 reason
argus pipeline create <file|->              # save a new definition; prints its id
argus pipeline update <id> <file|-> [--patch] [--force]  # PUT, or PATCH with --patch
argus pipeline start <id>                   # start an instance now: runs agents, costs money
argus tail --for 0                          # snapshot: running, waiting, just finished
argus tail --for 5m --until-idle            # follow until nothing runs (gates do not hold it)
argus approve <instanceId> [--phase <id>]   # only on the person's word
argus revise <instanceId> --note "…" [--phase <id>]
```

Exit status `0` ok, `1` refused, invalid or unreachable (stderr says why), `2`
bad arguments. The CLI uses `ARGUS_PORT` and `ARGUS_TOKEN`; `--url <base>` and
`--token <t>` override them. Everything except `list`, `show`, `runtimes` and
`tail` needs an Argus account: `ARGUS_USER` and `ARGUS_PASSWORD`, since a tool
call cannot answer the password prompt. If a call is unauthorized or cannot
connect, the variables may not be set in the shell your tools run in: ask the
person how this machine provides them, or pass `--url`/`--token`.

**Only the server writes definitions.** Never edit
`~/.claude/argus/pipelines.json` by hand or by script: the server owns it under
a store lock, and validation needs the server. If Argus is not reachable, tell
the person to start it (`argus`) and stop there.

## The workflow

1. **Map the request.** Each distinct stage becomes a phase; the actions
   inside a stage become its steps. Sort every criterion three ways:
   - a human checkpoint ("let me approve before deploy") → `gated: true`;
   - a quality bar ("only pass if tests are green", "don't touch files outside
     `src/`") → an explicit acceptance criterion in the step prompt, **and** a
     check wherever it can be tested mechanically;
   - a cadence → `trigger`; none given means `null` (manual).

2. **Ask, don't guess.** Ask the person (in Claude Code, with the
   AskUserQuestion tool) only what is still unresolved. Typically:
   - each phase's `cwd`: required, must exist on the Argus machine, and the
     field most often missing. Never invent one; offer the current repository
     root as an option;
   - the cadence, when the flow reads as scheduled but none was given;
   - whether a phase is gated, when that is ambiguous;
   - runtime and model, if they care;
   - anything that acts outside Argus (pushes, pull requests, comments,
     tickets, deploys).

3. **Look at what exists.** `argus pipeline runtimes` (available runtimes and
   their model names) and `argus pipeline list`. If a pipeline already does
   most of the job, `show` it and change it rather than adding a near-copy. To
   repair one, start from `show` and its last instance's
   [evidence](reference/troubleshooting.md#reading-the-evidence).

4. **Pick the shape** from [recipes](reference/recipes.md) and start from the
   smallest one that does the job. Add candidates, memory, rubrics or
   knowledge phases only when the job needs them.

5. **Draft the JSON in a scratch or temp directory**, never in the person's
   repository. Use readable phase ids (`plan`, `build`, `review`): `needs`,
   routes, `{{artifacts.*}}`, spawn sources and knowledge selectors refer to
   them. An id is 1-80 letters, digits, `.`, `-` or `_`, starting with a letter
   or digit, unique in the pipeline. Set `runtime`; give every phase
   `timeoutSeconds` and `stallSeconds`. Models: omit unless asked; pipeline
   `model` for "everything on X", step `model` for "X for the review step";
   prefer names `runtimes` lists (any well-formed id saves, and a wrong one
   only fails at run time).

6. **Validate until clean:** `argus pipeline validate draft.json` (`--as <id>`
   for a change to an existing pipeline). Fix each `400` as worded. Then
   compare the printed definition with your draft: unknown keys on the
   pipeline, a phase or a step are dropped without an error, so a field missing
   there is a typo.

7. **Preview and confirm.** Show a compact summary: name, trigger, enabled,
   and per phase its id, name, `cwd`, gated, runtime/model if set, step names,
   checks, `needs`. Get a "looks right?" before `create` or `update`.

8. **Create it inert:** `"trigger": null`, or the real trigger with
   `"enabled": false`. Absent `enabled` means `true`, and an enabled schedule
   starts on its own. A spawn parent needs its child created first.

9. **First run, watched.** Starting spends money: get the go-ahead unless the
   person already asked for a run. `argus pipeline start <id>`, then
   `argus tail --for 5m --until-idle` (under your tool timeout; repeat to keep
   following). At a gate, relay the ⏸ line and its review link.

10. **Inspect the evidence**, not the agent's summary: phase status and failure
    class, check output, the result value, the branch, the journal, the run
    log. Did each phase do what was meant, not merely succeed?

11. **Fix and re-run.** `show` into a file, edit, `validate --as <id>`,
    `update <id> <file>`. An instance keeps the definition it started with: an
    edit reaches the next start only, and while one is live an execution edit
    is `409 instances-running` unless `--force`. Repeat until one run is right.

12. **Only then switch it on:** the real trigger and `"enabled": true`
    (`update --patch` with just those keys). Ask first whenever it will spend
    unattended or act outside Argus; say how often it fires and what one run
    cost.

13. **Relay the outcome plainly:** what was created or changed and its id,
    whether it was started, the instance id and how to follow it
    (`argus tail`), what is enabled and when it fires, and what is left for
    the person to decide.

## Rules that prevent most broken pipelines

**The outcome marker is Argus's job.** Argus tells every step to end with
`ARGUS_OUTCOME: succeeded`, or `failed` / `blocked` with a reason. Do not write
that into prompts, do not quote the marker, and do not dictate a reply format
("answer only with JSON") that leaves no room for it. State the acceptance bar;
the agent reports against it. A completion with no marker, or two different
ones, fails as **`unverified`**: a protocol failure, retried by default, not a
verdict. Keep `completion.marker: "required"`; `lenient` only hides that the
agent never said it finished. The marker is the agent's claim, never proof.

**Results go to `ARGUS_RESULT_FILE`, not prose.** Anything a later phase or a
route depends on is a `result` with a schema. Argus appends the schema and the
file instruction to the result step's prompt; the prompt itself says what each
field means and how to decide it. A missing or invalid result fails the phase.
An agent that decides "reject" has succeeded. Do not route on payload text.

**Prompts are self-contained.** Each step is a fresh process in the phase's
`cwd`, with no memory of other steps, this conversation or earlier instances.
Say what the repository is, what to do, what not to touch, how to verify, and
what success means. Pass earlier work with `{{artifacts.<name>}}`, a webhook
body or spawned task with `{{trigger.payload}}`. Unknown placeholders become
empty text.

**Steps in one phase run at the same time.** Ordered work goes in separate
phases.

**`cwd` must exist** on the Argus machine when you save, as an absolute path.
So must `additionalDirectories` and `claudeConfigDir`.

**Gate where a person must look:** before work that is expensive, hard to
undo, or acts outside Argus, and after a plan the rest depends on. Results and
checks are evaluated before the gate opens; a gate is a decision, not proof.

**Checks are the real proof.** Give every phase that changes something a
`command` check (the repository's own test or lint command), a `changed-files`
check (`requireChanges` when doing nothing is a failure), or an `artifact`
check for a required file. They run in the phase's worktree under the phase's
environment policy.

**Retries.** `retryOn` defaults to `["spawn", "exit-code", "unverified"]`.
`signal` is left out on purpose: the agent considered the work and reported
failure, so the same prompt mostly fails again at the same price. An explicit
list replaces the default, so name `unverified` yourself. Add `verification`
to retry failed checks (their output goes into the retry prompt), `timeout` for
timeouts and stalls, `signal` on a phase a spawn phase reads its task list
from. `configuration` is never retried: fix the definition.

**Timeouts.** Without `timeoutSeconds` a step may run forever; without
`stallSeconds` (≥ 30) a hung command is noticed only at the timeout.

**Worktrees** give the work its own branch. Only committed work survives: the
directory goes when the instance ends, so make the agent commit and check it
(`git diff --quiet HEAD`), or set `keep: true`. The tree is cut from `base`
(default `HEAD` of `cwd`): uncommitted edits in the checkout are not in it, and
Argus never fetches. A phase with its own `workspace` does not share the
pipeline's tree; for phases that build on each other, put `"scope":
"instance"` on the pipeline only. Nothing merges the branch.

**`overlapPolicy: "skip"`** (the default) for anything that claims a resource,
edits a shared checkout or polls a queue. `"allow"` for a spawn target and for
instances that share nothing.

**Secrets never go in the definition.** `GET /api/pipelines` returns every
definition, `env.set` values and webhook `hookToken`s included, to callers
without an account. Pass credential names with `env.allow`.

**Capability profiles** merge by top-level key: a phase `env` replaces the
pipeline's whole `env`. Claude Code `read-only` denies bare `Bash` unless
`tools.allow` names commands. Codex `read-only` cannot write the result file or
artifacts; use `workspace-write`. OpenCode and Qwen enforce no key, so a
profile there needs `"enforcement": "best-effort"`. Argus grants a profiled run
its own result, artifact and memory paths; do not add `Write` or
`Bash(printenv:*)` for them.

**There is no "no work" outcome** and no step-less phase. A job that may find
nothing decides it in a `result` (`{ "found": false }`) and routes the work
phase on it; the skipped branch lets the instance succeed. A precondition
belongs in a `command` check, not in an agent step that only reports it.

**Spawn phases:** create the child first, with `"trigger": null` (or a
webhook) and `"overlapPolicy": "allow"`. Children run one at a time, and each
runs the child's agents, so spend multiplies with the task count.

**Knowledge Ledger phases** (`discovery`, `ruleVerification`, `changeIntent`,
`implementation`, `acceptanceVerification`, `knowledgeContext`) have their own
protocols; follow
[the knowledge guide]({{argusRoot}}/docs/guides/knowledge.md#authoring-knowledge-workflows).
Their caps are not yet in the agent contract: read them from the code (a
KnowledgeDelta section holds at most 64 entries, `DELTA_SECTION_MAX` in
`{{argusRoot}}/server/src/knowledge/delta.ts`). A person approves their gates.

**Decisions belong to people.** Never approve, revise or abort on your own
judgement, never create an Argus account, and never enable a trigger, webhook
or `after` chain unasked. Money is spent by `start`, by an enabled trigger
firing, by approving a gate, by each retry, by `candidates` (N runs) and by
spawn phases (an instance per task); prompts that push, comment or claim act on
real systems from the first run.

## Deeper reading

- [Pipelines guide]({{argusRoot}}/docs/guides/pipelines.md),
  [API § Phase fields]({{argusRoot}}/docs/API.md#phase-fields),
  [API § Pipelines]({{argusRoot}}/docs/API.md#pipelines-v03)
- [HARNESS.md]({{argusRoot}}/docs/HARNESS.md) §2 completion, §3–4
  capabilities and environment, §6 checks, §7 timeouts, §11 worktrees, §12
  candidates, §13 context, §20 spawn; the
  [reference pipeline]({{argusRoot}}/docs/HARNESS.md#9-reference-pipeline)
- [Scheduling guide]({{argusRoot}}/docs/guides/scheduling.md),
  [runtimes]({{argusRoot}}/docs/reference/runtimes.md)
- The validator: `{{argusRoot}}/server/src/sources/pipelines.ts`
