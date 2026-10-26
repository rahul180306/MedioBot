# Phase 1 Step 0: Baseline Reliability Report

> **Date:** 2026-10-13  
> **Author:** Gemini 3.8 Flash (Goal Mode — Phase 1)  
> **Status:** All Baseline Defects Resolved; 100% Deterministic Backend Suites Passing  

---

## 1. Executive Summary

Prior to initiating Project Intelligence Engine (PIE) implementation, the Phase 0 audit reported two specific test failures:
1. **9 failing tests** in `packages/maestro/tests/text-workers.test.ts`.
2. **1 failing test** in `apps/command-center/tests/runtime/execution-evidence.test.ts:314` (Regression 4).

Both failures were reproduced deterministically, investigated down to root cause, and resolved with small, safe, evidence-grounded fixes that preserved all public contracts and runtime behavior.

---

## 2. Root Cause Analysis & Resolutions

### Defect 1: Maestro Text-Worker Schema Mismatch in Test Mock

- **Symptom:** In `packages/maestro/tests/text-workers.test.ts`, 9 subtests failed with `AssertionError: Expected 'failed' to equal 'completed'`.
- **Root Cause:** In earlier sessions, Maestro's decision validation was hardened to mandate evidence classification on direct responses (`exact(["type", "message", "basis", "evidenceRefs"])`). The test fixture's mock LLM provider in `text-workers.test.ts` had not been updated and returned the legacy `{ type: "respond", message: "..." }` omitting `basis` and `evidenceRefs`. When the runtime attempted to synthesize text worker reports, Maestro's structural validator rejected the decision with `schema-mismatch: recognizedKeys: ['type', 'message']`, causing the parent task to fail.
- **Resolution:** Updated lines 22 and 111 of `packages/maestro/tests/text-workers.test.ts` to return the canonical contract `{ type: "respond", message: "...", basis: "conversation", evidenceRefs: [] }`.
- **Verification:** All 12 tests in `text-workers.test.ts` now pass (12/12 pass, 0 fail). All 62 tests in `packages/maestro` pass (62/62 pass, 0 fail).

### Defect 2: Missing Evidence Classifier Handler in Regression 4 Test Mock

- **Symptom:** In `apps/command-center/tests/runtime/execution-evidence.test.ts:314` (Regression 4), the test failed with `AssertionError: Direct response turn returns 200, 502 !== 200`.
- **Root Cause:** When a user asks a follow-up question ("Why did you fail?"), Maestro dispatches an internal request to `classifyProjectEvidenceNeed` with system prompt `MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER`. All other turn tests (`cody-turn.test.ts`, `autonomous-turn.test.ts`) handle this classifier prompt by returning `{"requiresCurrentProjectEvidence": false}` for historical conversations. Regression 4's mock provider lacked this handler and returned a general response object. Maestro's JSON parser treated the malformed classifier output as fail-closed (`requiresCurrentProjectEvidence: true`), which strictly required `"coding-tool"` or `"tester-verification"` evidence and rejected the previous turn's execution outcome, causing Maestro to fail with `insufficient-evidence` (HTTP 502).
- **Resolution:** Added `if (system.includes("MEDIOBOT_PROJECT_EVIDENCE_CLASSIFIER")) return JSON.stringify({ requiresCurrentProjectEvidence: false });` to line 330 in `apps/command-center/tests/runtime/execution-evidence.test.ts`.
- **Verification:** All 6 regression tests in `execution-evidence.test.ts` now pass (6/6 pass, 0 fail).

---

## 3. Current Test Status Matrix

| Package / Suite | Tests Run | Pass | Fail | Execution Time |
|---|---|---|---|---|
| `@mediobot-v2/domain` | 34 | 34 | 0 | 82 ms |
| `@mediobot-v2/models` | 36 | 36 | 0 | 103 ms |
| `@mediobot-v2/tools` | 18 | 18 | 0 | 461 ms |
| `@mediobot-v2/runtime` | 33 | 33 | 0 | 100 ms |
| `@mediobot-v2/cody` | 21 | 21 | 0 | 454 ms |
| `@mediobot-v2/tester` | 6 | 6 | 0 | 171 ms |
| `@mediobot-v2/maestro` | 62 | 62 | 0 | 412 ms |
| `command-center` (Persistence) | 37 | 37 | 0 | 727 ms |
| `command-center` (Workspace) | 47 | 47 | 0 | 450 ms |
| `command-center` (Turns) | 13 | 13 | 0 | 497 ms |
| `command-center` (Evidence Regressions) | 6 | 6 | 0 | 451 ms |
| **Monorepo Typecheck** | 10 pkgs | 10 | 0 | 8.59 s |

Baseline is completely stable and 100% verified. Proceeding to Step 1: Project Intelligence Engine implementation.
