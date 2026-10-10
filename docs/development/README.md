# Development status and contributor guide

[Documentation](../README.md) · [Catalog](catalog.md) · [Agent reading guide](../AGENT-GUIDE.md)

This page separates product documentation from research, plans and retained
development evidence. Status statements summarize records inspected on
**2026-10-10**; they do not identify the build running on any particular machine.

## Areas of work

The repository has no single authoritative active-track count. The following
grouping is a navigation aid, not a declaration of five currently running projects.

| Area                             | Current reading                                                                                                                | What the evidence establishes                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Core orchestration and harness   | [Pipelines](../guides/pipelines.md), [HARNESS](../HARNESS.md), [changelog](../../CHANGELOG.md)                                 | Source-documented scheduling, runtime adapters, gates, checks, dependencies, recovery and optional trajectory features.                         |
| Knowledge workflows              | [Knowledge guide](../guides/knowledge.md), [Knowledge Ledger](../KNOWLEDGE-LEDGER.md)                                          | Protocols through semantic discovery, verification, change intent and realization; the Knowledge page is read-only.                             |
| Decision Plane / Decision Ledger | [Experiments](../guides/experiments.md), [latest matrix](../argus/decision-ledger-development/implementation-status-matrix.md) | Existing opt-in H1/H2 shadow mechanisms; additional advisory/invocation foundations verified offline with production prerequisites outstanding. |
| Experience and design            | [Motion system](../MOTION-SYSTEM.md), [design sources](../../design/README.md)                                                 | Documented UI/motion architecture and historical design waves.                                                                                  |
| Engineering and operations       | [Operations](../reference/operations.md), [releasing](../RELEASING.md), [scorecard](../SCORECARD.md)                           | Runtime/deployment controls, quality rubric and release procedure; check the actual checkout before making validation claims.                   |

## Decision Ledger: the important status boundary

Read the [closeout report](../argus/decision-ledger-development/report.md) and
[implementation matrix](../argus/decision-ledger-development/implementation-status-matrix.md)
together. The session stopped at its cutoff, left reviewed changes for IDE review
and paused its heartbeat. Its records establish offline behavior under their
stated tests; they do not establish live service readiness.

- Evidence foundations, run reader, optional advisory JSON seam, guarded
  invocation foundations and frozen V2 input preparation have offline evidence.
- Production reader configuration, exact account/model capability, real fencing,
  common atomic accounting, reviewed input consumption and operational drills
  still have explicit prerequisites.
- Genuine reference/adjudication evidence, policy application, enforcement and
  artifact-sensitive applicability remain blocked or deferred.
- The report records baseline server-suite failures. Do not describe the global
  suite as passing by quoting the focused checks.

The [Decision Plane RFC](../rfc/2026-09-29-decision-plane.md) explains the design
and its implementation amendments. Existing H1/H2 collection is different from
releasing these new consumers. H1 predicts operator behavior, not correctness;
H2 residual cause accuracy remains dependent on genuine references.

## Experiments and historical records

The shadow feeder and controlled closeout cases are historical studies.
[Pipeline cleanup](../../experiments/pipeline-cleanup-20261010/README.md) records
archiving 20 reviewed definitions and preserving other state on 2026-10-10.
It does not remove the product's Scheduler or Pipeline functionality.

Use the [catalog](catalog.md) to find:

- the feeder handoff and retained H2 report;
- the experiment closeout, evidence audit and consumer backlog;
- Decision Ledger development plans, prerequisites, runbook and validation;
- dated harness research and UI design specifications/plans.

Historical reports may reference isolated worktrees and state at capture time.
Their hashes and validation outcomes remain historical evidence, not a current
workspace or deployment inventory.

## Working on Argus

From the repository root, install dependencies with `npm ci`, then:

```sh
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run dev` exposes the web UI on port 5757 and API on 7777 by default.
`npm run build` builds web and server; `npm start` serves the built app on one
port. `npm run check` combines typecheck, lint and tests. Use focused tests for
the affected behavior before broader checks; report failures with their actual
scope and evidence rather than hiding them behind a successful build.

| Concern                                 | Primary source                                                          |
| --------------------------------------- | ----------------------------------------------------------------------- |
| HTTP/WebSocket types                    | [contracts workspace](../../contracts/README.md)                        |
| Server routes and application assembly  | [server/src/app.ts](../../server/src/app.ts)                            |
| Runtime-specific CLI behavior           | [server/src/runtimes](../../server/src/runtimes/)                       |
| Pipeline execution                      | [HARNESS](../HARNESS.md), [Architecture](../ARCHITECTURE.md)            |
| React routes, live resources and motion | [web README](../../web/README.md), [Motion system](../MOTION-SYSTEM.md) |
| Local state formats                     | [Data model](../DATA-MODEL.md)                                          |

Follow the repository/user instructions for source control and review. A release
checklist documents a release operation; it is not authorization to commit, push
or publish changes. See [documentation maintenance](documentation.md) for docs-only work.
