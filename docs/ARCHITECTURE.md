# Argus — Architecture

> The all-seeing monitor for Claude Code. A dashboard **and control plane** over
> `~/.claude`: it reads the state Claude Code owns and manages its own
> scheduler/pipeline state alongside it.

## 1. Principle: read Claude's state, own only Argus's

Argus treats the state Claude Code owns — `jobs/`, `daemon/`, `projects/`,
`history.jsonl`, `tasks/`, `stats-cache.json` — as **strictly read-only**. It
never mutates those files, so it is safe to run alongside live sessions and
cannot corrupt the state it observes.

Argus does **own and write** its own state, all confined to `~/.claude/argus/`
(schedules, pipelines, per-run records and instances) plus, when the user
applies setup fixes, its signal hook under `~/.claude/hooks/` and a hook entry
in `settings.json`. All Argus writes go through an atomic tmp+rename writer and
are serialized per file/instance by a keyed mutex.

Because it can spawn `claude -p` agents with the user's credentials, the HTTP
surface is a privileged single-user control plane: loopback-bound by default,
with a Host allowlist (anti DNS-rebind), an Origin check on mutations (anti
CSRF), and an optional bearer token — all applied to the WebSocket upgrade too.

On top of those transport-level layers, **editing or running pipelines requires
an admin login** (`server/src/auth.ts`). The admin account is created on first
run from the Pipelines tab; the password is persisted only as a salted scrypt
hash in `~/.claude/argus/auth.json` (mode 0600), and sessions are random
256-bit tokens in an `HttpOnly; SameSite=Strict` cookie, kept server-side as
SHA-256 digests in memory (12 h TTL, restart = signed out, brute-force
lockout on the login route). Reads stay open so the dashboard works without a
login; the agent-facing signal endpoint keeps its own per-instance token
instead. See docs/API.md § Admin authentication.

```
┌────────────────────┐   read-only (chokidar watch)  ┌─────────────────────┐
│  Claude's state     │ ───────────────────────────▶ │  server (Hono+ws)   │
│  jobs/ daemon/      │      read on demand           │  /api/* + /ws       │
│  projects/ history  │                               │  createApp factory  │
├────────────────────┤   read + atomic writes        │  + scheduler/engine │
│  ~/.claude/argus/   │ ◀───────────────────────────▶ │                     │
│  schedules pipelines│                               └──────────┬──────────┘
│  runs/ instances/   │       spawn `claude -p`  ◀───────────────┤ JSON + ws push
└────────────────────┘                              ┌──────────▼──────────┐
                                                     │  web (Vite/React)   │
                                                     │  one live socket +  │
                                                     │  useLiveResource    │
                                                     └─────────────────────┘
```

## 2. Workspaces

| Workspace | Runtime                         | Responsibility                                               |
| --------- | ------------------------------- | ------------------------------------------------------------ |
| `server/` | Node 22 + TS (tsx)              | Read `~/.claude`, expose REST + WebSocket, watch for changes |
| `web/`    | Vite 8 + React 19 + Tailwind v4 | Tabbed dashboard, live refresh                               |

Dev: `npm run dev` → server `:7777`, web `:5757` (Vite proxies `/api` and `/ws`
to the server). One command, two processes via `concurrently`.

## 3. Server layering (SOLID)

```
src/
  claudeHome.ts        — single source of truth for path resolution
  sources/             — one module per data domain (SRP)
    readJson.ts        — readJson / readJsonl primitives (DRY)
    types.ts           — shared domain types
    jobs.ts daemon.ts sessions.ts history.ts projects.ts
    stats.ts inventory.ts tasks.ts search.ts cron.ts
  watch.ts             — chokidar → debounced change callback
  index.ts             — composition root: wires sources to routes + ws
```

- **Single Responsibility** — each `sources/*.ts` owns exactly one domain and
  exports plain async functions returning normalized DTOs.
- **Dependency Inversion** — sources depend on `paths`/`claudeHome`, not on
  hardcoded locations; `index.ts` is the only place that knows about HTTP.
- **Open/Closed** — adding a view = add a `sources/x.ts` + register one route;
  nothing existing changes.

### Path discipline (cross-OS)

`claudeHome()` derives the root from `os.homedir()` (or `ARGUS_CLAUDE_HOME` /
`CLAUDE_CONFIG_DIR`). Data files frequently embed **foreign** absolute paths —
e.g. a Windows `cwd: C:\GIT\Spectacle` sitting inside a Linux `~/.claude`. Those
are display-only. Correlation always keys off `sessionId` and the **encoded
project-dir name** (`-home-mtrushbad-GIT`, `C--GIT-Spectacle`), never the
embedded path. Path splitting tolerates both separators: `split(/[\\/]/)`.

## 4. Live update protocol

`watch.ts` watches `jobs/`, `daemon/roster.json`, `daemon.status.json` (and, as
features land, `history.jsonl` / `projects/`). Changes are **debounced ~150ms**
and emit a single `{type:"agents:changed"}` frame over `/ws`. The client treats
the socket as a _dumb tap_: a frame means "something changed, re-fetch" — the
server stays the single source of truth and payloads never diverge from a fresh
`GET`. A 10s polling fallback keeps the UI correct if the socket drops, with
auto-reconnect (2s backoff).

This "ping, then re-fetch" design (vs. pushing diffs) is deliberate: it keeps the
server stateless per-connection and makes every view trivially correct.

## 5. Data sources map

| Domain            | Path(s)                                     | Shape highlights                                                                   |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| Background agents | `jobs/<short>/state.json`, `timeline.jsonl` | `state` (working/done/failed/idle), `tempo`, `detail`, `output.result`, `inFlight` |
| Live workers      | `daemon/roster.json`, `daemon.status.json`  | `workers[short].pid` → liveness join                                               |
| Sessions          | `projects/<proj>/<id>.jsonl`                | typed message stream (`ai-title`, `user`, `assistant`, `tool_use`, …)              |
| Activity          | `history.jsonl`                             | global prompt log                                                                  |
| Projects          | `projects/<proj>/`                          | encoded path → label, session counts                                               |
| Stats             | `stats-cache.json`                          | usage aggregates                                                                   |
| Inventory         | `agents/ commands/ skills/ plugins/`        | installed extensions (md frontmatter)                                              |
| Tasks             | `tasks/<uuid>/`                             | `.highwatermark`, `.lock`                                                          |
| Cron              | — (not on disk)                             | session-scoped; see §6                                                             |

## 6. The cron boundary (known limitation)

Scheduled routines are **not persisted to `~/.claude`**. They are session-scoped
and only enumerable via the in-session `CronList` tool. A file-watcher
fundamentally cannot see them. Argus therefore ships a cron view that is honest
about this and documents the path forward: a small **polling host** (a long-lived
process inside a Claude session, or a future server-side API) that periodically
publishes the cron list to a file Argus could then watch. Until that exists, the
cron tab is an informative empty state — not a fake.

## 7. Failure posture

Every read is defensive: missing/ð malformed files degrade to empty results, not
crashes (`readJson(file, fallback)`, per-line `try/catch` in `readJsonl`). A
half-written `state.json` caught mid-flush simply yields the previous value on
the next debounce tick. The dashboard surfaces server-unreachable as a banner,
never a blank screen.

## 8. Deployment shape

Single user, localhost. `npm run build` produces a static `web/dist` the server
can serve directly (future: mount static + collapse to one port). OS-agnostic by
construction — only `os.homedir()` and Node are assumed. A future Tauri shell
could wrap it for tray + native "agent finished" notifications.
