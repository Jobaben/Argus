# Next-slice feasibility: retained evaluation and policy preparation

Read-only investigation: 2026-10-10. No application source edits, live provider calls, canonical record changes, production activation, or enforcement. The reproduction below used injected mock providers and fresh temporary stores only. This report is a development proposal, not evidence that the proposed coordinator exists or that any threshold is safe.

## Smallest coherent next slice: reject mismatched retained-evaluation identity

**Local coding is feasible now.** `server/src/decision/service.ts:358` already implements a new provider call against an original retained snapshot and question version, appending a linked shadow assessment. Its pre-call validation is weaker than `assessSnapshot` (`service.ts:298`) and the advisory reader (`reader.ts:203`). At `service.ts:386`, it compares only retained projection digest with the parent assessment's projection digest. It does not require matching projection id/version, parent subject, parent snapshot bytes, complete registered projection identity, or a freshly resealed content identity before invoking the provider.

`server/src/decision/journal.ts:891` checks assessment snapshot hash/bytes against the supplied snapshot at append time. It does not require assessment.subject or assessment.snapshot.projection to equal the snapshot content. A hash-valid but semantically inconsistent historical assessment can therefore exist without weakening or rewriting the journal's historical format.

### Actual temporary-store reproduction

1. Create a normal residual assessment through a mock provider and load its retained snapshot.
2. Append a copied assessment under a new valid `DA-` id, using the same retained snapshot, with one alteration below.
3. Call `service.reEvaluate` on that new parent id. Count mock calls before/after.

Observed results before any next-slice correction:

| Altered parent field                                        | Result                        | New mock calls | Defect                                                                                            |
| ----------------------------------------------------------- | ----------------------------- | -------------: | ------------------------------------------------------------------------------------------------- |
| subject.runId = other-run                                   | accepted; providerCalled=true |              1 | Provider saw run-1 snapshot, new assessment names other-run                                       |
| snapshot.projection.id = other-projection; digest unchanged | accepted; providerCalled=true |              1 | New assessment silently uses retained run-failure projection instead of parent's named projection |
| snapshot.projection.version = 2; digest unchanged           | accepted; providerCalled=true |              1 | New assessment silently uses retained version 1 instead of parent's named version 2               |

No real provider was invoked. Original question/projection definitions and existing assessments remained unchanged. Parent snapshot byte mismatch requires an injected journal view or a directly encoded temporary fixture line, because ordinary journal append already rejects byte mismatch. Retained canonical/hash corruption can be exercised with an injected lookup; real loadSnapshot already validates stored bytes, but the service should refuse inconsistent lookup results before invocation.

### Required change

Before the provider call, require all of:

- Original question definition still matches by complete registered reference; its declared projection resolves to the same full reference as the parent and retained content.
- Parent subject equals retained content subject and matches the registered question's subject kind.
- Parent snapshot hash and bytes equal loaded snapshot hash and bytes.
- Canonical resealing of retained content matches both hash and byte identities; content format/version is supported.
- Snapshot size remains within the registered projection limit.

Return an explicit pre-call refusal with providerCalled=false on mismatch. Do not rebuild from live sources, repair historical records, reinterpret V1, or call a provider to diagnose mismatch. Keep successful re-evaluation as a new linked shadow assessment on the original question version, even when a newer question is registered.

### Acceptance and rollback

Tests first: all three actual mismatch cases refuse with zero additional mock calls; altered bytes/content identity refuses; registered projection drift refuses; valid archived input still calls once and preserves original digest, original question version, snapshot identity, and reEvaluates link. Existing compatibility tests are `service.test.ts:175` (archived retained re-evaluation) and `service.test.ts:214` (missing source/definition mismatch refusals). Store inventory must show no write on refusal and no original record rewrite on success.

Stop condition: focused service/integrity tests, server typecheck/build and independent review pass; no endpoint, scheduler, new provider adapter or enforcement added. Rollback: withdraw this pre-call validation consumer or revert the narrow service/test patch before release; preserve historical records. Reverting protection restores the known defect, so leave new evaluations disabled if rolled back.

## Preparation-only alternative and executable coordinator prerequisites

A read-only preparation function is feasible independently: return an immutable plan binding parent assessment id/digest, exact original question/projection refs, retained hash/bytes/subject, requested provider identity, requested sample, and caller-supplied authorization scope. It must not call providers, publish snapshots, write invocation intent, grant authority, or call itself an executed evaluation. Tests can prove deterministic preparation, exact identity mismatch refusal and unchanged stores. It is useful for review, but does not replace durable invocation coordination.

Reusable foundations for an executable coordinator:

- `service.ts:298` accepts a validated retained snapshot and preassigned assessment id. `reEvaluate` currently lacks a preassigned new id; a narrowly scoped extension would enable exact reconciliation while retaining parent linkage.
- `decision/storage.ts:77` supplies canonical hashed line envelopes; `storage.ts:285` appends and fsyncs. `mutex.ts:12` supplies keyed same-process serialization.
- H2 watcher has durable attempt-before-call at `h2/watcher.ts:576`; reconciliation at roughly line 282 finds a preassigned assessment id or records unknown-outcome and never automatically resends. H1 has the same durable intent pattern at `h1/watcher.ts:831`.
- `journal.ts:1134` and `:1139` expose read-only journal/snapshot lookup. The existing journal remains the assessment store; invocation intent should be a separate bounded typed log, not an assessment or a recreated experiment.

Exact gaps: validated authorization bound to immutable invocation identity; a durable caller idempotency key; preassigned re-evaluation id; general intent/result/unknown-outcome log; strict reconciliation matching all bound fields; a common budget acquisition/reservation gate; authoritative runtime/account support evidence before live activation. `decision/experiments.ts:39` and `:43` share historical spend through sequential H1/H2 reads, and its check executes H1 before H2. This is not a general atomic reservation shared with arbitrary new evaluations. Analysis runner serialization limits concurrent execution but does not prove atomic monetary authorization/reservation across caller ledgers.

A fixture-only coordinator can be coded locally under current authority with injected authorization, budget and mock provider seams, no production factory or route. Meaningful tests: duplicate concurrent delivery makes at most one call; durable intent failure makes none; crash after intent or uncertain provider completion becomes unknown and never resends; crash after assessment append reconciles exact id and identities; denied/expired authorization and insufficient shared allowance make no call; unknown/invalid existing spend prevents a new reservation; corrupt invocation log halts; repeated restart is deterministic. Activation remains blocked until every real invoking path shares the gate and runtime support is proven. A rolling stop after unknown spend is containment, not a prospective hard dollar cap.

## DL06: policy preparation is locally feasible; policy application remains gated

`contracts/src/decision.ts:270` defines a policy contract with only friction effects: escalate, flag, withhold-auto-approval. There is no evaluator, policy registry, durable evaluation/intent/application record, rollback implementation, or approved threshold evidence. The contract references provider kinds and question id/version, but omits the exact provider/projection/definition digests and target answer semantics required for strict binding. `decision/registry.ts:95` deliberately rejects questions declaring consumers; historical definitions must retain that restriction and their digests. `DecisionAssessment.mode` (`contracts/src/decision.ts:203`) must not be overloaded as proof of a durable applied transition.

The existing advisory reader can supply validated identity, retained integrity and live applicability. A small pure preparation module is feasible: accept an explicit versioned rule supplied by the caller, a verified advisory result, and exact target-state identity; refuse missing/failed/abstained/stale/historical/corrupt/unsupported evidence; return only evaluated output or a prepared intent. Do not install a default rule, choose a production threshold, relax question consumer registration, change human approvals/knowledge boundaries, or provide an apply method. Fixture thresholds test arithmetic only and are not calibration or operator reference labels.

For eventual application, reuse the engine's durable transition convention, not its granting approval path. `pipelineEngine.ts:5643` documents validate -> fsynced intent -> linked pending operation -> idempotent effects -> durable save clearing marker. Helpers at `:5675`, `:5707`, and `:5880` demonstrate refusal before effects, durable linkage and restart settlement. An unlinked record is not-applied; a linked pending marker is incomplete; applied requires verified durable settlement. Reusing that convention does not authorize calling approve, accepting knowledge, opening a gate or widening permissions.

Required integration gaps: exact state recheck under the target lock; idempotent effect key; authoritative durable receipt/settlement binding; conservative fallback on drift/failure; tested disable and rollback; permitted consumer declaration for a new version; prospective operator cohort, accepted loss/threshold criteria and calibration evidence. All enforcing consumers remain disabled. Local code for pure evaluation/preparation and fault-injection protocol tests is feasible; production policy rules, live application and safety claims are gated by those release prerequisites.
