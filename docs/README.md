# Argus documentation

Argus runs and monitors coding agents on your machine. It reads their local
history, launches one-off or scheduled work, and coordinates pipelines with
verification and human review. Supported runtimes are Claude Code, Codex,
OpenCode and Qwen Code; you only need the runtimes you intend to use.

## Start here

| Your goal                                            | Read next                                                                   |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Install Argus and open the dashboard                 | [Installation and setup](getting-started/README.md)                         |
| Run a small task and inspect the result              | [Your first run](getting-started/first-run.md)                              |
| Learn the interface and find a feature               | [Navigation](guides/navigation.md), then [feature guides](guides/README.md) |
| Repeat work or build a reviewed workflow             | [Schedules](guides/scheduling.md), then [pipelines](guides/pipelines.md)    |
| Understand rules, evidence and implementation intent | [Knowledge workflows](guides/knowledge.md)                                  |
| Diagnose a setup or runtime problem                  | [Operations and troubleshooting](reference/operations.md)                   |
| Work on Argus as an AI agent                         | [Agent reading guide](AGENT-GUIDE.md)                                       |

## How the documentation is organized

```text
docs/
  README.md             documentation entry point
  getting-started/       installation and a first-run tutorial
  guides/               task-focused instructions for every feature
  reference/            configuration, runtimes, operations and vocabulary
  development/          development status, document catalog and maintenance
  ARCHITECTURE.md        detailed implementation architecture
  API.md                HTTP and WebSocket contracts
  DATA-MODEL.md         file formats and runtime data sources
  HARNESS.md            pipeline execution protocols and worked examples
  KNOWLEDGE-LEDGER.md    semantic protocols, invariants and worked examples
  research/             dated research and capability comparisons
  rfc/                  design proposals with implementation amendments
  argus/                dated development evidence and experiment handoffs
  superpowers/          historical design specifications and plans
```

The detailed technical references keep their existing paths so code, evidence
records and older links remain usable. [USER-GUIDE.md](USER-GUIDE.md) preserves
the old numbered section links and points to the new feature pages.

## Learn the main concepts

An **agent runtime** is the CLI that performs a task. A **run** is one invocation.
A **schedule** repeats a prompt when its trigger fires. A **pipeline** defines
phases and steps; an **instance** is one execution of that definition. A **gate**
pauses progression for review. A successful agent message, a passed verification
check and an approved gate are distinct events.

Three features use ledger terminology:

- **Spend Ledger:** where money went and estimated future spend, inside Budget.
- **Knowledge Ledger:** claims, rule revisions, evidence and semantic provenance.
- **Decision Journal / Decision Ledger:** retained model assessments and their
  evaluation foundations. An assessment does not grant approval or establish
  knowledge support.

Use the [glossary](reference/glossary.md) for the other terms and UI names.

## Reference and development

- [Technical reference index](reference/README.md): configuration, runtime
  differences, operations, API, architecture and execution protocols.
- [Development status](development/README.md): delivered mechanisms, optional
  experiments, offline foundations and remaining prerequisites.
- [Complete document catalog](development/catalog.md): all documentation titles,
  including design history and experimental evidence.
- [Changelog](../CHANGELOG.md): changes recorded by release or under Unreleased.

## What a status claim means

These instructions describe the source checkout inspected on **2026-10-10**.
Check `/api/health` and your running process when identifying an installed build;
a source change or an offline report does not prove that build is running.

H1/H2 shadow collection and trajectory judging are optional. New Decision
Ledger advisory and enforcing consumers have separate readiness requirements.
Read the [status guide](development/README.md) before using research or a plan as
evidence that a feature is enabled. Historical experiment pipelines were
[archived](../experiments/pipeline-cleanup-20261010/README.md).
