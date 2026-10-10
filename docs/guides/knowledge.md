# Knowledge: rules, evidence and change workflows

[Documentation](../README.md) · [Feature guides](../guides/README.md)

Inspect accepted claims and follow how rules become verified implementation intent.

## Before you start

Knowledge records for a project. An empty Knowledge page is expected until a knowledge-producing workflow has been authored, run and approved.

## Try it

1. Open **More → Knowledge**, select the project/repository scope, and open a module or source-file group.
2. Open a claim to inspect its exact revision, evidence, justifications and implementation checks.
3. Treat support and implementation conformance as separate dimensions: a well-supported rule can still be violated by code.
4. To populate the ledger, author a knowledge workflow using the linked harness protocols below. The Knowledge page itself is read-only.
5. Review a knowledge gate before approving canonical changes; a model assessment is not knowledge evidence by itself.

**Expected result:** You can explain why a claim is believed, which revision was used, and which repository state was checked.

## On this page

- [Knowledge](#knowledge)

## Knowledge

A read-only view of the [Knowledge Ledger](../KNOWLEDGE-LEDGER.md): the business
rules, facts and other claims Argus has accepted, the evidence behind each one,
and who relied on it. Reach it from **More → Knowledge**, `g k`, or the palette.

- **The overview** is one sentence about the whole ledger (how many claims,
  whether all are supported, how many rules anyone has verified), a bar
  showing the mix of kinds, and one card per module. **Group by** switches the
  cards to source files. Pick a scope to see one project's knowledge.
- **A card, a kind or a search** opens the matching claims, grouped by kind.
  **Only what needs a look** narrows to flagged claims.
- **A claim** opens a drawer: what it says, why Argus believes it (its
  evidence and justifications), whether anyone checked the code obeys it, and
  which runs used it or were given it.
- **Normal says nothing.** An active, supported claim carries no badge. A
  badge appears only for _contested_, _violated_, _stale_, _superseded_ or
  _unsupported_. Every underlined word and every **?** explains itself, and
  **How to read this page** lists every mark and term.

Data: `GET /api/knowledge/atlas` (optionally `?project=&repository=`).

## How knowledge workflows fit together

Execution provenance says which run produced an output. The Knowledge Ledger
says _why it is believed_: an append-only graph of claims (facts, assumptions,
business rules, constraints, conclusions, decisions), the evidence that grounds
them and the justifications that derive one from others. A claim changes by
revision — the old revision stays addressable and nothing that referenced it is
retargeted — and support (`supported | unsupported | contested`) is derived by
one deterministic function, never stored. It also records which run
**consumed** which exact revision and which artifacts that run produced, so
when a business rule is superseded Argus can compute — deterministically, with
an explanation path — which conclusions lost support, which runs built on
them, and which files now need semantic reevaluation, without ever rewriting a
run's own status.

A second, orthogonal dimension answers whether the _code_ does what the rules
say. A verification phase is handed exact canonical rules, decides `holds`,
`violated` or `unverifiable` for each, and Argus records the answer against
that exact rule revision **and** that exact commit — so "held at `abc123`"
never gets reported as "holds now", and a new rule revision starts
`unverified` rather than inheriting anything. The two are kept rigorously
apart: a rule whose implementation is in breach stays exactly as supported as
it was, because a bug is not a doubt about the domain.

A third dimension starts from the other end: someone wants the business to work
differently. A change-intent phase is given the requested change verbatim, the
rules it affects and what the implementation currently does about them, and
answers with a reviewable **change proposal** — which exact rule revisions it
would create, which existing ones it deliberately preserves, the decisions that
follow, the observable acceptance criteria that would demonstrate success, and
anything the request leaves genuinely unresolved (rather than a value the model
chose). Nothing becomes canonical until a person approves the gate, and the
accepted proposal is kept forever, so "what requested change caused this rule
revision, and how was it meant to be judged?" stays answerable. A request is
not a rule, and a rule is not its implementation: the code already disagreeing
with a rule is reported as a defect, never treated as what the business wants.

The fourth dimension closes the loop. An accepted change proposal becomes a
**change realization**: Argus derives, from provenance it already holds, where
the change lives in the repository; runs an implementation agent against the
canonical semantics, the accepted transition and that scope; and then answers
one question deterministically — _was this change carried out?_ An agent
reporting success is not an answer. A green test suite is not an answer. Every
business rule holding is not an answer while an acceptance criterion is
violated, and every criterion being satisfied is not an answer while a revised
rule is violated. All four have to hold, at one repository state Argus can
prove the verification actually examined — `gitHead` plus the content hash of
any uncommitted work, so two dirty trees at one commit are two different
implementations. Where the change is unmet, a _targeted_ remediation is told
the exact failing rules and criteria and only the implementation and its
verification re-run, under a bound the pipeline author wrote; where the domain
moved on while the work ran, the realization is `stale` rather than complete.
Both the failed attempt and the successful one are kept, so the history
explains how the implementation converged.

Inspect it all at `/api/knowledge`; the design and its worked example are in
**[docs/KNOWLEDGE-LEDGER.md](../KNOWLEDGE-LEDGER.md)**.

## Authoring knowledge workflows

Knowledge workflows use the pipeline API protocols rather than a button that creates claims in the read-only Knowledge view. Use these recipes in order:

| Goal                                       | Protocol and worked examples                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Discover business rules from a repository  | [Business-rule discovery](../HARNESS.md#14-business-rule-discovery-phases)                                    |
| Verify code against exact rule revisions   | [Business-rule verification](../HARNESS.md#15-business-rule-verification-phases)                              |
| Propose a business change for human review | [Change intent](../HARNESS.md#16-change-intent-phases)                                                        |
| Implement and remediate an accepted change | [Targeted realization](../KNOWLEDGE-LEDGER.md#17-targeted-implementation-and-closed-loop-realization-phase-8) |

Each recipe defines its inputs, output schema, gate and refusal conditions. Do not substitute a generic successful step for an accepted knowledge transition. See [API operations](../API.md#knowledge-ledger) and [ledger invariants](../KNOWLEDGE-LEDGER.md#19-important-invariants).
