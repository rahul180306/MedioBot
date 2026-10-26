# Phase 4: Intelligent Resource Governor — Acceptance & Architecture Report

**Status:** Completed & Validated  
**Component:** `@mediobot-v2/runtime`, `@mediobot-v2/contracts`, `@mediobot-v2/tools`, `@mediobot-v2/vision`, `@mediobot-v2/command-center`  
**Milestone:** Phase 4 Intelligent Resource Governor  

---

## 1. Executive Summary

Phase 4 introduces a hardware-aware, self-regulating **Intelligent Resource Governor** to the MedioBot V2 distributed agent operating system. The governor enables multiple autonomous Mediobots (Maestro, Cody, Vision, Tester), concurrent model requests, browser sessions, and terminal tool execution workflows to operate concurrently without starving each other, degrading system responsiveness, or causing out-of-memory crashes or runaway orphan subprocesses.

All contracts are fully typed, tested with 100% green coverage, verified end-to-end with realistic workloads, and live-validated in the command center UI.

---

## 2. Architecture & Design Principles

### 2.1 Typed Resource Contracts (`@mediobot-v2/contracts`)
- Defined discrete resource categories:
  - `execution-slot`: Worker task concurrency slots.
  - `model-request`: LLM provider requests.
  - `browser-session`: Vision Playwright browser pages.
  - `subprocess`: Terminal tool child process executions.
- Priority tiers:
  - `interactive`: User chat turns and direct cancellations (preempts queues, admitted even under elevated pressure).
  - `background`: Autonomous agent turns and subtasks.
  - `batch`: Non-time-critical sweeps and indexers.
- Hardware-adaptive budgets (`ResourceBudget`) computed automatically from host memory and CPU core count.
- Structured leases (`ResourceLease`) tracking acquisition time, units, priority, and parent task/workspace ownership.

### 2.2 System Resource Telemetry (`@mediobot-v2/runtime/resource-telemetry.ts`)
- Low-overhead cached telemetry collector (1,000ms caching window).
- **Darwin (macOS) Specific Calibration:** Accounts for macOS `vm_stat` inactive memory pages (`availableMemory = rawFree + inactiveBytes`) alongside raw free memory, preventing false critical alarms from macOS's opportunistic page caching.
- Dynamic pressure classification (`normal`, `elevated`, `critical`).
- Dynamic concurrency scaling (AIMD):
  - Normal: 100% capacity.
  - Elevated: 50% capacity.
  - Critical: Concurrency dialed down to 1 slot; background task admission suspended to preserve responsiveness for interactive user turns.

### 2.3 Subprocess Supervision (`@mediobot-v2/runtime/subprocess-supervisor.ts`)
- Explicit registration of all child processes spawned by `terminal.execute` tool invocations.
- Global quota (`maxConcurrentGlobal`) and per-workspace quota (`maxConcurrentPerWorkspace`) enforcement.
- Tree-aware process cleanup: Sends `SIGTERM` followed by a grace period and escalating to `SIGKILL` if necessary.
- Atomic teardown on task cancellation: `terminateTaskSubprocesses(taskId)` eliminates orphan processes when turns are interrupted or cancelled.

### 2.4 Fair Deficit-Round-Robin Scheduler (`@mediobot-v2/runtime/resource-governor.ts`)
- Queued requests are organized by workspace with DRF (Dominant Resource Fairness) principles and wait-time aging anti-starvation boost (`agingBoost = waitTimeMs / 10000`).
- Priority weighting ensures `interactive` requests receive head-of-line preference over `background` and `batch` tasks.
- Cancellation signals (`AbortSignal`) remove entries immediately from the queue without leaks or dangling references.

### 2.5 Integrated Tool & Vision Runtime Supervision
- **Tools (`@mediobot-v2/tools`)**: Child processes spawned by `ToolRuntime` are supervised by `SubprocessSupervisor`, registered on `spawn`, unregistered on process `close`, and aborted immediately on quota breach with diagnostic stderr.
- **Vision (`@mediobot-v2/vision`)**: `PlaywrightBrowserRuntime` enforces `maxSessions` quota and raises typed `BrowserSessionQuotaExceededError`.
- **Worker Runtime (`@mediobot-v2/runtime`)**: Task execution acquires an `execution-slot` lease upon task start and automatically releases it upon task settlement, propagating cancellations to all held resources.

---

## 3. Test Verification Matrix

| Suite | File | Tests | Status | Key Assertions Verified |
| :--- | :--- | :---: | :---: | :--- |
| **Governor Unit Suite** | `packages/runtime/tests/resource-governor.test.ts` | 7 | **PASS** | Hardware budget calculation, global & workspace concurrency quotas, DRF fair scheduling & anti-starvation, dynamic telemetry adaptation, process tree termination, cancellation teardown, AbortSignal queue eviction. |
| **Runtime Core Suite** | `packages/runtime/tests/index.test.ts` | 33 | **PASS** | Event-driven supervision seams, capacity reservation, lease settlement, definition-driven task submission. |
| **End-to-End Suite** | `apps/command-center/tests/runtime/resource-governor-e2e.test.ts` | 5 | **PASS** | `GET /api/system/resources` server endpoint, terminal tool subprocess supervision, runaway subprocess quota rejection, browser session quota enforcement, composition multi-workspace admission. |
| **Monorepo Typecheck** | `pnpm typecheck` | 11 pkgs | **PASS** | 0 TypeScript compilation errors across all workspace packages. |
| **Frontend Production Build** | `pnpm --filter @mediobot-v2/command-center build` | 1 | **PASS** | Vite production bundle compiled in < 1s with 0 errors. |

---

## 4. Live UI Validation

- **Component:** `apps/command-center/src/components/ResourceStatusIndicator.tsx`
- **Location:** TopChrome right action cluster.
- **Visuals:** Dark ZIP-derived minimal pill with active/limit counter (`0/4`), color-coded memory pressure dot (green = normal, yellow = elevated, red = critical), and interactive detail popover.
- **Live Telemetry Verified:**
  - Memory Pressure State: `NORMAL`
  - Active Concurrency: `0 / 4 active`
  - Active Subprocesses: `0`
  - Memory Usage: `13G / 16G (83.1%)`
  - Load Average (1m): `2.45`
- **Visual Evidence:**
  - Recording: `phase4_resource_ui_1791909632030.webp`
  - Interactive Popover Screenshot: `resource_governor_clicked_1791909657525.png`
  - Zero layout regressions, completely responsive.

---

## 5. Invariant Conformance

- **Fairness:** No workspace monopolizes resources; wait-time aging prevents background starvation.
- **Responsiveness:** Interactive user turns can always preempt queues and execute even under elevated pressure.
- **Stability:** Dynamic scaling throttles concurrency under memory pressure to prevent OOM panics.
- **Zero Orphans:** Subprocess supervisor process tree termination ensures all child processes are killed upon cancellation.
- **No Synthetic Substitutions:** Verified against real OS processes, SQLite storage, and live browser runtime.
