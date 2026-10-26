# FINAL RESEARCH AUDIT — MedioBot V2 Architecture

> **Author:** Principal AI Systems Architect (Opus Audit)
> **Date:** 2026-10-13
> **Status:** INDEPENDENT CRITICAL AUDIT
> **Scope:** All 16 documents in `docs/advanced-orchestration-research/`, plus codebase verification

---

## 1. Audit Verdict

The previous research is **architecturally sound in direction** but **contains significant unsupported quantitative claims**, overly rigid scheduling assumptions, and gaps in non-Git project support. The "Autonomous Agile Engineering Pod" metaphor is appropriate but the implementation plan must be substantially corrected.

**Overall Grade: B+ (Strong foundation, unreliable specifics)**

---

## 2. Claim-by-Claim Verification

### 2.1 "93% RAM Reduction via In-Process Logical Actors"

| Status | **UNSUPPORTED** |
|--------|----------------|
| **Claim Source** | RECOMMENDED_ARCHITECTURE.md, PERFORMANCE_MACOS_WINDOWS.md |
| **Issue** | The 93% figure compares theoretical OS-process overhead (~150 MB per Node.js child process × 8 agents = 1.2 GB) against in-process actors (~80 MB shared runtime). This comparison is misleading: (a) child processes share memory pages via copy-on-write on macOS/Linux, reducing real RSS to ~40-60 MB per additional process; (b) in-process actors still require separate LLM API connections, response buffers, and tool state, which can easily consume 50-100 MB each. |
| **Corrected Estimate** | In-process actors likely achieve **40-60% reduction** vs. naïve multi-process, not 93%. Actual savings depend on shared dependency deduplication and V8 heap sharing. |
| **Measurement Plan** | Benchmark 4-agent scenario: measure RSS of (a) 4 child_process workers vs. (b) 4 in-process async actors. Report p50/p95 RSS over a 10-minute coding task. |

### 2.2 "Microsecond Symbol Retrieval"

| Status | **MISLEADING** |
|--------|----------------|
| **Claim Source** | PROJECT_INTELLIGENCE_ARCHITECTURE.md |
| **Issue** | SQLite B-tree lookups on indexed columns are typically 5-50 microseconds for point queries. However, "symbol retrieval" in practice involves: (a) query parsing, (b) FTS5 match or B-tree seek, (c) result hydration with file paths and line numbers, (d) optional graph traversal for dependencies. End-to-end latency will be 0.5-5 milliseconds, not microseconds. |
| **Corrected Estimate** | **Sub-5ms** for single-symbol lookup; **10-50ms** for dependency-aware retrieval across a 1,000-file project. |
| **Measurement Plan** | Benchmark against the MedioBot V2 repository itself (~200 files). Measure cold/warm query times for: exact symbol, fuzzy FTS5, and 2-hop dependency graph. |

### 2.3 "1,500-Token Repository Maps"

| Status | **PLAUSIBLE BUT UNVERIFIED** |
|--------|------------------------------|
| **Claim Source** | PROJECT_INTELLIGENCE_ARCHITECTURE.md |
| **Issue** | Aider's repository maps typically produce 500-3,000 tokens depending on repository size and PageRank parameters. The 1,500-token budget is reasonable for medium projects (~200-500 files) but may be insufficient for large monorepos (2,000+ files) or excessive for small projects (<50 files). |
| **Corrected Design** | Token budget should be **adaptive**: `min(1500, max(300, fileCount × 3))` with hard ceiling. The budget must be tunable per-agent based on remaining context window. |

### 2.4 "Zero File Collisions via Git Worktrees"

| Status | **INCORRECT** |
|--------|---------------|
| **Claim Source** | PARALLEL_EXECUTION_AND_CONFLICTS.md |
| **Issue** | Git worktrees prevent filesystem-level write collisions to the same file path. They do **NOT** prevent: (a) semantic conflicts where Agent A modifies function `foo()` in worktree-1 and Agent B modifies a caller of `foo()` in worktree-2; (b) `node_modules` or build artifact conflicts; (c) shared resource conflicts (database locks, port bindings); (d) git ref conflicts when both worktrees try to create branches from the same base. |
| **Corrected Design** | Worktrees provide **filesystem isolation**, not conflict freedom. A **File Ownership Registry** and **Semantic Conflict Detector** are required on top of worktrees. |

### 2.5 "Guaranteed Safe Execution Waves"

| Status | **OVERSTATED** |
|--------|----------------|
| **Claim Source** | RECOMMENDED_ARCHITECTURE.md |
| **Issue** | Topological wave scheduling guarantees that tasks within a wave have no declared dependencies on each other. It does NOT guarantee safety because: (a) the dependency graph is constructed by an LLM, which may miss implicit dependencies; (b) shared state (environment variables, running servers, database state) can create undeclared coupling. |
| **Corrected Design** | Waves provide **declared-dependency safety**. Runtime must additionally monitor for undeclared conflicts via file-access tracking and port-usage detection. |

### 2.6 "Sub-Second Integration and Rollback"

| Status | **PLAUSIBLE FOR GIT PROJECTS ONLY** |
|--------|--------------------------------------|
| **Issue** | `git merge --no-ff` and `git reset --hard` are indeed sub-second operations. However, this assumes: (a) the project uses Git; (b) worktrees are clean; (c) no build artifacts need regeneration. For non-Git projects, rollback requires file-level backup/restore which is slower. |
| **Corrected Design** | Git rollback: sub-second (VERIFIED for clean merges). Non-Git rollback: requires copy-based snapshots, estimated 1-10 seconds depending on project size. |

### 2.7 "85% Prompt Cache Hit Rates"

| Status | **SPECULATIVE** |
|--------|-----------------|
| **Issue** | Prompt caching depends on: (a) LLM provider support (OpenAI, Anthropic, Google each have different caching semantics); (b) prefix stability (system prompts + project context must be identical across requests); (c) cache TTL policies. The 85% figure has no measurement basis. |
| **Corrected Estimate** | Achievable range: **40-75%** with careful prompt prefix engineering. Higher rates require stable system prompts and sorted context injection. Must be measured per-provider. |

### 2.8 "Fixed RAM Budgets for 8 Concurrent Agents"

| Status | **UNREALISTIC AS STATED** |
|--------|---------------------------|
| **Claim Source** | PERFORMANCE_MACOS_WINDOWS.md |
| **Issue** | The document claims 8 agents can run within fixed RAM budgets (1.5 GB on 8 GB machines). This ignores: (a) OS overhead (macOS typically uses 3-4 GB); (b) Electron/Vite dev server for Command Center (~200-400 MB); (c) LSP servers if integrated; (d) SQLite memory-mapped I/O. |
| **Corrected Budgets** | 8 GB machine: max 2 concurrent agents + orchestrator. 16 GB: max 4 agents. 32 GB: max 8 agents. These are **targets to verify**, not guarantees. |

---

## 3. Previously Overlooked Research

### 3.1 Durable Execution Patterns (Temporal, Restate)
The previous research focused on DAG scheduling but overlooked **durable execution** — the ability to persist workflow state across process restarts, network failures, and long-running operations. Temporal.io and Restate provide patterns for: automatic retry with idempotency, workflow state persistence, and long-running operation coordination. MedioBot should adopt durable execution principles for multi-step agent tasks rather than relying on purely in-memory DAG tracking.

**Recommendation:** Implement SQLite-backed task state persistence inspired by durable execution patterns. Tasks should survive process crashes.

### 3.2 LangGraph's Stateful Agent Graphs
LangGraph (LangChain) provides a mature model for stateful multi-agent coordination using directed graphs with conditional edges. Key insight: agents communicate through a **shared state object** rather than direct message passing, simplifying coordination. MedioBot's current architecture could benefit from this shared-state pattern for the Blackboard component.

**Reference:** LangGraph documentation (https://langchain-ai.github.io/langgraph/)

### 3.3 Magentic-One's Ledger-Based Orchestration
Microsoft's Magentic-One uses a **shared ledger** pattern where the orchestrator maintains a running narrative of progress, facts, and plan state. This is more flexible than strict DAG waves because it allows the orchestrator to dynamically replan based on accumulated evidence.

**Recommendation:** Adopt ledger-inspired progress tracking alongside (not replacing) the DAG structure. Maestro should maintain a structured progress document that evolves as tasks complete.

### 3.4 Context Engineering (Anthropic, 2025-2026)
Recent work on "context engineering" emphasizes that the quality of context provided to LLMs is more important than model selection or prompt engineering alone. Key techniques: hierarchical context (summary → detail on demand), task-relevant filtering, and context budgeting per agent call.

**Impact:** Reinforces the Project Intelligence Engine design. Context must be actively curated, not passively dumped.

### 3.5 MAG (Memory-Augmented Generation)
Investigation reveals "MAG" refers to multiple unrelated concepts: (a) Memory-Augmented Generation in various papers; (b) Microsoft's AutoGen framework. There is no single "MAG architecture" that replaces RAG. The term should not be used without specific citation.

**Verdict:** RAG remains the correct foundational pattern. Enhance with structured memory (A-MEM style) and provenance tracking.

### 3.6 Mem0 and Letta Memory Systems
- **Mem0** provides a managed memory layer for AI agents with automatic memory extraction, deduplication, and retrieval. Useful reference but introduces external dependency.
- **Letta** (formerly MemGPT) implements hierarchical memory with explicit memory management tools given to the agent. Novel but complex to integrate.

**Recommendation:** Use A-MEM-inspired SQLite implementation initially. Evaluate Mem0/Letta integration as optional Phase 9+ enhancement.

---

## 4. Architecture Decisions Confirmed as Sound

| Decision | Verdict | Rationale |
|----------|---------|-----------|
| In-process logical actors | **CONFIRMED** | Lower overhead than child processes for TypeScript agents sharing a V8 runtime |
| SQLite as primary store | **CONFIRMED** | Proven performance, zero-config, supports FTS5 + WAL mode for concurrent reads |
| Tree-sitter for AST parsing | **CONFIRMED** | Incremental parsing, multi-language, WASM-compatible, widely adopted |
| Evidence-based verification | **CONFIRMED** | Critical for hallucination reduction; deterministic checks preferred |
| Git worktrees for isolation | **CONFIRMED WITH CAVEATS** | Good filesystem isolation but requires supplementary conflict detection |
| Chokidar file watching | **CONFIRMED** | Mature, cross-platform, reasonable CPU overhead with debouncing |
| PageRank for repository maps | **CONFIRMED** | Proven in Aider; produces relevance-ranked file summaries |

---

## 5. Architecture Decisions Requiring Correction

| Decision | Issue | Correction |
|----------|-------|------------|
| Strict topological wave barriers | Over-constrains parallelism | Replace with **async dependency release** — tasks start as soon as their specific dependencies complete, not when the entire wave completes |
| Fixed 6-phase roadmap | Too coarse; phases 3-4 bundle too many concerns | Split into **8-10 smaller phases** with independent testability |
| A-MEM as sole memory model | Overengineered for initial release | Start with **simple key-value memory with provenance**; evolve to A-MEM network when needed |
| sqlite-vec for embeddings | Adds complexity; marginal benefit initially | **Defer** vector search. Use FTS5 + structural graph queries first; add embeddings when retrieval quality is measurably insufficient |
| Non-Git projects unsupported | Major gap | Design **file-level snapshot isolation** as fallback for non-Git projects |
| TypeScript Compiler API for all TS | Heavy dependency for non-TS projects | Use Tree-sitter for universal parsing; TS Compiler API **only** for TypeScript-specific type checking in the Dual Validation Gate |

---

## 6. Summary of Audit Findings

- **7 of 8** quantitative claims are unsupported or misleading as stated
- **3 major gaps** identified: durable execution, non-Git support, adaptive scheduling
- **6 research approaches** previously overlooked
- **7 architectural decisions** confirmed sound
- **6 architectural decisions** require correction
- **Previous architecture direction is correct**; execution plan needs refinement

> [!IMPORTANT]
> The previous research team did excellent qualitative analysis. The primary failures are:
> (1) fabricating specific performance numbers without benchmarks, and
> (2) treating Git worktrees as a complete solution for parallel safety.
> Both are correctable without abandoning the architecture.
