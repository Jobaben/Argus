# Handoff: Delivery loop with per-task autonomy

**Plan:** [`plan.md`](plan.md) (same folder). Read these first: Context, Decisions already made, Target design, Ground rules, Order and Open decisions.

**Repo:** `C:\GIT\argus`. The remote `origin` is GitHub. A plain `git push` works. Never use `gh`.
**Updated:** 2026-10-26. This file lives in the repo so any session or machine can continue. Update it in place at the end of each session rather than creating a new one.

## Where things stand

| Item                               | State                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The open pilot instance            | ✅ Aborted on 2026-10-21, after you abandoned its spec-only PR.                                                                                                                                                                                                                                                                           |
| The pilot pipeline's webhook token | ✅ Rotated on 2026-10-21 (it had been printed into a session transcript). The intake skill reads the token at call time, so nothing else changes.                                                                                                                                                                                         |
| Plan                               | Written 2026-10-21 against `main` = `15a6fd5`; statuses updated 2026-10-26. D1–D4, D12 and D13 were taken at their proposed defaults when you asked to proceed with everything (2026-10-21). They stay yours to change. D5–D11 are open.                                                                                                  |
| DL-A0 (setup-folder close-out)     | 🟡 `claudeConfigDir` (#94) is merged and in the pinned build, still under `[Unreleased]`. The Windows done gate and the nine probes are open. They need this Windows machine and a real CLI.                                                                                                                                              |
| DL-A1 (revise notes)               | ✅ Merged 2026-10-21 (`0017d3f`); in the pinned build.                                                                                                                                                                                                                                                                                    |
| DL-A2a–c, DL-A3, DL-A4             | ✅ Squash-merged into `main` as `c1a634e` (#96) on 2026-10-22, with the offline loop test `server/src/deliveryLoopE2e.test.ts`. The per-workstream commits on `claude/cool-goldberg-325t64` no longer exist. In the pinned build.                                                                                                         |
| `argus pipeline`, `argus skills`   | ✅ #97 (`6b85474`), then `9fa32cd` and `7165940`. Pipelines can be listed, shown, validated, saved and started from a terminal; the bundled `argus-pipeline` skill describes this build.                                                                                                                                                  |
| The server                         | Runs the pinned build `1.0.0-7165940` (= `main`), started 2026-10-26 09:06. "Argus first" is met: the DL-P track can start.                                                                                                                                                                                                               |
| Version tag                        | ⬜ None since `v1.0.0`. `[Unreleased]` holds WS3, `claudeConfigDir`, DL-A1–DL-A4 and #97: a minor version by `docs/RELEASING.md`. The number is your call.                                                                                                                                                                                |
| Windows CI                         | Not checked from here (no `gh`). The push of `c1a634e` to `main` ran the `windows` job; look at its result in GitHub Actions.                                                                                                                                                                                                             |
| Decisions                          | 2026-10-26: a one-person loop with no approval gates, stopping only for a question a step cannot settle; one feature branch per idea, merged back to its base; a local pipeline repository; queued ideas, each after the last loop's learnings settle; Learn's loop changes applied once you merge them (plan, "Decisions already made"). |
| DL-P1–DL-P5 (pipeline)             | 🔵 Drafted for the one-person loop in the pipeline's local repository: committed and applied to Argus, both pipelines switched off. Both definitions validate; 57 smoke cases pass. Never run. See the plan's pipeline outcome.                                                                                                           |
| DL-P0, DL-P6, DL-P7                | ⬜ DL-P0 is superseded. DL-P6 (monitoring) needs D11. DL-P7 (a metrics report) is partly covered by Learn's per-loop metrics.                                                                                                                                                                                                             |
| DL-M1 (working model v1.1)         | ⬜ The agents' copy in the pipeline repository is rewritten for one person; the published working model is unchanged.                                                                                                                                                                                                                     |
| Pilot notes                        | In the pipeline repository's `notes/`. The pilot's original work item has since been delivered by hand, so the first run needs a new, small idea.                                                                                                                                                                                         |

## Next steps

1. ✅ 2026-10-26: the pipeline repository is committed: the baseline, then the rework.
2. ✅ 2026-10-26: applied with `--disabled`. The task loop exists and the parent is replaced, both switched off; `sync.mjs diff` shows no difference.
3. In the pilot repository, add a branch policy that requires a PR (no second reviewer) on the base branch. Set an Argus spend budget.
4. Schedule `node scripts/pump.mjs run` every few minutes as yourself, with `ARGUS_TOKEN`, `ARGUS_USER` and `ARGUS_PASSWORD` set. Optionally point the intake skill at `pump.mjs enqueue`.
5. Enable the parent and queue a small first idea: two or three tasks, two levels, one dependency. Report it as "ready for verification" until it has run.
6. Cut a tagged release when you choose (`docs/RELEASING.md`). DL-A0 on this machine, then WS13 before any `maxParallel` above 1.

## Interim rules

- Edit the pipeline only when no instance of it is running or waiting.
- Before `argus release --use <older>` to a build without spawn phases, abort every instance that spawns children (`docs/RELEASING.md`).
- Rollback after the first apply: the old definition is saved in the old pack's `backups/` folder (outside this repository); `argus pipeline update <id> <that file> --force` restores it.
