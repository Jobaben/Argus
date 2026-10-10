# Shared reservation dispatch contract prerequisite

2026-10-10 03:30 UTC. Read-only contract investigation; no new defect or provider-call reproduction asserted.

The current shared-gate contract requires unknown or invalid existing spend to reject new reservation acquisition. A reservation binds invocation, prepared-request digest, accounting scope, policy and allowance. It has no revocation, validity generation or expiry field. Gate validation is asynchronous; the final synchronous dispatch assertion currently checks pinned ownership and authority/preflight expiry.

Consequently, these fixtures do not establish whether unrelated unknown spend arriving after successful gate validation invalidates an outstanding reservation. No production shared gate exists here. An expectation of zero spawn in that window would invent a policy the present contract has not specified.

Before production activation, the accounting owner must explicitly choose and validate one contract:

- A durable reserved permit remains valid through settlement; the gate must prove the allowance is isolated from subsequent admission/accounting changes and conservatively retain possible spend.
- Accounting changes can invalidate outstanding permits; the gate must expose an explicit final synchronous validity assertion or equivalent protected dispatch permit, with actual-spawn drift regressions and durable restart semantics.

Both choices require authoritative common accounting coverage across every invoking path, unknown-outcome retention, idempotent settlement, fenced recovery and operational disable drills. Neither is proven by injected fixture gates. This is a release prerequisite, not permission to use a permissive default or claim a hard monetary cap.

Evidence locations: retained-evaluation-plan.md admission steps 5 and 7; server/src/decision/invocationLedger.ts Reservation schema; server/src/decision/evaluationCoordinator.ts SharedEvaluationGate and dispatch admission; server/src/sources/analysis.ts final validation beside spawn; dispatch-boundary-plan.md. Existing acquisition tests cover unknown spend before reservation, not revocation afterwards.

Rollback remains withdrawal of admission wiring while preserving all intent, reservation, settlement and deduplication history. No source change, test repetition, provider call or live-store access was performed for this investigation.
