# The Knowledge Ledger — semantic provenance for Argus

_Phase 1: the semantic kernel and its persistence model. Phase 2: the
execution provenance bridge and deterministic impact analysis. Phase 3: the
KnowledgeDelta protocol — how agent executions propose knowledge and how Argus
alone validates and commits it. Phase 4: the KnowledgeContext protocol —
how Argus supplies exact canonical knowledge to an execution and records what
it supplied, independently of what the agent later declares it consumed.
Phase 5: business-rule discovery orchestration — how a bounded repository
investigation becomes candidate knowledge, how a person reviews it, and how
the rules it establishes reach the phases that follow._

## 1. Why it exists

Argus has strong **execution provenance**. For any output it can say which
pipeline definition, instance, phase, step and run produced it, at which git
head, with which invocation record, journal and verification report. It can
answer:

> Which phase/run produced this output?

It has almost no **semantic provenance**. It cannot answer:

> Why do we believe this conclusion?
> Which facts, rules and assumptions support it?
> Which evidence supports those premises?
> What would lose support if one premise were superseded?

The Knowledge Ledger is the subsystem that answers those questions. It borrows
the useful core of a truth maintenance system — explicit claims, explicit
justifications between them, stable identity, revision, and a deterministic
answer to "does this still have support?" — without the rest of Doyle's 1979
machinery. There is no ATMS, no assumption environments, no non-monotonic
logic, no rules engine and no graph database. There is a small append-only
graph, a pure evaluation function, and an HTTP surface to inspect it.

## 2. Knowledge Ledger vs pipeline DAG

Argus now has two graphs. They answer different questions and share nothing.

```
   Execution DAG (Weave)                 Knowledge / justification graph
   "what executes after what?"           "what depends logically on what?"

   investigate                           FACT-12:v1     RULE-7:v1
       ↓                                      \           /
     plan                                      ↓         ↓
       ↓                                      CONCLUSION-19:v1
   implement                                        ↓
                                              DECISION-21:v1

   PhaseDef.needs, readyPhases,           Justification.premises,
   settle(), PhaseProgress.status         evaluateSupport(), dependentsOf()
   server/src/sources/dag.ts              server/src/knowledge/kernel.ts
   server/src/pipelineTransitions.ts
```

Nothing in `knowledge/` imports the DAG, and nothing in the DAG imports the
ledger. `PhaseDef.needs` is never overloaded to carry a semantic edge. The
links between the two worlds are **references**: a claim, evidence record or
justification may carry an `ExecutionRef` (`instanceId`, `phaseId`, `runId`),
an `EvidenceSource` may name a run, phase, artifact or verification, and — as
of Phase 2 — a consumption or artifact record names a run (§8). Those are
pointers into execution history, not edges in the execution graph.

The invariant this protects: **successful execution is not semantic
validity.** A phase may have `status: "succeeded"` while every conclusion it
produced has lost support because a business rule was revised. Phase 1 does
not add a semantic state to `PhaseProgress`; it makes sure nothing here would
make that future separation hard. The separation is already there — a
justification's `producedBy` says which phase derived a conclusion, and the
phase record is never touched when the conclusion's support changes.

## 3. Claim identity and revision semantics

A **claim** is an addressable semantic assertion:

```ts
interface Claim {
  id: string; // logical identity: RULE-17
  revision: number; // 1..n, no gaps
  kind: "fact" | "assumption" | "business-rule" | "constraint" | "conclusion" | "decision";
  statement: string;
  structuredValue?: unknown; // opaque in Phase 1; see §10
  producedBy?: { instanceId?; phaseId?; runId? };
  revisionNote?: string; // why this revision replaced the previous one
  createdAt: string;
}
```

Two identities, and the invariant that keeps them unambiguous:

| Name              | Form                              | Means                                    |
| ----------------- | --------------------------------- | ---------------------------------------- |
| logical identity  | `RULE-17`                         | the claim, across its whole history      |
| revision identity | `RULE-17:v2` / `{ id, revision }` | one exact statement at one point in time |

**Every edge in the graph names a revision identity.** Evidence points at a
revision. A justification's premises and conclusion are revisions. There is no
edge from a bare id, so there is nothing that could silently start meaning
something else when a claim is revised.

A bare id is accepted in two places only, and resolved immediately to the
active revision: in URLs (`GET /api/knowledge/claims/RULE-17` means "the
active revision of RULE-17, with its history") and in proposal bodies (a
premise written as `"RULE-7"` is stored as `{ id: "RULE-7", revision: <active
at write time> }`). What is persisted is always the exact revision.

**Lifecycle** (`active | superseded`) is derived, not stored: a revision is
superseded exactly when a higher revision of its id exists. Revisions of one id
are numbered contiguously from 1, and `reviseClaim` is the only way to get a
revision above 1. Kind is part of the logical identity and cannot change on
revision.

Ids may be proposed by the caller (so a human-meaningful `RULE-17` is
possible) or minted by Argus from the kind (`RULE-3f9a1c2b`,
`FACT-…`, `CONCLUSION-…`). Either way Argus validates the alphabet and
enforces uniqueness. Evidence (`EV-…`) and justification (`J-…`) ids are always
minted.

## 4. Evidence

Evidence is a **stable-identity record of provenance** bearing on one claim
revision, in one direction:

```ts
interface Evidence {
  id: string;
  claim: ClaimRef;
  direction: "supports" | "opposes";
  source: EvidenceSource;
  note?: string;
  createdAt: string;
}

type EvidenceSource =
  | { type: "run"; runId }
  | { type: "phase"; instanceId; phaseId }
  | { type: "artifact"; instanceId; phaseId; path }
  | { type: "verification"; instanceId; phaseId }
  | { type: "source-code"; path; repository?; gitHead?; symbol?; startLine?; endLine?; line? }
  | { type: "git-commit"; sha; repository? }
  | { type: "document"; uri; title? }
  | { type: "human"; who };
```

A claim never _contains_ prose about where it came from. It is pointed at by
evidence, which has its own id, can be listed and counted, and — in a later
phase — re-checked against the execution record it names. The source union is
small and closed on purpose: each variant is validated field by field, and
adding one is a one-line addition to the type and one case in the validator.
No external integration is implemented; `document` and `human` are the escape
hatches until one is.

`source-code` is the variant business-rule discovery produces, and the only
one with structural rules beyond well-formedness: the path is
repository-relative (no `..`, no leading `/`, no drive letter), a line range
is ordered, and `gitHead` is a commit sha. It records **where the code is,
never a copy of it** — a rule grounded in a 400-line function is as small in
`knowledge.json` as one grounded in a constant — and its identity is
historical: `src/Kobra.cs@abc123:120-136` means that file at that commit,
forever. See §14.4.

Evidence is what grounds a claim that has no premises — a fact observed by a
run, a rule read from a specification, an assumption a human is willing to
sign. Without evidence or an in-force justification, a claim is `unsupported`.

## 5. Justifications

A justification records a **semantic derivation**:

```ts
interface Justification {
  id: string;
  conclusion: ClaimRef;
  premises: ClaimRef[]; // conjunctive: all must hold
  direction: "supports" | "opposes";
  producedBy?: ExecutionRef;
  note?: string;
  createdAt: string;
}
```

"These premise revisions, taken together, support (or oppose) this conclusion
revision." Premises are conjunctive. Two independent derivations of the same
conclusion are two justifications — which is what lets a conclusion survive
losing one of them (§6).

The direction is on the justification rather than on each premise. A
per-premise `opposes` has murky semantics (does the derivation need the
opposing premise to be _unsupported_?); a justification-level direction has
one: an opposing justification, when in force, is a negative signal on its
conclusion.

Traversal in both directions is a function of the ledger:

- `premisesOf(ref)` — the justifications concluding `ref` (why is it
  supported?).
- `dependentsOf(ref)` — conclusions of justifications naming `ref` as a
  premise (what directly depends on it?). Opposing justifications count: a
  conclusion whose refutation rests on X depends on X.
- `transitiveDependentsOf(ref)` — breadth-first over `dependentsOf`, each
  revision once, in ledger order (deterministic), the start excluded.

**Cycles are rejected.** `addJustification` refuses a self-justification, a
premise equal to the conclusion, and any justification whose conclusion already
(transitively) reaches one of its premises — in either direction. The graph is
a DAG over _revision_ nodes, so `R:v2` may be justified by `R:v1` (they are
different nodes). Rejecting cycles was chosen over permitting them because
support evaluation recurses over premises and "a claim supported by itself" has
no small, understandable meaning. Evaluation and traversal are nevertheless
cycle-safe — a hand-edited file degrades to `unsupported`, never to a hang.

## 6. Deterministic support semantics

`evaluateSupport(ledger, ref): "supported" | "unsupported" | "contested"` is
the **only** definition of support. It is a pure, total, deterministic function
of the ledger. No LLM is consulted and no record stores the answer.

A justification is **in force** iff every premise:

1. exists in the ledger,
2. is the **active** revision of its id (a superseded premise never transmits
   support), and
3. is itself `supported` (an `unsupported` or `contested` premise does not
   transmit support).

For a revision R:

- **positive** = some supporting evidence on R, or some supporting
  justification concluding R is in force;
- **negative** = some opposing evidence on R, or some opposing justification
  concluding R is in force;

| positive | negative | result        |
| -------- | -------- | ------------- |
| yes      | no       | `supported`   |
| yes      | yes      | `contested`   |
| no       | any      | `unsupported` |

Consequences worth naming:

- **Multiple justifications.** `A+B → C` and `D+E → C`: revising `A` takes the
  first justification out of force; C stays `supported` on the second. Revising
  `D` too leaves C `unsupported`.
- **Opposition alone is not contestation.** A claim with only opposing
  evidence is `unsupported`; the support report says why.
- **Lifecycle is not an input.** A superseded revision is evaluated on its own
  evidence and justifications exactly as it stood, so a historical premise can
  still be inspected as it was. Lifecycle and support are separate axes.
- **Chains.** Support flows: grounded root → derived → derived, as long as
  every link is active and supported.

`supportReport(ref)` returns the same verdict plus every signal: each evidence
record, and each justification with its force (`{ inForce: true }` or
`{ inForce: false, failing: [{ premise, reason }] }`, reason ∈
`superseded | unsupported | contested | missing`).

## 7. Supersession — the worked example

```
FACT-12:v1   "Kobra exposes a free-text comment field"      ← human evidence
RULE-7:v1    "Kobra comment maximum is 180"                 ← human evidence
      \          /
       ↓        ↓
CONCLUSION-19:v1  "Validate comments at 180 chars"           J-1, producedBy inst-1/plan/run-9
       ↓
DECISION-21:v1    "Ship the 180-char validator"              J-2
```

Every claim is `supported`. `GET /claims/RULE-7/dependents` answers
`direct: [CONCLUSION-19:v1]`, `transitive: [CONCLUSION-19:v1, DECISION-21:v1]`
— this is "what would lose support if the rule changed?".

The rule changes: `POST /claims/RULE-7/revise { statement: "Kobra comment
maximum is 500", revisionNote: "Kobra 4.2 raised the limit" }`.

What the ledger now holds:

| Record             | Before                                       | After                                                       |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------- |
| `RULE-7:v1`        | active, supported                            | **superseded** (by v2), still supported on its evidence     |
| `RULE-7:v2`        | —                                            | active, unsupported (no evidence attached yet)              |
| `J-1`              | premises `[FACT-12:v1, RULE-7:v1]`, in force | **same premises**, out of force: `RULE-7:v1 superseded`     |
| `CONCLUSION-19:v1` | supported                                    | unsupported                                                 |
| `DECISION-21:v1`   | supported                                    | unsupported (its only justification's premise lost support) |
| `inst-1` / `plan`  | `status: succeeded`                          | `status: succeeded` — untouched                             |

Nothing was rewritten. `RULE-7:v1` is still there with its 180. `J-1` still
says it was derived from `RULE-7:v1` — and the report says precisely why it is
out of force. The phase that produced the conclusion still says it succeeded,
because it did. Phase 2 turns "unsupported because a premise was superseded"
into an impact set (§10, §11); Phase 1 made the state computable and
inspectable.

Re-deriving from the new rule is a **new** justification (`J-3`, premises
`[FACT-12:v1, RULE-7:v2]`), after evidence is attached to v2. The old one is
untouched; `CONCLUSION-19:v1` is `supported` again, with two justifications in
its report — one out of force, one in force.

## 8. Execution provenance bridge

Phase 1 could say which execution **produced** a piece of knowledge. It could
not say which later execution **relied on** it. Those are different facts:

```
RULE-17:v1
    ↓ premise-of (J-1)
CONCLUSION-8:v1
    ↓ premise-of (J-2)
DECISION-3:v1                 producedBy: run_123   (the plan phase derived it)
    ↓ consumed-by
run_456                        (the implement phase built on it)
    ↓ produced
src/CustomerCommentValidator.cs
```

If `RULE-17:v1` is superseded, `run_123` is useful provenance — it explains
where the decision came from. `run_456` is the execution whose output may need
reevaluation, because it took the decision as a premise for what it built.
Phase 2 makes that second relationship explicit, with three bridges between the
semantic graph and execution history, none of which touch the execution DAG:

| Bridge                                         | Record                                                              | Since   |
| ---------------------------------------------- | ------------------------------------------------------------------- | ------- |
| Execution → ClaimRevision it **produced**      | `Claim.producedBy`, `Justification.producedBy` (matched on `runId`) | Phase 1 |
| ClaimRevision → Execution that **consumed** it | `ClaimConsumption { claim, execution, createdAt }`                  | Phase 2 |
| Execution → Artifact it **produced**           | `ArtifactProduction { execution, artifact, createdAt }`             | Phase 2 |

```ts
/** An ExecutionRef that definitely names a run. */
interface RunExecutionRef extends ExecutionRef {
  runId: string; // the unit of execution: one step attempt, one invocation
}
interface ClaimConsumption {
  claim: ClaimRef; // exact revision, never a bare id
  execution: RunExecutionRef;
  createdAt: string;
}
interface ArtifactRef {
  location: "artifact-dir" | "repository"; // the phase's artifact dir, or the run's working tree
  path: string; // relative, POSIX, no `..`
  gitHead?: string; // repository only
}
interface ArtifactProduction {
  execution: RunExecutionRef;
  artifact: ArtifactRef;
  createdAt: string;
}
```

**Why `producedBy` is reused rather than mirrored.** Phase 1 already records
production on the record that was produced, and every read that needs the
other direction — "what did run X derive?" — is a filter over `claims` and
`justifications` by `producedBy.runId`. A second production edge would store
the same fact twice with nothing to keep the copies agreeing. The one thing
Phase 2 adds on the production side is `executionProvenance(runId)`, which
joins both directions for a run (§9).

**Why the execution identity is the run.** Argus's unit of execution is the
run: one step attempt, one invocation record, one process. A phase has several
runs (steps, retries, candidates), and a revised phase's second attempt may
consume different claims than its first. `runId` is the one identifier that
can say "this exact execution consumed that exact revision"; `instanceId` and
`phaseId` stay optional locators, exactly as on `producedBy`. No new identity
system is introduced.

**Invariants on the edges:**

1. **Exact revision.** A consumption names `(id, revision)`. A bare id in a
   proposal body resolves to the active revision at write time and is stored
   resolved, as every Phase 1 edge is.
2. **Immutable, never retargeted.** `RULE-17:v1 → RULE-17:v2` leaves every
   consumer of v1 pointing at v1. That is not a limitation; it is what makes
   impact analysis able to find them.
3. **Deterministic duplicates.** Identity is `(runId, claim)` for a
   consumption and `(runId, location, path)` for an artifact. Recording an
   identical edge again is a no-op: the same ledger back, the original record
   (with its original `createdAt`) returned, `added: false`. Over HTTP that is
   a `200` where a first registration is a `201`.
4. **One run, one place.** A run belongs to one instance and one phase.
   Locators that contradict an earlier record for the same run are refused;
   locators omitted are filled in from it, so every edge of a run reads the
   same.
5. **Validated where it can be.** Claim revisions must exist. Run ids,
   instance ids and phase ids must have the shape of an Argus identifier.
   Artifact paths must be relative POSIX paths that stay inside their root
   (the containment rule the artifact viewer applies), and `gitHead` must be a
   hex sha on a `repository` path. Run **existence** is deliberately not
   checked: run files are a pruned, rebuildable record (`runs/` → the Vault),
   so a reference to a run whose JSON has aged out is a legitimate historical
   reference, not an error.
6. **Provenance, not ordering.** Consumption says what a run reasoned from,
   not what it ran after. Nothing here consults `PhaseDef.needs`, routing or
   `PhaseProgress`, and nothing in them consults this.

Consumption is registered through one explicit, admin-gated operation per
direction — `POST /api/knowledge/executions/:runId/consumptions` and
`POST /api/knowledge/executions/:runId/artifacts` — by an operator, a test,
or (Phase 3) a typed agent protocol. It is **never inferred** from prompt
text, transcripts, artifact contents, embeddings or an LLM's reading of any of
those. Phase 2 needs the trusted primitive before anything can be trusted to
fill it.

## 9. Semantic currency

Two questions that look alike and are not:

| Question                                                   | Answered by                           | Can change later? |
| ---------------------------------------------------------- | ------------------------------------- | ----------------- |
| Did this run complete successfully at the time?            | `Run.status`, `PhaseProgress.status`  | **No.** History.  |
| Are the premises it relied on still current and supported? | `executionProvenance(runId).currency` | **Yes.** Derived. |

`execution.status = succeeded` and `currency = stale` coexist, and must: the
run did succeed, and the world moved. Argus never rewrites a historical
execution status because its semantic premises later changed, and it stores
no mutable "stale" flag anywhere — currency is computed on every read from
the ledger:

```ts
interface ExecutionProvenance {
  execution: RunExecutionRef;
  consumed: Array<{ claim; lifecycle; support; current: boolean }>; // current = active && supported
  produced: { claims: ClaimView[]; justifications: Justification[]; artifacts: ArtifactRef[] };
  currency: "current" | "stale"; // stale = some consumed revision is not current
}
```

A run that consumed nothing has nothing that can go stale; its `currency` is
`current` and its `consumed` is empty — the two together say "no recorded
semantic premises", and the report is `404` when the ledger knows nothing at
all about the run.

## 10. Impact analysis

`analyzeImpact(ledger, root: ClaimRef): ImpactSet` is a pure function in
`server/src/knowledge/impact.ts`: no clock, no I/O, no writes, no LLM, no
pipeline action. It answers two questions at once — **what** is affected and
**why** — and it does so by a rule stricter than reachability.

### 10.1 Impact is changed support, not reachability

`transitiveDependentsOf(RULE-17:v1)` says what _could_ be affected. It
over-reports whenever a conclusion has more than one derivation:

```
A + B → C
D + E → C
```

If `A` is superseded but `D + E → C` still holds, `C` is reachable from `A` and
unharmed. Phase 1's support semantics (§6) already know this; Phase 2 does not
re-derive them. Instead the evaluator is run **twice over the same ledger**:

- **actual** — the ledger as it stands;
- **ifRootHeld** — the same ledger with the root _held_: treated as the active,
  supported revision no matter what the ledger says (`Evaluation.assume`).

Whatever differs between the two evaluations is the impact of the root's
condition, and nothing else is:

| Node          | Affected iff                                                        |
| ------------- | ------------------------------------------------------------------- |
| justification | its force differs (`inForce.ifRootHeld ≠ inForce.actual`)           |
| claim         | its derived support differs (`support.ifRootHeld ≠ support.actual`) |
| execution     | it consumed the root or an affected claim                           |
| artifact      | an affected execution produced it                                   |

So: `C` above has `supported` in both evaluations → not affected → nothing
downstream of `C` is poisoned. `A + B → C` (the justification) did lose force
→ it _is_ in `affectedJustifications`, because it did change. An execution that
consumed `A:v1` directly is affected; one that consumed `C` is not.

The question this answers, precisely, is: **which claims, executions and
artifacts rest on this revision being the current, supported one, given
everything else in the ledger as it is?** For a superseded root that is "what
changed when it was superseded". For a root that was never supported it is
"what depends on it being supported" — the same computation, honestly named.

### 10.2 Supersession is not unsupportedness

Phase 1 keeps lifecycle and support on separate axes (§6), and impact analysis
keeps them separate the whole way through:

- `root.conditions` says what is wrong with the root: `superseded`,
  `unsupported`, `contested` — any combination, or none (in which case nothing
  is impacted, because holding the root changes nothing).
- Every affected claim carries `support: { ifRootHeld, actual }` and a
  `reasons` list from a **closed taxonomy**:

```ts
type ImpactReason =
  | "premise-superseded" // a justification concluding it lost force on a superseded affected premise
  | "premise-unsupported" // … on an unsupported affected premise
  | "premise-contested" // … on a contested affected premise
  | "support-changed" // its support differs, but no derivation of it fails on an affected premise (one gained force)
  | "consumed-affected-claim" // execution: consumed the root or an affected claim
  | "produced-by-affected-execution"; // artifact: produced by such an execution
```

`RULE-17:v1` after supersession is `lifecycle: superseded, support: supported`
— a true description of what was believed. Its impact set says `conditions:
["superseded"]` and reasons `premise-superseded`, never `premise-unsupported`:
the evidence is intact; the rule is simply no longer the current one. A claim
that became `contested` yields `conditions: ["contested"]` and
`premise-contested` downstream. The taxonomy is what a consumer of the API
should switch on; any prose is secondary.

### 10.3 Explanation paths

The API does not return a flat list. Every affected node has one `ImpactPath`:
the hops from the root to it.

```ts
type ImpactNode =
  | { kind: "claim"; claim: ClaimRef }
  | { kind: "execution"; execution: RunExecutionRef }
  | { kind: "artifact"; execution: RunExecutionRef; artifact: ArtifactRef };
interface ImpactHop {
  via: "premise-of" | "consumed-by" | "produced";
  justification?: string; // on premise-of
  to: ImpactNode;
}
interface ImpactPath {
  target: ImpactNode;
  hops: ImpactHop[];
}
```

Paths are built breadth-first from the root **over affected edges only** (an
affected justification from an affected premise to an affected conclusion), so
a diamond whose left side is unharmed explains the far node through the right
side. Each node gets the shortest path; ties go to ledger order. An execution
is explained through the consumed claim with the shortest path; an artifact
through its execution. The same ledger therefore always produces the same
`ImpactSet`, byte for byte — the persistence test reloads the file and checks
exactly that.

### 10.4 Producers are not consumers

`executions` lists **consumers only**. The run that derived an affected claim
is visible on that claim's `producedBy` inside `affectedClaims` — it is
provenance for the reader, not an execution whose output is in question. The
"producer is not consumer" test pins this: `RUN-A produced DECISION-B`,
`RUN-B consumed DECISION-B`, a change to the decision's premise lists `RUN-B`
and only `RUN-B`.

### 10.5 What the algorithm guarantees

Deterministic, cycle-safe (the evaluator and the traversal both keep visited
sets; a hand-edited cyclic ledger degrades, never hangs), deduplicated (each
claim, run and artifact appears once), stably ordered (breadth-first, ties by
ledger order; claims, then executions, then artifacts), explained (one path
per node), and side-effect free (the input ledger is not touched; nothing is
persisted; no phase is re-run, invalidated or marked).

## 11. The worked example, continued

```
RULE-17:v1        "Kobra customer comment max = 180"        ← document evidence
    ↓ J-1
CONCLUSION-8:v1   "Validate customer comments at 180 characters"    producedBy run_123 (inst-1 / plan)
    ↓ J-2
DECISION-3:v1     "Implement a 180-character validator"            producedBy run_123 (inst-1 / plan)
    ↓ consumed-by
run_456           (inst-1 / implement)   also consumed CONCLUSION-8:v1
    ↓ produced
src/CustomerCommentValidator.cs @ 9f3c2a1
```

Registered as:

```jsonc
// POST /api/knowledge/executions/run_456/consumptions
{ "instanceId": "inst-1", "phaseId": "implement", "claims": ["DECISION-3", "CONCLUSION-8:v1"] }
// POST /api/knowledge/executions/run_456/artifacts
{ "artifacts": [{ "location": "repository", "path": "src/CustomerCommentValidator.cs", "gitHead": "9f3c2a1" }] }
```

While `RULE-17:v1` is active, `GET /claims/RULE-17/impact` reports
`conditions: []` and nothing else. Then:

```jsonc
// POST /claims/RULE-17/revise
{ "statement": "Kobra customer comment max = 500", "revisionNote": "Kobra 4.2 raised the limit" }
```

`GET /api/knowledge/claims/RULE-17:v1/impact` now returns (paths abridged to
their hops):

```jsonc
{
  "root": {
    "claim": { "id": "RULE-17", "revision": 1 },
    "lifecycle": "superseded",
    "support": "supported",
    "conditions": ["superseded"],
  },
  "semantic": {
    "affectedClaims": [
      {
        "claim": { "id": "CONCLUSION-8", "revision": 1 },
        "reasons": ["premise-superseded"],
        "support": { "ifRootHeld": "supported", "actual": "unsupported" },
        "producedBy": { "instanceId": "inst-1", "phaseId": "plan", "runId": "run_123" },
      },
      {
        "claim": { "id": "DECISION-3", "revision": 1 },
        "reasons": ["premise-unsupported"],
        "support": { "ifRootHeld": "supported", "actual": "unsupported" },
        "producedBy": { "instanceId": "inst-1", "phaseId": "plan", "runId": "run_123" },
      },
    ],
    "affectedJustifications": [
      {
        "id": "J-1",
        "conclusion": { "id": "CONCLUSION-8", "revision": 1 },
        "inForce": { "ifRootHeld": true, "actual": false },
      },
      {
        "id": "J-2",
        "conclusion": { "id": "DECISION-3", "revision": 1 },
        "inForce": { "ifRootHeld": true, "actual": false },
      },
    ],
  },
  "executions": [
    {
      "execution": { "runId": "run_456", "instanceId": "inst-1", "phaseId": "implement" },
      "reasons": ["consumed-affected-claim"],
      "consumed": [
        { "id": "DECISION-3", "revision": 1 },
        { "id": "CONCLUSION-8", "revision": 1 },
      ],
    },
  ],
  "artifacts": [
    {
      "execution": { "runId": "run_456", "instanceId": "inst-1", "phaseId": "implement" },
      "artifact": {
        "location": "repository",
        "path": "src/CustomerCommentValidator.cs",
        "gitHead": "9f3c2a1",
      },
      "reasons": ["produced-by-affected-execution"],
    },
  ],
  "paths": [
    // CONCLUSION-8:v1   ← RULE-17:v1 -- premise-of(J-1) --> CONCLUSION-8:v1
    // DECISION-3:v1     ← … -- premise-of(J-2) --> DECISION-3:v1
    // run_456           ← RULE-17:v1 -- premise-of(J-1) --> CONCLUSION-8:v1 -- consumed-by --> run_456
    // the .cs file      ← … -- consumed-by --> run_456 -- produced --> src/CustomerCommentValidator.cs
  ],
}
```

Read it as: `CONCLUSION-8:v1` lost its only derivation because its premise was
superseded; `DECISION-3:v1` lost its only derivation because its premise is
now unsupported; `run_456` consumed both; the validator it wrote was produced
under those premises. `run_123`, which derived the conclusion and the
decision, is named as provenance on each and is **not** an impacted execution.

`GET /api/knowledge/executions/run_456/provenance` says
`currency: "stale"`, with each consumed revision `active` but `unsupported`
and `current: false`; `run_123`'s says `current`. Neither run's own status
record changed, and neither will.

What this does **not** say is that `CustomerCommentValidator.cs` is wrong.
The limit may have been raised in a way the implementation already tolerates;
the file may have been rewritten since. It says the artifact **requires
semantic reevaluation because it was produced under a premise that is no
longer current** — and it says exactly which premise, through which
derivations, consumed by which run. Whether to re-run the implement phase,
open an issue, or attach new evidence and a new justification from
`RULE-17:v2` is a later phase's decision, and a human's.

## 12. KnowledgeDelta protocol (Phase 3)

Phases 1 and 2 built the ledger and the bridges into execution history, and
left the `POST` endpoints as the vocabulary an agent _would_ use. Phase 3 is
the point where the ledger starts participating in real agent workflows — and
the point where the Phase 1 principle has to hold under pressure:

> **LLMs propose; Argus validates and applies.**

```
Agent
  ↓  writes one JSON document to $ARGUS_KNOWLEDGE_DELTA_FILE
KnowledgeDelta proposal
  ↓  read by Argus when the run completes (Stop hook signal, or reconcile fallback)
Argus validation                       shape · local ids · exact references · preflight against the ledger
  ↓
staged delta                           argus/knowledge-deltas/<runId>/staged.json — NOT canonical
  ↓
deterministic successful phase boundary    steps succeeded · result validated · checks passed · gate approved
  ↓
atomic ledger transition               every eligible delta of the attempt, or none
  ↓
canonical Knowledge Ledger             argus/knowledge.json (version 3)
```

An agent process never writes `knowledge.json`, never assigns a canonical claim
id or a revision number, never modifies an existing record, never retargets a
historical reference, and can never partially commit anything. It produces a
proposal document. Argus owns canonical ids, revision assignment, referential
integrity, cycle validation, stale-write detection, provenance binding, atomic
application and persistence.

### 12.1 The wire contract

One versioned document per run (`contracts/src/knowledge.ts`):

```ts
interface KnowledgeDelta {
  schemaVersion: 1;
  claims?: Array<{ localId; kind; statement; structuredValue? }>; // new claims — Argus mints the id
  revisions?: Array<{
    claimId; // an existing claim
    expectedRevision; // optimistic-concurrency precondition
    statement;
    structuredValue?;
    revisionNote?;
    localId?; // so the same delta can build on the new revision
  }>;
  evidence?: Array<{ claim: DeltaClaimRef; direction?; source: EvidenceSource; note? }>;
  justifications?: Array<{
    conclusion: DeltaClaimRef;
    premises: DeltaClaimRef[];
    direction?;
    note?;
  }>;
  consumed?: ClaimRef[]; // exact revisions the execution declares it relied on
  artifacts?: ArtifactRef[]; // what the execution produced
  metadata?: { summary?: string };
}
type DeltaClaimRef = { local: string } | { id: string; revision: number }; // or "ID:vN"
```

Every section is optional. A missing file, or a delta whose every section is
empty, means the run proposed no durable knowledge — and the pipeline behaves
byte for byte as it did before the protocol existed. Sections are bounded at 64
entries; the file at 1 MiB.

Three things are conspicuously **not** fields: a canonical `id` on a new claim,
a `revision` number, and `producedBy`. A document that carries any of them is
refused with a message saying why (`canonical ids are assigned by Argus; use
localId`). Provenance is bound by Argus from the run that wrote the file.

A realistic delta, as an agent in a `plan` phase would write it:

```jsonc
{
  "schemaVersion": 1,
  "claims": [
    {
      "localId": "comment-limit",
      "kind": "conclusion",
      "statement": "Customer comments must be limited to 500 characters",
    },
    {
      "localId": "ship-validator",
      "kind": "decision",
      "statement": "Implement a 500-character validator on CustomerComment",
    },
  ],
  "revisions": [
    {
      "claimId": "RULE-17",
      "expectedRevision": 2,
      "statement": "Kobra customer comment max = 500",
      "revisionNote": "Kobra 4.2 raised the limit",
      "localId": "rule-v3",
    },
  ],
  "evidence": [
    {
      "claim": { "local": "rule-v3" },
      "source": { "type": "document", "uri": "https://kobra.example/release-notes/4.2" },
    },
  ],
  "justifications": [
    {
      "conclusion": { "local": "comment-limit" },
      "premises": [{ "local": "rule-v3" }, "FACT-12:v1"],
    },
    { "conclusion": { "local": "ship-validator" }, "premises": [{ "local": "comment-limit" }] },
  ],
  "consumed": ["FACT-12:v1", "RULE-17:v2"],
  "metadata": { "summary": "re-derived the comment validation decision from Kobra 4.2" },
}
```

### 12.2 Local references

Argus assigns canonical ids, but an agent still has to say "create conclusion
X, then justify X from RULE-17:v2" in one document. A **delta-local id** does
that:

- `localId` is declared on a new claim (required) or a revision (optional).
- It is referenced as `{ "local": "<id>" }` from evidence, a justification's
  conclusion or its premises. Never from `consumed` — a run cannot have relied
  on a claim it is proposing.
- Local ids share the claim-id alphabet but live in a different syntactic
  position from canonical references (`{ local }` vs `{ id, revision }`), so
  the two cannot be confused.
- A local id declared twice, or a `{ local }` that names no declaration,
  refuses the **entire** delta before anything is staged.
- Argus maps every local id to the canonical revision it minted, and the
  apply result exposes the mapping: `createdClaims: [{ localId, claim }]`,
  `createdRevisions: [{ localId?, claim, supersedes }]`.
- Local ids are never persisted as semantic identity. `knowledge.json` does
  not contain the string `localId`; the mapping lives on the staged record
  beside the run.

What the example above became, from its apply result:

| local id         | canonical                              |
| ---------------- | -------------------------------------- |
| `comment-limit`  | `CONCLUSION-7c1e02ab:v1`               |
| `ship-validator` | `DECISION-3b90f4d2:v1`                 |
| `rule-v3`        | `RULE-17:v3` (supersedes `RULE-17:v2`) |

### 12.3 Exact references only

Every reference to _existing_ knowledge in a delta must be an exact revision:
`"RULE-17:v2"` or `{ "id": "RULE-17", "revision": 2 }`. A bare `"RULE-17"` is
refused at validation. The HTTP proposal API (§3) still offers the convenience
of resolving a bare id at write time for an operator; the file protocol does
not, because an agent that writes `RULE-17` may have meant "whatever is
current", and a committed delta must never carry that ambiguity. Canonical
persisted provenance therefore never contains a "current revision" reference —
which is also what makes a stale precondition _detectable_ (§12.4).

A reference to a revision that does not exist in the ledger snapshot — including
a sibling delta's not-yet-minted creation in the same phase commit — is
`unknown-reference`.

### 12.4 Revision preconditions (optimistic concurrency)

An agent may not say "revise RULE-17". It says:

```jsonc
{ "claimId": "RULE-17", "expectedRevision": 2, "statement": "…" }
```

meaning _create the next revision only if v2 is still the active revision_.
The precondition is checked twice against a ledger snapshot: at intake (so a
proposal that is already stale fails the step at once) and at commit (inside
the ledger mutex, against the snapshot that is about to be written). If another
change made v3 in between:

```
expected: 2
actual:   3
→ stale-revision: revisions[0] expects RULE-17 at v2, but the active revision is v3
```

the **entire** delta is refused — the valid new claims in it too. Argus does
not create v4 on reasoning that was built on v2. The phase fails under
`knowledge-delta`, the reason names the revision that moved, and a retry (if
the author opted in) or a human revise gets a second attempt that can read v3.

Kind cannot change on revision (a `kind` field on a revision proposal is
refused), and one delta may not revise the same claim twice.

### 12.5 The per-run file: how the agent receives it and what it writes

Argus follows its result-file convention. Every step run is launched with:

| Env var                      | Value                                                 |
| ---------------------------- | ----------------------------------------------------- |
| `ARGUS_KNOWLEDGE_DELTA_FILE` | `~/.claude/argus/knowledge-deltas/<runId>/delta.json` |

The directory exists before the process starts. The file is one of the
**Argus-owned invocation channels** (HARNESS.md §3a) — the same model that
carries the result file and the artifact directory — so under a capability
profile the runtime is asked to make it reachable whatever `filesystem` says
about the working tree (Claude Code: `--add-dir`; Codex: a
`sandbox_workspace_write.writable_roots` entry under `workspace-write`), and
must answer whether it could. A read-only researcher may still propose what it
learned. It is a per-invocation identifier: never inherited from Argus's own
environment, never settable through `env.set`, recorded on the invocation
record as `knowledgeDeltaFile` and, with its access and availability, in the
record's `channels`.

**Offered versus required.** The channel is offered to every run and emitting
a delta is optional — an ordinary step writes no file and nothing about the
channel can fail its launch. A phase whose purpose _is_ to propose knowledge
can declare `knowledgeDelta: "required"` on its `PhaseDef`; the channel then
becomes a precondition of the launch, and a runtime that cannot make the path
writable (Codex under an effective `read-only` sandbox; Qwen Code inside its
container sandbox) refuses the step under strict enforcement with a
`configuration` failure — before any process starts — or, under
`enforcement: "best-effort"`, launches with the limitation recorded.
`"required"` says nothing about whether the agent must write a delta: it
guarantees only that a proposal _could_ arrive. When the channel is merely
offered and the runtime cannot reach it, the run still launches and the
invocation record says so (`channels[].status: "unavailable"`, plus the reason
in `limitations`): Argus never exposes the protocol silently to a process that
cannot use it. Without a capability profile Argus does not manage the
runtime's filesystem at all, exactly as before, and the record marks the
channel `unmanaged`.

| Runtime     | Can write the delta file under…                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| Claude Code | every `filesystem` mode (`--add-dir`), unless the working directory itself contains Argus's data directory |
| Codex       | `workspace-write` (declared or the `ARGUS_CODEX_SANDBOX` default) and `unrestricted`; **not** `read-only`  |
| OpenCode    | always — it runs unsandboxed (the profile's `filesystem` is itself unenforceable and reported)             |
| Qwen Code   | always, unless `ARGUS_QWEN_ARGS` puts the run in the CLI's `--sandbox` container                           |

The system prompt carries one constant, `KNOWLEDGE_DELTA_CONTRACT` (beside
`OUTCOME_CONTRACT`, in `STEP_CONTRACT`), which says roughly:

> If this task establishes or revises durable semantic knowledge, write one
> JSON KnowledgeDelta to `$ARGUS_KNOWLEDGE_DELTA_FILE`. Do not invent canonical
> ids: use a `localId` for a new claim. Reference existing claims only by exact
> revision (`ID:vN`). Argus applies the delta only once the phase is accepted;
> an invalid delta fails this step. Ordinary work writes no file.

It is a pure constant — no per-run data — so the prompt-cache prefix holds, and
it is deliberately short. The agent does not `POST` to `/api/knowledge`; the
file is the agent boundary. The Stop hook is unchanged: Argus reads the file
itself when the completion arrives, which gives the hook path and the
reconcile fallback (Codex/OpenCode, whose completion is read off the run
record) identical semantics.

**Lifecycle of the file:**

1. `launchStep` creates `knowledge-deltas/<runId>/` and injects the variable.
2. The agent may write `delta.json` at any point before it finishes.
3. On the completion signal (or a recovered completion during reconcile),
   Argus reads it — absent → no delta; present → parse, validate, preflight,
   stage or refuse.
4. The file itself is left in place as evidence; `staged.json` beside it is
   Argus's record.

### 12.6 Staging

`agent completed` is not `phase accepted`. A delta that passes intake is
**staged**, not applied:

```
run completes
  ↓ read delta.json
  ↓ parse (invalid-json) · validate shape (schema, local-reference)
  ↓ artifact existence in the run's own roots
  ↓ preflight against the current ledger snapshot (unknown-reference, stale-revision, cycles)
  ↓ write knowledge-deltas/<runId>/staged.json  { id, runId, instanceId, phaseId, attempt, step, status: "staged", delta }
  ↓ step.knowledgeDelta = { id, status: "staged" } on the instance
```

The staged record carries the identity Argus assigned (`KD-…`), the full
execution provenance that distinguishes it from any other attempt's proposal
— instance, phase, **attempt**, run, step — timestamps, the validated
proposal, and later its refusal reason or apply result. It is written with the
atomic writer, survives a restart, and is inspectable at
`GET /api/knowledge/deltas/:id` and `GET /api/knowledge/executions/:runId/deltas`.

Intake failures do not disappear. A malformed or semantically invalid delta
fails the step at once: the step is marked `failed`, the phase fails under the
**`knowledge-delta`** failure class with the refusal as its reason, the run's
outcome is patched to `failed`, and a `rejected` record is written (with the
tail of what the agent wrote when it could not even be parsed). The journal
gets `knowledge.rejected`.

### 12.7 The commit boundary

A delta becomes canonical only when the phase its run belongs to has crossed
**every** deterministic acceptance condition. The integration point is the one
place a phase becomes `succeeded` in the pure transitions — `succeedPhase`,
reached from `concludePhase` (ungated) and `applyApprove` (gated):

```
Ungated phase                            Gated phase
  all steps succeeded                      all steps succeeded
  result validated                         result validated
  checks passed  (if any)                  checks passed  (if any)
        ↓                                        ↓
  succeedPhase()                           awaiting-approval
        │                                        ↓ human approves
        │                                  succeedPhase()
        ↓                                        ↓
  staged deltas?  ──no──▶ succeeded        staged deltas?  ──no──▶ succeeded
        │ yes                                    │ yes
        ▼                                        ▼
  phase.knowledge = pending, phase stays running,  TransitionResult.commitKnowledge = [phaseId]
        ↓ engine: persist the held state · commitKnowledgeDeltas() under the ledger mutex
  applyKnowledgeCommit(verdict)
        ├── ok       → succeeded, publish artifact, settle → successors launch
        └── refused  → failed (class knowledge-delta), reason = the ledger's refusal
```

The transitions stay pure: `succeedPhase` only _holds_ the phase (`running`,
`knowledge.status: "pending"`) and hands the engine the phase id, exactly as
`advance` holds a phase under `verification.status: "running"` and hands it
`verify`. The engine's `settleKnowledge` persists the held instance first,
**rechecks every declared artifact**, commits, applies the verdict and
continues with what the verdict settled.

The artifact recheck closes the gap between intake and commit: intake proved
an artifact existed when the run finished, not that it still does after checks
ran and a gate waited. Before the ledger is touched, `verifyDeltaArtifacts`
re-establishes, for every artifact of every delta in the attempt, exactly what
it established at intake — the run has the root the location names (its
artifact directory; its worktree or working directory, from the invocation
record), the path resolves inside that root, and something exists there. Never
the contents: what the file _is_ remains the agent's claim. One artifact that
vanished refuses the whole attempt's commit — the sibling's valid claims too —
with `KnowledgeDelta commit refused: … artifact: <location>:<path> does not
exist in the run's <location>`, every record moves to `rejected`, and
`knowledge.json` is not written. A
gated phase's staged deltas are untouched while it waits: approval is the
acceptance condition, and only approval commits. If the human revises instead,
the staged deltas are superseded before the new attempt's steps replace the
old ones, and the new attempt stages its own.

Ledger side effects therefore live in the engine (`commitPhaseKnowledge` →
`store.commitKnowledgeDeltas`), never in `pipelineTransitions.ts`.

### 12.8 Multi-step atomicity

Steps of a phase run concurrently and complete in any order. Each run may
write at most one delta; each is staged independently on its own step as it
completes. When the phase is accepted, **every** staged delta of the
succeeding attempt is committed as one ledger transition (`applyKnowledgeDeltas`
over one snapshot, one `atomicWriteJson`) — in step order, never completion
order — or none is.

Cross-delta conflicts are detected in preflight, before a single record is
applied, so the refusal is the same whichever run finished first:

```
step A proposes revision RULE-7 from v2
step B proposes revision RULE-7 from v2
→ conflict: deltas KD-… and KD-… both revise RULE-7 from v2; the phase commit is refused rather than choosing one
```

The phase fails under `knowledge-delta`, both records are `rejected`, and
`RULE-7` stays at v2. Process-completion timing never decides semantic history.
Two non-conflicting deltas commit together, each attributed to its own run.

### 12.9 Attempt isolation

The staging identity is (instance, phase, **attempt**, run, step), and the
staged reference lives on the `StepProgress` of the run that produced it. A
retry or a revise replaces the phase's steps (`restartPhase`), so a new attempt
starts with no staged deltas by construction; `phase.knowledge` is deleted
with them. The commit additionally refuses a record whose `attempt` is not the
phase's current attempt.

Whenever an attempt can no longer be accepted, its staged deltas are retired to
**`superseded`** — on every instance write (`retireStagedDeltas`: a failed,
aborted or skipped phase; a failed, aborted or skipped step, which is how a
losing candidate's delta is retired) and explicitly on revise. So:

```
attempt 1 → emits delta D1 → verification fails      D1: superseded ("phase attempt 0 failed")
attempt 2 → emits delta D2 → succeeds                 D2: applied
```

Only D2 is canonical. D1 remains on disk as diagnostic evidence, never as
knowledge. An `applied` record is never demoted by a later sweep.

A `candidates` phase (HARNESS.md §12) takes the same path with no special
case: each candidate is a step with its own run, worktree and delta file; a
candidate whose checks failed keeps its delta staged (its step is still
`succeeded`) until the selection, where the losers are marked `aborted`,
`stagedDeltaIds` admits only the winner's delta to the commit, and the losers'
records are superseded on the same instance write. A candidate killed
mid-flight never completes, so its file is never even read. Both lifecycles
are covered end to end in `knowledge/deltaEngine.test.ts` ("candidates: …"),
against a real repository.

### 12.10 Atomic application

`applyKnowledgeDeltas(ledger, proposals, { now, mint })` in
`server/src/knowledge/delta.ts` is pure and composes the Phase 1/2 kernel
transitions — `addClaim`, `reviseClaim`, `addEvidence`, `addJustification`,
`recordConsumption`, `recordArtifact` — on a working copy of one snapshot. The
kernel's invariants (uniqueness, existence, acyclicity, locator agreement,
duplicate-edge idempotence) are reused, not reimplemented; a kernel refusal
surfaces as a `ledger`-coded delta error naming the delta and the field. Any
throw leaves the caller holding the snapshot it started with, because the
kernel never mutates. The store wraps it in the ledger mutex and writes the
returned document once:

```
read knowledge.json  →  preflight(all)  →  apply(each, in order)  →  one atomic write
                            │ refused                  │ refused
                            └──────── nothing written ─┘
```

A delta containing a claim, evidence, a justification, a consumption and an
artifact commits completely or not at all. The "atomic failure" test pins it:
a valid claim and valid evidence do not survive an invalid cyclic
justification in the same delta.

Commits are **idempotent on delta id**: `knowledge.json` (version 3) carries a
`deltas` array with one `AppliedKnowledgeDelta` per applied delta — its id,
execution, attempt, and every record id/ref it created. A proposal already
listed there is skipped and its result rebuilt. That is what makes the
persisted "pending" hold crash-safe: a restart between the ledger write and
the instance write is healed by reconcile committing again.

### 12.11 Provenance

Argus binds execution provenance; the agent cannot assert it:

- Every claim, revision and justification a delta creates carries
  `producedBy: { runId, instanceId, phaseId }` — the run that wrote the file.
- Every `consumed` entry becomes a Phase 2 `ClaimConsumption` with
  `execution: { runId, instanceId, phaseId }`, naming the exact revision. There
  is no second consumption representation.
- Every `artifacts` entry becomes a Phase 2 `ArtifactProduction` for the same
  execution. Paths reuse the containment rule (`validArtifactPath`), and at
  intake Argus additionally checks that the file **exists** in the run's own
  root — its artifact directory, or its working tree (the worktree when the
  phase declared one) as the invocation record names them. An agent cannot
  claim `../../somewhere/outside` or a file it never produced.
- The ledger's `deltas` entry records which run, in which attempt, introduced
  which records, so the chain is answerable from `knowledge.json` alone:

```
canonical claim DECISION-3b90f4d2:v1
    ← introduced through   KnowledgeDelta KD-4f…   (ledger.deltas[i].claims)
    ← emitted by           run_123 (inst-1 / plan, attempt 0)   (ledger.deltas[i].execution)
```

and `executionProvenance(runId)` joins both directions as before.

**Agent-declared dependency vs. Argus-proven validity.** A `consumed` entry
is the agent's _declaration_ that it relied on that revision. Argus proves
that the reference exists, is an exact immutable revision, is well formed, and
records it as provenance. Argus does **not** prove — and does not pretend to
prove — that the model internally reasoned from the claim merely because it
declared consumption. The same is true of a justification: Argus proves the
premises exist and the graph stays acyclic, not that the derivation is sound.
This distinction is deliberate and must remain explicit: what the ledger holds
is _structurally valid, agent-declared_ semantic dependency. Phase 4 (§13)
adds the other half: Argus controls the semantic context it supplies to an
invocation, records exactly what it supplied, and classifies each declared
consumption against that record — without ever turning "supplied" into
"consumed".

### 12.12 Failure semantics

**Decision:** a refused KnowledgeDelta is a new **`PhaseFailureClass`**,
`knowledge-delta`, in the `RetryableClass` subset. Not `configuration`
(the definition is fine; running again _can_ help) and not `verification`
(that class means a `checks` entry failed, and its retry note is built from a
`VerificationReport` that a delta refusal does not have). Like `signal`, it is
excluded from the default retry set — the agent considered its proposal — and
an author may opt in with `retry.retryOn: ["knowledge-delta"]`; the retry note
then carries the exact refusal (the revision that moved, the unresolved local
id), which is what a second attempt needs.

| Where                     | Trigger                                                                                                                                                                                                      | Effect                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| intake (step completion)  | invalid JSON · schema · duplicate/undeclared local id · bare id · missing artifact · unknown reference · stale precondition · cycle                                                                          | step `failed`, phase `failed` (`knowledge-delta`), run outcome `failed`, record `rejected`        |
| commit (phase acceptance) | a declared artifact no longer exists (or no longer resolves inside its root) · stale precondition (the ledger moved while checks ran or a gate waited) · conflict between sibling deltas · unreadable ledger | phase `failed` (`knowledge-delta`), `phase.knowledge.status: "rejected"`, every record `rejected` |
| attempt abandoned         | verification failed · agent failed · timeout · revise · abort · lost candidate                                                                                                                               | records `superseded`; nothing canonical                                                           |

Refusal codes (`KnowledgeDeltaError.code`): `invalid-json`, `schema`,
`local-reference`, `unknown-reference`, `stale-revision`, `conflict`,
`artifact`, `ledger`. The reason text on the phase payload carries the code.
A phase is never considered semantically successful while a delta it emitted
was silently discarded: the only deltas that vanish are the ones a run never
wrote.

### 12.13 Auditability and inspection

| Record                        | Where                                        | Says                                                                                  |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `KnowledgeDeltaRecord`        | `argus/knowledge-deltas/<runId>/staged.json` | id, run, instance, phase, attempt, step, status, timestamps, proposal, reason, result |
| `StepProgress.knowledgeDelta` | instance record                              | `{ id, status }` per run                                                              |
| `PhaseProgress.knowledge`     | instance record                              | the attempt's commit: `pending` / `applied` / `rejected`, delta ids                   |
| `AppliedKnowledgeDelta`       | `knowledge.json` → `deltas[]`                | what each applied delta created, attributed to its run and attempt                    |
| journal                       | `argus/journals/<instanceId>.jsonl`          | `knowledge.staged`, `knowledge.rejected`, `knowledge.applied`, `knowledge.superseded` |

Read surface (open, like every dashboard read; there is deliberately no write):

- `GET /api/knowledge/deltas/:id` — the record.
- `GET /api/knowledge/deltas/:id/result` — the `KnowledgeDeltaApplyResult`
  (local id → canonical mapping, created ids, consumptions, artifacts); `404`
  until applied.
- `GET /api/knowledge/executions/:runId/deltas` — the run's deltas (at most
  one, by protocol).

### 12.14 Restart and recovery

- A **staged** delta is on disk before the step's transition is persisted; a
  restart finds it exactly where the step's `knowledgeDelta` reference says.
  A gated phase approved after a restart commits it like any other.
- A phase held **pending** was persisted in that state before the ledger was
  written. Reconcile finds `knowledge.status: "pending"` on a running phase
  and commits again; the ledger's `deltas` makes an already-applied delta a
  no-op, so nothing is applied twice.
- A completion recovered from the run record (Codex/OpenCode fallback) goes
  through the same intake, so a delta written by a run that ended while Argus
  was down is staged when the run is healed. A Claude Code run that ended
  without signalling is failed by the existing fail-safe rule, and its file is
  never staged.
- A record found `rejected` for the current attempt on re-intake is a refusal
  again; a record `staged` for the current attempt is reused (same id).

## 13. KnowledgeContext protocol (Phase 4, hardened in Phase 4.1)

Phase 3 left the _input_ side of the agent boundary soft. A run declared
`consumed: ["RULE-17:v2"]`, and Argus could prove the reference was exact and
existed — but not that the agent had ever been _given_ RULE-17:v2. Phase 4
closes that with the mirror image of the delta file: Argus selects exact
revisions, writes them to a read-only file beside the run, and records on the
invocation precisely what it supplied.

```
             ARGUS
Knowledge Ledger  (one snapshot per phase attempt)
      │
      │ KnowledgeContext        Argus-controlled input   argus/invocations/<runId>/knowledge-context.json
      ▼                                                  $ARGUS_KNOWLEDGE_CONTEXT_FILE, read-only
    Agent
      │
      │ KnowledgeDelta          agent-proposed output    argus/knowledge-deltas/<runId>/delta.json
      ▼                                                  $ARGUS_KNOWLEDGE_DELTA_FILE, write
Knowledge Ledger  (committed at phase acceptance, §12.7)
```

Two facts come out of one run, and they are **never collapsed**:

| Fact         | Meaning                                                        | Who asserts it | Where it lives                                                       |
| ------------ | -------------------------------------------------------------- | -------------- | -------------------------------------------------------------------- |
| **supplied** | Argus can prove this exact revision was in the run's context   | Argus          | `SuppliedContext` in `knowledge.json` (exact refs + sha256, §13.10)  |
| **consumed** | the agent declares it materially relied on this exact revision | the agent      | `ClaimConsumption` in `knowledge.json` (Phase 2 edge, via the delta) |

An agent may receive ten claims and rely on three. Supplying a claim creates
no consumption edge, and impact analysis (§10) reads consumptions only. What
Phase 4 adds to the consumption edge is a classification — which side of the
line it fell on — not a new kind of edge.

### 13.1 Authoring: selectors on a step or its phase

The narrowest useful scope is the step: each invocation may need different
knowledge. A phase may also declare a spec, which every step of the phase
receives unless the step declares its own (a step's spec _replaces_ the
phase's; selector lists are never merged). There is no pipeline-level spec —
"every run receives everything" is the anti-pattern this protocol exists to
avoid.

```jsonc
{
  "id": "implement",
  "name": "Implement",
  "knowledgeContext": { "claims": ["RULE-17", "CONSTRAINT-4:v1"] }, // every step of the phase
  "steps": [
    { "name": "code", "prompt": "…" }, // receives the phase's
    {
      "name": "verify",
      "prompt": "…",
      "knowledgeContext": { "claims": [{ "id": "DECISION-3", "revision": "active" }] }, // its own
    },
  ],
}
```

A selector is one of two things, and the difference is _when_ it is resolved:

| Selector   | Authored as                                                | Means                                                                          |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **exact**  | `"RULE-17:v2"` or `{ "id": "RULE-17", "revision": 2 }`     | always that historical revision, superseded or not                             |
| **active** | `"RULE-17"` or `{ "id": "RULE-17", "revision": "active" }` | the active revision _at the moment the phase attempt is prepared_, then frozen |

Strings are normalized to the object form when the definition is saved, so a
persisted definition never depends on how a selector was spelled. Two rules
are enforced at save time, ledger-free (`parseKnowledgeContextSpec`):

- **shape** — a selector that is not a claim id, an `ID:vN`, or the object
  form; a revision below 1; an unknown key; an empty list; more than 64
  entries — is a `400` naming the entry (`phase 0: step "code":
knowledgeContext.claims[1] must be a claim id …`);
- **one selector per claim id.** A context is a set of claims keyed by
  logical id — each selector answers "which revision of X does this step
  see" — so `["RULE-17:v2", "RULE-17"]` is refused (`RULE-17 is already
selected by claims[0]; each claim id may appear once`). The alternative
  (two revisions of one claim presented as simultaneously _the_ claim) is
  exactly the ambiguity exact references exist to remove. Deduplicating
  silently was rejected because a duplicate is an authoring mistake worth
  hearing about.

Whether the claims **exist** is not checked at save time: a definition may
legitimately name a claim a later phase will create. That check happens at
launch (§13.3).

### 13.2 Resolution: one snapshot per phase attempt

```
startPhase(attempt)
  ↓ any step of the phase declares a knowledgeContext?  → readLedger() once   ← the snapshot
  ↓ for each planned run: resolveKnowledgeContext(snapshot, spec)             ← pure
  │     exact  → getClaim(id, revision)        (may be superseded; lifecycle says so)
  │     active → activeRevision(id)            (the highest revision in the snapshot)
  ↓ prompt gains one line naming the exact refs the file will hold
launchStep(run)
  ↓ write argus/invocations/<runId>/knowledge-context.json atomically, chmod 0444
  ↓ prepareInvocation: channel { kind: "knowledge-context", access: "read", required: true }
  ↓ invocation record: knowledgeContextFile, knowledgeContext { schemaVersion, claims, sha256 }
  ↓ journal knowledge.supplied
  ↓ spawn
```

**The resolution boundary is the snapshot.** Every selector of every run of
one phase attempt — exact and active alike — is answered from the one ledger
document read when the attempt was planned. Consequences, all deterministic:

- The runs of one attempt cannot disagree about what "active" meant.
- A revision committed between planning and spawn, or while the agents run,
  is by construction not in any of their files. The run received what the
  snapshot said; the invocation record says so; a newer revision appearing
  immediately afterwards is expected and harmless, because history is what
  the record holds.
- A retry or a revise plans a **new** attempt and reads a **new** snapshot —
  the second attempt may see v3 where the first saw v2, and each attempt's
  runs record their own.
- Nothing attempts a transaction between process spawn and later ledger
  writes. The record is the proof; the file is immutable once written.

Support state never blocks selection. `unsupported` and `contested` revisions
are supplied with that state written on them: a contested rule may be exactly
what the step is asked to reason about, and hiding semantic uncertainty from
the agent would be worse than exposing it. An exact selector may name a
superseded revision (it exists — that is what "historical" means) and the
projection says `lifecycle: "superseded", supersededBy: "RULE-17:v2"`. An
active selector, by definition, only ever resolves to an active revision.

### 13.3 What refuses a launch

| Condition                                                                          | When           | Effect                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| malformed selector, duplicate id, empty or oversized list                          | pipeline save  | `400` (`PipelineValidationError`)                                                                                                                                                           |
| claim id unknown to the snapshot                                                   | phase planning | the step fails as **`configuration`** before any process starts: `knowledge context unknown-claim: knowledgeContext.claims[1] (NOPE-1 (active)): claim NOPE-1 does not exist in the ledger` |
| exact revision unknown to the snapshot                                             | phase planning | same, `unknown-revision: … revision v7 of RULE-17 does not exist`                                                                                                                           |
| runtime cannot make the file readable (Qwen container sandbox; strict enforcement) | launch         | `configuration` — the read channel is `required` (HARNESS.md §3a)                                                                                                                           |

`configuration` is the right class: the definition names knowledge the ledger
does not hold, and running again cannot change that. It is never retried. The
run record carries the reason (`termination: "spawn-failed"`), the phase
fails under `configuration`, and no context file is written.

### 13.4 The agent-facing document

`ARGUS_KNOWLEDGE_CONTEXT_FILE` names one JSON document (`contracts/src/knowledge.ts`
→ `KnowledgeContext`). It is a **projection**, not a serialized ledger: each
entry carries what an agent needs to reason correctly from the claim without
touching the ledger, and nothing else.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-19T10:00:00.000Z",
  "claims": [
    {
      "ref": "RULE-17:v2", // the immutable identity to cite in `consumed`
      "id": "RULE-17",
      "revision": 2,
      "kind": "business-rule",
      "statement": "Kobra customer comments are limited to 500 characters",
      "lifecycle": "active", // or "superseded", with "supersededBy": "RULE-17:v3"
      "support": "supported", // or "unsupported" | "contested" — never hidden
      "revisionNote": "Kobra 4.2 raised the limit",
      "evidence": [
        {
          "direction": "supports",
          "source": { "type": "document", "uri": "https://kobra.example/release-notes/4.2" },
        },
      ],
    },
    {
      "ref": "CONSTRAINT-4:v1",
      "id": "CONSTRAINT-4",
      "revision": 1,
      "kind": "constraint",
      "statement": "Validation runs server-side",
      "structuredValue": { "where": "server" }, // when the claim has one; opaque
      "lifecycle": "active",
      "support": "supported",
      "producedBy": { "instanceId": "inst-0", "phaseId": "plan", "runId": "run-0" },
      "evidence": [{ "direction": "supports", "source": { "type": "human", "who": "architect" } }],
    },
  ],
  "metadata": {
    "selection": [
      // how each entry was chosen — inspection, not instruction
      {
        "selector": { "id": "RULE-17", "revision": "active" },
        "resolved": { "id": "RULE-17", "revision": 2 },
      },
      {
        "selector": { "id": "CONSTRAINT-4", "revision": 1 },
        "resolved": { "id": "CONSTRAINT-4", "revision": 1 },
      },
    ],
  },
}
```

What is deliberately **not** there: record ids and timestamps of evidence,
the justification graph, consumptions, artifact productions, applied deltas,
any claim that was not selected, and any storage or locking detail. The
document is deterministic for one snapshot and one spec — same bytes, same
hash — and `claims` follow the spec's order.

The file is written with the atomic writer and then made read-only (`0444`).
The mode is a guard against an accidental overwrite by a tool, not the
security boundary; the runtime's sandbox or deny rules are (HARNESS.md §3a),
and the invocation record's hash is the proof of what was supplied whatever
happens to the file afterwards.

### 13.5 The system prompt and the run prompt

`STEP_CONTRACT` gains a third pure constant, `KNOWLEDGE_CONTEXT_CONTRACT`,
phrased conditionally so the cacheable prefix is identical for every run:

> Semantic context. If the `ARGUS_KNOWLEDGE_CONTEXT_FILE` environment variable
> is set, Argus has supplied canonical semantic context … as a read-only JSON
> file at that path; read it before reasoning about the task. Each entry's
> `ref` (`ID:vN`) is an immutable historical identity … Never modify the file.
> Use only what is relevant. If you write a KnowledgeDelta that declares an
> existing claim as consumed, name the exact revision you relied upon, as
> given by its ref.

A step that received a context additionally gets one line in its prompt
(beside the artifact and memory instructions) naming the exact refs:
`Semantic context supplied. Argus has placed 2 canonical claim revisions
(RULE-17:v2, CONSTRAINT-4:v1) as read-only JSON at the path in …`. The file is
the channel; the prompt only makes sure the agent knows it is there. Nothing
tells the agent the ledger's architecture, and nothing obliges it to use every
supplied claim.

### 13.6 Supplied provenance: where it lives and why

`run_456 was supplied RULE-17:v2` is recorded in **two places with different
jobs**, and the split is the point:

```jsonc
// argus/invocations/run_456/invocation.json — the operational launch record
{
  "knowledgeContextFile": "…/argus/invocations/run_456/knowledge-context.json",
  "knowledgeContext": {
    "schemaVersion": 1,
    "claims": [
      { "id": "RULE-17", "revision": 2 },
      { "id": "CONSTRAINT-4", "revision": 1 },
    ],
    "sha256": "3b7c…",
  },
  "channels": [
    // …
    {
      "kind": "knowledge-context",
      "envVar": "ARGUS_KNOWLEDGE_CONTEXT_FILE",
      "access": "read",
      "required": true,
      "status": "granted",
    },
  ],
}
```

```jsonc
// ~/.claude/argus/knowledge.json → supplied[] — the durable semantic record
{
  "execution": { "runId": "run_456", "instanceId": "inst_9", "phaseId": "implement" },
  "attempt": 0,
  "schemaVersion": 1,
  "claims": [
    { "id": "RULE-17", "revision": 2 },
    { "id": "CONSTRAINT-4", "revision": 1 },
  ],
  "sha256": "3b7c…",
  "suppliedAt": "2026-09-19T10:00:00.000Z",
}
```

**Phase 4 recorded only the first, and that was the one asymmetry left in the
model.** Invocation records are pruned with their runs (§14), so the answer to
_what canonical semantic context did run_456 receive?_ had a retention horizon
that consumption provenance does not. Semantic input provenance is part of the
reasoning history; it should not age out with a log file. Phase 4.1 closes the
asymmetry (§13.10) without making the invocation record redundant:

| Record                               | Answers                                                                         | Retention           |
| ------------------------------------ | ------------------------------------------------------------------------------- | ------------------- |
| `AgentInvocationRecord`              | _how was this process launched?_ argv, env, channels, where the context file is | pruned with the run |
| `SuppliedContext` (`knowledge.json`) | _which exact revisions did this execution receive, and with what content hash?_ | durable             |
| the materialized context file        | _what exactly did the agent read?_ (the bytes)                                  | pruned with the run |

The principle, stated once: **heavy operational records are prunable; small
semantic provenance is durable.** The invocation record stays the immediate
launch representation and the only place the file path lives; every semantic
query that must survive pruning reads the ledger, and none of them scans
retained invocation directories.

Both directions are exposed:

```
GET /api/knowledge/executions/run_456/context      →  what did run_456 receive?
GET /api/knowledge/claims/RULE-17:v2/supplied-to    →  which runs received RULE-17:v2?
```

The first returns the durable record's exact refs, hash and timestamp, the
ledger's consumptions for the run, the three-way comparison, and — while the
file still exists — the materialized projection, with `projectionAvailable`
saying which. The second filters the ledger's `supplied` for the exact
revision (a different revision of the same id is not a match), oldest launch
first, and lists runs whose invocation directories are long gone.

### 13.7 Supplied versus consumed

At intake (§12.6) Argus reads the run's supplied refs and copies them onto the
staged `KnowledgeDeltaRecord` as `supplied` (empty for a run launched without
a context; absent only when nothing can answer). There is **one deterministic
answer from two sources with a fixed precedence**: the ledger's durable
`SuppliedContext` first — written before the process started and proof against
every pruning path — and the run's invocation record only when there is none
(a run launched before Phase 4.1, or one launched with no context at all).
The two cannot disagree: both come from the same resolution, and a
conflicting registration is refused (§13.10). The precedence therefore only
buys availability — a recovery path whose invocation directory is gone still
classifies correctly. At commit the pure `applyKnowledgeDeltas` receives them
on the `DeltaProposal` and classifies every `consumed` entry:

| Case                   | Example                                      | Result                                                                     |
| ---------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| supplied and consumed  | supplied `RULE-17:v2`, consumed `RULE-17:v2` | `ClaimConsumption.source = "supplied-context"` — the normal case           |
| supplied, not consumed | supplied `CONSTRAINT-4:v1`, not declared     | **no consumption edge**. Allowed: the agent did not need everything it got |
| consumed, not supplied | consumed `FACT-2:v1`, never supplied         | `source = "agent-discovered"`. Allowed and recorded, never refused         |
| no supplied evidence   | (hand-registered via the admin API)          | `source` absent — no claim either way, never guessed                       |

`source` is the smallest representation that preserves the distinction: one
optional field on the Phase 2 edge, so `executionProvenance(runId).consumed[]`
and `GET /claims/:key/consumers` show it, the field is purely additive on the
ledger document, and records written before Phase 4 simply lack it.

**Unknown stays unknown.** A consumption is marked `supplied-context` only
where Argus holds positive supplied-provenance evidence. A Phase 1–3 record
with `source` undefined is never retrospectively upgraded, a ledger upgraded
to version 4 gains an _empty_ `supplied` array, and nothing is inferred from a
prompt, a phase relationship or which run produced the claim. A run launched
_with no context_ is a different case: its invocation record positively says
the supply was empty, so its consumptions are classified `agent-discovered`
rather than left blank.

A consumed-but-not-supplied claim is **not rejected**. The agent may have
learned it from source code, a document, an MCP server or any other tool it
was allowed. What Phase 4 adds is that Argus now knows — and says — that it
did not supply it. Whether a policy should later require consumption to stay
within supplied context is a decision for a later phase, and one this record
makes possible.

### 13.8 Impact stays consumption-based

Nothing in `analyzeImpact` reads a supplied set, and this is deliberate. A run
that received `RULE-A`, `RULE-B`, `RULE-C` and declared `consumed: [RULE-B]`
is impacted when `RULE-B` changes and untouched when `RULE-A` does. Were
supply to count as dependency, every context payload would become blast
radius and the impact set would be dominated by false positives — the exact
failure the exact-reference discipline exists to prevent. The
`contextEngine.test.ts` scenario "supplied ≠ consumed" pins this from both
sides: revising the supplied-only claim yields `executions: []`; revising the
consumed one lists the run and its artifact.

### 13.9 The worked example, Phase 4

```
Ledger:   RULE-17:v1 (superseded) → RULE-17:v2 "Comment max is 500"     CONSTRAINT-4:v1 "Validate server-side"
Step:     implement/code   knowledgeContext: { claims: ["RULE-17", "CONSTRAINT-4:v1"] }
```

1. `startPhase` reads one snapshot; `RULE-17` (active) resolves to **v2**,
   `CONSTRAINT-4:v1` is taken exactly.
2. `launchStep` writes `argus/invocations/run_456/knowledge-context.json`
   (`claims[].ref = ["RULE-17:v2", "CONSTRAINT-4:v1"]`, `0444`), records
   `knowledgeContext: { claims: [RULE-17:v2, CONSTRAINT-4:v1], sha256 }`,
   journals `knowledge.supplied`, and spawns with
   `ARGUS_KNOWLEDGE_CONTEXT_FILE` set. Under a Claude Code profile the argv
   carries `--add-dir <invocation dir>` and `Edit(//<invocation dir>/**)` in
   `--disallowedTools`.
3. The agent reads the file, implements the validator, and writes a delta:
   `{ "consumed": ["RULE-17:v2"], "artifacts": [{ "location": "artifact-dir", "path": "context-as-seen.json" }] }`.
4. Intake copies `supplied: [RULE-17:v2, CONSTRAINT-4:v1]` onto the staged
   record; the phase's checks pass; the commit records
   `ClaimConsumption { RULE-17:v2, run_456, source: "supplied-context" }` and
   the artifact. No edge for `CONSTRAINT-4:v1`.
5. Later, `RULE-17:v3` supersedes v2. `GET /claims/RULE-17:v2/impact` lists
   `run_456` (`consumed-affected-claim`) and its artifact. The invocation
   record still says v2; the file still says v2.
6. `CONSTRAINT-4` is revised. `GET /claims/CONSTRAINT-4:v1/impact` lists no
   execution: it was supplied, not consumed.
7. `GET /executions/run_456/context` answers
   `comparison: { suppliedAndConsumed: [RULE-17:v2], suppliedNotConsumed: [CONSTRAINT-4:v1], consumedNotSupplied: [] }`;
   `GET /claims/RULE-17:v2/supplied-to` answers `[run_456]`.

This exact scenario runs against real child processes in
`harness/e2e.test.ts` ("knowledge context: …"), with the fake agent copying
the file it read into its artifact directory so the test compares the bytes
the agent saw with the bytes Argus wrote.

### 13.10 Durable supplied provenance (Phase 4.1)

The durable half of the protocol. One record per run, in `knowledge.json`
beside `consumptions`, `artifacts` and `deltas` — the same authoritative store
as the rest of the semantic execution provenance, for the same reason: a
supplied set is a fact about reasoning history, it is validated against the
same execution locators, and the volumes are tiny (one small record per run
that received a context). No second database, no independent semantic-history
store.

```ts
interface SuppliedContext {
  execution: RunExecutionRef; // runId, and instanceId/phaseId where known
  attempt?: number;
  schemaVersion: 1; // the KnowledgeContext wire version
  claims: ClaimRef[]; // the exact revisions, in file order
  sha256: string; // of the materialized file's bytes
  suppliedAt: string;
}
```

**What it deliberately does not hold: the KnowledgeContext JSON.** The
projection is derivable presentation — statements, support, evidence — over
revisions that are themselves immutable in the ledger. Its identity is what
matters, and `claims + sha256` is that identity: it names precisely which
canonical semantic revisions a run received and lets any surviving copy of
the file be checked against it. Copying the whole document in would duplicate
the ledger's own records for every run forever and create a second place a
reader could think the claims lived. The projection stays an operational
artifact under invocation retention.

**Lifecycle.** Registered by the invocation path only — there is no mutation
API for supplied provenance, and none will be added:

```
resolve one ledger snapshot per phase attempt        (startPhase)
      ↓
build the KnowledgeContext, serialize, hash          (resolveKnowledgeContext)
      ↓
write argus/invocations/<runId>/knowledge-context.json, chmod 0444
      ↓
write the invocation record                          (writeInvocation)
      ↓
register the durable SuppliedContext                 (registerSuppliedContext)
      ↓
journal knowledge.supplied
      ↓
spawn the process
```

Registration happens **before** the spawn, and deliberately before the point
where the launch can still be refused (an unenforceable capability profile).
The invariant it asserts is therefore precise:

> A `SuppliedContext` record means: **Argus materialized this exact context
> and named it to this attempted invocation.** It does not mean the process
> ran, and it does not mean the agent read the file.

"Did it run?" is the run record's question, and "did it produce semantics?"
is answered durably by the consumption, artifact and applied-delta records —
a run that never spawned has a supplied record and none of those. That reuses
the distinction the execution model already has rather than inventing a
softer one.

**Idempotency.** Identity is `execution.runId` — one run receives one context,
once. Registering the identical record again (a retried preparation, a restart
reconciling, a replay) is a no-op that returns the existing record. Registering
a _different_ claim list or a _different_ hash for the same run is **refused**
with a `KnowledgeValidationError`; it never merges and never overwrites. Two
conflicting accounts of what a past execution was given is a bug, and failing
closed keeps the history rather than keeping the last writer. Two attempts of
a phase are two runs, so they get two independent records — attempt 1 may hold
`RULE-A:v1` and attempt 2 `RULE-A:v2`, and neither is retargeted.

**Historical guarantee.** Exactly as for a consumption: `run_456 → RULE-17:v2`
stays v2 when v3 is created, forever. The reverse query is on the exact
revision, so `RULE-17:v3/supplied-to` does not list a run that received v2.

### 13.11 Context integrity (Phase 4.1)

Argus hashed the context file when it wrote it. Phase 4.1 uses that hash.
Before a step's completion — and the semantic output it carries — is accepted,
the file is re-read and re-hashed:

```
Argus materializes the context → records sha256 (durable)
      ↓
agent executes
      ↓
completion received (signal, or recovered by reconcile)
      ↓
Argus re-hashes the file at the recorded path
      ↓
matches?   yes → intake the KnowledgeDelta, then the ordinary transition
           no  → deterministic failure, nothing staged, nothing committed
```

The order matters: the integrity check runs **before** delta intake, so a run
whose input Argus cannot vouch for never even gets its proposal staged, let
alone committed. Both completion paths — the stop-hook signal and the
reconcile fallback for runtimes with no hook — go through the same gate.

**Failure class.** `knowledge-context-integrity`, a new `RetryableClass`
alongside `knowledge-delta`: not retried by default (a tampered context is a
harness or sandbox problem, not a transient one), retryable on opt-in in
`retry.retryOn` since a fresh attempt materializes a fresh file. The phase
failure reason names the run, the expected hash, the hash found and the path —
and never a byte of the context itself.

**A missing file is a failure too.** Deleting the file does not erase history
(the durable record holds it), but it does mean Argus cannot confirm the agent
read what it was given, and "cannot confirm" is not "confirmed". No runtime in
the repository legitimately removes the file — it is created `0444` in the
run's own invocation directory, which every runtime is told to admit read-only
and Claude Code is told to deny edits under — so the deterministic refusal has
no legitimate case to break. If a future runtime needs to, that is a runtime
capability to declare, not a silence to permit.

**Integrity is about bytes, not currency — this distinction is mandatory.**
Suppose a run receives `RULE-17:v2` and, while it is running, another run
commits `RULE-17:v3`. The context file is untouched, so it hashes correctly,
so integrity **passes** and the run legitimately completes on the historical
v2. The context is never compared against the current ledger and never
declared stale at completion. Whether a conclusion still rests on current
knowledge is a separate, derived read — §9 semantic currency and §10 impact —
computed whenever someone asks, never a failure at completion time.

**Runs with no context are untouched.** No durable supplied record means
nothing to verify: no hash, no read, no check, no failure class, no journal
entry. A legacy pipeline behaves exactly as it did before Phase 4 existed.

### 13.12 Retention interaction

What `pruneRuns` removes for a pruned run: `run.json`, the log, the result
directory, the whole invocation directory (the record, the materialized
context file, materialized settings/MCP files) and the delta staging
directory. `pruneInstances` removes the instance file, its journal and its
worktrees. **Neither touches `knowledge.json`.**

So after ordinary retention has run:

| Question                                      | Still answerable                      |
| --------------------------------------------- | ------------------------------------- |
| which exact revisions did run_456 receive?    | yes — durable record                  |
| what was the context's sha256, and when?      | yes — durable record                  |
| which runs received RULE-17:v2?               | yes — durable record                  |
| what did run_456 declare it consumed?         | yes — consumption edges               |
| what did run_456's context file actually say? | **no** — `projectionAvailable: false` |
| where was the context file?                   | **no** — `context.file: null`         |

The API states the last two rather than working around them: it does **not**
rebuild a projection from today's ledger and present it as what the run
received. Today's ledger is a different document; a reconstruction would be a
plausible-looking forgery of the one thing this protocol exists to make exact.

## 14. Business-rule discovery orchestration (Phase 5)

Phases 1–4.1 built a semantic harness: immutable claims, evidence,
justifications, deterministic support, a proposal protocol with an atomic
commit boundary, and controlled context delivery with durable provenance.
Phase 5 adds no new machinery to any of that. It is **one workflow** built on
what already exists, for the question the Ledger was created to answer:

> What business rules does this repository actually enforce, and how do we
> know?

```
business change / investigation task
        ↓
repository evidence discovery          (a bounded scope, read by an agent)
        ↓
candidate business rules               (a staged KnowledgeDelta — §12)
        ↓
human review gate                      (deterministic checks, then a person)
        ↓
KnowledgeDelta commit                  (the §12.7 boundary, unchanged)
        ↓
canonical Knowledge Ledger
        ↓
explicit KnowledgeContext selection    (§14.7 — by accepted phase)
        ↓
planning / implementation / verification agents
```

The transition that matters is the one in the middle:

```
repository observation  →  candidate semantic knowledge  →  review  →  canonical semantic knowledge
```

**Discovery never bypasses the commit boundary.** A discovery agent writes the
same `ARGUS_KNOWLEDGE_DELTA_FILE` every other step is offered, Argus stages it
the same way, and it becomes canonical through exactly the §12.7 commit. There
is no second candidate store, no second approval system, and no path by which
an agent's proposal reaches `knowledge.json` without a phase being accepted.

### 14.1 Candidate versus canonical

An agent discovering a possible business rule does **not** mean Argus believes
it. Given:

```
src/Booking/KobraAdapter.cs
    public const int MaxCustomerCommentLength = 180;
```

a discovery agent may propose:

> **Candidate.** Kobra bookings restrict customer comments to 180 characters.

That is a _staged_ claim. Until the containing phase is accepted it has:

- no canonical id (it is `local:comment-limit` everywhere a person sees it),
- no revision number,
- no presence in `knowledge.json`,
- no reachability from any downstream selector (§14.7).

The Phase 3 lifecycle carries it the rest of the way: staged → the phase's
acceptance ladder → applied, or superseded if the attempt is revised, retried
or aborted.

### 14.2 Authoring a discovery phase

A phase becomes a discovery phase by declaring `discovery`:

```jsonc
{
  "id": "discover-rules",
  "name": "Discover rules",
  "gated": true,
  "discovery": {
    "scope": {
      "paths": ["src/Booking"],
      "label": "Kobra booking",
      "note": "We are changing the comment-length handling.",
    },
    "evidence": "required", // the default; "warn" downgrades it to a warning
  },
  "steps": [{ "name": "investigate", "prompt": "Investigate the booking module." }],
}
```

That does three things, all deterministic:

1. the steps get the **discovery instructions** appended to their prompt
   (§14.3);
2. the delta the run writes is held to the **discovery invariants** (§14.5);
3. the phase carries a `DiscoverySummary` and its gate carries a
   `KnowledgeDeltaPreview` (§14.6).

Everything else about the phase is an ordinary phase. In particular a
discovery phase is normally `gated: true` — nothing forces it, but §14.1 is
only meaningful if a person is in the loop.

**Bounded scope is not decoration.** `scope.paths` is used twice: it goes into
the agent's instructions, _and_ it is the containment rule every `source-code`
evidence path is checked against. Evidence pointing outside the declared scope
refuses the delta. `"."` means the whole working tree and has to be written
out; there is no implicit "look everywhere". The capability system remains the
security boundary — the scope is a semantic bound, not a sandbox.

### 14.3 The discovery contract

One reusable instruction block (`knowledge/discovery.ts`,
`DISCOVERY_CONTRACT`), appended after the author's own prompt the way the
result and artifact instructions are. An authored pipeline never restates it.
It tells the agent to distinguish:

| A business rule                                                 | Not a business rule                                     |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| "Kobra bookings allow a maximum customer comment length of 180" | "`KobraBookingMapper.cs` uses `Substring(0, 180)`"      |
| a domain or regulatory constraint                               | "the class is called `FooValidator`"                    |
| something a domain owner would recognise                        | an architectural preference or a test's internal detail |

The second column is **evidence for** the first, not a rule. The instruction
asks the model the question that makes the difference:

> What business or domain behaviour does this implementation appear to
> enforce?

and tells it that if the answer is "none, this is plumbing", the right output
is nothing. It also says: evidence is mandatory, uncertainty goes in an
explicit assumption claim, an existing rule is revised rather than duplicated,
and canonical ids are Argus's to mint.

### 14.4 Source-code evidence

Phase 1's evidence union already had a `source-code` variant. Phase 5 widens
it to the smallest locator a person can act on later, and validates it:

```jsonc
{
  "type": "source-code",
  "path": "src/Booking/KobraAdapter.cs", // repository-relative, required
  "repository": "monorepo", // optional label
  "gitHead": "abc123…", // the commit it was read at
  "symbol": "KobraAdapter.MapComment", // optional
  "startLine": 120,
  "endLine": 136,
  "line": 120, // pre-Phase-5 single-line form, still parsed
}
```

**Provenance, not source duplication.** The ledger stores where the code is,
never a copy of it. A rule grounded in a 400-line function is as small in
`knowledge.json` as one grounded in a constant.

What Argus validates, all deterministically and never by asking a model:

| Rule                                                                                        | Where          | Outcome              |
| ------------------------------------------------------------------------------------------- | -------------- | -------------------- |
| `path` is repository-relative POSIX, no `..`, no leading `/`, no drive letter, no backslash | `validate.ts`  | the delta is refused |
| `startLine ≤ endLine`, both positive integers; `endLine` requires `startLine`               | `validate.ts`  | the delta is refused |
| `gitHead` is a hex sha                                                                      | `validate.ts`  | the delta is refused |
| the path is inside the phase's `discovery.scope`                                            | `discovery.ts` | the delta is refused |
| the path resolves to a **file that exists** in the run's working tree                       | `discovery.ts` | the delta is refused |
| `gitHead` matches the commit Argus recorded for the run (abbreviations allowed)             | `discovery.ts` | the delta is refused |

The last three run **twice**: at intake, while the worktree the run used still
exists, and again at the commit boundary — the same discipline §12.7 applies
to declared artifacts. A source file deleted while a gate waited refuses the
commit rather than being recorded as provenance for something that is gone.
This is deliberately **fail-closed**: a rule whose evidence nobody can go and
check is worse than no rule.

What Argus does **not** validate: that the code means what the agent says it
means. That is the review's job (§14.9).

**Source identity is historical.** `src/Booking/KobraAdapter.cs@abc123:120-136`
means that file at that commit. A later commit that moves or rewrites the code
does not retarget the record and does not rewrite the rule — exactly as a
claim revision never retargets a consumption. Rediscovery at a later commit
may _propose_ a revision; that is what the Ledger is for.

### 14.5 The business-rule evidence invariant

> **A business rule created or revised through a discovery-mode KnowledgeDelta
> must carry supporting evidence in that same delta.**

Precisely:

- A proposed `business-rule` claim needs at least one evidence record with
  `direction: "supports"` attached to its `localId`. A justification alone is
  not enough — a derived rule must still be grounded.
- A proposed **revision** of an existing `business-rule` needs _fresh_
  evidence: the revision must declare a `localId` and at least one supporting
  evidence record must name it. **An agent may not revise a business rule
  purely by changing its sentence.** The evidence on the previous revision
  supported the previous statement; it is not a reason to believe the new one.
- Revisions of other kinds are unaffected — the invariant is about rules.

This is enforced **on discovery-mode deltas only**, and that is an intentional
choice, not a limitation we ran out of time to fix:

- Applying it globally would change `POST /api/knowledge/claims` and every
  non-discovery agent phase, breaking the admin and historical-import paths
  the ledger deliberately keeps open for a human operator.
- The invariant is about _agent-discovered_ knowledge. "An agent said so" is
  exactly the claim that needs grounding; "an operator recorded the rule the
  domain owner stated" is a different provenance with a different warrant.

Outside discovery mode, a rule with no evidence is still surfaced — as a
review warning on the preview (§14.6) — just not refused.

`evidence: "warn"` on the policy downgrades these two codes to warnings, for
an author who would rather see the candidate at the gate than lose the step.
It downgrades nothing else: nobody gets to opt out of evidence pointing at a
file that is not there.

### 14.6 The candidate preview and its warnings

A gated discovery phase must be reviewable **without reading the agent's
transcript**. `PhaseReview.knowledge` carries one `KnowledgeDeltaPreview` per
step that staged a delta on this attempt — derived per read from the staged
record and the ledger, mutating nothing:

```ts
interface KnowledgeDeltaPreview {
  deltaId: string;
  runId: string;
  step: string;
  attempt: number;
  status: KnowledgeDeltaStatus;
  proposedClaims: PreviewClaim[]; // with their evidence and justifications gathered under them
  proposedRevisions: PreviewRevision[]; // with `current`: what the ledger holds now
  evidence: PreviewEvidence[];
  justifications: PreviewJustification[];
  consumed: Array<{ ref; claim; kind?; statement? }>;
  supplied?: Array<{ ref; claim; kind?; statement? }>;
  artifacts: ArtifactRef[];
  summary?: string;
  warnings: KnowledgeDeltaWarning[];
}
```

**It does not pretend canonical identity exists.** A proposed claim is shown
as `local:comment-limit`, because that is all it is until the commit mints an
id. A proposed revision shows both sides: `RULE-17:v1 → RULE-17:v2 (proposed)`,
with the current statement, support and lifecycle beside the new statement.

The deterministic warnings, every one decided from exact structured
information — the delta, the ledger, the filesystem:

| Code                             | Means                                                             | Refuses in discovery mode |
| -------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| `business-rule-without-evidence` | a proposed rule carries no supporting evidence                    | yes (unless `warn`)       |
| `revision-without-evidence`      | a rule revision changes the sentence with no new evidence         | yes (unless `warn`)       |
| `source-path-unsafe`             | the path escapes the repository                                   | yes                       |
| `source-outside-scope`           | the path is outside the declared discovery scope                  | yes                       |
| `source-file-missing`            | the path is not a file in the run's working tree                  | yes                       |
| `source-git-head-mismatch`       | the evidence names a commit other than the run's                  | yes                       |
| `source-range-invalid`           | `endLine` precedes `startLine`                                    | yes                       |
| `assumption-without-evidence`    | an assumption with neither evidence nor a justification           | no — a reviewer's call    |
| `claim-without-support`          | any other claim with neither                                      | no                        |
| `revision-target-unsupported`    | the targeted claim is currently `unsupported` or `contested`      | no                        |
| `revision-stale`                 | `expectedRevision` is no longer active; the commit will refuse it | no                        |
| `new-rule-while-rules-supplied`  | a new rule was created while supplied rules were left unrevised   | no                        |

The last one deserves a note, because it is the one that _looks_ like
similarity matching and is not. It counts two exact sets — the business rules
the run was supplied (from the durable `SuppliedContext`) and the claim ids
the delta revises — and when the first is non-empty and disjoint from the
second, it says:

> this delta creates 1 new business rule while 1 supplied business rule
> (RULE-17:v1) was left unrevised; check whether one of them is the same
> logical rule, which should be revised rather than duplicated

It never asserts the rules _are_ duplicates. There are no embeddings, no
vector search, no similarity threshold and no LLM adjudication anywhere in
Phase 5. Global semantic deduplication is a later problem; §14.8 is what Phase
5 does instead.

### 14.7 The structured phase summary

A discovery phase also carries counts, for routing, status and observability
— never a second copy of the candidates:

```json
{
  "candidates": 2,
  "newRules": 1,
  "revisions": 0,
  "assumptions": 1,
  "facts": 0,
  "constraints": 0,
  "conclusions": 0,
  "evidence": 3,
  "warnings": 0,
  "requiresReview": true
}
```

`requiresReview` is true exactly while the candidates are staged and not
canonical, so a board can say "2 candidates, waiting on you" and then "2
candidates, committed" without reading the ledger. The authoritative detail
stays in the staged KnowledgeDelta.

### 14.8 Existing-rule reconciliation

Discovery must account for rules the ledger already holds. The mechanism is
the one that already exists: the pipeline author **supplies** the relevant
canonical rules through `knowledgeContext` (§13), and the contract tells the
agent to check them first.

Given `RULE-17:v1` in context and repository evidence now indicating 500, the
desired proposal is:

```jsonc
{
  "revisions": [
    {
      "claimId": "RULE-17",
      "expectedRevision": 1,
      "localId": "r2",
      "statement": "Kobra comments max = 500",
      "revisionNote": "the adapter truncates at 500",
    },
  ],
  "evidence": [{ "claim": { "local": "r2" }, "source": { "type": "source-code", "path": "…" } }],
}
```

not a second `RULE-89` saying something different about the same thing. The
optimistic concurrency of §12.4 remains authoritative: if `RULE-17` moved to
v2 while the gate waited, the **whole** delta is refused at commit and nothing
in it becomes canonical — including the unrelated claims it proposed.

If the agent was _not_ supplied a semantically similar rule, it may still
propose a new one, and it will not be merged automatically. Phase 5's answer
to duplication is controlled context, exact identity and explicit review, in
that order.

### 14.9 Review and acceptance

```
discovery agent completes
      ↓
deterministic checks (§14.4, §14.5)  ──refused──▶ the step fails (knowledge-delta), nothing staged
      ↓
KnowledgeDelta staged
      ↓
awaiting-approval, with the preview (§14.6)
      ├─ revise ──▶ the staged delta is superseded; a new attempt proposes afresh
      └─ approve ──▶ the §12.7 checks run again ──▶ atomic commit ──▶ canonical rules
```

**No canonical rule exists before approval.** That is mandatory for Phase 5
and is proved by the suite in both directions: the ledger has nothing while
the gate waits, and a revised attempt's candidates never become canonical.

What is agent interpretation, and what Argus establishes deterministically:

| Argus establishes                                                | The reviewer decides                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| the path is repository-relative and inside the declared scope    | whether the code the path names really encodes a business rule |
| the file exists at the commit the run ran on                     | whether "180 characters" is a domain rule or an accident       |
| the rule carries supporting evidence                             | whether the evidence actually supports the sentence            |
| the revision precondition still holds                            | whether the new statement is the right replacement             |
| the assumption is recorded as an assumption, not a fact          | whether to accept the assumption at all                        |
| which exact revisions the run was supplied and declared consumed | whether a new rule duplicates a supplied one                   |

Discovery is **not verification**. "The source code says this, therefore this
is the intended business rule" is precisely the inference Argus refuses to
make on its own. Stronger verification against specifications, issue trackers,
production behaviour or a domain owner is a later phase's work.

### 14.10 Same-instance knowledge handoff

This is the first time knowledge created earlier in a pipeline instance must
reach a later phase's KnowledgeContext. A second selector family does it:

```jsonc
{
  "knowledgeContext": {
    "fromPhases": [{ "phaseId": "discover-rules", "kinds": ["business-rule", "constraint"] }],
  },
}
```

`claims` and `fromPhases` compose; at least one must be present. `claims` is
resolved first and wins on a claim-id collision, so an author who pinned a
revision explicitly keeps it.

**Resolution reads the applied delta provenance and nothing else.** At the
downstream phase's planning, Argus asks `claimsProducedByPhase(ledger,
instanceId, phaseId)`, which scans `ledger.deltas` — the ledger's record of
every **applied** KnowledgeDelta (§12.11) — for the ones that phase of this
instance committed, and takes the exact `ClaimRef`s they created. Three
consequences, all of them the point:

- **Staged knowledge cannot leak.** A phase parked at its gate has committed
  nothing, so `ledger.deltas` holds nothing for it and the selector resolves
  to nothing. This is structural, not a check somebody has to remember.
- **It is exact.** The refs are the ones the commit minted — not claims whose
  `producedBy` happens to name the phase, and not claims that look recent. A
  superseded attempt's records are not in `deltas` at all.
- **It is historically stable.** A later revision of one of these claims
  creates a new record; it does not retarget this one. The same question
  tomorrow gives the same answer.

Resolution is refused as a `configuration` failure — before any process
starts — when the named phase is not `succeeded` or `skipped`. In particular
`awaiting-approval` is refused rather than resolving to an empty context: a
downstream step quietly told "there is no knowledge" when the truth is "the
knowledge is not accepted yet" is a lie with consequences. A `skipped` phase
resolves to nothing, which is the honest answer for a routed-around branch.

Authoring is checked when the pipeline is saved: the named phase must exist,
must not be the phase itself, and must be a **transitive dependency** through
`needs` (for a linear pipeline, the implicit edges satisfy this). Two phases
that merely sit side by side have no ordering, so a handoff across them would
be a race.

`kinds` is the whole of the "do not implicitly trust everything downstream"
story. Discovery may produce facts, assumptions, rules and conclusions; an
implementation phase may be given only the rules:

```
Phase: discover-rules   →  FACT-1:v1, ASSUME-2:v1, RULE-3:v1
Phase: plan             ←  fromPhases: [{ phaseId: "discover-rules", kinds: ["business-rule"] }]
                           KnowledgeContext = [RULE-3:v1]
Phase: implement        ←  the same selector, plus the planning decision
Phase: verify           ←  the accepted rules
```

The implementation agent then declares exactly which rules it relied on, the
consumption edge is classified `supplied-context` (§13.7), and the §10 impact
machinery becomes meaningful for the next change.

An empty resolution still materializes a context file and still writes a
durable `SuppliedContext` record with an empty `claims` list: "Argus supplied
this run a context holding no revisions" is a different, and equally
recordable, fact from "this run was launched with no semantic context".

### 14.11 The worked example, Phase 5

A repository at commit `abc123`:

```
src/Booking/Booking.cs
src/Booking/KobraAdapter.cs      MaxCustomerCommentLength = 180
```

```
Phase discover (gated, scope src/Booking)
  the agent writes:
    ASSUME-local  "the 180 ceiling is a Kobra integration constraint"
    RULE-local    "Kobra bookings restrict customer comments to 180 characters"
    evidence      src/Booking/KobraAdapter.cs@abc123:5-8  (KobraAdapter.MapComment)
    evidence      src/Booking/Booking.cs@abc123:1-4
    justification RULE-local ← ASSUME-local
  Argus checks: paths in scope ✓ files exist ✓ commit matches ✓ rule has evidence ✓
  → staged.  knowledge.json: unchanged.  discovery: { candidates: 2, requiresReview: true }

a person reads the preview and approves
  → ASSUME-7:v1, RULE-8:v1 committed atomically, with their evidence and justification

Phase plan      knowledgeContext: fromPhases [discover, kinds: [business-rule]]
  → KnowledgeContext = [RULE-8:v1]            (the assumption is not handed on)

Phase implement knowledgeContext: fromPhases [discover, kinds: [business-rule]]
  → KnowledgeContext = [RULE-8:v1]
  the agent declares consumed: ["RULE-8:v1"], artifact repository:src/Booking/CommentValidator.cs
  → consumption (RULE-8:v1, run_impl, source: supplied-context)
    production  (run_impl, repository:src/Booking/CommentValidator.cs)

later: Kobra 4.2 raises the limit; RULE-8:v2 supersedes v1
  analyzeImpact(RULE-8:v1)
    root.conditions   ["superseded"]
    executions        [run_impl]        — it consumed v1
    artifacts         [src/Booking/CommentValidator.cs]
```

Not one step of that provenance or impact chain is computed by a model.

### 14.12 What Phase 5 deliberately does NOT do

- **No automatic repository-wide discovery.** Every invocation is bounded by a
  declared scope.
- **No embeddings, vector search or semantic similarity.** Rule identity is
  exact, and deduplication is a review decision.
- **No automatic acceptance.** A discovery phase exists to be reviewed.
- **No automatic rule merging, ontology management or contradiction-resolution
  agents.** Conflict is modelled (opposing evidence, contested support); it is
  not resolved autonomously.
- **No rediscovery-driven rewriting.** A rule discovered at `abc123` stays a
  historically supported claim bound to `abc123`. A later run may _propose_ a
  revision; nothing rewrites it in the background.
- **No Jira/specification ingestion, production-data discovery, or automatic
  remediation.** Those are verification and integration problems, not
  discovery ones.
- **No graph UI.** The gate review is a structured panel: candidates,
  evidence, revisions, warnings.

## 15. Persistence

**Authoritative store:** `~/.claude/argus/knowledge.json`, one JSON document:

```json
{ "version": 4, "claims": [...], "evidence": [...], "justifications": [...], "consumptions": [...], "artifacts": [...], "deltas": [...], "supplied": [...] }
```

Written through the same discipline as `pipelines.json` and `schedules.json`:
a whole-document read-modify-write serialized by a keyed mutex, persisted via
the atomic tmp+rename writer, and **refusing to overwrite** a file it cannot
parse or that carries an unknown version. A refused transition writes nothing.
Concurrent proposals see each other's records, so the second of two identical
claim ids is refused rather than duplicated.

**Version 2** (Phase 2) added the two provenance arrays; **version 3** (Phase 3)
added `deltas`, the ledger's own record of every KnowledgeDelta it applied;
**version 4** (Phase 4.1) added `supplied`, the durable record of what Argus
put into each run's context (§13.10).
A version 1, 2 or 3 file is read as version 4 with the missing arrays empty and
is rewritten in that shape by the next successful transition — nothing an
earlier phase recorded changes, no supplied provenance is invented for the runs
it already holds, and reading alone never writes. Any other version is
treated as foreign: readable as empty, never overwritten.

**Staging store:** `~/.claude/argus/knowledge-deltas/<runId>/` — `delta.json`
(the agent's document) and `staged.json` (Argus's record, §12.13). Per run,
like the result file and the invocation directory — and pruned with the run,
like them; the ledger's own `deltas` record is what outlives pruning. Never
canonical; written with the same atomic writer.

**The retention rule, once:** heavy operational records (run json, log,
invocation directory, materialized context file, delta staging) are prunable;
small semantic provenance (claims, evidence, justifications, consumptions,
artifact productions, applied deltas, supplied contexts) is durable. §13.12
tabulates what that means for the context queries.

Why not the Vault: the Vault is documented as a **rebuildable read-side cache**
of execution history. It can be deleted and re-ingested from the run and
instance files, and it is allowed to be unavailable (no `node:sqlite`, a
read-only home) at the cost of a feature. Nothing can rebuild a claim graph;
the ledger _is_ the record. Making the cache the source of truth for the one
thing that cannot be recomputed would invert its documented failure model.

Why one document rather than a file per claim: every mutation is validated
against the whole graph (uniqueness, references, acyclicity, locator
agreement), and one atomic write is the simplest way to make "the graph I
validated against" and "the graph I wrote" the same graph. Volumes are modest;
correctness and a `cat`-able file come first. If the document ever needs to
grow past what one read per request tolerates, the kernel is unchanged — only
`store.ts` would learn to page or index.

The on-disk records carry **no derived state**: no `lifecycle`, no `support`,
no `truth`, no `currency`, no `impacted`. Every read surface derives them.

## 16. Important invariants

1. **Append-only.** No record is updated or deleted. A claim changes by
   revision; evidence, justifications, consumptions and artifact productions
   are only ever added.
2. **Revision identity everywhere.** Every edge names `(id, revision)`. A bare
   id in a URL or proposal resolves to the active revision at that moment and
   is stored resolved.
3. **Contiguous revisions.** Revisions of an id are 1..n; the highest is
   active; kind never changes across revisions.
4. **Nothing is retargeted.** A justification based on `RULE-17:v1` remains a
   justification based on `RULE-17:v1`; a run that consumed `RULE-17:v1`
   remains a consumer of `RULE-17:v1`.
5. **Referential integrity on write.** Evidence, justifications and
   consumptions may only name revisions that exist. Execution and artifact
   references are validated for shape and containment.
6. **Acyclic justification graph** over revision nodes, enforced on write;
   evaluation, traversal and impact analysis are cycle-safe regardless.
7. **Support is derived and deterministic.** One function, no model, no stored
   verdict. A superseded or non-supported premise never transmits support.
8. **Lifecycle ≠ support ≠ currency.** A superseded revision can be
   supported; an active one can be unsupported; a succeeded run can be stale.
9. **Impact is changed support.** A node is impacted only when holding the
   root would change its derived state; reachability alone is not impact.
10. **Producers are not consumers.** `producedBy` and consumption are distinct
    facts; impact lists consumers.
11. **Duplicate edges are no-ops.** Identity is `(runId, claim)` and
    `(runId, location, path)`; a repeat returns the original record.
12. **Agents propose, Argus applies.** Every write goes through
    `validate.ts` → `store.ts` → `kernel.ts`. Ids (unless validly proposed),
    revisions, timestamps and integrity are Argus's.
13. **Separate from execution.** No import from `knowledge/` into the
    DAG/engine; `PhaseProgress` and run records are never written by the
    ledger, and never read by it. The engine imports the ledger's store to
    commit deltas — the dependency points one way, and the pure transitions
    import nothing from it.
14. **Agents never write the ledger.** The only agent-facing surface is the
    per-run delta file. Canonical ids, revision numbers and provenance are
    refused in a proposal and assigned by Argus.
15. **A delta commits whole or not at all, at the phase's acceptance.** Staged
    is not canonical; a failed, revised, aborted or superseded attempt's deltas
    never enter the ledger; sibling deltas of one attempt commit as one
    transition; a stale precondition or a conflict refuses everything.
16. **Consumption is agent-declared, structurally verified.** Argus proves the
    reference; it does not claim to prove the reasoning.
17. **Artifact provenance is re-proven at commit.** What intake established
    about a declared artifact — a real root, a contained path, an existing
    file — is established again immediately before the canonical write, and a
    failure refuses the whole attempt's commit. Contents are never inspected.
18. **The delta channel is never exposed silently.** Under a capability
    profile the runtime answers whether `ARGUS_KNOWLEDGE_DELTA_FILE` is
    writable; an unwritable channel is on the invocation record, and refuses
    the launch when the phase declared it required (HARNESS.md §3a).
19. **Supplied ≠ consumed.** What Argus put in a run's context is recorded
    durably (`supplied[]`: exact refs, sha256) and never becomes a
    consumption; what the agent declares consumed is the only dependency edge,
    classified as `supplied-context` or `agent-discovered`. Impact reads
    consumptions only, and `executionProvenance` is not brought into being by
    supply alone.
20. **Exact revisions are supplied, from one snapshot.** An `active` selector
    is resolved when the phase attempt is planned and frozen; the file and
    the record name the exact revision, never "active". A later revision
    never alters a prepared run's context.
21. **The context file is Argus → agent, read-only.** It lives in the run's
    own invocation directory, is a `required` read channel, is made `0444`,
    and under Claude Code is denied for edits; a runtime that cannot make it
    readable refuses the launch under strict enforcement.
22. **Supplied provenance is durable and one-per-run.** It is written before
    the process exists, survives run and instance pruning, is idempotent on
    the run id, and fails closed on a conflicting claim list or hash. It
    attests supply for an attempted invocation, never that the process ran.
23. **The context file is verified before a completion is accepted.** The
    bytes must still hash to the recorded value; changed or missing bytes
    fail the step under `knowledge-context-integrity` before any delta is
    staged. A newer claim revision is **not** tampering: integrity asks
    whether the input changed, never whether the knowledge is still current.
24. **Unknown supply stays unknown.** `source` is set only from positive
    supplied-provenance evidence. Pre-Phase-4 records are never upgraded
    retrospectively, and supply is never inferred from prompts, phase
    relationships or claim production.
25. **Candidate is not canonical, and cannot leak.** Knowledge an agent
    proposes lives in a staged KnowledgeDelta beside its run. A downstream
    `fromPhases` selector resolves from `deltas[]` — the ledger's record of
    **applied** deltas — so a phase parked at its gate supplies nothing, by
    construction rather than by a check (§14.10).
26. **A discovered business rule is grounded or refused.** In discovery mode a
    proposed rule needs supporting evidence, and a rule _revision_ needs fresh
    evidence for its new statement: an agent may not revise a rule by
    rewording it (§14.5).
27. **Source evidence is checkable, twice.** A `source-code` path is
    repository-relative, inside the phase's declared scope, at the commit
    Argus recorded for the run, and points at a file that exists — verified at
    intake and again at the commit boundary. Fail-closed (§14.4).
28. **Argus validates structure; the reviewer decides meaning.** Nothing in
    discovery asks a model whether a path is safe, a range is valid or a rule
    is grounded — and nothing in Argus decides whether the code really encodes
    the rule the agent read out of it (§14.9).

## 17. What Phases 1–5 deliberately do NOT do

- **No automatic pipeline invalidation.** A superseded rule changes what
  `evaluateSupport` and `analyzeImpact` return; it does not touch any
  instance, phase or run.
- **No automatic re-execution or remediation.** Nothing re-runs a phase, edits
  a file or opens an issue because a premise changed. An `ImpactSet` is a
  report.
- **No inferred consumption.** Consumption and artifact production are
  registered explicitly. Nothing parses prompts, transcripts, artifact
  contents or embeddings, and no LLM is asked what a run relied on.
- **No autonomous knowledge mining.** Phase 5 added business-rule discovery,
  but every invocation is bounded by a declared scope, every candidate is
  reviewed, and nothing becomes canonical without a phase being accepted
  (§14.12 lists what discovery deliberately leaves out).
- **No semantic similarity anywhere.** Claim identity is exact. There are no
  embeddings, no vector search and no LLM adjudication of whether two rules
  are the same rule; global deduplication is a later problem.
- **No structured rule DSL.** `structuredValue` is stored opaquely (bounded at
  64 KiB) and never interpreted.
- **No content-addressed storage, artifact versioning, file repository, git
  abstraction or worktree management.** An artifact is a location, a path and
  optionally a commit, as produced by one run.
- **No ATMS, no assumption environments, no alternative worlds.** The
  "ifRootHeld" evaluation is a one-node assumption inside one pure function,
  not a world.
- **No confidence heuristics.** Impact is boolean per node, with a typed reason.
- **No autonomous contradiction resolution.** `contested` is reported, not
  resolved.
- **No graph visualization, no UI.** API and tests only.
- **No external source integrations.** `EvidenceSource` names Jira-shaped
  things through `document`; it does not talk to them.
- **No graph database, RDF, ontology framework or rules engine.**
- **No changes to `PhaseDef.needs`, routing or any execution semantics.** The
  knowledge commit is an extra rung on the acceptance ladder, not a route.
- **No automatic impact remediation.** After a delta commits, `analyzeImpact`
  can show the older runs and artifacts it affects. Phase 3 does not re-run
  them, revise phases, modify code, open remediation agents, resolve
  contradictions or alter any execution status. It ends at "new knowledge
  committed → the ImpactSet shows the consequences".
- **No automatic context selection.** Phase 4 supplies exactly what a step's
  author selected — exact or active revisions by claim id. No semantic
  search, embeddings, vector store, tag or domain filters, automatic
  graph-neighbourhood expansion, or LLM-chosen context.
- **No enforcement of "consume only what was supplied".** A
  consumed-but-not-supplied claim is recorded as `agent-discovered`, never
  refused.
- **No business-rule discovery, Jira ingestion, discovery agents or
  repository-wide extraction.** The context file is the delivery primitive
  those would build on; none of them exists.
- **No inferred deltas.** Nothing parses a transcript, a diff or a prompt into
  a delta. The agent writes the file or there is no delta.
- **No mutation API for supplied provenance.** Only Argus's own invocation
  lifecycle may assert what it supplied; there is no `POST` for it and no way
  for an agent or an operator to add, amend or delete one.
- **No retrospective supply.** A run that predates Phase 4.1 gains nothing on
  upgrade, and a consumption whose `source` is unknown stays unknown.
- **No context reconstruction.** Once the materialized projection has been
  pruned, the API reports it as unavailable. It never rebuilds the document
  from the current ledger and presents it as what the run received.
- **No staleness check at completion.** Integrity compares bytes. A newer
  revision of a supplied claim never fails a running step; semantic currency
  stays a derived read.

## 18. How this prepares the next steps

With Phase 4 the agent boundary is closed in both directions. A run's
semantic input is chosen by its author, resolved deterministically, delivered
read-only and recorded exactly; its semantic output is proposed through the
delta, validated, and committed at acceptance; and every consumption edge
says whether it fell inside or outside what Argus supplied. Phase 5 put that
boundary to work: a bounded repository investigation now produces candidate
business rules with checkable evidence, a person accepts or rejects them, and
the rules an accepted phase committed reach the phases that follow by exact
ref rather than by prose.

Phase 4.1 makes that boundary _trustworthy over time_: the supplied set is
durable rather than retention-bound, so the reasoning history survives the
logs; and the supplied bytes are verified at completion, so "Argus supplied
this" is a claim Argus can still stand behind after the agent has run. The
full model now reads end to end:

```
Knowledge Ledger
      ↓  selectors, one snapshot per phase attempt
KnowledgeContext            (projection; operational artifact, prunable)
      ↓  materialize, hash
durable supplied provenance (knowledge.json: exact refs + sha256; Argus-controlled)
      ↓  ARGUS_KNOWLEDGE_CONTEXT_FILE, read-only
Agent
      ↓  re-hash at completion: unchanged, or deterministic failure
declared consumption        (knowledge.json: agent-declared, classified against supply)
      ↓
KnowledgeDelta              (committed whole at phase acceptance)
```

The smallest coherent Phase 5 is **deterministic semantic context selection
and business-rule discovery orchestration**: a pipeline whose early phase is
allowed to _discover_ candidate business rules from repository evidence
(source, documents, tests) and propose them — through the existing
KnowledgeDelta, with `source-code` and `document` evidence, as ordinary
`business-rule` claims — while every downstream phase receives only
explicitly selected canonical knowledge through the KnowledgeContext. The
new work is orchestration and authoring: a way for a later step's spec to
select what an earlier step of the same instance created (the local-id →
canonical mapping already exists on the applied delta), and a review gate
between discovery and use. Nothing about the ledger, the delta or the context
primitive has to change for that; whether discovered rules are then
re-verified, contradicted or acted on remains a separate decision, and a
human's.

## 19. Where the code lives

| Path                                | Role                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/src/knowledge.ts`        | wire types: Claim, ClaimRef, Evidence, Justification, ClaimConsumption, ArtifactProduction, ExecutionProvenance, ImpactSet, SuppliedContext, ContextIntegrityResult                                                                                                                                                                                              |
| `server/src/knowledge/kernel.ts`    | pure transitions and queries; the only definition of support; the provenance transitions and `executionProvenance`                                                                                                                                                                                                                                               |
| `server/src/knowledge/impact.ts`    | `analyzeImpact` — the pure, deterministic impact algorithm                                                                                                                                                                                                                                                                                                       |
| `server/src/knowledge/validate.ts`  | untrusted body → typed proposal; the structural `source-code` evidence rules (repository-relative path, line range, commit sha)                                                                                                                                                                                                                                  |
| `server/src/knowledge/store.ts`     | the authoritative JSON document (v4); mints ids, stamps time, upgrades v1/v2/v3; `commitKnowledgeDeltas` and `registerSuppliedContext` under the ledger mutex                                                                                                                                                                                                    |
| `server/src/knowledge/delta.ts`     | the KnowledgeDelta protocol's pure half: `validateKnowledgeDelta`, `applyKnowledgeDeltas` (preflight + atomic application)                                                                                                                                                                                                                                       |
| `server/src/knowledge/staging.ts`   | per-run staging: the agent's file, Argus's record, status transitions                                                                                                                                                                                                                                                                                            |
| `server/src/knowledge/context.ts`   | the KnowledgeContext protocol: `parseKnowledgeContextSpec`, `resolveKnowledgeContext` (pure, one snapshot, `claims` + `fromPhases`), projection, hash, the per-run file, `verifyKnowledgeContextIntegrity`                                                                                                                                                       |
| `server/src/knowledge/discovery.ts` | business-rule discovery (Phase 5): `DISCOVERY_CONTRACT` and `discoveryInstruction`, the source-evidence checks, `semanticWarnings`, `checkDiscoveryDelta`, `previewKnowledgeDelta`, `summarizeDiscovery`                                                                                                                                                         |
| `server/src/harness/channels.ts`    | the Argus-owned invocation channels the delta file and the read-only context file are two of: kind, env var, path, access, required (HARNESS.md §3a)                                                                                                                                                                                                             |
| `server/src/knowledge/routes.ts`    | `/api/knowledge` (mounted and admin-gated in `app.ts`), including the delta inspection reads and the context reads (`/executions/:runId/context`, `/claims/:key/supplied-to`)                                                                                                                                                                                    |
| `server/src/pipelineTransitions.ts` | `succeedPhase` (the hold), `applyKnowledgeCommit` (the verdict), `stagedDeltaIds`                                                                                                                                                                                                                                                                                |
| `server/src/pipelineEngine.ts`      | `acceptCompletion`, `checkContextIntegrity`, `intakeKnowledgeDelta`, `verifyDeltaArtifacts`, `commitPhaseKnowledge`, `settleKnowledge`, `retireStagedDeltas`; `KNOWLEDGE_DELTA_CONTRACT`; the per-attempt ledger snapshot, `knowledgeContextInstruction`, `KNOWLEDGE_CONTEXT_CONTRACT`; the discovery checks at intake and commit, and `refreshDiscoverySummary` |
| `server/src/sources/artifacts.ts`   | the gate review, including the candidate-knowledge previews a discovery phase's reviewer reads                                                                                                                                                                                                                                                                   |
| `web/src/views/GateDrawer.tsx`      | the one place a human decides on a gate; the Candidate knowledge panel (rules, revisions, evidence, warnings)                                                                                                                                                                                                                                                    |
| `server/src/knowledge/*.test.ts`    | kernel semantics, impact scenarios, persistence roundtrip, HTTP contract, delta validation/application, engine lifecycle, context resolution and delivery; `contextDurability.test.ts` for durable supply, retention and integrity; `discovery.test.ts` and `discoveryEngine.test.ts` for Phase 5                                                                |
| `docs/API.md` § Knowledge Ledger    | endpoint reference                                                                                                                                                                                                                                                                                                                                               |
