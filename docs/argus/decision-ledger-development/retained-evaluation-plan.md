# Retained-snapshot evaluation coordinator foundation

Date: 2026-10-10. Proposed next slice; implementation and activation are not established by this plan.

## Scope and ownership

Build an executable, default-unwired coordinator with a separate bounded invocation ledger and injected authorization, capability preflight, exclusive-writer and shared atomic reservation seams. Only temporary stores and mock providers are used for proof. No default caller, provider factory, route, scheduler, policy, enforcement, live migration or production wiring.

Reuse canonical envelopes and fsynced appends from decision/storage.ts. Reuse KeyedMutex for same-process serialization only. It does not establish cross-process single-writer safety. Production requires authoritative exclusive ownership for the invocation and reservation stores; an absent, expired or rejected ownership capability fails closed.

The existing reEvaluate identity guard remains the retained-input admission owner. Add only optional preassigned result id to reEvaluate, validate it before invocation and pass it to record. This preserves the original question version, exact retained snapshot and reEvaluates parent link without duplicating provider/output validation.

## Responsibilities and narrow APIs

- InvocationLedger.load(): strict validated history/index or integrity refusal.
- InvocationLedger.reserveCapacity(intent): capacity for intent and worst-case terminal settlement, without dispatch.
- InvocationLedger.appendIntent(intent), appendSettlement(settlement): bounded, ordered, durable writes under exclusive ownership.
- EvaluationCoordinator.execute(request): resolve idempotent delivery, admit new intent, invoke once, settle.
- EvaluationCoordinator.reconcile(): resolve open intents from exact journal evidence, never invoke.
- Authorization.authorize(binding): validated principal/scope/expiry bound to immutable request digest; absent or denied evidence refuses.
- Preflight.check(binding): fresh authoritative explicit runtime/model/account support evidence; missing evidence refuses.
- WriterOwnership.require(): validated exclusive ownership capability; no implicit success.
- SharedGate.acquire(binding, allowance), validate(reservation), settle(reservation, settlement), cancelProvenUncalled(reservation): durable idempotent atomic admission and accounting contract. Missing gate refuses. Mock implementations prove only the contract exercised locally.

Do not hold a ledger mutation lock across provider execution. Serialize admission and duplicate lookup; later duplicates observe the existing invocation and return in-progress or terminal state. A process-local active-call set distinguishes a live in-progress invocation from restart recovery.

## Immutable intent

Bind format/version; invocation id; caller namespace/idempotency key; canonical request digest; parent assessment id and journal digest; original complete question/projection references; retained snapshot hash/bytes/subject; provider key and expected full identity; explicit sample; preassigned result assessment id; reEvaluates parent; authorization reference/digest/scope/issued-at/expiry and invocation binding; preflight evidence reference/digest/expiry; exclusive-owner identity; reservation id/shared scope/accounting-policy digest/allowance; creation time; canonical intent digest.

Validate closed schema, supported enums, bounded strings and records, finite nonnegative quantities, integer samples, identifiers, digests and dates. Deep-copy bound inputs. Caller keys are data, never filesystem paths. Do not replace original version with latest, rebuild live inputs, repair historical records or interpret caller-supplied authorization text as authorization.

## Admission and delivery protocol

1. Require ownership; strictly load ledger and journal. Corruption halts.
2. Resolve existing caller/key. Identical binding returns existing state; changed binding refuses. An existing unresolved invocation never authorizes a second call.
3. Validate parent provenance and exact retained identities through the service admission boundary; validate authorization/preflight and their expiry. Ensure service/provider identity is bound explicitly.
4. Reserve ledger capacity for intent plus worst-case settlement before monetary admission. Refuse full storage before dispatch.
5. Under the shared gate's atomic admission operation, acquire an idempotent durable reservation. Unknown/invalid existing spend and insufficient allowance refuse.
6. Fsync immutable intent before dispatch. If publication fails, call none. Recover an orphan reservation through the gate contract; release only when no-call evidence is authoritative.
7. Validate the reservation asynchronously, then recheck pinned ownership and authority/preflight expiry synchronously beside actual spawn through guarded dispatch. Invoke reEvaluate with preassigned result id once. Reservation permit lifetime/revocation semantics remain a production release prerequisite; this does not prove a final synchronous accounting-state assertion.
8. Publish durable terminal settlement and idempotently settle reservation. Persist enough linkage to recover a crash between these writes.

Reservation-before-intent and settlement-before-gate completion create cross-store crash windows. Explicit recovery handles them; do not claim the stores participate in an atomic transaction. Reservation ids must recover by invocation id. Uncertain intent publication conservatively retains reservation until recovery proves no dispatch.

## Settlements and restart recovery

Terminal states: recorded, refused-before-call, unknown-outcome, integrity-halt. Settlements bind invocation/intent digest, result assessment id/digest where present, actual provider identity, outcome classification, call status yes/no/unknown, cost known/unknown, timestamp and bounded reason.

Recorded failure/abstention stays failed/abstained; it confers no favorable authority. Unexpected provider identity settles as mismatch, never silently replaces admitted identity. Unknown/invalid cost stays unknown and possibly spent. Release reservations only for proven no-call refusal.

Restart reads open intents and exact journal evidence. Match result id, parent link, question/projection complete refs, snapshot hash/bytes/subject, sample and admitted provider identity; verify result digest and journal integrity. Exact result reconciles without calling. Missing result becomes unknown-outcome and is never resent, even if a crash may have preceded dispatch. Contradictory result or damaged evidence halts. Repeated reconciliation and repeated delivery produce the same settlement.

Strict bounded logs validate sequence, state transitions, unique invocation/result ids and caller keys, and settlement links. Malformed complete lines, digest failures, gaps, conflicts, unsupported versions and illegal transitions halt admission. Torn tail never permits uncertain dispatch to be replayed or possible spend to disappear. Retention must preserve durable deduplication identity; deleting old keys must not make them new requests. No automatic retention deletion is needed in this slice.

## Local acceptance evidence

Tests first with testHome and fresh temporary stores: concurrent duplicates call at most once; changed payload under same key refuses; denied/expired authorization, absent ownership/gate/preflight or insufficient allowance calls none; capacity/intent write failure calls none; unknown/invalid spend prevents reservation; every crash boundary recovers deterministically without resend; exact journal result reconciles; mismatched identities/corrupt logs halt; repeated restart/delivery is stable; original parent and snapshot bytes remain unchanged. Focused tests, typecheck/build, lint and independent review establish this local foundation.

## Release gates and rollback

Fixtures establish durable coordination under injected contracts. They do not prove account compatibility, cross-process ownership, production global budget enforcement or a hard dollar cap. Existing H1/H2 sequential shared-spend reads are not atomic reservations.

Activation requires real application-owned exclusive writer, durable shared gate covering H1/H2 and every other invoking path, authoritative fresh account-bound explicit model capability evidence, tested recovery of cross-store reservation/settlement windows and operational disable/recovery drills. All activation remains blocked until these exist.

Rollback removes wiring and stops new admission. Retain intent/reservation/deduplication history, reconcile durable results and conservatively settle unresolved calls. Never erase possible spend or retry uncertain invocations. No policy/enforcement authority is introduced.

## Architecture rulings before implementation

- Requested provider identity binds provider, requestedModel, adapterVersion and elicitation. reportedModel remains observed (possibly null); only a separately explicit authorized reported-model allowlist may restrict it. Do not guess a reported identity during preparation.
- Add read-only prepareReEvaluation to the service, reusing the retained identity guard. It returns pinned parent journal provenance/digest, original question/projection, snapshot and requested provider identity. It must not publish snapshots, call providers, rebuild live inputs or write records. Dispatch revalidates the prepared binding and accepts an optional preassigned result assessment ID, preserving the parent link.
- Same-process coordination uses the resolved ledger path across coordinator instances; an instance-local mutex/active set is insufficient. Actual cross-process exclusivity remains an injected fenced-owner prerequisite, not proof from KeyedMutex.
- Capacity admission reserves worst-case settlement bytes for every durable open intent after restart. No in-memory-only capacity reservation or deletion of resolved idempotency keys.
- Gate reservations must bind invocation ID, request digest, shared scope, policy and allowance. Missing or changed bindings refuse. Orphan enumeration and recovery belong to the gate protocol; uncertain publication retains the reservation, and absence alone never proves no call without fenced ownership.
- Reconciliation matches shadow mode, parent link, exact original definitions/snapshot/subject/sample/requested provider and authorized observed model policy, plus journal digest/provenance. Corrupt evidence halts; it must not be misclassified as merely missing.
- Keep implementation in new decision-plane modules/tests and narrow service preparation/id changes. No contracts, index, app, experiments, provider wiring, policy or enforcement source changes.

Ruling: implement the locally testable default-unwired foundation only — it closes durable coordination prerequisites without claiming real shared budget, account compatibility or exclusive ownership exists. If an injected contract cannot be exercised conservatively with fixtures, retain a specific blocker rather than adding permissive defaults.

## Integration rulings

Keep a caller payload digest separate from the authorization/reservation request digest over the complete pinned preparation. Existing identical delivery resolves from durable history before current provider/source prerequisites are checked. Changed payload under the same key refuses. Authorization and reservations bind the full prepared request, not only the parent ID and provider alias.

Recheck the exact admitted owner fence and grant/preflight expiry after awaited reservation validation, immediately before dispatch. An ownership refresh that returns a different fence cannot be discarded as success. Orphan no-call proof must still match the current fence immediately before cancellation. Ownership receipts explicitly bind the resolved ledger and shared accounting scope/policy.

Existing service identity-mismatch failures normalize the adapter kind in journal provider metadata, with the reported mismatch retained in failure detail. Do not rewrite those historical semantics or guess an actual response identity from detail. A coordinator settlement of such a failed result is explicit integrity-halt/mismatch, with actualProvider unavailable/null; preserve result digest and known cost. A thrown provider has no response identity: actualProvider null, failed result and unknown cost remain conservative. No mismatch/failed result becomes favorable evidence.

Independent adversarial review amendments: pin defensive copies of all admission receipts. Carry admission through the guarded provider/runner to actual spawn after all asynchronous preparation. Final synchronous validation proves pinned ownership and authority/preflight expiry. Reservation validation remains asynchronous; later accounting-state revocation is not specified or proven by this foundation. Unresolved orphan reservations halt new admission even when remaining allowance is positive; missing intent history must not reset deduplication. Only a proven refused-before-call settlement may use providerCalled=no; uncertain or integrity-halt settlements retain yes/unknown. These are local safety prerequisites, not evidence of production ownership or budget coverage.

## Shared reservation permit prerequisite

A shared gate must specify whether outstanding durable reservations remain dispatchable through settlement or can be revoked by later accounting changes. Current fixture contracts do not settle that question. Resolve and validate the accounting contract before production integration; see reservation-dispatch-prerequisite.md. Unknown spend already blocks new acquisition. No hard monetary cap or final synchronous accounting-state guarantee is claimed.
