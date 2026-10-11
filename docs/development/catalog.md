# Complete Argus document catalog

[Documentation](../README.md) · [Development status](README.md) · [Agent reading guide](../AGENT-GUIDE.md)

This catalog lists product documentation and retained research/design/evidence documents found in the checkout on **2026-10-10**. Start with the task guides for current usage. Historical specifications, experiment reports and validation records describe their own captured scope; they are not proof of deployment.

Markdown and HTML versions are listed separately when both exist. Runtime data, JSON evidence inventories, raw diagnostic text and screenshots are linked from their owning documents rather than counted as standalone prose documentation. Generated app pages and dependencies are excluded.

## Entry points and compatibility

- [Argus](../../README.md)
- [Reading Argus documentation as an AI agent](../AGENT-GUIDE.md)
- [Argus documentation](../README.md)
- [Argus user guide](../USER-GUIDE.md)

## Getting started

- [Install and start Argus](../getting-started/README.md)
- [Your first run](../getting-started/first-run.md)

## Task guides

- [Feature guides](../guides/README.md)
- [Accounts and multiple machines](../guides/administration.md)
- [Budgets, spending and long-term history](../guides/budget-and-history.md)
- [Decision experiments: H2 failures and H1 gate actions](../guides/experiments.md)
- [Health, failures, quality and incidents](../guides/health-and-quality.md)
- [Knowledge: rules, evidence and change workflows](../guides/knowledge.md)
- [Monitor runs and review recent work](../guides/monitoring.md)
- [Navigation and natural-language actions](../guides/navigation.md)
- [Pipelines, human gates and advanced execution](../guides/pipelines.md)
- [One-off runs and recurring schedules](../guides/scheduling.md)
- [Sessions, search, projects and inventory](../guides/sessions-and-inventory.md)
- [Monitor and review gates from a terminal](../guides/terminal.md)

## Operational and technical reference

- [@argus/contracts](../../contracts/README.md)
- [Argus — HTTP & WebSocket API](../API.md)
- [Argus — Architecture](../ARCHITECTURE.md)
- [Argus — Data Model Reference](../DATA-MODEL.md)
- [Argus as a harness](../HARNESS.md)
- [The Knowledge Ledger — semantic provenance for Argus](../KNOWLEDGE-LEDGER.md)
- [The Motion System](../MOTION-SYSTEM.md)
- [Releasing Argus](../RELEASING.md)
- [Argus State-of-the-Art Scorecard](../SCORECARD.md)
- [Reference](../reference/README.md)
- [Configuration and data sources](../reference/configuration.md)
- [Argus glossary](../reference/glossary.md)
- [Removed views and API-only features](../reference/legacy-features.md)
- [Operations and troubleshooting](../reference/operations.md)
- [Agent runtimes](../reference/runtimes.md)
- [Argus web workspace](../../web/README.md)

## Development navigation and release history

- [Changelog](../../CHANGELOG.md)
- [Argus — Roadmap](../ROADMAP.md)
- [Development status and contributor guide](README.md)
- [Complete Argus document catalog](catalog.md)
- [Maintaining the documentation](documentation.md)

## Research and design analysis

- [What the best harnesses do, and where Argus falls short](../HARNESS-RESEARCH.md)
- [Motion & Feel Uplift — Analysis](../MOTION-UPLIFT-ANALYSIS.md)
- [Argus Pipeline — Feedback Request](../argus-pipeline-feedback.md)
- [Agent Harnesses on Non-SWE-bench Benchmarks: An Evidence Review (2026)](../research/2026-09-agentic-benchmarks.md)
- [Argus — Harness Capability Inventory](../research/2026-09-argus-inventory.md)
- [What Makes an AI Agent Harness Effective: Literature Review (2026)](../research/2026-09-harness-literature.md)
- [Orchestration / Supervision Layers for Coding Agents — State of Play (Sept 2026)](../research/2026-09-orchestration-layers.md)
- [SWE-bench-family leaderboards: what externally-graded harnesses actually do](../research/2026-09-swebench-harnesses.md)

## Decision Plane RFC

- [RFC: A provider-neutral Decision Plane for Argus](../rfc/2026-09-29-decision-plane.md)

## Historical design specifications and plans

- [Scheduled Runs Monitoring — Implementation Plan](../superpowers/plans/2026-06-22-scheduled-runs-monitoring.md)
- [Scheduler Re-frame — Navbar Redesign Implementation Plan](../superpowers/plans/2026-06-24-scheduler-reframe-navbar.md)
- [Argus Design System Implementation Plan](../superpowers/plans/2026-06-26-argus-design-system.md)
- [Windows Pipeline Console Host Implementation Plan](../superpowers/plans/2026-08-10-windows-pipeline-console-host.md)
- [Scheduled Runs, Monitored by Argus — Design](../superpowers/specs/2026-06-22-scheduled-runs-monitoring-design.md)
- [Re-frame Argus around the Scheduler — navbar redesign](../superpowers/specs/2026-06-23-scheduler-reframe-navbar-design.md)
- [Argus Design System — Design Spec](../superpowers/specs/2026-06-26-argus-design-system-design.md)
- [Windows Pipeline Console Host Design](../superpowers/specs/2026-08-10-windows-pipeline-console-host-design.md)
- [Outcome-Based Pipeline Routing Design](../superpowers/specs/2026-08-13-outcome-routing-design.md)

## Decision Ledger development and validation records

- [Acceptance input and advisory identity prerequisites](../argus/decision-ledger-development/acceptance-input-prerequisites.md)
- [Decision: bounded advisory foundations before consumer enforcement](../argus/decision-ledger-development/adr.md)
- [Bounded consumer acceptance protocol](../argus/decision-ledger-development/bounded-acceptance-protocol.md)
- [Final cutoff checklist](../argus/decision-ledger-development/cutoff-checklist.md)
- [Actual dispatch-boundary admission repair](../argus/decision-ledger-development/dispatch-boundary-plan.md)
- [Exact V2 offline input preparation plan](../argus/decision-ledger-development/evaluation-input-plan.md)
- [Decision Ledger foundations implementation plan](../argus/decision-ledger-development/implementation-plan.md)
- [Implementation status matrix](../argus/decision-ledger-development/implementation-status-matrix.md)
- [Next-slice feasibility: retained evaluation and policy preparation](../argus/decision-ledger-development/next-slice-feasibility.md)
- [DL06 policy preparation developer guide](../argus/decision-ledger-development/policy-preparation.md)
- [Pre-call accounting diagnosis](../argus/decision-ledger-development/precall-accounting-diagnosis.md)
- [Explicit execution provenance plan](../argus/decision-ledger-development/precall-accounting-plan.md)
- [Decision Ledger development progress](../argus/decision-ledger-development/progress-history.md)
- [Decision Ledger development report](../argus/decision-ledger-development/report.md)
- [Shared reservation dispatch contract prerequisite](../argus/decision-ledger-development/reservation-dispatch-prerequisite.md)
- [Retained-snapshot evaluation coordinator foundation](../argus/decision-ledger-development/retained-evaluation-plan.md)
- [Disable, drift and rollback readiness](../argus/decision-ledger-development/runbook.md)
- [Validation evidence inventory](../argus/decision-ledger-development/validation/README.md)
- [Independent actual dispatch-boundary review](../argus/decision-ledger-development/validation/dispatch-boundary-independent-review.md)
- [Final process and accounting source review](../argus/decision-ledger-development/validation/final-process-accounting-review.md)
- [Integrated invocation review — fresh dispatch diagnosis](../argus/decision-ledger-development/validation/integrated-invocation-review.md)

## Shadow feeder and experiment closeout records

- [Verified shadow-feeder handoff](../argus/shadow-feeder/continuation.md)
- [Argus · H2 Shadow Evidence](../argus/shadow-feeder/report.html) — HTML
- [Decision ledger and pipeline utilization: evidence-bound development plan](../../experiments/decision-ledger-closeout-20261009/development-plan-draft.md)
- [Baseline shadow evidence: independent forensic review](../../experiments/decision-ledger-closeout-20261009/reports/baseline-forensic-review.md)
- [Deadline probe validity review](../../experiments/decision-ledger-closeout-20261009/reports/deadline-probe-validity-review.md)
- [Decision ledger and pipeline utilization: evidence-bound development plan](../../experiments/decision-ledger-closeout-20261009/reports/development-plan.md)
- [Native evidence audit](../../experiments/decision-ledger-closeout-20261009/reports/evidence-audit.md)
- [Argus Decision Ledger closeout](../../experiments/decision-ledger-closeout-20261009/reports/final-report.html) — HTML
- [Argus Decision Ledger experiment closeout](../../experiments/decision-ledger-closeout-20261009/reports/final-report.md)
- [Decision Ledger consumer backlog](../../experiments/decision-ledger-closeout-20261009/reports/implementation-backlog.md)
- [Independent closeout plan review](../../experiments/decision-ledger-closeout-20261009/reports/independent-closeout-plan-review.md)
- [Argus · Decision Ledger closeout](../../experiments/decision-ledger-closeout-20261009/reports/lan-site/index.html) — HTML
- [Argus Decision Ledger closeout](../../experiments/decision-ledger-closeout-20261009/reports/report.html) — HTML
- [Experiment pipeline cleanup](../../experiments/pipeline-cleanup-20261010/README.md)
- [Shadow feeder](../../experiments/shadow-feeder/README.md)

## Design-system sources

- [Argus design system — sync sources](../../design/README.md)
- [Chronicle timeline (design reference)](../../design/components/chronicle-timeline/index.html) — HTML
- [Segmented control (design reference)](../../design/components/segmented-control/index.html) — HTML
- [Living-data choreography](../../design/foundations/motion-choreography/index.html) — HTML
- [Motion lifecycle](../../design/foundations/motion-lifecycle/index.html) — HTML

**Inventory:** 98 documents, including this catalog. Source code, skills and runtime artifacts are outside this prose-document inventory.
