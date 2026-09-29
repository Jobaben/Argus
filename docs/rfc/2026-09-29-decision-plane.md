# RFC: A provider-neutral Decision Plane for Argus

_Status: **amended 2026-09-29; Phase 0 implemented, later phases not
started.** The original text was an architecture investigation. §M records
what Phase 0 changed in the code; §N lists the decisions and corrections this
amendment applies. Nothing after Phase 0 (Decision Journal, providers, shadow
watchers, evaluation UI, Jev) is implemented or authorised by this document._

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
**None of this is implemented; Phase 0 (§M) deliberately stops short of it.**

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

Still open:

- Whether `DecisionObservation`s (operator actions, later outcomes) should be
  written by the engine as events happen (Phase 1), or derived by the report
  from the gate decision log and the ledger.
- The concrete size and age limits for an active journal segment.

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
- **Automated decisions are bound to their basis.** The record copies the
  exact verdicts used: id, run, timestamp, score, bar, runtime, requested
  and reported model, prompt version and rubric digest. Pruning the verdict
  store later cannot erase the explanation of an approval.
- **Write-ahead, and idempotent in effect.** The order is always:
  1. validate;
  2. append the record and `fsync` it;
  3. apply the transition, naming the record in
     `PipelineInstance.gateDecisionIds` in the **same save**, before any
     knowledge commit is attempted.

  Consequences:
  - A record that cannot be written refuses the decision with a 500, and the
    instance file stays byte-identical.
  - Concurrent duplicates serialise on the instance lock. One applies; the
    other fails validation and records nothing.
  - A crash between steps 2 and 3 leaves a record the instance does not
    name. It reads `not-applied`, and nothing replays it; the operator's
    retry is a new record, which applies.
  - A crash after the pending-commit save leaves the decision named on the
    instance whose commit reconcile re-applies.
  - A torn final line is skipped on read, and the next append starts on a
    fresh line (a defect the tests caught, fixed).

- **Effect is derived, never trusted.** `applied` means the instance names
  the record. `not-applied` means the instance exists and does not.
  `unknown` means the instance has been pruned.
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

## N. Amendment log (2026-09-29)

| #   | Decision or correction                                                                                                                                                                                                     | Where            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| D1  | Model-driven `autoApprove` on knowledge-committing gates is refused, with no opt-in bypass                                                                                                                                 | §M.1, §L         |
| D2  | TypeSafe integration and new egress stay disabled                                                                                                                                                                          | §G.3, §G.4       |
| D3  | Human labelling is optional; gate actions are behavioural records                                                                                                                                                          | §G.1, §H.3       |
| D4  | Initial assessments cannot grant permission; `grant` removed                                                                                                                                                               | §F.2, §I.3, §J   |
| D5  | Bounded active journal storage with explicit archival and retention, and no Vault dependency                                                                                                                               | §F.4             |
| C1  | Ratings, predicted probabilities, provider confidence statistics and observed outcomes are separated; the Verdict baseline is compared without a probability interpretation                                                | §F.1, §H.3, §H.4 |
| C2  | H1's target is operator behaviour, not the safety of skipping review; reference streams are separate; judgments are hidden during labelling                                                                                | §H.3             |
| C3  | Observed termination is separate from inferred cause; the probe's answer space contains every reference label; probe and residual are versioned apart and never pooled                                                     | §H.2             |
| C4  | H3 is kept as a semantic audit of verifier conclusions that can neither redefine support nor become evidence                                                                                                               | §H.1             |
| C5  | Replay (stored assessments plus a versioned policy, no call) is separate from re-evaluation (a new call); snapshot bodies are retained                                                                                     | §F.3             |
| C6  | The Jev mapping was re-examined: official docs were unreachable (`EGRESS_BLOCKED`), the supplied corrections are recorded as unverified, requested and reported model ids are separate, and there are no synthetic aliases | §G.3             |

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
