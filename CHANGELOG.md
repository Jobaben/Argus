# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

### Fixed

- **Sessions tests no longer depend on the hour they run.** The day-grouping
  fixtures were offsets from `Date.now()`, so "two hours ago" stopped being
  today between midnight and 02:00 — which is when CI runs. They are anchored to
  midday now.

### Added

- **Verdict scores now trend on the schedule cards**, beside the health badge,
  so quality sits next to liveness where the decision about a schedule is made.
  Only for schedules that declare a rubric and have been scored — an empty
  sparkline on every card would advertise the feature at the cost of the page.
  One trends read for the whole list, not one per card.

- **Live-region parity on Fleet, the Ledger panels and the Vault panels.** All
  three carry numbers that change under a poll, and a change only visible to
  someone watching the pixels is not a change that was reported. The Vault's is
  the load-bearing one: a store that quietly stopped ingesting looks exactly
  like a quiet month.

- **Constellation** (`#/fleet`): N machines, one lens. Argus watches one
  `~/.claude`, so anyone running it on a laptop and a build box runs it twice
  and reads it twice — and the questions that span both, what is failing
  anywhere and what am I spending in total, have had no home. Now each machine
  publishes a small summary of itself and pulls its peers', and the Fleet page
  shows all of them with fleet-wide totals.
  **Peer-to-peer with no server, and no coordinator to run.** Pull rather than
  push, because a machine that is asleep or behind NAT is not a failed delivery
  to retry — it is a peer that did not answer this round, which the fleet view
  already renders. **Single-machine stays zero-config**: with no peers
  configured nothing runs, nothing is published, and no federation endpoint
  answers.
  **Pairing is mutual and secret-based.** Mint a secret on one machine, add each
  machine to the other with that same secret, and every exchange between them is
  encrypted and signed end-to-end — HKDF to two independent keys, AES-256-GCM to
  encrypt, HMAC-SHA256 over the whole envelope to bind the header, and a
  timestamp plus nonce so a captured response cannot be replayed to freeze a
  peer at a healthy moment. TLS on top is an improvement, not a requirement,
  because "set up certificates between your laptop and your build box" is where
  a feature like this stops being used.
  **Refuse-to-boot extends to federation.** Argus already refuses to bind an
  exposed port without `ARGUS_TOKEN`; it now equally refuses to start with a peer
  configured over a non-loopback URL and no pairing secret. A security promise
  that covers the original feature and not the new one is the promise people
  rely on and the one that is quietly false.
  **Command Center, Chronicle, Issues and Budget go fleet-wide.** Each gains a
  machine picker; pick a peer and the page shows that machine, under a banner
  naming it, dating its figures and linking to its own Argus. Peer mode is
  read-only by construction — no approve on a peer's board, no triage on its
  issues, no limits form on its budget, because those are mutations on a machine
  this one does not own and a button that would either fail or need a second
  control plane is worse than no button. Chronicle renders a list rather than
  its packed timeline, because a timeline built from forty sampled runs shows
  gaps that mean _not sent_ and read as _nothing happened_. **In solo mode none
  of it appears**: no picker, no banner, no extra request.
  **What crosses the wire** is headline counts plus a bounded facet list per
  view — twelve pipelines, twelve issues, forty runs, every string clamped, and
  the caps re-applied on receipt as well as on send, because a peer is a machine
  you trust to be yours and not one you trust to be correct. Prompts, working
  directories and session ids never travel at all. The machine's identity is a
  locally-minted random id, not your hostname.
  **Fleet totals say what they are made of.** Every aggregate is labelled _from
  N of M machines_ and marked as a lower bound when some are not reporting;
  silently summing whatever is reachable is how "spend is fine" becomes wrong on
  the day a machine goes quiet. A quiet peer keeps its last card, marked stale,
  rather than vanishing — and _unpaired_ (a mismatched secret) is kept distinct
  from _unreachable_ (a dead machine), because they want different fixes.

- **Omnibar** — the command palette learns to act. Type a sentence into `⌘K`
  ("pause everything touching Spectacle") and Argus compiles it, through a
  bounded planning pass, into an explicit table of changes: what it touches,
  what it is now, what it becomes. Nothing happens until you press Apply, and
  then all of it happens or none of it does. Questions are answered inline with
  deep links instead — routing "when did nightly triage last run" through a
  confirm step would be theatre.
  The confirm step is not a formality, it is the security model, and three
  constraints make that true. The **verbs are a closed set** — disable/enable a
  schedule, resolve/ignore an issue, abort a live instance, set a budget limit —
  so a planner cannot name a capability Argus does not already expose behind the
  same admin gate. The **targets are resolved, not accepted**: the model supplies
  a verb, an id and a value, and every label and before/after you read is
  computed by the server from the live record, so a plan cannot say "Staging
  cleanup" while pointing at production. And **execution takes the plan's id,
  never the sentence**, so the intent is never re-interpreted and the list you
  approved is the list that runs. Both the sentence and the catalogue it compiles
  against contain text Argus did not author — an issue title is whatever a
  failing run printed — and that is fine by construction: the worst a fully
  compromised planning pass achieves is proposing a wrong-but-legal change that a
  person then reads and rejects.
  Applying is a **compensating transaction, and says so** rather than claiming an
  atomicity several independent JSON files cannot provide. Every mutation is
  re-validated against live state first, so a schedule someone disabled by hand
  between preview and confirm stops the whole plan before anything is attempted.
  Failures unwind in reverse. There are four outcomes rather than a boolean, and
  the fourth is the point: when a rollback itself fails the system really is
  part-changed, and `partial` names exactly what is still in effect. Aborting a
  pipeline has no inverse — a killed process does not come back — and the code
  says `null` instead of inventing a restart that would make a rollback report
  claim more than happened.
  Two words still fuzzy-jump, which is what the palette is for; three words and
  twelve characters is where it offers to interpret instead, `⌘↵` forces it, and
  the first `esc` returns to the list rather than throwing away what you typed.
  Plans are single-use, expire in five minutes, and are held in memory only:
  surviving a restart sounds like robustness and is a confirmation landing
  against state nobody has looked at since.

- **The Vault** — an embedded analytical store that remembers what the JSON
  files are forced to forget. Argus prunes: run records keep the newest 50 per
  schedule, the spend ledger keeps a year of days. That retention is right for
  files a human might open and wrong for "how did this schedule behave last
  quarter", so every run, alert, cost tick and Verdict score is also ingested
  into a local SQLite database. **Stats** gains a quarter view, **Chronicle**
  gains 90-day and 1-year windows, **Search** gains a second, indexed section
  over Argus's own run history, and `GET /api/vault/otel` hands the whole thing
  to your collector as OTLP spans — one span per run, a pipeline as one trace,
  cost and tokens under the `gen_ai.*` semantic conventions so they land on
  dashboards that already exist.
  Zero configuration and zero dependencies: the engine is `node:sqlite`, built
  into Node 22 — no package to install, no native build, no service to run. A
  monitoring tool should not arrive with an operations story of its own.
  It is a **cache of truth, never the source**. Every ingest is an upsert keyed
  by the record's own identity, so re-running a pass changes nothing and the
  watermark is an optimisation rather than a correctness requirement — the
  strictly-advancing cursor that would have been faster is wrong in the case
  that matters, where a run starting before the cursor and finishing after it
  is recorded as running forever. A missing, corrupt, disabled or unavailable
  Vault degrades the long views to their JSON-only behaviour and breaks nothing;
  a schema it cannot read is moved aside and rebuilt rather than surfaced as a
  boot failure, because refusing to start would look conservative and cost more
  than starting fresh does.
  Search expansion finds terms that **co-occur with your query in this machine's
  own history** — search `backoff`, also search `quarantine`. Expanded hits are
  tagged `related` so they can never pass as direct matches, and the terms used
  are shown. It is not an embedding model and is not described as one: a general
  model of English is a worse fit for a corpus of your own runs than that
  corpus's own vocabulary, and it would cost the zero-configuration promise the
  rest of the feature makes.
  The panel reports its own state — rows held, size, last ingest, and how many
  runs it is keeping that the JSON files have already pruned. A store that
  quietly stopped ingesting looks exactly like a quiet month, which is the one
  failure a history feature must not hide. `ARGUS_VAULT=off` turns it off.

- **Ledger** (`#/budget`, below the chart): where the money went, where it is
  going, and what a change would do about it. Spend attributes by **schedule,
  agent, pipeline, project and model** at per-run grain — `agent` being the
  worker that actually ran, which for a pipeline is one phase, so it answers
  "which part of the release train costs the money" rather than only "the
  release train costs money" — with each row carrying its
  share and its cost per run; the long tail folds into one `N more` row rather
  than being dropped, and the footer reports how many costed runs the grouping
  could not place, so the totals can be checked against the chart above. A
  **month-end forecast** shows its band and its sample count instead of a single
  confident figure. And a **what-if simulator** answers "move this to Haiku —
  what happens?" as a priced trade: _`haiku` on Nightly triage saves $41.00/mo
  at −0.2 Verdict_.
  The rule underneath all of it: **nothing here invents a number.** There is no
  embedded price list, because a saving computed from a price table looks
  identical in the UI to a measured one and is wrong the week the prices change.
  So the simulator compares what two models have actually cost on this machine
  and, when the target has never run here, says so rather than guessing. The
  same discipline produces three more honest refusals: no projection at all
  under three full days of history, a confidence figure derived from the
  observed spread rather than asserted, and a quality effect reported as
  **unmeasured — not zero** unless both models carry Verdict scores. The daily
  rate is a median and excludes today, so one runaway backfill day cannot set
  the trend and the projection does not sag every morning and recover every
  evening.
  Budget limits also graduate. A **policy ladder** moves spending through
  `warn → downgrade → defer → stop` at thresholds you set, so approaching a cap
  narrows what runs instead of dropping a cliff in front of it; deferral still
  leaves manual runs available, because a run you fire by hand is a decision you
  have already made. The **highest** matching step wins rather than the first —
  with warn@0.8 and stop@1.0, first-match would only warn a run 5% over the cap
  — and both the daily and monthly windows are evaluated, with the more severe
  verdict applying. Every affected run records what was done to it
  (`budgetAction`, `modelDowngradedFrom`), so "why did Tuesday's run use Haiku?"
  is answerable from the run record rather than by correlating a timestamp
  against a policy that has since been edited.

- **Weave** — pipelines graduate from a list to a typed DAG. Phases declare
  `needs`, so a pipeline can plan once, fan out to build and test in parallel,
  and fan back in to ship when both are done. Cycles and dangling edges are
  rejected when you save, naming the phases involved — without that check a bad
  graph is not an error but an instance that starts and never finishes. Phases
  can declare a **retry policy** (attempts, doubling backoff, and which failure
  classes are worth retrying — `signal` is deliberately excluded by default,
  because an agent that reported failure has considered the work) and **named
  artifacts** that later phases interpolate as `{{artifacts.<name>}}`. Every
  instance keeps an append-only **journal**, because the instance record is
  state rewritten in place and can never say that a phase failed, retried,
  failed again and was revised.
  Linear definitions load unchanged, and not as a compatibility shim: a linear
  pipeline is _defined_ as a DAG in which each phase needs its predecessor, so
  there is one executor rather than a general one and a legacy one that could
  drift. The entire 735-test suite that predated Weave passes untouched.
  Three things that were bugs before they were design: a failed branch no longer
  terminalizes the instance while a sibling is still running (that rendered a
  stopped pipeline with a live process writing into it), kill scope is explicit
  so a revise cannot silently abort a sibling branch, and deferred launches
  re-resolve phases by id because an abort landing in the window changes what
  the indices mean. The board draws the graph when — and only when — there is
  one to see: a linear pipeline draws none, and an instance carrying no edge
  information draws none either, because absent edges mean _unknown_, not
  _parallel_.

- **Sentinel** (`#/sentinel`): incidents, escalation, and a diagnostic that
  proposes but never acts. Monitors, Issues and Watchtower each raise a signal;
  none of them holds the state that makes a signal answerable — who saw it, when
  it was acknowledged, whether it escalated, what was found. An incident is that
  state, and it assembles its own timeline as the problem develops. What opens
  one is deliberately narrow (a monitor down or failing, an issue you had marked
  resolved coming back, a critical anomaly), because mirroring every open issue
  would just make a second inbox. A condition that persists never opens a second
  incident; a condition that recurs **reopens** the same one, because the history
  of a recurring problem is the useful part. Escalation climbs a policy on a
  clock until someone acknowledges. Quiet hours suppress **the bell, never the
  record** — the timeline, the list and the clock all carry on, so the morning
  view has no hole where the night's problems were. The read-only diagnostic is
  read-only _by construction_: everything it may consider is inlined into the
  prompt, so it is never asked to go and look and has nothing to look with, and
  its remediation renders as "Proposed, not done" with execution always a human's
  click. Auto-dispatch exists and is off by default. Incidents persist, so a
  restart resumes mid-incident rather than re-opening everything, and the
  reconcile-and-persist runs under one store lock so a tick and a human
  acknowledging cannot lose each other's writes.

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
