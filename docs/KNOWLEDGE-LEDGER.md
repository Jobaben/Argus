# The Knowledge Ledger — semantic provenance for Argus

_Phase 1: the semantic kernel and its persistence model. Phase 2: the
execution provenance bridge and deterministic impact analysis. Phase 3: the
KnowledgeDelta protocol — how agent executions propose knowledge and how Argus
alone validates and commits it. Phase 4: the KnowledgeContext protocol —
how Argus supplies exact canonical knowledge to an execution and records what
it supplied, independently of what the agent later declares it consumed.
Phase 5: business-rule discovery orchestration — how a bounded repository
investigation becomes candidate knowledge, how a person reviews it, and how
the rules it establishes reach the phases that follow. Phase 6: business-rule
verification and implementation conformance — whether the code at one exact
repository revision does what one exact rule revision says, recorded as its
own append-only dimension and kept rigorously apart from whether the rule
itself is well founded. Phase 7: change-intent orchestration — a requested
business change becomes a structured, reviewable semantic transition. Phase 8:
targeted implementation and closed-loop realization — an accepted change is
implemented against exact semantic intent, verified on four independent
dimensions at one proven repository state, and selectively remediated until it
is realized or a bounded loop ends with the exact criteria that remain unmet._

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
  id: string; // logical identity: RULE-17, or RULE-17.4f3a9c17 when scoped (§3a)
  revision: number; // 1..n, no gaps
  scope?: { projectId: string; repositoryId: string }; // who owns it (§3a)
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

## 3a. Knowledge scope — who owns a claim

Argus keeps **one** ledger and runs pipelines against **many** unrelated
projects. Those two facts are only compatible if retrieval is isolated by
default, so a run working in one repository cannot traverse, materialize or be
handed another's knowledge. A `KnowledgeScope` is that boundary:

```ts
interface KnowledgeScope {
  projectId: string; // declared: only a person knows two repos are one product
  repositoryId: string; // declared, else derived — never a filesystem path
}
```

**It is not a path, and it is not a repository state.** `C:\src\Kobra`,
`/home/u/src/Kobra` and a `/worktrees/poc` worktree are three checkouts of one
logical repository and resolve to one `repositoryId`. A `RepositoryStateRef`
(§17) says _which commit and working tree an observation examined_; a scope
says _which repository the knowledge is about_. A rule outlives every commit of
it. Nor is it pipeline topology: two pipelines against one repository share one
scope, and the pipeline that happened to discover a claim never owns it.

### Deriving repository identity

`repositoryId` is declared when the author knows it, and otherwise derived from
the phase's working tree, in this order and from nothing else:

| source                         | identity                    | identical across        |
| ------------------------------ | --------------------------- | ----------------------- |
| normalized `origin` remote     | `git:github.com/acme/kobra` | clones, worktrees, OSes |
| root commit (no usable remote) | `commit:<sha>`              | clones, worktrees       |
| neither                        | **refused**                 | —                       |

Every spelling of one remote collapses to one answer — `https://…/Acme/Kobra.git`,
`git@github.com:Acme/Kobra.git` and `ssh://git@github.com:22/Acme/Kobra` are the
same repository. A _path-shaped_ remote (`/srv/git/kobra.git`) is deliberately
refused and falls through to the root commit, because a path is exactly what
must not become identity. A tree that answers neither fails the phase as a
`configuration` error naming the fix — Argus never scopes a project's knowledge
to whatever the checkout happened to be called.

### Scope-qualified claim ids

Every edge in the ledger — `Evidence.claim`, `Justification.premises`,
`ClaimConsumption.claim`, `RuleVerification.rule`,
`AcceptedChangeProposal.semanticChanges` — names a bare `ClaimRef`. If ids were
unique only _within_ a scope, every one of those refs would become ambiguous and
the graph would have to carry a scope on each edge.

So the scope is folded into the canonical id instead: `RULE-42` created in scope
S becomes `RULE-42.<8 hex of S>`. Two unrelated repositories can each hold a
`RULE-42`; ids stay globally unique; and **every existing ref-keyed lookup is
already isolated** — `evidenceOf`, `verificationsOfClaim`, `consumersOf`,
`supportReport`, `ruleConformance` and `changeProposalOfClaim` needed no
change. The stored `scope` remains the authoritative, queryable ownership; the
token is a naming device and never the thing a scope check reads.

```
Project A            Project B
  RULE-42.4f3a9c17     RULE-42.623ce8f9      two claims, one name
```

A revision **inherits** its claim's scope from the revision it supersedes, so
`RULE-42:v2` belongs to whoever `RULE-42:v1` belonged to and a claim can never
be moved between projects.

### The invariant

> A pipeline execution observes knowledge within its resolved project and
> repository scope, unless a broader scope was explicitly declared and
> authorized.

Enforced in four places, each fail-closed:

| where                        | rule                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveKnowledgeContext`    | a selector resolves in the run's own scope first; an id owned by an unauthorized scope is `out-of-scope`, **never** a fallback to the global record |
| `applyKnowledgeDeltas`       | a run may **write** only to its own scope, and **read** only its own plus `alsoRead`                                                                |
| `addJustification`           | a derivation may not cross a scope — which is what keeps support evaluation and impact analysis partitioned                                         |
| the engine's `changeContext` | a phase may not receive the accepted intent of a differently-scoped phase of the same instance                                                      |

### Declaring it

```json
{
  "knowledgeScope": {
    "projectId": "motorit",
    "repositoryId": "git:github.com/motorit/online",
    "alsoRead": [{ "projectId": "acme", "repositoryId": "git:github.com/acme/kobra" }]
  }
}
```

On the pipeline, or on a phase that works in a different repository (a phase
override _replaces_ the pipeline's, exactly as a workspace policy does). The
resolved scope is **frozen on the phase attempt** (`PhaseProgress.knowledgeScope`)
before a single run is planned, so editing the pipeline — or moving the
checkout — while an instance runs can never retarget ownership of knowledge it
already wrote.

`alsoRead` is the only route by which one project's run may name another's
knowledge. It grants **reading**, never writing: a run may declare it consumed
an authorized foreign revision, and still may not revise it, attach evidence to
it, or derive from it.

### Absent means unknown

A claim written before scopes existed, or by a pipeline that declares none, has
**no** scope. Argus does not guess: the ledger records no repository against a
claim, so there is nothing to infer from. The consequences are explicit:

- an unscoped pipeline reads and writes unscoped records exactly as it always
  did — nothing about its behaviour changes;
- a scoped pipeline **cannot resolve an unscoped claim at all** (`out-of-scope`,
  never the record), and an unscoped one cannot reach a scoped claim by naming
  its canonical id either;
- an operator who _does_ know the ownership states it by re-running discovery
  under a declared scope, which creates properly scoped claims.

Nothing rewrites history to pretend the ownership was always known.

### Retrieval, not filtering

Scope is the **first lookup dimension**, not a filter over a whole-ledger scan.
`scope.ts` builds a scope index — claims, evidence and justifications keyed by
scope — lazily and once per ledger snapshot, cached in a `WeakMap` against the
snapshot object (ledger snapshots are immutable, so a cached index can never
describe a document that has moved on). `analyzeImpact` takes its claim and
justification lists from that index, so an unrelated project's records are
never visited at all:

```
shared authoritative ledger
      ↓ scope index (O(1) after one pass per snapshot)
scope-aware retrieval
      ↓ bounded traversal: analyzeImpact walks one scope by default
small KnowledgeContext
      ↓ filtered before materialization
agent
```

The agent is never asked to ignore irrelevant knowledge; it never receives any.

### Query surfaces

| route                                           | default               | scoped by                                                                |
| ----------------------------------------------- | --------------------- | ------------------------------------------------------------------------ |
| `GET /claims`                                   | whole ledger          | `?project=&repository=`                                                  |
| `GET /claims/:key` (and every claim-keyed read) | key as written        | `?project=&repository=`, which also lets `RULE-42` mean _that project's_ |
| `GET /claims/:key/impact`                       | the claim's own scope | `?traverse=ledger` for the explicit broader question                     |
| `GET /change-proposals`                         | whole ledger          | `?project=&repository=`                                                  |

These are operator surfaces — no agent reads them — so "everything" stays
available and is simply never what a pipeline sees. `project` and `repository`
must be given **together**: a half-named scope is a different scope, not a
broader one, so it is a 400.

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
| `ARGUS_KNOWLEDGE_DELTA_FILE` | `~/.claude-argus/knowledge-deltas/<runId>/delta.json` |

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

## 15. Business-rule verification and implementation conformance (Phase 6)

Phase 5 answered _what rules does this organization have, and what grounds
them?_. Phase 6 answers a different question about the same rules:

> Does the implementation at a particular repository revision satisfy the exact
> canonical business rules it is supposed to satisfy?

The two questions are answered by two separate models, and **keeping them
separate is the whole of Phase 6**:

```
RULE SUPPORT                        IMPLEMENTATION CONFORMANCE
is the rule itself well founded?    does the code do what the rule says?

derived from evidence and           a RuleVerification record bound to one
justifications; never stored;       exact ClaimRef and one exact gitHead;
never set by an agent               appended, never derived, never inferred

GET /claims/:key/support            GET /claims/:key/conformance
```

### 15.1 The critical invariant: a violation is not a doubt

A rule may be perfectly well founded and the code may not do it. That is the
ordinary state of a bug:

```
RULE-42:v1  "Kobra customer comments must not exceed 180 characters."
            support   = supported          ← the business really does say 180
            lifecycle = active

implementation permits 500

RULE-42:v1  conformance @abc123 = violated ← the code is in breach
            support                        = supported   (unchanged)
```

Recording that violation as **opposing evidence** on `RULE-42:v1` would be
wrong in a way that spreads. It would make the rule read `contested` — "we are
no longer sure the business has this rule" — which is false; and `contested`
then propagates through every justification that has the rule as a premise,
through `analyzeImpact`, and into the currency of every run that consumed it.
One failing test would quietly put a domain in doubt.

So a verification never touches claim support:

- it creates no `Evidence`, no `Justification` and no `Claim`;
- `recordRuleVerification` appends to exactly one array (`verifications[]`),
  and support evaluation never reads that array;
- `analyzeImpact` does not see verifications at all (§15.11).

One more path is closed explicitly. A verification run is still an ordinary
run and may write a KnowledgeDelta if it genuinely learned something durable —
but on a `ruleVerification` phase, a delta that attaches **opposing** evidence
to (or justifies against) one of the exact rules the run was supplied to verify
is refused. Narrow on purpose: it says nothing about opposing evidence in
general, which stays a legitimate Phase 1 concept, and nothing about rules this
run was not asked about. It closes the single structural path by which a
failing test could turn a supported rule `contested`.

This is enforced structurally rather than by convention, and asserted directly:
`verificationEngine.test.ts` → _"MANDATORY REGRESSION: a violated
implementation does not contest the rule"_ drives the whole engine path and
then checks that the ledger's `claims`, `evidence` and `justifications` arrays
are byte-identical to what they were before.

### 15.2 The outcomes

Three, deliberately. No confidence score, no fourth hedging value.

| Outcome        | Means                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `holds`        | The verifier obtained sufficient implementation or test evidence to conclude the examined implementation satisfies the rule under the authored criteria. |
| `violated`     | The verifier obtained sufficient evidence that the examined implementation contradicts the rule.                                                         |
| `unverifiable` | The verifier could not deterministically establish either outcome from the available implementation and test evidence. Requires a reason.                |

And a fourth value exists only in the **read model**, never in a record:

| Status       | Means                                                                         |
| ------------ | ----------------------------------------------------------------------------- |
| `unverified` | No accepted verification exists for the scope asked about. **Nobody looked.** |

`unverified` and `unverifiable` are never collapsed. Reporting the first as the
second claims an investigation that never happened; reporting the second as the
first loses one. Many business rules have no executable expression at all —
`unverifiable` exists so that fact is recorded rather than laundered into
`holds`, and the agent contract says so in as many words.

### 15.3 The durable record

`RuleVerification`, in `knowledge.json` beside the other semantic provenance
(ledger **version 5**):

```ts
interface RuleVerification {
  id: string;
  rule: ClaimRef; // always exact: RULE-42:v1, never a bare id
  outcome: "holds" | "violated" | "unverifiable";
  execution: RunExecutionRef; // the run that performed it
  attempt?: number;
  repository?: { gitHead: string }; // Argus's recorded head, not the agent's claim
  evidence: VerificationEvidence[];
  reason?: string; // required for `unverifiable`
  note?: string;
  policy?: "agent-evidence" | "deterministic-check"; // what `holds` required
  createdAt: string;
}
```

Identity is `(execution.runId, rule)` — one run verifies one rule once.
Recording the identical result again is a no-op, which is what makes committing
again after a crash safe; recording a _different_ outcome for the same pair is
refused rather than overwriting a past conclusion.

**Two bindings, neither ever retargeted.** A verification of `RULE-42:v1` says
nothing about `RULE-42:v2`, and `holds at abc123` says nothing about `def456`.
Both are §15.9.

### 15.4 Verification evidence

A separate union from `EvidenceSource`, on purpose: rule-support evidence and
implementation-conformance evidence answer different questions and must never
be mistaken for one another.

| Kind          | What it is                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| `check`       | A deterministic `PhaseCheck` of the verifying phase, cited **by label**. Argus binds the outcome (§15.7).          |
| `source-code` | The Phase 5 `SourceCodeEvidence` shape, reused as-is: path, commit, symbol, line range. Provenance, never content. |
| `artifact`    | A file the phase produced — a test report, a generated analysis. An `ArtifactRef`, not a copy.                     |
| `observation` | The verifier's own reading, where no deterministic check can express the link. The weakest kind.                   |

No test output and no source text ever enters the ledger. A rule verified
against a 40 000-line test log costs a label and an exit code.

### 15.5 Authoring a verification phase

There is deliberately **no second rule-selection mechanism**. The rules a
verification phase is accountable for are exactly the ones its
`knowledgeContext` supplied (§13) — explicit claims, `active` selectors,
`fromPhases`, an accepted discovery phase's output. That mechanism already
resolves against one snapshot, already records durably what was supplied, and
already refuses to float onto a newer revision.

So the phase-level declaration says only _this phase must produce structured
conformance results_:

```json
{
  "id": "verify-rules",
  "name": "Verify rules",
  "gated": true,
  "steps": [{ "name": "verify", "prompt": "Check the implementation." }],
  "knowledgeContext": { "fromPhases": [{ "phaseId": "discover", "kinds": ["business-rule"] }] },
  "ruleVerification": { "holds": "deterministic-check" },
  "checks": [{ "kind": "command", "run": "dotnet test", "label": "comment-length-tests" }]
}
```

| Field   | Meaning                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| `kinds` | Which supplied claim kinds need an outcome. Default `["business-rule"]`: a fact is context to reason _with_. |
| `holds` | `agent-evidence` (default) or `deterministic-check`. §15.8.                                                  |
| `note`  | One author-written sentence narrowing what "conforms" means here.                                            |

`ruleVerification` absent = an ordinary phase, behaving in every respect
exactly as before Phase 6 existed.

### 15.6 The protocol

Its own Argus-owned sidecar, `ARGUS_RULE_VERIFICATION_FILE`, delivered through
the Phase 3.1 channel model (HARNESS.md §3a) as a `required` write channel — it
is the phase's output, not an optional proposal, so a runtime that cannot make
it writable refuses the launch under strict enforcement.

Deliberately **not** the KnowledgeDelta. A delta proposes new canonical
semantics; a verification report describes the relationship between an
implementation and semantics that already exist. Sharing the channel would have
made every conformance result look like a knowledge mutation — and the first
thing an agent reaches for then is opposing evidence on the rule, which is
exactly §15.1. A run may of course write both files: a verification phase that
also learns something durable proposes it through the delta, as any phase does.

```
KnowledgeContext (exact rules)
      ↓  ARGUS_KNOWLEDGE_CONTEXT_FILE, read-only
verification agent
      ↓  ARGUS_RULE_VERIFICATION_FILE
structured verification proposal
      ↓  parse, validate, completeness, check references, source evidence
staged record (rule-verifications/<runId>/staged.json — NOT canonical)
      ↓  the phase's deterministic PhaseChecks
      ↓  the gate, when configured
      ↓  phase acceptance
durable RuleVerification records (knowledge.json)
```

The document:

```json
{
  "schemaVersion": 1,
  "verifications": [
    {
      "rule": "RULE-42:v1",
      "outcome": "violated",
      "evidence": [
        { "type": "check", "label": "comment-length-tests" },
        {
          "type": "source-code",
          "path": "src/Booking/KobraCommentValidator.cs",
          "startLine": 3,
          "endLine": 6
        }
      ],
      "note": "MaxLength is 500"
    }
  ],
  "metadata": { "summary": "One rule checked against the Kobra adapter." }
}
```

### 15.7 What Argus validates

The agent performs semantic interpretation — deciding that
`if (comment.Length > 180)` implements "customer comments max 180" needs a
model, and Argus has no way to do it. Everything around that judgement is
Argus's, and is decided from structured data alone:

1. **Completeness.** `selected = holds ∪ violated ∪ unverifiable`, each rule
   exactly once. A **missing** rule refuses the whole document (silent omission
   would read as though a rule had been considered when it had not — say
   `unverifiable` instead). An **extra** rule refuses it too: a result about
   something this run was never given is unaccountable. A verification phase
   that was supplied rules and wrote **no file at all** fails the step; "no
   file" is not "nothing proposed" here.
2. **Exact revision.** `rule` must be `ID:vN`; a bare id is refused before
   anything is staged, and the ref must resolve in the ledger.
3. **Evidence floors.** `holds` and `violated` must cite at least one evidence
   record; `unverifiable` must give a reason. "It holds because I say so" is
   refused under every policy.
4. **Check references.** A cited `check` label must be one the phase's own
   `checks` declare — decided from the phase definition at intake, so a forged
   reference is refused long before anybody reads an outcome backed by a test
   that does not exist. At the commit boundary the label is bound to the
   phase's `VerificationReport`: `status`, `exitCode` and `detail` come from
   the run **Argus** performed. Any `status` the agent wrote is stripped at
   validation; a cited check absent from the report refuses the commit.
5. **Source evidence.** Repository-relative, inside the run's working tree
   through every symlink on the way (§15.13), at the commit Argus recorded.
6. **No contamination through the delta channel.** On a `ruleVerification`
   phase, a KnowledgeDelta opposing one of the supplied rules is refused
   (§15.1).
7. **Everything owned.** Ids, timestamps, the execution identity, the
   repository revision, persistence and the acceptance boundary.

A structured result is not a proof. Argus validates the _shape and the
references_ of a semantic judgement; it does not establish that the code and the
sentence mean the same thing. That is why a verification phase is normally
gated.

### 15.8 The `holds` policy

Minimal, two values:

- **`agent-evidence`** (default) — `holds` needs at least one concrete cited
  evidence record of any kind.
- **`deterministic-check`** — additionally, `holds` must cite a `check` of this
  phase, **and that check must have passed** when Argus binds it. A rule with no
  executable expression then comes back `unverifiable`, which is the honest
  answer.

This is what lets a later reader distinguish

```
agent says it holds
```

from

```
agent says it holds AND comment-length-tests exited 0
```

`violated` always requires cited evidence and `unverifiable` always requires a
reason, under both policies. Not every rule needs a dedicated executable test —
`unverifiable` exists precisely because many will never have one.

### 15.9 Currency is derived, never written back

Nothing is ever marked stale. A verification can be superseded in two
independent ways, and both are answered by asking a _scoped_ question:

**The rule changed.**

```
RULE-42:v1  verified holds        → stays holds, historically, forever
RULE-42:v2  created               → unverified, until somebody verifies v2
```

**The implementation changed.**

```
RULE-42:v1 @ abc123  holds        → stays holds at abc123
RULE-42:v1 @ def456               → unverified, until somebody verifies def456
```

`ruleConformance(rule, gitHead?)` is the read model:

- **with** `gitHead` — only verifications that examined that commit are
  eligible. An abbreviated sha matches a full one.
- **without** `gitHead` — the latest recorded outcome for the revision, with
  `latest.repository.gitHead` saying which commit it was about. That is a
  statement about the past, which is the only kind of statement the record
  supports.

So Argus never says _"the current implementation holds"_ on the strength of an
older commit. It says:

```
last verified holds at abc123
current HEAD (def456) unverified
```

`history` is always the full, unfiltered history of the revision, oldest first,
however the question was scoped. Several repository revisions coexist:

```
RULE-42:v1  @X → holds     @Y → violated     @Z → holds
```

### 15.10 Staging, atomicity and attempt isolation

Identical discipline to the KnowledgeDelta, on its own channel:

- a proposal is **staged beside its run** (`rule-verifications/<runId>/`), never
  in `knowledge.json`;
- it becomes durable only when the phase crosses its acceptance boundary —
  checks passed, gate approved;
- a retry, a revise, an abort or a lost candidate selection **supersedes** the
  attempt's records, which can never become durable afterwards;
- a phase that verifies ten rules commits all ten **in one ledger transition**
  or none of them. `commitPhaseSemantics` applies the attempt's deltas and its
  verifications inside a single `mutateLedger`, so a phase that both revises a
  rule and verifies one leaves the two facts either both durable or neither;
- the commit is idempotent on `(runId, rule)`, so a crash between the ledger
  write and the instance write is healed by committing again;
- a refusal anywhere — a forged check label, a cited check the report does not
  contain, an unsatisfied `holds` policy, a rule the ledger no longer holds —
  refuses the whole attempt before the ledger is touched, and fails the phase
  under the `rule-verification` failure class.

### 15.11 ImpactSet is unchanged

`analyzeImpact` means exactly what it meant in Phase 2: semantic dependency
impact. A rule revision still finds the decisions, consumer executions and
artifacts that rest on it. Phase 6 adds a **separate dimension** and deliberately
does not join them:

- verifications are not semantic dependents — a verification does not _rest on_
  the rule in the justification sense, and making it a dependent would have put
  conformance results into an `ImpactSet` whose whole meaning is changed
  support;
- `ledger.verifications` is read by the conformance queries and by nothing else.

"Which verification results are associated with `RULE-42:v1`?" is answerable —
`verificationsOfClaim`, `GET /claims/RULE-42:v1/verifications` — and when
`RULE-42:v2` appears it simply has none yet.

### 15.12 The review surface

A gated verification phase's `PhaseReview` carries `ruleVerifications` — one
preview per step that wrote a report — and the phase's counts. The GateDrawer
renders them grouped, compactly, with no transcript involved:

```
Business-rule verification
1 holds · 1 violated · 1 unverifiable · at abc123de
Nothing here is durable yet; approving records it against these exact rule revisions.

HOLDS (1)
  holds      RULE-9:v2     rule: supported
  External bookings require a CRM id
  ✓ check: crm-id-tests (passed, exit 0)

VIOLATED (1)
  violated   RULE-42:v1    rule: supported
  Kobra customer comments must not exceed 180 characters
  MaxLength is 500
  ✓ src/Booking/KobraCommentValidator.cs:3-6

UNVERIFIABLE (1)
  unverifiable  RULE-51:v1
  Refunds are approved by a manager
  no code path in this repository expresses manager approval
```

Every row shows the rule's **own support** beside the outcome. That is not
decoration: a reviewer who could see only `VIOLATED` would eventually start
"fixing" rules whose implementations were merely in breach. A selected rule with
no submitted outcome is named outright rather than being absent.

### 15.13 Source-evidence containment, hardened

Phase 5 checked repository containment **lexically**: relative path, no `..`,
and `path.resolve(root, …)` under `root`. Necessary, not sufficient — a
repository may contain a symlink of its own:

```
src/Booking/Escape.cs → /somewhere/outside/secrets.txt
```

Every lexical rule passes and the file `stat`s happily, so a rule could be
recorded with durable evidence pointing at a file that is not in the repository
and not at the commit the evidence claims. Nothing in Argus copies that file's
contents anywhere, so this is a containment bug rather than a disclosure one —
but the record would be a lie.

Containment is now decided on the **resolved real path**
(`knowledge/sourcePath.ts`): `realpath(candidate)` must stay inside
`realpath(root)`. `realpath` resolves intermediate symlinks too, so
`scope/link/inner.cs` fails as well. A repository reached _through_ a symlink is
still its own root, because the root is resolved the same way. Where `realpath`
cannot be taken the path is reported `missing` rather than `unsafe`: Argus
refuses what it can disprove and reports what it merely cannot confirm.

The rule applies to every repository source-code evidence record Argus
validates deterministically — discovery evidence (§14.4) and verification
evidence alike.

### 15.14 The worked example, Phase 6

`harness/verificationE2e.test.ts`, with real child processes, the real Stop
hook and a real git repository:

```
RULE-42:v1  "Kobra customer comments must not exceed 180 characters."   support = supported

KobraCommentValidator.cs: MaxLength = 180      commit abc123
  → verify-rules (holds: deterministic-check, check "comment-length-tests")
  → agent reads ARGUS_KNOWLEDGE_CONTEXT_FILE, answers for every rule in it
  → RULE-42:v1 @abc123 = holds
       evidence: check comment-length-tests (passed, exit 0)   ← bound by Argus
                 src/Booking/KobraCommentValidator.cs

KobraCommentValidator.cs: MaxLength = 500      commit def456
  → ruleConformance(RULE-42:v1, def456) = unverified           ← never "holds"
  → verify-rules again
  → RULE-42:v1 @def456 = violated

  support(RULE-42:v1) = supported                              ← UNCHANGED
  no opposing evidence exists anywhere in the ledger

business change: Kobra now permits 500
  → RULE-42:v2 created
  → ruleConformance(RULE-42:v2, def456) = unverified           ← v2 inherits nothing
  → verify-rules again
  → RULE-42:v2 @def456 = holds

history, nothing rewritten:
  RULE-42:v1 @abc123 holds
  RULE-42:v1 @def456 violated
  RULE-42:v2 @def456 holds
```

### 15.15 What Phase 6 deliberately does NOT do

- **No automatic code remediation.** A `violated` result is a report. Nothing
  edits a file, opens an issue or re-runs anything.
- **No automatic re-verification.** A new commit makes a rule `unverified`; it
  does not schedule a run.
- **No confidence scores.** Three outcomes, and uncertainty is named as
  uncertainty.
- **No mutation API.** Only an accepted verification phase's commit creates a
  record; there is no `POST`, no edit and no delete.
- **No retargeting, ever.** A new rule revision or a new commit produces a new
  record, never an amended one.
- **No verification-driven rule revision.** A breach does not propose, weaken or
  contest the rule (§15.1).
- **No business-change decomposition, Jira/spec ingestion, requirements or
  acceptance-criteria generation, autonomous rule correction, semantic
  similarity, embeddings, production telemetry, domain-owner integration, ATMS
  worlds or graph UI.** Later phases.

## 16. Change-intent orchestration (Phase 7)

Phases 5 and 6 answered two questions about rules that already exist: _what
does the business say?_ and _does the code do it?_ Phase 7 starts from the
question a person actually arrives with:

> "We want the business to work differently. What does that mean?"

The answer is a **ChangeProposal**: a structured, reviewable semantic
transition that says what would change, what deliberately would not, what
follows from that, how anyone would know it had been done, and what is still
unknown. It is reviewed intent — not knowledge — until a human approves it.

Phase 7 stops before implementation. It writes no code, re-runs nothing,
remediates nothing, and never infers what the business _wants_ from what the
code currently _does_.

### 16.1 Three things that look alike and are not

The whole phase exists to keep these apart, because collapsing any two of them
is how an organization's semantics quietly become whatever somebody last
filed, or whatever the code last happened to do.

```
REQUESTED CHANGE        "Kobra now supports 500-character comments."
                        a ChangeRequest. Somebody's words. Neither canonical
                        knowledge nor evidence that any reading of it is right.

CURRENT SEMANTICS       RULE-42:v1 "Kobra comments max = 180"  support: supported
                        the ledger. Reaches the agent as a KnowledgeContext.

CURRENT IMPLEMENTATION  RULE-42:v1 @abc123 → holds
                        a RuleVerification. A fact about the code, never about
                        what the business wants.

PROPOSED TRANSITION     revise RULE-42:v1 → v2 "max = 500"
                        preserve CONSTRAINT-8:v1
                        decide "only when BookingEngine == Kobra"
                        accept when 500 passes and 501 fails
                        a ChangeProposal. Not canonical until approved.
```

A fourth separation runs through the rest of this section and is stated here
once:

> **Change provenance is not justification.**
> A justification answers _why is this claim supported?_ — an argument from
> premises, which bears on support. Change provenance answers _which request
> made us intentionally introduce or revise it?_ — a historical fact about
> intent, which bears on nothing. If they were the same edge, "the business
> asked for it" would become an argument that a rule is _true_.

### 16.2 The workflow

```
ChangeRequest                       (authored on the phase, or supplied at start)
      +
KnowledgeContext                    (§13 — the exact canonical claims)
      +
current conformance                 (§15 — RuleVerification, scoped to a commit)
      ↓  ARGUS_CHANGE_REQUEST_FILE (read-only) + ARGUS_KNOWLEDGE_CONTEXT_FILE
change-intent agent
      ↓  ARGUS_CHANGE_PROPOSAL_FILE
ChangeProposal                      (validated, checked, staged — NOT canonical)
      ↓  gate
      ├── revise      → the proposal is superseded; a fresh attempt may differ
      ├── needs-input → a deterministic readiness state, not a verdict
      └── approve
             ↓  ONE ledger transition
          semanticDelta commits  (§12, unchanged)   → RULE-42:v2, DECISION-x:v1
          AcceptedChangeProposal written            → request → those exact refs
             ↓  ARGUS_CHANGE_CONTEXT_FILE
          later implementation phase
```

The semantic half of a proposal is an **ordinary KnowledgeDelta**. There is no
second path to canonical: a change proposal's `semanticDelta` is staged as that
run's delta and commits through exactly the Phase 3 boundary, with the same
preflight, the same optimistic concurrency and the same atomicity. What Phase 7
adds around it is the material a delta has no place for.

### 16.3 The ChangeRequest

```ts
interface ChangeRequest {
  id: string; // stable; minted per phase attempt when absent
  summary: string; // one line: what is wanted
  details?: string;
  scope?: { paths?: string[]; label?: string; note?: string };
  claims?: ClaimRef[]; // revisions the requester believes are involved
  constraints?: string[]; // the requester's own words, not claims
  requestedBy?: string;
  receivedAt?: string; // bound by Argus at phase-attempt planning
}
```

It is **never written into the ledger as a claim**. It is carried, frozen, on
the accepted proposal that answered it. `claims` is a hint, not a selection:
which rules the agent is accountable for comes from the phase's
KnowledgeContext, exactly as a verification phase's accountability does.

Two sources, in a fixed precedence and no third:

1. the instance's `triggerPayload.changeRequest`, when it carries one — a
   request supplied when _this_ run was started is more specific;
2. the phase's authored `changeIntent.request`.

Neither resolving is a `configuration` failure. Argus never invents a request:
a change-intent phase with nothing to reason about is a definition that cannot
run, and running it would produce a proposal answering nothing.

`scope` is deliberately unchecked, unlike a `DiscoveryScope`: Phase 7 reads no
code, so no evidence path is contained by it. It narrows the agent's attention
and appears in the review.

### 16.4 Current state reaches the agent on two channels, and stays apart

The change agent needs both halves of what Argus knows about a rule, and they
arrive separately so neither can stand in for the other:

| What                                  | Channel                        | Contents                                                                   |
| ------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| current **semantics**                 | `ARGUS_KNOWLEDGE_CONTEXT_FILE` | the exact canonical claims (§13), unchanged                                |
| the request + current **conformance** | `ARGUS_CHANGE_REQUEST_FILE`    | the request verbatim, and per accountable rule its support and conformance |

```ts
interface ChangeIntentInput {
  schemaVersion: 1;
  generatedAt: string;
  request: ChangeRequest;
  relevant: ChangeRuleState[];
  gitHead?: string; // what `conformance` is scoped to
}

interface ChangeRuleState {
  ref: string; // "RULE-42:v1"
  claim: ClaimRef;
  kind: ClaimKind;
  statement: string;
  support: ClaimSupport; // is the rule well founded?
  lifecycle: ClaimLifecycle;
  conformance: RuleConformanceStatus; // does the code do it, at this commit?
  conformanceAt?: string;
  verifiedAt?: string;
}
```

`support` and `conformance` sit side by side and are never merged. `supported ·
violated` is the ordinary reading of a bug. `unverified` means **nobody looked
at this commit** — not "fine", and not `unverifiable` (somebody looked and
could not tell).

The rules a change phase must account for are exactly the business rules its
KnowledgeContext supplied, narrowed by `changeIntent.kinds` (default
`["business-rule"]`). There is no second rule-selection vocabulary, for the
same reason Phase 6 has none: two would be two answers to "which rules was this
run accountable for?".

### 16.5 The ChangeProposal

```ts
interface ChangeProposal {
  schemaVersion: 1;
  semanticDelta?: KnowledgeDelta; // the ONLY path to canonical
  preserved?: ClaimRef[]; // exact revisions deliberately untouched
  classification?: RuleClassification[];
  acceptanceCriteria?: AcceptanceCriterion[];
  unresolved?: UnresolvedQuestion[];
  metadata?: { summary?: string };
}
```

A change-intent run writes this file and **not** an
`ARGUS_KNOWLEDGE_DELTA_FILE`: one run, one account of what it proposes. Writing
both refuses the step.

**`semanticDelta`** carries the rule revisions, new constraints and decisions.
The agent revises the exact claim it was given rather than creating a second
rule about the same thing, with the Phase 12.4 precondition
(`expectedRevision`) doing the concurrency work it already does.

**`preserved`** names existing revisions whose behaviour an implementation must
not alter. Exact refs only — "the rule as it is right now", never "whatever
RULE-9 becomes" — and **no claim is created merely to say that an existing rule
is unchanged**. This is what stops an implementation agent reading _increase one
integration's limit_ as _change all comment validation_.

**`classification`** accounts for every rule Argus held the run responsible for:

```ts
type RuleChangeDisposition = "revised" | "preserved" | "not-relevant" | "unresolved";
```

Silence about a supplied rule is indistinguishable from not having considered
it, so an unclassified selected rule **refuses the proposal**, and so does a
classification that disagrees with the delta (`revised` for a rule the delta
does not revise; `preserved`/`not-relevant` for one it does).

### 16.6 Acceptance criteria are not business rules

```ts
interface AcceptanceCriterion {
  id: string; // proposal-local, "AC-1"
  statement: string;
  kind: "behavior" | "invariant" | "regression" | "verification";
  relatesTo: ChangeClaimRef[]; // local ids or exact revisions
  verificationHint?: string; // one line; never executed
}
```

A business rule describes domain semantics that outlive any particular change
("Kobra comments max = 500"). An acceptance criterion describes the evidence
that **one change** was carried out ("a 501-character Kobra comment is
rejected"). Storing criteria as claims would fill the ledger with per-change
assertions that nothing supersedes and nobody would ever revise, and would make
"what does the business say?" unanswerable.

So criteria live on the accepted proposal, **outside the claim graph**. They may
_reference_ exact rule revisions, and after the commit they do: `relatesTo` is
rewritten from delta-local ids to the canonical refs the commit minted.

Deliberately not a test DSL. `verificationHint` is one line of prose for a human
or a later agent; Argus never executes it.

### 16.7 Unresolved questions and readiness

Asked to "increase the Kobra comment limit" with no new maximum stated, a model
will produce `500` and a justification for it, and the fact that nobody ever
decided `500` disappears. An `UnresolvedQuestion` keeps that fact:

```ts
interface UnresolvedQuestion {
  id: string; // "Q-1"
  question: string;
  blocks?: ChangeClaimRef[]; // resolved to canonical refs at commit
  note?: string;
}
```

Readiness is **derived, never asserted by the agent**:

```
ready       every selected rule accounted for, nothing unresolved, and every
            proposed business-rule change carries an acceptance criterion
needs-input anything else
```

`needs-input` is not a verdict on the proposal — it may still be approved, and
its semantic delta (if any) commits. What it may not do is silently drive an
implementation: a `changeContext` selector refuses a `needs-input` proposal by
default (§16.11).

### 16.8 What Argus checks, and what it refuses

Every code is decided from **exact structured information** — the proposal, the
ledger, the conformance records — never from similarity, embeddings or a
model's opinion. There are no semantic-similarity warnings, by design.

| Code                               | Meaning                                                                         | Fatal?                                       |
| ---------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| `selected-rule-unclassified`       | a supplied rule is neither revised, preserved, not-relevant nor unresolved      | **yes**                                      |
| `classification-mismatch`          | the accounting and the semantic delta describe different changes                | **yes**                                      |
| `preserved-and-revised`            | the same claim is both preserved and revised                                    | **yes**                                      |
| `acceptance-criterion-unknown-ref` | a criterion names a local id the delta does not declare, or an unknown revision | **yes**                                      |
| `acceptance-criteria-missing`      | a proposed business-rule change carries no criterion                            | **yes**, unless `acceptanceCriteria: "warn"` |
| `unresolved-questions`             | the proposal is not implementation-ready                                        | no                                           |
| `no-semantic-change`               | the request produced no proposed semantic difference                            | no                                           |
| `implementation-already-violates`  | the code already violates a selected rule this change does **not** revise       | no                                           |
| `change-may-be-implemented`        | the code already violates a rule this change **does** revise                    | no                                           |
| `implementation-unverified`        | no accepted verification at the commit under analysis                           | no                                           |
| `request-claim-unknown`            | the request named a revision the ledger does not hold                           | no                                           |

Everything Argus can _prove_ inconsistent is fatal. Everything that is a
judgement for a person — an unresolved question, a pre-existing defect, a change
that turns out to be a no-op — is a warning, because refusing it would be Argus
deciding the semantics, which is the reviewer's job.

The proposal's `semanticDelta` additionally carries the Phase 5 delta warnings
(`revision-stale`, `revision-without-evidence`, …) on its own preview, so
"proposed revision lacks fresh support" and "already appears stale" are reported
by exactly the machinery that already reports them.

### 16.9 Existing defect versus requested change

This is the case the phase must not get wrong:

```
RULE-42:v1        "Kobra comments max = 180"       support: supported
implementation    @abc123 → violated               (the validator allows 500)
requested change  "Kobra now permits 500"
```

Argus warns `change-may-be-implemented`: the code may already behave as the
request asks, and the rule is only now catching up. What it does **not** do:

- **it does not revise the rule because the code differs.** The rule is revised
  because the _request_ says the business semantics changed. Inferring desired
  future semantics from current behaviour would make every bug a requirement;
- **it does not rewrite history.** The recorded violation of `RULE-42:v1`
  stands, bound to v1 and to the commit it was about. `RULE-42:v2` starts
  `unverified` — nobody has looked at it — which is the honest answer;
- **it does not erase the defect.** A violated rule the change does _not_ revise
  is reported separately, as `implementation-already-violates`: a pre-existing
  defect this change does not address.

### 16.10 The acceptance boundary

Approving commits **one ledger transition** over three things:

```
deltas → verifications → change proposals
```

in that order because it is the dependency order. A change proposal's criteria
must be resolved against exactly what the delta minted, and that has not
happened until the delta is applied — on this snapshot, inside this mutex. So
`local:r42` becomes `RULE-42:v2` here, and **a local id the commit did not
create refuses the whole transition** rather than persisting a label that points
at nothing. Nothing downstream ever sees a local reference.

Before approval:

- no proposed rule revision is canonical;
- no proposed decision or constraint is canonical;
- `ledger.changeProposals` is empty for that phase.

If the commit is refused — the classic case being `RULE-42` moving from v1 to v2
while the proposal waited at its gate — **nothing** lands: no revision, no
decision, no accepted proposal. The phase fails under `change-proposal` with the
ledger's own reason, and the staged records read `rejected`.

### 16.11 The durable record, and the downstream handoff

```ts
interface AcceptedChangeProposal {
  id: string;
  schemaVersion: 1;
  request: ChangeRequest; // frozen as it was at launch
  execution: RunExecutionRef;
  attempt?: number;
  deltaId?: string;
  readiness: ChangeProposalReadiness;
  semanticChanges: ClaimRef[]; // every revision this change created
  revised: Array<{ from: ClaimRef; to: ClaimRef }>;
  created: ClaimRef[];
  decisions: ClaimRef[];
  constraints: ClaimRef[];
  preserved: ClaimRef[];
  acceptanceCriteria: ResolvedAcceptanceCriterion[]; // canonical refs only
  unresolved: ResolvedUnresolvedQuestion[];
  classification: RuleClassification[];
  acceptedAt: string;
}
```

It lives in `knowledge.json` (ledger version 6), beside the records its delta
created, so three questions are answerable from the ledger alone, forever, and
survive every pruning path:

- _What requested change caused `RULE-42:v2` to exist?_
- _What acceptance criteria were associated with `RULE-42:v2`?_
- _Which implementation run was later intended to realize `CP-12`?_

Immutable, and never retargeted: a later `RULE-42:v3` does not change what this
proposal says it did, exactly as a consumption or a verification does not. It is
its own array, read by the change queries and by nothing else — support
evaluation and `analyzeImpact` never see it.

A later phase receives it through a **ChangeContext**:

```ts
// PhaseDef
changeContext?: { fromPhase: string; requireReady?: boolean };
```

```ts
interface ChangeContext {
  schemaVersion: 1;
  generatedAt: string;
  proposalId: string;
  request: ChangeRequest;
  readiness: ChangeProposalReadiness;
  semanticChanges: ClaimRef[];
  revised: Array<{ from: ClaimRef; to: ClaimRef }>;
  created: ClaimRef[];
  decisions: ClaimRef[];
  constraints: ClaimRef[];
  preserved: ClaimRef[];
  acceptanceCriteria: ResolvedAcceptanceCriterion[];
  unresolved: ResolvedUnresolvedQuestion[];
}
```

Materialized read-only at `ARGUS_CHANGE_CONTEXT_FILE`, through the same
invocation-channel model as every other Argus-owned path.

**References, not restatements.** `semanticChanges` names `RULE-42:v2`; what
RULE-42:v2 _says_ arrives through the run's KnowledgeContext. A second copy of a
claim's sentence in a second file is a second thing to drift.

**No staged leakage, by construction.** The selector resolves exclusively from
`ledger.changeProposals`, which holds only _accepted_ proposals, which are
written only at the commit boundary. A proposal waiting at a gate resolves to
nothing and refuses the launch — not because a check remembers to look, but
because there is nothing there to find. Authoring adds the same two graph rules
`fromPhases` has: the named phase must exist and must be a transitive
dependency, and it must actually be a `changeIntent` phase.

`requireReady` defaults to `true`: an implementation driven by intent nobody
finished deciding is exactly what readiness exists to prevent.

### 16.12 Authoring a change-intent phase

```jsonc
{
  "id": "change-intent",
  "name": "Change intent",
  "gated": true, // REQUIRED
  "knowledgeContext": {
    "claims": [
      { "id": "RULE-42", "revision": "active" },
      { "id": "CONSTRAINT-8", "revision": "active" },
    ],
  },
  "changeIntent": {
    "request": {
      "id": "CR-1",
      "summary": "Kobra now supports 500-character customer comments.",
    },
    "kinds": ["business-rule"], // default
    "acceptanceCriteria": "required", // default; "warn" downgrades it
  },
  "steps": [{ "name": "reason", "prompt": "Work out what this change means." }],
}
```

**A change-intent phase must be `gated`.** Saving an ungated one is a 400. Phase
7 exists so that a requested change is reviewed before it becomes canonical
semantics; an ungated one would be a pipeline that rewrites the domain because
somebody filed a ticket, and no later check can recover a review that never
happened.

### 16.13 The review surface

The gate drawer gains a **Change intent** panel — an extension of the existing
review, not a new product area — laid out as the decision is made:

```
Requested change
  Kobra now supports 500-character customer comments.        [ready]

CURRENT
  RULE-42:v1   rule: supported · impl: holds @abc123de
  "Kobra customer comments must not exceed 180 characters."

PROPOSED
  RULE-42 v1 → v2
  ~~Kobra customer comments must not exceed 180 characters.~~
  Kobra customer comments must not exceed 500 characters.

PRESERVED
  ✓ CONSTRAINT-8:v1  Comment validation is enforced server-side.

DECISIONS
  • The 500-character limit applies only when BookingEngine == Kobra.

ACCEPTANCE CRITERIA
  AC-1 [behavior]   A Kobra comment of 500 characters is accepted.
  AC-2 [behavior]   A Kobra comment of 501 characters is rejected.
  AC-3 [regression] Non-Kobra comment limits are unchanged.

UNRESOLVED
  none
```

Every rule in CURRENT shows its own support _and_ the implementation's
conformance, for the reason Phase 6's panel does: a reviewer who could not see
the distinction would eventually start "fixing" rules whose implementations were
merely in breach. No transcript inspection is required for any of it.

### 16.14 The worked example, Phase 7

Starting state:

```
RULE-42:v1       "Kobra comments max = 180"          support: supported
                 verification @abc123 → holds
CONSTRAINT-8:v1  "Validation is enforced server-side" support: supported
```

Request: _"Kobra now supports 500-character customer comments."_

The agent proposes: revise `RULE-42` (expecting v1) to 500; preserve
`CONSTRAINT-8:v1`; a `decision` claim justified from the proposed revision plus
the preserved constraint; AC-1 500 accepted, AC-2 501 rejected, AC-3 non-Kobra
unchanged. Readiness: `ready`.

Before approval — `RULE-42:v2` does not exist, there is no decision, and
`ledger.changeProposals` is empty.

A human approves. In one transition:

```
RULE-42:v2      "Kobra comments max = 500"      ← revision, not a second rule
DECISION-x:v1   "…only when BookingEngine == Kobra"   supported
CP-12           request CR-1 → [DECISION-x:v1, RULE-42:v2]
                preserved   [CONSTRAINT-8:v1]
                AC-1/AC-2 → RULE-42:v2   AC-3 → CONSTRAINT-8:v1
```

`CONSTRAINT-8` has exactly one revision still. The earlier verification is
untouched, still bound to `RULE-42:v1` and to `abc123`; `RULE-42:v2` is
`unverified`. The next phase receives `RULE-42:v2` and the decision as a
KnowledgeContext, and CP-12 as a ChangeContext.

**No implementation has happened.**

### 16.15 What Phase 7 deliberately does NOT do

- **No code modification, autonomous implementation, targeted re-execution or
  automatic remediation.** A proposal ends at accepted intent.
- **No re-verification.** Nothing schedules a run because a rule changed.
- **No PR creation or merge, no Jira integration, no automatic change-request
  generation, no stakeholder approval, no production telemetry.**
- **No inference of intent from code.** Conformance is an input and a warning;
  it never causes a revision.
- **No rewriting of verification history.** The past is not made consistent with
  a requested future.
- **No acceptance criteria as claims**, and no test DSL.
- **No semantic-similarity warnings**, no embeddings, no LLM adjudication.
- **No task decomposition beyond semantic intent**, no project planning, no
  estimation, no scheduling.
- **No mutation API.** A change proposal becomes canonical exactly one way: an
  agent proposes it, a person approves the gate, and the phase's commit writes
  it. There is no `POST` that could record one around the review.
- **No ATMS environments or alternative worlds.**

## 17. Targeted implementation and closed-loop realization (Phase 8)

Phase 7 ended at **accepted intent**: a person approved a ChangeProposal, its
semantic delta committed, and a later phase could receive the result as a
ChangeContext. Phase 8 answers the question that follows, and it is the one
the whole ledger was built to be able to answer:

> Has this accepted business change actually been implemented, and how do we
> know?

### 17.1 The completion invariant

The answer is never one fact. An agent saying

```
ARGUS_OUTCOME: succeeded
```

is one agent's word about its own work. `npm test → 0` is Argus's own
observation, and says nothing about the domain. `RULE-42:v2 → holds` is about
the domain and says nothing about whether _this change_ was carried out. Each
of them is necessary; none is sufficient. So:

```
ChangeRealizationComplete  ⟺
      the implementation execution succeeded
    ∧ every mandatory deterministic PhaseCheck passed
    ∧ every targeted business-rule revision  `holds`     at the examined state
    ∧ every required acceptance criterion    `satisfied` at that same state
    ∧ the verification examined the state the implementation produced
    ∧ the semantic target is still the domain's current intent
```

Evaluated by one pure function, `evaluateCompletion` (`knowledge/realization.ts`),
from records Argus wrote — never from a model's opinion, and never from an
agent's report about itself. The six conjuncts in order, and what each one
refuses:

| #   | Dimension        | Decided from                                       | Failure class                                     |
| --- | ---------------- | -------------------------------------------------- | ------------------------------------------------- |
| 1   | execution        | the run's `ARGUS_OUTCOME` / the phase's status     | `blocked`, `technical-failure`                    |
| 2   | checks           | the phase's own `VerificationReport`               | `technical-failure`                               |
| 3   | rule conformance | `ledger.verifications` for this attempt's runs     | `rule-violation`                                  |
| 4   | acceptance       | `ledger.acceptanceVerifications` for the same runs | `acceptance-violation`, `acceptance-unverifiable` |
| 5   | state binding    | the two `RepositoryStateRef`s                      | `state-mismatch`                                  |
| 6   | intent currency  | `activeRevision` of every targeted ref             | `stale-intent`                                    |

The order is the order the dimensions fail in, and it is what keeps the
classes apart: a compile error is never reported as a rule violation, and a
rule violation is never reported as an acceptance violation — because the
remediation each one needs is different.

**The four dimensions are never merged.** This is the state Phase 8 exists to
be able to name:

```
RULE-42:v2   support = supported   conformance = holds
npm test     exit 0
AC-1         satisfied
AC-2         satisfied
AC-3         "Non-Kobra behaviour unchanged"        violated
                              ↓
                  the change is NOT complete
```

and so is its inverse (every criterion satisfied, a targeted rule violated).
Neither result rewrites the other; completion _combines_ them.

### 17.2 Change realization, the durable record

One attempt-chain against one accepted proposal (ledger **version 7**):

```ts
interface ChangeRealization {
  id: string; // CR-…
  schemaVersion: 1;
  proposalId: string; // the accepted CP it realizes — frozen
  target: ClaimRef[]; // the revisions that CP introduced
  instanceId: string;
  phaseId: string; // the implementation phase
  verificationPhaseId?: string;
  maxAttempts: number; // the loop's bound, the author's
  scope: ImplementationScope; // derived once, frozen
  attempts: ChangeRealizationAttempt[];
  outcome?: ChangeRealizationOutcome; // written once, never rewritten
  createdAt: string;
}
```

It is the one record in the ledger that is not write-once, and it is mutable
in exactly two guarded ways and no others:

- **`attempts` is appended to.** An attempt number the realization already
  holds is a no-op when identical and a **refusal** when it differs, so a
  remediation can never rewrite the attempt it is remediating.
- **`outcome` is written once.** A second, different verdict is refused rather
  than turning a failed realization into a success, or a success into a stale
  one. Its presence is what makes the realization no longer `running` — the
  status is derived (`realizationView`), never stored twice.

```ts
interface ChangeRealizationAttempt {
  attempt: number; // 1 = implementation, 2..n = remediation
  kind: "implementation" | "remediation";
  implementation: RunExecutionRef[];
  verification: RunExecutionRef[];
  repository?: RepositoryStateRef;
  technical?: RealizationTechnicalResult;
  ruleResults: RealizationRuleResult[];
  acceptanceResults: RealizationAcceptanceResult[];
  outcome: ChangeAttemptOutcome;
  reason?: string;
  startedAt: string;
  endedAt?: string;
}
```

Two levels of history, both preserved. Within one realization the attempts are
the record of how the implementation converged; across realizations, a second
run of the pipeline against the same CP opens a _second_ realization and the
first stands untouched.

Identity is `(instanceId, phaseId)`: one implementation phase of one instance
drives one realization, however many attempts it takes. Opening it again is a
no-op — which is what makes a restart between the ledger write and the
instance write safe — and opening it against a **different** proposal is
refused rather than retargeting a running attempt at intent it never received.

The externally useful states:

| Status              | Means                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| `running`           | an attempt is in flight                                                      |
| `succeeded`         | every required dimension held, at one state, with the target still current   |
| `needs-remediation` | recorded on the _attempt_; the realization re-opens the implementation phase |
| `failed`            | terminal without success: budget exhausted, blocked, unverifiable, technical |
| `stale`             | the accepted intent was superseded; a new decision is needed, not more code  |

### 17.3 Repository-state identity

A conformance result is a statement about one implementation, and `gitHead`
alone does not name one when the agent left its work uncommitted:

```
HEAD abc123   +   validator accepts 501     ← attempt 1, the defect
HEAD abc123   +   validator rejects 501     ← attempt 2, the fix
```

Two different implementations, one commit. A verification bound to the head
alone would claim the second's result about the first. So Phase 8 adds:

```ts
interface RepositoryStateRef {
  gitHead?: string;
  workingTree?: { snapshotHash: string; dirty: number; truncated?: boolean };
}
```

`snapshotHash` is sha256 over the sorted `(path → content identity)` pairs of
Argus's own `WorkingTreeSnapshot` — content hashes, never timestamps — so it is
derived from what the files _say_. No new subsystem: the snapshot already
existed for `changed-files` checks.

Three rules, all fail-closed:

- **absent `workingTree` means clean at `gitHead`** — a positive statement, and
  a clean state never matches a dirty one;
- **neither field means "not a repository"** — an honest absence of identity,
  which matches nothing, itself included;
- **a truncated snapshot identifies nothing.** Argus will not assert an
  identity it could not compute.

A record written before Phase 8 carries a `gitHead` and no state. It answers a
**clean** question at that head and nothing else: a question that carries a
working tree is about content such a record never saw, so the answer is
`unverified` rather than a silent match (`repositoryStateAnswers`).

`RuleVerification` gains `repositoryState` beside its existing `repository`;
`ruleConformance(rule, gitHead)` is unchanged and still answers the head-scoped
question, and `ruleConformanceAtState(rule, state)` answers the stricter one a
realization has to ask. It is recorded only by a realization's verifier — the
phase that declares `acceptanceVerification`. An ordinary Phase 6 verification
phase behaves exactly as it did, with no snapshot taken and no new field on its
records, because nothing asks a state-scoped question of it.

### 17.4 The critical binding: verified state = implemented state

```
implementation phase concludes  →  snapshot            (state I)
      ↓
verification runs               →  snapshot at intake  (state V)
      ↓
close-out:  I ≠ V  →  state-mismatch, fail closed
```

Argus does not introduce a branch or worktree subsystem to guarantee this (a
pipeline that wants isolation already has `workspace`). It **proves** it, and
refuses when it cannot: a verifier that ran in a different tree, or modified
the one it was given, did not verify the implementation, and no amount of
green output makes it so. Two verification runs that examined different trees
also produce no single state, and are refused for the same reason.

The one case that proceeds without a binding is a working directory that is
not a git repository at all. The limitation is then explicit — the realization
records no repository — rather than a fabricated revision identity.

### 17.5 Deterministic implementation scope

Before an implementation agent is launched, Argus answers one question from
its own records and nothing else:

> Where, in this repository, does the ledger say this change lives?

```
revised RULE-42:v1 → v2
      ↓ analyzeImpact(RULE-42:v1)              Phase 2, called, not re-derived
  consumer executions → the artifacts they produced       impact-artifact
      ↓ evidenceOf(RULE-42:v1 / :v2)           Phase 1/5 source-code evidence
  where the rule lives in the code                        source-code-evidence
      ↓ verificationsOfClaim(RULE-42:v1)       Phase 6 conformance evidence
  where somebody last looked                              verification-evidence
      ↓ preserved revisions' own evidence                 preserved-evidence
      ↓ ChangeRequest.scope.paths                         request-scope
```

```ts
interface ImplementationScope {
  schemaVersion: 1;
  generatedAt: string;
  proposalId: string;
  semanticChanges: ClaimRef[];
  preserved: ClaimRef[];
  targets: ImplementationTarget[]; // path + location + reasons
  impactedExecutions: RunExecutionRef[];
  completeness: "known-targets" | "scope-incomplete";
  withoutTargets: ClaimRef[];
  requestedPaths: string[];
}
```

Every reason is a closed `ScopeReasonCode` carrying the exact claim, execution
or evidence record it came from — machine-readable, so a later phase can route
on it without parsing prose:

```
src/Booking/CustomerCommentValidator.cs
  impact-artifact        RULE-42:v1 → consumed by run_impl_17 → produced this
src/Booking/KobraAdapter.cs
  source-code-evidence   EV-1 grounds RULE-42:v1
src/Booking/ServerValidation.cs
  preserved-evidence     CONSTRAINT-8:v1 must keep behaving as it does
src/Booking
  request-scope          the change request named it
```

**It never claims to be exhaustive.** `known-targets` means "these are the
places the ledger knows about", and the agent may legitimately need to touch
others — the scope is guidance and provenance, not a filesystem boundary (the
capability profile is that, if anything is).

And the case that matters most: a **new** business rule nothing has ever
implemented has no consumer execution, no artifact and no source evidence.
`analyzeImpact` is empty. Argus reports `scope-incomplete` and names the
revisions it cannot place — never an empty target list that would read as
_nothing to do_. The requester's own `scope.paths` are delivered to the agent
but deliberately do **not** count as provenance: a request naming a directory
must not make a change with no implementation history read as fully scoped.

### 17.6 Acceptance-criterion verification

Phase 7 introduced acceptance criteria and deliberately kept them out of the
claim graph. Phase 8 gives them first-class verification results, on their own
dimension:

```
RULE-42:v2   "Kobra comments max = 500"    a domain rule that outlives the
                                           change.  Bound to a ClaimRef.
CP-12/AC-3   "Non-Kobra behaviour is       evidence that ONE change was done
              unchanged."                  right.  Bound to a proposal.
```

AC-3 is not a business-rule revision and has nothing to be verified _against_;
mapping it onto `RuleVerification` would have required inventing a claim for
every criterion, which is exactly what §16.6 forbids. So it gets its own
channel, record, read model and failure class.

```ts
interface AcceptanceVerification {
  id: string;
  proposalId: string; // CP-12
  criterionId: string; // AC-3        → "CP-12/AC-3"
  statement: string; // frozen from the ACCEPTED proposal
  kind: AcceptanceCriterionKind;
  outcome: "satisfied" | "violated" | "unverifiable";
  execution: RunExecutionRef;
  attempt?: number;
  repository?: RepositoryStateRef;
  evidence: VerificationEvidence[]; // the Phase 6 union, reused as-is
  reason?: string; // required for `unverifiable`
  note?: string;
  createdAt: string;
}
```

**Identity is the pair.** `AC-1` is proposal-local by design — two changes may
both have one, meaning entirely different things — so nothing outside a
proposal addresses a criterion by its bare id, and a report written against
CP-11 can never answer CP-12. The statement is read from the accepted
proposal, never from the agent's document: a durable result is always about
the sentence a person approved.

Four answers, and the same distinction Phase 6 draws:

| Status         | Means                                                         |
| -------------- | ------------------------------------------------------------- |
| `satisfied`    | sufficient evidence the implementation meets the criterion    |
| `violated`     | sufficient evidence it does not                               |
| `unverifiable` | somebody looked and could not settle it. Requires a reason    |
| `unverified`   | **read model only** — nobody looked, at this repository state |

`acceptanceConformance(proposalId, criterionId, state?)` scopes the question
to an exact repository state, exactly as `ruleConformance` scopes to a commit:
a criterion satisfied against one implementation reads `unverified` against a
different one at the same head, and `history` is always the full history
however the question was scoped.

### 17.7 The protocol

Four Argus-owned channels, through the existing invocation-channel model
(HARNESS.md §3a), and deliberately four rather than one:

| Channel                              | Direction       | When                                        |
| ------------------------------------ | --------------- | ------------------------------------------- |
| `ARGUS_IMPLEMENTATION_SCOPE_FILE`    | read, required  | the phase declares `implementation`         |
| `ARGUS_REMEDIATION_CONTEXT_FILE`     | read, required  | attempt 2..n only                           |
| `ARGUS_ACCEPTANCE_VERIFICATION_FILE` | write, required | the phase declares `acceptanceVerification` |
| `ARGUS_CHANGE_CONTEXT_FILE`          | read, required  | unchanged from Phase 7                      |

```
KnowledgeContext      what the domain currently says        (§13)
      +
ChangeContext         the accepted transition to realize    (§16.11)
      +
ImplementationScope   where the ledger says it lives        (§17.5)
      ↓
implementation run
      ↓  repository changes, artifacts, an optional KnowledgeDelta
Argus's PhaseChecks
      ↓
verification run
      ↓  ARGUS_RULE_VERIFICATION_FILE   +  ARGUS_ACCEPTANCE_VERIFICATION_FILE
staged records (NOT canonical)
      ↓  completeness · exact refs · evidence floors · check labels · realpath
      ↓  PhaseChecks → check evidence bound from Argus's own report
      ↓  gate, when configured → phase acceptance, ONE ledger transition
RuleVerification  +  AcceptanceVerification  +  the realization attempt
```

Three documents, never one blob. `ImplementationScope` names `RULE-42:v2` and
what it _says_ arrives through the KnowledgeContext — a second copy of a
claim's sentence in a second file is a second thing to drift.

The acceptance document:

```json
{
  "schemaVersion": 1,
  "proposalId": "CP-12",
  "criteria": [
    {
      "criterionId": "AC-1",
      "outcome": "satisfied",
      "evidence": [{ "type": "check", "label": "kobra-comment-500" }]
    },
    {
      "criterionId": "AC-2",
      "outcome": "violated",
      "evidence": [{ "type": "source-code", "path": "src/Booking/Validator.cs" }],
      "note": "501 is accepted too"
    },
    {
      "criterionId": "AC-3",
      "outcome": "satisfied",
      "evidence": [{ "type": "check", "label": "non-kobra-unchanged" }]
    }
  ]
}
```

What Argus validates, all from structured data:

1. **Completeness.** `required = satisfied ∪ violated ∪ unverifiable`, each
   criterion exactly once. A **missing** criterion refuses the whole document
   (say `unverifiable` instead); an **extra** one refuses it too — and the
   classic form of an extra one is a criterion belonging to a different
   proposal.
2. **Proposal identity.** An echoed `proposalId` that is not the run's own
   refuses the document before anything else is read.
3. **Evidence floors.** `satisfied`/`violated` must cite evidence;
   `unverifiable` must give a reason.
4. **Check references.** A cited label must be one the phase declares; its
   `status`, `exitCode` and `detail` are bound from Argus's own report at the
   commit boundary, and any `status` the agent wrote is stripped at
   validation. A `satisfied` outcome citing a check Argus observed **failing**
   refuses the commit.
5. **Source evidence.** Repository-relative, real, inside the run's tree
   through every symlink (`realpath`), at the commit Argus recorded.
6. **No file is not silence.** A run given an accepted change with criteria has
   an obligation to answer them; an absent report refuses the step.

An agent may _create_ a test — that is ordinary implementation work — but
creating one proves nothing. Only Argus's subsequent deterministic execution
of it, cited as a `check`, is evidence.

### 17.8 ChangeContext integrity, closed

Phase 7 materialized the ChangeContext read-only and never checked it again,
so an implementation could have been driven by bytes nobody could vouch for.
Phase 8 closes that by exactly the Phase 4.1 model, for all three read inputs:

```
materialize  →  record path + sha256 on the invocation
      ↓
launch
      ↓
completion   →  re-hash
      ↓
mismatch or missing  →  `change-context-integrity`, deterministic failure,
                        before anything the run proposed is staged
```

It asks **one** question — _did the bytes supplied to this invocation change?_
— and deliberately not _is this still the newest proposal?_. An accepted
ChangeProposal's identity is immutable, so a newer proposal accepted while the
agent ran is never tampering; a realization that has been overtaken is a
`stale` realization, decided at close-out from the ledger. A record with no
`suppliedInputs` (written before Phase 8) has nothing to verify and passes,
exactly as a pre-Phase-4.1 context does.

The ChangeContext is built from the **accepted proposal in the ledger**, never
from an earlier phase's invocation file, so implementation and remediation
never depend on a transient record that pruning may have removed.

### 17.9 Channels match phase responsibilities

While touching invocation construction, one asymmetry Phase 7 left is closed:
a change-intent phase was offered `ARGUS_KNOWLEDGE_DELTA_FILE` even though a
run that writes both a delta and a proposal is refused outright. It is no
longer offered there — advertising a protocol whose use would fail the step is
worse than not advertising it. Every other phase is offered the delta channel
exactly as before; this is the only suppression, and it is decided from the
phase definition (`channels.ts`), not by a new mechanism.

### 17.10 Targeted remediation

When accepted verification finds the change unmet, Argus builds the
remediation's input **from its own accepted results** — never from the previous
agent's transcript:

```ts
interface RemediationContext {
  schemaVersion: 1;
  realizationId: string;
  proposalId: string;
  attempt: number; // 2..n
  previousOutcome: ChangeAttemptOutcome;
  failedRules: RemediationFailedRule[]; // ref, statement, outcome, evidence
  failedCriteria: RemediationFailedCriterion[]; // CP-12/AC-2, statement, evidence
  technicalFailures: Array<{ label; detail? }>;
  affectedTargets: ImplementationTarget[]; // narrowed by the failures
  satisfied: { rules: string[]; criteria: string[] }; // do not break these
}
```

`affectedTargets` is the scope narrowed to what the failures actually point
at — the files the failing evidence cited, plus the targets whose reasons name
a failing rule. Attempt 2 is told _this file, this criterion_, not _here is the
whole change again_.

**Only the realization re-runs.** `applyRemediation` re-opens the
implementation phase and resets the phases between it and its verifier to
`pending`. Everything earlier — discovery, change intent, the human approval
that made the intent canonical — is accepted history and is never re-run.

Three things that share mechanics and must not share semantics:

```
retry        the same intended work; the execution failed operationally.
             consumes the author's retry budget.
revise       a person decided to try again, and reset that budget.
remediation  the implementation EXECUTED; Argus's own verification proved the
             accepted intent unmet, and a new attempt is launched with the
             exact failures as its input. The retry budget is untouched; the
             bound is the realization's own `maxAttempts`.
```

They are separate journal kinds (`realization.remediation-started` vs
`phase.retrying` vs `phase.revised`) and separate durable facts.

### 17.11 The loop is bounded

`implementation.maxAttempts` (default 2, hard cap 8, validated when the
pipeline is **saved**) is the only thing that decides how many times the loop
may come back. Exhaustion is a clear terminal state — `failed`, with a reason
naming the budget — never another automatic attempt. And three outcomes stop
the loop even with attempts remaining, because more code is not the answer:

- `blocked` — the agent reported it cannot safely implement the accepted
  intent with the information it has (reusing `ARGUS_OUTCOME: blocked`, not a
  new mechanism);
- `acceptance-unverifiable` — a required criterion cannot be established
  either way; a person is needed;
- `stale-intent` / `state-mismatch` — the premises of the loop no longer hold.

### 17.12 Stale intent

Two preconditions, at the two moments that matter:

**Before launching.** If any revision the accepted proposal introduced is no
longer the **active** revision of its id, the launch is refused as a
`configuration` failure and no agent starts:

```
CP-12 targets RULE-42:v2
current active revision is RULE-42:v3
  → "the domain has moved past this intent; a new change decision is
     required, not an implementation of the old one"
```

(`implementation.requireCurrentIntent: false` allows a deliberately historical
operation.)

**Before declaring success.** The same check runs again at close-out. The
attempt's results stay historically true about the exact revisions they
named — a verification of `RULE-42:v2` is a fact about v2 forever — but the
realization closes `stale` rather than `succeeded`, remediation stops, and the
reason names the supersession. A perfect implementation of v2 is not current
completion when the business has decided v3.

### 17.13 Atomic close-out

A realization's verification phase commits **everything or nothing** in one
ledger transition: its deltas, its rule verifications, its accepted change
proposals and its acceptance verifications, through the one extended
`commitPhaseSemantics`. Three rule results and four criterion results are
seven records that land together or not at all; a forged check reference, a
`satisfied` resting on a failing check, a criterion whose proposal is not in
the ledger — any of them refuses the whole attempt before the ledger is
touched, and the phase fails under `acceptance-verification`.

The attempt record and the terminal verdict are separate, idempotent ledger
transitions that follow it, so a crash anywhere in the sequence heals by
running it again.

### 17.14 The worked example, Phase 8

`harness/realizationE2e.test.ts`, with real child processes, the real Stop
hook, a real git repository and real `node` check processes:

```
RULE-42:v1       "Kobra comments max = 180"        supported, holds @baseline
CONSTRAINT-8:v1  "Validation is enforced server-side"

request          "Kobra now supports 500-character comments."
  ↓ change intent (gated) — a human approves
RULE-42:v2 "max = 500"   preserved CONSTRAINT-8:v1
AC-1 500 accepted · AC-2 501 rejected · AC-3 non-Kobra unchanged

  ↓ ImplementationScope: kobraCommentValidator.mjs (source-code-evidence),
    src/Booking (request-scope), completeness = known-targets
  ↓ attempt 1 — a real defect: accepts(500) AND accepts(501)
  ↓ PhaseChecks: syntax ✓  non-kobra-unchanged ✓        ← green, and wrong
  ↓ verification
RULE-42:v2 → violated        AC-1 satisfied · AC-2 violated · AC-3 satisfied
  → attempt 1: rule-violation                       (needs remediation)

  ↓ RemediationContext: RULE-42:v2 violated, CP/AC-2 violated,
    already satisfied: CP/AC-1, CP/AC-3
  ↓ attempt 2 — the boundary is enforced
  ↓ re-verification
RULE-42:v2 → holds           AC-1 · AC-2 · AC-3 all satisfied
  → realization SUCCEEDED, bound to the exact repository state examined

durable history, nothing rewritten:
  RULE-42:v1 @baseline holds
  RULE-42:v2 violated          (attempt 1)
  RULE-42:v2 holds             (attempt 2)
  CP-12/AC-2 violated          (attempt 1)
  CP-12/AC-2 satisfied         (attempt 2)
  attempts: [1 implementation rule-violation, 2 remediation succeeded]

support(RULE-42:v2) = supported throughout.  No opposing evidence exists
anywhere in the ledger: a breach is never a doubt.
```

### 17.15 Authoring a realization

```jsonc
{
  "id": "implement",
  "name": "Implement",
  "needs": ["change-intent"],
  "knowledgeContext": { "fromPhases": [{ "phaseId": "change-intent" }] },
  "changeContext": { "fromPhase": "change-intent" },
  "implementation": {
    "maxAttempts": 2,          // default 2, cap 8; 1 = no autonomous remediation
    "requireCurrentIntent": true,  // default
    "includePreserved": true,      // default: regression surface in the scope
  },
  "steps": [{ "name": "build", "prompt": "Realize the accepted change." }],
},
{
  "id": "verify",
  "name": "Verify",
  "needs": ["implement"],
  "knowledgeContext": { "fromPhases": [{ "phaseId": "change-intent" }] },
  "changeContext": { "fromPhase": "change-intent" },
  "ruleVerification": { "holds": "deterministic-check" },
  "acceptanceVerification": {
    "implementationPhase": "implement",
    "require": "all",          // default; "behavioral" accepts an
                               // `unverifiable` regression criterion
  },
  "checks": [{ "kind": "command", "run": "npm test", "label": "tests" }],
  "steps": [{ "name": "check", "prompt": "Verify the implementation." }],
}
```

Refused when the pipeline is **saved**, where the author can see it:

- an `implementation` or `acceptanceVerification` phase with no
  `changeContext` — the accepted proposal is the one that selector resolves,
  and a second selection mechanism would be a second answer to "which change
  is this?";
- an `implementation` phase with no verifier, or with two: nothing would ever
  decide the change, or two things would;
- a verifier whose `implementationPhase` is not an `implementation` phase, or
  is not a dependency of it;
- two halves resolving their accepted change from _different_ phases;
- `maxAttempts` outside 1..8.

### 17.16 Impact-driven re-evaluation

`analyzeImpact` already names the historical runs and artifacts a revised rule
affects, and Phase 8 adds no daemon over it. What it adds is the primitive
those reports were missing: given an `ImpactSet`, the implementation artifacts
and consumer executions it names are exactly what an `ImplementationScope`
derives from, so an operator who decides a stale artifact should be reworked
authors a realization against the accepted change that superseded it. Nothing
schedules that, and nothing rewrites the system on its own.

### 17.17 The review surface

The gate drawer gains an **Acceptance criteria** panel beside the Phase 6
one — beside, never merged, for the reason the dimensions exist — and a
one-line realization header:

```
Change realization
Realizing CP-12 · CR-7 · remediation attempt 2 of 2.
The implementation left abc123de with 1 uncommitted file.

Business-rule verification
1 holds · 0 violated · 0 unverifiable · at abc123de
  holds      RULE-42:v2    rule: supported
  Kobra customer comments must not exceed 500 characters
  ✓ src/Booking/kobraCommentValidator.mjs

Acceptance criteria
3 satisfied · 0 violated · 0 unverifiable · for CP-12 · at abc123de
  SATISFIED (3)
    satisfied  CP-12/AC-1  behavior    RULE-42:v2
    A Kobra comment of 500 characters is accepted.
    ✓ check: kobra-comment-500 (passed, exit 0)
    satisfied  CP-12/AC-2  behavior    RULE-42:v2
    satisfied  CP-12/AC-3  regression  CONSTRAINT-8:v1
```

No new graph UI, no project-management dashboard, no transcript inspection.

### 17.18 The API

Read-only, like every other semantic surface:

```
GET /api/knowledge/realizations[?proposal=CP-12]
GET /api/knowledge/realizations/:id
GET /api/knowledge/realizations/:id/runs
GET /api/knowledge/realizations/:id/results
GET /api/knowledge/change-proposals/:id/criteria/:criterionId[?gitHead=]
GET /api/knowledge/change-proposals/:id/acceptance
GET /api/knowledge/executions/:runId/acceptance
GET /api/knowledge/executions/:runId/acceptance-proposal
GET /api/knowledge/acceptance/:id[/preview]
```

There is deliberately **no** write API for completion state. A realization is
opened, advanced and closed by the pipeline engine as its phases cross their
acceptance boundaries; a route that could mark one `succeeded` would be a way
to declare a change implemented without any of the dimensions having been
established.

### 17.19 What Phase 8 deliberately does NOT do

- **No PR creation or merge, no deployment, no Jira, no Slack.** A realization
  ends at a verified repository state.
- **No unbounded remediation.** The bound is the author's, small, and enforced
  before a spawn.
- **No re-running of earlier accepted work.** Discovery and change intent are
  historical inputs; only the implementation/verification pair re-runs.
- **No canonical-intent revision by an implementation agent.** An
  implementation realizes the accepted proposal; if it cannot, it reports a
  blocker rather than rewriting what the business is taken to have decided.
- **No new impact algorithm.** `analyzeImpact` is called, not duplicated.
- **No worktree/branch subsystem.** The state binding is proven, and refused
  when it cannot be.
- **No confidence scores, no semantic similarity, no LLM adjudication of
  completion.** Every conjunct of the invariant is decided from a record.
- **No automatic stakeholder approval, no production telemetry, no
  cross-repository orchestration, no ATMS worlds, no graph visualization.**
- **No implicit cross-project reasoning.** Knowledge lives in one ledger and is
  retrieved by scope (§3a). A run reads its own project's records; reading
  another's takes a declared `alsoRead`, writing to another's is refused
  outright, and a derivation may not cross a scope at all.

## 18. Persistence

**Authoritative store:** `~/.claude/argus/knowledge.json`, one JSON document:

```json
{ "version": 8, "claims": [...], "evidence": [...], "justifications": [...], "consumptions": [...], "artifacts": [...], "deltas": [...], "supplied": [...], "verifications": [...], "changeProposals": [...], "acceptanceVerifications": [...], "changeRealizations": [...] }
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
put into each run's context (§13.10); **version 5** (Phase 6) added
`verifications`, implementation conformance bound to an exact claim revision
and an exact repository revision (§15.3); **version 6** (Phase 7) added
`changeProposals`, the durable record of the requested change that caused a
revision to exist (§16.11); **version 7** (Phase 8) added
`acceptanceVerifications` and `changeRealizations` (§17.2, §17.6);
**version 8** added `Claim.scope` — knowledge ownership (§3a) — and **no array
and no existing field at all**, so a version 7 document upgrades by carrying
its records forward exactly as they are.
A version 1–7 file is read as version 8 with the missing arrays empty
and is rewritten in that shape by the next successful transition — nothing an
earlier phase recorded changes, no supplied provenance is invented for the runs
it already holds, no rule gains a conformance it never had (an upgraded rule is
`unverified`, never `holds`), no revision gains a request that never asked for
it, no criterion gains a result nobody established (`unverified`, never
`satisfied`), no accepted change gains a realization nobody ran, **no claim
gains a project it was never recorded against** (an upgraded claim stays
unscoped, and a scoped pipeline is refused rather than inheriting it), and
reading alone never writes. Any other version
is treated as foreign: readable as empty, never overwritten.

**Staging stores:** `~/.claude-argus/knowledge-deltas/<runId>/` — `delta.json`
(the agent's document) and `staged.json` (Argus's record, §12.13) — and
`~/.claude-argus/rule-verifications/<runId>/` — `verification.json` (the
agent's document) and `staged.json` (Argus's record, §15.10) — and
`~/.claude-argus/change-proposals/<runId>/` — `proposal.json` (the agent's
document) and `staged.json` (Argus's record, §16.5) — and
`~/.claude-argus/acceptance-verifications/<runId>/` — `acceptance.json` (the
agent's document) and `staged.json` (Argus's record, §17.7). Per run, like
the result file and the invocation directory — and pruned with the run, like
them; the ledger's own `deltas`, `verifications`, `changeProposals`,
`acceptanceVerifications` and `changeRealizations` records
are what outlive pruning. Never canonical; written with the same atomic writer.

**The retention rule, once:** heavy operational records (run json, log,
invocation directory, materialized context, change-context, implementation-scope
and remediation-context files, delta, verification, change-proposal and
acceptance staging) are prunable; small semantic provenance (claims,
evidence, justifications, consumptions, artifact productions, applied deltas,
supplied contexts, rule verifications, accepted change proposals, acceptance
verifications, change realizations) is durable. A realization therefore still
answers "was CP-12 implemented, by which runs, at which repository state, and
proved by what?" long after every run log has been pruned.
§13.12
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

## 19. Important invariants

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
29. **Rule support ≠ implementation conformance.** A verification creates no
    evidence, no justification and no claim; it appends to `verifications[]`
    and nothing else reads that array. A `violated` implementation leaves its
    rule exactly as supported as it was, and never appears in an `ImpactSet`
    (§15.1, §15.11).
30. **A verification is bound twice and retargeted never.** It names one exact
    `ClaimRef` and one exact `gitHead`. A new rule revision and a new commit
    each start `unverified`; nothing rewrites, restates or marks stale an
    older record (§15.9).
31. **`unverified` ≠ `unverifiable`.** Nobody looked, versus somebody looked
    and could not tell. Derived at read time from a scoped question, so Argus
    never reports an older commit's conclusion as a statement about a newer
    one (§15.2, §15.9).
32. **Every selected rule gets exactly one outcome.**
    `selected = holds ∪ violated ∪ unverifiable`. A missing rule, an
    unsupplied rule, or no file at all refuses the whole proposal — silent
    omission is the one thing completeness forbids (§15.7).
33. **An agent may cite a check; it may not claim one passed.** A `check`
    label must be one the phase declares, and its `status`, `exitCode` and
    `detail` are bound from Argus's own `VerificationReport` at the commit
    boundary. `holds` never rests on an agent's assertion alone (§15.7,
    §15.8).
34. **Repository containment is decided on the resolved real path.** For every
    source-code evidence record Argus validates, `realpath(candidate)` must
    stay inside `realpath(root)`; a repository-internal symlink pointing
    outside the tree is refused, lexical containment notwithstanding (§15.13).
35. **A request is not a rule.** A `ChangeRequest` is never written into the
    ledger as a claim. It is carried, frozen, on the accepted proposal that
    answered it, and nothing it says becomes canonical without a person
    approving a gate (§16.1, §16.3).
36. **Change provenance is not justification.** An accepted change proposal is
    its own array, read by the change queries and by nothing else. It creates
    no evidence and no justification, and it never enters support evaluation
    or `analyzeImpact`: "the business asked for it" is not an argument that a
    claim is true (§16.1, §16.11).
37. **An acceptance criterion is not a business rule.** Criteria are evidence
    that one change was carried out, live on the accepted proposal, and are
    never stored as claims (§16.6).
38. **Desired semantics are never inferred from current behaviour.**
    Conformance reaches a change proposal as input and as a warning. A rule is
    revised because a request said the business changed — never because the
    code differs — and no verification is ever rewritten to make the past
    agree with a requested future (§16.9).
39. **Every relevant rule is accounted for, or the proposal is refused.** A
    supplied rule that is neither revised, preserved, not-relevant nor
    unresolved refuses the proposal, as does an accounting that contradicts
    the semantic delta: silence about a supplied rule is indistinguishable
    from not having considered it (§16.5, §16.8).
40. **A local reference never outlives its commit.** Every delta-local id in a
    proposal's criteria and questions is resolved to the canonical revision
    the commit minted, and one the commit did not create refuses the whole
    transition (§16.10).
41. **Only an accepted proposal can reach a downstream run.** A `changeContext`
    selector resolves exclusively from the ledger's accepted proposals, so a
    proposal staged at a gate resolves to nothing — by construction, not by a
    check (§16.11).
42. **Completion is a conjunction, and no conjunct is an agent's word about
    its own work.** Execution success, deterministic checks, rule conformance
    and acceptance satisfaction are four independent dimensions; a realization
    succeeds only when all four hold, at one proven repository state, against
    intent that is still current. `ARGUS_OUTCOME: succeeded`, a green test
    suite, and "every rule holds" are each necessary and none is sufficient
    (§17.1).
43. **The four dimensions never rewrite one another.** A violated criterion
    leaves its rule's conformance exactly as it was, and a violated rule leaves
    every satisfied criterion satisfied. Completion combines them; nothing
    merges them (§17.1, §17.6).
44. **A conformance result names the implementation it examined, not just the
    commit.** Two dirty working trees at one `gitHead` are two different
    `RepositoryStateRef`s, distinguished by the content hash of Argus's own
    snapshot. A record with no state answers only a clean question at its head
    (§17.3).
45. **The verified state is the implemented state, or nothing is claimed.**
    The state the implementation produced and the state the verification
    examined must be the same, and a mismatch — or two verification runs that
    disagree — fails closed as `state-mismatch` (§17.4).
46. **A criterion is addressed by `(proposal, criterion)`.** `AC-1` is
    proposal-local; CP-11's AC-1 can never satisfy CP-12's, and a result's
    statement is read from the accepted proposal rather than from the agent's
    document (§17.6).
47. **Every required criterion is accounted for, or the whole result is
    refused.** `required = satisfied ∪ violated ∪ unverifiable`, each exactly
    once; a missing one, an extra one, or no file at all refuses the document —
    and `unverified` (nobody looked) is never collapsed with `unverifiable`
    (somebody looked and could not tell) (§17.6, §17.7).
48. **An implementation scope is derived, never guessed, and never claims to
    be complete.** Every target carries a closed reason code naming the exact
    claim, execution or evidence record it came from; a change nothing has ever
    implemented reports `scope-incomplete`, never an empty "nothing to do"
    (§17.5).
49. **A realization is append-only in its attempts and write-once in its
    verdict.** A remediation never rewrites the attempt it is remediating, and
    a realization that ended cannot be re-ended differently (§17.2).
50. **A realization is never retargeted.** Its `proposalId`, its `target` and
    its `scope` are frozen at creation; a newer proposal accepted while it runs
    makes it `stale`, not re-aimed (§17.2, §17.12).
51. **Autonomous remediation is bounded by the author.** `maxAttempts` is
    validated when the pipeline is saved, checked before every spawn, and its
    exhaustion is a terminal state with a reason — never another attempt. A
    blocker, an unverifiable required criterion, a stale target and a state
    mismatch stop the loop with attempts still remaining (§17.11).
52. **Remediation is not retry and not revise.** Three different facts, three
    journal kinds, three budgets: a remediation leaves the phase's retry budget
    untouched and re-runs only the implementation/verification pair (§17.10).
53. **Accepted intent is checked for bytes, never for currency.** The
    ChangeContext, the ImplementationScope and the RemediationContext are
    hashed at launch and re-hashed at completion; a newer proposal is not
    tampering, and staleness is decided from the ledger at close-out (§17.8).

## 20. What Phases 1–8 deliberately do NOT do

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
- **No automatic remediation or re-verification.** A `violated` result is a
  report; a new commit makes a rule `unverified`. Nothing edits code, opens an
  issue or schedules a run (§15.15).
- **No confidence scores on conformance, and no fourth outcome.** Uncertainty
  is named `unverifiable`, with a reason, and is never rounded up to `holds`.
- **No verification-driven rule revision.** A breach never proposes, weakens or
  contests the rule it breached.
- **No mutation API for conformance.** Only an accepted verification phase's
  commit creates a `RuleVerification`; there is no `POST`, no edit, no delete.
- **No change to what `ImpactSet` means.** Verifications are not semantic
  dependents and never enter impact analysis (§15.11).
- **No code modification, autonomous implementation, targeted re-execution,
  automatic remediation, PR creation or merge.** Phase 7 ends at accepted
  semantic intent; an implementation phase receives it and nothing else
  happens automatically (§16.15).
- **No Jira integration, automatic change-request generation, automatic
  stakeholder approval, production telemetry or domain-owner integration.** A
  `ChangeRequest` arrives from pipeline authoring or from the instance's
  trigger payload, and from nowhere else.
- **No inference of a request from code, and no invented business values.** An
  ambiguous request produces an `UnresolvedQuestion` and a `needs-input`
  proposal, never a guessed number (§16.7).
- **No acceptance criteria as claims, and no test DSL.** `verificationHint` is
  one line of prose Argus never executes (§16.6).
- **No task decomposition beyond semantic intent.** Phase 7 proposes what the
  domain would have to say; it does not plan, estimate or schedule the work.
- **No mutation API for change intent.** A proposal becomes canonical exactly
  one way: an agent proposes it, a person approves the gate, and the phase's
  commit writes it (§16.15).
- **No PR creation or merge, no deployment, no Jira, no Slack, no stakeholder
  approval, no production telemetry.** A realization ends at a verified
  repository state (§17.19).
- **No unbounded remediation.** The `implement → verify → implement` loop is
  bounded by the author's `maxAttempts`, and four outcomes stop it even with
  attempts remaining.
- **No re-running of earlier accepted work.** A remediation re-opens the
  implementation phase and the phases between it and its verifier, and nothing
  else: discovery and change intent are historical inputs.
- **No canonical-intent revision by an implementation agent.** An
  implementation realizes the accepted proposal; when it cannot, it reports a
  structured blocker rather than rewriting what the business decided.
- **No second impact algorithm.** `analyzeImpact` is called by scope
  derivation, not duplicated by it.
- **No worktree or branch subsystem.** The verified-state binding is _proven_
  from snapshots that already existed, and refused when it cannot be.
- **No mutation API for completion state.** Only the pipeline engine's own
  acceptance boundaries open, advance and close a realization.
- **No confidence scores on completion, and no LLM adjudication of it.** Every
  conjunct of the invariant is decided from a record Argus wrote.
- **No global daemon re-evaluating impacted work.** `analyzeImpact` still
  reports; nothing schedules a realization because a rule changed (§17.16).

## 21. How this prepares the next steps

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

Phase 6 adds the dimension the ledger could not previously express: whether the
code does what the rules say. It is a second, orthogonal axis over the same
canonical rules — bound to an exact revision and an exact commit, staged and
accepted like everything else an agent proposes, and rigorously insulated from
the support model so a bug never reads as a doubt:

```
Knowledge Ledger
      ↓  selectors (§13)
KnowledgeContext — the exact rules this phase answers for
      ↓  ARGUS_RULE_VERIFICATION_FILE
verification agent  → structured conformance proposal
      ↓  completeness · exact refs · evidence floors · check labels · realpath
staged record (not canonical)
      ↓  PhaseChecks → check evidence bound from Argus's own report
      ↓  gate → phase acceptance
RuleVerification (knowledge.json: rule × gitHead × outcome, append-only)
      ↓
ruleConformance(rule, gitHead?)  →  holds | violated | unverifiable | unverified
```

The state Argus can now hold about one rule is the state a change needs as its
input: _what the rule says_, _what grounds it_, _what the code does about it_,
and _at which commit each of those was last established_.

Phase 7 built exactly that: change-intent orchestration. A requested business
change now becomes a structured, reviewable semantic transition, through the
existing KnowledgeDelta and KnowledgeContext primitives and the same
candidate/gate/commit boundary — with one new durable record, the accepted
proposal, which is change _provenance_ rather than knowledge:

```
ChangeRequest        (authored, or supplied when the instance starts)
      +
KnowledgeContext     — what the domain currently says
      +
RuleVerification     — what the code currently does, at one commit
      ↓  ARGUS_CHANGE_REQUEST_FILE
change-intent agent  → ChangeProposal
      ↓  completeness · classification · criteria coverage · local refs
staged record (not canonical)
      ↓  gate → phase acceptance, ONE transition
semanticDelta commits  +  AcceptedChangeProposal (knowledge.json)
      ↓  ARGUS_CHANGE_CONTEXT_FILE
implementation phase:  KnowledgeContext + ChangeContext
                       what is true · what this change makes true ·
                       what must stay true · how success is judged
```

The state Argus can now hand an implementation run is, for the first time,
complete: the domain's current semantics, the intended transition with its
exact canonical refs, the revisions that must keep behaving as they do, and the
observable criteria the work will be judged by.

Phase 8 closes the loop on that. An accepted proposal now becomes a durable
**ChangeRealization**: a deterministic implementation scope derived from
provenance Argus already held, an implementation run against
KnowledgeContext + ChangeContext + scope, Argus's own deterministic checks, and
two independent semantic verifications — rule conformance and acceptance
satisfaction — bound to the exact repository state the implementation produced.
Where the change is unmet, a _targeted_ remediation receives the exact failing
rules and criteria and only the implementation/verification pair re-runs, under
a bound the author wrote:

```
accepted ChangeProposal
      ↓  deterministic scope: ImpactSet ∪ source evidence ∪ request scope
ImplementationScope         (known-targets, or an honest scope-incomplete)
      ↓  KnowledgeContext + ChangeContext + ImplementationScope
implementation run
      ↓  PhaseChecks                          Argus's own observation
verification run
      ↓  RuleVerification   +   AcceptanceVerification
      ↓  one ledger transition, at the phase's acceptance boundary
ChangeRealization
      succeeded            every dimension held, at one proven state
      needs-remediation    → targeted remediation → re-verification
      failed / stale       the exact rules and criteria that remain unmet
```

The foundational loop is therefore complete: Argus can discover what the
business says, represent and revise it with provenance, reason about an
explicit requested change, implement it with agents, independently verify both
technical and business correctness, and selectively remediate what is unmet —
with every step of that chain decided from a record rather than from a model's
opinion. What remains beyond it is delivery (pull requests, deployment,
ticketing), organization-wide mining, and semantic search: capabilities that
build _on_ this foundation rather than completing it.

The smallest coherent Phase 5 was **deterministic semantic context selection
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

## 22. Where the code lives

| Path                                          | Role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/src/knowledge.ts`                  | wire types: Claim, ClaimRef, Evidence, Justification, ClaimConsumption, ArtifactProduction, ExecutionProvenance, ImpactSet, SuppliedContext, ContextIntegrityResult, RuleVerification, ChangeRequest, ChangeProposal, AcceptanceCriterion, AcceptedChangeProposal, ChangeContext, RepositoryStateRef, ImplementationScope, AcceptanceVerification, ChangeRealization, RemediationContext                                                                                                                                                                                                                                                                                                                               |
| `server/src/knowledge/scope.ts`               | knowledge scope: repository identity derivation, scope-qualified claim ids, the per-snapshot scope index, policy validation (§3a)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `server/src/knowledge/kernel.ts`              | pure transitions and queries; the only definition of support; the provenance transitions and `executionProvenance`; the Phase 8 records (`recordAcceptanceVerification`, `startChangeRealization`, `appendRealizationAttempt`, `closeChangeRealization`) and the repository-state predicates (`sameRepositoryState`, `repositoryStateAnswers`)                                                                                                                                                                                                                                                                                                                                                                         |
| `server/src/knowledge/impact.ts`              | `analyzeImpact` — the pure, deterministic impact algorithm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `server/src/knowledge/validate.ts`            | untrusted body → typed proposal; the structural `source-code` evidence rules (repository-relative path, line range, commit sha)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `server/src/knowledge/store.ts`               | the authoritative JSON document (v7); mints ids, stamps time, upgrades v1–v6; `commitPhaseSemantics` (deltas + rule verifications + accepted change proposals + acceptance verifications in one transition), `openChangeRealization` / `recordRealizationAttempt` / `closeRealization`, and `registerSuppliedContext` under the ledger mutex                                                                                                                                                                                                                                                                                                                                                                           |
| `server/src/knowledge/delta.ts`               | the KnowledgeDelta protocol's pure half: `validateKnowledgeDelta`, `applyKnowledgeDeltas` (preflight + atomic application)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `server/src/knowledge/staging.ts`             | per-run staging: the agent's file, Argus's record, status transitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `server/src/knowledge/context.ts`             | the KnowledgeContext protocol: `parseKnowledgeContextSpec`, `resolveKnowledgeContext` (pure, one snapshot, `claims` + `fromPhases`), projection, hash, the per-run file, `verifyKnowledgeContextIntegrity`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `server/src/knowledge/ruleVerification.ts`    | business-rule verification (Phase 6): `RULE_VERIFICATION_CONTRACT` and `verificationInstruction`, `validateRuleVerificationReport`, `selectedRules`, `completenessRefusal`, `checkRuleVerification`, `bindCheckEvidence`, `holdsPolicyRefusal`, `previewRuleVerification`, `summarizeRuleVerification`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `server/src/knowledge/verificationStaging.ts` | per-run verification staging: the agent's file, Argus's record, status transitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `server/src/knowledge/changeIntent.ts`        | change-intent orchestration (Phase 7): `CHANGE_INTENT_CONTRACT` and `changeIntentInstruction`, `validateChangeRequest`, `validateChangeProposal`, `selectedChangeRules`, `buildChangeIntentInput`, `changeProposalWarnings`, `checkChangeProposal`, `changeReadiness`, `resolveChangeAcceptance`, `buildChangeContext`, `previewChangeProposal`, `summarizeChangeIntent`                                                                                                                                                                                                                                                                                                                                               |
| `server/src/knowledge/changeStaging.ts`       | per-run change-proposal staging: the agent's file, Argus's record, status transitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `server/src/knowledge/implementationScope.ts` | deterministic implementation scope (Phase 8): `deriveImplementationScope` (ImpactSet ∪ source evidence ∪ verification evidence ∪ preserved evidence ∪ request scope, with closed reason codes), `implementationScopeInstruction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `server/src/knowledge/acceptance.ts`          | acceptance-criterion verification (Phase 8): `ACCEPTANCE_VERIFICATION_CONTRACT` and `acceptanceInstruction`, `validateAcceptanceReport`, `acceptanceCompletenessRefusal`, `checkAcceptanceReport`, `bindAcceptanceChecks`, `acceptanceCheckRefusal`, `previewAcceptance`, `summarizeAcceptance`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `server/src/knowledge/acceptanceStaging.ts`   | per-run acceptance staging: the agent's file, Argus's record, status transitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `server/src/knowledge/realization.ts`         | the completion invariant (Phase 8): `evaluateCompletion`, `requiredRules`, `repositoryStateFrom`, `technicalResultFrom`, `buildRemediationContext`, `remediationInstruction`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `server/src/knowledge/sourcePath.ts`          | `realpath`-based repository containment for every source-code evidence record Argus validates (§15.13)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `server/src/knowledge/discovery.ts`           | business-rule discovery (Phase 5): `DISCOVERY_CONTRACT` and `discoveryInstruction`, the source-evidence checks, `semanticWarnings`, `checkDiscoveryDelta`, `previewKnowledgeDelta`, `summarizeDiscovery`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `server/src/harness/channels.ts`              | every Argus-owned invocation channel — the delta file, the read-only context file, the three change-intent files and Phase 8's implementation-scope, remediation-context and acceptance-verification files: kind, env var, path, access, required (HARNESS.md §3a)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `server/src/knowledge/routes.ts`              | `/api/knowledge` (mounted and admin-gated in `app.ts`), including the delta inspection reads, the context reads (`/executions/:runId/context`, `/claims/:key/supplied-to`) and the change-provenance reads (`/change-proposals`, `/claims/:key/change-proposal`)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `server/src/pipelineTransitions.ts`           | `succeedPhase` (the hold), `applyKnowledgeCommit` (the verdict), `stagedDeltaIds`, `stagedVerificationIds`, `stagedChangeProposalIds`, `stagedAcceptanceIds`, and `applyRemediation` — which re-opens one implementation phase and the phases that verify it, and nothing else                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `server/src/pipelineEngine.ts`                | `acceptCompletion`, `checkContextIntegrity`, `intakeKnowledgeDelta`, `verifyDeltaArtifacts`, `commitPhaseKnowledge`, `settleKnowledge`, `retireStagedDeltas`; `KNOWLEDGE_DELTA_CONTRACT`; the per-attempt ledger snapshot, `knowledgeContextInstruction`, `KNOWLEDGE_CONTEXT_CONTRACT`; the discovery checks at intake and commit, and `refreshDiscoverySummary`; `intakeRuleVerification`, `verificationProposalsOf`, `refreshVerificationSummary`; `resolveChangeRequest`, `intakeChangeProposal`, `changeAcceptancesOf`, `refreshChangeIntentSummary`                                                                                                                                                               |
| `server/src/sources/artifacts.ts`             | the gate review, including the candidate-knowledge previews a discovery phase's reviewer reads, the conformance previews a verification phase's reviewer reads and the change-proposal previews a change-intent phase's reviewer reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `web/src/views/GateDrawer.tsx`                | the one place a human decides on a gate; the Candidate knowledge panel, the Business-rule verification panel, the Change intent panel, and Phase 8's Change realization header and Acceptance criteria panel — shown _beside_ the rule panel, never merged with it                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `server/src/knowledge/*.test.ts`              | kernel semantics, impact scenarios, persistence roundtrip, HTTP contract, delta validation/application, engine lifecycle, context resolution and delivery; `contextDurability.test.ts` for durable supply, retention and integrity; `discovery.test.ts` and `discoveryEngine.test.ts` for Phase 5; `ruleVerification.test.ts` and `verificationEngine.test.ts` for Phase 6; `changeIntent.test.ts` and `changeEngine.test.ts` for Phase 7; `implementationScope.test.ts`, `acceptance.test.ts`, `realization.test.ts` and `realizationEngine.test.ts` for Phase 8, with `harness/verificationE2e.test.ts`, `harness/changeIntentE2e.test.ts` and `harness/realizationE2e.test.ts` for the real-process worked examples |
| `docs/API.md` § Knowledge Ledger              | endpoint reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
