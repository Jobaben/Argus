# Argus — Architecture

> The all-seeing monitor for Claude Code. A pure **reader** over `~/.claude`
> that turns local agent/job state into a live dashboard.

## 1. Principle: read, never write

Argus never mutates `~/.claude`. Every feature is a projection of files Claude
Code already maintains. This keeps Argus safe to run alongside live sessions and
means it can never corrupt the very state it observes. The only side effects are
HTTP responses and WebSocket pushes.

```
┌────────────────────┐      watch (chokidar)        ┌─────────────────────┐
│   ~/.claude/*       │ ───────────────────────────▶ │  server (Hono+ws)   │
│  jobs/ daemon/      │      read on demand          │  /api/* + /ws       │
│  projects/ history  │ ◀─────────────────────────── │  pure reader        │
└────────────────────┘                              └──────────┬──────────┘
                                                                │ JSON + ws push
                                                     ┌──────────▼──────────┐
                                                     │  web (Vite/React)   │
                                                     │  tabbed dashboard   │
                                                     └─────────────────────┘
```

## 2. Workspaces

| Workspace | Runtime | Responsibility |
| --- | --- | --- |
| `server/` | Node 22 + TS (tsx) | Read `~/.claude`, expose REST + WebSocket, watch for changes |
| `web/` | Vite 8 + React 19 + Tailwind v4 | Tabbed dashboard, live refresh |

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
the socket as a *dumb tap*: a frame means "something changed, re-fetch" — the
server stays the single source of truth and payloads never diverge from a fresh
`GET`. A 10s polling fallback keeps the UI correct if the socket drops, with
auto-reconnect (2s backoff).

This "ping, then re-fetch" design (vs. pushing diffs) is deliberate: it keeps the
server stateless per-connection and makes every view trivially correct.

## 5. Data sources map

| Domain | Path(s) | Shape highlights |
| --- | --- | --- |
| Background agents | `jobs/<short>/state.json`, `timeline.jsonl` | `state` (working/done/failed/idle), `tempo`, `detail`, `output.result`, `inFlight` |
| Live workers | `daemon/roster.json`, `daemon.status.json` | `workers[short].pid` → liveness join |
| Sessions | `projects/<proj>/<id>.jsonl` | typed message stream (`ai-title`, `user`, `assistant`, `tool_use`, …) |
| Activity | `history.jsonl` | global prompt log |
| Projects | `projects/<proj>/` | encoded path → label, session counts |
| Stats | `stats-cache.json` | usage aggregates |
| Inventory | `agents/ commands/ skills/ plugins/` | installed extensions (md frontmatter) |
| Tasks | `tasks/<uuid>/` | `.highwatermark`, `.lock` |
| Cron | — (not on disk) | session-scoped; see §6 |

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
