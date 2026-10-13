# Handoff: Argus reliability plan

**Plan:** [`plan.md`](plan.md) (same folder). Read these first:

- the **Re-baseline** section at the top, including the **Decisions on the re-baseline**;
- the ground rules;
- the WS14 section.

**Repo:** `C:\GIT\argus`. The remote `origin` is GitHub (`Jobaben/Argus`), not Azure DevOps. A plain `git push` works. Never use `gh`.
**Updated:** 2026-10-13 (WS14 staged, code-review follow-ups included). Lives in the repo so any session or machine can continue; update it in place at the end of each session rather than creating a new file.

## Where things stand

| Item                               | State                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS1, WS2, follow-ups #1/#4         | ✅ on `main` and pushed (`fa470ed`).                                                                                                                                                                                                                                                                       |
| `main`                             | `eb7663f` (handoff and plan updates), on top of `ee69bb4` (this plan and handoff moved into the repo), `db13709` (`docs/superpowers` deleted) and `75deb5f` (`v0.5.0`, tagged). All pushed. The engine, `pipelineTransitions.ts`, `dag.ts`, `harness/`, `bin/` and `hooks/` are untouched since `fa470ed`. |
| Plan                               | Re-baselined against `39b58dc` on 2026-10-12. Every open question is answered, and the narrowed soak wording is confirmed (the plan's "Decisions on the re-baseline"). One follow-up: in WS3, ask what a missing `ARGUS_TOKEN` does (decision 4).                                                          |
| WS14 (instance status under gates) | 🔵 **Staged for review** on `fix/gate-state-guards` (2026-10-13), uncommitted. Steps 1–5 done, plus the code-review follow-ups; the plan's WS14 "Outcome" block lists what changed and what was decided.                                                                                                                                    |
| WS3–WS13                           | ⬜ Not started.                                                                                                                                                                                                                                                                                            |
| Live proof of WS1/WS2              | Ready for verification only. It comes with WS11's discovery-pipeline fan-out.                                                                                                                                                                                                                              |

**State at 2026-10-13, end of session:**

- **WS14 is staged, not committed.** The stash is popped and gone; the three red tests are now green, in `pipelineEngineHarness.test.ts` section "WS14".
- **Done gate (Windows):**
  - `test:timeboxed`: 3,237 tests, 3,209 pass, 25 skipped, 3 fail, all three baseline (CRLF Codex skill copy, "blowing the output cap", "analysis spawn: kill()").
  - typecheck, lint, `prettier --check --end-of-line auto`, `check-contracts-runtime`, `git diff --check`: pass.
  - `server test:coverage`: 4 fail, all baseline (the three above plus the load-only `processTree` "timed-out command"). No threshold failed.
  - `web test:coverage`: 3 fail, none real: `sessionList` (locale, baseline) and two `Fleet.test.tsx` tests that pass alone (load-only).
  - build, `check-bundle-size` (121.8 kB of 122 kB, **0.2 kB headroom**: WS4/WS7/WS8 web additions must be lazy), `check-motion-budget`, `argus --help`: pass.
- **Two decisions taken (2026-10-13):** `DELETE /api/pipelines/:id` aborts live instances first; a recovery heal that opens a gate stops the heal loop.
- **A `/code-review` pass found 10 items; the user said "fix all".** All are fixed and staged (the plan's "Code-review follow-ups"), except approving a snapshot orphan through the API, which stays: it is the snapshot contract an existing engine test pins.
- **Orphan `48fab3f6` is still `awaiting-approval`** (checked 2026-10-13). Once WS14 is running, it is the live acceptance case: it shows on the Command Center as _pipeline deleted_ with a Stop button.

**State at 2026-10-12, end of session:**

- **`v0.5.0` is released:** commit `75deb5f` on `main`, tag `v0.5.0`, both pushed. It includes the CHANGELOG gap fill, the breaking-changes callout, and docs for the advisory assessment route and the H2 runtime and effort settings.
  - `npm run check` was not green locally: 3 server baseline failures, plus 1 web locale failure (`sessionList.test.ts` expects "Thursday" and gets "torsdag").
- **Branches cleaned up (2026-10-13).** `origin` holds only `main`. Locally there are only `main` and `fix/gate-state-guards`, and no extra worktrees.
  - Merged branches were deleted.
  - Unmerged work older than two weeks and not in the plan was dropped. That covers `agent/derive-name-name-source` `1c3e5b9`, `agent/macos-tmpdir-realpath` `c6e7116` and the UX analysis `b058b90`.
  - The five dependabot branches were deleted too, which closed their PRs. Dependabot offers newer versions on its next run.
  - To restore a dropped branch, run `git push origin <sha>:refs/heads/<name>`.
- **The plan and this handoff live in the repo** (`docs/argus/reliability/`, committed as `ee69bb4`). The OneDrive originals are deleted. The `docs/superpowers` links are gone from the catalog and `docs/README.md`.
- **WS14's three failing tests are stashed** in the original checkout as "ws14 red tests" (`git stash list`), a change to `server/src/pipelineEngineHarness.test.ts`, section "WS14".
  - They fail on `75deb5f` for the intended reasons. `onFailure` fires at the approve, not at the stall, so test 2 pins the right path.
  - They exist nowhere else. On another machine, rewrite them from the plan's WS14 step 4. A's failure must be a **stall**, not a failed check, because check results wait for a pending gate decision.
- **Orphan `48fab3f6` is still `awaiting-approval` on disk** (file unchanged since 2026-07-02). The UI has no control for it (it is the gap in plan WS14 step 5). On 2026-10-13 the user was given a browser-console `fetch` to `POST /api/instances/48fab3f6-9145-4a30-a082-85e97d13e84f/abort` from a signed-in tab. Check the instance file to see whether it has been aborted.

**Next session:**

1. The user reviews and commits WS14 on `fix/gate-state-guards`, merges it, and cuts a release (decision 2).
2. Live acceptance: start the server from that build, open the Command Center, and stop `48fab3f6` from its _pipeline deleted_ card. Check that the "awaiting you" count drops to 0.
3. Then WS3, from the updated `main`. Ask what a missing `ARGUS_TOKEN` does (decision 4).

## WS14 in one paragraph

Four transitions write `inst.status = "running"` without deriving it, which hides a sibling's waiting gate: `applyRevise` `:1328`, `applyRemediation` `:1417`, `applyRetry` `:1506` and `scheduleRetry` `:1604` in `pipelineTransitions.ts`. `instanceOutcome` (`sources/dag.ts`) also ignores `retryAt`, so a pending retry turns the instance falsely `failed`. Both are verified by reading the code.

The fix:

- one `liveStatus(inst)` derivation;
- `pendingRetry` counted as live;
- named predicates in a non-engine module (`sources/instanceStatus.ts`);
- a guard test over status reads **and** writes;
- phase-derived `hasWaitingGate` for verdictWatcher and the display counts.

The full inventory, with every site, is in the plan's WS14 section. It changes outcomes, so it gets a WS4 registry entry.

## Baseline at `39b58dc` (this machine)

- **`npm -w server run test:timeboxed`:** 3,218 tests, 3,188 pass, 25 skipped, 5 fail. Takes about 2.5 min.
  - Known: the CRLF Codex skill copy; "blowing the output cap"; "analysis spawn: kill()…".
  - Load-only (they pass in isolation): `processTree` "verification: a timed-out command whose descendant holds the pipe…"; `pipelineEngine` "a completion signal is answered while a later wave waits for a slot".
- **Typecheck and build:** pass.
- **The done gate now also includes** server/web `test:coverage`, `check-bundle-size.mjs` and `check-motion-budget.mjs` (when web changed), because CI runs them.

## Open items carried over

1. **WS4 registry backfill:** WS2 `read-only-enforced`, `stall-at-gate` (`fa470ed`), WS14 `instance-status-derived`, and `codex-read-only-isolation` (adopted, decision 3).
2. **`bypassPermissions` PowerShell probe:** unprobed. The script is [`ws2-run-probe.sh`](ws2-run-probe.sh) in this folder (edit its `BASE` first).

**Web load-only failures (2026-10-13).** Under parallel load (web coverage beside a server suite) these time out at 5 s and pass alone: `CommandCenter.test.tsx` "opens the review drawer…" and "revise needs a note…", `Fleet.test.tsx` ×2, `PipelineForm.test.tsx` (several), `PipelineFormRoutes.test.tsx` ×2, `Schedules.test.tsx` catch-up. Run web coverage on its own, and rerun a failing file alone before calling it real.

## Environment gotchas (this Windows checkout)

- **`npx tsx` fails.** Run tests as `cd server && node ../node_modules/tsx/dist/cli.mjs --import ./src/testHome.ts --test --test-reporter=spec --test-name-pattern="…" src/<file>.test.ts`.
- **Run `test:timeboxed` in the background**, redirected to a file, and read it with `grep -E "^ℹ (tests|pass|fail)"`. Rerun any failing file on its own before calling a failure real.
- **Check exit codes without a pipe.** `cmd | tail; echo $?` reports `tail`'s status. Use `${PIPESTATUS[0]}` or redirect to a file.
- **Repo-wide `format:check` reports about 547 CRLF-only files.** Use `npx prettier --check --end-of-line auto .`, and confirm touched files are LF with `git ls-files --eol`.
- **Give every assert a message.** A failing `assert.ok` without one can take minutes under tsx.
- **Test files are ESM:** no `require`. Node `-e` from Git Bash mangles Windows backslashes; use the Edit tool.
- **To spy on a prototype in a test,** use `t.mock.method(...)` (it is restored after the test). The engine modules share one module graph with the test file.
- **Real-CLI probes run sequentially** (the `~/.claude.json` race, WS13). The auto-mode classifier blocks `bypassPermissions` probes.
- **`new Response(body, { status: 204 })` throws** in undici; use 202 in fetch fakes.
- **Don't import a bare `process`** in server modules that run under tsx watch on Windows.
- **Commits:** no attribution lines of any kind. Stage, stop and report; commit, merge or push only when the user asks.

## Decisions taken on 2026-10-12 that need action outside the code

- **Orphan instance `48fab3f6`** (deleted pipeline `cf12d32d`, gate waiting since 2026-07-02): the user approved aborting it. `POST /api/instances/:id/abort` needs a logged-in admin session; `ARGUS_TOKEN` only passes the outer `/api/*` gate (health returns 200 with it). The user aborts it in the web UI. Never edit `instances.json` by hand.
- **The local server last reported `0.4.0`**, then was stopped. Start it from a `0.5.0` build.
