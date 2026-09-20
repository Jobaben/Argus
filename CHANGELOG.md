# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow SemVer.

## [Unreleased]

### Added

- **Change-intent orchestration (Knowledge Ledger Phase 7).** A phase may now
  declare `changeIntent: { request?, kinds?, acceptanceCriteria?, note? }`,
  which turns it into a **change-intent phase**: it is given an explicit
  requested business change plus the current conformance of the rules it is
  accountable for, and must answer with a structured **ChangeProposal** —
  what semantics would change, what stays exactly as it is, what decisions
  follow, how success will be judged, and what is still unknown. Phase 7 stops
  before implementation: it writes no code, re-runs nothing and remediates
  nothing.
- **Three things that look alike are kept apart, and that is the whole
  point.** A requested change, the canonical semantics and the implementation's
  behaviour are three different facts, and collapsing any two of them is how an
  organization's semantics quietly become whatever somebody last filed, or
  whatever the code last happened to do:

  ```
  REQUESTED CHANGE        "Kobra now supports 500-character comments."   ← somebody's words
  CURRENT SEMANTICS       RULE-42:v1 "max = 180"        support: supported
  CURRENT IMPLEMENTATION  RULE-42:v1 @abc123 → holds    (a fact about the code)
  PROPOSED TRANSITION     revise RULE-42:v1 → v2 "max = 500"
                          preserve CONSTRAINT-8:v1
                          decide "only when BookingEngine == Kobra"
                          accept when 500 passes and 501 fails
  ```

  A `ChangeRequest` is never written into the ledger as a claim; it is carried,
  frozen, on the accepted proposal that answered it.

- **The semantic half of a proposal is an ordinary KnowledgeDelta.** There is no
  second path to canonical: a proposal's `semanticDelta` is staged as that run's
  delta and commits through exactly the Phase 3 boundary, with the same
  preflight, the same `expectedRevision` concurrency and the same atomicity. A
  change-intent run may not also write a KnowledgeDelta file — one run, one
  account of what it proposes.
- **Acceptance criteria are first-class, and are not business rules.** A rule
  describes domain semantics that outlive any change; a criterion describes the
  evidence that _one_ change was carried out. Criteria live on the accepted
  proposal, outside the claim graph, and their references are rewritten from
  delta-local ids to the canonical revisions the commit minted — `AC-1 relates
to local:r42` becomes `AC-1 relates to RULE-42:v2`, and a local id the commit
  did not create refuses the whole transition.
- **Unresolved questions instead of invented values.** Asked to "increase the
  Kobra comment limit" with no new maximum stated, an agent reports an
  `UnresolvedQuestion` rather than choosing `500` and justifying it. Readiness
  is derived, never asserted: `ready` when every relevant rule is accounted for,
  nothing is unresolved and every proposed business-rule change carries a
  criterion; `needs-input` otherwise. A `needs-input` proposal may still be
  approved — its delta commits — but by default it cannot drive an
  implementation.
- **Every relevant rule is accounted for, or the proposal is refused.** Each
  business rule the phase's `knowledgeContext` supplied must be classified
  `revised`, `preserved`, `not-relevant` or `unresolved`, and the classification
  must agree with the semantic delta. Silence about a supplied rule is
  indistinguishable from not having considered it.
- **Durable change provenance (`knowledge.json` version 6).** Approving writes
  an `AcceptedChangeProposal` in the **same ledger transition** as the semantic
  delta, so the ledger can answer _"what requested change caused RULE-42:v2 to
  exist?"_, _"what acceptance criteria were associated with it?"_ and _"which
  run was later intended to realize CP-12?"_ forever. It is deliberately **not**
  a justification: "the business asked for it" is a historical fact about
  intent, never an argument that a claim is true, so it creates no evidence, no
  justification, and never enters support evaluation or `analyzeImpact`.
- **Existing defect versus requested change.** Where the implementation already
  violates a rule the change revises, Argus warns `change-may-be-implemented`
  (the code may already do the requested thing) — and still revises the rule
  only because the _request_ asked for it. The recorded violation of `v1`
  stands, bound to v1 and to the commit it was about; `RULE-42:v2` starts
  `unverified`. A violated rule the change does _not_ revise is reported
  separately as a pre-existing defect. Verification history is never rewritten
  to make the past agree with a requested future.
- **The downstream handoff (`changeContext`).** A later phase declares
  `changeContext: { fromPhase, requireReady? }` and its steps receive
  `ARGUS_CHANGE_CONTEXT_FILE`: the accepted proposal as **exact canonical
  refs** — what this change introduced, what must keep behaving as it does, the
  decisions, and the acceptance criteria — beside the KnowledgeContext that says
  what those refs mean. References, never restatements. It resolves only from
  the ledger's accepted proposals, so a proposal waiting at a gate refuses the
  launch: unapproved intent cannot leak into an implementation run, by
  construction rather than by a check.
- **The gate review is extended, not replaced.** The drawer gains a **Change
  intent** panel: the request, the current rules with their support _and_ their
  conformance side by side, the proposed transition, what is preserved, the
  decisions, the acceptance criteria, the unresolved questions and the
  deterministic warnings. No transcript inspection.
- **A change-intent phase must be gated.** Saving an ungated one is a 400: an
  ungated one would be a pipeline that rewrites the domain because somebody
  filed a ticket, and no later check can recover a review that never happened.
- **Three new Argus-owned invocation channels** — `ARGUS_CHANGE_REQUEST_FILE`
  (read-only: the request plus current conformance),
  `ARGUS_CHANGE_PROPOSAL_FILE` (the phase's output) and
  `ARGUS_CHANGE_CONTEXT_FILE` (read-only: accepted intent) — all required when
  their phase declares them, and all per run.
- **New reads** under `/api/knowledge`: `GET /change-proposals` (with
  `?request=`), `GET /change-proposals/:id`, `GET /change-proposals/:id/preview`,
  `GET /claims/:key/change-proposal` and
  `GET /executions/:runId/change-proposal`. There is **no write endpoint**, by
  design: a proposal becomes canonical exactly one way, through the gate.
- A new `change-proposal` failure class, opt-in for retry like the other
  semantic classes, carrying the exact refusal so a second attempt can propose
  from the current ledger.
- **Business-rule verification and implementation conformance (Knowledge
  Ledger Phase 6).** A phase may now declare `ruleVerification: { kinds?,
holds?, note? }`, which turns it into a **business-rule verification phase**:
  its agents are told to decide, for every business rule Argus supplied them
  as semantic context, whether the implementation in their working tree
  conforms — and to write the answer as one structured document rather than as
  prose. The result is a new, append-only dimension of the ledger:
  `RuleVerification`, bound to one **exact claim revision** and one **exact
  repository revision**, so Argus can finally answer _"does the implementation
  at this commit satisfy the exact canonical rules it is supposed to
  satisfy?"_.
- **Rule support and implementation conformance are separate models, and stay
  separate.** This is the whole point of the phase. A rule may be perfectly
  well founded while the code does not do it — that is the ordinary state of a
  bug — so a violation is recorded as conformance, never as _opposing
  evidence_ on the rule:

  ```
  RULE-42:v1  "Kobra customer comments must not exceed 180 characters."
              support                  = supported    ← the business really does say 180
              conformance @def456      = violated     ← the code is in breach
  ```

  Recording the breach as evidence against the rule would make it read
  `contested` ("we are no longer sure the business has this rule"), and that
  would then propagate through every justification, through `analyzeImpact`,
  and into the currency of every run that consumed it — one failing test would
  quietly put a domain in doubt. So a verification creates no evidence, no
  justification and no claim; it appends to one array that support evaluation
  and impact analysis never read. There is a mandatory regression test that
  drives the whole engine path and then asserts the ledger's `claims`,
  `evidence` and `justifications` are unchanged.

- **Three honest outcomes, and a fourth status that is not one of them.**
  `holds` (sufficient evidence the implementation satisfies the rule),
  `violated` (sufficient evidence it contradicts the rule) and `unverifiable`
  (the verifier could not establish either — with a required reason). No
  confidence scores. In the read model there is also `unverified`: **nobody
  looked**. `unverified` and `unverifiable` are never collapsed — the first
  would claim an investigation that never happened, the second would lose one.
  Many business rules have no executable expression, and `unverifiable` exists
  so that is recorded rather than laundered into `holds`.
- **Conformance is never timeless.** `GET
/api/knowledge/claims/:key/conformance?gitHead=…` scopes the question to one
  commit: a rule verified `holds` at `abc123` answers `unverified` at `def456`
  until somebody verifies it there. Without a `gitHead` the answer is the
  latest recorded outcome, and the report says which commit it was about.
  Staleness is **derived**, never written back: a new rule revision and a new
  commit each simply start `unverified`, and the old record stays bound to
  what it examined. `RULE-42:v1 @X holds`, `@Y violated`, `RULE-42:v2 @Y
holds` all coexist, and nothing rewrites history.
- **The rules a phase answers for come from its KnowledgeContext.** There is
  deliberately no second rule-selection mechanism: the phase (or step)
  declares `knowledgeContext` as it always has — explicit claims, `active`
  selectors, `fromPhases`, an accepted discovery phase's output — and the
  business rules Argus supplied that run are exactly the ones it is
  accountable for. `ruleVerification` says only _this phase must produce
  structured conformance results_.
- **Deterministic completeness.** `selected = holds ∪ violated ∪
unverifiable`, each rule exactly once. A **missing** rule refuses the whole
  proposal (silent omission would read as though a rule had been considered
  when it had not — say `unverifiable` instead), an **extra** rule refuses it
  too (a result about something the run was never given is unaccountable), and
  a verification phase that wrote **no file at all** fails rather than quietly
  succeeding. A proposal must name exact revisions: a result for `RULE-42:v1`
  when the phase was supplied `v2` is refused, never retargeted.
- **Check linkage: an agent may cite a test, but not claim one passed.**
  Conformance evidence can name a deterministic `PhaseCheck` of the same phase
  by label. Argus validates at intake that the label is one the phase declares
  (a forged reference refuses the proposal), and at the commit boundary binds
  `status`, `exitCode` and `detail` from its **own** `VerificationReport`; any
  `status` the document asserted is stripped at validation. That is what lets
  a later reader distinguish _"an agent says it holds"_ from _"an agent says it
  holds **and** `comment-length-tests` exited 0"_. A minimal policy makes the
  difference enforceable: `holds: "deterministic-check"` requires a `holds`
  outcome to cite a check that passed, and `agent-evidence` (the default)
  requires concrete cited evidence — `holds` because the agent said so is
  refused under both.
- **Its own Argus-owned sidecar, not the KnowledgeDelta.**
  `ARGUS_RULE_VERIFICATION_FILE` is a new invocation channel delivered through
  the existing channel model, `required` on a verification phase because the
  conformance report _is_ the phase's output. Keeping it off the delta channel
  is deliberate: a delta proposes new canonical semantics, a verification
  describes the relationship between an implementation and semantics that
  already exist, and sharing the channel would have invited exactly the
  contamination above.
- **Staged, gated, atomic.** Identical discipline to the KnowledgeDelta: the
  proposal is staged beside its run (`rule-verifications/<runId>/`), becomes
  durable only at the phase's acceptance boundary, and is **superseded** by a
  retry, a revise, an abort or a lost candidate selection. A phase that
  verifies ten rules commits all ten in one ledger transition or none of them
  — and in the _same_ transition as that attempt's KnowledgeDeltas, so a phase
  that both revises a rule and verifies one leaves the two facts either both
  durable or neither. The commit is idempotent on `(runId, rule)`, so an
  awaiting-approval proposal survives a restart and commits correctly.
- **A structured review surface.** A gated verification phase's review carries
  `ruleVerifications` — outcomes grouped Holds / Violated / Unverifiable, each
  row showing the exact `ClaimRef`, the rule's statement, the **rule's own
  support**, the outcome and the concise evidence including the checks it
  cites — and `ruleVerification`, the counts. The GateDrawer renders it beside
  the candidate-knowledge panel. Showing support next to conformance is not
  decoration: a reviewer who could see only `VIOLATED` would eventually start
  "fixing" rules whose implementations were merely in breach.
- **Read APIs, no write API.** `GET /api/knowledge/claims/:key/verifications`
  (history for an exact revision), `/conformance` (with optional `?gitHead=`),
  `/api/knowledge/executions/:runId/verifications`, and the staged-record
  reads. There is no admin mutation for a verification and none is planned:
  only an accepted verification phase's commit may create one, and nothing
  edits or deletes one.

### Changed

- **`knowledge.json` is version 5**, adding `verifications[]`. A version 1–4
  document is read as version 5 with the new array empty and rewritten in that
  shape by the next successful transition. An upgraded ledger claims **no**
  conformance for the rules it already holds: an unverified rule reads
  `unverified`, never `holds`.
- **`PhaseFailureClass` gains `rule-verification`** — a refused conformance
  proposal (malformed, an unsupplied rule, a supplied rule left unanswered, an
  outcome with no evidence, a forged check label, source evidence that is not
  a real file in the repository) or a refused commit. Not retried by default;
  opt in through `retry.retryOn`, since the refusal names exactly what was
  missing.

### Security

- **Source-evidence containment is decided on the resolved real path.** Phase 5
  checked repository containment lexically — relative path, no `..`,
  `path.resolve` under the root — which a repository-internal symlink defeats:
  `src/Booking/Escape.cs → /somewhere/outside/secrets.txt` satisfies every
  lexical rule and `stat`s happily, so a rule could be recorded with durable
  evidence pointing at a file that is not in the repository and not at the
  commit the evidence claims. Containment now requires
  `realpath(candidate)` to stay inside `realpath(root)`, which also closes the
  symlinked-directory variant (`scope/link/inner.cs`). A repository reached
  _through_ a symlink is still its own root, and a path whose real path cannot
  be taken is reported as missing rather than unsafe — Argus refuses what it
  can disprove and reports what it merely cannot confirm. Applies to discovery
  evidence and verification evidence alike.

### Added

- **Business-rule discovery orchestration (Knowledge Ledger Phase 5).** A
  phase may now declare `discovery: { scope: { paths, label?, note? },
evidence? }`, which turns it into a **business-rule discovery phase**: its
  agents are told to read the bounded repository scope and propose the
  business rules the code appears to enforce, and Argus holds what they write
  to a set of deterministic invariants before it can be staged. No new
  subsystem and no new commit path — a discovery agent writes the same
  `ARGUS_KNOWLEDGE_DELTA_FILE` every step is offered, and its proposal becomes
  canonical through exactly the Phase 3 boundary: staged → the phase's
  acceptance ladder → applied. The whole point is the distinction it makes
  explicit: **repository observation → candidate semantic knowledge → review →
  canonical semantic knowledge**. Nothing an agent discovers is canonical
  before a person approves the phase.
- **A reusable discovery contract.** One instruction block, appended after the
  author's prompt like the result and artifact instructions, that tells the
  model what a business rule is ("Kobra bookings allow a maximum customer
  comment length of 180") and what is only an implementation observation
  ("`KobraBookingMapper.cs` uses `Substring(0, 180)`" — evidence _for_ a rule,
  not a rule; a class named `FooValidator`; an architectural preference; a
  test's internals). It asks the question that makes the difference — _what
  business behaviour does this code appear to enforce?_ — and says that if the
  answer is "none, this is plumbing", the right output is nothing. It also
  requires evidence, tells the agent to put uncertainty in an explicit
  `assumption` claim rather than in a rule's wording, and to **revise** a rule
  it was supplied rather than create a second one about the same thing.
- **First-class source-code evidence.** The `source-code` evidence source
  gains `repository`, `symbol`, `startLine`/`endLine` beside the existing
  `path`/`gitHead`/`line`, and is now validated: the path must be
  repository-relative POSIX (no `..`, no leading `/`, no drive letter, no
  backslash), a line range must be ordered, and `gitHead` must be a commit
  sha. It records **provenance, not source** — where the code is, never a copy
  of it — and its identity is historical: `src/Kobra.cs@abc123:120-136` means
  that file at that commit, and a later commit never retargets it.
- **Deterministic evidence validation, fail-closed and checked twice.** On a
  discovery phase, before a delta is staged and again at the commit boundary,
  Argus verifies that every `source-code` path is inside the declared scope,
  resolves to a file that actually exists in the run's working tree, and (when
  the agent named one) matches the commit Argus recorded for the run. A source
  file removed while a person deliberated at the gate refuses the commit
  rather than being recorded as provenance for something that is gone. None of
  it asks a model anything.
- **The business-rule evidence invariant.** In discovery mode a proposed
  `business-rule` must carry supporting evidence in the same delta, and a
  **revision** of an existing rule must carry _fresh_ evidence for its new
  statement — an agent may not revise a business rule by rewording it. Scoped
  to discovery-mode deltas on purpose: the admin API and non-discovery agent
  phases keep their existing semantics exactly, because the invariant is about
  agent-discovered knowledge, not about an operator recording what a domain
  owner said. `evidence: "warn"` downgrades these two checks to review
  warnings; it downgrades nothing about source paths.
- **The candidate preview, and a review surface for knowledge.** `GET
/api/instances/:id/phases/:phaseId/review` now carries `knowledge` — a
  deterministic `KnowledgeDeltaPreview` per step that staged a delta on _this_
  attempt — and `discovery`, a small `{ candidates, newRules, revisions,
assumptions, facts, constraints, conclusions, evidence, warnings,
requiresReview }` summary for routing, status and observability. The preview
  shows proposed claims with their evidence and justifications gathered under
  them, and a proposed revision beside the revision it would replace
  (statement, support, lifecycle). It **never invents canonical identity**: a
  proposed claim is `local:comment-limit`, because that is all it is until the
  commit mints an id. `GET /api/knowledge/deltas/:id/preview` exposes the same
  projection standalone. Twelve warning codes (a rule with no evidence, a
  reworded revision, a missing or out-of-scope source path, a stale
  precondition, an unsupported revision target, a bare assumption, …) are all
  decided from exact structured information — the delta, the ledger, the
  filesystem. There are **no embeddings, no vector search and no similarity
  matching** anywhere in Phase 5; the "is this a duplicate?" warning counts two
  exact sets (supplied business rules, revised claim ids) and asks a person to
  look, never asserting that two rules are the same.
- **Same-instance knowledge handoff.** `knowledgeContext` gains a second
  selector family: `fromPhases: [{ phaseId, kinds? }]`, meaning "the claims
  that phase of this instance committed". It resolves **exclusively from the
  ledger's applied-delta provenance** (`AppliedKnowledgeDelta`), never by
  scanning today's ledger and never from a staged record — so a discovery
  phase parked at its gate supplies nothing downstream, structurally rather
  than by a check somebody has to remember. `kinds` is how an author chooses
  what flows forward: discovery may produce facts, assumptions and rules while
  the implementation phase receives only the rules. Authoring is checked when
  the pipeline is saved (the phase must exist, must not be itself, and must be
  a transitive `needs` dependency), and a selector naming a phase that is not
  `succeeded`/`skipped` refuses the launch as a `configuration` failure rather
  than quietly resolving to an empty context. `claims` and `fromPhases`
  compose; `claims` wins on a claim-id collision.
- **Durable supplied provenance and context integrity (Knowledge Ledger
  Phase 4.1).** Phase 4 recorded what Argus supplied to a run on the run's
  invocation record — authoritative while that record exists, and pruned with
  the run. Semantic input provenance is part of the reasoning history and
  should not age out with a log file, so it now lives in the ledger:
  `knowledge.json` gains a `supplied` array (document **version 4**; v1/v2/v3
  files upgrade in memory with the new array empty) holding one
  `SuppliedContext` per run — the execution ref, the attempt, the
  KnowledgeContext schema version, the **exact** claim revisions in file
  order, the file's `sha256` and when it was materialized. It is registered
  between the invocation record and the spawn, is idempotent on the run id,
  and **fails closed**: registering a different claim list or hash for the
  same run is refused rather than overwriting history. There is no mutation
  API for it; only Argus's invocation lifecycle may assert what it supplied.
  The record attests _supply for an attempted invocation_ — not that the
  process ran, which stays the run record's question. Run and instance
  pruning now destroy the invocation record and the materialized context file
  but never the semantic facts: heavy operational records are prunable, small
  semantic provenance is durable.
- **Context integrity verified at completion.** The `sha256` Argus took when
  it materialized a KnowledgeContext is now used. Before a step's completion —
  and the semantic output it carries — is accepted, the file is re-hashed on
  both completion paths (the stop-hook signal and the reconcile fallback).
  Changed bytes, or a file that has disappeared, fail the step deterministically
  under a new `knowledge-context-integrity` failure class (not retried by
  default, opt-in via `retry.retryOn`), **before** the KnowledgeDelta is even
  staged — so a run whose input Argus can no longer vouch for never commits
  knowledge. The reason names the run, the expected hash, the hash found and
  the path, and never the context's contents; the journal gains
  `knowledge.integrity`. Integrity is about **bytes, not currency**: a claim
  revised in the ledger while the agent runs leaves the file untouched, so the
  run legitimately completes on the historical revision it was given —
  staleness stays a derived read (`ExecutionCurrency`, `analyzeImpact`), never
  a failure at completion. A run launched without a semantic context performs
  no check and behaves exactly as before.
- **Controlled semantic context delivery (Knowledge Ledger Phase 4).** A
  step — or every step of a phase — may declare `knowledgeContext: { claims:
[...] }`, naming exact claim revisions (`"RULE-17:v2"`) or the active
  revision of a claim (`"RULE-17"`). When the phase attempt is planned, Argus
  resolves every selector against **one** ledger snapshot, freezes the
  result, and writes it as a read-only JSON `KnowledgeContext`
  (`argus/invocations/<runId>/knowledge-context.json`, `0444`) the agent
  finds at `ARGUS_KNOWLEDGE_CONTEXT_FILE` — the mirror image of the
  KnowledgeDelta file. Each entry carries the exact `ref`, kind, statement,
  `structuredValue`, lifecycle (including `supersededBy`), support state and
  direct evidence; unsupported, contested and superseded revisions are
  supplied as requested with that state exposed, never hidden. The
  invocation record now proves what was supplied
  (`knowledgeContextFile`, `knowledgeContext: { schemaVersion, claims,
sha256 }`), the context is a new **read** channel in the unified channel
  model (`required`; Claude Code admits the directory and denies edits under
  it, Codex never lists it as writable, Qwen Code's container sandbox refuses
  the launch under strict enforcement), and the journal gains
  `knowledge.supplied`. Two inspection reads answer both directions:
  `GET /api/knowledge/executions/:runId/context` (what did this run receive,
  with the supplied/consumed comparison and the projection) and
  `GET /api/knowledge/claims/:key/supplied-to` (which runs received this
  exact revision), both derived from the invocation records rather than a
  second store. A malformed selector or a duplicate claim id is a `400` at
  save; a claim or revision the snapshot does not hold fails the step as
  `configuration` before any process starts. Steps without a
  `knowledgeContext` launch exactly as before: no file, no variable, no
  channel.
- **Supplied ≠ consumed.** A consumption committed from a KnowledgeDelta is
  now classified against what Argus supplied to the run:
  `ClaimConsumption.source` is `"supplied-context"` or `"agent-discovered"`
  (absent on admin-registered or pre-Phase-4 records). Supplying a claim
  never creates a consumption, a consumed-but-not-supplied claim is recorded
  rather than refused, and impact analysis stays consumption-based: a
  supplied-only claim changing does not impact the run. The staged delta
  record carries the run's `supplied` refs beside its `consumed` list.

### Changed

- `KnowledgeContextSpec.claims` is now optional, because a spec may name
  `fromPhases` instead. Every existing definition, which names `claims`, is
  unaffected; a spec with neither is still refused at save time.
- A durable `SuppliedContext` record may now carry an **empty** `claims` list.
  A `fromPhases` selector can legitimately resolve to nothing (an accepted
  phase that committed no matching knowledge), and the run still receives — and
  Argus still hashes — a context file. "Argus supplied this run a context
  holding no revisions" is a different, and equally recordable, fact from "this
  run was launched with no semantic context", which still has no record at all.
- `source-code` evidence paths are now validated as repository-relative on
  every write path, including the admin `POST /api/knowledge/evidence`. An
  absolute path, a drive letter or a `..` segment is a `400` where it
  previously stored. Existing records are untouched; only new writes are
  checked.
- `GET /api/knowledge/executions/:runId/context` and
  `GET /api/knowledge/claims/:key/supplied-to` now answer from the ledger's
  durable supplied records instead of scanning retained invocation
  directories, so both survive normal pruning. The context report adds
  `context.suppliedAt` and `context.projectionAvailable`, and `context.file`
  is now nullable: once the invocation directory is gone the durable refs and
  hash are still returned while the materialized projection is reported
  unavailable — it is never reconstructed from the current ledger and
  presented as what the run received. `supplied-to` entries carry the phase
  `attempt`. Consumption classification (`ClaimConsumption.source`) now reads
  the durable record first and the invocation record only as a fallback, so a
  recovery path with no invocation directory still classifies correctly;
  `source` is still set only from positive evidence, and pre-Phase-4 records
  are never upgraded retrospectively.
- **Argus-owned invocation channels (Knowledge Ledger Phase 3 hardening).**
  The structured files Argus hands an agent — `ARGUS_RESULT_FILE`,
  `ARGUS_KNOWLEDGE_DELTA_FILE`, `ARGUS_ARTIFACT_DIR`, `ARGUS_MEMORY_DIR` —
  are now one model (`harness/channels.ts`): each with its env var, path,
  required access and whether the launch depends on it. Every runtime
  receives the whole list inside the capability request and answers for
  every entry, instead of each channel being bolted on separately. Under a
  capability profile a channel the runtime cannot reach is always recorded on
  the invocation record (`channels[]`, plus `limitations`); a **required**
  one — the result file of a publishing step, the artifact directory of a
  phase with an `artifact` check, the memory directory when `memory` is on,
  the delta file when the new phase field `knowledgeDelta: "required"` is
  set — refuses the launch under strict enforcement as a `configuration`
  failure, and launches with the limitation recorded under `best-effort`.
  Without a profile nothing changes: the CLI's defaults decide and the record
  says `unmanaged`. The runtime matrix (Claude Code, Codex, OpenCode, Qwen
  Code × filesystem mode) is documented in HARNESS.md §3a and pinned by
  `runtimes/channels.test.ts`. Codex's former "read-only sandbox prevents
  writing artifacts" / "memory notes" limitation strings are replaced by one
  per-channel sentence naming the runtime, the mode and the variable.
- **KnowledgeDelta artifacts are re-verified at commit.** Intake proved a
  declared artifact existed when the run finished; the commit boundary now
  re-establishes the same deterministic facts — a real root, a path inside
  it, an existing file — immediately before the canonical write. An artifact
  that vanished while checks ran or a gate waited refuses the whole attempt's
  commit (sibling deltas included) under `knowledge-delta`; contents are
  never inspected.

### Fixed

- A result-publishing step under a restrictive capability profile is now
  deterministically able to write its result file on runtimes that can grant
  it (Claude Code: `--add-dir`; Codex `workspace-write`: `writable_roots`),
  and is refused before spawn — rather than failing later with a missing
  result — on ones that cannot. Previously only the artifact, memory and
  delta directories were added to the writable set and the result file was
  left to the runtime's accidental behaviour. The result file moves from
  `results/<runId>.json` to `results/<runId>/result.json`, a directory per
  run, so granting the channel admits this run's result and no other's; the
  old path is still read (a run in flight across the upgrade settles) and
  still pruned.
- Codex under an effective `read-only` sandbox can no longer be told to
  propose knowledge without Argus knowing: the KnowledgeDelta channel is
  reported unavailable on the invocation record (and refuses the launch when
  the phase requires it) instead of failing silently at write time.

### Added

- **The Knowledge Ledger (Phase 3): the KnowledgeDelta protocol.** Agent
  executions can now _propose_ semantic knowledge, and Argus alone validates
  and commits it. Every step run is handed `ARGUS_KNOWLEDGE_DELTA_FILE`, a
  per-run path (writable under every capability profile) where it may leave
  one typed JSON document: new claims (by delta-local id — Argus mints the
  canonical identity and the apply result exposes the mapping), revisions
  guarded by an `expectedRevision` precondition, evidence, justifications, the
  exact revisions the run declares it consumed, and the artifacts it produced.
  References to existing knowledge must be exact revisions; a bare id, an
  invented canonical id or an agent-asserted `producedBy` is refused. When the
  run completes Argus reads the file itself (the Stop hook is unchanged),
  validates it, preflights it against the ledger and **stages** it beside the
  run; it becomes canonical only when the phase crosses every deterministic
  acceptance condition — checks passed, gate approved — as one atomic ledger
  transition covering every sibling step's delta of that attempt, or none. A
  stale precondition (the ledger moved), two steps revising the same revision,
  a cycle or an unresolved reference refuses the whole commit and fails the
  phase under the new `knowledge-delta` failure class (retryable on opt-in,
  with the exact refusal in the retry note). A failed, revised, aborted or
  losing attempt's deltas are superseded and never enter the ledger.
  `knowledge.json` is now version 3 with a `deltas` array recording which run,
  in which attempt, introduced which records; commits are idempotent on delta
  id, so a restart mid-commit is healed by reconcile. Inspection:
  `GET /api/knowledge/deltas/:id`, `/deltas/:id/result`,
  `/executions/:runId/deltas`. Consumption is agent-declared and structurally
  verified — Argus proves the reference, not the reasoning.
- **The Knowledge Ledger (Phase 2): execution provenance and deterministic
  impact analysis.** Phase 1 could say which run _produced_ a claim; it could
  not say which later run _relied on_ one, so it could not answer "which
  executions and artifacts were built on premises that are no longer
  current?". The ledger now records two more explicit, immutable edges —
  **run R consumed exact revision `RULE-17:v1`** and **run R produced artifact
  `src/Validator.cs`** — registered through
  `POST /api/knowledge/executions/:runId/consumptions` and `/artifacts`
  (admin-gated, idempotent on their identity, never inferred from a prompt or
  transcript). `GET /api/knowledge/executions/:runId/provenance` joins both
  directions and derives the run's **semantic currency** (`current | stale`)
  on every read: a run that `succeeded` stays `succeeded` forever, and what
  can change is whether its premises still hold. `GET
/api/knowledge/claims/:key/impact` returns a deterministic `ImpactSet`: the
  claims whose support _actually changed_ (a conclusion with an independent
  justification still in force is not impacted, and nothing downstream of it
  is), the justifications that lost or gained force, the consuming runs, the
  artifacts they produced, and one machine-readable explanation path per node
  with a closed reason taxonomy that keeps `premise-superseded` apart from
  `premise-unsupported` and `premise-contested`. `knowledge.json` is now
  version 2; a version 1 file is read as-is and upgraded by its next write.
  Nothing re-runs, invalidates or marks a phase. See `docs/KNOWLEDGE-LEDGER.md`
  §8–§11.
- **The Knowledge Ledger (Phase 1): semantic provenance beside execution
  provenance.** Argus could say which phase and run produced an output; it
  could not say _why_ a conclusion is believed, which facts, business rules
  and assumptions it rests on, or what would lose support if one of them
  changed. `~/.claude/argus/knowledge.json` now holds an append-only graph of
  **claims** (`fact`, `assumption`, `business-rule`, `constraint`,
  `conclusion`, `decision`), **evidence** pointing at Argus's own execution
  records (runs, phases, artifacts, verification, source, commits, documents,
  human assertions) and **justifications** ("these premise revisions support
  or oppose this conclusion revision"). A claim changes by _revision_ —
  `RULE-17:v1` stays addressable and every justification that named it keeps
  naming it — and support (`supported | unsupported | contested`) is derived
  by one deterministic function, never stored and never set by an agent.
  `GET /api/knowledge/claims[/:key[/support|/dependents]]` read it; four
  admin-gated `POST`s propose to it. The semantic graph is a separate concept
  from the pipeline DAG and touches nothing in it. See
  `docs/KNOWLEDGE-LEDGER.md`.

### Fixed

- **A scheduled or one-off run whose CLI exits 0 after reporting an error is
  now recorded `failed`, not `succeeded`.** The scheduler decided a run's
  status from the exit code alone, and threw away the `is_error` verdict every
  runtime's envelope parser already extracted — so `claude -p` ending with
  `"is_error": true, "result": "Invalid API key · Please run /login"` and a
  clean exit landed as a green run with the refusal as its summary. Exit 0 is
  now a precondition and the envelope is the verdict: a `true` `isError` fails
  the run with the CLI's own message as its error (so it reaches failure
  notifications and Issues), a non-zero exit still names the exit code, and a
  clean exit with no envelope to read is unchanged. Pipeline steps already
  behaved this way on the reconcile path; this brings schedules in line.

### Changed

- **The nav is eight tabs, not eleven.** Watchtower and Sentinel had been
  added to a bar laid out for nine, and six surfaces were answering "is
  anything wrong?" in slightly different words. Now: **Launch is the
  Scheduler's One-off sub-tab** (`#/schedules/oneoff`) — a one-off run is a
  schedule with no trigger, and the two pages shared a form and a run list.
  **Monitors and Watchtower are the two halves of Health** (`#/health`,
  `#/health/watchtower`) — both per-schedule, both read-only, both about the
  same objects. **Sentinel moved to the ⋯ menu**: it holds the stateful record
  of signals the Briefing already surfaces, so it is where you go with an
  incident in hand, not where you learn about one. **Sessions gained a menu
  entry** — it was the main reading surface with no way in but a run row.
  Every old hash (`#/launch`, `#/monitors`, `#/watchtower`, `#/projects`,
  `#/activity`, `#/tasks`) is rewritten in place to where its content went, so
  bookmarks, archived alert links and older `argus tail` output keep landing.
  `g m` now opens Health; `g l` and `g w` are retired.
- **The Briefing's "Awaiting approval" card opens the review drawer.** It
  linked to the Pipelines page, which can only _stop_ an instance; approve and
  revise live in the Command Center's drawer and nowhere else. The card now
  deep-links to that instance's drawer, the same link the palette and
  `argus tail` already used. The situation strip's **running** count likewise
  goes to the Chronicle, which shows every run in flight, rather than to the
  one-off list, which shows only launches.
- **Budget and Stats each say which spend they count.** Budget meters the runs
  Argus launched; Stats reads Claude Code's own telemetry, interactive sessions
  included. Two pages about dollars with no word on why the figures differ
  read as a bug.

### Removed

- **Projects, Activity and Tasks pages, and the Scheduler's Cron sub-tab.**
  Projects was a card per folder with a session count and, per its own guide
  entry, "informational only" — it is now a filter on Sessions
  (`#/sessions/:project`), which is where its palette entries land. Activity
  listed the last hundred prompts with nothing to click and nothing linking to
  it. Tasks read Claude Code's internal `.lock` files, "mostly diagnostic".
  The Cron sub-tab was three panels explaining that it could show nothing. The
  `GET /api/activity`, `/api/projects`, `/api/tasks` and `/api/cron` endpoints
  are unchanged.

- **The review drawer shows the agent's closing note as a document instead of
  dumping the Stop-hook event.** A phase's payload is usually the whole event
  Claude Code hands its Stop hook — session id, transcript path, permission
  mode, background tasks — with the agent's final message buried as one field
  among a dozen, so "What went wrong" opened on a wall of JSON. Now the
  one-line reason comes first, the closing note (`last_assistant_message`, or
  a `summary`) renders as markdown the way a `.md` artifact already did, and
  the remaining fields fold behind a **Raw payload** toggle. A payload with no
  prose in it still shows raw, expanded, as before.
- **The Command Center draws each pipeline as a lane graph instead of a packed
  chip rail.** The rail held a linear pipeline to one card-height, but on a
  real conditional pipeline it broke the chain wherever a row ran out of
  width, stacked a fan-out without saying which chip fed which, and put the
  route condition _inside_ the chip — a phase gated on another phase's
  verdict carried a chip the width of the sentence
  (`IF PHASE 3 · VERIFY THE PLAN AGAINST TICKET AND CONTEXT: VERDICT =
"APPROVED"`). Now stages are rows read top to bottom, the chain that
  continues keeps the left lane and leaves hang to its right, and every
  dependency is a drawn edge from the instance's own graph, so a join is a
  join and a fan-out is a fan-out. Conditions moved onto the edge they govern
  as the value alone; the path that ran is tinted, an untaken branch is
  dashed, a leaf ends with a terminator, and the edges around the pinned node
  light up. The graph sits beside the focus panel on a wide card (measured,
  not a viewport breakpoint — the card's width depends on whether the
  activity rail is beside the board) and above it on a narrow one, fitting
  its lanes to the card; beyond about twelve stages it scrolls inside its
  tile, opened at the phase that needs you. The focus panel's header now also
  says where the phase's routes lead (`→`) with the condition each needs.
  Layout is a pure module (`laneGraphLayout.ts`) with its own tests — lane
  assignment, edge state, label placement and collision — because that is
  where the off-by-ones live.
- **The pipeline form is now a rail + focus panel, and dependencies became
  editable.** The form used to render every field of every phase and step at
  once — a nine-phase pipeline was ~6,000px of stacked inputs, and the graph
  shape (`needs`) had no UI at all: invisible when reading, impossible to
  author, and deleting a phase another phase depended on produced a validation
  error the form gave no way to see or fix. Now a compact phase rail (the
  Command Center board's stage layout, edit flavour — validity dots instead of
  status dots) is the always-on overview, and one phase's fields render
  beneath it, entering with the board's focus-panel motion. "Starts after"
  toggles edit `needs` per phase with cycle-creating choices disabled; the
  first dependency edit of a linear pipeline materializes the implicit edges
  on every phase so going explicit doesn't reshape the graph, and an untouched
  linear pipeline keeps declaring nothing. Removing a phase strips edges into
  it. Phase features authored via the API (retry, produces, rubric,
  auto-approve) show as badges and survive the round-trip; un-gating a phase
  drops its now-meaningless auto-approve instead of failing validation.

### Added

- **Context discipline: bounded placeholders, pipeline memory, richer retry
  feedback and stall detection.** Five loops the harness research pointed at
  directly (docs/HARNESS-RESEARCH.md §2 #4–#7, §4):
  - **Every interpolated placeholder value is capped**, by default 16 KiB
    (`PipelineDefinition.contextLimits.placeholderBytes`, 1 KiB–256 KiB). Over
    the cap, Argus keeps the head (2/3) and tail (1/3) with a one-line marker
    naming where the full value was written under the run's invocation
    directory (`context/<placeholder>.txt`), UTF-8 safe. Two new
    placeholders: `{{trigger.payload}}` (the instance's firing payload) and
    `{{previous.instance}}` (a one-paragraph summary of the pipeline's last
    settled instance — status, when it ended, which phase failed and why,
    which candidate won). Argus's own injected prompt blocks (result,
    artifact, memory, retry-note instructions) now always ride _after_ the
    agent's own prompt, in a fixed order, with the retry note last —
    recency is what a model weighs most ("lost in the middle").
  - **Pipeline memory** (`PipelineDefinition.memory: { enabled, maxBytes? }`,
    off by default): durable notes at `~/.claude/argus/memory/<pipelineId>/NOTES.md`,
    read via `{{memory}}` (tail-capped to `maxBytes`, default 8 KiB) and
    writable by the agent through `$ARGUS_MEMORY_DIR` (added to Claude Code's
    `--add-dir` / Codex's `writable_roots` the same way the artifact
    directory is). Trimmed back to its cap on a line boundary after each
    instance settles (`memory.trimmed` journal entry); never created until
    enabled, never deleted by Argus.
  - **Every retryable failure class now hands the next attempt something to
    repair against**, not just `verification`/`signal`: `verification` names
    each failed check with the tail of its own output, `exit-code` carries the
    exit code plus a tail of the run's own error/result text, and
    `timeout`/`spawn`/`signal` carry their existing one-line reason — each
    bounded, the whole note capped at ~2 KiB, and headed
    `Previous attempt (n of m) failed — <class>:`.
  - **Stall detection**: `PhaseDef.stallSeconds` / `PhaseStep.stallSeconds`
    (minimum 30, absent = off) kills a step whose transcript has gone quiet
    for that long even though its process is still alive — a hard timeout
    sized for the worst case never notices a stuck-but-alive run. Reuses the
    existing reconcile tick rather than a second timer system; classed as
    `timeout` for the retry policy, with its own `termination: "stalled"` and
    `step.stalled` journal entry so it reads distinctly from a hard timeout.
  - **`WorkspacePolicy.scope` gains `"none"`**, so one phase can opt out of a
    pipeline-wide isolation policy and run in its own `cwd`.
  - See docs/HARNESS.md §13.

- **Candidates — a phase can run N drafts of its step and let its checks pick
  one.** A phase ran its step once; a bad draw was found at the checks and cost
  a sequential retry at the same price. A phase can now declare
  `candidates: { count, select, variants? }` and Argus launches `count` runs of
  its single step at once, each in a git worktree, artifact directory and
  `changed-files` baseline of its own, each verified by the phase's own
  `checks` inside its own tree. `select: "first-verified"` takes the first
  draft whose checks pass and kills the rest (recorded as **superseded**, not
  failed); `"cheapest-verified"` lets them all finish and buys the cheapest
  verified one, tie-broken by duration. The winner's payload, result,
  verification report and worktree become the phase's — so
  `{{previous.payload}}`, `produces` and routing see one draft, never a
  mixture — and a gated phase opens its gate on the winner. `variants` gives
  each candidate its own runtime, model or reasoning effort, cycled when
  shorter than `count`, so the same step can be drafted on Claude Code **and**
  Codex and the checks decide which lands. A candidate that dies before its
  checks simply loses; the phase fails only when none can still win, once, with
  every draft's fate in the reason and the retry policy applied as usual.
  Requires exactly one step and an effective `workspace.scope: "attempt"`, both
  refused at save time with the reason. Candidate runs are ordinary runs: they
  cost what they cost, take a concurrency slot each, and queue past the global
  cap. The board badges each draft `c1`/`c2`…, marks the winner selected, and
  summarises the phase as `2/3 verified · c2 selected`. Evidence:
  Trae Agent 70.6 → 75.2% from its ensemble alone, AutoCodeRover +7 points from
  three samples — and, crucially, sampling without a verifier plateaus. See
  [docs/HARNESS.md § 12](docs/HARNESS.md).
- **Webhook and after-pipeline triggers.** A schedule or pipeline's trigger
  can now be `{ "kind": "webhook" }` — fired by
  `POST /api/hooks/{pipelines,schedules}/:id`, authenticated with a per-definition
  `hookToken` (minted on first save, shown with a copy button and a **Rotate**
  action in the trigger editor, never `ARGUS_TOKEN`) — or
  `{ "kind": "after", "pipelineId", "on": "succeeded" | "failed" | "any" }`,
  which chains a pipeline or schedule to fire once a chosen **pipeline**'s
  instance ends. Chaining runs on the ordinary scheduler tick and is
  restart-safe: a small ledger (`~/.claude/argus/chains.json`) fires each
  source instance into each matching target at most once. A pipeline instance
  or schedule run fired this way carries `trigger: "webhook"` or `"chained"`
  (plus `triggerPayload`/`chainedFrom` on the instance) instead of
  `"manual"`/`"scheduled"`, shown as a badge wherever those already were. A
  self-chain and a direct two-pipeline cycle are refused at save time. See
  [docs/API.md § Webhook and chained triggers](docs/API.md).
- **Workspace isolation — a phase can run in a git worktree of its own.** Every
  phase of a pipeline used to edit the same checkout, so two branches of a
  fan-out overwrote each other and a failed attempt left its half-done edits
  for the next one. A pipeline or a phase can now declare
  `workspace: { scope: "instance" | "attempt", base?, keep? }`: Argus creates a
  worktree under `~/.claude/argus/worktrees/<instanceId>/` on a branch named
  `argus/<instanceId>/shared` (one per instance, shared by every phase that
  opts in) or `argus/<instanceId>/<phaseId>/<attempt>` (one per attempt), and
  the phase's steps — their `cwd`, their transcripts' project, their
  `changed-files` baseline and the phase's `checks` — all run there instead of
  in the phase's own `cwd`. `ARGUS_WORKSPACE` names it to the agent. The
  branch is the deliverable: the directory is removed when the instance
  settles (or is pruned) unless `keep: true`, and whatever was left
  uncommitted goes with it. A worktree Argus cannot create — not a repository,
  an unresolvable `base`, no git — fails the phase under `configuration` with
  git's own words, and is never retried. Restart-safe: a tree that is already
  there is reused, and a branch whose tree was removed is checked out again
  with its commits. Not a security boundary — Codex's sandbox remains the only
  OS-level one. See [docs/HARNESS.md § 11](docs/HARNESS.md).
- **Analyze — a settings review for a pipeline, one agent per phase.** Whether
  a step's model, reasoning effort, timeout and turn cap fit the work its prompt
  describes was something an author judged once, when writing the pipeline, and
  rarely revisited. **Analyze** on a pipeline card now asks one bounded pass
  per phase exactly that, and opens a drawer of proposals — each with the
  current value, the proposed one, where the current value is inherited from
  and the words in the prompt that led there — for the author to tick and
  apply. Two things it will not do. It never touches a prompt: the response
  schema has no field for one, the parser drops any field outside the four
  tunable ones, and the client rebuilds each step by whitelisted assignment.
  And it never forces a change: a phase whose settings already fit comes back
  "No changes recommended", a proposal equal to the current value is dropped,
  and nothing is saved until a ticked proposal is applied through the same
  admin-gated update — with the same running-instances confirm — as a hand
  edit. `GET`/`POST /api/pipelines/:id/tune`; reports in `argus/tuning.json`.
- **`argus tail` — a terminal frontend, for the window that isn't a browser.**
  When the machine running Argus is one you only reach through a terminal — an
  SSH session, or a Claude Code session driven from your phone through Remote
  Control — there was no way to see what it was doing short of curling JSON.
  `argus tail` prints the dashboard's facts as text, one line each: a snapshot
  (what is running and what it is doing right now, with its last few activity
  lines; pipelines waiting at a gate and what they want approved; live
  background agents; recent outcomes with duration, cost and the failure reason;
  the next firing; or `idle`), then the live feed — per-tool activity from
  running steps, runs and phases and pipelines starting and ending, agents
  changing state, and every alert the bell would ring — and a closing line
  saying why it stopped and how many runs are still going. It is a client of the
  running server (same port, same `ARGUS_TOKEN`) that follows the same
  WebSocket and turns the payload-free `*:changed` pings into concrete lines by
  diffing conditional re-reads of `/api/runs`, `/api/overview` and
  `/api/agents`. When stdout is not a terminal the window defaults to 60 seconds
  so an agent's tool call always returns a complete answer; `--for` sets it
  (`0` = snapshot only), `--until-idle` ends it once nothing is running,
  `--json` emits one object per line. A bundled skill teaches an agent session
  on that machine to run it and relay it: Claude Code and Codex read the same
  `SKILL.md` format from `skills/<name>/` under their homes, so it is one file
  (`.claude/skills/argus-tail/`, with `.agents/skills/` linking to it for a
  Codex session inside the checkout) that `argus tail --install-skill` copies
  into `~/.claude/skills/` and/or `~/.codex/skills/` — bare, for every CLI on
  PATH; `=claude`, `=codex` or `=all` to choose. Alongside it,
  `GET /api/runs/:id/activity` exposes the run tailer's
  retained events for a running step, so a client arriving mid-run can say what
  the step has been doing rather than only what it did last.
- **Argus as a harness: capability profiles, environment policy, deterministic
  verification and timeouts for pipeline steps.** A phase (or one of its
  steps) may now declare `capabilities` — filesystem mode, tool allow/deny
  rules, an exact MCP server set, extra readable directories, Claude Code's
  setting sources/permission mode/max turns, and an environment policy — plus
  `checks` (a command, a required artifact or file, or a changed-files
  assertion Argus runs itself once every step has reported success) and a
  `timeoutSeconds`. None of it is required: a phase declaring none of it runs
  exactly as it always did. `harness/invocation.ts` resolves the profile
  narrowest-wins by key (step ▸ phase ▸ pipeline), asks the runtime to map it
  onto its own flags and config files, and writes an `AgentInvocationRecord`
  beside the run — bin, argv, environment variable **names** (never values),
  the profile as applied (secret-bearing values under `env.set` and each MCP
  server's `env`/`headers` redacted, keys kept), what the runtime couldn't
  enforce, materialized config files, the artifact directory, the deadline,
  and `git rev-parse HEAD`
  — readable at `GET /api/runs/:id/invocation`. `harness/childEnv.ts` is now
  the one place a child's environment is assembled, so Argus's own secrets
  (`ARGUS_TOKEN`, `ARGUS_WEBHOOK_URL`) and per-invocation identifiers are
  stripped unconditionally regardless of policy. Under `enforcement: "strict"`
  (the default) a capability the chosen runtime cannot honour — Claude Code's
  bare `Bash` under `read-only`, Codex's inability to exclude `config.toml`
  MCP servers, or OpenCode/Qwen Code's total lack of per-invocation
  control — fails the step before it launches, under a new `configuration`
  failure class that is never retried; `"best-effort"` launches anyway and
  just records the gap. `timeoutSeconds` (step overrides phase) becomes a
  persisted `deadlineAt` enforced by SIGTERM-then-SIGKILL, surviving an Argus
  restart via reconcile. A phase's `checks` run after every step succeeds and
  before the gate or the next phase — "the agent said the tests pass" and
  "the tests pass" are no longer the same claim — and a failure there carries
  the full `VerificationReport` as evidence. Five new failure classes
  (`spawn`, `exit-code`, `signal`, `timeout`, `verification`, plus the
  never-retried `configuration`) replace the old binary success/failure split
  on `PhaseFailurePayload.failureClass`, and four journal kinds
  (`step.timed-out`, `step.exit-mismatch`, `phase.verifying`,
  `phase.verified`) narrate the new states. See
  [docs/HARNESS.md](docs/HARNESS.md) for the full reference, including a
  worked five-phase pipeline.
- **Outcome-based routing: a phase can decide what runs next.** A phase may
  declare a `result` — an artifact name and a small validated schema — and a
  dependency may carry a `when` condition over it, so `publish` runs only if
  `evaluate` decided `accepted: true` while `repair` is _skipped_, and a later
  join needing both with `allowSkipped` runs after whichever branch happened.
  The decision travels through a per-run JSON file named by `ARGUS_RESULT_FILE`
  and parsed by the stop hook (read off disk on the reconcile tick for runtimes
  with no hook), never from the agent's prose: `ARGUS_OUTCOME` still reports
  whether the run _worked_, and an agent that decides "reject" has succeeded.
  `settle()` is the only route evaluator — it validates the result, publishes
  the artifact, evaluates the edges in definition order and records the decision
  in the same atomic write as the skips it implies, then replays that record
  forever after, so a crash, a downstream revise, or an edit to the definition
  cannot re-decide a branch that already ran. A missing, unreadable,
  schema-invalid or contradicted result fails the phase with a specific reason
  under its ordinary retry policy; an ambiguous exclusive group or an unmatched
  required group fails it too. Authoring is validated at save time as a `400`
  naming the phase — a condition on a phase that decides nothing, a field its
  schema never declares, a value its type cannot hold, a stray default, a group
  spanning two sources. The board renders a skipped branch as skipped (not
  idle), labels conditional edges, and explains the decision in one line; the
  phase panel authors results, conditions, groups, defaults and skip-tolerant
  joins. An instance whose every phase either succeeded or was intentionally
  skipped succeeds. Every pipeline without a `when` edge loads, validates,
  executes and renders exactly as before.
- **Two more agent runtimes: OpenCode and Qwen Code.** Argus now drives
  `opencode run` and `qwen` alongside `claude -p` and `codex exec`, selectable
  in every place a runtime already was: per schedule, per one-off launch, per
  pipeline, and per phase or step inside one. Both speak OpenAI-compatible
  endpoints, which is the point of adding them — a model served locally by
  `llama-server`, Ollama or vLLM becomes a runtime like any other, rather than
  something you drive outside the dashboard. Nothing existing moves: a record
  that names no runtime still runs on Claude Code.

  The runtime seam earned its keep. Each is one new file under
  `server/src/runtimes/` answering the same four questions, with no new branch
  anywhere else in the engine.

  **Qwen Code** turned out to be Claude Code's twin where it counts. Its
  `-o stream-json` emits the same envelope — `system`/`init`, `assistant`
  messages carrying `text` and `tool_use` blocks, a closing `result` — so the
  activity derivation is Claude's, handed Qwen's tool vocabulary rather than
  rewritten. Its hooks are Claude Code's too, down to the `settings.json` schema
  and the `last_assistant_message` payload, so the same `argus-signal.mjs` is
  registered under `~/.qwen` and pipeline phases signal exactly as they always
  have. The prompt goes on stdin and `-p` is deliberately unused: it _appends_
  to stdin rather than replacing it, so using both would deliver the prompt
  twice. Unattended runs pass `--approval-mode yolo`, without which Qwen Code
  withholds the shell, write and edit tools entirely and an agent asked to fix a
  test reports back that it has no way to run one; the banner that warns about
  it is silenced per-run, because it is written to stderr and the pipeline
  engine points both descriptors at the log the tailer parses.

  **OpenCode** needed two gaps declared rather than papered over. It has no
  command hooks at all — its extension surface is JavaScript plugins — so there
  is nothing for Setup to register, and it files transcripts in a private SQLite
  schema rather than per-session JSONL, so the Sessions view honestly reports
  that it has nothing to read back. Live activity is unaffected: that comes off
  the `--format json` event stream, which also carries OpenCode's own `cost`,
  so this is the one non-Claude runtime that needs no price table to be honest
  about dollars. `--auto` is passed for ordinary runs, since an unattended run
  that stops at a permission prompt on a terminal nobody is watching presents as
  a hang; analysis passes instead run under the built-in read-only `plan` agent.

  How a phase on a hookless runtime completes is now the runtime's own
  declaration. `recoverCodexOutcome` — which read a run's conclusion off the
  `ARGUS_OUTCOME` marker in its final message when Codex's best-effort hook
  didn't fire — became `recoverRunOutcome`, gated on an `outcomeFromRecord` flag
  each runtime sets. For OpenCode it is the completion protocol rather than a
  backstop, so a phase advances on the next reconcile tick instead of the
  instant the process exits; for Claude Code and Qwen Code it stays off, so a
  hook that fails to fire still surfaces as a failure rather than being quietly
  rubber-stamped.

  Setup gained `opencode-cli`, `qwen-cli` and `qwen-signal-hook`, each scoped
  the same way the existing ones are: checked only while something on the
  machine actually runs on that CLI, so a Qwen-only install is never held to
  "Claude CLI on PATH". The Qwen hook installer rewrites `~/.qwen/settings.json`
  only to add its own group, leaves every other key alone, and refuses a
  present-but-unparseable file rather than replacing it.

  **Qwen Code transcripts read back into the Sessions view.** Qwen Code files
  transcripts almost exactly where Claude Code does — one directory deeper, at
  `projects/<encoded-cwd>/chats/<id>.jsonl`, with the same encoding of the
  working directory into a path segment — so a session resolves from
  `(project, sessionId)` the way a Claude one does, needs no reserved bucket the
  way a Codex rollout does, and groups by working directory for free. A Claude
  and a Qwen session from the same directory share a project segment without
  shadowing each other, since both ids are UUIDs and Claude's path is tried
  first.

  Only the _file_ is foreign. Qwen Code inherits Gemini CLI's message vocabulary
  — `message.parts[]` for `message.content[]`, `functionCall` /
  `functionResponse` for `tool_use` / `tool_result`, `role: "model"` for the
  assistant, and `type: "system"` lines that are telemetry rather than
  conversation — so `sources/qwenSessions.ts` translates it, and the list,
  detail view, live tail, transcript search, Markdown export and Flight Recorder
  all read a Qwen run through the code path they already had. The telemetry
  lines are kept rather than dropped, because they are the only place the model
  name is recorded; a `tool_result` line comes through flagged `isMeta` so a
  shell transcript can never become a session's title. That the _live_ stream
  needs no translation at all — `-o stream-json` is Claude Code's envelope
  verbatim — remains the odd asymmetry of this runtime.

  The two-way `codex: boolean` that used to decide how a transcript was read
  became a `TranscriptKind`, which is what kept adding a third source from
  meaning a third branch in the summarizer, the resolver, the tail and the
  search scanner.

  This turned up a real bug in transcript search: `listTranscriptFiles` gave up
  entirely when `~/.claude/projects` was missing, which is the ordinary state of
  a Codex-only or Qwen-only machine — so search came back empty rather than
  searching the transcripts that were there. A missing Claude directory is now
  "no Claude transcripts", not "stop".

  Two smaller things fell out of it. Model identifiers may now contain `/`,
  which OpenCode requires to address a model as `<provider>/<model>` and which
  is neither a shell metacharacter nor a flag introducer. And the web's nine
  `runtime === "codex" ? … : …` ternaries — each of which would have rendered a
  third runtime as "Claude Code" — collapsed into one table of ids, labels and
  commands.

- **A second agent runtime: OpenAI Codex.** Argus now drives `codex exec`
  alongside `claude -p`, selectable per schedule, per one-off launch, per
  pipeline — and per **phase or step** inside a pipeline, so one pipeline can
  draft on one agent and review on the other.

  The two CLIs differ in ways that reach all the way up to the dashboard, so
  rather than scatter `if (codex)` through four spawn sites, a log parser and an
  activity tailer, everything CLI-specific now sits behind one seam in
  `server/src/runtimes/`. A runtime answers four questions and nothing else in
  the server knows which one is running: how to invoke it (a spawn plan —
  binary, argv, the text for stdin, env), how to read what it printed, how to
  turn one line of its streaming log into Command Center activity, and what it
  cannot do.

  The mapping, feature for feature: `codex exec` for `claude -p`; the prompt on
  stdin via the `-` placeholder, so no shell ever parses user-authored text;
  `--json` serving as both the result envelope and the live NDJSON transcript
  the tailer follows; `--model` for `--model`; and a `[[hooks.stop]]` entry in
  `~/.codex/config.toml` for the `Stop` hook in `settings.json`. Codex has no
  `--append-system-prompt`, so the outcome contract that lets a phase report
  `ARGUS_OUTCOME` rides at the top of the prompt instead — same text, same
  effect, one delivery mechanism.

  Two differences survive the mapping and are **reported rather than papered
  over**, as declared capabilities the UI can read. Codex mints its own thread
  id, so Argus reads it back out of the stream and patches the run record once
  the run starts — the transcript link appears a moment late instead of pointing
  at nothing. And `turn.completed.usage` reports tokens but not dollars, so
  `costUsd` stays null on Codex runs: the Budget view shows what it has, and a
  USD ceiling constrains Claude Code runs only. Inventing a figure nobody could
  reconcile against an invoice would have been the worse answer.

  Everything else is at parity. Codex rollouts under
  `~/.codex/sessions/YYYY/MM/DD/` are translated into the same line shape the
  Claude transcript reader consumes, so the Sessions list, the detail view, the
  live tail, the Markdown export and the Flight Recorder all work unchanged
  rather than growing a second code path. Gated phases pause on Codex too —
  there is no `AskUserQuestion` twin to hook, and none is needed, because the
  engine holds a gate on the phase's _completion_ signal rather than on the
  agent asking a question.

  Nothing is rewritten on upgrade. A schedule, pipeline or run that names no
  runtime is Claude Code, exactly as before; resolution is narrowest-wins (step,
  phase, pipeline, `ARGUS_AGENT`, then Claude Code), and the resolved value is
  written onto the run record so a run started under one default stays
  explicable after the default changes.

  Setup follows the same principle in reverse: each runtime's CLI and hook
  prerequisites are checked **only while something on the machine uses that
  runtime**. These are the checks a pipeline start refuses on, so an unscoped
  version would have left a Codex-only install permanently unable to run
  anything because Claude Code wasn't present — and, once Codex existed, the
  same trap in mirror image. Registering the Codex hook **appends** a block to
  `config.toml` and never rewrites it; a config that already declares a scalar
  `stop` key under `[hooks]` (which would make the block invalid TOML) is
  reported for a human rather than silently corrupted.

  New: `GET /api/runtimes`, `runtime` fields across the schedule / launch /
  pipeline / phase / step / run contracts, `codexHome` on `GET /api/health`, and
  the `ARGUS_AGENT`, `ARGUS_CODEX_HOME`, `ARGUS_CLAUDE_BIN`, `ARGUS_CODEX_BIN`,
  `ARGUS_CODEX_SANDBOX`, `ARGUS_CLAUDE_ARGS`, `ARGUS_CODEX_ARGS`,
  `ARGUS_CODEX_MODELS` and `ARGUS_ANALYSIS_RUNTIME` environment variables.

- **Reliability — first-attempt pass rate and lucky passes, per pipeline.**
  Binary pass/fail on the board hides the run that only succeeded after a
  retry the harness quietly absorbed (AgentLens: 0.5–23% of "passing" agent
  trajectories are exactly this). Each pipeline card now has a
  **Reliability ▾** disclosure covering the trailing 30 days: the share of
  settled instances that passed with every phase on attempt 1, the share of
  successful instances that needed a retry or a human revise to get there, a
  day-by-day sparkline of succeeded vs. failed instances, and a per-phase
  table of first-try / lucky / failed counts, timeout-classed stalls and the
  dominant failure class. A rate is `null` — shown as "—" — rather than 0%
  when nothing has settled yet, so an unproven pipeline never reads as a
  broken one. `GET /api/pipelines/:id/reliability?days=` (1–365, default 30);
  the derivation is pure over the instance record alone, in
  `server/src/sources/reliability.ts`.

### Fixed

- **Editing a pipeline under a running instance no longer changes it — and is
  no longer silent.** Every launch after the first — the phase after a gate, a
  retry, a revise, a run healed after a restart, the rubric a verdict scored
  against — read the _live_ definition. A prompt fixed mid-flight ran on the
  very next phase, a phase removed mid-flight failed the instance as a
  configuration error, and deleting the pipeline left its running instance
  unable to advance (approve and revise answered "pipeline not found"). An
  instance now snapshots the whole definition when it starts and runs against
  that copy forever after; the live definition is read only to _start_ one.
  Saving an edit that changes what runs (phases, model, effort, runtime,
  capabilities) while an instance is running or awaiting approval is refused
  with a `409` naming those instances unless `?force=1`, and the pipeline form
  asks before forcing it — so an author fixing a prompt learns the fix lands on
  the next start rather than watching for it on this one. Trigger, overlap,
  enable/disable and rename save freely. The Command Center labels a running
  instance from its own snapshot, and an instance written before the snapshot
  existed keeps reading the live definition as it always did.

- **Retrying a phase after its pipeline was edited could launch a different
  phase.** An instance snapshots its phase list when it starts, but the engine
  looked the phase's definition up by _position_ in the current definition. Once
  an author inserted a phase ahead of the failed one, a Retry or Revise spawned
  whatever now sat at that index — the wrong prompt, recorded on the right
  phase — and the child's completion signal named a phase id the instance did
  not have, so it was dropped and the reconciler failed the step 30 s later as
  "run ended without emitting a completion signal". The launcher now resolves
  the definition by phase id. A phase the definition has since removed fails
  cleanly as a `configuration` failure naming the missing phase (previously the
  launch threw and left the instance wedged as running with nothing to heal),
  and a signal the instance cannot apply is journalled as `phase.signalled`
  with an `(ignored: …)` detail and logged, instead of recorded as if it had
  landed.
- **The Command Center's Live rail listed a running pipeline step twice.** The
  rail shows every working board step, then adds the running runs the board
  does not own (scheduled firings, one-off Launches) so it can never claim
  nothing is running. But a pipeline step's run is itself a running run, so
  the same run appeared once under its step name and once under the run's
  `pipeline · phase` name, with the identical live tool call beneath both,
  and the Live count read one higher than the RUNNING counter above it. Runs
  already represented by a working step are now excluded from that second
  list.
- **Windows pipeline PowerShell popup spam.** Pipeline agents now run through a
  hidden console host on Windows, so repeated PowerShell tool calls inherit one
  console instead of flashing a new window each time. Argus records the real
  agent PID, preserving aborts, process-tree cleanup, and adoption after a
  server restart.

- **Codex pipeline completion no longer depends on perfect Stop-hook delivery.**
  The hook remains the preferred path, but reconciliation now recovers a
  terminated Codex step from its completed run record and strict
  `ARGUS_OUTCOME` marker. Successful records advance only on an unambiguous
  `succeeded`; reported `failed` / `blocked`, process errors, missing markers,
  and conflicting markers fail safely. The instance mutex makes a delayed or
  duplicate hook signal idempotent. Hook transport failures, timeouts, and
  non-2xx responses now reach stderr and return a non-zero hook status instead
  of disappearing. This also fixes a DAG terminality bug that could label an
  all-terminal graph containing a failed phase as succeeded.

- **A test that could leak into the next one, and did on CI.** The engine's
  "adoption holds the concurrency slot" test deliberately left a `start()`
  parked on the semaphore and never settled it. Every path in the engine is
  resolved when it is used, and `beforeEach` repoints `ARGUS_CLAUDE_HOME` at a
  fresh directory — so a start still in flight across that boundary wrote its
  instance into the _next_ test's home, where a stray running instance made that
  test's overlap check refuse to start anything. It failed with no spawn and no
  explanation, only under load: 50ms is plenty of parked time on an idle box and
  not always enough on a two-core runner, which is why adding tests elsewhere
  was enough to surface it. The test now releases the adopted slot the way a
  real restart does — the reattached run ends, `reconcile` hands the slot on —
  and awaits the queued start, which also makes it assert the half it never did:
  that the queued work actually proceeds once the slot frees.

- **Tests no longer read the developer's real `~/.codex`.** Every test file
  already pinned `ARGUS_CLAUDE_HOME` to a temp directory; nothing pinned the
  Codex home, and once the Sessions list, transcript search and the setup
  prerequisites learned to read it, a machine that actually uses Codex would
  fail assertions about "one session in this temp home" — on that machine only.
  A `--import` preload on the test scripts defaults the variable to a throwaway
  directory, so isolation holds for every file at once and cannot be forgotten
  by the next test that needs it.

### Changed

- **The motion layer, completed** — all four goals of
  [`docs/MOTION-UPLIFT-ANALYSIS.md`](docs/MOTION-UPLIFT-ANALYSIS.md), with the
  delivered system documented in [`docs/MOTION-SYSTEM.md`](docs/MOTION-SYSTEM.md).
  No colour, size, spacing, copy, component anatomy or accessibility behaviour
  changed; the whole thing is _when and how_ things move.

  **Everything that enters now leaves.** Every overlay in the app was
  `open ? <Panel/> : null` — it slid in over 180ms and vanished in zero. Users do
  not notice a missing exit consciously; they feel it, because dismissal is the
  most frequent thing they do and the illusion that these are objects collapsed at
  every one. The drawer, command palette, shortcut sheet, overflow menu, mobile
  nav sheet and notification popover now have paired entrances and exits, at 0.7×
  the entrance duration and easing in rather than out. They are also
  _interruptible_: the transition is driven through the Web Animations API, which
  — unlike a keyframe — can be asked where it currently is, so ⌘K ⌘K ⌘K follows
  the keystrokes instead of restarting from opacity zero each time.

  **Toasts had no animation at all**, which for a surface whose entire job is to
  catch the eye gracefully was the loudest unfinished signal in the product. They
  arrive on a slight overshoot, leave sideways off the stack's own axis, and the
  remaining stack closes the gap by gliding rather than snapping upward.

  **The skeleton→content blink is gone.** `Handoff` fades the skeleton out over
  the content that replaces it, at every in-place loading region — the placeholder
  exists to say "this is the shape of what is coming", and the old hard swap
  contradicted that at the moment of arrival.

  **Navigation has a direction.** Drilling into a detail brings the new view in
  from the right while the old settles back; going back reverses it; a move between
  peer destinations keeps the crossfade, because it is not a hierarchy move.
  Derived from the nav roles that already existed, so there is no second table to
  keep in step. Where the browser has View Transitions the outgoing view is really
  still on screen for it, and the agent tile you clicked visibly _becomes_ the
  detail page's heading. The nav's active pill slides between destinations instead
  of teleporting, and overlays grow out of the control that opened them.

  **The board moves like the live thing it watches.** Reorders glide (FLIP) on the
  Command Center, the schedule list, monitors, issues, the agent grid, the toast
  stack and the heartbeat strip. A new heartbeat tick grows off its baseline while
  the strip slides left by a slot. Status pills crossfade their tint rather than
  hard-swapping it, and arriving at `failed` rings once. Meter fills animate to
  their new value and board totals count to it. Every ambient
  pulse/sweep/ping/shimmer now takes its phase from one shared epoch, so a board
  with six live indicators shows one rhythm instead of six.

  **It can be handled, not just watched.** A real spring — a sampled damped
  oscillator, not a cubic-bezier impression of one — so a gesture can hand
  momentum to an animation. The drawer can be flicked away, with the outcome
  decided from measured pointer velocity, so a fast two-pixel flick dismisses and
  a slow drag half-way across does not. The Flight Recorder's lane strips are now
  the scrubber they always looked like: press to land, drag to track the pointer
  1:1, release to glide to rest. Pressed states on palette rows, nav pills, menu
  items, tile links, gate buttons and transport controls.

  **Reduced motion is unchanged, deliberately.** Every animation above is additive
  under `motion-safe:` or guarded by an explicit `prefersReducedMotion()` check
  (CSS cannot reach a WAAPI animation or a `::view-transition-*` pseudo-element).
  The analysis proposed relaxing the global kill switch into a finer tier; that was
  declined, because it would spend an accessibility guarantee those users have
  today to buy polish they did not ask for.

### Fixed

- **`sweep` animated a layout property.** The indeterminate progress strip on
  every working step tile animated `left` — sixty times a second, per tile, for a
  decoration — in a file whose own comment claimed every keyframe there was
  "opacity/transform only". It is a transform now, and
  `scripts/check-motion-budget.mjs` enforces the claim in CI over the keyframes in
  every stylesheet, the `transition-[…]` utilities, and `transition-all` — which
  is the one spelling that animates layout properties while naming none of them,
  and so the one a property-name check cannot otherwise see. A short list of
  argued exceptions, rather than an unchecked convention.

- **Overlay entrances were being skipped.** Found by the first test written
  against the new presence hook: a surface mounting already-open seeded its
  progress from "visible", which seeked the entrance straight to its end. The
  surface simply appeared — an entrance skipped exactly when it was wanted.

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
  **Monitor and budget transitions are archived as they happen.** Both are
  derived on each tick, diffed in memory, pushed to the bell and then forgotten;
  nothing on disk could answer "how often did this monitor flap last quarter".
  They are pushed to the Vault rather than polled because by the next tick there
  is nothing left to poll, content-hashed so a replayed tick cannot report one
  breach as two, and a failure to archive is swallowed — an alert that cannot be
  stored must not break the alert.
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
