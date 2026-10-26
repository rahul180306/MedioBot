# LIVE_EXECUTION_UX_DESIGN.md — Professional Live Execution Experience

**Document Status:** Approved Design Specification  
**Date:** October 2026  
**Target:** MedioBot V2 Command Center (Desktop) & Terminal CLI  
**Scope:** Live Execution Presentation, Visual Hierarchy, Diffs, Approvals, Evidence Badges, and Frontend Contracts  

---

## 1. Executive Summary

A professional coding agent interface must balance **truthfulness**, **clarity**, and **unobtrusiveness**. Naive interfaces suffer from two extremes: either flooding the user with thousands of lines of raw terminal logs and hidden model thoughts, or over-simplifying into a vague spinner that hides what the agent is actually touching.

This specification details the live execution UX for MedioBot across both the desktop Command Center and terminal CLI. It draws upon proven, publicly observable patterns from OpenAI Codex and Anthropic Claude Code while strictly preserving MedioBot's signature visual identity:
- Distinct specialist personas (Maestro, Cody, Tester).
- Stable, monotonic tool cards with frozen durations.
- Syntax-highlighted unified diffs.
- Explicit visual distinction between **empirical verification evidence** and **model-generated claims**.
- Zero exposure of private model reasoning or raw secrets.

---

## 2. Comparative Analysis of State-of-the-Art Execution UX

| Execution Element | OpenAI Codex Pattern | Claude Code Pattern | MedioBot V2 Native Architecture |
|---|---|---|---|
| **Work Progress** | Clean single-line progress indicator with high-level stage label | Spinner with elapsed timer (`Thinking (4.1s)...`) & collapsible step log | Distinct bot avatar + monotonic elapsed timer computed from backend `startedAt` |
| **Tool Invocations** | Compact tool rows with status badges and duration | Inline tool pill with arguments and collapsed output | Dedicated tool card with tool icon, target path/cmd, exit badge, duration |
| **File Reads** | Collapsed reference to file name and line count | Concise `Read file.ts (lines 1-80)` indicator | Windowed preview showing exact line numbers; collapsed by default |
| **File Edits & Diffs** | Unified diff block with line removals and additions | Patch preview with syntax highlighting and hunk headers | Full Monaco/CodeMirror syntax-highlighted diff with line additions/deletions |
| **Command Execution** | Exit code badge + scrollable command output box | Command string + exit status + truncated stdout/stderr | Command line with duration, exit code pill, and bounded stdout/stderr viewer |
| **Error Handling** | Categorized error cards with recovery guidance | Plaintext explanation of error without trace dump | Safe categorized error badge (`command-failed`, `test-failure`) + sanitized hint |
| **Human Approvals** | Interactive modal for destructive actions | Terminal prompt `[y/N/always]` before tool execution | Structured approval card in chat & CLI prompt with action scope |
| **Verification Evidence** | Implicit test execution confirmation | "Ran tests: 12 passed" log line | Explicit **[✓ Verified Proof]** badge versus **[Observed Claim]** tag |
| **Task Completion** | Completion banner with summary and git commit status | Final bulleted summary with modified file list | Authoritative completion banner: files touched, tests passed, goal state |

---

## 3. The 9 Core Execution Components in MedioBot V2

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. WORK PROGRESS & BOT IDENTITY                                              │
│ [🤖 Cody] Software Engineering Specialist                       ⏱ 4.2s (running)│
│ "Investigating regression in calculateTax() function..."                    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. TOOL CALL & 3. FILE READ                                                 │
│  ✓ filesystem.read  src/tax/calculator.ts:1-65                       24ms   │
│    └─ [▶ 65 lines inspected]                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. FILE EDIT & UNIFIED DIFF                                                 │
│  ✓ filesystem.edit  src/tax/calculator.ts:42-48                      18ms   │
│    ┌────────────────────────────────────────────────────────────────────┐   │
│    │ @@ -42,4 +42,5 @@                                                  │   │
│    │ -  const taxRate = 0.05;                                           │   │
│    │ +  const taxRate = getEffectiveRate(customer.state);               │   │
│    │ +  if (taxRate < 0) throw new Error("Invalid rate");               │   │
│    └────────────────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. COMMAND EXECUTION & 6. ERROR DISPLAY                                     │
│  ✗ terminal.execute  npm test -- tests/tax.test.ts          exit 1   340ms  │
│    └─ [Error: Rate calculation expected 0.08, received 0.05]                │
├─────────────────────────────────────────────────────────────────────────────┤
│ 7. APPROVAL PROMPT (When Required)                                          │
│  ⚠️ Permission Required: Run command outside sandbox                         │
│     Command: rm -rf dist/ && npm run build                                  │
│     [ Approve Once ]   [ Always Allow for Thread ]   [ Reject ]             │
├─────────────────────────────────────────────────────────────────────────────┤
│ 8. VERIFICATION EVIDENCE                                                    │
│  ✓ terminal.execute  npm test -- tests/tax.test.ts          exit 0   410ms  │
│    Badge: [✓ VERIFIED COMMAND PROOF] (Exit code 0, 14 passed)               │
├─────────────────────────────────────────────────────────────────────────────┤
│ 9. AUTHORITATIVE COMPLETION BANNER                                          │
│  🎉 Task Completed — Goal Satisfied                                  6.8s   │
│  - 1 file modified (src/tax/calculator.ts)                                  │
│  - 1 verification suite passed (tests/tax.test.ts)                          │
│  - Verified by independent test run (Exit 0)                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Work Progress & Persona Identity
- **Visuals:** Renders the bot's distinct avatar and color scheme:
  - **Maestro:** `#8B5CF6` (Purple), animated eye-blink avatar.
  - **Cody:** `#3B82F6` (Blue), technical specialist avatar.
  - **Tester:** `#10B981` (Emerald), shield verification avatar.
- **Timing:** Displays an active timer computed live as `(Date.now() - tool.startedAt)`. When the tool finishes, the timer freezes permanently to `(tool.durationMs / 1000).toFixed(1) + "s"`.
- **Reasoning Masking:** Internal `<think>` reasoning is stripped. The UI only displays the sanitized `activityState` or `text` field.

### 3.2 Tool Invocations
- Every tool execution renders in a dedicated card keyed by `toolInvocationId`.
- **States:**
  - `running`: Shimmering border, spinning indicator, active duration timer.
  - `success`: Crisp green border, checkmark icon, frozen duration, exit badge.
  - `failed`: Red accent, alert triangle, sanitized error pill (`"Tool operation failed"`).
  - `cancelled`: Muted gray border, ban icon, `"Task cancelled"`.

### 3.3 File Reads & Windowed Previews
- Instead of printing thousands of characters, file reads display a compact summary row: `Read src/index.ts (lines 1-120)`.
- Clicking expands a syntax-highlighted, read-only code block with line numbering.

### 3.4 File Edits & Diffs
- Mutations emit `diff.created` events with structured unified diff data.
- The UI renders line additions in emerald green (`+`) and deletions in crimson red (`-`).
- In the desktop Command Center, clicking the diff row opens the file in the CodeMirror editor at the modified line.

### 3.5 Command Results & Stream Truncation
- Displays the exact command executed, working directory, duration, and exit code.
- If output exceeds 1 MB, the card shows a clear truncation badge: `[Output truncated: showing last 100 lines of 1,240]`.

### 3.6 Error Categorization & Diagnosis
- Tool errors are classified into safe diagnostic badges:
  - `syntax-error`
  - `build-failure`
  - `test-failure`
  - `permission-denied`
  - `timeout`
- The system never outputs raw stack traces or internal prompt instructions.

### 3.7 Interactive Approvals
- For destructive or mutating actions, the execution engine halts and emits `approval.required`.
- The user is presented with three explicit choices:
  1. `Approve Once`
  2. `Always Allow for this Workspace`
  3. `Reject Action`

### 3.8 Verification Evidence Badges
- MedioBot clearly differentiates model statements from empirical proof:
  - **Model Claim:** `[Observed Summary]` (Yellow pill) — Indicates Cody claims the code is fixed.
  - **Command Proof:** `[✓ Verified Evidence]` (Green pill) — Indicates an independent test command exited with code 0.
  - **Tautological Warning:** `[Unverified Check]` (Orange pill) — Indicates a test ran without assertions.

### 3.9 Authoritative Task Completion
- When Maestro transitions a Goal to `satisfied`, the turn card transitions to a settled state.
- Summarizes total elapsed time, files touched, diff statistics (`+12 / -4`), and evidence citations.
- Spinner is removed immediately; `activeTurnIdentity` is set to null.

---

## 4. Frontend Event-Presentation Contracts

The frontend state engine expects the following typed contracts across SSE and SQLite snapshots:

```typescript
export interface ToolPresentationItem {
  id: string;                         // Stable toolInvocationId
  turnId: string;
  type: "tool_execution";
  actor: {
    type: "agent";
    name: "Maestro" | "Cody" | "Tester";
    definitionId: string;
  };
  timestamp: number;
  tool: {
    toolName: string;
    toolInvocationId: string;
    status: "running" | "success" | "failed" | "cancelled";
    startedAt: number;
    durationMs?: number;
    exitCode?: number | null;
    stdoutBytes?: number;
    stderrBytes?: number;
    error?: string;
    failureCategory?: string;
    isVerification?: boolean;
    verificationStatus?: "command-succeeded" | "command-failed" | "unverified";
    outcomeBadge?: string;
    eventSequence?: number;
  };
}

export interface DiffPresentationItem {
  id: string;
  turnId: string;
  type: "diff";
  actor: {
    type: "agent";
    name: "Cody";
    definitionId: string;
  };
  timestamp: number;
  diff: {
    filePath: string;
    originalContent?: string;
    newContent?: string;
    patch: string;                    // Standard unified diff format
    additions: number;
    deletions: number;
  };
}
```

---

## 5. Architectural Recommendations & Justifications

### 5.1 Recommendation: Dynamic Timer Derivation from Backend `startedAt`
- **Problem it Solves:** Eliminates drift, flickering, and reset-to-zero bugs when the user switches tabs, remounts React components, or reconnects over SSE.
- **Source Supporting It:** W3C Performance Timing API & React Immutable State Lifecycle.
- **Why it Fits MedioBot:** Backend provides authoritative epoch-millisecond `startedAt`; UI simply calculates `(now - startedAt)` without storing mutable tick state.
- **Alternatives Rejected:** Running local `setInterval` counters inside each component (causes desynchronization across component remounts).
- **What Must Be Tested:** Durations render identically before and after browser reloads.

### 5.2 Recommendation: Visual Segregation of Verification Badges
- **Problem it Solves:** Prevents users from being misled by LLMs claiming "I tested the code and it works perfectly" when no test was executed.
- **Source Supporting It:** SWE-bench evaluation methodology (Jimenez et al., 2024).
- **Why it Fits MedioBot:** Grounded in `COMPLETION-POLICY.md` where model summaries can never satisfy Goal criteria.
- **Alternatives Rejected:** Showing a single green checkmark for any completed turn regardless of evidence type.
- **What Must Be Tested:** A turn ending with only Cody's summary displays `[Observed Summary]`, whereas a turn with test exit 0 displays `[✓ Verified Evidence]`.
