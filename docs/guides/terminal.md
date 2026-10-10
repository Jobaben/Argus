# Monitor and review gates from a terminal

[Documentation](../README.md) · [Feature guides](../guides/README.md)

Read the dashboard state and review pipeline gates without a browser.

## Before you start

A running Argus server; use the same URL/port and token as that server. Gate actions also require an approved account.

## Try it

1. From the checkout, run `node bin/argus.mjs tail --for 0` for a snapshot. This does not start a server.
2. Run `node bin/argus.mjs tail --for 60s` for a bounded live feed, or add `--json` for machine-readable output.
3. Use `node bin/argus.mjs approve --help` or `node bin/argus.mjs revise --help` before acting on a gate. Review its exact instance and evidence first.
4. The optional installed `argus` command is shorthand for the same launcher; the examples below use that shorthand.

**Expected result:** The terminal shows running work, waiting gates and recent outcomes; JSON mode provides one record per line.

## On this page

- [`argus tail`](#argus-tail)

## `argus tail`

_What is it doing, when I can't see the UI?_ Not a tab — a command.

**Purpose:** every view above assumes a browser pointed at the machine. Often
there isn't one: you are on a phone, and the only window onto the box is a
terminal — an SSH session, or a Claude Code session driven through Remote
Control. `argus tail` is the dashboard for that window. It prints the same
facts as text, one line each, and returns on its own, so a person can read it
and an agent can relay it.

```bash
argus tail                        # snapshot, then follow the live feed for 60s
argus tail --for 0                # snapshot only
argus tail --for 5m --until-idle  # follow until nothing is running
argus tail --json                 # one JSON object per line
```

**What you see.** Every line is `HH:MM:SS <icon> <text>`.

The **snapshot** comes first: a summary line (how many running, how many
waiting for approval, live background agents, monitors down, open issues,
today's spend against the budget); one ▶ line per running run — its board name
(`Pipeline › phase › step`), runtime if not the default, elapsed time, time left
before its deadline if it has one, and what it is doing right now — with its
last few activity lines indented beneath it, oldest first; one ⏸ line per
pipeline waiting at a gate, with the agent's own summary of what it wants
approved; one ● line per live Claude Code background agent; recent outcomes
(✓ ✗) inside the `--since` window, newest first, with duration, cost, the
failure reason or the first line of the result; the next scheduled firing (⏲);
and `○ idle` when nothing at all is running.

Then it **follows**. Per-tool activity from running pipeline steps streams as
it happens (⚙ a tool call, 💬 the agent's own words, ○ session started, ■
finished). Runs starting (▶) and ending (■ ✓ / ✗); phases starting, succeeding,
failing or being skipped (→); pipelines starting, pausing at a gate (⏸),
resuming and ending; background agents changing state (●); and every alert the
bell would ring — monitor (⚠), budget ($), anomaly (↯), incident (🔥). A closing
── line says why it stopped (window elapsed, went idle, Ctrl-C), how many
events it printed, and how many runs are still going.

**How it works.** It is a client of the running server: the same port, the
same `ARGUS_TOKEN` (`--url` and `--token` override both). It reads the API the
dashboard reads and follows the same WebSocket. The payload frames print
directly; the payload-free `*:changed` pings trigger conditional re-reads of
runs, the board and the agents, which it diffs against its previous read to
produce "run X started" rather than "something changed". A dropped socket
reconnects with backoff and re-reads everything on the way back, and a
twenty-second safety re-read covers a ping that never arrived.

**The window matters.** When stdout is not a terminal — an agent's tool call, a
pipe — the default is to follow for 60 seconds and exit, so a call with a
timeout always returns a complete, self-describing answer; on a real terminal
the default is to follow until Ctrl-C. `--for` sets it explicitly (`--for 0` is
a pure snapshot), and `--until-idle` ends it early once nothing is running.
Each run's snapshot catches anything that happened between calls, so "run it
again" is the whole continuation story.

**Honest limits.** Only pipeline steps stream per-tool activity, because only
they run with a live transcript (`--output-format stream-json`); schedule and
one-off runs are batch runs and show start and finish lines only. A gate needs
a human: the tail tells you a pipeline is waiting and never decides for you.
Each ⏸ line carries the link to that gate's review drawer and the matching
`argus approve` command, so the person reading the relay can look, then act.

**Deciding from the terminal.** Two sibling commands make the decision the
review drawer makes, for the window that has no browser:

```bash
argus approve <instanceId> [--phase <phaseId>]                  # continue the pipeline
argus revise  <instanceId> --note "<what to change>" [--phase <phaseId>]  # run the phase again
```

Both need an Argus account, because they call the same admin-gated routes the
drawer does. Set `ARGUS_USER` and `ARGUS_PASSWORD` in the shell, or answer the
prompt on a real terminal (a tool call has no terminal, so an agent relaying
the tail needs the variables). The session lasts for the one call and is never
written to disk. `--note` is required for `revise` — the note is the revision.
`--phase` is only needed when the ⏸ line shows one. `--json` prints the outcome
as one object; the exit status is `0` when the decision landed, `1` when Argus
refused it or could not be reached (the one line on stderr says why), `2` for
bad arguments. Approving here is exactly approving in the drawer: what the
agent produced is what continues, so look first — the tail printed the link.

**For an agent.** `argus tail --install-skill` installs the bundled
`argus-tail` skill for every agent CLI it finds on PATH. Claude Code and Codex
discover skills the same way — a `skills/<name>/SKILL.md` tree under the CLI's
home, `name` and `description` frontmatter, chosen implicitly when a request
matches the description or by name — so it is one file, written in the
dialect both accept, landing in `~/.claude/skills/` (honouring
`ARGUS_CLAUDE_HOME`) and `~/.codex/skills/` (honouring `ARGUS_CODEX_HOME` and
`CODEX_HOME`). `--install-skill=claude`, `=codex` or `=all` chooses
explicitly; bare, it installs for what is present and says what it skipped.
From then on a session of either CLI on that machine answers "what is Argus
doing?", "has the release pipeline finished?", `/argus-tail` (Claude Code) or
`$argus-tail` (Codex) by running the command and relaying the lines —
including a remote session on your phone, which is the case this exists for.
The skill teaches the icon vocabulary, the bounded-window habit, and to quote
failure reasons verbatim. Inside the Argus checkout both CLIs find it without
installing: Claude Code at `.claude/skills/argus-tail/`, Codex at
`.agents/skills/argus-tail/` — a plain copy of the same file rather than a
symlink, so a Windows checkout without symlink support has it too, and a test
fails if the two copies ever differ.

**Where the data comes from:** `GET /api/health`, `/api/runs`,
`/api/overview`, `/api/agents`, `/api/insight`, `/api/runs/:id/activity` (the
tailer's retained events for a running step), and `WS /ws`.
