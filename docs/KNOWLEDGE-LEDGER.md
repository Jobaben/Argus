# The Knowledge Ledger — semantic provenance for Argus

_Phase 1: the semantic kernel and its persistence model. Phase 2: the
execution provenance bridge and deterministic impact analysis. Phase 3: the
KnowledgeDelta protocol — how agent executions propose knowledge and how Argus
alone validates and commits it._

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
is _structurally valid, agent-declared_ semantic dependency. A later phase can
make consumption more deterministic by controlling the semantic context Argus
supplies to an invocation and recording exactly what was supplied.

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

## 13. Persistence

**Authoritative store:** `~/.claude/argus/knowledge.json`, one JSON document:

```json
{ "version": 3, "claims": [...], "evidence": [...], "justifications": [...], "consumptions": [...], "artifacts": [...], "deltas": [...] }
```

Written through the same discipline as `pipelines.json` and `schedules.json`:
a whole-document read-modify-write serialized by a keyed mutex, persisted via
the atomic tmp+rename writer, and **refusing to overwrite** a file it cannot
parse or that carries an unknown version. A refused transition writes nothing.
Concurrent proposals see each other's records, so the second of two identical
claim ids is refused rather than duplicated.

**Version 2** (Phase 2) added the two provenance arrays; **version 3** (Phase 3) added `deltas`, the ledger's own record of every KnowledgeDelta it applied.
A version 1 or 2 file is read as version 3 with the missing arrays empty and is
rewritten in that shape by the next successful transition — nothing an earlier
phase recorded changes, and reading alone never writes. Any other version is
treated as foreign: readable as empty, never overwritten.

**Staging store:** `~/.claude/argus/knowledge-deltas/<runId>/` — `delta.json`
(the agent's document) and `staged.json` (Argus's record, §12.13). Per run,
like the result file and the invocation directory — and pruned with the run,
like them; the ledger's own `deltas` record is what outlives pruning. Never
canonical; written with the same atomic writer.

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

## 14. Important invariants

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

## 15. What Phases 1–3 deliberately do NOT do

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
- **No changes to `PhaseDef.needs`, routing or any execution semantics.** The
  knowledge commit is an extra rung on the acceptance ladder, not a route.
- **No automatic impact remediation.** After a delta commits, `analyzeImpact`
  can show the older runs and artifacts it affects. Phase 3 does not re-run
  them, revise phases, modify code, open remediation agents, resolve
  contradictions or alter any execution status. It ends at "new knowledge
  committed → the ImpactSet shows the consequences".
- **No semantic context delivery.** Argus does not yet choose which claims an
  agent should read, materialize them, or record what it supplied; a
  `consumed` entry is the agent's declaration.
- **No inferred deltas.** Nothing parses a transcript, a diff or a prompt into
  a delta. The agent writes the file or there is no delta.

## 16. How this prepares the next steps

With Phase 3, every run has a trusted way to put facts into the ledger, and
every fact in the ledger can be traced back to the delta and the run that
proposed it. `executionProvenance` and `analyzeImpact` are now fed by the
pipeline itself rather than by an operator. What remains soft is the _input_
side: an agent declares what it consumed, but Argus did not choose what it
read.

The smallest coherent Phase 4 is therefore **controlled semantic context
delivery**: Argus selects the exact claim revisions relevant to an agent task
(by kind, by explicit reference from the phase definition, by the phase's
declared dependencies), materializes them as a machine-readable context file
beside the run — the mirror image of the delta file — and records which
revisions were supplied to the invocation. Consumption then has a
deterministic floor ("the run was given exactly these revisions") that the
agent's declaration refines rather than invents, and a revision proposal can
be checked against what the run was actually shown. Business-rule discovery —
an agent proposing `business-rule` claims from a repository — becomes a
pipeline authored on top of the protocol that already exists, not a new
mechanism. Whether Argus then offers a re-run, opens an issue, or marks a phase
for review remains a separate decision, and because the phase record and the
ledger are separate, it can be made without rewriting either.

## 17. Where the code lives

| Path                                | Role                                                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/src/knowledge.ts`        | wire types: Claim, ClaimRef, Evidence, Justification, ClaimConsumption, ArtifactProduction, ExecutionProvenance, ImpactSet                  |
| `server/src/knowledge/kernel.ts`    | pure transitions and queries; the only definition of support; the provenance transitions and `executionProvenance`                          |
| `server/src/knowledge/impact.ts`    | `analyzeImpact` — the pure, deterministic impact algorithm                                                                                  |
| `server/src/knowledge/validate.ts`  | untrusted body → typed proposal (the future agent boundary)                                                                                 |
| `server/src/knowledge/store.ts`     | the authoritative JSON document (v3); mints ids, stamps time, upgrades v1/v2; `commitKnowledgeDeltas` under the ledger mutex                |
| `server/src/knowledge/delta.ts`     | the KnowledgeDelta protocol's pure half: `validateKnowledgeDelta`, `applyKnowledgeDeltas` (preflight + atomic application)                  |
| `server/src/knowledge/staging.ts`   | per-run staging: the agent's file, Argus's record, status transitions                                                                       |
| `server/src/harness/channels.ts`    | the Argus-owned invocation channels the delta file is one of: kind, env var, path, access, required (HARNESS.md §3a)                        |
| `server/src/knowledge/routes.ts`    | `/api/knowledge` (mounted and admin-gated in `app.ts`), including the delta inspection reads                                                |
| `server/src/pipelineTransitions.ts` | `succeedPhase` (the hold), `applyKnowledgeCommit` (the verdict), `stagedDeltaIds`                                                           |
| `server/src/pipelineEngine.ts`      | `intakeKnowledgeDelta`, `verifyDeltaArtifacts`, `commitPhaseKnowledge`, `settleKnowledge`, `retireStagedDeltas`; `KNOWLEDGE_DELTA_CONTRACT` |
| `server/src/knowledge/*.test.ts`    | kernel semantics, impact scenarios, persistence roundtrip, HTTP contract, delta validation/application, engine lifecycle                    |
| `docs/API.md` § Knowledge Ledger    | endpoint reference                                                                                                                          |
