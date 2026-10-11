# Overnight roadmap work — 2026-10-11

User instruction: read the documentation and fan out meaningful work overnight from plans and roadmaps. Preserve staged, uncommitted changes for IDE review. No commit, push, merge or release.

## Scope and execution

The historical roadmap is an idea source, not a current implementation checklist. Current development status, source, tests and retained evidence decide whether a slice remains useful. Many harness and Decision Ledger foundation plans are already implemented. Live Decision Ledger consumers remain blocked by their explicit operational prerequisites.

The initial working tree was clean. Work takes place in the current checkout with disjoint file ownership; no worker may revert another worker's edits. Maximum two simultaneous implementers and one evidence/review agent. Root coordinates validation and stages only intended files. Do not create work just to consume the night.

Argus HTTP probes on port 7777 returned connection refused; ports 7777 and 5757 have no listeners. Persisted pipeline definitions are empty. No Argus pipeline was started. The thread heartbeat `argus-overnight-roadmap-work` runs every 30 minutes until 2026-10-11 06:00 UTC (08:00 Stockholm, assumed morning cutoff). It may stop earlier when the useful queue is exhausted. Follow-ups require the host/app to execute them; scheduled creation alone does not establish subsequent execution.

## Bounded queue

1. **Session transcript shape hardening** — roadmap quality backlog. Owner `backlog`: `server/src/sources/sessions.ts`, session-specific tests, `sessions-report.md`. First reproduce malformed-but-valid JSON failures. Preserve valid title precedence, text, tool counts, ordering, tail indices and runtime translations. Avoid changing the raw Recorder reader contract.
2. **History reader hardening and home isolation** — roadmap source fixture coverage/correctness. Owner `history`: `server/src/sources/history.ts`, `history.test.ts`, `history-report.md`. Reproduce invalid shapes/date failures and cross-home cache leakage; retain valid activity, bounded tail, newest-first order and limit semantics.
3. **Naming provenance evidence** — roadmap `deriveName` item. Owner `operations`: `naming-report.md`. Establish actual `nameSource` values without exposing raw prompts. If semantics cannot be established, record a blocker and leave behavior alone. Code requires a concrete evidence-supported policy and exclusive ownership of jobs source/tests.
4. **Validation and review** — root captures focused tests, typecheck, lint, build and appropriate broader tests. Independent reviewer inspects both implementation slices and regression coverage. Investigate actual new failures using captured logs. Existing suite failures require fresh diagnosis; historical counts are not current results. Do not broaden into unrelated fixes or weaken tests.
5. **Morning handoff** — update `report.md`, stage intended changes, retain logs and reports, list verified results and unresolved limitations. Pause the heartbeat at cutoff, queue exhaustion or a genuine external evidence blocker. No new slice after cutoff.

## Acceptance and stop rules

Meaningful fixture regressions must fail before the fix and pass afterward. Report applied edits separately from verification. Follow SOLID and existing repository patterns. If a first fix fails, re-diagnose from fresh error evidence before a second fix. Never fabricate production support, provider capability, genuine references, calibrated thresholds or live readiness. No production stores, hooks, credentials, accounts, gates or provider calls are modified.

## Native Argus fan-out recipe for later use

When deliberately bringing up Argus: rebuild the intended checkout, identify its health/build, verify `/api/setup` and runtime readiness, and use an approved account session for mutation/start. Use an explicit DAG: independent phases `needs: []`, a fan-in report phase naming all dependencies, `overlapPolicy: skip`, manual one-shot trigger, explicit Codex runtime, bounded per-step timeout/stall, no automatic retry after signalled failures. Configure server concurrency separately.

Each independent writing phase needs `workspace: { scope: "attempt", base: "HEAD", keep: true }`. Instance workspaces share a directory; attempt workspaces isolate branches. `keep: true` preserves uncommitted work, which default cleanup otherwise discards. HEAD-based worktrees exclude dirty changes; account for the staged implementation before choosing a baseline. Stage changes in each retained workspace and report paths; do not auto-merge. A bounded DAG has no built-in overall overnight deadline, so keep its total work finite. Use `produces`/artifact placeholders for unambiguous handoffs and required completion signalling plus deterministic checks; an exit code alone is insufficient.
