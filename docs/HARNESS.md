# Argus as a harness

[Documentation](README.md) · [Pipeline guide](guides/pipelines.md) · [Advanced recipe map](guides/pipelines.md#advanced-feature-recipes)

This reference defines execution protocols, optional controls and worked
pipeline examples. New users should complete [their first run](getting-started/first-run.md)
and the [pipeline walkthrough](guides/pipelines.md#try-it) before authoring
advanced API settings. Knowledge workflows are mapped separately in the
[Knowledge guide](guides/knowledge.md#authoring-knowledge-workflows).

Weave gave a pipeline a shape — a DAG of phases with dependencies, retries and
routing. This is about what happens _inside_ one phase's run: what Argus
launches, what it lets that process do, how it decides the process actually
succeeded, and what it writes down so a run can be explained (and reproduced)
after the fact. None of it is required — a phase that declares no
`capabilities`, no `checks` and no `timeoutSeconds` runs exactly as it always
did, on the CLI's own defaults.

The pieces this document covers live in `server/src/harness/`:

- `invocation.ts` — resolves capabilities, asks the runtime to map them onto
  flags/config, applies the environment policy, and writes down what it did.
- `childEnv.ts` — the one place a child process's environment is assembled.
- `verification.ts` — Argus's own deterministic checks over a phase's work,
  and the command runner approval polls reuse (§2, Approval conditions).
- `workspace.ts` — the git worktree a phase's steps run in, when one is
  declared (§11), and one per candidate when a phase runs best-of-N (§12).
- `memory.ts` — a pipeline's durable, cross-instance notes (§13).
- `stall.ts` — deciding whether a still-alive step has gone quiet too long (§7).
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
  │                                               Argus classifies the final message's
  │                                               ARGUS_OUTCOME marker itself, whichever
  │                                               path it arrived by (§2)
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
- **The deadline clock starts at spawn, not when the wave is planned.** A step
  can sit queued behind the concurrency semaphore for a while; `deadlineAt`
  (and `run.startedAt`) are computed once the slot is held and the invocation
  is fully prepared — immediately before `deps.spawn` is called — so a step's
  timeout budget is never eaten by however long it waited for a slot.
- **A run past the concurrency cap waits off the instance lock.** A wave is
  planned and recorded under the instance lock; each run that fits under
  `maxConcurrent` spawns there and then, and the rest are queued for a slot
  _without_ the lock. The semaphore is strictly FIFO: a released slot passes
  straight to the longest waiter, so two runs never share one. When a queued
  run gets its slot it takes the lock again and spawns only if its instance is
  still running (or paused at another phase's gate), its phase is running at
  the same attempt, its step is still running and it has no run record yet;
  otherwise the journal says `not launched: decided while waiting for a slot`.
  A run Argus refuses at planning (an unresolvable knowledge context, a
  missing change request, an unusable accepted intent) is failed then, and
  never takes a slot. So `start`, `approve` and `revise` return once every run
  that fits has spawned and the rest are queued, and a completion signal or a
  reconcile tick is never held behind a launch waiting for a slot.
- **Shutdown waits, briefly, for detached continuations.** Every
  `launchStep`/`queueVerification` continuation that runs off the request path
  is tracked in a set the engine can await; `Engine.drain()` resolves once
  that set is empty, and server shutdown races it against a 5-second timeout
  so an in-flight launch or verification gets a chance to persist its result
  instead of being cut off mid-write.

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
final message's ARGUS_OUTCOME marker           nothing the run wrote has been read yet
classified (completion policy)                no marker under `required`, conflicting
        │                                     markers, or a stop-hook reading that
        │                                     disagrees with Argus's → "unverified"
        │                                     `failed`/`blocked` inside a `completed` → "signal"
        ▼
supplied KnowledgeContext re-hashed (if any)   bytes changed or file gone
        │                                          → "knowledge-context-integrity"
        │                                     (KNOWLEDGE-LEDGER.md §13.11)
        ▼
declared result schema validated (if `result`) missing/unparseable/schema-invalid → "signal"
        │                                     (the agent reported, but nothing routable; classed
        │                                      with a bad route condition, under the same policy)
        ▼
deterministic checks run (if `checks`)         a failing CheckResult → "verification"
        │
        ▼
gate opens (if `gated`): a person,            the approveWhen command exits with
auto-approval, or an approval condition       its failOnExit code → "approval-condition"
        │
        ▼
staged KnowledgeDeltas, rule                 a refused commit → "knowledge-delta",
verifications and change proposals            "rule-verification" or "change-proposal"
commit (if any)                              (stale revision precondition, conflicting
        │                                      sibling deltas, a cited check the phase's
        │                                      report does not contain, a proposal's local
        │                                      reference the commit did not create; ONE
        │                                      ledger transition for all three —
        │                                      KNOWLEDGE-LEDGER.md §12, §15.10, §16.10)
        ▼
succeeded
```

A delta the run wrote is also validated at the completion signal itself: a
malformed or refusable document fails the step under `"knowledge-delta"`
before any of the rungs below it, so an agent's proposal is never silently
dropped.

On a phase that declares `discovery` (business-rule discovery,
KNOWLEDGE-LEDGER.md §14), the same intake applies the discovery invariants:
every proposed business rule must carry supporting evidence, and every
`source-code` evidence path must be repository-relative, inside the phase's
declared scope, at the commit Argus recorded for the run, and point at a file
that is actually there. A failure is a `"knowledge-delta"` refusal like any
other. The source-path and existence checks run **again** at the commit
boundary, exactly as the declared-artifact checks do, so a file deleted while
a person deliberated at the gate refuses the commit rather than being recorded
as provenance for something that is gone.

On a phase that declares `ruleVerification` (business-rule verification,
KNOWLEDGE-LEDGER.md §15), the completion also reads the run's
`ARGUS_RULE_VERIFICATION_FILE`. The rules the run is accountable for are
exactly the business rules its own KnowledgeContext supplied, and the intake is
deterministic: every one of them must receive an outcome (`holds`, `violated`
or `unverifiable`) and nothing else may; a `holds` or `violated` outcome must
cite evidence and an `unverifiable` one must give a reason; a cited `check`
label must be one the phase declares; and a cited source path must be a real
file inside the run's repository. A missing rule, an unsupplied rule, or no
file at all fails the step under `"rule-verification"` — on a verification
phase, "no file" is not "nothing proposed". At the commit boundary each cited
check is bound to the phase's own `VerificationReport`, so an agent can name a
test but never claim one passed.

On a phase that declares `changeIntent` (change-intent orchestration,
KNOWLEDGE-LEDGER.md §16), the completion reads the run's
`ARGUS_CHANGE_PROPOSAL_FILE` **before** its KnowledgeDelta, because on such a
phase the proposal carries the delta: its `semanticDelta` is staged as that
run's KnowledgeDelta and commits through exactly the Phase 3 boundary, and a
separate delta file beside it refuses the step (one run, one account of what it
proposes). The intake is deterministic: every business rule the run's own
KnowledgeContext supplied must be classified `revised`, `preserved`,
`not-relevant` or `unresolved`; that classification must agree with the
semantic delta; no claim may be both preserved and revised; every acceptance
criterion must reference a delta-local id the proposal declares or an exact
revision the ledger holds; and — under the default
`acceptanceCriteria: "required"` — every proposed business-rule change must
carry a criterion. Writing no file at all fails the step: a run given an
explicit requested change has an obligation to answer it. Everything that is a
judgement for a person (an unresolved question, a pre-existing defect, a change
that turns out to be a no-op) travels to the gate as a warning instead.

Ahead of all of it, the completion signal's own report is classified: Argus
reads the run's final message for an `ARGUS_OUTCOME` marker and, under the
default policy, refuses a completion that does not carry an unambiguous
`succeeded` — before it reads a single file the run wrote. See
[Completion policy](#completion-policy-the-agents-report-not-verification)
below.

Ahead of even the delta, a run Argus supplied a KnowledgeContext to has its context
file re-hashed against the value recorded at launch. Changed or missing bytes
fail the step under `"knowledge-context-integrity"` **before** the delta is
read, so a run whose input Argus can no longer vouch for never stages a
proposal, let alone commits one. This matters most where read-only enforcement
is best-effort: the `0444` mode and the runtime's deny rules are the guard, and
this check is the proof. A claim _revised in the ledger_ while the agent ran is
not tampering — the file is untouched and integrity passes (KNOWLEDGE-LEDGER.md
§13.11).

`PhaseFailureClass` (in `@argus/contracts`) is the closed set:

| Class                         | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Retried by default?                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `spawn`                       | The process never started — preparing the invocation threw, `deps.spawn` itself threw, or (found by `reconcile()` after a restart) a step recorded `running` had no process behind it at all. `run.termination = "spawn-failed"`.                                                                                                                                                                                                                                                                                                                                                                                                               | **Yes**                                                 |
| `exit-code`                   | The process ended (any way) without Argus's own timeout and without the agent signalling failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Yes**                                                 |
| `signal`                      | The agent's _own_ completion signal declared `failed` or `blocked` — it considered the work and reported on it. (Named for the pipeline `signal` the agent posts, **not** an OS process signal.)                                                                                                                                                                                                                                                                                                                                                                                                                                                | No — opt in via `retry.retryOn`                         |
| `unverified`                  | A `completed` signal (or a finished run record) whose final message Argus could not accept as the agent's report of success: no `ARGUS_OUTCOME` marker under a `required` policy, more than one distinct conclusion, or — under `required` — a stop-hook reading of the marker that disagrees with the message it delivered. Refused before anything the run proposed is read. On the run-record path a missing or conflicting marker is `unverified` under either policy. It is a protocol failure, not a verdict: the agent said nothing Argus could act on. A marker that says `failed`/`blocked` is the agent's verdict and stays `signal`. | **Yes**                                                 |
| `timeout`                     | Argus killed the process at its `deadlineAt`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | No — opt in                                             |
| `verification`                | Every step reported success, but a `checks` entry failed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | No — opt in                                             |
| `knowledge-delta`             | The run wrote a KnowledgeDelta Argus refused — malformed, an unresolved or inexact reference, a stale `expectedRevision`, a cycle, a claimed artifact that does not exist, or (on a `discovery` phase) a business rule with no evidence or source evidence that is out of scope, at the wrong commit or missing — or the phase commit was refused (the ledger moved while a gate waited; two steps' deltas conflicted). The refusal is the reason, so a retry can propose from the current ledger.                                                                                                                                              | No — opt in                                             |
| `knowledge-context-integrity` | The KnowledgeContext Argus materialized for the run no longer hashes to the value recorded at launch — the file was modified, or removed, while the agent ran. The completion is refused and nothing the run proposed becomes canonical. The reason names the run, the expected hash, the hash found and the path; never the contents.                                                                                                                                                                                                                                                                                                          | No — opt in                                             |
| `rule-verification`           | The run emitted a rule-verification proposal Argus refused — malformed, a rule it was not supplied, a supplied rule left without an outcome (or no file written at all), an outcome with no evidence, an `unverifiable` with no reason, a `check` label the phase does not declare, source evidence that is not a real file inside the repository — or the phase commit was refused (a cited check absent from the report; a `holds` whose check did not pass under `holds: "deterministic-check"`). The refusal names exactly what was missing (KNOWLEDGE-LEDGER.md §15.7).                                                                    | No — opt in                                             |
| `change-proposal`             | The run emitted a ChangeProposal Argus refused — malformed, no file written at all, a supplied rule left unclassified, a classification that contradicts the semantic delta, a claim both preserved and revised, an acceptance criterion naming a local id the delta does not declare, a business-rule change with no acceptance criteria under a `required` policy, or a separate KnowledgeDelta file written beside it — or the phase commit was refused (a local reference the commit did not create; the ledger moved under the proposal's `expectedRevision`). The refusal names exactly what was missing (KNOWLEDGE-LEDGER.md §16.8).     | No — opt in                                             |
| `change-context-integrity`    | An Argus-owned **read-only input** the run was given — its ChangeContext, its ImplementationScope, its RemediationContext — no longer hashes to what Argus recorded at launch. The exact counterpart of `knowledge-context-integrity`, and it asks the same question: _did the bytes supplied to this invocation change?_, never _is this still the newest proposal?_. The completion is refused and nothing the run proposed becomes durable (KNOWLEDGE-LEDGER.md §17.8).                                                                                                                                                                      | No — opt in                                             |
| `acceptance-verification`     | The run emitted an acceptance-verification proposal Argus refused — malformed, a criterion the accepted proposal does not declare, a required criterion left without an outcome (or no file written at all), an outcome with no evidence, an `unverifiable` with no reason, a `check` label the phase does not declare, a report written against a different accepted change, source evidence that is not a real file inside the repository — or the phase commit was refused (a cited check absent from the report; a `satisfied` citing a check Argus observed failing) (KNOWLEDGE-LEDGER.md §17.7).                                          | No — opt in                                             |
| `configuration`               | The declared capability profile could not be enforced under strict enforcement, or a change realization's preconditions do not hold (the accepted intent's target revisions are no longer active; the attempt budget is spent) — the step never launched.                                                                                                                                                                                                                                                                                                                                                                                       | **Never** — the definition is what's wrong, not the run |
| `approval-condition`          | The phase waited at its gate and its `approveWhen` command exited with its `failOnExit` code (for example: the pull request was abandoned). See [Approval conditions](#approval-conditions).                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **Never** — a person revises or aborts                  |

The class is written onto the phase's payload (`withFailureClass`) whenever a
phase fails, whether or not that failure ends up scheduling a retry — a
terminal failure with no attempts left still names which of the fourteen classes
it was, never just "failed".

**A completion signal is authoritative over the exit code that follows it.**
Once a step's Stop hook (or the reconcile fallback) reports `completed`, the
phase has already advanced on it; a process that then exits non-zero does not
unwind that decision. The contradiction is recorded, not hidden: the run
carries both `outcome: "succeeded"` and the non-zero `exitCode`, and the
journal gets a `step.exit-mismatch` entry. See §10.

`RetryPolicy.retryOn` defaults to `["spawn", "exit-code", "unverified"]` — the
classes that plausibly reflect a transient infrastructure hiccup, or an agent
that reported nothing Argus could accept, rather than a considered verdict. An
absent or ambiguous completion report is a protocol failure, not a judgement:
re-running the prompt costs one more attempt, and the retry note carries the
refusal reason, which for a missing or conflicting marker names the one that is
required. (The run-record path used to class exactly this case `exit-code`, so
the default retries it as before.) An author who wants a flaky test suite
retried opts `"verification"` in explicitly; wanting a `"signal"` failure
retried is asking Argus to re-run a prompt whose own agent already decided it
failed, which is allowed but is rarely what you want.

A policy that lists `retryOn` explicitly replaces the default rather than
extending it, so it must now add `"unverified"` to keep retrying a missing
marker — previously, on the run-record path, an explicit `["exit-code"]` was
enough. `retryOn` accepts every class the contract's `RetryableClass` names
(including `unverified`, `change-proposal`, `change-context-integrity` and
`acceptance-verification`); everything but `configuration` and
`approval-condition` may be named.

A retried attempt is told why the previous one failed: `retryNote()` appends a
bounded, class-specific note to the prompt for **every** retryable class, not
only `"verification"`/`"signal"` — see §13.

### A received signal comes first

A completion signal is counted as in flight from the moment it reaches the
server, before it waits for the instance lock. While it is, a reconcile pass
leaves that run alone instead of healing it from its run record: the agent's
own report decides the step, never a reading of the record that happened to
get the lock first. Duplicate deliveries are counted, so the run stays
protected until the last one has been applied.

A signal is also accepted while a _sibling_ phase waits at its gate. The
instance then reads `awaiting-approval` as a whole, but the signalling run's
own phase is still `running` and its report counts. Only a terminal or aborted
instance ignores a signal outright; a signal for a phase that is itself paused
is ignored by the transition, as `phase-not-running`, and journalled. The
accepted phase's checks still wait for the gate decision: check results are
not applied to a paused instance, and recovery re-runs them once it is
running again. The same holds for a run that was queued for a slot and is then
refused at launch, for example because its capability profile cannot be
enforced: its phase fails under `configuration` even while a sibling waits at
its gate.

### Instance status is derived from the phases

A live instance's status is never written by hand. Every transition that
keeps an instance live (settle, revise, remediation, a retry starting or being
scheduled) sets it with `liveStatus`: `awaiting-approval` while any phase
waits at a gate, else `running`. A transition that wrote `running` would hide
a sibling's waiting gate from auto-approval, from the gate counts and from the
rule that results wait for a gate decision.

A failed phase with a retry scheduled (`retryAt`) counts as live in
`instanceOutcome`, so the instance does not end as `failed` while a retry is
pending: no `onFailure`, no `instance.ended`, no `after: failed` chain and no
worktree cleanup. A due retry runs while a sibling waits at its gate.

A spawn phase (§20) stays `running` while its children run or wait at their
own gates: a child's gate is the child's, and never makes its parent
`awaiting-approval`. The parent waits only when the spawn phase pauses at
`children` (a child failed or was aborted, and none is live), and only a person
opens that pause. Whether an instance is in flight, moving without a person,
reads the spawn phase's tasks: a parent whose live children all wait at their
own gates is not, so `argus tail --until-idle` returns.

The questions are named once, in `server/src/sources/instanceStatus.ts`:
`resumable` (the engine may still act), `isTerminal`, `appliesResults`
(results apply only while no gate waits), `hasWaitingGate` (asked of the
phases, for every count and badge), `pendingRetry`, `liveStatus`, `inFlight`
(something moves without a person) and `isLiveTask` (a spawn phase's task
holds one of its `maxParallel` slots).
`engine/instanceStatus.test.ts` fails on an inline `running` or
`awaiting-approval` comparison of an instance's status in the engine or the
transitions, on a spelled-out terminal check, and on a hand-written live status.

### The hook retries delivery

The stop hook (`hooks/argus-signal.mjs`) does not give up on the first failed
POST. It retries within a **45 s budget**, which keeps it inside Qwen's 60 s hook
limit (Claude Code and Codex allow 600 s). Between attempts it waits 0.5, 1, 2,
4 and then 8 s, and keeps waiting 8 s until the budget is spent. The budget,
not an attempt count, ends the retries. Each attempt may wait for whatever is
left of it, and the last error is reported.

- **Retried:** a transport error (refused, reset, timed out) or a 5xx, because
  Argus may be busy or restarting.
- **Never retried:** a 4xx. A bad token or an unknown instance is Argus's
  answer, and the same request cannot change it.
- **Sent unchanged:** every attempt carries the identical body. A duplicate of
  a signal Argus already applied is ignored as `step-not-running`, so a retry
  after a lost response is harmless.

The payload is unchanged, so `HOOK_VERSION` stays where it was. Installed
copies are compared by byte hash and re-copied by setup and `preflight()`.

### Completion policy: the agent's report, not verification

A step's process stopping and the agent saying it finished are two different
facts. The stop hook reports `completed` for anything that is not a
`failed`/`blocked` marker, so before this policy a run that stopped without
saying anything — a truncated final message, a session that ended mid-thought —
advanced exactly like one that concluded `ARGUS_OUTCOME: succeeded`. A phase now
declares what it will accept:

```jsonc
{ "completion": { "marker": "required" | "lenient" } }
```

on the pipeline, on a phase, or both. The phase's declaration overrides the
pipeline's (narrowest wins), and with neither the effective policy is
`required`. **That default is an intentional behaviour change**: a `completed`
signal used to be accepted whether or not the final message carried a marker.
The policy is read from the instance's retained definition snapshot
(`instance.definition`), so editing a pipeline mid-flight does not change the
policy of an instance already running, and an instance started before the
upgrade — whose snapshot has no `completion` field — runs under `required`.
`completion` accepts only `marker`; any other key is a `400` validation error,
because a typo here would otherwise silently mean `required`.

**One classifier reads the message.** On a `completed` signal Argus classifies
the run's final message itself — the first of the payload's
`last_assistant_message`, `last_agent_message` and `last_message` that is a
string — with a single pure function (`classifyOutcomeMarker`, in
`server/src/harness/completion.ts`). A marker is recognised anywhere in the
message, in any case, and the result is one of `succeeded`, `failed`,
`blocked`, `missing` (no marker) or `conflicting` (more than one distinct
conclusion; repeating the same one is harmless, since models often recap before
the required last line). A completion with no final message at all is
`missing`. The stop hook has always read failure markers this way; the
run-record fallback used to require the marker at the start of a line and now
uses the same classifier.

| Final message read as | `required` (default)        | `lenient`                                              |
| --------------------- | --------------------------- | ------------------------------------------------------ |
| `succeeded`           | accepted                    | accepted                                               |
| `missing`             | refused, class `unverified` | accepted; the step records marker `missing`, `lenient` |
| `conflicting`         | refused, class `unverified` | refused, class `unverified`                            |
| `failed` / `blocked`  | refused, class `signal`     | refused, class `signal`                                |

`lenient` relaxes exactly one thing: a _missing_ marker on the signal path. It
never means "ignore what the agent wrote" — a message that reports `failed`, or
two conclusions at once, is refused under either policy. A `failed`/`blocked`
marker inside a `completed` signal is the agent's own verdict, so it is classed
`signal` like any other failure the agent reported.

**Refusal happens before Argus reads anything the run proposed.** A refused
completion stages no KnowledgeDelta, rule verification, change proposal or
acceptance verification and runs no checks; the step fails with the class above
and the retry policy takes over. That is why this is the first rung of the
ladder rather than a check beside the others: an agent whose report Argus will
not accept has not earned a read of what it left behind.

**Stop-hook metadata.** Hook version 2 (`HOOK_VERSION = 2` in
`hooks/argus-signal.mjs`) sends an additive top-level
`completion: { hookVersion: 2, marker }` with every signal — its own reading of
the marker. It is untrusted: Argus re-classifies the message it was delivered
and only compares. Under `required`, any disagreement between the hook's
reading and Argus's, or metadata that is not the shape a hook writes, refuses
an otherwise acceptable completion as `unverified` — two readings of one
message that differ is exactly the ambiguity the policy exists to refuse. Under
`lenient` the disagreement is recorded and the message alone decides. A hook
older than version 2 sends no metadata and keeps working (its completions are
judged on the message); a server older than this change ignores the field. The
hook's choice of signal type is unchanged: a failed/blocked marker anywhere
sends `failed`, pending background work sends nothing ("deferred"), anything
else sends `completed`.

**The run-record path.** Runtimes with `outcomeFromRecord` (Codex, OpenCode)
recover a completion from the finished run's final message with the same
classifier. A missing or conflicting marker is `unverified` under _either_
policy: on that path an exit code alone has never been taken as a completion,
and `lenient` does not change it. `failed`/`blocked` stay `signal`.

**What is recorded.** Every run's completion is written on its step as
`StepProgress.completion` — `{ signal, source: "signal" | "run-record", policy,
marker, hook?, verdict: "accepted" | "refused" | "reported-failure", reason?,
at }`. A multi-step or candidates phase keeps one per run, and a phase's
completion is derived from all its steps (`summarizePhaseCompletion`), never
stamped from whichever signal arrived last. A refused candidate loses with
failure class `unverified` and is never selectable. The step drawer words it as
the agent's report ("agent reported succeeded — accepted", "no outcome marker —
accepted under the lenient policy", "… — completion refused") and the
Reliability card labels the class "unverified completion".

**What a marker is not.** The marker is something the agent wrote. Requiring it
separates "the process stopped" from "the agent says it finished"; it never
makes the claim true, and a `succeeded` marker does not prove the work is
correct. The result schema, the deterministic checks, the gate and the
knowledge commit are separate authorities, each of which still decides its own
part of the ladder below — and none of them speaks for the others. Treat an
accepted marker as permission to go on to those rungs, not as having passed
them.

**Opting out** is `{ "completion": { "marker": "lenient" } }` on the pipeline
(or a single phase). Before relying on it, note what it restores: acceptance of
a completion no one vouched for, with the missing marker visible in the step's
completion record rather than silently absorbed.

### Per-run signal tokens

A signal is the agent's own report, so it has to be attributable to the run
that sent it. Every run of an instance used to be handed the instance's one
`signalToken`, which meant any run could complete, fail or pause any other step
of that instance — a sibling, a later attempt, a phase it had nothing to do
with. Now each run that can signal gets its own random 256-bit token in
`ARGUS_SIGNAL_TOKEN` (the variable name is unchanged, so installed hooks keep
working). Argus persists only a `SignalAuthRecord`
`{ scheme: "run-token-v1", sha256, phaseId, attempt }` on the step and on the
run record, where `sha256` is a SHA-256 over the token together with the
instance id, phase id, attempt and run id. The token value itself is never
persisted — not in `invocation.json`, the run, the instance or any
materialized config file (a test scans every file under the home for it) — so
no stored record holds a usable credential.

A signal is accepted only when its token verifies for the exact run it names. A
sibling's token, another instance's run token and another attempt's run token
all get `403`. New instances carry `signalScheme: "run-token-v1"`, and on them
the instance-wide `signalToken` is never accepted for anything; it is still
minted only so the record keeps its shape.

**Compatibility.** An instance without `signalScheme` whose step has no
`signalAuth` — a run launched before the upgrade — still accepts the
instance's legacy `signalToken` for that step, so a run already going when
Argus was upgraded can finish. Any step launched after the upgrade, including
the next phase of that same instance, has its own token and refuses the legacy
one.

**Runtimes without a signal hook** (`capabilities.signalHook: false`, i.e.
OpenCode) are given no `ARGUS_SIGNAL_TOKEN` at all: a credential nothing uses is
only something to leak. Their step records `signalAuth: { scheme: "none" }` and
every HTTP signal for them is `403`. They complete through the run-record path,
which is engine-internal and never goes through HTTP authentication — as are
the engine's other synthesized completions (run-record recovery, deadlines,
refusals).

**Stale and duplicate signals.** A genuine signal for a run that is no longer a
current step (a revised or retried attempt's run, a superseded candidate) is
authenticated against the run record's own `signalAuth`, journalled as ignored
(`202`) and changes nothing — not the instance and not the run record. A forged
one is `403` and is not journalled. An ignored signal used to patch the run
record's `outcome`; it no longer does, so a run whose completion was refused
(outcome `failed`) cannot be flipped to `succeeded` by a repeated hook
delivery. Likewise a step that is no longer `running` ignores signals
(`ignored: "step-not-running"`): a duplicate `completed` cannot overwrite the
payload or result a sibling may already have read, and a late `failed` cannot
fail a phase whose step already succeeded. For `needs-input`, the signal pauses
the phase (`awaiting-approval`, `pause: "needs-input"`); the same run's later
Stop signal is then a no-op (`200` on a paused instance), and approving (with
answers) or revising is what resumes it.

**This is not a security boundary.** An agent and its own hook share an OS user
and an environment, so an agent can always read the token its own hook uses. The
binding limits what a _leaked_ token can reach — its own run, nothing else. It
does not prove a human was involved and does not protect against same-user file
or process access. Argus does not deliver the token through a file: environment
delivery is kept because globally installed hooks (Codex, Qwen) may be the older
version, which reads only `ARGUS_SIGNAL_TOKEN`, and a file alongside an
environment variable would not reduce exposure.

### Approval conditions

A gated phase can declare a command that Argus polls while the phase waits at
its gate, so a gate can open when something outside Argus says it may — a
pull request merged, a deployment went green — without a person watching for
it (`PhaseDef.approveWhen`, `ApprovalCondition` in `@argus/contracts`;
`engine/gatePolls.ts`):

```jsonc
"approveWhen": {
  "kind": "command",
  "run": "node /home/you/argus-checks/pr-merged.mjs", // 1–4,000 characters, through the shell
  "label": "pull request merged",      // optional, ≤120; default: "command: " and the first 71 characters of run
  "everySeconds": 300,                 // 30–86400, from one poll's start to the next
  "timeoutSeconds": 60,                // optional, 1–600; default 60
  "failOnExit": 3                      // optional, 1–255
}
```

- **Where it is allowed.** On a gated phase only, and never on a phase whose
  gate commits knowledge: the same rule that refuses `autoApprove` there
  (`knowledgeCommitReasons` in `sources/gatePolicy.ts`) refuses `approveWhen`
  when the definition is saved. The defaults are applied when a poll runs,
  never stored, so a definition round-trips exactly as it was written.
- **Where and how it runs.** In the phase's worktree (§11), or its `cwd` when
  it has none, exactly where its checks run; an optional `approveWhen.cwd` is
  resolved against that, and an absolute one stands. It runs through the
  platform shell under the phase's own environment policy, with the inputs a
  command check gets: `ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`,
  `ARGUS_PHASE_ATTEMPT`, `ARGUS_ARTIFACT_DIR`, `ARGUS_WORKSPACE` and
  `ARGUS_TRIGGER_PAYLOAD_FILE` (§6, "What a command check is told"; the
  payload file is written before every poll). Nothing in `approveWhen` is
  interpolated. The runner is the command checks' own (`runCommand` in
  `harness/verification.ts`), so a timeout or a shutdown ends the command's
  whole process tree (§17).
- **Out of the agent's reach.** A poll runs in the tree the phase's agent has
  just edited, and its exit 0 opens the gate. Keep the script, and every
  program it starts, outside that tree, and name the script by absolute path
  as the example does: a `scripts/pr-merged.mjs` committed to the repository
  is the agent's to edit, and an edit that makes it exit 0 opens the gate with
  no person approving and nothing merged. On Windows a program named without
  a path is looked for in the current directory before `PATH`, whether the
  shell or the script starts it, so name the interpreter by absolute path too;
  otherwise a `node.cmd` the agent left in its worktree runs in its place. A
  worktree is not a jail (§11): an agent that can write outside it can still
  edit the script itself.
- **What a result means.** Only a command that exited on its own speaks
  (`conditionOutcome` in `sources/gatePolicy.ts`):
  - **exit 0** approves the gate, through the same write-ahead record, link,
    completion and recovery as a person's approval; the next phases start;
  - **an exit equal to `failOnExit`** fails the phase under the
    `approval-condition` class (`applyConditionFailed` in
    `pipelineTransitions.ts`), which no `retryOn` can name, so it is never
    retried. A person can still revise it. It is not a gate decision: there
    is no decision kind for it, and an older build would complete an unknown
    kind as an approval;
  - **anything else** keeps the gate waiting: any other exit code, a timeout,
    a kill, a command that could not start. A timed-out command that traps
    SIGTERM and exits with the `failOnExit` code still only waits.
- **What an approval records.** A gate decision with mechanism
  `approval-condition`, channel `approval-poll` and principal
  `{ kind: "system", component: "approval-poll" }`, and as its basis
  (`condition`) the label, the exit code, the last 500 characters of the
  command's combined output, when it started and how long it ran. The record
  is never pruned: print one short line that explains the result, never a
  secret.
- **Cadence.** Polls are queued on the scheduler tick, right after
  `reconcile` and never inside it; the tick does not wait for them. At most one
  poll runs per phase attempt, and the next starts no sooner than
  `everySeconds` after the previous one started (to within a second), so the
  resolution is one tick (`ARGUS_SCHED_TICK_MS`, 30 s by default). The first
  scheduler tick after a restart polls again: nothing about a poll is stored
  on the instance.
- **The journal.** `phase.approval-condition`, only when the result changes:
  the first wait, an approval, a failure, a refusal. A condition that waits for
  days leaves one entry per server process. Expired credentials for the tool a
  condition calls make it wait forever, journalled once; look there when a gate
  that should have opened has not.
- **What is never polled.** A phase paused for an agent's question
  (`needs-input`), a spawn phase waiting on its children (`children`, §20; a
  spawn phase cannot declare `approveWhen` either), a pause recorded before
  pause causes were, a gate whose attempt staged knowledge (journalled once per
  attempt as "not polled"), an instance whose pipeline was deleted, and an
  instance whose gate decision is still being completed.
- **A person first, and `autoApprove` beside it.** A person can approve,
  revise or abort at any time; a poll that finishes after the phase moved is
  refused under the instance lock (`approveOnCondition` and `failOnCondition`
  in `engine/gates.ts` decide again, on exactly the terms a Verdict
  auto-approval does) and journalled as "not applied". So is a poll on a
  spawned child its parent no longer waits for (`409 parent-decided`, §20).
  `approveWhen` may sit beside `autoApprove`; whichever qualifies first opens
  the gate.
- **Read-only and repeatable.** A shutdown cuts a poll in flight and discards
  its result, and the next server runs it again, so a condition must only
  read. It never holds a shell open between polls.
- **Rollback.** A build from before approval conditions ignores `approveWhen`
  — those gates wait for a person — and drops the field the next time it
  saves the pipeline.

The [pipelines guide](guides/pipelines.md#open-a-gate-when-its-pull-request-merges)
has a worked recipe that opens a gate when its pull request merges.

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
  `Edit(//<dir>/**)` for every `additionalDirectories` entry, each path spelled
  the way Claude Code's rules match it (see _Rule paths_ below), **plus**
  `Bash` and `PowerShell` themselves — unless `tools.allow` already names
  specific `Bash(...)` or `PowerShell(...)` rules, in which case only those
  survive and that shell's bare rule is left alone. An `Edit(path)` deny rule
  is what actually does the work here: Claude Code consults it for every
  built-in file-editing tool — `Edit`, `Write`, `MultiEdit`, `NotebookEdit` —
  not only its own `Edit`; a `Write(path)` rule is accepted but never
  consulted, so `Edit(...)` is the one shape that denies writes under these
  roots. If `tools.allow` contains a **bare** `Bash` or `PowerShell` (or
  `Bash(*)` / `Bash(*:*)`, and the same for `PowerShell`) rule, Claude Code
  cannot be made read-only for shell commands at all — that is reported as its
  own limitation string rather than the generic one:
  `"read-only cannot prevent shell writes while Bash is allowed unrestricted"`
  (or `… while PowerShell …`). A root (`cwd` or an `additionalDirectories`
  entry) no rule can name — a comma or newline, which would split the
  comma-joined `--disallowedTools` flag, or a UNC share — is reported as its
  own limitation (`"read-only cannot be expressed for a path that contains a
comma or newline, or is a UNC share: ..."`), which under strict enforcement
  (the default) refuses the launch rather than silently leaving that root
  writable.
- `tools.allow` / `tools.deny` → `--allowedTools` / `--disallowedTools`
  (comma-joined; a rule may not itself contain a comma).
- `mcpServers` (present, even `{}`) → written to
  `<invocationDir>/mcp.json` as `{ "mcpServers": {...} }`, passed as
  `--mcp-config <path> --strict-mcp-config`.
- `additionalDirectories` → one `--add-dir <dir>` per entry — **and** every
  Argus-owned invocation channel (§3a: the result file's directory, the
  KnowledgeDelta file's directory, the artifact directory, the memory
  directory) gets an `--add-dir` too, regardless of `filesystem`, so a
  read-only step can still leave its result, its proposal and its declared
  artifacts. Each write channel also gets an `Edit(//<dir>/**)` rule in
  `--allowedTools`: `--add-dir` alone admits the directory but still leaves
  each edit to a permission prompt, which a headless run under the default
  permission mode refuses. The one case Claude Code cannot honour is a channel that sits
  _under_ a root the read-only `Edit(//root/**)` rule denies (a working
  directory that is the operator's home, say): that is decided from the
  paths alone and reported per channel (`"Claude Code read-only denies edits
under <root>, which contains the result file (ARGUS_RESULT_FILE)"`).
- `settingSources` → `--setting-sources user,project,local` (only the ones
  named).
- `permissionMode` → `--permission-mode <mode>`.
- `maxTurns` → `--max-turns <n>`.
- Argus's own Stop/PreToolUse hooks (registered when the phase declares a
  capability profile at all, or the pipeline names its own Claude config
  folder — §3b) are written to `<invocationDir>/settings.json` and passed as
  `--settings <path>`:

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

#### Rule paths, as probed

A rule path is absolute when it starts with `//`, and Claude Code matches it
against one spelling only. `toClaudeRulePath` produces that spelling from the
path's own shape, never from the host: `/work/repo` stays as it is, and
`C:\work\repo` becomes `/c/work/repo`. The rule is then `Edit(//c/work/repo/**)`.
Earlier releases wrote the path as given — `Edit(//C:\work\repo/**)` on
Windows, `Edit(///work/repo/**)` on POSIX — and the Windows form matched
nothing, so a read-only phase on Windows could write its repository.

Probed with Claude Code 2.1.295 on Windows 11, a Haiku session asked to write
one file in a working directory `wt` or a channel directory `chan`:

| Flags                                                                     | Write    | Notes                                                       |
| ------------------------------------------------------------------------- | -------- | ----------------------------------------------------------- |
| `acceptEdits`, deny `Edit(//C:\…\wt/**)`                                  | **made** | The raw Windows path never matches: the old gap.            |
| `acceptEdits`, deny `Edit(//c/…/wt/**)`                                   | refused  |                                                             |
| `acceptEdits`, deny `Edit(//C/…/wt/**)`                                   | refused  | The drive letter's case does not matter.                    |
| `acceptEdits`, deny `Edit(//c/users/OPERATOR/…/WT/**)`                    | refused  | Nor does any other segment's: Windows rules match any case. |
| `acceptEdits`, deny `Edit(//c/Users/OPERAT~1/…/wt/**)`                    | **made** | An 8.3 short name never matches the long one.               |
| `default`, `--add-dir chan`, allow `Edit(//c/…/chan/**)`                  | made     |                                                             |
| `default`, `--add-dir chan`, no allow                                     | refused  | Why every write channel now carries its own allow.          |
| no `--permission-mode` (operator's `defaultMode: auto`), `--add-dir chan` | made     | The auto classifier approved it.                            |
| no `--permission-mode` (`auto`), deny `Edit(//c/…/wt/**)`                 | refused  | A deny rule holds under the classifier.                     |
| `acceptEdits`, deny `Bash`, PowerShell `Set-Content` into `wt`            | refused  | PowerShell's path check applied the `Edit` deny.            |
| `acceptEdits`, deny `Bash`, PowerShell `[IO.File]::WriteAllText` in `wt`  | refused  | Refused as "invokes .NET methods", a parser heuristic.      |
| `auto`, deny `Bash`, PowerShell `[IO.File]::WriteAllText` in `wt`         | refused  | The classifier refused it.                                  |
| `acceptEdits`, deny `Bash,PowerShell`                                     | refused  | The tool is not offered at all.                             |

PowerShell did not write in any probed mode, but each refusal depended on how
the tool parsed the command text, or on the classifier — a command it cannot
parse names no path for a rule to match — and `bypassPermissions` was not
probed. That is the same footing Bash is on with
an `Edit` deny, which is why read-only denies both shells outright.

Two consequences. Argus never writes an 8.3 short name itself — its own
directories come from the home directory, which Windows reports in the long
form — but an author who writes `cwd` as `C:\Users\OPERAT~1\…` gets a deny
rule that matches nothing; write the long form. And parallel probes showed
that concurrent `claude` sessions can read `~/.claude.json` mid-write and
report it corrupted; the file itself was intact, but a fan-out runs exactly
that way.

### How Codex maps a profile (`buildCodexCapabilities` in `runtimes/codex.ts`)

- `filesystem` → `--sandbox` (`read-only` / `workspace-write` /
  `danger-full-access` for `"unrestricted"`).
- `additionalDirectories` (plus every Argus-owned write channel — §3a — when
  the **effective** sandbox is `workspace-write`) → `-c
sandbox_workspace_write.writable_roots=[...]`. "Effective" means the
  profile's own `filesystem`, else `ARGUS_CODEX_SANDBOX`, else
  `workspace-write` — the same resolution order that decides which sandbox the
  process actually runs under, so a channel is writable whenever the run is,
  whether that came from the profile or the operator's own default. Under an
  effective `read-only` sandbox Codex has no way to admit a write at all, so
  every write channel is reported unavailable (`"Codex read-only sandbox
prevents writing the result file (ARGUS_RESULT_FILE)"`, one per channel);
  `danger-full-access` needs nothing. Reads are allowed under every sandbox.
- `mcpServers` → one `-c mcp_servers.<name>.<field>=<value>` per field
  (`type`, `command`, `args`, `env.*`, `url`, `headers.*`), TOML-quoted. `env`
  and `headers` keys are restricted to `[A-Za-z_][A-Za-z0-9_-]*` at validation
  time (same as the record-shape check every runtime's spec goes through) —
  Codex receives them unquoted inside the `-c` override.

### Limitations, per runtime

| Runtime         | What it cannot do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | Bash stays a bare shell under `read-only` unless `tools.allow` scopes it to specific commands — Claude Code has no OS-level sandbox, only tool permission rules.                                                                                                                                                                                                                                                                                                                                                    |
| **Codex**       | `mcpServers` narrows nothing: there is no flag scoping a run to _only_ the declared servers, so whatever is in `config.toml` stays reachable alongside them (`"Codex cannot exclude MCP servers configured in config.toml"`). A `read-only` **effective** sandbox (declared, or inherited from `ARGUS_CODEX_SANDBOX` when the profile leaves `filesystem` unset) cannot write any Argus-owned channel — result file, KnowledgeDelta file, artifact or memory directory — each reported as its own limitation (§3a). |
| **OpenCode**    | Enforces **none** of `CapabilityProfile`'s keys — every key a profile sets becomes its own limitation string (`"OpenCode cannot enforce \"filesystem\" for this invocation"`, one per key present).                                                                                                                                                                                                                                                                                                                 |
| **Qwen Code**   | Same as OpenCode: zero keys supported, every declared key becomes a limitation.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

`unsupportedCapabilities()` (in `runtimes/types.ts`) is what produces those
strings — it is handed each runtime's list of keys it _can_ map (empty for
OpenCode and Qwen), and reports every key the profile sets that isn't on that
list. `env` and `enforcement` are never in that list for any runtime: they
are engine-owned (§4), never a runtime's to enforce or report on. Whether a
runtime can reach Argus's _own_ files is a separate question with its own
per-channel answer — §3a.

### `enforcement: "strict" | "best-effort"`

Default is `"strict"`. When a resolved profile has any limitation — a key the
runtime cannot enforce, or a **required** invocation channel (§3a) the
runtime cannot reach — and enforcement is strict, the step **does not
launch**: it fails immediately under the `configuration` class (never
retried; see §2), and the invocation record still shows what Argus would have
run. An _optional_ channel the runtime cannot reach is recorded as a
limitation but never refuses a launch. `"best-effort"` records the same
limitations but launches anyway: useful for a phase whose declared profile is
aspirational (e.g. "prefer read-only" on a runtime that can't do it) rather
than a hard requirement.

### 3a. Argus-owned invocation channels

Beyond the working tree, Argus hands every agent process a small set of files
and directories that _it_ owns — the protocol between the agent and Argus.
Each is named to the agent by one environment variable, lives outside the
repository (under `~/.claude/argus/`), and must stay reachable whatever
`filesystem` says about the rest of the disk: a read-only researcher still
writes its report, its decision and its proposal there.

| Channel                 | Env var                              | Direction     | Required access | Launch depends on it when…                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------ | ------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Result file             | `ARGUS_RESULT_FILE`                  | agent → Argus | write           | the step publishes the phase's `result` (always required then: the routing reads it). `results/<runId>/result.json` — a directory per run, so granting it admits this run's result only                                                                                                                                                   |
| KnowledgeDelta file     | `ARGUS_KNOWLEDGE_DELTA_FILE`         | agent → Argus | write           | the phase declares `knowledgeDelta: "required"`. Offered to every run; emitting a delta stays optional either way (KNOWLEDGE-LEDGER.md §12.5)                                                                                                                                                                                             |
| Artifact directory      | `ARGUS_ARTIFACT_DIR`                 | agent → Argus | write when used | the phase declares an `artifact` check. Offered to every run                                                                                                                                                                                                                                                                              |
| Memory directory        | `ARGUS_MEMORY_DIR`                   | agent ↔ Argus | write           | `memory.enabled` is set (every step's prompt then asks the agent to append to `NOTES.md`)                                                                                                                                                                                                                                                 |
| KnowledgeContext        | `ARGUS_KNOWLEDGE_CONTEXT_FILE`       | Argus → agent | **read**        | the step (or its phase) declares a `knowledgeContext` — always required then: the step was authored to reason from it. `invocations/<runId>/knowledge-context.json`, per run, `0444`; the agent never writes it, and Argus re-hashes it before accepting the completion (KNOWLEDGE-LEDGER.md §13, §13.11)                                 |
| Rule verification       | `ARGUS_RULE_VERIFICATION_FILE`       | agent → Argus | write           | the phase declares `ruleVerification` — always required then: the conformance report _is_ the phase's output, not an optional proposal. `rule-verifications/<runId>/verification.json`, a directory per run (KNOWLEDGE-LEDGER.md §15.6)                                                                                                   |
| Change request          | `ARGUS_CHANGE_REQUEST_FILE`          | Argus → agent | **read**        | the phase declares `changeIntent` — always required then: it is the phase's input. The requested change verbatim plus, per accountable rule, its support and its current implementation conformance. `invocations/<runId>/change-request.json`, per run, `0444` (KNOWLEDGE-LEDGER.md §16.4)                                               |
| Change proposal         | `ARGUS_CHANGE_PROPOSAL_FILE`         | agent → Argus | write           | the phase declares `changeIntent` — always required then: the proposal _is_ the phase's output. `change-proposals/<runId>/proposal.json`, a directory per run (KNOWLEDGE-LEDGER.md §16.5)                                                                                                                                                 |
| Change context          | `ARGUS_CHANGE_CONTEXT_FILE`          | Argus → agent | **read**        | the phase declares `changeContext` — always required then: the step was authored to implement that accepted intent. The approved proposal as exact canonical refs, never restated statements. `invocations/<runId>/change-context.json`, per run, `0444`; re-hashed before the completion is accepted (KNOWLEDGE-LEDGER.md §16.11, §17.8) |
| Implementation scope    | `ARGUS_IMPLEMENTATION_SCOPE_FILE`    | Argus → agent | **read**        | the phase declares `implementation` — always required then: the run was authored to realize that scope. Where the ledger says the change lives, with a closed reason code per target. `invocations/<runId>/implementation-scope.json`, per run, `0444`, re-hashed at completion (KNOWLEDGE-LEDGER.md §17.5)                               |
| Remediation context     | `ARGUS_REMEDIATION_CONTEXT_FILE`     | Argus → agent | **read**        | the attempt is a remediation (2..n) — always required then. The exact rules and criteria the previous attempt left unmet, from Argus's own accepted results rather than the previous agent's transcript. `invocations/<runId>/remediation-context.json`, per run, `0444`, re-hashed at completion (KNOWLEDGE-LEDGER.md §17.10)            |
| Acceptance verification | `ARGUS_ACCEPTANCE_VERIFICATION_FILE` | agent → Argus | write           | the phase declares `acceptanceVerification` — always required then: the criterion outcomes _are_ the phase's output. `acceptance-verifications/<runId>/acceptance.json`, a directory per run (KNOWLEDGE-LEDGER.md §17.7)                                                                                                                  |
| Revision notes          | `ARGUS_REVISION_NOTES_FILE`          | Argus → agent | **read**        | never required. Offered only when the phase's revise notes did not all fit the prompt (§13, _Revision notes_): every note in full, oldest first. `invocations/<runId>/notes/revision-notes.md`, in a folder of its own so the read rule covers nothing else                                                                               |

The model (`harness/channels.ts`, `InvocationChannel` in `runtimes/types.ts`):
`prepareInvocation` builds **one** list of channels — kind, env var, path, the
directory access must be granted on, `read`/`write`, and whether the launch
depends on it — and hands the whole list to the runtime inside the
`CapabilityRequest`. The runtime maps every entry through the one mechanism it
has (`--add-dir`, `writable_roots`, or nothing because it runs no sandbox) and
answers for every entry with a `ChannelOutcome`: `granted`, or `unavailable`
with a reason. A channel the runtime does not answer for is treated as
unavailable — a protocol path is never presumed writable. Nothing on the
runtime side is special-cased by kind: the result file, the delta file and the
artifact directory are the same thing to an adapter. The one distinction an
adapter makes is by **access**: a `read` channel (the KnowledgeContext file,
and the change-context, implementation-scope and remediation-context files)
must be reachable and, where the runtime can express it, must _not_ be made
writable — Claude Code adds an `Edit(//<dir>/**)` deny rule beside the
`--add-dir`; Codex never lists it in `writable_roots`; OpenCode and Qwen Code
run unsandboxed and can express neither, which is the same limitation their
profiles already carry.

What an `unavailable` verdict means is the engine's decision, from `required`
and `enforcement`:

|                  | `enforcement: "strict"` (default)                                  | `enforcement: "best-effort"`  |
| ---------------- | ------------------------------------------------------------------ | ----------------------------- |
| required channel | **refused before launch** — `configuration` failure, never retried | launches; limitation recorded |
| optional channel | launches; limitation recorded                                      | launches; limitation recorded |

"Recorded" means the reason is in the invocation record's `limitations` _and_
in its `channels` array (§8), status `unavailable`. There is no silent case:
an agent is never told "you may write here" without the record saying whether
it actually could. The variable is still set and the system-prompt contract
still describes the protocol — the record, not the prompt, is where the
mismatch is stated.

**Without a capability profile** nothing changes from before profiles
existed: Argus does not shape the runtime's filesystem at all, the CLI's own
defaults decide, and the record lists the channels offered with status
`unmanaged` — no claim either way. A pipeline that uses no structured result,
no KnowledgeDelta and no file artifacts, with or without a profile, launches
exactly as it always did.

For a run with a capability profile, every channel's path also travels in the
run's own prompt, after Argus's other instructions and before any revision
notes or retry note (`channelInstruction` in `engine/prompts.ts`, appended by
`launchStep` once the paths are known). A read-only profile denies the shell,
and with it the only way an agent could read its environment. A run without a
profile keeps its shell and its prompt exactly as before, and the system prompt
stays the same for every run.

**Runtime matrix** (pinned by `runtimes/channels.test.ts`):

| Runtime         | Effective filesystem mode                                          | Result file · KnowledgeDelta · artifact dir · memory dir (write)                                               | Read channels                                                                                             |
| --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Claude Code** | any                                                                | ✅ `--add-dir` + `Edit(//<dir>/**)` allowed on each channel's directory (a path no rule can name → limitation) | ✅ `--add-dir` + `Edit(//<dir>/**)` denied: readable, not editable (a path no rule can name → limitation) |
| **Claude Code** | `read-only`, channel _under_ `cwd`/`additionalDirectories`         | ❌ the `Edit(//root/**)` deny rule covers it; reported from the paths                                          | ✅ readable; the root's own deny rule already covers it                                                   |
| **Codex**       | `workspace-write` (declared, or the `ARGUS_CODEX_SANDBOX` default) | ✅ named in `sandbox_workspace_write.writable_roots`                                                           | ✅ reads are unrestricted; never listed in `writable_roots`, so the sandbox refuses writes                |
| **Codex**       | `unrestricted` / `danger-full-access`                              | ✅ nothing to add                                                                                              | ✅ (no sandbox: writes cannot be prevented)                                                               |
| **Codex**       | `read-only` (declared, or via `ARGUS_CODEX_SANDBOX`)               | ❌ no way to admit a write; one limitation per channel                                                         | ✅ readable; the sandbox refuses every write                                                              |
| **OpenCode**    | any (the profile's `filesystem` is itself unenforceable)           | ✅ `opencode run --auto` runs unsandboxed; nothing stands in the way                                           | ✅ readable (writes cannot be prevented — the profile is unenforceable regardless)                        |
| **Qwen Code**   | any, no `--sandbox` in `ARGUS_QWEN_ARGS`                           | ✅ `--approval-mode yolo` runs unsandboxed                                                                     | ✅ readable (writes cannot be prevented — as above)                                                       |
| **Qwen Code**   | `--sandbox` / `-s` in `ARGUS_QWEN_ARGS`                            | ❌ the container mounts the project and the CLI's home, not Argus's data directory                             | ❌ unavailable; the channel is required, so a strict launch is refused                                    |

Where a runtime cannot prevent a write to the context file, the file's `0444`
mode guards against an accidental overwrite and the invocation record's
`knowledgeContext.sha256` remains the proof of what Argus supplied — an agent
that rewrote its own context changed a file, not the record. Without a
capability profile the read channel is `unmanaged` like every other: the CLI
reads it exactly as it would any file.

Two consequences worth stating plainly. A `filesystem: "read-only"` profile
on **Codex** with a structured result (or `knowledgeDelta: "required"`, or an
`artifact` check) is a configuration error under strict enforcement — the
agent would be asked for a file its sandbox refuses; declare
`workspace-write` (the channels are the only writable roots outside the tree)
or `best-effort`. And the same profile on **OpenCode** or **Qwen Code** is
refused for a different reason — the profile itself cannot be enforced — while
the channels would have been reachable; under `best-effort` such a run
launches unrestricted and its channels are granted.

### 3b. A Claude setup folder per pipeline (`claudeConfigDir`)

Every Claude Code step runs `claude -p` on the operator's machine, signed in as
the operator, and by default the CLI loads the operator's whole personal setup
from `~/.claude`: `CLAUDE.md`, the settings (hooks, permission grants,
`defaultMode`), skills, agents and commands, user-scope MCP servers and
auto-memory. A pipeline's agents then follow rules written for interactive
work, and neither can be set up without touching the other.

`claudeConfigDir` on the **pipeline** names a folder its Claude steps load
instead, through `CLAUDE_CONFIG_DIR`. For the CLI that folder replaces
`~/.claude` completely, so nothing has to be subtracted:

| In the folder                     | Role                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                       | The pipeline's own instructions, loaded as the "global" CLAUDE.md by every agent and subagent. |
| `settings.json`                   | Sign-in token, attribution, auto-memory, permissions and hooks for this pipeline only.         |
| `skills/`, `agents/`, `commands/` | The pipeline's own, where it needs any.                                                        |
| `projects/`                       | Written by the CLI: the session logs of every run, subagents' included.                        |

The repository's own `CLAUDE.md` files, their `@` imports and its `.claude/`
content still load on top, exactly as for anyone who opens the repository.

**Signing the folder in.** A new folder starts signed out. `claude setup-token`
creates a long-lived token for the operator's subscription account, and the
folder's own `settings.json` sets it:

```json
{
  "env": { "CLAUDE_CODE_OAUTH_TOKEN": "<token>" },
  "attribution": { "commit": "", "pr": "" },
  "autoMemoryEnabled": false
}
```

Never as a user-wide environment variable: `CLAUDE_CODE_OAUTH_TOKEN` overrides
the stored login everywhere, the operator's interactive sessions included. Nor
in Argus's own environment, where every agent that inherits it would switch to
it. (`--bare` loads nothing implicitly, but signs in with an API key only, so
it is no option for a subscription account.)

**What Argus does with it**, for every Claude Code step of the pipeline, with or
without a capability profile:

- The child environment gets `CLAUDE_CONFIG_DIR=<folder>`. The field belongs to
  the pipeline, not to a profile, so a phase that declares its own `env` can no
  longer drop it the way it drops a pipeline's `env.set` (profiles merge by
  top-level key, §3).
- `--disallowedTools` gets `Read(//<folder>/settings.json)`,
  `Read(//<folder>/.credentials.json)` and `Edit(//<folder>/**)`, spelled as in
  _Rule paths_ above and joined into the same single flag as the profile's own
  rules. An agent can neither read the sign-in nor rewrite the setup every
  later run loads. The CLI's own writes there (session logs, its state) are not
  tool calls and are unaffected. As under `read-only`, a shell the profile
  leaves open could still print the file: deny `Bash` or scope it.
- The per-run `<invocationDir>/settings.json` (`--settings`) carries Argus's
  Stop/PreToolUse hooks even when the phase declares no profile, because the
  copy Setup installs lives in the operator's home, which the folder replaces:
  without its own registration the run would never signal. It also carries
  `claudeMdExcludes` naming the operator's `~/.claude/CLAUDE.md`. CLAUDE.md
  discovery walks every parent directory of the working directory and reads
  `<parent>/.claude/CLAUDE.md` too, past the git root, and Argus's worktrees
  live under `~/.claude-argus/worktrees/`, inside the home folder, so without
  the exclusion every step would still load the operator's file as a "project"
  one. Claude Code merges array settings across layers, so the exclusion adds
  to whatever the folder's own `settings.json` excludes.
- The run record (`Run.claudeConfigDir`) and the invocation record
  (`AgentInvocationRecord.claudeConfigDir`) name the folder.

A step on another runtime keeps its own home. Its invocation record says
`"Codex does not load a Claude config folder: claudeConfigDir does not apply to
this step"` (or the OpenCode or Qwen Code equivalent), and that is never a
reason to refuse the launch.

**Validation**, at save time: an absolute path to an existing directory that a
permission rule can name (no comma or newline, not a UNC share), stored
resolved. It is refused when it is or contains the operator's Claude home,
when it contains Argus's work root (the `Edit` deny would cover every worktree
and channel), when a phase's `cwd` or an `additionalDirectories` entry sits
inside it, and when any level of the definition also sets
`capabilities.env.set.CLAUDE_CONFIG_DIR` (`env.set` lands last in the child
environment, so the two would silently disagree). Changing it while an
instance runs is an execution edit: `409` without `?force=1`. A patch with
`claudeConfigDir: null` puts the pipeline back on the operator's setup.

**Transcripts.** The CLI files a folder run's session log under
`<folder>/projects/<project>/`. Argus finds it through the folder the run
recorded, never through the current definition, so an edited or deleted
pipeline keeps its history for as long as its runs are kept: the session list
and view, the live tail, the Flight Recorder, search and the projects list
scan the operator's own `projects/` and each recorded folder's
(`sources/transcriptRoots.ts`), and the session watcher widens to a new folder
within 15 s of its first run. Once a run is pruned, its transcript stays in
the folder but no longer shows in Argus.

**Scope.** Pipelines only. Schedules, Launch-tab runs and analysis passes keep
the operator's own setup.

**What has been probed** (Claude Code 2.1.304 on Windows 11, set up by hand
through `env.set`): the CLI signs in with the folder's token; the folder's
`CLAUDE.md`, the repository's and its `@` imports reach a subagent; the
folder's own `claudeMdExcludes` keeps the parent-walk file out; the `Read` deny
holds; session logs land in `<folder>/projects/`. Not probed yet: the
exclusion arriving through the per-run `--settings` layer instead, and a full
pipeline instance on the field.

### Configuration precedence

Three layers govern what an invocation can actually do, and this feature
narrows only the third:

| Layer                                                                                                | Owns                                                                                                                                | After this change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GLOBAL USER CONFIG** (`~/.claude/settings.json`, `~/.claude.json`, `~/.codex/config.toml`, …)      | The operator's own hooks, permission grants, and **user-scope MCP servers** (`~/.claude.json`, added via `claude mcp add -s user`). | Still loaded by default. `settingSources` can drop `~/.claude/settings.json` from the invocation (naming only `project`/`local`) — but `~/.claude.json`'s user-scope MCP servers are a **separate file `settingSources` does not touch**; the _only_ way to exclude them is `mcpServers` under `strict-mcp-config`, which replaces the whole MCP server set for that invocation. Declaring no `mcpServers` at all leaves them reachable. A pipeline's own `claudeConfigDir` replaces this whole layer for its Claude steps (§3b). |
| **REPOSITORY CONFIG** (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json` in `cwd`) | Project-level hooks, permissions and MCP servers.                                                                                   | Loaded whenever `settingSources` includes `"project"`/`"local"` (the default). A declared `mcpServers` still overrides these via `--strict-mcp-config`.                                                                                                                                                                                                                                                                                                                                                                           |
| **ARGUS INVOCATION CONFIG** (`~/.claude/argus/invocations/<runId>/{settings,mcp}.json`)              | This one invocation's Stop/PreToolUse hooks, and (when declared) its exact MCP server set.                                          | New. Written fresh per invocation, never reused across attempts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Credentials are never Argus's concern at any layer: the CLI authenticates
itself exactly as it does outside Argus (its own login, its own
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` if the environment policy passes it
through). Argus holds no API keys of its own and never materializes one into
a config file. A pipeline's own config folder (§3b) signs in with the token its
own `settings.json` carries, which the operator put there; Argus never reads
or writes that file, and denies its agents `Read` on it.

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
  identifiers) — except that it may not name a reserved name (below).

**Always stripped, under every policy, non-overridable even by an explicit
`allow` or `set`:**

- Argus's own secrets: `ARGUS_TOKEN` (the admin bearer token) and
  `ARGUS_WEBHOOK_URL`.
- Per-invocation identifiers, which must come only from this invocation's own
  freshly-computed values, never be inherited from Argus's own process (which
  would let a nested Argus child impersonate or interfere with the run that
  spawned it): `ARGUS_SIGNAL_TOKEN`, `ARGUS_SIGNAL_URL`, `ARGUS_RESULT_FILE`,
  `ARGUS_ARTIFACT_DIR`, `ARGUS_INSTANCE_ID`, `ARGUS_PHASE_ID`,
  `ARGUS_PHASE_ATTEMPT`, `ARGUS_RUN_ID`, `ARGUS_STEP_NAME`, `ARGUS_WORKSPACE`,
  `ARGUS_RUNTIME` (the hook keys its Stop-payload handling off this one, so a
  value inherited from a different invocation would misparse the signal),
  `ARGUS_MEMORY_DIR`, `ARGUS_KNOWLEDGE_DELTA_FILE`,
  `ARGUS_KNOWLEDGE_CONTEXT_FILE`, `ARGUS_RULE_VERIFICATION_FILE`,
  `ARGUS_CHANGE_REQUEST_FILE`, `ARGUS_CHANGE_PROPOSAL_FILE`,
  `ARGUS_CHANGE_CONTEXT_FILE`, `ARGUS_REVISION_NOTES_FILE` and
  `ARGUS_TRIGGER_PAYLOAD_FILE` (`ARGUS_PER_INVOCATION_IDENTIFIERS` in
  `harness/childEnv.ts`). A pipeline that names one in `env.set` is refused when
  it is saved.

The engine builds a `command` check's environment the same way: the phase's
`inherit`, `allow` and `deny`, then the check's own identity as a layer, then
the phase's `set` (§6, "What a command check is told").

The invocation record never stores a variable's _value_ — only names
(`envNames`, sorted; `envStripped`, sorted). Reconstructing what Argus ran
never means reconstructing a secret.

## 5. Artifacts

Every phase attempt gets its own directory for file artifacts, distinct from
the payload artifacts `produces`/`{{artifacts.<name>}}` already carry (see
API.md § Weave).

A phase's `id` is more than a label: it names that directory, and the
`changed-files` baseline file below, so it is validated at save time as one
path segment — `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`, 1-80 chars, never `.` or
`..`. `safeSegment()` (`harness/invocation.ts`) sanitizes both the instance id
and the phase id again at every directory join — any character outside
`[A-Za-z0-9._-]` becomes `_`, and a segment that would resolve to "here" or
"up" becomes a literal `_._`/`_.._` — a second line of defense should
validation ever be bypassed, not a substitute for it.

The directory itself:

- `ARGUS_ARTIFACT_DIR` — set on every step's environment, and on the phase's
  `command` checks (§6), pointing at
  `~/.claude-argus/artifacts/<instanceId>/<phaseId>/`. Argus creates the
  directory, hands it to the runtime as an invocation channel (§3a — admitted
  to the sandbox no matter what `filesystem` says elsewhere, or reported
  unavailable when the runtime cannot; **required** exactly when the phase
  declares an `artifact` check), and passes it to `checks` of kind `artifact`
  as their search root.
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
  `~/.claude-argus/artifacts/<instanceId>/` (and the instance's working-tree
  baselines and trigger-payload copy, in
  `~/.claude/argus/invocations/<instanceId>/`) together with the instance
  record once it falls outside the per-pipeline retention window
  (`INSTANCE_KEEP`). Invocation records, by contrast, are pruned per _run_ —
  with `pruneRuns`'s retention window, because they are keyed by `runId` — so
  the two can fall out of retention on different schedules. A spawned child
  (§20) is kept past the window while its parent's record exists, or cannot be
  read right now: only a parent record that is provably gone releases it.
  Kept children still count toward the window.

File artifacts are the counterpart of `produces`/`PhaseResult` payload
artifacts: a payload is a small validated JSON value pasted into a later
prompt; a file artifact is a path a later step reads for itself (a diff, a
report, an investigation write-up too large to interpolate as text).

## 6. Verification checks

`PhaseCheck` (in `@argus/contracts`) is Argus's own evidence that a phase's
declared work actually happened — run once every step of the phase has
reported success (or been recovered as successful — §2), never before, and
never derived from the agent's own words.

| Kind            | Fields                                                                                                                        | Limit / semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`       | `run` (string, ≤4000 chars), `label?`, `cwd?` (resolved against the phase's `cwd`), `timeoutSeconds?` (1–86400; default 600s) | Runs through the shell in `cwd`; exit `0` passes. Combined stdout+stderr is capped at 16 KiB in memory, and only the last 4000 chars survive into the `CheckResult.output`. Runs under the phase's own resolved `EnvPolicy` (pipeline → phase capabilities — the same merge the phase's steps ran under), not Argus's full environment, with the work's identity (see "What a command check is told" below). `run` is never interpolated. At the deadline, POSIX: SIGTERM to the process group, then SIGKILL to the group after a grace period (`killGraceMs`, default 5s), sent even if the leader has already exited; Windows: `taskkill /T /F` on the command's tree (forceful — there is no graceful step), repeated after the grace only while the root shell is still alive. After a further grace, if a descendant still holds the output pipes, Argus releases its end of them and fails the check ("process did not exit") — a command that traps signals or leaves a grandchild behind can never hang verification. See §17. |
| `artifact`      | `path` (relative, no `..`, no absolute), `label?`, `minBytes?` (≥0, default 1)                                                | Resolved against the phase's `ARGUS_ARTIFACT_DIR`. Uses `lstat`, so it does not follow a symlink: fails if the phase has no artifact directory, the path escapes it, the file is missing, **is a symbolic link**, or it's smaller than `minBytes` — a symlink to some large file elsewhere is never mistaken for the artifact the phase was asked to produce.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `file`          | same fields as `artifact`                                                                                                     | Resolved against the phase's own `cwd` instead of the artifact directory — for a file the agent was supposed to leave in the working tree itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `changed-files` | `label?`, `allow?` (globs), `deny?` (globs), `requireChanges?` (boolean)                                                      | See below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `trajectory`    | `label?`, `thresholds` (signal → maximum count, 0 to 10,000), `requireTranscript?` (boolean)                                  | Deterministic signals over the relevant runs' transcripts; may report `not-evaluated`. See §19.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

A phase may declare up to 50 checks (`MAX_CHECKS`); they all run, one at a
time in the order listed, always — verification never stops at the first
failure, because the full report is the evidence a failed phase leaves behind.

A check's `status` is `passed` or `failed`; only a `trajectory` check can also
report `not-evaluated` (§19). The report's status is `failed` if and only if some
check failed, so a `not-evaluated` check neither fails the report nor counts as
passed.

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
Argus snapshots the working tree (`git status --porcelain=v1 -z
--untracked-files=all`) at the _start_ of the attempt, before any step
launches, and writes it beside the invocation records
(`~/.claude/argus/invocations/<instanceId>/<phaseId>.<attempt>.baseline.json`
— keyed by instance, unlike the per-run invocation directories). Each dirty
path's identity is **content-only**: the SHA-256 of its bytes, or
`size:<bytes>:<mtimeMs>` for a file over 8 MiB (`MAX_HASH_BYTES`) or a
symlink — too large or too risky to hash — or `deleted`. **Staging a file
(`git add`) is deliberately not part of it**: only the bytes (or the file's
presence) change identity, so an agent that stages without editing is not
credited with a change, and one that edits after staging still is.

At verification time Argus snapshots again and reports every path whose
identity differs between the two snapshots — added, modified, deleted, or
newly dirty. **A file that was already dirty before the phase started and
comes out with an identical hash is not "changed"** — only a path whose
baseline/current identity actually differs counts, so a phase run against an
already-dirty tree isn't credited (or blamed) for pre-existing changes it
never touched.

**A retry is measured from the start of its retry chain.** Each attempt still
records its own baseline, but an automatic retry is the same intended work, so
when it reuses the tree an earlier attempt changed (`workspace.scope:
"instance"`, or no workspace) its check is measured from the baseline of the
chain's first attempt (`PhaseProgress.baselineAttempt`). A retry that only
re-runs what the first attempt already committed — say, after a test
environment outage — passes `requireChanges` instead of failing with "no files
changed". An attempt in a tree of its own (`scope: "attempt"`, cut fresh from
the base) keeps its own baseline, so commits that landed on the base in between
are never credited as work. A revise or a remediation asks for new work: it
clears `baselineAttempt` and is measured from its own baseline.

**Commits the agent made are included, not just the working tree.** A commit
leaves a clean tree, which the working-tree diff alone can't see — so
whenever `HEAD` moved between the baseline and the current snapshot, Argus
additionally runs `git diff --name-only <baseline-head> <current-head>` (or,
when the attempt started with no commits at all, `git ls-tree -r --name-only
<current-head>` over the full tree) and folds those paths into the changed
set too. If that diff can't be computed, the check **fails closed** — it
would rather report "cannot be evaluated" than silently ignore commits the
agent made.

`requireChanges: true` fails a phase that changed nothing at all. A dirty
working tree with more than 5000 entries (`MAX_SNAPSHOT_ENTRIES`) is recorded
as `truncated` at snapshot time instead of silently cut off, and a
`changed-files` check against a truncated baseline or current snapshot fails
outright ("the working tree has more than 5000 dirty paths; changed-files
cannot be evaluated") rather than pass on a set it never fully saw.

**Glob semantics.** `allow`/`deny` globs are matched against each changed
path with Node's own `path.matchesGlob`, after normalizing to forward slashes
(so the check behaves the same on Windows and POSIX). A changed path failing
every `allow` glob (when any are set), or matching any `deny` glob, is
"offending"; any offending path fails the check.

### What a command check is told

A `command` check runs with the identity of the work it judges, so a script
can find the instance, its folder, its tree and the task it was started for
without deriving them from a path (`commandInputLayer` in
`harness/childEnv.ts`, applied in `engine/verification.ts`):

| Variable                     | Value                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ARGUS_INSTANCE_ID`          | The instance.                                                                                                       |
| `ARGUS_PHASE_ID`             | The phase.                                                                                                          |
| `ARGUS_PHASE_ATTEMPT`        | The phase attempt the checks judge, counted from 0. Every candidate of an attempt sees the same attempt.            |
| `ARGUS_ARTIFACT_DIR`         | The artifact directory the checks read (§5); a candidate's own `c<i>` folder for a candidate's checks (§12).        |
| `ARGUS_WORKSPACE`            | The worktree the work happened in (§11); a candidate's own tree for a candidate's checks. Unset when there is none. |
| `ARGUS_TRIGGER_PAYLOAD_FILE` | A JSON copy of the instance's `triggerPayload`. Unset when the instance has none (absent or `null`).                |

`ARGUS_WORKSPACE` names the worktree, not the check's `cwd`: a phase without a
worktree runs its checks in its own `cwd`, and they get no `ARGUS_WORKSPACE`,
exactly like its steps.

- **The payload file.** The copy is
  `~/.claude/argus/invocations/<instanceId>/trigger-payload.json`, beside the
  instance's working-tree baselines and outside the worktree and the artifact
  folder (`ensureTriggerPayloadFile` in `sources/instances.ts`). It is written
  before each verification run of a phase that declares a `command` check (a
  candidate's checks are a run of their own) and before every approval poll
  (§2), whether or not the polled phase declares one, and only when its bytes
  differ from the payload's, so a copy that was edited or deleted is put back
  before the next run or poll — after a restart too, because the checks of an
  interrupted verification run again. Nothing puts it back during a run: a
  check that runs repository code, such as `npm test`, gets the variable and
  can change the copy for the checks listed after it, and for any other phase
  or candidate of the instance verifying or polling at the same time, since
  they share the one copy. List a check that judges the work against the
  payload before any check that runs repository code. The copy is pruned with
  the instance (§5). A payload is set by a webhook start (the request body),
  by a chained start (`{ sourceInstanceId, sourcePipelineId, status }`) and by
  a spawned start (its `SpawnTriggerPayload`,
  `{ task, key, base?, include?, parent }`, §20); a manual or scheduled start
  has none.
- **A file, not a variable.** A webhook body can be 64 KiB, and a Windows
  environment value is capped at 32,767 characters. A copy, never the instance
  record: the record also holds the definition snapshot and its `hookToken`.
- **Reserved names.** All six are per-invocation identifiers (§4): never
  inherited from Argus's own environment, and kept under `inherit: "minimal"`
  and any `deny`, because Argus adds them after the policy's `inherit`, `allow`
  and `deny` filters. `env.set` is applied after them, so a pipeline that names
  one there is refused when it is saved. A pipeline that named
  `ARGUS_PHASE_ATTEMPT` or `ARGUS_TRIGGER_PAYLOAD_FILE` in `env.set` before
  they were reserved keeps its own value until it is next saved, and an
  instance started before then keeps it for its whole run.
- **Agent steps.** A step gets the same identity variables,
  `ARGUS_PHASE_ATTEMPT` included, but not `ARGUS_TRIGGER_PAYLOAD_FILE`: a
  prompt reads the payload through `{{trigger.payload}}` (§13).
- **`run` is never interpolated.** A webhook body pasted into a shell command
  line is an injection; read the file instead. A payload value a script passes
  to a program as an argument needs the same care without a shell: one that
  starts with `-` is read as an option (`git diff "--output=<path>...HEAD"`
  writes a file), so put it after `--end-of-options` or refuse it.
- **No base ref on `changed-files`.** It compares against the attempt's
  baseline (above). To compare a branch with the commit its task started from,
  use a `command` check, such as
  `git rev-list --count --end-of-options <base>..HEAD` or
  `git diff --name-only --end-of-options <base>...HEAD` with the base read from
  the payload file.

The [pipelines guide](guides/pipelines.md#check-work-against-the-task-it-was-started-for)
has a worked task-scope check.

An approval poll ([Approval conditions](#approval-conditions), §2) runs through
the same command runner and is told the same six variables.

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
- **Only a step confirmed still running is stamped.** Both `expireStep` and
  the plain `failStep` it calls re-read the run and the instance under the
  instance lock before writing anything; a step whose completion signal
  already landed is left exactly as that signal decided, never overwritten as
  timed out just because its timer happened to fire around the same moment.
- **Enforcement survives a restart.** `deadlineAt` is read back off the `Run`
  record by `reconcile()`: an adopted run already past its deadline is killed
  on the very next reconcile tick, exactly as if the original timer had fired
  — the deadline is a property of the run, not of the process that happened
  to be watching it.
- **A step whose process never started at all gets a different heal.** If
  Argus stops between recording a step as `running` and actually starting its
  process, there is no `deadlineAt` to enforce — nothing will ever kill a
  process that doesn't exist. `reconcile()`'s heal pass instead recognizes the
  step directly (no run record yet, or one with `pid: null` and status
  `running`, and not a run this process itself is mid-launch of) and fails it
  under the `spawn` class with a `spawn-failed` run record and the reason
  "Argus stopped before the step's process was started" — retryable by
  default, since nothing about the step's own work was ever at fault.

```json
{
  "id": "run_8f2a",
  "deadlineAt": "2026-09-10T14:15:00.000Z",
  "termination": "timed-out",
  "error": "timed out after 900s"
}
```

### Stalls: a step can be alive and say nothing forever

`timeoutSeconds` is sized for the worst case a phase should ever take —
generous, because a hard kill at half that would fail runs that were simply
working. That leaves a gap a hard timeout can't close: a process wedged on a
hung tool call, spinning without producing output, or stuck in a loop, well
inside its timeout budget. Stuck-detection is close to universal in the
harnesses the research survey looked at (OpenHands, Symphony;
docs/HARNESS-RESEARCH.md §2 #7), and Argus already had the raw material — the
run tailer's own notion of when a run last said anything.

`stallSeconds` (`PhaseDef.stallSeconds` / `PhaseStep.stallSeconds`, narrowest
wins like `timeoutSeconds`; absent = off; minimum 30 — anything shorter is
indistinguishable from an ordinary gap between tool calls) kills a step whose
transcript has gone quiet that long, even while its process is alive:

- **No second timer system.** Stall detection is checked on the existing
  reconcile tick (`server/src/harness/stall.ts`'s `isStalled`, a pure
  function; the engine's `reconcile()` calls it), not a new
  per-step `setTimeout`. Practically this means a stall is noticed within one
  tick of crossing `stallSeconds`, not at the exact instant. An instance
  paused at a gate is watched too: a sibling waiting for a decision leaves
  this step's phase running.
- **The reference clock is the run's own `lastActivityAt`**, refreshed from
  the run tailer's latest observed activity each tick and **persisted** on the
  `Run` record — so a restart does not misjudge a stall from a stale
  in-memory clock; a run with no observed activity yet falls back to its
  `startedAt`.
- A stalled step is killed exactly like a timed-out one — SIGTERM, then
  SIGKILL after `killGraceMs` — but records `run.termination = "stalled"` (not
  `"timed-out"`) and a `step.stalled` journal entry (not `step.timed-out`),
  with the reason `"stalled: no output for Ns"`. The phase fails under the
  `timeout` failure class (§2) — a stall is a timeout that noticed sooner, and
  `retry.retryOn: ["timeout"]` opts into retrying either.
- Only a step confirmed still `running`, with no `termination` already
  recorded, is ever stamped — the same non-overwrite discipline `expireStep`
  uses for a hard timeout.

```json
{
  "id": "run_9a1c",
  "stallSeconds": 120,
  "lastActivityAt": "2026-09-10T14:12:03.000Z",
  "termination": "stalled",
  "error": "stalled: no output for 120s"
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
  "capabilities": {
    "filesystem": "workspace-write",
    "maxTurns": 40,
    "mcpServers": { "docs": { "command": "docs-mcp", "env": { "DOCS_TOKEN": "<redacted>" } } }
  },
  "limitations": [],
  "materializedFiles": ["/home/user/.claude/argus/invocations/run_8f2a/settings.json"],
  "artifactDir": "/home/user/.claude-argus/artifacts/inst_71c0/implement",
  "resultFile": null,
  "knowledgeDeltaFile": "/home/user/.claude-argus/knowledge-deltas/run_8f2a/delta.json",
  "knowledgeContextFile": "/home/user/.claude/argus/invocations/run_8f2a/knowledge-context.json",
  "knowledgeContext": {
    "schemaVersion": 1,
    "claims": [
      { "id": "RULE-17", "revision": 2 },
      { "id": "CONSTRAINT-4", "revision": 1 }
    ],
    "sha256": "3b7c9e…"
  },
  "channels": [
    {
      "kind": "knowledge-delta",
      "envVar": "ARGUS_KNOWLEDGE_DELTA_FILE",
      "path": "/home/user/.claude-argus/knowledge-deltas/run_8f2a/delta.json",
      "access": "write",
      "required": false,
      "status": "granted"
    },
    {
      "kind": "knowledge-context",
      "envVar": "ARGUS_KNOWLEDGE_CONTEXT_FILE",
      "path": "/home/user/.claude/argus/invocations/run_8f2a/knowledge-context.json",
      "access": "read",
      "required": true,
      "status": "granted"
    },
    {
      "kind": "artifact-dir",
      "envVar": "ARGUS_ARTIFACT_DIR",
      "path": "/home/user/.claude-argus/artifacts/inst_71c0/implement",
      "access": "write",
      "required": false,
      "status": "granted"
    }
  ],
  "timeoutSeconds": 1800,
  "deadlineAt": "2026-09-10T14:32:00.000Z",
  "gitHead": "3f1a9c2e8b0d4f6a7c1e2b3d4f5a6b7c8d9e0f10",
  "startedAt": "2026-09-10T14:02:00.000Z"
}
```

Values of environment variables never appear in `envNames`/`envStripped` —
only names. Within `capabilities`, the same rule applies to every value that
could hold a secret: `env.set`'s values and each MCP server's `env`/`headers`
values are replaced with `"<redacted>"` — keys are kept (so the record still
shows _that_ `DOCS_TOKEN` was set, just not to what), and every other
`CapabilityProfile` key (`filesystem`, `tools`, `mcpServers`'s `command`/
`args`/`url`, `additionalDirectories`, …) is written verbatim, since none of
those can carry a secret. The materialized `mcp.json` a runtime actually reads
still carries the real values — an agent needs them to work — this record
just isn't where they get archived. `limitations` is what the chosen runtime
could not enforce of the declared profile, plus every Argus-owned channel it
could not reach (§3a); empty means every declared key was honoured and every
channel is reachable (or no profile was declared at all). `channels` lists
each channel the invocation was offered — its env var, path, access, whether
the launch depended on it, and `granted` / `unavailable` (with the reason) /
`unmanaged` (no profile: the CLI's defaults decided). `claudeConfigDir` names
the pipeline's own Claude config folder the CLI loaded (§3b), absent when the
step ran on the operator's setup or on another runtime. `knowledgeContextFile`
and `knowledgeContext` (Phase 4) say exactly which claim revisions Argus
supplied to the run and the SHA-256 of the file as written — `null` when the
step declared no `knowledgeContext`, absent on older records. They are the
authoritative "supplied" provenance
(`GET /api/knowledge/executions/:runId/context`, KNOWLEDGE-LEDGER.md §13.6).

**Journal kinds** (`server/src/sources/journal.ts`, append-only, per
instance) that this feature adds:

| Kind                           | When                                                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step.timed-out`               | A step's process was killed at its `deadlineAt` (live, or discovered on reconcile after a restart).                                                                                                                                         |
| `step.stalled`                 | A step's process was killed for going quiet longer than its `stallSeconds` while still alive (§7).                                                                                                                                          |
| `step.exit-mismatch`           | A step's completion signal was accepted as `completed`, and its process then exited non-zero. The phase is not unwound — the signal already decided — but the run carries both `outcome: "succeeded"` and the non-zero `exitCode`. See §10. |
| `phase.launch-recovered`       | A phase attempt was `running` with no run planned — a crash fell between the transition and the launch — and `reconcile` launched it (§18).                                                                                                 |
| `step.termination-redelivered` | A run's recorded stop request was still outstanding with its process alive after a restart, and was delivered again under its original reason (§18).                                                                                        |
| `step.orphan-stopped`          | A still-alive run whose step was already decided, and that this process had not stopped, was stopped on recovery (§18).                                                                                                                     |
| `phase.verifying`              | Every step of a phase reported success and Argus started running its `checks`.                                                                                                                                                              |
| `phase.verified`               | The checks finished — `passed`, or `failed` naming which checks and why.                                                                                                                                                                    |
| `memory.trimmed`               | A settled instance's pipeline had `memory` enabled and `NOTES.md` had grown past `maxBytes`; Argus trimmed its head back down to the cap (§13).                                                                                             |
| `knowledge.supplied`           | A step's KnowledgeContext was materialized and recorded, immediately before the spawn; the detail names the exact refs and the first 12 hex of the file's sha256 (KNOWLEDGE-LEDGER.md §13).                                                 |

**`Run.termination`** (`@argus/contracts`) records _how_ a run ended when
Argus knows more than the exit code: `"exited"` (its own doing), `"timed-out"`
(killed at its deadline), `"stalled"` (killed for going quiet longer than
`stallSeconds` while still alive — §7), `"killed"`
(aborted/cancelled/superseded by Argus for some other reason), `"spawn-failed"`
(never started at all — covers both the `spawn` and `configuration` failure
classes, since neither ever produced a process). Absent means the process
simply exited on its own.

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
      // Best-of-N (§12): two drafts of the same step, one on each CLI, and the
      // checks below decide. Requires the attempt-scoped worktree declared here
      // and the single step the phase already had.
      "workspace": { "scope": "attempt" },
      "candidates": {
        "count": 2,
        "select": "first-verified",
        "variants": [{ "runtime": "claude" }, { "runtime": "codex" }],
      },
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
  back in the prompt (`retryNote`). With `candidates`, a retry re-runs the
  whole set — so the two attempts here are two _rounds_ of two drafts, and the
  phase only fails when neither round produced a draft that typechecks and
  touched the right files.
- `implement` is the phase worth spending on, so it is the one with
  `candidates`: two drafts, one per CLI, `first-verified` so the loser is
  killed the moment the winner's checks pass. It needs
  `workspace: { scope: "attempt" }` — declared on the phase here rather than
  pipeline-wide, because the read-only phases have nothing to isolate. Note
  that `review` reads `{{artifactDir.implement}}/summary.md`: that resolves to
  the phase's directory, and the winning draft's files are one level down in
  `c0/` or `c1/` (§12) — a phase that must hand files on from a candidate
  should write them into the working tree and commit, which is the branch the
  worktree exists to produce.
- Only `implement` and `verify` need `workspace-write`; `plan`'s `maxTurns`
  caps a phase that should be a short structured answer, not an open-ended
  session.

## 10. Known limitations / non-goals

- **No OS-level sandbox for Claude Code.** `filesystem: "read-only"` is tool
  permission rules, not a kernel-enforced boundary — a scoped `Bash` rule the
  agent can talk its way around (e.g. a command that itself writes files) is
  not caught by anything here. Codex's sandbox is the one runtime with a real
  OS-level boundary.
- **Shells under read-only, generally.** Even where Argus denies bare `Bash`
  and `PowerShell`, any `tools.allow` entry scoping specific commands
  necessarily trusts that those commands don't write — Argus does not parse or
  sandbox the command line itself.
- **8.3 short names in rule paths.** A deny rule built from a Windows short
  name (`C:\Users\OPERAT~1\…`) never matches the long path the agent writes
  to (§3, _Rule paths_). Argus's own directories are always long; a `cwd` or
  `additionalDirectories` entry must be authored in the long form too.
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
- **A completion signal can be right about the phase and wrong about the exit
  code, and Argus does not undo the phase over it.** If a step's Stop hook (or
  the reconcile fallback) reports `completed` and the process then exits
  non-zero — a hook that fires before the CLI's own cleanup fails, for
  instance — the phase has already advanced on the signal, and downstream work
  may already be running against it; Argus does not unwind that decision,
  because the signal is what a later step or a person already saw. The
  contradiction is not hidden, though: the run carries both
  `outcome: "succeeded"` and the non-zero `exitCode`, and the journal gets a
  `step.exit-mismatch` entry naming the phase and run, for anyone reconciling
  the two by hand.
- **The end-to-end suites are POSIX-only.** `harness/e2e.test.ts`,
  `verificationE2e.test.ts`, `changeIntentE2e.test.ts` and
  `realizationE2e.test.ts` are skipped on Windows; see §17.

## 11. Workspace isolation

A phase's steps run in the phase's `cwd`. For a pipeline that reads, that is
right; for one that writes, it means every phase — and every attempt of every
phase — is editing the same checkout. Two branches of a fan-out overwrite each
other's files, a failed attempt leaves its half-done edits for the retry to
trip over, and "what did this phase actually change?" is only answerable while
nothing else is running.

A pipeline or a phase can instead declare a `WorkspacePolicy`, and Argus gives
the work a **git worktree** of its own:

```jsonc
{
  "workspace": { "scope": "instance" }, // pipeline-wide default
  "phases": [
    {
      "id": "implement",
      "cwd": "/src/app",
      "workspace": { "scope": "attempt", "base": "origin/main" }, // overrides it
    },
  ],
}
```

| Field   | Meaning                                                                                                                                                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope` | `"instance"` — one worktree per pipeline instance, shared by every phase that opts in. `"attempt"` — a fresh worktree per phase attempt. `"none"` — this phase opts _out_ of a policy it would otherwise inherit and runs in its own `cwd`, no worktree created.                                   |
| `base`  | The ref the worktree is cut from. Default: `HEAD` of the repository at the phase's `cwd`. Validated as a ref: no whitespace, no leading `-`. A spawned child's trees are cut from its `workspaceBase` (its parent's `spawn.base`, §20) instead. Argus never fetches: the child's first phase does. |
| `keep`  | Keep the directory after the instance ends. Default `false` — the directory is removed, the branch is kept.                                                                                                                                                                                        |

Narrowest wins, as everywhere else: `phase.workspace ?? pipeline.workspace`.
Absent at both levels, nothing changes — the phase runs in its own `cwd`
exactly as it did before workspaces existed — and `scope: "none"` on a phase
means the same thing for that one phase even when the pipeline (or another
phase) declares a policy: a read-only research phase in an otherwise
`workspace: { scope: "instance" }` pipeline has nothing to isolate and no
reason to pay for a worktree it will never write to.

**Names.** The directory is
`~/.claude-argus/worktrees/<instanceId>/shared` or
`.../<instanceId>/<phaseId>-attempt<N>`; the branch is
`argus/<instanceId>/shared` or `argus/<instanceId>/<phaseId>/<attempt>`. Both
segments go through the same `safeSegment` sanitizing the artifact directories
use (§5), plus git's own ref rules, so an identifier can never name a
directory outside the worktrees root or a branch git refuses.

**What runs there.** Everything about the attempt: each step's `cwd` and the
`project` its transcript is filed under, `ARGUS_WORKSPACE` in the child
environment and in the phase's `command` checks (a per-invocation identifier,
so it is never inherited from the parent — §4, §6), the `changed-files`
baseline snapshot, and the phase's `checks` — a `command` check is the
repository's own script and must see what the agent saw. The invocation record
and `PhaseProgress.workspace` both carry the `WorkspaceRecord` (`path`,
`branch`, `base`, resolved `baseHead`), and the step drawer shows the branch.

**The deliverable is the branch; uncommitted changes are discarded.** When the
instance settles — succeeded, failed or aborted — Argus runs
`git worktree remove --force` on every tree whose policy did not say `keep`,
and `pruneInstances` catches any that no settlement ever removed. The branch
is never deleted, by either path. So a phase that must hand its work on has to
**commit** it: anything left dirty in the tree goes with the directory. (One
phase asking to `keep` a shared `instance` tree keeps it for all of them — the
conservative reading, since a directory kept by mistake costs disk and one
removed by mistake costs work.)

**Failure is `configuration`.** A `cwd` that is not inside a git work tree, a
`base` that does not resolve, a directory in the way, git missing entirely —
each fails the phase before anything is spawned, under the `configuration`
class, with git's own stderr in the reason. Never retried: running it again
cannot help, because what is wrong is the definition. The journal gets
`workspace.created` and `workspace.removed` entries either side of the work.

**Restarts.** Creation is idempotent, because Argus restarts: a directory that
is already this branch's worktree is reused as it stands (uncommitted work and
all), and a branch that exists without a directory — its tree already cleaned
up — is checked out again rather than re-cut from `base`, so the first
attempt's commits come back with it. A step that is still running keeps
whatever `cwd` it was launched with; only a new attempt resolves a workspace.

**Limitations.**

- **Not a security boundary.** A worktree is a directory, not a jail. Nothing
  stops an agent from `cd`-ing out of it, and Argus's `filesystem` capability
  is still tool permission rules for every runtime but Codex, whose sandbox
  remains the only OS-level boundary here (§10).
- **Claude Code's own directory handling is unaffected.** `--add-dir` (from
  `additionalDirectories` and the artifact directory) still points where it
  pointed; a phase that hands the agent the original repository as an extra
  directory has handed it the original repository.
- **One repository per phase.** The worktree is cut from the repository at the
  phase's `cwd`; a phase working across several repositories isolates only
  that one.
- **`{{workspace}}` is not a placeholder.** The run's `cwd` _is_ the worktree,
  so a prompt does not need to name it; `ARGUS_WORKSPACE` is there for a
  script that does.
- **Nothing merges the branch.** Argus creates it and leaves it; landing the
  work is a later phase's job (a `command` check, an agent that opens a PR) or
  a human's.

## 12. Candidates

A phase runs its step once. If that run is a bad draw — the model went down a
wrong path, the test it wrote does not compile, the patch touches the wrong
file — Argus finds out at the checks and then does the only thing it can: fail
the phase, and maybe retry it, sequentially, at the same price.

A `candidates` phase runs the step **N times at once**, in N separate
worktrees, and lets the phase's own `checks` decide which draft the pipeline
keeps.

This is the single best-evidenced lever in the harness literature (see
[HARNESS-RESEARCH.md §2](HARNESS-RESEARCH.md) #1–#2). Trae Agent's SWE-bench
Verified score moved **70.6% → 75.2% from its candidate ensemble alone**, and
monotonically in N; AutoCodeRover gained **+7 points from three samples**. The
qualifier matters more than the numbers: sampling _without_ a verifier
plateaus (Large Language Monkeys), because picking by majority vote or by a
reward model is not the same as picking the one that passes. Argus has a real
verifier already — §6 — so candidates is the two halves put together.

```jsonc
{
  "id": "implement",
  "cwd": "/path/to/repo",
  "workspace": { "scope": "attempt" },
  "steps": [{ "name": "code", "prompt": "Implement {{artifacts.plan}}." }],
  "checks": [
    { "kind": "command", "run": "npm run typecheck", "label": "typecheck" },
    { "kind": "command", "run": "npm test", "label": "tests" },
  ],
  "candidates": {
    "count": 2,
    "select": "first-verified",
    "variants": [{ "runtime": "claude" }, { "runtime": "codex" }],
  },
}
```

| Field      | Meaning                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `count`    | How many independent runs of the step launch at once. Integer, 2–8.                                                                      |
| `select`   | `"first-verified"` or `"cheapest-verified"` — see below.                                                                                 |
| `variants` | Per-candidate `{ runtime?, model?, reasoningEffort? }`, **cycled** when shorter than `count`. Absent means `count` identical candidates. |

### Requirements

Both are refused with a `400` naming the reason, at authoring time — and
re-checked on the _merged_ definition after a `PATCH`, so clearing a
pipeline-wide workspace under a phase that relies on it is refused too:

- **Exactly one step in the phase.** A selection replaces the phase's whole
  result with one candidate's, and "which of three steps did candidate 2 win
  with" has no answer.
- **An effective `workspace.scope: "attempt"`** (on the phase or inherited
  from the pipeline, §11). Without a worktree each, the candidates are not
  independent samples of the same task — they are N agents editing one
  checkout.

### What each candidate gets

Everything that could otherwise be shared, isn't:

| Per candidate `i`        | Value                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| worktree                 | `.../worktrees/<instanceId>/<phaseId>-attempt<N>-c<i>`, branch `argus/<instanceId>/<phaseId>/<N>-c<i>`                                                                 |
| artifact directory       | `<phaseArtifactDir>/c<i>` — also what `ARGUS_ARTIFACT_DIR` and `{{artifactDir}}` point at, for the run and for its checks                                              |
| `changed-files` baseline | `<phaseId>.<attempt>.c<i>.baseline.json`                                                                                                                               |
| verification report      | `StepProgress.verification` — the phase's `checks`, run in **that** worktree; a `command` check's `ARGUS_WORKSPACE` and `ARGUS_ARTIFACT_DIR` name that tree and folder |
| result file              | the run's own `ARGUS_RESULT_FILE`; nothing is shared, so nothing races                                                                                                 |
| knowledge delta file     | the run's own `ARGUS_KNOWLEDGE_DELTA_FILE`; a losing candidate's staged delta is superseded at selection                                                               |

The candidate index rides on the _attempt_ component of the branch
(`…/impl/0-c1`, not `…/impl/0/c1`) because git's ref namespace is a
filesystem: `argus/i/impl/0` and `argus/i/impl/0/c1` cannot both exist, and a
phase that gained candidates between attempts would start failing on the
collision.

The prompts are identical apart from what the variant changes and the
artifact directory, which is per candidate by necessity.

Variant overrides resolve narrowest-first like everything else:
`variant → step → phase → pipeline → server default`.

### Selection

**`first-verified`** — the first candidate whose checks pass wins. Its
siblings are killed at once (`termination: "killed"`, `error: "superseded by
candidate k"`, SIGTERM then SIGKILL after the grace period, exactly the
existing kill path), their steps go to `aborted`, and their worktrees are
removed. This is the cheap mode: you stop paying for the drafts you are not
going to use.

**`cheapest-verified`** — every candidate runs to its own checks. Among the
verified ones the lowest `costUsd` wins; ties break on the shortest duration,
then on the lowest index. A candidate whose run reported no cost sorts **last**:
an unknown price is not a cheap one. This is the mode for "I want the best
value", and it costs N runs by construction.

When a winner is chosen, its payload, its declared `result`, its verification
report and its worktree become the **phase's** — so `{{previous.payload}}`,
`produces` and a route condition downstream see one draft, never a mixture.
The phase then concludes exactly as any other: a gated phase opens its gate
**after** selection, on the winner, and a revise re-runs the whole set as a new
attempt.

A candidate that fails before verification — spawn, exit-code, signal, timeout,
an invocation Argus refused to make, or an agent that signalled `needs-input`
(a draft has nowhere to take a question) — simply **loses**. The phase fails
only when no candidate can still win, and then once, with every draft's fate in
the reason:

```
no candidate passed its checks — c0 (claude opus): verification failed: tests (exit 1);
c1 (codex): timed out after 3600s
```

The phase's failure class is the class every candidate shared, if they shared
one; otherwise `verification` if any candidate reached the checks; otherwise
`exit-code`. The phase's `retry` policy then applies as usual, and a retry
re-runs the whole set.

`PhaseProgress` records `selectedCandidate` and a `candidateOutcomes` entry per
draft (status, verified, cost, duration, runtime, model, and why it lost) — the
losers' processes are gone, and this is what remains to explain the choice.

### Cost

Candidate runs are ordinary runs: they appear in the Ledger, count against the
budget, and cost what they cost. `count: 3` is up to three times the phase's
spend — `first-verified` recovers part of that by killing the losers, and
`cheapest-verified` recovers none of it by design. Nothing here is free; what
the evidence says is that it is often worth it.

Each candidate also takes a **concurrency slot**. `count` is bounded by the
server's global cap (`maxConcurrent`), and candidates past the cap queue for a
slot like any other step — a `count: 8` phase on a 4-slot server runs four,
then four. The deadline clock starts at spawn, so queueing never eats a
candidate's timeout budget (§7).

### Restarts

Everything a selection needs is on disk, and the decision is a pure function of
it (`selectCandidate` in `pipelineTransitions.ts`). So:

- a candidate whose checks were running when Argus stopped is verified again,
  keyed by attempt **and** candidate, so a duplicate report is a no-op;
- a candidate whose process died without signalling is healed into a loss by
  the ordinary reconcile path;
- a restart that lands between the last report and the selection it implied
  simply asks the question again, and gets the same answer.

### Limitations

- **One step per phase.** Enforced, for the reason above. A multi-step phase
  that wants best-of-N splits the step it wants sampled into its own phase.
- **No Verdict-based selection.** Selection is by deterministic `checks` only.
  Judging the drafts with a rubric (the Verdict watcher already scores runs) is
  the natural next selector and is deliberately not built yet: the evidence is
  specifically that selection _without execution_ plateaus, so an
  execution-gated selector had to come first.
- **No cross-candidate merging.** The winner is taken whole. Argus never
  combines two drafts, and nothing merges the winning branch — landing the work
  is still a later phase's job or a human's (§11).
- **Losing worktrees go, losing branches stay.** A loser's directory is removed
  as soon as it loses (or when the phase gives up), unless `workspace.keep` is
  set. Its branch survives, so `git checkout argus/<instance>/<phase>/<n>-c<i>`
  still shows what that draft committed — but anything it left _uncommitted_ is
  gone with the directory, exactly as in §11.
- **`needs-input` from a candidate is a loss**, not a pause. The gate of a
  candidates phase belongs to its winner.

## 13. Context and memory

Four pieces of evidence point the same direction (docs/HARNESS-RESEARCH.md
§2 #4–#7, §4): a retry that carries the failing output back is the
best-evidenced repair loop there is; where in the prompt something sits (and
how much of it) matters, and an over-long context hurts; state that survives
past one session is how long-horizon work gets anywhere; and stuck-detection
is close to universal in the harnesses that get this right. This section is
the four of them.

### Placeholders

| Placeholder                 | Value                                                                                                                                   | Capped |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `{{previous.payload}}`      | The phase's dependency's payload (the last one, in declaration order, if several).                                                      | yes    |
| `{{artifacts.<name>}}`      | A `produces`-published phase payload, by name.                                                                                          | yes    |
| `{{artifactDir}}`           | This phase's own file-artifact directory.                                                                                               | no     |
| `{{artifactDir.<phaseId>}}` | An earlier phase's file-artifact directory.                                                                                             | no     |
| `{{trigger.payload}}`       | The instance's firing payload (`PipelineInstance.triggerPayload`), JSON-stringified.                                                    | yes    |
| `{{memory}}`                | This pipeline's `NOTES.md`, tail-capped to its own `memory.maxBytes` — empty when `memory` is disabled or nothing has been written yet. | yes    |
| `{{previous.instance}}`     | A one-paragraph summary of the most recent _settled_ instance of this pipeline, before this one — empty when there is none.             | yes    |

An unknown placeholder (of any kind) interpolates to empty, same as it always
has — a template marker reaching the model is worse than a gap, because the
model tries to make sense of it.

**Every capped value is bounded**, by default 16 KiB
(`DEFAULT_PLACEHOLDER_BYTES`), overridable per pipeline via
`contextLimits.placeholderBytes` (1 KiB–256 KiB):

```jsonc
{ "contextLimits": { "placeholderBytes": 32768 } }
```

Over the cap, `capPlaceholder()` (`server/src/sources/dag.ts`) keeps the head
(2/3 of the budget) and the tail (1/3), joined by a one-line marker:

```
[… Argus trimmed 41214 bytes of {{artifacts.plan}} — the full value is at
/home/user/.claude/argus/invocations/run_8f2a/context/artifacts.plan.txt …]
```

The trimming is UTF-8 safe — it backs off over continuation bytes so it never
splits a multi-byte character — and the full, untrimmed value is written to
that path (under the run's own invocation directory) so the agent can read the
whole thing if the head and tail aren't enough. `interpolate()` itself stays
pure: it returns which files to write (`InterpolateResult.contextFiles`), and
the engine writes them alongside the run's other materialized files.
`{{artifactDir}}`/`{{artifactDir.<phaseId>}}` are paths, not values that could
run long, so they are never capped.

**Placement.** A step's prompt is the agent's own words, first. Everything
Argus injects rides _after_ it, in a fixed order, short: the result
instruction (§ pipelineEngine.ts `resultInstruction`), the artifact
instruction (`artifactInstruction`), the memory instruction (below), then
the channel paths (§3a), the phase's revision notes (§ Revision notes, below),
and last — because recency is what a model weighs most, and a retry note is
the part most worth remembering — the retry note (§ Retry feedback, below). None
of this reorders the `OUTCOME_CONTRACT` system-prompt mechanism (§1), which is
a pure constant carried separately so the prompt cache prefix holds across
every run.

### Pipeline memory

Externalised state is how work that spans more than one instance survives at
all — Anthropic's own long-running-harness pattern is exactly this: a durable
place outside any one session's context that the next session reads first.
Argus's version is `memory`, off by default:

```jsonc
{ "memory": { "enabled": true, "maxBytes": 8192 } }
```

| Field      | Meaning                                                                              |
| ---------- | ------------------------------------------------------------------------------------ |
| `enabled`  | Required. `false` (or the field absent) is the same as before this existed.          |
| `maxBytes` | Cap on `NOTES.md`'s size. Default 8 KiB (8192). Range 1 KiB (1024) – 64 KiB (65536). |

The file lives at `~/.claude-argus/memory/<pipelineId>/NOTES.md`
(`harness/memory.ts`'s `memoryNotesPath`) — **never created until `enabled` is
true, and never deleted by Argus**: deleting the pipeline leaves the file
behind (the same conservative default as a losing candidate's branch, §12).
When enabled:

- `ARGUS_MEMORY_DIR` is set on every step's environment (a per-invocation
  identifier — never inherited by a nested Argus child, §4) pointing at the
  directory (not the file), and handed to the runtime as a **required**
  invocation channel (§3a) like the artifact directory: `--add-dir` for
  Claude Code, `sandbox_workspace_write.writable_roots` for Codex under an
  effective `workspace-write` sandbox (a `read-only` one reports "Codex
  read-only sandbox prevents writing the memory directory
  (ARGUS_MEMORY_DIR)", and refuses the launch under strict enforcement).
  OpenCode and Qwen Code run unsandboxed, so the directory is reachable
  without any flag.
- `{{memory}}` interpolates the tail of `NOTES.md`, capped to `maxBytes` (and
  then to `contextLimits.placeholderBytes` on top, same as any other
  placeholder — the smaller of the two governs in practice).
- Every step's prompt gets a fixed instruction appended:

  > Durable notes for this pipeline live at $ARGUS_MEMORY_DIR/NOTES.md. Append
  > what a future run of this pipeline must know (decisions, gotchas, what was
  > tried); keep it under N bytes — Argus trims the head beyond that.

- **After each instance settles** (succeeded, failed or aborted — the same
  moment worktree cleanup runs, §11), Argus checks `NOTES.md`'s size and, if
  it exceeds `maxBytes`, trims its head back down to the cap on a line
  boundary (`trimMemoryIfNeeded`, keeping the newest content), journaling
  `memory.trimmed`. A file within the cap, or one that was never written,
  costs one read and nothing else.

`{{previous.instance}}` (above) is not gated on `memory.enabled` — it costs
one instance listing Argus already has to read, and says nothing a pipeline
needs to opt into. `summarizeInstance()` (`harness/memory.ts`, pure) is what
builds it: status, when it ended, which phase failed and why in one line, and
which candidate won, if any —

```
Previous run failed (ended 2026-09-19T14:02:11.000Z); phase "implement"
failed: verification failed: typecheck (exit 1).
```

### Retry feedback

`retryNote()` (`server/src/pipelineEngine.ts`) now hands the next attempt
something to repair against for **every** retryable class, not only
`"verification"`/`"signal"` as before — each bounded, the whole note capped at
~2 KiB, and headed `Previous attempt (n of m) failed — <class>:`, appended
last in the prompt (above):

| Class          | What the note carries                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verification` | Each failed check by name, with the tail (~600 chars) of its own output — read straight off the failed attempt's `VerificationReport`, still on the phase until the retry overwrites it. |
| `exit-code`    | The exit code, plus a tail (~800 chars) of the failed run's own `error`/`resultSummary` text.                                                                                            |
| `timeout`      | The reason already computed where the failure was recorded: `"timed out after Ns"` or, for a stall, `"stalled: no output for Ns"`.                                                       |
| `spawn`        | The spawn error, in one line.                                                                                                                                                            |
| `signal`       | Unchanged: the agent's own reported reason.                                                                                                                                              |
| `unverified`   | The refusal reason: for a missing or conflicting marker, what was found and that a single `ARGUS_OUTCOME` marker is required; for a stop-hook disagreement, the two readings.            |

`configuration` failures are never retried (§2) and so never get a note.

### Revision notes

A revise note is a person's correction, and a phase can be revised more than
once. Every attempt after a revise is told **every** note its phase received in
this instance, oldest first — not only the latest:

```
Revision notes, oldest first:
- After attempt 0: <the first note>
- After attempt 1: <the second note>
```

- **Where they come from.** `startPhase` reads them once per attempt from the
  durable gate-decisions record (`revisionHistory` in `engine/outcome.ts`):
  decisions of kind `revise`, with a note, about this phase, and linked to the
  instance (`gateDecisionIds`). A decision recorded but never linked did not
  take effect and is left out. Reading the record rather than carrying the
  note forward is what keeps it on every launch path: a second revise, a
  retry or remediation after a revise, and a launch recovered after a restart
  (§18) all carry the same notes.
- **Clipping and the bound.** A note is clipped to 2,000 characters when it is
  submitted, and the record, the pending operation and every prompt carry the
  same text. The block is bounded at 8,000 characters: past it, the oldest
  note stays (it usually frames the rest), then as many of the newest as fit,
  and a marker names `ARGUS_REVISION_NOTES_FILE`, an optional read channel
  (§3a) holding every note in full.
- **Placement.** After the channel paths and before the retry note, which stays
  last (§ Placement, above).
- An attempt already running when Argus is upgraded keeps the prompt it was
  launched with.

### Stalls

See §7 — stall detection is a timeout mechanism, documented there beside the
rest of timeout enforcement.

### `WorkspacePolicy.scope: "none"`

See §11 — a phase can opt out of a pipeline-wide isolation policy and run in
its own `cwd`, no worktree created.

## 14. Business-rule discovery phases

A phase that declares `discovery` asks its agents to read a bounded repository
scope and propose the business rules it appears to enforce, as a
KnowledgeDelta. The semantics — candidate versus canonical, the evidence
invariant, the review surface, the handoff to later phases — are
KNOWLEDGE-LEDGER.md §14. This section is the harness side: what the agent is
told, and what Argus checks before anything it says is staged.

```jsonc
{
  "id": "discover-rules",
  "gated": true,
  "discovery": {
    "scope": { "paths": ["src/Booking"], "label": "Kobra booking" },
    "evidence": "required", // default; "warn" makes a rule without evidence a review warning
  },
  "steps": [{ "name": "investigate", "prompt": "Investigate the booking module." }],
}
```

**What the agent is told.** One reusable instruction block is appended after
the author's own prompt, in the same position as the result and artifact
instructions (§5). It carries the fixed discovery contract — what counts as a
business rule, what is only an implementation observation, that evidence is
mandatory, that uncertainty goes in an explicit `assumption` claim, that an
existing rule is revised rather than duplicated — plus this phase's scope. The
author writes _what question to answer_; Argus writes _what the protocol is_.
The delta's own shape stays in the system-prompt `KNOWLEDGE_DELTA_CONTRACT`
(§3a), so the model never gets two versions of it to reconcile.

**What Argus checks, deterministically.** At intake, and again at the commit
boundary:

| Check                                                                     | On failure        |
| ------------------------------------------------------------------------- | ----------------- |
| every proposed `business-rule` has supporting evidence in the same delta  | `knowledge-delta` |
| a `business-rule` revision brings _fresh_ evidence for its new statement  | `knowledge-delta` |
| every `source-code` path is repository-relative and inside `scope.paths`  | `knowledge-delta` |
| every `source-code` path resolves to a file that exists in the run's tree | `knowledge-delta` |
| a supplied `gitHead` matches the commit on the run's invocation record    | `knowledge-delta` |

`evidence: "warn"` downgrades the first two to review warnings and nothing
else. A run with no recorded git head leaves an agent-supplied commit
_unverifiable_ rather than wrong: Argus refuses what it can disprove, never
what it merely cannot confirm.

**The scope is a semantic bound, not a sandbox.** It constrains what the agent
is asked to investigate and what its evidence may point at; it does not stop
the process reading anything. The capability profile (§3) remains the security
boundary, and a discovery phase is usually `filesystem: "read-only"` with a
narrow `tools.allow` for exactly that reason.

**The gate.** A discovery phase is normally `gated: true`. Its review carries
`knowledge` — one candidate preview per step that staged a delta on this
attempt, with the proposed rules, the evidence under each, what a revision
would replace, and the deterministic warnings — and `discovery`, the counts.
A reviewer decides from that; the agent's transcript is not required reading.
Revise supersedes the attempt's candidates and nothing becomes canonical;
approve commits them through the ordinary §2 ladder.

**Downstream.** A later phase receives what an accepted discovery phase
committed by naming it:

```jsonc
{
  "knowledgeContext": {
    "fromPhases": [{ "phaseId": "discover-rules", "kinds": ["business-rule"] }],
  },
}
```

resolved from the ledger's applied-delta provenance, so a phase still waiting
at its gate supplies nothing (KNOWLEDGE-LEDGER.md §14.10). The named phase
must be a transitive `needs` dependency — checked when the pipeline is saved.

## 15. Business-rule verification phases

A phase that declares `ruleVerification` answers a different question from a
discovery phase (§14). Discovery asks _what rules does this code appear to
encode?_; verification asks _does this code do what these exact rules say?_ —
and the two must never contaminate each other (KNOWLEDGE-LEDGER.md §15.1).

```jsonc
{
  "id": "verify-rules",
  "gated": true,
  "knowledgeContext": {
    "fromPhases": [{ "phaseId": "discover-rules", "kinds": ["business-rule"] }],
  },
  "ruleVerification": {
    "holds": "deterministic-check", // default "agent-evidence"
    // "kinds": ["business-rule"],  // which supplied kinds need an outcome
    // "note": "Conformance means the booking pipeline enforces it."
  },
  "checks": [{ "kind": "command", "run": "dotnet test", "label": "comment-length-tests" }],
  "steps": [{ "name": "verify", "prompt": "Check the implementation." }],
}
```

**Which rules.** Exactly the ones the phase's (or step's) `knowledgeContext`
supplied — there is deliberately no second selection mechanism. Every one of
them must get an outcome, and nothing else may.

**What the agent is told.** One reusable instruction block after the author's
own prompt, in the same position as the result, artifact and discovery
instructions (§5): the three outcomes and what each means, the evidence kinds,
that `unverifiable` is a respectable answer with a reason rather than something
to round up to `holds`, that completeness is enforced — and, explicitly, that
finding the code in breach is **not** a reason to doubt the rule. The block
names the exact refs the run is accountable for, which no static prompt could
(they may have been minted by an earlier phase's commit minutes earlier).

**What it writes.** One JSON document to `ARGUS_RULE_VERIFICATION_FILE` (§3a):

```json
{
  "schemaVersion": 1,
  "verifications": [
    {
      "rule": "RULE-42:v1",
      "outcome": "violated",
      "evidence": [
        { "type": "check", "label": "comment-length-tests" },
        {
          "type": "source-code",
          "path": "src/Booking/KobraCommentValidator.cs",
          "startLine": 3,
          "endLine": 6
        }
      ],
      "note": "MaxLength is 500"
    }
  ]
}
```

**What Argus checks, deterministically.** At intake, and again at the commit
boundary:

| Check                                                                         | On failure          |
| ----------------------------------------------------------------------------- | ------------------- |
| every supplied rule receives exactly one outcome (a missing rule, or no file) | `rule-verification` |
| no rule the run was not supplied appears at all                               | `rule-verification` |
| `rule` names an exact revision (`ID:vN`) that the ledger holds                | `rule-verification` |
| `holds`/`violated` cite ≥1 evidence record; `unverifiable` gives a reason     | `rule-verification` |
| a cited `check` label is one this phase declares                              | `rule-verification` |
| a cited `check` appears in the phase's own `VerificationReport` at commit     | `rule-verification` |
| under `holds: "deterministic-check"`, a `holds` cites a check that **passed** | `rule-verification` |
| every `source-code` path is a real file inside the run's repository           | `rule-verification` |
| a supplied `gitHead` matches the commit on the run's invocation record        | `rule-verification` |
| the run's KnowledgeDelta (if any) does not **oppose** a rule it was verifying | `knowledge-delta`   |

The agent names a check; **Argus** binds `status`, `exitCode` and `detail` from
the report of the checks it ran itself. Any `status` the document asserts is
stripped at validation, so no proposal can claim a test passed.

**The gate.** Normally `gated: true`. The review carries `ruleVerifications` —
one preview per step that wrote a report, grouped into Holds / Violated /
Unverifiable, each row showing the exact `ClaimRef`, the rule's statement, the
rule's **own support**, the outcome and the concise evidence — and
`ruleVerification`, the counts. Nothing is durable until the phase is accepted;
a revise, a retry or an abort supersedes the attempt's proposal. The commit is
one ledger transition with the attempt's KnowledgeDeltas: ten rules land
together or none does.

**What is recorded.** One append-only `RuleVerification` per rule, bound to the
exact revision and to the commit Argus recorded for the run. Nothing about the
rule's support changes, ever — that is the point of the phase existing
separately (KNOWLEDGE-LEDGER.md §15).

## 16. Change-intent phases

A phase that declares `changeIntent` answers a third question again. Discovery
asks _what rules does this code appear to encode?_; verification asks _does the
code do what these rules say?_; change intent asks _we want the business to
work differently — what does that mean?_ (KNOWLEDGE-LEDGER.md §16).

```jsonc
{
  "id": "change-intent",
  "gated": true, // REQUIRED — saving an ungated one is a 400
  "knowledgeContext": {
    "claims": [
      { "id": "RULE-42", "revision": "active" },
      { "id": "CONSTRAINT-8", "revision": "active" },
    ],
  },
  "changeIntent": {
    "request": {
      "id": "CR-1",
      "summary": "Kobra now supports 500-character customer comments.",
      "details": "Confirmed with the integration team.",
      "scope": { "label": "Kobra comments", "paths": ["src/Booking"] },
    },
    // "kinds": ["business-rule"],       // which supplied kinds must be classified
    // "acceptanceCriteria": "required", // default; "warn" downgrades it
    // "note": "Only the Kobra adapter is in scope."
  },
  "steps": [{ "name": "reason", "prompt": "Work out what this change means." }],
}
```

**Where the request comes from.** The phase's `changeIntent.request`, or the
instance's `triggerPayload.changeRequest` when a start supplied one — the
run-specific request wins. Neither resolving is a `configuration` failure: the
step never launches, because Argus does not invent a request. Nor does it fall
back: a _malformed_ supplied request fails the phase rather than quietly
answering the pipeline's default one, which would have the run answer a
different question from the one somebody asked.

**Which rules.** Exactly the business rules the phase's (or step's)
`knowledgeContext` supplied, narrowed by `kinds`. No second selection
mechanism, for the same reason a verification phase has none.

**What the run is given.** Three channels (§3a), and they stay apart:

- `ARGUS_KNOWLEDGE_CONTEXT_FILE` — what the domain currently **says**;
- `ARGUS_CHANGE_REQUEST_FILE` — the requested change verbatim, plus each
  accountable rule's support **and** its current implementation conformance,
  scoped to the phase's repository revision;
- `ARGUS_CHANGE_PROPOSAL_FILE` — where the answer goes.

Current implementation state is context, never intent: a rule is revised
because the request said the business changed, and a code path that already
disagrees with a rule is reported as a defect rather than treated as a
requirement.

**What it writes.** One JSON document, and **not** a KnowledgeDelta file:

```json
{
  "schemaVersion": 1,
  "semanticDelta": {
    "schemaVersion": 1,
    "revisions": [
      {
        "claimId": "RULE-42",
        "expectedRevision": 1,
        "statement": "Kobra customer comments must not exceed 500 characters.",
        "localId": "r42"
      }
    ],
    "claims": [
      {
        "localId": "d1",
        "kind": "decision",
        "statement": "The 500-character limit applies only when BookingEngine == Kobra."
      }
    ],
    "justifications": [
      { "conclusion": { "local": "d1" }, "premises": [{ "local": "r42" }, "CONSTRAINT-8:v1"] }
    ]
  },
  "preserved": ["CONSTRAINT-8:v1"],
  "classification": [{ "rule": "RULE-42:v1", "disposition": "revised" }],
  "acceptanceCriteria": [
    {
      "id": "AC-1",
      "statement": "A Kobra comment of 500 characters is accepted.",
      "kind": "behavior",
      "relatesTo": [{ "local": "r42" }]
    },
    {
      "id": "AC-2",
      "statement": "A Kobra comment of 501 characters is rejected.",
      "kind": "behavior",
      "relatesTo": [{ "local": "r42" }]
    }
  ],
  "unresolved": []
}
```

`semanticDelta` is an ordinary KnowledgeDelta and is the **only** path to
canonical: it is staged as that run's delta and commits through the Phase 3
boundary. Everything beside it is change material — what stays, how success is
judged, what is unknown — and is persisted as change provenance rather than as
claims.

**What Argus checks, deterministically.** At intake, and again at the commit
boundary:

| Check                                                                                      | On failure        |
| ------------------------------------------------------------------------------------------ | ----------------- |
| the run wrote a proposal at all                                                            | `change-proposal` |
| no separate `ARGUS_KNOWLEDGE_DELTA_FILE` beside it                                         | `change-proposal` |
| every supplied rule is classified revised / preserved / not-relevant / unresolved          | `change-proposal` |
| the classification agrees with the semantic delta                                          | `change-proposal` |
| no claim is both `preserved` and revised                                                   | `change-proposal` |
| every acceptance criterion resolves (a declared local id, or a revision the ledger holds)  | `change-proposal` |
| every proposed business-rule change carries a criterion (`acceptanceCriteria: "required"`) | `change-proposal` |
| every local reference resolves to what the commit minted                                   | `change-proposal` |
| the delta's own rules (§KNOWLEDGE-LEDGER §12): exact refs, `expectedRevision`, no cycle    | `knowledge-delta` |

Everything that is a judgement for a person — an unresolved question, a
pre-existing defect, a request that turns out to be a no-op — is a **warning**
on the review instead.

**Readiness.** Derived, never asserted by the agent: `ready` when every selected
rule is accounted for, nothing is unresolved and every proposed business-rule
change is covered by a criterion; `needs-input` otherwise. A `needs-input`
proposal may still be approved — its semantic delta commits — but it cannot
drive an implementation (below).

**The gate.** Required. The review carries `changeProposals` — one preview per
step, showing the request, the current rules with their support **and** their
conformance, the proposed transition (through the same candidate-knowledge
machinery a discovery phase uses), what is preserved, the decisions, the
acceptance criteria, the unresolved questions and the warnings — and
`changeIntent`, the counts. Nothing is canonical until the phase is accepted,
and the commit is one ledger transition with the attempt's KnowledgeDeltas and
rule verifications: all of it lands, or none does.

**Downstream.** A later phase declares:

```jsonc
{
  "id": "implement",
  "needs": ["change-intent"],
  "knowledgeContext": { "fromPhases": [{ "phaseId": "change-intent" }] },
  "changeContext": { "fromPhase": "change-intent" }, // "requireReady": true by default
}
```

and its steps receive `ARGUS_CHANGE_CONTEXT_FILE`: the accepted proposal as
exact canonical refs — what this change introduced, what must keep behaving as
it does, the decisions, and the acceptance criteria the work will be judged by
— beside the KnowledgeContext that says what those refs mean. The selector
resolves only from the ledger's **accepted** proposals, so a proposal waiting
at a gate refuses the launch rather than leaking unapproved intent; the named
phase must be a `changeIntent` phase and a transitive `needs` dependency,
checked when the pipeline is saved.

Phase 7 stops there. Nothing implements, re-runs or re-verifies anything.

### Change realization (Phase 8)

A phase that declares `implementation` beside its `changeContext` becomes the
implementation half of a **change realization** — a durable, bounded
`implement → verify → remediate → verify` loop against one accepted change.
A later phase declaring `acceptanceVerification` is its verification half.

```jsonc
{
  "id": "implement",
  "needs": ["change-intent"],
  "knowledgeContext": { "fromPhases": [{ "phaseId": "change-intent" }] },
  "changeContext": { "fromPhase": "change-intent" },
  "implementation": { "maxAttempts": 2 },  // default 2, cap 8; 1 = no remediation
},
{
  "id": "verify",
  "needs": ["implement"],
  "knowledgeContext": { "fromPhases": [{ "phaseId": "change-intent" }] },
  "changeContext": { "fromPhase": "change-intent" },
  "ruleVerification": { "holds": "deterministic-check" },
  "acceptanceVerification": { "implementationPhase": "implement" },
  "checks": [{ "kind": "command", "run": "npm test", "label": "tests" }],
}
```

**What the implementation run receives.** Three read channels, never one blob:
its KnowledgeContext (what the domain says), its ChangeContext (the accepted
transition), and `ARGUS_IMPLEMENTATION_SCOPE_FILE` — where the ledger says the
change lives, derived from the `ImpactSet` of the superseded revisions, the
`source-code` evidence grounding the changed and preserved rules, the locations
accepted verifications cited, and the request's own paths. Every target carries
a closed reason code. A change nothing has ever implemented reports
`scope-incomplete` rather than an empty list.

**What decides completion.** Four independent dimensions, none of which is an
agent's word about its own work:

```
implementation execution succeeded   (ARGUS_OUTCOME / the phase's status)
  ∧ every mandatory PhaseCheck passed (Argus's own VerificationReport)
  ∧ every targeted rule `holds`       (RuleVerification, this attempt's runs)
  ∧ every required criterion `satisfied` (AcceptanceVerification, same runs)
  ∧ the verification examined the state the implementation produced
  ∧ the semantic target is still the domain's current intent
```

"Mandatory" means: a check whose result decides the report. Every check kind is
mandatory, except a `trajectory` check without `requireTranscript` that had no
complete recording to read. That check is reported `not-evaluated`: it neither
satisfies nor violates this conjunct, it is never listed among the passed
checks of the realization's technical result, and it cannot be cited as
knowledge evidence. An author who needs the trajectory to count towards
completion sets `requireTranscript`, which turns missing or truncated input
into a failed check.

The repository state is `gitHead` **plus** the content hash of any uncommitted
work, so two dirty trees at one commit are two different states and a
verification of one never answers for the other. A mismatch between what the
implementation produced and what the verification examined fails closed.

**What happens when it is unmet.** Argus writes a `RemediationContext` naming
the exact failing rules and criteria (with the evidence the verifier cited, and
what already holds so a fix does not undo it), re-opens the implementation
phase and resets the phases that verify it — and nothing else. Discovery and
change intent are accepted history. The loop is bounded by `maxAttempts`, and
four outcomes stop it even with attempts remaining: a `blocked` implementation,
an `unverifiable` required criterion, a superseded semantic target, and a
repository-state mismatch.

A remediation is **not** a retry: the phase's `retry` budget is untouched, and
the journal says `realization.remediation-started` rather than
`phase.retrying`. See KNOWLEDGE-LEDGER.md §17 for the full model.

## 17. Process trees and portable tests

### Ending a process tree

An agent CLI or a check's shell spawns children, and those children inherit
its stdout and stderr. Killing only the process Argus spawned leaves them
running and still holding the pipes, so the owner's `close` event never fires
and the open pipe handles keep the host process alive. That condition — a
descendant still holding an inherited pipe after the kill — was reproduced on
POSIX with a controlled fixture. On Windows Argus used to call `child.kill()`,
which ends only `cmd.exe`, so any descendant that outlived the shell would
hold the pipe in the same way; that is the diagnosis of the reported Windows
hang, made from the code and the POSIX reproduction, and not yet executed on
Windows. The platform difference now lives in one place,
`server/src/processTree.ts`.

`signalProcessTree` signals a process and its descendants:

- **Windows.** `taskkill /PID <pid> /T /F`. It is forceful whatever signal was
  asked for; there is no graceful step.
- **POSIX.** The signal goes to `-pid` (the process group) only for a child
  spawned `detached`, which leads its own group, falling back to the pid. A
  child that shares Argus's own group is signalled by pid only.

`childTreeStopper` is the ladder for a child Argus owns. It terminates the
tree, and after a grace period escalates: SIGKILL to the group on POSIX, and
on Windows `taskkill` again, but only while the root can still be walked from,
because `taskkill /T` cannot find the descendants of a root that has exited.
For the same reason, and because an exited root's pid may be reused, nothing
is sent on Windows once the root has exited — not even the first `taskkill`.
Unlike `signalProcessTree`, the ladder never falls back to the bare pid on
POSIX: once the root has exited and been reaped its pid can belong to anyone,
so the fallback is the root's own `ChildProcess` handle, and only while it is
still running. After a further grace period it releases Argus's end of the
pipes, unrefs the child, and lets the owner settle with a "did not exit"
outcome. The uncertainty is kept next to the cause: a timed-out analysis pass
reports it after the timeout, and an output-cap kill reports `output cap
exceeded; the process did not exit after it was killed` (still classified as
`output-cap`). Requesting
termination is never reported as the process having stopped. Normal
completion still waits for `close`, so successful output is fully drained. The
ladder's timers stay referenced; they are bounded to 2 × the grace period and
cleared on dispose.

It is used by:

- **Verification command checks** (§6).
- **Approval polls** (§2, Approval conditions): a timeout or a shutdown ends
  the tree the same way.
- **The AnalysisRunner's spawn** (`spawnAnalysisProcess` in
  `sources/analysis.ts`). A timeout, the output cap (overflow), and an error
  from a still-running process now all end the tree, and `done` always
  settles. Previously `kill()` sent one SIGTERM (on Windows it killed only the
  shell) and `done` waited for a `close` that any process still holding the
  pipe could withhold forever, leaving the runner permanently "busy" —
  reproduced on POSIX, inferred for Windows.
- **`killRunProcess`** (scheduler cancel, shutdown, and the pipeline engine's
  `stopRun`), which now delegates to the same helper with an unchanged
  interface. On Windows the `taskkill` is now an asynchronous `execFile` with
  `windowsHide` and a 10s bound, instead of `spawnSync`.

One deliberate non-change: the pipeline engine's step-deadline timer
(`trackStep`) was reviewed and left referenced. It is the only in-process
deadline enforcement for runs this process launched; the reconcile pass
enforces a persisted `deadlineAt` only for runs adopted after a restart. In
the server the HTTP listener keeps the loop alive and shutdown calls
`process.exit`, so `unref` would change nothing in production, and no hang
was traced to it.

### Writing tests that run on Windows too

- **CI.** The server and web suites and the typecheck run on `windows-latest`
  (job `windows` in `.github/workflows/ci.yml`). The server suite runs through
  `npm -w server run test:timeboxed`, which caps each test at 120 seconds
  (`--test-timeout=120000`; Node rejects it in `NODE_OPTIONS`, so it is a CLI
  flag). Each step and the job carry a `timeout-minutes`, and a final step
  fails if any `processTreeFixture.mjs` process is left running. Lint, format,
  coverage gates, build and budgets stay on the Linux job only.
- **Line endings.** `.gitattributes` pins `* text=auto eol=lf`. The index was
  already LF, so nothing was renormalised.
- **Commands fed to `command` checks** run through the platform shell
  (`cmd.exe` on Windows). Write them as `node -e "<js>" "<arg>"`: the
  JavaScript in double quotes with only single quotes inside it, paths passed
  as separate quoted arguments and read from `process.argv[1]`, and none of
  `%`, `^`, `&`, `|`, `<`, `>`, `$` or backticks. `exit N` works in both
  shells.
- **Symlinks.** Gate the test with `{ skip: symlinkSkip }` from
  `server/src/testPlatform.ts`, which probes once whether file and directory
  links can actually be created (Windows needs Developer Mode or
  administrator rights). Pass `"dir"` as the type for a link to a directory —
  Node creates a file link on Windows when the type is omitted. Do not link to
  POSIX-only paths such as `/etc/hostname`; create the target in the test's
  temp directory.
- **Drain every engine a test creates** before the next test points
  `ARGUS_CLAUDE_HOME` somewhere new: the engine's detached work resolves its
  paths when it writes, so work still in flight would write into the next
  test's home.
- **Test repositories** set `core.autocrlf=false`, so a checkout gives back
  the committed bytes whatever the host's git config says (a Windows runner's
  system config sets it to `true`).
- **Expected paths** are built with `path.join` wherever the code under test
  builds them that way, not written with `/`.
- **POSIX permission bits** are asserted only off Windows (`posixModeSkip`, or
  `process.platform !== "win32"`).
- **Engine tests with invented pids must inject a fake `kill`** (`fakeKill()`
  from `testPlatform.ts`). An invented pid can be a real, unrelated process on
  the host, and the default `killRunProcess` would terminate it. Only a test
  that spawns its own real process and needs it killed keeps the real
  `killRunProcess`, and says so.
- **Process-lifecycle tests** use `server/src/processTreeFixture.mjs`, which
  spawns its own root and descendant and records the descendant's pid. Tests
  probe only that pid, and assert both that the owning promise settles and that
  the descendant is gone. The descendant exits by itself once the test removes
  its pid file.
- **State compared across temp homes** is normalised with `withoutHome()`
  (`server/src/decision/testSupport.ts`). It replaces only exact spellings of
  the home (as given, its real path, with forward slashes, and with
  JSON-escaped backslashes), never a pattern, so a difference anywhere below
  the home still fails. `settleJournalOrder` accepts either path separator.
- **The Argus tail skill.** `.agents/skills/argus-tail/SKILL.md` is now a
  plain copy of `.claude/skills/argus-tail/SKILL.md` instead of a git symlink,
  and `server/src/cli/tail.test.ts` fails if they differ. Edit one and copy it
  over the other.

### POSIX-only suites

The end-to-end suites `server/src/harness/e2e.test.ts`,
`verificationE2e.test.ts`, `changeIntentE2e.test.ts` and
`realizationE2e.test.ts` remain skipped on Windows. Their skip reason is that
they rely on process groups, `sh -c` hooks and signal-based kills; the fake
agent `harness/fakeAgent.mjs` is executed directly through its shebang and
exec bit, which Windows cannot do, and the engine uses its two-stage host
there. On Windows the tree-termination helper itself is exercised by
`processTree.test.ts` (real controlled trees through verification and the
analysis spawn), and the engine's two-stage host by the win32-gated tests in
`pipelineProcess.test.ts`; the engine-level deadline and abort paths those
suites drive end to end are not exercised on Windows.

A known residual: `probeCommand` in `server/src/setup/prereqs.ts` uses
`spawnSync` with `shell: true` on Windows, whose timeout ends only `cmd.exe`,
so a timed-out probe waits for its descendant to release the pipe. That is a
bounded delay, and it is not changed here.

## 18. Transitions and recovery

Everything above decides what a phase's outcome _is_. This section is about
what happens when Argus itself stops partway through acting on one — a crash, a
kill, a power cut — and how an operator can tell afterwards what the instance
went through. The design and its commit order are in
[ARCHITECTURE.md § Transitions are logged, instances are the authority](ARCHITECTURE.md#transitions-are-logged-instances-are-the-authority);
this is what it means for someone running pipelines.

### The transition log

Each instance has `~/.claude/argus/transitions/<instanceId>.jsonl`: a numbered
record for every save of the instance, saying which pure transitions ran
(`events`), what they changed, and a summary of the side effects the saved
state owes (`effects`: launches, checks, stops, knowledge commits, and a spawn
phase's `spawn` work: `plan` its task list or its next tasks, `start` a planned
child, `revive` a failed one). It supports
**replay and integrity diagnosis, not authority**. The saved instance is what
Argus acts on, and a record is never executed on its own word. The `effects`
field in particular is a diagnostic snapshot, written for a reader. Nothing in
recovery reads it (`transitionLog/effects.ts` `owedEffects()` has one caller,
the record writer). It is computed separately from the checks recovery
applies, and is not guaranteed to agree with them in every edge case.
It is separate from the instance journal (observational, size-capped), from
`gate-decisions.jsonl`, from the Decision Journal and from the Knowledge Ledger.
The log is deleted only when its instance is pruned.

What a replay reproduces is a _projection_ of the instance, not the instance:
the definition snapshot and trigger payload appear only as digests, so do
payloads, results and answers over 1 KiB and any string over 512 characters.
A differing elided value still shows as a different digest, but the log cannot
give you back an agent's message. A record over 16 KiB keeps its sequence
number but not its changes, and replay stops there.

### Checking an instance

`GET /api/instances/:id/transitions/integrity` compares the log with the saved
instance and returns a status, in plain words, with the first path where they
differ. It repairs nothing and nothing reads it to decide what to do.

| Status         | What it means                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `untracked`    | No log, and the instance never claimed one — it predates the log and has not moved since.                                                                         |
| `consistent`   | The fold of the log equals the saved instance's projection, from the instance's first transition.                                                                 |
| `partial`      | What the log covers agrees, but it does not cover all of it: it begins at a baseline written after the instance existed, or replay stopped at an oversize record. |
| `missing`      | The instance claims a log that is not there.                                                                                                                      |
| `degraded`     | Records the instance claims could not be written (see below); replay stops at the gap.                                                                            |
| `ahead`        | The log has records past the saved instance: a transition that was proposed and never committed. Nothing it owed was executed.                                    |
| `behind`       | The saved instance is past the end of the log.                                                                                                                    |
| `gap`          | Sequence numbers are not contiguous.                                                                                                                              |
| `disagreement` | The fold and the saved instance differ.                                                                                                                           |
| `corrupt`      | A line failed its checksum or did not parse, and was not a torn final write.                                                                                      |

A torn tail (the only failure mode of an append) is tolerated and reported, as
are bad lines and foreign records. `ahead` after a crash is expected, not an
alarm: it is exactly the signature of dying between writing the record and
publishing the instance, and the next commit re-anchors the log with a baseline.
An instance that predates the log gets a `baseline` record on its first save,
which is why its coverage is `from-baseline` and its best status `partial`.

### Degraded and capped logs

If the log cannot be written — an I/O error, or the 4 MiB cap — the instance
save **still proceeds**. The instance records `transitionLog.degradedFrom` (and
`capped`), sequence numbers keep counting, and the integrity report says
`degraded`; the gap is never forgotten. A capped log is **never pruned to make
room**, since the oldest records are the ones that explain how the instance got
here. Logging failing does not permit or destroy anything: gate decisions still
require their own durable record (a failing gate log still refuses an approval
with `500`), and knowledge commits still require the ledger.

Instance saves themselves are durable: the file is written in full and fsynced,
renamed over the old one (with the existing bounded retry on Windows), and the
directory is fsynced. Honest limits: on Windows a directory cannot be fsynced,
so that step is a no-op there and rests on NTFS metadata journalling, which
Argus has not measured; nothing is claimed about hardware that lies about its
write cache; and no NTFS performance measurement was made.

### What recovery does after a restart

`reconcile()` derives every recovered effect from **committed state**: the
saved instance (phase and step status, attempt, run ids, `verification`,
`knowledge`, `pendingGateOperation`) and the run records (`Run.termination`,
`deadlineAt`, liveness). It never reads the transition log to decide anything,
and it is at-least-once. "Exactly once" is not claimed for effects in general.

- **An owed launch.** A phase attempt the saved instance says is `running` with
  no run planned — a crash between the transition (a retry, a revise, a
  remediation, a settle) and the launch — is launched by `reconcile`, and the
  journal gets `phase.launch-recovered`. It is skipped if this process already
  has that launch queued. Launch identity is the run: `startPhase` refuses to
  plan an attempt whose steps already carry run ids, before any side effect, so
  a second queued launch of the same attempt cannot start a second set of runs;
  a sibling phase is a different attempt and is never held back. A planned run
  whose process never started is still failed as `spawn`, never re-spawned.
  That includes a run that was queued for a concurrency slot when Argus
  stopped: the queue lives in memory, so after a restart every such run fails
  as `spawn` and its phase is retried under the default retry policy. While
  this process holds it in the queue, reconcile leaves it alone.
- **A stop request that was never delivered.** Every stop goes through one
  `terminateRun`. `Run.termination` is a recorded _request_, not proof the
  process stopped, so liveness is asked (`isAlive`) and delivery is tracked per
  process. Within one process, the delivery (SIGTERM, then SIGKILL after the
  grace) is the whole of it and a sweep never repeats it. After a restart, a
  recorded request whose process is still alive is delivered again, under its
  original reason (journal `step.termination-redelivered`); an adopted run past
  its deadline likewise.
- **A decided run that is still alive.** A live run whose step was already
  decided (failed, aborted, skipped, or running under a finished phase), that
  did not report its own outcome and that this process did not stop, is stopped
  (`step.orphan-stopped`). This reaches the sibling a crash kept the
  post-failure sweep from reaching. Runs of terminal instances updated in the
  last 24 hours are swept too.
- **Checks and knowledge commits.** Re-driven from the saved state as before:
  checks re-run when `verification.status` is `running`, and a pending
  knowledge commit is re-applied, idempotent by delta id.
- **While another phase is paused at a gate.** A fan-out instance with any
  phase `awaiting-approval` reads `awaiting-approval` as a whole. Recovery
  gives it the authority the live paths already give it.
  - Work a committed decision ordered still happens:
    - an owed launch, including one completed by gate recovery (the approval
      path itself starts successors while other gates wait);
    - a pending knowledge commit.
  - Results wait for the gate decision: healing a run that ended without
    signalling, check results (not applied to a paused instance, so
    interrupted checks are not re-run until then) and candidate selection. A
    run that does signal is accepted by the signal path meanwhile (§2). This
    holds when a heal in the same pass is what opened the gate: the pass
    stops healing there, and the siblings are healed after the decision.
  - Every recovered effect acts only on phases that are themselves `running`.
    Recovery never touches, approves or resumes the paused phase.
- **Approval polls are gate decisions, not recovery.** Reconcile never polls;
  the scheduler tick queues polls after it ([Approval conditions](#approval-conditions)).
  An approval a poll made is an ordinary approval: interrupted after its link,
  it is completed by gate recovery like any other. A poll in flight at a crash
  or a shutdown is lost and runs again on the new process's first tick;
  nothing about a poll is stored on the instance. A condition failure is one
  transition save, so there is nothing to recover.
- **An owed spawn** (§20). Every live parent's spawn phases are re-driven
  under the parent's lock: a task list a crash left unbuilt is built, every
  `planned` child is started under the id the parent saved (an existing record
  is found, never created twice; one Argus cannot read is waited for, never
  overwritten), and every `reviving` child is revived, once: whether its revise
  happened is asked of the child's own linked decisions.
- **A child that ended while Argus was down.** The same pass reads every child
  the saved parent names and mirrors it: the spawn phase joins, pauses at
  `children`, or plans its next task. A `children` pause is not a gate here:
  an observation of a child is what ends it.
- **A child its parent no longer waits for.** A live child of a parent that
  ended before its abort cascade ran, whose spawn phase joined or was accepted,
  or whose task now names a fresh child, is aborted (`parent-aborted`). The
  candidates come from the saved parent (`decidedChildren` in
  `transitionLog/effects.ts`), never from `effects`.

The tests for all of this simulate recovery — they discard an engine and build a
fresh one over the same files — and do not establish power-loss durability.

### For contributors: forgotten transitions

At each commit, every pipeline status change (the instance's status, a phase's
status, attempt, pause or retry time, a step's run id or status, a spawn task's
child id or state, keyed `child:<phaseId>#<i>`, the pending gate operation — not
run records, verification reports or Verdicts) must be
accounted for by an event about that phase. One that is not is written on the
record as `unattributed` and logged as a warning in production. The test
preload sets `ARGUS_STRICT_TRANSITIONS=1`, which makes it throw, so a status
write that bypasses a pure transition fails the suite. The engine no longer
writes those fields itself: launch planning, retry scheduling, failure
classification, gate link/complete, candidate tree cleanup and every change to
a spawn phase's tasks are pure transitions in `pipelineTransitions.ts`, and a
targeted static test bans direct writes of them, of a phase's `children` and of
a task's fields, in engine modules.

## 19. Trajectory signals and judging

Verdict (USER-GUIDE §24) asks whether a run's final output was any good. It
cannot see how the agent got there: a run can loop, fight errors, undo its own
edits, write outside its working directory or run something destructive and
still end with a fine summary. A rubric may therefore declare a `trajectory`,
which adds a second, separate judgment of the **path**: deterministic signals
computed from the run's recorded events, an **automation hold** that turns some
of them into a held automated approval, and optionally one bounded judge call.
A phase may also declare a `trajectory` **PhaseCheck**, a verification check
over the same signals that is configured on the phase, not the rubric (see
below). The code is
`server/src/sources/trajectory.ts` (the heuristics), `trajectoryVerdict.ts`
(the pass) and `timeline.ts` (the timeline format shared with Autopsy).

**Off by default.** Nothing here runs unless `rubric.trajectory` is declared (or
a phase declares a `trajectory` PhaseCheck). A rubric without it has no
trajectory analysis of any kind, no extra cost, and the same output
`rubricDigest` it always had.

```jsonc
"rubric": {
  "goal": "…",
  "criteria": [ … ],
  "trajectory": {
    "criteria": [{ "id": "focus", "label": "Stayed on the task" }], // optional: a judge scores these
    "minScore": 6,                                                  // optional; needs criteria
    "check": { "holdOn": ["destructive-command", "path"] }          // optional: an automation hold, not a verification check
  }
}
```

`trajectory` must ask for something: criteria, a `check`, or both. `check.holdOn`
is a non-empty, duplicate-free list of signal names; `minScore` needs criteria
to score; the criteria rules (slug ids, at most 10, weights above zero) are the
output rubric's.

### The five heuristics

The signals are computed by pure functions over the run's Recorder events (the
Flight Recorder's derivation, `sources/recorder.ts`; USER-GUIDE §21) and carry
`TRAJECTORY_SIGNALS_VERSION` (currently 1). Each stores a `count`, an `observed` flag (the count reached the
rule's threshold) and up to five clipped examples: timeline labels and
commands, never file contents. The `trajectory` PhaseCheck compares the
`count`, not the `observed` flag.

**They are heuristics, not findings.** A positive count is not proof of a
problem: polling `git status` is repetition, and a test suite that fails twice
before passing is errors. A count of zero means **not observed in the recorded
events**, never "did not happen". The Recorder keeps the most recent 2,000
events (`EVENT_CAP`), so a long run's opening is gone and `truncated` is `true`;
a resumed session, a tool the Recorder does not model, and everything below can
hide behaviour too. **A truncated recording is incomplete input**: what it kept
is real, but it cannot show that a signal never occurred in the part that was
dropped, so it never establishes a clean trajectory (see the PhaseCheck and the
automated approval rules below).

| Signal                | Counts                                                                                                                             | Observed at |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `repetition`          | distinct non-file tool labels that occur 3 or more times                                                                           | 1 or more   |
| `errors`              | tool calls that came back `is_error`, plus error results with no matching call                                                     | 3 or more   |
| `edit-revert`         | edits whose added/removed line counts mirror an earlier edit to the same path                                                      | 1 or more   |
| `path`                | file-tool calls whose path is outside the working directory, or matches a sensitive pattern                                        | 1 or more   |
| `destructive-command` | Bash calls matching one of a fixed list of destructive command shapes (`DESTRUCTIVE_PATTERNS`: ten, listed under the signal below) | 1 or more   |

Known limitations, per signal:

- **repetition.** The rule is identical `label` on a `tool`-lane event, three or
  more times. Labels are the Recorder's one-line labels, clipped at 120
  characters, so two different long commands sharing a prefix look identical.
  A label is not the whole call: `Read` is labelled by file _basename_,
  `Grep`/`Glob` by pattern and every tool the Recorder has no label for, MCP
  tools included, by tool name alone, so repeated calls with different
  arguments can count as the same call. Legitimate polling and retry loops
  count. File-tool calls (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`) are not
  considered here at all.
- **errors.** Counts errored tool calls and orphan error results (a result whose
  call was not recorded, as in a truncated or resumed transcript). Observed at 3. A command that fails but exits 0, and a failure the agent only describes in
  prose, are invisible: the transcript marks a result as an error only when the
  tool said so. A failing test run the agent then fixes counts like any other.
- **edit-revert.** Per path, an `Edit` or `MultiEdit` whose `(added, removed)`
  line counts are the mirror image of an earlier, not-yet-matched edit to the
  same path (it adds what that one removed and removes what it added; both must
  be non-zero in total). The Recorder keeps line **counts**, not content, so an
  unrelated edit with mirrored counts matches. `Write` and `NotebookEdit` are
  excluded (a write replaces a file and the transcript does not say what was
  there), and a revert through `Write`, `git checkout`, `git restore` or any
  shell command is invisible.
- **path.** Only the file tools (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`
  with a `file_path`) are seen: reads are not, and a shell command that writes
  anywhere is not. A relative path is resolved against the run's working
  directory and counts if it leaves it; symlinks are not resolved, so a link
  inside the directory pointing out is not outside. A path is sensitive when it
  is under `.ssh`, `.aws`, `.gnupg`, `.kube` or `.docker`, is `.env` or
  `.env.*`, is inside `.git/`, is under `/etc/`, or is named `id_rsa`,
  `id_ed25519`, `credentials`, `credentials.json`, `.netrc`, `.npmrc` or
  `.pypirc`. With **no working directory recorded** only the sensitive-path rule
  and a leading `../` apply.
- **destructive-command.** The ten patterns are `rm -rf` (and `-fr`, or the long
  forms), `git reset --hard`, `git push --force`/`--force-with-lease`/`-f`,
  `git clean -f…`, `git checkout .`/`git restore .`, `git branch -D`,
  `drop table|database|schema` and `truncate table`, `find … -delete`,
  disk writes (`mkfs`, `dd of=/dev/…`, redirects to `/dev/sd*`, `nvme*`,
  `disk*`), and `chmod -R 777`. They are matched against the Bash label and,
  when the call did **not** error, the full command the Recorder kept (an
  error replaces the detail, so an errored call is matched on its label alone,
  which is clipped). Aliases, scripts, `eval`, variables and other indirection
  are invisible, and so is anything that is not the `Bash` tool: MCP servers
  and other runtimes' shells are not inspected. The match is a regex over the
  text, so **quoted text is a known false positive**: `echo rm -rf /tmp/x` is
  reported. Only the examples tell you which pattern matched, as
  `<pattern id>: <label>`.

The Recorder's own synthetic markers (the run-start line and the terminal
"finished" or "failed" line) come from the run record, not from anything the
agent did, and are excluded before any heuristic runs. If no transcript event
remains — no session, no transcript or an empty one — the signals are stored as
`transcript: "missing"` with no signals computed, and the verdict is
`skipped`. A missing transcript is **unavailable, never passing**; so is a
truncated one.

### The automation hold (`holdOn`)

`trajectory.check.holdOn` names the signals whose observation withholds an
**automated** approval (the Verdict watcher's) from a gate, leaving it for a
person. It is deterministic and uses no model. `held` is the subset of `holdOn`
whose signal was observed.

It is **only an automation hold**, and it is not a verification check:

- it does not fail verification and does not appear in a phase's verification
  report;
- it does not pause or fail a phase;
- it does not affect an operator's approval, which is never conditioned on it;
- it matters to a gate only when `autoApprove` is declared (it is then one more
  condition for the gate to open itself). It cannot approve anything.

The run's page shows what it held on. To make a path signal fail a phase, use the
`trajectory` PhaseCheck below.

### The trajectory PhaseCheck

A `PhaseCheck` of `kind: "trajectory"` is a **verification check**, declared in
a phase's `checks` beside `command`, `artifact`, `file` and `changed-files`. It
is deterministic and uses no model, and it is independent of `rubric.trajectory`:
a phase can declare either, both or neither.

```jsonc
"checks": [
  {
    "kind": "trajectory",
    "label": "Stayed inside the lines",      // optional
    "thresholds": { "destructive-command": 0, "path": 0, "errors": 5 },
    "requireTranscript": true                // optional, default false
  }
]
```

`thresholds` maps signal names to the largest `count` the check allows. It must
name at least one of the five signals, and each maximum is a whole number from 0
to 10,000 (`TRAJECTORY_THRESHOLD_MAX`); `requireTranscript` is a boolean; any other
key is refused. A signal the check does not name is not looked at.

**What counts.** The check reads each relevant run's own transcript at
verification time (`readRun`, `readSessionLines`, the Recorder's
`buildRecording`, then `computeTrajectorySignals`), not a stored verdict, and
compares the signal `count` to its threshold. The counts are:

| Signal                | `count`                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `repetition`          | the number of distinct non-file tool labels that occur 3 or more times |
| `errors`              | errored tool calls plus orphan error results                           |
| `edit-revert`         | mirrored edits                                                         |
| `path`                | file-tool writes outside the working directory, or to sensitive paths  |
| `destructive-command` | `Bash` calls matching the destructive pattern list                     |

**Which runs.** An ordinary phase verifies the runs of its relevant steps: the
selected candidate's runs when a candidate is selected, otherwise every step of
the attempt. A candidate being verified (best-of-N) is checked on its own run
only.

**Outcomes.** There are three, kept apart on purpose:

- **Violation, `failed`.** Some relevant run's count for a named signal is
  above its threshold. This is an observed violation, so it fails the check
  whatever else is missing, and **even on a truncated recording**, because the
  events it kept are real. The detail begins `observed:` and names the run,
  signal, count and threshold.
- **Insufficient input.** No violation was seen, but the check cannot show the
  thresholds held: a run has no run record, no recorded session, no readable
  transcript, or a truncated recording; or there are no runs at all. With
  `requireTranscript: true` the check is `failed` ("insufficient input"). Without
  it the check is `not-evaluated`. It is **never `passed`**: absent or partial
  data is not evidence that nothing happened.
- **`passed`.** Every relevant run has a complete (untruncated) recording within
  every named threshold.

`CheckResult.status` is therefore `passed`, `failed` or `not-evaluated`, and only
a `trajectory` check produces the last. The report's status is `failed` if and
only if some check `failed`: a `not-evaluated` check does not fail the report
and is never counted as passed. When a report passes, the phase journal's
`phase.verified` detail adds `(n not evaluated)` if any check was not evaluated. The gate drawer shows a
not-evaluated check as `–` with "(not evaluated)".

**Knowledge.** A `not-evaluated` check result can never be bound as knowledge
evidence. Rule verification and acceptance verification bind a cited check to
the phase's report by label, and only checks that were evaluated (`passed` or
`failed`) are bindable; citing a not-evaluated check is an unsubstantiated
citation and refuses the commit, as for any check the report does not contain.
The knowledge layer itself is unchanged.

### The optional judge

When the rubric declares trajectory `criteria`, the pass makes **one bounded
call** through the same `AnalysisRunner` as Autopsy and Verdict (one pass at a
time, 90-second timeout, no tools, metered into the spend ledger, refused under
the budget hard stop, off under `ARGUS_ANALYSIS=off`; see ARCHITECTURE.md § One
place that asks a model a question). A check-only rubric makes no call at all,
so it is unaffected by `ARGUS_ANALYSIS=off` and the budget.

The prompt carries the rubric's goal, the trajectory criteria by id, the task
prompt, the signals (labelled as heuristics that "can miss things and can flag
legitimate work", so the judge may disagree with them), and a timeline of the
run's events in the Autopsy format. The timeline quotes the **first 20 and last
60 events**, with the gap said (`… N events omitted …`); if that exceeds a
**14,000-character** timeline budget, lines are dropped from the middle, head
and tail in proportion, until it fits, and the whole prompt is capped at 24,000
characters. The answer is parsed with the output judge's validator: scores for
unlisted criteria are dropped, scores are clamped to 0–10, a response scoring
none of the criteria is a failure, and the overall score is computed from the
author's weights, never taken from the model. A trajectory
score below `trajectory.minScore` marks the verdict `regression: true`. That
flag is stored and plotted; unlike an output regression it does not open an
issue.

### Storage

A trajectory assessment is a `Verdict` with `kind: "trajectory"` (an absent
`kind` means `output`, which is every verdict written before trajectories
existed), stored in the **same** `verdicts.json` and subject to the **same
400-record cap**: output and trajectory judgments share `VERDICT_KEEP`, so
declaring a trajectory does not raise retention. Each kind has its own current
record per run (the newest), its own trend and its own basis in an approval;
they are never mixed. A pruned judgment is simply absent, and an absent
judgment holds the gate rather than opening it. The Vault and the issue triage
read output verdicts only.

The record carries `trajectory: { signals, held, judged }`. Its
`status` is:

| Status    | When                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `skipped` | there is no transcript to read (`signals.transcript` is `missing`), or the judge was disabled            |
| `failed`  | a judge was asked and produced nothing usable                                                            |
| `ready`   | otherwise; a **check-only** rubric is `ready` with a `null` score, a judged one carries a weighted score |

Every status other than `ready` holds an automated approval. A `trajectory`
verdict's `provenance.promptVersion` is `TRAJECTORY_PROMPT_VERSION` (currently
1).

### Digests

An output verdict's `rubricDigest` is unchanged, byte for byte: a hash of the
goal and the output criteria, with or without a trajectory on the rubric, so
adding one invalidates no existing output verdict. A trajectory verdict has its
own `trajectoryRubricDigest`: a hash of the goal, the trajectory criteria (id,
label, weight), the **sorted** `holdOn` list and the signals version. Changing
any of those, or a heuristic (which bumps the version), means earlier
trajectory judgments no longer match the rubric and cannot open a gate.
`trajectory.minScore` and the `autoApprove` bars are policy applied afterwards
and are in neither digest.

### Automated approval

A gated phase whose rubric declares a trajectory needs, in addition to
everything §2 and USER-GUIDE §24 require of the output basis, a **trajectory
basis**, kept apart from the output one. For every relevant step (the exact
runs of the attempt; the selected candidate's for best-of-N):

- a **current** trajectory judgment: the run's newest `trajectory` verdict, with
  an id, `ready`;
- its `rubricDigest` equals the `trajectoryRubricDigest` of the instance's own
  rubric snapshot;
- its signals are present (`transcript: "present"`) at the **current signals
  version**, and come from a **complete recording**: `signals.truncated` is
  false;
- when the rubric has trajectory criteria: a score, and `provenance.promptVersion`
  equal to the current trajectory prompt version;
- the check held nothing. `held` is **recomputed from the stored signals**
  against the rubric's `holdOn`, never read from the record;
- when judged, the score is at least the trajectory bar,
  `autoApprove.trajectory`, else `autoApprove.verdict`. A check-only rubric has
  no trajectory score and no bar. `autoApprove.trajectory` is only accepted when
  the rubric declares trajectory criteria.

A missing, pruned, failed, skipped, mismatched, signal-less, truncated or
older-version judgment holds the gate (`insufficient-data`, naming one of
`no-trajectory-verdict`, `trajectory-without-id`, `trajectory-not-ready`,
`trajectory-rubric-mismatch`, `trajectory-signals-unavailable`,
`trajectory-signals-truncated`, `trajectory-prompt-mismatch`); an observed held
signal or a score under the bar leaves it waiting for a person
(`below-threshold`). The output requirements are unchanged, including the
phase's worst step deciding.

Incomplete trajectory input never establishes a clean trajectory.
`trajectory-signals-unavailable` (no transcript, an unsupported signals
version) and `trajectory-signals-truncated` (the Recorder keeps the last 2,000
events and dropped the earliest) are **insufficient data, not observed
violations**: they withhold automation, and nothing is asserted about what the
agent did. One definition (`trajectoryBasisEntry`) decides this at both places
that read it, the watcher's pre-qualification (`autoApprovalQualification`) and
the engine's automated-approval boundary (`approveAutomatically`, under the
verdict store lock). An operator's own approval is unaffected.

The watcher names the trajectory basis in the approval request as
`trajectoryVerdicts: [{ runId, verdictId }]`, apart from `verdicts`, and the
engine decides again from the stores. In `approveAutomatically` the trajectory
basis is validated **under the verdict store lock, together with the output
basis**, so a write that lands first is part of what was validated and one that
lands later cannot revoke a durable approval. The request is refused (`409`)
when it names a trajectory judgment on a phase whose rubric declares none, names
a run twice or a run that is not one of the attempt's relevant runs, omits a
relevant run, names a verdict that is not that run's current trajectory
judgment, or names one that cannot open the gate. Only `{ runId, verdictId }` is
trusted from the request: the recorded `trajectoryVerdicts[]` entry (`stepName`,
`verdictId`, `at`, `score`, `bar`, `held`, `signalsVersion`, `rubricDigest` and
the provenance fields) is **reconstructed from the stored record** and the
instance's own policy. `held` is always empty in an approval, and `score` and
`bar` are `null` for a check-only rubric. A phase whose rubric declares no
trajectory records no `trajectoryVerdicts` at all.

### When it runs

The Verdict watcher runs on the scheduler tick. Each tick it does **at most one
trajectory pass**, after the output judgment and before the gate check, and
because the tick is sequential, before any shadow experiment asks the runner for
anything. It picks the newest run that succeeded within the last 24 hours, whose
rubric declares a trajectory, and that has no trajectory verdict of any status
yet. A run need not have a result summary (an output pass does). If the runner
refuses as **busy** or over the **budget hard stop**, the pass writes nothing and
is tried again on a later tick, rather than leaving a permanent refusal; a
disabled analysis, a missing transcript and a failed judge _are_ written, so the
operator can see why. If the watcher has no way to read transcripts, a gate
whose rubric declares a trajectory never qualifies: it waits for a person.

### What it is not

A trajectory assessment is Argus's own observation plus a model's rating of a
timeline. It is **not Knowledge Ledger evidence**: it is never cited by a claim,
and it does not change `evaluateSupport` or anything the ledger derives. It
cannot open a gate that commits knowledge (that exclusion is unchanged), it
does not stop a run, and a `holdOn` hold leaves the decision with a person.
(A `trajectory` PhaseCheck is a different thing: its `passed` and `failed` results
are ordinary check results, bindable as knowledge evidence like any other, and its
`not-evaluated` result is not; see above.)

### Decision Plane H1

The H1 Verdict baseline is `auto-approval-qualification`, which now has two
versions. **v1** is the Phase 0 rule as it was; **v2** adds the trajectory
requirement above. On a phase whose rubric declares no trajectory the two
classify identically, but a capture names the definition it was taken under:
new captures are v2, the H1 config records v2, and a v1 capture stays v1 and is
never re-read under v2's rule. The report has one Verdict row set per version
in use. The rating stays the **minimum output score** (an ordinal, never a
probability), so a trajectory score does not enter it. Paired model agreement
pools v1 and v2 captures, because without a trajectory they cannot differ. The
qualification definition row is registered when every recorded digest is a
known version. See RFC 2026-09-29 §Q.6.

**v2 was amended in place.** v2 had never been published when review found that
a truncated recording could satisfy a trajectory requirement; v2's text now
requires signals from a complete, untruncated recording, so a truncated one is
`insufficient-data` (`trajectory-signals-truncated`). Because v2 had not been
released, it was edited rather than versioned, and its digest changed:

| Definition                           | Digest                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| v1                                   | `b2041f398f64873dd7914452ed0f46a9ec3cc6d7a7dc863d0addb3a8c937ede1` |
| v2 (current)                         | `376097e99f957acd47876a64b85defc60975f984cb150b6be4938b2ab1299b34` |
| v2 as first written (never released) | `13e14de3c3afbc046ae5f6a6a7d557fbac94a7b599de57415aac1d7df9be6d38` |

v1's digest is unchanged. A capture or configuration taken under the superseded
v2 digest names a digest no registered definition has: it is **never re-read**
under the current v2 (the report selects captures by exact digest, so it is in
no Verdict row set), and the qualification definition row reports
`digest-mismatch` while a recorded configuration carries an unregistered digest.

## 20. Spawn phases

A **spawn phase** works through a list of tasks with one pipeline instance per
task. Instead of running steps, it reads a task list from an earlier phase's
validated `result`, starts one instance of another pipeline (a _child_) per
task, in dependency order, and succeeds once every child has succeeded. It runs
no agent of its own, so it has no steps, checks, gate, retry or worktree: each
task's work, and its review, happen in its child, at the child's own gates.

The pure half (the limits, the item check, the order, the payload, the summary)
is `server/src/sources/children.ts`; the engine half (the starts, the mirror,
the abort cascade, recovery) is `engine/children.ts`. Every change to the
parent is a pure transition in `pipelineTransitions.ts` (§18). The pipelines
form refuses a phase with no steps, so a pipeline with a spawn phase is
authored and edited through the API. The worked recipe is
[Spawn child instances](guides/pipelines.md#spawn-child-instances).

### What a spawn phase is

```jsonc
{
  "id": "tasks",
  "name": "Tasks",
  "cwd": "/src/app", // must exist, although nothing runs there
  "needs": ["plan"],
  "produces": "tasks-summary", // publishes the children summary
  "spawn": {
    "pipelineId": "task-loop", // the pipeline every child runs
    "items": { "phase": "plan", "path": ["tasks"] }, // the task list in plan's result
    "key": "id", // names each task
    "dependsOn": "after", // optional: the keys a task waits for
    "title": "title", // optional: shown for the task
    "maxParallel": 1, // optional: default 1, and 1 is the most for now
    "maxItems": 20, // optional: default 20, at most 50
    "base": "origin/main", // optional: every child's worktrees are cut from it
    "include": { "spec": { "phase": "plan", "path": ["spec"] } }, // optional
  },
}
```

| Field         | Meaning                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pipelineId`  | The pipeline every child runs (the _task pipeline_). See [Targets](#targets).                                                                                                                                                                    |
| `items`       | `{ phase, path }`: the task list is the array at `path` (property names; `[]` is the whole result) in `phase`'s result.                                                                                                                          |
| `key`         | The task property that names each task. Each value must be unique and 1-64 letters, digits, `.`, `-` or `_`, starting with a letter or digit: it is safe in a label, a path segment or a branch name.                                            |
| `dependsOn`   | The task property listing the keys of the tasks it waits for. A task starts only when every task it names has succeeded. Absent: no order beyond `maxParallel`.                                                                                  |
| `title`       | The task property shown as its title, clipped to 60 characters on the parent. Absent: the key is the title.                                                                                                                                      |
| `maxParallel` | How many children may be live at once. Default 1. Above 1 is refused until parallel Claude sessions are safe (reliability WS13); it is a constant, not a setting, so one machine never runs what another refuses to save.                        |
| `maxItems`    | The most tasks the list may hold. Default 20, at most 50.                                                                                                                                                                                        |
| `base`        | The git ref every child's worktrees are cut from, instead of the task pipeline's own `workspace.base` (§11). Also in each child's payload. Validated like `workspace.base`.                                                                      |
| `include`     | Named values from earlier phases' results, copied into every child's payload under `include.<name>`: the approved spec's path and commit, say. Up to 16 names of 1-40 letters, digits, `-` or `_`; each `{ phase, path }`, the path of any type. |

A spawn phase declares only `id`, `name`, `cwd`, `needs`, `produces` and
`spawn`. It is stored with `steps: []` and `gated: false`, and accepts those two
values back, so a `GET` → `PUT` round trip saves. Anything else is a `400`: a
`retry` or `checks` that looks meaningful but would be ignored is worse than a
refusal. The checks made when the pipeline is saved
(`validateSpawnPhases` in `sources/pipelines.ts`):

- `items.phase` and every `include` source is another phase that is a
  transitive `needs` dependency of the spawn phase (so its result exists before
  any child starts) and declares a `result` whose schema declares the path.
  A path is at most 8 property names.
- The schema at `items.path` is an array of objects; each task declares `key`
  as a required string, `dependsOn` as an array of strings and `title` as a
  string.
- A spawn phase may not sit between an implementation phase and its acceptance
  verifier (§16): a remediation re-runs exactly those phases to re-verify an
  implementation, and re-running children is not what it means.

The exact messages are in [API.md § Phase fields](API.md#phase-fields).

**The item check.** The task list is checked again, against the result itself,
when the source phase submits it (`readSpawnItems`, from
`resolvePhaseResult`): before the source phase's own checks and gate, so nobody
approves a plan that could not run. The source phase fails, classed `signal`,
when the list is missing, is not a list, is empty, holds more than `maxItems`
tasks, or holds a task that is not an object, has no `key` string, has a key
outside the alphabet above or one another task already has, is over 16 KiB as
JSON, has a `dependsOn` that is not a list of strings, or depends on itself, on
a key not in the list, or through a cycle. The reason reads
`the task list for spawn phase "tasks" is not usable: …` and counts tasks from 1.
A key listed twice in one `dependsOn` counts once. `signal` is not in the default
`retryOn` (§2): add it to the source phase's `retry.retryOn` to give its agent
another attempt with the reason in its retry note (§13).

| Limit                    | Value                                 | Enforced                                       |
| ------------------------ | ------------------------------------- | ---------------------------------------------- |
| Children live at once    | 1 (`maxParallel`), until WS13         | at save                                        |
| Tasks in the list        | default 20 (`maxItems`), at most 50   | `maxItems` at save; the list by the item check |
| Task key                 | 1-64 characters, unique               | the item check                                 |
| Task title on the parent | 60 characters (the child gets it all) | clipped when the list is built                 |
| One task as JSON         | 16 KiB                                | the item check                                 |
| A child's whole payload  | 64 KiB, the webhook body cap          | when the list is built (see below)             |
| `include` names          | 16                                    | at save                                        |
| A source `path`          | 8 property names                      | at save                                        |

### The payload

Each child starts with `trigger: "spawned"`, `parent` (which parent instance,
spawn phase, task position and key it runs) and this
`triggerPayload` (`SpawnTriggerPayload`):

```jsonc
{
  "task": { "id": "auth", "title": "Add sign-in", "after": ["schema"] }, // as the result held it
  "key": "auth",
  "base": "origin/main", // when spawn.base is set
  "include": { "spec": "docs/specs/auth.md" }, // when spawn.include is set
  "parent": {
    "instanceId": "…",
    "pipelineId": "delivery",
    "phaseId": "tasks",
    "index": 1,
    "key": "auth",
  },
}
```

The child's prompts read it as `{{trigger.payload}}`, capped like any
placeholder (16 KiB by default, §13), and its `command` checks read a copy at
`ARGUS_TRIGGER_PAYLOAD_FILE` (§6). An `include` path the result does not hold
is copied as `null`.

Every task's payload is built and measured when the list is built, before any
child starts, and built again, identically, when each child starts. A task
alone is at most 16 KiB, so only `include` can push a payload over 64 KiB; one
that does is a definition problem, and the spawn phase fails under
`configuration` (never retried), naming the largest `include` value. A
source phase with no result to read when the spawn phase starts (one reached
through an `allowSkipped` edge, say) fails it the same way.

`base` is recorded on the child as `workspaceBase`, and its worktrees are cut
from it instead of its definition's `workspace.base` (§11). Argus never fetches
it: the tree is cut from wherever that ref points in the local repository, so
the child's first phase should fetch and reset to the remote ref. A task
pipeline with no workspace policy only sees `base` in its payload.

### How a child starts: exactly once, by identity

1. **Plan, under the parent's lock.** The tasks that are ready (every
   dependency succeeded, and a slot free under `maxParallel`) each get a newly
   minted instance id, saved on the parent with the task `planned`. That save is
   the commit point.
2. **Start, off the parent's lock**, under the task pipeline's start lock. The
   id is looked up first. A record with that id is returned as it is. A file
   Argus cannot read for any reason but "file not found" is never overwritten:
   the start waits and is asked again on the next tick. Only a missing record is
   created, after asking again whether the parent still waits for that id; then
   it starts like any instance, from the task pipeline's definition as it is
   now, through its `overlapPolicy`, the preflight, the first save and the
   first launches. A record under that id whose `parent` names another instance
   is never adopted: the task fails, and a revise of the spawn phase gives it a
   fresh id.
3. **Mirror, under the parent's lock.** Every save of a child queues its
   parent's sync, which reads the child's record (without its lock) and updates
   the task.

A crash after step 1 repeats step 2 with the same id; a crash after step 2
finds the child. Reconcile repeats steps 1 to 3 for every live parent on every
tick, from the saved parent alone (§18).

| Argus stopped after                                    | The saved parent says           | Recovery                                                     |
| ------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------ |
| the spawn phase started, before its list was built     | the phase runs, no task list    | builds the list (the same one: the source result is settled) |
| the plan save, before the start                        | task `planned`, no child        | starts the child under that id, once                         |
| the child's first save, before the parent mirrored it  | task `planned`, the child runs  | the start finds the child and mirrors it                     |
| a child's record was damaged or locked                 | task `planned`, unreadable      | waits (`deferred`), asks each tick, never re-creates it      |
| a child ended while Argus was down                     | task `running`, the child ended | mirrors it: the join, the pause, or the next task            |
| the parent's abort, before its children were aborted   | parent `aborted`, children live | the sweep aborts each child (`parent-aborted`)               |
| a revise of the spawn phase, before the child's revise | task `reviving`, child `failed` | revives the child once                                       |
| the child's revise link, before the revise completed   | task `reviving`, child `failed` | gate recovery completes it; no second revise                 |
| the child's revise, before the parent mirrored it      | task `reviving`, child running  | mirrors it; no second revise                                 |

A revive is a revise of the child, and whether it happened is asked of the
child alone: some decision it links, and has finished applying, carries the
parent's decision id (`parentDecisionId`). So an interrupted revive is carried
out exactly once. While the child's revise is still being applied (it carries
`pendingGateOperation`, §18), its `failed` is the failure being revived: the
task stays `reviving`, and the revise's last save mirrors the child.

### Lock order

A parent's lock is never held while waiting for a child's lock or for a
pipeline's start lock, and a child's lock never waits for its parent's.
Anything one locked section needs from another lock (a start, a revive, the
abort cascade, the parent's sync after a child's save) is queued, and starts
with no lock held; children are read from disk, never locked, from the parent's
side, and the parent is read, never locked, from a child's. A start lock may be
followed by one instance lock (a start, the cascade, `DELETE` of the pipeline),
never by another start lock.

### Order, the join and the children pause

- **Order.** Tasks start in list order as their dependencies succeed, at most
  `maxParallel` live at a time. "Succeeded" is the child instance succeeding,
  through whatever gates its own pipeline has.
- **The join.** When every task has succeeded, the spawn phase succeeds. Its
  payload, published under `produces`, is the children summary
  (`SpawnChildrenSummary`: every task's key, title, state and child, counts by
  state, and `notSucceeded`), and the phases that need it start. Journal
  `children.joined`.
- **A child that fails or is aborted** stops new starts. Waiting tasks that
  depend on it, directly or through others, become `blocked`, and running
  children finish. Once no child is live, the spawn phase pauses:
  `awaiting-approval` with `pause: "children"` and the summary as its payload,
  so the parent reads `awaiting-approval`. Journal `children.halted`.

At a `children` pause a person chooses one of four actions. Each is a state
change; a re-run child runs its pipeline's agents again, and an approval starts
the phases after the spawn phase:

- **Accept the rest: approve the spawn phase.** It succeeds with the summary,
  whose `notSucceeded` lists the tasks it drops, and the phases after it start.
  It takes no `answers` (`400 answers-not-accepted`), and is refused
  `409 children-running` while a child a person re-ran is live again, or its
  revise is still being applied.
- **Re-run every task that did not succeed: revise the spawn phase.** A failed
  child is revived in place: Argus revises the child's failed phase with a
  decision whose mechanism is `parent-decision`, principal
  `{ kind: "system", component: "spawn" }`, `parentDecisionId` the parent's
  revise and `note` the parent's note, which the child's next attempt reads
  like any revise note (§13). An aborted, refused or never-started task gets a
  fresh child (the old id moves to `previousInstanceIds`), and blocked tasks
  wait again. Tasks that succeeded stay; the task list is never rebuilt.
- **Re-run one child: revise that child's failed phase**, on the child. The
  task runs again, the spawn phase resumes (`children-resumed`), and once the
  child succeeds the tasks it blocked continue.
- **Abort** the parent (below).

Rewinding to the phase that wrote the task list is deferred: accept the rest
and start a follow-up instance instead. A `children` pause is never opened by
an automated rule: auto-approval (§19) and its qualification treat it as
ineligible, as they do a `needs-input` pause, and an approval condition (§2)
never polls it; a spawn phase cannot declare `approveWhen` or `autoApprove`.

### Abort, delete, edit and retention

- **Aborting the parent aborts its children.** Its live tasks are recorded
  `aborted` in the same save, and each child is then aborted with
  `abortCause: "parent-aborted"`, recorded as carrying out the parent's abort
  (mechanism `parent-decision`, principal `spawn`, `parentDecisionId`). No
  `after` chain fires for those children.
- **The sweep.** A live child its parent no longer waits for (the parent ended
  before the cascade reached it, its spawn phase joined or was accepted, or a
  fresh child replaced it) is aborted by reconcile the same way, with no
  `parentDecisionId`: it acts on the parent's state, not on one decision.
- **Aborting a child** always works. Its task becomes `aborted`; the parent
  lets its running children finish, then pauses at `children`.
- **Deciding on a child its parent no longer waits for.** Approve and revise,
  and an automated decision (a Verdict auto-approval, or an approval
  condition's exit 0 or `failOnExit`), are refused with `409 parent-decided`:
  its outcome would count for nothing. A refused poll is journalled once as
  "not applied", and the sweep aborts the child. The parent waits for a child
  while the parent is live, its spawn phase runs or waits at `children`, and
  the task still names that child. A child whose parent's record is gone is the
  operator's alone; a parent record Argus cannot read refuses the decision
  until it can.
- **Deleting the task pipeline** aborts its live instances, the children among
  them (`pipeline-deleted`). A start still owed then finds no pipeline and fails
  its task for good, and each parent pauses at `children` once its running
  children finish. A recreated pipeline has a new id, and a parent's task list
  keeps naming the old one: accept the rest, or abort.
- **Deleting the parent's pipeline** aborts the parents (`pipeline-deleted`), and
  each parent's abort aborts its children (`parent-aborted`).
- **Editing the task pipeline.** Each child reads the task pipeline's
  definition when it starts. So an execution edit is held with
  `409 instances-running`, as under the pipeline's own live instances, while a
  live instance of another pipeline has a spawn phase that targets it and has
  not succeeded or been skipped; `?force=1` saves it anyway.
- **Retention.** A child is kept past its pipeline's window of 50 instances
  while its parent's record exists, or cannot be read right now; only a parent
  record that is provably gone releases it, at the task pipeline's next start.
  Kept children still count toward the window. Pruning a parent does not prune
  its children.

### Status

The parent's spawn phase stays `running` while its children run or wait at
their own gates: a child's gate belongs to the child, and never makes its parent
`awaiting-approval`. Only the `children` pause does. `inFlight`
(`sources/instanceStatus.ts`) reads the spawn phase's tasks: a parent whose live
children all wait at their own gates is not in flight, so
`argus tail --until-idle` returns; a planned child whose start waits (a budget
hold, a busy task pipeline) keeps it in flight. Each child is an instance of the
task pipeline: its gates are its own, and `argus tail` names it
`<pipeline> [<key>]`.

### Budget

While the spend budget's hard stop is on (`isSpendBlocked`, the authority
scheduled firings obey: the ladder's `stop` step, or an exceeded limit with
`blockScheduled`), no new child is planned, and a planned child's start waits
with `deferred.reason` "the spend budget is exceeded". The parent's journal gets
`children.held` when a hold begins and `children.released` when it lifts. A
budget that cannot be read holds too. A revive is not held (it is a person's
decision), and a running child is never stopped. Spend multiplies with the task
count: every child runs its own pipeline's agents.

### Targets

- **Trigger none or webhook.** A spawned pipeline is started by its parent; a
  schedule or `after` trigger would start it without one.
- **One level deep.** The task pipeline may not have a spawn phase of its own,
  and a pipeline may not spawn itself.
- **Both directions.** Checked when the parent is saved (it names a pipeline
  that exists and qualifies) and when the task pipeline is saved (it may gain
  neither such a trigger nor a spawn phase while any pipeline spawns it). It is
  validation, a `400`, so `?force=1` does not bypass it.
- **`overlapPolicy: "skip"`** on the task pipeline is honoured: while one of its
  instances is live, the next child waits (`deferred`). With `maxParallel: 1` a
  parent's previous child has ended before the next is planned, so it only
  waits on another parent's child or a manual start; set the task pipeline's
  `overlapPolicy` to `"allow"` to avoid that.
- **`enabled`** on the task pipeline is not consulted.

### Known limits

- **One child at a time** until reliability WS13 makes parallel Claude sessions
  safe.
- **A revive can race its child's worktree cleanup.** A failed child's worktree
  removal starts when it fails; a revive soon after reuses the tree or checks
  the branch out again (§11), and the race between the two is the reliability
  plan's WS5. Not fixed here.
- **A stale base.** Argus does not fetch `spawn.base`; a child whose first
  phase does not fetch works from an old commit.
- **`after` chains of the task pipeline fire once per child** that ends on its
  own. Only children stopped by their parent (`parent-aborted`) or by a deleted
  pipeline fire none.
- **`{{previous.instance}}` in a child** names the last settled instance of the
  task pipeline: usually another task's child.
- **The record bound.** The parent's transition log records the task list in
  full (§18), one line at most 16 KiB. The records a spawn phase writes fit at
  50 tasks, but a baseline record, which carries the whole instance, of a parent
  with many phases and 50 tasks with long keys and titles can exceed it. That
  parent's log then reads `partial`; recovery never reads the log.
