# DL06 policy preparation developer guide

[Development status](../../development/README.md) · [DL06 feasibility](next-slice-feasibility.md)

`server/src/decision/policyPreparation.ts` provides a synchronous, server-local
preparer for one caller-supplied probability rule and one advisory assessment.
It evaluates the comparison and, when matched, returns a prepared friction
intent. Every successful result has `applied: false`. Preparation performs no
provider calls, source reads, store writes or effects. There is no apply method,
route, production wiring, installed policy rule or calibrated production threshold.

The historical closeout report, implementation matrix and feasibility report
retain their captured scope. This guide describes the additive preparation API;
it does not establish live policy readiness or change their validation evidence.

## API and rule identity

Import `createPolicyPreparer` and `PolicyPreparationRule` from
`server/src/decision/policyPreparation.ts`. The factory accepts
`{ registry }`, using the registry's read-only `question`, `projection` and
`latestQuestion` lookups. Call:

```ts
createPolicyPreparer({ registry }).prepare({
  rule,
  advisory,
  target: { subject, stateDigest },
});
```

`advisory` is an `AdvisoryReadResult` from `createDecisionReader` in
`server/src/decision/reader.ts`. `target.subject` must match the assessment
subject; `target.stateDigest` is a caller-supplied lowercase SHA256 digest.
The preparer neither loads that target state nor proves that its digest is
fresh, locked or authorized.

The rule supplies an `id` and positive safe integer `version`, exact `question` and
`projection` references (id, version and digest), and the complete `provider`
identity. Provider kind alone is insufficient. Rule/definition ids and choice
option ids use lowercase alphanumeric segments separated by dots or hyphens.
Rule, reference, provider, target and answer-selector objects must have exactly
their supported fields. The rule also supplies:

- `targetAnswer: { kind: "probability", shape: "binary", event: "p" }`, or
  `{ kind: "probability", shape: "choice", optionId }` for a registered option;
- `comparison: ">="` and a finite `threshold` in `[0, 1]`;
- `effect: "escalate"`, `"flag"` or `"withhold-auto-approval"`.

Binary evaluation selects `p`; choice evaluation selects the named option's
probability. Equality meets the threshold. Rating and scale answers,
aggregation across assessments and other comparators are unsupported.

## Fixture example using a real advisory reader

This example belongs in the `server/src/decision` test context. Its mock provider,
temporary harness and `0.7` threshold exercise arithmetic and identity binding;
they are not a production rule, calibrated threshold or operator reference label.
The reader constructs the advisory result rather than manually asserting usable
or current flags.

```ts
import assert from "node:assert/strict";
import { canonicalDigest } from "./canonical.js";
import { BUILTIN_BUILDERS } from "./definitions.js";
import { createPolicyPreparer, type PolicyPreparationRule } from "./policyPreparation.js";
import { createMockProvider } from "./providers/mock.js";
import { createDecisionReader } from "./reader.js";
import { harness, RESIDUAL_P } from "./testSupport.js";

const provider = createMockProvider({ script: [{ distribution: RESIDUAL_P }] });
const h = harness({ providers: { mock: provider } });
const assessed = await h.service.assess({
  question: "run.failure-cause.residual",
  version: 1,
  subject: { kind: "run", runId: "run-1" },
  provider: "mock",
});
assert.ok(assessed.ok);
const assessment = assessed.assessment;
const reader = createDecisionReader({
  journal: h.journal,
  registry: h.registry,
  builders: BUILTIN_BUILDERS,
  sources: h.sources,
  consumers: [
    {
      id: "fixture-policy-reader",
      question: assessment.question,
      projection: assessment.snapshot.projection,
      providers: [assessment.provider],
    },
  ],
});
const advisory = await reader.read({
  assessmentId: assessment.id,
  consumerId: "fixture-policy-reader",
  subject: assessment.subject,
});
const rule: PolicyPreparationRule = {
  id: "fixture-missing-context-flag",
  version: 1,
  question: assessment.question,
  projection: assessment.snapshot.projection,
  provider: assessment.provider,
  targetAnswer: {
    kind: "probability",
    shape: "choice",
    optionId: "missing-context",
  },
  comparison: ">=",
  threshold: 0.7,
  effect: "flag",
};
const result = createPolicyPreparer({ registry: h.registry }).prepare({
  rule,
  advisory,
  target: {
    subject: assessment.subject,
    stateDigest: canonicalDigest({ fixtureTargetState: "review-pending" }).sha256,
  },
});
assert.ok(result.ok);
assert.equal(result.value.matched, true);
assert.equal(result.value.applied, false);
assert.equal(result.value.intent?.status, "prepared");
```

The fixture service creates an assessment through the mock before preparation;
that call is not a provider call by the preparer. The advisory reader checks live
applicability against injected fixture sources before returning its result.

## Results, refusals and consistency

Success has the shape
`{ ok: true, value: { status: "evaluated", applied: false, rule, probability, comparison, threshold, matched, intent? } }`.
`rule` is a `DefinitionRef` for the canonical rule. A non-matching comparison
returns evaluated output without an intent. A matching comparison adds an intent
with `status: "prepared"`, `applied: false` and `authority: "inference-only"`.

The intent binds the rule reference, assessment id and provenance envelope digest,
exact question/projection/provider identities, sample, snapshot reference and
subject, caller target subject/state digest, answer selector, probability,
comparison, threshold and effect. Its `digest` seals those bindings. Canonical
input copies and deeply frozen results prevent later input mutation from changing
the output; the same supported inputs produce the same output and digest.

Refusal has the shape `{ ok: false, reason }`. The module refuses malformed or
unsupported rules and targets, missing or unusable advisory evidence,
failed/abstained/invalid outcomes, stale or historical applicability, inconsistent
registered definitions/provider/answer identities, and corrupt or inconsistent
retained snapshot or assessment envelope evidence. Usable/current flags alone
cannot override those consistency checks. The exported `PolicyPreparationRefusal`
type defines the exact reason strings.

These are structural consistency checks, not authenticated provenance. A digest
can detect inconsistent content; it does not certify an author, establish a trusted
live read or prevent a caller from constructing a self-consistent fixture. The
preparer does not recheck currency after the reader returns.

## Before any future application

Production application still requires an exact state recheck under the target
lock, an idempotent effect key, authoritative durable intent/receipt/settlement
linkage, conservative fallback on drift or failure, and tested disable/rollback.
A new question version needs a permitted consumer declaration. Production rule
selection requires prospective operator cohorts, accepted loss criteria and
threshold calibration evidence. Existing historical definitions and their
consumer restrictions remain unchanged.

A prepared `withhold-auto-approval` intent does not itself withhold approval.
No returned intent escalates, flags, opens a gate, accepts knowledge or grants
authority. See [DL06 feasibility](next-slice-feasibility.md#dl06-policy-preparation-is-locally-feasible-policy-application-remains-gated)
for the retained application prerequisites.

## Offline validation

Validation on 2026-10-10 covered 15 policy preparation tests, including the
independent adversarial suite and the enum-coercion regression. All passed.
Workspace typecheck, lint and builds, scoped formatting, whitespace and local
link-target checks passed. Independent final review found no remaining actionable
finding after the enum fix.

The full server run reported 3,205 tests: 3,148 passed, 20 failed and 37 skipped,
with no cancellations. Its 20 failed names exactly match the recorded
[PR integration baseline](validation/pr-integration-validation.json). The global
server suite is not passing. These offline results establish the bounded
preparation behavior; they do not establish live application readiness.
