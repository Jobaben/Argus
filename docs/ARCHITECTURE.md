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

The one exception is the Vault's `argus/vault.sqlite`, which uses SQLite's own
WAL journalling instead. That is not a gap in the rule but the reason for it:
the atomic writer exists to give JSON files the crash-safety a database already
has, and wrapping a live database in tmp+rename would remove that guarantee
rather than add it. It is safe to make the exception there precisely because the
Vault holds no authoritative state — see §5.

Because it can spawn `claude -p` agents with the user's credentials, the HTTP
surface is a privileged single-user control plane: loopback-bound by default,
with a Host allowlist (anti DNS-rebind), an Origin check on mutations (anti
CSRF), and an optional bearer token — all applied to the WebSocket upgrade too.

One route is exempt from the bearer token and authenticates itself instead:
`/api/federation/summary`, which requires the caller to name a pairing this
machine already holds and seals its answer with that pairing's secret. See §5,
"Federation without a server", for why that is stronger than the check it
replaces rather than a hole in it.

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
| The Vault         | `argus/vault.sqlite`                            | every run/event/score past JSON retention; a rebuildable cache, never the source     |

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

### Federation without a server

`federation/` adds peers to a tool whose whole premise is that it needs no
infrastructure, so the shape was chosen to keep that true. Peer-to-peer with no
coordinator, **pull** rather than push, and opt-in per peer: with none
configured the code paths do not run at all, and single-machine stays exactly as
zero-config as it was.

Pull is what removes the server. A machine that is asleep, behind NAT, or simply
off is not a failed delivery to retry — it is a peer that did not answer this
round, which is a state the fleet view already renders. Push would need
retries, a queue, and somewhere for an undeliverable summary to wait.

**The transport is not trusted.** Peers talk over whatever the user has: a LAN,
a tailnet, a reverse proxy. So the payload is sealed end-to-end — HKDF-SHA256 to
two independent keys, AES-256-GCM to encrypt, HMAC-SHA256 over the whole
envelope to bind the header, and a timestamp plus nonce so a captured response
cannot be replayed to freeze a peer at a healthy moment. Verification order
matters and is enforced: signature, then freshness, then decrypt, so nothing
derived from an envelope is used before it verifies. TLS on top is an
improvement rather than a requirement, which matters because "set up
certificates between your laptop and your build box" is where a feature like
this stops being used.

Three decisions are worth naming because each was a smaller, worse design first.

**The pairing is named by a hash of its secret.** The responder has to know
which key to seal with. Sending the secret defeats the point; sending the
caller's own peer id does not work, because that id is local to the caller's
list and means nothing on the other machine. `HMAC("argus-pairing-id", secret)`
gives both sides the same name for the pairing without either revealing it, and
it grants nothing on its own — every byte still has to verify against the secret
it names.

**The peer endpoint is exempt from `ARGUS_TOKEN`.** Federation is only reachable
on an exposed bind, and an exposed bind requires the token, so without the
exemption pairing could only work by handing every peer the bearer that unlocks
the whole control plane. That is strictly worse: one shared secret granting
everything, versus a per-pair secret granting one read. The exemption is safe
because the route's own authentication is stronger than the one it replaces, and
because it is read-only.

**`totals.reporting` sits next to `totals.machines`.** A number summed over three
of five machines is not a fleet number. Returning only the sum would make every
client present it as one, and the failure is silent and lands on the day a
machine goes quiet — which is the day the number matters. For the same reason a
quiet peer keeps its last summary, marked stale, rather than disappearing and
shrinking the denominator.

The summary carries headline counts plus a bounded facet list per fleet-wide
view. That is a deliberate revision of a stricter first version that sent counts
only — counts cannot make Command Center, Chronicle, Issues and Budget
fleet-wide, which is the point of federating them, and a page that can only say
"seven issues somewhere" is a worse product than one that names them.

What makes it safe is not the absence of detail but who receives it: a machine
paired by hand, over a channel sealed with a secret carried between the two.
Within that the bounds are structural — twelve pipelines, twelve issues, forty
runs, every string clamped, **re-applied on receipt as well as on send**, because
a peer is a machine you trust to be yours and not one you trust to be correct.
Three fields never travel at all: prompts, working directories and session ids,
the ones certain to hold something written for one machine's eyes. The machine's
identity is a locally-minted UUID rather than a hostname, for the same reason.

Peer mode in the four views is read-only by construction — no approve, no
triage, no limits form. Those are mutations on a machine this server does not
own, and a control that would either fail or require a second write path across
the pairing is worse than no control. Chronicle also degrades deliberately: it
renders a list rather than its packed timeline, because a timeline built from
forty sampled runs shows gaps that mean _not sent_ and read as _nothing
happened_.

### The confirm step is the security model

`sources/omnibar.ts` is the only place in Argus where a model's output
influences what the system _does_ rather than what it displays. Three
constraints, in this order, are what make that acceptable.

**The vocabulary is closed.** `MutationKind` is exhaustive and checked against a
`Set` on the server; a planner cannot name a verb Argus does not already expose
behind the same admin gate. The temptation here is a generic
`{ "endpoint": …, "body": … }` shape, which is strictly more capable and turns
every future route into an attack surface the day it is added.

**The targets are resolved, not accepted.** The model supplies a verb, an id and
a value. Everything a human then reads — the label, the `before`, the `after` —
is computed from the live record. That is not defence in depth for its own sake:
if the model supplied the label, a plan could say "Staging cleanup" while
targeting the production schedule, and the preview would be worse than useless.

**Nothing is applied by the planner.** `compileIntent` returns a `Plan`;
`omnibarExecutor.ts` applies one, and only when handed a plan id that a human
confirmed. Execution takes the id rather than the sentence, so the intent is
never re-interpreted and the list that runs is the list that was read.

The consequence worth stating plainly: both the sentence _and_ the catalogue it
compiles against contain text Argus did not author — an issue title is whatever
a failing run happened to print. Prompt injection through either is expected and
uninteresting, because the worst a fully-compromised planning pass achieves is
proposing a wrong-but-legal change that a person then reads and rejects.

### Compensating, not atomic — and saying so

Argus's state is several independent JSON files, so `executePlan` cannot be a
transaction and does not claim to be one. It re-validates every mutation against
live state first (any mismatch aborts before anything is attempted), applies in
order recording inverses, and unwinds in reverse on failure.

The design decision is in the _result type_. Four statuses instead of
`ok: boolean`, and the fourth is the reason: when a rollback itself fails, the
system genuinely is part-changed, and `partial` names exactly what is still in
effect. Folding that into a generic error would be the most expensive lie this
feature could tell — it is the one outcome where a human must go and look.

`instance.abort` has no inverse and the code says so with `null` rather than
inventing a "restart" that would make a rollback report claim more than
happened. Inverses are their own small union rather than more `PlannedMutation`s
for the same reason: restoring an issue to `open` has no forward verb, because
reopening is not something a plan is allowed to propose, and reusing the plan
vocabulary would have quietly widened it.

Plans live in memory only. Surviving a restart sounds like robustness and is the
opposite: a confirmation landing against state nobody has looked at since the
process died. Losing pending plans costs a re-ask and removes a class of
stale-approval bug.

### A cache of truth: the Vault's failure model

`vault/` is the first part of Argus that is not a file the user could open in an
editor, and that changes what "correct" means for it. Three rules fall out.

**It never becomes load-bearing.** Every read path returns
`{ available: false, detail }` instead of throwing, and every caller renders a
degraded view rather than handling an exception. A Node build without
`node:sqlite`, a read-only home, a database corrupted by a full disk: each costs
the long-horizon views and nothing else. The JSON files remain authoritative for
everything they still hold, and where the two disagree the file wins — that is
what makes it safe to merge Vault rows into the Chronicle at all.

**A schema it cannot read is moved aside, not surfaced as an error.** Refusing
to start would be the conservative-looking choice and the wrong one: the Vault
is rebuildable by construction, so a fresh start costs only what the JSON files
have already pruned, while _not_ starting breaks every long view until a human
notices. The old file is kept as `vault.sqlite.corrupt-<ts>`.

**It is not written through the atomic writer, deliberately.** `atomicWrite`
exists to give JSON files the crash-safety a database already has natively;
wrapping a live SQLite file in tmp+rename would remove that guarantee rather
than add it. WAL plus SQLite's own journalling is the stronger primitive, and
preferring it is safe precisely because the Vault holds no authoritative state.

The ingest pass is idempotent rather than incremental, which is the decision the
rest of the design rests on. Every write is an upsert keyed by the record's own
identity — a run is its id, an incident event is a content hash, a spend day is
its calendar date — so re-running a pass changes nothing and the watermark is an
optimisation rather than a correctness requirement. A strictly-advancing cursor
would be faster and wrong in the case that matters most: a run that starts
before the cursor and _finishes_ after it would be recorded as running forever.
For the same reason the pass re-reads a one-hour window behind the watermark
rather than starting at it.

Two smaller decisions are worth naming because both were bugs first. Incident
timeline events are keyed by a hash of their content, not their index: the
timeline is capped, so dropping the oldest entry renumbers every survivor and an
index-keyed id would re-ingest the whole history on every prune. And a
re-ingested run has its FTS document deleted before the new one is inserted —
FTS5 has no upsert, so without that the same run matches once more after every
completed pass.

### "Related", not "semantic"

Search expansion mines terms that co-occur with the query in the user's own
corpus, scored tf-idf, and the UI says exactly that. The tempting alternative
was to ship an embedding model and call the feature semantic search. It was
rejected on two grounds: the dependency (a model file, a runtime, a warm-up)
contradicts the zero-configuration promise the rest of the Vault makes, and a
general model of English is a worse fit for a corpus of one machine's runs than
that corpus's own vocabulary is. Expanded hits are tagged `related` so they can
never pass as direct matches, and the expansion terms are returned so a reader
can see why a result appeared.

The implementation detail that keeps it cheap: candidates are gathered from the
sampled matching documents _first_, and only those terms are looked up in
`docs_vocab`. Reading the vocabulary table whole and scoring against it is the
natural way to write it and costs a full scan per search, growing with the
corpus instead of with the query.

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
- **One motion system.** Surfaces do not invent their own timings: `ds/presence`
  owns the entrance/exit lifecycle from one `SURFACE` table, `ds/flip` owns list
  reordering, and every duration and easing is a token that
  `ds/tokens.test.ts` checks against `index.css`. Motion is transform/opacity
  only, enforced by `scripts/check-motion-budget.mjs` in CI — the property budget
  is to feel what the payload budget is to load time. See
  [MOTION-SYSTEM.md](MOTION-SYSTEM.md).

Every route except the landing one is a lazy chunk, and
`scripts/check-bundle-size.mjs` holds the initial gzipped payload under a budget
in CI.

## 9. Deployment shape

Single user, localhost. `npm run build` produces a static `web/dist` the server
can serve directly (future: mount static + collapse to one port). OS-agnostic by
construction — only `os.homedir()` and Node are assumed. A future Tauri shell
could wrap it for tray + native "agent finished" notifications.
