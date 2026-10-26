# FINAL IMPLEMENTATION PHASES — MedioBot V2

> **Author:** Principal AI Systems Architect (Opus Audit)
> **Date:** 2026-10-13
> **Status:** PROPOSED — Replaces Previous 6-Phase Roadmap
> **Executor:** Gemini 3.8 Flash (in subsequent Goal Mode sessions)

---

## 1. Redesign Rationale

The previous 6-phase roadmap bundled too many concerns per phase and assumed components would work correctly on first implementation. The corrected roadmap uses **10 smaller, independently testable phases** with explicit prerequisites, acceptance criteria, and rollback strategies.

```mermaid
flowchart LR
    P0[Phase 0<br/>Baseline & Contracts] --> P1[Phase 1<br/>PIE Core Flagged]
    P1 --> P2[Phase 2<br/>Context Integration]
    P2 --> P3[Phase 3<br/>Task Persistence]
    P3 --> P4[Phase 4<br/>Resource Governor]
    P4 --> P5[Phase 5<br/>Workspace Isolation]
    P5 --> P6[Phase 6<br/>Dual Validation Gate]
    P6 --> P7[Phase 7<br/>Multi-Agent Scheduler]
    P7 --> P8[Phase 8<br/>Memory Engine]
    P8 --> P9[Phase 9<br/>Specialists]
    P9 --> P10[Phase 10<br/>Self-Improve]
```

---

## 2. Phase 0: Baseline Verification and Architecture Contracts

**Objective:** Establish that the current system works correctly before modifying it. Define TypeScript interfaces and non-negotiable safety invariants that all subsequent phases must implement.

**Scope:**
- Run all existing deterministic tests, typechecks, and production builds; record failures accurately without modifying unrelated code
- Formally record the **MiniMax live acceptance test status as EXPLICITLY UNVERIFIED** (two attempted requests failed with `ENOTFOUND` resolving `inference.dahl.global`; zero model completions occurred; cannot be marked verified)
- Create `packages/contracts/` with shared TypeScript interfaces, importing authoritative IDs from `@mediobot-v2/domain` to prevent duplicate type fracturing
- Document baseline performance benchmarks: startup time, idle process RSS, project discovery time, test execution time, TypeScript typecheck time, and production build time
- Codify the 10 Non-Negotiable Architectural Safety Contracts into documentation and shared contracts

**New Modules:**
- `packages/contracts/package.json` — Package configuration for `@mediobot-v2/contracts`
- `packages/contracts/tsconfig.json` — TypeScript configuration
- `packages/contracts/src/index.ts` — Shared interfaces (`TaskNode`, `FileOwnershipClaim`, `IndexReport`, `SafetyRuleContract`)

**Existing Modules Affected:**
- None modified — read-only audit, test execution, and benchmark measurement

**Acceptance Criteria:**
- [x] Baseline deterministic tests executed and documented accurately (`packages/domain`, `models`, `tools`, `runtime`, `cody`, `tester`, `command-center`)
- [x] MiniMax live acceptance test status explicitly documented as UNVERIFIED with network root cause
- [x] Baseline performance numbers measured and recorded in `docs/benchmarks/baseline.md`
- [x] `packages/contracts/` added to workspace and compiles cleanly with zero errors (`pnpm typecheck` code 0)
- [x] 10 Non-Negotiable Architectural Safety Contracts codified in architecture specifications
- [x] No production code modified

**Rollback:** N/A (no production code changes)

**Estimated Effort:** 1 Goal Mode session

---

## 3. Phase 1: Project Intelligence Engine — Core (Feature-Flagged)

**Objective:** Build Tree-sitter AST parsing and SQLite symbol storage safely behind a disabled feature flag, preserving the existing 35-file scan as active fallback.

**Scope:**
- Integrate `web-tree-sitter` (WASM) into the monorepo
- Implement symbol extraction for TypeScript/JavaScript
- Create SQLite database schema (`project-intelligence.db`) with WAL mode and foreign keys
- **SQLite Safety Guarantee:** SQLite corruption or migration error NEVER triggers destructive database deletion; corrupt files are quarantined to `.corrupt-<timestamp>`
- Implement full-index and incremental-update operations
- Implement FTS5 search over symbol names
- Add Chokidar file watcher with debounced change dispatch
- **Feature Flag Requirement:** Must start behind disabled feature flag (`USE_PROJECT_INTELLIGENCE=false`). When disabled, `discoverProjectIntelligence()` in `packages/maestro/src/discovery.ts` remains the active fallback

**New Modules:**
- `packages/intelligence/src/index.ts` — ProjectIntelligenceEngine
- `packages/intelligence/src/parser.ts` — Tree-sitter wrapper
- `packages/intelligence/src/extractor.ts` — AST → symbol extraction
- `packages/intelligence/src/store.ts` — SQLite operations (non-destructive)
- `packages/intelligence/src/watcher.ts` — File change monitoring

**Existing Modules Affected:**
- `packages/maestro/src/discovery.ts` — Add PIE fallback path (strictly gated by feature flag)

**SQLite Schema:** As specified in [PROJECT_INTELLIGENCE_SPEC.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/PROJECT_INTELLIGENCE_SPEC.md)

**Acceptance Criteria:**
- [ ] Feature flag `USE_PROJECT_INTELLIGENCE` defaults to `false`
- [ ] Proven legacy discovery (`discoverProjectIntelligence`) remains active and verified when feature flag is disabled
- [ ] Database corruption recovery quarantines corrupted file and creates fresh DB without deleting old data
- [ ] Full index of MedioBot V2 repo (~200 files) completes in < 5 seconds when flag enabled
- [ ] Symbol search returns correct results for known symbols
- [ ] FTS5 search for "Maestro" returns relevant symbols
- [ ] Incremental update on single file change completes in < 100ms
- [ ] File watcher CPU usage < 1% during idle editing
- [ ] Unit tests for parser, extractor, and store modules pass

**Rollback:** Set `USE_PROJECT_INTELLIGENCE=false` → legacy `discoverProjectIntelligence()` activates immediately

**Estimated Effort:** 2 Goal Mode sessions

---

## 4. Phase 2: Shared Context Integration

**Objective:** Connect the PIE to Maestro's context compilation so all agents receive richer project understanding.

**Scope:**
- Implement PageRank-based RepoMap generator
- Modify `compileMaestroContext` to include PIE output
- Implement adaptive token budgeting for RepoMap
- Add dependency graph queries (imports/importedBy)
- Add project metadata detection (frameworks, languages, etc.)

**Existing Modules Affected:**
- `packages/maestro/src/context.ts` — Extend `compileMaestroContext()` with PIE data
- `packages/maestro/src/index.ts` — Pass PIE context to agent prompts

**New Modules:**
- `packages/intelligence/src/repomap.ts` — RepoMap generation
- `packages/intelligence/src/metadata.ts` — Project metadata detection

**Acceptance Criteria:**
- [ ] RepoMap generation produces < 2,000 tokens for 500-file project
- [ ] RepoMap prioritizes high-PageRank files
- [ ] Focus files/symbols boost correctly affects ranking
- [ ] Maestro receives and includes PIE context in prompts
- [ ] Cody receives project intelligence when delegated
- [ ] No regression in existing Maestro → Cody delegation flow

**Rollback:** Remove PIE integration from `compileMaestroContext`; revert to legacy

**Estimated Effort:** 1 Goal Mode session

---

## 5. Phase 3: Durable Task Persistence & SQLite Safety

**Objective:** Persist task state to SQLite so multi-step operations survive process restarts, with strict guarantees against destructive database cleanup.

**Scope:**
- Create task execution table in SQLite
- Implement TaskStore with CRUD operations
- **SQLite Safety Guarantee:** Corruption or migration failure NEVER drops, resets, or purges user databases; corrupt files are quarantined to `.corrupt-<timestamp>` and reported
- Extend `InMemoryWorld` to persist critical events to SQLite
- Add task status tracking (pending, running, completed, failed)
- Implement task recovery and reconciliation on process restart

**New Modules:**
- `packages/runtime/src/task-store.ts` — SQLite-backed task persistence (non-destructive)

**Existing Modules Affected:**
- `packages/runtime/src/index.ts` — Integrate TaskStore with WorkerRuntime

**SQLite Schema:** As specified in [CORRECTED_ARCHITECTURE.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/CORRECTED_ARCHITECTURE.md)

**Acceptance Criteria:**
- [ ] Task state survives Node.js process restart
- [ ] TaskStore correctly records all task lifecycle transitions
- [ ] Corrupt database simulation successfully quarantines file without deleting user data
- [ ] No regression in existing single-agent task flow
- [ ] Database queries for task status complete in < 5ms

**Rollback:** Remove TaskStore integration; tasks remain in-memory only

**Estimated Effort:** 1 Goal Mode session

---

## 6. Phase 4: Resource Governor and Concurrency Limits

**Objective:** Enforce strict hardware-aware resource limits and process monitoring BEFORE enabling parallel multi-agent execution.

**Scope:**
- Implement system resource detection (RAM, CPU, platform)
- Enforce strict concurrency quotas based on available hardware:
  * 8 GB RAM: max 2 concurrent agents + orchestrator
  * 16 GB RAM: max 4 concurrent agents
  * 32 GB RAM: max 8 concurrent agents
- Implement process memory monitoring and graceful throttling when free memory < 20%
- Implement cooperative worker pause/backoff under resource exhaustion
- Provide concurrency gate interfaces for the subsequent scheduler

**New Modules:**
- `packages/runtime/src/resource-governor.ts` — Resource monitoring, concurrency quotas, and memory guards

**Existing Modules Affected:**
- `packages/runtime/src/index.ts` — Gate worker execution through ResourceGovernor

**Acceptance Criteria:**
- [ ] Concurrency quotas strictly enforced (requests exceeding quota are queued, never dropped)
- [ ] Memory pressure detection triggers graceful backoff when free memory < 20%
- [ ] Resource monitoring incurs < 0.5% CPU overhead
- [ ] Unit tests verify quota rejection and queue drainage

**Rollback:** Fix concurrency at 1 worker (safe sequential execution)

**Estimated Effort:** 1 Goal Mode session

---

## 7. Phase 5: Workspace Isolation Manager

**Objective:** Enable agents to work in isolated workspaces without touching or modifying the user's working-tree files.

**Scope:**
- Implement Git worktree strategy for Git repositories
- Implement file snapshot strategy for non-Git projects
- **Working-Tree Safety Guarantee:** NEVER stash, reset, checkout, or modify the user's uncommitted working-tree files. Worktrees are branched cleanly from HEAD or commit refs without touching working-tree state
- **File Overwrite Protection:** NEVER overwrite or collide with user files during isolation setup; collisions fail closed
- Scope agent tool invocations strictly to isolated workspace paths
- Implement safe worktree cleanup on task completion/crash without deleting unmerged work

**New Modules:**
- `packages/isolation/src/index.ts` — WorkspaceIsolationManager
- `packages/isolation/src/git-strategy.ts` — Git worktree implementation (non-destructive)
- `packages/isolation/src/snapshot-strategy.ts` — File snapshot implementation
- `packages/isolation/src/cleanup.ts` — Safe orphan detection and recovery

**Existing Modules Affected:**
- `packages/tools/` — Tool wrappers scoped to isolated workspace roots

**Acceptance Criteria:**
- [ ] Two agents work in separate isolated worktrees simultaneously
- [ ] User working tree uncommitted dirty files remain 100% untouched throughout isolation lifecycle
- [ ] No `git stash` or `git reset` commands are executed
- [ ] Non-Git projects isolate via snapshot copy without modifying source files
- [ ] Worktree creation < 500ms
- [ ] Crash recovery cleans up temp worktrees safely without touching user workspace

**Rollback:** Disable isolation; agents operate in sequential read/write mode with explicit user confirmations

**Estimated Effort:** 2 Goal Mode sessions

---

## 8. Phase 6: Dual Validation Gate (DVG)

**Objective:** Validate all agent modifications deterministically before allowing any integration into the user workspace.

**Scope:**
- Implement Gate 1 (static verification: syntax, AST structure, imports, TypeScript type check)
- Implement Gate 2 (execution verification: targeted test runner and assertion verification)
- **Zero Unverified Merges Guarantee:** Never automatically merge unverified agent changes. Changes that fail Gate 1 or Gate 2 are quarantined with diagnostic reports; merge requires explicit user approval
- Implement circuit breaker for looping or repeatedly failing agents (trips after 3 identical failures)
- Implement structured failure taxonomy and remediation recommendations

**New Modules:**
- `packages/verification/src/static-gate.ts` — Static verification checks
- `packages/verification/src/execution-gate.ts` — Test execution checks
- `packages/verification/src/circuit-breaker.ts` — Loop detection
- `packages/verification/src/failure-taxonomy.ts` — Failure classification

**Existing Modules Affected:**
- `packages/isolation/src/index.ts` — Route all integration requests through DVG

**Acceptance Criteria:**
- [ ] Syntax errors and broken imports in agent changes rejected 100% of the time
- [ ] Unverified agent claims never trigger automatic workspace merges
- [ ] Circuit breaker trips after 3 consecutive verification failures
- [ ] Test regressions block merge and output structured failure diagnostic
- [ ] User can inspect diff and explicitly authorize manual force-merge

**Rollback:** Disable automatic integration; all changes require manual user patch review

**Estimated Effort:** 2 Goal Mode sessions

---

## 9. Phase 7: Multi-Agent Async Scheduler & Safe Integration

**Objective:** Enable Maestro to dispatch multiple concurrent tasks governed by resource quotas, isolated workspaces, and verification gates.

**Scope:**
- Implement `plan_multi_task` decision type in Maestro with dynamic DAG representation
- Build async dependency scheduler (tasks start immediately when dependencies resolve)
- Implement exclusive File Ownership Registry to prevent overlapping file mutations
- Connect scheduler to Phase 4 (Resource Governor), Phase 5 (Workspace Isolation), and Phase 6 (DVG)
- Add progress ledger tracking and extended SSE events for multi-agent observability

**New Modules:**
- `packages/orchestration/src/scheduler.ts` — Async dependency scheduler
- `packages/orchestration/src/ownership.ts` — File ownership registry
- `packages/orchestration/src/ledger.ts` — Progress ledger

**Existing Modules Affected:**
- `packages/maestro/src/index.ts` — Handle `plan_multi_task` decisions
- `packages/runtime/src/index.ts` — Multi-worker submission support
- `apps/command-center/src/server.ts` — Extended SSE multi-agent event stream

**Acceptance Criteria:**
- [ ] Scheduler dispatches tasks respecting DAG dependencies
- [ ] Resource Governor limits prevent system oversubscription
- [ ] File ownership prevents simultaneous writes to identical files
- [ ] Progress ledger accurately reports multi-agent execution state
- [ ] Unverified task outputs are blocked by DVG before integration
- [ ] Single-agent legacy delegation remains completely functional as fallback

**Rollback:** Disable `plan_multi_task` decision type; Maestro reverts to single delegation

**Estimated Effort:** 2 Goal Mode sessions

---

## 10. Phase 8: Memory Engine

**Objective:** Enable cross-session knowledge persistence with provenance tracking.

**Scope:**
- Implement SQLite memory store with WAL mode
- Implement memory retrieval with FTS5
- Implement file-linked memory invalidation (file modification invalidates linked memories)
- Implement confidence decay and memory ranking
- Integrate memory retrieval into agent context compilation

**New Modules:**
- `packages/memory/src/index.ts` — MemoryEngine
- `packages/memory/src/store.ts` — SQLite memory operations
- `packages/memory/src/retrieval.ts` — Search and ranking
- `packages/memory/src/invalidation.ts` — File-change-triggered invalidation

**Acceptance Criteria:**
- [ ] Memories persist across process restarts
- [ ] FTS5 retrieval returns relevant memories in < 10ms
- [ ] File changes invalidate linked memories
- [ ] Memory database < 50 MB after 1,000 entries
- [ ] Legacy stateless operation remains available when memory is disabled

**Rollback:** Remove memory integration from context compilation; agents operate statelessly

**Estimated Effort:** 1-2 Goal Mode sessions

---

## 11. Phase 9: Specialist Agent Roster

**Objective:** Upgrade Tester to tool-capable agent and register specialized Mediobot definitions.

**Scope:**
- Upgrade Tester from text-worker to tool-capable agent with targeted test execution tools
- Register Doc specialist with documentation editing capabilities
- Define contracts for Dessy (UI/UX), Weby (research), Scraapy (extraction)
- Implement JIT skill injection based on task context

**Existing Modules Affected:**
- `packages/tester/src/` — Upgrade to tool-capable verification agent
- `packages/maestro/src/definitions.ts` — Register specialist definitions

**New Modules:**
- `packages/doc/src/` — Documentation specialist agent

**Acceptance Criteria:**
- [ ] Tester independently executes tests and reports deterministic evidence
- [ ] Doc reads and updates documentation without altering codebase logic
- [ ] JIT skill injection reduces prompt overhead by > 30%

**Rollback:** Revert to current roster (Maestro + Cody + text-workers)

**Estimated Effort:** 2 Goal Mode sessions

---

## 12. Phase 10: Controlled Self-Improvement

**Objective:** Enable MedioBot to learn from task outcomes and improve performance over time under strict user approval gating.

**Scope:**
- Implement agent performance metrics tracking
- Store successful workflows as procedural memories
- Implement prompt variant evaluation
- **Safety Invariant:** Zero automatic modification of security policies, tool permissions, or system definitions; all improvements require explicit user approval

**New Modules:**
- `packages/runtime/src/metrics.ts` — Performance tracking
- `packages/runtime/src/improvement.ts` — Controlled adaptation logic

**Acceptance Criteria:**
- [ ] Performance metrics track agent success rates accurately
- [ ] Successful workflows stored as procedural memories
- [ ] No modifications to system prompts or security policies without user approval

**Rollback:** Disable improvement engine; agents operate with static configuration

**Estimated Effort:** 1 Goal Mode session

---

## 13. Phase Dependencies Summary

| Phase | Description | Depends On | Safety Prerequisite Justification |
|-------|-------------|------------|-----------------------------------|
| 0 | Baseline & Safety Contracts | None | Must be first; defines immutable invariants and verifies baseline |
| 1 | PIE Core (Disabled Feature Flag) | 0 | Starts behind disabled flag; legacy discovery remains active fallback |
| 2 | Shared Context Integration | 1 | Builds on PIE; preserves fallback if disabled |
| 3 | Durable Task Persistence | 0 | Independent persistence concern; non-destructive SQLite safety |
| 4 | Resource Governor & Limits | 3 | **MANDATORY BEFORE PARALLEL EXECUTION**: Establishes hard concurrency & RAM bounds |
| 5 | Workspace Isolation Manager | 4 | **MANDATORY BEFORE PARALLEL WRITES**: Prevents user working-tree modifications |
| 6 | Dual Validation Gate (DVG) | 5 | **MANDATORY BEFORE MERGING**: Prevents unverified changes from reaching workspace |
| 7 | Multi-Agent Async Scheduler | 2, 4, 5, 6 | Safe parallel execution: bounded by P4, isolated by P5, gated by P6 |
| 8 | Memory Engine | 2, 3 | Cross-session provenance persistence; can develop in parallel with P9 |
| 9 | Specialist Agent Roster | 7 | Upgrades Tester and Doc for multi-agent pod execution |
| 10 | Controlled Self-Improvement | 7, 8, 9 | Must be last; user-approval gated calibration |

---

## 14. Total Estimated Effort

| Phase | Name | Sessions | Cumulative |
|-------|------|----------|------------|
| 0 | Baseline Verification & Contracts | 1 | 1 |
| 1 | PIE Core (Feature Flagged) | 2 | 3 |
| 2 | Context Integration | 1 | 4 |
| 3 | Task Persistence & SQLite Safety | 1 | 5 |
| 4 | Resource Governor & Concurrency | 1 | 6 |
| 5 | Workspace Isolation Manager | 2 | 8 |
| 6 | Dual Validation Gate | 2 | 10 |
| 7 | Multi-Agent Async Scheduler | 2 | 12 |
| 8 | Memory Engine | 1.5 | 13.5 |
| 9 | Specialist Agent Roster | 2 | 15.5 |
| 10 | Controlled Self-Improvement | 1 | 16.5 |

**Total: ~16.5 Goal Mode sessions** (Safety-first sequential ordering ensuring no subsystem runs unisolated or unverified)

