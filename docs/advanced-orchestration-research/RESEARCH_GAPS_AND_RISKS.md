# RESEARCH GAPS AND RISKS — MedioBot V2

> **Author:** Principal AI Systems Architect (Opus Audit)
> **Date:** 2026-10-13
> **Status:** FINAL RISK ASSESSMENT

---

## 1. Known Research Gaps

### 1.1 LLM-Generated Task Decomposition Quality

**Gap:** The entire multi-agent architecture depends on Maestro correctly decomposing user goals into task DAGs. There is no published benchmark for LLM task decomposition accuracy in software engineering contexts.

**Risk Level:** HIGH

**Mitigation:**
- Single-agent fallback must always work (bypass multi-agent entirely)
- Validate DAG structure before execution (no cycles, all agents exist, file ownership non-overlapping)
- Start with conservative decomposition (2-3 tasks max) and increase complexity gradually
- Log all decompositions for post-hoc analysis

### 1.2 Tree-sitter Symbol Extraction Completeness

**Gap:** Tree-sitter grammars vary in quality across languages. Some language features (macros, metaprogramming, complex generics) may not extract correctly.

**Risk Level:** MEDIUM

**Mitigation:**
- Start with TypeScript/JavaScript only (best-maintained grammars)
- Add languages incrementally, with extraction quality tests per language
- Fall back to regex-based extraction for unsupported languages
- PIE provides "best effort" intelligence, not guaranteed completeness

### 1.3 Git Worktree Performance at Scale

**Gap:** No published benchmarks for git worktree performance with 4-8 concurrent worktrees on large repositories (10,000+ files). Shared `.git/` directory may become a bottleneck.

**Risk Level:** MEDIUM

**Mitigation:**
- Serialize git operations through a command queue (prevent concurrent `.git/` access)
- Benchmark on MedioBot V2 itself before deploying to larger repos
- Fall back to file snapshot strategy if worktree performance degrades
- Set maximum worktree count based on measured performance

### 1.4 Cross-Agent Semantic Conflict Detection

**Gap:** Detecting semantic conflicts (e.g., Agent A changes a function signature, Agent B calls the old signature) requires understanding program semantics beyond AST-level analysis.

**Risk Level:** MEDIUM-HIGH

**Mitigation:**
- Phase 1: Rely on file ownership to prevent concurrent edits to related files
- Phase 2: Use dependency graph to identify related files and assign to same agent
- Phase 3: Run full type-check after merge to catch remaining issues
- Accept that some semantic conflicts will only be caught by tests

### 1.5 Memory Staleness and Hallucination Amplification

**Gap:** Memories created from LLM inferences may be recalled as "facts" in future sessions, amplifying original hallucinations. No established pattern for preventing memory-based hallucination chains.

**Risk Level:** MEDIUM

**Mitigation:**
- Confidence model tags LLM-inferred memories at 0.5 (not treated as facts)
- File-linked invalidation removes stale memories when source changes
- Deterministic evidence (tool results, test outcomes) always overrides recalled memories
- Regular consolidation prunes low-access, low-confidence memories

### 1.6 Prompt Cache Hit Rate Uncertainty

**Gap:** Prompt caching behavior varies across providers and is not well-documented. Cache TTLs, prefix matching algorithms, and cost savings are provider-specific.

**Risk Level:** LOW

**Mitigation:**
- Design prompts for stable prefixes (system prompt → project context → task-specific)
- Measure actual cache hit rates per provider
- Don't rely on caching for correctness — only for cost optimization

---

## 2. Technical Risks

### 2.1 web-tree-sitter WASM Compatibility

**Risk:** Tree-sitter WASM may not work in all Node.js environments or may have performance issues on Windows.

**Likelihood:** LOW (widely used in VS Code, Zed, Helix)

**Impact:** HIGH (PIE is the foundation for all subsequent phases)

**Mitigation:** Test on all target platforms in Phase 1. Have regex-based fallback ready.

### 2.2 SQLite Concurrency Under Heavy Write Load

**Risk:** Multiple agents writing to the same SQLite database may cause `SQLITE_BUSY` errors despite WAL mode.

**Likelihood:** MEDIUM (WAL mode allows concurrent reads but serializes writes)

**Impact:** MEDIUM (writes may be delayed but not lost)

**Mitigation:**
- `PRAGMA busy_timeout = 5000` — automatic retry for 5 seconds
- Batch writes into transactions (reduce lock contention)
- Separate databases for different concerns (intelligence, memory, audit)
- Single write connection; multiple read connections

### 2.3 Agent Cost Explosion

**Risk:** Multi-agent parallel execution could significantly increase API costs if not properly budgeted.

**Likelihood:** HIGH (more agents = more LLM calls)

**Impact:** HIGH (user may incur unexpected costs)

**Mitigation:**
- Token budget per goal (configurable by user)
- Token usage tracking and reporting
- Budget warnings at 50%, 75%, 90% usage
- Auto-pause at 100% budget with user prompt to continue
- Prefer cheaper models for specialist tasks (text workers, test verification)

### 2.4 Orphaned Worktrees After Crashes

**Risk:** If the process crashes during multi-agent execution, git worktrees and branches may be left behind.

**Likelihood:** MEDIUM (crashes happen)

**Impact:** LOW (disk space waste, potential confusion)

**Mitigation:**
- Startup cleanup: `git worktree prune` + scan for `mediobot/task-*` branches
- Track active worktrees in SQLite; reconcile on startup
- User notification if orphaned worktrees found

### 2.5 Windows File Locking Issues

**Risk:** Windows file locking semantics differ from POSIX. Files opened by one process cannot be modified by another, causing `EBUSY` errors.

**Likelihood:** HIGH (common Windows issue with Node.js)

**Impact:** MEDIUM (operations fail but can be retried)

**Mitigation:**
- Exponential backoff retry for all file operations on Windows
- Ensure all file handles are promptly closed (especially in Tree-sitter parsing)
- Use directory junctions instead of symlinks

---

## 3. Architectural Risks

### 3.1 Single-Process Scalability Ceiling

**Risk:** Running all agents in a single Node.js process limits scalability. The V8 event loop becomes the bottleneck when 8+ agents are active.

**Likelihood:** MEDIUM (depends on workload)

**Impact:** MEDIUM (performance degradation, not failure)

**Mitigation:**
- For Phase 1-8: single process is sufficient for 4 agents
- For 8+ agents: evaluate worker_threads for CPU-intensive tasks (Tree-sitter parsing, RepoMap generation)
- Do NOT move to multi-process until single-process ceiling is measured

### 3.2 Architecture Over-Engineering

**Risk:** The architecture is designed for 8 concurrent agents, but most real tasks need 1-2 agents. Over-engineering the parallel infrastructure may delay useful improvements.

**Likelihood:** MEDIUM

**Impact:** MEDIUM (wasted effort, delayed value delivery)

**Mitigation:**
- **Phase 0-2 deliver value immediately** (better project understanding) without any multi-agent complexity
- Multi-agent features are strictly additive — single-agent path preserved
- Each phase delivers independently useful functionality
- Defer Phases 8-10 if earlier phases take longer than expected

### 3.3 Model Provider Dependency

**Risk:** The architecture is designed around cloud LLM APIs. Provider outages, rate limits, or API changes could break the system.

**Likelihood:** MEDIUM

**Impact:** HIGH (system non-functional during outages)

**Mitigation:**
- Multi-provider support already exists in the codebase
- Automatic failover between providers
- Graceful degradation: if LLM is unavailable, report to user rather than crash
- Consider local model support (Ollama, llama.cpp) as fallback for basic tasks

---

## 4. Gaps Relative to State-of-the-Art

### 4.1 No Benchmark Suite

MedioBot V2 has no equivalent of SWE-bench, HumanEval, or similar benchmark suites for measuring end-to-end task completion quality.

**Recommendation:** Create a "Golden Test Suite" of 10-20 real-world coding tasks with known correct solutions. Run after each phase to measure improvement.

### 4.2 No User Study Data

No data on how real users interact with multi-agent coding assistants. Architecture assumptions about task complexity distribution are unvalidated.

**Recommendation:** Instrument usage analytics (opt-in) to understand: task types, delegation frequency, failure rates, user overrides.

### 4.3 No Comparison with Existing Systems

No systematic comparison with Cursor, Windsurf, Cline, Aider, or other coding assistants.

**Recommendation:** Not a priority — focus on building a differentiated system. Compare once Phases 0-6 are complete.

---

## 5. Risk Summary Matrix

| Risk | Likelihood | Impact | Phase Affected | Mitigation Status |
|------|-----------|--------|----------------|-------------------|
| LLM task decomposition quality | High | High | 4 | Planned (fallback) |
| Tree-sitter compatibility | Low | High | 1 | Planned (fallback parser) |
| SQLite concurrency | Medium | Medium | 3-7 | Planned (WAL + busy_timeout) |
| Agent cost explosion | High | High | 4+ | Planned (budgets) |
| Semantic conflict detection | Medium | High | 5 | Partially planned |
| Memory hallucination amplification | Medium | Medium | 7 | Planned (confidence model) |
| Windows file locking | High | Medium | All | Planned (retry logic) |
| Architecture over-engineering | Medium | Medium | All | Mitigated (phased approach) |
| Single-process ceiling | Medium | Medium | 9+ | Deferred (measure first) |
| No benchmark suite | N/A | High | All | Recommended for Phase 0 |

---

## 6. Recommended Risk Mitigations for Phase 0

Before starting implementation, establish:

1. **Automated test suite** that runs on every change (`pnpm test`)
2. **Benchmark baseline** for startup, idle RSS, and task completion time
3. **Feature flag convention** for all new capabilities
4. **Rollback documentation** for every phase
5. **Cost monitoring** for LLM API usage during development

These foundational practices reduce the likelihood and impact of all subsequent risks.
