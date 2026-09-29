# RFC: A provider-neutral Decision Plane for Argus

_Status: **proposal, not implemented**. Architecture investigation only. No
code in this repository changes because of this document._

_Scope: every place Argus decides something; the hypothesis that an explicit
**inferred** layer belongs between Argus's evidence and its policy; how such a
layer would relate to the Knowledge Ledger; and the smallest experiment that
could tell us whether it earns its place. TypeSafe's Jev is treated as one
possible provider. It is mapped last, and only onto an abstraction that
belongs to Argus._

Line references are to the tree at `232ba4a`. `E` = `server/src/pipelineEngine.ts`,
`K` = `server/src/knowledge/kernel.ts`, `C` = `contracts/src/knowledge.ts`.

---

## A. Executive conclusion

**The gap is real, but it is not empty. Argus already has an inferred layer.
It has no name, no contract and no invariants, and in one place it already
breaks the rules this RFC would impose.**

1. **A proto-decision-plane already exists.** `server/src/sources/analysis.ts`
   calls itself "the one place Argus asks a model a question about its own
   state". Five passes run through it:
   - Autopsy: a closed-taxonomy _choice_ plus a 0–1 confidence.
   - Verdict: per-criterion 0–10 _scores_, combined by Argus-owned
     arithmetic and compared against an author threshold.
   - Sentinel's diagnosis.
   - Tuning.
   - The Omnibar planner.

   The runner is headless-CLI only. It is bounded in time, output, concurrency
   and spend, and it runs with no tools. Its output stores are small capped
   JSON arrays. No record carries the provider, model, prompt version, input
   hash or repository state.

2. **One of those judgments already crosses into authority.** Verdict's
   `autoApprove` opens pipeline gates (`verdictWatcher.ts:127-163`). Three
   checks confirm the gap:
   - I confirmed by running `validatePipelineInput` that a gated `changeIntent`
     phase and a `ruleVerification` phase both accept
     `rubric + autoApprove: { verdict: 5 }`.
   - Approval is the knowledge commit boundary (`E:5530-5532`,
     `settleKnowledge`).
   - The approval records no actor. `phase.approved` is declared in
     `journal.ts:50` and never written.

   The consequence: a cheap model's score of the **agent's own final message**
   can make a change proposal or a verification canonical in `knowledge.json`.
   Afterwards that is indistinguishable from a human decision. The agent being
   judged authors the judge's input, so it can steer the judge. This is the
   exact failure mode Codex's constraints 2, 5 and 12 name, and it exists
   today, with no Jev anywhere.

3. **So the Decision Plane is justified, and the value is governance rather
   than intelligence.** The new subsystem is worth building for three reasons:
   - It gives the inferred layer an append-only, state-bound, replayable
     journal.
   - It gives it an epistemic status the ledger cannot confuse with support.
   - It gives it a policy rule that an assessment can **add friction but never
     remove it** until measured calibration says otherwise. It can never do
     so on a boundary that commits knowledge.

   A second provider (Jev) is a benefit on top of that, not the reason for it.

4. **Several of Codex's candidate P questions are D or H in Argus.**
   - "What class of remediation is needed?" is already deterministic inside
     realizations. `evaluateCompletion` orders six conjuncts precisely so the
     failure class is mechanical.
   - "Does evidence sufficiently support R17?" collides with
     `evaluateSupport`, the ledger's only definition of support. It must not
     be a Decision Plane question under that name.
   - Several Autopsy classes (`timeout`, `infrastructure` via
     `spawn-failed`) are facts already on the run record (`Run.termination`,
     `PhaseFailureClass`). The model is asked to guess them anyway.

5. **Recommendation, in order.**
   1. **Phase 0 (this week, independent of any provider):** close the
      autoApprove-on-knowledge hole, journal gate decisions with their actor,
      and stamp provider identity on the existing Verdict and Autopsy records.
   2. **Phases 1–2:** introduce the journal and the provider seam around the
      existing `AnalysisRunner`, and shadow two questions (§H) using Claude
      providers and a deterministic baseline.
   3. **Phase 3:** add Jev only after you decide on data egress (§L).

   No probability participates in gating before Phase 4. Even then it only
   escalates.

The refinement I would make to the framing: _known → inferred → generated →
permitted_ is one bucket short for Argus. The ledger does not hold what is
**known**. It holds what was **accepted** through a boundary, and a lot of it
is agent-authored. Argus's own **observations** (check exit codes, hashes,
git state, termination causes) are a different and stronger thing. The
ladder that fits the code is:

```
observed  → accepted   → inferred    → generated → permitted
(Argus's    (ledger:     (Decision     (agents)    (policy +
 own eyes)   passed a     Journal)                  humans)
             boundary,
             on someone's
             authority)
```

`RuleVerification.policy` (`agent-evidence` vs `deterministic-check`) already
encodes the observed/accepted distinction for one record type. The Decision
Plane generalises the pattern one rung down.

---

## B. The current architecture, reconstructed from code

### B.1 Planes that already exist

```
                   ┌────────────────────────── GENERATIVE ─────────────────────────┐
                   │ claude -p · codex exec · opencode run · qwen   (runtimes/*.ts) │
                   └───────┬───────────────────────────────────────────┬───────────┘
          ARGUS_OUTCOME,   │ result.json, KnowledgeDelta, RuleVerif.,   │ transcripts,
          Stop hook        │ ChangeProposal, AcceptanceVerification     │ resultSummary
                           ▼                                            ▼
┌──────────── OBSERVED (Argus's own) ────────────┐   ┌──── ANALYSIS (proto-inferred) ─────┐
│ exit code · termination · deadline/stall       │   │ sources/analysis.ts AnalysisRunner │
│ VerificationReport (PhaseChecks)               │   │  autopsy · verdict · diagnose ·    │
│ invocation.gitHead · RepositoryStateRef        │   │  tune · plan    (haiku by default) │
│ supplied-context sha256 · artifacts            │   │ autopsies.json(200) verdicts(400)  │
└──────────────────────┬─────────────────────────┘   └───────┬───────────────┬────────────┘
                       │                                     │ autoApprove   │ failureClass
                       ▼                                     │ (gate open)   │ → Issues
┌──────────── ACCEPTED (Knowledge Ledger) ───────┐           │               │ clustering
│ knowledge.json v8, never pruned                │◄──────────┘ (via approve → settleKnowledge)
│ claims/evidence/justifications → evaluateSupport (pure, derived)           │
│ verifications · acceptanceVerifications · changeProposals · realizations   │
│ impact (analyzeImpact), currency (derived, never written back)             │
└──────────────────────┬─────────────────────────────────────────────────────┘
                       ▼
┌──────────── PERMITTED (policy + orchestration) ──────────────────────────────┐
│ pipelineTransitions.settle() · dag.ts readiness · routing.ts · retry policy  │
│ gates (human approve/revise/abort) · evaluateCompletion · remediation bound  │
│ budget ladder (schedules + analysis only) · capability/strict enforcement    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### B.2 What each layer decides with

- **Orchestration is pure code over records.**
  - `settle()` (`pipelineTransitions.ts:345`) is the single transition
    point.
  - Routes are evaluated once and persisted as `inst.routeDecisions`, which
    are replayed and never recomputed (`:244-257`).
  - Retries depend only on `PhaseFailureClass` (`:1266-1292`).
  - Candidate selection (best-of-N) uses Argus's checks plus cost and
    duration (`:856-885`).
  - Realization completion is one pure function, `evaluateCompletion`
    (`knowledge/realization.ts:191`).
- **The ledger's epistemics are deliberately probability-free.**
  - `evaluateSupport` is pure and total: `supported | unsupported |
    contested`, with no confidence (`K:1142`).
  - `RuleVerification` says "Deliberately no confidence score"
    (`C:1309-1311`).
  - Uncertainty is expressed only as the `assumption` kind, the
    `unverifiable` outcome with a reason, `UnresolvedQuestion` /
    `needs-input`, and `contested`.
- **Semantic judgment is done by generative agents inside verifier phases.**
  Examples: "does `if (len > 180)` implement RULE-42?" (`RuleVerification`)
  and "is AC-3 satisfied?" (`AcceptanceVerification`). Argus validates shape,
  completeness, references, evidence floors and check bindings. It does not
  validate meaning (§15.7: _"A structured result is not a proof"_). A gate is
  the intended human check.
- **Execution success comes from agent self-report plus Argus observation.**
  `ARGUS_OUTCOME` via the Stop hook (`hooks/argus-signal.mjs:130`) or the
  run-record fallback (`E:704`), then result validation, then Argus's checks,
  then the gate.

### B.3 Where the code differs from the design documents

These are the discrepancies that bear on this RFC. The ones marked ✔ I
reproduced or read myself. The rest are cited from code by the investigation
and consistent with what I read.

| # | Design says | Code does |
|---|---|---|
| 1 ✔ | Change intent "never become[s] canonical without a person" (`E:4257`) | `autoApprove` is accepted on `changeIntent` and `ruleVerification` phases, and `openQualifiedGates` does not exclude knowledge phases |
| 2 ✔ | The journal records revisions and approvals (`journal.ts:10-13`) | `phase.approved`, `phase.revised` and `phase.succeeded` are declared and never emitted. Auto-approval is only a `log.info` (`index.ts:305`). No approver identity exists anywhere |
| 3 ✔ | A missing completion marker is a failure (`recoverRunOutcome`, `E:721-736`) | On the hook path (Claude, Qwen) a missing marker resolves to **`completed`** (`argus-signal.mjs:130-136`). The same agent behaviour has opposite outcomes depending on runtime |
| 4 ✔ | Discovery rules are gated ("mandatory", §14.9 and `C:1011`) | Nothing enforces it. §14.2 itself says "nothing forces it" |
| 5 ✔ | Discovery rules must carry source-code evidence (§14.5) | `supportOf` counts any supporting evidence, so an agent-written `{type:"human"}` satisfies the check |
| 6 ✔ | Requests are "never an argument that a claim is true" (§16) | The change-intent contract tells the agent to attach the request as supporting `document` evidence (`changeIntent.ts:182-183`) |
| 7 | "`holds` never rests on an agent's assertion alone" (invariant 33) | Under the default `agent-evidence` policy, one `observation` suffices |
| 8 | "No conjunct is an agent's word about its own work" (invariant 42) | Conjunct 1 and `blocked` come from `ARGUS_OUTCOME` |
| 9 ✔ | `needs-input` is a gate after validation (HARNESS §2) | `needs-input` sets `awaiting-approval` before result validation, checks and intake (`pipelineTransitions.ts:484`) |
| 10 | Snapshot identity is "content hashes, never timestamps" | Files over 8 MiB and symlinks use `size:mtime` (`harness/verification.ts:138`) |
| 11 | Budget hard stop | Applies to schedules and analysis passes. No pipeline start path checks it |
| 12 | Journal as the audit trail | The journal file is deleted once it passes 512 KB (`journal.ts:139-141`) |
| 13 ✔ | Signal authentication | The per-instance token sits in the agent's own environment (`E:2101`), so any process the agent runs can POST `completed` for itself or a sibling |

Items 1–2 are the ones a Decision Plane must fix before it adds anything.
Items 3–13 are independent defects, found along the way and listed here so
they are not lost.

---

## C. Decision Surface Map

**D** deterministic · **P** probabilistic semantic judgment · **G**
generative · **H** human authority.

The "Unc." column asks whether uncertainty is meaningful, meaning a calibrated
probability would carry information that a hard answer does not.

The "Replay" column asks whether a durable record exists that would let a
shadow provider be scored against what happened.

### C.1 Execution and orchestration

| # | Decision | Where | Mechanism today | Class | Unc. | Wrong → / reversible | Replay | Shadow fit |
|---|---|---|---|---|---|---|---|---|
| 1 | Signal type from the final message | `argus-signal.mjs:46,130` | unanchored regex over agent text; no marker = completed | **D** over a G self-report | no | false success moves the phase on; only a human revise undoes it | payload on instance | none. Unify with #2 deterministically |
| 2 | Outcome from the run record | `E:683,704-754` | line-anchored regex; missing or conflicting marker = failed | D | no | same | `Run.outcome` | none |
| 3 | Signal acceptance | `E:5381-5439`, `app.ts:1596` | token plus tracked runId | D (security) | no | forged completion | — | none. Fix the token scope instead |
| 4 | Result-file validity | `pipelineTransitions.ts:176-225` | schema | D | no | phase fails (`signal`) | result on instance | none |
| 5 | Result **content** used for routing | `routing.ts:119-170` | the agent writes e.g. `{"verdict":"fail"}` | **G** (agent's decision) routed by D | yes | wrong branch; skips are irreversible | `routeDecisions` + result | later: P second opinion on audit-style results |
| 6 | DAG readiness and skip propagation | `dag.ts:109-348` | graph rules | D | no | — | — | none |
| 7 | Retry eligibility and backoff | `pipelineTransitions.ts:1266-1292` | failure class ∈ `retryOn` | D | no | wasted run, or a missed retry | `retries`, `retryAt`, journal | none |
| 8 | Retry-note content | `E:808-860` | class-specific evidence tail | D | no | a worse retry prompt | only inside `Run.prompt` | none |
| 9 | Deadline and stall | `invocation.ts:282`, `harness/stall.ts:43` | wall clock | D | no | killed a slow-but-alive run | `Run.termination` | none |
| 10 | Checks pass or fail | `harness/verification.ts:566` | exit codes, stat, globs | D (**observed**) | no | caveat: scripts live in the agent-edited tree | report, current attempt only | none |
| 11 | Best-of-N selection | `pipelineTransitions.ts:856` | checks, then cost/duration | D | yes, among passing candidates | losers' worktrees destroyed; irreversible | `candidateOutcomes` | good later P candidate ("which passing candidate better meets intent?"); ROADMAP.md:131 defers it |
| 12 | Runtime, capabilities, workspace | `runtimes/index.ts:77`, `invocation.ts:52-332` | narrowest-wins; strict enforcement | D | no | configuration failure | invocation.json | none |
| 13 | Budget enforcement | `budget.ts:247`, `scheduler.ts:409` | ratios and ladder | D | no | overspend or a blocked run | `budgetAction` on run | none |
| 14 | Gate: approve / revise / abort | `E:5514-5622` | **human** (admin-gated UI) | **H** | — | wrong acceptance commits knowledge | **only state changes; no decision record, no actor** | this is the ground truth for H1 (§H), once it is recorded |
| 15 | Gate: Verdict auto-approve | `verdictWatcher.ts:127-163` | haiku 0–10 per criterion, min over judged steps ≥ bar | **P → policy → transition** | yes, and **uncalibrated** | same as #14, and invisible | verdicts.json (400, overwritten on re-judge); approval unrecorded | the incumbent to beat in H1 |
| 16 | `needs-input` pause | `pipelineTransitions.ts:484`; `claude.ts:212` | agent asks | G → H | — | skips validation (B.3 #9) | payload | none |

### C.2 Knowledge ledger

| # | Decision | Where | Mechanism today | Class | Unc. | Wrong → / reversible | Replay | Shadow fit |
|---|---|---|---|---|---|---|---|---|
| 17 | Delta schema, references, scope, preflight | `delta.ts:287-558` | code | D | no | bad delta refused (fail-closed) | staged sidecars | none |
| 18 | **Claim support** | `K:1117-1185` | `evaluateSupport`, pure | **D, and must stay D** | no, by design | — | derived | **excluded.** A probabilistic "support" would be a second, competing definition |
| 19 | Impact and currency | `impact.ts:93`, `K:1348` | pure | D | no | — | derived | excluded |
| 20 | Context integrity | `context.ts:619` | sha256 | D | no | step fails | journal | none |
| 21 | Candidate rule content (is this a rule, what it says) | discovery agent | agent authors | **G** → H (gate) | — | wrong rule becomes canonical | delta + preview | none |
| 22 | Does the cited code actually express the rule? | `discovery.ts:491-545` checks only shape | **not decided by anyone except the reviewer** | **P** | yes | a rule grounded by the wrong code; reversible only by revision | source evidence refs at commit | **strong P candidate** as a reviewer aid |
| 23 | Rule conformance outcome | verifier agent → `ruleVerification.ts:509-643` | agent's semantic judgment; Argus validates references | **G performing P**, then H | yes, but the record forbids it | a false `holds` feeds realization success; the record is immutable per (run, rule) | `ledger.verifications` (durable), evidence refs | **P as an audit**: "is this outcome grounded by its cited evidence?" (§H, deferred) |
| 24 | Acceptance criterion outcome | `acceptance.ts:324-527` | same | G performing P, then H | yes | false `satisfied` gives false realization success | durable | same as #23 |
| 25 | Change classification and readiness | `changeIntent.ts:606-917` | agent content; D over it | G → H (forced gate) | — | intent becomes canonical | durable | none. Human authority |
| 26 | Implementation scope | `implementationScope.ts` | union over provenance | D | no | missing target | durable | none |
| 27 | Completion and remediation class | `realization.ts:191-330` | ordered conjuncts | **D** | no | — | durable attempts | **none.** This is Codex's "remediation category", already solved deterministically |
| 28 | Stale intent | `K:2204`, `E:1777` | active revision | D | no | — | durable | none. See B.3 for the support gap |
| 29 | Remediate vs stop | `E:4938-4985` | remediable flag plus budget | D (+H on stop) | no | — | durable | none |
| 30 | Admin HTTP writes | `routes.ts:736-822` | operator | H (unaudited provenance) | — | forged `producedBy` | knowledge.json | none |

### C.3 Analysis passes and operational judgment

| # | Decision | Where | Mechanism today | Class | Unc. | Wrong → / reversible | Replay | Shadow fit |
|---|---|---|---|---|---|---|---|---|
| 31 | Failure class of a failed run | `autopsy.ts:128-240` | haiku, closed 11-way taxonomy, 0–1 confidence | **P** (Choice), but **partly D** | yes, for the residual | wrong Issue clustering; advisory; reversible | autopsies.json (200); no model, no input hash, no label | **best first experiment** (H2), after deterministic pre-classification |
| 32 | Autopsy why / span / promptDelta | same | haiku | G | — | a bad relaunch prompt (human-gated) | same | none. Stays G |
| 33 | Output quality per criterion | `verdict.ts:192-295` | haiku scores; Argus weights | **P** (Score) | yes | trend noise; regression Issue; **gate** (#15) | verdicts.json; Vault keeps the overall score only | incumbent provider for H1 |
| 34 | Quality regression | `verdict.ts:378` | score < `minScore` | D policy over P | — | noisy Issues | same | — |
| 35 | Incident open, escalate, notify | `sentinel.ts:242-337` | fixed rules and clock | D | no | page or no page | incidents.json + Vault | none |
| 36 | Incident diagnosis | `diagnose.ts:38` | haiku text plus confidence | G (a confidence on prose) | weak | advisory | incidents.json | none |
| 37 | Issue clustering | `issues.ts:143-197` | regex, sha, Jaccard 0.5/0.7 | D (consumes #31) | — | merged or split issues | triage only | possible P ("same root cause?"), low value |
| 38 | Anomaly | `watchtower.ts:235` | median/MAD, z ≥ 3.5 and ratio ≥ 1.5 | D (statistical) | handled already | a false page | Vault events | none |
| 39 | Settings proposals | `tuning.ts` | haiku | G → H | — | human applies | tuning.json (50); accept/reject not recorded | none |
| 40 | Intent → mutations | `omnibar.ts:160-373` | haiku planner; validated; human confirms | G → H | — | compensating transaction | **in memory only** | none |
| 41 | Monitor status | `monitors.ts:81` | grace window | D | no | — | — | none |

### C.4 What the map says

- **Of about 41 surfaces, 5 are genuinely P:** #22, #23/#24 (as audits of an
  agent's judgment), #31, #33. Two more are plausible later (#5, #11). Of
  those, #31 and #33 are already model-backed today, just without a contract.
- **The dangerous pattern is not "P exists". It is "P holds authority
  without calibration" (#15), and "G's self-report is treated as D" (#1, and
  #23/#24 under the `agent-evidence` policy).** The Decision Plane fixes the
  first. The second is a verification-policy question it can support (#23
  audits) but should not own.
- **Deterministic logic can replace model judgment today.**
  - In Autopsy (#31): `timeout` ⟸ `Run.termination ∈ {timed-out, stalled}`;
    `infrastructure` ⟸ `spawn-failed`, or `status: interrupted` after a
    restart; `bad-output-format` ⟸ `PhaseFailureClass ∈ {signal (result
    invalid), knowledge-delta, …}` when the reason is a schema refusal.
    `rate-limit` and `permission-denied` are often matchable in the CLI
    error envelope.
  - The Autopsy prompt does not even include `termination`, so today the
    model guesses a fact Argus recorded.
  - In #1: one deterministic rule should govern a missing marker on both
    paths.

---

## D. Testing the hypothesis

The hypothesis is that a Decision Plane sits cleanly between the Evidence
plane and the Policy plane. The table checks each specific hazard against
the current code.

| Hazard | Present today? | Verdict for the Decision Plane |
|---|---|---|
| **Duplicated semantics with the ledger/TMS** | Not yet, but Codex's R17 example would create it | **Real.** Rule: assessments never use ledger vocabulary (`supported`, `holds`, `satisfied`) and never have a claim's truth as their subject. Their subjects are **records and executions**: a run, a phase attempt, a gate review, a verification record. "Is this `holds` record grounded by what it cites?" is a question about a record. "Does R17 hold?" belongs to the ledger and the verifier. |
| **Hidden feedback loops** | **Yes, three.** Autopsy class → Issues clustering → Sentinel regression pages. Autopsy `promptDelta` → relaunch prompt. Verdict score → gate → ledger commit → the next run's KnowledgeContext → the next Verdict | Real. An assessment's consumers must be declared (policy registry, §F), and no assessment feeds a prompt or a ledger write without passing through a named policy. |
| **Probabilistic decisions contaminating factual state** | **Yes** (A.2) | This is the reason to do the work. It is enforced by the invariant structure in §E, not by convention. |
| **Model and version drift** | **Yes.** `Verdict` and `Autopsy` carry no model, runtime or prompt version, and `ARGUS_ANALYSIS_MODEL` can change underneath a trend line | Every assessment carries `ProviderIdentity` and `question.version`. Trends and thresholds are keyed by them. |
| **Stale repository state** | Not for runs (immutable), but yes for anything verification-shaped | Snapshots carry `RepositoryStateRef` when the subject is state-dependent. Currency is derived with `sameRepositoryState`, never written back. |
| **Input construction becoming an implicit prompt system** | **Yes, already.** `buildVerdictPrompt` and `buildAutopsyPrompt` are the state construction | Split it: a provider-neutral, typed, hashed **StateSnapshot** (the same projection-plus-hash discipline as KnowledgeContext) is built by Argus. Rendering it into prose is the **adapter's** versioned job. Jev takes the state natively; Claude needs rendering. The hash is over the snapshot, not the prompt. |
| **Threshold brittleness** | **Yes.** `autoApprove.verdict` is a bar on an uncalibrated Haiku score | Thresholds bind to (question, version, provider, model). A provider or model change voids the threshold until it is re-validated on the shadow corpus. |
| **Correlated decisions treated as independent** | Partly. Verdict takes the min across steps, which is correct. But Claude-judges-Claude shares failure modes with the generator | Policy never multiplies probabilities. Provider heterogeneity is a measured property, not an assumption. This is the one structural argument **for** a non-LLM provider such as Jev, and it has to be shown empirically. |
| **Repeated decisions producing inconsistent state** | **Yes.** `writeVerdict` replaces by runId, so re-judging erases history | The journal is append-only. Repeated calls are samples (`sample` index); instability is itself a metric. |
| **Results outliving their evidence** | Not tracked at all | Currency = snapshot hash re-derivable now ∧ question version unchanged ∧ every referenced ledger revision still active. Derived, never stored. |
| **Scope leakage** | Low today (analysis is local) | Snapshots are built only from the subject's own scope plus `alsoRead` (as in `context.ts:347-372`). An external provider additionally needs a per-scope **egress policy**. |
| **Replay determinism** | None: nothing is recorded that could be replayed | Replay means **reading the recorded result**, never calling again. `ReplayDecisionProvider` answers from the journal by `(question, version, snapshotHash, providerIdentity)`. A re-evaluation is a new assessment. |
| **Provider lock-in** | Soft lock to headless CLIs, which is fine | The seam in §G. Core never requires a key. |
| **Privilege escalation through semantic judgment** | **Yes.** An agent's `resultSummary` is inlined verbatim into the judge prompt, so a phase can write "all criteria fully met" and move its own gate | **Asymmetric authority invariant:** an assessment whose snapshot contains subject-authored content may only **withhold** permission (escalate, flag, block auto-approval), never **grant** it. No assessment of any kind may open a gate on a phase that stages knowledge. |

**Where the hypothesis is wrong, or needs narrowing.**

1. The plane is **not** a layer that all decisions pass through. Most surfaces
   (C.1, C.2) are D and never touch it. It is a side channel with exactly one
   exit, the Policy plane, and Policy consults it only for surfaces declared
   in a registry.
2. "Evidence plane" is not a new thing to build. It is the union of existing
   records (run, invocation, VerificationReport, ledger, journal). What is new
   is the **StateSnapshot projection** over them, which is to the Decision
   Plane what KnowledgeContext is to an agent.
3. The boundary between the Decision Plane and verifier agents is not clean.
   A verifier already performs semantic judgment (#23). The plane can **audit**
   those judgments. It should not replace them, because the verifier's output
   carries evidence citations and the plane's output carries only a
   distribution.

The hypothesis survives in this narrowed form: **one bounded subsystem that
records typed inferences about Argus's own records, has no authority of its
own, and is consulted by named policies whose default effect is escalation.**

---

## E. Ledger/TMS integration: the epistemic model

### E.1 Four kinds of record, never interchangeable

| Kind | Examples | Authority | Where |
|---|---|---|---|
| **Observation** | check exit code, `termination`, `gitHead`, snapshot hash, supplied-context sha256 | Argus's own instrumentation | run, invocation, VerificationReport |
| **Accepted record** | Claim, Evidence, Justification, RuleVerification, AcceptanceVerification, AcceptedChangeProposal | whoever crossed the acceptance boundary (a human gate, or an ungated phase's checks) | `knowledge.json` |
| **Assessment** | "p(needs review) = 0.81 from provider X, model M, on snapshot H, for Q v2" | **none about the world.** It is authoritative only about the fact that the inference happened | Decision Journal (new) |
| **Permission** | gate opened, route taken, remediation started | policy code and humans | instance, journal, ledger realization records |

**The journal is authoritative about what was inferred, never about what is
true.** "Provider X said 0.97" is a durable fact. "R17 is satisfied" is not
something the journal can say.

### E.2 Answers to the specific questions

- **Inside the ledger, adjacent, or a separate journal?** A **separate Decision
  Journal**, adjacent to the ledger and pointing into it. It must not live in
  `knowledge.json`, for three reasons:
  - That file is loaded whole, is never pruned, and every reader of it would
    have to learn to ignore assessments.
  - Assessment volume scales with runs times questions times providers times
    samples. Ledger volume scales with knowledge.
  - Phase 6 set the precedent that a new epistemic dimension gets its own
    array and its own read model, and that `evaluateSupport` never reads it.
    The journal goes one step further and gets its own file.
- **Can an assessment support a claim?** **No.** It is not an `EvidenceSource`
  variant, and `evaluateSupport` and `analyzeImpact` never read the journal.
  This is enforced the way Phase 6 enforces "a violation is not a doubt": a
  mandatory regression test asserting that the ledger's `claims`, `evidence`
  and `justifications` are byte-identical before and after any assessment
  and any policy that consumes it.
- **Can it invalidate a claim?** **No.** It can cause a **human** to act (revise
  the claim, attach opposing evidence as `{type:"human"}`, reject a gate). The
  human is then the authority, and the evidence note may cite the assessment
  id for traceability.
- **When must it be recomputed?** Never automatically in place. Its
  **currency** is derived on read:
  `current ⟺ questionVersion is the live one ∧ the snapshot projection, re-run
  now for the same subject, hashes to the recorded hash ∧ every ledger ref in
  the snapshot is still the active revision`. Assessments of finished runs
  are almost always current, because runs are immutable. Assessments of a gate
  review go stale when the phase is revised. A policy that needs a current
  assessment and finds a stale one requests a new one. It never reuses the old
  one.
- **How does repository-state binding affect it?** When the subject is
  state-dependent (a verification record, a gate review of a realization), the
  snapshot embeds the `RepositoryStateRef` Argus recorded, never the agent's
  claim. Currency then additionally requires `sameRepositoryState`. The rule
  is the same as `ruleConformance`: _"assessed at abc123"_ says nothing about
  `def456`.
- **How does scope affect it?** An assessment inherits the subject's
  `KnowledgeScope`. Snapshots are built from own-scope plus `alsoRead` only.
  Journal reads are scoped the same way the ledger's are. An external
  provider needs a per-scope egress allowance (§G.4).
- **What happens when providers disagree?** Both assessments stand. The
  journal never averages across providers. **Disagreement is a derived
  signal** that a policy may consume (for example, "escalate if providers
  disagree by more than δ"). It is never folded into a consensus number that
  looks like one provider's answer.
- **What happens when the same provider changes its answer?** Both records
  stand, as separate samples. Policy reads a defined aggregate declared in the
  policy (for example, "the latest current assessment", or "all n samples ≥
  τ"), and **instability is itself reportable** (§H.4).
- **How does TMS invalidation affect assessments?** Through currency (above),
  never through a write. A read-only companion to `analyzeImpact`,
  `assessmentsResting(root)`, can list assessments whose snapshots referenced
  affected revisions. It is kept **outside** `ImpactSet`, exactly as Phase 6
  kept verifications outside it (§15.11).
- **What is authoritative?**
  - Observations: about what Argus saw.
  - Accepted records: about what was accepted and by whom.
  - Human decisions: about permission.
  - Policy code: about what an assessment is allowed to cause.
  - The journal: only about what was inferred.

  **No probability becomes truth by crossing a threshold. It can only become a
  reason for a policy to escalate.**

---

## F. Domain contracts (minimum)

TypeScript, since that is the codebase. They would go in
`contracts/src/decision.ts` (wire types) and `server/src/decision/`
(journal, snapshots, providers, policy). Names are Argus's, not Jev's.

```ts
/** What is being asked about. Always a record or an execution, never a claim's truth. */
export type DecisionSubject =
  | { kind: "run"; runId: string }
  | { kind: "phase-attempt"; instanceId: string; phaseId: string; attempt: number }
  | { kind: "rule-verification"; verificationId: string }
  | { kind: "acceptance-verification"; verificationId: string };

/** Argus's three answer shapes. They map onto Noul/Choice/Score, but are defined here. */
export type AnswerSpace =
  | { shape: "binary" }                                              // p(yes)
  | { shape: "choice"; options: Array<{ id: string; label: string }> } // closed; ids are slugs
  | { shape: "scale"; min: number; max: number; step: number; anchors?: Record<number, string> };

export interface DecisionQuestion {
  id: string;            // "run.failure-cause", "gate.needs-review"
  version: number;       // bump on ANY change to wording, answer space or projection
  text: string;          // the question as a domain sentence, provider-neutral
  answers: AnswerSpace;
  subject: DecisionSubject["kind"];
  projection: { id: string; version: number }; // which StateSnapshot builder
  /** Declared consumers. A policy not listed here may not read this question. */
  consumers: string[];   // policy ids
}

/** The typed, hashed input. Built by Argus, never by a provider. */
export interface StateSnapshot {
  projection: { id: string; version: number };
  subject: DecisionSubject;
  scope?: KnowledgeScope;
  repository?: RepositoryStateRef;          // Argus-recorded, when state-dependent
  refs: {                                   // what the body was built from
    runs: string[]; claims: ClaimRef[]; verifications: string[]; artifacts: ArtifactRef[];
  };
  /** Which fields of the body the subject itself authored (asymmetric-authority input). */
  subjectAuthored: string[];                // JSON pointers into body
  body: unknown;                            // typed per projection
  sha256: string;                           // over canonical JSON of the above
  bytes: number;
}

export type Distribution =
  | { shape: "binary"; p: number }
  | { shape: "choice"; p: Record<string, number> } // sums to 1 ± ε; closed keys
  | { shape: "scale"; p?: Record<string, number>; point?: number };

export interface ProviderIdentity {
  provider: "claude-cli" | "codex-cli" | "jev" | "deterministic" | "human" | "replay" | "mock";
  model: string | null;          // as the provider reported it, pinned where possible
  adapterVersion: number;        // rendering/parsing code version
  /** How the probability came to exist. Not comparable across kinds without calibration. */
  elicitation: "native" | "verbalized" | "sampled" | "rule" | "label";
}

export interface DecisionAssessment {
  id: string;                                   // minted: DA-…
  question: { id: string; version: number };
  subject: DecisionSubject;
  snapshot: { sha256: string; projection: { id: string; version: number } };
  provider: ProviderIdentity;
  sample: number;                               // 0..n-1 for repeated calls
  outcome:
    | { status: "answered"; distribution: Distribution; rationale?: string } // rationale: display only
    | { status: "abstained"; reason: string }
    | { status: "failed"; failure: string };
  mode: "shadow" | "advisory" | "enforcing";    // what the calling policy did with it
  latencyMs: number; costUsd: number | null; tokens: number | null;
  createdAt: string;
}

export interface DecisionPolicy {
  id: string;
  question: { id: string; version: number };
  providers: ProviderIdentity["provider"][];     // which assessments count
  aggregate: "latest-current" | "all-samples" | "min" | "disagreement";
  /** Effects are monotone toward caution unless `grants` is explicitly allowed. */
  effect: "escalate" | "flag" | "withhold-auto-approval" | "grant";
  threshold: number;                             // bound to question version and provider model
  calibratedOn?: { corpus: string; at: string; n: number }; // required for "grant"
}

export interface DecisionProvider {
  identity(): ProviderIdentity;
  supports(q: DecisionQuestion): boolean;
  assess(q: DecisionQuestion, s: StateSnapshot, signal: AbortSignal): Promise<DecisionAssessment["outcome"]>;
}
```

**What these reuse instead of inventing:**
- `KnowledgeScope`, `ClaimRef`, `ArtifactRef` and `RepositoryStateRef` are
  imported as-is.
- The snapshot follows KnowledgeContext's projection → hash → durable-record
  discipline.
- `AnalysisRunner` stays the only spawn site for CLI providers.
- Journal persistence follows the append-only JSONL pattern of
  `sources/journal.ts`, but without the 512 KB deletion. Size-bounded
  rotation archives into the Vault; it never deletes silently.

**What is deliberately absent:**
- A "fact" or "support" field.
- An "overall confidence" that the provider sets. Aggregation belongs to
  policy, the same way Verdict's weighted score belongs to Argus.
- Any field a provider can use to name the next transition.

---

## G. Provider architecture

### G.1 Providers

```
                       DecisionService (server/src/decision/)
            question registry · snapshot builders · journal · currency
                                     │ DecisionProvider
   ┌──────────────┬──────────────┬───┴──────────┬───────────────┬──────────────┐
   ▼              ▼              ▼              ▼               ▼              ▼
Deterministic  ClaudeCli       CodexCli       Jev (optional)  Human/Label    Replay/Mock
(rules; the    (AnalysisRunner (AnalysisRunner HTTPS + key    (recorded gate (journal
 baseline)      → claude -p)    → codex exec)  from env)       decisions,     lookup;
                                                               corrections)   tests)
```

- **Deterministic** is a first-class provider, not an afterthought. For H2 it
  is the pre-classifier. For H1 it is a rule baseline. A P provider has to
  beat it to earn a place.
- **Human/Label** makes recorded human decisions comparable in the same
  tables. It becomes possible once Phase 0 records them.
- **Replay** answers from the journal, so any report can be regenerated
  without spending anything.

### G.2 Claude baseline (and why it is not "Claude imitating Jev")

- `ClaudeCliDecisionProvider` renders `(question.text, answers, snapshot.body)`
  into a prompt and runs it through `AnalysisRunner`. It keeps the no-tools,
  stdin, timeout, output-cap, budget and concurrency guards unchanged.
- It asks for a closed JSON distribution and validates it: keys exactly equal
  to the option ids, values in [0, 1], and a sum within ε, renormalised and
  recorded.
- `elicitation: "verbalized"`.
- Two honest limitations follow from staying on the headless CLI:
  - There are **no logprobs and no temperature control**, so "probability"
    means a verbalised number. It is not comparable to a native one until
    both are calibrated on the same corpus.
  - An optional `sampled` mode (n calls, empirical frequencies) is the only
    CLI route to a distribution with frequency meaning, and it costs n times
    as much.

  An API-based Claude provider with logprobs would need a key. It is exactly
  as optional as Jev, and not proposed now.
- The same question definition runs on Haiku and Sonnet (`model` in the
  identity), so "model size" and "model class" can be separated as variables.

### G.3 Jev adapter (mapped last)

What I could establish without vendor access follows. Egress to the vendor
docs is blocked in this environment, so **everything here is unverified and
the adapter design must be confirmed against the live API.** Search results
describe:
- an HTTP API at `POST https://api.typesafe.ai/v1/systemone`;
- a model route `jev-latest`;
- Python and JS SDKs;
- the three primitives with "a probability for every option" (Choice), a
  "scale" (Score) and p(true) (Noul).

| Argus | Jev | Loss / assumption |
|---|---|---|
| `binary` | Noul | Natural mapping. |
| `choice` | Choice | Natural mapping if the options pass through verbatim. Assumption: the returned distribution covers every option. |
| `scale` | Score | Unknown whether a full distribution or a point comes back. `Distribution.scale` allows either. |
| `abstained` | ? | If Jev cannot abstain, Argus loses the honest "cannot tell" that Verdict and Autopsy both value. Could be emulated by an explicit `insufficient-evidence` option, which **changes the question** and must bump its version. |
| `snapshot.body` | "state" | How Jev ingests structured state (a JSON schema? size limits?) is unknown. Truncation rules have to be deterministic, hashed and part of the projection version. |
| `ProviderIdentity.model` | `jev-latest` | **Replay hazard.** A floating route breaks the assumption that the same identity means the same function. The adapter must pin a version if the API offers one, or record whatever version the response reports. If neither exists, every Jev assessment is tagged `model: "jev-latest@<date>"` and drift checks are mandatory. |
| `elicitation` | `native` (claimed) | "Calibrated" is a vendor claim. Argus treats it as a hypothesis to measure (§H.4), never as a property. |
| failure | HTTP errors, timeout | Maps to `failed`. Network absence must degrade to "no assessment", which every policy already treats as "no permission granted". |
| cost / latency | vendor claims 40–200× faster, 40–400× cheaper than frontier LLMs | Measure, don't cite. |

### G.4 Configuration, failure and privacy

- **Keys.** `ARGUS_JEV_API_KEY` is read from the environment and never
  written to disk. It is excluded from `childEnv` passthrough, so an agent
  child never sees it. With no key, the provider reports
  `supports() = false` and the registry simply has one provider fewer. Core
  behaviour is unchanged.
- **Egress.** Jev is the **first provider that sends Argus state to a party
  that is not already running the user's agents.** Claude and Codex CLI
  providers send nothing new, because those vendors already see the
  transcripts. A Jev snapshot may contain prompts, final messages, diffs,
  rule statements and file paths.
  - Required: a per-scope egress allowlist (`decision.egress: { jev: [
    "<projectId>/<repositoryId>" ] }`), default empty.
  - Required: a redaction pass that is part of the projection version.
  - Required: the snapshot hash to be recorded **before** sending, so what
    left the machine is auditable.
- **Failure.** It rides the analysis budget guard. Pipeline behaviour must
  never depend on a Jev answer arriving: shadow mode by construction, and
  escalate-only effects later.

---

## H. First shadow experiment

### H.1 Choosing the questions

Codex proposed (1) "does this run need human review?" and (2) "what
failure/remediation class?". After reading the code:

- **(2) goes first, reformulated as H2.** Autopsy already asks it with a model,
  so the shadow adds nothing to pipeline risk. Deterministic pre-classification
  also yields **free ground truth** on a subset (below). The "remediation"
  half is dropped: inside realizations it is D (#27).
- **(1) becomes H1, anchored to gates.** This is where a human decision
  exists and where the incumbent (Verdict auto-approve) is the thing to beat.
  It **cannot start until Phase 0 records gate decisions**, because today
  there is no durable ground truth for it at all.
- A third question is designed but deferred: **H3, "is this verification
  outcome grounded by what it cites?"** (#23/#24). It is the highest-value
  audit, but its only ground truth is expert review, and wrong answers here
  are the ones that matter most.

### H.2 H2: `run.failure-cause` (Choice)

- **Subject:** a failed run (`isAutopsyEligible`).
- **Deterministic stage (provider `deterministic`, `elicitation: rule`):**
  `termination ∈ {timed-out, stalled}` → `timeout`; `spawn-failed` or
  interrupted-by-restart → `infrastructure`; `PhaseFailureClass` intake
  refusal → `bad-output-format`; CLI envelope rate-limit or permission
  signatures → `rate-limit` / `permission-denied`. When one of these fires,
  **no model is asked** in production.
- **Residual question (v1):** "Which best explains why this agent run did not
  accomplish its task?" The options are `prompt-ambiguity | missing-context |
  tool-error | environment | model-refusal | task-infeasible | other`. The
  options the deterministic stage owns are removed, so the model is never
  asked to guess a fact.
- **Snapshot (`projection: run-failure v1`):**
  - run metadata (status, exit, duration, error);
  - the prompt (capped);
  - the last 60 Recorder events with error marks (as `buildAutopsyPrompt`);
  - the `resultSummary`;
  - with `termination` and `PhaseFailureClass` **withheld** in probe mode.

  Everything the agent authored is listed in `subjectAuthored`.
- **Ground truth and its honest limits:**
  - **Hidden-deterministic probes.** Deterministically classified runs are
    also sent to the P providers with the deciding fields withheld. The label
    is known, so this measures accuracy and calibration on a real, if easy,
    subset. It is the only accuracy number available without human labelling.
  - **Human corrections.** Add a one-click "correct class" on the Autopsy panel
    (`provider: human, elicitation: label`). Until corrections exist,
    **accuracy on the residual classes is unmeasurable**, and the report must
    say so rather than show agreement as accuracy.
  - The existing Autopsy output enters as a third provider: `claude-cli`, model
    unknown, `adapterVersion: 0`.

### H.3 H1: `gate.needs-review` (binary)

- **Subject:** a phase attempt in `awaiting-approval`.
- **Question (v1):** "Would a careful reviewer send this phase attempt back
  (revise or abort) rather than approve it as it stands?"
- **Snapshot (`projection: gate-review v1`):** built from what the human sees
  in the gate drawer (`sources/artifacts.ts` review):
  - the step prompts and final messages;
  - the validated result;
  - the VerificationReport (labels, status, exit codes);
  - the changed-files list and diff stat (not full content in v1);
  - candidate or knowledge previews (counts, warnings, outcomes, evidence
    kinds);
  - Watchtower ratios;
  - the attempt number.
- **Providers:**
  - `deterministic`: escalate if any check was retried, `attempt > 1`, any
    `unverifiable`, observation-only `holds`, a fatal-adjacent warning, or a
    cost or duration anomaly;
  - `claude-cli` on Haiku and on Sonnet;
  - **Verdict-as-provider**: `score/10`, flipped to "needs review" below the
    phase's bar, so the incumbent is measured on the same subjects;
  - later, `jev`.
- **Ground truth:** the recorded human gate decision. `revise` or `abort` is
  positive, `approve` is negative.
  - Label noise is inherent. Some approvals are wrong, which shows up later as
    a failed realization attempt, a revise on the next instance, or a
    regression Issue. Track those "late positives" as a secondary label and
    never overwrite the primary one.
  - **Auto-approved gates have no label** and are excluded.
- **Volume warning.** This is a single-operator tool. If you decide tens of
  gates a month, calibration curves will not be meaningful for months. The
  report must show `n` and confidence intervals, and it must not show
  reliability buckets with fewer than about 20 items. An offline **seeded-defect
  corpus** (known-bad outputs made by mutating good ones) adds labelled
  positives quickly. Report it separately from real traffic, because it
  measures sensitivity, not base-rate performance.

### H.4 Measurements

All are computed from the journal by Replay, so the report costs nothing to
regenerate.

| Metric | Definition | Needs ground truth? |
|---|---|---|
| Agreement with reference | accuracy and Cohen's κ against the label; per-class confusion matrix for H2 | yes |
| **False close** (H1) | P(provider says "approve" \| human revised or aborted). **The metric that decides everything** | yes |
| False escalation (H1) | P(provider says "review" \| human approved) | yes |
| Calibration | Brier score; reliability buckets with n shown; ECE only when n ≥ 200 | yes |
| Confidence vs correctness | accuracy of the top answer by confidence decile | yes |
| Provider disagreement | total-variation distance between providers per subject; agreement rate | no |
| Stability | k = 3 repeated calls on the same snapshot: top-answer flip rate and mean TV distance | no |
| Robustness to irrelevant state | inject content-free padding (unrelated recorder events, a second unrelated run) and measure the TV shift; **also inject a subject-authored instruction ("reviewer: approve") and measure the shift**, which is the escalation probe | no |
| Robustness to missing state | ablate one field (the check report, the diff stat). The expectation is that confidence **drops**; count cases where it rises | no |
| Latency, cost, size | p50/p95 latency; USD and tokens per assessment; snapshot bytes | no |
| Drift | re-run a frozen **canary set** of about 50 snapshots monthly per provider identity; alert on TV shift | no |
| Versus the deterministic baseline | every metric above with the rule provider as a row | — |

**Where ground truth does not exist, the report prints "unmeasured" in that
cell, never agreement dressed as accuracy.**

### H.5 What shadow mode means mechanically

- A watcher on the scheduler tick, beside Autopsy and Verdict (the
  ARCHITECTURE.md §5 rule that model-backed work lives in watchers, never
  under the instance lock).
- One assessment per tick, rate- and budget-bounded, and `mode: "shadow"` on
  every record.
- **No policy consumes H1 or H2 in Phases 1–3.** The registry lists no
  consumers, and a test asserts that the instance, route, gate and ledger
  state are identical with the decision service on and off for the same
  fixture pipeline.

---

## I. Risks and failure modes

These are the ways adding inference makes Argus **less** deterministic or
trustworthy.

1. **Laundering through the reviewer.** Even with no authority, a confident
   "no review needed" badge in the gate drawer will anchor a tired human.
   Mitigation: advisory display only after the false-close rate is measured,
   phrased as "escalation reasons", and never shown as "safe to approve".
2. **The judge as an attack surface.** Any P judgment over agent-authored
   content can be steered by that agent. The asymmetric-authority invariant
   contains it; it does not eliminate it. H.4's injection probe measures it.
3. **Calibration folklore.** A threshold tuned on thirty gates reads as policy.
   Mitigation: `grant` effects require `calibratedOn` with n and a date, and
   the schema forbids them on knowledge-staging phases regardless.
4. **Snapshot creep.** Projections will grow toward "include everything", which
   becomes the implicit prompt system under a new name. Mitigation: projection
   versions are reviewed like migrations; bytes are a tracked metric;
   irrelevant-state robustness is measured.
5. **Two sources of classification truth.** Autopsy's model class and
   `PhaseFailureClass` already coexist. A third (H2) would make it worse
   unless H2 **replaces** Autopsy's classification once it lands (Phase 4),
   with the deterministic stage authoritative where it applies.
6. **Egress.** A single misconfigured scope sends proprietary code to a new
   vendor. Mitigation: default-empty allowlist, and hash-before-send.
7. **Cost and rate-limit competition.** Shadowing three providers on every
   failed run could compete with real work. Mitigation: the existing
   single-slot runner and budget guard, one assessment per tick, and sampling
   by rate rather than exhaustively.
8. **The comparison is not the product.** The risk is building an evaluation
   harness that is more elaborate than the decisions it evaluates. The
   Phase 4 decision point (J) exists to stop there if the numbers do not
   justify going on.

---

## J. Migration path

Each phase is additive and reversible. `ARGUS_DECISIONS=off` removes
everything after Phase 0.

| Phase | Work | Reversible by | Exit criterion |
|---|---|---|---|
| **0: Harden what exists (no Decision Plane)** | (a) refuse `autoApprove` on any phase that can stage knowledge (discovery, `knowledgeDelta: required`, ruleVerification, changeIntent, acceptanceVerification, implementation's verifier), at save time with a clear 400; (b) a durable **gate decision record** `{instanceId, phaseId, attempt, decision: approve\|revise\|abort, actor: human:<name>\|verdict-auto, at}`, persisted outside the 512 KB journal; (c) stamp `{runtime, model, promptVersion}` on `Verdict` and `Autopsy`; (d) stop `writeVerdict` from overwriting on re-judge | reverting each change on its own | tests: a knowledge phase with autoApprove → 400; every approve path writes an actor |
| **1: Contracts and journal** | `contracts/src/decision.ts`; `server/src/decision/` (registry, projections, journal, currency); Deterministic, ClaudeCli, Replay and Mock providers over `AnalysisRunner`; a mandatory ledger-isolation regression test | deleting the module; nothing else imports it | journal round-trip; replay reproduces a report byte for byte |
| **2: Shadow H2, then H1** | H2 watcher plus the Autopsy correction affordance; H1 watcher on gates (needs 0b); Verdict-as-provider; report page (read-only) | the env switch | enough n to print non-"unmeasured" cells |
| **3: Jev (optional)** | adapter, egress policy, redaction projection, version pinning; the same questions | unsetting the key | same report with a Jev row |
| **4: Decide** | review the numbers. Candidate outcomes: H2 replaces Autopsy's classification; H1 is shown as **escalation reasons** in the gate drawer (advisory); or stop | — | a written decision, not a default |
| **5: Enforcing, escalate-only** | e.g. `withhold-auto-approval` when `gate.needs-review` ≥ τ on non-knowledge phases, making Verdict auto-approve stricter, never looser | removing the policy | false-close rate measured below a bar you set |

"Grant" effects, meaning a calibrated assessment that removes a human wait,
are not on this path. If they ever are, it will be a separate RFC with its own
evidence.

---

## K. Recommendation

1. **Do Phase 0 now.** It is small, independent of Jev and of this whole RFC,
   and it closes the one place where a model judgment already becomes
   canonical knowledge without anyone knowing. Without 0b there is no
   ground truth for any later experiment.
2. **Then build Phases 1–2 with the Claude CLI providers and the deterministic
   baseline.** That tests the architecture (journal, snapshot, currency, replay)
   at zero new dependency and zero new egress. If the deterministic baseline
   matches the model providers on H2 and H1, that is a valuable result: it
   means Argus should delete model calls, not add providers.
3. **Add Jev only after the egress decision (L.2).** It should get exactly the
   same questions, snapshots and report rows. The interesting scientific
   question is not "is Jev better than Claude" but "does a non-generative
   provider fail **differently** from the generator it judges". Only
   disagreement and injection-robustness measurements can answer that.
4. **Do not** add a probabilistic "support", "sufficiency" or "satisfied"
   question over claims. Those belong to the ledger and to verifiers, and a
   second definition would erode the one property that makes the ledger
   trustworthy.

---

## L. Open questions that need your decision

1. **autoApprove on knowledge phases.** I recommend refusing it at save time.
   That is a breaking change for any saved pipeline that combines them, and
   such pipelines are silently making model-approved canonical knowledge
   today. The alternative is to allow it with an explicit opt-in field and a
   recorded actor. Which do you want?
2. **Egress to TypeSafe.** Is sending run prompts, final messages, diff stats
   and rule statements to TypeSafe's hosted API acceptable, and for which
   projects or repositories? Phase 3 is blocked on this.
3. **Labelling.** Will you (or others) click "correct class" on autopsies, and
   is the gate decision an acceptable ground truth for H1? Without human
   labels, H2's residual accuracy stays "unmeasured". At single-operator
   volume, H1 needs months or a seeded-defect corpus.
4. **The asymmetric-authority invariant.** Should "assessments may only add
   friction, never remove it" be a permanent invariant (like §15.1's "a
   violation is not a doubt"), or a default that a future RFC may relax for
   non-knowledge phases?
5. **Journal retention.** Should the Decision Journal be durable and unbounded
   like `knowledge.json`, or rotated into the Vault? The latter keeps the long
   horizon but makes replay depend on the Vault being built.

---

## Appendix: defects found incidentally (not Decision Plane work)

Listed so they get their own issues. Details are in B.3.
- The hook path treats a missing `ARGUS_OUTCOME` marker as success.
- The signal token is instance-wide and inside the agent's environment.
- `needs-input` bypasses validation and checks.
- Pipelines ignore the budget hard stop.
- The journal is deleted at 512 KB.
- `trackStep` ignores the envelope's `isError`.
- Discovery gating and source-code evidence are not enforced as the doc
  states.
- The change-intent contract makes the request supporting evidence.
- Intent currency checks lifecycle but not support.
- `childEnv` does not scrub three Phase 8 channel variables.
- Remediation leaves a stale route decision for a re-run verifier.
