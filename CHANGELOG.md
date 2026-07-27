# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

### Added

- **Verdict** — opt-in rubric scoring for schedules and pipeline phases. Exit
  code 0 means the process ended, not that the work was good; a rubric says what
  good means for one unit of work and a bounded judge pass scores each output
  against it, 0–10 per criterion. The overall score is **computed from the
  author's weights**, not taken from the model — asking a judge for a weighted
  average and believing it lets one that scored every criterion 3/10 hand back
  an 8. Criteria the rubric never mentioned are dropped, scores are clamped,
  labels come from the rubric (so renaming one keeps the trend), and a response
  scoring none of the real criteria is a failure rather than a zero. Scores
  trend on Watchtower with a delta against the _prior median_ rather than the
  previous run, and a score below the author's threshold opens an issue in the
  same triage surface as a crash. Gated phases may declare
  `autoApprove: { verdict: N }`: every judged step must clear the bar — the
  phase's worst step decides, not the average — and a gate with no verdict yet
  waits, because silence is not approval. Judging and gate-opening run on the
  scheduler tick rather than in the engine's signal path, where a 90-second
  model call under the instance lock would be a deadlock rather than a delay.

- **Autopsy** — every failed run gets an automatic postmortem. A bounded
  `claude -p` pass returns a failure class from a closed taxonomy, a confidence
  figure, one paragraph of prose, the transcript span where it went wrong, and a
  proposed replacement prompt with one-click **Relaunch with fix** behind the
  admin gate. The relaunch fires a one-off and never edits the schedule — a
  model's rewrite of a prompt that spends money unattended is a suggestion, not
  a migration, and the UI says so next to the button. Nothing the model returns
  is trusted verbatim: the class must be in the taxonomy, confidence is clamped,
  the cited span is clamped into the recording's real duration (so "the failure
  was at forty minutes" on a two-minute run cannot send the scrubber off the end
  of the track), and an answer with no explanation is rejected. The panel shows
  the span's own quote next to a **scrub to** control, so the claim is checkable
  against the timeline right below it, and shows what the postmortem cost.
- **Issue clustering upgraded from string equality to similarity.** With
  postmortems available, differently-worded errors that describe the same
  problem merge into one issue marked "N wordings merged", driven by Autopsy's
  failure class plus token overlap of the normalized messages. Two _different_
  known classes never merge however alike the words. The string fingerprint is
  kept as the fallback: with no postmortems, grouping is byte-for-byte what it
  always was.
- **One audited place that asks a model a question** (`sources/analysis.ts`),
  shared by every model-backed feature: one pass at a time (claimed
  synchronously, so two callers cannot both see an idle runner), a hard timeout
  that kills the process _group_, an output cap, metering into the spend ledger
  even on failure, and a refusal to start under the budget hard stop.
  `ARGUS_ANALYSIS=off` disables it; `ARGUS_ANALYSIS_MODEL` picks the model.

- **Watchtower** (`#/watchtower`, `GET /api/watchtower`): learned envelopes per
  schedule and per pipeline _phase_, and the runs that leave them. Monitors say
  "did it run", Issues say "did it fail"; this catches the run that succeeded,
  took nine minutes instead of two and cost four dollars instead of forty cents.
  Robust statistics only — median and MAD, no dependency and no training step —
  and anomalies are stated as the multiple a human can act on ("3.2× median
  cost"), not as a z-score. Deliberately quiet: envelopes learn from successful
  runs only (a crash that died in two seconds is not evidence about how long the
  work takes), a z-score _and_ a ratio must both agree before anything fires, an
  identical-sample distribution reports `zScore: null` rather than pretending
  0.012 vs 0.010 is twenty sigma, and nothing fires at all under eight
  successful samples. Baselines are visible, show their sample count, and are
  resettable ("learn from here") and restorable. Newly-observed anomalies push a
  typed `watchtower:anomaly` frame to the toast stack and bell, POST an
  `anomaly.detected` webhook, become Briefing attention items when critical, and
  add an anomalies count to the Command Center strip. Detection diffs derived
  state between scheduler ticks, so the first pass after a restart is a silent
  baseline and deterministic anomaly ids mean a run never alerts twice.

- **Flight Recorder** (`#/run/<id>`, `GET /api/runs/:id/recording`): any run
  opens as a scrubbable causal timeline instead of a JSONL wall. Every tool
  call, file diff, token burst and cost tick is placed on one clock rooted at
  the run's start; `tool_use` and `tool_result` are joined by id so a call is a
  span with a duration and an error flag, not two unrelated lines. Play at
  1×–100×, step event by event (a same-instant cluster is one press, so the
  clock always moves), and **jump to failure** — which lands on the errored
  tool call, not the terminal "it failed" marker. The scrubber position lives in
  the URL, so a link to a recording is a link to a _moment_ in it. Derived on
  every read and never persisted, so it cannot drift from the transcript.
  Honest about its limits in the UI: per-event cost is the run's single
  reported total apportioned by token share, long runs are trimmed to the most
  recent 2,000 events with absolute offsets preserved, and a run with no
  transcript gets an empty state that says which of the four reasons applies.

- **Command palette (`⌘K` / `Ctrl K`)** over navigation, entities and actions:
  fuzzy search across every destination, pipeline, schedule, failing monitor,
  open issue, agent, project and recent transcript, plus the actions worth doing
  from a keyboard — approve a waiting gate, run a schedule now, mark the Briefing
  caught up. Matching is subsequence-based and scored by where the hits land
  (word initials, adjacent runs, early position), and it highlights exactly what
  it matched on. Backed by one purpose-built index, `GET /api/palette`, instead
  of the seven view payloads a client-side join would need. Recently-run commands
  float to the top of an _empty_ query only; once you type, ranking is purely
  relevance.
- **Keyboard layer with a `?` cheatsheet**: `g c` / `g b` / `g h` / `g l` /
  `g s` / `g m` / `g i` / `g p` / `g u` / `g a` for destinations, `/` for
  search. Bindings are data and the overlay renders the same array the listener
  dispatches from, so a shortcut that exists is documented and an unavailable one
  is not advertised. Chords disarm on an unknown second key rather than falling
  through, and nothing single-letter fires while a text field has focus.
- **Command Center situation strip** (`GET /api/insight`): gates awaiting you,
  failures, runs in flight, live agents, down/failing monitors, open issues,
  today's spend against the daily limit, the next scheduled firing with a live
  countdown, and a 24-hour run-outcome histogram. Shows only what is true — a
  metric with nothing to report is omitted rather than drawn as a zero.
- **Live activity rail** on the board: what is running now with each step's
  current tool call (including scheduled and one-off runs, which have no card),
  over the last completed runs with outcome, duration and cost.
- **Step drawer**: clicking a step opens its run — id, model, timings, tokens,
  cost, failure reason, transcript link, cancel — with the log tailing live,
  over the board rather than away from it.
- **Notification bell** keeping every alert raised this session, with an unread
  count and a link per entry, because a toast lasts eight seconds and most fire
  while you are in another tab.
- **Shape-matched loading skeletons** in all eighteen views, replacing
  "Loading…" text, each paired with a polite live-region announcement.
- **Mobile navigation sheet** replacing the nine-tab strip below `md`, listing
  every destination at once with its attention badge.
- **Scheduler health.** Each schedule leads with a verdict — paused, failing,
  running, healthy, never-run — and carries its next firing as a live countdown,
  when it last ran, its median duration, and a pass ratio over the runs shown. A
  failure _streak_ is stated with the first line of its error, because one
  failure is visible in a row and three consecutive ones are a different problem.
  Above the list: how many schedules exist, how many are failing or paused, what
  fired in the last 24 hours and what fires next — every count a filter for its
  own subset.
- **Filterable health counters** on Monitors and Issues: pressing "3 Down" or
  "2 Open" narrows the list in place, so "which ones?" is answered without
  leaving the page. A counter with nothing behind it stays inert rather than
  offering to blank the list.
- **Session search and day grouping**: the transcript index groups under Today /
  Yesterday / weekday / date and filters with the same fuzzy matcher the palette
  uses, over titles, project paths and model names.
- **Month-end spend projection** on Budget, from the elapsed daily rate, with the
  day a limit is projected to be crossed — plus a daily-limit line on the 30-day
  chart and the days that broke it drawn in red.
- **Pipeline cards say where the latest run got to.** One chip per phase, coloured
  by state, plus last activity, phase and step counts, spend and the failing
  step's reason. The list previously said "4 phases" and stopped, so finding which
  phase a pipeline was stuck in meant going to the board and locating its card —
  from data this list was already fetching for its status pill.

### Changed

- **New `@argus/contracts` workspace**: every DTO that crosses the HTTP/WebSocket
  boundary is declared once and imported by both sides, replacing ~25
  hand-duplicated copies (330 lines in `web/src/types.ts` alone, plus a dozen
  inlined in hooks). Types-only by construction — nothing is emitted, and
  `scripts/check-contracts-runtime.mjs` fails CI if that changes. WebSocket
  frames are now a typed discriminated union rather than string literals matched
  on both ends.
- **Conditional reads.** Every `GET` carries a strong `ETag`; the client sends it
  back and an unchanged resource returns `304`, which it handles without touching
  state — so a no-op broadcast costs ~100 bytes and zero re-renders instead of a
  full re-parse and re-render of the board.
- **Single-flight, coalesced refetches** with jittered exponential backoff (to
  30s) in both the fetch layer and the socket, replacing per-frame fetches that
  could land out of order and a flat 2s reconnect that hammered a downed server
  forever. The socket also reconnects immediately on tab-visible or
  browser-online.
- **One structured logger** replacing 25 ad-hoc `console.error("[argus] …")`
  calls: level-gated, `key=value` text or JSON lines (`ARGUS_LOG_FORMAT=json`),
  with `Error` objects serialized properly. Every request carries an
  `x-request-id`, echoed back and honoured from a proxy, so a UI report ties to
  the exact server line.
- **`strict` is on in the web workspace**, which it had never been.
- **Every route is a lazy chunk** except the landing one: initial payload
  105.7 → 91.5 kB gzip, other routes 1–4 kB each, with
  `scripts/check-bundle-size.mjs` holding the initial gzipped payload under a
  budget in CI.
- **Per-route error boundaries**: an unexpected shape in one view no longer
  blanks the whole dashboard.
- **The run and instance read paths no longer re-scan on every write.** Both
  directories were memoised behind a 500-entry LRU, which is the pathological
  policy for the access pattern they serve: a full-directory scan touches every
  file once in order, so past the cap each entry was evicted just before the next
  scan asked for it. Retention is now by scan membership (one shared
  `createFileMemo`), and a write **patches** the cached scan rather than dropping
  it — re-reading the one file that changed instead of forcing the next reader to
  re-stat the directory. Measured over 1200 run records: a warm rescan 163 → 57ms,
  and the write-then-read cycle a live run performs continuously 142 → 1.5ms.
- Motion that carries information only: counters roll when they change (snapping
  on first paint, huge jumps and reduced motion), and the row that just changed
  status flashes.
- **The Scheduler loads its runs once instead of once per card.** Each schedule
  card called `GET /api/runs?scheduleId=…` itself, so twelve schedules meant
  thirteen requests and thirteen live polls — and still no aggregate view, since
  nothing held all the runs at once. The view fetches `/api/runs` once and groups.
- **The Launch form keeps the working directory and model** after firing, and
  clears only the prompt and name. Firing several prompts at one repo is the
  common case; retyping an absolute path each time was not.
- **Empty states teach instead of just reporting.** Schedules, Monitors, Issues,
  Launch, Sessions and the spend chart each explain what the thing is, where its
  data comes from and what to do next, with the action inline where there is one.

### Security

- **An unauthenticated non-loopback bind is now refused, not warned about.** The
  README has always called `ARGUS_TOKEN` "mandatory" when `ARGUS_HOST` points at
  a non-loopback interface, but the code only logged a warning and carried on —
  so the documented promise and the actual behaviour disagreed. Argus now exits
  with an explanation instead of opening a port that can execute agents with the
  user's credentials.
- **`npm start` no longer overrides the loopback default.** It carried a
  hardcoded `ARGUS_HOST=0.0.0.0 ARGUS_ALLOWED_HOSTS=10.59.1.53`, which meant
  anyone running the documented production command got a LAN-exposed control
  plane with no token — the exact case the paragraph above exists to prevent. Set
  the variables explicitly (with a token) if you want that bind.

### Fixed

- **`AgentStatus` was an assertion, not a guarantee.** The server passed the
  `state` string straight off disk into the union, so a value from a newer CLI
  would reach the client and fall through every exhaustive switch. Unrecognised
  states now normalize to `"unknown"` (job status _and_ timeline entries), and
  `"stopped"` — which the UI already handled but the server's union omitted — is
  part of the contract.
- **`Next: -7138s ago` on a late monitor.** `TimeAgo` assumed every instant was
  in the past, so a future one rendered as a negative duration. Relative time now
  works in both directions, and a late or down monitor leads with "Overdue by
  2h 5m".
- **Relative timestamps never updated** — computed at render and frozen until
  something unrelated re-rendered, so a quiet dashboard misreported how old its
  data was. They now share one module-level clock.
- **An aborted request cleared `loading`**, so a first load (or any React
  StrictMode double-mount) could drop to the _empty state_ — "No pipelines
  defined yet" on a board with pipelines — until the cancelled fetch returned.
- **The board was unusable on a phone**: unbounded `1fr` phase columns gave each
  phase ~60px at 390px wide and rendered its title one letter per line. Columns
  now have a 200px floor and the card scrolls horizontally below that.
- **The Chronicle was unreadable at wide windows**: lane labels wrapped mid-word
  across two lines, sub-minute spans were 0.03% wide (invisible and impossible to
  hover), and almost nothing was labelled. Labels truncate to their identifying
  tail with the full path as a tooltip, spans have a ~16px floor, and a legend
  states what the colours mean.
- `formatUsd(0)` rendered `$0.0000`, a precision claim about nothing.
- A malformed `run:activity` batch could render as `undefined` deep in a view;
  frame payloads are now validated once in the socket.
- **Four more copies of the frozen `timeAgo`** survived the first pass, in
  Sessions, Projects, Tasks and Activity — each reading the clock during render
  and never revisiting it. All four now use the shared clock.
- **The Scheduler spoke in absolute timestamps**: `7/26/2026, 4:00:10 PM` for a
  run, `next 7/27/2026, 2:30:00 AM` for a slot, `60s` for a duration and
  `every 360 min` for a cadence. Runs read "2h ago" with the instant on hover,
  slots count down, and a cadence reduces to its largest unit ("every 6h").
- **A schedule paused with a computed next slot claimed it would fire.** The
  header's "next" now skips disabled schedules and the row says so outright.
- "1 tools" on a session card.
- **`every 360 min` survived in two more places.** The trigger phrasing existed in
  three copies that had drifted: only one humanised a cadence, only one handled a
  manual (null) trigger. There is now one `formatTrigger`, so a trigger reads the
  same on the Scheduler, on the Pipelines list and in the palette.
- **Search presented a ceiling as a count.** The scan stops at 100 matches and
  exits early — deliberately, so a common word does not read every transcript on
  disk — but the UI said "100 matches", which a reader takes literally. The
  response now carries `limit` and `truncated`, and the UI says "first 100
  matches — narrow the query".
- **The Users page was a dead end when signed out.** It said only root can manage
  accounts and stopped; the sign-in form is on the Pipelines tab, which nothing
  said. It now links there.
- **An awaiting-approval pipeline showed a live "running" pulse.** Waiting for a
  human is stopped, not working.
- **`Plugins 0` wore a red badge.** The inventory accents are per-category, not
  severity, so a zero now renders neutral instead of looking like an alert.
- **The Briefing's failure rows were the only dead ones on the page.** Attention
  cards, new issues and finished pipelines all linked to what they described;
  failures did not. A failure now opens its run's transcript, or Issues when the
  run has none.
- **Rebuilding the UI under a running Argus produced a blank page.** `index.html`
  was read once at boot and served forever, so after a rebuild the cached HTML
  kept naming content-hashed chunks that no longer existed: every asset 404'd and
  the app was white until someone restarted the server. It is now re-read when the
  file on disk changes — one `stat` per navigation, the same cost the asset route
  already paid.
- **A port collision logged an internal error and then hung.** `EADDRINUSE`
  reached the catch-all `uncaughtException` handler, whose job is to keep the
  daemon alive through a stray rejection — the opposite of what "the port is
  taken" needs. Argus now prints which port and how to change it, and exits 1, so
  the CLI and any supervisor can tell it failed.
- **Usage stats printed six confident zeros** for tokens, cost and models when
  Claude Code's usage telemetry was absent, beside real session counts read from
  the transcripts — indistinguishable from having genuinely used zero tokens
  across 184 sessions. The two halves are now separate, and a missing one says so.

## [0.4.0] - 2026-07-14

### Added

- **`argus` CLI** (`bin/argus.mjs`, wired as the package `bin`): one command
  that checks for a production build (building UI + server on first run),
  then starts the single-port server. `--open` launches your browser once
  `/api/health` answers; `--port <n>`, `--rebuild`, `--version`, `--help`;
  all `ARGUS_*` environment variables pass through. Install with
  `npm i -g .` (or `npm link`) from a clone — see the README quick start.

## [0.3.0] - 2026-07-14

### Added

- **Launch — one-off runs** (new "Launch" tab, `POST /api/launch`): fire a
  single `claude -p` run straight from the dashboard — prompt, working
  directory, optional name (defaults to the prompt's first line) and optional
  model (`--model` now supported by the scheduler spawn) — without authoring
  a schedule. One-off runs live in a shared `oneoff` bucket (pruned to the
  usual 50-run window, listed via `GET /api/runs?scheduleId=oneoff`), render
  with the same expandable rows as schedule runs (live-tailing log, cancel,
  transcript link) plus a **Reuse** button that refills the form, and flow
  everywhere runs already go: one "One-off runs" Chronicle lane, Issues
  fingerprinting, the Briefing digest, totals and the budget ledger. The run
  row and model picker were extracted into shared components
  (`views/RunRow`, `ds/ModelSelect`) instead of being duplicated.
- **Budget — spend guardrails** (new "Budget" tab, `GET/PUT /api/budget`):
  every completed run's reported cost is folded into a per-local-day ledger
  (`~/.claude/argus/spend.json`) at the same exactly-once point as the
  all-time totals, so scheduled, manual, one-off and pipeline-step runs all
  count and the numbers survive run-record pruning. Set a daily and/or
  monthly USD limit (`~/.claude/argus/budget.json`): the tab shows
  today/this-month meters, a 30-day spend chart and a state pill
  (`ok`/`warning` ≥ 80%/`exceeded`), and the server emits
  `budget.warning` / `budget.exceeded` / `budget.cleared` transition alerts
  each scheduler tick — webhook + `budget:alert` WS frame → in-app toast and
  native notification, with boot-baseline suppression like monitor alerts.
  An opt-in hard stop (`blockScheduled`) records due schedule slots as
  `skipped` runs ("skipped: spend budget exceeded") instead of firing while
  over budget; manual runs, launches and pipeline starts are never blocked,
  and firing resumes automatically once spend drops under every limit.
- **Catch-up for missed schedules** — anacron-style, opt-in per schedule
  ("Catch up a missed run on recovery" in the Scheduler form, `catchUp` on
  the API). A slot that came due while the machine was asleep or Argus was
  down normally expires with the firing grace and is skipped; with catch-up
  on, the most recent missed slot fires **once** on the next scheduler tick.
  Exactly one recovery run per outage regardless of how many slots were
  missed, never a slot from before the schedule existed, and the catch-up
  run also satisfies the schedule's monitor. Cards show a "catch-up" chip.
- **Monitor alerts** — the dead-man's switch now pages you instead of only
  coloring a tab. The server re-derives monitor health each scheduler tick
  and, on an observed transition, emits `monitor.down` / `monitor.failing` /
  `monitor.recovered`: POSTed to `ARGUS_WEBHOOK_URL` (same payload shape as
  `run.failed`/`pipeline.failed`) and pushed as a payload-carrying
  `monitors:alert` WS frame that the web app surfaces as an in-app toast
  plus a native OS notification (under the already-requested permission).
  The first check after boot is a silent baseline — restarting Argus never
  replays known-bad state — and `late` never alerts (that's grace working).
  The agent-notification toast queue was extracted into a shared
  `useToastQueue` so both sources render through one capped,
  auto-dismissing region.
- **Briefing** — a "while you were away" digest (new "Briefing" tab, first
  after Command Center): state-now attention cards (down/failing monitors,
  pipeline phases awaiting approval, open issues) each deep-linking to the
  owning tab, plus a windowed digest since your last **Mark caught up** —
  run outcomes, token/dollar spend, failures, first-seen issues, and finished
  pipelines. The nav tab carries a red attention-count badge visible from any
  tab. Backed by `GET /api/briefing` (pure derivation over runs, schedules,
  issue triage, and instances; window defaults to 24 h, capped at 7 days) and
  `POST /api/briefing/ack` (acknowledgement stored in Argus-owned
  `~/.claude/argus/briefing.json`, broadcast as `briefing:changed`).
- **The Chronicle** — a cross-source timeline view (new "Chronicle" tab):
  every scheduler run, background agent, and interactive session in a chosen
  window (1h–7d) rendered as swimlane spans on one time axis. Overlapping
  spans pack into extra rows; in-flight work draws open-ended into a "now"
  line with a pulse; bars deep-link to the run's session, the agent detail,
  or the transcript. Backed by `GET /api/chronicle?hours=N`, which merges the
  three sources server-side into packed, attention-sorted groups plus window
  totals (spans, in-flight, failed, run spend).
- Design-system additions for it: a reusable `SegmentedControl` (radio-group
  semantics) and pure timeline layout math (`spanGeometry`/`axisTicks`), both
  covered by tests.
- `useLiveResource` gained `pollAlways` for resources that mix pushed sources
  with time-decaying ones (the Chronicle's session-activity status can change
  with no file event).
- `design/` — repo-side sources for the claude.ai/design "Argus Design
  System" project, with card conventions and an incremental DesignSync
  workflow documented; the Chronicle timeline and segmented-control cards
  were published to the shared project.
- Command Center cost surfacing: every step tile shows its run's tokens and
  dollar cost, each pipeline row shows the latest run's total (Σ chip, all
  revise attempts included), and the page header shows the grand total across
  every pipeline. `GET /api/overview` now joins `costUsd`/`tokens` onto each
  step and returns a per-instance `cost` total.
- Boot-time cost backfill: terminal runs recorded before cost capture existed
  are patched once from their log envelopes, so historical steps show spend
  immediately after upgrading.
- UX/A11y wave (independently re-audited 9 → 10): a polite live region
  announces pipeline status transitions and gate action outcomes; per-route
  `document.title`; global high-contrast `:focus-visible` outline;
  skip-to-content link + focusable `<main>` landmark; `aria-expanded` /
  `aria-pressed` on expanders and sub-tabs; labeled custom-model input;
  SetupBanner apply failures surfaced with `role="alert"` and a busy label;
  Search states and connection pill in live regions; Stats hour bars exposed
  as labeled images; "Inventory" named consistently; actionable Command
  Center empty state; dead Vite scaffolding CSS removed.

- Auto-setup on boot: every fixable prerequisite (signal hook file, Stop and
  PreToolUse registration, data directories) is installed automatically at
  server start; the log reports what was installed and what still needs a
  human (missing CLI, corrupt files).
- Web test-coverage gate (`npm -w web run test:coverage`, enforced in CI) and
  a raised server coverage gate (70/58/58, ratcheted to just under actual).
- Supply-chain scanning: Dependabot (npm, GitHub Actions, Docker) and a CodeQL
  workflow.

### Fixed

- Pipeline step runs completed by the live tracking path never captured
  cost/tokens/result from the CLI's JSON envelope (only restart-adopted runs
  did); the completion handler now parses the log tail like the reconcile
  path.
- `applyAll`/`preflight` no longer risk clobbering a corrupt-but-recoverable
  `settings.json`: writes now refuse when the file exists but does not parse
  (checks still report it as `settings-parse: error`).
- The server test script used single quotes around its glob, which Windows
  `cmd` passes through literally — `npm test` matched zero files and reported
  a false green. Double-quoted so all 220 tests run on every OS.
- Generated `web/coverage/` output is ignored by git, ESLint, and Prettier.

### Performance

- Pipeline-instance reads (`/api/overview`, instance lists) use an mtime-keyed
  parse memo: unchanged instance files cost a `stat` instead of a read +
  `JSON.parse` on every poll.
- The shared TTL cache is size-bounded (256 keys) with expired-entry sweep;
  the session-summary memo is now true LRU (hits refresh recency).

### Changed

- The three instance-action handlers (`signal`, `approve`, `revise`) parse
  bodies through the shared `jsonBody` helper; pipeline PUT/PATCH share one
  update handler; engine gate replies share one response mapper.

### Removed

- Leftover Vite scaffold assets (`web/src/assets/hero.png`, `react.svg`,
  `vite.svg`) — never referenced by the app.

## [0.2.0]

### Hardening (post-audit polish)

- Fix a race the deadlock fix introduced: the detached next-phase start now
  re-acquires the instance lock and re-verifies liveness, so an abort/revise
  landing mid-transition can't be clobbered or orphan spawned children.
- `prereqs.writeSettings` uses the shared atomic writer (pid+random temp)
  instead of a pid-only temp that could collide between concurrent writers.
- Token comparison is constant-time (`crypto.timingSafeEqual`).
- The failure webhook now also fires for runs that fail at spawn time.
- Per-file, mtime-keyed session-summary memoization so a list refetch no longer
  re-parses unchanged transcripts.
- A11y: labeled interval/time trigger inputs and the pipeline revise-note input;
  windowed schedules render an accurate summary string.

### Security

- Server binds to loopback (`127.0.0.1`) by default; `ARGUS_HOST` to override.
- Host-header allowlist (defeats DNS-rebinding) and Origin checks on all
  mutating requests (defeats drive-by CSRF), applied to REST and the WebSocket
  upgrade.
- Optional `ARGUS_TOKEN` bearer-token gate for non-loopback deployments.
- `--model` values validated against an identifier allowlist (argv/shell
  injection); path-traversal guard on the agent-timeline route.

### Fixed

- Lost-update races on pipeline instances and JSON stores eliminated with a
  keyed mutex serializing every read-modify-write.
- Semaphore self-deadlock on the signal path broken by detaching step spawns.
- Scheduler tick reentrancy guard prevents double-fires; `stop()` drains the
  in-flight tick.
- Atomic writes use unique temp names (no same-file collision).
- Run-completion handlers can no longer crash the daemon (unhandled rejection);
  process-level `unhandledRejection`/`uncaughtException` handlers added.
- Robust CLI result parsing (256 KB tail, envelope recovery) — large results no
  longer silently dropped.
- Schedules no longer fire immediately when created within their trigger window.

### Added

- Single-port packaging: `npm run build && npm start` serves UI + API together.
- Compiled server build (`server/dist`) and a multi-stage `Dockerfile`.
- `POST /api/runs/:id/cancel` to kill a running scheduled run.
- Per-run cost (`total_cost_usd`) and token capture.
- `/api/health` reports the version.
- CI workflow (typecheck, lint, test, build); server ESLint; Prettier and
  EditorConfig; `.nvmrc`.
- Quality rubric in `docs/SCORECARD.md`.

## [0.1.0]

- Initial live-agents dashboard: background jobs + daemon liveness, live
  WebSocket refresh, plus the Scheduler and Pipelines verticals.
