# Argus Pipeline — Feedback Request

- **Created:** 2026-08-16
- **Last updated:** 2026-08-16
- **Owner (requester):** _(unassigned)_
- **Approver:** _(unassigned)_

## Purpose

This document collects the requirements feedback needed before any further work
is planned on the **Argus pipeline** feature — the multi-phase, human-gated
agent flows described in [USER-GUIDE.md § 8 Pipelines](USER-GUIDE.md#8-pipelines):
ordered phases, steps inside each phase, `needs` dependencies, gated phases,
triggers and overlap policy, and per-pipeline / per-phase / per-step runtime,
model and effort overrides.

It is a durable request, not a chat transcript: it lives in the repository, is
answered in place by editing this file, and its answers become the input to
triage. Nothing is implemented, planned or estimated on the basis of this
document until it reaches the **Approved** status below.

## How to answer

1. Edit this file in place, in the repository, and commit it yourself.
2. Write your answer under the `**Answer:**` line of each question, replacing the
   `_(unanswered)_` placeholder. Keep the answer inside that question's section.
3. Do **not** reword, renumber, reorder or delete the questions or their
   headings — they are stable anchors that later revisions rely on.
4. Do **not** edit or delete anyone else's answer. To disagree, add your own
   paragraph below theirs and sign it, for example `— Alex, 2026-08-17`.
5. If a question does not apply, write `N/A` and one sentence explaining why.
   Leaving it blank is not the same as answering it.
6. When every question is answered, work through the Ready-for-triage checklist
   and update **Feedback status** and **Last updated**.

## Feedback status

**Current status: `Awaiting answers`**

| Status             | Meaning                                                                    | Who sets it                                   |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------- |
| `Awaiting answers` | The request is published; one or more questions are still unanswered.      | The requester, when publishing this document. |
| `Ready for triage` | All eight questions are answered and every checklist item below is ticked. | The answerer, once the checklist passes.      |
| `Approved`         | Triage has accepted the answers as a sufficient basis for planning work.   | The named approver, after triage.             |

Change the status by editing the **Current status** line above, and record the
date on the **Last updated** line at the top of the file.

## Ready-for-triage checklist

Tick every box before moving the status to `Ready for triage`.

- [ ] All eight questions below have a real answer (or an explicit `N/A` with a reason).
- [ ] The desired outcome in Q1 is stated as an outcome, not as an implementation.
- [ ] The acceptance criteria in Q2 are ranked, and the must-have set is identified.
- [ ] Users and workflows in Q3 name concrete roles and concrete tasks.
- [ ] Q4 addresses safety, privacy and backwards compatibility explicitly — none left silent.
- [ ] At least one example, reference or counter-example is given in Q5.
- [ ] Non-goals in Q6 are explicit, so scope can be bounded.
- [ ] Testing and rollout expectations in Q7 state how success will be observed.
- [ ] Known risks, dependencies and time constraints in Q8 are listed with owners where known.
- [ ] Owner and approver are named at the top of this file.
- [ ] **Last updated** reflects the date of the final edit.

## Questions

### 1. Outcome — what should change, and why

What outcome do you want from the Argus pipeline feature that you do not get
today, and why does it matter? Describe the end state and the motivation, not a
solution. If something is broken or missing today, say what happens now and what
should happen instead.

**Answer:**

_(unanswered)_

### 2. Acceptance criteria, ranked

List the criteria that would let you say the work is done, ranked from most to
least important. Mark which are must-have and which are nice-to-have. Where a
criterion is measurable (a latency, a count, a rate, a cost), give the number.

**Answer:**

_(unanswered)_

### 3. Users and workflows

Who uses this, and what are they doing when they touch it? Name the roles (for
example: pipeline author, run approver, on-call reviewer) and walk through the
concrete workflows each one performs — including how often, and what they do
immediately before and after.

**Answer:**

_(unanswered)_

### 4. Required and prohibited behavior

What must the feature always do, and what must it never do? Cover explicitly:

- **Safety** — destructive or irreversible actions, gating and approval rules,
  what an agent run may and may not touch, stop/abort guarantees.
- **Privacy** — prompts, transcripts, working directories, credentials and any
  data that must not be logged, displayed, exported or sent anywhere.
- **Compatibility** — existing pipelines, stored run records, the HTTP/WebSocket
  contracts, and the supported agent runtimes that must keep working unchanged.

**Answer:**

_(unanswered)_

### 5. Examples and references

Give concrete examples: a real pipeline you would author, a run you would expect
to see, a screen or an API response as it should look. Point to prior art —
products, internal tools, documents, tickets, or existing parts of Argus that
get it right. Counter-examples ("not like X, because…") are equally useful.

**Answer:**

_(unanswered)_

### 6. Boundaries and non-goals

What is explicitly out of scope? Name the adjacent things that must **not** be
changed as part of this work, the problems this feature is not trying to solve,
and any deliberate simplifications you are willing to accept.

**Answer:**

_(unanswered)_

### 7. Testing and rollout

How should this be verified before it ships, and how should it reach users?
Include the tests or checks you expect to exist, the environments and data used
to validate them, whether the change is gated behind a flag or staged rollout,
what would trigger a rollback, and what you want to observe once it is live.

**Answer:**

_(unanswered)_

### 8. Risks, dependencies and time constraints

What could go wrong, what does this depend on, and by when is it needed? List
known technical and organisational risks, upstream or downstream dependencies
(teams, services, agent runtimes, other work in flight), and any deadline or
event that constrains the timing. Name owners where you know them.

**Answer:**

_(unanswered)_

---

## Revision log

Add one line per substantive edit, newest last.

| Date       | Who       | What changed                                                   |
| ---------- | --------- | -------------------------------------------------------------- |
| 2026-08-16 | Requester | Initial feedback request published; status `Awaiting answers`. |
