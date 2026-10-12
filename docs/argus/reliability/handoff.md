# Handoff: Argus reliability plan

**Plan:** [`plan.md`](plan.md) (same folder). Read these first:

- the **Re-baseline** section at the top, including the **Decisions on the re-baseline**;
- the ground rules;
- the WS14 section.

**Repo:** `C:\GIT\argus`. The remote `origin` is GitHub (`Jobaben/Argus`), not Azure DevOps. A plain `git push` works. Never use `gh`.
**Updated:** 2026-10-12. Lives in the repo so any session or machine can continue; update it in place at the end of each session rather than creating a new file.

## Where things stand

| Item                               | State                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WS1, WS2, follow-ups #1/#4         | ✅ on `main` and pushed (`fa470ed`).                                                                                                                                                                                                                                                 |
| `main`                             | `39b58dc`, even with `origin/main`, with 12 commits by others since `fa470ed` (Decision Ledger, docs reorg, Codex read-only isolation, transcript readers). `server/src/engine/`, `pipelineTransitions.ts`, `dag.ts`, `harness/`, `bin/` and `hooks/` are untouched since `fa470ed`. |
| Plan                               | Re-baselined against `39b58dc` on 2026-10-12. Every open question is answered (the plan's "Decisions on the re-baseline"). Two follow-ups: confirm the narrowed soak wording (decision 1), and in WS3 ask what a missing `ARGUS_TOKEN` does (decision 4).                            |
| WS14 (instance status under gates) | ⬜ **Next** after the `v0.5.0` release, on `fix/gate-state-guards`, before WS3. Order and grown scope approved (decision 7).                                                                                                                                                         |
| WS3–WS13                           | ⬜ Not started.                                                                                                                                                                                                                                                                      |
| Live proof of WS1/WS2              | Ready for verification only. It comes with WS11's discovery-pipeline fan-out.                                                                                                                                                                                                        |

**State at 2026-10-12, end of session:**

- **`v0.5.0` is released:** commit `75deb5f` on `main`, tag `v0.5.0`, both pushed. It includes the CHANGELOG gap fill, the breaking-changes callout, and docs for the advisory assessment route and the H2 runtime and effort settings.
  - `npm run check` was not green locally: 3 server baseline failures, plus 1 web locale failure (`sessionList.test.ts` expects "Thursday" and gets "torsdag").
- **The six merged branches are deleted.** A detached worktree remains at `.claude/worktrees/argus-workspace-setup-0dc225`; it was not touched.
- **The plan and this handoff moved into the repo** (`docs/argus/reliability/`), staged on `main` for the user to commit and push. Until that commit lands, the WS14 tests stay stashed ("ws14 red tests"); after it, rebase `fix/gate-state-guards` onto `main` and pop the stash.
- **`fix/gate-state-guards` is cut from `main`.** WS14's three behavioural tests sit unstaged in `server/src/pipelineEngineHarness.test.ts` (section "WS14") on the original checkout (`C:GITrgus`) and fail as intended. They exist nowhere else until the branch is committed and pushed; on another machine, rewrite them from the plan's WS14 step 4. `onFailure` fires at the approve, not at the stall, so test 2 pins the right path.
- **Orphan `48fab3f6` is still `awaiting-approval` on disk** (file unchanged since 2026-07-02). The user reported "killed the running instance", and the Argus server on :7777 is down. Confirm with the user whether the orphan still needs aborting in the UI.

**Next session:**

1. Check `git status`: on `fix/gate-state-guards`, with the WS14 tests unstaged. If `main` moved past `75deb5f`, check `git diff --stat 75deb5f..main -- server/src/engine server/src/pipelineTransitions.ts server/src/sources/dag.ts`.
2. Implement WS14 per the plan's WS14 section. Order:
   - the `sources/instanceStatus.ts` predicates and `liveStatus`;
   - the four transitions;
   - `pendingRetry` in `instanceOutcome`, and `runDueRetries` filtering on `resumable`;
   - the guard test;
   - the inline-spelling sweep;
   - the display surfaces;
   - the docs, the CHANGELOG ("Fixed") and the registry note.
3. Turn the three tests green, then run the full done gate (baseline-relative). Stage, stop, and report.

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

1. **WS4 registry backfill:** WS2 `read-only-enforced`, `stall-at-gate` (`fa470ed`), WS14 `instance-status-derived`, and possibly `codex-read-only-isolation` (open question 3).
2. **`bypassPermissions` PowerShell probe:** unprobed. The script is [`ws2-run-probe.sh`](ws2-run-probe.sh) in this folder (edit its `BASE` first).

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
- **The running server reports `0.4.0`.** After the release, restart it from the new build.
