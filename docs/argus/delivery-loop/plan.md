# Plan: Delivery loop with per-task autonomy

**Written:** 2026-10-21, against `main` = `15a6fd5` (build `1.0.0-15a6fd5`). **Handoff:** [`handoff.md`](handoff.md) (same folder).

This plan closes every gap between the delivery-loop pipeline and the pod working model it implements ("AI-Augmented Product Pods", v1.0). It has three tracks: Argus features first (**DL-A**), then the pipeline (**DL-P**), and the working model itself (**DL-M**). Pilot-specific details (repository, instance, names) are kept out of this repository, in the pipeline's own notes.

## Context

### The working model

A seven-step loop: Discover, Define, Plan, Build, Verify, Ship, Learn. Four human gates: G1 Spec Approval, G2 Plan Approval, G3 Code Review, G4 Rollout Decision. Plan breaks the spec into agent-sized tasks and sets a risk class and an autonomy level **per task**. Build runs one coding agent per task, each in an isolated branch, each opening a PR small enough to review in half an hour. Learn turns lessons into context files, skills and evals for the next round.

### The pipeline today (13 phases)

`discover → define [G1] → plan [G2] → one lane (assist [gate] | pair [gate] | build) → review [gate] | verify → pr [G3] | pr-auto → ship [G4] → learn [gate] → apply-learnings`

- **One lane per instance.** Plan sets a level per task, then the instance runs every task at the lowest one (Plan prompt, step 2). The lane routes read one top-level `autonomyLevel`.
- **A spec-wide clamp.** Define derives one `autonomyCeiling` for the whole spec, and Plan caps every task at it.
- **L1 and L2 run no agent.** Both lanes write a brief and wait for a person to write the code outside Argus.
- **One branch, one PR, one G3 per spec.** Build works every task in sequence in one session (90-minute timeout), and Verify reviews the whole diff.
- **Nothing stops an empty delivery on the L1/L2 path.** `verify` requires `openBlocking: 0`; `review` does not, and `pr` needs `review` only with `allowSkipped`.

### The pilot run (2026-10-21)

- The spec was critical (ceiling L2). Plan produced 16 tasks: 10 sensitive-area, 3 structural-change, 2 new-functionality, 1 docs. All 16 became L2: 13 by policy, 3 by the clamp. Plan recommended splitting into 7 slices; nothing acts on that.
- The Pair lane wrote a handoff. Its gate was approved before any code existed. Review found 3 blocking findings (no acceptance criterion implemented, tests red) and was approved. The PR contains only the spec.
- At G2, a second one-line revise started a fresh attempt that received only its own note. The first revise (seven points) vanished from the approved plan: `server/src/engine/gates.ts:207` appends only the current note, and every attempt starts with an empty artifact folder (`server/src/engine/launch.ts:760-764`).

### The gaps

| #   | Gap                                                                       | Cause                                                                                                                                                                       | Closed by           |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1   | No lane per task                                                          | Argus: phases are fixed at save time; route predicates refuse arrays (`server/src/sources/routing.ts:98-112`); `candidates` is N copies of one step; `after` chains are 1:1 | DL-A2, DL-P3, DL-P4 |
| 2   | No agent, branch and PR per task                                          | Argus: no child instances, no per-task worktree or base                                                                                                                     | DL-A2, DL-P3        |
| 3   | L1 and L2 produce no code                                                 | Pipeline design                                                                                                                                                             | DL-P2, DL-P3        |
| 4   | The spec-wide clamp                                                       | Pipeline (Define and Plan prompts)                                                                                                                                          | DL-P2, DL-P4        |
| 5   | An empty delivery reaches a PR                                            | Pipeline (no guard on the L1/L2 path)                                                                                                                                       | DL-P3               |
| 6   | Revise notes are lost                                                     | Argus (only the current note; artifact folder emptied per attempt)                                                                                                          | DL-A1               |
| 7   | G3 (and G1) need a manual click after a merge in Azure DevOps             | Argus: a gate can only be opened by a person or a rubric verdict                                                                                                            | DL-A3               |
| 8   | Checks cannot see which task an instance works on                         | Argus: a command check gets no instance identity or trigger payload, and its fields are not interpolated                                                                    | DL-A4               |
| 9   | G4 has no flag or monitoring evidence ("not monitored")                   | Pilot repo and pipeline                                                                                                                                                     | DL-P6               |
| 10  | No metrics for the Agent Ops Review                                       | Nothing computes them                                                                                                                                                       | DL-P7               |
| 11  | The pipeline has no versioned home, so Learn cannot propose changes to it | Pipeline (definition in Argus state; pack and setup folder outside git)                                                                                                     | DL-P1, DL-P5        |
| 12  | Session transcripts are invisible to Argus                                | Pipeline sets `env.set.CLAUDE_CONFIG_DIR` instead of the pipeline-level `claudeConfigDir` (#94)                                                                             | DL-P0 / DL-P1       |
| 13  | 12 of 13 phases still name the old sandbox as `cwd`                       | Pipeline (works only because Discover creates the shared worktree and each phase still runs `git` in its own `cwd` first, `server/src/engine/launch.ts:187-194`)            | DL-P0 / DL-P1       |
| 14  | The working model contradicts the decided model                           | Working model v1.0: L1/L2 keep a human author; Discover, Define and Learn are human-led                                                                                     | DL-M1               |

## Decisions already made

| Date       | Decision                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-19 | Learnings reach the target repository's context (root CLAUDE.md, AGENTS.md, `.claude/skills/`) only through a reviewed PR. L4 finishes as a PR with auto-complete. The PR body follows the working model (spec link, session link, level, verification).    |
| 2026-10-20 | Each pipeline runs on its own Claude setup folder (`claudeConfigDir`, HARNESS.md §3b).                                                                                                                                                                      |
| 2026-10-21 | Work enters through the pipeline's webhook (the intake skill).                                                                                                                                                                                              |
| 2026-10-21 | One person holds every pod role. One approval covers every role a gate names.                                                                                                                                                                               |
| 2026-10-21 | **Autonomy levels contain no human authoring or pairing.** Levels differ in tooling and permission settings. People act at the gates.                                                                                                                       |
| 2026-10-21 | **The flow:** the person starts the loop; the pipeline specifies, plans, fans the work out, opens PRs from the fanned-out work, ships after all PRs are approved, then runs Learn over the whole instance and improves the pipeline for the next iteration. |
| 2026-10-21 | **Argus first, then the pipeline.** Close every gap in this plan.                                                                                                                                                                                           |

Everything else in this plan is a proposed default, listed under [Open decisions](#open-decisions-defaults-proposed-the-user-confirms).

## Target design

### The loop

```
Parent: "Delivery loop" (one instance per work item)

  discover → define [G1] → plan [G2] → tasks ──► one child per task, in dependency order
                                          ◄── join: every child settled
           → ship [G4] → learn [Context Retro] → apply-learnings (repo-context PR, pipeline PR)

Child: "Task loop" (one instance per task)

  prepare → lane by the task's level ─┬─ L1 decide [Decide gate] ─────────────────────┐
                                      ├─ L2 build-guarded → verify (+ security round) ┤
                                      └─ L3/L4 build → verify ────────────────────────┴→ pr [G3, advances on merge]
                                                                                           (L4: auto-complete)
```

### Levels are profiles, not people (decided; details proposed in D6 and D7)

| Level         | Task types (policy)                                                                                                        | The agent may                                                            | Extra verification                                                                                                  | Human control                                                | Merge                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| L1 Decide     | Architecture: new services, technical choices, ADRs                                                                        | read the repository; write only `docs/adr/`                              | ADR completeness (options, decision, consequences)                                                                  | decides at the Decide gate, then reviews the ADR PR at G3    | a person                                |
| L2 Guarded    | Sensitive areas (auth, payments, personal data, security); structural changes (migrations, public APIs, shared components) | write only the task's planned files and their tests; no new dependencies | an independent security-review round that must find nothing; migration checks where relevant; a smaller size budget | G3 with a stricter checklist (security report, criteria map) | a person                                |
| L3 Delegate   | New functionality, bug fixes                                                                                               | write anywhere except protected paths                                    | the standard set: verification commands, test guard, criteria map, fresh review rounds                              | G3                                                           | a person                                |
| L4 Autonomous | Task types the person approved (`approvedL4TaskTypes`)                                                                     | as L3                                                                    | as L3                                                                                                               | spot checks afterwards, in the Agent Ops Review              | auto-complete when branch policies pass |

Claude Code permission rules are not a sandbox (HARNESS.md §10). What holds a task to its scope is the checks that run after the agent and fail the phase: `changed-files`, the test guard, the verification commands and the task-scope script.

**Level selection.** Per task, from the policy only: the task type gives `maxAutonomy`; L4 only for approved task types. No spec-wide clamp: the spec's risk class is information for G1. A person can lower a task's level at G2 (in a revise note), never raise it.

### Data between parent and child

- **Parent → child (spawn payload):** the task (`id`, `title`, `taskType`, `riskClass`, `autonomyLevel`, `files`, `dependsOn`, `tests`), the spec (path and the commit it was approved at), the base ref to branch from, and the parent's instance id.
- **Child → parent:** the child's result (`prId`, `url`, merge commit, verification summary) and its artifact folders, collected in a children manifest the parent's later phases read (DL-A2).

### The learning loop

- Learn reads the whole instance: the parent's artifacts and every child's (review rounds, findings by kind, retries, revise notes, wait times, cost).
- It proposes two sets of changes, each as a PR the person merges:
  - **the target repository's context** (CLAUDE.md, AGENTS.md, `.claude/skills/`): the existing context PR;
  - **the pipeline** (prompts, templates, checks, task-sizing guidance): a PR in the pipeline's versioned home (DL-P1).
- **Never in Learn's output:** wider permissions, a higher level, a new L4 task type, a removed or weakened check. Those belong to the Agent Ops Review, decided by a person on trends across several runs (DL-P7).
- Applying a merged pipeline PR to Argus is a person's step (the sync script). Agents never edit a pipeline through the API.

## Ground rules

- **Argus workstreams (DL-A)** follow the reliability plan's ground rules unchanged ([`../reliability/plan.md`](../reliability/plan.md), "Ground rules for every workstream"): one branch per workstream from `main`; stage, never commit; the full done gate; docs and a CHANGELOG `[Unreleased]` entry; the architecture rules (`core.fns` boundaries, pure transitions, additive types-only contracts, `app.ts` never imports `engine/*`); Windows-portable tests; a release after each merged workstream.
- **The soak rule (reliability WS12) still applies:** no new top-level `server/src/` directory and no new `/api/` route family. Every DL-A workstream is designed inside existing subsystems and route families, and states so. The pilot re-run counts towards the soak: it is the implement→PR pipeline.
- **"Argus first" means released.** A DL-P workstream that needs a DL-A feature starts only when that feature is merged, released (`argus release`) and the server runs from the pinned release (WS3).
- **Pipeline workstreams (DL-P)** land in the pipeline's versioned home as PRs. A person applies them with the sync script. Argus refuses definition edits while an instance runs or awaits approval (`docs/API.md:2973`, `409 instances-running`), so finish or abort instances first.
- **Never versioned, synced or printed:** the setup folder's `settings.json`, `.credentials.json` and `.claude.json`, and a pipeline's `hookToken`.
- **No employer, product or personal names in this repository.** Pilot details live in the pipeline's own notes.

## Order

Status legend: ⬜ not started · 🟡 in progress · 🔵 staged for review · ✅ merged · ⏸ blocked

| Status | #             | Workstream                                                                   | Branch / home                                 | Why here                                                                  | Depends on                                              |
| ------ | ------------- | ---------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| 🟡     | DL-A0         | Close out the setup-folder feature (#94): Windows done gate, probes, release | – (probes on this machine; `argus release`)   | Merged but not verified on Windows; the pipeline moves onto it            | – (can run alongside)                                   |
| ✅     | DL-A1         | Revise notes accumulate                                                      | `fix/revise-notes-accumulate`                 | Gates are the human control in this model; a lost note is a lost decision | –                                                       |
| ⬜     | DL-A2a        | Spawn phases                                                                 | `feat/spawn-phases`                           | The core gap: one lane, branch and PR per task                            | –                                                       |
| ⬜     | DL-A2b        | The parent's view of its children                                            | `feat/spawn-children-context`                 | Learn over the whole instance                                             | DL-A2a                                                  |
| ⬜     | DL-A2c        | Spawn phases on the board                                                    | `feat/spawn-board`                            | Seeing children, deciding at the `children` pause                         | DL-A2a (contracts)                                      |
| ⬜     | DL-A4 + DL-A3 | Task inputs for checks, then gates a polled command approves                 | `feat/approval-conditions`                    | G1 and G3 advance on a merge; task-scope checks                           | –                                                       |
| ⬜     | WS13          | (reliability) the `.claude.json` race                                        | `fix/claude-config-race`                      | Before any `maxParallel` above 1                                          | DL-A0 (where `.claude.json` lives under a setup folder) |
| ⬜     | DL-P0         | Hygiene on the current pipeline                                              | API (admin session)                           | Only if the current pipeline runs before DL-P4                            | –                                                       |
| ⬜     | DL-P1         | A versioned home for the pipeline                                            | a new private repository                      | Learn needs somewhere to propose pipeline changes                         | D9                                                      |
| ⬜     | DL-P2         | Autonomy policy v2 and lane profiles                                         | pipeline home                                 | Levels as profiles; no clamp                                              | DL-P1; D6, D7                                           |
| ⬜     | DL-P3         | The task-loop pipeline (child)                                               | pipeline home                                 | One task, agent, branch and PR                                            | DL-A2a, DL-A3, DL-A4 released; DL-P1, DL-P2             |
| ⬜     | DL-P4         | Rework the delivery-loop pipeline (parent)                                   | pipeline home                                 | Spec PR, Plan per task, the `tasks` spawn phase, Ship after the join      | DL-A2a, DL-A3 released; DL-P3                           |
| ⬜     | DL-P5         | Learn over the whole instance                                                | pipeline home                                 | Two proposal PRs                                                          | DL-A2b released; DL-P4                                  |
| ⬜     | DL-P6         | G4 evidence: feature flag and monitoring                                     | pilot repository and pipeline home            | G4 decided on data                                                        | D11                                                     |
| ⬜     | DL-P7         | The Agent Ops Review report                                                  | pipeline home and an Argus schedule           | Metrics for promotions and demotions                                      | DL-P1                                                   |
| ⬜     | DL-M1         | Working model v1.1                                                           | the published working model; the setup folder | The document and the agents must say the same                             | your go                                                 |
| ⬜     | DL-V          | The pilot re-run                                                             | –                                             | End-to-end verification; counts towards the soak                          | everything above                                        |

Release after each merged DL-A workstream, as the reliability plan does. DL-A1, DL-A2a and DL-A4 + DL-A3 are independent and can be built in any order; this table's order is the proposed one (D13).

## Argus workstreams

### DL-A0 — Close out the setup-folder feature (#94)

**Status:** 🟡 Merged as `6e26d87` and running in the pinned build `1.0.0-15a6fd5`; still under `[Unreleased]`. Carried over on 2026-10-21 from the retired headless-isolation handoff (deleted; it stays in git history).

- **The Windows done gate.** CI's `windows` job ran only the server suite on the PR's first push; the web tests and the checks after them did not run. Run the full done gate on Windows against the reliability baseline.
- **Probes, one at a time** (real-CLI probes race on `.claude.json`). Use a scratch setup folder signed in with the existing token, and a scratch repository with marker files, `.claude/agents`, `.claude/commands` and a `.mcp.json`:
  - the repository's `.mcp.json` loading headless, given project-server approval;
  - claude.ai connectors under a token sign-in, which has no account details;
  - the repository's `.claude/agents` and `.claude/commands`;
  - a nested `sub/CLAUDE.md` loading on demand;
  - the PR attribution setting (`attribution.pr: ""`);
  - `claudeMdExcludes` arriving through the per-run `--settings` file rather than the folder's own `settings.json`;
  - the three deny rules together in one flag, and the `.credentials.json` rule (only the `settings.json` form was probed);
  - a step **without** a capability profile on a folder: Argus's hooks through `--settings` under `CLAUDE_CONFIG_DIR`;
  - the session watcher picking up a new folder (there is no automated test for `watch.ts`).
- **For WS13:** where `.claude.json` lives under `CLAUDE_CONFIG_DIR`. If it moves into the folder, a pipeline's steps race only among themselves, not with the operator's sessions. That shapes how WS13 is fixed before parallel children (D1).
- **Release:** cutting a version with this entry is your call.
- Moving the pilot pipeline onto the field is in DL-P0 (or DL-P1's templates); the live acceptance checks are in [End-to-end verification](#end-to-end-verification).

### DL-A1 — Revise notes accumulate

**Status:** ✅ Merged to `main` on 2026-10-21; not released yet, so the pinned server still runs without it · **Branch:** `fix/revise-notes-accumulate` · **Size:** S–M (about a day) · **Behaviour change.**

**Today:**

- A note lives in the gate decisions log, clipped to 2,000 characters and never pruned. It also lives briefly, unclipped, in `pendingGateOperation`.
- Only the current note reaches the next attempt, as a prompt suffix (`server/src/engine/gates.ts:207`).
- Three more paths drop it:
  - an owed launch after a crash (`engine/reconcile.ts:315-333`);
  - a revised run that was queued for a slot when Argus stopped (`reconcile.ts:347-356`);
  - every retry after a revise (`engine/failure.ts:258-268`).

**Design:**

- When an attempt is planned (`startPhase`), read this phase's revise decisions from the gate decisions log. Keep a record only if all of these hold:
  - its decision is `revise`;
  - its note is not empty;
  - it is about this phase;
  - it is linked to the instance (`gateDecisionIds`).

  Read them oldest first. This covers every launch path, including instances revised before the upgrade.

- Render one line per note, `- After attempt <n>: <note>`, with at most 8,000 characters in total. Keep the oldest note and as many of the newest as fit, and mark the omitted middle with where the full text is.
- When notes are omitted, write all of them to the run's `notes/revision-notes.md` and offer that file as an optional read channel (`ARGUS_REVISION_NOTES_FILE`). Under a capability profile, Claude Code reaches only channel folders.
- The prompt order is: channel paths, then the revision notes, then the retry note last.
- Clip a note once on entry (2,000 characters), and use the clipped text for both the record and the pending operation.
- **Denied:**
  - a copy on `PhaseProgress`, which would duplicate the record and miss earlier revises;
  - pointing the agent at the log or the API: its environment has no token, and the log holds every instance's principals;
  - keeping the suffix path.

**Steps:**

1. Add the limits to `engine/constants.ts`.
2. Clip once and drop the suffix: `engine/gates.ts:637-658`, `:207`, `:317` and `:661`; `Continued.suffix` in `engine/types.ts`; the suffix parameter at `engine/launch.ts:1399-1435`.
3. Add `revisionHistory`, `revisionNotes` and `revisionNotesFile` to `engine/outcome.ts`, a leaf module, so the boundaries test stays green.
4. In `startPhase`, render the notes per run and prepend them to the note suffix at `launch.ts:816`.
5. Add the `revision-notes` channel: contracts, `harness/channels.ts`, `harness/invocation.ts`, `harness/childEnv.ts`.
6. Update the doc comments in `contracts/src/gates.ts`.

**Tests:**

- The formatter: order, attempt labels, the bound, the marker, and empty history.
- After two revises, the third attempt holds both notes, oldest first.
- Unlinked records and other phases' notes are excluded.
- After a revise and then a retry, the notes come first and the retry note last.
- Recovery:
  - a crash at `revise:linked` or `revise:killed` shows the note once;
  - a crash at `revise:saved` gives the owed launch the note. This test fails on `main` today;
  - a revised run queued at a restart carries the notes on its retry.
- The channel is recorded and granted.

**Docs:**

- HARNESS.md §13: the placement, and a new "Revision notes" subsection.
- HARNESS.md §3a: the channel table.
- API.md and `guides/pipelines.md`.
- CHANGELOG, under Changed, marked **Behaviour change**.

**Behaviour change before WS4 exists:**

- What changes for existing definitions:
  - the notes have a new format;
  - retries and remediations after a revise now carry them;
  - a note over 2,000 characters is clipped in the prompt too.
- Mark it in the CHANGELOG, and add `revise-notes-accumulate` to WS4's list of entries to add, as WS14 did.

**Risks:**

- The never-pruned decisions log is read once per attempt start, and only for instances that have decisions.
- The prompt grows by at most 8,000 characters.
- Attempts already in flight at the upgrade keep the prompt they were built with.

**Defaults:** remediation attempts get the notes; a revise without a note is left out; the 2,000-character cap stays.

### DL-A2 — Spawn phases: one child instance per task, joined

**Status:** ⬜ · **Branches:** `feat/spawn-phases` (DL-A2a, size L) first; then `feat/spawn-children-context` (DL-A2b, M) and `feat/spawn-board` (DL-A2c, M), which can run in parallel. Designed against `15a6fd5` by a read-only pass; line anchors are at that commit.

**Verified facts that shape it**

- Route predicates read only a phase's own validated `result` (`server/src/pipelineTransitions.ts:295,312`), and `resolvePath` stops at arrays. A child therefore routes on its own first phase: DL-P3's `prepare` returns the level.
- `workspace.base` is fixed per definition and never fetched (`server/src/engine/launch.ts:188-193`, `server/src/harness/workspace.ts:274-306`).
- `start(pipelineId, trigger, firing)` takes a payload but mints its own instance id (`launch.ts:1344-1390`, the id at `:1366`).
- The `after` chain pass is at-least-once: it starts the target, then writes its ledger (`server/src/scheduler.ts:621-646`). Spawns copy the gate write-ahead instead.
- Status is derived per instance (`server/src/sources/instanceStatus.ts:34-66`): a child's gate never changes its parent's status, but `inFlight(parent)` would stay true while a child waits, so `argus tail --until-idle` would never return.
- No pipeline start checks the spend budget; only schedule firings do (`scheduler.ts:405-422`).
- "Fan-out" already means parallel DAG phases in the code and in HARNESS.md, and `server/src/engine/spawn.ts` is the process-spawn module. Hence the names below.
- A Claude step whose profile allows `Read` can read another phase's folder today: in the pilot run, Define read Discover's brief. What a parent lacks is knowing its children's ids and folders, which are not placeholders.

**Design**

- **Contract** (types-only, additive):
  - `PhaseDef.spawn: { pipelineId, items: { phase, path }, key, dependsOn?, title?, maxParallel? (default 1), maxItems? (default 20, max 50), base?, include? }`;
  - `PhaseProgress.children`, with a state per task: `pending`, `planned`, `reviving`, `running`, `awaiting-approval`, `succeeded`, `failed`, `aborted`, `blocked`;
  - `PipelineInstance.parent` and `workspaceBase`; trigger `"spawned"`; pause cause `"children"`; abort cause `"parent-aborted"`; the system principal `"spawn"`; new transition events and an owed `spawn` effect.
- **Exactly one child per task, by identity.**
  1. Under the parent's lock: pick the ready tasks, mint each child's instance id, and save that plan. The save is the commit point.
  2. Off the lock: start each child with its id. `start` first returns an existing instance with that id. Only "file not found" counts as absent; any other read or parse error defers the spawn, so a transient error can never overwrite a live child.
  3. Under the parent's lock: mirror the child into the parent.
     A crash after step 1 repeats step 2 with the same id; a crash after step 2 finds the child.
- **Order:** a task starts when every task in its `dependsOn` succeeded (its PR merged, DL-A3). A `maxParallel` above 1 is refused at save until WS13 raises the limit (a constant, not an env flag).
- **A bad task list fails Plan before G2:** not an array of objects, a duplicate or missing key, an unknown or cyclic dependency, zero tasks, or more than `maxItems`. That failure is classed `signal`, which the default `retryOn` excludes, so the delivery-loop Plan adds `signal` to its `retryOn`.
- **Per-child base:** the child records its base, and its worktree is cut from it. Argus does not fetch: the child's `prepare` fetches and resets to the remote ref.
- **Join:** when every child succeeded, the spawn phase succeeds and publishes a children summary. When a child fails or is aborted, nothing new spawns, its dependents show `blocked`, and running children finish. Then the phase waits for you (pause `children`):
  - **re-run one child:** revise that child's failed phase (this works today);
  - **re-run every task that did not succeed:** revise the spawn phase. Failed children revive in place, recorded with the system principal `spawn` and the parent's decision id; aborted or never-started tasks get a fresh child;
  - **accept the rest:** approve the spawn phase; the drawer lists the dropped tasks;
  - **abort.**
    Rewinding to Plan from here is deferred. Accept the rest and start a follow-up work item instead.
- **Abort, delete, edit, retention.**
  - Aborting the parent aborts its children, and no `after` chain fires for them.
  - Aborting a child lets the parent drain, then wait for you.
  - Deleting the child pipeline aborts the children and pauses the parent.
  - Editing the child pipeline is refused (`409 instances-running`, `?force=1`) while a parent that spawns it is live.
  - Retention keeps a child for as long as its parent's record exists.
- **Status:** the parent stays `running` while a child waits at its gate, and `--until-idle` returns. The board shows "waiting for you" on the spawn phase, with a link to the child's gate.
- **Budget:** spawning holds while the spend budget is exceeded (O2).
- **The parent's view of its children (DL-A2b, opt-in):** `childrenContext: { fromPhase }` gives a phase a read-only children manifest at `ARGUS_CHILDREN_FILE`, hashed into the run's supplied inputs. It lists every child's id, phases, results, verification, gate decisions with notes, cost and artifact folders. Read channels to the children's folders come with it (`children-manifest`, `child-artifacts`).
- **Behaviour change:** none; purely additive, so no WS4 entry. An older release would stall a spawn phase, so RELEASING.md gets a note: abort such instances before `argus release --use <older>`.

**Implementation, DL-A2a (`feat/spawn-phases`)**

1. Contracts (`contracts/src/pipelines.ts`, `gates.ts`, `transitions.ts`, the index re-export), then `node scripts/check-contracts-runtime.mjs`.
2. Pure helpers in a new `server/src/sources/children.ts`: the limits, the item check (Kahn's algorithm as in `sources/dag.ts:207-222`), `nextSpawns`, the children summary, and the payload (capped at 64 KiB, like the webhook).
3. Save-time validation in `server/src/sources/pipelines.ts`:
   - a spawn phase may have zero steps (`:1181`) and nothing but `id`, `name`, `cwd`, `needs`, `produces` and `spawn`;
   - `validateSpawn`, plus graph checks: `items` comes from an ancestor whose result schema has an array of objects at that path, with `key` a required string and `dependsOn` a string list;
   - `assertSpawnTargetsValid` beside `assertAfterTriggerValid` (`:2086`): the target exists, is not the pipeline itself, has a null or webhook trigger, and spawns nothing (depth 1).
4. Pure transitions in `server/src/pipelineTransitions.ts` (`applyChildrenStart`, `applyChildrenPlan`, `applyChildrenObserved`, `applyChildDeferred`, `applyChildRefused`, `applyChildRevived`), patterned on the candidates transitions (`:1186`); the item check in `resolvePhaseResult` (`:212-261`).
5. The transition log: `child:<phaseId>#<i>` keys in the status view and attribution, the owed `spawn` effect, `decidedChildren` beside `decidedRuns`.
6. `start` by id (`launch.ts:1344-1390`) with the strict existence check; `initInstance` stores `parent` and `workspaceBase`; `ensureWorkspace` uses `inst.workspaceBase ?? policy.base`.
7. A new `server/src/engine/children.ts` (`createChildren(core)`): plan, start, sync, the abort cascade, the sweep, reconcile and the revise guard. Wired once in `pipelineEngine.ts` and `EngineFns`, patterned on `engine/candidates.ts`.
8. Hooks:
   - `startPhase` branches for a spawn phase before workspaces and the artifact wipe;
   - `saveInstance` queues the parent's sync;
   - `continueAbort` queues the cascade;
   - `revise` asks `childReviseAllowed`;
   - reconcile runs the children pass and the sweep.
     Lock order: a parent's lock is never held while waiting for a child's lock or a pipeline's start lock.
9. The budget hold. The status work: `inFlight` and the `children` pause wording in `decision/h1/gate.ts`, `sources/gatePolicy.ts` and `engine/gates.ts`. The `processChains` skip for `parent-aborted`, and the `argus tail` label.
10. The retention pin, and the edit-guard extension (`app.ts:1251-1283`).
11. API, with no new path: `?parent=` on `GET /api/pipelines/:id/instances`; `409 parent-decided`; `400` on answers at a `children` pause; `PhaseReview.children`.

**DL-A2b (`feat/spawn-children-context`):** the manifest (built once per attempt, like the ledger snapshot), `ARGUS_CHILDREN_FILE`, the two read channels through `harness/channels.ts` and `harness/invocation.ts`, and a prompt instruction.

**DL-A2c (`feat/spawn-board`):** a children tile per spawn phase in the Command Center (state per task, links, "waiting for you"); a parent chip on each child; the gate drawer's `children` pause (accept the rest, re-run, abort); a spawn glyph in the phase graph; the pipeline form accepting a zero-step spawn phase (JSON fields in v1); a "spawned" chip. Loaded lazily, within the bundle and motion budgets.

**Tests**

- Pure helpers, and each transition (a replay is a no-op, a stale attempt is refused).
- Every save-time rule.
- A new `server/src/spawnEngine.test.ts`:
  - tasks run in dependency order, and independent tasks still run one at a time;
  - a failure blocks its dependents, then the phase pauses;
  - revising a child, revising the spawn phase, and accepting the rest;
  - an abort cascades and fires no chains;
  - deleting the child pipeline mid-run, and deferral;
  - the parent's status while a child waits.
- Recovery over the same files, as in `engine/effectRecovery.test.ts`:
  - a crash after the plan commit creates exactly one child;
  - a read failure on an existing child never re-initializes it;
  - a child that ended while Argus was down joins on reconcile;
  - a concurrent sync and reconcile create one child.
- The retention pin, the chain skip, the channels with Windows-shaped paths, and route tests in a new file outside `app.test.ts` (timebox).

**Docs:** HARNESS.md §20 "Spawn phases", plus §18 (spawn identity, the owed start, the sweep), §11 (`workspaceBase`; no fetch), §3a (the two channels) and §5 (the retention pin); API.md; a "Spawn child instances" recipe in `guides/pipelines.md`; DATA-MODEL.md; the feature map; the RELEASING.md note; the glossary; CHANGELOG.

**Soak rule:** compliant. The new files are `server/src/engine/children.ts`, `server/src/sources/children.ts` and tests. No route path is added: one query filter, error codes and response fields.

**Risks:** a lock-order deadlock (tested); a revive racing the child's worktree cleanup (the WS5 race, more frequent now); a stale base if `prepare` skips the fetch; spend multiplies; `after` targets of the task loop fire once per child; `{{previous.instance}}` in a child names another task's child; WS7 edits the same stepless-phase lines; WS9's fan-out lint must not mean spawn phases.

**Open, with defaults:** O1 is D4. O2: spawning holds while over budget (yes). O3: the child's `prepare` fetches; an engine fetch can come after WS5. O4: zero tasks fail Plan, until WS8 adds `no-work`. O5: rewinding to Plan is deferred. O6: a spawn target's trigger is null or a webhook.

### DL-A4 and DL-A3 — Task inputs for checks, then gates a polled command can approve

**Status:** ⬜ · **Branch:** `feat/approval-conditions`, with DL-A4 as the first commit and DL-A3 after it, because DL-A3 uses DL-A4's inputs · **Size:** S (DL-A4, half a day) + M (DL-A3, 2–3 days).

#### DL-A4 — Per-instance inputs for command checks

**Today:**

- A command check runs with no `ARGUS_*` identity. Secrets and per-invocation identifiers are stripped (`harness/childEnv.ts:38-79`).
- Check fields are never interpolated.
- `changed-files` compares only against a per-attempt baseline.
- The pack's scripts derive the instance from the worktree path. That fails for a phase without a worktree.
- The trigger payload lives only in the instance file, beside the definition snapshot and its `hookToken`.

**Design:**

- Command checks, and DL-A3's polls, get these variables:
  - `ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID` and `ARGUS_PHASE_ATTEMPT`;
  - `ARGUS_ARTIFACT_DIR` and `ARGUS_WORKSPACE`;
  - `ARGUS_TRIGGER_PAYLOAD_FILE`.

  These are the names agent steps already get, so one script works in both places.

- The payload file is `<invocationsDir>/<instanceId>/trigger-payload.json`.
  - It is written before checks run, and only when its bytes differ, which also restores an edited file.
  - It is pruned with the instance.
  - It is a file, not a variable, because a payload can be 64 KiB and a Windows environment value is capped at 32,767 characters.
- **Denied:**
  - interpolating check fields: a webhook body in a shell command line is an injection;
  - a base ref on `changed-files`: a command check that runs `git rev-list --count <spec>..HEAD` covers it.

**Steps:**

1. `harness/childEnv.ts`: two new reserved identifiers, and a pure `commandInputLayer`.
2. `harness/invocation.ts`: `instanceTriggerPayloadPath`.
3. `engine/verification.ts`: call `ensureTriggerPayloadFile` before `runChecks` (`:170`, `:292`), and pass the layer to `buildChildEnv` (`:180`, `:299`).

**Tests:**

- The layer's contents.
- An `env.set` that names the new variables is refused.
- A webhook-started instance's check reads the variables and the file.
- A candidate gets its own folder and worktree.
- With no payload, the variable is unset.
- A restart rewrites an edited payload file.

**Docs:** HARNESS.md §6 and §4; the reserved env-var list in API.md; a task-scope recipe in `guides/pipelines.md`.

**Additive.** The one risk: a saved `env.set` that names one of the two new variables is refused on its next save. None is expected.

#### DL-A3 — A gate a polled command can approve

**Today:** only a person or a rubric verdict (`approveAutomatically`, `engine/gates.ts:429-615`) can open a gate, and nothing can fail a paused phase. Watchers run in sequence on the 30-second scheduler tick.

**Design:**

- **The field:** `PhaseDef.approveWhen: { kind: "command", run, cwd?, label?, everySeconds (30–86400), timeoutSeconds? (1–600, default 60), failOnExit? (1–255) }`. It is allowed on gated phases only, and refused on phases that commit knowledge.
- **Polling:** a new `engine/gatePolls.ts` runs on each tick, right after reconcile. It queues polls and never awaits them.
  - It polls each live phase that waits at a gate (pause `gate`) and declares `approveWhen`.
  - A poll is keyed by instance, phase and attempt: at most one per key is in flight, and none sooner than `everySeconds`.
- **One poll:** runs the command in the phase's worktree, with DL-A4's inputs.
  - **Exit 0:** approves through a new `approveOnCondition`. It uses the same write-ahead, decisions log, journal and recovery as a person's approval: mechanism `approval-condition`, channel `approval-poll`, system principal `approval-poll`, and the exit code, an output tail of at most 500 characters and the timing as its basis.
  - **Exit `failOnExit`:** fails the phase through a new pure `applyConditionFailed`. It is never retried, but a person can still revise it.
  - **Anything else:** keeps waiting. A journal entry is written only when the result changes.
- A person can approve, revise or abort at any time. A poll whose phase has moved is refused.
- **Denied:**
  - a new decision kind such as `reject`: after a rollback, an older build would finish an interrupted reject as an approval;
  - polls inside reconcile, or awaited in the tick;
  - per-poll state on the instance;
  - a journal entry per poll;
  - generalizing `approveAutomatically`.

**Steps:**

1. Contracts: `ApprovalCondition`, and the new mechanism, channel, principal and transition source.
2. Validation in `sources/pipelines.ts`, with its refusal message in `sources/gatePolicy.ts`.
3. `conditionOutcome` in `gatePolicy.ts`, and `applyConditionFailed`.
4. `approveOnCondition`, with the preamble extracted from `gates.ts:432-465`.
5. `engine/gatePolls.ts`, wired once (`engine/context.ts`, `pipelineEngine.ts`), and `index.ts` calling `engine.pollGates()` after reconcile.
6. `decision/h1/gate.ts` treats the new mechanism as automated.
7. A new journal kind, `phase.approval-condition`.

**Tests:** a new `engine/gatePolls.test.ts`, with `node -e "process.exit(N)"` commands.

- Exit 0 approves once and starts the next phases.
- `failOnExit` fails the phase without a retry.
- Other exit codes and timeouts keep the gate waiting.
- A person's revise beats a poll that is in flight.
- No poll at a `needs-input` pause, at a knowledge-staging attempt or for an orphan.
- Cadence.
- Restarts:
  - a crash at `approve:linked` completes the approval once;
  - a recorded but unlinked approval reads as not applied;
  - a fresh engine polls on its first tick.
- Validation, transitions and the H1 label.

**Docs:**

- HARNESS.md §2: an "Approval conditions" subsection.
- HARNESS.md §18: polls are gate decisions, not recovery.
- API.md.
- A PR-merge recipe in `guides/pipelines.md`. It binds the PR to the worktree's branch and HEAD, and takes credentials from the provider CLI's own login plus `env.allow`, never from a token in `env.set`.
- CHANGELOG.

**Risks:**

- The agent writes the PR id, so the recipe checks the PR's source branch and merge source commit against the worktree's HEAD.
- The output tail lands in a record that is never pruned.
- Expired CLI credentials make the poll wait forever. That is journalled once.
- A rollback drops `approveWhen` on the next save.
- Shutdown cuts polls in flight, so the command must be read-only.

**Defaults:**

- The fail path is a phase failure, not an abort.
- A board marker for polled gates is deferred.
- `approveWhen` and `autoApprove` may both be set, and whichever qualifies first wins.

**Why not today's long-running check** (DL-P3's interim):

- The phase reads as running, so it can't be revised.
- After 24 hours it fails as verification and may re-run the agent.
- A restart runs it again.
- It holds a shell open for hours.
- Nothing records what opened the gate.
- `--until-idle` never exits.
- Its environment has no instance identity.

## Pipeline workstreams

The pipeline workstreams change the pipeline's definitions, prompts and pack (templates, autonomy policy, check scripts), not Argus. Each lands as a PR in the pipeline's versioned home (DL-P1) and is applied by a person.

### DL-P0 — Hygiene on the current pipeline

**Status:** ⬜ · **Needs:** nothing new in Argus · **Only if** the current pipeline runs again before DL-P4. Otherwise DL-P1 carries the fixes and DL-P3 replaces the L1/L2 path.

- Done on 2026-10-21: the open pilot instance is aborted (its spec-only PR abandoned), and the pipeline's webhook token is rotated.
- Repoint the 12 phases whose `cwd` is still the old sandbox (gap 13).
- Replace `capabilities.env.set.CLAUDE_CONFIG_DIR` with the pipeline-level `claudeConfigDir` (gap 12), in one save: Argus refuses the field beside the `env.set` entry (HARNESS.md §3b, "Validation"). Send `claudeConfigDir` together with the capabilities that no longer carry `env.set`. The per-phase `Read` and `Edit` denies on the folder become redundant, because Argus adds them itself; drop them in the same save if wanted. Runs from before the move recorded no folder, so their transcripts stay invisible in Argus.
- Guard the L1/L2 path (gap 5): the `review` phase gets a `command` check that fails while the branch has no commits beyond the spec or while blocking findings remain. You commit your fixes, then revise the failed phase (a failed phase takes Revise, `docs/API.md:2025`).
- Until DL-A1 lands: when you revise a gate twice, repeat the earlier notes in the new one.

### DL-P1 — A versioned home for the pipeline

**Status:** ⬜ · **Needs:** decision D9.

- A private repository (default, D9) holding:
  - `pack/`: the templates (SPEC, PR, ADR), `autonomy-policy.json` and `checks/*.mjs`;
  - `setup/CLAUDE.md`: the working model the agents load, copied into the setup folder by the sync script;
  - `definitions/`: the parent and child definitions as templates, with placeholders for machine paths and no `hookToken`;
  - `scripts/sync.mjs`: renders the templates, shows the diff against the live definitions (`GET /api/pipelines`) and applies them with `PUT /api/pipelines/:id` through an admin session. A person runs it. It stops when an instance is running or waiting, unless forced;
  - `notes/`: the pilot-specific notes.
- `.gitignore` and the sync script exclude `settings.json`, `.credentials.json`, `.claude.json`, `projects/` and everything else the CLI writes into the setup folder.
- The definitions read the pack from the clone (`additionalDirectories` and the check commands point there), so a merged change is live after the next sync. The templates carry the `cwd` and `claudeConfigDir` fixes (gaps 12 and 13).
- **Done when** exporting today's definition and rendering it back gives no diff except machine paths, and a dry-run sync reports no change.

### DL-P2 — Autonomy policy v2 and lane profiles

**Status:** ⬜ · **Needs:** DL-P1, decisions D6 and D7, DL-M1 for the wording.

- `autonomy-policy.json` v2 describes each level as a profile (what the agent may do, the extra verification, the human control, the merge), as in [Target design](#levels-are-profiles-not-people-decided-details-proposed-in-d6-and-d7). Task types, risk classes and `approvedL4TaskTypes` stay. `requiresTechLead` becomes the L2 G3 checklist.
- **Define** drops `autonomyCeiling` from its result. The spec's risk class stays, for G1 (gap 4).
- **Plan** takes each task's level from its task type alone. A person can lower a level at G2, never raise it.
- New checks in `pack/checks/`:
  - `scope.mjs`: the branch changes only the task's planned files and their tests (reads the task through DL-A4);
  - `impl.mjs`: the branch has commits beyond the spec, and they change more than documentation (every build lane; gap 5);
  - `size.mjs`: the diff stays within the level's size budget (D6);
  - `deps.mjs`: an L2 task adds no dependency (package manifests, project and package references);
  - `adr.mjs`: an L1 ADR has options, a decision and consequences.
- An L2 security round: a fresh subagent runs the bundled security review over the task's diff, and any finding is blocking.

### DL-P3 — The task-loop pipeline (child)

**Status:** ⬜ · **Needs:** DL-A2, DL-A3, DL-A4 released; DL-P1, DL-P2.

| Phase           | Gated       | Runs for | Does                                                                                                                         | Checks and result                                                                       |
| --------------- | ----------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `prepare`       | no          | all      | Fetches, cuts `task/<spec-slug>/<task-id>` from the payload's base, and returns the level for routing                        | result `{level, branch}`                                                                |
| `decide`        | Decide gate | L1       | Drafts and commits an ADR under `docs/adr/` with options and a recommendation; you approve it, or revise with another choice | `adr.mjs`; `changed-files` allows only `docs/adr/**`                                    |
| `build-guarded` | no          | L2       | Implements the task, with a test for each acceptance criterion it covers                                                     | `scope.mjs`, `deps.mjs`, `impl.mjs`, test guard, verification commands, protected paths |
| `build`         | no          | L3, L4   | Implements the task                                                                                                          | `impl.mjs`, test guard, verification commands, protected paths                          |
| `verify`        | no          | L2–L4    | Fresh review rounds (and the security round for L2), the criteria map, fixes for blocking findings                           | result `openBlocking` must be `0`; test guard, verification commands, `size.mjs`        |
| `pr`            | G3          | all      | Pushes the task branch and opens the PR into the merge target (L4 with auto-complete), from the PR template                  | G3 approves itself when the PR merges and fails the phase when it is abandoned (DL-A3)  |

- A child succeeds when its PR merges: one task, one agent, one branch, one PR.
- Pipeline settings: the setup folder (`claudeConfigDir`), `workspace: {scope: "instance"}`, `overlapPolicy: "allow"`, and no trigger of its own (it is only spawned).
- The prompts give the agent the task from the payload, the spec, the plan's section for the task, and the guardrails: no pushes to protected branches, no CI, infrastructure or context files, no skipped or deleted tests.
- **Interim before DL-A3:** `pr` is not gated and carries a `command` check that polls the PR until it merges (timeout up to 24 h). The instance then reads "running" instead of "waiting for you", which is why DL-A3 replaces it.

### DL-P4 — Rework the delivery-loop pipeline (parent)

**Status:** ⬜ · **Needs:** DL-A2 and DL-A3 released; DL-P1–DL-P3.

- Phases: `discover`, `define` [G1], `plan` [G2], `tasks` (a spawn phase), `ship` [G4], `learn` [Context Retro], `apply-learnings`. The lane phases (`assist`, `pair`, `build`, `review`, `verify`, `pr`, `pr-auto`) move into the child or go.
- **Define** commits the spec on `spec/<slug>` and opens a spec PR. G1 is that PR's review and advances when it merges (DL-A3), so every child branches from a base that has the spec (D8).
- **Plan** returns per task: `id`, `title`, `taskType`, `riskClass`, `autonomyLevel`, `files`, `dependsOn`, `tests` and the acceptance criteria it covers. It recommends splitting the spec only when the work serves unrelated outcomes. Review size is the spawn phase's job.
- **`tasks`** (a spawn phase, DL-A2): one task-loop child per `plan.tasks` element, in `dependsOn` order, `maxParallel: 1` until WS13 is fixed (D1), joined before Ship. When a child fails, the phase waits for you (D4). Plan's `retryOn` includes `signal`, so a bad task list fails Plan with a retry note instead of ending the instance.
- **Ship** runs once, after the join: every PR merged, the merge commits, deployments, the feature flag and monitoring (DL-P6). G4 stays your decision.
- **Learn** reads the children manifest and every child's folders (DL-P5).
- Every gate summary leads with the evidence (checks, open findings, what changed since the last attempt) before the ask.

### DL-P5 — Learn over the whole instance

**Status:** ⬜ · **Needs:** DL-A2 (children manifest); DL-P1, DL-P4.

- **Inputs:** the parent's artifacts, the children manifest, every child's artifacts, the gate decisions with their notes, and the ledger's costs.
- **Compiles:** lead time per task (first commit to merge), review rounds and findings by kind, rework inside each branch, retries and their causes, gate wait times, cost per merged PR, and the outcome so far against the brief's metric.
- **Stages two change sets:**
  - the target repository's context: the existing `context.mjs stage|check` and the `context/<slug>` PR from `apply-learnings`;
  - the pipeline: complete new versions of pack files, prompts or definition templates under `<artifactDir>/pipeline/`; `apply-learnings` opens a PR in the pipeline's home.
- A new check, `pipeline-proposal.mjs`, refuses a proposal that widens a capability allow-list, raises a `maxAutonomy`, adds to `approvedL4TaskTypes`, or removes or weakens a check.
- Every proposed change cites its evidence (instance and phase ids, findings). The Context Retro gate shows both diffs.

### DL-P6 — G4 evidence: feature flag and monitoring

**Status:** ⬜ · **Needs:** decision D11; product work in the pilot repository.

- If the pilot repository has no feature-flag mechanism, adding one is a task for its next loop: product work, planned by the loop itself.
- Ship gets read-only access to the monitoring source chosen in D11. A credential comes from the OS secret store and is handed over in memory at launch, never stored in a file.
- Ship reports the flag and its state, the deployments of the merge commits, and the errors, latency and alarms since the deploy for what changed, with a recommendation. G4 stays a person's decision.
- Until then, Ship keeps reporting "not monitored".

### DL-P7 — The Agent Ops Review report

**Status:** ⬜ · **Needs:** DL-P1; the endpoint survey under DL-A4.

- A weekly Argus schedule (existing scheduling, no new route): a read-only run that writes a report.
- Per pipeline and per task type:
  - **agent PR acceptance rate:** merged task PRs with no commits added after the first human review;
  - **rework rate:** lines from merged task PRs changed again within three weeks;
  - **review wait time:** PR opened to first reviewer vote (Azure DevOps);
  - **cost per merged PR:** the ledger cost of each child instance;
  - **lead time:** first commit to merge;
  - **gates and retries:** wait time and revise count per gate; retries per phase and their failure classes.
- Change failure rate and time to restore need deployment and incident data. They show as "not available" until DL-P6.
- **Data, all from existing GETs** (`ARGUS_TOKEN` only, no admin session):
  - runs: `GET /api/runs?scheduleId=pipeline:<id>`, with cost, tokens, timing, `instanceId` and `phaseId`. A child's cost is the sum of its runs, superseded attempts included;
  - instances: `GET /api/pipelines/:id/instances` and `GET /api/instances/:id`;
  - gate decisions: `GET /api/instances/:id/gate-decisions`, which still answers after the instance is pruned;
  - journal: `GET /api/instances/:id/journal`, for starts, verifications and retries. It returns at most 500 entries and is deleted past 512 KiB;
  - spend: `/api/budget` and `/api/ledger`; for a long window, `/api/vault/otel?days=`;
  - PR data from Azure DevOps (`az repos pr list` and `show`, reviewer votes, commits) and git, for acceptance, review wait and rework.
- **Derivations:**
  - Gate wait is the decision time minus the latest passed `phase.verified` of that attempt. No gate-open time is recorded (see [Adjacent findings](#adjacent-findings-ask-first)).
  - Retries are `phase.retrying` entries, and revises are decisions of kind `revise`. Attempts count from 0.
- **Retention:** instances are pruned past 50 per pipeline at each start, so the job runs at least weekly and keeps its own history. Gate decisions are never pruned, and the spend ledger keeps 366 days.
- **Drop before storing or logging:** definitions, `hookToken`, `signalToken` and run prompts.
- **Don't trust** the reliability route's `firstAttempt`, `lucky` and `meanAttempts` fields (see the adjacent findings).
- The report proposes promotions and demotions (a task type up or down a level) with the evidence. The person decides, and changes `autonomy-policy.json` through a pipeline PR.

## Working model

### DL-M1 — Working model v1.1

**Status:** ⬜ · **Needs:** your go to publish. The working model is published and shared with your organization, so nothing changes there without you.

- **Autonomy levels** become profiles, as in [Target design](#levels-are-profiles-not-people-decided-details-proposed-in-d6-and-d7). "Higher risk buys more checking" replaces "higher risk gives more human". L1 becomes a decision task.
- **The loop:** people frame the work item and approve at G1–G4 and at the Context Retro; agents draft in Discover, Define and Learn. G1 and G3 advance on a merged PR; L4 merges itself within its branch policies.
- **RACI:** agents are Responsible for implementation at every level; the human owner stays Accountable for every spec, PR and release.
- **Kom igång** (the first 90 days) adapted to spawn phases and to the Agent Ops Review report (DL-P7).
- The same text goes into the setup folder's CLAUDE.md through DL-P1, so the agents and the document say the same thing.

## Open decisions (defaults proposed, the user confirms)

| #   | Decision                            | Proposed default                                                                                                                                                                                                                                                                                                                                        | Shapes       |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| D1  | Task order and parallelism          | Dependency order from `dependsOn`. `maxParallel: 1` until WS13 is fixed; then independent tasks run in parallel.                                                                                                                                                                                                                                        | DL-A2, DL-P4 |
| D2  | Branching                           | A child branches from the merge target once its dependencies merged. No stacked branches.                                                                                                                                                                                                                                                               | DL-A2, DL-P3 |
| D3  | Merge target                        | `main`, behind a feature flag, as in the working model's Ship step. Alternative while the pilot repository has no flag mechanism: one integration branch per spec, which Ship merges.                                                                                                                                                                   | DL-P3, DL-P6 |
| D4  | A failed or rejected child          | The spawn phase waits for you. You re-run that child (revise its failed phase), re-run every task that did not succeed (revise the spawn phase), accept the rest (approve; only when the missing task sits behind the flag and nothing depends on it), or abort. Revising Plan from there is deferred: accept the rest and start a follow-up work item. | DL-A2, DL-P4 |
| D5  | G1 and G2                           | Keep both. Your flow did not name them, but once nobody writes code they are where judgment enters, and the working model never skips a gate.                                                                                                                                                                                                           | DL-P4        |
| D6  | What L2 buys                        | Scope limited to the planned files and their tests; no new dependency; a security round that must find nothing; at most 400 changed lines (L3: 800); a stricter G3 checklist.                                                                                                                                                                           | DL-P2, DL-P3 |
| D7  | L1                                  | A decision task: an ADR with options and a recommendation, decided at the Decide gate, merged through G3.                                                                                                                                                                                                                                               | DL-P2, DL-P3 |
| D8  | The spec                            | Define opens a spec PR, and G1 advances when it merges, so every child branches from a base that has the spec.                                                                                                                                                                                                                                          | DL-A3, DL-P4 |
| D9  | The pipeline's versioned home       | A dedicated private repository. Alternative: a folder in the pilot repository (simpler, but one copy per target repository).                                                                                                                                                                                                                            | DL-P1        |
| D10 | Learn's limits and level promotions | Learn never widens permissions, raises a level or removes a check. A task type moves up a level after 5 consecutive merged tasks of that type with no rework and no blocking finding at G3, decided in the Agent Ops Review.                                                                                                                            | DL-P5, DL-P7 |
| D11 | G4 sources for the pilot            | Pilot-specific: which feature-flag mechanism and which monitoring tool.                                                                                                                                                                                                                                                                                 | DL-P6        |
| D12 | The soak rule                       | Keep it. Every DL-A design fits inside existing subsystems and route families.                                                                                                                                                                                                                                                                          | DL-A1–DL-A4  |
| D13 | Order against the reliability plan  | DL-A1, then DL-A2, DL-A3 and DL-A4, each released, before reliability WS4–WS12 resume. WS13 before any `maxParallel` above 1.                                                                                                                                                                                                                           | Order        |

## Adjacent findings (ask first)

Found while designing DL-A1–DL-A4. None is part of this plan's scope. The first and third were checked against the code on 2026-10-21 (attempts start at 0 in `initInstance`, `pipelineTransitions.ts:455`; `pruneInstances` slices with no status check). The rest come from the design pass and are not yet confirmed.

- **The reliability route's attempt fields are off by one.** `server/src/sources/reliability.ts:18,76,185` assume a phase's first attempt is 1, but it is 0. So a clean instance never counts as clean, and a phase revised once counts as a first-attempt pass.
- **The `after` chain pass is at-least-once** (`server/src/scheduler.ts:621-646`). A crash between starting the target and writing the ledger fires the target again.
- **Instance retention ignores liveness** (`server/src/sources/instances.ts:168-187`): past 50 per pipeline, a live instance can be pruned. DL-A2 pins children, but nothing else is pinned.
- **An owed launch after a retry drops the retry note.** `engine/failure.ts:258-268` saves before `startPhases`.
- **A trimmed placeholder's pointer is not a channel** (`sources/dag.ts:521-528`). A profile that scopes `Read` cannot open it; a bare `Read` rule can, since the pilot run read other phases' folders that way.
- **Three per-invocation identifiers are missing** from `harness/childEnv.ts:47-79`: `ARGUS_IMPLEMENTATION_SCOPE_FILE`, `ARGUS_REMEDIATION_CONTEXT_FILE` and `ARGUS_ACCEPTANCE_VERIFICATION_FILE`.
- **No gate-open time is recorded.** A `phase.paused` journal entry would give DL-P7's review-wait metric exactly, without a new route. Until then, DL-P7 approximates it.

## Not doing unless you ask

- **Route predicates over arrays.** Each child routes on its own task, so spawn phases make this unnecessary.
- **A hosted interactive pairing session in Argus.** L2 is a profile now (decided 2026-10-21).
- **Stacked task branches.** A child branches from the merge target after its dependencies merged (D2).
- **An Argus metrics view.** It would be a new route family under the soak rule; the weekly report (DL-P7) covers it.
- **Running the working model's meetings.** The pipeline feeds the Daily Sync, the Agent Ops Review and the retros; it does not hold them.
- **Merging branches inside Argus.** Landing work stays a PR that a person, or L4 auto-complete, merges.

## End-to-end verification

**DL-V, the pilot re-run.** After DL-P4, from the pinned release, start the pilot's work item again and re-plan it. It passes when:

1. Every task in the approved plan gets exactly one child. Restarting the server while the `tasks` phase spawns children starts nothing twice.
2. Every child opens exactly one PR, with implementation and tests. No PR contains only the spec.
3. A gate revised twice shows both notes to its third attempt.
4. A child's G3 advances when its PR merges. An abandoned PR fails the child, and the parent waits for you.
5. A dependent child starts only after its dependencies merged.
6. An L2 child that changes a file outside its plan fails `scope.mjs`, and its security round ran.
7. Ship runs once, after every child succeeded. G4 shows the flag and monitoring, or "not monitored" before DL-P6.
8. Learn covers every child and proposes the two PRs. `pipeline-proposal.mjs` passes: no proposal widens permissions or levels.
9. The instance ends `succeeded` with no manual state edits. That is one clean implement→PR run towards the soak (WS12).
10. The setup folder works live (from DL-A0): each step's transcript opens in Argus; the operator's own `CLAUDE.md` stays out; the folder's and the repository's instructions reach a subagent; `GET /api/runs/:id/invocation` shows `claudeConfigDir`, the three deny rules and the per-run `settings.json` with `claudeMdExcludes`.

Until it has run, report it as "ready for verification", never as done.
