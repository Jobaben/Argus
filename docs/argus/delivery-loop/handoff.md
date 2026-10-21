# Handoff: Delivery loop with per-task autonomy

**Plan:** [`plan.md`](plan.md) (same folder). Read these first: Context, Decisions already made, Target design, Ground rules, Order and Open decisions.

**Repo:** `C:\GIT\argus`. The remote `origin` is GitHub. A plain `git push` works. Never use `gh`.
**Updated:** 2026-10-21. This file lives in the repo so any session or machine can continue. Update it in place at the end of each session rather than creating a new one.

## Where things stand

| Item                               | State                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The open pilot instance            | ✅ Aborted on 2026-10-21, after you abandoned its spec-only PR.                                                                                                                                                                          |
| The pilot pipeline's webhook token | ✅ Rotated on 2026-10-21 (it had been printed into a session transcript). The intake skill reads the token at call time, so nothing else changes.                                                                                        |
| Plan                               | Written 2026-10-21 against `main` = `15a6fd5`. Decisions D1–D13 have proposed defaults; none is confirmed yet.                                                                                                                           |
| DL-A0 (setup-folder close-out)     | 🟡 `claudeConfigDir` (#94) is merged and in the pinned build, still under `[Unreleased]`. The Windows done gate, nine probes and the release are open; carried over from the retired headless-isolation handoff on 2026-10-21.           |
| DL-A1 (revise notes)               | ✅ Merged to `main` on 2026-10-21: every attempt reads all of its phase's revise notes from the gate-decisions record. **Not released yet**: the server runs the pinned build until `argus release`.                                     |
| DL-A2–DL-A4 (Argus)                | ⬜ Not started.                                                                                                                                                                                                                          |
| DL-P0–DL-P7 (pipeline)             | ⬜ Not started. DL-P0 only matters if the current pipeline runs again before DL-P4.                                                                                                                                                      |
| DL-M1 (working model v1.1)         | ⬜ Not started. Publishing needs your go.                                                                                                                                                                                                |
| Pilot notes                        | In the pipeline pack, `~/.claude/argus/delivery-loop/notes/pilot.md`, outside this repository: the first G2 revision to re-apply, and the classification check for the re-plan. They move with the pack into its versioned home (DL-P1). |

## Next steps

1. Confirm or change the open decisions. D1–D4, D12 and D13 shape DL-A2, so settle those before its branch starts.
2. Release DL-A1 (`argus release`), so the running server gets it; the ground rules cut a release after each merged workstream.
3. Then DL-A2 and DL-A3 (and DL-A4), each merged and released before the pipeline work that needs it.
4. DL-A0 can run at any time: it needs this Windows machine and a real CLI, and its probes run one at a time.
5. Once D13 is confirmed, add a one-line pointer to the [reliability handoff](../reliability/handoff.md), so a session following it doesn't start WS4 first.

## Interim rules until the Argus work lands

- When you revise a gate twice, repeat the earlier notes in the new one, until DL-A1 is released.
- Don't approve a gate whose summary shows blocking findings or a branch with nothing beyond the spec (DL-P0 and DL-P3 guard this).
- Edit the pipeline only when no instance of it is running or waiting.
