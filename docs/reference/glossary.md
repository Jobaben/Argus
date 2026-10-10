# Argus glossary

[Documentation](../README.md) · [Feature guides](../guides/README.md) · [Reference](README.md)

## Execution and evidence

| Term                        | Meaning                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Runtime                     | The CLI Argus invokes: Claude Code, Codex, OpenCode or Qwen Code.                                                  |
| Model                       | The model selected within that runtime. Installing a CLI does not prove that a model is supported by your account. |
| Run                         | One invocation of an agent CLI, with an identity, activity and eventual outcome.                                   |
| Session                     | A conversation/transcript produced by a CLI; it is not the pipeline instance.                                      |
| Schedule                    | A saved prompt, runtime and directory with a trigger.                                                              |
| Trigger                     | What starts scheduled work: a timer, webhook or predecessor pipeline completion.                                   |
| Pipeline definition         | The authored phases, steps, dependencies and execution settings.                                                   |
| Instance                    | One execution with a snapshot of its pipeline definition. Editing the definition affects later instances.          |
| Phase                       | A unit of pipeline work containing steps, optional checks and a gate.                                              |
| Step                        | A prompt/invocation within a phase.                                                                                |
| Attempt                     | A particular try at a phase; retry and human revise create new attempts.                                           |
| Candidate                   | One isolated competing draft in a best-of-N step. Selection uses the configured verification/selection policy.     |
| Gate                        | A pause for a decision about a completed phase attempt.                                                            |
| Approve / revise / abort    | Continue with accepted work, send an attempt back, or terminate the instance.                                      |
| Outcome marker              | The agent's explicit completion report, such as `ARGUS_OUTCOME: succeeded`. It is not independent verification.    |
| Check / verification report | Deterministic evidence about declared requirements. Incomplete input may be `not-evaluated`, which is not a pass.  |
| Artifact                    | A named output published by one phase for other phases to consume.                                                 |
| Workspace                   | The directory in which a run executes; optionally a dedicated git worktree.                                        |
| Journal / transition log    | Observational or diagnostic execution history. The saved instance is the transition recovery authority.            |
| Claim / revision            | A Knowledge Ledger assertion and one exact version of it. Old references are not silently retargeted.              |
| Support                     | Whether a claim's evidence and justifications support it. This is separate from code conformance.                  |
| Conformance                 | Whether code at an exact repository state satisfies an exact rule revision.                                        |
| Currency / stale            | Whether retained evidence still applies to the identities/state being considered.                                  |
| Shadow assessment           | A model prediction collected for comparison; it does not enact a policy or approve a gate.                         |
| Unknown cost                | Missing or unusable monetary information. It is not a zero-dollar call.                                            |

## Feature names

| Name                               | Plain-language purpose                                            | Location                            |
| ---------------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| Briefing                           | Catch-up summary and attention queue                              | Briefing                            |
| Chronicle                          | Timeline across runs, jobs and sessions                           | Chronicle                           |
| Flight Recorder                    | Detailed run activity and result                                  | Run detail                          |
| Monitors                           | Detect missing, late or failing scheduled work                    | Health                              |
| Watchtower                         | Detect runs outside learned historical envelopes                  | Health                              |
| Autopsy                            | Model-assisted explanation of a failed run                        | Run detail                          |
| Verdict                            | Model assessment of output and optional trajectory                | Run detail / trends                 |
| Sentinel                           | Track incidents, acknowledgements and diagnostic proposals        | More → Sentinel                     |
| Weave                              | Pipeline graph, branching, dependencies and retries               | Pipelines / Command Center          |
| Spend Ledger                       | Spending attribution, forecasts and policy ladder                 | Budget                              |
| Vault                              | Rebuildable historical SQLite cache, not authoritative state      | Stats / Search / Chronicle          |
| Omnibar                            | Natural-language request with a concrete preview                  | Command palette                     |
| Constellation                      | Paired-machine summaries                                          | More → Fleet                        |
| Knowledge Ledger                   | Semantic claims, evidence and provenance                          | More → Knowledge                    |
| Decision Journal / Decision Ledger | Retained model assessments, identities and evaluation foundations | Experiments / development reference |

See the [feature map](../guides/README.md#feature-map) for navigation and the
[development status guide](../development/README.md) for optional and unreleased
work.
