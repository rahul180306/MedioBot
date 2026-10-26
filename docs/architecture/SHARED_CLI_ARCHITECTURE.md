# SHARED_CLI_ARCHITECTURE.md — Unified Execution Engine & CLI Architecture

**Document Status:** Approved Architectural Design  
**Date:** October 2026  
**Target:** MedioBot V2 Platform Architecture  
**Scope:** Reusable Runtime Core, CLI Integration, Daemon Lifecycle, Event Streaming, and Packaging  

---

## 1. Executive Summary

A critical mandate for MedioBot V2 is to provide a unified execution core shared by both the desktop Command Center and a professional command-line interface (CLI). The system must **never maintain two independent agent runtimes**; duplicating prompt logic, tool execution, or state persistence across separate desktop and CLI codebases inevitably causes behavioral divergence, synchronization bugs, and maintenance fatigue.

This document evaluates three architectural approaches for exposing MedioBot through the terminal:
1. Direct Shared-Library Integration (In-Process)
2. Local Daemon / API Integration (Thin Client)
3. Hybrid Architecture (Daemon-First with Auto-Spawn Fallback)

We recommend the **Hybrid Architecture with a Shared Daemon Protocol**. This approach preserves a single authoritative execution engine, prevents SQLite write-lock contention, enables simultaneous CLI and desktop observability, and supports instantaneous reconnection.

---

## 2. Evaluation of Architectural Approaches

```
+---------------------------------------------------------------------------------------------------+
| APPROACH COMPARISON MATRIX                                                                        |
+---------------------------------------------------------------------------------------------------+
| Criterion                      | Option A: Direct Library | Option B: Pure Daemon | Option C: Hybrid Auto-Daemon |
+--------------------------------+--------------------------+-----------------------+-----------------------------+
| Single Runtime Engine          | Moderate (shared code)   | High (single process) | High (single process)       |
| Desktop & CLI Coexistence     | Poor (DB lock conflict)  | Perfect (shared state)| Perfect (shared state)      |
| Zero-Config Terminal Launch    | High (runs standalone)   | Poor (requires server)| High (spawns if absent)     |
| Reconnection Resilience        | None (process exits)     | High (daemon retains) | High (daemon retains)       |
| Maintenance & Testing Overhead | High (dual lifecycle)    | Low (reuses HTTP/SSE) | Low (reuses HTTP/SSE)       |
| Architectural Recommendation   | REJECTED                 | REJECTED (Pure manual)| **APPROVED & RECOMMENDED**  |
+---------------------------------------------------------------------------------------------------+
```

### 2.1 Option A: Direct Shared-Library Integration (In-Process)
- **Concept:** Extract orchestration from `apps/command-center` into `@mediobot-v2/core`. The CLI imports `@mediobot-v2/core` directly, instantiates `ToolRuntime`, connects to `mediobot.db` via SQLite, and executes entirely in-process.
- **Why Rejected:**
  1. *Database Lock Contention:* SQLite in Node.js supports multiple readers but serializes writers. If the desktop UI is open while the CLI runs, concurrent writes can produce `SQLITE_BUSY` errors.
  2. *Split-Brain State:* An active task in the CLI is invisible to the Command Center desktop view, and vice versa.
  3. *Process Death Kills Execution:* Closing the terminal terminal tab sends `SIGHUP`, killing in-flight long-running builds without recovery.

### 2.2 Option B: Local Daemon / API Integration (Pure Manual Client)
- **Concept:** The CLI is a lightweight HTTP/SSE client that connects exclusively to `http://127.0.0.1:5199`.
- **Why Rejected:**
  - Poor developer ergonomics: If the daemon is not already running, the CLI immediately exits with `ECONNREFUSED: Server not running. Run pnpm dev first.` Developers expect `mediobot` to work instantly from any terminal.

### 2.3 Option C: Hybrid Architecture (Daemon-First with Auto-Spawn Fallback) — *RECOMMENDED*
- **Concept:**
  1. When invoked (`mediobot "Fix issue 42"`), the CLI checks for an active local daemon via health probe (`GET http://127.0.0.1:5199/api/health` or Unix Domain Socket `~/.mediobot/runtime.sock`).
  2. If the daemon is alive, the CLI attaches immediately as an interactive terminal stream.
  3. If no daemon is found, the CLI spawns a detached background headless daemon (`node server.ts --headless`) in under 200ms, waits for socket readiness, and attaches.
- **Why Approved:**
  - **Single Engine Invariant:** Exactly one runtime daemon manages SQLite, `WorkerRuntime`, and task lifecycles.
  - **Shared Live State:** A task started in the terminal can be viewed live in the Command Center desktop browser simultaneously!
  - **Detached Resilience:** If the terminal disconnects or crashes, the background daemon completes the task and commits results to SQLite. Reopening the terminal or running `mediobot attach` seamlessly resumes the turn stream using `Last-Event-ID`.

---

## 3. End-to-End CLI System Architecture

```
+-----------------------------------------------------------------------------+
| CLI TERMINAL PROCESS (@mediobot-v2/cli)                                     |
|                                                                             |
| +---------------------+   +---------------------+   +---------------------+ |
| | Input Parser        |   | Stream Consumer     |   | TTY Renderer        | |
| | - Args & Flags      |   | - EventSource client|   | - Terminal UI       | |
| | - Interactive REPL  |   | - Last-Event-ID sync|   | - Diff colorizer    | |
| +---------------------+   +---------------------+   +---------------------+ |
+-----------------------------------------------------------------------------+
                               |              ^
              POST /api/turns  |              |  GET /api/turns/:id/events (SSE)
              POST /api/cancel |              |  (Live events & snapshot)
                               v              |
+-----------------------------------------------------------------------------+
| LOCAL MEDIOBOT DAEMON (Single Execution Core)                               |
|                                                                             |
| +-------------------------------------------------------------------------+ |
| | HTTP / SSE API Gateway (apps/command-center or @mediobot-v2/server)     | |
| | - /api/turns (Barrier, validation, SQLite commit)                       | |
| | - /api/turns/:id/events (Authoritative snapshot boundary + SSE replay)  | |
| | - /api/turns/:id/cancel (Immediate worker abort & state settlement)     | |
| +-------------------------------------------------------------------------+ |
|                                      |                                      |
|                                      v                                      |
| +-------------------------------------------------------------------------+ |
| | Orchestration Runtime                                                   | |
| | - Maestro Decision Provider (Context, Goals, Delegation)                | |
| | - Cody Specialist (Implementation, Workspace Tools, Build Check)        | |
| | - Tester Specialist (Reproduction Tests, Adversarial Verification)      | |
| | - ToolRuntime (Realpath sandboxing, sensitive env stripping)            | |
| +-------------------------------------------------------------------------+ |
|                                      |                                      |
|                                      v                                      |
| +-------------------------------------------------------------------------+ |
| | Durable State Storage (application-data / mediobot.db)                 | |
| | - SQLite WAL mode (threads, turns, items, evidence, artifacts)          | |
| +-------------------------------------------------------------------------+ |
+-----------------------------------------------------------------------------+
```

---

## 4. Architectural Deep Dive: Core Mechanisms

### 4.1 Packaging & Code Organization
To share code cleanly without duplication:
```
mediobot-v2/
├── packages/
│   ├── core/                  # NEW: Extracted composition, world & execution wiring
│   ├── domain/                # Existing: World, Goal, Task, Evidence models
│   ├── runtime/               # Existing: WorkerRuntime, TaskSubmission, Supervision
│   ├── tools/                 # Existing: ToolRuntime, sandboxing, process execution
│   ├── models/                # Existing: ModelResolver, ProviderRepository, sanitization
│   ├── cody/                  # Existing: Cody agent execution adapter
│   ├── maestro/               # Existing: Maestro orchestrator, text workers
│   └── cli/                   # NEW: Terminal CLI application
└── apps/
    └── command-center/        # Existing: Desktop Web UI (connects to same core/daemon)
```

### 4.2 Lifecycle & Process Management
- **Daemon Socket / Port:** `127.0.0.1:5199` (HTTP) with fallback to Unix Domain Socket `~/.mediobot/runtime.sock` on macOS/Linux.
- **PID File:** `~/.mediobot/daemon.pid`.
- **Idle Timeout:** For automated background daemons, the process stays alive for 30 minutes of inactivity before clean shutdown, or persists indefinitely if launched via `mediobot daemon start` or `pnpm dev`.

### 4.3 Streaming Protocol & WHATWG Reconnection
The CLI reuses the exact SSE endpoint verified in Phase 1:
1. **Initial Connection:** `GET /api/turns/:turnId/events?threadId=:threadId`.
2. **Snapshot Boundary:** Server sends `id: snapshot-${turnId}-${sequence}` with the complete SQLite turn state. The CLI hydrates its terminal model from this snapshot.
3. **Event Replay:** Any subsequent live events (`tool.started`, `tool.completed`, `diff.created`, `task.completed`) are printed as they occur.
4. **Disconnect & Resume:** If network drops or the terminal window is closed, the CLI reconnects sending `Last-Event-ID: evt-003`. The server replays missed events and continues live streaming.

### 4.4 Cancellation & Signals
- **Ctrl+C Handling in Terminal:**
  - First `Ctrl+C`: CLI immediately calls `POST /api/turns/:turnId/cancel?threadId=...`.
  - The daemon triggers `controller.abort()`, terminating active child processes in `ToolRuntime` and committing `status = "cancelled"` to SQLite.
  - The CLI displays `[Cancelled by user]` and exits cleanly.
  - Second `Ctrl+C` (within 1 second): Force-kills the CLI process immediately.

### 4.5 Workspace Permission Gating in the Terminal
- When Cody or Tester requests a tool that mutates files or executes shell commands:
  - If `--yes` / `-y` flag is passed: Auto-approved.
  - If interactive: The CLI prints a structured prompt:
    ```
    ┌─ Permission Request ──────────────────────────────────────────┐
    │ Tool: terminal.execute                                         │
    │ Command: npm test                                             │
    │ Directory: ./                                                 │
    └───────────────────────────────────────────────────────────────┘
    Authorize this action? [y/N/always]: 
    ```
  - The decision is posted to `POST /api/turns/:turnId/approval` and unblocks the execution loop.

---

## 5. Architectural Recommendations & Justifications

### 5.1 Recommendation: Extract `@mediobot-v2/core` from Command Center
- **Problem it Solves:** Eliminates code duplication between `apps/command-center/src/server.ts` and the CLI.
- **Source Supporting It:** Single Responsibility Principle and Domain-Driven Design (Evans, 2003).
- **Why it Fits MedioBot:** Both desktop and terminal need identical access to `LocalHistoryStore`, `LocalDatabase`, `ModelResolver`, and `createComposition`.
- **Alternatives Rejected:** Importing directly from `apps/command-center/src/...` (violates package encapsulation and creates circular workspace dependencies).
- **What Must Be Tested:** Packaging build, module resolution in both ESM and TS, zero frontend imports in `@mediobot-v2/core`.

### 5.2 Recommendation: Standardize CLI Output on Ink / Native TTY Streams
- **Problem it Solves:** Avoids flickering full-screen repaints while presenting rich tool cards, spinners, and live diffs.
- **Source Supporting It:** Claude Code and Codex CLI terminal rendering patterns.
- **Why it Fits MedioBot:** Preserves MedioBot's distinct visual identity (Maestro purple, Cody blue, clean monospace diffs) in standard ANSI/Unicode terminals.
- **Alternatives Rejected:** Full-screen curses/blessed TUI (destroys normal scrollback history and prevents copying text).
- **What Must Be Tested:** Rendering on 80-column terminals, dumb terminals without ANSI support, CI non-TTY environments.
