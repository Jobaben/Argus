# Announcement post (draft)

> Status: **draft — do not publish without owner sign-off.**
> Target: blog / dev.to / X thread / Reddit r/ClaudeAI — trim to taste.

---

## Argus: a control plane for Claude Code agents that work while you don't

Claude Code quietly crossed a line in the last year: agents stopped being
something you watch and started being something you _delegate to_. Nightly
triage runs. Scheduled dependency audits. Multi-phase pipelines that grind
through a backlog at 3am.

Which raises a question nobody's tooling was answering: **who's watching the
agents?**

When an unattended run fails at 3am, nothing tells you. When it fails the
same way twenty nights in a row, nothing groups those into "one problem,
twenty occurrences." When a scheduled job silently _doesn't fire_ — laptop
asleep, process dead — no runs list can show you a run that never existed.
And nothing at all stands between an unattended loop and your API bill.

Argus is my answer. It's a local-first, open-source control plane for Claude
Code agents:

- **Schedule** headless `claude -p` runs on interval/daily/weekly triggers —
  with history, cancel, and catch-up for slots missed while the machine slept.
- **Cap spend.** Every run reports its real dollar cost. Set daily/monthly
  limits; optionally hard-stop scheduled firings while over budget. Manual
  actions always work — a human clicking a button is its own authorization.
- **Gate the consequential steps.** Pipelines pause at human gates: approve,
  revise with feedback, or abort before the next phase spends anything.
- **Alert on the failure you can't see.** Dead-man's-switch monitors catch
  the slot where nothing ran. Failures, downed monitors, and budget
  crossings reach you as notifications and webhooks.
- **Audit everything.** Failures are fingerprinted into issues, Sentry-style.
  Any run replays as a scrubbable timeline. Full-text search covers your
  whole agent history.

It's deliberately modest in scope: **single-user, local-first, Claude Code
only.** It runs on your machine, binds to loopback, treats Claude Code's
state as strictly read-only, and refuses to open a non-loopback port without
token auth — because a thing that can spawn agents with your credentials
should be paranoid on your behalf.

Getting started is one clone and one command:

```bash
git clone https://github.com/Jobaben/Argus.git && cd Argus
node bin/argus.mjs --open
```

**I have exactly zero users and I'd like some.** If you run Claude Code
agents unattended — or you would, if something were watching them — I want
to hear what breaks and what's missing:

- Bugs and feature requests: https://github.com/Jobaben/Argus/issues
- What gets built next: the pinned [roadmap issue](https://github.com/Jobaben/Argus/issues/20) asks one question —
  should the next thing be a **remote-ingestion adapter** (watch agents on
  your CI/servers) or a **team/fleet edition** (one pane for several
  humans)? Real demand decides.
