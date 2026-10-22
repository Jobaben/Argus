# Handoff: Delivery loop with per-task autonomy

**Plan:** [`plan.md`](plan.md) (same folder). Read these first: Context, Decisions already made, Target design, Ground rules, Order and Open decisions.

**Repo:** `C:\GIT\argus`. The remote `origin` is GitHub. A plain `git push` works. Never use `gh`.
**Updated:** 2026-10-22. This file lives in the repo so any session or machine can continue. Update it in place at the end of each session rather than creating a new one.

## Where things stand

| Item                               | State                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The open pilot instance            | ✅ Aborted on 2026-10-21, after you abandoned its spec-only PR.                                                                                                                                                                          |
| The pilot pipeline's webhook token | ✅ Rotated on 2026-10-21 (it had been printed into a session transcript). The intake skill reads the token at call time, so nothing else changes.                                                                                        |
| Plan                               | Written 2026-10-21 against `main` = `15a6fd5`; statuses updated 2026-10-22. D1–D4, D12 and D13 were taken at their proposed defaults when you asked to proceed with everything (2026-10-21). They stay yours to change. D5–D11 are open. |
| DL-A0 (setup-folder close-out)     | 🟡 `claudeConfigDir` (#94) is merged and in the pinned build, still under `[Unreleased]`. The Windows done gate, nine probes and the release are open. They need this Windows machine and a real CLI.                                    |
| DL-A1 (revise notes)               | ✅ Merged to `main` on 2026-10-21. **Not released yet**: the server runs the pinned build until `argus release`.                                                                                                                         |
| DL-A4 (check inputs)               | 🔵 `9355865` on `claude/cool-goldberg-325t64`. Not merged, not released.                                                                                                                                                                 |
| DL-A3 (`approveWhen`)              | 🔵 `ee56f8a` on the same branch. Not merged, not released.                                                                                                                                                                               |
| DL-A2a (spawn phases)              | 🔵 `46cdb73` on the same branch. Not merged, not released.                                                                                                                                                                               |
| DL-A2b (children manifest)         | 🔵 `94e4e6e` on the same branch. Not merged, not released.                                                                                                                                                                               |
| DL-A2c (spawn phases on the board) | 🔵 `01c3a53` on the same branch. Not merged, not released.                                                                                                                                                                               |
| Whole-branch pass                  | 🔵 `6075d3b`: an offline end-to-end test of the loop (`server/src/deliveryLoopE2e.test.ts`) and the fixes from a review of the whole branch.                                                                                             |
| Done gate (Linux, at `6075d3b`)    | ✅ Typecheck, lint, format, contracts, server `test:coverage` (3,597 tests, 0 failures, 4 skipped; lines 77.3 %), web `test:coverage` (1,602 tests), build, bundle (127.3 of 128 kB), motion budget, `argus --help`, `git diff --check`. |
| Windows                            | Ready for verification. CI's `windows` job runs on a pull request or on a push to `main`; nothing on this branch has run there yet.                                                                                                      |
| DL-P0–DL-P7 (pipeline)             | ⬜ Not started. DL-P3 to DL-P5 need DL-A2 to DL-A4 released; DL-P1 needs D9. DL-P0 only matters if the current pipeline runs again before DL-P4.                                                                                         |
| DL-M1 (working model v1.1)         | ⬜ Not started. Publishing needs your go.                                                                                                                                                                                                |
| Pilot notes                        | In the pipeline pack, `~/.claude/argus/delivery-loop/notes/pilot.md`, outside this repository: the first G2 revision to re-apply, and the classification check for the re-plan. They move with the pack into its versioned home (DL-P1). |

## How the branch is built

- One commit per workstream, in this order, on top of DL-A1 (`0017d3f`): DL-A4, DL-A3, DL-A2a, DL-A2b, DL-A2c, then the whole-branch pass. A cloud session built them; it could not leave work staged on one branch per workstream, as the ground rules ask.
- Each commit passed the done gate on Linux. Each was then reviewed from several angles (plan conformance, correctness and recovery, locks, security, tests, docs). Every finding was checked by independent verifiers, and the confirmed ones were fixed before the commit.
- The plan's sections DL-A2 and "DL-A4 and DL-A3" each end with an **Outcome** block: the decisions taken while building and the follow-ups left open.

## Next steps

1. Review the branch commit by commit, then bring it into `main`. A fast-forward keeps one commit per workstream:
   `git fetch origin && git checkout main && git merge --ff-only origin/claude/cool-goldberg-325t64 && git push`.
   The push runs CI, including the `windows` job: that is the Windows done gate for the new tests.
2. Cut a release (`docs/RELEASING.md`). `[Unreleased]` now holds WS3, `claudeConfigDir`, DL-A1 and DL-A2 to DL-A4. They are features, so a minor version; the version is your call. Then `node bin/argus.mjs release --ref vX.Y.Z` on this machine and restart `argus`. "Argus first" means released: DL-P work starts only after this.
3. DL-A0 on this machine: the Windows done gate and the nine probes, one at a time. Then WS13 (the `.claude.json` race), before any `maxParallel` above 1.
4. Confirm D5–D11. D9 (the pipeline's versioned home) comes first, because DL-P1 needs it.
5. Then the pipeline track, from the pinned release: DL-P1, DL-P2, DL-P3, DL-P4, DL-P5, with DL-P6 and DL-P7 alongside. DL-P3's `pr` phase can use `approveWhen` with the PR-merge recipe in `docs/guides/pipelines.md` instead of the interim long-running check.
6. DL-M1 when you say go.

## Interim rules until the Argus work is released

- When you revise a gate twice, repeat the earlier notes in the new one, until DL-A1 is released.
- Don't approve a gate whose summary shows blocking findings or a branch with nothing beyond the spec (DL-P0 and DL-P3 guard this).
- Edit the pipeline only when no instance of it is running or waiting.
- Before `argus release --use <older>` to a build without spawn phases, abort every instance that spawns children (`docs/RELEASING.md`).
