# Agent Harnesses on Non-SWE-bench Benchmarks: An Evidence Review (2026)

Scope: externally graded leaderboards/evaluations only (public leaderboards, peer-reviewed or
independent third-party evaluations). Vendor blog "we scored X%" claims are excluded unless
corroborated by an independent leaderboard (tbench.ai, HAL, Steel.dev aggregator, BenchLM.ai,
llm-stats.com, official benchmark sites) or a peer-reviewed paper. Note: several 2026 model names
surfaced by search (e.g. "GPT-5.6 Sol", "Claude Opus 5/Mythos/Fable", "GPT-6 Astra") are beyond
this agent's training cutoff and are reported here only as leaderboard entries as scraped, not
verified against vendor documentation.

---

## 1. Top-ranked harness/agent entries across non-SWE-bench benchmarks

| #   | Benchmark                                                                           | Top entry (harness / agent)                                            | Model(s)                               | Score                                                                               | Date       | Source                                                                                                      |
| --- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Terminal-Bench 2.0 (overall)                                                        | "vix" (research harness)                                               | Claude Opus 4.7                        | 90.2%                                                                               | 2026       | tbench.ai leaderboard                                                                                       |
| 2   | Terminal-Bench 2.0 (named CLI agents)                                               | Codex CLI                                                              | GPT-5.5                                | 82.2%                                                                               | 2026-06-07 | tbench.ai                                                                                                   |
| 3   | Terminal-Bench 2.1 (named CLI agents)                                               | Codex CLI                                                              | GPT-5.5                                | 83.4%                                                                               | 2026       | codingfleet.com / snorkel.ai                                                                                |
| 4   | Terminal-Bench 2.1 (Terminus-2 harness, controlled)                                 | Terminus 2                                                             | GPT-5.5                                | 76.40%                                                                              | 2026       | Artificial Analysis via tbench.ai (same model scores lower under standardized harness than under Codex CLI) |
| 5   | Terminal-Bench 2.1 (Terminus-2 harness)                                             | Terminus 2                                                             | Codex/GPT-5.6 "Sol"                    | 89.5%                                                                               | 2026       | Artificial Analysis                                                                                         |
| 6   | Terminal-Bench 2.1 (Terminus-2 harness)                                             | Terminus 2                                                             | Claude Code / Opus 5                   | 89.1%                                                                               | 2026       | Artificial Analysis                                                                                         |
| 7   | Terminal-Bench 1.0 (historical baseline)                                            | Terminus 1                                                             | Claude 3.7 Sonnet                      | ~30% (task-set dependent)                                                           | 2025       | tbench.ai leaderboard v0.1.1                                                                                |
| 8   | HAL — GAIA                                                                          | Claude-based agent scaffold                                            | Claude Sonnet 4.5                      | 74.6%                                                                               | 2026       | hal.cs.princeton.edu                                                                                        |
| 9   | HAL — SWE-bench Verified                                                            | Agent scaffold (excluded from "our slice" but cross-referenced)        | Claude Opus 4.7                        | 87.6%                                                                               | 2026       | hal.cs.princeton.edu                                                                                        |
| 10  | GAIA (public/vendor-adjacent leaderboards)                                          | Lemon Agent                                                            | multi-model ensemble                   | 91.36%                                                                              | 2026-02-06 | arXiv:2602.07092                                                                                            |
| 11  | GAIA                                                                                | JoyAgent-JDGenie                                                       | multi-model ensemble                   | reported top-tier                                                                   | 2025-2026  | arXiv:2510.00510                                                                                            |
| 12  | GAIA (tracked/public snapshot, less rigorous)                                       | OPS-Agentic-Search                                                     | —                                      | 92.36%                                                                              | 2026       | pricepertoken.com aggregator                                                                                |
| 13  | τ²-Bench Airline                                                                    | (Sierra harness, function-calling agent)                               | Gemini 3.7 Flash                       | 80.6%                                                                               | 2026-09-17 | OpenRouter τ²-bench tracker                                                                                 |
| 14  | τ-bench (τ1, retail/airline)                                                        | Sierra reference agent                                                 | GPT-4o/Claude-class (2024-25 baseline) | ~60% retail / ~35% airline (baseline era)                                           | 2024       | sierra-research/tau-bench (GitHub)                                                                          |
| 15  | OSWorld-Verified                                                                    | (computer-use agent)                                                   | Qwen3.8 Max                            | 86.1%                                                                               | 2026-09-15 | Steel.dev / BenchLM.ai                                                                                      |
| 16  | OSWorld-Verified                                                                    | Claude-based computer-use agent                                        | Claude "Fable"/"Mythos" 5              | 85% (tie)                                                                           | 2026       | BenchLM.ai                                                                                                  |
| 17  | OSWorld-Verified (enterprise-audited)                                               | UiPath Screen Agent                                                    | Claude Opus 4.5                        | "top ranking" (independent audit)                                                   | 2026-01-14 | Businesswire / independent OSWorld run                                                                      |
| 18  | WebArena                                                                            | WebTactix                                                              | DeepSeek v3.2                          | 74.3%                                                                               | 2026-06-29 | Steel.dev                                                                                                   |
| 19  | BrowseComp                                                                          | (OpenAI deep-research-style agent)                                     | GPT-5.6 Sol Ultra                      | leader                                                                              | 2026       | Steel.dev aggregator                                                                                        |
| 20  | Online-Mind2Web                                                                     | Browser Use (Cloud, "bu-max")                                          | proprietary orchestration              | 97% (highest recorded)                                                              | 2026       | browser-use.com / OSU-NLP leaderboard                                                                       |
| 21  | Mind2Web (original, offline)                                                        | MindAct                                                                | small ranker + large model             | baseline architecture reference                                                     | 2023-24    | OSU-NLP Mind2Web                                                                                            |
| 22  | AgentBench (8-env aggregate)                                                        | AgentRL                                                                | Qwen2.5-32B-Instruct                   | 70.4 (aggregate)                                                                    | 2026-04-16 | Steel.dev (benchmark largely superseded)                                                                    |
| 23  | MLE-bench (75 Kaggle competitions)                                                  | AIDE (tree-search scaffold)                                            | o1-preview                             | 16.9% ≥bronze-medal rate (original paper)                                           | 2024       | OpenAI MLE-bench paper                                                                                      |
| 24  | MLE-bench                                                                           | FM Agent                                                               | frontier model, undisclosed            | 96.89% valid-submission rate; competitive medal rate                                | 2025-26    | arXiv:2510.26144                                                                                            |
| 25  | MLE-bench (public leaderboard)                                                      | Famou-Agent 2.0                                                        | Gemini-3-Pro                           | 80.3% medal rate                                                                    | 2026-06    | public MLE-bench leaderboard                                                                                |
| 26  | RE-Bench (METR)                                                                     | METR reference scaffolds (ReAct1 / Triframe)                           | frontier models, multiple              | used for time-horizon calibration, not single top score                             | 2024-26    | metr.org/AI_R_D_Evaluation_Report.pdf                                                                       |
| 27  | METR Time-Horizon 1.1                                                               | Triframe / ReAct1 scaffolds                                            | Claude/GPT/Gemini frontier set         | 50% task success at ~1-4hr horizon (model-dependent); >16hr "unreliable"            | 2026-01/05 | metr.org/time-horizons                                                                                      |
| 28  | METR "Claude Code vs Codex vs METR scaffolds" note                                  | Claude Code (as scaffold)                                              | Claude-class model                     | won only 50.7% of bootstrap comparisons vs METR's plain ReAct                       | 2026-02-13 | metr.org/notes (via search)                                                                                 |
| 29  | METR same note                                                                      | Codex CLI (as scaffold)                                                | GPT-class model                        | won only 14.5% of comparisons vs METR's Triframe                                    | 2026-02-13 | metr.org/notes                                                                                              |
| 30  | Aider Polyglot                                                                      | Aider architect+editor mode                                            | GPT-5 (high) planner                   | 88.0%                                                                               | 2026       | aider.chat/docs/leaderboards                                                                                |
| 31  | Aider Polyglot                                                                      | Aider architect+editor                                                 | GPT-5 (medium)                         | 86.7% (≈40% cheaper)                                                                | 2026       | aider.chat                                                                                                  |
| 32  | Aider Polyglot                                                                      | Aider single-model editor                                              | Gemini 2.5 Pro (32k thinking)          | 83.1%                                                                               | 2026       | aider.chat                                                                                                  |
| 33  | LiveCodeBench Pro                                                                   | (contest-style eval, Elo)                                              | Gemini 3.1 Pro                         | Elo 2887                                                                            | 2026       | llm-stats.com                                                                                               |
| 34  | SWE-Lancer                                                                          | (agentic freelance-task solver)                                        | GPT-5.1 Codex                          | 66.3%                                                                               | 2026       | llm-stats.com (self-reported, 0 independently verified)                                                     |
| 35  | Cybench (ICLR 2025 paper baseline)                                                  | Structured ReAct-style scaffold (Reflection/Plan/Thought/Log/Action)   | Claude 3.5 Sonnet                      | 17.5% unguided; +3.2pp with subtask guidance                                        | 2024-25    | arXiv:2408.08926                                                                                            |
| 36  | Cybench (2026 trackers)                                                             | alias3 harness                                                         | multi-provider frontier models, pass@3 | leads early-2026 snapshot                                                           | 2026       | Alias Robotics                                                                                              |
| 37  | Cybench (2026 trackers, divergent)                                                  | Muse Spark 1.1 harness                                                 | Meta model                             | 92.9%                                                                               | 2026-08    | BenchLM.ai                                                                                                  |
| 38  | AppWorld                                                                            | ReAct-style code-writing agent (write-and-execute Python against APIs) | GPT-4o/Claude-class (paper baseline)   | baseline reference architecture                                                     | 2024 (ACL) | appworld.dev / StonyBrookNLP                                                                                |
| 39  | TheAgentCompany                                                                     | ReAct/CodeAct-style office-work agent                                  | Gemini-2.5-Pro                         | ~30% full task completion (175 tasks)                                               | 2025-26    | TheAgentCompany (NeurIPS D&B 2025)                                                                          |
| 40  | Spider 2.0                                                                          | ReFoRCE (self-refinement + consensus + column exploration)             | GPT-4o/Claude-class                    | SOTA at publication                                                                 | 2025       | arXiv:2502.00675                                                                                            |
| 41  | BIRD-SQL (dev/test)                                                                 | Agentar-Scale-SQL (orchestrated test-time scaling)                     | frontier LLM ensemble                  | 74.90% dev / 81.67% test                                                            | 2025-09-28 | arXiv:2509.24403, bird-bench.github.io                                                                      |
| 42  | BIRD-SQL (earlier SOTA)                                                             | CHASE-SQL (multi-path reasoning + preference-optimized selection)      | Gemini-class                           | 73.0% test / 73.01% dev                                                             | 2024       | arXiv:2410.01943                                                                                            |
| 43  | ARC-AGI-2                                                                           | Frontier reasoning model + light harness (no heavy scaffold reported)  | GPT-6 "Astra"                          | 95%                                                                                 | 2026-09-10 | BenchLM.ai / arcprize.org                                                                                   |
| 44  | ARC-AGI-2                                                                           | —                                                                      | GPT-5.6 "Sol"                          | 92.5%                                                                               | 2026-09    | BenchLM.ai                                                                                                  |
| 45  | ARC-AGI-2                                                                           | —                                                                      | Claude Opus 5                          | 90.4%                                                                               | 2026-09    | BenchLM.ai                                                                                                  |
| 46  | HAL — USACO / CORE-bench / AssistantBench / SciCode / ScienceAgentBench (aggregate) | HAL-standardized scaffolds (framework-agnostic)                        | multiple, cost-tracked                 | Pareto frontier across 21,730 rollouts; up to 100x cost difference for 1pp accuracy | 2025-26    | arXiv:2510.11977 (HAL/ICLR 2026)                                                                            |

Notes on the table: entries 1–9, 12–13, 15–22, 28–29, 33–34, 37, 43–45 come from continuously
updated public leaderboards (tbench.ai, HAL, Steel.dev, BenchLM.ai, OpenRouter, llm-stats.com,
aider.chat) rather than vendor press releases. Entries 23–26, 30–32, 35–36, 38–42, 46 are grounded
in peer-reviewed or archival papers with independently reproducible numbers. Several aggregator
sites (pricepertoken.com, BenchLM.ai) mix self-reported and verified rows; where a "verified" flag
was available (e.g., SWE-Lancer: "0 verified / 4 self-reported") it is called out because it bears
directly on evidentiary trust.

---

## 2. Harness design features, by system (public architecture only)

### Terminus 2 (Terminal-Bench reference harness, Laude Institute/Stanford)

- **Tool interface**: single bash/terminal tool inside a sandboxed container per task; no bespoke
  tool schema beyond shell.
- **Planning/decomposition**: each turn the model must emit a structured JSON object with
  `analysis`, `plan`, `commands` (required) and an optional `task_complete` flag — i.e., explicit
  chain-of-thought-as-plan is enforced by the response schema, not left implicit.
- **Context management/compaction**: for long-running sessions that exceed the model's context
  budget, a dedicated summarization step invokes the LLM itself to produce a structured "handoff
  summary" so state survives across effectively unbounded token budgets (papers describe sessions
  "routinely exceeding" the model's native context window).
- **Verification**: task-level oracle test scripts (external, not part of the agent) grade
  pass/fail; the agent itself has no built-in self-check beyond the plan/commands loop.
- **Sandbox/isolation**: one container per task (Docker-based), matching the terminal-bench task
  format (instruction + test script + oracle solution).
- **Retries/step budgets**: harness supports concurrency controls (`--n-concurrent`) and per-task
  step/turn limits; exact numbers vary by submission config.
- **Test-time scaling**: leaderboard explicitly separates "harness+model" pairs; some entries
  (e.g., "vix") are themselves research scaffolds layering extra machinery over a base model,
  demonstrating that harness choice alone moves rank order independent of model.

### mini-SWE-agent (100-line reference agent, used across SWE-bench and Terminal-Bench-adjacent work)

- **Tool interface**: bash is the _only_ tool — no structured function-calling schema at all,
  deliberately trading tool richness for model-agnosticism (works with any LLM, not just
  tool-call-tuned ones).
- **Loop design**: strictly linear message history — "no difference between the trajectory and the
  messages passed to the LM." Every step appends to one growing transcript; no separate
  planner/executor split.
- **Context management**: none beyond the raw linear transcript — this is a deliberate minimalism
  argument (simplicity aids debugging/fine-tuning, at the cost of unbounded context growth on long
  tasks).
- **Sandboxing**: stateless `subprocess.run` per action, pluggable into Docker, Podman,
  Singularity/Apptainer, or Bubblewrap — statelessness is what makes swapping sandboxes trivial.
- **Verification/self-check**: none built in; relies entirely on external benchmark graders.
- **Reported results**: >74% on SWE-bench Verified with a ~100-line agent, evidence that scaffold
  _complexity_ is not what drives frontier scores — model quality dominates once a minimal
  tool-use loop exists.

### AIDE (MLE-bench's best-performing scaffold)

- **Planning/decomposition**: agentic **tree search** over code, not a single linear rollout —
  each candidate Python script is a tree node; LLM-generated patches spawn children.
- **Verification/test-time scaling**: node fitness is scored by the task's own metric (e.g.,
  Kaggle leaderboard metric on a held-out validation split), and metric feedback prunes/guides
  which branches get expanded — this is a built-in best-of-N / beam-search verifier loop, not just
  single-shot generation.
- **Reported ablation**: AIDE's tree search wins **4× more medals** than the best purely linear
  (single-trajectory) agent on the same 75 MLE-bench competitions — a concrete, quantified case of
  test-time-scaling/search beating a bigger single rollout.
- **Sandbox**: each candidate script executes in an isolated run to obtain the metric.

### METR reference scaffolds (ReAct1, Triframe) and independent scaffold audits

- METR deliberately maintains its **own** generic scaffolds (a ReAct-style loop and a
  "Triframe" multi-role scaffold) as the primary instrument for time-horizon measurement, rather
  than adopting vendor CLIs, specifically to keep elicitation comparable model-to-model.
- METR spent an estimated **2-3 engineer-weeks per model** tuning scaffolds — a data point on how
  much of "frontier" benchmark performance is elicitation effort rather than raw model capability.
- METR distinguishes "low-elicitation" (plain scaffold, single rollout) vs "high-elicitation"
  estimates (best publicly known scaffold **plus** inference-time compute techniques such as
  best-of-N), and explicitly flags that some tasks are not suited to best-of-K scaffolding at all.
- **Head-to-head scaffold test (2026-02-13 METR note)**: pitting the vendor-native harnesses
  (Claude Code, Codex CLI) against METR's own generic scaffolds on the _same_ models and tasks,
  Claude Code beat METR's plain ReAct loop in only **50.7%** of bootstrap samples (i.e.,
  statistically indistinguishable from a coin flip), and Codex CLI beat METR's Triframe scaffold in
  only **14.5%** of samples (i.e., the specialized, product-grade CLI scaffold _underperformed_ a
  generic research scaffold on METR's task suite). This is one of the strongest pieces of causal
  evidence in this research slice that a heavily engineered, product-oriented harness does not
  automatically transfer its advantage to a different task distribution.

### GAIA scaffold ablation (arXiv:2606.08529, "Scaffold Effects on GAIA: A Controlled Comparison")

- Pre-registered, controlled comparison of **three scaffolds** — plain ReAct, a
  Planner-Actor-Rater multi-agent design, and a planner-then-executor split — crossed with
  **five models** from three providers (Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5; Gemini 3.1 Pro
  Preview; GPT-5.5), three attempts per question, on GAIA validation Levels 1-2.
- **Headline number**: scaffold choice alone moved measured accuracy by **up to 28 percentage
  points** for the same model (Opus 4.7, Level 2, robust slice) — confirming a pre-registered
  hypothesis that scaffold variance would exceed 10pp.
- The pre-registered prediction that _more capable models would be less scaffold-sensitive_ was
  **rejected in direction**: scaffold sensitivity did not shrink monotonically with model strength
  and varied idiosyncratically by model and data slice. In other words, you cannot assume a
  stronger base model "outgrows" the need for harness engineering.

### Cybench structured scaffold (ICLR 2025)

- Response schema modeled on Reflexion/ReAct: **Reflection, Plan-and-Status, Thought, Log,
  Action** fields per turn — an explicit self-critique step (Reflection) is baked into the
  protocol, distinct from plain ReAct's Thought/Action.
- Four scaffold variants were ablated head-to-head on the same models: structured-bash,
  action-only, pseudoterminal, and web-search-augmented — isolating tool-interface effects from
  model effects.
- **Subtask decomposition as scaffolding**: giving the agent the competition's own subtask
  breakdown (a form of externally supplied plan/decomposition) raised success rate by **+3.2
  percentage points** on complete-task solve rate versus the unguided condition, and the
  best unguided model (Claude 3.5 Sonnet) reached only 17.5% vs GPT-4o's 29.4% _with_ subtask
  guidance — showing decomposition granularity is worth more than raw model choice at the margin.

### Aider (architect/editor split)

- **Planning/decomposition as an explicit two-model pipeline**: a "planner" model (architect)
  proposes the diff/plan in natural language; a separate, often cheaper, "editor" model turns that
  plan into an exact source-code diff. This is a clean example of decomposition (reasoning vs.
  mechanical edit-application) improving cost/accuracy jointly — architect+editor rows on the
  Polyglot leaderboard are explicitly marked as _system_ results, not single-model numbers, because
  the split materially changes measured accuracy versus using one model for both roles.
- **Verification**: Aider applies the edit and then runs the target language's own test/lint
  tooling; on failure it can feed errors back for another edit attempt (a lightweight retry loop),
  though the polyglot leaderboard reports pass@N under a fixed attempt budget.

### Browser-use / Online-Mind2Web-style browser agents

- **Tool interface**: DOM-element-indexed actions (click/type/scroll against a numbered list of
  interactive elements) rather than raw pixel coordinates or a single freeform "browser" tool —
  the MindAct architecture underlying Mind2Web is explicit about this: a small ranking model
  filters candidate DOM elements, then a large model chooses/parameterizes the action from the
  short list (a retrieve-then-reason pattern that keeps the LLM's action space bounded and
  grounded, rather than hallucinating selectors).
- **Verification**: Online-Mind2Web moved from static, cached-page evaluation to live sites
  specifically because static Mind2Web scores were showing an "illusion of progress" — outcome
  checking now uses an automated judge (WebJudge) or human review against live, evolving pages,
  which is a harder and more externally valid verification signal than string-matching a cached
  DOM.

### AppWorld reference agent

- **Tool interface**: agent writes and executes arbitrary **Python code** against 457 documented
  simulated APIs across 9 apps, rather than calling a fixed function-call schema — closer to
  code-agent (CodeAct-style) design than JSON tool calls.
- **Documented failure modes** (from the benchmark's own error analysis) map directly onto missing
  harness features: **API confusion** (agent invents nonexistent methods — argues for a
  tool/API-signature verification step), **state-tracking drift** over long multi-step scenarios
  (argues for explicit memory/state-tracking scaffolding), and **hallucinated entities** (argues
  for grounding/verification against the live environment before acting).

### AIDE/MLE-bench, Spider 2.0's ReFoRCE, and BIRD's Agentar-Scale-SQL all converge on the same

pattern for structured-output domains (ML pipelines, SQL): **self-refinement + column/schema
exploration + a consensus or voting step across multiple candidate generations**, i.e., verifier-
gated best-of-N rather than single-shot generation. Agentar-Scale-SQL's name itself signals
"orchestrated test-time scaling" as the mechanism credited for its BIRD SOTA (74.9% dev / 81.67%
test, versus CHASE-SQL's earlier 73%/73%).

---

## 3. Synthesis: what's shared, what ablations show, and does more scaffolding always help?

**Shared features across top/independently-verified entries:**

1. **Explicit plan-then-act structuring, not free-form chat.** Terminus 2 forces a JSON
   `analysis/plan/commands` schema every turn; Cybench's scaffold forces
   `Reflection/Plan-and-Status/Thought/Log/Action`; Aider explicitly separates a planner
   (architect) from an executor (editor). Even AppWorld's code-writing agent is effectively
   "plan implicitly via code structure." The common thread: benchmarks that expose the harness
   design reward _making the plan a first-class, checkable artifact_ rather than trusting the
   model's latent reasoning alone.
2. **Verifier-gated test-time scaling beats single-shot generation whenever a benchmark supplies
   a cheap-to-check metric.** AIDE's tree search (MLE-bench) wins 4x more medals than a linear
   agent; Agentar-Scale-SQL's "orchestrated test-time scaling" set the BIRD SOTA over a
   single-pass system (CHASE-SQL); Cybench's subtask-guidance is effectively a cheap decomposition
   that substitutes for expensive search. This pattern fails or is unavailable exactly where no
   cheap verifier exists (open-ended GAIA/BrowseComp research tasks, TheAgentCompany's messy
   office tasks) — and indeed those are the domains where scores are lowest (~30% on
   TheAgentCompany, sub-20% unguided on Cybench) and where scaffold _variance_ is highest (up to
   28pp on GAIA).
3. **Context compaction is treated as a first-class engineering problem, not an afterthought**,
   specifically in long-horizon terminal/coding tasks: Terminus 2's LLM-generated "handoff
   summaries" and the broader Terminal-Bench-adjacent literature (e.g., "Building Effective AI
   Coding Agents for the Terminal: Scaffolding, Harness, Context Engineering," and "A Self-Evolving
   Framework for Efficient Terminal Agents via Observational Context Compression") treat context
   management as a distinct, publishable sub-problem, separate from raw model capability.
4. **Sandboxed, isolated, reproducible execution is table stakes** across every benchmark that
   lets an agent run code or shell commands (Terminal-Bench containers, AIDE per-candidate runs,
   mini-SWE-agent's pluggable Docker/Podman/Bubblewrap backends, AppWorld's controlled simulation).
   None of the top entries skip sandboxing; the differentiation is entirely in what happens
   _inside_ the sandbox (single linear loop vs. tree search vs. multi-agent).
5. **Grounding the action space beats enlarging the model's freedom.** Browser agents that
   constrain actions to a short, ranked list of DOM elements (MindAct/Mind2Web lineage) and
   AppWorld's API-signature grounding both target the same failure mode — hallucinated actions —
   that dominates real agent errors more than raw reasoning failures do.

**Cross-harness ablations with numbers, and what they show about "does more scaffolding help":**

- **Terminal-Bench 2.1 same-model, different-harness**: GPT-5.5 scores 83.4% under Codex CLI (a
  heavily product-engineered, purpose-built harness) but only 76.4% under the standardized
  Terminus 2 research harness — a **7-point swing from harness alone**, holding the model fixed.
  This shows harness engineering _does_ help, but also that leaderboard rank is not portable
  across harnesses — a model's "true" capability is under-determined by any single harness score.
- **GAIA controlled scaffold study**: up to **28-point swing** for the same model across three
  scaffolds, and — counterintuitively — this scaffold-sensitivity does _not_ shrink as models get
  more capable. More scaffolding effort clearly matters, but its payoff is not predictable from
  model tier alone; it must be measured per model, per task family.
- **METR's specialized-vs-generic scaffold test** is the sharpest "more scaffolding ≠ always
  better" data point in this slice: a product-grade, heavily maintained harness (Claude Code) only
  ties a plain research ReAct loop (50.7% win rate — statistical noise), and another product-grade
  harness (Codex CLI) _loses_ to a generic multi-role scaffold (Triframe) 85.5% of the time. The
  implication: harnesses tuned for one distribution (interactive coding sessions, developer UX)
  do not automatically generalize to a different distribution (long-horizon autonomous R&D-style
  tasks), and "more engineering" invested in a harness can even be _negatively_ transferable.
- **HAL's cost-accuracy Pareto analysis**: across 21,730 rollouts (model × scaffold × benchmark),
  HAL finds up to a **100x cost differential for a 1-percentage-point accuracy gain** — i.e., past
  a certain point, additional scaffolding/inference compute (more rollouts, more tool calls,
  bigger context, multi-agent overhead) buys vanishingly small accuracy improvements at
  exponentially increasing cost. This is the clearest quantitative statement that scaffolding has
  strongly diminishing, and eventually negative-ROI, returns.
- **Cybench subtask decomposition**: a _cheap_ form of scaffolding (handing the agent an existing
  task decomposition) produces a reliable but modest +3.2pp gain — a case where lightweight
  scaffolding (decomposition without added search/compute) is unambiguously positive-ROI, in
  contrast to expensive multi-agent or tree-search scaffolding whose ROI is benchmark-dependent.
- **AIDE tree search vs. linear agent on MLE-bench**: 4x medal-rate improvement from adding
  search/verification alone (holding the base model fixed) — the single largest, most
  unambiguous "scaffolding helps enormously" data point in the whole slice, precisely because
  MLE-bench supplies a near-free, high-fidelity verifier (the competition metric) that makes
  search cheap to score.

**Net answer to "does more scaffolding always help?"**: No. The evidence splits cleanly by
whether a _cheap, reliable verifier_ exists for the task. Where one does (Kaggle-style ML
competitions, SQL execution accuracy, terminal task oracle scripts), search/best-of-N/tree-search
scaffolding shows large, reproducible gains (AIDE's 4x, Agentar-Scale-SQL's SOTA). Where no cheap
verifier exists and success is judged by an LLM-judge or human rater (GAIA, BrowseComp, terminal
long-horizon research-style tasks, TheAgentCompany), scaffolding effects are large in magnitude
but unpredictable in sign and direction (28pp swings, non-monotonic with model capability,
specialized harnesses sometimes _underperforming_ generic ones), and HAL's Pareto data shows the
marginal accuracy return on marginal scaffolding cost collapses well before scaffolding
sophistication is exhausted. The practical implication echoed across every independent
cross-harness comparison found here: harness choice is not a fixed multiplier you can assume
transfers from one benchmark/model to the next — it must be measured per (model, task
distribution) pair, exactly as HAL, METR, and the GAIA scaffold-ablation paper each independently
argue.

---

## Key sources

- tbench.ai Terminal-Bench 2.0/2.1 leaderboards; Snorkel AI and CodingFleet leaderboard mirrors
- hal.cs.princeton.edu and arXiv:2510.11977 ("Holistic Agent Leaderboard," ICLR 2026)
- Steel.dev aggregator (leaderboard.steel.dev) for WebArena/OSWorld/Online-Mind2Web/AgentBench/GAIA
- OpenRouter τ²-bench tracker; sierra-research/tau2-bench (GitHub)
- METR: metr.org/time-horizons, metr.org/AI_R_D_Evaluation_Report.pdf (RE-Bench),
  metr.org/notes/2026-02-13-measuring-time-horizon-using-claude-code-and-codex
- arXiv:2606.08529 "Scaffold Effects on GAIA: A Controlled Comparison"
- OpenAI MLE-bench paper (arXiv:2410.07095) and WecoAI/aideml (GitHub)
- arXiv:2408.08926 "Cybench" (ICLR 2025)
- appworld.dev / StonyBrookNLP/appworld (GitHub, ACL 2024 Best Resource Paper)
- TheAgentCompany (NeurIPS 2025 Datasets & Benchmarks track)
- arXiv:2502.00675 "ReFoRCE" (Spider 2.0); arXiv:2509.24403 "Agentar-Scale-SQL"; bird-bench.github.io
- aider.chat/docs/leaderboards; SWE-agent/mini-swe-agent (GitHub)
- arcprize.org leaderboard; BenchLM.ai / llm-stats.com aggregate trackers
