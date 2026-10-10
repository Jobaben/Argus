# Reading Argus documentation as an AI agent

[Documentation](README.md) · [Document catalog](development/catalog.md)

This is a task-to-document map. Repository and user instructions still govern
your work; this document explains where the product's contracts and evidence are.

## Read only the context your task needs

| Task                                 | First source                                       | Exact behavior or schema                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install or start Argus               | [Getting started](getting-started/README.md)       | [Launcher](../bin/argus.mjs), [package scripts](../package.json)                                                                                          |
| Demonstrate a first run              | [First-run tutorial](getting-started/first-run.md) | [Scheduling guide](guides/scheduling.md)                                                                                                                  |
| Explain or operate a feature         | [Feature map](guides/README.md#feature-map)        | The linked feature guide, then [API](API.md) if a request is needed                                                                                       |
| Inspect running work                 | [Terminal guide](guides/terminal.md)               | `node bin/argus.mjs tail --for 0 --json` against the running server                                                                                       |
| Configure runtimes or local models   | [Runtime reference](reference/runtimes.md)         | [Runtime adapters](../server/src/runtimes/), [configuration](reference/configuration.md)                                                                  |
| Author a pipeline                    | [Pipeline guide](guides/pipelines.md)              | [Harness](HARNESS.md), [API](API.md#pipelines-v03), [contracts](../contracts/src/)                                                                        |
| Author a semantic workflow           | [Knowledge guide](guides/knowledge.md)             | [Knowledge protocols](KNOWLEDGE-LEDGER.md), [harness recipes](HARNESS.md#14-business-rule-discovery-phases)                                               |
| Diagnose setup/authentication        | [Operations](reference/operations.md)              | [Setup checks](../server/src/setup/prereqs.ts), [auth](../server/src/auth.ts), [users](../server/src/userStore.ts)                                        |
| Change internals                     | [Architecture](ARCHITECTURE.md)                    | [Developer workflow](development/README.md#working-on-argus), responsible source and tests                                                                |
| Assess Decision Ledger readiness     | [Development status](development/README.md)        | [Latest closeout report](argus/decision-ledger-development/report.md), [status matrix](argus/decision-ledger-development/implementation-status-matrix.md) |
| Find a design or previous experiment | [Catalog](development/catalog.md)                  | Dated original artifact, with its scope and validation limits                                                                                             |

## Resolve sources by the kind of claim

1. **Startup requirements and supported controls:** use the current checkout's
   package engines, launcher, configuration parser, routes and contracts.
2. **What is running:** inspect the process/build and `/api/health`; do not infer
   deployment from a staged diff, an old report or a source tree.
3. **How to use a feature:** prefer getting-started pages and topic guides. Use
   the API/harness references for exact payloads and boundary conditions.
4. **What was verified:** use the specific report and retained evidence for that
   exact slice. Offline mock checks and production readiness are separate claims.
5. **Why a design exists:** use the RFC, research and historical plans. A planned
   phase or a frozen experiment artifact is not proof of current implementation.

For conflicting claims, identify the dates, identities and evidence before
choosing the applicable source. In the Decision Plane RFC, later implementation
amendments describe later phases; historical text retains its original scope.
The roadmap is historical context, not a current release checklist.

## Keep the domains separate

- A **process exit**, **task outcome**, **verification**, **gate decision** and
  **model assessment** describe different facts.
- The spend Ledger, Knowledge Ledger and Decision Journal are separate stores
  with different authority. Model assessments cannot establish knowledge support.
- A run, session, phase attempt, candidate and instance have different identities.
  Bind exact identities when making requests or interpreting retained evidence.
- A read can be free of provider calls; enabling collection or requesting an
  assessment may invoke a runtime and incur spend. Read the endpoint's semantics.
- Unknown cost, absent evidence and `not-evaluated` checks never establish zero
  spend, correctness or successful verification.
- Knowledge approvals remain human decisions. Optional shadow predictions do
  not alter gates, policy or canonical knowledge.

## Documentation maintenance

When a task changes an actual behavior, update its task guide and exact reference
together. Keep historical evidence intact and add a current pointer rather than
rewriting a prior run's result. Follow the [maintenance checklist](development/documentation.md)
for feature coverage, links, anchors and validation.
