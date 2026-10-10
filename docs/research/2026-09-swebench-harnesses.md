# SWE-bench-family leaderboards: what externally-graded harnesses actually do

Scope: SWE-bench Verified/Lite/Full, SWE-bench Pro (Scale AI), SWE-bench Multimodal, Multi-SWE-bench,
SWE-bench-java, SWE-PolyBench, SWE-rebench (Nebius), SWE-Gym — as surfaced by leaderboard sites,
peer-reviewed papers, and independent audits as of September 2026. Vendor blog claims are included
only when they correspond to a leaderboard entry or a peer-reviewed paper; pure marketing claims are
flagged as such.

Note on access: swebench.com and arxiv.org direct fetches were blocked by this session's egress proxy;
all data below comes from search-engine-surfaced excerpts of those same pages/papers (leaderboard
mirrors — llm-stats.com, BenchLM.ai, Steel.dev, benchmarklist.com — and paper abstracts/summaries via
WebSearch). Numbers should be treated as directionally reliable but re-verified against swebench.com
before being used in anything load-bearing; several papers below (UTBoost, SWE-ABS, AgentLens) exist
specifically because leaderboard numbers have proven to be non-reproducible or inflated.

---

## 1. Harness / entry table (35+ distinct entries)

| #   | Name                                                                     | Leaderboard                             | Score                                                                                   | Date              | Link                                                         |
| --- | ------------------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------ |
| 1   | SWE-agent (ACI)                                                          | SWE-bench Full / Lite                   | 12.47% Full, 18.0% Lite (GPT-4 Turbo)                                                   | 2024-05           | arxiv.org/abs/2405.15793                                     |
| 2   | Agentless (v1)                                                           | SWE-bench Lite                          | 27.33%(GPT-4o)/32.0% best reported                                                      | 2024-07           | arxiv.org/abs/2407.01489, github.com/OpenAutoCoder/Agentless |
| 3   | Agentless-1.5 + Claude 3.5 Sonnet                                        | SWE-bench Lite/Verified                 | 50.8% (Verified), 38–40% (Lite)                                                         | 2024-10/11        | swebench.com/experiments                                     |
| 4   | AutoCodeRover v1                                                         | SWE-bench Lite                          | 19% (single), 26% (3 attempts), later 38.4% Lite                                        | 2024-04           | arxiv.org/abs/2404.05427                                     |
| 5   | AutoCodeRover v2.0 + Claude 3.5 Sonnet                                   | SWE-bench Lite/Verified                 | 46.2% Lite, 30.67% Verified                                                             | 2024-10           | github.com/AutoCodeRoverSG/auto-code-rover                   |
| 6   | SpecRover (AutoCodeRover extension)                                      | SWE-bench                               | (intent-extraction variant, no single official % surfaced)                              | 2024-11 (ICSE'25) | abhikrc.com/pdf/ICSE25.pdf                                   |
| 7   | Moatless Tools + Claude 3.5 Sonnet                                       | SWE-bench Lite                          | 38.33%/36.67%                                                                           | 2024-10           | github.com/aorwall/moatless-tools                            |
| 8   | Moatless-tree-search / SWE-Search (MCTS)                                 | SWE-bench Lite                          | improves over linear Moatless baseline (ICLR 2025)                                      | 2024-10           | arxiv.org/abs/2410.20285                                     |
| 9   | OpenHands (CodeAct 2.1)                                                  | SWE-bench Verified                      | 53.0%                                                                                   | 2024-11           | openhands.dev/blog                                           |
| 10  | OpenHands + Claude Sonnet 4.5                                            | SWE-bench Verified                      | ~77%                                                                                    | 2025-26           | openhands.dev                                                |
| 11  | Nemotron-CORTEXA (NVIDIA)                                                | SWE-bench Verified                      | 68.2%                                                                                   | 2025              | research.nvidia.com/labs/adlr/cortexa                        |
| 12  | Trae Agent (ByteDance), single-agent                                     | SWE-bench Verified                      | 70.6%                                                                                   | 2025-05           | se-research.bytedance.com                                    |
| 13  | Trae Agent, test-time-scaling ensemble                                   | SWE-bench Verified                      | 75.20% (Pass@1); +10.22% avg over baselines                                             | 2025-07           | arxiv.org/abs/2507.23370, github.com/bytedance/trae-agent    |
| 14  | SWE-Gym fine-tuned agent (32B)                                           | SWE-bench Verified/Lite                 | 32.0% Verified, 26.0% Lite (open-weight SOTA at release)                                | 2024-12           | github.com/SWE-Gym/SWE-Gym                                   |
| 15  | OpenHands LM 32B (trained on SWE-Gym)                                    | SWE-bench Verified                      | 37%                                                                                     | 2025              | all-hands.dev                                                |
| 16  | R2E-Gym (hybrid verifiers, open-weight)                                  | SWE-bench Verified                      | scaling study, no single flagship % surfaced                                            | 2025-04           | arxiv.org/abs/2504.07164                                     |
| 17  | Alibaba LingmaAgent + Lingma SWE-GPT 72B                                 | SWE-bench Verified/Lite                 | 28.80% Verified; +18.5% relative over SWE-agent (Lite)                                  | 2024-06/11        | arxiv.org/abs/2406.01422, arxiv.org/abs/2411.00622           |
| 18  | Refact.ai Agent                                                          | SWE-bench Verified                      | 70.4% (#1 open-source at release)                                                       | 2025              | refact.ai/blog                                               |
| 19  | Amazon Q Developer Agent (v20241202-dev)                                 | SWE-bench Verified                      | 55.00%                                                                                  | 2024-12           | swebench.com/viewer                                          |
| 20  | devlo                                                                    | SWE-bench Verified                      | 54.20%                                                                                  | 2024-12           | swebench.com/viewer                                          |
| 21  | CodeStory "Midwit" Agent                                                 | SWE-bench Verified                      | listed (score not confirmed this pass)                                                  | 2024-25           | swebench.com/viewer                                          |
| 22  | Blackbox AI Agent                                                        | SWE-bench Verified                      | listed (score not confirmed this pass)                                                  | 2024-25           | swebench.com/viewer                                          |
| 23  | Gru                                                                      | SWE-bench Verified                      | listed (score not confirmed this pass)                                                  | 2024-25           | swebench.com/viewer                                          |
| 24  | IBM iSWE-Agent (Claude 4.5 Sonnet backend)                               | Multi-SWE-bench (Java)                  | #1 in Java category                                                                     | 2025-26           | research.ibm.com/blog                                        |
| 25  | IBM iSWE-OpenModels                                                      | Multi-SWE-bench (Java)                  | 31% (best open-model Java entry)                                                        | 2025-26           | research.ibm.com/blog                                        |
| 26  | SWE-agent on SWE-bench-java-verified                                     | SWE-bench-java                          | 1.10%–9.89% across models                                                               | 2024-08           | arxiv.org/abs/2408.14354                                     |
| 27  | MiniMax M2.7 (agent+model, self-reported)                                | Multi-SWE-bench                         | 0.527 (0–1 scale)                                                                       | 2026-05           | llm-stats.com/benchmarks/multi-swe-bench                     |
| 28  | mini-SWE-agent (bash-only, ~100 LOC)                                     | SWE-bench Verified                      | >74% (model-dependent; no tool-calling API needed)                                      | 2025              | github.com/SWE-agent/mini-swe-agent                          |
| 29  | Live-SWE-agent + Claude Opus 4.5                                         | SWE-bench Verified                      | 79.2% (near Anthropic's own internal scaffold)                                          | 2025-11           | arxiv.org/abs/2511.13646, live-swe-agent.github.io           |
| 30  | Live-SWE-agent + Gemini 3 Pro                                            | SWE-bench Verified                      | 77.4%                                                                                   | 2025-11           | live-swe-agent.github.io                                     |
| 31  | Live-SWE-agent + Claude Sonnet 4.5                                       | SWE-bench Pro                           | 45.8% (new SOTA on Pro at release)                                                      | 2025-11           | live-swe-agent.github.io                                     |
| 32  | PatchPilot                                                               | SWE-bench Lite                          | 45.33% (136/300), $0.97/instance                                                        | 2025-02 (ICML'25) | arxiv.org/abs/2502.02747                                     |
| 33  | SWE-Replay (efficient test-time scaling)                                 | SWE-bench Verified                      | up to 17.4% lower cost at equal/better resolve rate vs naive scaling                    | 2026-01           | arxiv.org/abs/2601.22129                                     |
| 34  | DeepSWE (RL-trained, open-weight)                                        | SWE-bench (long-horizon variant)        | reported as frontier open-weight agent                                                  | 2026-07           | arxiv.org/abs/2607.07946                                     |
| 35  | Scale AI standardized harness — "Muse Spark 1.1"                         | SWE-bench Pro (public set)              | 61.5%                                                                                   | 2026-09           | labs.scale.com/leaderboard/swe_bench_pro_public              |
| 36  | Claude Fable 5.1 (Anthropic scaffold)                                    | SWE-bench Pro (3rd-party platform)      | 81.2%                                                                                   | 2026-09           | benchlm.ai/benchmarks/swe-bench-pro                          |
| 37  | Anthropic "Claude Code"-style internal scaffold + Opus/Fable models      | SWE-bench Verified                      | 95–96% cluster (top-3 within ~1 pt)                                                     | 2026-09           | leaderboard.steel.dev, benchlm.ai                            |
| 38  | Google internal scaffold + Gemini 3(.1) Pro                              | SWE-bench Verified/rebench              | ~77–80%                                                                                 | 2026              | multiple leaderboard mirrors                                 |
| 39  | GLM-5 / GLM-5.1 (Zhipu, fixed ReAct scaffold)                            | SWE-rebench                             | 62.8% / 62.7%                                                                           | 2026-08           | huggingface.co/datasets/nebius/SWE-rebench-leaderboard       |
| 40  | Claude Opus 4.6 (fixed ReAct scaffold)                                   | SWE-rebench                             | 65.3% (leader)                                                                          | 2026-08           | benchlm.ai/benchmarks/swe-rebench                            |
| 41  | Claude Mythos Preview (agent+browsing)                                   | SWE-bench Multimodal                    | 0.590 (leader, 0–1 scale)                                                               | 2026              | llm-stats.com/benchmarks/swe-bench-multimodal                |
| 42  | Amazon SWE-PolyBench baseline agents (multi-language)                    | SWE-PolyBench (Verified, 382 instances) | per-language pass rates + localization precision/recall (no single headline % surfaced) | 2025-04           | github.com/amazon-science/SWE-PolyBench                      |
| 43  | Qwen3-4B (DAgger-trained on SWE-Gym data)                                | SWE-bench Verified                      | 27.3%                                                                                   | 2026              | arxiv.org/abs/2605.12913                                     |
| 44  | Qwen3-8B (DAgger-trained on SWE-Gym data)                                | SWE-bench Verified                      | 29.8%                                                                                   | 2026              | arxiv.org/abs/2605.12913                                     |
| 45  | HAL (Holistic Agent Leaderboard) reference runs, SWE-bench Verified Mini | cross-benchmark, cost-controlled        | 21,730 rollouts / 9 models / 9 benchmarks, ~$40k compute                                | 2025-10           | arxiv.org/abs/2510.11977                                     |

Additional entries seen listed on the live swebench.com viewer but whose numeric scores could not be
independently re-confirmed this pass (flagged, not fabricated): Zencoder, Augment Agent, Warp, Bloop,
Isoform, Factory AI, W&B "Programmer" (O1 self-consistency ensemble), Composio, Globant, Emergent,
Kodu — these should be pulled directly from swebench.com/viewer.html when that domain is reachable.

---

## 2. Architecture features, where publicly documented

**SWE-agent (ACI).** The foundational open-source harness. Core contribution is the Agent-Computer
Interface: a small, guarded action set (view/search/edit/execute) instead of raw shell access, a
100-line "windowed" file viewer (empirically the optimum window size), and a custom `edit` command with
integrated linting that alone added ~3.0 points. Concise per-turn feedback (guardrails against common
mistakes) rather than raw stdout. No test-time scaling, no verifier, single rollout, iteration-capped
ReAct loop. This "constrained ACI beats raw bash" result was later partly reversed by mini-SWE-agent
(below), which shows a raw bash-only interface can also reach high scores if the underlying model is
strong enough — suggesting ACI matters more for weaker/older models than for frontier ones.

**Agentless.** Deliberately _not_ agentic: no LLM-driven action loop. Fixed three-phase pipeline —
(1) hierarchical localization (file → class/function → edit location), (2) repair (multiple diff-format
candidate patches sampled per bug), (3) validation (regression test selection + LLM-generated
reproduction tests to filter candidates). No tool-use decisions, no dynamic planning. Matched or beat
contemporary agentic systems at a fraction of the cost ($0.34–0.70/bug vs several dollars for agentic
peers), which became the central data point cited against "give the model more autonomy" designs.

**AutoCodeRover / SpecRover.** Program-structure-aware localization: searches over AST
(class/method-level) representations rather than plain-text/BM25 retrieval, plus spectrum-based fault
localization (SBFL) using test executions to rank suspicious methods, fed to the LLM as hints. Multiple
attempts (3x) materially improve resolve rate (19%→26% on Lite), an early empirical data point for
test-time scaling via repetition alone (no verifier beyond re-sampling).

**Moatless Tools / Moatless-Tree-Search / SWE-Search.** Decouples the "inner" LLM action policy from
the "outer" control-flow: the same ActionAgent can be driven by a simple ReAct loop (`AgenticLoop`) or by
a `SearchTree` doing MCTS (Select-Expand-Simulate-Backpropagate with a learned/heuristic reward and
per-node file-context snapshots). This is one of the clearest published examples of harness-level
test-time compute: multiple candidate trajectories are grown and pruned by a reward signal rather than
independently sampled and majority-voted.

**OpenHands (CodeAct family).** Minimal core loop (stateless Agent emits Actions → Conversation runs an
append-only EventLog → sandboxed Workspace, local process or Docker, executes and returns Observations),
with LiteLLM abstracting the model provider. Auxiliary services hang off the event stream: memory
compression/context pruning, "microagent" injected domain knowledge, sub-agent delegation, a stuck-state
detector, and a security review pass. Function-calling (vs free-text action parsing) was a documented
jump from CodeAct 1.x to 2.1 (53% Verified). Score has since risen to ~77% purely by swapping in stronger
backend models (Claude Sonnet 4.5) with the same scaffold — direct evidence that scaffold and model
contribute somewhat independently to score.

**Nemotron-CORTEXA (NVIDIA).** Two-stage localization (file-level, then class-level) + repair, tuned for
solution diversity; reports beating OpenAI's o3-based agent (66%) at 68.2% while costing only
$3.28/instance — cited as one of the best cost/performance points on the Verified leaderboard.

**Lingma Agent (Alibaba).** Repository-level understanding via a top-down repository knowledge graph
(compress the whole repo before reasoning) plus MCTS-based exploration of that graph, aimed specifically
at large/complex repos where flat retrieval fails. Also fields a purpose-trained model (Lingma SWE-GPT)
rather than relying purely on a frontier general model — one of few open efforts to co-design harness and
model together and report both a leaderboard number (28.80% Verified) and a real deployment number
(16.9% auto-resolved / 43.3% after human triage in Alibaba's internal issue tracker).

**Trae Agent (ByteDance).** Explicitly frames the harness as an "ensemble reasoning" / search problem:
modular sub-agents for generation, pruning, and selection of candidate solutions, with a test-time
scaling knob that trades inference cost for resolve rate monotonically (no plateau/regression reported
up to their tested ensemble sizes). Went from #1 at 70.6% (single-agent) to 75.20% Pass@1 purely by
adding the ensemble layer — a clean before/after ablation of "test-time compute via multiple rollouts +
selection" on the same base model.

**Live-SWE-agent.** The newest architectural idea in this set: the agent generates and installs _new
tools for itself at runtime_ while solving a task (an online self-evolution loop), instead of a fixed
tool palette decided at design time. With Claude Opus 4.5 it reaches 79.2% Verified — close to
Anthropic's own manually-engineered internal scaffold — and with Claude Sonnet 4.5 sets a new SOTA
(45.8%) on the much harder SWE-bench Pro, suggesting the runtime-tool-authoring idea transfers better to
harder/less-templated tasks than to the now-near-saturated Verified set.

**mini-SWE-agent.** The minimalist counterpoint: ~100 lines of code, bash-only tool surface, no
tool-calling API required at all (works with any model, even ones without native function calling), and
still clears 74%+ Verified with a strong backend. Directly informs the synthesis question "does a
structured tool interface matter": for frontier 2025-26 models the marginal benefit of an elaborate ACI
over raw bash appears to have shrunk a lot relative to the 2024 SWE-agent era.

**PatchPilot.** Rule-based (not free-form-agentic) five-stage pipeline: reproduction → localization →
generation → validation → refinement, plus an early attempt at _formal_ verification (LLM generates a
spec, a Z3 SMT solver checks the patch against it) — though only 11 of the resolved Lite patches were
actually formally verified, showing formal verification is still a minor, expensive addition rather than
a general-purpose gate. $0.97/instance, 45.33% Lite — another cost/performance-Pareto entry.

**Agentless / PatchPilot / Nemotron-CORTEXA / SWE-Gym** together are the clearest "non-agentic or
constrained-agentic beats free-form ReAct on cost" data points on these leaderboards.

**SWE-Gym / R2E-Gym / OpenHands-LM / DAgger-on-SWE-Gym (Qwen3-4B/8B).** These are training
environments/recipes rather than inference-time harnesses, but they matter for the harness question
because they show a harness's _verifier_ can double as a _training signal_: SWE-Gym pairs task
environments with trained verifiers and reports up to +19 points absolute from training alone (holding
the base model family roughly fixed), and R2E-Gym's "hybrid verifiers" (execution-based + learned) is
used both to filter training trajectories and to rank candidate patches at inference time.

**Terminal-native harness engineering ("Building Effective AI Coding Agents for the Terminal" /
OPENDEV).** Not itself leaderboard-ranked, but a rare open architectural write-up of a production CLI
agent: workload-specialized model routing (cheap model for simple steps, expensive model for hard
reasoning — a pattern also flagged independently by the "Inside the Scaffold" taxonomy paper below), a
dual-agent split between planning and execution, lazy tool discovery (only surface tools when needed,
rather than dumping a large tool schema into context up front), and adaptive context compaction that
progressively summarizes/drops older observations as the transcript grows.

---

## 3. Synthesis

**What's common among top-10-class entries (2025-26 vintage: Trae Agent ensemble, Live-SWE-agent,
Refact.ai, OpenHands+Sonnet 4.5, Nemotron-CORTEXA, Anthropic/Google internal scaffolds):**

1. _A localization step that is not purely "dump the whole repo in context."_ Every top system uses
   either structured retrieval (BM25/embedding), AST/graph-aware search (AutoCodeRover, Lingma), or an
   agent-driven exploratory search loop — but crucially, they narrow scope before or during repair rather
   than relying on ever-larger context windows alone.
2. _Some form of verification loop before submitting a patch._ Test execution (existing regression
   suite), LLM-generated reproduction tests (Agentless, PatchPilot), or a learned/reward-based verifier
   (R2E-Gym, SWE-Gym, Moatless MCTS reward) recur across nearly every top-half system with a public
   architecture. Systems without any such check (early single-shot ReAct loops) cluster lower.
3. _Some test-time compute beyond a single rollout_ — repeated attempts (AutoCodeRover 19%→26%),
   ensembling with a pruning/selection stage (Trae Agent 70.6%→75.2%), or tree search with a reward model
   (Moatless/SWE-Search) — is present in essentially every system that jumped to the top of a leaderboard
   after a prior single-rollout baseline, and every published ablation of "add rollouts" shows a positive,
   often monotonic, effect (Trae Agent explicitly reports monotonic improvement with ensemble size; SWE-
   Replay shows the same gains obtainable at up to 17.4% lower cost by being selective about which
   rollouts to continue).
4. _Sandboxing/containerized execution_ is universal among agentic (non-Agentless) top systems — needed
   both to run tests safely and, per OpenHands' architecture, to isolate side effects; "SWE-World"
   explicitly studies Docker-free alternatives because container overhead is now a recognized cost/latency
   bottleneck at scale.
5. _Context management as a first-class concern, not an afterthought_, in every system whose internals
   are documented past 2025: OpenHands' auxiliary memory-compression service, OPENDEV's adaptive
   compaction and lazy tool discovery, Lingma's whole-repo knowledge-graph compression, and "structured
   memory" and "structural codebase index" papers all target the same failure mode — "Coherence Collapse"
   (agents that find the right code early but then degrade through the rest of a long trajectory) is
   explicitly documented as a distinct, common failure class in 2026 papers, independent of model choice.

**What's largely absent from bottom-of-leaderboard / older entries:** no localization stage (flat
whole-repo prompting), no verification (patch submitted on first LLM output with no test run), single
rollout only, and — per "Inside the Scaffold" — either zero LLM-callable tools (raw text generation into
a diff) or an unconstrained, ungraded action space with no guardrails (the original motivation for
SWE-agent's ACI in 2024). The taxonomy paper's cross-cutting finding is that despite huge variance in
raw tool-count (0 to 37 action classes across 13 open agents studied), four capability categories —
read, search, edit, execute — appear in literally every agent that is given any autonomy at all; harnesses
differ in how these are packaged/guarded, not in whether they exist.

**Where ablations give numbers, not just direction:**

- SWE-agent's windowed file viewer + custom `edit`-with-linting: ~+3.0 points from the edit command alone;
  window size tuned empirically (100 lines optimal on their setup).
- Agentless vs. contemporary agentic systems: comparable or higher resolve rate at $0.34–0.70/bug vs.
  multi-dollar agentic runs — the single most-cited "structured/constrained pipeline beats free agentic
  loop, on cost" data point in this space.
- AutoCodeRover: 19%→26% (+7 points) from single-attempt to 3-attempt sampling, no verifier beyond
  re-sampling — an early, clean test-time-scaling-without-verifier data point.
- Trae Agent: +10.22% average Pass@1 over baselines from its generation/pruning/selection ensemble;
  monotonic improvement with ensemble size (explicit dial for cost/quality tradeoff).
- SWE-Gym: up to +19 points absolute on Verified/Lite purely from training on agent-generated
  trajectories + verifiers, i.e., the "verifier" role feeding back into training rather than only gating
  inference-time outputs.
- SWE-Replay: same or better resolve rate at up to 17.4% lower compute than naive multi-rollout scaling,
  i.e., _how_ you scale rollouts (adaptive continuation vs. brute repetition) matters roughly as much as
  _whether_ you scale them.
- UTBoost: correcting insufficient test cases and regex-based pass/fail parsing changed the ranking of
  24.4% of Verified-leaderboard entries and 40.9% of Lite entries — a direct empirical warning that a
  meaningful fraction of leaderboard position differences reflect evaluation-harness noise, not agent
  harness quality.
- AgentLens: among _passing_ OpenHands trajectories, 0.5%–23.2% (model-dependent) are "Lucky Passes" —
  messy, retry-heavy, or verification-skipping paths that happened to pass; re-ranking by trajectory
  quality instead of raw pass rate moves some models by up to 5 rank positions. This is direct evidence
  that binary resolved/unresolved leaderboard scores understate the reliability gap between harnesses that
  verify-before-submit and ones that don't.

**Answers to the four specific design-feature questions:**

- _Test-time compute via multiple rollouts + verifier/selector_: strongly supported by the evidence.
  Every documented before/after case (AutoCodeRover repetition, Trae Agent ensemble, Moatless
  tree-search, SWE-Replay) shows positive, and in Trae Agent's case monotonic, gains, and the two leaders
  on SWE-bench Pro at the hardest end of the difficulty spectrum (Live-SWE-agent, Trae Agent) are both
  built around explicit search/selection over multiple candidates rather than a single greedy rollout.
  The main caveat is cost: gains are real but sub-linear, and "smart" scaling (SWE-Replay's selective
  continuation) captures most of the benefit of naive scaling at a fraction of the compute.
- _Reproduction-test-first_: supported wherever it's been tried (Agentless, PatchPilot both build
  LLM-generated reproduction tests into validation, both land on strong cost/performance Pareto points),
  but no paper in this set isolates a clean ablation for reproduction-test-generation alone versus
  running only the existing regression suite — it's usually bundled with the rest of the validation stage,
  so the effect size specifically attributable to "reproduce first" is asserted more often than measured.
- _Structured tool interface (ACI-style)_: the evidence is now mixed rather than uniformly positive. It
  was decisively positive in 2024 against weaker models and shell-only baselines (SWE-agent's +64%
  relative gain over a shell-only agent, same base model). By 2025-26, mini-SWE-agent's 100-line
  bash-only harness reaching 74%+ Verified with a frontier model shows the marginal value of a bespoke
  ACI has shrunk as base-model competence has grown — the harness increasingly matters more for
  localization/verification/test-time-compute than for the raw action-interface design.
- _Context pruning / compaction_: universally treated as necessary at the architecture-description level
  (OpenHands' memory-compression service, OPENDEV's adaptive compaction, Lingma's whole-repo graph
  compression, dedicated 2026 papers on "structured memory" and "coherence collapse"), but, like
  reproduction-first, rarely isolated with a clean ablation number in the sources surfaced here — it's
  reported as a failure-mode fix (agents that degrade over long trajectories) more than as a leaderboard-
  points-per-technique measurement.
- _Step/iteration budgets_: appear universally as a practical constraint in every harness examined but
  are treated as an engineering necessity (cost/latency control, avoiding infinite loops) rather than a
  studied independent variable; no paper in this set reports a clean sweep of "resolve rate vs. iteration
  budget," so this remains the least evidenced of the five design questions in the current literature —
  its effects are visible only indirectly, through papers on "stuck-state detection" (OpenHands) and
  long-horizon context degradation.

**Overall picture.** The field has converged on roughly the same four-stage skeleton — localize, act
under sandboxed tool execution with guardrails, verify (run tests / reproduce bug / check with a
learned or LLM judge), and increasingly spend extra compute on search or ensembling rather than one
greedy pass — while diverging on the details of tool granularity, whether planning is agent-driven or
fixed-pipeline, and how aggressively context is pruned. Two meta-findings temper all of the above:
(1) leaderboard evaluation infrastructure itself is measurably noisy — UTBoost's re-grading flipped
roughly a quarter of Verified rankings and AgentLens shows binary pass/fail hides large reliability
differences between harnesses — so score differences of a few points between harnesses should not be
over-read; and (2) as base models have gotten stronger, some of the harness-design gains that were large
and clean in 2024 (bespoke ACI, careful windowed file viewers) have partly been absorbed by model
capability, while the gains that persist into 2025-26 top systems are concentrated in verification and
test-time search rather than in tool-interface cleverness.
