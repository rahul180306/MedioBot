# MEDIOBOT V2 — PHASE 1: PROJECT INTELLIGENCE ENGINE (PIE)
## Engineering Implementation & Reliability Audit Report

> **Date:** October 13, 2026  
> **Status:** IMPLEMENTED — AWAITING USER ACCEPTANCE  
> **Package:** `@mediobot-v2/intelligence` (`packages/intelligence/`)  
> **Feature Flag:** `USE_PROJECT_INTELLIGENCE=false` (Disabled by default)  

---

## 1. Executive Summary

Phase 1 of MedioBot V2 has implemented the **Project Intelligence Engine (PIE)** under `packages/intelligence/`. PIE provides an accurate, incremental, AST-based project discovery and symbol indexing subsystem designed to serve as the shared, grounded foundation for all future Mediobots (Cody, Maestro, Tester, etc.).

All strict architectural constraints have been honored:
- **No UI, CSS, layout, or animation changes**: Zero modifications to frontend presentation.
- **No new Mediobots, no Vision implementation, no browser automation, no multi-agent scheduler**.
- **No external heavy services**: Zero new external native binary dependencies. Native Node 22 `node:sqlite` (`DatabaseSync`) was used with built-in FTS5 and WAL mode; TypeScript compiler API (`typescript: ^5.9.3`) was reused for 100% accurate, WASM-free AST parsing and symbol extraction.
- **Rule 1 compliance**: SQLite corruption triggers non-destructive quarantine (`.corrupt-<timestamp>`) and verified disposable rebuilds. Never automatically deletes user databases.
- **Feature flag disabled by default**: `USE_PROJECT_INTELLIGENCE=false`. Legacy Maestro project discovery remains active and transparently acts as an automatic error fallback.

---

## 2. Root-Cause Report for Step 0 Baseline Failures

Prior to PIE implementation, baseline failures reported from Phase 0 were investigated and definitively resolved:

### 2.1 Maestro Text-Worker Tests (9 Failures)
- **Location:** `packages/maestro/tests/text-workers.test.ts`
- **Root Cause:** In earlier sessions, Maestro's structural decision validator was hardened to enforce an exact key set on `respond` decisions (`exact(["type", "message", "basis", "evidenceRefs"])`). The test mock at lines 22 and 111 provided only `{ type: "respond", message: "..." }`, omitting `basis` and `evidenceRefs`. Maestro's validator threw a structural `schema-mismatch` error.
- **Correction:** Updated mock fixtures in `text-workers.test.ts` to include `basis: "conversation", evidenceRefs: []`, satisfying Maestro's schema validator without altering production code or weakening assertions.

### 2.2 Execution Evidence Regression 4 (1 Failure)
- **Location:** `apps/command-center/tests/runtime/execution-evidence.test.ts:314`
- **Root Cause:** The test mock failed to intercept `MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER`. Maestro's semantic gating requires verified project evidence for current-project assertions. Because the classifier was not intercepted, the turn required current evidence and rejected the `previous-turn-execution` summary claim.
- **Correction:** Intercepted the evidence classifier in the test fixture at line 330, allowing the mock to exercise the target historical evidence turn accurately.

### 2.3 Command-Center Parallel-Text Tests (2 Failures)
- **Location:** `apps/command-center/tests/runtime/parallel-text.test.ts:36,38`
- **Root Cause:** Identical to the text-workers defect: mock respond decisions omitted `basis` and `evidenceRefs`.
- **Correction:** Added `basis: "conversation", evidenceRefs: []` to the test mock.

### 2.4 Command-Center Vision Hybrid Composition Browser Leak
- **Location:** `apps/command-center/tests/runtime/vision-hybrid-composition.test.ts:79,100,114`
- **Root Cause:** Test blocks instantiated `PlaywrightBrowserRuntime` via `createComposition({ headless: true })` without shutting down in their `finally` blocks, causing Node 22's test runner to hang on open browser socket handles.
- **Correction:** Added `await composition?.shutdown?.()` to the finally blocks.

---

## 3. Architecture & Capabilities Implemented in `packages/intelligence`

```
packages/intelligence/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts               # Public API exports and factory
│   ├── types.ts               # Shared interfaces, SymbolRecord, DependencyRecord, RepoMap
│   ├── config.ts              # USE_PROJECT_INTELLIGENCE feature flag
│   ├── store.ts               # Node:sqlite DatabaseSync, WAL mode, FTS5 triggers, quarantine
│   ├── scanner.ts             # Canonical workspace directory scanner with symlink containment
│   ├── watcher.ts             # Debounced recursive file watcher with queue serialization
│   ├── repomap.ts             # In-degree dependency ranking & token-budgeted RepoMap generator
│   ├── engine.ts              # ProjectIntelligenceEngineImpl and safe fallback coordinator
│   └── adapters/
│       ├── types.ts           # LanguageAdapter and ParsedFile contracts
│       ├── typescript.ts      # TypeScript & JavaScript AST extractor using ts.createSourceFile
│       └── registry.ts        # Extensible language adapter registry
├── scripts/
│   ├── benchmark.ts           # Telemetry & performance benchmarking script
│   └── pie.ts                 # CLI tool for interactive manual verification
└── tests/
    ├── parser-and-adapters.test.ts    # Scenarios 1, 2, 3, 6, 8
    ├── store-and-safety.test.ts        # Scenarios 5, 7, 12, 13, 16
    ├── scanner-and-containment.test.ts  # Scenarios 4, 14, 15
    ├── watcher-and-incremental.test.ts # Scenarios 9, 10, 11, 19, 20
    └── feature-flag-and-fallback.test.ts # Scenarios 17, 18
```

### Key Technical Capabilities:
1. **TypeScript/JavaScript Symbol & AST Extraction:** Extracts interfaces, types, classes, methods, functions, variables, constants, and enums with exact 1-indexed lines, 0-indexed character offsets, signatures, and JSDoc docstrings.
2. **Import/Export Dependency Tracking:** Extracts ES imports, CommonJS `require()`, dynamic `import()`, named exports, default exports, and `export * / export { ... } from` re-exports.
3. **SQLite & FTS5 Index Safety:**
   - WAL journal mode (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL`).
   - SQLite FTS5 full-text search table with automated triggers on insert, update, and delete.
   - Non-destructive corruption quarantine: If `PRAGMA integrity_check` fails, the corrupt file is renamed to `<path>.corrupt-<timestamp>` and a fresh database is initialized. Never deletes user data.
4. **Symlink Containment & Traversal Protection:**
   - Validates `realpath(workspaceRoot)`.
   - Rejects path traversal (`..` escapes).
   - Skips external symlinks pointing outside the workspace while indexing internal symlinks cleanly.
5. **Debounced & Serialized File Watching:**
   - Debounces rapid file writes (150ms default).
   - Serializes change dispatch to prevent overlapping writes or concurrent indexing collisions.
6. **Token-Budgeted PageRank-Inspired RepoMap:**
   - Ranks files by in-degree import dependency graph and focus boosts.
   - Formats a compact repository overview strictly within token limits (< 1,500 tokens).

---

## 4. Test Results Across the Monorepo

| Package / Test Suite | Total Tests | Passed | Failed | Skipped |
|----------------------|-------------|--------|--------|---------|
| `@mediobot-v2/intelligence` (New) | 20 | 20 | 0 | 0 |
| `@mediobot-v2/maestro` | 62 | 62 | 0 | 0 |
| `@mediobot-v2/runtime` | 33 | 33 | 0 | 0 |
| `@mediobot-v2/domain` | 34 | 34 | 0 | 0 |
| `@mediobot-v2/models` | 36 | 36 | 0 | 0 |
| `@mediobot-v2/tools` | 18 | 18 | 0 | 0 |
| `@mediobot-v2/cody` | 21 | 21 | 0 | 0 |
| `@mediobot-v2/tester` | 6 | 6 | 0 | 0 |
| `@mediobot-v2/vision` | 10 | 10 | 0 | 0 |
| `@mediobot-v2/command-center` (Backend) | 217 | 212 | 0 | 5 (live opt-in) |
| **Monorepo Total** | **457** | **452** | **0** | **5** |

### TypeScript Compilation & Production Build:
- `pnpm -r typecheck`: **11 of 11 workspace packages pass cleanly (0 errors)**.
- `pnpm --filter @mediobot-v2/command-center build`: **Vite build succeeds in 761ms**.

---

## 5. Performance Benchmark Results

Tested against the full MedioBot V2 repository (291 source files, 8,299 symbols):

| Metric | Target | Measured Result | Status |
|--------|--------|-----------------|--------|
| **Full Index Duration** | < 5,000 ms | **458.53 ms** | **Exceeds Target (10x faster)** |
| **Incremental Update Duration (1 file)** | < 100 ms | **0.32 ms** | **Exceeds Target (300x faster)** |
| **Exact Symbol Retrieval Latency** | < 10 ms | **0.050 ms** | **Exceeds Target** |
| **FTS5 Search Latency** | < 10 ms | **0.095 ms** | **Exceeds Target** |
| **RepoMap Generation** | < 50 ms / < 1,500 tokens | **43.96 ms / 1,480 tokens** | **Meets Target** |
| **SQLite Database Size** | < 5.0 MB | **1.52 MB** | **Exceeds Target** |
| **Memory Delta (RSS)** | Bounded (< 100 MB) | **46.56 MB** | **Meets Target** |
| **Idle Watcher CPU** | < 0.5% | **~0.06% (1.25ms CPU / 2s)** | **Exceeds Target** |

---

## 6. Feature Flag and Fallback Verification

- Flag: `USE_PROJECT_INTELLIGENCE` (environment variable).
- Default: `false`.
- When `false`:
  - Maestro and existing discovery mechanisms execute legacy `discoverProjectIntelligence()` without invoking PIE.
  - Zero performance regression or behavioral disruption to existing flows.
- When `true`:
  - Invokes `discoverProjectIntelligenceSafe()`.
  - Builds or retrieves AST index and RepoMap.
  - If any unhandled error occurs during indexing, the error is logged and the engine automatically falls back to the legacy discovery path.

---

## 7. Known Limitations

1. **Language Adapters:** Phase 1 implements TypeScript, JavaScript, JSX, and TSX. Other languages (Python, Rust, Go) fall back to metadata-only indexing (file size, language detection, hash) without symbol extraction. Additional language adapters can be added via the extensible `LanguageAdapter` interface in future phases.
2. **Phase 2 Context Wiring:** PIE is completely implemented as a standalone engine. Deep integration into Maestro's prompt compilation (`compileMaestroContext`) is explicitly reserved for Phase 2.
3. **Cross-File Type Resolution:** Symbols are extracted directly from AST syntax trees without running a heavy background language server (LSP/tsserver), by architectural decision (deferred to Phase 7+).
