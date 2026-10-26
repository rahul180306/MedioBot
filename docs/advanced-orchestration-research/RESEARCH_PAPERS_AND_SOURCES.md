# MedioBot V2 — Advanced Autonomous Multi-Agent Architecture Research
## Deliverable 3: Research Papers, Empirical Benchmarks & Literature Review

---

### 1. Introduction & Methodology

This document evaluates the primary academic and industrial literature underpinning autonomous multi-agent software engineering, repository understanding, agentic memory, and long-horizon execution. 

Every reviewed source is classified according to four strict categories:
1. **Verified Research Findings**: Peer-reviewed conference papers, formal arXiv preprints, or official reproducible technical reports with open benchmarks.
2. **Existing MedioBot Implementation Facts**: Concrete verified behaviors in the active `mediobot-v2` codebase.
3. **Architectural Proposals**: Recommended engineering designs synthesizing research into MedioBot.
4. **Speculative Ideas**: Theoretical paradigms lacking empirical benchmark validation.

---

### 2. Multi-Agent Coordination & Orchestration Literature

#### 2.1 Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks
* **Source:** arXiv:2411.04468v1 | Microsoft Research (Fourney et al.)
* **Publication Date:** November 7, 2024
* **Main Contribution:** Introduces a multi-agent system anchored by a centralized lead agent (**Orchestrator**) managing two explicit ledgers:
  1. *Task Ledger (Outer Loop):* Tracks high-level goals, verified facts, hypotheses, and re-planning steps.
  2. *Progress Ledger (Inner Loop):* Tracks step-by-step progress and subtask delegation to specialized workers (`FileSurfer`, `Coder`, `Terminal`, `WebSurfer`).
* **Evidence Strength:** High. Evaluated across GAIA, AssistantBench, and WebArena benchmarks using AutoGenBench with Dockerized execution sandboxing.
* **Limitations:** The Orchestrator operates synchronously; worker execution is largely sequential rather than deeply parallel. High token consumption due to frequent ledger re-prompts.
* **Applicability to MedioBot:** Direct. Maestro can implement the Task Ledger / Progress Ledger split to replace its current single-turn blind delegation, maintaining active state across multi-step plans.

#### 2.2 SPOQ: Specialist Orchestrated Queuing for Multi-Agent Software Engineering
* **Source:** arXiv:2606.03115v1 | Carbowitz & Kumar
* **Publication Date:** June 2, 2026
* **Main Contribution:** Introduces three orchestration innovations:
  1. *Wave-Based Topological Dispatch:* Decomposes tasks into Directed Acyclic Graphs (DAGs) and computes concurrent execution waves.
  2. *Dual Validation Gates:* Applies strict validation before execution (planning validation) and after execution (code test validation) to halt defect propagation.
  3. *Human-as-an-Agent (HaaA):* Explicit gates where a human acts as an agent in the graph for approval and steering.
* **Evidence Strength:** Very High. Longitudinal empirical study across 17 real repositories, 8,589 commits, 1,822 tasks, and 13,866 tests. Speedup of 1.4× to 14.3×; reduced task defects from 0.34 to 0.20 per task; boosted test pass rate to 99.75%. Replicated on local open-weights models (Qwen3.6-35B-A3B).
* **Limitations:** Assumes tasks can be cleanly factored into independent topological stages; tightly coupled inter-file refactorings can force the graph to collapse into sequential waves.
* **Applicability to MedioBot:** Critical Architectural Pattern. MedioBot should adopt topological wave dispatch for coordinating Cody, Tester, Doc, and Dessy.

#### 2.3 Agyn: A Multi-Agent System for Team-Based Autonomous Software Engineering
* **Source:** arXiv:2602.01465v2 | Benkovich & Valkov
* **Publication Date:** February 1, 2026
* **Main Contribution:** Replicates human software engineering team organization (coordination, research, implementation, review). Gives each agent an isolated sandbox for experimentation and enables structured inter-agent communication.
* **Evidence Strength:** High. Evaluated post-hoc on SWE-bench 500, resolving 72.2% of real GitHub issues without benchmark overfitting.
* **Limitations:** High compute and RAM requirements when running multiple full sandbox containers concurrently.
* **Applicability to MedioBot:** Validates the role-based Agile team metaphor (Maestro as coordinator, Cody as implementer, Tester as reviewer) and highlights the requirement for isolated workspace sandboxes.

#### 2.4 AsynCodeBench: Benchmarking Collaboration of Asynchronous Multi-Agent Systems in Software Engineering
* **Source:** arXiv:2609.32662v1 | Zhang et al.
* **Publication Date:** September 26, 2026
* **Main Contribution:** Formal benchmark specifically targeting asynchronous multi-agent collaboration in software engineering. Measures cross-agent coordination via Asynchronous Dependency Pass Rate (ADPR) and Dependency Resolution Step (DRS). Reveals that multi-agent coding performance does not correlate purely with model coding ability—organizational coordination structure is the deciding factor. Discovers that successful collaboration occurs in concentrated bursts ("hopping windows").
* **Evidence Strength:** High. 19 complex repository-level tasks, 52 explicit directed dependencies with automated checkers across diverse LLM families.
* **Applicability to MedioBot:** Informs the design of dependency checkers and event hooks between Cody and Tester.

---

### 3. Repository Understanding & Code Intelligence Literature

#### 3.1 Prometheus: Towards Long-Horizon Codebase Navigation for Repository-Level Problem Solving
* **Source:** arXiv:2507.19942v2 | Pan et al.
* **Publication Date:** July 26, 2025
* **Main Contribution:** Addresses the "Needle-in-a-Haystack" failure mode of coding agents on large repositories. Replaces flat directory exploration with a unified repository knowledge graph encoding semantic dependencies, coupled with a working memory context engine that retains explored paths across reasoning turns.
* **Evidence Strength:** SOTA Benchmark Performance. Achieves 74.4% resolution on SWE-bench Verified and 33.8% on SWE-PolyBench Verified (Top-6 and Top-1 open-source rankings).
* **Limitations:** Graph construction overhead on massive multi-million line monorepos requires background pre-indexing.
* **Applicability to MedioBot:** Demonstrates why MedioBot's current 35-file directory scan fails on real codebases and justifies an AST-backed dependency graph.

#### 3.2 TypeScript Repository Indexing for Code Agent Retrieval (abcoder-ts-parser)
* **Source:** arXiv:2604.18413v2 | Pu, Li, & Chen
* **Publication Date:** April 20, 2026
* **Main Contribution:** Diagnoses the severe performance bottleneck of using Language Server Protocol (LSP) for agent code retrieval: per-symbol JSON-RPC queries cause severe latency spikes on large repositories. Introduces `abcoder-ts-parser`, utilizing the native **TypeScript Compiler API** directly to construct function-level abstract syntax trees (UniAST), symbol tables, and module dependency chains without JSON-RPC overhead.
* **Evidence Strength:** Empirical evaluation on three production TypeScript codebases totaling 1.2M lines of code with orders-of-magnitude faster indexing than LSP-based alternatives.
* **Limitations:** Specific to TypeScript/JavaScript; non-JS ecosystems require Tree-sitter fallbacks.
* **Applicability to MedioBot:** Crucial. Because MedioBot and its target web applications are predominantly TypeScript/JavaScript, utilizing the TypeScript Compiler API directly inside Node.js provides instant, high-fidelity symbol resolution without spawning heavy LSP processes.

#### 3.3 Aider Repository Map Architecture (PageRank over Tree-sitter AST)
* **Source:** Aider Technical Documentation & Architecture Specification | Paul Gauthier
* **Release / Update Date:** 2023–2025
* **Main Contribution:** Generates a concise, budget-constrained "Repo Map" that fits into the LLM context window. Extracts symbols (classes, functions, methods, imports) using Tree-sitter, models the codebase as a directed graph where edges represent references, and applies the **PageRank algorithm** to identify the most central definitions. Dynamically samples definitions based on the user's active query.
* **Evidence Strength:** High practical adoption. Proven in hundreds of thousands of coding agent runs; consistently ranks among top single-agent systems on SWE-bench.
* **Limitations:** Does not execute semantic tests; purely structural heuristic.
* **Applicability to MedioBot:** Excellent fit for Maestro's context window. Instead of dumping raw file trees, Maestro receives a PageRank-weighted symbol map of relevant modules.

---

### 4. Advanced Agentic Memory Literature

#### 4.1 A-MEM: Agentic Memory for LLM Agents
* **Source:** arXiv:2502.12110v1 | NeurIPS 2025 (Xu, Liang, Mei, Gao, Tan, Zhang)
* **Publication Date:** February 17, 2025
* **Main Contribution:** Proposes an agentic memory network inspired by the **Zettelkasten** method. Each memory entry is an atomic note enriched with structured attributes (contextual descriptions, keywords, tags). When new experiences occur, the system dynamically discovers connections to historical memories, establishing bidirectional links. Uniquely supports **Memory Evolution**: adding new experiences retroactively refines and updates the attributes of older notes.
* **Evidence Strength:** High. Evaluated across 6 foundation models with significant empirical gains over static vector retrieval.
* **Limitations:** Full $O(N^2)$ cross-linking comparisons during memory ingestion can cause latency spikes if not gated.
* **Applicability to MedioBot:** Ideal for storing cross-thread architectural decisions, developer coding preferences, and successful debugging resolutions.

#### 4.2 D-MEM: Dopamine-Gated Agentic Memory via Reward Prediction Error Routing
* **Source:** arXiv:2603.14597v1 | Song & Xin
* **Publication Date:** March 15, 2026
* **Main Contribution:** Directly solves the $O(N^2)$ scaling bottleneck of A-MEM by implementing a biologically inspired Fast/Slow memory routing system based on **Reward Prediction Error (RPE)**. Routine observations bypass heavy restructuring into an $O(1)$ fast buffer; high-RPE events (such as unexpected test failures, user corrections, or novel architectural patterns) trigger an $O(N)$ memory evolution step. Reduces memory token overhead by >80%.
* **Evidence Strength:** Evaluated on the LoCoMo-Noise benchmark under adversarial and long-session conditions.
* **Applicability to MedioBot:** Solves the token and CPU overhead of long-term memory on resource-constrained local developer workstations.

#### 4.3 Jev-Mem: System-One-Controlled Agentic Memory for Efficient AI Agents
* **Source:** arXiv:2609.23986v1 | Jiang, Li, & Li
* **Publication Date:** September 21, 2026
* **Main Contribution:** Introduces a System-1 / System-2 division of labor for agent memory. A fast, deterministic heuristic controller (System-1) handles memory typing, relational linking, query routing, and adaptive retrieval termination, reserving expensive autoregressive LLM reasoning (System-2) strictly for complex multi-hop synthesis. Achieves a 6.6× speedup in memory construction and 36.7% latency reduction on the LoCoMo benchmark.
* **Applicability to MedioBot:** Aligns with MedioBot's local-first architecture: deterministic SQLite and BM25 handle rapid retrieval without invoking costly model inference for basic memory lookups.

#### 4.4 Demystifying the Term "MAG" in AI Literature
* **Clarification of Terminology:**
  * **MAG = Memory-Augmented Generation**: The academic paradigm extending Retrieval-Augmented Generation (RAG). While RAG retrieves immutable text chunks from an external corpus, MAG treats memory as an active, stateful, self-updating cognitive store containing episodic traces, procedural schemas, and entity relationships (e.g., *MMAG*, Sapienza University, Dec 2025; *MAGMA*, Jan 2026).
  * **MAG = Multi-Agent Graph**: In orchestration contexts, MAG refers to modeling multi-agent interactions as stateful directed graphs where nodes represent agent personas and edges represent typed message handoffs (e.g., LangGraph, MAD-RAG).
* **Comparative Evidence (MAG vs. RAG):**
  * *RAG Strengths:* Excellent for static external documentation libraries (e.g. React docs, Tailwind reference); zero write latency.
  * *RAG Weaknesses for Coding Agents:* Cannot remember that Cody already refactored `auth.ts` two turns ago; cannot learn that the user dislikes semicolons; cannot update stale assumptions.
  * *MAG Strengths:* Maintains evolving truth across the project lifecycle; captures provenance and causal links; supports state invalidation when files change.
  * *Verdict:* **MedioBot should not replace RAG with MAG, but combine them in a dual-tier strategy**: use RAG for external library documentation and MAG (via SQLite + A-MEM) for project and execution memory.

---

### 5. Benchmark Analysis & Critical Evaluation

| Benchmark | Target Capability | Evaluation Methodology | Real-World Validity | Known Limitations |
| :--- | :--- | :--- | :--- | :--- |
| **SWE-bench Verified** | Autonomous repository issue resolution | 500 validated GitHub issues; verified unit test assertions | **High**: Tests actual patch generation against unit tests. | Over-indexes on Python; ignores UI layout, CSS aesthetics, visual verification, and greenfield scaffolding. |
| **SWE-bench Pro / PolyBench** | Multi-language repo problem solving | Python, TypeScript, Go, Java, Rust issues | **Very High**: Reflects diverse tech stacks. | High compute requirements to run isolated Docker validation for every task. |
| **GAIA** (General AI Assistants) | Multi-modal, tool-assisted complex reasoning | Real-world multimodal web, file, and code tasks | **Moderate**: Tests generalist tool orchestration. | Tasks are heavily text/web-search oriented rather than long-term collaborative software development. |
| **WebArena** | Web interaction & computer use | Live sandbox web applications (eCommerce, GitLab) | **High for Vision**: Verifies UI clicking, forms, and navigation. | Requires live headless browser sandbox; susceptible to DOM timing flakiness. |
| **AsynCodeBench** | Asynchronous multi-agent SE collaboration | 19 repo tasks, 52 explicit cross-agent dependencies | **Very High for Concurrency**: Measures cross-agent coordination and deadlocks. | Small sample size (19 tasks); newer benchmark (Sept 2026). |

> **Critical Warning on Benchmarks:** Benchmark scores must never be treated as direct proof of MedioBot's end-to-end performance. High SWE-bench scores can mask severe UI latency, poor user feedback, high API costs, and brittle terminal interaction. Benchmark metrics should guide subsystem design, not substitute for live human verification.
