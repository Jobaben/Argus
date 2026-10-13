# Plan: Argus pipeline reliability (every audit finding)

## Re-baseline, 2026-10-12, against `main` = `39b58dc`

This plan was written against `main` around `db4c035`. Since then:

- WS1 and WS2 merged, and their follow-ups landed in `fa470ed`.
- 12 more commits landed (`fa470ed..39b58dc`):
  - the Decision Ledger foundations in `server/src/decision/` (H1/H2, DL06 policy prep);
  - a docs reorganization (`0c583e9`);
  - runtime changes (Codex read-only isolation, cost parsing);
  - transcript reader hardening;
  - the experiment folders.

Six read-only audits checked every workstream's claims against `39b58dc`; none found an obsolete item. Before editing them in, I checked by hand:

- every design-changing claim (status masking, the Codex read-only hooks, the health 401, the decision `not-called` whitelist, the `signals.ts` hard-coded outcome);
- every moved line reference.

Moved references are fixed in place. Each workstream has a **Re-baseline** block: pure corrections are stated as fact, and new work is marked **(adopted)** (approved on 2026-10-12, decision 8).

**What did not change:**

- `server/src/engine/`, `pipelineTransitions.ts`, `sources/dag.ts`, `harness/`, `bin/` and `hooks/` are untouched since `fa470ed`.
- None of WS3–WS10 is pre-empted: no release, build id, state lock, `contractVersion`, `no-work`, check-only phase or doctor code exists.

**Baseline suite at `39b58dc` (Windows, this machine):**

- `test:timeboxed` runs 3,218 tests: 3,188 pass, 25 skipped, 5 fail.
- 3 of the failures are known: the CRLF Codex skill copy, "blowing the output cap", and "analysis spawn: kill()…".
- 2 are load-only and pass in isolation: `processTree` "verification: a timed-out command whose descendant holds the pipe…", and `pipelineEngine` "a completion signal is answered while a later wave waits for a slot".
- Typecheck and build pass.

**New since the plan:** WS14 (instance status under gates) runs **before WS3**; see its section.

### Decisions on the re-baseline (the user, 2026-10-12)

1. **WS12 soak rule: narrowed.** New rule: "No new top-level `server/src/` directory and no new `/api/` route family until the discovery pipeline (P1) and one implement→PR pipeline each run 10 times clean on Windows from a release build. Work inside existing subsystems, including the Decision Ledger, continues." _(Wording confirmed by the user, 2026-10-12.)_
2. **Release cadence: cut.** `v0.5.0` was released on 2026-10-12 (`75deb5f`, tag pushed). From now on, release after every merged workstream. `[Unreleased]` spans about 2,270 lines since `v0.4.0` (2026-07-14).
3. **CHANGELOG gap: yes.** I write the missing entries for `fa470ed..39b58dc` before the release, including the Codex read-only **behaviour change**: since `821d047`, a Codex step with `filesystem: "read-only"` runs with `features.hooks=false` (`runtimes/codex.ts:94-110`, applied at `:178`), so its completion comes from the run record, not the stop hook. It also gets no MCP servers or web search, an env allowlist, and `ARGUS_CODEX_ARGS` throws (`:126`). WS4's registry gets `codex-read-only-isolation`.
4. **WS3 lock probe: the token must exist.** `/api/health` returns 401 without a token (`app.test.ts:181-189`). The probe always sends `ARGUS_TOKEN` (set in the Windows user environment on 2026-10-12), and a 401 from a live pid counts as **held**. _Still open, ask during WS3:_ what a missing `ARGUS_TOKEN` does (the server refuses to start, or only the probe fails closed).
5. **WS6 fallback directory: approved.** No `os.homedir()` fallback (it picks up home-level CLI config). Fall back to an Argus-owned directory that is always created, as the Decision Ledger does (`decision/definitions.ts:116-120`, `providers/cli.ts:124-157` `unsafe-cwd`).
6. **WS11 scope.**
   - **A third, disabled probe definition** (`f91767c8`) is **out of scope.** It came up only because WS10/WS11 verify against "the existing pipelines" and the store holds three definitions; no workstream depends on it.
   - **Orphan instance `48fab3f6`** (`awaiting-approval` since 2026-07-02, deleted pipeline `cf12d32d`): **abort it** through the API, never by editing `instances.json`. It matters because it is a live gate: the H1 collector would capture it, it skews the gate counts WS14 fixes, and WS14's status derivation runs over it.
7. **WS14 scope: approved as grown.** It includes:
   - four pure transitions derive the status instead of writing `running`;
   - `instanceOutcome` counts a pending retry as live. **This changes outcomes:** no spurious `failed`, `onFailure`, `instance.ended`, `after:failed` chain or early worktree cleanup;
   - the display surfaces (briefing, palette, insight, `argus tail`, the federation summary) use the same predicate.
8. **Scope additions: all approved.** They are marked **(adopted)** in each workstream:
   - **WS3:** `export-ignore` for `experiments/`; a manual check that a second server on another port is refused; the rollback data-hiding note in RELEASING.md.
   - **WS5:** limit reclaim to the retry after a timed-out add, or require an empty `git status`; cleanup waits for owed stops.
   - **WS6:** a new `cwd-missing` failure kind in both decision whitelists; an injectable directory check.
   - **WS7:** rename "check-only" (it clashes with null-score rubrics).
   - **WS8:** review the other `RunOutcome` consumers; exclude no-work runs from H2 sampling.
   - **WS9:** `codex-args-readonly` and runtime/model compatibility lints; tag probe and canary runs and exclude them.
   - **WS10:** exclude canary instances from H1, or refuse `--canary` while H1 collection is on.
   - **WS12:** split `app.test.ts` before routes are added, plus the process additions listed there.
   - **Dependencies:** WS8 drops WS4 (it has no registry entry) and gains WS14; WS3 (order only) and WS11 gain WS14. Applied in the Order table.

## Context

The 2026-10-08 audit (`scratchpad/argus-audit/argus-failure-audit.md`) found that pipelines built with the skill succeeded 2 of 27 times. The 37 phase failures behind that break down as:

| Cause                                        | Failures |
| -------------------------------------------- | -------- |
| skill or authoring gaps                      | 12       |
| design strictness                            | 10       |
| Argus runtime bugs                           | 7        |
| Windows                                      | 4        |
| behaviour changes that hit saved definitions | 3        |
| requirement churn                            | 1        |

The save-time dry run caught none of them. Planning added two more findings:

- **Completed runs get discarded.** The launcher holds the instance lock while it waits for a concurrency slot. The hook's 10 s POST then queues behind that lock and gives up. Reconcile fails the finished Claude run without reading its record. This was verified in `ebe85a30`.
- **Read-only is not enforced.**
  - Rules embed raw paths: `Edit(//C:\…/**)` on Windows and `Edit(///work/**)` on POSIX. Claude Code matches `//c/…` and `//work/…`.
  - `PowerShell` is never denied.
  - Local invocation records show "read-only" phases allowed to `Write` with deny rules that never match.

**Outcome:**

- completed work is never discarded;
- read-only really is read-only;
- pipelines fail in a cheap launch simulation, not in an expensive run;
- limits live in the agent contracts;
- behaviour changes are flagged on each saved pipeline;
- pipelines run on a pinned release;
- the skill closes its loop.

## Decisions already made

| Topic                                     | Decision                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behaviour changes under saved definitions | **Flag + explicit upgrade.** Each definition gets a `contractVersion`. Argus lists pending changes and keeps running the pipeline; `argus pipeline upgrade <id>` acknowledges them. |
| A run with nothing to do                  | **`ARGUS_OUTCOME: no-work`.** The phase succeeds, every downstream phase is skipped, the instance succeeds with a "no work" label, and no incident opens.                           |
| Release                                   | **Pinned release build.** The server runs from a versioned folder, not the dev checkout.                                                                                            |
| Existing pipelines                        | **Rework both** once their dependencies land.                                                                                                                                       |

## Ground rules for every workstream

- **One branch per workstream**, cut from the current `main` (`fix/...` or `feat/...`). I **stage the changes, never commit**, then stop so you can review, commit and merge. The next workstream branches from the updated `main`.
- **A workstream is done when all of these pass:**
  - `npm run typecheck`
  - `npm run lint`
  - `npm run format:check`
  - `npm -w server run test:timeboxed`
  - `npm -w web run test` (only when web changed)
  - `node scripts/check-contracts-runtime.mjs`
  - `npm run build`
  - _(re-baseline)_ CI runs more than this list (`.github/workflows/ci.yml:32-41`). Done also includes:
    - `npm -w server run test:coverage`;
    - `npm -w web run test:coverage`, when web changed;
    - `node scripts/check-bundle-size.mjs` and `node scripts/check-motion-budget.mjs`, when web changed. `a60d3f9` had to defer code to fit the payload budget, so WS4, WS7 and WS8's web additions should stay lazily loaded.
  - _(re-baseline)_ **"Passes" means no new failures against the baseline** in the Re-baseline section, with every failure rerun in isolation before it is called real. Per `docs/development/README.md`, a focused check is never reported as the global suite passing.
  - _(re-baseline)_ `format:check` reports about 547 files that are only CRLF working copies. Use `npx prettier --check --end-of-line auto .`, and confirm the touched files are LF with `git ls-files --eol`.

  Docs and a CHANGELOG `[Unreleased]` entry (`- **Title.** body`) are part of done. Anything that needs a live run is reported as **"ready for verification"**, never as "done".

- _(re-baseline)_ **The docs are reorganized** (`0c583e9`); `docs/development/documentation.md` sets the rules. Every workstream:
  - updates the topic guide **and** the exact reference together;
  - updates the feature-map row in `docs/guides/README.md`;
  - adds any new doc to `docs/development/catalog.md`;
  - checks `node bin/argus.mjs --help` and `git diff --check`.

  Where the plan's doc names now point:

  | The plan says                                                                      | Now                                                                                                        |
  | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
  | USER-GUIDE.md                                                                      | an anchor stub; write to `docs/guides/<topic>.md` (pipelines, terminal, …)                                 |
  | README (config table, launcher)                                                    | `docs/reference/configuration.md` (env vars) and `docs/reference/operations.md` (launcher, build identity) |
  | API.md, HARNESS.md, ARCHITECTURE.md, DATA-MODEL.md, `docs/RELEASING.md`, CHANGELOG | still canonical, unchanged in place                                                                        |
  | CLI commands                                                                       | `docs/guides/terminal.md` and/or `operations.md`, plus `--help`                                            |

- **Architecture rules to keep:**
  - Engine modules talk only via `core.fns` (`engine/boundaries.test.ts`).
  - State changes go only through the pure `pipelineTransitions.ts` (`transitionEngine.test.ts:469`, `ARGUS_STRICT_TRANSITIONS=1`, on by default in tests via `testHome.ts:44`).
  - Contracts are types-only and additive.
  - `app.ts` never imports `engine/*` (`boundaries.test.ts:75`).
  - New admin routes are registered per path in the `app.ts` block under the comment "Pipeline definitions: mutations only" (`:484-516` at `39b58dc`) and added to the `app.test.ts:342-361` list.
  - Windows-portable tests: HARNESS.md §17, "Writing tests that run on Windows too" (`HARNESS.md#17-process-trees-and-portable-tests`).
- **Behaviour-change registry (from WS4 on):** any change that can alter the outcome of an existing definition, or that needs author action, appends an entry. Additive or purely beneficial changes get no entry.

## Order

Status legend: ⬜ not started · 🟡 in progress · 🔵 staged for review · ✅ merged · ⏸ blocked

| Status | #    | Workstream                                                                       | Branch                                                    | Why here                                                                   | Depends on                                           |
| ------ | ---- | -------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| ✅     | WS1  | Completion delivery (the race, gate drops); server first, hook in a later commit | `fix/completion-delivery`, then `fix/hook-delivery-retry` | Discards completed work today                                              | –                                                    |
| ✅     | WS2  | Read-only enforcement and channel access                                         | `fix/claude-permission-rules`                             | Security gap                                                               | –                                                    |
| ✅     | –    | WS1/WS2 follow-ups: stall pass at a gate, test D ordering                        | `fix/stall-at-gate` (`fa470ed`)                           | Same class as WS1/WS2's gate guards                                        | –                                                    |
| 🔵     | WS14 | Instance status under gates (derivation, predicates, guard test)                 | `fix/gate-state-guards`                                   | The gate-guard bugs keep recurring one path at a time; runs **before WS3** | –                                                    |
| ⬜     | WS3  | Pinned release, state lock, build id                                             | `feat/pinned-release`                                     | Later development stops moving running pipelines                           | WS14 (order only)                                    |
| ⬜     | WS4  | `contractVersion`, registry, `pipeline upgrade`                                  | `feat/behaviour-change-registry`                          | Later workstreams register their changes                                   | –                                                    |
| ⬜     | WS5  | Workspace and git reliability                                                    | `fix/worktree-reliability`                                | Timeouts, long paths, cleanup race                                         | –                                                    |
| ⬜     | WS6  | Caps in the contracts, analysis cwd                                              | `fix/contract-limits`                                     | Small; removes prompt hacks                                                | WS4 (entry)                                          |
| ⬜     | WS7  | Check-only phases                                                                | `feat/check-only-phases`                                  | Replaces the Haiku "anchor" step                                           | –                                                    |
| ⬜     | WS8  | `no-work` outcome                                                                | `feat/no-work-outcome`                                    | Empty queues stop failing                                                  | WS1 (signal path), WS14 (instance-status derivation) |
| ⬜     | WS9  | `argus pipeline doctor`                                                          | `feat/pipeline-doctor`                                    | Launch simulation                                                          | WS2, WS4, WS5, WS6                                   |
| ⬜     | WS10 | Skill: close the loop, start minimal                                             | (skill folder, no git)                                    |                                                                            | WS6–WS9                                              |
| ⬜     | WS11 | Rework both pipelines                                                            | (API, via `--update`)                                     |                                                                            | WS1–WS10, WS13, WS14                                 |
| ⬜     | WS12 | Process: credentials, soak, release cadence                                      | –                                                         |                                                                            | –                                                    |
| ⬜     | WS13 | `~/.claude.json` race under parallel sessions (investigation first)              | `fix/claude-config-race`                                  | Fan-out phases launch exactly that way                                     | – (WS11 depends on it)                               |

After each of WS1–WS9 is merged, cut a release (`argus release`, from WS3 on).

---

## WS1 — Completion delivery (P0)

**Status:** ✅ WS1a `db4c035` (pushed) and WS1b `7787fdb` (hook retries + `concludeUnlaunchable` gate fix) merged to `main` on 2026-10-09, and both are pushed. Live proof pending (WS11).
Files: `server/src/engine/{spawn,context,launch,reconcile,signals}.ts`, `hooks/argus-signal.mjs` and its `.d.mts`.

**Exact mechanism behind `ebe85a30`:**

1. Under one lock hold, slices 1–4 took the four slots. Slice 5 then waited in `sem.acquire()` (`launch.ts:916`) while still holding the instance lock.
2. A reconcile tick queued behind it (`reconcile.ts:238`), and the four Stop POSTs queued behind reconcile.
3. The hooks gave up at 10 s and the agents exited, which freed slots for slices 5–8.
4. Reconcile ran first and failed the four finished Claude runs. Their signals were then "ignored".

**WS1a: the server.** Stage it, you commit, then WS1b follows.

1. **Strict FIFO semaphore (`engine/spawn.ts`).**
   - `release()` hands its slot directly to the next waiter. Today a newcomer can grab it first, so two runs share one slot.
   - New `tryAcquire()`, which refuses while anyone is queued.
   - Tests in a new `engine/spawn.test.ts`: overshoot, FIFO order, `tryAcquire` behind a waiter.
2. **Spawn off the lock.**
   - **Why one change fixes all six paths:** `launch.ts:916` is the only place a slot is awaited.
   - **The waiting registry:** `engine/context.ts` gets `awaitingSlot: Set<runId>`.
   - **Refused runs are settled during planning:** the planned-error check moves out of `launchStep` into `plannedRefusal()`, so a refused run gets its `spawn-failed` record and never needs a slot.
   - **The launch loop.** Its body (`:767-820`) becomes `spawnUnit` and its failure tail (`:823-847`) becomes `concludeUnlaunchable`. For each run:
     - If `sem.tryAcquire()` succeeds, it spawns inline as today.
     - Otherwise `queueSpawn` adds the run to `awaitingSlot` and calls `sem.acquire()`. It waits off the lock, then re-takes the lock and re-reads the instance with `readLive`.
     - It re-checks that the instance is running or awaiting approval, the phase is running at the same attempt, the step with that runId is still running, and no run record exists yet.
     - If all hold, it spawns. Otherwise it journals "not launched: decided while waiting for a slot".
     - In `finally` it releases the slot and leaves the set.
   - **Reconcile** (`reconcile.ts:340-343`) also requires `!awaitingSlot.has(runId)` before stubbing a run as never-started.
   - **Comments** at `launch.ts:759-765` and `1243-1248` and at `signals.ts:260-267` are rewritten to match.
3. **A signal the server has received wins over reconcile.**
   - `signalsInFlight: Map<runId, count>` (a counter, since duplicate deliveries overlap).
   - `onSignal` increments it before taking the lock and decrements it in `finally`.
   - Reconcile skips a run while it is in that map (`reconcile.ts:386`).
4. **Accept signals while a sibling waits at a gate** (found during planning; same symptom).
   - `settle` sets the instance to `awaiting-approval` whenever **any** phase is at a gate (`pipelineTransitions.ts:424`), and `onSignal` drops every signal unless the instance is `running` (`signals.ts:84`).
   - So in any gated fan-out, sibling completions are silently dropped, then healed as failures.
   - Fix: return early only for terminal or aborted instances.

Tests in `pipelineEngine.test.ts`:

- **A, the incident:** cap 2; `pre` then `s1`–`s3`. `onSignal(s1)` returns 202 within a time bound while the wave is still queued. Nothing is journalled as ignored, and `s2` and `s3` spawn in order.
- **B:** a queued run whose instance is aborted never spawns, has no run record, and its slot passes on.
- **C:** cap 1. A retry waiting for a slot no longer blocks the reconcile tick, and it is not stubbed as `spawn-failed`.
- **D:** a signal received while reconcile is blocked wins. Today the journal shows "ignored: phase is failed".
- **E:** parallel phases where one is gated and waiting. The other phase's completion is accepted.
- Update "adopt claims alive running steps…" with `await e2.drain()`.
- `harness/reviewFixes.test.ts` must still see `readRun(runIdB) === null`.

**WS1b: hook delivery, landed in a later commit.** A more patient hook running against the unfixed server would make the deadlock last longer. 5. `deliverSignal(…, timeoutMs)` treats only transport errors and 5xx as retryable, never 400, 403 or 404.

- New `deliverWithRetry` has a **45 s budget**, because Qwen kills hooks at 60 s and Claude and Codex allow 600 s.
- Each attempt waits up to the remaining budget.
- Backoff is 0.5 / 1 / 2 / 4 / 8 s.
- Every attempt sends the identical body. Duplicates are ignored as `step-not-running`.
- Tests in `hooks.test.ts`:
  - resend after a thrown fetch and after a 503;
  - no resend on 403;
  - the budget runs out and the last error is rethrown;
  - every attempt sends the same body;
  - a process test with a 503 → 202 server exits 0.
- No `HOOK_VERSION` bump: the payload is unchanged, and installed hooks are compared by byte hash and re-copied by boot setup and `preflight()`.

Docs:

- HARNESS.md: §1 (cap and queue), §2 (delivery retries, received-signal precedence), §18 (on a restart, a queued run fails as `spawn` and is retried by default).
- ARCHITECTURE.md: the two new registries.
- CHANGELOG:
  - **Fixed:** completed runs discarded when the cap is full; sibling completions dropped while a gate waits.
  - **Changed:** start, approve and revise can return before every run has spawned; the hook retries delivery.

Decisions:

- **APPROVED: defer only the spawn, per run.** One change point; the six callers are untouched; crash behaviour is kept.
- **DENIED: a full launch queue.** It needs a second registry for reconcile's owed-launch check and adds no safety.
- **DENIED: the Claude/Qwen run-record fallback. This reverses the audit's recommendation 1.**
  - The hook deliberately defers "Done. ARGUS_OUTCOME: succeeded" while background tasks are queued (`hooks.test.ts:65-73`, `argus-signal.mjs:264-271`).
  - Reading the record would accept that unfinished work.
  - Steps 2–3 remove the actual cause. `pipelineEngine.test.ts:373` stays as it is.
- **DENIED: a clock-based grace window.** It delays every genuinely lost signal; step 3 is exact instead.
- **DENIED: reviving a failed phase on a late completion.** By then cleanup has started, `onFailure` has fired and siblings are swept, and steps 2–3 close the window anyway.

Risks:

- **A restart while the cap is full:** every queued phase fails as `spawn` and is retried by default.
- **Forged signals:** a request counted in flight before authentication can delay healing for that request's lifetime only.

---

## WS2 — Read-only enforcement and channel access (P0, security)

**Status:** ✅ merged to `main` as `c8d5e2a` (2026-10-09) and pushed. Follow-ups #1 (stall pass at a gate) and #4 (test D ordering) landed as `fa470ed`; #2 became WS13. Also carries the two WS1 lifecycle guards (deadline and `adopt()` under `awaiting-approval`). Probe results: HARNESS.md §3 "Rule paths, as probed". The PowerShell expectation in step 1 did **not** reproduce (see the handoff); `bypassPermissions` unprobed. `toClaudeRulePath(p)` infers Windows/POSIX from the path's shape instead of taking a `platform` argument.
Files: `server/src/runtimes/claude.ts`, `server/src/engine/prompts.ts`, `server/src/engine/launch.ts`.

1. **Probe first.** It is manual: it needs the real CLI on Windows, in temp folders `wt` (working directory) and `chan` (channel). Record the results in HARNESS.md §3.
   - Under `--permission-mode acceptEdits`:
     - `--disallowedTools "Edit(//C:\…\wt/**)"` → a write to `wt` succeeds (the gap).
     - `Edit(//c/…/wt/**)` → refused.
   - Default mode:
     - `--add-dir chan --allowedTools "Edit(//c/…/chan/**)"` → a write to `chan` succeeds.
     - Without that allow → refused.
   - `--disallowedTools Bash` → PowerShell can still write to `wt`.
2. **Normalize rule paths.** Add `toClaudeRulePath(path, platform)`:
   - win32 `C:\x\y` → `/c/x/y`, trailing slash trimmed;
   - a comma, newline or UNC path returns `null`, which becomes a limitation;
   - rules are built as `Edit(/${rulePath}/**)`, which fixes POSIX `///`;
   - use it for roots (`:157`) and read channels (`:106`);
   - `isWithin` compares normalized paths, case-insensitively on win32.
3. **Auto-allow each granted write channel.** Thread `allow` into `claudeChannels` and add `Edit(//<dir>/**)`. This only affects runs with a capability profile.
4. **Read-only also denies `PowerShell`,** with the same scoped-allow logic as `Bash` (`:161-168`).
5. **Channel paths go in the per-run user prompt.**
   - `channelInstruction(env)` lives in `prompts.ts` and is rendered by `launchStep` from its env map.
   - The `noteSuffix` append moves from `startPhase` into `launchStep`, so the retry note stays last.
   - `STEP_CONTRACT`, the system prompt, stays constant so the cache prefix holds.

Tests:

- `runtimes/claude.test.ts`, `channels.test.ts`: Windows-shaped inputs; change the `///` assertions to `//`; write-channel allows; PowerShell.
- `pipelineEngine.test.ts`: the prompt carries the channel paths and ends with the retry note.

Docs: HARNESS.md §3/§3a, USER-GUIDE.md, CHANGELOG ("Security").

Registry: **v4 `read-only-enforced`**, backfilled in WS4. A read-only agent that used to write into its repo now fails.

Decisions:

- **APPROVED:** normalization, write-channel allows, PowerShell deny, paths in the user prompt (`artifactInstruction` already puts absolute paths there).
- **DENIED: auto `Bash(printenv …)`.** It would flip `hasScopedBash` and un-deny Bash for every read-only phase. With your user-level `defaultMode: auto`, the classifier could then approve shell writes.

---

## WS14 — Instance status under gates

**Status:** 🔵 staged for review on `fix/gate-state-guards` (2026-10-13). Order (before WS3) and the grown scope are approved (decision 7).

**Outcome, 2026-10-13.** Steps 1–5 are implemented and staged:

- `sources/instanceStatus.ts` holds the predicates, imported from there everywhere (engine modules included). `settle` and the four transitions write `liveStatus`, `instanceOutcome` counts `pendingRetry`, and `runDueRetries` filters on `resumable` (re-checked under the lock).
- The guard test (`engine/instanceStatus.test.ts`) keys its allowlist on file + trimmed line text rather than line numbers, so an unrelated edit above it cannot break it. Two entries: the decided-run sweep in `reconcile.ts`.
- **Step 4's `reconcile.ts:538` case, decided by the user:** a heal that opens a gate stops the loop (`!appliesResults`), matching the documented policy and the paused-at-entry path. The siblings heal after the decision.
- **Step 5, decided by the user: abort first.** `DELETE /api/pipelines/:id` aborts live instances, then deletes. It returns `409 instance-not-stopped` and keeps the definition if one cannot be stopped. `GET /api/overview` adds `orphaned: true` entries. The Command Center shows them as _pipeline deleted_ with a Stop button for admins.
- Three existing tests encoded the masked state (status `awaiting-approval` with no waiting phase, or `running` over a waiting phase): `federation.test.ts` summary, `palette.test.ts` gate entry and `verdictWatcher.test.ts` "not awaiting". Their fixtures were made consistent, and verdictWatcher gained the masked-gate regression.
- **Code-review follow-ups, same day (user: "fix all"):**
  - Delete runs under `engine.withStartsHeld(id)`: `start` holds the same per-pipeline lock from reading the definition to launching its first phases, so no instance appears between the aborts and the delete. Starts of one pipeline are now serialized through their first launch.
  - The delete's aborts carry `cause: "pipeline-deleted"` (persisted in `PendingGateOperation`, then `PipelineInstance.abortCause` in the abort save). `processChains` skips them; an operator's abort still chains as `failed`.
  - `verdictWatcher` skips instances whose pipeline is gone.
  - `queueVerification`/`queueCandidateVerification` return before running checks while a gate waits; reconcile queues them after the decision (test counts `phase.verifying`: 0, then 1).
  - New predicate `inFlight` (a phase running, a retry due, or no gate): the fleet's `liveInstances` and `argus tail --until-idle` use it. The tail's started/resumed lines ask `hasWaitingGate` first, then `resumable`.
  - The web board's `gatesFor` reads waiting gates off the phases of any live instance. `useAuth` returns `isAdmin`. An orphan card keys its Stop error by instance.
  - The alias wrappers (`isSettled`, `isWaitingGate`, `nonTerminal`) and the `engine/constants.ts` re-export are gone. The guard test scans `sources/`, `cli/`, `federation/`, `scheduler.ts`, `app.ts` and `verdictWatcher.ts` too, and knows `i` and `latest` as instance names.
  - Instances on disk as `failed` with a `retryAt`: **0** on this machine (2026-10-13), so no migration; the CHANGELOG note stands.
- **Not changed, adjacent:**
  - `currentPhaseIndex` after revise/retry/remediation still points at the restarted phase, not the waiting gate. Nothing selects a gate by it (`pausedPhase` searches the phases); only `notify.ts` reads it, on failure.
  - `argus tail` prints no line when a second gate opens on an instance already waiting.
  - An orphan that carries a snapshot can still be approved through the API. That is the snapshot contract, pinned by `pipelineEngine.test.ts` "deleting the definition under a running instance leaves the instance able to finish". The board hides the gate on orphans, auto-approval skips them, and an orphan with no snapshot is refused (404) before anything is recorded.
    **Branch:** `fix/gate-state-guards`

**Why.** WS1 made it legal for an instance to read `awaiting-approval` while sibling phases keep running. Every path that asks "is this instance running?" was then fixed one at a time: WS1a signals, WS1b `concludeUnlaunchable`, WS2 `failStep`/`adopt`, `fa470ed` the stall pass. The inventory at `39b58dc` (every instance-level status check in `server/src`) shows the root cause is not the guards but the **status itself**:

- **Masking.** `settle` derives the status: `awaiting-approval` if any phase waits at a gate, else `running` (`pipelineTransitions.ts:424-426`). Four transitions instead write `inst.status = "running"` unconditionally, which hides a sibling's waiting gate until the next `settle`:
  - `applyRevise` (`:1328`)
  - `applyRemediation` (`:1417`)
  - `applyRetry` (`:1506`)
  - `scheduleRetry` (`:1604`)
- **False `failed` with a pending retry.** `instanceOutcome` (`sources/dag.ts`) ignores `retryAt`. With nothing else live, a phase that failed with a retry pending turns the instance `failed`. Then `onFailure` fires, `instance.ended` is journaled and `store.ts` cleans the worktrees, all before `applyRetry` revives the instance. This is why `runDueRetries` (`engine/failure.ts:242`) accepts `failed`.
- **Retry stalls behind a gate.** `runDueRetries` skips `awaiting-approval`, so a due retry waits for a human gate decision. Adding `awaiting-approval` there alone is not enough, because `applyRetry` would then mask the gate.
- **Consumers that read the masked status:**
  - `verdictWatcher.ts:214` misses a masked gate for auto-approval.
  - `reconcile.ts:283` `paused` reads false, so orphan heals and check re-queues run while a gate waits.
  - Display counts undercount gates: `sources/briefing.ts:75`, `palette.ts:94`, `insight.ts:60`, `cli/tailCore.ts:525/820/853`, `federation/summary.ts:161`.

**Plan.**

1. **Predicates in a non-engine module** (`server/src/sources/instanceStatus.ts`). The boundaries rules bar app, scheduler, sources and federation from `engine/constants`, and bar `pipelineTransitions` from the engine. `engine/constants.ts` re-exports `resumable`.
   - `resumable(s)`
   - `isTerminal(s)`: replaces `harness/memory` SETTLED, reliability `isSettled`, tailCore `TERMINAL_INSTANCE`, and the gates abort guards.
   - `liveStatus(inst)`: the single derivation used by `settle` and all four transitions.
   - `pendingRetry(inst)`: counted as live in `instanceOutcome`, so the instance stays `running`/`awaiting-approval` instead of going falsely `failed`. `runDueRetries` then filters on `resumable` alone.
   - `hasWaitingGate(inst)`: phase-derived, used by verdictWatcher and the display counts.
   - `appliesResults(s)`: names the "results wait for the gate decision" policy at `verification.ts:151/262` and `reconcile.ts:283/544`.
2. **Replace the inline spellings** of `running || awaiting-approval` with these predicates. Sites:
   - `app.ts:1247,1424`
   - `engine/launch.ts:943,990,1341,1404`
   - `signals.ts:104`, `store.ts:30`, `reconcile.ts:538,561,565`
   - `scheduler.ts:517`
   - `sources/omnibar.ts:88,213`, `overview.ts:87`
   - `federation/summary.ts:79`
3. **Guard test** (`engine/instanceStatus.test.ts`, in the style of `boundaries.test.ts`):
   - flags raw instance-status comparisons in `engine/`, with an allowlist of file + line + reason;
   - flags any `inst.status = "running"` write in `pipelineTransitions.ts` outside `settle`/`initInstance`. A read-only regex alone would not have caught this class.
4. **Behavioural tests, written first and shown failing on `39b58dc`.** Use three-phase fixtures: a two-phase one passes for the wrong reason, because masking lets `failure.ts:242` accept the instance.
   - **Status 2026-10-12:** written in `pipelineEngineHarness.test.ts` (section "WS14"), stashed as "ws14 red tests" in the original checkout (the handoff says how to restore them), and failing on `75deb5f` for the intended reasons: (1) `running` after the retry is scheduled beside B's gate; (2) `onFailure` fires once while A's retry is pending; (3) `running` after revising G1 while G2 waits.
   1. A is retryable and fails by a **stall** (`retryOn: ["timeout"]`), B is gated, C completes. A failed check would not do: check results wait for a pending gate decision. A relaunches at `retryAt`, and the instance still reads `awaiting-approval`.
   2. A's retry is pending, B is approved, nothing else is live. No `onFailure`, the worktree is kept, and A relaunches.
   3. Two parallel gates, revise one. The instance stays `awaiting-approval`, and verdictWatcher still sees the other gate.
   - Plus: a `reconcile.ts:538` case (two orphaned siblings, the first heal gates) to decide whether the loop's current behaviour is intended.
5. **Instances whose pipeline was deleted** (added 2026-10-13, found through orphan `48fab3f6`).
   - **How it happens.** `DELETE /api/pipelines/:id` (`app.ts:1290`) does not check for live instances, so deleting a pipeline can leave an instance stuck as `running` or `awaiting-approval`.
   - **Why it's stuck.** `buildOverview` (`sources/overview.ts`) only builds entries from the definitions, so the instance has no card and no abort button. Yet `insight.ts:72` `gatesWaiting` still counts it: the "awaiting you" chip shows 1 and links to nothing. The abort route itself works without the definition (`engine/gates.ts` `abort`).
   - **The fix:**
     - deleting a pipeline with live instances is refused with 409, or aborts them first (the user decides which);
     - non-terminal instances with no definition appear on the board with an abort control;
     - the counts and the board agree, using the `hasWaitingGate` predicate from step 1.
   - **Tests:** deleting a pipeline with a live instance; an orphan instance appears in the overview and can be aborted; `gatesWaiting` matches what the board shows.

**Registry (WS4 backfill):** this changes outcomes. A pending retry no longer ends the instance as `failed` (no spurious `onFailure`, `instance.ended`, `after:failed` chain or worktree cleanup), and auto-approval sees gates sooner. Add an entry next to WS2's and the stall-at-gate one.

Docs: HARNESS.md (instance status derivation), ARCHITECTURE.md if it describes instance status, CHANGELOG "Fixed".
**Not in scope:** the phase-level equivalents (`dag.ts:319` `livePhases`, `gates.ts:686`, `pipelineTransitions.ts:1442,1690`) unless a test shows the same gap.

---

## WS3 — Pinned release, state lock, build id

**Status:** ⬜ not started

1. **New `bin/lib/buildTarget.mjs` plus a `.d.mts`.** Testable without a build, like `hooks/argus-signal.mjs`.
   - `releasesRoot(env)` → `~/.claude-argus/releases`, mirroring `argusWorkRoot()`.
   - `readPointer()`.
   - `resolveBuildRoot()` accepts only a directory that has a `release.json`.
2. **`bin/argus.mjs`.**
   - Every spawn and cwd uses the resolved build root (`:158-162`, `:171-175`, `:191-195`).
   - `--dev` forces the checkout, and the dev path prints a WARNING.
   - `release` always runs the checkout's `cli/release.js`.
3. **`argus release [--ref <ref>] | --list | --use <id>`** (`cli/releaseCore.ts` plus `cli/release.ts`, pure core plus injectable `Io`):
   1. resolve the commit;
   2. `git archive | tar -x` **in place** into `releases/<version>-<sha7>/`. npm's workspace links are absolute, so the folder can never be moved afterwards;
   3. `npm ci && npm run build`;
   4. smoke-check `dist`, `web/dist`, `hooks/` and `.claude/skills/`, and that `version.js` imports;
   5. write `release.json` last, then `current.json` via tmp+rename.

   It warns that uncommitted changes are excluded. It never deletes old releases, because per-run hook commands embed their path.

4. **`server/src/buildInfo.ts`.**
   - `/api/health` (`app.ts:324-332` at `39b58dc`; it already returns `claudeHome` and `codexHome`) gains `build {kind, sha, dir, id?}`, and the contract gets an optional `HealthResponse.build`.
   - A dev build logs a warning.
5. **`server/src/stateLock.ts`.**
   - `paths.argus()/server.lock` is created with `wx` and holds `{pid, port, build, startedAt}`.
   - It counts as held when the pid is alive and either the lock is younger than 60 s or `/api/health` on that port reports the same `claudeHome`.
   - `index.ts` acquires it before the engine, scheduler and setup start, and releases it in `shutdown()`.
   - It refuses any second server on the same state directory.

Hooks need no code change: the running build copies its own `hooks/`.

Tests: `cli/buildTarget.test.ts`, `cli/releaseCore.test.ts`, `cli/release.test.ts` (fake `Io` plus one real `git archive`), `stateLock.test.ts`, `buildInfo.test.ts`, and the health shape in `app.test.ts`.

Manual checks:

1. `argus release`, then `argus`: health shows a release build.
2. `npm run dev` is refused while that server runs.
3. `--use <previous>` rolls back.

Docs: RELEASING.md, README, USER-GUIDE.md, API.md, CHANGELOG.

**Re-baseline (2026-10-12, `39b58dc`).** All the plan's references are still valid except the `app.ts` health line (fixed above).

- **Spawn sites the plan misses in `bin/argus.mjs`:**
  - `version()` (`:94-96`), the `run()` cwd (`:101-105`) and `ensureBuilt` (`:110-120`). A release directory is never `npm ci`'d or rebuilt by the launcher.
  - `tail`/`approve`/`revise` bypass `parseArgs` (`:156`, `:167`), so `--dev` must be handled there too.
  - Update HELP (`:18-49`).
- **Paths.**
  - The CLI lives in `server/src/cli/` (it compiles to `server/dist/cli/`).
  - `bin/lib/*.mjs` tests go in `server/src/cli/buildTarget.test.ts` and import `../../../bin/lib/…`, as `hooks.test.ts` does. `bin/` is not linted by any workspace.
  - `releasesRoot` must re-implement `argusWorkRoot`'s three env rules (`claudeHome.ts:30-35`). Consider a sibling folder rather than placing code under the work root, which `configuration.md:113` labels "Agent writable outputs".
- **(adopted) `git archive`.** `experiments/` is tracked (about 107 files). Add `export-ignore` for it in `.gitattributes`, so releases don't carry it.
- **Hooks.** Setup copies the running build's hook over the shared `~/.claude/hooks/argus-signal.mjs` (`setup/prereqs.ts:88,121-124`), so switching releases rewrites the global hook copy. Per-run invocations embed the build's own `hooks/` (`harness/invocation.ts:73,82-85`), which is why old releases are never pruned.
  - Before relying on that: on this machine, `~/.claude/settings.json` points at the global hook path. Confirm which path per-run settings actually embed.
- **State lock.**
  - `mkdir -p paths.argus()` before the `wx` create; setup only creates it later (`prereqs.ts:109-113`).
  - Acquire it in `index.ts` between `:76` and `:91`, before the tailer, experiments (`:123`), fleet poller, engine (`:93`), scheduler (`:409`) and setup (`:165-190`).
  - Release it in `shutdown()` (`:444-462`) **and** on the listen-error `process.exit(1)` path (~`:477`).
  - Health is token-gated: the probe always sends `ARGUS_TOKEN`, and a 401 from a live pid counts as held (decision 4). Ask what a missing token does.
  - Don't import a bare `process` in `stateLock.ts`; it hangs under tsx watch on Windows.
- **The lock now also guards the Decision Ledger.** Its state lives under `paths.argus()`: `decisions/`, `decision-experiments/{h1,h2}`, `decision-provider-cwd`. It is guarded only by in-process mutexes (`decision/journal.ts:460`, `h2/ledger.ts:433`), so `server.lock` becomes its only cross-process guard.
  - **Out-of-process writers bypass any server lock:** the experiment scripts (e.g. `bound-pipeline.mjs` calling `updatePipeline` from dist, and `pipeline-cleanup-20261010/cleanup.mjs`). Document "use the API while a server runs"; the lock covers servers only.
- **Real motivation.** The decision-ledger collector ran from an unregistered ad-hoc copy (`.worktrees/argus-local`) that was later deleted. Its scripts (`start-collector.ps1:3`, `bound-pipeline.mjs:2-3`, `refresh-evidence.mjs:3-9`) still hardcode that path. Its duplicate-server guard probes only the port (`start-collector.ps1:5-15`).
  - (adopted) Add a manual check: a second server on **another port** with the same state directory is refused.
- **(adopted) Rollback (`--use`) can hide data.** An older build reads a newer knowledge ledger as empty (`knowledge/store.ts:196-205`). Add this to manual check 3 and to RELEASING.md.
- **Docs after the reorg:**
  - launcher and build identity: `docs/reference/operations.md:7-22` (line 15 "does not compare source timestamps" becomes stale);
  - start, stop and rebuild: `docs/getting-started/README.md:42-75,131-141`;
  - CLI: `docs/guides/terminal.md`;
  - storage: `reference/configuration.md:100-113` and `operations.md:156-169` (add `releases/` and `server.lock`);
  - API.md health at `:65-75` (a stale duplicate sits at `:317-321`);
  - `docs/RELEASING.md` (unmoved).
  - Clarify how `argus release`'s `<version>-<sha7>` folders relate to the RELEASING.md tag procedure (decision 2: `v0.5.0` is cut by hand before WS14).

**DENIED:**

- auto-pruning releases (in-flight runs reference them);
- running the test suite inside `release` (RELEASING.md already requires a green `main`).

---

## WS4 — `contractVersion`, behaviour-change registry, `argus pipeline upgrade`

**Status:** ⬜ not started

1. **Contracts.** `PipelineDefinition.contractVersion?: number` (absent = 0) and `PendingBehaviourChange {id, since, title, detail, phases}`.
2. **New `server/src/sources/behaviourChanges.ts`.**
   - `BEHAVIOUR_CHANGES`, with `CONTRACT_VERSION = max(since)`: adding a change is one appended entry, like `LEDGER_VERSION`.
   - `contractVersionOf(def)` and `pendingChanges(def)`.
   - Backfilled entries:
     - **v1 `work-root-moved`:** a prompt, check, cwd or `additionalDirectories` that names `.claude/argus/{results,artifacts,worktrees,memory}`.
     - **v2 `duplicate-claim-refusal`:** discovery or `knowledgeDelta` phases.
     - **v3 `completion-marker-required`:** neither the phase nor the pipeline sets `completion.marker`.
     - **v3 `retry-unverified`:** `attempts > 1`, and an explicit `retryOn` includes `exit-code` but not `unverified`.
     - **v4 `read-only-enforced`** (WS2): any `filesystem: "read-only"` phase.
     - _(re-baseline, entries to add; final numbering is set when WS4 is built)_:
       - **`stall-at-gate`** (`fa470ed`): any phase with `stallSeconds` in a pipeline with a gated phase.
       - **`instance-status-derived`** (WS14): a pending retry no longer ends the instance as `failed`; a due retry runs beside a waiting gate; auto-approval sees a gate a transition used to mask; check and candidate results beside a waiting gate wait for the decision; recovery stops healing at a gate it opened. Suggested match (settle when WS4 is built): any phase with `retry`, or a gated phase in a pipeline with parallel phases. Also: instances already on disk as `failed` with a `retryAt` are no longer revived, and `DELETE /api/pipelines/:id` aborts live instances (author-visible, not definition-matched).
       - **`codex-read-only-isolation`** (`821d047`; adopted, decision 3): Codex `filesystem: "read-only"` phases run without hooks, MCP or web search, with an env allowlist.
     - _(re-baseline)_ v1's match list is both too narrow and too broad:
       - **too narrow:** CHANGELOG `:596-603` also moved `knowledge-deltas`, `rule-verifications`, `change-proposals` and `acceptance-verifications` (`claudeHome.ts:88-101`);
       - **too broad:** `sources/runs.ts:60` still writes `paths.argus()/results/<id>.json`, so a bare `.claude/argus/results` match gives false positives. Narrow it.
3. **`sources/pipelines.ts`.**
   - `createPipeline` stamps `CONTRACT_VERSION`.
   - A new `upgradePipelineContract` follows `rotatePipelineHookToken` and runs no validators, so a removed cwd doesn't block it. It stores `max(existing, current)`.
   - `updatePipeline` and `markPipelineStarted` already keep the field.
   - Request bodies cannot set it.
4. **`app.ts`.**
   - `GET /api/pipelines` adds `pending: {[id]: PendingBehaviourChange[]}` as a sibling key, so the stored shape is untouched.
   - New `POST /api/pipelines/:id/upgrade`, admin-only. It broadcasts `pipelines:changed`.
5. **CLI.**
   - Extract the login/logout flow from `gate.ts:46-137` and `gateCore.ts:172-252` into `cli/adminSession.ts` and `adminSessionCore.ts`; the existing gate tests must pass unchanged.
   - New `cli/pipelineCore.ts` and `cli/pipeline.ts` with `upgrade <id>`.
   - `bin/argus.mjs` dispatches `pipeline`.
6. **Web.**
   - `usePipelines.ts` reads `pending`.
   - `Pipelines.tsx` PipelineCard gets an amber "N changes" chip next to "paused" (`:133-140`). It expands into a list styled like GateDrawer's warnings (`:357-369` at `39b58dc`): title, `since vN`, affected phases, and the `argus pipeline upgrade` command. It stays in lazily loaded code (the bundle budget).

**Re-baseline (2026-10-12, `39b58dc`).** All other references are still valid.

- **Naming.** Avoid the word "registry" in code: `decision/registry.ts` (`DecisionRegistry`) already uses it. Suggested: `behaviourChanges` / `BEHAVIOUR_CHANGES`, as already planned.
- **CLI.** WS4 creates the `pipeline` dispatcher in `bin/argus.mjs` (`:156-180`) and `server/src/cli/pipelineCore.ts`; WS9 adds `doctor` to it. Split `explainRefusal` (`gateCore.ts:229-257`) when extracting the login flow.
- **Absent means 0 is intended.** Out-of-band writers (`pipeline-cleanup-20261010/cleanup.mjs`) bypass `createPipeline` stamping, so their definitions show everything as pending; document that.
  - `experiments/decision-ledger-closeout-20261009/{baseline,definitions}/*.json` are real definitions, usable as `pendingChanges` fixtures.
- **Docs:** `docs/guides/pipelines.md:28-160` (was USER-GUIDE), API.md (admin list `:304-305`, `:442`), DATA-MODEL.md (new `pipelines.json` section), HARNESS.md, CHANGELOG.

Tests:

- `sources/behaviourChanges.test.ts`: unique ids, non-decreasing `since`, one fixture per entry, absent = 0.
- `sources/pipelines.test.ts`, `app.test.ts`, `cli/pipeline*.test.ts`, `usePipelines.test.tsx`, `views/Pipelines.test.tsx`.

Docs: API.md, a new `pipelines.json` section in DATA-MODEL.md, "Adding a behaviour change" in HARNESS.md, USER-GUIDE.md, CHANGELOG.

**DENIED:**

- wrapping `pipelines.json` in `{version, pipelines}`: older builds read a non-array as empty and overwrite it (`jsonArrayStore.ts:45`);
- version-dependent defaults;
- bumping the version on edit;
- a UI "mark reviewed" button (you chose the CLI).

---

## WS5 — Workspace and git reliability

**Status:** ⬜ not started
Files: `server/src/harness/workspace.ts`, `server/src/engine/store.ts`, `server/src/engine/launch.ts`, `server/src/engine/context.ts`.

1. **`runGit`** takes `{timeoutMs}` and returns `{code, stdout, stderr, timedOut, durationMs}`, keeping the last 64 KiB.
   - A pure `gitArgv(args, platform)` adds `-c core.longpaths=true` on win32.
   - On timeout it stops the whole process tree with `childTreeStopper` (`processTree.ts:163`). Today `worktree add` leaves an orphaned checkout child writing.
2. **Timeouts.** Queries keep 60 s. Add and remove use `ARGUS_WORKTREE_TIMEOUT_SECONDS`, default 600 (a full checkout takes about 5 min here).
3. **`describeGitFailure`** replaces `gitReason`:
   - it keeps the **tail** (last 400 characters) and drops `\r` progress segments;
   - it says "timed out after N s (process tree stopped)".
4. **Add flags.** `worktree add -q`, plus a `detach` option that creates no ref (WS9 uses it).
5. **Stricter reuse.** The branch must match and the index must exist; a checkout killed at 22% passes today's check.
6. **`reclaim`, by provenance only.**
   - It applies only to a path recorded on the instance, phase or step.
   - Sequence: unlock → `remove --force --force` → `rm` with retries → `prune` → add.
   - Without that provenance, a foreign directory is still refused (`workspace.test.ts:316`).
7. **Retry a timed-out add once:** reclaim, re-check the branch, add. Everything else still fails as `configuration`.
8. **Fix the cleanup race (`a6e64182`).**
   - `cleanups: Map<id,{cancelled, done}>` in `engine/context.ts`.
   - `saveInstance` registers and cancels removals.
   - `ensureWorkspace` awaits `done` before creating a tree.
   - Test seam: `EngineDeps.workspaces`.

Tests:

- `harness/workspace.test.ts`:
  - the output tail and the timeout wording;
  - `gitArgv`;
  - retry once, then an honest failure;
  - a leftover reclaimed only with provenance;
  - a tree on the wrong branch refused;
  - `detach` leaves no ref.
- `pipelineEngineHarness.test.ts`: a revise during a removal waits for it, then rebuilds the tree.

Docs: HARNESS.md, README config table, CHANGELOG "Fixed".

**Re-baseline (2026-10-12, `39b58dc`).** Every code reference is still valid; nothing WS5 touches changed.

- **`childTreeStopper` alone is not enough.** `runGit` spawns without `detached` (`workspace.ts:52`), so the POSIX group kill does nothing.
  - Spawn with `detached: platform !== "win32"`, pass `grouped`, and map `onAbandon` to a "tree not confirmed stopped" result (`processTree.ts:124-134`).
- **Unlock is mandatory.** git leaves a killed `worktree add` _locked_, and `prune` skips locked trees.
- **(adopted) Reclaim can destroy work.** A worktree in the salvage audit held 54 staged files. Limit reclaim to the retry after a timed-out add, or require an empty `git status --porcelain` first.
- **(adopted) Not covered yet: a run still holding files when its tree is removed.** `transitionLog/effects.ts:57ff` already models "owes a stop until its process is known gone". Cleanup should wait for owed stops before removing a tree.
- **The salvage folder is not evidence of Argus worktree failures.** `experiments/worktree-salvage-20261010` covers developer and Codex checkouts, not trees under `argusWorkRoot()/worktrees`.
  - Only partial support: test fixtures held retired directories (supports `rm` with retries), and a detached Codex checkout (the `detach` case).
  - `a6e64182` is an instance id; "about 5 min" and "22%" are audit evidence, not verifiable at HEAD.
- **Test-environment lesson (overnight 2026-10-11):** fixture temp inside a git checkout found the parent repo and tried to lock a real ref. New workspace tests create fixtures outside every repo and assert that.
- **Docs:** env var → `docs/reference/configuration.md` (~`:43ff`), `docs/guides/pipelines.md:167-185` ("Choose an isolated workspace"), HARNESS §11 (`:1486`).

**DENIED:** reclassifying a timed-out add as retryable (it stays `configuration` and gets one in-process retry).

---

## WS6 — Caps in the agent contracts, analysis cwd

**Status:** ⬜ not started

1. **Analysis spawns use a directory that exists.**
   - New `sources/directory.ts` with `firstExistingDirectory(...)`.
   - `autopsy.ts:297`, `verdict.ts:519`, `trajectoryVerdict.ts:189`, `diagnose.ts:122` and `tuning.ts:616` call `firstExistingDirectory(run.cwd, paths.argus(), os.homedir())`.
   - `sources/analysis.ts` `run()` refuses a missing cwd with a clear `spawn-failed`.
   - `harness/verification.ts:332-340` reuses `isDirectory`.
   - This fixes 15 of 27 failed post-mortems. They will not re-run on their own; re-run them on demand.
2. **Fix the 32/64 mismatch.** `changeIntent.ts` `list()` takes the kernel's per-section maxima (`UNRESOLVED_MAX` 32, …) instead of 64 everywhere, and imports `CHANGE_SUMMARY_MAX_CHARS` rather than redeclaring it.
3. **Interpolate the caps into the contract text at module load:**
   - `KNOWLEDGE_DELTA_CONTRACT`: 64 entries per section and per `premises`, 8000-character statements, "over any limit refuses the whole delta";
   - `RULE_VERIFICATION_CONTRACT` and `ACCEPTANCE_VERIFICATION_CONTRACT`: 32 evidence records;
   - `CHANGE_INTENT_CONTRACT`: the kernel caps.

   The strings stay constant, so caching is unaffected. `CONTEXT_MAX_CLAIMS` is documented for authors, not added to the contract.

4. **New `server/src/knowledge/limits.ts` exporting `AGENT_LIMITS`.** It is the single source the contracts, the doctor and the skill read.

Tests: `directory.test.ts`, `autopsy.test.ts`, `analysis.test.ts`, `changeIntent.test.ts`, `pipelineEngine.test.ts` (the contract carries the caps and no `{{`), and the knowledge suites.

Registry: **v5 `unresolved-cap-32-at-intake`**, which affects `changeIntent` phases (the number is tentative until WS4 lands).

**Re-baseline (2026-10-12, `39b58dc`).** All references are valid; the contract to edit is `KNOWLEDGE_DELTA_CONTRACT` in `engine/prompts.ts:35`.

- **The "refuses a missing cwd with `spawn-failed`" item conflicts with the Decision Ledger** (`sources/analysis.ts` gained a provenance layer).
  - `failed()` stamps `executionDisposition: "not-called"`.
  - `decision/providers/cli.ts:205-232` and `decision/service.ts:163-170` (`NO_CALL_GUARDS`) accept `not-called` only for a fixed set of failures; anything else becomes `invalid-execution-disposition`.
  - (adopted) Add a distinct `cwd-missing` to the `AnalysisFailure` union (`analysis.ts:66-78`) and to both whitelists. Test it in `analysis.test.ts`, `decision/claudeCli.test.ts` and `codexCli.test.ts`.
- **The fallback order** (decision 5): no `os.homedir()`; fall back to an Argus-owned directory that is always created, as `decision/definitions.ts:116-120` does.
- **(adopted) The directory check must be injectable** through `AnalysisRunnerDeps`. `analysis.test.ts:59` (`cwd: "/tmp"`) and `:327` (`cwd: ""`) use fake spawns and would fail a real check on Windows.
- **`AGENT_LIMITS` reaches the skill only through the running build** (the `--limits` endpoint/CLI) or `--repo` dist. Say which in WS10.
- **The Decision Ledger has its own caps.** `GATE_REVIEW_CAPS` (`decision/h1/definitions.ts:19`) and `RUN_FAILURE_CAPS` (`decision/projections/runFailure.ts:31`) truncate what Argus _feeds_ a decision model. They sit outside `AGENT_LIMITS` and do not contradict the "no truncation" denial; note that in the docs.

**DENIED:**

- truncating oversized deltas (lossy, orphans `{local}` references, contradicts KNOWLEDGE-LEDGER §12.10 "commits completely or not at all");
- chunked deltas (§12.8 allows one delta per run; that would be a channel-model change);
- raising the caps (they bound gate review and keep downstream contexts under 64).

---

## WS7 — Check-only phases

**Status:** ⬜ not started

1. **Validator (`sources/pipelines.ts` `validatePhase`).**
   - `steps: []` is valid only with at least one `command` or `file` check. Artifact, changed-files and trajectory checks need runs.
   - Allowed alongside it: `gated`, `needs`, `checks`, `retry`, `workspace`, `capabilities.env`.
   - Refused: `result`, `produces`, `completion`, `rubric`, `autoApprove`, `runtime`, timeouts, `candidates`, knowledge fields, `changeContext`, `implementation`.
2. **Transition.** `applyCheckOnlyLaunch` in `pipelineTransitions.ts` sets `verification: running` and returns `verify:[id]`. It is idempotent.
3. **Engine.** `startCheckOnlyPhase` in `engine/launch.ts` runs after the worktree exists: after the `ensureWorkspace` try/catch ends (~`:291` at `39b58dc`), before `artifactDir` is set (`:293`). It saves the instance, then calls `core.fns.queueVerifications`.
4. **Recovery.**
   - Remove the `steps.length===0` skip at `reconcile.ts:318` (was `:306`).
   - `transitionLog/effects.ts:33` owes a launch when no step has a run id and there is no verification yet.
5. **Web.** `PipelineForm.phaseProblem` (`:307`, the rule at `:310`) allows zero steps when there are checks, and the board labels such a phase "checks only".

Tests:

- `pipelines.test.ts`, `pipelineTransitions.test.ts`.
- `pipelineEngine.test.ts`, using `node -e` commands: pass → successors launch; gated → waits; fail → retried.
- `effectRecovery.test.ts` zero-step variants, `transitionLog.test.ts`, `PipelineForm.test.tsx`.

Docs: HARNESS.md §6, API.md (`steps` may be empty), USER-GUIDE.md, CHANGELOG.

**Re-baseline (2026-10-12, `39b58dc`).** References are fixed in place above.

- **(adopted) Naming collision.** "check-only" already means a rubric with a null score (`gatePolicy.ts:136`, `trajectoryVerdict.ts:137`). Use a distinct label in code and docs, e.g. "checks-only phase" or "stepless phase".
- **Decision Ledger H1 skips zero-step phases.** `decision/h1/gate.ts:74-75` returns `no-relevant-steps`, so a gated checks-only phase is silently left out of gate-review capture. Document it and add a test.
- **Docs:** HARNESS §6 (`:928`), API.md, `docs/guides/pipelines.md` (not USER-GUIDE), and the `guides/README.md` feature map.

---

## WS8 — The `no-work` outcome

**Status:** ⬜ not started

1. **Types (additive).**
   - `OutcomeMarkerKind` and `RunOutcome` gain `"no-work"`.
   - New `PhaseProgress.noWork?:{reason, at}` and `PipelineInstance.noWork?:{phases}`.
   - `PhaseStatus` and `InstanceStatus` are **not** widened.
2. **Classifier.**
   - `MARKER_RE` gains `no-work`, and the text after it becomes the reason.
   - `decideCompletion` accepts it under both policies.
   - The hook copy's regex changes too, with `HOOK_VERSION` going from 2 to 3. WS1 doesn't bump it.
   - A v2 hook that read `missing` counts as agreeing with `no-work`.
3. **Refused (class `signal`) on accountable phases:** discovery, rule or acceptance verification, change intent, implementation, `knowledgeDelta:"required"` and candidates phases.
4. **Run-record path.** `recoverRunOutcome` handles `no-work` the same way.
5. **DAG.** `dag.ts` `noWorkShadow`: every edge from a no-work phase, or from anything it shadows, is `routed-out`, overriding `when` and `allowSkipped`. A join therefore skips even when its other branch did work, which matches "every downstream phase is skipped".
6. **Transitions.**
   - The phase is no-work only when **all** its steps report it; otherwise no-work steps count as succeeded.
   - Result validation, rubric, gate and `produces` are skipped. **Checks still run.** Artifact and changed-files `requireChanges` checks become `not-evaluated`.
   - `recordRouteDecisions` skips no-work phases.
   - `restartPhase` and `applyRemediation` clear `noWork`.
   - `settle` labels the instance.
7. **Engine.**
   - `acceptNoWork` refuses a non-empty delta, verification, proposal or acceptance file (class `unverified`), and ignores result and artifacts.
   - It is wired into both `signals.ts` and `reconcile.ts`.
   - The journal reason reads "upstream phase reported no work".
   - `OUTCOME_CONTRACT` gains one constant sentence.
8. **Watchers.**
   - `verdictWatcher.ts` skips no-work runs.
   - `watchtower.ts` excludes them from the baseline and from anomalies.
   - `cli/tailCore.ts` shows "(no work)".
9. **Chains.** `afterMatches` (`scheduler.ts:513-523`) fires a no-work instance only for `on: "any"`, and the payload gains `noWork`. **APPROVED:** an `on: "succeeded"` chain means "the work happened".
10. **Web.** A `ds/NoWorkBadge` on CommandCenter rows and on PipelineCard; `overviewRow.ts` adds the skip cause "no work upstream".

Tests: `completion.test.ts` (corpus, older-hook rule, refusals), `hooks.test.ts`, `completionEngine.test.ts`, `dag.test.ts`, `pipelineTransitions.test.ts`, `verdictWatcher.test.ts`, `watchtower.test.ts`, `scheduler` chain tests, web row tests.

Docs: HARNESS.md §2, API.md, USER-GUIDE.md, CHANGELOG. No registry entry (additive).

**Re-baseline (2026-10-12, `39b58dc`).** All references are valid. Nothing WS8 touches changed, and the Decision Ledger has no outcome overlap: "outcome routing" is the older DAG `when` feature.

- **(adopted) Dependencies.** WS4 is dropped (no registry entry, as stated above). WS14 is added, because both change `settle`/`instanceOutcome`.
- **Missing site: the run outcome on signals.** `engine/signals.ts:171-178` hard-codes the run outcome to `"succeeded"` on every completed signal. It must patch `"no-work"`, or the watchers and run consumers never see it.
- **More type sites:**
  - the literal unions at `web/src/ds/status.ts:62` and `server/src/vault/query.ts:499,526`;
  - `MARKER_KINDS` (`harness/completion.ts:98`) and the `found` unions (`:34`, `:51`).
- **Hook.** Only `MARKER_RE` (`hooks/argus-signal.mjs:63`) changes. `OUTCOME_RE` (`:51`, which emits the failure signal) must not match `no-work`. Update `argus-signal.d.mts:18` too.
  - The v2-hook rule only matters for runs without a capability profile: invocation hooks run the build's copy (`harness/invocation.ts:82`).
- **Parity test location.** The corpus test lives in `server/src/harness/completion.test.ts`, not `hooks.test.ts`.
- **Codex and OpenCode** rely only on `recoverRunOutcome` (`outcomeFromRecord: true`, `codex.ts:532`, `opencode.ts:347`). So does a Codex read-only step since `821d047` (hooks are off; decision 3).
- **Wording.** "`artifact` checks, and `changed-files` checks with `requireChanges`" become `not-evaluated`; `requireChanges` exists only on `changed-files`.
- **(adopted) Other `RunOutcome` consumers** (`issues.ts:40-47`, `autopsy.ts:130`, `recorder.ts:195,435`, `chronicle.ts:38`, `insight.ts:150`, `monitors.ts:52`, `vault/otel.ts:56`, `federation/summary.ts:115,163`) test for failed/blocked explicitly, so `no-work` falls through as a success. Review each.
- **(adopted) Decision Ledger H2 sampling** (`decision/observations.ts:53`, `h2/sampling.ts:81,89`) would count no-work runs as successes. Exclude them, as for verdict and watchtower. H1 never sees them: a no-work phase skips its gate.
- **Paths:** `PipelineCard` is in `web/src/views/Pipelines.tsx`; `overviewRow` is `web/src/ds/overviewRow.ts` (`skipCause` `:115`, `:383`).
  - The badge needs the bundle-size check: keep it out of the eager path.
- **Docs:** HARNESS §2 (`:139`), `docs/guides/pipelines.md` (completion text `:131-141`), `reference/glossary.md:23`, `reference/runtimes.md:32,122`, API.md, the feature map.

---

## WS9 — `argus pipeline doctor` (launch simulation)

**Status:** ⬜ not started
It is named `doctor` because "check" already means phase checks, and "preflight" is taken by setup.

1. **`contracts/src/doctor.ts`:** `DoctorFinding {lint, severity, phaseId?, message, fix?}`, `DoctorProbeResult` and `DoctorReport`.
2. **`sources/doctor.ts`: a pure `lintPipeline(def, ctx)`.** It is importable from `dist`, so the skill can use it without a server. Lints:
   - `fan-out`: info level after WS1. Phases queue; it reports the number of waves.
   - `reply-form`: reply-dictating phrases under the `required` policy without "outcome line".
   - `context-cap`: explicit claims plus `claimsProducedByPhase` from the last accepted instance, above 64.
   - `chained-discovery`.
   - `channels`: resolved through the runtime's own `streamPlan` and `settleChannels`.
   - `overlap-allow`: a trigger is set and a phase writes to a shared cwd, or uses memory or knowledge.
   - `behaviour-changes`: from `pendingChanges`.
   - `cwd-missing`.
   - `no-work-misuse`: an accountable phase whose prompt mentions no-work.
3. **`sources/doctorProbes.ts` plus `doctorStore.ts`** (`doctor.json`, keeps 50):
   - **worktree:** a detached scratch tree under `worktreesDir()/_doctor/<uuid>`; timed, warned above 50% of the timeout, then removed;
   - **checks:** every `command` check in that tree, with `checkEnvFor()` extracted from `engine/verification.ts:139/256`. A failure is phrased "may expect the agent's work";
   - **agent:** opt-in, shipped last. One one-turn cheap-model probe per distinct capability profile. It writes a nonce to each channel, is spend-gated and recorded, and sets no `ARGUS_SIGNAL_URL`.
4. **Routes.**
   - `GET /api/pipelines/:id/doctor` (open): lints plus the latest probe report.
   - `POST /api/pipelines/:id/doctor` (admin, `{probes}`): 202 plus a background pass, 409 while one runs, broadcasts `doctor:changed`.
   - `POST /api/doctor` (admin, `{pipeline, probes?}`, for an unsaved body).
   - `GET /api/doctor/:reportId`.
5. **CLI.** `argus pipeline doctor <id> | --file body.json [--probe worktree,checks,agent] [--json]`. It exits 1 on an error finding or a failed probe.

Tests:

- `sources/doctor.test.ts`: one case per lint, plus fixtures shaped like `a6e64182` and the discovery pipeline's preflight.
- `doctorProbes.test.ts`: real git, no ref left behind, a cwd escape refused, the agent probe with an injected spawn.
- `app.test.ts`, `cli/pipelineCore.test.ts`, plus a parity test: the doctor's channel kinds equal `prepared.record.channels`.

Docs: API.md, USER-GUIDE.md, HARNESS.md, CHANGELOG.

**Re-baseline (2026-10-12, `39b58dc`).** Nothing doctor-like exists; `/tune` is model-driven advice, so it only shares the route and store pattern.

- **`lintPipeline` is no longer side-effect free for Codex.** `readOnlyConfig` (`runtimes/codex.ts:94-117`, used at `:178`) reads `~/.codex/config.toml` and throws on `ARGUS_CODEX_ARGS` (`:126`).
  - The `channels` lint catches these and reports them as findings.
  - (adopted) Add a `codex-args-readonly` lint.
  - Resolve channels through `prepareInvocation` (`harness/invocation.ts:211`): it gives parity with `prepared.record.channels` by construction.
- **Wiring.**
  - `behaviour-changes` is the only hard WS4 coupling; make it conditional on WS4.
  - Import `CONTEXT_MAX_CLAIMS` (`knowledge/context.ts:103`) rather than a literal 64.
  - Build `doctorStore` on `sources/jsonArrayStore.ts`, as tuning does.
  - Add `doctor:changed` to the `contracts/src/live.ts:25-37` union.
  - Register routes with `app.on(["POST"], …)`, following the tune routes (`app.ts:496`, `:1341-1380`).
  - The admin block is at `app.ts:484-516`.
- **(adopted) Probe and canary runs become ordinary Run records.** Watchtower, Issues, Autopsy and Decision Ledger H2 sampling would ingest them. Tag their origin and exclude them.
- **(adopted) Model compatibility.** The closeout's only failure was Codex rejecting an inherited model (`gpt-6.1-sol`). Add a runtime/model compatibility lint.
- **Docs:** `docs/guides/pipelines.md` and `docs/guides/terminal.md` (CLI), the feature map, and an AGENT-GUIDE.md "Author a pipeline" row.

---

## WS10 — Skill: close the loop, start minimal

**Status:** ⬜ not started
Files: `~/.claude/skills/argus-pipeline/` (not under git; I list every changed file).

1. **`argus-pipeline.mjs`:**
   - `--doctor`: a static lint run during the dry run. It prefers `POST /api/doctor` on the **running** build and falls back to `lintPipeline` from `--repo` dist, labelled as such.
   - `--doctor --probe worktree,checks[,agent]`: polls until the pass settles.
   - `--limits`: prints `AGENT_LIMITS` and `CONTRACT_VERSION` from the running build.
   - `--canary <phaseId>`: a temporary copy of that phase plus its ancestors, with every phase `gated: true`. It starts, waits for a gate or a failure, reports the staged preview, results and checks, then aborts and deletes the copy. Nothing reaches the ledger.
2. **SKILL.md.** "Ready" means: dry run plus doctor clean → probes clean → canary clean. §7 and §9 are rewritten, and §9 gains the **write-back rule**: a root cause found while repairing updates the skill in the same session.
3. **Start minimal.**
   - Agent-only preflights are replaced by check-only phases; archetype L is rewritten.
   - No context chaining.
   - `overlapPolicy: skip` for resource claimers.
   - `no-work` for empty queues.
   - The repo's own test command, smoke-tested by probes.
   - On builds at or above WS2's version, the Write/printenv recipe is marked legacy.
4. **schema.md and runtime.md** cite `--limits` and the registry instead of hard-coded numbers. They also document `no-work`, check-only phases, the doctor and the release build.

Verification: the dry run plus doctor against both existing pipelines' bodies reproduces their known hazards. Then run `--canary` on the discovery pipeline's smallest slice.

**Re-baseline (2026-10-12).** The skill (`~/.claude/skills/argus-pipeline/`) has not changed since 2026-10-08. A stale `argus-pipeline.zip` sits beside it.

- **`--canary`'s "Nothing reaches the ledger" conflicts with the Decision Ledger.** The H1 collector captures every open `awaiting-approval` gate (`decision/h1/watcher.ts:484-492`) when `ARGUS_DECISIONS=on` and `ARGUS_DECISIONS_H1_COLLECT=on`, and may spend provider budget.
  - Write "no Knowledge **or Decision** Ledger entries".
  - (adopted) Either exclude canary instances in H1, or refuse `--canary` while H1 collection is on.
- **"On builds at or above WS2's version" has no version to compare.** WS2 is under `[Unreleased]`, and the package is still 0.4.0. Tie it to WS3's build id, or mark the recipe legacy outright.
  - Sites: SKILL.md `:61`, `:125`; archetypes.md `:16`, `:27`, `:41`, `:45`, `:113`, `:134`, `:141`, `:161`, `:175`; knowledge-ledger.md `:107`, `:230`; runtime.md `:74-76`.
- **Hard-coded numbers** also sit in `knowledge-ledger.md:68` ("≤ 64"), as well as `schema.md:37-38` and `runtime.md:28`.
- **Scope.** The live store has a third, disabled probe definition; it is out of scope (decision 6).

---

## WS11 — Rework the existing pipelines

**Status:** ⬜ not started
Uses `argus-pipeline.mjs --update`, after backing up `pipelines.json`.

**P1, the discovery pipeline (8-slice fan-out):**

- `preflight` becomes a check-only phase: closure check only, no Haiku step, no `lenient`.
- Drop `Write`, `Bash(printenv:*)` and the "Output files…printenv" prompt line; WS2 auto-grants them.
- Drop "at most 55 claims"; WS6 puts the cap in the contract.
- Keep `retryOn` and the determinism lines.
- Each slice gets `knowledgeContext.claims` with its own committed claims from `ebe85a30` (≤ 64 each, verified), plus "revise, never restate".
- Then: `pipeline upgrade` → doctor plus probes → canary → full run.

**P2, the implement→PR workflow:**

- The claim phase ends with `ARGUS_OUTCOME: no-work` when nothing fits, and `overlapPolicy` becomes `skip`.
- Doctor probes smoke-test its checks.
- **I ask you before setting `enabled: true`:** it claims real tickets and opens PRs.

**Re-baseline (2026-10-12).** Live state on this machine (`~/.claude/argus/pipelines.json`, read-only) shows both definitions unchanged since 2026-10-08.

- **P1** `de8a7cc1` is enabled and manual, `overlapPolicy: skip`. Its preflight is still a Haiku step with "lenient". All 8 slices still carry "55 claims" and `printenv`, with no `knowledgeContext` and no `contractVersion`, so every WS11 target is still present.
- **P2** `051a0f0e` is disabled, windowed weekdays 07-15, `overlapPolicy: allow`.
- **The `pipeline-cleanup-20261010` experiment does not apply here.** It emptied a store on another machine (20 experiment definitions, neither of these pipelines).
- **`ebe85a30` is still a valid reference.** It succeeded on 2026-10-08, after P1's last edit, and has 8 deltas of 49-55 claims each (427 in all).
  - 4 slices sat exactly at 55, so the prompt cap was the binding limit. Once WS6 drops "55", slices can reach 64 and trip the doctor's `context-cap` lint. Recheck net claims after revisions.
  - In that run, 4 slices failed at attempt 0 with "run ended without emitting a completion signal": the WS1 race, now fixed.
- **Before the live run:** orphan instance `48fab3f6` is aborted (decision 6). The third, disabled probe definition is out of scope.
- **Environment for the live proof:** not inside a network-restricted sandbox. The overnight run showed hook and transport tests failing on sandboxed sockets.

---

## WS12 — Process

**Status:** ⬜ not started

- **Rotate the two credentials** flagged in the audit (the user's action, outside the repo). Keep `ARGUS_*` in the profile only.
- **Soak (narrowed, decision 1).** No new top-level `server/src/` directory and no new `/api/` route family until the discovery pipeline (P1) and one implement→PR pipeline each run 10 times clean on Windows from a release build. Work inside existing subsystems, including the Decision Ledger, continues. Make the Windows CI job a required check (a repository setting).
- **Release after every merged workstream.** Keep `[Unreleased]` to one feature-sized entry (RELEASING.md).
- _(re-baseline)_ The release rule restarts with `v0.5.0` (decisions 2 and 3). Process additions (adopted, decision 8):
  - **Worktree hygiene.** On 2026-10-10, dev work sat in 6 checkouts across three roots, and the server ran from an unregistered copy (`experiments/worktree-salvage-20261010/audit.json`).
  - **A CHANGELOG check at merge.** The 12 commits after `fa470ed` added no entries.
  - **The suite needs a writable temp outside any sandbox** (EPERM on rename in the overnight run).
  - **`app.test.ts` sits near the 120 s per-file timebox** under load. Split it before WS3, WS4 and WS9 add routes.

---

## WS13 — `~/.claude.json` race under parallel sessions

**Status:** ⬜ not started (added 2026-10-09, from the WS2 probes)

The WS2 probes showed that concurrent `claude -p` sessions can read `~/.claude.json` mid-write and report it corrupted, although the file itself stays intact (HARNESS.md, end of the "Rule paths, as probed" part of §3). A fan-out phase launches its steps exactly that way.

1. **Reproduce first.** Launch N parallel `claude -p` sessions (N = the discovery pipeline's fan-out of 8) with a trivial prompt, several times over. Record how often it happens, the exact error text, the exit code, and whether the run still does its work or dies before its first turn. Also check what an Argus step sees: its exit code, its log, and its failure class.
2. **Then decide.** Options only, not a choice. You pick after the repro:
   - **Launch stagger:** a small gap between spawns in one fan-out. Cheap, but it only narrows the window.
   - **Classify and retry:** recognize the "corrupted" error at startup as a `spawn`-class failure and retry once. Needs the exact error text from step 1.
   - **Per-run config isolation:** a per-run `CLAUDE_CONFIG_DIR`. It closes the race, but it touches auth and user-scope settings, so it needs probes of its own.
3. Tests and docs follow the chosen option. A HARNESS.md note replaces the current one-line warning.

Needs a real CLI, so it is **ready for verification** only, never "done". Run the probes sequentially with each other, and never alongside another `claude -p` probe.

**Re-baseline (2026-10-12).** None of the new evidence settles it either way. The closeout cases were staggered two minutes apart, and the shadow feeder has one step, so nothing ran a parallel fan-out. The repro is still required.

## Not doing unless you ask

Stale API.md lines: the admin-route list (`:303-306` at `39b58dc`) omits tune, autopsy and others, and still says "create the admin" although the auth model is now root/approved member. The 409 keys (`:2913-2914`) omit workspace and memory (`app.ts:1226-1233` has them). They're unrelated to these fixes.

- _(re-baseline)_ `docs/development/documentation.md` now asks for route coverage in docs checks, which may pull these into scope.

## End-to-end verification

1. Each workstream's own green suite (ground rules), plus its manual checks:
   - WS2 probe;
   - WS3 release, refusal and rollback;
   - WS9 probes against the discovery pipeline's definition.
2. **Regression for the race:** WS1 tests A–E pass on Windows. _(Re-baseline: A, C and D were shown failing before WS1 merged; that step is done. They pass at `39b58dc`.)_
   - Add: WS14's three gate-state tests pass, and its guard test is in place.
3. **Live** (after WS11): from a release build, run the discovery pipeline with a fan-out of 8. Every slice succeeds on attempt 0, no run log shows `stop-hook-error`, and the doctor is clean. The implement→PR workflow with an empty queue ends `succeeded` with the "no work" label and no incident.
