# Recipes

Complete definitions for common shapes. Each one passes
`validatePipelineInput` as written once `/path/to/repo` names a real
directory on the Argus machine. Replace paths, commands and prompt details
with the user's; keep the structure. Every recipe is saved manual
(`"trigger": null`) or disabled (`"enabled": false`) so the first run is one
you start and watch.

Prompts are complete on purpose. Each step is a fresh headless run that sees
only its prompt, its working directory and what Argus adds. Argus appends the
`ARGUS_OUTCOME` rule, the result-file instruction and the artifact paths
itself; the prompts below only state the task and how to judge success.

## (a) One gated phase, manual

**When to use:** a single task whose output a person reviews before it counts,
such as a report, a review or a draft. The gate is the verification. The
`artifact` check makes Argus prove the file exists before the gate opens.
Read-only, so nothing in the repository changes.

```json
{
  "name": "Release notes draft",
  "trigger": null,
  "overlapPolicy": "skip",
  "runtime": "claude",
  "phases": [
    {
      "id": "draft",
      "name": "Draft release notes",
      "cwd": "/path/to/repo",
      "gated": true,
      "timeoutSeconds": 1800,
      "stallSeconds": 300,
      "capabilities": {
        "filesystem": "read-only",
        "tools": { "allow": ["Bash(git log:*)", "Bash(git describe:*)", "Bash(git show:*)"] }
      },
      "steps": [
        {
          "name": "draft",
          "prompt": "You are drafting release notes for the git repository in your working directory. Find the latest tag with `git describe --tags --abbrev=0` and list the commits since it with `git log <tag>..HEAD --oneline`. Group the user-visible changes under Added, Changed and Fixed, one line each, in plain English. Leave out refactors, tests and CI changes. Write the notes as Markdown to {{artifactDir}}/release-notes.md. Do not edit any file in the repository. Success means the file exists and every user-visible commit since the tag is covered."
        }
      ],
      "checks": [{ "kind": "artifact", "path": "release-notes.md", "minBytes": 200 }]
    }
  ]
}
```

## (b) Plan, build, verify

**When to use:** a change to one repository, planned by one run, made by
another and checked by Argus. The plan is a validated `result`, so `build`
reads a JSON value instead of prose. `build` proves its work with `command`
and `changed-files` checks and retries on a failed check with the check output
in its prompt. There is no worktree: `build` edits the checkout at `cwd`
directly, so run it on a clean branch. Use (f) to isolate the work.

```json
{
  "name": "Plan build verify",
  "trigger": null,
  "overlapPolicy": "skip",
  "runtime": "claude",
  "phases": [
    {
      "id": "plan",
      "name": "Plan",
      "cwd": "/path/to/repo",
      "gated": true,
      "timeoutSeconds": 1200,
      "stallSeconds": 300,
      "capabilities": { "filesystem": "read-only", "maxTurns": 40 },
      "steps": [
        {
          "name": "plan",
          "prompt": "You are planning a change to the repository in your working directory. The change: add a --json flag to the `report` command that prints the same data as JSON. Read the code that implements the command and its tests. Produce a plan: a one-paragraph summary, the files to change, and an ordered list of concrete steps, each small enough to verify. Do not edit any file. Success means the plan names real files and covers tests."
        }
      ],
      "result": {
        "artifact": "plan",
        "schema": {
          "type": "object",
          "required": ["summary", "files", "steps"],
          "properties": {
            "summary": { "type": "string" },
            "files": { "type": "array", "items": { "type": "string" } },
            "steps": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    },
    {
      "id": "build",
      "name": "Build",
      "cwd": "/path/to/repo",
      "gated": false,
      "timeoutSeconds": 3600,
      "stallSeconds": 600,
      "retry": {
        "attempts": 3,
        "backoffSeconds": 60,
        "retryOn": ["spawn", "exit-code", "unverified", "verification"]
      },
      "capabilities": { "filesystem": "workspace-write" },
      "steps": [
        {
          "name": "implement",
          "prompt": "You are implementing an approved plan in the repository in your working directory. The plan, as JSON: {{artifacts.plan}}. Make the changes it describes, including tests. Run `npm run typecheck` and `npm test` yourself and fix what fails. Do not change files the plan does not need. Success means the plan is implemented and both commands pass."
        }
      ],
      "checks": [
        { "kind": "command", "run": "npm run typecheck", "label": "typecheck", "timeoutSeconds": 600 },
        { "kind": "command", "run": "npm test", "label": "tests", "timeoutSeconds": 1200 },
        {
          "kind": "changed-files",
          "allow": ["src/**", "test/**"],
          "deny": ["package-lock.json"],
          "requireChanges": true
        }
      ]
    },
    {
      "id": "verify",
      "name": "Review",
      "cwd": "/path/to/repo",
      "gated": true,
      "timeoutSeconds": 1200,
      "stallSeconds": 300,
      "capabilities": {
        "filesystem": "read-only",
        "tools": { "allow": ["Bash(git diff:*)", "Bash(git status:*)"] }
      },
      "steps": [
        {
          "name": "review",
          "prompt": "You are reviewing an uncommitted change in the repository in your working directory against its plan. The plan, as JSON: {{artifacts.plan}}. Read `git status` and `git diff`. List each place where the change does not match the plan, is untested, or is likely wrong, with file and line. Write the review as Markdown to {{artifactDir}}/review.md. Do not edit any file. Success means every changed file was read and the review says plainly whether the change is ready."
        }
      ],
      "checks": [{ "kind": "artifact", "path": "review.md", "minBytes": 100 }]
    }
  ]
}
```

## (c) Fan-out and fan-in with named artifacts

**When to use:** independent looks at the same input that can run at once,
joined by one phase that needs all of them. Each branch publishes a validated
`result` under its own name, and the join reads them by name, because a phase
with several dependencies has no single `{{previous.payload}}`. All branches
are read-only, so they cannot overwrite each other. Branches that write need a
worktree each and a plan for merging them. Runs past `ARGUS_MAX_CONCURRENT_RUNS`
(default 4) queue.

```json
{
  "name": "Branch review",
  "trigger": null,
  "overlapPolicy": "skip",
  "runtime": "claude",
  "capabilities": {
    "filesystem": "read-only",
    "tools": { "allow": ["Bash(git diff:*)", "Bash(git log:*)", "Bash(git merge-base:*)"] }
  },
  "phases": [
    {
      "id": "collect",
      "name": "Collect the change",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": [],
      "timeoutSeconds": 900,
      "steps": [
        {
          "name": "collect",
          "prompt": "You are summarising the change on the current branch of the git repository in your working directory, compared with origin/main. Run `git merge-base HEAD origin/main` and `git diff --stat <base>...HEAD`. Report the base commit, every changed file, and a three-sentence summary of what the change does. Do not edit any file."
        }
      ],
      "result": {
        "artifact": "change",
        "schema": {
          "type": "object",
          "required": ["base", "files", "summary"],
          "properties": {
            "base": { "type": "string" },
            "files": { "type": "array", "items": { "type": "string" } },
            "summary": { "type": "string" }
          }
        }
      }
    },
    {
      "id": "security",
      "name": "Security review",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": ["collect"],
      "timeoutSeconds": 1800,
      "steps": [
        {
          "name": "review",
          "prompt": "You are reviewing a change for security problems only. The change, as JSON: {{artifacts.change}}. Read `git diff <base>...HEAD` for the files listed. Report each problem as one line with file, line and why it matters: injection, missing authorisation, secrets, unsafe file paths. Report an empty list if you find none. Do not edit any file."
        }
      ],
      "result": {
        "artifact": "security",
        "schema": {
          "type": "object",
          "required": ["findings"],
          "properties": { "findings": { "type": "array", "items": { "type": "string" } } }
        }
      }
    },
    {
      "id": "tests",
      "name": "Test review",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": ["collect"],
      "timeoutSeconds": 1800,
      "steps": [
        {
          "name": "review",
          "prompt": "You are reviewing whether a change is tested. The change, as JSON: {{artifacts.change}}. Read `git diff <base>...HEAD`. For each changed behaviour, say whether a test covers it, naming the test file. Report each gap as one line with the behaviour and the file that should test it. Report an empty list if there are none. Do not edit any file."
        }
      ],
      "result": {
        "artifact": "tests",
        "schema": {
          "type": "object",
          "required": ["findings"],
          "properties": { "findings": { "type": "array", "items": { "type": "string" } } }
        }
      }
    },
    {
      "id": "synthesize",
      "name": "Synthesis",
      "cwd": "/path/to/repo",
      "gated": true,
      "needs": ["security", "tests"],
      "timeoutSeconds": 900,
      "steps": [
        {
          "name": "synthesize",
          "prompt": "You are writing one review from two independent reviews of the same change. The change: {{artifacts.change}}. Security findings: {{artifacts.security}}. Test findings: {{artifacts.tests}}. Remove duplicates, order by severity, and say in the first line whether the change can merge as it is. Write the review as Markdown to {{artifactDir}}/review.md. Do not edit any file in the repository."
        }
      ],
      "checks": [{ "kind": "artifact", "path": "review.md", "minBytes": 100 }]
    }
  ]
}
```

## (d) Routing on a structured result

**When to use:** the work itself decides what happens next. `evaluate` writes
`{ "accepted": true|false, ... }` to its result file; `publish` runs only when
it is `true`, `repair` only when it is `false`, and the one not chosen is
**skipped**, not failed. The group makes it one decision: exactly one branch
must match. `report` needs both with `allowSkipped`, so it runs after whichever
branch ran. An instance with skipped phases still succeeds. A failed branch is
not a skip: the instance fails and `report` never runs.

```json
{
  "name": "Changelog check",
  "trigger": null,
  "overlapPolicy": "skip",
  "runtime": "claude",
  "phases": [
    {
      "id": "evaluate",
      "name": "Evaluate",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": [],
      "timeoutSeconds": 900,
      "capabilities": { "filesystem": "read-only" },
      "steps": [
        {
          "name": "evaluate",
          "prompt": "You are checking the `## [Unreleased]` section of CHANGELOG.md in your working directory. Accept it only if every entry describes a user-visible change in one sentence and names the command, setting or screen it affects. List every entry that fails, with the reason. Do not edit any file. Deciding not to accept is a successful evaluation."
        }
      ],
      "result": {
        "artifact": "evaluation",
        "schema": {
          "type": "object",
          "required": ["accepted", "problems"],
          "properties": {
            "accepted": { "type": "boolean" },
            "problems": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    },
    {
      "id": "publish",
      "name": "Publish summary",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": [
        {
          "phase": "evaluate",
          "when": {
            "group": "verdict",
            "exclusive": true,
            "required": true,
            "predicate": { "path": ["accepted"], "operator": "equals", "value": true }
          }
        }
      ],
      "timeoutSeconds": 600,
      "capabilities": { "filesystem": "read-only" },
      "steps": [
        {
          "name": "summary",
          "prompt": "You are writing a one-paragraph release summary from the `## [Unreleased]` section of CHANGELOG.md in your working directory, for people who use the product. Write it to {{artifactDir}}/summary.md. Do not edit any file in the repository."
        }
      ],
      "checks": [{ "kind": "artifact", "path": "summary.md", "minBytes": 100 }]
    },
    {
      "id": "repair",
      "name": "Repair changelog",
      "cwd": "/path/to/repo",
      "gated": true,
      "needs": [
        {
          "phase": "evaluate",
          "when": {
            "group": "verdict",
            "exclusive": true,
            "required": true,
            "predicate": { "path": ["accepted"], "operator": "equals", "value": false }
          }
        }
      ],
      "timeoutSeconds": 1200,
      "capabilities": { "filesystem": "workspace-write" },
      "steps": [
        {
          "name": "repair",
          "prompt": "You are fixing the `## [Unreleased]` section of CHANGELOG.md in your working directory. An evaluation found these problems: {{artifacts.evaluation}}. Rewrite only the entries listed so each describes a user-visible change in one sentence and names what it affects. Change no other file and no other section. Do not commit."
        }
      ],
      "checks": [{ "kind": "changed-files", "allow": ["CHANGELOG.md"], "requireChanges": true }]
    },
    {
      "id": "report",
      "name": "Report",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": [
        { "phase": "publish", "allowSkipped": true },
        { "phase": "repair", "allowSkipped": true }
      ],
      "timeoutSeconds": 600,
      "capabilities": { "filesystem": "read-only" },
      "steps": [
        {
          "name": "report",
          "prompt": "You are reporting the outcome of a changelog check in three sentences. The evaluation was: {{artifacts.evaluation}}. If it was accepted, say a summary was written. If not, say the listed entries were rewritten and are waiting in the working tree, uncommitted, for a person to commit. Do not edit any file."
        }
      ]
    }
  ]
}
```

## (e) A windowed job that may find no work

**When to use:** a job that polls for work on a timetable, such as triaging new
issues during working hours. `overlapPolicy: "skip"` keeps it to one instance
at a time. Argus has no "no work" outcome (`ARGUS_OUTCOME` accepts only
`succeeded`, `failed` and `blocked`), so the empty case is a route: `pick`
reports `found: false`, `triage` is skipped and the instance succeeds. It is
saved disabled; start it by hand, then enable it. The triage step labels and
comments on a real issue: ask the person before enabling it.

```json
{
  "name": "Issue triage",
  "trigger": {
    "kind": "windowed",
    "startTime": "08:00",
    "endTime": "17:00",
    "everyMinutes": 60,
    "weekdays": [1, 2, 3, 4, 5]
  },
  "enabled": false,
  "overlapPolicy": "skip",
  "runtime": "claude",
  "phases": [
    {
      "id": "pick",
      "name": "Pick an issue",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": [],
      "timeoutSeconds": 300,
      "stallSeconds": 120,
      "retry": { "attempts": 2, "backoffSeconds": 60 },
      "capabilities": {
        "filesystem": "read-only",
        "tools": { "allow": ["Bash(gh issue list:*)"] }
      },
      "steps": [
        {
          "name": "pick",
          "prompt": "You are choosing one GitHub issue to triage for the repository in your working directory. Run `gh issue list --state open --label needs-triage --json number,title,createdAt --limit 50`. Choose the oldest one. If the list is empty, report found as false and nothing else. Do not edit any file and do not change any issue. Finding no issue is a successful run."
        }
      ],
      "result": {
        "artifact": "pick",
        "schema": {
          "type": "object",
          "required": ["found"],
          "properties": {
            "found": { "type": "boolean" },
            "number": { "type": "number" },
            "title": { "type": "string" }
          }
        }
      }
    },
    {
      "id": "triage",
      "name": "Triage",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": [
        {
          "phase": "pick",
          "when": { "predicate": { "path": ["found"], "operator": "equals", "value": true } }
        }
      ],
      "timeoutSeconds": 1800,
      "stallSeconds": 300,
      "capabilities": {
        "filesystem": "read-only",
        "tools": {
          "allow": ["Bash(gh issue view:*)", "Bash(gh issue edit:*)", "Bash(gh issue comment:*)", "Bash(git log:*)"]
        }
      },
      "steps": [
        {
          "name": "triage",
          "prompt": "You are triaging one GitHub issue of the repository in your working directory. The issue, as JSON: {{artifacts.pick}}. Read it with `gh issue view <number> --comments`. Find the code it concerns. Post one comment with `gh issue comment` that states the likely cause, the files involved and a suggested size (small, medium, large). Then run `gh issue edit <number> --remove-label needs-triage --add-label triaged`. Do not edit any file. Success means the comment is posted and the labels are changed."
        }
      ]
    }
  ]
}
```

## (f) Worktree, pull request and a gate that opens on merge

**When to use:** an agent makes a change on its own branch, pushes it and opens
a pull request, and the pipeline continues when that pull request merges. The
pipeline-wide `instance` worktree keeps the work off the authored checkout and
lets later phases see it. Only committed work survives: the directory is
removed when the instance ends. `approveWhen` polls a script you keep outside
the repository; the guide's
[`pr-merged.mjs`]({{argusRoot}}/docs/guides/pipelines.md#open-a-gate-when-its-pull-request-merges)
is the model, with a `gh pr list` variant there. A person can still approve,
revise or abort first. Opening a pull request acts outside Argus: ask before
running it.

```json
{
  "name": "Fix and open PR",
  "trigger": null,
  "overlapPolicy": "skip",
  "runtime": "claude",
  "workspace": { "scope": "instance", "base": "origin/main" },
  "capabilities": { "filesystem": "workspace-write" },
  "phases": [
    {
      "id": "implement",
      "name": "Implement and open PR",
      "cwd": "/path/to/repo",
      "gated": true,
      "timeoutSeconds": 3600,
      "stallSeconds": 600,
      "retry": {
        "attempts": 2,
        "backoffSeconds": 60,
        "retryOn": ["spawn", "exit-code", "unverified", "verification"]
      },
      "steps": [
        {
          "name": "implement",
          "prompt": "You are working in a fresh git worktree of the repository, on its own branch, cut from origin/main. The task: make `npm run lint` pass with no warnings, without disabling any rule. Fix the code, run `npm run lint` and `npm test` until both pass, then commit with a message that says what you fixed. Push the branch with `git push -u origin HEAD` and open a pull request into main with `gh pr create --fill --base main`. Success means the commit is pushed and the pull request exists. Report the pull request URL in your last message."
        }
      ],
      "checks": [
        { "kind": "command", "run": "npm run lint", "label": "lint", "timeoutSeconds": 600 },
        { "kind": "command", "run": "npm test", "label": "tests", "timeoutSeconds": 1200 },
        { "kind": "command", "run": "git diff --quiet HEAD", "label": "no uncommitted tracked changes" },
        { "kind": "changed-files", "requireChanges": true }
      ],
      "approveWhen": {
        "kind": "command",
        "run": "node /home/you/argus-checks/pr-merged.mjs",
        "label": "pull request merged",
        "everySeconds": 300,
        "timeoutSeconds": 60,
        "failOnExit": 3
      }
    },
    {
      "id": "wrap-up",
      "name": "Wrap up",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": ["implement"],
      "timeoutSeconds": 600,
      "capabilities": { "filesystem": "read-only", "tools": { "allow": ["Bash(git log:*)"] } },
      "steps": [
        {
          "name": "summary",
          "prompt": "You are summarising work that has just merged. Read `git log origin/main..HEAD` in your working directory, or the last commit if that is empty. Write three sentences for a changelog to {{artifactDir}}/summary.md. Do not edit any file in the repository."
        }
      ],
      "checks": [{ "kind": "artifact", "path": "summary.md", "minBytes": 50 }]
    }
  ]
}
```

Before the first start: `git fetch origin` in `/path/to/repo` (Argus never
fetches the `base`), and sign `gh` in as the user Argus runs as.

## (g) A spawn parent and its task pipeline

**When to use:** a plan splits work into tasks, and each task should run as its
own instance of another pipeline, in dependency order, one at a time. Two
creates, **child first**: the parent's `spawn.pipelineId` must name a pipeline
that exists (the server checks it on create, update and `validate`). The child
has no trigger and `overlapPolicy: "allow"`. The parent's plan lists `signal`
in `retryOn`, because a task list Argus cannot run fails it under `signal`.

Child (create it, note the id it prints):

```json
{
  "name": "Task loop",
  "trigger": null,
  "overlapPolicy": "allow",
  "runtime": "claude",
  "workspace": { "scope": "instance" },
  "capabilities": { "filesystem": "workspace-write" },
  "phases": [
    {
      "id": "implement",
      "name": "Implement",
      "cwd": "/path/to/repo",
      "gated": true,
      "timeoutSeconds": 3600,
      "stallSeconds": 600,
      "retry": {
        "attempts": 2,
        "backoffSeconds": 60,
        "retryOn": ["spawn", "exit-code", "unverified", "verification"]
      },
      "steps": [
        {
          "name": "implement",
          "prompt": "You are doing one task of a larger plan, in a fresh git worktree of the repository on its own branch. The task, with its key and the parent's context, as JSON: {{trigger.payload}}. Do only what the task describes, add or update tests, run `npm test` until it passes, and commit with a message that starts with the task key. Success means the task is done, tested and committed."
        }
      ],
      "checks": [
        { "kind": "command", "run": "npm test", "label": "tests", "timeoutSeconds": 1200 },
        { "kind": "command", "run": "git diff --quiet HEAD", "label": "no uncommitted tracked changes" },
        { "kind": "changed-files", "requireChanges": true }
      ]
    }
  ]
}
```

Parent (replace `<child pipeline id>`, then create it):

```json
{
  "name": "Delivery",
  "trigger": null,
  "overlapPolicy": "skip",
  "runtime": "claude",
  "phases": [
    {
      "id": "plan",
      "name": "Plan",
      "cwd": "/path/to/repo",
      "gated": true,
      "timeoutSeconds": 1800,
      "stallSeconds": 300,
      "retry": {
        "attempts": 2,
        "backoffSeconds": 30,
        "retryOn": ["spawn", "exit-code", "unverified", "signal"]
      },
      "capabilities": { "filesystem": "read-only" },
      "steps": [
        {
          "name": "plan",
          "prompt": "You are splitting the specification in docs/spec.md of the repository in your working directory into small tasks. Each task gets a short id (letters, digits, '-' only, unique), a title, a description precise enough for someone who has not read the spec, and the ids of the tasks it needs first (after). Order does not matter; dependencies do. At most 20 tasks. Do not edit any file."
        }
      ],
      "result": {
        "artifact": "plan",
        "schema": {
          "type": "object",
          "required": ["tasks"],
          "properties": {
            "tasks": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["id", "title", "description"],
                "properties": {
                  "id": { "type": "string" },
                  "title": { "type": "string" },
                  "description": { "type": "string" },
                  "after": { "type": "array", "items": { "type": "string" } }
                }
              }
            }
          }
        }
      }
    },
    {
      "id": "tasks",
      "name": "Tasks",
      "cwd": "/path/to/repo",
      "needs": ["plan"],
      "produces": "tasks-summary",
      "spawn": {
        "pipelineId": "<child pipeline id>",
        "items": { "phase": "plan", "path": ["tasks"] },
        "key": "id",
        "dependsOn": "after",
        "title": "title",
        "base": "origin/main"
      }
    },
    {
      "id": "retro",
      "name": "Retrospective",
      "cwd": "/path/to/repo",
      "gated": false,
      "needs": ["tasks"],
      "childrenContext": { "fromPhase": "tasks" },
      "timeoutSeconds": 900,
      "capabilities": { "filesystem": "read-only" },
      "steps": [
        {
          "name": "retro",
          "prompt": "You are reviewing how a set of tasks went. Read the children manifest Argus names below. For each task, say whether it succeeded on the first attempt, what a person asked to change and why, and what it cost. Then propose one change to the task pipeline's prompt that would have avoided the most common problem. Write it as Markdown to {{artifactDir}}/retro.md. Do not edit any file in the repository."
        }
      ],
      "checks": [{ "kind": "artifact", "path": "retro.md", "minBytes": 200 }]
    }
  ]
}
```

At run time: approve `plan` at its gate, then approve each child's
`implement` gate (`argus tail` names a child `Task loop [<key>]`). A failed
child pauses `tasks` at `children`: revise the child, revise `tasks` to re-run
every unfinished task, or approve `tasks` to accept the rest.
[HARNESS §20]({{argusRoot}}/docs/HARNESS.md#20-spawn-phases)
