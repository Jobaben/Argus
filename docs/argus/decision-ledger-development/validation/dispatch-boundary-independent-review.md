# Independent actual dispatch-boundary review

Frozen carrier and service owner bytes reviewed on 2026-10-10.

Actual original-gap reruns: integrated-dispatch-gap-boundary-review.mts and integrated-dispatch-fence-gap-boundary-review.mts both exited 0, spawned 0, and preserved assessment count. Originals and failing logs remain unchanged. The expiry case remains unknown-outcome because expired ownership prevents durable settlement; the fence case settles refused-before-call with providerCalled=no and zero proven-call spend.

Fresh independent command from server: ../node_modules/.bin/tsx.cmd --import ./src/testHome.ts --test --test-reporter=spec src/sources/analysis.test.ts src/decision/claudeCli.test.ts src/decision/service.test.ts src/decision/evaluationCoordinator.test.ts src/decision/dispatchAdmission.integration.test.ts src/decision/isolation.test.ts

Result: 133 tests, 132 pass, 1 fail, no cancellation. Saved dispatch-boundary-independent-focused.log. The failure is isolation.test.ts:347: its sources/analysis.js import allowlist rejects AnalysisDispatchAdmission in provider types/Claude/mock and dispatchValidationDetail/prepareDispatchAdmission in mock. Those imports are type/pure local validation helpers; existing explicit analysis runner seam permits only AnalysisRunner and analysisModel. Architectural disposition required before claiming completion. Reviewer changed no implementation or isolation test.

Source review confirmed explicit optional guarded capabilities with unsupported refusal; async preparation followed by mandatory synchronous validateNow immediately before spawn; no await or user callback after final validation before spawn; required synchronous ownership.assertCurrent checks with Promise/thenable refusal; fresh clock and original pinned owner/grant/preflight expiry checked after asynchronous work; abort checked at final boundary. Focused tests cover budget/microtask fence and expiry drift, malformed/throw/async admission, missing provider/runner/ownership capabilities, custom thenable ownership, valid one spawn, duplicate/restart no resend, lost settlement unknown spend, and strict no-call refusal before assessment append.

Limits: temporary stores and injected mock spawn/current ownership capability only; no live provider, persistent schema/provider identity/prompt version changes or activation by reviewer; no production account/shared atomic gate/cross-process exclusive fencing proof, frozen reviewed-byte dispatch, or human-label/calibration proof. No staging or commits. Owner typecheck/build/scoped-lint logs report exit 0 but independent isolation check is failing.

## Final independent verification after narrow isolation disposition

Root amended only the isolation seam allowance and added an AST assertion requiring AnalysisDispatchAdmission imports to remain type-only. Reviewed exact allowance: AnalysisDispatchAdmission, dispatchValidationDetail, prepareDispatchAdmission; all other existing allowed symbols and writer prohibitions are unchanged. The new AST check handles both whole-import and specifier type modifiers and the imported symbol name when aliased. Pure helper inspection found no store/pipeline/gate mutator introduced by this allowance. No substantiated issue remains in the requested local scope.

Fresh command from server: ../node_modules/.bin/tsx.cmd --import ./src/testHome.ts --test --test-reporter=spec src/sources/analysis.test.ts src/decision/claudeCli.test.ts src/decision/service.test.ts src/decision/evaluationCoordinator.test.ts src/decision/dispatchAdmission.integration.test.ts src/decision/isolation.test.ts src/decision/h2/activity.test.ts

Result: exit 0; 136 tests; 136 pass; 0 fail/cancelled/skipped/todo. This includes the former 133 checks, one new type-only isolation check and two counting wrapper checks. Exact final log: dispatch-boundary-independent-final.log. SHA256 of 14 reviewed source/test files: dispatch-boundary-independent-source-hashes.log. Prior failing independent log remains preserved.

Both unchanged actual gap repros already passed zero spawn/no assessment append. No production activation or live provider occurred. Default-unwired local dispatch repair is independently verified within these focused fixtures; injected current ownership is not production cross-process proof, and operational/account/shared-gate/frozen-byte-dispatch/human-label limitations above remain.
