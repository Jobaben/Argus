# RFC: A provider-neutral Decision Plane for Argus

_Status: **amended 2026-09-29; Phase 0 implemented; Phase 1 (contracts and
journal) implemented (§O); the Phase 2 H2 shadow-experiment slice
implemented, off by default (§P); H1 and later phases not started.** The
original text was an architecture investigation. §M records what Phase 0
changed in the code, §N lists the decisions and corrections the amendment
applies, §O is the Phase 1 design note and what it built, and §P is the H2
slice's design note and what it built. Nothing beyond the H2 slice (H1,
gate-review projections, badges, policies, enforcement, Jev) is implemented
or authorised by this document._

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

> **Reading note (amendment).** §A–§E describe the repository at `232ba4a`,
> before Phase 0, and keep that description as it was found. Where they
> state a defect in the present tense (for example, the auto-approval of
> knowledge gates, or approvals with no recorded actor), §M says what Phase
> 0 changed. Where their design language differs from §F–§H, the later
> sections are authoritative.

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
     `PhaseFailureClass`). The model is asked to guess them anyway. They
     are observed termination classes, not causes; §H.2 separates the two.

5. **Recommendation, in order.**
   1. **Phase 0 (independent of any provider), now done (§M):** close the
      autoApprove-on-knowledge hole, record gate decisions with their
      mechanism and server-resolved principal, and stamp provenance on the
      existing Verdict and Autopsy records.
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

| #    | Design says                                                                 | Code does                                                                                                                                                                         |
| ---- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 ✔  | Change intent "never become[s] canonical without a person" (`E:4257`)       | `autoApprove` is accepted on `changeIntent` and `ruleVerification` phases, and `openQualifiedGates` does not exclude knowledge phases                                             |
| 2 ✔  | The journal records revisions and approvals (`journal.ts:10-13`)            | `phase.approved`, `phase.revised` and `phase.succeeded` are declared and never emitted. Auto-approval is only a `log.info` (`index.ts:305`). No approver identity exists anywhere |
| 3 ✔  | A missing completion marker is a failure (`recoverRunOutcome`, `E:721-736`) | On the hook path (Claude, Qwen) a missing marker resolves to **`completed`** (`argus-signal.mjs:130-136`). The same agent behaviour has opposite outcomes depending on runtime    |
| 4 ✔  | Discovery rules are gated ("mandatory", §14.9 and `C:1011`)                 | Nothing enforces it. §14.2 itself says "nothing forces it"                                                                                                                        |
| 5 ✔  | Discovery rules must carry source-code evidence (§14.5)                     | `supportOf` counts any supporting evidence, so an agent-written `{type:"human"}` satisfies the check                                                                              |
| 6 ✔  | Requests are "never an argument that a claim is true" (§16)                 | The change-intent contract tells the agent to attach the request as supporting `document` evidence (`changeIntent.ts:182-183`)                                                    |
| 7    | "`holds` never rests on an agent's assertion alone" (invariant 33)          | Under the default `agent-evidence` policy, one `observation` suffices                                                                                                             |
| 8    | "No conjunct is an agent's word about its own work" (invariant 42)          | Conjunct 1 and `blocked` come from `ARGUS_OUTCOME`                                                                                                                                |
| 9 ✔  | `needs-input` is a gate after validation (HARNESS §2)                       | `needs-input` sets `awaiting-approval` before result validation, checks and intake (`pipelineTransitions.ts:484`)                                                                 |
| 10   | Snapshot identity is "content hashes, never timestamps"                     | Files over 8 MiB and symlinks use `size:mtime` (`harness/verification.ts:138`)                                                                                                    |
| 11   | Budget hard stop                                                            | Applies to schedules and analysis passes. No pipeline start path checks it                                                                                                        |
| 12   | Journal as the audit trail                                                  | The journal file is deleted once it passes 512 KB (`journal.ts:139-141`)                                                                                                          |
| 13 ✔ | Signal authentication                                                       | The per-instance token sits in the agent's own environment (`E:2101`), so any process the agent runs can POST `completed` for itself or a sibling                                 |

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

| #   | Decision                            | Where                                          | Mechanism today                                             | Class                                | Unc.                          | Wrong → / reversible                                            | Replay                                                            | Shadow fit                                                                                               |
| --- | ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- | ------------------------------------ | ----------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Signal type from the final message  | `argus-signal.mjs:46,130`                      | unanchored regex over agent text; no marker = completed     | **D** over a G self-report           | no                            | false success moves the phase on; only a human revise undoes it | payload on instance                                               | none. Unify with #2 deterministically                                                                    |
| 2   | Outcome from the run record         | `E:683,704-754`                                | line-anchored regex; missing or conflicting marker = failed | D                                    | no                            | same                                                            | `Run.outcome`                                                     | none                                                                                                     |
| 3   | Signal acceptance                   | `E:5381-5439`, `app.ts:1596`                   | token plus tracked runId                                    | D (security)                         | no                            | forged completion                                               | —                                                                 | none. Fix the token scope instead                                                                        |
| 4   | Result-file validity                | `pipelineTransitions.ts:176-225`               | schema                                                      | D                                    | no                            | phase fails (`signal`)                                          | result on instance                                                | none                                                                                                     |
| 5   | Result **content** used for routing | `routing.ts:119-170`                           | the agent writes e.g. `{"verdict":"fail"}`                  | **G** (agent's decision) routed by D | yes                           | wrong branch; skips are irreversible                            | `routeDecisions` + result                                         | later: P second opinion on audit-style results                                                           |
| 6   | DAG readiness and skip propagation  | `dag.ts:109-348`                               | graph rules                                                 | D                                    | no                            | —                                                               | —                                                                 | none                                                                                                     |
| 7   | Retry eligibility and backoff       | `pipelineTransitions.ts:1266-1292`             | failure class ∈ `retryOn`                                   | D                                    | no                            | wasted run, or a missed retry                                   | `retries`, `retryAt`, journal                                     | none                                                                                                     |
| 8   | Retry-note content                  | `E:808-860`                                    | class-specific evidence tail                                | D                                    | no                            | a worse retry prompt                                            | only inside `Run.prompt`                                          | none                                                                                                     |
| 9   | Deadline and stall                  | `invocation.ts:282`, `harness/stall.ts:43`     | wall clock                                                  | D                                    | no                            | killed a slow-but-alive run                                     | `Run.termination`                                                 | none                                                                                                     |
| 10  | Checks pass or fail                 | `harness/verification.ts:566`                  | exit codes, stat, globs                                     | D (**observed**)                     | no                            | caveat: scripts live in the agent-edited tree                   | report, current attempt only                                      | none                                                                                                     |
| 11  | Best-of-N selection                 | `pipelineTransitions.ts:856`                   | checks, then cost/duration                                  | D                                    | yes, among passing candidates | losers' worktrees destroyed; irreversible                       | `candidateOutcomes`                                               | good later P candidate ("which passing candidate better meets intent?"); ROADMAP.md:131 defers it        |
| 12  | Runtime, capabilities, workspace    | `runtimes/index.ts:77`, `invocation.ts:52-332` | narrowest-wins; strict enforcement                          | D                                    | no                            | configuration failure                                           | invocation.json                                                   | none                                                                                                     |
| 13  | Budget enforcement                  | `budget.ts:247`, `scheduler.ts:409`            | ratios and ladder                                           | D                                    | no                            | overspend or a blocked run                                      | `budgetAction` on run                                             | none                                                                                                     |
| 14  | Gate: approve / revise / abort      | `E:5514-5622`                                  | **human** (admin-gated UI)                                  | **H**                                | —                             | wrong acceptance commits knowledge                              | **only state changes; no decision record, no actor**              | now recorded (§M.2); it is H1's operator-action reference, a behavioural record, not a correctness label |
| 15  | Gate: Verdict auto-approve          | `verdictWatcher.ts:127-163`                    | haiku 0–10 per criterion, min over judged steps ≥ bar       | **P → policy → transition**          | yes, and **uncalibrated**     | same as #14, and invisible                                      | verdicts.json (400, overwritten on re-judge); approval unrecorded | the incumbent to beat in H1                                                                              |
| 16  | `needs-input` pause                 | `pipelineTransitions.ts:484`; `claude.ts:212`  | agent asks                                                  | G → H                                | —                             | skips validation (B.3 #9)                                       | payload                                                           | none                                                                                                     |

### C.2 Knowledge ledger

| #   | Decision                                              | Where                                          | Mechanism today                                       | Class                      | Unc.                           | Wrong → / reversible                                                               | Replay                                          | Shadow fit                                                                          |
| --- | ----------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- | -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| 17  | Delta schema, references, scope, preflight            | `delta.ts:287-558`                             | code                                                  | D                          | no                             | bad delta refused (fail-closed)                                                    | staged sidecars                                 | none                                                                                |
| 18  | **Claim support**                                     | `K:1117-1185`                                  | `evaluateSupport`, pure                               | **D, and must stay D**     | no, by design                  | —                                                                                  | derived                                         | **excluded.** A probabilistic "support" would be a second, competing definition     |
| 19  | Impact and currency                                   | `impact.ts:93`, `K:1348`                       | pure                                                  | D                          | no                             | —                                                                                  | derived                                         | excluded                                                                            |
| 20  | Context integrity                                     | `context.ts:619`                               | sha256                                                | D                          | no                             | step fails                                                                         | journal                                         | none                                                                                |
| 21  | Candidate rule content (is this a rule, what it says) | discovery agent                                | agent authors                                         | **G** → H (gate)           | —                              | wrong rule becomes canonical                                                       | delta + preview                                 | none                                                                                |
| 22  | Does the cited code actually express the rule?        | `discovery.ts:491-545` checks only shape       | **not decided by anyone except the reviewer**         | **P**                      | yes                            | a rule grounded by the wrong code; reversible only by revision                     | source evidence refs at commit                  | **strong P candidate** as a reviewer aid                                            |
| 23  | Rule conformance outcome                              | verifier agent → `ruleVerification.ts:509-643` | agent's semantic judgment; Argus validates references | **G performing P**, then H | yes, but the record forbids it | a false `holds` feeds realization success; the record is immutable per (run, rule) | `ledger.verifications` (durable), evidence refs | **P as an audit**: "is this outcome grounded by its cited evidence?" (§H, deferred) |
| 24  | Acceptance criterion outcome                          | `acceptance.ts:324-527`                        | same                                                  | G performing P, then H     | yes                            | false `satisfied` gives false realization success                                  | durable                                         | same as #23                                                                         |
| 25  | Change classification and readiness                   | `changeIntent.ts:606-917`                      | agent content; D over it                              | G → H (forced gate)        | —                              | intent becomes canonical                                                           | durable                                         | none. Human authority                                                               |
| 26  | Implementation scope                                  | `implementationScope.ts`                       | union over provenance                                 | D                          | no                             | missing target                                                                     | durable                                         | none                                                                                |
| 27  | Completion and remediation class                      | `realization.ts:191-330`                       | ordered conjuncts                                     | **D**                      | no                             | —                                                                                  | durable attempts                                | **none.** This is Codex's "remediation category", already solved deterministically  |
| 28  | Stale intent                                          | `K:2204`, `E:1777`                             | active revision                                       | D                          | no                             | —                                                                                  | durable                                         | none. See B.3 for the support gap                                                   |
| 29  | Remediate vs stop                                     | `E:4938-4985`                                  | remediable flag plus budget                           | D (+H on stop)             | no                             | —                                                                                  | durable                                         | none                                                                                |
| 30  | Admin HTTP writes                                     | `routes.ts:736-822`                            | operator                                              | H (unaudited provenance)   | —                              | forged `producedBy`                                                                | knowledge.json                                  | none                                                                                |

### C.3 Analysis passes and operational judgment

| #   | Decision                         | Where                 | Mechanism today                               | Class                            | Unc.                  | Wrong → / reversible                          | Replay                                                  | Shadow fit                                                                 |
| --- | -------------------------------- | --------------------- | --------------------------------------------- | -------------------------------- | --------------------- | --------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| 31  | Failure class of a failed run    | `autopsy.ts:128-240`  | haiku, closed 11-way taxonomy, 0–1 confidence | **P** (Choice), but **partly D** | yes, for the residual | wrong Issue clustering; advisory; reversible  | autopsies.json (200); no model, no input hash, no label | **best first experiment** (H2), after deterministic pre-classification     |
| 32  | Autopsy why / span / promptDelta | same                  | haiku                                         | G                                | —                     | a bad relaunch prompt (human-gated)           | same                                                    | none. Stays G                                                              |
| 33  | Output quality per criterion     | `verdict.ts:192-295`  | haiku scores; Argus weights                   | **P** (Score)                    | yes                   | trend noise; regression Issue; **gate** (#15) | verdicts.json; Vault keeps the overall score only       | incumbent baseline for H1: a rating, compared at the decision level (§H.3) |
| 34  | Quality regression               | `verdict.ts:378`      | score < `minScore`                            | D policy over P                  | —                     | noisy Issues                                  | same                                                    | —                                                                          |
| 35  | Incident open, escalate, notify  | `sentinel.ts:242-337` | fixed rules and clock                         | D                                | no                    | page or no page                               | incidents.json + Vault                                  | none                                                                       |
| 36  | Incident diagnosis               | `diagnose.ts:38`      | haiku text plus confidence                    | G (a confidence on prose)        | weak                  | advisory                                      | incidents.json                                          | none                                                                       |
| 37  | Issue clustering                 | `issues.ts:143-197`   | regex, sha, Jaccard 0.5/0.7                   | D (consumes #31)                 | —                     | merged or split issues                        | triage only                                             | possible P ("same root cause?"), low value                                 |
| 38  | Anomaly                          | `watchtower.ts:235`   | median/MAD, z ≥ 3.5 and ratio ≥ 1.5           | D (statistical)                  | handled already       | a false page                                  | Vault events                                            | none                                                                       |
| 39  | Settings proposals               | `tuning.ts`           | haiku                                         | G → H                            | —                     | human applies                                 | tuning.json (50); accept/reject not recorded            | none                                                                       |
| 40  | Intent → mutations               | `omnibar.ts:160-373`  | haiku planner; validated; human confirms      | G → H                            | —                     | compensating transaction                      | **in memory only**                                      | none                                                                       |
| 41  | Monitor status                   | `monitors.ts:81`      | grace window                                  | D                                | no                    | —                                             | —                                                       | none                                                                       |

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
    model guesses a fact Argus recorded. (These are Autopsy's own class
    names. §H.2 records them as observed termination classes, `deadline`,
    `never-ran`, `output-refused`, `rate-limited` and `permission-denied`,
    and keeps inferred cause as a separate question.)
  - In #1: one deterministic rule should govern a missing marker on both
    paths.

---

## D. Testing the hypothesis

The hypothesis is that a Decision Plane sits cleanly between the Evidence
plane and the Policy plane. The table checks each specific hazard against
the current code.

| Hazard                                                    | Present today?                                                                                                                                                                                                    | Verdict for the Decision Plane                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Duplicated semantics with the ledger/TMS**              | Not yet, but Codex's R17 example would create it                                                                                                                                                                  | **Real.** Rule: assessments never use ledger vocabulary (`supported`, `holds`, `satisfied`) and never have a claim's truth as their subject. Their subjects are **records and executions**: a run, a phase attempt, a gate review, a verification record. "Is this `holds` record grounded by what it cites?" is a question about a record. "Does R17 hold?" belongs to the ledger and the verifier. |
| **Hidden feedback loops**                                 | **Yes, three.** Autopsy class → Issues clustering → Sentinel regression pages. Autopsy `promptDelta` → relaunch prompt. Verdict score → gate → ledger commit → the next run's KnowledgeContext → the next Verdict | Real. An assessment's consumers must be declared (policy registry, §F), and no assessment feeds a prompt or a ledger write without passing through a named policy.                                                                                                                                                                                                                                   |
| **Probabilistic decisions contaminating factual state**   | **Yes** (A.2)                                                                                                                                                                                                     | This is the reason to do the work. It is enforced by the invariant structure in §E, not by convention.                                                                                                                                                                                                                                                                                               |
| **Model and version drift**                               | **Yes.** `Verdict` and `Autopsy` carry no model, runtime or prompt version, and `ARGUS_ANALYSIS_MODEL` can change underneath a trend line                                                                         | Every assessment carries `ProviderIdentity` and `question.version`. Trends and thresholds are keyed by them.                                                                                                                                                                                                                                                                                         |
| **Stale repository state**                                | Not for runs (immutable), but yes for anything verification-shaped                                                                                                                                                | Snapshots carry `RepositoryStateRef` when the subject is state-dependent. Currency is derived with `sameRepositoryState`, never written back.                                                                                                                                                                                                                                                        |
| **Input construction becoming an implicit prompt system** | **Yes, already.** `buildVerdictPrompt` and `buildAutopsyPrompt` are the state construction                                                                                                                        | Split it: a provider-neutral, typed, hashed **StateSnapshot** (the same projection-plus-hash discipline as KnowledgeContext) is built by Argus. Rendering it into prose is the **adapter's** versioned job. Claude needs rendering; whether and how Jev ingests structured state is unverified (§G.3). The hash is over the snapshot, not the prompt.                                                |
| **Threshold brittleness**                                 | **Yes.** `autoApprove.verdict` is a bar on an uncalibrated Haiku score                                                                                                                                            | Thresholds bind to (question, version, provider, requested and reported model). A provider or model change voids the threshold until it is re-validated on the shadow corpus.                                                                                                                                                                                                                        |
| **Correlated decisions treated as independent**           | Partly. Verdict takes the min across steps, which is correct. But Claude-judges-Claude shares failure modes with the generator                                                                                    | Policy never multiplies probabilities. Provider heterogeneity is a measured property, not an assumption. This is the one structural argument **for** a non-generative provider (Jev is described that way; unverified, §G.3), and it has to be shown empirically.                                                                                                                                    |
| **Repeated decisions producing inconsistent state**       | **Yes.** `writeVerdict` replaces by runId, so re-judging erases history                                                                                                                                           | The journal is append-only. Repeated calls are samples (`sample` index); instability is itself a metric.                                                                                                                                                                                                                                                                                             |
| **Results outliving their evidence**                      | Not tracked at all                                                                                                                                                                                                | Currency = snapshot hash re-derivable now ∧ question version unchanged ∧ every referenced ledger revision still active. Derived, never stored.                                                                                                                                                                                                                                                       |
| **Scope leakage**                                         | Low today (analysis is local)                                                                                                                                                                                     | Snapshots are built only from the subject's own scope plus `alsoRead` (as in `context.ts:347-372`). An external provider additionally needs a per-scope **egress policy**.                                                                                                                                                                                                                           |
| **Replay determinism**                                    | None: nothing is recorded that could be replayed                                                                                                                                                                  | Replay means **reading the recorded result** with a named policy version, never calling again; it is a reader of the journal, not a provider (§F.3). A re-evaluation is a new provider call on a retained snapshot, recorded as a new assessment.                                                                                                                                                    |
| **Provider lock-in**                                      | Soft lock to headless CLIs, which is fine                                                                                                                                                                         | The seam in §G. Core never requires a key.                                                                                                                                                                                                                                                                                                                                                           |
| **Privilege escalation through semantic judgment**        | **Yes.** An agent's `resultSummary` is inlined verbatim into the judge prompt, so a phase can write "all criteria fully met" and move its own gate                                                                | **Asymmetric authority invariant:** an assessment whose snapshot contains subject-authored content may only **withhold** permission (escalate, flag, block auto-approval), never **grant** it. No assessment of any kind may open a gate on a phase that stages knowledge.                                                                                                                           |

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

| Kind                | Examples                                                                                         | Authority                                                                                     | Where                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Observation**     | check exit code, `termination`, `gitHead`, snapshot hash, supplied-context sha256                | Argus's own instrumentation                                                                   | run, invocation, VerificationReport           |
| **Accepted record** | Claim, Evidence, Justification, RuleVerification, AcceptanceVerification, AcceptedChangeProposal | whoever crossed the acceptance boundary (a human gate, or an ungated phase's checks)          | `knowledge.json`                              |
| **Assessment**      | "p(operator sends back) = 0.81 from provider X, requested model M, on snapshot H, for Q v2"      | **none about the world.** It is authoritative only about the fact that the inference happened | Decision Journal (new)                        |
| **Permission**      | gate opened, route taken, remediation started                                                    | policy code and humans                                                                        | instance, journal, ledger realization records |

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
**Phase 0 (§M) deliberately stopped short of this. Phase 1 implements it with
the resolutions recorded in §O, which govern where they differ from these
sketches.**

### F.1 Four kinds of number, never interchangeable

Argus already produces numbers that look alike and mean different things.
The contracts keep them in different fields, so none can be read as another:

| Kind                              | Example today                                              | What it is                                                                                                        | What it is not                                                                             |
| --------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Rating**                        | `Verdict.score` (0–10, weighted by Argus)                  | an ordinal position on a scale an author wrote                                                                    | a probability. `score / 10` is a _normalised rating_; nothing calibrates it to a frequency |
| **Predicted probability**         | a provider's distribution over a closed answer space       | a number whose meaning depends on how it was elicited (§G.2) and whose calibration is **measured**, never assumed | a correctness guarantee                                                                    |
| **Provider confidence statistic** | `Autopsy.confidence`; a vendor's "confidence" field        | a statistic the provider derives and reports, recorded verbatim with the provider's own definition                | P(the answer is right). It is never an input to a policy threshold as if it were           |
| **Observed outcome**              | an operator's gate action; a realization that later failed | what happened, with its own provenance (§M.2)                                                                     | an assessment. No provider produces one                                                    |

### F.2 Contracts

```ts
/** What is being asked about. Always a record or an execution, never a claim's truth. */
export type DecisionSubject =
  | { kind: "run"; runId: string }
  | { kind: "phase-attempt"; instanceId: string; phaseId: string; attempt: number }
  | { kind: "rule-verification"; verificationId: string }
  | { kind: "acceptance-verification"; verificationId: string };

/** Argus's answer shapes. They map onto Noul/Choice/Score, but are defined here. */
export type AnswerSpace =
  | { shape: "binary" } // p(yes)
  | { shape: "choice"; options: Array<{ id: string; label: string }> } // closed; ids are slugs
  | { shape: "scale"; points: Array<{ value: number; label?: string }> }; // closed ordinal points

export interface DecisionQuestion {
  id: string; // "run.failure-cause.residual", "gate.operator-action"
  version: number; // bump on ANY change to wording, answer space or projection
  text: string; // the question as a domain sentence, provider-neutral
  answers: AnswerSpace;
  subject: DecisionSubject["kind"];
  projection: { id: string; version: number }; // which StateSnapshot builder
  /** Declared consumers. A policy not listed here may not read this question. */
  consumers: string[]; // policy ids
}

/** The typed input. Built by Argus, never by a provider, and RETAINED (§F.3). */
export interface StateSnapshot {
  projection: { id: string; version: number };
  subject: DecisionSubject;
  scope?: KnowledgeScope;
  repository?: RepositoryStateRef; // Argus-recorded, when state-dependent
  refs: {
    // what the body was built from
    runs: string[];
    claims: ClaimRef[];
    verifications: string[];
    artifacts: ArtifactRef[];
  };
  /** Which fields of the body the subject itself authored (asymmetric-authority input). */
  subjectAuthored: string[]; // JSON pointers into body
  /** Redactions applied, by rule id — part of the projection version. */
  redactions: string[];
  body: unknown; // typed per projection; the exact evaluated payload
  sha256: string; // over canonical JSON of the above
  bytes: number;
}

/** A provider's answer, by kind (§F.1). A rating is never stored as a probability. */
export type DecisionAnswer =
  | { kind: "probability"; shape: "binary"; p: number }
  | { kind: "probability"; shape: "choice"; p: Record<string, number> } // sums to 1 ± ε; closed keys
  | { kind: "probability"; shape: "scale"; p: Record<string, number> } // over the declared points
  | { kind: "rating"; value: number; scale: { min: number; max: number } };

export interface ProviderIdentity {
  provider: "claude-cli" | "codex-cli" | "jev" | "deterministic" | "human" | "mock";
  /** What Argus asked for (an alias such as "haiku", or a pinned id). */
  requestedModel: string | null;
  /** What the provider's response said it evaluated with. Null = not reported —
   *  never back-filled from the request, never synthesised. */
  reportedModel: string | null;
  adapterVersion: number; // rendering/parsing code version
  /** How the probability came to exist. Not comparable across kinds without calibration. */
  elicitation: "native" | "verbalized" | "sampled" | "rule" | "label";
}

export interface DecisionAssessment {
  id: string; // minted: DA-…
  question: { id: string; version: number };
  subject: DecisionSubject;
  snapshot: { sha256: string; projection: { id: string; version: number } };
  provider: ProviderIdentity;
  sample: number; // 0..n-1 for repeated calls
  /** Set when this is a re-evaluation (§F.3): a NEW provider call on a retained snapshot. */
  reEvaluates?: string; // the DA-… it repeats
  outcome:
    | {
        status: "answered";
        answer: DecisionAnswer;
        /** Verbatim, keyed by the provider's own names; never read by policy as P(correct). */
        providerStatistics?: Record<string, number>;
        rationale?: string; // display only
      }
    | { status: "abstained"; reason: string }
    | { status: "failed"; failure: string };
  mode: "shadow" | "advisory" | "enforcing"; // what the calling policy did with it
  latencyMs: number;
  costUsd: number | null;
  tokens: number | null;
  createdAt: string;
}

/** What happened, recorded apart from what was predicted (§F.1). */
export interface DecisionObservation {
  id: string; // DO-…
  subject: DecisionSubject;
  kind: "operator-action" | "review-finding" | "later-outcome";
  value: string; // e.g. "revise", "defect:missing-test", "realization-failed"
  source: { recordId: string; recordedBy: string }; // e.g. a GD-… gate decision (§M.2)
  observedAt: string;
}

/**
 * Initial policies can only add friction. There is deliberately no effect that
 * removes a human wait or opens a gate: any future low-risk automation that
 * would is a separate design decision, not a value of this type.
 */
export interface DecisionPolicy {
  id: string;
  version: number; // replay evaluates a named version
  question: { id: string; version: number };
  providers: ProviderIdentity["provider"][]; // which assessments count
  aggregate: "latest-current" | "all-samples" | "min" | "disagreement";
  effect: "escalate" | "flag" | "withhold-auto-approval";
  threshold: number; // bound to question version and provider identity
}

export interface DecisionProvider {
  identity(): ProviderIdentity;
  supports(q: DecisionQuestion): boolean;
  assess(
    q: DecisionQuestion,
    s: StateSnapshot,
    signal: AbortSignal,
  ): Promise<DecisionAssessment["outcome"]>;
}
```

### F.3 Replay is not re-evaluation, and a hash is not an input

- **Replay** recomputes a report or a policy decision from **stored
  assessments** and a **named policy version**. It makes no provider call and
  costs nothing, and the same journal plus the same policy version always
  gives the same result. Replay is a reader of the journal, not a provider,
  so the earlier `ReplayDecisionProvider` is withdrawn.
- **Re-evaluation** is a **new provider call** on a retained snapshot. It
  produces a new assessment with `reEvaluates` pointing at the original. It
  never overwrites one, and it is how stability and drift are measured.
- **Retained input.** A `sha256` identifies an input but cannot reconstruct
  one. So the journal keeps the snapshot body itself, after redaction and
  exactly as evaluated, content-addressed by that hash. An assessment whose
  snapshot body is gone can still be replayed, but it can no longer be
  re-evaluated, and the report says so.

### F.4 Storage: bounded active journal, explicit archive

The storage is designed now so that it cannot drift into the Vault later.
None of it is implemented in Phase 0.

- **Active storage is bounded.** The journal is written as append-only JSONL
  segments with snapshot bodies stored beside them. A segment closes at a
  fixed size or age, with both limits configured and defaulted conservatively.
  Only open and recent segments count as active.
- **Archival is an explicit step.** Closing a segment moves it, together with
  the snapshot bodies only it references, into an archive directory. It also
  appends a manifest line recording the segment id, time range, record
  count, sha256 and location. Archival is logged. It never deletes anything.
- **Deletion is explicit and leaves a trace.** Nothing is ever deleted by a
  cap, and the journal's 512 KB delete-at-cap behaviour is not repeated. An
  operator command can remove an archived segment. That leaves a tombstone in
  the manifest, so a later replay reports a gap instead of an absence.
- **No dependency on the Vault.** Replay reads the active segments plus the
  manifest. The Vault may index the journal, but the journal never needs the
  Vault to answer.

**What these reuse instead of inventing:**

- `KnowledgeScope`, `ClaimRef`, `ArtifactRef` and `RepositoryStateRef` are
  imported as-is.
- The snapshot follows KnowledgeContext's projection → hash → durable-record
  discipline.
- `AnalysisRunner` stays the only spawn site for CLI providers.
- Journal records follow the write-ahead, fsynced append discipline that
  Phase 0 introduced for gate decisions (`sources/gateDecisions.ts`).

**What is deliberately absent:**

- A "fact" or "support" field.
- An "overall confidence" that the provider sets. Aggregation belongs to
  policy, the same way Verdict's weighted score belongs to Argus.
- Any field a provider can use to name the next transition.
- Any policy effect that grants.

---

## G. Provider architecture

### G.1 Providers

```
                       DecisionService (server/src/decision/)
            question registry · snapshot builders · journal · currency
                                     │ DecisionProvider
   ┌──────────────┬──────────────┬───┴──────────┬───────────────┬──────────────┐
   ▼              ▼              ▼              ▼               ▼              ▼
Deterministic  ClaudeCli       CodexCli       Jev (optional)  Human/Label    Mock
(rules; the    (AnalysisRunner (AnalysisRunner (unverified;   (recorded      (tests)
 baseline)      → claude -p)    → codex exec)  from env)       observations)
```

- **Deterministic** is a first-class provider, not an afterthought. For H2 it
  is the pre-classifier. For H1 it is a rule baseline. A P provider has to
  beat it to earn a place.
- **Human/Label** makes recorded observations (§F.1) comparable in the same
  tables. Phase 0 records operator gate actions (§M.2). They are
  **behavioural records, not correctness labels** (Decision 3).
- **Replay** is not a provider (§F.3). It regenerates any report from the
  journal and a named policy version without a call.

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

- The same question definition runs on Haiku and Sonnet (`requestedModel`
  in the identity; `reportedModel` stays null until a runtime reports one),
  so "model size" and "model class" can be separated as variables.

### G.3 Jev adapter (mapped last)

**Official documentation could not be reached from this environment.** Both
the main agent and a delegated retrieval agent tried
`https://docs.typesafe.ai/models`, `/api` and `/confidence`, and each attempt
returned `EGRESS_BLOCKED` from the egress proxy. Nothing below is confirmed
from official sources. Third-party search snippets gathered for the first
draft are not authority, and this section does not rely on them.

**Reported but unverified.** These corrections were supplied for this
amendment and **must be confirmed against the official pages before Phase 3**:

1. versioned model ids are supported (not only a floating alias);
2. a response reports the model version it evaluated with;
3. a Score response includes a full probability distribution over the scale;
4. "confidence" is a statistic derived from the distribution, not a
   correctness guarantee.

The adapter design below holds whichever way those turn out:

| Argus                | Jev                  | Mapping, and what it depends on                                                                                                                                                                                                                                         |
| -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `binary`             | Noul                 | `answer: { kind: "probability", shape: "binary" }`.                                                                                                                                                                                                                     |
| `choice`             | Choice               | Options pass through verbatim. The adapter refuses a response that does not cover every option, rather than renormalising a partial one.                                                                                                                                |
| `scale`              | Score                | If (3) holds, the distribution over the declared points becomes `{ kind: "probability", shape: "scale" }`, and any point estimate is **derived by Argus** from it. If only a point comes back, it is stored as a `rating`, never as a probability.                      |
| `abstained`          | ?                    | If Jev cannot abstain, the honest "cannot tell" is lost. An explicit `insufficient-evidence` option **changes the question** and bumps its version.                                                                                                                     |
| `snapshot.body`      | "state"              | The ingestion format and size limits are unconfirmed. Truncation is deterministic, hashed and part of the projection version.                                                                                                                                           |
| `requestedModel`     | the id sent          | Recorded as sent. If (1) holds, the adapter sends a pinned id. A floating alias is recorded as sent, and the assessment is flagged unpinned.                                                                                                                            |
| `reportedModel`      | the id returned      | Recorded only if the response reports it (2). Otherwise it stays `null`. **No synthetic alias** (such as a date-stamped `jev-latest@…`) is ever recorded as a resolved version. Unpinned assessments with no reported version are excluded from cross-time comparisons. |
| `providerStatistics` | "confidence"         | Recorded verbatim as a provider confidence statistic (§F.1). It is never read as P(correct) and never used as a policy threshold.                                                                                                                                       |
| `elicitation`        | `native` (claimed)   | "Calibrated" is a vendor claim. Argus measures it (§H.4) and never treats it as a property.                                                                                                                                                                             |
| failure              | HTTP errors, timeout | Maps to `failed`. Network absence degrades to "no assessment", which no policy can turn into a permission (§F.2).                                                                                                                                                       |
| cost / latency       | vendor claims        | Measured, never cited.                                                                                                                                                                                                                                                  |

### G.4 Configuration, failure and privacy

- **Keys.** `ARGUS_JEV_API_KEY` is read from the environment and never
  written to disk. It is excluded from `childEnv` passthrough, so an agent
  child never sees it. With no key, the provider reports
  `supports() = false` and the registry simply has one provider fewer. Core
  behaviour is unchanged.
- **Status (Decision 2).** TypeSafe integration and any new data egress stay
  **disabled**. No provider, API key or external service is required or
  configured. Everything here is design for a later, separately approved
  phase.
- **Egress.** Jev would be the **first provider that sends Argus state to a party
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
  also yields known reference labels, but only for a separate probe question
  over observed terminations; the residual cause question has none (§H.2).
  The "remediation" half is dropped: inside realizations it is D (#27).
- **(1) becomes H1, anchored to gates, and restated as a prediction of the
  operator's action** (§H.3). This is where an operator decision exists, and
  where the incumbent Verdict auto-approval is the baseline. It needed Phase
  0 to record gate decisions, which it now does (§M.2). Those records are
  behavioural records, not correctness labels.
- A third question is kept as a possible **semantic audit of verifier
  conclusions**, and is deferred: **H3, "do the evidence records this
  verification cites, as cited, plausibly establish the outcome it states?"**
  (#23/#24). Its subject is a `RuleVerification` or `AcceptanceVerification`
  _record_, never the rule or criterion itself. Its constraints are
  structural:
  - it does not redefine `evaluateSupport`, and support evaluation never
    reads it;
  - it is not an `EvidenceSource`, and it cannot be cited as supporting (or
    opposing) evidence;
  - its only permitted effect, if one is ever enabled, is escalation: flag
    the record for a person.

  It is the highest-value audit. Its only reference is expert review, which
  is optional (Decision 3), and a wrong answer here is the one that matters
  most.

### H.2 H2: failure cause, with observed termination kept apart

**Observed termination is not failure cause.** `Run.termination` and
`PhaseFailureClass` are observations: the run timed out, it never started,
its intake was refused. What _caused_ an agent to run out its deadline,
whether a missing file, an ambiguous prompt or a loop, is an inference. The
first draft folded `timeout` into a cause taxonomy. That was wrong, and this
amendment separates the two.

- **Deterministic stage (provider `deterministic`, `elicitation: rule`)**
  records the **observed termination class** as an observation, never as a
  cause:
  - `timed-out` / `stalled` → `deadline`;
  - `spawn-failed`, or interrupted by a restart → `never-ran`;
  - an intake refusal class → `output-refused`;
  - CLI envelope signatures → `rate-limited` / `permission-denied`.

  A run whose observed class is `never-ran` or `rate-limited` has no agent
  behaviour to explain, so no cause question is asked of it.

- **Residual question `run.failure-cause.residual` (v1):** "Which best
  explains why this agent run did not accomplish its task?" The options are
  `prompt-ambiguity | missing-context | tool-misuse | environment |
model-refusal | task-infeasible | other`. It is asked for runs that ended
  on their own **and** for runs that hit a deadline, because a timed-out run
  still has a cause. The options are causes, so no observed termination
  appears among them, and no provider is asked to guess a fact Argus
  recorded.
- **Probe question `run.termination-probe` (v1), a different question with
  a different taxonomy, versioned on its own.** It asks: "From this trace
  alone, how did this run end?"
  - Subject: runs whose termination Argus observed.
  - Snapshot: `termination`, `PhaseFailureClass`, exit code and error string
    are **withheld**.
  - Answer space: **every reference label the probe can carry**, `deadline |
never-ran | output-refused | rate-limited | permission-denied |
ended-normally`. Every probe item's reference label is therefore an
    answerable option. A probe item whose label falls outside the space is a
    construction error and is excluded, not scored.
  - What it measures: a provider's ability to recover an observed fact from
    a trace (a sensitivity and sanity check), and calibration on a subset
    with known answers.
  - **Probe performance is never reported as residual accuracy.** The
    report prints them in separate tables under separate question ids,
    because they are different questions over different populations.
- **Snapshot (`projection: run-failure v1`):**
  - run metadata;
  - the prompt (capped);
  - the last 60 Recorder events with error marks (as `buildAutopsyPrompt`);
  - the `resultSummary`.

  The residual question may see the observed termination class. The probe
  may not. Everything the agent authored is listed in `subjectAuthored`.

- **Ground truth, and its honest limits:**
  - **Residual.** Human corrections are optional (Decision 3). Until they
    exist, **accuracy on the residual question is unmeasured**, and the
    report says "unmeasured", not agreement presented as accuracy.
  - **Probe.** The reference labels are Argus's own observations, so
    accuracy and calibration are measurable, but only for the probe
    question.
  - **Existing Autopsy output.** It enters as a comparison row: `claude-cli`,
    `requestedModel` from its provenance where present (§M.4),
    `adapterVersion: 0`, on the old 11-way taxonomy. It is comparable to
    neither new question without an explicit, published mapping.

### H.3 H1: `gate.operator-action` (binary)

**The target, stated exactly.** H1 predicts **what the operator will do**
at this gate: send it back (revise or abort) rather than approve it. That is
a prediction of operator behaviour. **A good H1 score is not evidence that
review can safely be skipped**, and nothing in this RFC treats it as such.
An approved phase may still be wrong, and a revised one may have been fine.

- **Subject:** a phase attempt with a `gate` pause (§M.3). A `needs-input`
  pause is a question, not a review, and is out of scope.
- **Question (v1):** "Will the operator send this phase attempt back (revise
  or abort) rather than approve it as it stands?"
- **Snapshot (`projection: gate-review v1`):** built from what the operator
  sees in the gate drawer (`sources/artifacts.ts` review):
  - the step prompts and final messages;
  - the validated result;
  - the VerificationReport (labels, status, exit codes);
  - the changed-files list and diff stat (not full content in v1);
  - candidate or knowledge previews (counts, warnings, outcomes, evidence
    kinds);
  - Watchtower ratios;
  - the attempt number.
- **Three reference streams, never merged:**
  1. **Operator action.** The applied `operator` gate decision for that
     attempt (§M.2). This is a behavioural record, not a correctness label
     (Decision 3).
  2. **Review findings.** Optional human labels of what was actually wrong,
     if anything.
  3. **Later outcomes.** A failed realization attempt, a revise of the same
     work in a later instance, or a regression Issue, observed afterwards.

  Each is a separate `DecisionObservation` kind (§F.2). A later outcome never
  rewrites an operator action.

- **Blinding.** Experimental judgments are **hidden** from the operator at
  the gate for the whole shadow period (no badge, score or ordering in the
  gate drawer). They are also hidden from anyone recording a review finding.
  A label made after seeing the model's answer is not a reference for that
  model.
- **Exclusions.** Automated approvals have no operator action and are
  excluded. Gates that declare `autoApprove` are a biased subset, because a
  person only sees the ones that did not auto-open, and they are reported
  separately.
- **Providers:**
  - `deterministic`: predict "sent back" if any check was retried,
    `attempt > 0`, any `unverifiable`, an observation-only `holds`, a
    fatal-adjacent warning, or a cost or duration anomaly;
  - `claude-cli` on Haiku and on Sonnet;
  - later, `jev`.
- **The Verdict baseline, without a probability interpretation.** The
  existing Verdict decision is compared at the **decision** level: would
  auto-approval (as §M.3 now defines it) have opened this gate, yes or no,
  against the operator action. Its rating is used only in ways that
  respect an ordinal scale:
  - a confusion matrix at the author's bar;
  - rank agreement (for example AUROC over the rating).

  No Brier score, calibration curve or "p = score/10" is ever computed for
  a rating.

- **Volume warning.** This is a single-operator tool. If you decide tens of
  gates a month, calibration curves will not be meaningful for months. The
  report must show `n` and confidence intervals, and must not show
  reliability buckets with fewer than about 20 items. An offline
  **seeded-defect corpus** (known-bad outputs made by mutating good ones)
  measures sensitivity, not operator behaviour. It is reported separately
  and never mixed with real traffic.

### H.4 Measurements

Every metric is computed by **replay** over the journal (§F.3), so the
report costs nothing to regenerate. Stability and drift need
**re-evaluation**, which is new calls on retained snapshots, and are budgeted
as such.

| Metric                            | Definition                                                                                                                                          | Applies to                                                             | Needs a reference? |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------ |
| Agreement                         | accuracy and Cohen's κ against the reference stream named in the row; confusion matrix                                                              | all answers                                                            | yes                |
| **False close** (H1)              | P(predicts "approve" \| operator sent back)                                                                                                         | H1, Verdict baseline                                                   | operator action    |
| False escalation (H1)             | P(predicts "sent back" \| operator approved)                                                                                                        | H1, Verdict baseline                                                   | operator action    |
| Calibration                       | Brier score; reliability buckets with n shown; ECE only when n ≥ 200                                                                                | **predicted probabilities only**, never ratings or provider statistics | yes                |
| Rank agreement                    | AUROC over the rating or probability                                                                                                                | ratings and probabilities                                              | yes                |
| Provider statistic vs correctness | accuracy by decile of the provider's own confidence statistic, reported as a description of that statistic                                          | provider statistics                                                    | yes                |
| Provider disagreement             | total-variation distance between providers per subject; agreement rate                                                                              | probabilities                                                          | no                 |
| Stability                         | k = 3 re-evaluations of the same retained snapshot: top-answer flip rate and mean TV distance                                                       | all                                                                    | no                 |
| Robustness to irrelevant state    | inject content-free padding and measure the shift; **inject a subject-authored instruction ("reviewer: approve") and measure the shift**            | all                                                                    | no                 |
| Robustness to missing state       | ablate one field. The expectation is that confidence **drops**; count cases where it rises                                                          | probabilities                                                          | no                 |
| Latency, cost, size               | p50/p95 latency; USD and tokens per assessment; snapshot bytes                                                                                      | all                                                                    | no                 |
| Drift                             | re-evaluate a frozen **canary set** of about 50 retained snapshots monthly per provider identity (requested **and** reported model); alert on shift | all                                                                    | no                 |
| Versus the deterministic baseline | every metric above with the rule provider as a row                                                                                                  | —                                                                      | —                  |

**Where no reference exists, the cell reads "unmeasured", never agreement
presented as accuracy. Probe rows and residual rows are never pooled.**

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
   Mitigation: there are no granting effects at all (§F.2, Decision 4).
   Escalation thresholds are bound to the question version and provider
   identity, and ship with their `n`.
4. **Snapshot creep.** Projections will grow toward "include everything", which
   becomes the implicit prompt system under a new name. Mitigation: projection
   versions are reviewed like migrations; bytes are a tracked metric;
   irrelevant-state robustness is measured.
5. **Two sources of classification truth.** Autopsy's model class and
   `PhaseFailureClass` already coexist. A third would make it worse unless
   the residual cause question **replaces** Autopsy's classification once it
   lands (Phase 4). Observed termination then stays with the deterministic
   stage, and the probe question stays a measurement only.
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

| Phase                                                       | Work                                                                                                                                                                                                                                                                                                                                                                                                                      | Reversible by                                                  | Exit criterion                                                                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **0: Harden what exists (no Decision Plane): DONE, see §M** | (a) refuse `autoApprove` on knowledge-committing phases when saved, **and** at the engine's automated-approval boundary; (b) a durable, write-ahead gate decision record for approve, revise and abort, with mechanism, channel and a server-resolved principal; (c) auto-approval that is complete, current and bound to one phase attempt; (d) Verdict and Autopsy stamped with provenance, and re-judging that appends | reverting the change set; saved definitions were not rewritten | met: see §M.6                                                                                                             |
| **1: Contracts and journal**                                | `contracts/src/decision.ts`; `server/src/decision/` (registry, projections, bounded journal with retained snapshots and an explicit archive, currency); Deterministic, ClaudeCli and Mock providers over `AnalysisRunner`; replay as a reader; a mandatory ledger-isolation regression test                                                                                                                               | deleting the module; nothing else imports it                   | journal round-trip; replay reproduces a report byte for byte; a re-evaluation of a retained snapshot works after archival |
| **2: Shadow H2, then H1**                                   | H2 residual and probe watchers, plus an optional Autopsy correction affordance; H1 watcher on gate pauses (needs 0b), blinded; the Verdict decision baseline; a read-only report page                                                                                                                                                                                                                                     | the env switch                                                 | enough n to print non-"unmeasured" cells                                                                                  |
| **3: Jev (optional, disabled by Decision 2)**               | only after its official documentation is verified (§G.3) and egress is separately approved: adapter, egress policy, redaction projection, version pinning; the same questions                                                                                                                                                                                                                                             | unsetting the key                                              | same report with a Jev row                                                                                                |
| **4: Decide**                                               | review the numbers. Candidate outcomes: H2 replaces Autopsy's classification; H1 is shown as **escalation reasons** in the gate drawer (advisory); or stop                                                                                                                                                                                                                                                                | —                                                              | a written decision, not a default                                                                                         |
| **5: Enforcing, escalate-only**                             | e.g. `withhold-auto-approval` when `gate.operator-action` ≥ τ on non-knowledge phases, making Verdict auto-approve stricter, never looser                                                                                                                                                                                                                                                                                 | removing the policy                                            | false-close rate measured below a bar you set                                                                             |

Granting effects, meaning an assessment that removes a human wait or opens a
gate, are not on this path and do not exist in the contract (Decision 4). Any
future low-risk automation of that kind is a separate design decision, with
its own evidence. Verdict's existing `autoApprove` on ordinary phases is
pre-existing, author-configured automation. Phase 0 hardened it, and the
Decision Plane may only make it stricter.

---

## K. Recommendation

1. **Phase 0 is done (§M).** It closed the place where a model judgment
   became canonical knowledge without anyone knowing, and it started
   recording the operator actions H1 will need. Operator actions are
   behavioural records, not correctness labels.
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

## L. Decisions taken, and questions still open

Resolved by the 2026-09-29 amendment:

1. **autoApprove on knowledge phases:** refused. There is no opt-in bypass.
   Saving is refused, the engine refuses at runtime, and existing affected
   pipelines require manual approval (§M.1, §M.5).
2. **Egress to TypeSafe:** kept disabled. No new provider, API key, external
   service or data egress. The existing authorised Claude CLI workflow
   continues (§G.3, §G.4).
3. **Labelling:** human labelling is optional. Gate actions are behavioural
   records, not automatic correctness labels (§H.3).
4. **The asymmetric-authority invariant:** initial assessments cannot grant
   permission. `grant` is removed from the contract. Future low-risk
   automation needs a separate design decision (§F.2, §J).
5. **Journal retention:** bounded active storage plus explicit archival and
   retention, with no dependency on the Vault (§F.4). Designed here and not
   implemented in Phase 0.

Resolved for Phase 1 (§O):

- `DecisionObservation`s are **derived read-only** from existing durable
  records, never written by the engine (§O.1).
- Active storage limits and how their total stays bounded (§O.2).

---

## M. Phase 0 as implemented

Phase 0 is the only phase implemented. It adds no Decision Journal, no new
provider, no shadow watcher, no evaluation UI and no external integration.
It hardens what already existed.

### M.1 The approval boundary

- **One definition** of "this gate commits knowledge", in
  `server/src/sources/gatePolicy.ts`. It is read from two things, neither of
  which an agent declares:
  - **configuration** (`knowledgeCommitReasons`): `discovery`,
    `ruleVerification`, `changeIntent`, `acceptanceVerification`,
    `implementation` (its acceptance records a realization attempt), and
    `knowledgeDelta: "required"`;
  - **staging** (`stagedKnowledgeReasons`): whatever this attempt actually
    staged, read from Argus's own sidecar records. This includes an
    _optional_ KnowledgeDelta on an otherwise ordinary phase, plus a pending
    commit or a realization link. A step that staged nothing leaves nothing
    to commit, and that absence is Argus's own observation.
- **At save time**, `validatePhase` refuses `autoApprove` on any phase whose
  configuration commits knowledge. The refusal is a 400 that names the
  reasons and the fix. It covers both POST/PUT and PATCH, because PATCH
  re-validates every phase it replaces. The rubric may stay; only automatic
  approval is refused.
- **At runtime**, automated approval has its own engine method,
  `Engine.approveAutomatically(request)`, separate from the operator
  `approve`. The Verdict watcher is wired only to it, so there is no path by
  which a score reaches `approve`. Under the instance lock it re-derives
  everything from the instance and its **own definition snapshot**, and
  refuses (409, with nothing recorded) unless all of the following hold:
  - the named phase is awaiting approval, on the named attempt, with a
    `gate` pause (§M.3);
  - the snapshot declares `autoApprove` and a rubric;
  - the phase commits **no** knowledge, by configuration or by staging;
  - the runs named are exactly the succeeded runs of the relevant steps;
  - every run has a verdict at or above the snapshot's bar, under the
    snapshot's rubric (by digest), that is still that run's **current**
    verdict in the store.

  The runtime check is what protects definitions saved before the rule, and
  instances whose snapshot predates it.

### M.2 Approval provenance

- **One record per decision submitted**, in `~/.claude/argus/gate-decisions.jsonl`
  (`contracts/src/gates.ts`, `server/src/sources/gateDecisions.ts`). Each
  record carries the instance, the phase(s) with their attempt, status and
  run ids, the decision (`approve | revise | abort`) and the timestamp, plus
  three things kept apart:
  - `mechanism`: `operator`, `verdict-auto-approve`, or `unspecified` for an
    in-process caller that did not say;
  - `channel`: `http`, `omnibar`, `verdict-watcher` or `in-process`;
  - `principal`: `session {username, role}`, `system {component}`, or
    `unknown`.
- **The principal is resolved server-side.** The HTTP routes read it from
  the authenticated session those routes already require. A request body
  that claims `actor`, `principal` or `mechanism` is ignored, and a test
  pins this.
- **Automated decisions are bound to their basis.** The record holds the
  exact verdicts used: id, run, timestamp, score, bar, runtime, requested
  and reported model, prompt version and rubric digest. They are rebuilt
  from the stored verdicts and the instance snapshot, never taken from the
  request (§M.8). Pruning the verdict store later cannot erase the
  explanation of an approval.
- **Intent, link, effects, completion.** This was corrected in the
  follow-up (§M.8); the order is always:
  1. validate — a refusal writes nothing;
  2. append the record and `fsync` it — the **intent**;
  3. **one** instance save that names the record in `gateDecisionIds`
     **and** carries `pendingGateOperation`, before any effect;
  4. the effects: supersede staged records, stop runs, commit knowledge,
     settle realizations, transition the phase. Each is idempotent against
     disk;
  5. the save that clears `pendingGateOperation`.

  Consequences:
  - A record that cannot be written refuses the decision with a 500, and the
    instance file stays byte-identical.
  - Concurrent duplicates serialise on the instance lock. One applies; the
    other fails validation and records nothing.
  - A crash between steps 2 and 3 leaves a record the instance does not
    name. No effect has started, it reads `not-applied`, and nothing replays
    it.
  - A crash anywhere in step 4 leaves the decision linked with its marker.
    It reads `incomplete`, and the engine completes it, exactly once,
    before any other transition of the instance.
  - A torn final line is skipped on read, and the next append starts on a
    fresh line (a defect the tests caught, fixed).

- **Effect is derived, never trusted.**
  - `applied`: linked, with no pending marker.
  - `incomplete`: linked, with the marker still present. Some, all or none
    of its effects may have happened, and it is never rounded to either
    side.
  - `not-applied`: not linked, so no effect started.
  - `unknown`: the instance has been pruned.
- **History stays unknown.** Gates decided before this change have no
  record. `GET /api/instances/:id/gate-decisions` lists them as
  `undocumented` and never attributes them.
- **The gate log is kept apart from the journal.** The instance journal is
  deleted at 512 KB and instances are pruned per pipeline. The decision log
  is append-only and is not pruned: human-scale volume, and the provenance of
  an accepted commit must outlive the instance that made it. Its future
  retention follows §F.4.

### M.3 Complete, current, attempt-bound auto-approval

- The previous watcher defects are fixed. It took the minimum over the steps
  that _happened_ to be judged, ignored failed judgments, looked only at
  `currentPhaseIndex`, and approved "the instance", which the engine
  resolved to the first paused phase. Now:
  - **every relevant step** must have a current, `ready` verdict under the
    snapshot rubric. For a best-of-N phase, the relevant steps are the
    selected candidate's (`gateRelevantSteps`);
  - every waiting phase is considered;
  - the request names phase, attempt, runs and verdicts, and the engine
    re-checks them all.
- **The pause cause is recorded** on `PhaseProgress.pause`: `gate` or
  `needs-input`. It is cleared on a fresh attempt. Automation opens only
  `gate` pauses:
  - a `needs-input` pause is a question put to a person;
  - a pause written before causes were recorded is treated as unknown and
    left for a person.
- **Verdicts carry `rubricDigest`**, sha256 over goal and criteria, excluding
  `minScore`, which is policy. A legacy verdict without one cannot open a
  gate.
- **Knowledge gates declaring `autoApprove`** are journaled once per attempt
  per process as `phase.auto-approval-withheld`, so the author can see why a
  gate waits.

### M.4 Judgment provenance

- **Verdict and Autopsy records** carry `id` (`V-…` / `A-…`) and
  `provenance { runtime, requestedModel, reportedModel, promptVersion }`.
  Verdicts also carry `rubricDigest`.
- **`requestedModel` is what Argus passed.** For the Claude runtime that is
  the `haiku` alias, which the CLI resolves.
- **`reportedModel` is `null`.** No runtime envelope parser extracts a model
  today, so none is fabricated or back-filled.
- **The runner's defaults are unchanged.** `AnalysisRunner` now reports the
  runtime and requested model on every result, refusals included, but it
  still uses the same defaults (`ARGUS_ANALYSIS_RUNTIME`,
  `ARGUS_ANALYSIS_MODEL`, the runtime's `defaultAnalysisModel`).
- **Re-judging appends.** It no longer replaces earlier judgments. Every
  consumer that means "the verdict for this run" reads the **current**
  (newest) one through `currentVerdicts` / `currentAutopsies`: trends,
  regression Issues, what-if, Vault ingest, failure-class clustering and
  the per-run reads. The store caps are unchanged and now shared by
  re-judgments.

### M.5 Migration

- **Saved definitions are not rewritten.** A legacy definition with
  `autoApprove` on a knowledge phase keeps the field on disk, but the field
  is inert:
  - the gate waits for a person;
  - the withheld notice is journaled;
  - the next edit of that pipeline returns a 400 until `autoApprove` is
    removed from that phase.
- **In-flight instances** keep their snapshot, and the runtime boundary
  refuses on it.
- **Instances already paused at upgrade** have no recorded pause cause, so
  they need a person.
- **Verdicts written before upgrade** have no rubric digest, so they cannot
  open a gate.
- **Ordinary phases with `autoApprove`** auto-approve under the stricter
  rules of §M.3. A gate that would previously have opened on a partial or
  stale judgment now waits.
- **Pipelines without `autoApprove`, and ungated phases,** behave as before.
  Their gate actions are now recorded.
- **API changes:**
  - `GET /api/instances/:id/gate-decisions`;
  - approve and revise accept an optional `attempt`, which is refused if the
    phase has moved on;
  - `Engine` gains `approveAutomatically`, and `abort` takes an optional
    source;
  - `PipelineInstance.gateDecisionIds` and `PhaseProgress.pause` are added;
  - `Verdict` and `Autopsy` gain optional fields.

### M.6 What was tested, and what it establishes

The regression tests were written first. The four original failures were
reproduced against the unmodified commit:

- validation accepted `autoApprove` on `changeIntent`;
- a two-step gate opened on one judged step;
- a `ruleVerification` gate was auto-approved;
- the watcher's approve named no phase or attempt.

They are covered in `sources/gatePolicy.test.ts`,
`gateDecisionsEngine.test.ts` (real engine, assertions on disk),
`verdictWatcher.test.ts`, `appEngine.test.ts`, `sources/verdict.test.ts`
and `sources/autopsy.test.ts`:

- new configurations are refused (create and PATCH), and ordinary ones are
  unchanged;
- legacy definitions and snapshots are refused at the engine: the ledger is
  byte-identical and no record is written, and an operator can still
  approve;
- an optional staged delta is refused;
- direct engine calls are refused for:
  - the wrong attempt;
  - a foreign run or an extra run;
  - a missing verdict;
  - a score below the bar, or a bar that is not the definition's;
  - another rubric, or a legacy digest;
  - an unknown phase;
  - a needs-input pause, or a pause of unknown cause;
  - a re-judgment that landed after the watcher looked;
- a revised attempt cannot be opened by a stale approval, and siblings are
  never mis-targeted;
- the watcher waits on partial judging, a failed current verdict, another
  rubric, a legacy verdict, another attempt's run, a knowledge gate or a
  staged delta; it judges the winner only; it never answers needs-input;
- provenance: HTTP body spoofing is ignored; unspecified in-process calls are
  `unknown`; revise and abort are recorded; undocumented history is listed;
- persistence and recovery: a failed write leaves the instance byte-identical;
  duplicates yield one record; orphans read `not-applied` across a restart;
  torn lines are handled;
- judgments: provenance stamped, history kept, current-per-run consumers.

Full suites on the final tree: server 2361 tests, 2357 pass, 1 fail and 3
skipped; web 1110 of 1110 pass. The one failure, `changeEngine.test.ts` "the
proposal is staged per run, beside the delta and never inside the ledger",
fails identically on the unmodified base commit. It is pre-existing and
tracked below. One earlier full run also showed a one-off module-load error
in `contextDurability.test.ts` that did not reproduce, either alone (3 of 3
runs) or in the final full run. Typecheck and lint are clean. Prettier's
remaining warnings are on files this change does not touch, or predate it.

### M.7 Trust limits that remain

- **A session is not a person.** `principal: session` means the request
  carried a valid session for that account. Any process holding that session
  cookie, or the account's credentials, is indistinguishable. In particular:
  - `ARGUS_USER` and `ARGUS_PASSWORD`, if exported in the server's
    environment, are **not** stripped from agent child environments.
    `ARGUS_SERVER_SECRETS` lists only `ARGUS_TOKEN` and `ARGUS_WEBHOOK_URL`.
  - An agent that can read the browser's cookie store can act as the
    operator.

  An actor field does not solve agent impersonation.

- **The decision log is not tamper-evident.** It is a local file writable by
  the same OS user the agents run as, like `knowledge.json` and the instance
  files. It records honestly what Argus did. It does not defend against a
  same-user process editing it.
- **The channel `http` covers both the web UI and the `argus approve` CLI**,
  and does not distinguish them.
- **Signal authority is unchanged.** The per-instance signal token is still
  in the agent's environment, so a process the agent runs can forge
  completion signals. Tracked below.
- **The needs-input bypass is unchanged for people.** An operator approving
  a needs-input pause still skips result validation, checks and intake. Only
  automation was closed off. Tracked below.
- **Outcome-marker handling is inconsistent across runtimes.** A missing
  marker counts as success on the hook path and as failure on the fallback
  path. Tracked below. This must be assessed before any future enforcement
  or expanded automation.

---

### M.8 Phase 0 follow-up: recovery, the decision point, authoritative provenance

This was a bounded verification pass. Every concern was reproduced with
deterministic fault injection before anything was changed. The seam used is
`EngineDeps.gateEffectProbe`: a probe called at each effect boundary, and
throwing from it simulates the process failing at that point. A "restart"
is a fresh engine over the same files. There are no sleeps and no timing.

**What reproduced** (against `7e03616`, with only the seam added):

- **Revise stopped nothing.** Its stop ran after `restartPhase` had replaced
  the steps, so a still-running step of the revised attempt (for example an
  agent waiting after `needs-input`) was never signalled.
- **Revise interrupted after superseding staged records read
  `not-applied`**, although its effects had happened. After a restart the
  revise was never carried through, and a retry performed it then.
- **Abort interrupted after stopping processes read `not-applied`**, and
  the instance could continue. After a restart, an approval of the attempt
  the abort was ending succeeded and **committed its staged delta**.
- **Abort interrupted after closing a realization** left the ledger closed
  and the instance running.
- **The parse memo let unsaved state leak.** `readInstance` returned the
  shared memoised object, so a failed operation's in-memory mutations were
  visible to every later read in the same process, until the file was next
  written. The engine could act on a state that existed nowhere on disk. On
  the pre-fix code, this masked three of the abort and approve windows.
- **A newer failed judgment could be ignored.** It was durably written
  after validation and before the instance link, became the run's current
  verdict, and the approval went ahead anyway.
- **Invented provenance was persisted.** A request's own `runtime`,
  `requestedModel`, `reportedModel` and `promptVersion` were recorded as the
  verdict's provenance, and a duplicate basis entry was accepted and
  persisted.

**What was corrected, and the guarantees now established:**

1. **Recovery and honest effects.**
   - The order is intent → link and pending marker → idempotent effects →
     completion (§M.2).
   - `readInstance` returns a private copy, so what the next reader sees is
     exactly what was last written.
   - Every engine path that mutates an instance reads it through `readLive`,
     which completes a leftover `pendingGateOperation` first:
     - the signal handler;
     - failure, retry and verification application;
     - deferred launches;
     - the reconcile heal;
     - approve, automated approve, revise and abort.

     Reconcile also completes every leftover marker at the start of each
     pass, whatever the instance's status.

   - Therefore:
     - **an interrupted revise is carried through once.** A retry finds it
       done (409). The attempt it discarded can no longer be approved, and
       its superseded records never reach the ledger;
     - **an interrupted abort ends the instance.** A signal arriving
       afterwards does not advance it, and nothing launches;
     - **an interrupted approval concludes once.** Its knowledge commit is
       idempotent;
     - **the ledger outcome of a realization closed by an interrupted abort
       is written once and not revisited.**
   - Revise now stops exactly the revised attempt's runs, captured when the
     decision is linked. A running sibling branch is never signalled.
   - When a leftover operation cannot be completed (for example, the
     definition is gone), the instance is **held**. Nothing transitions it,
     gate actions on it return 409, and the decision stays `incomplete`
     until a later attempt succeeds. It needs a person.
2. **The approval decision point is a commit point, not a snapshot.** The
   verdict store's lock is the lock every verdict write takes. Under it, the
   automated boundary:
   - reads the current verdicts;
   - validates them;
   - appends the decision;
   - saves the instance link.

   That link save is the moment the approval becomes durable and its basis
   is fixed. Any verdict write is therefore ordered against it:
   - **before**: it is what validation sees. If it is now the current
     verdict, the request names a verdict that is not current, and the
     approval is refused. This holds for a newer lower-scoring or failed
     re-judgment;
   - **after**: the approval is already durable. It is not revoked, and the
     gate decision keeps the basis it was decided on.

   "Current" is the store's order: the newest `at` (the judgment's start
   time), with ties going to the most recent write. A judgment that started
   earlier but was written later is not "newer" by this order, and the
   guarantee is stated only for the store's order. Lock order is instance,
   then verdict store; nothing takes them the other way round. The verdict
   lock is held only for reads, one decision append and one instance save,
   never across a model call.

3. **Authoritative provenance.**
   - An automated approval request names only `{ runId, verdictId }` per
     relevant run.
   - A run named twice, or a run the gate is not about, is refused as
     inconsistent. Every other field on a basis entry is ignored.
   - The persisted basis is rebuilt from the stored verdict: id, `at`,
     score, rubric digest, runtime, requested and reported model, prompt
     version. The step name and bar come from the instance and its own
     definition snapshot.
   - Metadata a stored verdict does not carry is recorded as `null`, and a
     verdict with no id cannot be named at all.

**Tests.** `gateRecovery.test.ts` covers the revise, abort and approve
windows:

- before the link;
- after superseding;
- after stopping processes;
- after the ledger commit;
- restart and reconcile;
- retry without a second revise;
- the straggler stop with an untouched sibling.

`realizationEngine.test.ts` adds the abort interrupted after closing a
realization. `gateDecisionsEngine.test.ts` adds:

- concurrent verdict writes during the approval window, low-scoring and
  failed, ordered after the commit;
- a verdict that lands first, which refuses;
- a judgment after commit, which does not revoke;
- forged metadata ignored;
- duplicate and extraneous entries refused;
- unknown provenance kept `null`.

**Still out of scope, and unchanged:** credential inheritance,
outcome-marker inconsistency, fan-out signals dropped while a sibling is
paused, and the human `needs-input` bypass. They stay tracked in the
appendix.

---

## N. Amendment log (2026-09-29)

| #   | Decision or correction                                                                                                                                                                                                                                                                                                     | Where            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| D1  | Model-driven `autoApprove` on knowledge-committing gates is refused, with no opt-in bypass                                                                                                                                                                                                                                 | §M.1, §L         |
| D2  | TypeSafe integration and new egress stay disabled                                                                                                                                                                                                                                                                          | §G.3, §G.4       |
| D3  | Human labelling is optional; gate actions are behavioural records                                                                                                                                                                                                                                                          | §G.1, §H.3       |
| D4  | Initial assessments cannot grant permission; `grant` removed                                                                                                                                                                                                                                                               | §F.2, §I.3, §J   |
| D5  | Bounded active journal storage with explicit archival and retention, and no Vault dependency                                                                                                                                                                                                                               | §F.4             |
| C1  | Ratings, predicted probabilities, provider confidence statistics and observed outcomes are separated; the Verdict baseline is compared without a probability interpretation                                                                                                                                                | §F.1, §H.3, §H.4 |
| C2  | H1's target is operator behaviour, not the safety of skipping review; reference streams are separate; judgments are hidden during labelling                                                                                                                                                                                | §H.3             |
| C3  | Observed termination is separate from inferred cause; the probe's answer space contains every reference label; probe and residual are versioned apart and never pooled                                                                                                                                                     | §H.2             |
| C4  | H3 is kept as a semantic audit of verifier conclusions that can neither redefine support nor become evidence                                                                                                                                                                                                               | §H.1             |
| C5  | Replay (stored assessments plus a versioned policy, no call) is separate from re-evaluation (a new call); snapshot bodies are retained                                                                                                                                                                                     | §F.3             |
| C6  | The Jev mapping was re-examined: official docs were unreachable (`EGRESS_BLOCKED`), the supplied corrections are recorded as unverified, requested and reported model ids are separate, and there are no synthetic aliases                                                                                                 | §G.3             |
| P1  | Phase 1 resolutions: observations derived read-only; active storage bounded by admission; two run-failure projections; a restart-interrupted run is not `never-ran`; definitions carry digests; H1 not registered                                                                                                          | §O               |
| P2  | H2 slice: opt-in, rate- and budget-bounded shadow collection on the tick, subordinate to existing analysis; a separate collection ledger retains references and deduplicates across archival and restarts; unknown call outcomes are never re-sent; `decision-h2-report` v1 replays it; residual accuracy stays unmeasured | §P               |
| P3  | H1 slice: `gate.operator-action` v1 predicts operator behaviour only; capture precedes any decision and is re-checked before and after the call; references are applied operator decisions retained in an experiment ledger; blinded, settled-only reporting; combined H1 + H2 limits keep one allowance                   | §Q               |

---

## O. Phase 1 design note: observations, storage limits, persistence

_Written before the Phase 1 persistence code, as the two open choices in §L
required. It narrows §F.4 and does not reopen the architecture. Where the
§F sketches contradict what follows, this section governs for Phase 1._

### O.1 Observations are derived, not written

- **Read-only derivation.** No engine hook, event or new write path is
  added. `server/src/decision/observations.ts` derives observations on read
  from records that already hold the meaning:
  - **`operator-action`**, from `gate-decisions.jsonl`. Only records with
    `mechanism: "operator"` qualify. `verdict-auto-approve` and
    `unspecified` records are excluded: an automated approval is not a
    human action, and an unattributed one is not known to be. There is one
    observation per phase reference. The value is the decision
    (`approve | revise | abort`), and the principal is copied as recorded.
  - **`observed-termination`**, from the run record. `timed-out` or
    `stalled` becomes `deadline`. `spawn-failed` becomes `never-ran`. A run
    that exited on its own becomes `ended-normally`.
- **Correction to §H.2.** A run marked `interrupted` by a restart **did
  run**, so it is not `never-ran`. It yields no termination observation;
  the result is `not-derivable` with the reason given. The same holds for
  `killed` (an Argus abort), and for `output-refused`, `rate-limited` and
  `permission-denied`. The run record has no structured field for the last
  three, and Phase 1 adds no plumbing to create one.
- **Provenance.** Every observation names its source store, the source
  record id, and the sha256 of that record's canonical JSON as read. A
  source that later changes is therefore detectable.
- **Streams stay apart.** `review-finding` and `later-outcome` exist in the
  contract, but nothing derives them, because no durable source holds them
  yet. They are never synthesised from operator actions, and a later
  outcome never rewrites an operator action.
- **Failure behaviour.** A source file that is missing reads as "no
  observations". An unreadable source line is skipped and counted, the same
  way `readGateDecisions` treats one. An observation is never invented to
  fill a gap.

### O.2 Storage limits, and why the total is bounded

Defaults, all overridable per journal instance:

| Limit                                                                       | Default |
| --------------------------------------------------------------------------- | ------- |
| segment size (`segmentMaxBytes`)                                            | 4 MiB   |
| segment age (`segmentMaxAgeMs`)                                             | 7 days  |
| one snapshot (`snapshotMaxBytes`)                                           | 256 KiB |
| total active storage (`activeMaxBytes`): active segments + active snapshots | 64 MiB  |

- **The per-segment cap does not bound the total.** The total is bounded by
  **admission**. Every write that adds active bytes is admitted, under the
  journal lock, only if `activeBytes + delta ≤ activeMaxBytes`. Those writes
  are a segment header, an assessment line and a newly published snapshot.
  Otherwise the append is refused with `active-storage-full`, and nothing
  is written.
- **Freeing space.** The only way to free active space is **archival**: an
  explicit, logged step (`archive()`). It first seals the open segment if
  that segment holds a record (`sealOpen`, the default). It then moves the
  sealed segments, and the active snapshots no active segment still
  references, into `archive/`, and it records each move in the manifest.
  Sealing the open segment matters because snapshots can dominate the
  quota: without it, a quota filled by the open segment's own snapshots
  could never be freed.
- **Record size.** An assessment line is at most 16 KiB. The service caps
  every free-text field of an outcome (rationale, reason, failure detail,
  raw excerpt) well below that. A snapshot published before its call is
  admitted only with room left for its record.
- **No silent deletion.** Nothing is deleted at any cap, and archival never
  deletes data.
- **The archive is outside the active bound.** It grows until an operator
  explicitly deletes an archived segment (§O.3).
- **The manifest is outside the active quota.** It holds one line per seal,
  archive or tombstone, at most about 1 KiB per segment ever created,
  or about 0.03 % of the data at the default segment size. It is reported
  separately. Keeping it outside the quota means a full journal can always
  be archived.
- **Refused appends are visible to callers.** In Phase 1 nothing runs
  automatically, so a refusal only affects an explicit caller. It never
  affects a pipeline.

### O.3 Persistence and recovery

The layout, under `<argus>/decisions/`, is separate from
`gate-decisions.jsonl`, from `knowledge.json` and from the Vault:

```
active/seg-00000001.jsonl      segments; seq never reused
snapshots/ab/<sha256>.json     active snapshot bodies
archive/segments/…  archive/snapshots/…
manifest.jsonl                 seal · archive · tombstone
```

- **Snapshot bytes.** The stored snapshot file _is_ the canonical JSON of
  the snapshot content: format, projection `{id, version, digest}`,
  subject, scope and repository when present, refs, `subjectAuthored`,
  redactions, truncations and body. `sha256` and `bytes` are computed over
  exactly those UTF-8 bytes. They are never inside them, so there is no
  self-reference. The canonical form sorts keys and accepts only plain
  objects, dense arrays, strings, booleans, `null` and finite non-negative-zero
  numbers. Anything else (`undefined`, `NaN`, `-0`, a `Date`, a class
  instance, an accessor, a cycle) is **refused**, never silently coerced.
- **Records.** Each record is one line:
  `canonical({kind, body, sha256})`, where `sha256` is over
  `canonical({kind, body})`. Each segment starts with a `segment-open`
  header.
- **Write order**, under one in-process lock per journal root. This is the
  repository's `KeyedMutex`, the same discipline as `gate-decisions.jsonl`,
  so the guarantee assumes one writing process, the Argus server:
  1. The snapshot is published before the provider call ("hash before
     send"): a temp file, `fsync`, rename, then a directory `fsync`.
  2. The provider is called **outside** the lock.
  3. Under the lock, the append re-ensures the snapshot. It re-publishes
     from memory if an explicit deletion removed it meanwhile, and replaces
     a copy whose digest no longer matches. Only then does it write the
     line and `fsync`.

  **Complete writes.** Every journal write goes through `writeAll`. That
  covers record lines, snapshot and archive copies, segment headers and
  manifest lines. `writeAll` loops over short writes and returns only once
  every intended byte is written. Zero progress fails with
  `ShortWriteError`, and a write error propagates. Either way the operation
  fails before its `fsync` and before any acknowledgement, and whatever
  prefix reached the file is left for torn-write recovery. A new segment's
  header is published whole (temp file, rename), so no segment exists with
  a torn header.

  So an acknowledged assessment's snapshot is on disk before the
  acknowledgement. A crash between the steps leaves an **orphan snapshot**:
  counted, reported by `verify()`, and moved by archival. It is never an
  acknowledged record without its input.

- **Torn tails.** A final line with no newline is an unacknowledged write.
  The next append first writes a fence, a NUL and then a newline, followed
  by a `torn-marker` record. The NUL matters: a fragment that happens to be
  a complete record minus its newline can never later parse as an
  acknowledged record. A reader classifies a bad line as follows:
  - followed by a marker: a recovered torn write;
  - last in its file: a torn tail;
  - anywhere else, or with a failing record digest: **interior
    corruption**, reported with segment and line.

  Nothing is truncated or rewritten.

- **Duplicate retries.** An append names its assessment id. If the same id
  is already in an active segment with the same record digest, the append
  is a no-op and returns `duplicate`. With a different digest it is
  refused as a conflict. Detection covers active segments only. The reader
  also reports identical duplicates, and conflicting ones, wherever they
  occur.
- **Concurrent appends** serialise on the lock, in call order.
- **Rotation.** A segment is sealed when the next line would pass
  `segmentMaxBytes`, or when its header is older than `segmentMaxAgeMs`.
  The seal is a manifest line with record count, byte size, file sha256 and
  time range. A crash after a new segment was opened but before the old one
  was sealed is repaired on the next mutation, which seals every unsealed
  segment below the newest. That seal line was the last manifest write, so
  the segment's bytes are as they were. This happens only while the
  manifest has no **interior** damage: a seal lost there could be of any
  age, and nothing is resealed. A segment is sealed once; a second seal
  line is reported as manifest damage and ignored.
- **Seal integrity.** The per-line digests cannot show that a whole line
  was lost, so every sealed segment is judged against its seal (sha256 and
  byte size). One judgment is used everywhere:
  - by readers;
  - by replay;
  - by reference scanning before deletion;
  - by interrupted-deletion recovery;
  - by archival, which will not move a segment it cannot show whole.

  The judgments are `intact`, `open` (the newest active segment, not yet
  sealed), `seal-mismatch` and `missing-seal`. A reader salvages every
  intact record from a damaged segment, and reports the finding with the
  sealed and found record counts. It never presents the segment as whole.

- **Archival**, per sealed segment:
  1. copy it to `archive/` (temp file, `fsync`, rename, directory `fsync`);
  2. verify the copy against the seal sha256;
  3. append the `archive` manifest line;
  4. unlink the active copy.

  Snapshots move the same way, and only once no active segment references
  them. A snapshot's location never matters to a reader, which looks in
  both stores. So a partial move is harmless, and recovery finishes it:
  - an archive copy that verifies lets the active copy go;
  - a copy that does not verify is reported, and both files are kept.

  **Reachability therefore holds across segments.** A snapshot shared by
  an archived and an active assessment stays readable throughout.

- **Explicit deletion** of an archived segment requires an operator
  principal and a reason. Under the lock:
  1. The tombstone goes to the manifest **first**, naming the segment, its
     sha256, record count, time range, and the snapshots to be deleted.
  2. Those snapshots, and only those, are unlinked. A snapshot is deleted
     only if no surviving segment, active or archived, references it.
  3. The segment is unlinked.

  Deletion refuses if a surviving segment has unreadable interior lines, a
  `seal-mismatch` or a `missing-seal`: a lost or unreadable line might
  reference a snapshot. A crash midway is completed by recovery, which
  recomputes references first. Under the same judgment, while any survivor
  is damaged, recovery removes the tombstoned segment and keeps every
  snapshot. Replay reports a tombstoned segment as a **gap**, never as an
  absence.

- **Path safety.** Every path is rebuilt from a validated id:
  `seg-\d{8}` for segments and 64 lowercase hex characters for snapshots. A
  path string from the manifest is never joined. A directory entry that
  matches no pattern, or is a symlink, is ignored and reported.
- **Honest limits.** Deterministic fault injection and fresh readers
  demonstrate **logical recovery**. That covers every interruption point in
  append, rotation, archival and deletion. An injected write seam adds
  short writes, zero progress and write errors. It is not a demonstration of
  power-loss durability: the tests cannot cut power, and `fsync` semantics
  are the filesystem's. Nor does it protect against a same-OS-user process
  editing the files (§M.7). Two writing processes are not excluded.

### O.4 Other resolutions of the §F sketches

- **Two projections, not one.** The probe must not see the observed
  termination, and the residual question may. "`run-failure v1` for both"
  was impossible, so there are two projections: `run-failure` v1 and
  `run-failure.blind` v1. The blind one withholds status, outcome, exit
  code, error string and termination, and drops the recorder's terminal
  event, which is derived from them.
- **Definition digests.** An assessment records the sha256 of the question
  and projection definitions it used, not only their versions. A
  definition edited in code without a version bump therefore reads as a
  mismatch. It is never read as current.
- **Registered questions.** The registered questions are H2 residual and
  H2 probe, each v1, each with its own id and answer space, and with
  `consumers: []`. The registry refuses any consumer in Phase 1. H1 is
  **not** registered: its `gate-review` projection needs the gate drawer's
  review model, and building that belongs to Phase 2.
- **The deterministic provider** is a pure rule evaluator
  (`elicitation: "rule"`). Phase 1 ships it with **no** production rules:
  - observed termination is an observation (§O.1), not an assessment;
  - no rule can infer a residual cause;
  - answering the probe from withheld fields would be circular.

  It reports `supports() = false` for both H2 questions.

- **The Claude CLI adapter** runs through the existing `AnalysisRunner`,
  unchanged:
  - `kind: "decide"` is added to the union, which only affects logs;
  - the runtime is pinned to `claude`, so the identity cannot misname
    another CLI;
  - the model defaults to the runner's default;
  - the adapter runs in an empty, dedicated working directory, so no
    repository `CLAUDE.md` or file is in reach.

  It is recorded as `elicitation: "verbalized"`. `requestedModel` is what
  the runner reports it passed, and `reportedModel` stays `null`.

- **Answer validation** checks:
  - keys exactly equal to the option ids or scale points;
  - finite values in [0, 1];
  - a per-question `sumTolerance` (0.02 for the H2 questions).

  A distribution inside the tolerance is renormalised, and the raw values
  and raw sum are kept on the outcome. Anything else is `failed:
invalid-answer`, with a bounded excerpt of the raw output. The service
  re-validates every provider's answer before appending, mocks included.

- **Replay** writes canonical report bytes. The report excludes physical
  placement (active or archive, open or sealed) and every wall-clock read,
  so successful archival does not change it.
  - **Integrity findings are not dropped with placement.** The report lists
    every finding the reader makes, including seal mismatches, missing
    seals, differing copies and manifest damage.
  - **`totals.history`** is `complete` only when there is no gap and no
    damage finding. Unacknowledged torn writes and identical duplicates do
    not make a history incomplete.

  **Currency** is a separate, live reader, and is never written.

### O.5 What Phase 1 built, and what its tests establish

**Code.**

- `contracts/src/decision.ts` holds the wire types. It is types only.
- `server/src/decision/` holds the rest:
  - canonical JSON;
  - answer validation;
  - the registry and the built-in definitions;
  - redaction and the two run-failure projections;
  - observations;
  - the journal (`storage.ts`, `journal.ts`);
  - currency and replay;
  - the mock, deterministic and Claude CLI providers;
  - the service.
- Outside that directory the only code change is `"decide"` added to
  `AnalysisKind`, which only affects logs.
- **Nothing imports the module.** There is no startup registration, watcher,
  route, engine hook or policy, and the runner's defaults are unchanged.

**Tests** (`server/src/decision/*.test.ts`), all deterministic:

- **Round trip and integrity:** round trip, snapshot bytes equal to their
  digest, damaged snapshots and records reported.
- **Torn and damaged lines:** torn tails fenced by a marker, and interior
  corruption named by segment and line.
- **Seal integrity** (`integrity.test.ts`):
  - a whole line lost from a sole archived segment is reported as
    `seal-mismatch`, in the reader and in replay, and the history is
    `incomplete`;
  - a lost seal under manifest damage is reported, and is not resealed;
  - a second seal is ignored;
  - archival skips a damaged segment;
  - fresh deletion refuses, and interrupted-deletion recovery keeps
    snapshots, while a surviving sealed segment is damaged.
- **Short writes:**
  - `writeAll` over split writes, zero progress, and errors after partial
    progress;
  - every journal write through a seam that splits writes;
  - a record write failing after part (or all but the newline) of its line
    is not acknowledged, and its retry lands exactly once;
  - a stalled snapshot publication calls no provider;
  - a failed header write leaves no segment.
- **Retries and concurrency:** idempotent retries, including a lost
  acknowledgement. Concurrent appends from two journal objects across
  rotations.
- **Interruption at every step boundary:**
  - snapshot publication;
  - the append;
  - rotation;
  - archival, at six points;
  - deletion, at two points;

  each followed by fresh readers and a recovering writer.

- **Storage:** the active bound is measured on disk after every append. A
  refusal writes nothing and spends no call.
- **Snapshots and deletion:** shared-snapshot reachability, explicit
  deletion and its refusals, and path traversal.
- **Replay** is byte-equal across fresh readers, clocks and archival, with
  a mock that records calls and a runner whose spawn throws, and it reports
  gaps and unavailable snapshots.
- **Re-evaluation** after archival uses the original snapshot and question
  version.
- **Currency:** stale, unavailable and current, including a changed phase
  attempt, claim revisions and repository state.
- **The Claude adapter** is tested through the real `AnalysisRunner` with
  an injected spawn: runtime pin, default model, identity, the busy gate,
  budget and disabled refusals, and invalid output.
- **The ledger-isolation regression** runs every operation over real
  stores:
  - every byte outside the journal is unchanged;
  - `evaluateSupport` is unchanged;
  - no module imports the plane;
  - the plane imports only readers.

**Limits.**

- This is logical recovery under injected faults, not power-loss
  durability.
- There is no protection against a same-user process.
- Only one writing process is assumed.
- Duplicate detection at append covers active segments only.
- Seal integrity is ordinary corruption detection against the recorded
  seals, not tamper resistance: a same-user process can rewrite a segment
  and its seal alike.
- Redaction is pattern-based, best effort.
- No paid call was made. The adapter's behaviour against a live CLI is
  unverified beyond the injected envelopes.

---

## P. Phase 2 (H2 slice) design note: shadow collection, references, replay

_Written before the watcher code, as the Phase 2 brief required. It narrows
§H.2, §H.4 and §H.5 for the H2 questions only, and does not reopen §O. H1,
gate-review projections, badges and any enforcement stay out of scope._

### P.1 Authority and enablement

- Every assessment stays `mode: "shadow"`, and both H2 questions keep
  `consumers: []`. Nothing reads an H2 assessment except the report.
- **Collection is off by default.** It runs only when both
  `ARGUS_DECISIONS=on` and `ARGUS_DECISIONS_H2_COLLECT=on` are set, and
  analysis passes are not disabled (`ARGUS_ANALYSIS=off` wins). Any other
  value of `ARGUS_DECISIONS` means off. When off, the watcher returns before
  reading or writing anything, so the provider is never reached.
- An invalid H2 setting disables collection and names the setting. It never
  falls back to a guess.
- **Reading the report never collects.** The report route reads the
  collection ledger and the journal and calls nothing else: no provider, no
  runner, no re-evaluation, and no write (not even a directory).

### P.2 Eligibility

A run is considered once it has finished, its `endedAt` is at or after the
collection's recorded start, and it is between 10 minutes and 24 hours old.
The 10 minutes let late writes (termination, cost backfill) settle. The
start is written once, on the first enabled check, and it never moves, so
enabling collection never drains history.

- **Exclusion common to both questions:** `runtime` other than `claude`. The
  run-failure projections read Claude session transcripts only, and a
  missing timeline would look like evidence.
- **Residual (`run.failure-cause.residual@1`):** the run is unsuccessful
  (`status: "failed"`, or `outcome` `failed` or `blocked`, the Autopsy
  definition without `interrupted`), **and** its observed termination
  (§O.1) is `ended-normally` or `deadline`. A successful run is excluded, so
  no one is asked why it failed. `never-ran` is excluded, because nothing
  ran to explain. A run whose termination is not derivable (interrupted,
  killed, cancelled, skipped) is excluded with the derivation's reason, and
  never guessed. The cause taxonomy is untouched.
- **Probe (`run.termination-probe@1`):** any considered run whose termination
  is derivable. The reference label is `observeTermination`'s value. It is
  validated against the probe's registered answer space. A label outside it
  is a construction error, excluded and counted, and never scored.

### P.3 Sampling

- **Deterministic and label-blind.** A run is selected for a question when
  `u < rate`, where `u` is the first 52 bits of
  `sha256(seed "|" questionId "@" version "|" runId)` divided by 2^52. The
  inputs are the seed, the question and the run id, and never the
  termination or any answer. Probe and residual draw independently.
- **Defaults:** residual rate 0.5, probe rate 0.1, seed `argus-h2`.
- **Census.** Each considered run gets one `census` line per question
  version, whatever the verdict: `selected`, `not-selected` or `excluded`
  with a reason. It records the termination stratum too. A run first seen
  past the 24-hour window is still censused, as `excluded: missed-window`,
  so the population is accounted for. At most 500 census lines are written
  per check.
- The effective definition is recorded as a `config` line, with its digest.
  That covers seed, rates, window, eligibility and exclusion rule ids,
  limits, and the requested provider identity. A changed setting appends a
  new `config` line. Each census and attempt line names the config it ran
  under.

### P.4 Scheduling

- **Placement.** The watcher is the last step of the scheduler's `onTick`,
  after Autopsy, Verdict, Sentinel, the Vault and the fleet poller. So it is
  outside every instance lock.
- **Awaited inside the tick.** A `busy` refusal makes Autopsy and Verdict
  write a permanent `failed` record (`performAutopsy`). A fire-and-forget
  H2 call could collide with the next tick's Autopsy, so the call is
  awaited. Ticks never overlap, and the watcher has its own overlap guard
  as well.
- **At most one provider invocation per check.** This holds even when both
  questions have work: pending items are taken oldest `endedAt` first,
  then by question id and run id.
- **Subordinate to existing analysis.** The runner is wrapped once, in
  `index.ts`, by a pass counter. The wrapper only delegates, so the runner's
  concurrency gate, timeout, output cap, metering and budget stop are the
  same object's. The watcher makes no call on a check if:
  - any non-`decide` pass started since its previous check (including the
    first check after boot);
  - a pass is in flight;
  - the spend hard stop is in force (it then pauses 15 minutes).

  So while Autopsy drains a backlog, one pass a tick, H2 waits.

- **Limits, from the ledger** (so a restart cannot reset them):
  - at most 20 provider invocations per rolling 24 hours;
  - at least 15 minutes between invocations;
  - at most US$1.00 of recorded H2 cost per rolling 24 hours.

  An invocation is any attempt whose call happened or may have happened.
  Cost is known only after a call, so the dollar cap can be passed by one
  call.

- **Backlog.** Only selected items inside the 24-hour window are pending.
  One that leaves the window unattempted gets an `expired` line. The queue
  is therefore at most one day of selections, and nothing old is drained.

### P.5 Attempts, deduplication, retries and unknown outcomes

The collection ledger is separate from the journal:
`<argus>/decision-experiments/h2/collection.jsonl`. It is an append-only
JSONL of the journal's own envelope (`encodeLine`), with the same torn-tail
fence, `fsync` per append, and a `seq` number on every line, so a lost line
is detectable. Its lines are capped at 8 KiB, and the file at 32 MiB. At
the cap, collection stops and says so; nothing is deleted or rotated
automatically.

- **Write order for one invocation:**
  1. an `attempt` line, `fsync`'d. It carries the attempt id, a
     pre-assigned assessment id, the item, the requested identity, the
     stratum and (probe only) the reference;
  2. `service.assess(… id)`;
  3. a `result` line.
- **Item identity** is `(runId, question id, version, provider identity,
sample 0)`. The ledger never passes through journal archival, so archival
  and restarts do not re-open an item. Stricter still, a `(run, question,
version)` that any identity has attempted is never taken up automatically
  by another identity. Changing the model setting does not re-assess old
  items.
- **Result classes:**

  | Class                                             | Provider called | Retried                     |
  | ------------------------------------------------- | --------------- | --------------------------- |
  | `answered`, `abstained`                           | yes             | never                       |
  | `provider-failed`                                 | yes             | never                       |
  | `refused`                                         | no              | bounded                     |
  | `missing-input`                                   | no              | bounded                     |
  | `construction-error`                              | no              | never                       |
  | `unrecorded` (the call spent, the append refused) | yes             | never                       |
  | `unknown-outcome`                                 | unknown         | never, and counted as spent |

  `refused` covers:
  - the service's pre-call refusals;
  - the runner's `disabled`, `busy` and `budget-blocked`;
  - the adapter's `aborted` and `unsafe-cwd`.

  Those runner and adapter refusals still append a `failed` assessment (the
  Phase 1 service always does). The H2 report classes them by code as calls
  not made.

- **Bounded retry.** A `refused` or `missing-input` item may be tried again
  at most 3 times in all, at least 30 minutes apart. After such a result the
  watcher pauses:
  - 15 minutes for `budget-blocked` or `disabled`;
  - 60 minutes when the journal refuses storage;
  - 5 minutes otherwise.

  Nothing that did or may have reached the provider is retried
  automatically.

- **Restart.** An `attempt` with no `result` belongs to an earlier process.
  If the journal holds its pre-assigned assessment, the result is
  reconciled from it (`reconciled: true`). Otherwise the result is
  `unknown-outcome`: the process died after the attempt line, and a paid
  call may or may not have happened. It is never re-sent silently, and it
  counts against the limits. **Exactly-once external execution is not
  claimed.**
- **Damage stops collection.** Interior corruption, a `seq` gap or a
  conflicting record means deduplication can no longer be trusted, so the
  watcher refuses to invoke and reports why. A torn tail is fenced as in
  §O.3 and is benign.

### P.6 Durable references

- The probe's reference is retained in the `attempt` line, a typed
  experimental record. It is never in the snapshot: the probe's snapshot is
  the blind projection, and the provider sees only that. The reference has:
  - `stream: "observed-termination"`;
  - the label;
  - the answer space it was validated against (question id, version and
    digest);
  - the observation's source (`runs`, record id, sha256 of the run record
    as read);
  - `observedAt`;
  - the derivation id;
  - its own sha256.
- The residual attempt records the termination stratum (the eligibility
  observation), with the same provenance. Its `reference` is always `null`,
  because the residual question has no reference stream.
- Replay joins the ledger to the journal only. Run pruning (`RUN_KEEP`
  runs per schedule) and transcript deletion do not change it.
- A reference that is absent, fails its digest, is outside the answer
  space, names another question, or sits on a residual attempt is reported
  as an integrity finding and is not scored. A deleted ledger line shows as
  a `seq` gap. Whether the live run record has since changed is not part of
  replay (it would be a live dependency). The retained reference is what
  was scored.

### P.7 The report (`decision-h2-report` v1)

The report is a pure function of:

- the ledger;
- the journal view;
- snapshot availability;
- the registry.

It emits canonical bytes, like §O.4 replay. It has no wall clock: "pending"
means pending as of the last ledger line. The Phase 1 `decision-journal-report`
v1 is unchanged.

- **Populations.** The population key is the question id, version and
  digest, plus the full recorded provider identity:
  - `provider`;
  - `requestedModel`;
  - `reportedModel`;
  - `adapterVersion`;
  - `elicitation`.

  Probe and residual populations are separate lists and are never pooled.
  Only attempts in the ledger count. Journal assessments no attempt names
  are counted as outside the experiment.

- **Counts per population:**
  - attempts by class;
  - assessed (answered, abstained or provider-failed);
  - reference-bearing;
  - coverage per stratum or reference class;
  - the census (considered, excluded by reason, selected, not selected,
    attempted, expired, abandoned, pending) per class.
- **Cost:** p50 and p95 latency; USD and tokens (total, mean over known,
  unknown count); snapshot bytes (p50, p95, max). The percentiles use the
  nearest-rank method.
- **Probe metrics**, against the named `observed-termination` stream:
  - `top` is the unique argmax. An exact tie is `tie`, which never counts as
    correct.
  - **Answered-only accuracy** is correct / answered, reported with
    **coverage** = answered / assessed-with-reference. **End-to-end
    accuracy** is correct / assessed-with-reference, which counts
    abstentions and provider failures as not correct. Refusals, missing
    input, unrecorded and unknown outcomes are not assessments, and are
    counted beside the table.
  - The confusion matrix has reference rows × (options, `tie`, `abstained`,
    `failed`) columns.
  - Per-class recall (answered-only and end-to-end), macro recall, and the
    majority-class share, so a skewed sample reads as skewed.
  - Cohen's κ over answered items, with `tie` as a category.
  - **Intervals:** Wilson score, 95 % (z = 1.959964). `n = 0` is null,
    never zero.
  - **Brier** is multiclass, in the original sum-over-classes form:
    `mean_i Σ_k (p_ik − y_ik)²` over all K options, over answered items with
    a validated distribution. Its range is [0, 2], and it is not divided by
    K.
  - **Reliability:** top-probability confidence, 10 equal-width bins
    (1.0 in the last bin). A bin shows its accuracy and mean confidence only
    at n ≥ 20; below that it is `unmeasured` with its n. **ECE** is the
    n-weighted |accuracy − confidence| over bins, and only at N ≥ 200.
  - Probability metrics are computed only for distributions that validate
    against the registered question with the recorded digest. Ratings and
    provider statistics are never read as probabilities.
- **Residual:** every accuracy and probability cell is `unmeasured`, with the
  reason (no reference labels exist). The top-answer counts are shown as a
  description, labelled as not accuracy.
- **Baselines.** The `deterministic` provider is `not-applicable`: it has no
  H2 rules (§O.4). Autopsy is named as a separate 11-way taxonomy that is
  not compared, because no mapping is published.
- **Integrity:**
  - ledger findings;
  - journal notices and gaps;
  - attempts whose assessment is missing or does not match;
  - non-shadow records;
  - reference findings;
  - `history: complete | incomplete`.

### P.8 Shutdown

- Unset either switch and restart. The next check returns immediately.
- An invocation in flight when the process stops becomes `unknown-outcome`
  on the next enabled start. It is not retried.
- The ledger and the journal stay readable, and the report still renders.
- Nothing is deleted.

### P.9 What the H2 slice built, and what its tests establish

**Code.** `server/src/decision/h2/`:

| File          | Holds                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| `config.ts`   | enablement and settings                                                     |
| `sampling.ts` | eligibility, the draw, references                                           |
| `ledger.ts`   | the collection ledger                                                       |
| `items.ts`    | the shared reading of it                                                    |
| `watcher.ts`  | the watcher                                                                 |
| `metrics.ts`  | the statistics                                                              |
| `report.ts`   | `decision-h2-report` v1                                                     |
| `activity.ts` | the pass counter                                                            |
| `entry.ts`    | the only module imported from outside the plane, by `index.ts` and `app.ts` |

Outside that directory:

- `service.assess` accepts an optional pre-assigned assessment id;
- `index.ts` wraps the runner and awaits the watcher last in `onTick`;
- `app.ts` serves `GET /api/decisions/h2`;
- the contracts gain the report types, which are types only;
- the web gains a read-only **Experiments** page.

No runner default, no Autopsy or Verdict code, and no Phase 1 report
changed.

**Tests** (`server/src/decision/h2/*.test.ts`). All are deterministic, and
none makes a paid call. The Decision service, journal, ledger, Claude CLI
adapter and `AnalysisRunner` are the real ones; only the spawn is injected.

- **Off.** With either switch off, or `ARGUS_ANALYSIS=off`, or an invalid
  setting:
  - no spawn;
  - no run read;
  - no directory;
  - the report route creates nothing and runs nothing, even with collection
    switched on.
- **Scheduling:**
  - the first check defers;
  - one invocation per check, oldest first;
  - the minimum interval, the daily call cap and the dollar cap each hold;
  - another pass since the last check, or one in flight, defers the call;
  - the spend hard stop pauses without a call;
  - overlapping checks make one call;
  - beside the real Autopsy watcher, Autopsy never meets a busy runner, and
    its records are identical with collection on and off.
- **Population:**
  - census verdicts for every termination class and exclusion;
  - `missed-window`;
  - history not drained;
  - a deterministic, label-blind draw;
  - expiry at 24 hours.
- **Honesty of outcomes:**
  - a runner refusal and missing input are retried at most 3 times, 30
    minutes apart, and never spawn;
  - journal storage refusal pauses an hour;
  - a full ledger writes nothing;
  - a crash after the intent line is an `unknown-outcome` and is never
    re-sent;
  - a crash after the call is reconciled from the journal;
  - restarts, journal archival and a model change never reopen an item;
  - a damaged ledger (a corrupt line or a lost line) halts collection;
  - a torn tail is fenced.
- **Blindness.** The probe prompt carries none of status, exit code, error,
  termination or the reference label. The retained snapshot is
  `run-failure.blind` and holds no label. The ledger holds the reference with
  source digest.
- **References:**
  - a label outside the answer space is excluded and counted, at census and
    at attempt time;
  - replay is identical after runs and transcripts are pruned and the journal
    archived;
  - corrupt, missing, mismatched and non-shadow records are findings, not
    scores.
- **Metrics on hand-worked fixtures:**
  - Wilson, nearest rank, ties, multiclass Brier, κ;
  - the reliability threshold of 20 and the ECE threshold of 200;
  - a 12-item probe population with ties, abstentions, a failure, refusals,
    missing input, an invalid and a corrupt reference, and class imbalance;
  - question versions and model identities kept apart;
  - residual accuracy unmeasured;
  - byte-deterministic replay.
- **State isolation (§H.5).** The same routed, gated fixture pipeline runs
  through the real HTTP routes and engine with collection on (making shadow
  calls) and off. Every file outside the plane's directories is
  byte-identical. That covers the instance, route decisions, gate state and
  decisions, the knowledge ledger, runs and journals, apart from the pipeline
  id, signal token and wall-clock definition stamps the server draws itself.
  The static test allows only `index.ts` and `app.ts` to import the plane,
  and only named entry points.

**Limits.**

- No live CLI or model call was made. Behaviour against a real model,
  including the cost and latency a real call has, is unverified beyond the
  injected envelopes.
- `reportedModel` stays null, because no envelope parser extracts one.
- Exactly-once provider execution is not claimed. The guarantee is "never
  re-sent silently", and an interrupted call counts as spent.
- The dollar cap is checked before a call, so one call can pass it.
- One writing process is assumed, as in §O. Ledger integrity is corruption
  detection, not tamper resistance.
- An on-demand analysis request that arrives while a shadow call is running
  gets `busy`, as it would beside any other pass.
- The collection ledger and the journal grow until an operator acts. Nothing
  archives or deletes automatically, and collection stops at either cap.
- The probe population is skewed wherever runs mostly end normally. The
  report shows prevalence and per-class recall; it cannot make the sample
  representative.

---

## Q. Phase 2 (H1 slice) design note: gate operator-action shadow collection

_Written before the H1 collection code, as the Phase 2 brief required. It
narrows §H.3–§H.5 for `gate.operator-action` only. It does not reopen §O or
§P: the H2 slice keeps its semantics, and the one H2 change (combined
limits, §Q.8) is additive and inert while the H1 ledger holds no
invocation. No permission effect, gate badge, approval change, Jev, new
service, required manual label, seeded-defect corpus or drift schedule is
part of it._

### Q.1 Target and authority

- **Question `gate.operator-action` v1 (binary):** "Will the operator send
  this phase attempt back (revise or abort) rather than approve it as it
  stands?" `p` is the probability of **yes = sent back**.
- It predicts operator behaviour. It says nothing about correctness, and no
  H1 figure can justify skipping review. The report prints that sentence.
- `consumers: []`, `mode: "shadow"`. Nothing reads an H1 record except the
  H1 report.
- H1 is registered in its own registry (`h1Registry()`: the built-ins plus
  H1), so `builtinRegistry()` and the definitions the Phase 1 and H2 reports
  read are unchanged.
- H1 assessments are written to the same Decision Journal. The H2 report's
  `outsideExperiment` counts journal assessments no H2 attempt names, so it
  now counts H1's too; its meaning is unchanged, and nothing else in the H2
  report reads them. The Phase 1 report, which no route serves, would list
  them with `definition: missing` under `builtinRegistry()`.
- **Enablement.** Off by default. It runs only with `ARGUS_DECISIONS=on`
  and `ARGUS_DECISIONS_H1_COLLECT=on`; `ARGUS_ANALYSIS=off` wins. When off,
  the watcher returns before reading or writing anything. An invalid H1
  setting disables H1 and is named; it never falls back to a guess.

### Q.2 Eligibility: a confirmed ordinary gate pause

An item is the phase attempt `(instanceId, phaseId, attempt)` with the
question id and version. It is eligible when, on one fresh read of the
instance (`readInstance`, a private copy):

- the phase is `awaiting-approval` with `pause: "gate"`. A `needs-input`
  pause is a question, not a review, and a pause with no recorded cause
  (written before causes were recorded) is of unknown cause. Both are
  excluded, and the exclusion is recorded;
- the instance has no `pendingGateOperation`;
- the relevant steps (`gateRelevantSteps`: the selected candidate's steps
  on a best-of-N phase) all succeeded and name their runs. These run ids
  are part of the capture;
- `gate-decisions.jsonl` holds **no** record naming this phase attempt,
  applied or not.

The population is split, and never pooled, by whether the instance's own
definition snapshot declares `autoApprove` on the phase:
`manual` and `auto-approve-declared`. The second is a biased subset: people
only see the gates auto-approval did not open.

### Q.3 Timing, and what "as it stands" means

Capture and prediction are separate steps, and the model call is never the
thing that proves an item was eligible.

1. **Capture**, every check, needing no model call and no budget. For a
   newly eligible item the watcher builds the snapshot, computes both
   baselines, then **re-reads** the instance and the gate log. Only if the
   exact attempt is still eligible (same attempt, same relevant runs, no
   decision record for it) is the capture line written. So a capture, and
   the baselines in it, provably precede any decision on that attempt:
   the decision record did not exist when the capture was confirmed.
   Otherwise the gate is recorded as `capture-raced`, and nothing is scored.
2. **Observation.** While an item is unsettled, each check (at most every
   minute per item) re-projects the review and compares its **review-state
   digest** with the capture's. The first difference is written once, as a
   `drift` line. The time of the last observation that saw the item
   eligible and unchanged is kept in memory.
3. **Model call** (sampled items, when the budget allows). Immediately
   before it, the same re-check runs: still eligible, same digest, no
   decision record. Otherwise no call is made, and no call is spent. The
   provider is sent the **captured** snapshot, never a rebuilt one.
4. **Post-check.** After the result line is durable, the watcher re-checks
   again and writes a `post-check` line. The prediction is prospective
   only if that post-check saw the attempt still eligible, with the same
   digest and no decision record. It is a read-after-write ordering, not a
   timestamp comparison. If the operator acted during the call, the
   post-check sees it, and the item is excluded from prospective model
   scoring as `action-during-call`. It is kept and reported. A result
   reconciled after a restart is post-checked at reconciliation.
5. **Settlement**, once an observation finds the attempt no longer
   eligible (§Q.5).

**"As it stands"** is the captured review state. The review-state digest
is sha256 over the canonical JSON of the snapshot body's **material
fields**:

- gate identity, attempt, retries and relevant runs;
- step prompts and final messages;
- the validated result;
- the verification report;
- changed files, diff statistics and the repository state;
- staged-record identities, statuses, outcomes, evidence kinds and warning
  codes;
- the artifact listing.

Two fields are capture-time context, excluded from the digest because they
move without the attempt changing:

- run cost, tokens, duration and model (late backfill);
- Watchtower anomalies (relative to a baseline other runs move).

Ledger-relative claim support is not in the v1 body at all.

A difference in material fields means the operator acted on a different
state than the one predicted about. That item is excluded as
`state-changed`, and no comparison is made. An action whose bracket
(last eligible observation → first ineligible one) is wider than 10
minutes, for example because the server was down, is excluded as
`state-unobserved`: the state before the action was not seen. Nothing
blocks or delays the operator, and no instance lock is taken; the watcher
only reads instance files.

### Q.4 Projection `gate-review` v1

Built from the existing review model (`buildPhaseReview`, the gate
drawer's own read model) and Argus's records, redacted by
`REDACTION_RULES_V1` and capped per field. The whole snapshot is at most
96 KiB.

| Field                                | Content                                                                                                                                                                                                                                    | Caps           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| `gate`                               | pipeline and phase names, attempt, retries, candidate count and the selected candidate                                                                                                                                                     | names 200      |
| `steps[]` (relevant only)            | name, run id, status, the run's `prompt`, its final message (`resultSummary`), and, as context, duration, cost, tokens, model and runtime. A run record that cannot be read is `unavailable`, never empty                                  | 8 steps; 4000  |
| `result`                             | `not-declared`, or the validated result's canonical JSON                                                                                                                                                                                   | 4000           |
| `verification`                       | `not-declared`, `missing` (checks were declared and no report exists), or the report: status and each check's kind, label, status, exit code and one-line detail. Command output is never included                                         | 30 checks; 300 |
| `changes.files` / `changes.diffStat` | `available` from the attempt's worktree against its recorded `baseHead`, or against the phase's recorded baseline; otherwise `unavailable` with the reason. Paths and line counts only, never file content. The diff stat needs a worktree | 100 paths; 300 |
| `repository`                         | the existing `RepositoryStateRef` of that working tree (`repositoryStateFrom`)                                                                                                                                                             | —              |
| `staged`                             | per kind (knowledge deltas, rule verifications, change proposals, acceptance), for relevant runs: counts by outcome, evidence kinds, warning codes and capped messages. A staged record a step names that cannot be read is `unavailable`  | 20 rows; 300   |
| `anomalies`                          | Watchtower anomalies on relevant runs (metric, direction, severity, ratio), with each run's baseline readiness; `unavailable` if unreadable                                                                                                | 16             |
| `artifacts`                          | the artifact listing: path and bytes                                                                                                                                                                                                       | 50; path 300   |

- `subjectAuthored` names the final messages, the result, staged
  summaries and notes, changed paths and artifact paths: text the assessed
  agent wrote or chose.
- `refs.runs` holds the relevant runs, and `refs.verifications` the staged
  record ids. `scope` is the attempt's `knowledgeScope` when it has one.
- **Excluded by construction:** every gate-decision record (earlier
  attempts' included), `gateDecisionIds`, `pendingGateOperation`, anything
  written after the capture, Verdict scores (they are a baseline, kept
  apart) and full file content.
- Git is read with `--no-optional-locks`, so observing never rewrites the
  index. Only an Argus worktree, or a directory with a recorded phase
  baseline, is read.

### Q.5 References

References are derived read-only from `gate-decisions.jsonl` and the
instance, at settlement, and **retained in the H1 ledger**. Replay never
reads either of them again. Candidate records are those naming this phase
id and attempt with `status: "awaiting-approval"`. Their effect comes from
`decisionEffect`, the Phase 0 definition.

| Finding                                               | Settles as                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| exactly one `applied` record, `mechanism: "operator"` | **labeled**: approve → `not-sent-back`; revise, abort → `sent-back` |
| an `applied` `verdict-auto-approve` record            | unlabeled `automated-approval` (never a reference)                  |
| an `applied` `unspecified` record                     | unlabeled `unattributed`                                            |
| more than one `applied` record                        | unlabeled `conflicting-records`                                     |
| an `incomplete` record                                | waits, up to 60 minutes; then unlabeled `effect-incomplete`         |
| only `not-applied` records, or none                   | unlabeled `no-applied-decision` / `no-decision-record`              |
| instance gone (effect `unknown`)                      | unlabeled `instance-gone`                                           |
| still eligible 7 days after capture                   | unlabeled `observation-window-closed`                               |

- A `not-applied` record beside the one `applied` record is noted and does
  not block the label. `operatorActionObservations` alone is never treated
  as proof of application.
- The retained reference holds:
  - the decision value and label;
  - the record id and the sha256 of the record as read;
  - mechanism, channel and the principal, copied as recorded;
  - `recordedAt`;
  - `effect: "applied"`, the derivation id (`applied-operator-gate-decision@1`)
    and its own digest.
- **Principal honesty.** A `session` principal means an authenticated
  account made the request, not that a person did (§M.7). The report
  counts principals by kind and says so.
- **Missing or uncertain actions stay unlabeled**, never negative. Review
  findings and later outcomes remain separate streams. H1 derives neither,
  links no later outcome, and synthesises no correctness label.

### Q.6 Baselines, retained at capture

**Deterministic (`gate-operator-action.rules` v1).** This is a pure
function of the snapshot body, so replay recomputes it and flags any
mismatch. It is reported as a **rule result**, `flag | no-flag |
insufficient-data`, never as a probability. The rules:

| Rule                     | Fires when                                                                           | Not evaluable when                                     |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `later-attempt`          | `attempt > 0`                                                                        | never                                                  |
| `automatic-retry`        | `retries > 0`                                                                        | never                                                  |
| `unverifiable-result`    | a staged rule-verification or acceptance entry is `unverifiable`                     | a named staged record is `unavailable`                 |
| `observation-only-holds` | a `holds` / `satisfied` entry whose evidence is non-empty and entirely `observation` | as above                                               |
| `grounding-warning`      | a warning code in the list below                                                     | as above                                               |
| `cost-anomaly`           | a relevant run has a Watchtower `cost` anomaly, direction `high`                     | anomalies `unavailable`, or a run's baseline not ready |
| `duration-anomaly`       | the same, for `duration`                                                             | as above                                               |

- The grounding-warning codes, all of which say the proposal's grounding or
  references do not hold up:
  - knowledge delta: `business-rule-without-evidence`,
    `revision-without-evidence`, `claim-without-support`,
    `revision-target-unsupported`, `revision-stale`, `source-file-missing`,
    `source-outside-scope`, `source-path-unsafe`, `source-git-head-mismatch`,
    `source-range-invalid`;
  - change proposal: `selected-rule-unclassified`, `preserved-and-revised`,
    `classification-mismatch`, `acceptance-criterion-unknown-ref`,
    `acceptance-criteria-missing`, `implementation-already-violates`,
    `request-claim-unknown`.

  Advisory codes are not in the list.

- Any rule that fires gives `flag` (predicts sent back). Otherwise, any
  rule that cannot be evaluated gives `insufficient-data` (an abstention).
  Otherwise the result is `no-flag` (predicts approve).

**Verdict (`auto-approval-qualification` v1).** This asks whether the
Phase 0 rules would have opened this captured gate. The watcher's pre-check
is extracted, unchanged, into the pure `autoApprovalQualification` in
`gatePolicy.ts`, which the Verdict watcher now calls. It keeps:

- the configuration and staging exclusions;
- rubric binding by digest;
- complete, current, `ready` verdict coverage of every relevant step;
- attempt and run binding;
- candidate selection;
- the minimum-over-steps rule against the bar.

It is evaluated at capture over the current verdicts, and the basis is
retained: verdict ids, scores, bar, rubric digest and provenance. A later
re-judgment never rewrites it. The results are distinct:

- `qualifies`, which would have opened, compared as "approve";
- `below-threshold`, which would have waited, compared as "sent back";
- `not-configured`, `ineligible` and `insufficient-data`, which are
  coverage gaps shown as their own columns, never folded into either side.

The rating is `min` over relevant steps, the aggregate the rule itself
compares to the bar. It is used only for a confusion matrix at the bar,
and for AUROC with positive class = sent back and the expectation that a
lower rating means sent back. AUROC is the Mann–Whitney estimate with ties
counted ½ and a Hanley–McNeil 95 % interval. No Brier score, calibration
or score/10 is ever computed. No hypothetical bar is applied to
unconfigured gates.

### Q.7 Sampling and models

- **Census.** Every eligible gate is captured, and baselines are computed
  for all of them. A model call is drawn label-blind:
  `u = first 52 bits of sha256(seed | question@version | instance | phase | attempt) / 2^52`,
  called if `u < rate`. The default rate is 1, and the seed is `argus-h1`.
- **Models.** `ARGUS_DECISIONS_H1_MODELS` is a comma list of at most three
  distinct entries. Each entry is `haiku`, `sonnet`, `opus`, or an id
  matching `claude-[a-z0-9.-]+`. Unset means one arm on the runner's
  default. With several arms, each item is assigned **one** arm by a second
  independent draw, so a Haiku/Sonnet comparison is between items and
  never doubles calls.
- **Identity.** `requestedModel` is what the runner reports it passed. An
  alias is resolved by the CLI at call time, and the concrete model is
  not observed, so `reportedModel` stays `null`. Populations are split by
  the full identity.
- A `(item, question, version)` attempted under any identity is never taken
  up automatically by another.

### Q.8 Scheduling and the combined H1 + H2 budget

- **Placement.** H1 runs on the tick, immediately before H2, both last and
  awaited, outside every instance lock.
- **One provider invocation per tick across both experiments.** If H1
  invoked (or may have invoked) the provider this tick, H2 records its
  census and expiries but makes no call. H1 goes first because its items
  disappear when the operator acts, while H2's wait up to a day.
- **Subordinate to existing analysis**, the same rule as §P.4. H1 makes no
  call on a check after any non-`decide` pass started since its previous
  check (including the first check after boot), while a pass is in flight,
  or under the spend hard stop.
- **Combined limits.** Each experiment checks its own limits against the
  invocations and recorded cost of **both** ledgers combined, over a rolling
  24 hours:
  - calls ≤ its `maxCallsPer24h` (H1 default 20, the same as H2);
  - USD ≤ its `maxUsdPer24h` (default US$1.00);
  - at least `minCallIntervalMs` (default 15 minutes) since the last
    invocation of either.

  With the defaults, both enabled together make at most 20 calls and spend
  about US$1 a day, the same allowance as H2 alone, not double. The ceiling
  is the larger of the two configured caps, plus at most one call past a
  dollar cap, because cost is known only afterwards.

- **Fairness.** H1's own invocations are also capped at
  `maxOwnCallsPer24h` (default 10, half). So H2 keeps at least half the
  allowance whenever it has work, and takes all of it when H1 has none.
- **H2 is unchanged when the H1 ledger is empty.** H2's combined count reads
  the H1 ledger whether or not H1 is enabled now, because the allowance is
  about spend.
- **Honest bias.** The shared 15-minute interval and the priority rule mean
  only gates that stay pending long enough are called. The report shows
  sampled-but-not-called counts by reason (acted before a call slot, state
  changed, budget).

### Q.9 Ledger, snapshots, retries and unknown outcomes

- The ledger is `<argus>/decision-experiments/h1/collection.jsonl`. Its
  mechanics are the H2 ledger's, reused from `storage.ts`:
  - `encodeLine` envelopes;
  - a `seq` on every line;
  - the torn-tail fence;
  - `writeAll` and an `fsync` per append;
  - 16 KiB lines and a 32 MiB file.

  At the cap it stops honestly, and nothing is deleted or rotated.

- Captured snapshots are published before their capture line (temp file,
  `fsync`, rename, directory `fsync`) to
  `<argus>/decision-experiments/h1/snapshots/`. The store is capped at
  64 MiB by admission, and is read back and verified against its sha256
  before a call. Source pruning (instances at 50 per pipeline, runs,
  transcripts, verdicts, the gate log) cannot touch replay, which reads only
  this store, the ledger and the journal.
- **Deduplication** is by the exact item identity. The ledger never passes
  through journal archival, so neither archival nor a restart reopens an
  item.
- **Result classes and retries** are the H2 classes and rules (§P.5):
  - `answered`, `abstained`, `provider-failed` and `unrecorded` are spent
    and never retried;
  - `refused` and `missing-input` (the retained snapshot is unreadable or
    corrupt) are retried at most 3 times, 30 minutes apart;
  - an attempt left open by an earlier process is reconciled from the
    journal by its pre-assigned assessment id, or becomes `unknown-outcome`,
    counted as spent and never re-sent.

  A pre-call eligibility failure is not an attempt, and spends nothing.

- **A damaged ledger** (interior corruption, a `seq` gap, a duplicate or
  orphan) halts H1 calls and captures, and says why.

### Q.10 Blinding

- The gate drawer, the review route, instance files and every existing
  route are unchanged. No H1 answer, rule result, score or ordering reaches
  them.
- `GET /api/decisions/h1` and the Experiments page report **only settled
  items**: items whose attempt is no longer eligible, or that expired.
  Items not yet settled, including those whose call has happened, appear
  only as aggregate pending counts per population. They contribute to no
  confusion cell, attempt-class count, rule result or usage figure.
  `observation-window-closed` items contribute only a count.
- The watcher's live status never names a result class. A check that made
  a call says only that an attempt was recorded.
- There is no labelling flow.

### Q.11 The report (`decision-h1-report` v1)

The report is a pure function of:

- the H1 ledger;
- the snapshot store;
- the journal;
- `h1Registry()`.

It uses no wall clock, so "pending" means as of the last ledger line, and
it writes canonical bytes. The Phase 1 and H2 reports are unchanged.

- **Populations** are keyed by question id, version and digest, projection
  digest, provider identity (for model rows), and `manual` versus
  `auto-approve-declared`. They are never pooled.
- **The census** shows:
  - gates seen, and exclusions by reason (`needs-input`, `unknown-pause`,
    `pending-operation`, `prior-decision-record`, `capture-raced`,
    `snapshot-too-large`, `store-full`);
  - captured, sampled and not sampled;
  - pending, settled, and unlabeled by reason;
  - temporal and state exclusions;
  - principals by kind.
- **Scoring set.** An item is scored if it is settled and labeled with
  state held: no drift, and a bracket of 10 minutes or less. Model rows
  also require an assessment and a prospective post-check. Every item
  outside the set is counted in its own column, with its denominator
  impact visible.
- **The binary rule for models.** `p > 0.5` predicts sent back and
  `p < 0.5` predicts approve. `p = 0.5` is `tie`, which is never
  agreement and never a false close or escalation.
- **Rows.** Each row shows reference × prediction confusion counts with
  the prediction columns `sent-back`, `approve`, `tie`, `abstained` and
  `failed` (or the rule-result or Verdict columns). It also shows:
  - agreement with operator behaviour, answered-only and end-to-end, with
    coverage;
  - **false close** = predicted approve / sent back;
  - **false escalation** = predicted sent back / approved;
  - both over answered items, ties in the denominator.
- **Intervals.** Every proportion carries a Wilson 95 % interval. `n = 0`
  is null.
- **Probability metrics, model rows only**, over validated binary
  probabilities:
  - Brier `mean (p − y)²`, y = 1 for sent back, range [0, 1];
  - reliability in 10 equal-width bins of `p`, each showing mean `p`
    against the observed sent-back rate, measured only at n ≥ 20;
  - ECE only at N ≥ 200;
  - κ over answered items.
- **Usage:**
  - p50 and p95 latency, nearest rank;
  - USD and tokens;
  - snapshot bytes;
  - spend totals over all attempts, counts only.
- **Integrity:**
  - ledger notices;
  - snapshot files missing or failing their digest;
  - baseline recomputation mismatches;
  - journal assessments missing or not matching their attempt;
  - reference digests;
  - `history: complete | incomplete`.

### Q.12 Shutdown and limits

- Unset either switch and restart: H1 stops at its next check. An in-flight
  call becomes `unknown-outcome` on the next enabled start. The ledger,
  snapshots and report remain, and nothing is deleted.
- **Limits:**
  - no paid call was made in development; injected spawns do not prove
    live contention, cost or latency;
  - operator-action agreement is not correctness;
  - the called population is biased towards gates that stay pending;
  - a session principal is not a person;
  - one writing process is assumed, and integrity is corruption detection,
    not tamper resistance;
  - observations are periodic, so a state that changed and changed back
    between two observations is not seen;
  - the bracket bound assumes the scheduler tick is well under 10 minutes; a
    slower tick makes every action `state-unobserved`, which is honest and
    leaves nothing scored;
  - a snapshot published just before a capture line that could not be
    written (ledger full, crash) stays in the store unreferenced. It is
    counted in the store's usage and never scored.

### Q.13 What the H1 slice built, and what its tests establish

**Code.** `server/src/decision/h1/`:

| File             | Holds                                                 |
| ---------------- | ----------------------------------------------------- |
| `definitions.ts` | the question, the projection, `h1Registry()`          |
| `projection.ts`  | `gate-review` v1 shaping and the review-state digest  |
| `collect.ts`     | the readers, including read-only git                  |
| `gate.ts`        | eligibility and reference settlement                  |
| `baselines.ts`   | the deterministic rules and the Verdict qualification |
| `ledger.ts`      | the H1 ledger                                         |
| `snapshots.ts`   | the snapshot store                                    |
| `config.ts`      | enablement and settings                               |
| `watcher.ts`     | capture, observation, settlement, the call            |
| `metrics.ts`     | the binary statistics                                 |
| `report.ts`      | `decision-h1-report` v1                               |
| `entry.ts`       | the collection and the report reader                  |

Outside it:

- `decision/experiments.ts` runs H1 and H2 together, and is what `index.ts`
  imports;
- `service.assessSnapshot` calls on a captured snapshot;
- H2's watcher takes optional `otherSpend` and `slotTaken`, which are inert
  while the H1 ledger holds no invocation;
- `gatePolicy.autoApprovalQualification` is the Verdict watcher's pre-check,
  extracted unchanged;
- `harness/verification.ts` gains an opt-in `readOnly` git mode and
  `diffNumstat`, with the defaults unchanged;
- `app.ts` serves `GET /api/decisions/h1`;
- the contracts gain the H1 types (types only);
- the Experiments page gains a read-only H1 section.

**Tests** (`server/src/decision/h1/*.test.ts`). All are deterministic and
none makes a paid call. The ledger, snapshot store, journal, service, Claude
CLI adapter and `AnalysisRunner` are real; the spawn is injected.

- **Off:** either switch off, `ARGUS_ANALYSIS=off`, or an invalid setting
  means no read, no write and no spawn. Reading the report creates nothing
  and calls nothing.
- **Eligibility:** exact attempt and relevant runs; the selected candidate
  only; `needs-input` and unknown pauses excluded; an existing decision
  record, a pending operation and a capture race all excluded.
- **Timing:** action before capture, before any call slot, during the call
  (post-check excludes it), after the prediction (scored), and a revision
  captured as a new item.
- **"As it stands":** a changed final message is drift, caught by
  observation or by the pre-call re-check; cost backfill is not.
- **References:** applied operator approve, revise and abort; `incomplete`
  waited for, then unlabeled on timeout; an orphaned record beside an
  applied one; automated, unattributed, conflicting and missing records are
  never labels.
- **Durability:**
  - an interrupted call is an `unknown-outcome`, never re-sent;
  - an interrupted result is reconciled and post-checked;
  - restarts and archival never reopen an item;
  - bounded retries;
  - a corrupt retained snapshot is missing input;
  - a damaged ledger halts, and a torn tail is fenced;
  - both caps stop honestly.
- **Scheduling:**
  - existing analysis goes first;
  - the spend stop pauses;
  - H1's share and the combined calls, interval and dollars hold;
  - with H1 and H2 together, at most one invocation per tick, H1 first;
  - H2's trace is identical while the H1 ledger holds no invocation.
- **Arms:** one arm per item and one call per item, with populations split
  by requested model.
- **Report:**
  - hand-worked agreement, false close and escalation with ties,
    abstentions and failures, κ, Brier, reliability at n = 20, ECE at
    N = 200, and AUROC with ties and its interval;
  - byte-identical replay after the instance, runs and gate log are pruned
    and the journal archived;
  - findings for a corrupt reference, a mismatched baseline, a missing
    snapshot and a missing assessment.
- **Blinding and isolation (§H.5):** through the real HTTP routes and
  engine, every file outside the plane's directories is byte-identical with
  collection on and off, and so is the gate drawer's review route. The
  report for a pending gate shows a count and no prediction.
- **Real sources:** the real review model and gate log end to end. A real
  git worktree gives changed files, line counts and repository state
  without reading content or rewriting the index.

**Limits** are those of §Q.12. Simulated spawns and no-op spend fixtures do
not show live contention, cost or latency.
---

## Appendix: defects found incidentally (not Decision Plane work)

Listed so they get their own issues. None of them is fixed by Phase 0 unless
marked. Details are in B.3.

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
- Found during Phase 0:
  - **Fan-out signals are dropped while a sibling is paused.** `onSignal`
    ignores every signal unless the instance is `running`
    (`pipelineEngine.ts`, "paused/terminal → idempotent ignore"). A branch
    that completes while another branch waits at a gate is left `running`
    until some other path heals it.
  - **`ARGUS_USER` / `ARGUS_PASSWORD` are not stripped from agent child
    environments** (§M.7).
  - **A pre-existing test fails on the base commit.** `changeEngine.test.ts`,
    "the proposal is staged per run, beside the delta and never inside the
    ledger", expects `proposal.json` in the change-proposal sidecar
    directory.
  - _Fixed in Phase 0:_ a torn final line in the gate-decision log would have
    swallowed the next record (§M.2).
