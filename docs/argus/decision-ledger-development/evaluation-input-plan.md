# Exact V2 offline input preparation plan

Architecture approved 2026-10-10 00:34 UTC. Dependency: verified retained preparation, registered immutable V2 and existing fixed Claude renderer. Scope: new evaluationInput.ts/tests plus explicit renderer version export; no invocation/reader/intent schema changes.

Existing behavior: retained preparation pins original snapshot and identities; Claude adapter rerenders internally. Authored case hints remain visible. Exact rendered-prompt audit is a documented prerequisite without executable binding.

Required change: read-only factory depending only on service.prepareReEvaluation, journal read/loadSnapshot and registry question/projection. Accept exact registered run.termination-probe@2/run-failure.blind@2 plus the fixed Claude verbalized adapter; refuse V1 conversion. Verify complete preparation digest, parent journal digest/segment/line, retained canonical hash/bytes/subject and registered definitions. Render via existing function. Return defensive deeply frozen versioned artifact with complete preparation, renderer/version/adapter, raw UTF8 prompt text/hash/bytes and canonical artifact digest. Always dispatchable=false. This is a new offline rendering, not proof of historical dispatched text.

Receipt: closed bounded versioned schema, exact artifact digest, audit protocol identity/digest, reviewer provenance reference, timestamp, explicit reviewed-for-offline-use/withheld disposition and receipt digest. Missing/malformed/mismatched/withheld refuses. Successful offline-review-complete remains dispatchable=false. Binding does not authenticate reviewer, prove neutrality, provide a human label or grant authority. No automatic receipts or pattern-based approval.

Acceptance: deterministic UTF8 exact bytes; metadata invariance versus authored hint retention; question labels/pointers/truncation changes; full snapshot/provider/sample/renderer identity drift; closed schemas; immutable clones; missing/corrupt/source/provenance refusal; no mock provider calls or journal writes; preserved V1 digests/defaults and preparation/intent compatibility. Focused input/V2/Claude/service/coordinator/isolation tests, server type/build/lint and independent review.

Rollback: remove additive input consumer/module and renderer export; preserve canonical records and retained review artifacts. No migration or authority enabled.

Disposition: implement offline preparation/binding only. A real future dispatch interface must consume exactly the reviewed frozen bytes; existing assess(q,snapshot) cannot prove that. Authenticated review provenance, genuine blinded reference labels, prospective evidence and production invocation prerequisites remain blocked. Do not wire this artifact into existing dispatch or reader usability.

Ownership: evaluation_input_impl owns only evaluationInput.ts/test; root owns renderer version export and documentation. Others' edits preserved. No staging/commits/live calls.
