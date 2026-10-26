# True parallelism — implementation guide

Source audit: 2026-10-26, current dirty worktree. Source inspection only; no tests or live requests executed for this guide. Paths are repository-relative. Preserve existing UI and LangGraph authority.

## Current state

| Status | Source and behavior |
| --- | --- |
| Working in source | `packages/maestro/src/index.ts`, `MaestroExecutionAdapter`: `maestro-specialist-groups` sends each assignment separately to `executionEngine.runParallel`, with `dependsOn` edges. Mixed Cody/web/text/Tester assignments are not one sequential batch. |
| Working in source | `packages/maestro/src/langgraph-engine.ts`, `LangGraphExecutionEngine.runParallel`: dispatch returns multiple LangGraph `Send` operations for ready assignments; SQLite checkpoints and outcome records preserve completed work. |
| Working in source | `packages/runtime/src/index.ts`, `WorkerRuntime.run`: task admission, cancellation, and resource release. `resource-governor.ts`, `ResourceGovernor.requestTaskAdmission` bounds admitted work. Composition defaults: 8 tasks globally, 6 per workspace, 2 browser sessions. |
| Working in source | `apps/command-center/src/events.ts`, `worldProductEvent`; `server.ts` turn SSE; `state/specialistTaskHistory.ts`; `features/empty/specialistTaskActivity.ts`: attributed activity projection and bounded specialist history already exist. |
| Partial / restrictive policy | `packages/models/src/scheduler.ts`, `ProviderRequestScheduler.getConcurrencyLimit`: defaults to 4, but NVIDIA type/identity is hardcoded to 1 unless explicitly overridden. Workers can overlap while inference requests queue. The comment asserting a universal NVIDIA free-tier limit is not account-specific evidence. |
| Unverified here | Actual model-selected independence, live request overlap, UI timing, Windows execution, and resource usage under load. Existing test source contains overlap assertions; that is not a fresh test result. |

Do not diagnose broken scheduling from sequential model responses or UI row order. Sequential actions inside one specialist, dependency waits, Governor admission, and provider queuing are separate causes.

## Minimal implementation

1. Keep the current assignment-level graph. Audit the production `/api/turns` → composition → `MaestroExecutionAdapter` route before touching the separate `packages/maestro/src/orchestrator.ts` API. Never activate both controllers for one parent task.
2. Capture assignment/dependency IDs and timestamps at ready, admission, worker start/end, provider queue/admit/release, and tool start/end. Reuse durable product events; include parent task, child execution task, specialist and invocation identity. Persist bounded metadata, never hidden reasoning or credentials.
3. Inspect `dependsOn` generation: add dependencies only for actual required evidence/artifacts. Do not replace the graph with `Promise.all` or a new scheduler. Retain failure isolation and explicit blocked dependencies.
4. Replace the provider-name concurrency heuristic only with explicit, validated per-connection policy using the existing scheduler options. Preserve conservative limits until provider/account capacity is known. Coordinate provider admission with existing Governor budgets; do not add another queue or reserve capacity twice.
5. Reuse current SSE/replay and timeline components to show real running, queued, waiting and terminal activity. Do not generate narration to imply parallelism.

## Dependencies and safety

Keep LangGraph/SQLite, WorkerRuntime, Governor, provider scheduler, approvals and permission checks. Shared-file edits still require existing file locks/content-hash preconditions. Cancellation must settle child workers and release leases; marking the parent terminal is insufficient. Use monotonic durations plus persisted wall-clock timestamps. Avoid polling, extra processes and CPU-bound work on the UI thread. Validate macOS and Windows separately.

## Acceptance

- Extend `packages/maestro/tests/langgraph-engine.test.ts` and `langgraph-execution.test.ts`; retain `capability-routing.test.ts`.
- Through controlled `/api/turns`, run two independent real local reads plus one dependent assignment. Assert `max(startA,startB) < min(endA,endB)` and dependent start follows required completion. Use bounded barriers rather than fragile sleep timing.
- With provider capacity 1, assert worker overlap and inference serialization are reported separately; with authorized capacity 2, assert request overlap. No live provider needed.
- Cancel one task family, retain unrelated work, release all leases; restart from an isolated database and do not replay completed side effects.
- Existing UI must show both active specialists, correctly attributed tools, ordered replay without duplicates and truthful final evidence. Measure RSS/CPU with the same workload before/after; record actual values, no acceptance claim from row order alone.
