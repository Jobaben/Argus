---
name: argus-tail
description: Watch what Argus is doing from a terminal and relay it — what is running, what is waiting for approval, what just finished or failed, and what each running agent step is doing right now. Use when someone asks what Argus, a pipeline, a schedule or an agent run is doing, whether something has finished, or to keep them posted on a run they cannot see in a browser.
---

# Watching Argus with `argus tail`

Argus is a dashboard over coding-agent runs. The person asking cannot see that
dashboard right now — you are their frontend. `argus tail` prints the same
facts as text, one line each, and returns on its own.

## The command

```bash
argus tail                 # snapshot + follow the live feed for 60s, then exit
argus tail --for 0         # snapshot only: what is running / waiting / recent
argus tail --for 5m --until-idle   # keep following until nothing is running
argus tail --json          # one JSON object per line, when you need to parse
```

`argus` must be on PATH on this machine (it is wherever Argus runs). If the
server is on another port, `--url http://127.0.0.1:<port>`; if it was started
with `ARGUS_TOKEN`, the same variable (or `--token`) must be set in your shell,
and the error message will say so.

## Reading the output

Every line is `HH:MM:SS <icon> <text>`:

| Icon     | Meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| ▣        | the summary: how many running, waiting for approval, spend today      |
| ▶        | running now (snapshot), or a run / pipeline / phase that just started |
| ·        | indented under a running step: its recent activity, oldest first      |
| ⚙ 💬     | an agent tool call / an agent's own words, live as they happen        |
| ⏸        | a pipeline waiting for a human to approve a gated phase               |
| ✓ ✗      | finished: succeeded / failed, with duration, cost and the reason      |
| ●        | a Claude Code background agent (the Agents tab)                       |
| ⚠ $ ↯ 🔥 | monitor, budget, anomaly and incident alerts                          |
| ⏲        | the next scheduled firing                                             |
| ──       | the closing line: why it stopped and how many are still running       |

Only **pipeline steps** stream per-tool activity (⚙ 💬). Schedule and one-off
runs show start and finish lines only — that is how Argus runs them, not a
gap in the tail.

## How to relay it

- Run `argus tail` with the default window, then summarise in a few lines:
  what is running (and what it is doing), what needs a decision, what finished
  since last time. Quote failure reasons verbatim; they are the useful part.
- Asked to "keep an eye on it": run `argus tail --for 5m --until-idle` (stay
  under your tool timeout), report, and run it again if they want more. Each
  run's snapshot catches anything you missed between calls.
- Asked "is it done yet?": `argus tail --for 0` answers immediately.
- A ⏸ line means a person must approve, revise or abort in the Argus UI or via
  its API; say so rather than waiting for it to move.
- If the command exits 1, relay its stderr line as-is — it names the fix
  (server not running, wrong port, missing token).
