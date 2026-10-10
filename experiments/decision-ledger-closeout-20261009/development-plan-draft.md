# Decision ledger and pipeline utilization: evidence-bound development plan

Date: 2026-10-09. Status: proposed development backlog; no application implementation is authorized by this artifact. The overnight experiment may strengthen or reject individual proposals. Its results must be attached before this draft becomes the closeout decision.

## Purpose and decision

Finish open-ended exploratory shadow collection by deciding what Argus should build, what it should leave deterministic, and what evidence each future consumer needs. A decision journal records that an inference occurred. It does not establish truth, satisfy acceptance criteria, or confer permission. Build on the existing journal rather than introduce a second authoritative ledger.

The proposed target is an auditable, state-bound assessment service, an advisory review interface, and separately authorized escalation-only pipeline consumers. Normal termination is observed deterministically. Residual causes remain hypotheses until independently reviewed. No result here authorizes automated knowledge acceptance or removing human review.

## Current implementation and limits

The inspected baseline is `C:/GIT/Argus/.worktrees/argus-local`. Source inspection establishes implemented mechanisms, not that the current process exercised every mechanism successfully.

| Capability | Current implementation | Remaining proof or work |
| --- | --- | --- |
| Versioned definitions | `contracts/src/decision.ts`, `decision/registry.ts`, `definitions.ts`; definitions and projections carry digests | Freeze active runtime definitions in closeout evidence |
| Immutable assessments | `decision/service.ts`, `journal.ts`, `storage.ts`; retained inputs, provenance, bounded persistence and explicit archival | Live integrity/replay evidence; no tamper-resistance claim |
| Currency | `decision/currency.ts`; derived current/stale/unavailable over definitions, snapshot, subject attempt, claim revisions and repository state | Extend appropriate projections to actual pipeline artifact/acceptance dependencies |
| H2 collection | `decision/h2/*`; separate residual and blind probe questions, budgets, census, retained references | Diversity, pending-item accounting, reference limitations |
| H1 collection | `decision/h1/*`; captured review input, operator-action settlement, deterministic and Verdict baselines, blinded pending results | Genuine prospective operator cohort; not synthetic approvals |
| Runtime reporting | `server/src/app.ts`: GET `/api/decisions/h1` and `/api/decisions/h2` | No public assessment or retained-snapshot reevaluation route |
| Policy | `DecisionPolicy` contract permits flag, escalate and withhold-auto-approval | Evaluation, durable application record and engine integration are proposed |
| Existing governance | RFC Phase 0 and gate-policy integration prohibit automated knowledge commits | Preserve existing boundary; verify new consumers cannot bypass it |

`observeTermination` currently derives only `deadline`, `never-ran`, and `ended-normally`. Probe options also contain output-refused, rate-limited and permission-denied, but these have no corresponding observed reference stream. A denied tool invocation can occur inside a process that ends normally. H2 residual references are always null; current report accuracy is unmeasured. A single-class normal-completion sample cannot establish discriminatory value. H1 predicts operator behavior, not correctness. Existing test documentation is evidence of designed checks; release requires running relevant checks on the future change.

## Architectural boundaries

Keep four distinct concepts and preserve their owners:

1. **Observation:** Argus-owned termination, check result, repository state or applied operator action, with source record and digest. Providers cannot write this stream.
2. **Assessment:** versioned question, exact bounded/redacted input, provider identity, answer or failure/abstention, provenance, cost, and immutable id. Subject-authored material is marked. Ratings, verbalized probabilities and provider statistics remain separate.
3. **Policy evaluation:** deterministic result over explicitly allowed current assessments and observations. Proposed record binds policy id/version/digest, assessment ids, state digest, selected effect, reasons and fallback. A probability is never a policy instruction.
4. **Applied decision:** engine-owned, idempotent application record with actor/mechanism and phase attempt. Existing gate decisions retain their meaning; an evaluation that was never applied must not appear applied.

SOLID boundaries: registry owns definitions; projection builders own input shaping; provider adapters own invocation/parsing; journal owns durability; currency reader owns applicability; policy evaluator is pure; engine adapter owns transitions; read model owns display. Depend on narrow interfaces and injected sources/clock/providers. Add a provider by implementing its interface without modifying engine rules. Split report, assessment, labeling and policy application interfaces so read-only consumers cannot mutate decisions. Provider failures remain substitutable typed results. Avoid a central decision service that also edits knowledge, operates gates and renders reports.

## Required state and scope binding

Every consumer declares question/version, permitted full provider identities, input projection digest, permitted phase kinds and effect. Bind evaluation to instance, phase, attempt, selected candidate/run ids, definition/config digest, review-state digest and referenced artifact content hashes. Knowledge-aware views bind claim revisions and repository state. Acceptance-aware views bind criterion identifiers/version and immutable verification record ids; an assessment never becomes acceptance evidence.

Use the existing snapshot/subject contracts first. Add fields only where a concrete consumer needs a dependency not represented today; version the affected contract/projection and record its migration. Display a retained assessment after sources are pruned as historical, while current applicability becomes unavailable. Replay and live applicability are separate operations.

## Sequenced backlog

| ID | Deliverable and dependencies | Acceptance and verification | Rollback |
| --- | --- | --- | --- |
| DL-01 | Closeout ADR and frozen evidence manifest; no prerequisite | Report question/provider populations separately; attach configs, source refs, selected run ids, snapshot hashes, integrity findings, costs and unresolved claims. Every experiment item has a known disposition. Distinguish implementation inspection, live observation and untested proposal | Preserve experiment; supersede ADR explicitly |
| DL-02 | Consumer contract and read model on existing journal; after DL-01 | Queries return assessment, exact input/provenance and derived currency. Unsupported question/provider is refused. Reading causes no collection/provider calls. Archived replay is deterministic. No knowledge mutation | Disable read feature; retain records |
| DL-03 | Supported budgeted retained-snapshot evaluation; after DL-02 | Single application-owned writer; prospective intent/id, new `reEvaluates` record, no historical rewrite. Crash reconciles completed journal result or unknown outcome; unknown calls are never automatically resent. Shared analysis limits apply. Authorization/redaction preserved | Disable evaluation endpoint/feature; keep journal |
| DL-04 | Cause taxonomy adjudication and optional reference stream; after DL-01 | Written missing-context/task-infeasible boundary; blinded independent review records with reviewer/source provenance and unresolved cases. New reference stream never overwrites observations/operator behavior. Agent consensus and intended scenario labels are not truth | Stop label collection; retain labels as historical |
| DL-05 | Advisory run/gate display; after DL-02 | Label inference/historical/stale/unavailable explicitly; link retained evidence and reasons. No suggestion is represented as support or permission. No ordering/badge leaks into a still-active blinded study. Missing assessment preserves existing review | Disable advisory display |
| DL-06 | Pure escalation policy and audit records; after DL-02, with evidence approval | Only declared consumers; exact policy/question/provider/config identity; no granting effects. Typed fallbacks, deterministic replay, no evaluation of stale inputs. Record a prepared intent before transition; mark applied only with the durable engine transition or explicit settlement. Reconcile prepared, applied and failed states idempotently | Disable policy; preserve prior audit records |
| DL-07 | Engine adapter for ordinary phases; after DL-06, DL-09 and prospective validation | At final application boundary recheck phase attempt/state; race loses eligibility. Effect can flag/escalate/withhold ordinary auto-approval only. No provider calls under instance locks. Knowledge commit gates remain human. No repeated transition on retry/restart | Turn consumer off; restore existing hardened flow |
| DL-08 | Artifact and acceptance advisory links; after DL-05 | Exact artifact digest and verification/criterion identity; changed artifact/revision makes prior judgment stale. Existing check/result validation and `evaluateCompletion`/`evaluateSupport` are unchanged. Structured agent result remains a proposal, not proof | Remove advisory links; no ledger migration required |
| DL-09 | Drift, retirement and operational runbook; after DL-03, before DL-07 | Frozen canary and limits per identity; definition/model change invalidates released threshold. Health includes budget, latency, unknown cost, corruption, backlog and loss. Document disable, recover, archive and reproduce procedures | Withdraw consumer and threshold; retain old records |

## Failure, stale-state and retry rules

Unanswered, abstained, refused, corrupt, budget-blocked, unavailable and stale inputs never become a favorable assessment. Advisory absence leaves the existing pipeline behavior intact. For an explicitly configured enforcing escalation consumer, absence of a required trustworthy assessment means withhold its ordinary auto-approval and retain manual review; this stronger fallback must be declared and approved before release, not silently imposed globally. Existing human approval paths remain available subject to existing checks and knowledge boundaries.

Pre-call refusals are distinguishable from spent/possibly spent calls. Persist intent before invocation and result before application. Key application idempotence by instance/phase/attempt/policy version and input state; repeated delivery does not apply twice. A changed attempt requires a new evaluation. Bound retries only for known pre-call transient failures; never infer that an unknown invocation did not spend money. Corruption stops affected writing/application and reports a typed reason. One writer remains the baseline assumption; multi-writer support is a separate design if ever needed.

## Evidence and release gates

**Architecture/read-only gate:** zero unexplained journal/collection/reference/snapshot integrity findings in the released evidence set; byte-identical offline replay of a frozen report; read paths create nothing; missing source inputs become unavailable, not current. Prove storage limits, archive/recovery and unknown-call handling with tests. Live overnight results can cover integrity and accounting, not every crash branch.

**Advisory gate:** display limitations and exact evidence; observed termination remains deterministic; residual correctness remains unmeasured unless independent references exist. Keep Autopsy replacement deferred until taxonomy, labels and comparative value are established. Do not convert old eleven-way Autopsy output to a new taxonomy without a published mapping and explicit limits.

**Enforcing gate:** approved consumer-specific false-close/false-escalation costs and thresholds; a prospective blinded genuine operator cohort with both outcome classes, baseline comparison, coverage/loss counts and intervals. Independent review is required for claims about correctness or safety. N>=200 permits the existing calibration display but does not itself prove safety. Suggested targets requiring explicit acceptance: false-close Wilson 95% upper bound <=5%, useful detection gain against the deterministic baseline, and an agreed tolerable false-escalation rate. With zero misses, the two-sided Wilson bound needs about 73 sent-back cases for 5% or 381 for 1%; these are class-specific denominators, not total samples. No automatic gate-opening proposal belongs in this plan.

**Robustness gate:** retained-snapshot k=3 repeat evaluations, irrelevant padding and subject-authored instruction tests, missing-field ablation and provider identity separation. Report top-answer flip rate and distribution distance. Fresh matched scenario runs are exploratory rather than equivalent. Agree tolerances before inspecting the acceptance corpus; this draft does not invent a passing result or retrospectively select thresholds.

## Future implementation tests

Use current decision test suites as the baseline, then add meaningful consumer tests: old/new phase attempt; changed artifact and claim revision; selected candidate changes; state drift between evaluation/application; unavailable source after pruning; rejected/disallowed provider; invalid distribution and exact tie; corrupted snapshot/ledger; archival replay; crash before/after invocation/result/application; duplicated application; hard budget stop; no provider under lock; operator action before/during/after prediction; and preserved knowledge gate restrictions. Test unchanged support/acceptance semantics and isolation from knowledge/source stores. Validate runtime process contention and cost separately from injected-spawn tests.

Run relevant contracts/server/web build and focused suites for actual future edits. Preserve known baseline failures as explicit findings. No application tests were run for this document-only planning artifact; it proves a reviewed proposed design, not functioning new behavior.

## Closeout outcome and evidence still needed

The intended closeout is a written development decision, not a declaration that every model is trustworthy. Stop repetitive broad feeders when they add no new class or failure mechanism. Retain a finite corpus and canary, and replace indefinite shadowing with scoped acceptance validation for specific consumer releases. If genuine human labels, exact-snapshot reevaluation or class coverage remain unavailable tonight, record them as blocked proof prerequisites and keep enforcing utilization deferred. Finishing the experiment means choosing the architecture and release path honestly; it does not erase unmeasured risks.

Primary sources: `docs/rfc/2026-09-29-decision-plane.md` sections H, J, O, P and Q; `contracts/src/decision.ts`; `server/src/decision/{definitions,observations,currency,service,journal,replay}.ts`; `server/src/decision/h1/{gate,baselines,report}.ts`; `server/src/decision/h2/{config,sampling,report}.ts`; `server/src/app.ts`. Later closeout evidence must identify the actual running build and configuration rather than assume it matches this inspected tree.

## New live evaluation limitation

See reports/deadline-probe-validity-review.md. The first correct native deadline answer explicitly relies on a schedule name containing “deadline”. It validates the live collection path, but cannot establish independent timeout recognition. All future held-out consumer validation must use neutral metadata and audit the exact frozen projection for label leakage. These requirements remain unimplemented and unproven; current historical answers must retain this caveat.
