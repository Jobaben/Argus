# The Knowledge Ledger — semantic provenance for Argus

_Phase 1: the semantic kernel and its persistence model. Phase 2: the
execution provenance bridge and deterministic impact analysis._

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
  | { type: "source-code"; path; line?; gitHead? }
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

## 12. Persistence

**Authoritative store:** `~/.claude/argus/knowledge.json`, one JSON document:

```json
{ "version": 2, "claims": [...], "evidence": [...], "justifications": [...], "consumptions": [...], "artifacts": [...] }
```

Written through the same discipline as `pipelines.json` and `schedules.json`:
a whole-document read-modify-write serialized by a keyed mutex, persisted via
the atomic tmp+rename writer, and **refusing to overwrite** a file it cannot
parse or that carries an unknown version. A refused transition writes nothing.
Concurrent proposals see each other's records, so the second of two identical
claim ids is refused rather than duplicated.

**Version 2** (Phase 2) added the two provenance arrays. A version 1 file is
read as version 2 with empty arrays and is rewritten in that shape by the next
successful transition — nothing Phase 1 recorded changes, and reading alone
never writes. Any other version is treated as foreign: readable as empty,
never overwritten.

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

## 13. Important invariants

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
13. **Separate from execution.** No import in either direction between
    `knowledge/` and the DAG/engine; `PhaseProgress` and run records are never
    written by the ledger, and never read by it.

## 14. What Phases 1 and 2 deliberately do NOT do

- **No automatic pipeline invalidation.** A superseded rule changes what
  `evaluateSupport` and `analyzeImpact` return; it does not touch any
  instance, phase or run.
- **No automatic re-execution or remediation.** Nothing re-runs a phase, edits
  a file or opens an issue because a premise changed. An `ImpactSet` is a
  report.
- **No inferred consumption.** Consumption and artifact production are
  registered explicitly. Nothing parses prompts, transcripts, artifact
  contents or embeddings, and no LLM is asked what a run relied on.
- **No extraction agents, no business-rule discovery.** The `POST`s are the
  proposal vocabulary an agent will use; no agent uses them yet.
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
- **No changes to `PhaseDef.needs`, routing or any execution semantics.**

## 15. How this prepares the next steps

Everything a trustworthy semantic feedback loop needs to _compute_ now exists,
and none of it depends on a model: exact provenance in both directions, a
derived notion of currency, and an impact set with machine-readable reasons
and paths. What is missing is the trusted way for **agents** to put facts into
the ledger.

The smallest coherent Phase 3 is therefore a typed **`KnowledgeDelta`**
protocol: a single validated document an agent step may emit alongside its
result — proposed claims and revisions, evidence, justifications, and the
exact revisions it consumed and artifacts it produced — which Argus checks
against the ledger (references, cycles, locator agreement, the run it actually
came from) and applies deterministically through the existing transitions, or
refuses as a whole. That gives every run a way to declare its premises without
Argus guessing at them, at which point `executionProvenance` and
`analyzeImpact` stop being operator tools and start being the pipeline's own
memory of why it did what it did. Whether Argus then offers a re-run, opens an
issue, or marks a phase for review remains a separate decision, and because
the phase record and the ledger are separate, it can be made without rewriting
either.

## 16. Where the code lives

| Path                               | Role                                                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `contracts/src/knowledge.ts`       | wire types: Claim, ClaimRef, Evidence, Justification, ClaimConsumption, ArtifactProduction, ExecutionProvenance, ImpactSet |
| `server/src/knowledge/kernel.ts`   | pure transitions and queries; the only definition of support; the provenance transitions and `executionProvenance`         |
| `server/src/knowledge/impact.ts`   | `analyzeImpact` — the pure, deterministic impact algorithm                                                                 |
| `server/src/knowledge/validate.ts` | untrusted body → typed proposal (the future agent boundary)                                                                |
| `server/src/knowledge/store.ts`    | the authoritative JSON document (v2); mints ids, stamps time, upgrades v1                                                  |
| `server/src/knowledge/routes.ts`   | `/api/knowledge` (mounted and admin-gated in `app.ts`)                                                                     |
| `server/src/knowledge/*.test.ts`   | kernel semantics, impact scenarios, persistence roundtrip, HTTP contract                                                   |
| `docs/API.md` § Knowledge Ledger   | endpoint reference                                                                                                         |
