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

References, next to this file:

- [reference/definition.md](reference/definition.md): every field, default,
  limit, trigger shape, check kind, placeholder and environment variable.
- [reference/recipes.md](reference/recipes.md): complete definitions that pass
  the validator, one per common shape.
- [reference/troubleshooting.md](reference/troubleshooting.md): validator
  messages, run failures, gates, and where the evidence is.

## The commands

```bash
argus pipeline runtimes [--json]            # installed runtimes, their models and efforts
argus pipeline list [--json]                # every definition: id, name, trigger, enabled, phases
argus pipeline show <id|name>               # the stored definition as JSON
argus pipeline validate <file|-> [--as <id>]  # full save-time checks, no save; prints the normalised definition or the 400 reason
argus pipeline create <file|->              # save a new definition; prints its id
argus pipeline update <id> <file|-> [--patch] [--force]  # PUT, or PATCH with --patch
argus pipeline start <id>                   # start an instance now: runs agents, costs money
argus tail --for 0                          # snapshot of what runs, waits and just finished
argus tail --for 5m --until-idle            # follow until nothing runs (gates do not hold it)
argus approve <instanceId> [--phase <id>]   # only when the person says so
argus revise <instanceId> --note "…" [--phase <id>]   # only when the person says so
```

Exit status: `0` ok, `1` refused, invalid or unreachable (stderr says why),
`2` bad arguments. The CLI talks to the running server using `ARGUS_PORT` and
`ARGUS_TOKEN`; `--url <base>` and `--token <t>` override them. Everything but
`list`, `show`, `runtimes` and `tail` needs an Argus account: `ARGUS_USER` and
`ARGUS_PASSWORD` in the environment, since a tool call cannot answer the
password prompt. If a call is unreachable or unauthorized, the variables may be
missing from this shell: pass `--url`/`--token`, or run it in an interactive
shell where the profile sets them. Never start a second Argus server.

## The workflow

1. **Clarify the job.** Before drafting, know:
   - the repository or directory each phase works in (it must exist on the
     machine Argus runs on);
   - what "done" means for each piece of work, in checkable terms (a command
     that exits 0, a file, a changed path);
   - where a person must look before the work continues;
   - how it starts: by hand, on a schedule, by webhook, after another
     pipeline, or as a spawned child;
   - whether it acts outside Argus (pushes, opens pull requests, comments,
     claims tickets, deploys) and what it may spend.

   Ask about what you cannot infer. Do not guess a schedule or an external
   action.

2. **Look at what exists.** Run `argus pipeline runtimes` (which runtimes are
   available, which models they offer) and `argus pipeline list`. If a
   pipeline already does most of the job, `show` it and change it rather than
   adding a near-copy. To repair one, start from `show` and the evidence of
   its last instance ([troubleshooting](reference/troubleshooting.md#reading-the-evidence)).

3. **Pick the shape** from [recipes](reference/recipes.md): one gated phase;
   plan, build, verify; fan-out and fan-in; routing on a result; a scheduled
   job that may find no work; a worktree with a pull request and a gate that
   opens on merge; a spawn parent with a task pipeline. Start with the smallest
   shape that does the job. Add candidates, memory, rubrics or knowledge
   phases only when the job needs them.

4. **Draft the JSON in a file** outside the repository the pipeline will edit.
   Write every prompt as a complete brief (see the rules below). Set
   `runtime` explicitly. Give every phase `timeoutSeconds` and `stallSeconds`.

5. **Validate until clean:** `argus pipeline validate draft.json`. Fix each
   `400` exactly as worded and validate again. Then compare the normalised
   definition it prints with your draft: unknown keys on the pipeline, a
   phase or a step are dropped without an error, so a missing field there is
   a typo. For a change to an existing pipeline, use `--as <id>`.

6. **Create it inert:** `"trigger": null` for a manual pipeline, or the real
   trigger with `"enabled": false`. Absent `enabled` means `true`, and an
   enabled schedule starts on its own. A spawn parent needs its child created
   first. Note the id `create` prints.

7. **First run, watched.** Starting runs agents and spends money: say so and
   get the person's go-ahead unless they already asked you to run it. Then
   `argus pipeline start <id>` and `argus tail --for 5m --until-idle` (stay
   under your tool timeout; run it again to keep following). At a gate, relay
   the ⏸ line and its review link. Approve or revise only on the person's word.

8. **Inspect the evidence**, not the agent's own summary: each phase's status
   and failure class, check results, the result value, the branch, the
   journal, the run logs. Did each phase do what was meant, not merely
   succeed? See [troubleshooting](reference/troubleshooting.md).

9. **Fix and re-run.** `show` the definition into a file, edit it, `validate
   --as <id>`, then `update <id> <file>`. A running instance keeps the
   definition it started with: an edit applies to the next start only, and
   while an instance is live an execution edit is refused with
   `409 instances-running` unless you pass `--force`. Repeat from step 7 until
   one run does what was meant.

10. **Only then switch it on.** Set the real trigger and `"enabled": true`
    (`update <id> <file> --patch` with just those keys). Ask the person first
    whenever the pipeline will spend money unattended or act outside Argus.
    Say what it will do, how often, and what one run cost.

11. **Report:** the pipeline id, what ran and with what result, the cost of
    the test run, what is enabled and when it fires next, and anything left
    for the person to decide.

## Rules that prevent most broken pipelines

**The outcome marker.** Argus itself tells every step to end its last message
with `ARGUS_OUTCOME: succeeded`, or `failed` / `blocked` with a reason. Do not
write that mechanic into prompts, do not quote the marker, and do not dictate a
reply format ("answer only with JSON") that leaves no room for it. Do state the
success criteria: the agent judges itself against them. A completion with no
marker, or with two different ones, fails as **`unverified`**: a protocol
failure, retried by default, not a verdict. Keep the default
`completion.marker: "required"`; `lenient` only hides that the agent never
said it finished. The marker is the agent's claim, never proof.

**Results go to `ARGUS_RESULT_FILE`, not prose.** Anything a later phase or a
route depends on is a `result` with a schema. Argus tells the agent where to
write it and validates it; a missing or invalid result fails the phase.
`ARGUS_OUTCOME` says whether the run worked; the result says what it decided.
An agent that decides "reject" has succeeded. Do not route on payload text.

**Prompts are self-contained.** Each step is a fresh process with no memory of
other steps, this conversation or earlier instances. Say what the repository
is, what to do, what not to touch, how to verify, and what success means. Pass
earlier work with `{{artifacts.<name>}}` (a `result` or `produces` value),
`{{trigger.payload}}` for a webhook body or a spawned task, and `{{memory}}`
only with `memory` enabled. Unknown placeholders become empty text.

**Steps in one phase run at the same time.** They are not a sequence. Ordered
work goes in separate phases; only independent work shares a phase.

**`cwd` must exist** on the Argus machine when you save, as an absolute path.
So must `additionalDirectories` and `claudeConfigDir`.

**Gate where a person must look:** before work that is expensive, hard to
undo, or acts outside Argus, and after a plan the rest depends on. A gate is
not verification of correctness; it is a decision point. Checks and the result
are evaluated before the gate opens, and a gated deciding phase takes its route
on approval.

**Checks are the real proof.** "The agent said the tests pass" is not "the
tests pass". Give every phase that changes something a `command` check (the
repository's own test or lint command), a `changed-files` check
(`requireChanges` when doing nothing is a failure), or an `artifact` check for
a required output file. Checks run in the phase's worktree under the phase's
environment policy. Put a check that reads the trigger payload before any check
that runs repository code.

**Retries.** `retry.retryOn` defaults to `["spawn", "exit-code",
"unverified"]`. `signal` is left out on purpose: the agent considered the work
and reported failure, so the same prompt mostly fails again at the same price.
An explicit `retryOn` replaces the default, so list `unverified` yourself. Add
`verification` to retry failed checks (the check output goes into the retry
prompt), `timeout` for timeouts and stalls, `signal` on a phase whose result a
spawn phase reads. `configuration` is never retried: fix the definition.

**Timeouts.** Without `timeoutSeconds` a step may run forever; without
`stallSeconds` (at least 30) a hung command is noticed only at the timeout.
Both fail under `timeout`.

**Worktrees** (`workspace`) give the work its own git branch. Only committed
work survives: the directory is removed when the instance ends, so tell the
agent to commit and check it (`git diff --quiet HEAD`), or set `keep: true`.
The tree is cut from `base` (default `HEAD` of `cwd`): uncommitted edits in
your checkout are not in it, and Argus never fetches. A phase with its own
`workspace` does not share the pipeline's tree; for phases that build on each
other, declare `"scope": "instance"` once on the pipeline. A worktree is not a
sandbox, and nothing merges the branch.

**`overlapPolicy: "skip"`** (the default) for anything that claims a resource,
edits a shared checkout, or polls a queue, so two instances never take the
same work. Use `"allow"` for a spawn target and for instances that share
nothing.

**Secrets never go in the definition.** `GET /api/pipelines` returns every
definition, `capabilities.env.set` values and webhook `hookToken`s included, to
any caller without an account. Keep credentials in the CLI's own login or the
server's environment and pass names with `env.allow`.

**Capability profiles** merge by top-level key across pipeline, phase and step:
a phase `env` replaces the pipeline's whole `env`. Under Claude Code
`read-only`, bare `Bash` is denied unless `tools.allow` names specific commands.
Codex `read-only` cannot write the result file or artifacts, so a strict launch
is refused; use `workspace-write`. OpenCode and Qwen enforce no profile key: a
profile there needs `"enforcement": "best-effort"`. Argus grants a profiled run
its own result, artifact and memory paths and lists them in the prompt; do not
add `Write` or `Bash(printenv:*)` for them.

**Mixed runtimes:** the pipeline `model` applies to every step whatever its
runtime. Set `model` per step when runtimes differ, using names
`argus pipeline runtimes` lists.

**There is no "no work" outcome** and no step-less phase. A job that may find
nothing to do decides it in a `result` (`{ "found": false }`) and routes the
work phase on it: the skipped branch lets the instance succeed. A precondition
that must hold belongs in a `command` check, not in an agent step whose only
job is to report it.

**Spawn phases:** create the child pipeline first, with `"trigger": null` (or a
webhook) and `"overlapPolicy": "allow"`. Children run one at a time
(`maxParallel` is capped at 1). Every task runs the child's agents, so spend
multiplies with the task count.

**Knowledge Ledger phases** (`discovery`, `ruleVerification`, `changeIntent`,
`implementation`, `acceptanceVerification`, `knowledgeContext`) have their own
protocols and caps. Follow
[the knowledge guide]({{argusRoot}}/docs/guides/knowledge.md#authoring-knowledge-workflows)
and read limits from the code: the agent contract does not yet state them
(for example, a KnowledgeDelta section holds at most 64 entries,
`DELTA_SECTION_MAX` in `{{argusRoot}}/server/src/knowledge/delta.ts`). Their
gates must be approved by a person.

**Decisions belong to people.** Never approve, revise or abort on your own
judgement, never create an Argus account, and never enable a trigger, a
webhook or an `after` chain without being asked.

## What spends money or acts outside Argus

`argus pipeline start`, enabling a trigger, a webhook or `after` chain that
fires, approving a gate (the next phases run), `candidates` (N runs per
attempt), retries (one run each), and spawn phases (a whole instance per
task). Prompts that push, open pull requests, comment or claim tickets act on
real systems from the first run. Say which of these a change does before you
do it.

## Deeper reading

- Pipelines, gates, routing, spawn: [guide]({{argusRoot}}/docs/guides/pipelines.md),
  [API § Weave]({{argusRoot}}/docs/API.md#phase-fields),
  [API § Pipelines]({{argusRoot}}/docs/API.md#pipelines-v03)
- Completion, checks, capabilities, worktrees, candidates, context:
  [HARNESS.md]({{argusRoot}}/docs/HARNESS.md) §2, §3, §4, §6, §7, §11, §12, §13;
  the [reference pipeline]({{argusRoot}}/docs/HARNESS.md#9-reference-pipeline)
- Triggers: [scheduling guide]({{argusRoot}}/docs/guides/scheduling.md),
  [webhook and after]({{argusRoot}}/docs/API.md#webhook-and-chained-triggers-v04)
- Runtimes and their limits: [runtimes]({{argusRoot}}/docs/reference/runtimes.md)
- The validator itself: `{{argusRoot}}/server/src/sources/pipelines.ts`
