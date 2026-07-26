# @argus/contracts

The **wire contract** between `@argus/server` and `@argus/web`: every DTO that
crosses the HTTP/WebSocket boundary, declared exactly once.

## Why it exists

Before this package the same ~25 DTOs were declared twice — once beside the
server source that produced them, once in `web/src/types.ts` and a dozen `use*`
hooks that consumed them. Nothing forced the two copies to agree, so a field
added on the server was invisible to the client until someone noticed, and a
field _removed_ on the server left the client type-checking against a shape that
no longer existed.

Now the server's sources and the web's hooks import the same declarations. A
producer change that breaks a consumer fails `npm run typecheck` in CI.

## Rules

1. **Types only — zero runtime.** Every export is an `interface`, `type` or
   `const enum`-free union, so all imports erase at compile time. Neither
   workspace gains a runtime dependency and there is no build step: consumers
   resolve `./src/index.ts` directly through the `exports` map.
2. **Only what crosses the boundary.** Server-internal shapes (on-disk file
   layouts, engine state, validation inputs) stay in `server/src`. If the web
   cannot observe it, it is not a contract.
3. **Additive by default.** Optional fields keep old clients compiling; a
   required field or a narrowed union is a breaking change and must be landed
   with its consumers in the same commit.

## Layout

| Module         | Covers                                                      |
| -------------- | ----------------------------------------------------------- |
| `agents.ts`    | Background agents, timelines, the daemon snapshot           |
| `schedules.ts` | Triggers, schedules, runs, one-off launches                 |
| `pipelines.ts` | Definitions, instances, phase/step progress, board overview |
| `monitors.ts`  | Dead-man's-switch health and heartbeats                     |
| `issues.ts`    | Failure fingerprints and triage                             |
| `budget.ts`    | Spend config, status and the daily ledger                   |
| `chronicle.ts` | Swimlane spans                                              |
| `briefing.ts`  | Attention items and the away digest                         |
| `insight.ts`   | Derived board signal (situation strip)                      |
| `catalog.ts`   | Sessions, projects, stats, inventory, tasks, search, cron   |
| `admin.ts`     | Auth status, users, setup prerequisites, totals, health     |
| `live.ts`      | The WebSocket frame union                                   |
