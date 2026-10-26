# Next phase: evidence-verified autonomous project change

Reviewed 2026-10-28 against the current dirty worktree. Architecture/planning only: no application edits, provider calls, or acceptance reruns. Existing audit reports describe earlier snapshots; do not reopen defects already corrected in current source.

## 1. Readiness and evidence baseline

**Readiness: controlled execution infrastructure is demonstrated; autonomous delivery is unproven.** `FOCUSED_ACCEPTANCE_REPORT_2026-10-28.md` reports two 5/5 runs. `evidence/focused_acceptance_evidence.json` contains one saved aggregate, not two independently replayable logs. The following conclusions come from inspecting those artifacts and `apps/command-center/tests/e2e/focused_acceptance_test.ts`, not independently rerunning them.

| Evidence | What it supports / limit |
| --- | --- |
| Recorded 1,199 ms execution-envelope and 1,232 ms admission overlap | LangGraph workers overlap with delayed fixture inference and observed tool events. `defaultMaestroDecide` explicitly selects Cody/Doc/Scraapy; model responses wait 1,200 ms. This proves controlled asynchronous overlap, not autonomous team selection or CPU-parallel computation. The min/max envelope can include gaps between operations; retain individual operation intervals for stronger measurement. |
| Real `/api/turns`, SQLite, SSE and browser | Product execution/event plumbing is exercised. Default specialist responses are scripted reports; Cody returns `finish`, without implementing or testing a change. Scraapy may exercise the configured real search path, but event presence alone does not establish relevant retrieved evidence. |
| Specialist panel screenshots | Test asserts panel visibility and parent incompletion. The report's quoted `data-activity-state="working"` assertions are absent from this test source. Artifact booleans are set after visibility checks, not evidence of specific action/tool/result rendering. |
| Targeted Scraapy cancellation | Test checks cancellation status and sibling completion. Its synthesis predicate accepts `task.completed` alone and does not inspect final response content; it does not prove that synthesis accurately reconciles cancellation. |
| Resource sample: 526,712,832 bytes | `packages/runtime/src/resource-telemetry.ts` uses `process.memoryUsage().rss`: backend process RSS, not application process-tree RSS. The test sets `labelledCorrectly` from numeric presence and compares RSS with physical RAM; it does not assert the visible labels or measure CPU/process-tree peak. Report terminology must be corrected. |

No new model ranking, scheduler replacement, generic fixture expansion, or “fully autonomous” claim follows from this baseline.

## 2. Actual capability inventory

Paths below are repository-relative.

| Area | Present in source | Partial / missing |
| --- | --- | --- |
| Maestro | `packages/maestro/src/index.ts`: `MaestroDecisionProvider`, strict action validation, capability-aware `MaestroExecutionAdapter`, dependencies, bounded assistance, synthesis and truthful report fallback. `langgraph-engine.ts`: ready-task fan-out/checkpoints. | Semantic decomposition and useful live-model choices unverified. Mixed-assignment completion is not a uniform independent-verification/repair loop. `DynamicSpecialistSelector` is imported/exported but no selection call is wired in `index.ts`; its heuristics are not evidence of model planning. |
| Cody | `packages/cody/src/agent.ts`: list/search/windowed read/write/edit/run, bounded model/action recovery, assistance, finish. `packages/intelligence/src/engine.ts`/`retrieval.ts`: repository context. | Useful code navigation, correct edits and debugging with actual configured models remain unproven here. A model's `finish` and a successful command do not prove all requested outcomes. |
| Doc | `mediobots/doc/MEDIOBOT.md`; `web-workers.ts` and `text-workers.ts`: authoritative-source retrieval or supplied-context reports, peer/group findings. | No demonstrated general document editor/exporter or workspace-document authoring loop. For this milestone Doc produces a source-grounded draft; Cody applies authorized workspace edits. Do not impersonate file access. |
| Scraapy / Research | Existing role-specific search/crawl/report adapters, relevance filtering, shared Crawl4AI runtime and collaboration. | Relevance, citations and reliable discovery are not proven by the focused event chain. Scraapy is oriented to component/design extraction; do not force it into unrelated CLI tasks. |
| Tester | `packages/tester/src/agent.ts`: independent read-only list/read/run/finish; records assertions and observed command evidence. | Must be bound to the final artifact revision, goal criteria and its own durable model snapshot in every verification path. No file-writing capability: Cody authors tests; Tester runs and evaluates them. |
| Vision | `packages/vision/src/index.ts` contains browser observation/action/effect contracts and execution; composition registers Vision. A default outcome verifier returns `unknown`. | Registration is not assignability or reliable goal verification. No acceptance of general desktop computer-use follows. Preserve this implementation; do not extend it in this milestone. |
| Dessy / Weby | No dedicated definitions/executors found in current `mediobots/`, Maestro source or application source searches. | Missing executable specialist capabilities. Do not advertise them as available or implement them as part of this coding milestone. |
| Persistence / UI | Existing specialist sessions, direct/group communication, durable tasks/product events, replay, per-bot work/history and task controls. | Correct action details, independent verification, recovery and final claims must stay synchronized in actual user workflows. No new conversation store or UI design is needed. |

Recent corrections are visible: composition preserves embedded effort; mixed and single Cody paths resolve child decisions; delegated Tester passes child options; Crawl4AI has an address-pinning backend, per-crawl browser routing and conditional cancellation settlement. These are source observations, **not fresh end-to-end security/recovery acceptance**. Preserve them and target only proven residual gaps.

## 3. Top five gaps, ranked

1. **Outcome enforcement:** one verified criterion ledger across mixed delegation, Tester, bounded Cody repair and synthesis; completion cannot depend on report wording.
2. **Useful task decomposition:** outcome-oriented assignments with necessary tool capabilities, minimal dependencies, exact scope and justified team size; no fixed three-bot selection.
3. **Specialists exchanging actionable evidence:** a retrieved source or observed code result must reach the consumer before its next decision and affect observable work, not just generate message events.
4. **Safe supervised recovery:** explicit response to failed checks, missing prerequisites, permissions and ambiguous side effects; preserve completed siblings and resume the correct revision/model without replay.
5. **Trustworthy live feedback and efficiency:** show actual action/status/evidence and requested/effective model policy; measure actual owned memory/processes and responsive operation, not fixture delays or numeric-presence flags.

## 4. One milestone and reference task

**Milestone:** through existing Main Chat, Maestro completes a bounded project feature with concurrent Cody and Doc work, an authorized finding consumed during execution, independent Tester verification, at most one repair and evidence-grounded final synthesis.

**Reproducible project:** a disposable, dependency-free Node.js 22+ notes CLI. Seed a functioning `add`/`list` implementation, a JSON data file, README, `package.json`, and baseline `node:test` tests. Record baseline hashes and tests before the user turn. Add the fixture only during implementation; this plan creates no project code.

**User request:** “Inspect this notes CLI. Add `list --tag <tag>` with case-insensitive exact tag matching. Unfiltered list behavior must stay unchanged; missing tag values must fail clearly. Listing must never modify stored notes. Update usage documentation and add regression tests. Use Doc for authoritative argument-parsing guidance, have Tester independently verify the result, and report files, checks and remaining limitations.”

Cody inspects/implements; Doc independently retrieves the official `util.parseArgs` documentation appropriate to the runtime version and publishes a bounded relevant finding. Cody consumes it or explicitly explains irrelevance. Tester depends on the candidate artifact set. Models choose assignments/actions from current contracts: never detect this prompt or hardcode the plan, source URL, patch, success answer or repair.

Positive acceptance requires actual file edits, exact output assertions, unchanged note-data hash and original tests passing. A separate deliberately broken candidate is a labeled negative control for the verification gate; do not force the real model to make a mistake to satisfy a repair demonstration.

## 5. Target data flow and contracts

`Main Chat → /api/turns → captured workspace/configuration → Maestro validated assignments → LangGraph ready branches → WorkerRuntime/Governor → authorized tools → durable artifacts/evidence/messages → dependent Tester → optional bounded Cody repair → reverify → Maestro synthesis → existing SSE/UI`.

Reuse `packages/contracts/src/index.ts` (`OrchestrationTaskSpec`, `OrchestrationPlanSpec`, `VerificationCheck`), `text-workers.ts` (`TextAssignmentDraft`, `WorkerReport`), domain goal criteria, `completion.ts` (`TrustedCompletion`) and durable engine APIs. Inspect equivalent fields before extending anything. Do not build a second planning/verification registry.

- **Assignment:** stable assignment/child task identity, specialist, objective, scope, required capabilities, expected outcome, criterion IDs, authorized context references, dependencies and limits. Validate capability coverage and acyclic dependencies before admission.
- **Execution configuration:** exact provider connection/model/requested effort captured at task creation; persist once and reuse across repair/approval/restart. Effective/unsupported effort comes from the protocol/client, not UI labels. No fallback model.
- **Evidence:** existing durable ID, producer/task/invocation, source kind, timestamp, workspace-relative artifact/hash or final source URL/content hash, observed result and validity. Model claims and peer reports remain attributed claims until independently supported.
- **Verification:** each criterion maps to observed check IDs against candidate artifact hashes. Tester report is structured input; host logic binds it to real command/read evidence. `exit 0` is necessary for a successful check, insufficient for all criteria. Read-only analysis requires observations, not a fabricated terminal check.
- **Supervision:** extend existing bounded support/graph expansion only where needed. After independent check failure, send exact failed criteria, bounded redacted diagnostics and revision references to Cody; one repair then reverify. Dependency failures block affected branches while unrelated work continues. Contradictory reports become unresolved criteria, not an invented consensus.
- **Settlement:** distinguish worker completion, verified goal satisfaction, partial/blocked outcome and cancellation cleanup. Never convert missing evidence into success because synthesis sounds plausible.

## 6. Ordered work packages, P0–P2

### P0 — Close production contract seams

**Components:** `apps/command-center/src/server.ts`, `composition.ts`, `packages/maestro/src/index.ts`, `packages/tester/src/agent.ts`, existing durable task store/runtime.

1. Trace the normal mixed and single-delegate routes, automatic Tester verification and recovery using distinct specialist model snapshots. The single-path automatic verifier still uses `activeTester` and prepares it with `{workspaceRoot}` around `index.ts`'s `shouldVerifyWithTester` block; ensure it resolves **Tester's** persisted configuration, scope, permissions and cancellation exactly as explicit Tester assignments do.
2. Compile a bounded criterion/evidence plan at goal creation using the current goal/contract infrastructure. User criteria must survive model schema repair. Require independent verification for code-changing objectives without imposing terminal checks on conversation/read-only work.
3. Reuse one existing verification settlement policy across mixed/single routes. `statusFromAssignmentReports` recognizes report statuses; it must not substitute for goal verification. Bind candidate artifacts and supported criteria explicitly before final success.
4. Revalidate recent DNS-pinning/browser-boundary and cancellation-settlement fixes with focused existing security tests; verify no fail-open browser routing when pinned context is missing and no lease release from unconfirmed cleanup. Correct defects only if reproduced. No broad security subsystem rewrite.

**Gate:** controlled production-path tests assert exact encoded provider/model/effort for all participating calls, restart retains those selections, denied tools make zero side effects, failed/absent verification cannot satisfy a changed-code goal, and cancellation preserves findings. Reuse existing regression files; no repeated generic codec fixture campaign.

### P1 — Deliver the vertical workflow

**Components:** `packages/maestro/src/index.ts`, `context.ts`, `specialist-communication.ts`, `web-workers.ts`; Cody/Tester adapters; `langgraph-engine.ts` only for an evidenced missing graph operation.

1. Improve Maestro's current prompt/context/validation with outcome criteria and truthful executable capabilities. Keep `delegate_text`'s existing tool-capable assignment route; do not rename/rebuild it. Independent Doc/Cody work must have no artificial dependency; verification must depend on the produced revision.
2. Use current Doc web tools. A known authoritative URL should be retrievable directly; unknown-source discovery remains separate. Preserve empty/challenge/error distinctions and verified excerpts. Avoid repeated searches when evidence is already adequate.
3. Publish Doc's explicitly shared finding through the current authorized group/direct API; deliver during Cody's active work. Inject only new bounded findings into subsequent decisions with sender and evidence IDs. Do not expose private conversations or manufacture acknowledgment text.
4. Have Cody use existing repository retrieval, relevant reads and content-hash guarded edits. Cody writes implementation/tests/README; Doc supplies an attributed draft or guidance. Keep real tool permissions and approvals.
5. Schedule Tester independently on the candidate artifacts using its own model. Run actual existing/new tests and inspect outputs/criteria. Use the bounded failure→Cody repair→Tester recheck branch from section 5. Preserve approved completed effects during retries.
6. Final synthesis receives bounded reports, criterion verdicts, artifact refs, check results and unresolved blockers. Runtime vetoes unsupported success and preserves truthful partial output if synthesis fails.

**Gate:** controlled adapters may propose actions, but actual files/process checks/messages must execute. Run the notes task and a second small variant with different filenames/requirements to reject scenario-specific routing. Inject one failed verification, one denied write and one unavailable web source; assert targeted recovery or truthful partial outcome, never fabricated evidence.

### P1 — Wire user-visible evidence in the same slice

**Components:** `apps/command-center/src/events.ts`, composition event projection, `state/AppContext.tsx`, `state/specialistTaskHistory.ts`, existing thread/tool/approval components and `features/empty/specialistTaskActivity.ts`.

Reuse existing event types, child execution attribution and replay. Render current action, real tool/result, shared finding, verification and retry status where existing components support them; add only minimal backward-compatible event fields if necessary. Omit generic progress spam and hidden reasoning. Keep Main Chat and individual bot views synchronized without duplicating events or remounting away drafts/history.

**Gate:** browser assertions check actual status/action/tool/evidence content while workers run, then correct terminal state and replay after reconnect. Inspect screenshots at 2048×1159. A visible empty panel is insufficient. Preserve the existing design and model controls.

### P2 — Recovery, safety and resource envelope

**Components:** existing LangGraph checkpoints/outcomes, `packages/runtime/src/durable.ts`, `resource-governor.ts`, `resource-telemetry.ts`, `subprocess-supervisor.ts`, tools and product events.

- Restart after Doc completes and Cody has an approved effect; resume only pending work. Pause/approval survives restart; cancellation leaves no late tools. Ambiguous side effects require reconciliation/user review, not blind replay.
- Keep read-before-edit, atomic writes, content-hash preconditions and file locks. Full transaction rollback is not demonstrated. For recovery retain bounded per-file before-images/diffs through existing artifact storage if absent; restore only explicitly owned files with unchanged expected hashes and approval. Never `git reset`, stash or overwrite unrelated user work.
- Start with two independent specialists plus one dependent Tester, one browser maximum for this task, lazy HTTP-first crawl, provider/Governor limits and existing deadlines. Do not increase global limits or create always-on processes. Suggested per-task ceiling: eight model decisions per specialist, one schema repair per decision, one implementation repair; count peer-responder calls within the same ceiling. Reuse stricter existing limits.
- Use current bounded context/repository retrieval, not full repeated transcripts or a new memory/index service. Cap each injected peer finding at the existing message limit and total per-decision peer context at 4 KB.
- On the 16 GB Mac, record backend RSS, crawler/process-tree RSS separately, browser/process counts, 1 s CPU samples and peak total owned RSS. Proposed task envelope: ≤2 GiB total owned peak and idle recovery within 10% of pre-task RSS after warm caches settle; treat these as targets to measure/tune, not current claims. Existing Governor pressure controls remain authoritative. UI stop requests should acknowledge within 1 s locally; cleanup must be confirmed or visibly pending.
- Verify Node/Python/browser discovery, paths, command arguments and subprocess-tree cleanup on Windows separately. Do not claim Windows acceptance from macOS fixtures.

**Gate:** isolated restart/cancellation/approval runs preserve hashes, findings, model snapshots and event order; bounded live activity remains responsive; no orphan processes or unaccounted leases. Review security/architecture changes beyond these seams before implementing them.

## 7. Acceptance protocol and remaining authorization

1. **Baseline:** preserve current worktree; record current focused evidence as controlled. Do not rerun it merely to recreate existing counts or overwrite historical artifacts. Save future evidence under immutable run IDs.
2. **Controlled integration:** use production `/api/turns`, real disposable local files, actual authorized tools and independent checks. Record action validity, interval overlap for actual operations, collaboration publish/delivery/consumer decision, artifact hashes, Tester commands/output/criteria, settlement, final response and UI contents. No generated model text itself proves an outcome.
3. **Negative controls/recovery:** failed assertions defeat completion; one bounded repair, denied action, malformed/empty response, source unavailable, specialist cancellation and restart leave truthful durable state. Verify completed siblings are retained.
4. **Real-model gate:** currently **BLOCKED** at $0 and no authorized provider calls. First confirm documented zero-cost entitlement/remaining allowance without inference, then obtain separate authorization for a specific bounded run. Run the same task through the existing UI with exact configured specialist models. Never silently swap providers or count controlled responses as live acceptance. If a required model is unavailable, report the blocked criterion.
5. **Completion:** actual model-chosen plan, concurrent useful work, authorized finding used, valid edits, independent verification, accurate final answer and live UI must all pass. Record PASS/PARTIAL/FAIL/BLOCKED per capability; security and Windows remain separate gates. Human review accepts the milestone before unrelated specialist expansion.

## 8. Antigravity execution prompt

> Implement this plan's single “evidence-verified autonomous project change” milestone in the existing dirty MedioBot V2 worktree. Start by confirming current source against the baseline; preserve already working LangGraph scheduling, model-routing fixes, collaboration, persistence, permissions and UI. Complete P0 contract seams first, then the P1 notes-CLI workflow and existing UI evidence together, then P2 restart/resource acceptance. Reuse the named contracts/adapters and existing tests; add only scenario-critical coverage. Models must choose assignments/actions from actual capabilities; never key production behavior on the reference prompt or fabricate tools, findings, repair success or verification. Resolve and persist each specialist's exact provider/model/effort, including automatic Tester and recovery. Require observed criterion-specific verification against final artifact hashes; allow one bounded repair and preserve completed siblings. Use real authorized local operations in controlled integration, with immutable run evidence and accurate live views. Correct the focused report's autonomy/UI/memory overclaims; retain historical results as controlled. Do not call providers, change saved models, redesign UI, modify Vision/UI-TARS/computer-use, add Dessy/Weby, replace LangGraph, add a scheduler/database, commit, push or overwrite unrelated files. Stop at genuine architectural/security gates and the separately authorized zero-cost live-model gate; ordinary local implementation needs no repeated approval. Deliver exact changes, controlled results, unresolved limitations, reproducible UI steps and per-capability status. Do not declare autonomous or production acceptance from scripted models.
