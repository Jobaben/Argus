# Baseline shadow evidence: independent forensic review

Reviewed 2026-10-08 at approximately 22:14 UTC (2026-10-09 00:14 Stockholm). Scope: every native assessment retained at audit time. Read-only access to canonical stores; this review writes only its two report artifacts. Independent agent review is not blinded human labeling.

## Reconciliation and integrity

The exported H2 baseline was captured at `2026-10-08T22:09:15.2610081Z`, with report ledger sequence 246 and report time `22:06:53.022Z`. The raw ledger reached sequence 248 at `22:10:53.081Z`: two additional census entries for run `18e9540f-b65c-4abb-8905-9db82ea1fd66`, with no additional assessment. Assessment counts therefore reconcile exactly: **61 total, 54 probe and 7 residual**, all answered; 61 attempts and 61 results. Current raw census has 124 entries versus 122 in the export. The extra census marks a successful run residual-excluded and probe-selected.

All **61 assessment snapshot hashes and byte lengths match**. SHA256 envelopes match for all 62 journal lines and all 248 H2 ledger lines. Collection sequence is continuous; files end with a newline. Each assessment has one matching attempt and result; run/question identities agree. All 54 retained probe reference digests match and name the matching run. No discrepancy was found in these checks. This establishes retained-byte integrity, not causal correctness, tamper resistance or exercised crash recovery.

Total native assessment cost is **$2.0524343**, excluding workload generation. All use `claude-cli`, requested model `haiku`, reported model null, adapter version 1, verbalized elicitation. No concrete model version was independently observed.

Every assessment rationale was read. All seven residual inputs, the sole probe error and seven additional non-certain probe inputs were reviewed in depth. The JSON companion retains every rationale, per-snapshot hash/size checks, all critical exact retained inputs and findings. Remaining normal probe inputs were loaded for byte/structure verification.

## Findings with evidence identities

**1. An unsupported subject explanation contaminated both assessments of the first blocked run.** Run `070e00ab-ada5-4207-a1d7-840d798e537d` did execute: its source record has start/end timestamps, duration 31.603 seconds and exit code 0. The retained trace contains denied PowerShell/Bash commands, file reads and final text. The selector did not successfully execute in this trace. Nothing in the retained input demonstrates that `ARGUS_RUN_ID` was actually absent.

- Residual `DA-8fIB3PDygkPlz2rX` assigns environment probability 0.95 and calls the agent's missing-variable claim correct. That specific causal assertion is unsupported. Permission denials are visibly grounded; environment absence remains unknown.
- Probe `DA--1yYkNCfYdpD8G7F` predicts never-ran at 0.80 against the retained ended-normally reference. Its rationale confuses failure to execute the requested selector with failure to start the agent process. It also treats later permission errors as secondary to an unverified prerequisite claim.

Consequence: preserve deterministic termination and enforce the observation/inference distinction in advisory presentation. Do not promote rationale text into a factual source. Projection improvements must link actual observed prerequisites/tool results where a consumer needs them.

**2. The missing-price cause boundary is inconsistent across materially equivalent cases.** All three retained inputs describe 16 tickets and `ticketPriceSek: null`, and honest blocked reporting. The descriptions of the missing input are grounded in the retained subject summaries; the category boundary remains unresolved.

| Assessment | Run | Top cause | Probability |
| --- | --- | --- | --- |
| `DA-tMKUdcYBEUmiXb5m` | `b4e89b8c-28c9-4b93-8675-3c4f0d17bbb4` | task-infeasible | 0.91 |
| `DA-2VhnmeSHH_ryeA3O` | `06e74e63-c384-4c8e-984f-879c5db0843e` | task-infeasible | 0.75 |
| `DA-TqH3GrqdHMfaNuSH` | `a87df709-2b13-4058-9d26-e28e14ca432c` | missing-context | 0.80 |

Consequence: define whether a task solvable by supplying a missing fact is missing-context rather than task-infeasible; obtain independent labels. This is evidence of taxonomy ambiguity, not a measured error rate.

**3. Contradictory-constraint explanations are internally grounded.** `DA-jesrKhhWH6oapAxt` (run `6a2cc8cc-85c9-40ac-822d-1fd372526377`, 0.93), `DA-azTiccdJYq7S4tnB` (`dcaeb69f-7530-432f-bb26-cb1b3e0b6e8d`, 0.90) and `DA-9SVB1mvBBCZqTu3g` (`03f73aba-37b7-4c28-b335-e2d1dbec32fe`, 0.95) select task-infeasible. Their retained summaries require confirmed=12 and confirmed<=10 simultaneously. The mathematical explanation follows from those stated constraints. The projection's scenario facts mainly arrive through agent-authored thinking/final text; this is useful explanation consistency, not independently labeled cause accuracy.

**4. Headline probe accuracy demonstrates normal-completion recognition only.** All 54 probe references are ended-normally. The model scores **53/54 (98.15%, Wilson 95% interval 90.23–99.67%)**; always predicting ended-normally scores **54/54** on this same population. Reported kappa is zero. There is no measured discrimination across true deadline/startup-failure cases. Residual cause accuracy remains unmeasured; model agreement never becomes a human reference.

The seven additional non-certain probes select ended-normally with probabilities 0.93–0.995. Their inputs contain successful selector invocation, final output and no errored projected events; they cover missing-price, contradictory-rules, revenue, waitlist and capacity. None introduces a new observed termination class. Their identities and inputs are in the JSON report.

**5. Storage fidelity exceeds input evidentiary fidelity.** The snapshots accurately retain bounded inputs, but projected tool events commonly retain the command and error status rather than selector stdout or independent scenario facts. Event details cap at 200 code points; result summaries cap at 1,000. Some relevant narrative is truncated. The first blocked run also shows status=succeeded, outcome=failed and an agent blocked marker, reinforcing the need to distinguish process termination, requested business result and reporting protocol.

Consequence: artifact/tool-result grounding, explicit truncation display and precise outcome semantics are dependencies for future consumers. A matching hash proves which input was evaluated, not that it contained sufficient independent evidence.

## Development decision supported by this baseline

The evidence supports continuing the existing journal/replay/provenance architecture and planning advisory display. It does **not** support replacing Autopsy on measured accuracy, assigning cause-driven retries, or skipping human gates. Prioritize DL-04 taxonomy/reference work, DL-02 evidence/currency views and DL-08 artifact/acceptance identity binding. DL-03 supported frozen-input reevaluation is needed for rigorous stability and injection checks. Keep DL-06/07 enforcing utilization conditional on prospective, class-diverse and independently reviewed evidence.

Primary material: exported `baseline/decisions-h2.json`; raw `~/.claude/argus/decision-experiments/h2/collection.jsonl`; raw `~/.claude/argus/decisions/active/seg-00000001.jsonl` and referenced snapshots; source run record for `070e00ab-ada5-4207-a1d7-840d798e537d`. Audit scope is frozen at sequence 248; later collection belongs to a separately timestamped update.
