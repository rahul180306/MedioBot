# MedioBot V2 — Phase 4: Intelligent Resource Governor Architecture Specification

**Phase:** Phase 4 — Production-Oriented Resource Management & Concurrency Governance  
**System:** MedioBot V2 Runtime Orchestration  
**Authors:** Principal Systems Architect & Senior AI Infrastructure Developer  
**Status:** Approved for Implementation  

---

## 1. Executive Mission & System Goals

MedioBot V2 coordinates multiple autonomous specialized agents (Maestro orchestrator, Cody software engineer, Vision browser agent, Tester verification agent), high-throughput model inference streams, headless Playwright browser automation, and localized shell subprocesses.

Prior to Phase 4:
- `WorkerRuntime` threw an unbuffered `RuntimeCapacityError` when exceeding a static limit of 4 concurrent executions, resulting in dropped work rather than queued admission.
- Subprocesses spawned by `ToolRuntime.runTerminal` tracked PIDs only for the lifetime of a single command without global quota enforcement, process-group tree termination, or crash reclamation.
- Model requests made direct API calls without admission concurrency gates, risking HTTP 429 rate limit storms and unbounded provider saturation under parallel multi-agent tasks.
- Browser sessions were provisioned on demand without per-workspace or global resource quotas.
- Host memory pressure and system CPU load were not dynamically monitored.

**Phase 4 Goal:** Implement an operating-system-grade **Intelligent Resource Governor** that preserves system responsiveness, hardware safety, and cross-workspace fairness under heavy multi-agent concurrency.

---

## 2. Resource Taxonomy & Ownership Model

Resources are strictly categorized, leased, and reclaimed under a formal ownership hierarchy:

```
                      ┌────────────────────────────┐
                      │  ResourceGovernor (Global) │
                      └─────────────┬──────────────┘
                                    │
           ┌────────────────────────┼────────────────────────┐
           ▼                        ▼                        ▼
┌────────────────────┐    ┌────────────────────┐    ┌────────────────────┐
│ Execution Slots    │    │ Model Concurrency  │    │ Browser Sessions   │
│ - Global Concurrency│    │ - Per-Provider RPM │    │ - Global Quota     │
│ - Per-Workspace Cap│    │ - Token Budget     │    │ - Per-Workspace Cap│
└──────────┬─────────┘    └────────────────────┘    └────────────────────┘
           │
           ├────────────────────────┐
           ▼                        ▼
┌────────────────────┐    ┌────────────────────┐
│ Subprocesses       │    │ System Memory      │
│ - PID Tree Superv. │    │ - macOS Telemetry  │
│ - PGID Tree Kill   │    │ - Adaptive Throttl.│
└────────────────────┘    └────────────────────┘
```

### 2.1 Resource Categories

1. **`execution-slot`**: High-level agent execution capacity. Bounds how many active Mediobot tasks run concurrently.
2. **`model-request`**: Outbound LLM API calls. Gated per provider connection and globally to prevent token exhaustion and rate limits.
3. **`browser-session`**: Playwright browser pages and contexts. Heavyweight memory footprint requires strict caps.
4. **`subprocess`**: Shell commands spawned by `ToolRuntime`. Requires process group isolation (`setsid` / process tree tracking) to prevent orphaned zombies.
5. **`memory-budget`**: Host system and Node.js process memory headroom.

### 2.2 Resource Leases

Every allocated resource is governed by a typed `ResourceLease`:
- **Identity:** `leaseId`, `taskId`, `workspaceId`, `category`, `units`.
- **Temporal Bounds:** `acquiredAt`, `expiresAt`, `heartbeatAt`.
- **Ownership Invariant:** A lease belongs to exactly one `(taskId, workspaceId)` pair.
- **Settlement Invariant:** When a task settles (completes, fails, or cancels), all held leases are atomically released in reverse dependency order.

---

## 3. Scheduling & Fair Admission Engine

### 3.1 Task Priority Classes

| Priority Class | Weight | Intended Workload | Preemption / Admission Behavior |
|---|---|---|---|
| `interactive` | 100 | Direct user conversation turns in chat UI | Highest admission priority; drains immediately ahead of background work. |
| `background` | 50 | Autonomous specialist delegations (Maestro -> Cody / Tester) | Standard autonomous execution; subject to adaptive throttling. |
| `batch` | 10 | Background maintenance, repo indexing, bulk tests | Lowest priority; first to yield under memory pressure. |

### 3.2 Fair Scheduling & Anti-Starvation (DRF / Deficit Round Robin)

To prevent a single active project workspace with dozens of subtasks from monopolizing system capacity:
1. **Per-Workspace Concurrency Quotas:** Each workspace has a dedicated cap (e.g., maximum 2 concurrent tasks if global cap is 4).
2. **Fair Deficit Round Robin:** When execution slots become available, candidate tasks are selected from the workspace with the lowest current active allocation.
3. **Aging Anti-Starvation Formula:** For each scheduling cycle that a task waits in queue, its effective priority score increments:
   $$\text{EffectiveScore} = \text{BasePriority} + (\text{WaitTimeMs} \times \alpha)$$
   This guarantees that background tasks cannot be starved indefinitely by continuous interactive requests.

---

## 4. Hardware Telemetry & Adaptive Concurrency Control

### 4.1 Telemetry Engine & macOS Specialization

The telemetry engine gathers real-time host and process metrics:
- **Universal:** `os.totalmem()`, `os.freemem()`, `os.cpus().length`, `os.loadavg()`, `process.memoryUsage()`.
- **macOS Specialization (`darwin`):** Non-blocking extraction of inactive, active, wired, and compressed memory pages via `vm_stat` or `sysctl`, with fallback to standard Node.js OS primitives.
- **Sampling Overhead:** Cached sampling with a 1,000ms sliding TTL, incurring $< 0.1\%$ CPU overhead.

### 4.2 Three-State Memory Pressure Model

```
 0%                      75%         85%               100% Host Memory Used
┌─────────────────────────┬───────────┬──────────────────┐
│         NORMAL          │ ELEVATED  │     CRITICAL     │
└─────────────────────────┴───────────┴──────────────────┘
```

1. **`NORMAL` (Memory Used $< 75\%$):**
   - Full configured concurrency limits active.
   - All priority classes admitted freely.
2. **`ELEVATED` (Memory Used $75\% - 85\%$ or High Load):**
   - Concurrency limits dynamically scaled down by $50\%$ (AIMD backoff).
   - `batch` and new `background` tasks queued; `interactive` tasks remain admitted.
3. **`CRITICAL` (Memory Used $> 85\%$ or Free Memory $< 15\%$):**
   - Admission of non-interactive work completely suspended.
   - Cooperative workers signaled to pause or back off.
   - **Crucial Safety Rule:** Healthy running tasks are **never killed aggressively**; they are allowed to complete their current atomic step to reach a safe checkpoint.

---

## 5. Subprocess & Browser Session Supervision

### 5.1 Subprocess Tree Supervision (`SubprocessSupervisor`)

- Every spawned terminal command receives a registered entry with PID, start time, `taskId`, and `workspaceId`.
- On task cancellation or timeout:
  1. Sends `SIGTERM` to the process group (`-pid` on POSIX systems).
  2. Waits for a grace period (e.g., 500ms).
  3. Escalates to `SIGKILL` (`-9`) if processes fail to exit.
- Guarantees zero orphaned compiler, test, or server processes upon cancellation or task abort.

### 5.2 Browser Session Governor (`BrowserSessionGovernor`)

- Intercepts session creation in `PlaywrightBrowserRuntime`.
- Enforces global limit (default: 2 active browser sessions) and per-workspace limit (default: 1).
- Automatically closes stale or abandoned browser contexts when associated task finishes.

---

## 6. Durable Task Engine (Phase 3) Integration

The Resource Governor integrates seamlessly with the Phase 3 Finite State Machine:
1. **Queued Admission:** When submitted work exceeds available budget, `durable_tasks.status` is set to `queued` (or retained as `queued`).
2. **Admission Transition:** Once the Governor grants a lease, the task transitions to `running`.
3. **Restart Reconciliation:** On server restart, `interrupted` tasks retain their checkpoints, delegations, and priority; the Governor picks them up and re-admits them under available capacity.

---

## 7. Implementation Plan & Module Breakdown

1. **`packages/contracts/src/resource-governor.ts`**: Typed contracts, interfaces, and safety definitions.
2. **`packages/runtime/src/resource-telemetry.ts`**: Platform hardware telemetry (macOS & cross-platform).
3. **`packages/runtime/src/subprocess-supervisor.ts`**: Process tree supervision and clean termination.
4. **`packages/runtime/src/resource-governor.ts`**: Core Governor, fair scheduler, lease manager, adaptive concurrency controller.
5. **`packages/runtime/src/index.ts`**: Wire Governor into `WorkerRuntime` and `RuntimeTaskSubmission`.
6. **`apps/command-center/src/server.ts` & `composition.ts`**: Expose telemetry, wire per-workspace budgets, integrate with `/api/tasks` and UI status indicator.
7. **`apps/command-center/src/components/Header.tsx`**: Subtle, elegant dark-mode resource status indicator.
8. **Test Suite & Live Verification**: Unit, stress, and e2e integration tests.
