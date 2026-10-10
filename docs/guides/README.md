# Feature guides

[Documentation](../README.md) · [Installation](../getting-started/README.md) · [Reference](../reference/README.md)

Start with [your first run](../getting-started/first-run.md). Each guide then
provides prerequisites, a short task to try, its expected result and detailed
controls. You do not need to learn every branded feature name before using Argus.

## Choose a task

| I want to…                                           | Guide                                               |
| ---------------------------------------------------- | --------------------------------------------------- |
| Find a page or preview a natural-language action     | [Navigation and Omnibar](navigation.md)             |
| See running work and review what happened            | [Monitoring](monitoring.md)                         |
| Launch one task or repeat it                         | [Scheduling](scheduling.md)                         |
| Coordinate phases and review their results           | [Pipelines](pipelines.md)                           |
| Diagnose missed runs, failures or poor output        | [Health and quality](health-and-quality.md)         |
| Set spending limits and inspect long-term usage      | [Budgets and history](budget-and-history.md)        |
| Search conversations and inspect installed resources | [Sessions and inventory](sessions-and-inventory.md) |
| Manage accounts or connect machines                  | [Administration](administration.md)                 |
| Follow work from a shell or an AI tool               | [Terminal access](terminal.md)                      |
| Inspect rules and author semantic workflows          | [Knowledge](knowledge.md)                           |
| Read or configure bounded shadow experiments         | [Decision experiments](experiments.md)              |

## Feature map

Routes below are browser hash paths appended to your dashboard URL, for example
`http://127.0.0.1:7777/#/schedules`. **More** means the navigation overflow menu.
Some features are panels within a page rather than separate destinations.

| Feature                          | Where to find it                                | Detailed instructions                                                                          |
| -------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Global navigation and shortcuts  | Ctrl K / ⌘K, ?                                  | [Navigation](navigation.md#global-ui)                                                          |
| Command Center                   | `#/command`                                     | [Pipeline board](monitoring.md#command-center)                                                 |
| Briefing                         | `#/briefing`                                    | [Catch up](monitoring.md#briefing)                                                             |
| Chronicle                        | `#/chronicle`                                   | [Timeline](monitoring.md#chronicle)                                                            |
| One-off runs                     | `#/schedules/oneoff`                            | [Launch once](scheduling.md#one-off-runs)                                                      |
| Scheduler                        | `#/schedules`                                   | [Recurring work and triggers](scheduling.md#scheduler)                                         |
| Monitors                         | `#/health`                                      | [Expected runs](health-and-quality.md#monitors)                                                |
| Issues                           | `#/issues`                                      | [Failure groups](health-and-quality.md#issues)                                                 |
| Pipelines                        | `#/pipelines`                                   | [Definitions and gates](pipelines.md#pipelines)                                                |
| Budget                           | `#/budget`                                      | [Limits](budget-and-history.md#budget)                                                         |
| Users and sign-in                | More → Users, `#/users`; login on Pipelines     | [Accounts](administration.md#users--sign-in)                                                   |
| Search                           | `#/search`, / or palette                        | [Transcript search](sessions-and-inventory.md#search)                                          |
| Agents                           | Palette or drill-down, `#/agents`               | [Discovered jobs](monitoring.md#agents)                                                        |
| Agent Detail                     | `#/agent/<id>`                                  | [Job detail](monitoring.md#agent-detail)                                                       |
| Sessions                         | More → Sessions, `#/sessions`                   | [Conversations](sessions-and-inventory.md#sessions)                                            |
| Projects                         | Sessions project filter, `#/sessions/<project>` | [Project grouping](sessions-and-inventory.md#projects)                                         |
| Stats                            | More → Stats, `#/stats`                         | [Usage](budget-and-history.md#stats)                                                           |
| Inventory                        | More → Inventory, `#/inventory`                 | [Resources](sessions-and-inventory.md#inventory)                                               |
| Flight Recorder                  | Open a run, `#/run/<id>`                        | [Run activity](monitoring.md#flight-recorder)                                                  |
| Watchtower                       | Health → Watchtower, `#/health/watchtower`      | [Learned envelopes](health-and-quality.md#watchtower)                                          |
| Autopsy                          | Failed run's Flight Recorder                    | [Cause analysis](health-and-quality.md#autopsy)                                                |
| Verdict                          | Run's Flight Recorder; quality trends           | [Output and trajectory assessment](health-and-quality.md#verdict)                              |
| Sentinel                         | More → Sentinel, `#/sentinel`                   | [Incidents](health-and-quality.md#sentinel)                                                    |
| Weave                            | Pipelines form and Command Center               | [Dependencies, routes and artifacts](pipelines.md#weave)                                       |
| Spend Ledger                     | Budget                                          | [Attribution and forecasts](budget-and-history.md#ledger)                                      |
| Vault                            | Stats, Search and Chronicle history             | [Historical cache](budget-and-history.md#the-vault)                                            |
| Omnibar                          | Command palette                                 | [Natural-language preview](navigation.md#omnibar)                                              |
| Constellation / Fleet            | More → Fleet, `#/fleet`                         | [Multiple machines](administration.md#constellation)                                           |
| `argus tail`, approve and revise | Terminal                                        | [Terminal guide](terminal.md#argus-tail)                                                       |
| H2 decision experiment           | More → Experiments, `#/experiments`             | [Failure/outcome shadow evidence](experiments.md#decision-experiments-h2-shadow-collection)    |
| H1 decision experiment           | More → Experiments, `#/experiments`             | [Operator-action shadow evidence](experiments.md#decision-experiments-h1-gate-operator-action) |
| Knowledge                        | More → Knowledge, `#/knowledge`                 | [Claims and evidence](knowledge.md#knowledge)                                                  |
| Activity, Tasks and native Cron  | API-only or removed UI                          | [Compatibility reference](../reference/legacy-features.md)                                     |

## Advanced authoring

Some options are API-authored and preserved by the form. The [advanced pipeline
recipes](pipelines.md#advanced-feature-recipes) map capability profiles,
verification, worktrees, candidates, memory, recovery and trajectory checks to
worked examples. The [knowledge authoring map](knowledge.md#authoring-knowledge-workflows)
covers discovery, verification, change intent and targeted realization.

For exact request bodies and authentication use [API.md](../API.md). For the
execution and result protocols use [HARNESS.md](../HARNESS.md). Neither a
successful process nor a favorable model score replaces independently required
checks and human decisions.
