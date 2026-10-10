# What Makes an AI Agent Harness Effective: Literature Review (2026)

## Methodology note

This review prioritizes sources with measured effects: ablations, leaderboard numbers, or controlled comparisons, over marketing claims. Sources are grouped by theme; each paragraph states what was measured, the effect size, and the design principle it supports.

---

## 1. Interfaces and action spaces

**SWE-agent / Agent-Computer Interfaces (Yang et al., NeurIPS 2024, arXiv:2405.15793).** Ablated the custom "ACI" (a restricted, purpose-built set of file-viewing, editing, and search commands with structured feedback) against a baseline agent that used a raw Linux shell with the same underlying LM (GPT-4 Turbo). On a 300-instance SWE-bench Lite subset, the ACI-equipped agent resolved 10.7 percentage points more instances than the raw-shell baseline, and the full system reached 12.47% on the 2,294-instance SWE-bench test set versus a prior non-interactive retrieval baseline of 3.8%. The ACI transferred to a different LM (Claude 3 Opus: 10.5%), showing the effect is architectural, not model-specific. **Principle supported:** the design of the tool/action interface — not just the underlying model — is a first-order determinant of agent success; narrow, well-scoped, high-feedback tools beat a general-purpose shell.

**CodeAct (Wang et al., ICML 2024, arXiv:2402.01030).** Compared "actions as executable Python code" against actions as JSON/text function calls across 17 LLMs on API-Bank and a new benchmark. Code-as-action raised success rate by up to 20 points absolute (e.g., GPT-4-1106: 74.4% vs 52.4% for JSON) with fewer turns (5.5 vs 7.6). **Principle:** giving the agent a Turing-complete, composable action space (loops, conditionals, reuse) outperforms constrained structured-output action schemas.

**AutoCodeRover (Zhang et al., ISSTA 2024, arXiv:2404.05427).** Compared AST/code-structure-aware search-and-edit actions (rather than raw grep/file-view) against SWE-agent's ACI on cost and resolve rate. AutoCodeRover resolved comparable/better rates at far lower token cost (~37k tokens / $0.43 per instance vs SWE-agent's ~245k tokens / $2.51), with 66.7% of SWE-agent's successes needing >100k tokens versus most of AutoCodeRover's needing <30k. **Principle:** program-structure-aware tools (AST navigation) reduce the search space and token cost more than general-purpose file/shell tools.

---

## 2. Agentic vs. non-agentic pipelines (localization + repair + validation)

**Agentless (Xia et al., 2024/ACM TOSEM 2025, arXiv:2407.01489).** Directly tested whether an autonomous, multi-turn agent loop is necessary at all. A fixed three-phase pipeline (hierarchical localization → candidate patch generation → filter/rank via regression+reproduction tests and majority voting) achieved 32.0% on SWE-bench Lite at $0.70/instance — at the time state-of-the-art among all systems, agentic or not — and >50% on SWE-bench Verified with Claude 3.5 Sonnet. **Principle (and a genuine counter to "more agentic autonomy is better"):** a well-engineered deterministic pipeline with precise localization and rigorous patch validation can match or beat open-ended agent loops, at lower cost and higher reliability. This directly informs harness design: decompose the task into a scaffolded pipeline wherever the task structure allows it, and reserve open-ended agency for where structure genuinely can't be predicted.

**Nemotron-CORTEXA (NVIDIA, ICML 2025).** Ablated a specialized code-embedding retrieval model plus a localization-refinement agent layered onto the Agentless-style pipeline. Result: 68.20% on SWE-bench Verified at $3.28/instance — higher accuracy than Agentless at comparable-to-lower cost. **Principle:** investment in retrieval/localization precision has outsized ROI relative to investment in more agent turns; localization quality gates everything downstream.

**Otter / Issue2Test (reproduction test generation, arXiv:2502.05368, arXiv:2503.16320).** Measured whether machine-generated "reproduction tests" (tests that fail before a fix and pass after) improve patch selection. Otter's tests, combined with pruning, gave a 6.2–9.0% relative improvement in issue-reproduction rate on SWE-bench Lite/Verified; Issue2Test's iterative refine-until-fails-correctly loop was evaluated on all 276 SWT-bench-Lite instances. **Principle:** having the harness synthesize its own executable verification oracle (not just relying on the agent's self-report) materially improves the correctness of automated patch/selection decisions.

---

## 3. Test-time scaling and verifier-guided selection

**Large Language Monkeys (Brown, Juravsky et al., 2024, arXiv:2407.21787).** Measured "coverage" (fraction of problems solved by at least one of N samples) as a function of N across many tasks/models. Coverage scaled log-linearly over 4 orders of magnitude of samples; on SWE-bench Lite, DeepSeek-Coder-V2-Instruct went from 15.9% (1 sample) to 56% (250 samples), beating the single-sample SOTA of 43%. Crucially, in domains lacking automatic verifiers, majority voting and reward models plateaued after a few hundred samples and failed to track the coverage curve. **Principle:** repeated sampling is a powerful and cheap lever, but its payoff is gated entirely on having a good selection/verification mechanism — sampling without a verifier wastes most of the available signal.

**CodeMonkeys (Stanford, arXiv:2501.14723).** Scaled both "serial" test-time compute (iterations per trajectory, with the model writing and running its own test script alongside the edit) and "parallel" compute (more trajectories), then selected across an ensemble including outside submissions. Achieved 57.4% on SWE-bench Verified for ~$2300 total inference cost; ensembling across existing top submissions raised this to 66.2%, exceeding the best individual member. **Principle:** ensembling and cross-system patch selection outperforms any single pipeline, and letting the model generate/run its own verification script in the same trajectory (self-verification) is a cheap serial-compute win.

**Scaling Test-Time Compute for Agentic Coding (arXiv:2604.16529, 2026).** Directly measured long-horizon-specific test-time scaling (as opposed to short bounded-output scaling), via "Recursive Tournament Voting" (parallel) and "Parallel-Distill-Refine" (sequential) over compressed rollout summaries. Claude-4.5-Opus improved from 70.9%→77.6% on SWE-bench Verified and 46.9%→59.1% on Terminal-Bench v2.0. **Principle:** for long, multi-step agent trajectories, compact structured summaries of rollouts (not raw trajectories) are the right unit to search/vote/refine over — naive sample-and-vote schemes designed for short CoT don't transfer directly to long-horizon agents.

**SWE-Search (arXiv:2410.20285, ICLR 2025).** Ablated MCTS-based exploration with an LLM value function and git-commit-tree backtracking against standard linear agent rollouts. Reported a 23% relative improvement across five different base models versus non-search agents on SWE-bench. **Principle:** giving the agent the ability to backtrack to prior states (not just move forward) and evaluate branches with a learned/prompted value function meaningfully improves outcomes — but the gain is relative and comes with substantially higher compute cost, so it's most defensible when a verifier can cheaply prune bad branches.

**Trae Agent (ByteDance, arXiv:2507.23370).** An explicit generation → pruning → selection ensemble-search framework, reaching #1 on the SWE-bench Verified leaderboard (75.20% Pass@1), a 10.22-point average improvement over baselines. **Principle:** decoupling generation from selection into distinct specialized agent roles, with an explicit pruning stage to control ensemble-space blowup, scales better than a single agent doing everything end-to-end.

**SWE-Gym / R2E-Gym (arXiv:2412.21139, arXiv:2504.07164).** Both built large executable-environment datasets to train verifiers, then measured inference-time gains from applying those trained verifiers at test time. SWE-Gym's verifier-plus-fine-tuned-agent combo hit 32.0%/26.0% on Verified/Lite (new open-weight SOTA at publication); R2E-Gym's "hybrid" verifier (combining execution-based and execution-free signals) reached 51% Verified, beating either verifier type alone and closing much of the gap to proprietary systems. **Principle:** verifiers trained specifically for patch correctness (not just the base coding LM) are a distinct, high-leverage component of the harness, and combining execution-based with execution-free (learned) verification beats either alone.

---

## 4. Reasoning/memory patterns (ReAct family, Reflexion, Self-Refine, Tree of Thoughts, workflow memory)

**ReAct (Yao et al., ICLR 2023, arXiv:2210.03629).** Interleaving reasoning traces with actions (vs. reasoning-only or acting-only) was evaluated on HotpotQA, FEVER, ALFWorld, WebShop, establishing that reasoning and acting are mutually reinforcing (reasoning helps track/adjust plans; acting grounds reasoning in real observations). This is the foundational pattern nearly every subsequent agent harness builds on. **Principle:** interleave "think" and "act" steps explicitly rather than doing all planning up front or none at all.

**Reflexion (Shinn et al., NeurIPS 2023, arXiv:2303.11366).** Measured self-generated verbal feedback stored in an episodic buffer and reused across trials (no weight updates). Reached 91% pass@1 on HumanEval, at the time surpassing GPT-4's zero-shot number. **Principle:** verbal self-critique persisted across attempts is a cheap, effective substitute for RL fine-tuning when a task can be retried.

**Self-Refine (Madaan et al., NeurIPS 2023, arXiv:2303.17651).** Same-model iterative feedback→refine loop, tested across 7 tasks with GPT-3.5/ChatGPT/GPT-4. Improved task performance ~20% absolute on average, with no additional training. **Principle:** even without an external verifier, a structured self-feedback loop (separate "critic" and "refiner" prompts, not a single-shot revision ask) reliably improves output quality — though this is weaker evidence than execution-verified approaches since it relies on the same model's own (possibly miscalibrated) judgment.

**Tree of Thoughts (Yao et al., NeurIPS 2023, arXiv:2305.10601) and LATS (Zhou et al., ICML 2024, arXiv:2310.04406).** ToT generalizes chain-of-thought into explicit branching search over "thoughts," evaluated with BFS/DFS and heuristic scoring. LATS adds MCTS plus LM-based value functions and self-reflection, unifying reasoning/acting/planning; its own ablation found that reducing the exploration-weight parameter (less exploration, more exploitation) _degraded_ HotpotQA performance, indicating the search/exploration component (not just the LM backbone) is load-bearing. **Principle:** structured search over alternative reasoning/action branches beats single-path generation, but only when paired with a working value/evaluation function — remove or weaken that function and the benefit of search shrinks or reverses.

**Agent Workflow Memory (Wang et al., 2024, arXiv:2409.07429).** Measured induced "workflows" (abstracted, reusable action templates mined from successful trajectories) injected as procedural guidance for new tasks, on Mind2Web and WebArena (1000+ tasks). Improved success rate 24.6% and 51.1% relative respectively over baselines, while reducing steps to success. **Principle:** mining and re-injecting the agent's own past successful procedures (as opposed to raw episodic transcripts) is a distinct, higher-leverage memory mechanism than simple retrieval-augmented context.

**Voyager (Wang et al., 2023, arXiv:2305.16291).** In the Minecraft domain, an ever-growing executable-code skill library plus automatic curriculum plus iterative self-verification produced 3.3x more unique items, 2.3x longer exploration distance, and up to 15.3x faster tech-tree unlocks than prior SOTA, and transferred to new worlds/tasks where baselines could not generalize. **Principle:** persisting learned competencies as composable, executable code (not natural-language notes) is what makes a skill library actually reusable and compounding.

**Generative Agents (Park et al., UIST 2023, arXiv:2304.03442).** Introduced the memory-stream + reflection + planning architecture (raw experience log → periodic higher-level "reflections" → plans), demonstrated via emergent, coherent multi-day social behavior among 25 simulated agents. Evidence here is largely qualitative/demonstrative rather than ablated with hard numbers, but the reflection-synthesis step is widely cited as the origin of "memory consolidation" in agent harnesses. **Principle (moderate strength):** periodically synthesizing raw memory into higher-level abstractions, rather than only ever retrieving raw logs, improves coherence over long horizons.

**CoALA (Sumers et al., 2023, arXiv:2309.02427).** A conceptual/organizing framework (not an empirical ablation) proposing modular memory (working/episodic/semantic/procedural), a structured internal+external action space, and a generalized decision loop. Its contribution is taxonomic: it gives the field shared vocabulary for comparing harness designs, and nearly every later system (MemGPT, AWM, Voyager) can be mapped onto its categories. **Principle (framework-level, not itself an effect size):** effective harnesses tend to explicitly separate memory _types_ (what persists, at what timescale, retrieved how) rather than using one undifferentiated context buffer.

---

## 5. Context engineering, long-running harnesses, and memory management

**Anthropic, "Effective context engineering for AI agents" (2025).** A practitioner engineering post (not a controlled experiment) arguing that context is a finite, curated resource, and that the operative question is "what configuration of context maximizes the probability of desired behavior," covering techniques like just-in-time retrieval, compaction, and sub-agent context isolation. No hard ablation numbers are published, but it is grounded in Anthropic's own production agent (Claude Code) telemetry. **Principle (moderate — vendor-published but grounded in internal measurement, not third-party replicated):** treat context as an engineered, actively pruned resource, not a passive log that only grows.

**Anthropic, "Effective harnesses for long-running agents" (2025).** A worked case study: a two-prompt harness (an "initializer" agent that produces `init.sh`, a structured JSON feature list, and a `claude-progress.txt`; then a "coding" agent that each session claims one failing feature, tests it end-to-end including browser automation, commits, and updates the progress file before stopping) built specifically to let agent work span many context windows with no persistent memory between sessions. This is a design pattern with a described mechanism rather than a benchmarked ablation, but it directly targets the failure mode of context loss across sessions. **Principle:** externalize state (progress files, structured task lists, git history) onto the filesystem/repo rather than relying on in-context memory to survive between agent sessions; force one-feature-at-a-time scoping to keep each session's diff reviewable and revertable.

**Manus, "Context Engineering for AI Agents: Lessons from Building Manus" (2025).** A practitioner postmortem reporting concrete production metrics: KV-cache hit rate was identified as "the single most important metric" for a production agent because cached vs. uncached input tokens differ 10x in cost (Claude Sonnet: $0.30 vs $3.00/MTok at time of writing), and the team reported rebuilding their context architecture four times ("Stochastic Graduate Descent") after finding cache-invalidating patterns (non-append-only edits, timestamps in stable prefixes, dynamically added/removed tools). They replaced tool add/remove with logit-masking over a fixed tool set to preserve cache stability. **Principle (moderate — single-vendor telemetry, directionally consistent with cache economics but not independently replicated):** keep the context prefix stable and append-only, and mask rather than mutate the available tool set, to preserve KV-cache hit rate, which dominates both cost and latency at production scale.

**Lost in the Middle (Liu et al., TACL 2024, arXiv:2307.03172).** Controlled multi-document QA and key-value retrieval experiments found a robust U-shaped position effect: performance is highest when relevant information is at the start or end of the context and degrades — sometimes below a no-context baseline — when it's in the middle, even for models explicitly built for long context. **Principle (strong, well-replicated):** context _position_, not just presence, matters; harnesses should place the most decision-relevant information (current task, most recent tool outputs, key constraints) at the start or end of the prompt, not buried mid-context, and should actively prune/compact stale middle content rather than let it accumulate.

**MemGPT (Packer et al., 2023, arXiv:2310.08560).** Proposed OS-inspired virtual-context management: tiered memory (fast "main context" vs. slow "external context") with the LLM itself issuing function calls to page information in/out, plus interrupts for control-flow handoff. Demonstrated on document QA and multi-session dialogue with qualitative gains in coherence over fixed-window baselines; became the conceptual ancestor of most "compaction" implementations in production harnesses (including Anthropic's and Manus's). **Principle (moderate):** give the agent explicit, callable memory-management operations (page in/out, summarize-and-evict) rather than only ever appending to one linear window.

**Mem0 (arXiv:2504.19413, ECAI 2025) and A-MEM (arXiv:2502.12110).** Mem0 is the first broad head-to-head of ten memory approaches (RAG, full-context, OpenAI Memory, Zep, etc.) on the LoCoMo benchmark; it reported 26% relative improvement in LLM-judged quality over the OpenAI Memory baseline, 91% lower p95 latency, and >90% token-cost savings, with a graph-augmented variant adding ~2 more points over its own flat-memory baseline. A-MEM (Zettelkasten-style self-organizing, self-linking memory notes) is evaluated mainly via case studies/qualitative comparison rather than a large controlled benchmark. **Principle (moderate-to-strong for Mem0's cost/latency claims, since they include a real inter-system comparison; weaker for A-MEM):** structured, extraction-based memory (facts distilled and linked, not raw transcript storage) outperforms naive full-context or basic RAG on both quality and cost at long horizons — though note these are vendor-authored benchmarks on the vendor's own product, so treat effect sizes as upper bounds pending independent replication.

**OpenAI, "Harness engineering: leveraging Codex in an agent-first world" (2026).** A case-study post describing an internal project where an entire production codebase (app, tests, CI, docs, observability, internal tooling) was authored end-to-end by Codex agents over five months, with humans working one abstraction layer up (prompting/reviewing PRs rather than writing code). The core operational claim is that repository legibility for an agent — architecture linting, docs-as-map, mechanical enforcement of conventions — becomes the dominant lever once humans stop hand-writing code, more so than model choice. No controlled A/B is published; this is a single internal case study. **Principle (anecdotal-to-moderate, single vendor, non-replicated, but concrete and mechanism-specific):** as agents write more of the codebase, invest harness effort in making the repository _machine-legible_ (enforced structure, executable documentation, lint rules an agent can satisfy) rather than only in prompt content.

---

## 6. Multi-agent orchestration

**Anthropic, "How we built our multi-agent research system" (2025).** The most concrete measured result on multi-agent design: an orchestrator-worker architecture (lead agent plans and spawns parallel subagents, each with its own context window, that report back curated findings) beat single-agent Claude Opus 4 by 90.2% on an internal research-quality eval. The same post reports that a substantial share of the performance variance across agent configurations was explained by token/compute usage patterns rather than architecture choice per se (i.e., how tokens were spent, in parallel exploration, mattered more than clever prompting), at roughly 15x the token cost of a single-agent chat. **Principle (strong for the specific measured task; caveat: internal eval, single organization, task-dependent):** for breadth-first, parallelizable research/search tasks, splitting into independent parallel subagents with separate context windows and a synthesizing orchestrator yields large quality gains — but at a large, superlinear token-cost multiplier, so this pattern is justified only when task parallelizability is real and quality gain outweighs 10–15x cost.

**Why Do Multi-Agent LLM Systems Fail? / MAST (Cemri et al., Berkeley, 2025, arXiv:2503.13657).** Systematically coded 150+ (of 1600+ collected) execution traces across 7 popular open-source multi-agent frameworks using grounded theory, reaching high inter-annotator agreement (κ=0.88) on a taxonomy of 14 failure modes in 3 categories: system-design issues, inter-agent misalignment, and task-verification failures. The paper's headline empirical claim is that, across the frameworks studied, MAS performance gains on popular benchmarks are often minimal relative to the complexity/cost added, and that most failures trace to _design and coordination_ problems, not raw model capability. **Principle (strong — the most rigorous negative-result evidence in this review):** adding more agents/roles does not reliably improve outcomes and frequently introduces new, systematic failure modes (verification gaps, miscommunication, premature termination); multi-agent architectures need the same rigor in role definition, hand-off protocols, and verification as single-agent harnesses, and should be justified by task structure, not adopted by default.

**Multi-agent debate — disentangling debate from voting (arXiv, 2025, referenced e.g. via "If Multi-Agent Debate is the Answer, What is the Question?" and related 2025 ablations).** A controlled decomposition of Multi-Agent Debate (MAD) into its majority-voting component and its actual cross-agent-argument (debate) component found that majority voting alone accounts for most of the gains typically attributed to MAD, and that debate alone does not reliably improve expected correctness. **Principle (a direct refutation of a popular assumption):** the commonly cited benefit of "agents debating each other" is largely a self-consistency/voting effect in disguise; harnesses seeking a debate-like improvement should consider whether cheaper N-sample majority voting achieves the same gain before paying for full multi-turn multi-agent debate.

**MetaGPT (Hong et al., ICLR 2024 Oral, arXiv:2308.00352) and ChatDev (Qian et al., ACL 2024, arXiv:2307.07924).** Both encode explicit human software-team workflows (SOPs / waterfall stages) into role-specialized multi-agent pipelines, reporting qualitatively more coherent multi-file outputs than naive chat-chained agents on software-engineering benchmarks; ChatDev additionally found that using natural language for design/communication and programming language for debugging worked better than a single communication modality throughout. Neither publishes SWE-bench-comparable leaderboard numbers, so evidence here is moderate (peer-reviewed, benchmarked against baselines, but on custom/smaller benchmarks rather than the now-standard large public leaderboards). **Principle:** imposing an explicit structured protocol (SOP/waterfall/standardized artifacts passed between roles) on a multi-agent system reduces the "cascading hallucination" failure mode identified generically by MAST.

---

## 7. Safety, sandboxing, and prompt-injection robustness

**AgentDojo (arXiv:2406.13352).** A dynamic evaluation environment (97 realistic tasks, 629 security test cases across email/banking/travel-style tool suites) for measuring both task success and susceptibility to indirect prompt injection under various attacks/defenses, designed to be extensible rather than a frozen leaderboard. Its main empirical contribution is methodological: it shows that utility and security must be measured jointly (many defenses that block injections also degrade task completion), rather than reporting an attack-success-rate in isolation. **Principle:** prompt-injection defenses must be evaluated on the utility/security Pareto frontier, not attack-success-rate alone; a harness that isn't measured this way may silently trade away usefulness for a security number that looks good in isolation.

**InjecAgent (Zhan et al., ACL Findings 2024, arXiv:2403.02691).** 1,054 test cases across 17 user tools/62 attacker tools, evaluating 30 agent configurations. Found ReAct-prompted GPT-4 was compromised by indirect prompt injection 24% of the time, nearly doubling when the injected instruction was reinforced with an explicit "hacking prompt." **Principle:** tool outputs are an uncontrolled input channel by default; a harness that treats tool-returned content as trusted context (the ReAct default) is measurably and substantially exploitable — tool-output sanitization / provenance-tagging must be a first-class harness feature, not an afterthought.

**Sandbox architecture surveys (2025–2026: microVM/gVisor/container comparisons, e.g. Modal, Northflank writeups; "Sandlock," "Quantifying Frontier LLM Capabilities for Container Sandbox Escape").** Practitioner-plus-academic consensus (with some measured sandbox-escape capability evaluations against frontier models) is that hardware-virtualized microVMs (Firecracker/Kata) provide a materially stronger isolation boundary than seccomp-hardened containers for untrusted agent-generated code execution, at acceptable latency in 2026 given snapshot-restore (reported ~49ms restore, ~179ms p50 end-to-end create in one write-up). **Principle (moderate — mix of vendor benchmarks and early academic capability studies, not yet a mature peer-reviewed literature):** for agents executing arbitrary generated code, prefer VM-level isolation (Firecracker/Kata/gVisor) over container-only isolation with seccomp/AppArmor; the latter is adequate only when the agent executes code that has already been reviewed/trusted.

---

## 8. Planning, evaluation, and observability — including counter-evidence

**Evaluating Plan Compliance in Autonomous Programming Agents (arXiv:2604.12147, 2026).** Directly measured the effect of injecting explicit plans (of varying quality) before code-generation steps. Found that a subpar plan hurts performance _more_ than having no plan at all, and that adding extra task-relevant phases to a plan can _degrade_ performance when those phases don't match the model's own internal problem-solving strategy. **Principle (a direct refutation of "more upfront planning is always better"):** planning is not unconditionally beneficial; a low-quality or misaligned plan actively harms downstream execution, so harnesses that force an explicit planning step should validate/critique the plan itself, not simply mandate one.

**Learning When to Plan (arXiv:2509.03581).** Measured cost/benefit of always-plan vs. never-plan vs. adaptively-plan policies for test-time compute allocation. Always-planning is expensive and degrades long-horizon performance; never-planning caps achievable performance; a learned "when to plan" policy dominates both fixed strategies. **Principle:** the decision of _whether_ to invoke planning should itself be adaptive/learned per-step, not a fixed harness-wide policy.

**On the Impact of AGENTS.md Files (arXiv:2601.20404).** Measured coding-agent efficiency as a function of the length/comprehensiveness of the repository's agent-instructions file. Found comprehensive AGENTS.md files can _hurt_ efficiency — evidence that more static context/instructions is not free and can crowd out or distract from task-relevant signal. **Principle (refutes "always give the agent more repo context/instructions"):** repository-level instruction files should be minimal and task-relevant rather than maximally comprehensive; this echoes "Lost in the Middle" — additional static context has a real attention cost.

**trajectory-judge (arXiv:2609.00038) and related LLM-as-judge validity studies (BabelJudge, arXiv:2606.22329; Agent-ValueBench, arXiv:2605.10365).** Measured how well outcome-only LLM judges detect agent failures compared to step-level rubric judges, across 400 trajectories and 5 judges. Outcome-only judging caught 84% of "loud" (visible) faults but only 45% of "silent" faults (wrong reasoning path, right answer), and falsely flagged 33% of correct trajectories; a step-rubric judge reached 77% silent-fault recall with zero false alarms. **Principle:** evaluating agents by final-answer correctness alone is a known-bad-but-common practice; a valid evaluation/regression harness needs step-level or rubric-based trajectory judging, not just outcome scoring, to catch silent failures before they compound.

**Approval-policy field study (referenced in "Stop Hand-Holding Your Coding Agent," arXiv:2607.00038, and "SWE-chat," arXiv:2604.20779).** Analysis of real-world agent usage logs found human approval gates appear in ~36% of agent loops, concentrated specifically around destructive/production/financial/external-facing actions; in the wild, agents author >99% of committed code in >40% of sessions, ask clarifying questions in only 1.4% of turns, while users interrupt ~44% of turns. **Principle (moderate — observational, single-source telemetry rather than controlled):** approval gating should be risk-tiered (destructive/irreversible/external actions gated; routine edits not), because blanket step-by-step approval is neither how agents are used in practice nor apparently necessary for most turns; conversely, the low clarifying-question rate suggests current harnesses under-elicit clarification relative to how often users actually intervene, which is itself a warning sign about agent overconfidence.

**Ralph Wiggum loop / long-running autonomous loops with git-worktree isolation.** A practitioner pattern (Geoffrey Huntley and others, 2025–2026), not an academic paper: fresh-context iterations of an agent loop against a persistent PRD/progress file, git history, and isolated worktrees per feature/loop to avoid interference. No controlled benchmark accompanies it; evidence is anecdotal (blog posts, community templates) but structurally consistent with Anthropic's peer-reviewed-adjacent "effective harnesses for long-running agents" pattern (externalized progress state, one-feature-at-a-time, checkpoint via git). **Principle (anecdotal only):** isolate parallel/sequential long-running loops via git worktrees and externalize all cross-session state to the filesystem; treat this as a plausible, widely-adopted convention rather than an evidence-backed result.

---

## Synthesis: Ranked Harness Design Principles

Ranked roughly by strength and consistency of evidence (not necessarily by ultimate importance):

1. **Tool/action-interface design is a first-order lever, independent of the base model.** _(Strong — SWE-agent ACI ablation, CodeAct, AutoCodeRover)_
2. **Precise localization/retrieval gates everything downstream in code-repair tasks; invest there before adding agent turns.** _(Strong — Agentless, Nemotron-CORTEXA, AutoCodeRover cost data)_
3. **Repeated sampling + a real verifier scales coverage predictably; without the verifier, gains plateau fast.** _(Strong — Large Language Monkeys, CodeMonkeys, SWE-Gym/R2E-Gym)_
4. **Structured, deterministic pipelines can match or beat open-ended agent loops on well-decomposable tasks, at lower cost.** _(Strong — Agentless vs. contemporaneous agentic systems)_
5. **Context position matters, not just presence; put critical info at start/end, actively prune the middle.** _(Strong, well-replicated — Lost in the Middle)_
6. **Interleaving explicit reasoning with acting outperforms either alone.** _(Strong, foundational, widely replicated — ReAct)_
7. **Outcome-only evaluation systematically misses silent failures; trajectory/step-level judging is needed for trustworthy evals.** _(Strong — trajectory-judge, BabelJudge)_
8. **Multi-agent orchestration (parallel subagents + synthesizer) gives large gains on parallelizable, breadth-first tasks — at large (~10–15x) token cost, so must be task-matched.** _(Strong for the specific task class, moderate generality — Anthropic multi-agent research post)_
9. **Adding more agents/roles is not reliably beneficial and introduces new, systematic coordination failure modes.** _(Strong — MAST/Berkeley taxonomy)_
10. **Self-critique/self-refine loops reliably improve output quality even without an external verifier, though less than execution-verified approaches.** _(Moderate-strong — Self-Refine, Reflexion)_
11. **Search over branching alternatives (tree/MCTS) beats single-path generation only when paired with a working value function.** _(Moderate — LATS, SWE-Search, with LATS's own ablation showing degraded performance when the exploration/value mechanism is weakened)_
12. **Externalizing state (progress files, structured task lists, git commits) is necessary for coherent multi-session/long-horizon agent work.** _(Moderate — Anthropic's long-running-harness case study, MemGPT's tiered-memory concept, Ralph Wiggum convention)_
13. **Mined/consolidated procedural memory (workflows, executable skill libraries) outperforms raw episodic retrieval for reuse.** _(Moderate-strong — Agent Workflow Memory, Voyager)_
14. **KV-cache/context-prefix stability is a dominant cost/latency lever in production agents; avoid non-append-only edits and dynamic tool-set churn.** _(Moderate — Manus telemetry, single-vendor)_
15. **Tool-returned content must be treated as untrusted input; agents that don't do this are measurably exploitable via indirect prompt injection.** _(Strong — InjecAgent, AgentDojo)_
16. **VM-level sandboxing (Firecracker/Kata/gVisor) is preferred over container-only isolation for executing untrusted, agent-generated code.** _(Moderate — mostly vendor/practitioner benchmarks, early academic capability studies)_
17. **Risk-tiered approval gating (destructive/irreversible actions gated, routine edits not) matches both real-world usage patterns and risk profile better than uniform step-by-step approval.** _(Moderate — observational field data)_
18. **Ensembling across independently-built systems/patches beats any single system, even a strong one.** _(Moderate-strong — CodeMonkeys ensemble result, Trae Agent)_
19. **Explicit structured protocols (SOPs, standardized inter-agent artifacts) reduce cascading-hallucination failures in multi-agent systems.** _(Moderate — MetaGPT, ChatDev, consistent with MAST's diagnosis of coordination failures)_
20. **Repository/codebase legibility (architecture linting, docs-as-map, mechanical convention enforcement) becomes the dominant harness lever as agents author more of the code.** _(Anecdotal-to-moderate — OpenAI's single internal case study)_

## What the Evidence Refutes or Shows to Be Neutral / Harmful

- **"More agents is better."** MAST (Berkeley) found MAS gains on popular benchmarks are often minimal relative to complexity, and identified 14 systematic failure modes introduced specifically by multi-agent coordination. More roles ≠ more accuracy by default.
- **"Multi-agent debate improves correctness via cross-agent argument."** Controlled decomposition studies found debate's benefit is largely explained by majority voting alone; the actual "debate" component adds little beyond the self-consistency effect.
- **"More upfront planning is always better."** A subpar or misaligned plan hurts more than no plan; "always plan" policies are both computationally expensive and can degrade long-horizon performance relative to adaptive planning.
- **"More repo context/instructions for the agent is always helpful."** Comprehensive AGENTS.md files were shown to hurt coding-agent efficiency, echoing Lost in the Middle's finding that added context has a real attention cost, not just a "no harm" floor.
- **"Majority voting / reward-model selection scales indefinitely with more samples."** Large Language Monkeys found these selection methods plateau after a few hundred samples in domains without automatic verifiers, even as raw coverage keeps climbing — the selection mechanism, not just sampling budget, is the bottleneck.
- **"Uniform step-by-step human approval is necessary for safe agent operation."** Field data shows approval is naturally concentrated on destructive/irreversible actions in practice (~36% of loops), and agents already author the overwhelming majority of code autonomously in production without a step-by-step gate — suggesting risk-tiered rather than uniform gating is both what's used and plausibly sufficient, though this evidence is observational, not a controlled safety study, so it should not be over-read as proof uniform gating is unnecessary in high-stakes settings.
- **"Non-agentic pipelines can't compete with autonomous agents."** Agentless directly refuted this at the time of its publication, beating essentially all contemporaneous agentic systems on SWE-bench Lite at a fraction of the cost — a caution against assuming agentic autonomy is intrinsically the more capable design.

---

## Key sources (representative, not exhaustive)

- Yang et al., _SWE-agent: Agent-Computer Interfaces_, NeurIPS 2024, arXiv:2405.15793
- Xia et al., _Agentless_, arXiv:2407.01489
- Zhang et al., _AutoCodeRover_, ISSTA 2024, arXiv:2404.05427
- Wang et al., _CodeAct_, ICML 2024, arXiv:2402.01030
- Shinn et al., _Reflexion_, NeurIPS 2023, arXiv:2303.11366
- Madaan et al., _Self-Refine_, NeurIPS 2023, arXiv:2303.17651
- Yao et al., _ReAct_, ICLR 2023, arXiv:2210.03629
- Yao et al., _Tree of Thoughts_, NeurIPS 2023, arXiv:2305.10601
- Zhou et al., _LATS_, ICML 2024, arXiv:2310.04406
- Wang et al., _Voyager_, arXiv:2305.16291
- Park et al., _Generative Agents_, UIST 2023, arXiv:2304.03442
- Wang et al., _Agent Workflow Memory_, arXiv:2409.07429
- Sumers et al., _CoALA_, arXiv:2309.02427
- Wang et al., _OpenHands/OpenDevin_, ICLR 2025, arXiv:2407.16741
- Brown et al., _Large Language Monkeys_, arXiv:2407.21787
- Stanford, _CodeMonkeys_, arXiv:2501.14723
- _Scaling Test-Time Compute for Agentic Coding_, arXiv:2604.16529
- _SWE-Search_, ICLR 2025, arXiv:2410.20285
- NVIDIA, _Nemotron-CORTEXA_, ICML 2025
- ByteDance, _Trae Agent_, arXiv:2507.23370
- Pan et al., _SWE-Gym_, ICML 2025, arXiv:2412.21139
- _R2E-Gym_, COLM 2025, arXiv:2504.07164
- _Otter_, arXiv:2502.05368; _Issue2Test_, ICSE 2026, arXiv:2503.16320
- Anthropic, _Effective context engineering for AI agents_ (2025)
- Anthropic, _Building effective agents_ (2024)
- Anthropic, _Effective harnesses for long-running agents_ (2025)
- Anthropic, _How we built our multi-agent research system_ (2025)
- Manus, _Context Engineering for AI Agents_ (2025)
- OpenAI, _Harness engineering_ (2026)
- Liu et al., _Lost in the Middle_, TACL 2024, arXiv:2307.03172
- Packer et al., _MemGPT_, arXiv:2310.08560
- _Mem0_, ECAI 2025, arXiv:2504.19413
- _A-MEM_, arXiv:2502.12110
- Hong et al., _MetaGPT_, ICLR 2024, arXiv:2308.00352
- Qian et al., _ChatDev_, ACL 2024, arXiv:2307.07924
- Chen et al., _AgentVerse_, arXiv:2308.10848
- Cemri et al., _Why Do Multi-Agent LLM Systems Fail? (MAST)_, arXiv:2503.13657
- Debarshi et al. / various, multi-agent debate disentanglement studies (2025)
- Debenedetti et al., _AgentDojo_, arXiv:2406.13352
- Zhan et al., _InjecAgent_, ACL Findings 2024, arXiv:2403.02691
- _Evaluating Plan Compliance in Autonomous Programming Agents_, arXiv:2604.12147
- _Learning When to Plan_, arXiv:2509.03581
- _On the Impact of AGENTS.md Files_, arXiv:2601.20404
- _trajectory-judge_, arXiv:2609.00038; _BabelJudge_, arXiv:2606.22329
- _Stop Hand-Holding Your Coding Agent_, arXiv:2607.00038; _SWE-chat_, arXiv:2604.20779
- Sandbox/isolation practitioner + early-academic sources (Modal, Northflank, _Sandlock_ arXiv:2605.26298, _Quantifying Frontier LLM Capabilities for Container Sandbox Escape_ arXiv:2603.02277)
