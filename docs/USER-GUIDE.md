# 👁️ Argus — User Guide

**What Argus is:** a dashboard and control plane over your local `~/.claude`
folder. It watches the files Claude Code already writes (background jobs,
transcripts, history, stats) and turns them into a live web view.

Argus **never modifies the state Claude Code owns** — it treats jobs,
transcripts, history and daemon files as strictly read-only. It _does_ own and
write its own state under `~/.claude/argus/` (schedules, pipelines, run
records) and, when you apply setup fixes, its signal hooks under
`~/.claude/hooks/` and a hook entry in `settings.json`. So the monitoring tabs
(Agents, Sessions, Activity, Projects, Stats, Search) are observe-only, while
the Scheduler and Pipelines tabs let you create, run, revise, and cancel work.

**Security note:** because Argus can launch `claude -p` agents with your
credentials, the server binds to loopback (`127.0.0.1`) only and rejects
cross-origin and unknown-Host requests. If you deliberately expose it on
another interface (`ARGUS_HOST`), set `ARGUS_TOKEN` so the surface is
authenticated.

## Global UI (applies to every tab)

- **The "Argus" logo + colored dot** (top-left): the dot is the live-connection
  indicator. **Green = "live"** (WebSocket to the server is connected); **gray =
  "reconnecting…"** (socket dropped, falling back to polling). It reflects
  Argus's link to its own server, not the health of your agents.
- **Auto-refresh:** the server pushes a "something changed" ping over a WebSocket
  whenever a watched file mutates, and the UI re-fetches. If the socket drops,
  each tab also polls on a timer (most tabs 10s; Stats 30s; Search on keystroke;
  Cron once). You rarely need to refresh the browser.
- **Routing** is hash-based (`#/agents`, `#/detail`, `#/search`…), so tabs are
  bookmarkable and the back button works.

---

## 1. Agents — _the home view_

**Purpose:** the at-a-glance status board for all your background Claude Code
jobs (agents launched to run in the background).

**What you see:**

- A **summary row**: total agents, how many are **live**, **working**, and
  **failed**.
- A grid of **agent cards**, each with: the agent's name, its short ID (the
  stable 8-char identifier), a color-coded **status pill**
  (`working / done / failed / idle / queued / unknown`), a pulsing green
  **"live"** dot if it's currently running, the detail line (what it's doing
  now), a green **result** box if it has finished output, and a footer of
  metadata — working directory, launch template, tempo (`active`/`idle`),
  in-flight task count, and last-update time.

**How to use it:** scan colors to triage — green pulse = running now, red =
failed, gray = idle/done. **Click any card** to jump to the **Detail** tab for
that agent.

**Where the data comes from:** `/api/agents`, which merges
`~/.claude/jobs/<short>/state.json` (the metadata) with
`~/.claude/daemon/roster.json` (liveness — an agent is "live" only if its short
ID is an active worker in the roster).

---

## 2. Detail — _single-agent deep dive + timeline_

**Purpose:** everything about one agent, including the chronological trail of how
it got to its current state. This is where a card click lands you
(`#/agent/<short>`); opening the tab with nothing selected shows a "no agent
selected" prompt.

**What you see:**

- A **metadata card**: name, short ID, status pill, live dot, current detail and
  result text, plus a full field list — folder, full CWD, template, tempo,
  session ID, CLI version, PID, in-flight/queued task counts, and Created /
  Updated / First-terminal timestamps (shown as relative times like "5m ago").
- A **timeline** below it: every recorded state transition, newest first, each
  with a status-colored dot, status pill, timestamp, and an optional detail line.
  Entries with long narration have a **"Show details"** toggle to expand the
  full text inline.

**How to use it:** read the timeline bottom-to-top to follow an agent's life
story — when it started working, what milestones it hit, when/why it finished or
failed. Use the **"All agents"** breadcrumb to go back.

**Where the data comes from:** `/api/agents/:short/timeline`, reading
`~/.claude/jobs/<short>/timeline.jsonl` (one event per line). The timeline shows
even for agents no longer in the main list.

---

## 3. Sessions — _browse & read transcripts_

**Purpose:** read the actual conversation transcripts of your Claude Code
sessions across all projects.

**What you see:**

- **List view:** cards sorted by most-recent activity, each showing a title
  (from the first user prompt or an AI-generated title), the project label,
  message count, tool-use count, the model used, and last-activity time.
- **Transcript view** (after clicking a card): a back button, a header repeating
  the session summary, and the **full message stream in chronological order** —
  each message with a role pill (user/assistant), a tool-name badge where a tool
  was invoked, a red error badge if the step errored, a timestamp, and the
  message body.

**How to use it:** find a past session by title/project, click in, and scroll the
conversation. Read-only — good for reviewing what an agent or you actually did.
Use **back** to return to the list.

**Where the data comes from:** `/api/sessions` (list) and
`/api/sessions/:project/:id` (one transcript), reading
`~/.claude/projects/<encoded-project>/<session-id>.jsonl`.

---

## 4. Activity — _global prompt feed_

**Purpose:** a single chronological stream of recent prompts/commands issued
across **all** projects and sessions — your "what have I been doing lately"
firehose.

**What you see:** a newest-first list; each row shows the project name, a
relative timestamp, and the prompt text (truncated to ~240 chars).

**How to use it:** skim it as a recent-activity log spanning everything,
regardless of which project or session it belonged to. Read-only.

**Where the data comes from:** `/api/activity`, reading `~/.claude/history.jsonl`
(the global append-only prompt log), most recent ~100 entries.

---

## 5. Projects — _working directories overview_

**Purpose:** a directory-level roll-up — every project folder Claude Code has
worked in, with how much activity each has.

**What you see:** a grid of project cards, each with the short folder name, the
full decoded path (hover for the whole thing), a **session-count** badge, and the
last-activity timestamp.

**How to use it:** see which repos/folders are most active and when each was last
touched. Informational only — there's no drill-in action from here (use
Sessions/Search to read content).

**Where the data comes from:** `/api/projects`, scanning the subdirectories under
`~/.claude/projects/` (one encoded dir per project path), counting `.jsonl`
session files and reading the newest modified time.

---

## 6. Search — _full-text across all transcripts_

**Purpose:** find any text anywhere in your session history — a phrase someone
said, a file name, an error message.

**What you see:** a search box; as you type, a live result count and a list of
matches. Each result shows a type badge (user/assistant), the project label, the
first 8 chars of the session ID, and a **snippet** centered on the match with
your query terms **highlighted in yellow**. Helper states tell you "Type to
search", "Searching…", or "No matches".

**How to use it:** just type — results update live (debounced ~300ms), capped at
100 matches, case-insensitive substring matching. This is the fastest way to
relocate a conversation when you don't remember which session it was in.

**Where the data comes from:** `/api/search?q=`, scanning every
`~/.claude/projects/<project>/<session>.jsonl` line by line per query (no
background polling — it queries on each keystroke).

---

## 7. Stats — _usage analytics_

**Purpose:** aggregate usage analytics across all your Claude Code activity.

**What you see:**

- **Headline metric cards:** total sessions, messages, tool calls, total tokens,
  output tokens, cache reads, active days, models used (compact `k/M/B`
  formatting). Plus, when available: total cost (USD), longest session duration,
  and first-session date.
- **By-model breakdown:** one row per model (with the `claude-`/date noise
  stripped), total tokens, a horizontal bar, and an
  input/output/cache-read/cache-creation/web-search split — sorted by token
  volume.
- **Activity-by-hour chart:** 24 bars showing which hours of the day you're most
  active.
- **Recent daily activity:** a last-30-days table with per-day token and message
  counts and a bar for relative volume.

**How to use it:** understand cost and consumption — which models dominate your
token spend, when you work, and trend over the last month. Read-only.

**Where the data comes from:** `/api/stats`, reading the pre-computed
`~/.claude/stats/stats-cache.json`. (Shape varies by CLI version, so some
secondary metrics appear only if present.)

---

## 8. Inventory — _installed extensions catalog_

**Purpose:** see everything installed into your Claude Code environment — the
agents, commands, skills, and plugins available to you.

**What you see:** four collapsible, color-accented sections, each with a count
badge:

- **Agents** (emerald) — from `~/.claude/agents/*.md`
- **Commands** (sky) — from `~/.claude/commands/*.md`
- **Skills** (amber) — from `~/.claude/skills/*.md`
- **Plugins** (rose) — from `~/.claude/plugins/installed_plugins.json`, showing
  marketplace and version

Each item shows its name and description (pulled from markdown frontmatter,
falling back to the filename and first prose line).

**How to use it:** click section headers to expand/collapse. It's a reference
catalog — "what do I have available and what does each do." No install/remove
actions.

**Where the data comes from:** `/api/inventory`.

---

## 9. Tasks — _task-queue workspace inventory_

**Purpose:** a low-level view of Claude Code's internal task directories (the
in-session task queue's working folders).

**What you see:** a list of task rows, each with the task UUID, a **highwatermark**
badge (e.g. "hwm 42") if present, the file count in the directory, a **lock
status** (amber = locked, emerald = open), and the last-updated time.

**How to use it:** mostly diagnostic — see which task workspaces exist, which are
currently locked (in use), and their progress marker. This is metadata, not task
content. Read-only.

**Where the data comes from:** `/api/tasks`, scanning `~/.claude/tasks/<uuid>/`
for `.lock` and `.highwatermark` files and directory mtime.

---

## 10. Cron — _honest empty state by design_

**Purpose:** to explain why scheduled/recurring routines **can't** be shown as a
live table — and what would be needed to surface them.

**What you see:**

- A **"not watchable"** panel explaining that cron routines aren't stored on disk.
- A **"path forward"** panel describing how a polling host process _could_
  publish them to a file Argus could then watch.
- An **on-disk scan** result: Argus name-matches anything in `~/.claude` that
  looks schedule-related (`cron`/`routine`/`schedul`) and lists candidates as
  _hints only_ (usually "nothing found").

**Why it's like this:** Claude Code's scheduled routines are **session-scoped** —
they exist only inside a running Claude session and are enumerable solely via the
in-session `CronList` tool. A pure file-watcher fundamentally cannot see them, so
Argus is deliberately honest about the limitation rather than faking a table.

**Where the data comes from:** `/api/cron`, which returns
`{ available: false, reason, howTo }` plus any filename hints.

---

## Quick mental model

| Tab           | Answers the question                      | Source file(s)                             |
| ------------- | ----------------------------------------- | ------------------------------------------ |
| **Agents**    | What's running / done / failed right now? | `jobs/*/state.json` + `daemon/roster.json` |
| **Detail**    | How did _this_ agent get here?            | `jobs/<short>/timeline.jsonl`              |
| **Sessions**  | What was actually said in a conversation? | `projects/*/*.jsonl`                       |
| **Activity**  | What have I prompted lately, everywhere?  | `history.jsonl`                            |
| **Projects**  | Which folders are active, and when?       | `projects/*/`                              |
| **Search**    | Where did I say/see _that_?               | all `projects/*/*.jsonl`                   |
| **Stats**     | What's my usage / cost / token spend?     | `stats/stats-cache.json`                   |
| **Inventory** | What's installed and available?           | `agents/ commands/ skills/ plugins/`       |
| **Tasks**     | What task workspaces exist / are locked?  | `tasks/<uuid>/`                            |
| **Cron**      | Why can't I see scheduled routines?       | none (session-scoped)                      |
