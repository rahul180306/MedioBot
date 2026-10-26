# IMPLEMENTATION_ROADMAP.md — Phased Architecture Implementation Roadmap

**Document Status:** Phased Engineering Plan  
**Date:** October 2026  
**Target:** MedioBot V2 Local-First Multi-Agent Coding Platform  
**Scope:** Sequencing, Test Criteria, Risk Mitigations, and Acceptance Standards  

---

## 1. Executive Summary

This roadmap establishes a disciplined, 5-milestone implementation plan to evolve MedioBot V2 into an industrial-grade, local-first multi-agent coding platform.

### Principles of Execution
- **Strict Monotonic Progress:** Every milestone is independently testable, backward-compatible, and verifiable before proceeding.
- **Foundational Correctness over Visual Velocity:** Protocol stability, permission sandboxing, and evidence provenance take strict precedence over cosmetic changes.
- **Zero Duplication:** Desktop and CLI share the exact same runtime engine, SQLite persistence, and event protocol.
- **Clean-Room Engineering:** All enhancements are built on open standards (`agentskills.io`, MCP, WHATWG SSE) and peer-reviewed research (ReAct, SWE-agent, SWE-bench).

---

## 2. Milestone Overview

```
+-----------------------------------------------------------------------------+
| MILESTONE 1: CORE DECOUPLING & CLI FOUNDATION                               |
| - Extract @mediobot-v2/core from Command Center                             |
| - Implement @mediobot-v2/cli connecting to local daemon                     |
| - Verify WHATWG Last-Event-ID reconnection across terminal sessions         |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| MILESTONE 2: ACI TOOLS & SURGICAL LINE PATCHING                             |
| - Implement windowed file reads with line numbers                           |
| - Replace whole-file overwrite with targeted line-range edit tool           |
| - Unify diff generation and syntax highlighting                             |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| MILESTONE 3: MODULAR SKILLS & PROJECT INSTRUCTIONS                          |
| - Implement agentskills.io SKILL.md parser with progressive disclosure      |
| - Implement project AGENTS.md instruction precedence                        |
| - Enforce tool allowlists and prompt-injection barriers                     |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| MILESTONE 4: TRI-AGENT ADVERSARIAL VERIFICATION LOOP                        |
| - Upgrade Tester to an executable verification specialist                   |
| - Implement Fail-to-Pass verification protocol (Cody + Tester)              |
| - Wire COMPLETION-POLICY.md evidence gates into Maestro goal settlement     |
+-----------------------------------------------------------------------------+
                                      |
                                      v
+-----------------------------------------------------------------------------+
| MILESTONE 5: LIVE EXECUTION UX ALIGNMENT & POLISHING                         |
| - Align Command Center desktop UI with 9-component UX standard              |
| - Implement structured approval modals and verification badges              |
| - Final end-to-end integration across real codebases                        |
+-----------------------------------------------------------------------------+
```

---

## 3. Detailed Milestone Specifications

### Milestone 1: Core Decoupling & CLI Foundation
*Focus: Shared engine architecture, zero code duplication, terminal accessibility.*

#### Objectives
1. Extract shared runtime composition, storage, and HTTP/SSE server infrastructure from `apps/command-center` into a new package: `@mediobot-v2/core`.
2. Create `@mediobot-v2/cli` as an ergonomic, thin terminal client.
3. Support automatic daemon probing and background headless startup if daemon is absent.
4. Implement interactive terminal streaming using the existing `/api/turns/:id/events` SSE endpoint.
5. Wire `Ctrl+C` interrupt to `POST /api/turns/:id/cancel` with immediate subprocess abort.

#### Affected Packages & Files
- `packages/core/` (new package extracted from `command-center/src/composition.ts`, `server.ts`, `history.ts`).
- `packages/cli/` (new CLI package).
- `apps/command-center/` (refactored to import `@mediobot-v2/core`).

#### Independent Testability
- Unit tests: CLI argument parsing, daemon health check, detached spawner.
- Integration tests: CLI initiates turn via `POST /api/turns`, receives live SSE stream, prints colored output, resumes cleanly after disconnect using `Last-Event-ID`.
- Cancellation tests: Sending `SIGINT` aborts execution within 200ms and commits `status = "cancelled"` to SQLite.

#### Acceptance Criteria
- [ ] `mediobot "prompt"` executes successfully from any terminal directory.
- [ ] Command Center web UI and terminal CLI can observe the same turn simultaneously.
- [ ] Disconnecting the terminal leaves background task running; reconnecting restores live stream.
- [ ] Zero database lock contention between simultaneous desktop and CLI access.

---

### Milestone 2: Agent-Computer Interface (ACI) Tools & Surgical Line Patching
*Focus: Token efficiency, editing reliability, avoiding whole-file overwrites.*

#### Objectives
1. Implement windowed file inspection: `filesystem.read` accepting `offset` and `limit` lines, outputting prefixed line numbers (`1: const x = 1;`).
2. Implement surgical line-range editing: `filesystem.edit` accepting `path`, `start_line`, `end_line`, `expected_content`, and `replacement_content`.
3. Validate exact character-sequence matches before mutating to prevent hallucinated line offset edits.
4. Generate structured unified diffs on every edit and emit `diff.created` product events.

#### Affected Packages & Files
- `packages/tools/src/index.ts` (tool schemas and execution logic).
- `packages/cody/src/agent.ts` (action contract and prompt instructions).
- `packages/cody/tests/` (unit and regression tests).

#### Independent Testability
- Unit tests: Line range replacement on edge cases (line 1, EOF, indentation shifts, multiline blocks).
- Rejection tests: Mismatched `expected_content` fails closed without touching the file.
- Token economy benchmark: Measure output token reduction on editing 10 lines of a 500-line file (expected: >85% token savings vs full rewrite).

#### Acceptance Criteria
- [ ] Cody edits files using line replacement instead of rewriting entire files.
- [ ] Indentation, comments, and file encodings are perfectly preserved.
- [ ] Clean unified diffs are generated and displayed in both CLI and desktop.

---

### Milestone 3: Modular Skills & Project Instructions System
*Focus: Extensibility, progressive disclosure, prompt-injection defense.*

#### Objectives
1. Implement `SkillCatalog` compliant with the `agentskills.io` specification:
   - Scans `~/.mediobot/skills/` (user global) and `.mediobot/skills/` (project local).
   - Extracts YAML frontmatter (`name`, `description`, `allowed-tools`, `metadata`).
2. Implement three-stage progressive disclosure:
   - **Discovery:** Compact summary table injected into prompt (~50 tokens per skill).
   - **Activation:** Model invokes `activate_skill({ name: "..." })` to load the full `SKILL.md` body.
   - **Execution:** Sub-resources (`scripts/`, `references/`) loaded on demand.
3. Implement `AGENTS.md` / `MEDIOBOT.md` project instruction loader with Level 0–4 security precedence.
4. Enforce strict tool allowlists declared in skill frontmatter.

#### Affected Packages & Files
- `packages/maestro/src/skills.ts` (catalog scanner and frontmatter parser).
- `packages/maestro/src/context.ts` (progressive disclosure context assembler).
- `packages/domain/src/index.ts` (skill capability types).

#### Independent Testability
- Unit tests: YAML frontmatter parsing, validation of 64-char names and 1024-char descriptions.
- Injection tests: Skills attempting path traversal (`../../etc/passwd`) or requesting unauthorized tools are rejected.
- Precedence tests: Project-level instructions override global preferences but cannot override Level 0 security invariants.

#### Acceptance Criteria
- [ ] Creating `.mediobot/skills/my-skill/SKILL.md` makes it discoverable by Maestro without restarting the server.
- [ ] Skills only load full instructions when explicitly activated by task intent.
- [ ] Tool permissions in skills cannot escalate agent privileges.

---

### Milestone 4: Tri-Agent Adversarial Verification Loop
*Focus: Truthfulness, goal satisfaction, independent verification proof.*

#### Objectives
1. Upgrade Tester from a text-inference prompt role to a fully executable specialist (`TesterExecutionAdapter`).
2. Provide Tester with scoped workspace tools: read files, write isolated test files (`tests/repro_*.test.ts`), and run test suites.
3. Implement the **Fail-to-Pass verification protocol**:
   - Tester writes reproduction test reproducing the bug; verifies it fails (exit code != 0).
   - Cody inspects codebase, writes surgical fix, and verifies build compiles.
   - Tester re-runs reproduction test; verifies it now passes (exit code 0).
   - Tester runs full suite to confirm no regressions (pass-to-pass).
4. Integrate domain `COMPLETION-POLICY.md`:
   - Maestro evaluates `GoalCriterion` using empirical `command-execution` evidence from Tester.
   - Cody's model finish summary is permanently recorded as `observed` evidence; it cannot satisfy verification criteria.

#### Affected Packages & Files
- `packages/maestro/src/index.ts` & `text-workers.ts` (orchestration and delegation protocol).
- `packages/cody/` & new `packages/tester/` (dedicated specialist packages).
- `packages/domain/src/index.ts` (typed criteria matching).

#### Independent Testability
- End-to-end integration tests: Bug repair scenario with automated reproduction test creation, patch application, and verification check.
- Contradictory outcome tests: If Cody claims success but Tester reports failure, Maestro marks the task as failed/blocked.

#### Acceptance Criteria
- [ ] Tester independently writes and executes tests in the workspace.
- [ ] Maestro refuses to declare a bug resolved without an independent test execution trace with exit code 0.
- [ ] Cody cannot bypass Tester or validate its own modifications.

---

### Milestone 5: Live Execution UX Alignment & Polishing
*Focus: Professional visual presentation, diffs, approvals, and evidence transparency.*

#### Objectives
1. Align Command Center desktop components with the 9-component UX standard defined in `LIVE_EXECUTION_UX_DESIGN.md`.
2. Implement visual distinction between **[✓ Verified Evidence]** (command exit 0) and **[Observed Summary]** (model statements).
3. Implement interactive human approval cards for destructive actions and out-of-sandbox commands.
4. Implement dynamic timer derivation from backend `startedAt` across all tool cards.
5. Provide rich terminal formatting in `@mediobot-v2/cli` (syntax-highlighted diffs, spinners, status pills).

#### Affected Packages & Files
- `apps/command-center/src/components/` (`ToolExecutionCard.tsx`, `DiffViewer.tsx`, `ApprovalModal.tsx`).
- `apps/command-center/src/state/AppContext.tsx` (state updates and timer bindings).
- `packages/cli/src/render/` (terminal ANSI/Ink rendering).

#### Independent Testability
- Visual regression checks: Tool cards display frozen durations and correct status badges.
- Remount tests: Switching tabs or refreshing browser preserves live timers without drift.
- Approval tests: Rejecting an approval halts execution cleanly without hung promises.

#### Acceptance Criteria
- [ ] Desktop Command Center and CLI render execution state with identical structure and semantic fidelity.
- [ ] Users can easily distinguish verified test results from model claims at a glance.
- [ ] Zero ghost spinners, zero duplicate cards, and zero credential leaks across the entire workflow.

---

## 4. Risk Matrix & Mitigations

| Risk | Impact | Probability | Architectural Mitigation |
|---|---|---|---|
| **SQLite Lock Contention** between CLI and Desktop | High | Medium | Enforce Daemon-Centric Architecture (Option C). A single background process writes to SQLite; CLI acts as an API client over local loopback. |
| **Model Context Overflow** during large test suites | High | High | Bounded stdout/stderr streaming in `ToolRuntime` (max 1 MB); truncates middle lines while preserving failure tails. |
| **Prompt Injection via `SKILL.md` or `AGENTS.md`** | Critical | Medium | Hardcoded Level 0 security rules (`realpath`, sensitive env stripping) run in native Node.js before filesystem access and cannot be overridden by model instructions. |
| **Tautological Testing** by Tester | Medium | Medium | Tester must verify the reproduction test fails *before* Cody applies the fix (Fail-to-Pass requirement). |
| **Terminal Escape Injection** from command stdout | High | Low | Sanitize all terminal output streams; strip ANSI control sequences that attempt terminal escape sequences or title resets. |
