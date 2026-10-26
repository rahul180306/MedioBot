# CURRENT_ARCHITECTURE_AUDIT.md — MedioBot V2 Platform Audit

**Document Status:** Complete Architectural Audit  
**Date:** October 2026  
**Target:** MedioBot V2 Local-First Multi-Agent Platform  
**Mode:** Architectural Audit & System Forensic  

---

## 1. Executive Summary

MedioBot V2 is architected as a local-first, multi-agent software engineering environment. It diverges fundamentally from naive chat wrappers by enforcing an explicit domain ownership model, strict filesystem sandboxing, monotonic event lifecycles, and a separation between model-generated claims and independently verified execution evidence.

This document traces the complete execution lifecycle from user invocation through planning, delegation, tool execution, persistence, and reactive rendering. It inventories every subsystem to classify what is **fully implemented**, **partially implemented**, **mocked/test-only**, or **merely planned**.

---

## 2. End-to-End Execution Trace

```
+---------------+     POST /api/turns      +-----------------------------------------+
| User / UI /   | -----------------------> | apps/command-center (server.ts)         |
| Future CLI    |                          | - Durably appends user turn to SQLite   |
+---------------+                          | - Acquires in-flight execution barrier  |
        ^                                  +-----------------------------------------+
        |                                                       |
        | SSE Stream                                            v
        | (/api/turns/:id/events)                  +-----------------------------------------+
        |                                          | packages/maestro                        |
        |                                          | - Compiles context & GoalAnchor         |
        |                                          | - Decides: respond vs delegate(_text)   |
        |                                          +-----------------------------------------+
        |                                                       |
        |                                        +--------------+--------------+
        |                                        |                             |
        |                             delegate (Coding)             delegate_text (Analysis)
        |                                        |                             |
        |                                        v                             v
        |                          +-----------------------+     +-----------------------+
        |                          | packages/cody         |     | TextMediobotExecution |
        |                          | - CodyDecisionProvider|     | - Cody/Research/Tester|
        |                          | - Read/Write/Run loop |     | - Concurrent reports  |
        |                          +-----------------------+     +-----------------------+
        |                                        |                             |
        |                                        v                             v
        |                          +-----------------------------------------------------+
        |                          | packages/runtime (WorkerRuntime)                    |
        |                          | - Bounded concurrency & ownership allocation        |
        |                          +-----------------------------------------------------+
        |                                        |
        |                                        v
        |                          +-----------------------------------------------------+
        |                          | packages/tools (ToolRuntime)                        |
        |                          | - Canonical realpath workspace sandboxing           |
        |                          | - Stripped sensitive environment variables          |
        |                          | - Bounded terminal spawn & stdout/stderr accounting |
        |                          +-----------------------------------------------------+
        |                                        |
        |                                        v
        |                          +-----------------------------------------------------+
        |                          | Domain World Events & Product Normalization         |
        |                          | - normalizeProductEvent() drops command text & logs |
        |                          | - Sanitizes secrets and <think> tokens              |
        |                          +-----------------------------------------------------+
        |                                        |
        |                   +--------------------+--------------------+
        |                   v                                         v
+---------------------------------------+         +---------------------------------------+
| SQLite Persistence Layer              |         | SSE Event Transport                   |
| - serverPersistListener()             |         | - Snapshot recovery boundary          |
| - mergeMonotonicToolData()            |         | - WHATWG Last-Event-ID replay         |
| - ChatRepository (durable JSON/turns) |         | - Sanitized tool/message events       |
+---------------------------------------+         +---------------------------------------+
        |                                                             |
        +----------------------------+--------------------------------+
                                     v
                        +---------------------------+
                        | Frontend State Engine     |
                        | - AppContext.tsx          |
                        | - Monotonic item merge    |
                        | - Dynamic timer rendering |
                        +---------------------------+
```

### 2.1 User Request & In-Flight Barrier
1. The user inputs a prompt in Command Center (or future CLI).
2. `POST /api/turns` in [`server.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/apps/command-center/src/server.ts) resolves the target thread and turn identity.
3. **Pre-Execution Durability:** Before any LLM call or worker dispatch occurs, `server.ts` durably commits the initial turn and user message to SQLite via `history.appendTurn()`.
4. **Concurrency Barrier:** An `inFlightBarrier` promise is registered in `inFlightTurns` keyed by `compositeTurnKey(threadId, turnId)`. Concurrent identical requests await this existing barrier, eliminating race conditions.

### 2.2 Maestro Context Compilation & Planning Phase
1. `server.ts` invokes `composition.decideMaestroTurn()`.
2. Maestro compiles [`MaestroContext`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/maestro/src/context.ts):
   - User goal text and bounded recent conversation turns (last 4).
   - Available intents: `respond`, `request_user_input`, `delegate`, and `delegate_text`.
   - Bounded descriptive projection of assignable Mediobots (maximum 500 characters per specialist instructions; Cody, Research, Tester).
   - Workspace state and progressive project discovery (excluding sensitive files like `.env`, `.git`, `.ssh`, `.aws`).
   - Compact skill catalog metadata (full instructions withheld until explicit invocation).
3. The model client generates a structured decision against [`MAESTRO_DECISION_CONTRACT`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/maestro/src/index.ts):
   - `respond`: Generates a direct conversational message. Allocates zero execution identities or worker tasks.
   - `request_user_input`: Asks the user a clarifying question before allocating resources.
   - `delegate`: Dispatches an implementation task to Cody with explicit workspace tool permissions.
   - `delegate_text`: Decomposes text analysis into 1–3 independent assignments across Cody, Research, and Tester.

### 2.3 Specialist Delegation & Execution Loop
- **Cody Workspace Execution:**
  - `CodyDecisionProvider` receives the assignment goal and recent tool history (bounded to last 10 entries).
  - Emits JSON actions: `list`, `read`, `write`, `run`, or `finish`.
  - Operates strictly within the owned workspace boundary bound by `ToolRuntime`.
  - Mutations invalidates prior verification. Verification commands must include explicit intent (`verification: "check description"`).
  - Model finishes emit `cody-summary` recorded as `observed` evidence; it cannot satisfy verification criteria.
- **Text-Worker Parallel Execution:**
  - `TextMediobotExecution` registers Cody, Research, and Tester definitions.
  - Generates an `Assignment`, `Task`, and `Worker` per draft.
  - Executes concurrent model completions via `WorkerRuntime.run` up to runtime capacity (default 4).
  - Gathers structured `WorkerReport` records containing conclusions, evidence claims, blockers, and high-resolution timing intervals.
  - Settles and feeds back to Maestro for final synthesis.

### 2.4 Tool Runtime & Security Sandboxing
- Implemented in [`packages/tools/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/tools/src/index.ts).
- `bindWorkspace()` canonicalizes paths via `realpath`, verifies directory existence, and rejects overlapping workspace boundaries.
- Blocks sensitive paths matching regex for `.env`, `.git`, `.aws`, `.ssh`, `credentials`, private keys, and certificates.
- Strips sensitive environment variables (`API_KEY`, `TOKEN`, `PASSWORD`, `SECRET`) before spawning child processes.
- Enforces strict stream limits: standard output and error captured up to 1 MB each (`MAX_CAPTURED_STREAM_BYTES`). File reads bounded to 8 MB.

### 2.5 Event Normalization & Security Projection
- Handled in [`normalizeProductEvent()`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/apps/command-center/src/composition.ts#L20-L50).
- Product events intentionally reconstruct an allowlisted contract, discarding raw tool inputs, arbitrary commands, and unvalidated output logs.
- Strips internal `<think>` reasoning tags via `sanitizeReasoningAndSecrets()`.
- Masks tool error strings to safe, static categories (`"Tool operation failed."`), preventing credential leakage.

### 2.6 Persistence, SSE Recovery, and Frontend Merging
- **SQLite Persistence:** `serverPersistListener` commits event mutations to SQLite via `history.updateTurn()` using `mergeMonotonicToolData()`.
- **SSE Transport:** `/api/turns/:turnId/events` writes a `turn.snapshot` event representing the durable SQLite state, followed by replaying unacknowledged events (`sequence > snapshotSequence`).
- **Frontend Monotonic State:** `AppContext.tsx` merges incoming stream events idempotently using `mergeIncomingItem()`. Completed tools never regress to running, conflicting terminal events fail closed, and spinners are cleared on settlement.

---

## 3. Subsystem Implementation Status Inventory

| Subsystem / Package | Component | Implementation Status | Grounding / File Reference | Notes & Architectural Deficits |
|---|---|---|---|---|
| **Domain** (`packages/domain`) | World, Tasks, Workers, Resources | **Implemented** | [`domain/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/domain/src/index.ts) | Pure in-memory reference implementation; brands IDs with nominal types. |
| | Goal & Completion Policy | **Implemented** | [`COMPLETION-POLICY.md`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/domain/COMPLETION-POLICY.md) | Enforces typed criteria, provenance verification, and revocation; fail-closed on uncompiled strings. |
| **Runtime** (`packages/runtime`) | `WorkerRuntime` | **Implemented** | [`runtime/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/runtime/src/index.ts) | Enforces concurrency limits (max 4), abort controllers, and resource cleanup. |
| | `RuntimeTaskSubmission` | **Implemented** | [`runtime/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/runtime/src/index.ts) | Manages submission lifecycle and adapter registration. |
| | `projectSupervision` | **Implemented** | [`supervision.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/runtime/src/supervision.ts) | Coalesces worker failures into 64-event circular notice buffer. |
| **Tools** (`packages/tools`) | `ToolRuntime` | **Implemented** | [`tools/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/tools/src/index.ts) | Sandboxed list, read, write, and execute tools. |
| | Tool Permissions UI | **Partially Implemented** | `server.ts:652`, `client.ts:288` | Backend has `approval.required` events, but frontend auto-approves or bypasses approvals. |
| | Line-level edits / Patching | **Missing / Planned** | `tools/src/index.ts:20` | Only whole-file overwrite (`filesystem.write`) is supported. No line replacement or unified diff applicator. |
| **Models** (`packages/models`) | Model Client & Provider Transport | **Implemented** | [`models/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/models/src/index.ts) | OpenAI-compatible fetch adapter with timeout and abort support. |
| | Sanitization & Secret Stripping | **Implemented** | [`models/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/models/src/index.ts) | Redacts Bearer tokens, `<think>` blocks, and unallowlisted outputs. |
| | Monotonic Tool Merging | **Implemented** | [`models/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/models/src/index.ts) | Idempotent state convergence; fail-closed conflict resolution. |
| **Cody** (`packages/cody`) | `CodyExecutionAdapter` | **Implemented** | [`cody/src/agent.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/cody/src/agent.ts) | ReAct loop with list/read/write/run/finish action set. |
| | Verification Provenance | **Implemented** | [`cody/src/agent.ts:52`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/cody/src/agent.ts#L52) | Verification commands require explicit explanation; writes invalidate prior verification. |
| **Maestro** (`packages/maestro`) | `MaestroDecisionProvider` | **Implemented** | [`maestro/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/maestro/src/index.ts) | Decides between respond, request_user_input, delegate, delegate_text. |
| | `TextMediobotExecution` | **Implemented** | [`maestro/src/text-workers.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/maestro/src/text-workers.ts) | Concurrent parallel execution for text specialists. |
| | Skills System | **Partially Implemented** | [`MEDIOBOT.md`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/mediobots/maestro/MEDIOBOT.md) | Compact metadata parsed from `skills/delegation/SKILL.md`; on-demand dynamic loading not fully wired. |
| **Tester** | Adversarial Verification Agent | **Mocked / Text-Only** | [`text-workers.ts:44`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/maestro/src/text-workers.ts#L44) | Tester currently has no tool access or executable harness; it is a text inference prompt role. |
| **Vision** (`packages/vision`) | Headed Browser Automation | **Implemented but Deferred** | [`vision/src/index.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/packages/vision/src/index.ts) | Playwright runtime with session isolation; deferred per project policy. |
| **Storage** (`command-center`) | SQLite Repository | **Implemented** | [`db.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/apps/command-center/src/storage/db.ts), [`chatRepository.ts`](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/apps/command-center/src/storage/chatRepository.ts) | Durable threads, turns, settings, workspace tabs, and projects. |
| **CLI** | Terminal User Interface | **Missing / Planned** | — | No CLI package exists; runtime is coupled to `apps/command-center`. |

---

## 4. Key Architectural Strengths

1. **Monotonic, Fail-Closed Tool State Machine:**  
   Unlike systems vulnerable to race conditions where reordered SSE packets turn completed tool cards back to running spinners, `mergeMonotonicToolData()` makes terminal states immutable and forces conflicting terminal outcomes to fail closed.
2. **Deterministic Workspace Sandboxing:**  
   `ToolRuntime` rejects symlink escapes, relative path traversals, drive-relative paths, and overlapping project bindings before filesystem access occurs.
3. **Rigorous Secret Sanitization:**  
   Command arguments, raw stdout/stderr logs, Bearer tokens, and provider thinking blocks are stripped from product events and SQLite snapshots, eliminating transcript credential leaks.
4. **Authoritative Snapshot SSE Recovery:**  
   The SSE reconnection path anchors on the latest SQLite state rather than purely ephemeral in-memory replay buffers, guaranteeing accurate state hydration even after server reboots or dropped connections.

---

## 5. Architectural Deficits & Gaps

1. **Coupled Runtime Core:**  
   `composition.ts` and `server.ts` are housed within `apps/command-center`. The desktop server is the only orchestration harness; there is no standalone `@mediobot-v2/core` that can be imported by a CLI.
2. **Whole-File Mutation Primitive:**  
   Cody relies exclusively on `{"type":"write","content":"complete replacement content"}`. As evidenced by SWE-agent research, whole-file rewrites waste output tokens and increase indentation and syntax corruption on files exceeding 100 lines.
3. **Tester is Inactive as an Executing Specialist:**  
   Tester is currently restricted to text-only analysis in `TextMediobotExecution`. It cannot independently create reproduction tests, run test suites in the workspace, or generate adversarial verification evidence.
4. **Skills System Lacks Progressive Disclosure:**  
   While `skills/delegation/SKILL.md` exists, the runtime does not support general project-level `.mediobot/skills/` or `.agents/skills/` discovery, dynamic activation, or parameter injection.
5. **No Structured Permission Gating:**  
   Tool executions execute directly without an interactive approval barrier when mutating production files or executing destructive shell commands.
