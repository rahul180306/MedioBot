# 13. Architecture Decision Matrix: Comparative Evaluation of Structural Candidates

> **Component:** Architectural Trade-off Analysis & Framework Selection  
> **Status:** Architecture Research & Specification Document  
> **Priority:** Tier 1 — Strategic Decision Foundation  
> **Authors:** Principal AI Systems Architect, Distributed Systems Architect, Software Engineering Productivity Researcher  

---

## 1. Executive Summary & Evaluation Methodology

Selecting the architectural foundation for MedioBot V2 is a critical decision. A mistake here results either in an unmaintainable monolith, a slow and brittle framework dependency, or an over-engineered distributed system that cannot run on a developer's laptop.

In accordance with Section 13 of the research specification, we evaluate **three credible architectural candidates**:

1. **Candidate A: In-Place Evolution of Existing Maestro Runtime**  
   Retain the current `packages/orchestration/src/maestro.ts` and `WorkspaceManager.ts` foundation; incrementally patch in parallel promise dispatches and SQLite tables.
2. **Candidate B: Full Adoption of an External Graph Framework (LangGraph / AutoGen 0.4)**  
   Rip out custom orchestration; rewrite the multi-agent system on top of an external graph framework (e.g., `@langchain/langgraph` or Microsoft AutoGen / Agent Framework).
3. **Candidate C: The Hybrid Autonomous Agile Pod Architecture**  
   Preserve proven MedioBot V2 foundations (SQLite continuity, SSE event contracts, React Command Center UI, Vite build), but construct a specialized, TypeScript-native orchestration layer incorporating **Topological Wave Execution (SPOQ)**, **Git Worktree Isolation**, **Tree-sitter AST SymGraph (RepoIntel)**, and **In-Process Logical Actors**.

---

## 2. Evaluation Criteria & Weighting Rationale

We establish a weighted decision matrix across 13 engineering criteria. Weights sum to 100% and reflect the realities of building an enterprise-grade, local-first coding assistant:

| Evaluation Criterion | Weight | Justification & Assumptions |
| :--- | :---: | :--- |
| **1. Reliability & Grounding** | **12%** | If code generated breaks builds or hallucinates, the tool is useless regardless of speed. |
| **2. Deep Project Understanding** | **12%** | The core differentiator: understanding 100k-line repos without overflowing tokens. |
| **3. Multi-Agent Parallelism** | **10%** | Ability for 4–8 agents to execute concurrently without file overwrites or race conditions. |
| **4. Low RAM & CPU Overhead** | **10%** | Must run smoothly on 8 GB and 16 GB MacBook/Windows laptops alongside active dev servers. |
| **5. Cognitive Memory & Retrieval** | **9%** | Cross-session persistence of user preferences, conventions, and failure invariants. |
| **6. Security & Sandboxing** | **9%** | Filesystem containment, secret redaction, and protection against indirect prompt injection. |
| **7. Cross-Platform Parity (Mac/Win)** | **8%** | Seamless operation across macOS ARM64 and Windows NT paths and file locking. |
| **8. Real-Time Latency & Responsiveness** | **8%** | Fast user feedback via SSE streams; prompt prefix caching compatibility. |
| **9. Extensibility (New Agents/Tools)** | **6%** | Ease of plugging in new specialists (Tester, Dessy, Vision) via clean contracts. |
| **10. UI & Event Protocol Fit** | **5%** | Native alignment with existing Command Center SSE stream contracts and timeline UI. |
| **11. Implementation Complexity** | **4%** | Feasibility of delivery without multi-month architectural rewrites. |
| **12. Long-Term Maintenance Burden** | **4%** | Freedom from upstream framework breaking changes and dependency churn. |
| **13. Code Accuracy (SWE-bench)** | **3%** | Expected benchmark performance on complex multi-file engineering problems. |
| **Total** | **100%** | |

---

## 3. Detailed Candidate Analysis

### 3.1 Candidate A: In-Place Evolution of Existing Maestro Runtime
- **Concept:** Take the current `packages/orchestration/src/maestro.ts` (which delegates to Cody in sequential fallback turns) and add `Promise.all` loops for parallel dispatch, while keeping the regex-based `discoverProjectIntelligence`.
- **Pros:** Lowest initial implementation effort; preserves 100% of current code; zero new concepts.
- **Cons:** Fails completely on parallelism safety (no worktree isolation means concurrent agents overwrite files); naive 35-file directory scan cannot scale to real repositories; memory remains limited to raw chat logs; sequential bottleneck remains baked into the architecture.

### 3.2 Candidate B: Full Adoption of External Framework (LangGraph / AutoGen)
- **Concept:** Replace custom orchestration with `@langchain/langgraph` (StateGraph, Checkpointer) or Microsoft AutoGen 0.4.
- **Pros:** Proven academic patterns; pre-built graph visualizers; community checkpointing primitives.
- **Cons:** High impedance mismatch with existing MedioBot V2 event contracts; heavy dependency tree (hundreds of transient npm packages); Python-first ecosystem (JS/TS ports often lag in feature parity and documentation); poor native primitives for local Git worktree isolation and OS file-locking; high RAM bloat; difficult to customize low-level Tree-sitter AST queries.

### 3.3 Candidate C: Hybrid Autonomous Agile Pod Architecture
- **Concept:** Retain the working MedioBot V2 core (SQLite session store, SSE event dispatch, WorkspaceManager path checks, React UI timeline). Build a purpose-engineered TypeScript layer implementing:
  1. *Topological Wave Execution (SPOQ)* for dependency DAGs.
  2. *Git Worktree Isolation Manager (WIM)* for physical file isolation.
  3. *In-Process RepoIntel Engine* (Tree-sitter + TS Compiler API + SQLite SymGraph).
  4. *Multi-Tier SQLite Memory* (A-MEM Zettelkasten + D-MEM gating).
  5. *Dual Validation Gates* for merge verification.
- **Pros:** Best-in-class performance and low memory; zero dependency lock-in; exact fit with existing SSE contracts and UI; true Git worktree file isolation; microsecond in-process communication.
- **Cons:** Requires implementing the custom DAG scheduler and Git worktree coordinator (moderate engineering complexity).

---

## 4. The Weighted Decision Matrix

Scores are assigned from **1 to 10** (1 = Catastrophic / Inadequate, 5 = Acceptable, 10 = Exceptional).

| Evaluation Criteria | Weight | Candidate A: Evolve Maestro | Candidate B: External Framework | Candidate C: Hybrid Agile Pod |
| :--- | :---: | :---: | :---: | :---: |
| 1. Reliability & Grounding | 12% | 4 (Score: 0.48) | 7 (Score: 0.84) | **9 (Score: 1.08)** |
| 2. Deep Project Understanding | 12% | 3 (Score: 0.36) | 6 (Score: 0.72) | **9 (Score: 1.08)** |
| 3. Multi-Agent Parallelism | 10% | 2 (Score: 0.20) | 6 (Score: 0.60) | **9 (Score: 0.90)** |
| 4. Low RAM & CPU Overhead | 10% | 7 (Score: 0.70) | 3 (Score: 0.30) | **9 (Score: 0.90)** |
| 5. Cognitive Memory & Retrieval | 9% | 3 (Score: 0.27) | 7 (Score: 0.63) | **9 (Score: 0.81)** |
| 6. Security & Sandboxing | 9% | 4 (Score: 0.36) | 5 (Score: 0.45) | **9 (Score: 0.81)** |
| 7. Cross-Platform Parity (Mac/Win) | 8% | 5 (Score: 0.40) | 5 (Score: 0.40) | **9 (Score: 0.72)** |
| 8. Real-Time Latency | 8% | 6 (Score: 0.48) | 4 (Score: 0.32) | **9 (Score: 0.72)** |
| 9. Extensibility (New Specialists) | 6% | 4 (Score: 0.24) | 8 (Score: 0.48) | **9 (Score: 0.54)** |
| 10. UI & Event Protocol Fit | 5% | 8 (Score: 0.40) | 3 (Score: 0.15) | **10 (Score: 0.50)** |
| 11. Implementation Complexity | 4% | **9 (Score: 0.36)** | 5 (Score: 0.20) | 6 (Score: 0.24) |
| 12. Maintenance Burden | 4% | 6 (Score: 0.24) | 4 (Score: 0.16) | **8 (Score: 0.32)** |
| 13. Code Accuracy (SWE-bench) | 3% | 4 (Score: 0.12) | 7 (Score: 0.21) | **9 (Score: 0.27)** |
| **Weighted Total Score** | **100%** | **4.61 / 10.0** | **5.46 / 10.0** | **8.89 / 10.0** |

---

## 5. Architectural Decision & Final Recommendation

### Final Verdict: Select Candidate C (Hybrid Autonomous Agile Pod Architecture)

- **Why Candidate A Failed:**  
  Candidate A scores lowest (4.61). Attempting to bolt multi-agent parallelism onto the existing sequential Maestro loop without Git worktree isolation will inevitably trigger catastrophic file-write collisions, race conditions, and repository corruption.
- **Why Candidate B Failed:**  
  Candidate B scores 5.46. While external frameworks provide abstract graph nodes, they fail to solve the hard, physical systems engineering challenges of local coding assistants: OS-level file locking on Windows, Git worktree lifecycle management, native in-process Tree-sitter indexing, and low-RAM execution on 8 GB/16 GB laptops.
- **Why Candidate C Wins Decisively:**  
  Candidate C achieves **8.89 / 10.0**. It combines the stability and UI-integration of existing MedioBot components with state-of-the-art patterns from top 2024–2026 research (SPOQ wave dispatch, Prometheus repository maps, A-MEM memory, and Git worktrees). It delivers enterprise-grade multi-agent safety with minimal hardware overhead.

---

## 6. Summary & Transition to Recommended Architecture

With the architectural foundation definitively selected, we proceed to **Deliverable 14: Recommended Architecture**, where the complete structural design of the Autonomous Agile Pod is specified with end-to-end component diagrams, contract schemas, and interaction flows.
