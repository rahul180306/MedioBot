# PERFORMANCE AND SECURITY SPEC — MedioBot V2

> **Author:** Principal AI Systems Architect (Opus Audit)
> **Date:** 2026-10-13
> **Status:** PROPOSED — Cross-Platform Optimization and Security Boundaries
> **Affects:** All packages

---

## 1. Target Platform Matrix

| Platform | Architecture | Min RAM | Agent Concurrency Target |
|----------|-------------|---------|--------------------------|
| macOS (Apple Silicon) | ARM64 | 8 GB | 2 agents + orchestrator |
| macOS (Intel) | x64 | 8 GB | 2 agents + orchestrator |
| Windows 10/11 | x64 | 8 GB | 2 agents + orchestrator |
| macOS (Apple Silicon) | ARM64 | 16 GB | 4 agents + orchestrator |
| macOS/Windows | Any | 32 GB | 8 agents + orchestrator |

---

## 2. Performance Budgets

### 2.1 Startup Performance

| Metric | Target | Notes |
|--------|--------|-------|
| Cold start to first prompt ready | < 3s | Excludes model warm-up |
| Project Intelligence initial index (500 files) | < 5s | Background, non-blocking |
| SQLite database open | < 50ms | WAL mode, pre-created |
| File watcher initialization | < 200ms | Chokidar with ignore patterns |
| UI render (Command Center) | < 1s | Vite dev: < 500ms, production: < 300ms |

### 2.2 Runtime Performance

| Metric | Target | Measurement |
|--------|--------|-------------|
| Idle RSS (no active tasks) | < 150 MB | Node.js process only |
| Per-agent incremental RSS | < 80 MB | Additional RSS when agent is active |
| Peak RSS (4 agents, 16 GB machine) | < 1.2 GB | Total Node.js process |
| CPU idle (no tasks, watcher active) | < 1% | 60-second average |
| CPU per active agent | < 15% of one core | During tool execution |
| Symbol search latency | < 10ms | p95, warm cache |
| RepoMap generation | < 50ms | p95, 500-file project |
| Incremental file re-index | < 100ms | Single file change |
| SSE event delivery to UI | < 50ms | Server to browser |

### 2.3 Task Performance

| Metric | Target | Notes |
|--------|--------|-------|
| Simple chat response | < 2s | Direct Maestro response, no delegation |
| Single-file edit task | < 30s | Cody: read → plan → edit → verify |
| Multi-file feature (3-5 files) | < 3 min | With parallel agents when applicable |
| Full project index rebuild | < 10s | 1,000-file project |

> [!IMPORTANT]
> All targets above are **UNTESTED proposals**. Each must be measured against real workloads
> before being treated as guarantees.

---

## 3. Resource Governor Implementation

### 3.1 System Resource Detection

```typescript
// PROPOSED — Cross-platform resource detection
export interface SystemProfile {
  readonly platform: 'darwin' | 'win32' | 'linux';
  readonly arch: 'arm64' | 'x64';
  readonly totalMemoryMB: number;
  readonly availableMemoryMB: number;
  readonly cpuCount: number;
  readonly cpuModel: string;

  /** Refresh resource readings */
  refresh(): Promise<void>;
}

// Implementation notes:
// macOS: os.totalmem(), os.freemem(), os.cpus()
// Windows: Same Node.js APIs work, but os.freemem() may underreport
// Memory pressure detection:
//   macOS: Use os.freemem() + check for memory_pressure (via child_process 'memory_pressure')
//   Windows: Use os.freemem() directly
```

### 3.2 Adaptive Concurrency

```typescript
// PROPOSED — Dynamic concurrency limits
export function computeMaxAgents(profile: SystemProfile): number {
  const availableMB = profile.availableMemoryMB;
  const osReserve = profile.platform === 'darwin' ? 3000 : 2500; // MB reserved for OS
  const appBaseline = 200; // MB for MedioBot core (no agents)
  const perAgent = 100;    // MB estimated per active agent (MUST benchmark)

  const usableMemory = Math.max(0, profile.totalMemoryMB - osReserve - appBaseline);
  const maxByMemory = Math.floor(usableMemory / perAgent);

  // CPU limit: don't exceed 80% of available cores
  const maxByCPU = Math.floor(profile.cpuCount * 0.8);

  return Math.max(1, Math.min(maxByMemory, maxByCPU, 8));
}
```

### 3.3 Memory Pressure Response

```
When available memory drops below 20% of total:
  1. Log warning
  2. Reduce max concurrent agents by 1
  3. Pause new task scheduling

When available memory drops below 10% of total:
  1. Log critical warning
  2. Set max concurrent agents to 1
  3. Trigger garbage collection (global.gc() if exposed)
  4. Clear non-essential caches (RepoMap cache, memory query cache)

When available memory recovers above 30%:
  1. Gradually restore max concurrent agents
  2. Resume normal scheduling
```

---

## 4. SQLite Performance Optimization

### 4.1 Configuration

```sql
-- Applied on database open
PRAGMA journal_mode = WAL;        -- Write-Ahead Logging for concurrent reads
PRAGMA synchronous = NORMAL;      -- Balance between safety and speed
PRAGMA cache_size = -8192;        -- 8 MB page cache (negative = KB)
PRAGMA mmap_size = 268435456;     -- 256 MB memory-mapped I/O
PRAGMA temp_store = MEMORY;       -- Keep temp tables in memory
PRAGMA busy_timeout = 5000;       -- 5s retry on locked database
```

### 4.2 Connection Management

- **Single writer, multiple readers**: Use WAL mode's MVCC
- **Connection pool**: One write connection, up to 4 read connections
- **Prepared statements**: Cache and reuse for hot queries (symbol lookup, FTS search)
- **Batch inserts**: Group index updates into transactions (not per-file commits)

### 4.3 Database Sizing

| Database | Estimated Size (500-file project) | Growth Rate |
|----------|-----------------------------------|-------------|
| project-intelligence.db | 2-5 MB | Proportional to file count |
| memory.db | 1-10 MB (after 3 months) | Proportional to task count |
| task-executions (in memory.db) | < 1 MB | Proportional to task history |
| audit.db | < 5 MB | Proportional to session count |

---

## 5. File Watcher Optimization

### 5.1 Chokidar Configuration

```typescript
// PROPOSED — Optimized watcher settings
const watcherOptions = {
  ignored: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/.mediobot/**',
    '**/coverage/**',
    '**/*.map',
    '**/.DS_Store',
  ],
  persistent: true,
  ignoreInitial: true,        // Don't fire events for existing files on startup
  awaitWriteFinish: {
    stabilityThreshold: 150,  // Wait 150ms after last write before firing
    pollInterval: 50,
  },
  usePolling: false,          // Use native FS events (fsevents on macOS, inotify on Linux)
  // Windows: Chokidar uses ReadDirectoryChangesW which is efficient
};
```

### 5.2 Debouncing Strategy

```
Batch file changes:
  1. Collect all change events within a 200ms window
  2. Deduplicate by file path (keep latest event type)
  3. Process as single batch update to Project Intelligence Engine
  4. This prevents: rapid save → re-index → save → re-index storms
```

---

## 6. Security Architecture

### 6.1 Existing Security (VERIFIED — Preserve)

The current codebase has strong security foundations:

| Feature | Location | Status |
|---------|----------|--------|
| Path containment | `discovery.ts: readWorkspaceFile()` | **VERIFIED** — symlink-safe, TOCTOU-resistant |
| Sensitive name detection | `discovery.ts: isSensitiveName()` | **VERIFIED** — blocks .env, keys, credentials |
| Secret scrubbing | `@mediobot-v2/models: sanitizeReasoningAndSecrets()` | **VERIFIED** — strips secrets from model I/O |
| Structural JSON validation | `@mediobot-v2/models: structuredJsonOnly()` | **VERIFIED** — prevents prompt injection via reasoning |
| Decision contract enforcement | `maestro/index.ts` | **VERIFIED** — rejects non-conforming decisions |

### 6.2 New Security Requirements

```typescript
// PROPOSED — Extended security boundaries
export interface SecurityPolicy {
  /** Files that agents may never read or write */
  readonly forbiddenPaths: ReadonlyArray<RegExp>;

  /** Commands that agents may never execute */
  readonly forbiddenCommands: ReadonlyArray<RegExp>;

  /** Environment variables that must be scrubbed from tool output */
  readonly scrubbedEnvVars: ReadonlyArray<string>;

  /** Maximum file size an agent may write (bytes) */
  readonly maxWriteSize: number;

  /** Whether agents may make network requests */
  readonly allowNetworkAccess: boolean;

  /** Whether agents may install packages */
  readonly allowPackageInstall: boolean;
}

const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  forbiddenPaths: [
    /\.env(?:\.|$)/i,
    /\.ssh\//,
    /\.gnupg\//,
    /\.aws\//,
    /id_(?:rsa|dsa|ecdsa|ed25519)/i,
    /\.npmrc$/i,
    /\.pypirc$/i,
  ],
  forbiddenCommands: [
    /^rm\s+-rf\s+\//,           // Prevent recursive delete from root
    /^sudo\s/,                   // No sudo
    /curl.*\|\s*(?:bash|sh)/,    // No pipe-to-shell
    /^chmod\s+777/,              // No world-writable permissions
  ],
  scrubbedEnvVars: [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
    'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN',
  ],
  maxWriteSize: 10 * 1024 * 1024,  // 10 MB
  allowNetworkAccess: false,         // Default: deny. Enable per-agent.
  allowPackageInstall: false,        // Requires user approval
};
```

### 6.3 Audit Logging

```sql
-- Security audit log
-- Location: .mediobot/cache/audit.db

CREATE TABLE IF NOT EXISTS audit_log (
    audit_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   INTEGER NOT NULL DEFAULT (unixepoch()),
    agent_id    TEXT NOT NULL,
    task_id     TEXT,
    action      TEXT NOT NULL,        -- 'file_read' | 'file_write' | 'command_exec' | 'network_request'
    target      TEXT NOT NULL,        -- File path, command, or URL
    outcome     TEXT NOT NULL,        -- 'allowed' | 'denied' | 'scrubbed'
    details     TEXT                  -- Additional context
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);
```

---

## 7. Cross-Platform Compatibility

### 7.1 macOS-Specific Considerations

| Topic | Handling |
|-------|----------|
| Apple Silicon (ARM64) | Tree-sitter WASM works natively; no special handling |
| FSEvents | Chokidar uses native fsevents module (efficient) |
| Symlinks | Fully supported for node_modules sharing |
| Memory pressure | `os.freemem()` + optional `memory_pressure` CLI check |
| Thread QoS | Set `QOS_CLASS_UTILITY` for background indexing (via worker_threads) |

### 7.2 Windows-Specific Considerations

| Topic | Handling |
|-------|----------|
| File locking (EBUSY) | Retry with exponential backoff (100ms, 200ms, 400ms) |
| Path separators | Use `path.join()` consistently; never hardcode `/` |
| Symlinks require admin | Use directory junctions (`mklink /J`) for node_modules |
| Long paths (> 260 chars) | Enable long paths via Node.js `--experimental-loader` or registry |
| Line endings | Normalize to LF in memory; respect `.gitattributes` on write |
| ReadDirectoryChangesW | Chokidar handles this; no special config needed |

### 7.3 Shared Cross-Platform Rules

- All file paths stored as POSIX-style in SQLite (convert on read/write per platform)
- All timestamps stored as UTC Unix seconds
- All text encoding is UTF-8
- Database files use platform-native byte order (SQLite handles this)

---

## 8. Token and Model Optimization

### 8.1 Context Window Budget

```
Total context budget per agent call:
  System prompt:          ~1,000 tokens (fixed)
  Project Intelligence:   ~1,500 tokens (RepoMap, adaptive)
  Task objective:         ~200 tokens
  Relevant evidence:      ~2,000 tokens (selected by relevance)
  Relevant memories:      ~500 tokens (top-5 memories)
  Conversation history:   ~1,000 tokens (recent turns only)
  Tool results:           ~2,000 tokens (most recent)
  Reserved for response:  ~4,000 tokens
  ──────────────────────────────────────────
  Total:                  ~12,200 tokens per call

  Target: Stay under 16K tokens per agent call to maximize cache hits
  and minimize cost. Expand to 32K only for complex multi-file tasks.
```

### 8.2 Prompt Cache Optimization

To maximize provider-side prompt caching:

1. **Stable prefix**: System prompt + project intelligence must be identical across calls
2. **Sorted context**: Always inject evidence/memories in deterministic order
3. **Incremental history**: Append new turns rather than restructuring entire history
4. **Estimated cache hit rate**: 40-65% (conservative; must measure per provider)

### 8.3 Model Selection Strategy

| Task Type | Recommended Model | Rationale |
|-----------|------------------|-----------|
| Maestro planning | High-capability (Opus/GPT-4o) | Complex reasoning, decomposition |
| Cody implementation | Mid-capability (Sonnet/GPT-4o-mini) | Good coding, reasonable cost |
| Tester verification | Mid-capability | Test generation, result analysis |
| Text workers | Fast/cheap (Flash/Haiku) | Bounded text analysis |
| RepoMap generation | None (deterministic) | Algorithm, not LLM |
| Memory consolidation | Fast/cheap | Summarization only |

---

## 9. Self-Improvement Architecture

### 9.1 Scope

Self-improvement is LIMITED to:
- **Runtime adaptation**: Adjusting concurrency, token budgets, model routing based on measured performance
- **Memory accumulation**: Learning from task outcomes (success patterns, failure patterns)
- **Prompt refinement**: Tracking which prompt variations produce better results (A/B tested)

Self-improvement EXCLUDES:
- Modifying agent definitions or system prompts without human approval
- Changing security policies
- Installing new tools or dependencies
- Modifying orchestration logic

### 9.2 Feedback Metrics

```typescript
// PROPOSED — Agent performance tracking
export interface AgentPerformanceMetrics {
  readonly agentId: string;
  readonly taskCount: number;
  readonly successRate: number;         // Tasks completed successfully / total
  readonly avgStepsPerTask: number;     // Mean tool calls per task
  readonly avgTokensPerTask: number;    // Mean tokens consumed per task
  readonly avgDurationMs: number;       // Mean wall-clock time per task
  readonly regressionRate: number;      // Tasks that caused test regressions / total
  readonly circuitBreakerRate: number;  // Tasks terminated by circuit breaker / total
  readonly verificationPassRate: number; // Tasks that passed DVG first try / total
}
```

### 9.3 Improvement Mechanisms

| Mechanism | Scope | Approval Required |
|-----------|-------|-------------------|
| Adjust concurrency limits | Runtime | No (automatic based on resource monitoring) |
| Adjust token budgets | Runtime | No (within ±20% range) |
| Store successful workflow as procedural memory | Memory | No (automatic) |
| Switch model for specific task type | Runtime | Yes (user confirmation) |
| Modify system prompt | Configuration | Yes (versioned, A/B tested) |
| Add new tool to agent | Configuration | Yes (user approval + security review) |

---

## 10. Acceptance Criteria

| Area | Criterion | Target |
|------|-----------|--------|
| Performance | Cold start | < 3s |
| Performance | Idle RSS | < 150 MB |
| Performance | Peak RSS (4 agents) | < 1.2 GB |
| Security | Secret leakage | 0 incidents |
| Security | Path traversal | 0 incidents |
| Security | Audit log completeness | 100% of agent file/command actions logged |
| Compatibility | macOS ARM64 | All tests pass |
| Compatibility | macOS x64 | All tests pass |
| Compatibility | Windows x64 | All tests pass |
| Self-improvement | No unsanctioned changes | 0 unauthorized modifications |
