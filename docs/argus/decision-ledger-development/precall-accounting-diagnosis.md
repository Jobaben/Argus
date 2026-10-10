# Pre-call accounting diagnosis

2026-10-10 01:31 UTC. Actual mock runner counters and temporary-store evidence in validation/precall-accounting-probe.log and precall-coordinator-probe.log.

Existing defect: Claude unsafe-cwd/already-aborted guards return without runner/spawn, but service records failed assessments with providerCalled=true and unknown cost. The coordinator then durably settles recorded/yes/unknown; injected shared gate blocks the next fresh key for unknown spent cost. Service documentation promises spent-call versus refusal semantics, so this is a provenance defect rather than merely an adapter-method counter.

H1/H2 classify these refusals no-call using PRECALL_FAILURES strings. That avoids this false halt but lets an arbitrary failed outcome name masquerade as no-call. Historical assessments lack execution provenance. Outcome labels cannot prove whether invocation/spend occurred.

Required narrow prerequisite: trusted adapter/runner execution disposition, separate from model outcome. Explicit no-call returns typed service refusal before assessment append; coordinator's existing durable no-call handling is reused. Missing, thrown, malformed or contradictory disposition remains potentially spent; unknown cost stays unknown. New H1/H2 classification and reconciliation cannot infer no-call from arbitrary failure strings. Existing historical records/ledger classifications are not rewritten; retired collection stays disabled.

Disposition: architecture planning before implementation. Meaningful evidence must include actual counters for known adapter/runner refusals, failure-name spoofing after a started call, missing/contradictory provenance, thrown runtime, preserved unknown cost, duplicate/restart coordinator behavior and H1/H2 accounting. No live calls or activation.

Rollback: withdraw new dispatch wiring and keep callers disabled if explicit provenance is unavailable; preserve invocation/assessment/reservation history and potential spend. Reverting protection must not authorize retrying uncertain calls.
