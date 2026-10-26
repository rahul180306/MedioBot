# GEMINI FLASH IMPLEMENTATION GUIDE — MedioBot V2

> **Author:** Principal AI Systems Architect (Opus Audit — Claude Opus 4.6)
> **Date:** 2026-10-13
> **Audience:** Gemini 3.8 Flash — Implementation Agent
> **Status:** ENGINEERING CONTRACTS FOR IMPLEMENTATION

---

## 1. How to Use This Guide

This guide provides precise engineering contracts for each implementation phase. Claude Opus 4.6 performed architectural reasoning; **you (Gemini Flash) will implement the code**.

**Rules for Implementation:**
1. Implement ONE phase per Goal Mode session (unless the phase is simple enough to combine)
2. Complete ALL acceptance criteria before declaring a phase done
3. Run tests after every change
4. Do NOT modify files outside the declared scope
5. Do NOT skip acceptance criteria — each one is mandatory
6. If you encounter an ambiguity not covered here, add a `TODO(architecture)` comment and proceed with the most conservative approach
7. Preserve all existing comments and documentation

---

## 2. Phase 0 Contract: Baseline Verification

### Objective
Verify the current system works. Create shared type definitions.

### Steps
1. Run `pnpm test` — document results
2. Run `pnpm build` — document results
3. Check if the dev server starts correctly (`pnpm dev`)
4. Create `packages/contracts/package.json` with TypeScript configuration
5. Create `packages/contracts/src/index.ts` with shared interfaces:

```typescript
// Required interfaces to define in packages/contracts/src/index.ts:

export interface TaskId { readonly __brand: 'TaskId'; readonly value: string; }
export function createTaskId(value: string): TaskId;

export interface EvidenceId { readonly __brand: 'EvidenceId'; readonly value: string; }

export interface TaskNode {
  readonly id: TaskId;
  readonly agentId: string;
  readonly objective: string;
  readonly dependencies: ReadonlyArray<TaskId>;
  readonly fileOwnership: ReadonlyArray<string>;
  readonly status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly errorMessage: string | null;
}

export interface Evidence {
  readonly id: EvidenceId;
  readonly type: 'file-read' | 'command-output' | 'test-result' | 'ast-query' | 'user-input';
  readonly content: string;
  readonly source: EvidenceSource;
  readonly createdAt: number;
  readonly createdBy: string;
  readonly taskId: TaskId;
}

export type EvidenceSource =
  | { readonly type: 'file'; readonly path: string; readonly line?: number; readonly hash: string }
  | { readonly type: 'command'; readonly command: string; readonly exitCode: number }
  | { readonly type: 'test'; readonly testFile: string; readonly passed: boolean }
  | { readonly type: 'ast'; readonly filePath: string; readonly symbolName: string }
  | { readonly type: 'user'; readonly turn: number };

export interface IndexReport {
  readonly filesIndexed: number;
  readonly filesSkipped: number;
  readonly symbolsExtracted: number;
  readonly dependenciesTracked: number;
  readonly durationMs: number;
  readonly errors: ReadonlyArray<{ path: string; error: string }>;
}
```

6. Record baseline benchmarks in `docs/benchmarks/baseline.md`:
   - Startup time (`time pnpm dev` until first SSE event)
   - Idle RSS (`process.memoryUsage().rss` after startup)
   - `pnpm test` execution time

### Definition of Done
- [ ] `pnpm test` output documented
- [ ] `pnpm build` succeeds
- [ ] `packages/contracts/` added to workspace and compiles
- [ ] Baseline benchmarks recorded
- [ ] No production code modified

---

## 3. Phase 1 Contract: Project Intelligence Engine Core

### Objective
Build the AST indexing system with Tree-sitter and SQLite.

### Dependencies to Install
```bash
pnpm add web-tree-sitter -w --filter @mediobot-v2/intelligence
pnpm add tree-sitter-typescript tree-sitter-javascript -w --filter @mediobot-v2/intelligence
pnpm add better-sqlite3 -w --filter @mediobot-v2/intelligence
pnpm add -D @types/better-sqlite3 -w --filter @mediobot-v2/intelligence
pnpm add chokidar -w --filter @mediobot-v2/intelligence
```

### New Package Structure
```
packages/intelligence/
  package.json
  tsconfig.json
  src/
    index.ts          — Public API (ProjectIntelligenceEngine class)
    parser.ts         — Tree-sitter initialization and parsing
    extractor.ts      — AST node → Symbol extraction
    store.ts          — SQLite schema creation and queries
    watcher.ts        — Chokidar file watcher with debounce
    repomap.ts        — PageRank RepoMap generator (Phase 2)
  test/
    parser.test.ts
    extractor.test.ts
    store.test.ts
    integration.test.ts
```

### SQLite Schema
Copy exactly from `PROJECT_INTELLIGENCE_SPEC.md` Section 4.

### Key Implementation Details

**parser.ts:**
```typescript
// Initialize Tree-sitter with WASM
import Parser from 'web-tree-sitter';

let initialized = false;

export async function initParser(): Promise<Parser> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  const parser = new Parser();
  // Load language grammar based on file extension
  return parser;
}

export async function loadLanguage(langName: string): Promise<Parser.Language> {
  // Load WASM grammar for the language
  // Cache loaded languages to avoid re-loading
}

export function parseFile(parser: Parser, content: string, language: Parser.Language): Parser.Tree {
  parser.setLanguage(language);
  return parser.parse(content);
}
```

**extractor.ts:**
```typescript
// Walk AST and extract symbols
export function extractSymbols(tree: Parser.Tree, filePath: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const cursor = tree.walk();

  // Recursive walk — extract function_declaration, class_declaration,
  // interface_declaration, type_alias_declaration, export_statement, import_statement
  // See PROJECT_INTELLIGENCE_SPEC.md Section 6.2 for the mapping table

  return symbols;
}

export function extractDependencies(tree: Parser.Tree, filePath: string): ExtractedDependency[] {
  // Find all import_statement nodes
  // Parse import specifier and imported names
  return [];
}
```

### Error Handling
- If Tree-sitter WASM fails to load: log error, return empty index, set `USE_PROJECT_INTELLIGENCE=false`
- If a file fails to parse: skip file, log error, continue indexing remaining files
- If SQLite database is corrupted: delete and recreate on next initialization

### Tests Required
1. `parser.test.ts`: Parse a TypeScript file, verify tree is not null
2. `extractor.test.ts`: Extract symbols from known TypeScript file, verify expected symbols found
3. `store.test.ts`: Insert and query symbols, verify FTS5 search works
4. `integration.test.ts`: Index the `packages/contracts/src/index.ts` file, search for "TaskNode"

### Definition of Done
- [ ] `pnpm test --filter @mediobot-v2/intelligence` — all tests pass
- [ ] Full index of MedioBot V2 repo completes without errors
- [ ] FTS5 search returns results for known symbol names
- [ ] Feature flag `USE_PROJECT_INTELLIGENCE` exists and defaults to `true`
- [ ] Legacy `discoverProjectIntelligence()` still works when flag is `false`

---

## 4. Phase 2 Contract: Shared Context Integration

### Objective
Wire PIE output into Maestro's context compilation.

### Files to Modify
- `packages/maestro/src/context.ts` — Add PIE context source
- `packages/maestro/src/index.ts` — Pass PIE to context compilation

### New Files
- `packages/intelligence/src/repomap.ts`
- `packages/intelligence/src/metadata.ts`

### Key Changes to `compileMaestroContext`:
```typescript
// In context.ts, add a new context record type:
if (sources.projectIntelligence) {
  const repoMap = await sources.projectIntelligence.generateRepoMap({
    maxTokens: 1500,
    includeSignatures: true,
    focusPaths: sources.focusPaths,
  });
  records.push({
    id: 'project-intelligence-repomap',
    label: 'Project Intelligence: Repository Map',
    content: repoMap.content,
    priority: 'high',
  });
}
```

### Definition of Done
- [ ] RepoMap generation produces < 2,000 tokens
- [ ] Maestro prompts include RepoMap when PIE is enabled
- [ ] Cody receives project intelligence context
- [ ] All existing tests still pass

---

## 5. Phases 3-10: Summary Contracts

Detailed engineering contracts for Phases 3-10 follow the same structure as Phases 0-2. The key specifications are in:

| Phase | Primary Spec Document |
|-------|----------------------|
| 3 | [CORRECTED_ARCHITECTURE.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/CORRECTED_ARCHITECTURE.md) §2.2 |
| 4 | [MAESTRO_ORCHESTRATION_SPEC.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/MAESTRO_ORCHESTRATION_SPEC.md) |
| 5 | [PARALLEL_EXECUTION_SPEC.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/PARALLEL_EXECUTION_SPEC.md) |
| 6 | [RELIABILITY_AND_VERIFICATION_SPEC.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/RELIABILITY_AND_VERIFICATION_SPEC.md) |
| 7 | [MEMORY_AND_KNOWLEDGE_SPEC.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/MEMORY_AND_KNOWLEDGE_SPEC.md) |
| 8 | [CORRECTED_ARCHITECTURE.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/CORRECTED_ARCHITECTURE.md) §3 |
| 9 | [PERFORMANCE_AND_SECURITY_SPEC.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/PERFORMANCE_AND_SECURITY_SPEC.md) |
| 10 | [PERFORMANCE_AND_SECURITY_SPEC.md](file:///Users/rahulkarthikt/Documents/mediobot/mediobot-v2/docs/advanced-orchestration-research/PERFORMANCE_AND_SECURITY_SPEC.md) §9 |

### Per-Phase Checklist (Apply to Every Phase)
1. Read the phase description in `FINAL_IMPLEMENTATION_PHASES.md`
2. Read the referenced spec document
3. Create new modules as specified
4. Implement public interfaces from `packages/contracts/`
5. Write unit tests for all new modules
6. Run `pnpm test` — all tests must pass
7. Run `pnpm build` — must compile cleanly
8. Verify feature flag enables/disables the new functionality
9. Document any deviations from the spec in a `PHASE_N_NOTES.md`

---

## 6. Critical Implementation Rules

### DO:
- Use `better-sqlite3` for synchronous SQLite access (faster than async wrappers)
- Use WAL mode for all SQLite databases
- Use feature flags for all new functionality
- Write tests before or alongside implementation
- Keep modules small and focused (< 500 lines per file)
- Use the existing `@mediobot-v2/domain` types where they exist
- Preserve all existing security boundaries

### DO NOT:
- Do NOT use `sqlite3` (async wrapper) — use `better-sqlite3` instead
- Do NOT create separate Node.js child processes for agents
- Do NOT load entire project files into memory simultaneously
- Do NOT hardcode performance numbers — measure and adjust
- Do NOT skip the feature flag — every new capability must be toggleable
- Do NOT modify the existing UI without explicit instruction
- Do NOT store API keys or secrets in SQLite databases
- Do NOT use `eval()` or `Function()` for dynamic code execution
- Do NOT bypass the existing path containment in `readWorkspaceFile()`

### WHEN IN DOUBT:
- Prefer the simpler implementation
- Add a `TODO(architecture)` comment for future review
- Log a warning rather than throwing an error for non-critical failures
- Use defensive programming (null checks, try-catch, fallbacks)
