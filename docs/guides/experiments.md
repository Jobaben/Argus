# Decision experiments: H2 failures and H1 gate actions

[Documentation](../README.md) · [Feature guides](../guides/README.md)

Read shadow-experiment evidence and understand the optional collection controls.

> **Development boundary:** the latest [Decision Ledger status matrix](../argus/decision-ledger-development/implementation-status-matrix.md) describes additional advisory/invocation foundations verified offline. It does not enable a production reader, policy or enforcement consumer. Historical study pipelines were [archived](../../experiments/pipeline-cleanup-20261010/README.md). These facts are distinct from the existing opt-in H1/H2 collection switches below.

## Before you start

These features are off by default. Reading reports is separate from enabling collection, which invokes providers. Use an explicitly bounded experiment with a working supported model.

## Try it

1. Open **More → Experiments** to inspect retained H2 and H1 evidence. Empty results mean there may be no collected eligible records.
2. Read which population, version and reference each result uses before comparing scores.
3. For historical local feeder/closeout studies, read [development status](../development/README.md) first: their pipelines were archived.
4. If authoring a new controlled collection, review the switches and bounds below together with [configuration](../reference/configuration.md). Keep collection off during basic onboarding.

**Expected result:** You can read retained evidence without treating it as calibrated policy or enabling provider calls accidentally.

## On this page

- [Decision experiments (H2 shadow collection)](#decision-experiments-h2-shadow-collection)
- [Decision experiments (H1 gate operator action)](#decision-experiments-h1-gate-operator-action)

## Decision experiments (H2 shadow collection)

An **experiment**, off by default, that asks a model two questions about
finished runs and measures the answers against what Argus itself recorded.
Nothing reads the answers: they are `mode: "shadow"` with no consumers. No
route, gate, retry, approval, ledger record, prompt, Autopsy or Verdict output
changes because of them. The design is RFC 2026-09-29 §P.

**The two questions are kept apart.**

- **Probe:** `run.termination-probe` v1 asks "from this trace alone, how did
  this run end?"
  - It sees the _blind_ projection. Status, exit code, error and termination
    are withheld.
  - Its reference label is the termination Argus observed, so its accuracy
    is measurable.
- **Residual:** `run.failure-cause.residual` v1 asks why an unsuccessful run
  did not accomplish its task.
  - It is asked only of runs that ended on their own or hit a deadline.
  - No reference labels exist for it, so **its accuracy is shown as
    unmeasured**.

Probe accuracy is never residual accuracy.

### Turning it on

Nothing collects until both switches are set, and `ARGUS_ANALYSIS=off` wins
over them:

```sh
ARGUS_DECISIONS=on ARGUS_DECISIONS_H2_COLLECT=on argus
```

Every value below has a conservative default. An invalid value turns
collection off and names itself on the Experiments page; it is never replaced
by a guess.

| Variable                                  | Default        | Meaning                                                   |
| ----------------------------------------- | -------------- | --------------------------------------------------------- |
| `ARGUS_DECISIONS_H2_MODEL`                | runner default | Explicit model for the Claude CLI adapter (one per item). |
| `ARGUS_DECISIONS_H2_RESIDUAL_RATE`        | `0.5`          | Share of eligible runs sampled for the residual question. |
| `ARGUS_DECISIONS_H2_PROBE_RATE`           | `0.1`          | Share of eligible runs sampled for the probe.             |
| `ARGUS_DECISIONS_H2_MAX_CALLS_PER_DAY`    | `20` (0–96)    | Provider invocations per rolling 24 hours.                |
| `ARGUS_DECISIONS_H2_MIN_INTERVAL_MINUTES` | `15`           | Minimum gap between invocations.                          |
| `ARGUS_DECISIONS_H2_MAX_USD_PER_DAY`      | `1`            | Recorded cost per rolling 24 hours, including H1 calls.   |
| `ARGUS_DECISIONS_H2_SEED`                 | `argus-h2`     | Seed of the deterministic sampling draw.                  |

The runner default model is `haiku` for Claude, or `ARGUS_ANALYSIS_MODEL`.
The adapter always runs the `claude` CLI.

### What it does, and what bounds it

- **Where it runs.** It runs on the scheduler tick, after every other watcher,
  and the tick waits for it. It never runs under an instance lock, and never
  while another analysis pass is in flight.
- **Existing work first.** It waits a whole tick after any Autopsy, Verdict,
  Sentinel or on-demand pass, so it never makes those see a busy runner.
- **Per tick:** at most one provider invocation, across H2 and H1 (§33)
  together. The spend hard stop pauses it for 15 minutes.
- **Shared allowance.** When H1 has made calls in the last 24 hours, H2's
  daily call cap, dollar cap and minimum interval count both experiments'
  calls, so enabling both never doubles the allowance.
- **Which runs.** A run counts if it ended at or after collection was first
  switched on, and is between 10 minutes and 24 hours old. History is never
  drained.
  - A selected item that is not reached within 24 hours **expires**.
  - A run seen too late is counted as `missed-window`.
- **Sampling** hashes the seed, the question and the run id, and nothing
  about how the run ended. Every considered run, sampled or not, gets a
  census line with its exclusion reason, if any. That is how the report
  explains its population.
- **Exclusions:**
  - non-Claude runtimes;
  - runs whose termination is not derivable (interrupted, killed, cancelled,
    skipped);
  - for the residual question, successful runs and runs that never ran.
- **Retries.** A refusal that made no call (budget, busy, disabled, storage)
  or missing input is retried at most 3 times, 30 minutes apart. Nothing
  that did, or may have, reached the provider is ever retried automatically.
- **Restarts.** An invocation interrupted by a restart is recorded as an
  **unknown outcome**. It still counts against the limits, and it is not
  re-sent. Exactly-once execution is not claimed.
- **Records.**
  - The collection ledger, `~/.claude/argus/decision-experiments/h2/collection.jsonl`,
    is append-only and capped at 32 MiB. Collection stops at the cap.
  - The assessments and their input snapshots are in the Decision Journal,
    `~/.claude/argus/decisions/`.

  Neither is ever pruned automatically.

H1 assessments share the Decision Journal. The H2 report's
`outsideExperiment` count therefore includes them; it is not a count of H2
assessments alone. Spend limits use recorded costs from completed calls; they
do not guarantee that an in-flight call cannot take spending over the cap.

### Reading the report

**More → Experiments** (`GET /api/decisions/h2`) is a replay of those
records. Opening it never starts collection, calls a model or writes
anything. It shows, for each question version and exact provider identity
(requested model, reported model, adapter version):

- the census by termination class;
- attempts by outcome;
- cost, latency, tokens and snapshot size;
- integrity findings.

For the probe it also shows:

- answered-only accuracy _with coverage_, and end-to-end accuracy (where
  abstentions and failures count as wrong);
- per-class recall and the majority-class share, so a skewed sample reads as
  skewed;
- Cohen's κ, a confusion matrix, and a multiclass Brier score (0–2);
- reliability buckets (only at n ≥ 20) and ECE (only at n ≥ 200).

Every interval is a Wilson 95 % interval.

**How to read it.** A probe score says how well a model recovers a fact Argus
already knows. It does not show that the model knows why a run failed, and
nothing on the page authorises an approval. The deterministic baseline reads
**not applicable**, because no H2 rule exists. Autopsy is **not compared**:
it uses a different taxonomy.

### Turning it off

Unset either switch and restart. Nothing is deleted, and the report still
renders from what was retained. An invocation in flight at shutdown is
reported as an unknown outcome on the next enabled start, and is not
re-sent.

## Decision experiments (H1 gate operator action)

A second experiment, off by default, that predicts **what the operator will
do** at an ordinary pipeline gate: will they send this phase attempt back
(revise or abort) rather than approve it as it stands? It predicts behaviour,
not correctness. **An agreement figure can never justify skipping review**:
an approved attempt may still be wrong, and a revised one may have been fine.
The design is RFC 2026-09-29 §Q.

Nothing reads the predictions. No gate badge, score, ordering or approval
changes, and the gate drawer shows exactly what it showed before.

### Turning it on

```sh
ARGUS_DECISIONS=on ARGUS_DECISIONS_H1_COLLECT=on argus
```

`ARGUS_ANALYSIS=off` wins. An invalid value turns H1 off and names itself.

| Variable                                   | Default        | Meaning                                                                                 |
| ------------------------------------------ | -------------- | --------------------------------------------------------------------------------------- |
| `ARGUS_DECISIONS_H1_RATE`                  | `1`            | Share of captured gates sampled for a model call.                                       |
| `ARGUS_DECISIONS_H1_MODELS`                | runner default | Up to three of `haiku`, `sonnet`, `opus` or a `claude-…` id; each gate is assigned one. |
| `ARGUS_DECISIONS_H1_MAX_CALLS_PER_DAY`     | `20` (0–96)    | H1 and H2 calls combined, per rolling 24 hours.                                         |
| `ARGUS_DECISIONS_H1_MAX_OWN_CALLS_PER_DAY` | `10`           | H1's own share of that.                                                                 |
| `ARGUS_DECISIONS_H1_MIN_INTERVAL_MINUTES`  | `15`           | Minimum gap since the last call of either experiment.                                   |
| `ARGUS_DECISIONS_H1_MAX_USD_PER_DAY`       | `1`            | Recorded H1 and H2 cost combined, per rolling 24 hours.                                 |
| `ARGUS_DECISIONS_H1_SEED`                  | `argus-h1`     | Seed of the deterministic sampling draw.                                                |

Several models compare **between** gates: each gate gets one model, never a
second call. The requested model is recorded; the model the CLI actually
used is not reported, and stays blank rather than guessed.

### What it does

- **Which gates.** Only a phase paused at an ordinary `gate`, on its exact
  attempt, with no decision on record yet. Questions an agent asked
  (`needs-input`) and pauses of unknown cause are excluded. A best-of-N
  phase is judged on the selected candidate. Gates whose phase declares
  `autoApprove` are reported as their own population.
- **Capture first, no call needed.** Within a tick of the pause, Argus
  captures a bounded, redacted snapshot of the review:
  - step prompts and final messages;
  - the result and the checks;
  - changed files and line counts, never file content;
  - staged-record outcomes and warnings;
  - Watchtower anomalies and the attempt number.

  It also records two baselines: a rule result, and whether auto-approval
  would have opened the gate. It then re-reads the gate to prove nobody had
  acted yet.

- **Then, budget allowing, one call** on that captured snapshot. It is
  re-checked just before the call and again just after. If you act while
  the call is running, that prediction is kept but not scored.
- **"As it stands."** If the review changes while the gate waits (a
  different final message, result, check or file), the item is not compared
  with your action.
- **Your action.** Only an applied operator decision on that exact attempt
  counts: approve means "not sent back", and revise or abort means "sent
  back". Automated approvals, unattributed or unfinished decisions, and
  pruned instances are never labels, and never negatives. A signed-in
  session is an account, not proof that a person clicked.
- **Records** live in `~/.claude/argus/decision-experiments/h1/`: an
  append-only ledger (32 MiB cap) and the captured snapshots (64 MiB cap).
  Collection stops at either cap, and nothing is pruned automatically.

### Reading the report

The Experiments page has an H1 section (`GET /api/decisions/h1`).

- **Only settled gates** contribute to report results; only valid applied
  operator decisions supply comparison labels. A gate still waiting on you
  appears only in a count, so the page cannot show you a prediction for a
  pending gate.
- **For each population and model**, it shows:
  - the confusion matrix, coverage, and agreement with your action;
  - **false close** (predicted approve, you sent it back) and **false
    escalation** (predicted sent back, you approved);
  - κ;
  - for model probabilities only: Brier, reliability buckets (n ≥ 20) and
    ECE (n ≥ 200).

  Proportion intervals use Wilson 95 % intervals. AUROC uses a
  Hanley–McNeil 95 % interval.

- **The baselines** sit beside the models:
  - The rule baseline is a rule result, not a probability.
  - The Verdict baseline is compared at the decision level, and its score
    is a rating: its only rank figure is an AUROC.
  - Auto-approval qualification is versioned. Historical v1 captures keep
    their original rules; v2 adds trajectory requirements. The report separates
    qualification versions rather than pooling different rules.

### Turning it off

Unset either switch and restart. Nothing is deleted, and the report still
renders.
