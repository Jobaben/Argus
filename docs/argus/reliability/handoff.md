# Handoff: Argus reliability plan

**Plan:** [`plan.md`](plan.md) (same folder). Read these first:

- the **Re-baseline** section at the top, including the **Decisions on the re-baseline**;
- the ground rules;
- the WS3 section, including its **Re-baseline** block.

**Repo:** `C:\GIT\argus`. The remote `origin` is GitHub (`Jobaben/Argus`), not Azure DevOps. A plain `git push` works. Never use `gh`.
**Updated:** 2026-10-15 (`v1.0.0` is `f09bdf1`, tagged and pushed; WS3 is merged to `main` as `6ce0dbe` and pushed). Lives in the repo so any session or machine can continue; update it in place at the end of each session rather than creating a new file.

## Where things stand

| Item                               | State                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS1, WS2, follow-ups #1/#4         | ✅ on `main` and pushed (`fa470ed`).                                                                                                                                                                                                              |
| `main`                             | `6ce0dbe` (WS3) on `f09bdf1` (`v1.0.0`). All pushed. WS3 sits under `[Unreleased]`; no release has been cut since `v1.0.0`.                                                                                                                       |
| Plan                               | Re-baselined against `39b58dc` on 2026-10-12. Every open question is answered, and the narrowed soak wording is confirmed (the plan's "Decisions on the re-baseline"). One follow-up: in WS3, ask what a missing `ARGUS_TOKEN` does (decision 4). |
| WS14 (instance status under gates) | ✅ On `main` and pushed (`7f2dac2`, 2026-10-13). `fix/gate-state-guards` is deleted (it was never on `origin`). The plan's WS14 "Outcome" block lists what changed and what was decided.                                                          |
| `v1.0.0`                           | ✅ `f09bdf1`, tag `v1.0.0` pushed (2026-10-14).                                                                                                                                                                                                   |
| WS3 (pinned release, lock, build)  | ✅ On `main` and pushed (`6ce0dbe`, 2026-10-15). The plan's WS3 "Outcome" block lists what changed, what was verified live and what is left for manual checks.                                                                                    |
| WS4–WS13                           | ⬜ Not started.                                                                                                                                                                                                                                   |
| Live proof of WS1/WS2              | Ready for verification only. It comes with WS11's discovery-pipeline fan-out.                                                                                                                                                                     |

**State at 2026-10-15:**

- **Release done.** The user committed the renumbering as `f09bdf1` ("V1.0.0 releases"); tag `v1.0.0` is pushed. Orphan `48fab3f6` is **aborted** (2026-10-14 05:44 UTC), so the live acceptance case is closed.
- **Decisions (2026-10-14):** a missing `ARGUS_TOKEN` never stops startup, only the lock probe fails closed; connection refused at the holder's recorded URL after 60 s is stale; releases live in `~/.claude-argus-releases` (a sibling of the work root, not under it). All recorded in the plan.
- **First WS3 check answered:** per-run settings embed the build's own `hooks/` (all 67 hook-carrying invocation records point at `C:/GIT/argus/hooks/argus-signal.mjs`), so releases must never be pruned.
- **Done gate on the WS3 diff (Windows):** typecheck, lint, `prettier --check --end-of-line auto .`, `check-contracts-runtime`, `git diff --check`, build and `argus --help` pass. `test:timeboxed`: 3,284 tests, 3,258 pass, 25 skipped, 1 fail (baseline CRLF Codex skill copy). `server test:coverage` (rerun after the `sameDirectory` fix): 3,285 tests, 1 fail (the same baseline), no threshold failed (79.0 % lines). The first coverage run also failed `release --use` once (load-only; see the plan). Web is untouched apart from the contract type, so web tests and bundle checks were not rerun.
- **Adjacent, not changed (ask first):** `openWhenUp` (`--open`) probes `/api/health` without the token, so with `ARGUS_TOKEN` set the browser never opens automatically; and the launcher's Ctrl+C forwarding is a hard kill on Windows, which skips `engine.drain()` (predates WS3).

**State at 2026-10-14:**

- **The release is `v1.0.0` (the user's decision, 2026-10-14).** It was first cut as `0.6.0` (`52fdecf`, pushed, never tagged). Because `52fdecf` is already on `origin`, the renumbering is a new change on top, not a rewrite. It is staged: the CHANGELOG header becomes `[1.0.0] - 2026-10-14`, and the callout drops its "Pre-1.0, so this bumps the minor version" line. The version in the four `package.json` files and `package-lock.json` becomes `1.0.0`. RELEASING.md's cadence now uses post-1.0 SemVer: a breaking change bumps **major** (WS8's `no-work` outcome, for one, may count as breaking). The CHANGELOG roll is `d1cd8c1`, with a breaking-changes callout: deleting a pipeline aborts its instances (or returns `409`), a scheduled retry keeps the instance live, and `liveInstances` counts work in flight. The lock diff is held to the five version fields: `npm version` also flips unrelated `peer` flags, so those were reverted.
- **`npm run check` on `ed3924d`:** typecheck and lint pass. The server suite (3,244 tests) has 5 failures:
  - the three baseline failures;
  - `processTree` "timed-out command" (fails only under load);
  - **new:** `pipelineEngine` "a completed step folds its cost into the all-time totals". It got `0.14 !== 0.07` and passes alone. This is a test-isolation leak, not a double count in the product. The test before it (from `ceab917`, 2026-07-09, older than WS14) also writes a 0.07 run, but it waits only for `succeeded`, not for its totals fold. Under load that fold crosses `beforeEach`'s `ARGUS_CLAUDE_HOME` repoint and lands in the next test's home: the same leak the comment at `pipelineEngine.test.ts:1010` describes. The fix, if wanted, is to make the earlier test wait for `countedInTotals`.

  The check stops at the server failures, so the web suite was run on its own: 54 failures under load (47 of them 5 s timeouts). Rerun alone, the 20 failing files leave only the baseline `sessionList` locale failure.

- **Orphan `48fab3f6` is still `awaiting-approval`** (instance file unchanged since 2026-07-02). The live acceptance case is still there.

**State at 2026-10-13, end of session:**

- **WS14 is merged.** The user committed it as `7f2dac2`; it was fast-forwarded into `main`, pushed, and the branch deleted. No release is cut yet. The stash is popped and gone; the three red tests are now green, in `pipelineEngineHarness.test.ts` section "WS14".
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

1. Manual checks (plan WS3 "Ready for verification"): `npm run dev` is refused while `argus` runs; `argus release` on the real home, then `argus`, makes health show `build.kind: "release"`; `--use <previous>` rolls back. Also Ctrl+C under `argus`: on Windows it may leave a dead-pid `server.lock` (the launcher forwards a hard kill); the next start takes it over, so either outcome is acceptable.
2. Cut the next release. My recommendation is a minor bump (WS3 adds features; its two behaviour changes are in the `[Unreleased]` callout), but the version is the user's call. From now on, pin each release with `argus release --ref vX.Y.Z` (RELEASING.md step 6).
3. Then WS4 on `feat/behaviour-change-registry`.

## WS3 in one paragraph

The server runs from the dev checkout, so every rebuild moves the pipelines already running, and nothing stops a second server from sharing the same state directory. WS3 adds three things:

- **`argus release`.** It extracts a commit with `git archive` into `~/.claude-argus-releases/<version>-<sha7>/`, builds it there and points `current.json` at it. The launcher then runs that build; `--dev` forces the checkout and prints a warning.
- **A build id on `/api/health`:** `build {kind, sha, dir, id?}`.
- **`server.lock`.** Created with `wx` under `paths.argus()`, it refuses a second server on the same state, whichever port that server uses. It is also the Decision Ledger's only guard across processes.

Steps 1–5 and the tests are in the plan's WS3 section. Its **Re-baseline** block lists the spawn sites the plan misses in `bin/argus.mjs`, `releasesRoot`'s three env rules, where to acquire and release the lock in `index.ts`, and the adopted additions:

- `export-ignore` for `experiments/`;
- a manual check that a second server on another port is refused;
- a RELEASING.md note that rolling back with `--use` can hide data.

**Line references that moved since the re-baseline (`39b58dc..52fdecf`).** WS3 touches only three files that changed: `app.ts`, `app.test.ts` and `docs/API.md` (WS14).

- The health route is at `app.ts:325` (the plan says `:324-332`).
- The "Pipeline definitions: mutations only" block starts at `:485` (the plan says `:484`).
- Recheck the `app.test.ts` admin-route list and the API.md health lines before you cite them.

`bin/`, `index.ts`, `claudeHome.ts`, `setup/prereqs.ts`, `harness/invocation.ts` and RELEASING.md are unchanged, so the plan's references to them still hold.

**First check in WS3** (from the plan): confirm which hook path the per-run settings actually embed. This machine's `~/.claude/settings.json` points at the global copy.

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
