# Show HN (draft)

> Status: **draft — do not post without owner sign-off.**

## Title

> Show HN: Argus – open-source control plane for Claude Code agents (schedules, budget caps, human gates)

(80 chars incl. "Show HN:" prefix — fits. Fallback if too feature-listy:
"Show HN: Argus – who watches your Claude Code agents while you sleep?")

## URL

https://github.com/Jobaben/Argus

## First comment (posted immediately by the author)

Hi HN — author here.

I started running Claude Code agents unattended (nightly triage, scheduled
dependency audits, long multi-phase pipelines) and kept hitting the same
three problems:

1. **Silent failure.** A scheduled run dies at 3am and nothing tells you.
   Worse: a run that never _fires_ (laptop asleep, process dead) is
   invisible to any runs list, because there's no run to list.
2. **Unbounded spend.** Nothing stood between an unattended loop and my API
   bill.
3. **No checkpoint.** Some pipeline steps shouldn't proceed without a human
   looking first, and "hope I'm at the keyboard" isn't a mechanism.

Argus is a local-first dashboard + control plane that fixes those: it
schedules headless `claude -p` runs, enforces daily/monthly budget caps
(over-budget scheduled firings are skipped and _recorded as skipped_, so you
can see what didn't happen), pauses pipelines at human approval gates, groups
failures by fingerprint into issues (twenty timeouts = one issue ×20), and
runs dead-man's-switch monitors per schedule so the missing 3am slot pages
you instead of hiding.

Design choices you may disagree with, stated up front:

- **Single-user and local-first, on purpose.** It reads the `~/.claude`
  directory Claude Code already writes, on your machine. No SaaS, no
  telemetry, your transcripts never leave your disk.
- **Security posture over convenience.** It can spawn agents with your
  credentials, so it binds loopback-only, checks Host and Origin on
  everything including the WebSocket, and refuses to start on a non-loopback
  interface without a bearer token — enforced, not a README warning.
- **Claude Code only, for now.** One agent runtime done properly first.

Stack: TypeScript end to end — Node 22 + Hono + chokidar + ws on the server,
React 19 + Vite + Tailwind on the web side, with all wire DTOs in one shared
types-only package.

What's next is genuinely undecided, and that's the feedback I'm here for:
the pinned roadmap issue asks whether the next milestone should be a
**remote-ingestion adapter** (watch agents running on CI/servers) or a
**team/fleet edition** (multiple humans, one pane). If you run agents
unattended, I'd love to know which of those you'd actually use — or what
I've missed entirely.

Apache-2.0. Quickstart is one clone + one command (`node bin/argus.mjs
--open`); it builds itself on first run.
