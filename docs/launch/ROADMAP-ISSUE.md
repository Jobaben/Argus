# Pinned roadmap issue (source of truth for the issue body)

> Created as [issue #20](https://github.com/Jobaben/Argus/issues/20) with
> the `roadmap` label. Owner keystroke remaining: **pin it**
> (Issues → ⋯ → Pin issue) — pinning has no API.

---

**Title:** Roadmap: what should Argus build next? (vote here)

**Body:**

Argus v0.4 is feature-complete for its current scope: one human, their own
machines, Claude Code agents — scheduling, budget caps, human gates,
failure→issue grouping, dead-man's-switch monitors, full-text history, and a
read-only multi-machine view.

The next milestone is deliberately undecided. Two candidates are on the
table, and this issue exists so real demand — not my guess — picks between
them.

## Option A: Remote-ingestion adapter 📡

Watch agents that run where you aren't. A small shipper process tails
`~/.claude` on a CI runner / build box / server and streams it to the Argus
on your desk. Local-first trust model stays intact (your dashboard, your
disk); what changes is _reach_.

You want this if: your agents mostly run in CI or on remote machines, and
today Argus can only see the local ones.

## Option B: Team / fleet edition 👥

Several humans, one pane. Shared schedules and pipelines, per-user approval
gates, an audit trail of who approved what. Today's read-only Constellation
federation is the seed of this.

You want this if: more than one person is responsible for the same fleet of
agents, and "walk over to my desk to approve the gate" doesn't scale.

## How to vote

- 👍 this issue + comment **A** or **B** (a sentence on your actual setup is
  worth ten votes).
- Neither? Comment with what you'd need instead — "neither, I need X" is a
  valid and useful answer.
- Bugs and smaller feature requests: separate issues, please — the
  [bug](https://github.com/Jobaben/Argus/issues/new?template=bug_report.yml)
  and [feature](https://github.com/Jobaben/Argus/issues/new?template=feature_request.yml)
  templates are short.

I'll leave this open until one option has clearly won on real use cases,
then turn the winner into a tracked milestone.
