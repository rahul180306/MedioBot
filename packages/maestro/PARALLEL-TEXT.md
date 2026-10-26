# Text-only parallel Mediobot execution

**Controlled backend real-model parallel execution is PROVEN on the user's normal Mac using NVIDIA DiffusionGemma text.** The user supplied a passing staged run: one Cody report; two-worker common overlap **1050.310791015625 ms**; three-worker common overlap **1155.5458984375 ms**; one real Maestro synthesis. Six worker calls across those stages plus one synthesis call completed. This proof used explicit harness assignments, not autonomous Maestro decomposition. No heterogeneous-model or speedup claim follows.

Current milestone: **AUTONOMOUS DECOMPOSITION NOT PROVEN** through the unchanged product UI. Read [AUTONOMOUS-TURN.md](AUTONOMOUS-TURN.md). The full normal turn handler is deterministically tested; the current sandbox natural-goal attempt failed at the semantic model call with `transport`. The historical sandbox blocker does not invalidate the normal-Mac proof. Human UI/answer-quality acceptance remains pending.

## Why the previous path was limited

`MaestroExecutionAdapter` previously exposed only Cody's definition ID, validated a single delegation, directly constructed a Cody execution adapter, awaited one child, and composed a fixed completion message. WorkerRuntime already supported concurrent workers; it was not the missing part.

The new semantic `delegate_text` contract supports one to three assignments and a bounded independence explanation. Maestro chooses whether delegation helps. No acceptance-task keywords or model names occur in production routing. The existing `delegate` coding-tool path remains intact for workspace actions. Research/Tester single delegations also use the shared text path.

## Actual execution path

User → registry-selected Maestro model → validated decision. A direct response/clarification creates zero Goals, Assignments, Tasks, or Workers. A text delegation creates one Goal and bounded Assignments → one Task and Worker per Assignment → existing WorkerRuntime admission and concurrent runs → independently resolved text-model clients → bounded WorkerReports → Maestro's selected model synthesizes or asks the user.

The production package entry point exposes `LangGraphExecutionEngine` and does not expose the older `MaestroOrchestrator` scheduler. That implementation remains available only through the explicit `@mediobot-v2/maestro/legacy-orchestrator` rollback subpath; the production Command Center has no import or construction path for it. Both code paths use LangGraph, but only the production adapter controls product execution.

`TextMediobotExecution` is shared by Cody, Research, and Tester. Role instructions distinguish implementation reasoning, evidence-conscious supplied-context analysis, and critical review. Workers have no tools in this operation. Research has no web/search provider, Tester runs no tests, and no artifacts are fabricated. The old Cody coding-tool adapter remains a separate operation, not a hard-coded model dependency.

Definitions are registered once per composition and reused by subsequent workers; IDs follow the existing World-scoped identity convention. They are not durable cross-restart IDs.

## Assignment and report contracts

The existing domain Assignment contains `id`, `worldId`, `goalId`, `targetDefinitionId`, `objective`, `relevantContextRefs`, `constraints`, `expectedOutcome`, `evidenceExpectations`, and `createdAt`. Optional `relevantContext` now carries the bounded supplied facts selected by Maestro. Worker input contains this assignment, not the parent Goal or sibling conversations. Context references are labels, not implicit filesystem/web access.

Canonical exported WorkerReport:

- `assignmentId`, `taskId`, `workerId`, `mediobotId`.
- `providerId`, `modelId`, `startedAt`, `completedAt` when applicable. Timestamps are high-resolution epoch milliseconds around model invocation/report validation; pre-inference admission or resolution failure has no invocation interval.
- `status`: completed, failed, cancelled, model-unavailable, or blocked.
- `summary`, `evidence`, `artifacts`, `blockers`, `unresolved`.

Model output accepts only bounded conclusion/evidence/blocker/unresolved fields and completed/blocked status. Runtime owns identities, timings, failures, and cancellation. Unknown fields (including reasoning) reject the report. Text is sanitized. Artifacts are empty because no artifact-producing tools execute. Reports are serialized as `worker-report` evidence with observed `execution-summary` validity; reported claims are never independently verified evidence. Worker completion does not satisfy the Goal.

## Model selection

`TextModelResolver.resolveForOperation("text-inference", selection)` is the worker boundary. Product composition supplies its existing ModelResolver/ProviderRepository. Workers require text capability, not a particular model, provider, or image/tool capability.

Manual options:

```ts
{
  modelSelection: { providerConnectionId: "connected-provider", modelId: "model-id" },
  assignmentModelSelections: {
    [assignmentIdOrDefinitionId]: { providerConnectionId: "another-provider", modelId: "another-model" }
  }
}
```

Assignment ID overrides take precedence over definition ID overrides; otherwise the turn's manual pair is inherited. Invalid explicit selections fail, without selecting another provider. Display names do not identify models. Models are never selected by the model-generated assignment. The boundary can accept a future Auto router, but Auto scoring, health scheduling, and learning are NOT IMPLEMENTED.

Per-assignment selection is a backend composition option. The frozen UI has no new per-worker model controls, and the normal conversation HTTP request does not expose this override map yet. The opt-in acceptance uses normal application composition and registry directly.

## Concurrency, supervision, and synthesis

Children start via `WorkerRuntime.run`; Promise aggregation only collects these real runtime executions. There is no second admission scheduler or delay-based concurrency. The default runtime capacity is four, including the parent; the plan is capped at three children. Existing fail-fast admission is retained. Capacity contention produces attributed blocked reports, not queued or simulated work.

Failure or cancellation of one child leaves siblings running. Parent cancellation reaches all active children, cancels the Goal, and prevents synthesis. Cancellation retains the runtime's existing cooperative cleanup behavior.

Actual child events feed existing `projectSupervision`; a bounded 64-notice collection of failures, cancellation, completion, and assignment blockage accompanies reports to Maestro after settlement. Existing runtime supervision observers continue to receive actual events. This is integrated settlement-time attention, not a live autonomous recovery controller.

Maestro receives the Goal Anchor, constraints, bounded reports, and notices, then makes a real model call. It may respond or request input; the latter transitions the Goal to waiting-user. There is no automatic extra worker round. Repair, reassignment, verification scheduling, and autonomous retry are NOT IMPLEMENTED. Goal satisfaction remains conservative: this path does not compile an independent analytical-answer acceptance policy.

## Historical validation before the user-provided real execution proof

| Check | Result |
| --- | --- |
| Domain / models / runtime / tools / Cody | 34 / 32 / 33 / 18 / 11 passed |
| Maestro, including new text tests | 43 passed |
| Application composition and parallel registry path | 4 passed |
| Pure existing registry checks | 3 passed |
| Total focused deterministic checks | 178 passed |
| Workspace typecheck | Passed |
| Production build | Passed; existing large-chunk warning |
| git diff --check | Passed |
| Full HTTP registry suite | Incomplete: sandbox denied local HTTP listen |
| Live configured acceptance | 0 passed, 1 skipped: transport unavailable at greeting |

The new tests cover single/multiple assignments, exact provider/model attribution (including duplicate display names), one model serving multiple Mediobots, DiffusionGemma's text capability, incompatible-model isolation, independent cancellation/failure, parent cancellation, admission blocking, report schema/privacy boundaries, direct conversation with zero execution identities, synthesis consumption, and no browser resources or Vision workers.

The final deterministic overlap measurement was **3 simultaneous workers, 0.121826171875 ms common interval** using barrier-controlled fake model adapters. No sleep was inserted. This only proves deterministic orchestration and timing attribution; it is not a model latency measurement or speedup claim.

Live acceptance uses read-only application SQLite configuration and the normal registry. The connected primary `dahl` / `MiniMaxAI/MiniMax-M2.7` failed at the initial greeting with category `transport`. No worker inference, DiffusionGemma call, live synthesis, or heterogeneous overlap was established. An initial attempt failed with insufficient diagnostic classification; after adding safe stage/category diagnostics, the final attempt skipped truthfully on provider unavailability. No further live attempts were made.

The HTTP tests' escalation could not execute because automatic approval review returned a service 404. This was a review-system failure, not a determination that the command was unsafe. Eleven HTTP registry cases remain unvalidated in this session; their failures were local listen errors. The separate composition regression found during development was fixed and its tests passed.

## Current manual acceptance and next milestone

Do not repeat the explicit-assignment proof. Start the normal product with `pnpm dev`, select Maestro and the connected NVIDIA DiffusionGemma model, and submit only the natural-language goal in [AUTONOMOUS-TURN.md](AUTONOMOUS-TURN.md). No assignments, worker count, or fixed specialist roster should be injected. Assess the actual semantic decision, real activity, and final recommendation separately.

The staged controlled harness is still available at `apps/command-center/tests/runtime/parallel-configured-acceptance.test.ts`; it requires an explicit `MEDIOBOT_PARALLEL_PROVIDER` and `MEDIOBOT_PARALLEL_MODEL` and supplies its own assignments. It must not be described as autonomous decomposition acceptance.

## Scope and safety

Authored implementation changes: `packages/maestro/src/index.ts`, `context.ts`, new `text-workers.ts`; optional context field in `packages/domain/src/index.ts`; backend wiring in `apps/command-center/src/composition.ts`. Added focused text-worker, registry-composition, and opt-in live acceptance tests; updated continuation and this report.

No browser/Chromium, Playwright tests, screenshots, OCR, or computer use were launched. Vision source was unchanged. No UI component/layout changes, secrets exposure, `.env` inspection, destructive Git operations, or commits. All unrelated dirty/untracked work was preserved.

## git status --short at handoff

The broad dirty/untracked status predates this milestone; the output is not a list of only this session's edits.

```text
 M .gitignore
 M package.json
 M packages/cody/package.json
 D packages/cody/src/index.test.ts
 M packages/cody/src/index.ts
 M packages/domain/package.json
 D packages/domain/src/index.test.ts
 M packages/domain/src/index.ts
 M packages/runtime/package.json
 D packages/runtime/src/index.test.ts
 M packages/runtime/src/index.ts
 M packages/tools/package.json
 D packages/tools/src/index.test.ts
 M packages/tools/src/index.ts
 M pnpm-lock.yaml
 M pnpm-workspace.yaml
?? .env.example
?? CONTINUATION.md
?? apps/
?? mediobots/
?? packages/cody/src/agent.ts
?? packages/cody/tests/
?? packages/domain/COMPLETION-POLICY.md
?? packages/domain/tests/
?? packages/maestro/
?? packages/models/
?? packages/runtime/src/supervision.ts
?? packages/runtime/tests/
?? packages/tools/tests/
?? packages/vision/
```
