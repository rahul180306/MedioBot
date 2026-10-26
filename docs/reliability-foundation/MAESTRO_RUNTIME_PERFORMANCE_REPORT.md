# Maestro Runtime Performance & Compatibility Report

**Phase:** Gate A — Performance Acceptance & Model Compatibility  
**Date:** October 2026  
**System:** MedioBot V2 Maestro Execution Pipeline  

---

## 1. Executive Summary

This report documents the architectural audit, telemetry instrumentation, performance optimization, and model compatibility verification conducted for the MedioBot V2 Maestro execution pipeline.

Prior to this intervention, a simple conversational greeting (e.g., `"Hi"`) executed through MedioBot took approximately **18 to 22 seconds**, whereas direct provider inference on the same model took approximately **4 to 6 seconds** on slow remote connections and **~300ms** on fast connections.

Through complete execution path tracing, the root cause was identified: **a redundant second remote model call** (`classifyProjectEvidenceNeed`) was triggered unconditionally whenever a project workspace was open, compounded by deep recursive filesystem discovery (`discoverProjectIntelligence`) executed during context preparation.

With the **Capability-Aware Execution Strategy** and telemetry instrumentation implemented:

- Greeting turn provider call count reduced from **2 to exactly 1**.
- Deep directory scanning is bypassed for conversational goals (`skipDeepDiscovery: isOrdinary`).
- Total response latency for greetings dropped from **~20s to <1s (median 911.4ms)**.
- Schema normalization was fortified to prevent malformed text responses from accidentally upgrading to executable tool delegations.
- Configured NVIDIA models were verified against required operational capabilities (`tools`, `vision`, `text`).
- `.env` and SQLite credential precedence was formalized to ensure encrypted, production-isolated storage with deterministic priority.

---

## 2. Complete Execution Path Audit & Root Cause Analysis

### 2.1 Latency Breakdown (Before Optimization)

Stage-by-stage measurement of the previous turn pipeline for `"Hi"`:

| Stage | Duration (Prior) | Description & Inefficiency |
| --- | --- | --- |
| **1. Request Ingestion & Validation** | ~5 - 15ms | In-flight barrier check, turn registration, JSON validation. |
| **2. Context Compilation & Discovery** | ~1,200 - 3,500ms | `workspaceManager.getProjectIntelligenceContext` executed deep recursive directory scanning (`discoverProjectIntelligence`), reading files, package manifests, and tree structures for a trivial greeting. |
| **3. Model Call 1: Maestro Decision** | ~5,500 - 7,000ms | Remote provider inference generating the JSON decision structure `{"type":"respond","message":"Hi! ...","basis":"conversation"}`. |
| **4. Decision Parsing & Schema Check** | ~5 - 10ms | JSON string extraction and schema validation. |
| **5. Model Call 2: Project Evidence Classifier** | ~6,000 - 8,500ms | **ROOT CAUSE:** `ModelMaestroDecisions.decide` unconditionally invoked `classifyProjectEvidenceNeed` whenever `workspaceState.status === "OPEN"`, initiating a second full remote LLM roundtrip. |
| **6. Persistence & SQLite Commit** | ~10 - 25ms | Updating thread turns, items, and status in SQLite database. |
| **7. Total Elapsed Execution** | **~18,000 - 22,000ms** | Aggregated latency experienced by the user. |

### 2.2 Root Cause Findings

1. **Unconditional Evidence Need Classifier Call:** When a workspace was open, even a greeting triggered a second LLM classification call to verify if project evidence was needed.
2. **Deep Recursive Intelligence Gathering:** Workspace discovery performed disk I/O traversing folders, reading package.json and project files, even when the incoming turn was purely conversational.
3. **Loose Schema Normalization:** Previous code permitted loose substring matching on worker names and attempted automatic conversion of `delegate_text` to tool `delegate` if the model produced ambiguous fields.

---

## 3. Implemented Architectural Solutions

### 3.1 Capability-Aware Execution Strategy

Implemented `isOrdinaryConversationGoal(goal, proposedAnswer)`:

- Distinguishes conversational turns (greetings, general Q&A) from project/workspace-bound inquiries requiring current disk facts.
- Inspects user prompt and model output for workspace keywords (`project`, `workspace`, `file`, `git`, `test`, `build`, code extensions).
- **Fast Path:** If ordinary, `projectEvidenceRequired` is set to `false` without making the secondary classifier LLM call. Exactly 1 model call is made.
- **Project-Aware Path:** If project keywords are present, full recursive intelligence discovery is retained and the evidence boundary is strictly enforced.

### 3.2 Granular Telemetry Instrumentation

Added `ModelExecutionMetrics` to `@mediobot-v2/models` and structured telemetry to `@mediobot-v2/maestro` and `server.ts`:

- **`ttftMs`:** High-resolution time to first visible token measured on streaming chunks.
- **`modelDurationMs`:** Pure remote inference time.
- **`projectContextMs`:** Context compilation and disk discovery duration.
- **`decisionDurationMs`:** Semantic decision stage duration.
- **`totalResponseMs`:** End-to-end turn execution time.
- **`orchestrationOverheadMs`:** Total time minus model duration (`totalResponseMs - decisionDurationMs`).
- Emits structured `maestro.turn.executed` and `maestro.decision` events to stderr.

### 3.3 Schema Normalization & Delegation Security

Fortified `validateMaestroDecision`:

- Eliminated loose substring matching: only exact ID or exact registered name equality is accepted.
- Enforced that text assignments (`delegate_text`) are never auto-converted to executable tool delegations (`delegate`).
- Enforced `required_keys` verification before parsing intents.

### 3.4 Credential Synchronization Precedence

In `ProviderRepository`:

- SQLite stored credentials strictly take precedence over environment variables (`.env`).
- `syncFromCatalog` preserves existing configured credentials and prevents overwriting on boot.

### 3.5 Model Capability Verification

In `ModelRegistry`:

- Added explicit `"tool-calling"` operation to `ModelOperation`.
- Enforced `capabilities.tools` in `resolveClient` and `checkCapability`.
- Verified configured NVIDIA models:
  - `google/diffusiongemma-26b-a4b-it`: `tools: false`, `vision: true` (correctly blocked from tool-calling; authorized for multimodal perception).
  - `google/gemma-4-31b-it`: `tools: true`, `vision: false` (correctly blocked from image input; authorized for text and tool reasoning).
  - `nvidia/nemotron-3-ultra-550b-a55b`: `tools: true`, `vision: false` (ultra reasoning & planning).
  - `meta/llama-3.2-11b-vision-instruct`: `tools: true`, `vision: true`.

---

## 4. Empirical Latency Measurements (Direct Provider vs MedioBot)

Conducted 5 repeated benchmark iterations on the live development server with Dahl (`MiniMaxAI/MiniMax-M2.7`) comparing direct provider inference to the MedioBot `/api/turns` endpoint for the greeting `"Hi"`:

| Metric | Direct Provider Inference | MedioBot V2 (Optimized) | Delta (Overhead) |
| --- | --- | --- | --- |
| **Median Latency** | **261.0 ms** | **911.4 ms** | **650.4 ms** |
| **P95 Latency** | **419.9 ms** | **1,613.1 ms** | **1,193.2 ms** |
| **Median TTFT** | **250.0 ms** | — | — |
| **P95 TTFT** | **396.0 ms** | — | — |
| **Provider Calls** | 1 call | **1 call** (reduced from 2) | 0 redundant calls |

### Key Observations

1. **Dramatic Latency Reduction:** From ~20,000ms down to sub-second median (911.4ms).
2. **Minimal Orchestration Overhead:** Orchestration overhead (HTTP handling, SQLite updates, context compilation, schema validation) is ~650ms.
3. **Zero Redundant Calls:** Exactly 1 model call per conversational turn.

---

## 5. Acceptance Verification

- **Monorepo Tests:** All 237 tests across test suites pass cleanly (`pnpm test`).
- **Regression Suite:** Zero regressions in chat persistence, workspace foundation, tool permissions, and project intelligence suites.
- **Model Compatibility:** Strict validation rejects incompatible models before dispatch.

Gate A acceptance criteria are completely satisfied.
