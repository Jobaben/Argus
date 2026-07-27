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
(schedules, pipelines, per-run records, instances and issue triage) plus, when the user
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

| Workspace    | Runtime                         | Responsibility                                               |
| ------------ | ------------------------------- | ------------------------------------------------------------ |
| `contracts/` | Types only, no runtime          | Every DTO that crosses the HTTP/WS boundary, declared once   |
| `server/`    | Node 22 + TS (tsx)              | Read `~/.claude`, expose REST + WebSocket, watch for changes |
| `web/`       | Vite 8 + React 19 + Tailwind v4 | Tabbed dashboard, live refresh                               |

Dev: `npm run dev` → server `:7777`, web `:5757` (Vite proxies `/api` and `/ws`
to the server). One command, two processes via `concurrently`.

### The contract workspace

`@argus/contracts` holds every boundary-crossing shape — agents, schedules and
runs, pipelines and instances, monitors, issues, budget, chronicle, briefing,
the palette index, the situation strip, and the WebSocket frame union. Both other
workspaces import it, so a producer change that breaks a consumer fails
`npm run typecheck` instead of drifting silently. Before it existed the same ~25
DTOs were declared twice, and nothing forced the copies to agree.

It is **types-only** by construction: every export erases at compile time, so
there is no build step, no runtime dependency, and nothing for the server's
compiled `dist/` to resolve. `scripts/check-contracts-runtime.mjs` compiles the
package for real and fails CI if any file emits runtime code — which is also why
its `index.ts` spells out `export type` instead of `export *`.

Server-internal shapes stay in `server/src`: on-disk file formats (`JobState`,
`SpendLedger`, `TriageRecord`), engine state, and validation inputs are not
contracts, because the web cannot observe them.

## 3. Server layering (SOLID)

```
src/
  claudeHome.ts        — single source of truth for path resolution
  log.ts               — one structured logger (text or JSON lines)
  httpCache.ts         — ETag / If-None-Match for every read
  requestLog.ts        — per-request id + timing, as a Hono middleware
  sources/             — one module per data domain (SRP)
    readJson.ts        — readJson / readJsonl primitives (DRY)
    types.ts           — re-exports the agent contract + the on-disk JobState
    jobs.ts daemon.ts sessions.ts history.ts projects.ts
    stats.ts inventory.ts tasks.ts search.ts cron.ts
    insight.ts         — the board situation (derived)
    palette.ts         — the command palette index (derived)
  watch.ts             — chokidar → debounced change callback
  app.ts               — the Hono app factory (testable, no side effects)
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

`watch.ts` watches `jobs/`, `daemon/roster.json`, `daemon.status.json`,
`history.jsonl` and `projects/`. Changes are **debounced ~150ms** and emit a
single change frame over `/ws`. The client treats the socket as a _dumb tap_: a
frame means "something changed, re-fetch" — the server stays the single source of
truth and payloads never diverge from a fresh `GET`. A polling fallback keeps the
UI correct while the socket is down.

This "ping, then re-fetch" design (vs. pushing diffs) is deliberate: it keeps the
server stateless per-connection and makes every view trivially correct. Three
things make it cheap enough to lean on:

1. **Conditional GETs.** Every read carries a strong `ETag`; the next fetch sends
   it back as `If-None-Match`. A broadcast that did not actually change _this_
   resource returns `304` with no body, and the client skips its state update —
   so a no-op ping costs a ~100-byte round trip and zero re-renders. (Getting to
   _actually_ zero required one subtlety: React still renders a component once
   before bailing out of a same-value `setState`, so the 304 path is not allowed
   to touch state at all, not even to re-clear an already-null error.)
2. **Single-flight coalescing.** The engine emits a frame per step transition. A
   fetch per frame let an older response land after a newer one and win; an
   in-flight request now absorbs the burst and re-runs exactly once after it
   settles.
3. **Jittered backoff, both layers.** Failed fetches and dropped sockets both
   double to a 30s ceiling with jitter rather than retrying in lockstep forever,
   and the socket reconnects immediately on tab-visible or browser-online — so
   the long tail of the backoff is never what the user waits on. While a fetch is
   failing the last good value stays on screen, marked stale, rather than being
   blanked.

Two frame types carry payloads because they cannot be re-derived from a `GET`:
alert transitions (which exist only at the instant they happen) and run-activity
tail deltas. Payload validation lives in one place in the client socket, so a
truncated batch is dropped rather than rendering as `undefined` deep in a view,
while an unrecognised frame _type_ is still forwarded for forward compatibility.

## 5. Data sources map

| Domain            | Path(s)                                         | Shape highlights                                                                     |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Background agents | `jobs/<short>/state.json`, `timeline.jsonl`     | `state` (working/done/failed/idle), `tempo`, `detail`, `output.result`, `inFlight`   |
| Live workers      | `daemon/roster.json`, `daemon.status.json`      | `workers[short].pid` → liveness join                                                 |
| Sessions          | `projects/<proj>/<id>.jsonl`                    | typed message stream (`ai-title`, `user`, `assistant`, `tool_use`, …)                |
| Activity          | `history.jsonl`                                 | global prompt log                                                                    |
| Projects          | `projects/<proj>/`                              | encoded path → label, session counts                                                 |
| Stats             | `stats-cache.json`                              | usage aggregates                                                                     |
| Inventory         | `agents/ commands/ skills/ plugins/`            | installed extensions (md frontmatter)                                                |
| Tasks             | `tasks/<uuid>/`                                 | `.highwatermark`, `.lock`                                                            |
| Cron              | — (not on disk)                                 | session-scoped; see §6                                                               |
| Flight Recorder   | run record + `projects/<proj>/<id>.jsonl`       | derived per read; never persisted (see below)                                        |
| Watchtower        | runs + `argus/watchtower.json`                  | envelopes derived per read; only reset markers persist                               |
| Autopsy           | `argus/autopsies.json`                          | bounded `claude -p` verdicts, capped at 200, keyed by run id                         |
| Verdict           | `argus/verdicts.json` + rubrics on defs         | rubric scores keyed by run id, capped at 400; trends derived per read                |
| Sentinel          | `argus/incidents.json`, `argus/sentinel.json`   | persisted incidents (so a restart resumes mid-incident) + escalation policy          |
| Ledger            | runs + `argus/spend.json` + `argus/budget.json` | attribution, forecast and enforcement all derived per read; only the ladder persists |

### Derivation over storage: the Flight Recorder

`sources/recorder.ts` is the shape every derived feature here should take:
a single pure function, `(run, transcript lines, now) → Recording`, with the
route in `app.ts` doing nothing but the reading. Three consequences are worth
naming, because they are the reasons to prefer this shape over a materialized
timeline table:

- **It cannot drift.** There is no second copy to fall out of sync with the
  transcript, and no migration when the derivation improves — the next read is
  the new version.
- **It is entirely testable without a filesystem.** The recorder's regression
  suite feeds it hand-built line arrays: out-of-order timestamps, orphaned tool
  results, malformed JSON, a transcript past the event cap.
- **It degrades rather than throws.** Every shape check treats the transcript as
  untrusted input, because a newer CLI writing an unfamiliar line must cost the
  timeline one event, not the whole route.

The cost is recomputation per read, which the ETag layer absorbs: an unchanged
run answers `304` with no body, so an open recording on a quiet board is free.

### Reading a directory of records, cheaply

Runs and pipeline instances are each a directory of small JSON files, and nearly
every route touches one or both. Three layers keep that affordable, in increasing
order of subtlety:

1. **A short-TTL single-flight scan cache** (1500ms, keyed by directory). One
   broadcast makes six routes call `readRuns()` within milliseconds; they share
   one scan. The TTL is what bounds staleness from writes Argus did not make.
2. **An mtime-keyed parse memo** (`sources/fileMemo.ts`), so an unchanged file
   costs a `stat` rather than a read plus `JSON.parse`. Retention is by **scan
   membership, not recency** — an LRU is the wrong policy here, because a
   full-directory scan touches every file once in order and therefore evicts each
   entry just before the next scan wants it. Memory is bounded by what pruning
   leaves on disk; the ceiling is a runaway guard.
3. **Write-patching.** A write updates the cached scan in place (re-reading only
   the file it changed) instead of dropping it. Without this, a running pipeline —
   which writes on every step transition — forced every reader to re-stat the
   whole directory between transitions. The patch deliberately does not refresh
   the entry's timestamp, so it cannot extend the TTL window in which an external
   edit goes unseen.

Read-after-write stays exact throughout: the write's own patch (or, on a miss, an
invalidation) lands before it returns.

### Derived state has no transitions — so something has to diff it

Monitor health, budget state and Watchtower envelopes are all computed on read.
That is the right shape for correctness (see above) and the wrong shape for
alerting: nothing ever _observes_ a derived value changing, so "the monitor went
down" and "this run left its envelope" are events that do not exist until
someone compares two derivations.

Each of the three therefore has a watcher (`monitorWatcher`, `budgetWatcher`,
`watchtowerWatcher`) that re-derives on the scheduler tick and diffs against the
previous pass. They share three rules, learned the hard way:

1. **The first pass after boot is a silent baseline.** Otherwise a restart
   replays every currently-bad state into the bell as though it just happened.
2. **A throwing handler must not stop the remaining alerts**, and a failed read
   must not wedge the tick. Both are caught per-item.
3. **Identity beats state where it can.** Monitor alerts must diff statuses,
   because a status is a mutable property of a schedule. Anomaly ids are
   deterministic (`key|metric|runId`), so Watchtower needs only a bounded set of
   ids already seen — no persisted alert log, and no chance of re-alerting
   because a baseline shifted slightly underneath an old run.

### One place that asks a model a question

Four features want a bounded `claude -p` pass over Argus's own state: Autopsy's
postmortem, and (by design) a judge, a diagnostic and a planner. Each is a way
to accidentally spend unbounded money, run unbounded time, or hand a model
something it can act on. Rather than four spawn sites with four sets of
nearly-correct guards, `sources/analysis.ts` owns all of them:

- **Bounded time** — a hard timeout that kills the process _group_, because
  `claude` spawns children and killing the parent orphans them.
- **Bounded output** — stdout capped, process killed past the cap.
- **Bounded concurrency** — one pass at a time, and the slot is claimed
  _synchronously_, before the first `await`. Taking it after a budget read let
  two callers both observe an idle runner and both spawn.
- **Bounded spend** — every pass is metered into the ledger real runs use, even
  when it fails, and refuses to start under the budget hard stop. Argus
  explaining an overspend must not be part of the overspend.
- **No tools** — the prompts inline everything the pass needs, so it never
  reaches for the repository, and the prompt goes in on stdin so no shell parses
  it.

`spawn` is a parameter, so the timeout, the output cap, the parse failure and
the budget refusal are all exercised in tests without a CLI on the box.

### Where model-backed side effects are allowed to live

Verdict can auto-approve a pipeline gate, which is the most consequential thing
a model does in Argus. It deliberately does **not** happen inside the engine.

The engine's signal path runs under the instance lock, inside an HTTP handler
that the signalling child process is still blocked on, and that child may hold
the last concurrency slot. A 90-second model call there is not slow — it is a
deadlock. So the judge and the gate-opener sit in a watcher on the scheduler
tick, calling the engine's ordinary `approve()` from outside. The cost is up to
one tick of latency; the benefit is that the engine's locking story is unchanged
and a hung analysis pass cannot wedge a pipeline.

The same reasoning applies to Autopsy: the postmortem never runs in the run
completion handler, only in a watcher afterwards.

### The one watcher whose state is on disk

Monitors, budget and Watchtower diff a snapshot held in memory: the first pass
after boot is silent, and nothing survives a restart. Sentinel cannot work that
way — an incident is precisely the thing that must outlive a restart, because
the question it answers is "has anyone dealt with this yet".

So its previous state is the incident file, and the consequences follow:

- The whole reconcile-and-persist is inside **one store lock**, so two ticks —
  or a tick and a human acknowledging — cannot lose each other's writes.
- Identity is derived from the condition (`monitor:<id>` → a hash), not
  generated, so a restart mid-incident reads the same incident rather than
  opening a second one.
- The read-only diagnostic runs _outside_ that lock, because it can take ninety
  seconds and holding the store for that long would block acknowledgements —
  then re-reads under the lock before attaching, so a human's edit during the
  pass survives.

### Replacing a cursor with a graph, without a second executor

The pipeline engine used to walk `currentPhaseIndex`. Weave replaced that with a
DAG, and the refactor was shaped around one rule: **there must not be a linear
executor and a general executor**, because the two would drift and the linear one
is the one every existing pipeline depends on.

So a linear pipeline is _defined_ as a DAG in which each phase needs its
predecessor (`sources/dag.ts`, `resolveNeeds`), and every transition funnels
through a single `settle()` in `pipelineTransitions.ts`, which computes
readiness, terminality and the current index in one place. The engine's
`startPhase` became `startPhases`; nothing else about its locking, slots or
process handling changed.

Three consequences worth naming, because each was a bug before it was a design:

- **Failure is not immediately terminal.** With a fan-out, flipping the instance
  to `failed` the moment one branch fails renders a stopped pipeline with a live
  process still writing into it. The failure lands on the phase; the instance
  settles when nothing can progress.
- **Kill scope became explicit.** `killPhaseRuns` takes phase ids rather than
  deriving them from "what is live", because abort must reach phases it has
  _already_ marked terminal while revise must **not** reach a sibling branch
  that is legitimately running.
- **Deferred launches re-resolve by id.** The post-signal launch happens under a
  fresh lock acquisition; an abort landing in that window changes which indices
  mean what, so the wave is re-resolved by phase id before spawning.

The whole 735-test suite that predated Weave passes unchanged, which is the
actual guarantee behind "linear definitions load unchanged".

### No price list: why the Ledger refuses some questions

`sources/ledger.ts` could answer every what-if by shipping a table of
per-million-token prices. It deliberately does not. A saving computed from a
price table is indistinguishable, in the UI, from one measured on this machine —
and it is wrong the week the prices change, silently, in the direction of
confidence. So the simulator compares what two models **have actually cost
here**, and when the target model has never run, the result type carries an
`unavailable` string instead of a number.

The same rule produces three more refusals, each encoded in the types rather
than in a comment:

- **No forecast under three days** (`MIN_FORECAST_DAYS`). Every projected field
  is `null` and the note says how many days exist. Three points extrapolate to
  any figure you like; a confident-looking number derived from two days is worse
  than no number.
- **`confidence: null`, and a visible band.** Confidence is computed from the
  observed p20–p80 spread, so it describes how well _this_ history extrapolates
  rather than how right the answer is.
- **`verdictDelta: null` means unmeasured, not zero.** It is only a number when
  both models have Verdict scores, because "nobody has measured" is the true
  answer far more often than "no difference".

Two decisions inside the maths are load-bearing enough to name. The daily rate
is a **median** and **excludes today**: a mean lets one runaway backfill day set
the trend for a month, and including a partial day makes the projection sag
every morning and recover every evening — a graph that moves for reasons that
are not about spending. And in `enforcementFor`, the **highest** matching ladder
step wins rather than the first; with warn@0.8 / stop@1.0, a first-match reading
would only warn a run that is 5% over the cap.

Finally, enforcement is written onto the run it affected (`budgetAction`,
`modelDowngradedFrom`) rather than inferred later. The policy is editable; the
run record is not. Without that field, "why did Tuesday's run use Haiku?"
requires correlating a timestamp against a policy that may since have changed,
which is exactly the class of question a control plane exists to answer
directly.

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

## 8. Client architecture

```
web/src/
  cmd/          — the command layer: palette, fuzzy ranking, keyboard map
  ds/           — presentational primitives, skeletons, motion, the shared clock
  live/         — one shared socket + one live-resource primitive
  notify/       — toasts, native notifications, the session notification log
  views/        — one file per route
```

Three rules hold it together:

- **One socket, one fetch primitive.** Every view's data comes from
  `useLiveResource`; nothing else opens a connection or owns a poll timer.
- **One clock.** Relative timestamps read a single module-level clock through
  `useSyncExternalStore` (quantised so the snapshot is stable between ticks)
  rather than each computing `Date.now()` at render — which was both impure and
  the reason "3m ago" never updated. `useTicker` is the per-second escape hatch
  for countdowns and elapsed timers, and it stops when nothing is running.
- **Failure is scoped.** Each route renders inside an error boundary keyed on the
  route, so an unexpected shape in one view costs that view, not the nav, the
  palette and every other tab.

Every route except the landing one is a lazy chunk, and
`scripts/check-bundle-size.mjs` holds the initial gzipped payload under a budget
in CI.

## 9. Deployment shape

Single user, localhost. `npm run build` produces a static `web/dist` the server
can serve directly (future: mount static + collapse to one port). OS-agnostic by
construction — only `os.homedir()` and Node are assumed. A future Tauri shell
could wrap it for tray + native "agent finished" notifications.
