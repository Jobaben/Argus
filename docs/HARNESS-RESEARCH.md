# What the best harnesses do, and where Argus falls short

_September 2026. Evidence-graded gap analysis behind the harness wave that
follows [HARNESS.md](HARNESS.md)._

## 1. Method

"Harness" here means everything around the model that decides what it is
given, what it may do, how its work is checked, and what happens when the check
fails. Argus occupies the outer ring of that: it launches subscription CLIs
(`claude -p`, `codex exec`, `opencode run`, `qwen`) and owns scheduling,
isolation, verification, retries, budgets and the record. It cannot change the
loop inside the CLI. So the question was not "what does a perfect agent look
like" but "what does the evidence say the layer _around_ the agent must do".

Four research passes, each restricted to externally graded sources — a public
leaderboard, a peer-reviewed paper with an ablation, an independent evaluation
or a pre-registered study — and forbidden from trusting a vendor's own numbers:

| Pass                                                                       | Sources                                                                                                                                                                                                                                                                            | Entries graded |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| [SWE-bench family](research/2026-09-swebench-harnesses.md)                 | SWE-bench Verified / Lite / Full / Pro / Multimodal, Multi-SWE-bench, SWE-PolyBench, SWE-rebench, SWE-Gym                                                                                                                                                                          | 45             |
| [Other agentic benchmarks](research/2026-09-agentic-benchmarks.md)         | Terminal-Bench 1.0–2.1, HAL (Princeton), GAIA, τ²-bench, OSWorld-Verified, WebArena / BrowseComp / Mind2Web, AgentBench, MLE-bench, METR RE-Bench and time horizons, Aider polyglot, LiveCodeBench Pro, SWE-Lancer, Cybench, AppWorld, TheAgentCompany, Spider 2.0 / BIRD, ARC-AGI | 46             |
| [Design literature with ablations](research/2026-09-harness-literature.md) | NeurIPS / ICML / ICLR / ACL / TACL papers and the few practitioner posts that publish measurements                                                                                                                                                                                 | ~45 papers     |
| [Orchestration layers](research/2026-09-orchestration-layers.md)           | 42 products and frameworks in Argus's own layer, feature-matrixed on 14 capabilities, each claim graded for evidence quality                                                                                                                                                       | 42             |

About 130 graded harness entries in total, against the
[inventory of what Argus does today](research/2026-09-argus-inventory.md).

Two caveats the evidence itself insists on. Leaderboard positions are noisy:
re-grading (UTBoost) moved a quarter of SWE-bench Verified entries, and 0.5–23%
of "passing" trajectories are lucky passes (AgentLens). And the METR 2025
randomised trial — the only RCT in the space — found developers 19% _slower_
with AI assistance while believing themselves 20% faster. Every vendor
productivity number below is therefore treated as unverified.

## 2. What the evidence supports

Ranked by strength of evidence. "Reach" says whether Argus's layer can act on
it: the CLI owns its inner loop; Argus owns what surrounds it.

| #   | Principle                                                                                                                                                                             | Evidence                                                                                                                                                                                         | Grade    | Reach  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| 1   | **A real verifier is the load-bearing part.** Repeated sampling scales coverage log-linearly, but only a verifier turns coverage into resolved tasks; selection without one plateaus. | Large Language Monkeys (15.9% → 56% coverage at 250 samples); CodeMonkeys; SWE-Gym / R2E-Gym verifiers; HAL: scaffolding pays where a cheap verifier exists and is unpredictable where none does | strong   | Argus  |
| 2   | **Test-time compute beyond one rollout, gated by that verifier.** Every leaderboard jump after a single-rollout baseline came from N candidates plus selection or search.             | Trae Agent 70.6 → 75.2% from its ensemble alone, monotonic in N; AutoCodeRover +7 pts from 3 samples; AIDE tree search 4× medal rate on MLE-bench; SWE-Replay: same gains at 17% less compute    | strong   | Argus  |
| 3   | **Sandboxed, reproducible execution is table stakes.** No top entry skips it; every orchestrator standardised on a worktree, container or VM per run.                                 | Terminal-Bench, mini-SWE-agent, AppWorld, AIDE; Codex cloud, Cursor, Copilot, Claude Squad, Conductor, Gas Town all isolate per run                                                              | strong   | Argus  |
| 4   | **Feed the failure back.** A retry that carries the failing test output is the best-evidenced loop in the space.                                                                      | Aider's edit loop, tracked independently by Epoch AI; CodeRabbit's capped 3-attempt autofix; Reflexion; Self-Refine (~20% absolute)                                                              | strong   | Argus  |
| 5   | **Context position and size matter, not just presence.** Middle-of-context content is under-used; comprehensive instruction files _hurt_ efficiency.                                  | Lost in the Middle (well replicated); "On the Impact of AGENTS.md Files"; Manus KV-cache telemetry (10× cost delta)                                                                              | strong   | Argus  |
| 6   | **Externalised state across sessions.** Progress files, task lists and git history are how long-horizon work survives a context window.                                               | Anthropic long-running-harness case study; MemGPT; Agent Workflow Memory (+24–51% relative); Ralph loop convention                                                                               | moderate | Argus  |
| 7   | **Stuck detection and bounded loops.** Long trajectories degrade ("coherence collapse"); top systems detect no-progress and stop or restart.                                          | OpenHands stuck detector; Symphony stall restart; step budgets universal in practice though never isolated in an ablation                                                                        | moderate | Argus  |
| 8   | **Outcome-only judging misses silent failures.** Step-level rubric judging catches 77% of silent faults vs 45% for outcome-only.                                                      | trajectory-judge, BabelJudge                                                                                                                                                                     | strong   | partly |
| 9   | **Risk-tiered approval, not blanket approval.** Gates cluster on destructive or external actions; routine edits run unattended.                                                       | Field telemetry (approval in ~36% of loops); Jules's auto-approve weakens the gate                                                                                                               | moderate | Argus  |
| 10  | **Event-driven scheduling is the underserved capability** in this layer: most CLIs need an external cron or CI wrapper.                                                               | Orchestration matrix: only Routines, Copilot issue-trigger, CodeRabbit PR-trigger, Symphony's board watch have it natively                                                                       | moderate | Argus  |
| 11  | **Plan as a checkable artifact, but do not force planning.** A subpar plan hurts more than none; "always plan" degrades long-horizon work.                                            | Terminus 2 / Cybench forced plan schemas; "Evaluating Plan Compliance"; "Learning When to Plan"                                                                                                  | strong   | Argus  |
| 12  | **More agents is not better by default.** Orchestrator-worker wins on parallelisable tasks at 15× cost; multi-agent gains are otherwise "often minimal".                              | Anthropic research system (+90% on breadth tasks); MAST taxonomy, 14 failure modes, κ = 0.88                                                                                                     | strong   | Argus  |
| 13  | **Tool output is untrusted input.**                                                                                                                                                   | InjecAgent (24% compromise for ReAct GPT-4); AgentDojo                                                                                                                                           | strong   | partly |
| 14  | **Tool-interface (ACI) design** mattered a lot in 2024 and has been largely absorbed by stronger models by 2026.                                                                      | SWE-agent ACI +10.7 pts (2024) vs mini-SWE-agent's 100-line bash harness at 74% Verified (2026)                                                                                                  | mixed    | CLI    |
| 15  | **Localisation precision gates repair.**                                                                                                                                              | Agentless, Nemotron-CORTEXA, AutoCodeRover cost data                                                                                                                                             | strong   | CLI    |
| 16  | **VM-level isolation over containers for untrusted code.**                                                                                                                            | Sandbox-escape capability studies; Firecracker / Kata write-ups                                                                                                                                  | moderate | no     |

Refuted or neutral, and therefore deliberately **not** built: multi-agent
debate (its gain is majority voting in disguise); mandatory planning phases;
maximal repo-instruction files; selection by majority vote or reward model
without execution (plateaus); more roles per pipeline.

## 3. Does this call for a redesign?

No. The orchestration survey's own conclusion is that the highest-leverage,
least-served capabilities in this layer are exactly Argus's shape: native
scheduling of headless CLI runs, enforced and visible retry and budget
ceilings, cross-CLI parallel-attempt-and-select, and portable records for
headless runs. Nothing in the evidence favours an API-key SDK integration over
driving the subscription CLIs — the leaderboard entries are model + harness
pairs, and the harness gains that persist into 2026 (verification, test-time
search, isolation, feedback) all live in the layer Argus already owns. The one
principle a dependency-less design cannot meet is VM-level isolation (#16);
the evidence-backed, dependency-less answer that every open-source orchestrator
converged on is a git worktree per run, which is what this wave adds. Codex's
own OS sandbox remains the only hard boundary, as documented.

## 4. Gap analysis

| Dimension            | Argus today                                                                                                  | Evidence says                          | Gap                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Verification         | Deterministic `command` / `file` / `artifact` / `changed-files` checks; Verdict rubric as a separate watcher | #1, #8                                 | Sound. Verdict judges output, not trajectory (follow-up, not this wave).                           |
| Test-time scaling    | **None.** Retries are sequential replacements; Verdict scores one run                                        | #2 — the single largest measured lever | **Candidates**: N parallel attempts of a phase, verifier-gated selection, cross-runtime variants.  |
| Isolation            | `cwd` only; Codex sandbox; Claude read-only emulated by tool denial                                          | #3 — universal                         | **Worktree per attempt / per instance**, git-only, no new dependency.                              |
| Retry feedback       | Failure reason fed back for `verification` and `signal` classes only                                         | #4                                     | Carry check output tails, exit-code stderr tail, and timeout context for every retryable class.    |
| Context discipline   | Four `{{…}}` placeholders, no size cap; Argus instructions placed mid-prompt                                 | #5                                     | **Bounded interpolation** (head + tail with a marker); keep injected instructions short and last.  |
| Memory across runs   | Artifacts cleared per attempt; nothing survives an instance                                                  | #6                                     | **Pipeline memory**: a bounded `NOTES.md` the agent may update, plus the last instance's outcome.  |
| Stuck detection      | Wall-clock `timeoutSeconds` only                                                                             | #7                                     | **Stall timeout**: no output for N seconds kills the step as `timeout` with a `stalled` reason.    |
| Triggers             | interval / daily / weekly / windowed, catch-up, manual; webhooks out only                                    | #10                                    | **Webhook-in** and **chaining** (`after` another pipeline) trigger kinds.                          |
| Evaluation over time | Verdict trend, Watchtower anomalies, Ledger cost                                                             | #1, AgentLens lucky passes             | **Reliability derivation** per pipeline: first-attempt pass rate, lucky passes, stalls, selection. |
| Planning             | Gated phase + JSON result schema                                                                             | #11 — do not force it                  | None. The pattern is right; a mandatory planner would be wrong.                                    |
| Approval             | Gated phases, auto-approve by rubric                                                                         | #9                                     | None.                                                                                              |
| Multi-agent          | DAG fan-out, concurrency cap                                                                                 | #12                                    | None; candidates add parallelism only where a verifier selects.                                    |
| Tool-output trust    | Outcome marker read from the agent's final message; hook signals token-authenticated                         | #13                                    | Partial. Noted for a later wave.                                                                   |
| Templates / library  | None                                                                                                         | weak evidence                          | Not built; Agent Workflow Memory suggests mined procedures, not galleries.                         |

## 5. The wave

Ordered by dependency. Each item lands with contracts first, colocated tests,
and its own section in HARNESS.md. The model column is what implemented it;
effort was matched to depth so that a derivation and a UI card did not consume
the budget an engine change needs.

| #   | Item                                                                                | Touches                                                                | Depends on | Model / effort  |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------- | --------------- |
| 1   | Worktree isolation (`workspace` on pipeline / phase; `instance` or `attempt` scope) | contracts, `harness/workspace.ts`, `pipelineEngine.ts`, UI step drawer | —          | Opus / high     |
| 2   | Webhook-in and `after` trigger kinds                                                | contracts `schedules.ts`, `app.ts` route, `scheduler.ts`, PipelineForm | —          | Sonnet / medium |
| 3   | Reliability derivation, `GET /api/pipelines/:id/reliability`, pipeline card         | contracts, `sources/reliability.ts`, `app.ts`, Pipelines view          | —          | Sonnet / medium |
| 4   | Candidates (best-of-N with verifier-gated selection, cross-runtime variants)        | contracts, `pipelineEngine.ts`, `pipelineTransitions.ts`, board        | 1          | Opus / high     |
| 5   | Bounded interpolation, pipeline memory, richer retry feedback, stall timeout        | `sources/dag.ts`, `pipelineEngine.ts`, `runTailer.ts`, `childEnv.ts`   | 4          | Sonnet / medium |
| 6   | Documentation: HARNESS.md sections, README runtime table, USER-GUIDE, CHANGELOG     | docs                                                                   | 1–5        | Sonnet / low    |

All six items landed in this wave (see the CHANGELOG under Unreleased and
HARNESS.md §11–§13). Two deviations from the sketches worth knowing: candidate
branches are named `argus/<inst>/<phase>/<attempt>-c<i>` because git refs are a
filesystem and `<attempt>` and `<attempt>/c1` cannot coexist; and
`WorkspacePolicy.scope` gained `"none"` so a phase can opt out of a pipeline's
isolation. Measured at the end: server 1705 tests, web 1095, every CI gate
green, initial payload 120.6 kB gzip against a budget raised from 120 to 122
with the reason written into the check.

### Contract sketches

```ts
// 1 — isolation
export interface WorkspacePolicy {
  /** "instance": one worktree per pipeline instance, shared by every phase that
   *  opts in. "attempt": a fresh worktree per phase attempt (what candidates need). */
  scope: "instance" | "attempt";
  /** Ref the worktree is created from. Default: HEAD of the repository at `cwd`. */
  base?: string;
  /** Keep the worktree directory after the instance ends. Default false: the
   *  directory is removed, the branch is kept. */
  keep?: boolean;
}
// PhaseDef.workspace?: WorkspacePolicy; PipelineDefinition.workspace?: WorkspacePolicy
// PhaseProgress.workspace?: WorkspaceRecord | null   ({ path, branch, base })

// 2 — triggers
export type TriggerKind = "interval" | "daily" | "weekly" | "windowed" | "webhook" | "after";
// webhook: POST /api/hooks/pipelines/:id (and /schedules/:id) with a per-definition
//          bearer token minted by the server; body kept as the instance's triggerPayload.
// after:   { kind: "after", pipelineId, on: "succeeded" | "failed" | "any" }

// 4 — candidates
export interface CandidatePolicy {
  count: number; // 2..8
  /** first-verified: the first candidate whose checks pass wins and its siblings
   *  are killed. all: every candidate runs to its checks; the cheapest verified wins. */
  select: "first-verified" | "cheapest-verified";
  /** Per-candidate overrides, cycled when shorter than count. */
  variants?: Array<{ runtime?: AgentRuntimeId; model?: string; reasoningEffort?: ReasoningEffort }>;
}
// PhaseDef.candidates?: CandidatePolicy  (requires workspace.scope === "attempt", one step)
// StepProgress.candidate?: number; PhaseProgress.selectedCandidate?: number

// 5 — memory and stall
// PipelineDefinition.memory?: { enabled: boolean; maxBytes?: number }
// PhaseDef.stallSeconds? / PhaseStep.stallSeconds?
// placeholders: {{memory}}, {{previous.instance}}, {{trigger.payload}}
```
