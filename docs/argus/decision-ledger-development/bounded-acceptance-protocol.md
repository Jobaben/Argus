# Bounded consumer acceptance protocol

2026-10-10 04:00 UTC. Proposed release protocol based on the closeout consumer matrix and current verified foundations. This document does not launch a study, authorize provider calls, approve numerical thresholds or enable a consumer. The overnight task's live provider-call limit remains zero.

## Required launch record

Before any future validation, the responsible release owner must freeze one consumer-specific record containing:

- Intended consumer, permitted effect and explicit excluded claims; owner/approval evidence and release decision to be made.
- Source/build/config identity; full question/projection/provider/renderer references; corpus membership, retained artifact hashes/bytes and exact run/attempt/candidate/state identities applicable to that consumer.
- Input review protocol and provenance, redaction/authorization scope, reference provenance and withheld-reference separation. Reference collection must be independent of model output; unresolved cases stay unresolved.
- Finite maximum corpus size, calls, repeats, concurrency, time and monetary allowance; shared accounting scope/policy and behavior for unknown cost/outcome. All required limits must be specified before calls. Missing limits block launch rather than inherit an indefinite schedule.
- Pre-agreed acceptance measures, class denominators and tolerances appropriate to the claim, baseline comparison, treatment of missing/failed/abstained/stale/corrupt evidence, and exact stop/withdraw/recovery procedures.

Freeze and identify this record before observing acceptance answers. Changes require a new version and explicit disposition of the prior run; do not silently expand the corpus, switch providers, select favorable repeats or adjust thresholds after seeing results. Historical calibration display counts, repeat counts and suggested statistical targets are not approval of a release criterion.

## Separate consumer gates

| Consumer validation | Locally verified foundation | Evidence required before launch/release | Bounded result and rollback |
| --- | --- | --- | --- |
| Run-only advisory read | Exact consumer allowlist; retained provenance/integrity; current/stale/historical/unavailable; read isolation, deterministic replay; run-only authenticated GET with default503 | Exact production build and configured consumer refs; finite assessment/source-state manifest with expected structural current/stale/historical/unavailable dispositions; repeated response-byte and before/after store-inventory checks; production read containment/authentication and missing-source presentation; UI limitations if a UI is released. No correctness claim without references. Artifact/H1 consumers are excluded until their identity prerequisites exist. | Complete the frozen read corpus with zero provider calls and zero store mutation. Any unexpected write/call, unsupported identity admission, false-current result or favorable failed/stale/corrupt/unavailable evidence stops release. Withdraw configured reader; preserve journal and ordinary human review. |
| V2 process evaluation and exact-input review | Authoritative process classes; unchanged V1; metadata invariance and authored hint visibility; frozen UTF8 artifact; offline receipt binding alwaysnon-dispatchable | Require registered run.termination-probe@2 and run-failure.blind@2 digests, an original retained V2 parent and complete preparation/provider/renderer identities; V1 cannot be silently converted. Audit exact rendered bytes including authored trace, identifiers, pointers, truncation and question text. Audit provenance must be authenticated before it can serve as review authority. Deterministic observed termination can be the reference for the process question; residual causes require independent genuine references. A future call must demonstrably consume the frozen reviewed bytes. | Review only the predeclared corpus; withheld/ambiguous/leaking inputs remain ineligible. No response may replace observed termination. Current receipt records completeness only. Stop V2 selection or withdraw offline preparer; preserve all original inputs and interpretations. |
| New retained-snapshot evaluation coordinator | Exact retained preparation; durable bounded intent/settlement; duplicates/restart without resend; guarded actual spawn; conservative failed/unknown outcomes | Real fenced exclusive owner/current assertion; fresh authoritative account/model capability; durable atomic common gate covering every caller; explicit reservation lifetime/revocation semantics; operational cross-store recovery/disable drills; immutable caller authorization and fixed reviewed input when used for acceptance | Enforce the frozen limits before each new admission. Capacity, authority, integrity or accounting uncertainty stops new admission. Reconcile existing exact results; unresolved calls remain unknown and are never automatically resent. Withdraw admission wiring without deleting intents, reservations, settlements or deduplication keys. |

Configured consumer IDs and provider aliases in tests are fixtures, not production configuration. Structural read dispositions are expected behavior assertions, not human cause labels.

These are separate gates: successful read validation does not authorize a provider call, and an offline input review does not release coordination or enforcement. Advisory presentation must continue to identify inference and uncertainty. No automatic gate opening, knowledge acceptance or permission widening is admissible.

## Terminal decisions

Each bounded validation ends with one recorded disposition: accepted for the declared narrow claim, rejected on observed evidence, or blocked/inconclusive with exact missing prerequisites. Reaching the time/call limit is not acceptance. Report all attempted items and failure/unknown/abstention populations with cost known and unknown separated; exclude none merely because they weaken a result. A spent or possibly spent failure stays in accounting and cannot be retried under a fresh key to escape uncertainty.

Stop early on unexplained integrity failure, identity drift, lost ownership, exhausted capacity/allowance, unaccounted possible spend, unexpected provider/store activity, breached blinding or undeclared authority. Finish safe reconciliation of already admitted work without new calls. Never continue an unchanged exploratory feeder while waiting for missing references or capabilities.

Enforcing escalation/withholding remains a separate blocked release. It requires prospective genuine operator/reference evidence, approved consumer-specific losses/thresholds and class coverage, state recheck, durable idempotent application/fallback and tested rollback. Policy evaluation, prepared intent and actual durable applied settlement must remain distinct. No enforcing acceptance run is launched here.

## Current evidence and readiness

Current local foundations are implemented and fixture-verified; production launch prerequisites above are unmet. No consumer is declared ready for live verification by this protocol. Exact current test results are in implementation-status.json and validation/*.json; known pristine Windows server failures remain explicit. Agent reviews and authored scenario intent are not human reference labels. See acceptance-input-prerequisites.md, reservation-dispatch-prerequisite.md and runbook.md for the unresolved boundaries.
