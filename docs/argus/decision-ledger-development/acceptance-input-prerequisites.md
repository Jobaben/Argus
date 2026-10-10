# Acceptance input and advisory identity prerequisites

Initial investigation: 2026-10-10 00:33 UTC; status updated at 03:35 UTC. No labels, live provider calls or live writes.

## Exact evaluation inputs

V2 removes schedule/prompt/summary/case metadata while preserving subject-authored timeline evidence. Neutral metadata fixtures prove rendered-input invariance across withheld metadata changes. The authored-hint fixture deliberately proves CASE_D1_EXPECTED_DEADLINE remains rendered; omission is not semantic blinding.

The Claude renderer includes question and answer labels, canonical body, subject-authored pointers and truncation annotations. Snapshot subject/refs/projection metadata are excluded from its text. At the initial investigation, the service pinned retained snapshot and requested provider identities, but had no exact rendered prompt hash/byte count/renderer identity or audit receipt. The subsequently verified offline evaluationInput module now supplies that artifact and an unauthenticated receipt binder, always dispatchable=false. The adapter renders immediately before calling its runner. A future acceptance evaluator must bind an audit decision to the exact frozen bytes actually dispatched, including renderer and full identity context. Pattern absence cannot automatically approve neutrality. Human reference labels and audit admission are separate evidence.

Disposition: minimal offline pure preparation and exact audit-binding seam implemented and verified under evaluation-input-plan.md. V1 definitions/default collector/archival invocation semantics are preserved. Semantic neutrality, authenticated review and actual dispatch consumption of the frozen bytes remain blocked; the ordinary adapter still rerenders. No provider framework or general leakage classifier was introduced.

## Artifact-sensitive H1 advisory

Historical gate-review@1 captures capped path/byte-length summaries with empty artifact refs. Its live builder deliberately refuses. Same-size content edits or changes beyond projected caps cannot be detected from these records. Retrospectively hashing today's files cannot add historical content identity. Full snapshot currency also differs from the watcher's material review-state digest, so replacing the refusing builder risks false stale and false current results.

A truthful future version needs full artifact content hashes and exact root/path identity, complete listing/read guarantees, phase attempt, selected candidate and relevant run binding, exact proposal/criterion definitions and verification content/run identities, plus material-state comparison. Missing/raced/unsafe/partial inputs remain unavailable. Bare criterion AC-1 and path+length are insufficient. Unrequested V1 semantics and canonical records remain unchanged.

Disposition: defer this larger identity-version slice. It needs new identity-bearing captures, safe production filesystem containment/race proof, admission rules/UI and operational evidence. Keep V1 H1 advisory historical/unusable. No new consumer or enforcement is enabled.

Rollback: withdraw additive offline input preparation/consumer wiring; retain historical snapshots, assessments and audit evidence. Unknown spend and existing invocation deduplication remain intact.
