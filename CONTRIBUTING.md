# Contributing to Argus

Thanks for considering a contribution. Argus is young; bug reports from real
usage are worth as much as code right now.

## Reporting bugs and requesting features

- **Bugs** → [open a bug report](https://github.com/Jobaben/Argus/issues/new?template=bug_report.yml).
  The single most useful thing you can include is what Argus _showed_ vs.
  what `~/.claude` actually _contained_.
- **Feature ideas** → [open a feature request](https://github.com/Jobaben/Argus/issues/new?template=feature_request.yml),
  or 👍 the pinned roadmap issue to weigh in on direction.
- **Security problems** → do **not** open a public issue; see
  [SECURITY.md](SECURITY.md).

## Development setup

```bash
git clone https://github.com/Jobaben/Argus.git && cd Argus
npm install
npm run dev      # server on :7777, web on :5757
```

Node ≥ 22 is required (see `.nvmrc`). The repo is an npm workspace:

- `contracts/` — shared wire DTOs (types only; CI enforces nothing is emitted)
- `server/` — Node + Hono API, file-watcher, WebSocket push, scheduler
- `web/` — Vite + React + Tailwind dashboard

Point Argus at a scratch directory instead of your real state while hacking:

```bash
ARGUS_CLAUDE_HOME=/tmp/argus-dev npm run dev
```

## Before you open a PR

Run the same gauntlet CI runs:

```bash
npm run check          # typecheck + lint + tests
npm run format:check   # prettier
npm run build          # web + server production build
```

A few conventions worth knowing:

- **Contracts first.** Anything that crosses the HTTP/WS boundary is declared
  in `contracts/` and imported by both sides. Never re-declare a wire shape
  locally.
- **Claude Code's state is read-only.** The server never writes to anything
  Claude Code owns; Argus-owned state lives under `~/.claude/argus/` only.
- **Tests ride along.** New behavior comes with tests — server code uses
  `node:test`, web code uses Vitest. CI has coverage gates.
- **Commit style** is conventional-commit-ish (`feat:`, `fix:`, `docs:`,
  `chore:`); look at `git log` and match it.

## Scope guardrails

Argus is deliberately **single-user, local-first, and Claude Code only** for
now. PRs that add a hosted mode, multi-tenant auth, or non-Claude-Code
backends will be closed with a pointer to the roadmap issue — not because
they're bad ideas, but because they're direction decisions that real user
demand should make first.
