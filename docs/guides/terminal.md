# Monitor and review gates from a terminal

[Documentation](../README.md) · [Feature guides](../guides/README.md)

Read the dashboard state and review pipeline gates without a browser.

## Before you start

A running Argus server; use the same URL/port and token as that server. Gate actions also require an approved account.

## Try it

1. From the checkout, run `node bin/argus.mjs tail --for 0` for a snapshot. This does not start a server.
2. Run `node bin/argus.mjs tail --for 60s` for a bounded live feed, or add `--json` for machine-readable output.
3. Use `node bin/argus.mjs approve --help` or `node bin/argus.mjs revise --help` before acting on a gate. Review its exact instance and evidence first.
4. Run `node bin/argus.mjs skills install` to give the Claude Code and Codex agents on this machine this build's `argus-pipeline` and `argus-tail` skills, or to bring older copies up to date.
5. The optional installed `argus` command is shorthand for the same launcher; the examples below use that shorthand.

**Expected result:** The terminal shows running work, waiting gates and recent outcomes; JSON mode provides one record per line.

## On this page

- [`argus tail`](#argus-tail)
- [`argus pipeline`](#argus-pipeline)
- [`argus skills`](#argus-skills)
- [`argus release`](#argus-release)

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
A gate waiting on you does not keep it open, and neither does a parent whose
[spawned children](pipelines.md#spawn-child-instances) all wait at their own
gates; a retry that is due does. Each child's gate gets its own ⏸ line, and a
child's lines carry its task key in brackets
(`Task loop [auth] › Implement started`). A spawn phase that waits for you
after a task failed says so on its ⏸ line:
`waiting for you at "Tasks" (1 of 4 tasks did not succeed)`.
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
`argus-tail` skill for every agent CLI it finds on PATH; it is
`argus skills install argus-tail` (see [`argus skills`](#argus-skills)), and
`--install-skill=claude`, `=codex` or `=all` chooses explicitly. From then
on a session of either CLI on that machine answers "what is Argus doing?",
"has the release pipeline finished?", `/argus-tail` (Claude Code) or
`$argus-tail` (Codex) by running the command and relaying the lines —
including a remote session on your phone, which is the case this exists for.
The skill teaches the icon vocabulary, the bounded-window habit, and to quote
failure reasons verbatim.

**Where the data comes from:** `GET /api/health`, `/api/runs`,
`/api/overview`, `/api/agents`, `/api/insight`, `/api/runs/:id/activity` (the
tailer's retained events for a running step), and `WS /ws`.

## `argus pipeline`

_Author a pipeline from a terminal, or let an agent do it._

**Purpose:** the pipeline form is where a person authors a definition. An
agent writes one as a JSON file instead, and needs the server's own verdict
on it before anything is saved. `argus pipeline` is that loop: check a file
without saving it, save it, replace it, start it.

```sh
argus pipeline list                          # id, name, trigger, state, phases
argus pipeline show <id|name> > p.json       # the stored definition, as JSON
argus pipeline runtimes                      # which CLIs, models and efforts this Argus can run
argus pipeline validate p.json               # every check a save makes; saves nothing
argus pipeline validate p.json --as <id>     # ...as a replacement of that pipeline
argus pipeline create p.json                 # save it; prints the new id
argus pipeline update <id> p.json            # replace it (--patch merges the file's fields)
argus pipeline start <id>                    # start an instance now
```

`validate` runs the same checks a save does — the definition, its graph and
routes, an `after` trigger, spawn phases against the pipelines that exist —
and prints the `400` reason when one fails, word for word. `update` is held
with `409 instances-running` while an instance runs under the pipeline,
because that instance keeps the definition it started with; `--force` saves
the edit for the next start anyway. `show` leaves out the webhook token, so
its output can go back through `update` without carrying a credential
around. `-` reads the file from stdin.

`list`, `show` and `runtimes` are reads. `validate`, `create`, `update` and
`start` need an Argus account, the same way `argus approve` does
(`ARGUS_USER` / `ARGUS_PASSWORD`, or the prompt), and `start` runs the
pipeline's agents, which invoke their providers. `--json` prints objects
instead of lines. Exit status: `0` done, `1` refused, invalid or
unreachable, `2` bad arguments.

**Where the data comes from:** `GET /api/pipelines`, `GET /api/runtimes`,
`POST /api/pipelines/validate`, `POST /api/pipelines`,
`PUT`/`PATCH /api/pipelines/:id` and `POST /api/pipelines/:id/start`.

## `argus skills`

_Teach the agents on this machine how this build of Argus works._

**Purpose:** Argus ships agent skills — `argus-pipeline`, which teaches an
agent to author, validate, start and repair pipelines with
[`argus pipeline`](#argus-pipeline), and `argus-tail` — and Argus changes
faster than a copy someone installed months ago. `argus skills install`
puts this build's skills into the Claude Code and Codex homes, or brings
the copies there up to date.

```sh
argus skills                                   # status: missing, up to date, older, edited
argus skills install                           # install or update every skill, every agent
argus skills install argus-pipeline --for all  # one skill, both CLIs whether on PATH or not
```

Claude Code and Codex discover skills the same way — a
`skills/<name>/SKILL.md` folder under the CLI's home, `name` and
`description` frontmatter, chosen when a request matches the description or
by name (`/argus-pipeline` in Claude Code, `$argus-pipeline` in Codex) — so
each skill is written once and lands in `~/.claude/skills/` (honouring
`ARGUS_CLAUDE_HOME`) and `~/.codex/skills/` (honouring `ARGUS_CODEX_HOME` and
`CODEX_HOME`). Without `--for`, it installs for every CLI found on PATH and
updates every home that already has one of the skills.

**What an update does:**

- An up-to-date skill is left alone.
- A skill that an earlier `argus skills` installed and nobody has touched
  since is replaced whole, so a file the new version dropped does not linger.
- A skill that was edited, or installed some other way (by hand, or an older
  skill of the same name), is copied to
  `~/.claude/argus/skill-backups/<claude|codex>/<name>-<time>/` first, then
  replaced. The line it prints names the copy.

Each installed folder gets a `.argus-skill.json` beside `SKILL.md`: the
version and build it came from, and a digest of what was written, which is
how a later run tells "older than this build" from "edited". The
`argus-pipeline` skill points its reader at the docs of the build that
installed it, so `argus skills install` after `argus release` points it at
the new release. The server says at startup when an installed skill is
older than the build it runs, and changes nothing itself. A new agent
session picks up the installed skill.

Inside the Argus checkout both CLIs find the skills without installing:
Claude Code at `.claude/skills/`, Codex at `.agents/skills/` — plain copies
rather than symlinks, so a Windows checkout without symlink support has them
too, and a test fails if the two copies ever differ.

## `argus release`

_Keep pipelines running while I work on Argus._

**Purpose:** without a release, `argus` runs the checkout, so every rebuild
or branch switch changes the code under pipelines that are already running,
including the completion hook their agents call. `argus release` builds one
commit into its own folder and pins it; from then on every `argus` command
runs that folder, and the checkout is yours to change.

```sh
node bin/argus.mjs release               # build HEAD and pin it
node bin/argus.mjs release --ref v1.0.0  # build a tag or any ref
node bin/argus.mjs release --list        # built releases; * is pinned
node bin/argus.mjs release --use <id>    # pin another (roll back or forward)
node bin/argus.mjs --dev                 # run the checkout anyway, with a warning
```

Restart `argus` after pinning. A release contains only the commit, never
uncommitted changes, and is never deleted, because the runs it launched
embed its hook path. Rolling back to an older release can hide data a newer
one wrote; see [Releasing](../RELEASING.md#rolling-back). Where releases live
and how the launcher picks one: [Operations](../reference/operations.md#startup-and-build-identity).
