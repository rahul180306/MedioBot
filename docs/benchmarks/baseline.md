# Phase 0 Baseline Benchmarks — MedioBot V2

> **Date:** 2026-10-13  
> **Environment:** macOS 26.0 (Darwin arm64), Apple Silicon, Node.js v22+  
> **Execution Mode:** Goal Mode (Phase 0 Baseline Verification)  
> **Integrity Rule:** All numbers are empirically measured. No invented or simulated metrics.

---

## 1. Executive Summary Table

| Metric | Measured Value | Measurement Method | Context / Details |
|--------|---------------|-------------------|-------------------|
| **Application Startup Time** | **63.04 ms** | `performance.now()` in `startCommandCenter({ port: 0, vite: true })` | Full server startup with DB migrations, session restore, and embedded Vite server |
| **Idle Process Memory (Background Server)** | **20.2 MB RSS** (20,688 KB) | OS process table (`ps -eo pid,rss,command`) | Background process `server.ts` running idle without active WebSocket/SSE load |
| **Fresh Startup Memory (Vite Embedded)** | **197.95 MB RSS** | `process.memoryUsage().rss` | Fresh process load immediately following Vite development server attachment |
| **Heap Memory (Used / Total)** | **62.32 MB / 90.03 MB** | `process.memoryUsage().heapUsed` / `heapTotal` | Fresh runtime heap allocation post-startup |
| **Existing Project Discovery Time (Average)** | **1.62 ms** | 5-run average via `discoverProjectIntelligence(cwd)` | Cold: 4.19 ms; Warm: 0.68 – 1.45 ms across repository root (~200 files) |
| **TypeScript Monorepo Typecheck Time** | **8.595 s** | `time pnpm typecheck` (tsc across 10 packages) | 35.80s user, 0.96s system, 427% CPU utilization |
| **Production Build Time (Vite)** | **819 ms** | `vite build` in `apps/command-center` | 8,377 modules transformed, outputs bundled into `dist/` |

---

## 2. Test Execution Times by Package

All tests executed via Node 22 native test runner (`node --experimental-strip-types --test`).

| Package | Test Duration | Tests Run | Pass | Fail | Notes |
|---------|---------------|-----------|------|------|-------|
| `@mediobot-v2/domain` | **82.1 ms** | 34 | 34 | 0 | Typed completion policies, world ownership, goal constraints |
| `@mediobot-v2/models` | **102.9 ms** | 36 | 36 | 0 | Structured JSON extraction, reasoning normalization, provider adapters |
| `@mediobot-v2/tools` | **461.5 ms** | 18 | 18 | 0 | Workspace containment, path traversal checks, terminal isolation |
| `@mediobot-v2/runtime` | **99.7 ms** | 33 | 33 | 0 | Concurrency reservations, task submission, event supervision |
| `@mediobot-v2/cody` | **467.5 ms** | 21 | 21 | 0 | Tool loop iteration, verification gating, write-recovery feedback |
| `@mediobot-v2/tester` | **157.0 ms** | 6 | 6 | 0 | Revision hashing, deterministic test execution, fabrication rejection |
| `@mediobot-v2/maestro` (Core) | **383.6 ms** | 50 | 50 | 0 | Completion, diagnostics, definitions, integration, discovery, reliability |
| `@mediobot-v2/maestro` (Text Workers) | **421.9 ms** | 12 | 3 | 9 | `tests/text-workers.test.ts` failure documented in Task 1 baseline |
| `@mediobot-v2/command-center` (Persistence) | **726.9 ms** | 37 | 37 | 0 | SQLite WAL persistence, multi-chat isolation, workbench tabs |
| `@mediobot-v2/command-center` (Workspace) | **449.7 ms** | 47 | 47 | 0 | Open folder canonicalization, project awareness, workspace gates A-Z |
| `@mediobot-v2/command-center` (Turns) | **496.9 ms** | 13 | 13 | 0 | Cody and autonomous turn execution, cancellation isolation |
| `@mediobot-v2/command-center` (Core Runtime) | **462.8 ms** | 41 | 40 | 1 | 40 pass; 1 failure in `execution-evidence.test.ts:314` (Regression 4) |

---

## 3. Project Discovery Characteristics (Existing Legacy Scan)

- **Target Directory:** `/Users/rahulkarthikt/Documents/mediobot/mediobot-v2`
- **Method:** `discoverProjectIntelligence(workspaceRoot)` in `packages/maestro/src/discovery.ts`
- **Cap:** 35 filesystem entries maximum, sampling candidate directories (`src`, `app`, `apps`, `packages`, `lib`, `test`, `tests`, `components`, `pages`) up to 5 items each.
- **Latency Distribution (5 consecutive runs):**
  - Run 1 (Cold cache): 4.19 ms
  - Run 2 (Warm): 1.45 ms
  - Run 3 (Warm): 0.82 ms
  - Run 4 (Warm): 0.68 ms
  - Run 5 (Warm): 0.97 ms
- **Findings:** The legacy 35-file scan is lightweight (< 5 ms) but lacks AST symbol depth, function signatures, and call graph topology. Phase 1 Tree-sitter integration will provide symbol depth while legacy discovery is retained as the active fallback.
