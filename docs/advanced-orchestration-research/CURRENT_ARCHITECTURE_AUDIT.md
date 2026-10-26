# MedioBot V2 — Advanced Autonomous Multi-Agent Architecture Research
## Deliverable 2: Current Architecture Audit & Forensic Analysis

---

### 1. Executive Summary of Architectural Audit

A comprehensive code-level audit was conducted across all packages in the active MedioBot V2 monorepo (`packages/domain`, `packages/models`, `packages/tools`, `packages/runtime`, `packages/maestro`, `packages/cody`, `packages/tester`, `packages/vision`, and `apps/command-center`).

The audit confirms that MedioBot V2 has established an unusually rigorous foundation for execution safety, containment, and state persistence. Unlike typical conversational frameworks that allow untrusted model prose to dictate tool execution, MedioBot enforces strict structural schemas, non-bypassable file-descriptor containment, and immutable SQLite records. However, the system currently suffers from severe orchestration rigidity: it operates exclusively on a single-turn serial delegation model, lacks AST-level codebase intelligence, and has zero primitives for safe multi-agent concurrency.

---

### 2. Comprehensive Subsystem Audit

#### 2.1 Maestro Orchestration (`packages/maestro/src/index.ts`, `composition.ts`)
* **Current Implementation:**
  * Driven by `MaestroDecisionProvider`, which issues structured prompts expecting one of six strict actions: `respond`, `request_user_input`, `acquire_context`, `use_capability`, `delegate`, or `delegate_text`.
  * Integrates definition instructions directly from `mediobots/maestro/MEDIOBOT.md`.
  * Enforces an automated evidence classification gate (`classifyProjectEvidenceNeed`): if a user query requires factual knowledge of the project, Maestro strictly forbids `basis: "conversation"` and requires concrete tool evidence from Cody before synthesizing an answer.
* **Key Limitations:**
  * **Strict Two-Turn Execution Ceiling:** Maestro delegates to exactly one specialist (`Cody`) or text workers (`Research`, `Tester`), awaits their completion, runs a single text synthesis pass, and terminates the turn. There is no multi-step loop, no dynamic task graph, and no re-delegation based on unexpected test results.
  * **Static Role Routing:** Intents are restricted to predefined hardcoded categories. Capabilities like `acquire_context` and `use_capability` exist in the schema types but have no executable runtime handlers registered in production.

#### 2.2 Cody Runtime (`packages/cody/src/agent.ts`)
* **Current Implementation:**
  * Implements an iterative, single-agent tool loop: `list`, `search`, `read`, `write`, `edit`, `run`, and `finish`.
  * Employs a strict structural normalizer (`structuredJsonOnly`) with a two-attempt repair loop that catches missing/malformed `type` fields without echoing raw model reasoning back into the prompt.
  * Rejects hallucinations: Cody cannot finish with an unverified claim if a write was performed; verification must be explicitly executed.
* **Key Limitations:**
  * **Single-Threaded Sequential Action Loop:** Cody executes one tool call per turn, waits for the result, appends it to in-memory history, and issues the next call. A task requiring 15 file checks executes 15 serial model inference roundtrips.
  * **Bounded Step Limit ($N \le 12$):** Cody terminates when reaching max steps, causing incomplete tasks on complex codebases.

#### 2.3 Agent Roster & Registry (`apps/command-center/src/composition.ts`, `server.ts`)
* **Current Reality vs. Product Marketing:**
  * **Implemented & Executable:**
    * `Maestro` (orchestrator; available).
    * `Cody` (coding specialist; executable when assigned by Maestro).
    * `Tester` (verification worker in `packages/tester`, exposed as text-worker in Maestro text synthesis).
    * `Vision` (browser agent in `packages/vision`; deferred in current milestone).
  * **Partially Defined Text Workers:** `Research`, `Tester` (invoked via `delegate_text` for bounded static reasoning).
  * **Purely Conceptual (Unimplemented):** `Doc`, `Dessy`, `Weby`, `Scraapy`. `Doc` is literally registered with instructions: `"Doc execution is not implemented"`. `Dessy`, `Weby`, and `Scraapy` do not exist anywhere in the code.

#### 2.4 Project Intelligence (`packages/maestro/src/discovery.ts`, `workspaceManager.ts`)
* **Current Implementation:**
  * `discoverProjectIntelligence` scans the workspace root via Node's `opendir`.
  * Samples top-level entries (capped at 35 entries).
  * Reads up to 4 KB from root manifests (`package.json`, `Cargo.toml`, `go.mod`, `tsconfig.json`).
  * Reads up to 8 KB from instruction files (`README.md`, `AGENTS.md`).
* **Key Limitations (The "Blind Assistant" Bottleneck):**
  * **No AST Parsing:** No Tree-sitter, no TypeScript Compiler API, no Babel/ESTree parser.
  * **No Symbol Graph:** The system has no index of classes, functions, interfaces, or exported types.
  * **No Call/Import Graph:** Maestro and Cody have no idea which files import or depend on a modified module.
  * **Zero Semantic Search:** No vector embeddings, no BM25 lexical index over the codebase.
  * **Context Starvation:** If a project has 500 files, MedioBot only knows the 35 top-level files unless Cody manually runs `filesystem.list` and `filesystem.read` across multiple expensive turns.

#### 2.5 Workspace Management & File Concurrency (`apps/command-center/src/workspaceManager.ts`)
* **Current Implementation:**
  * Canonical path resolution using `realpathSync`.
  * Enforces path containment (`contained` function) to prevent directory traversal (`..`, symlink redirection).
  * Uses an in-memory map of promises (`writeLocks = new Map<string, Promise<void>>()`) to serialize concurrent writes to the *exact same* file path.
* **Key Limitations for Multi-Agent Collaboration:**
  * **Single Shared Working Tree:** All agents operate on the single physical directory on disk (`workspaceRoot`).
  * **Race Conditions on Uncommitted Edits:** If Agent A edits `server.ts` while Agent B is testing it, Agent B's test fails unpredictably.
  * **No Branch/Worktree Isolation:** There is no Git worktree manager to provision temporary, isolated branch checkouts for concurrent agents.

#### 2.6 Persistence & Memory (`apps/command-center/src/storage/`, `packages/runtime/src/`)
* **Current Implementation:**
  * Built on Node 22 native `node:sqlite` (`DatabaseSync`).
  * Authoritative schema: stores `workspaces`, `ui_state`, `threads`, `turns`, `turn_items`, `tasks`, and `provider_connections`.
  * Bounded history projection: server reconstructs up to 4 prior turns directly from SQLite, sanitizing secret keys (`nvapi-`, `dahl_`, `sk-`) and hidden model reasoning tags.
* **Key Limitations:**
  * **Zero Long-Term / Cross-Thread Memory:** Once a thread is closed, everything learned (user preferences, architectural idiosyncrasies, resolved bug patterns) is inaccessible to new threads.
  * **No Episodic or Procedural Memory:** No semantic embeddings or associative knowledge network (such as A-MEM or Mem0) exist.

#### 2.7 Tool Runtime & Permission Engine (`packages/tools/src/permissions.ts`)
* **Current Implementation:**
  * `ToolPermissionEngine` enforces approval modes (`"Approve for me"`, `"Ask to edit"`, `"Ask to run"`, etc.).
  * Safe file descriptors: `readWorkspaceFile` opens an `O_NOFOLLOW` file descriptor, checks matching device/inode numbers (`dev`/`ino`), and re-verifies paths before reading to block TOCTOU attacks.
  * Sensitive file masking: automatically denies access to `.env`, `.aws`, `.ssh`, `.git`, `.gnupg`, private keys, and credential stores.
* **Assessment:**
  * This is an exemplary, production-grade security boundary that must be preserved without compromise.

#### 2.8 Model Client & Provider Integration (`packages/models/src/index.ts`, `modelRegistry.ts`)
* **Current Implementation:**
  * Generic `OpenAICompatibleStructuredClient` supporting OpenAI, Anthropic, Dahl (MiniMax M2.7), and custom local endpoints.
  * Normalizes `<think>...</think>` tags and reasoning blocks before passing text to structured JSON parsers.
  * Enforces `finish_reason === "length"` error detection to catch truncated model responses.

---

### 3. Detailed Architectural Limitations Matrix

| Architectural Subsystem | Current Mechanism | Limitation / Bottleneck | Impact on Target Vision |
| :--- | :--- | :--- | :--- |
| **Task Decomposition** | Single static prompt to Maestro | No dynamic DAG planning or subtask dependency tracking | Cannot coordinate multi-phase features (e.g. backend $\to$ frontend $\to$ test) |
| **Concurrency Model** | 1 worker active per turn | Completely sequential execution; concurrency = 1 | Incapable of running 4–8 concurrent specialists |
| **Workspace Sandboxing** | Shared disk directory with in-memory mutex | File collisions, uncommitted state bleed, test port conflicts | Multiple agents corrupt each other's code |
| **Codebase Understanding** | 35-file directory scan + root README | No AST, no symbols, no call graph, no lexical index | Hallucinates module APIs; high latency discovering files |
| **Memory & Experience** | 4-turn SQLite thread slice | Zero cross-thread memory; no procedural learning | Forgets user requirements and architectural conventions |
| **Verification & QA** | Single post-Cody test run | No pre-execution plan validation; no regression merge gate | Defects propagate to user before detection |
| **Specialist Ecosystem** | Cody only (Doc is stubbed; others nonexistent) | Only 1 generalist coding persona actually works | Cannot divide labor into UX, web research, documentation |

---

### 4. Capabilities Worth Preserving (Non-Negotiable Core)

The following components represent hardened, reliable engineering that should be retained as bedrock in the recommended architecture:

1. **SQLite Native Persistence (`DatabaseSync`):** Complete transaction durability for thread state, task snapshots, and approval records without heavy external database dependencies.
2. **`ToolPermissionEngine` & Contained Filesystem Security:** Inode pinning (`dev`/`ino`), `O_NOFOLLOW` flags, path traversal barriers, and strict secret masking (`.env`, `.ssh`).
3. **Structured Normalization & Bounded Repair:** The 2-attempt normalizer that strips `<think>` tags, validates JSON schemas, and recovers without polluting context windows with raw reasoning.
4. **SSE Event Protocol (`/api/turns/:turnId/events`):** Clean real-time event streaming (`task.created`, `tool.completed`, `file.changed`, `turn.completed`, `turn.failed`) powering the Command Center desktop UI.
5. **ZIP-Aligned Desktop UI:** The high-fidelity desktop workspace, left-hand user checkpoint navigation (`TimelineNavigator.tsx`), monaco editor integration, and responsive layout.

---

### 5. Architectural Gap Analysis: Current vs. Target

```text
Current MedioBot V2:
[User] -> [Maestro] -> [Single Cody Task] -> [Tool Loop (1 by 1)] -> [Evidence] -> [Answer]
   ^            |               |
   |            v               v
 [UI]      [35-file Scan]   [Shared Disk]

Target MedioBot V2 Architecture:
[User] -> [Maestro Coordinator]
               |
               +---> [Repository Intelligence Engine (Tree-sitter AST + Symbol Graph)]
               +---> [Provenance Memory (SQLite + A-MEM Cognitive Links)]
               +---> [Dynamic DAG Planner & Wave Scheduler]
                           |
                           +---> Wave 1: [Dessy (UI Research)] || [Doc (Spec Discovery)]
                           |
                           +---> Wave 2: [Git Worktree Manager]
                           |                 |---> Worktree 1: [Cody-Backend]
                           |                 +---> Worktree 2: [Cody-Frontend]
                           |
                           +---> Wave 3: [Tester (Automated Dual Validation Gate)]
                           |
                           +---> [Merge Validation & Evidence Synthesis] -> [UI]
```

This audit confirms that scaling MedioBot V2 to 4–8+ concurrent agents requires three major architectural additions:
1. **Repository Intelligence Engine (Tree-sitter AST & symbol dependency graph)** to eliminate blind repository navigation.
2. **Topological Wave Dispatch (DAG task scheduler)** to coordinate multi-agent dependencies without deadlock.
3. **Git Worktree Isolation Manager** to give each concurrent specialist an isolated sandbox pointing to the shared Git object store.
