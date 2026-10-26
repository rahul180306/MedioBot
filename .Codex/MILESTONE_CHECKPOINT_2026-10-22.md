# MedioBot V2 World Space Milestone Checkpoint

**Date:** 2026-10-22  
**State:** PARTIAL — controlled acceptance passes; genuine live-provider end-to-end acceptance does not.

## Implemented in the current dirty worktree

- LangGraph remains the execution authority for the managed task workflows, using the existing Maestro, Cody/specialist adapters, WorkerRuntime, DurableTaskEngine, Resource Governor, SQLite, model resolver, collaboration and product-event/SSE infrastructure.
- Capability-aware dispatch sends web assignments to web-capable workers, testing assignments to the existing test-capable adapter, and supplied-context analysis to text execution. Mixed independent assignments remain concurrent.
- Durable specialist identities, scoped sessions, attributed direct/group messages, bounded histories/cursors, and authorized live assistance are connected to execution. Required group findings are exposed to specialist report actions; if an explicitly required finding is omitted, workers make one bounded model-only repair from already-collected evidence. They do not repeat web or filesystem side effects. Missing publication is reported as blocked.
- Assignment and tool events carry specialist/task attribution. Main Chat, the durable task view, and individual specialist workspace projections use the existing event/history sources. Generic progress is not substituted for authored conversation.
- Cody's existing action loop supports bounded workspace inspection/editing/terminal checks, validation of model actions, safe failure recovery, and persisted tool evidence. Terminal failure records retain bounded, redacted command/cwd/launch-or-exit/recovery details without raw output or secrets.
- Durable recovery includes restart-safe approvals, LangGraph checkpoints, completed side-effect restoration, and fail-closed handling for ambiguous terminal side effects. Verified project evidence is retrieved from the existing workspace/thread-scoped SQLite index with bounded provenance.

## Verification completed

- `pnpm test`: **319 total, 311 passed, 0 failed, 8 skipped**. Skips include opt-in/live-provider cases.
- `pnpm typecheck`: passed for all 11 workspace projects in scope.
- Maestro suite: **131/131 passed**; Maestro typecheck passed.
- Controlled mixed-executor test: Doc and Research each performed one search and crawl; Tester performed a real local terminal invocation. Web calls overlapped **252 ms** and web/test execution overlapped **232 ms**. Doc omitted a required group finding on its first report; one model-only repair persisted Doc's finding at sequence 2 after Maestro's sequence-1 kickoff. Search/crawl counts remained at two each, and synthesis retained sibling results.
- Controlled `/api/turns` collaboration test passed: Doc authored a group finding, Cody consumed it during active execution and then read the project file, the finding/tool activity appeared in task and Main Chat event projections, and Maestro synthesized the findings.
- Browser tests passed for the prime-check task and live Doc/Cody/Research assistance. The prime test used deterministic model adapters but performed actual local filesystem writes and terminal subprocesses; it verified ENOENT on the first interpreter, one evidence-justified alternate Python invocation with exit 0, accurate synthesis, and matching Main Chat/Cody workspace event identity. The live-assistance fixture measured **21.8 ms** search overlap and confirmed Cody consumed Doc's report while Research ran concurrently.
- Specialist group-history UI tests: **2/2 passed**. Specialist activity projection tests: **6/6 passed**.
- Process-crash approval test passed: persisted approval survived termination and resumed the exact Cody action once.
- `git diff --check` passed. No commits or pushes were made. The pre-existing dirty/untracked worktree was preserved.

All test and browser results above use controlled provider/model fixtures except where explicitly described as local filesystem/subprocess execution. They do not prove live model behavior or human visual acceptance.

## Previous live-provider failures

Live runs used the configured NVIDIA Nemotron model through normal `/api/turns`. No credentials were read. Transport reached the provider in the decision-contract attempt; therefore that failure was not diagnosed as DNS, TLS, authentication, or HTTP transport.

1. **Maestro decision-contract failure:** The first model response selected `delegate_text` but used a single-assignment shape with `requiredCapabilities` duplicated at the top level. The strict validator rejected it as `schema-mismatch`. A production normalization defect that retained that duplicate was fixed and covered by a regression test. The next two model attempts changed away from the required delegation intent and were rejected as `repair-intent-changed`; no child specialist task, tool call, or artifact was created. This was a real parser defect followed by a model/provider inability to honor the bounded repair contract. The live fix has not been revalidated because the prior authorization was consumed.
2. **Collaboration/synthesis failure (`task_23fd84b2-f2be-4779-ae7a-da56f97569e2`):** Cody and Doc were assigned and started concurrently; their persisted intervals overlapped **24.370 s**, and each used its actual tools. The shared group contained only Maestro's kickoff, so there was no evidence Cody consumed a Doc-authored group finding. Doc's retrieved evidence was not accepted as relevant/verified, and Maestro incorrectly said delegation was unavailable. The production paths were tightened and controlled integration tests now cover required group publication and truthful synthesis, but no live rerun has validated those fixes.
3. **Later group-action run (`task_345916c6-8fdc-4f45-8963-f80cf620125c`, as reported during this work):** A specialist-authored group finding was produced, but Cody generated an invalid `run` action and did not complete its next model decision before the 90-second task guard canceled execution. Cancellation did not settle promptly. The evidence available for this checkpoint does not establish whether that final Cody request received headers/tokens or was blocked in transport, nor does it identify the exact promise preventing settlement. Do not label that as a confirmed provider transport failure or a fixed cancellation defect. The safe conclusion is that real task completion failed at action/decision execution and the reported cancellation settlement was unreliable; the exact subcause remains unverified.

**Real-provider acceptance: FAIL.** A real task has not yet demonstrated all of: correct delegation, Cody's natural communication, authorized tool execution, completed behavioral verification, and accurate final synthesis. Controlled tests demonstrate the application path; they cannot substitute for another authorized live run.

## Smallest remaining blockers

1. After fresh authorization and confirmed model configuration, run one bounded normal-UI task. Do not send another paid request without that authorization.
2. Before that run, capture safe, bounded timing/state for Cody's model call and cancellation lifecycle so a timeout can be distinguished from parsing/tool/waiting and parent cancellation can be measured through worker settlement. The exact `task_345916...` model/cancellation subcause is not proven by the evidence currently available.
3. The run must verify a real Doc-authored shared finding (or an explicitly authorized direct reply), Cody's consumption and valid action, actual tool results, independent verification when requested, and evidence-grounded Maestro synthesis. Stop on the first repeated provider/contract failure; do not retry expensive runs.
4. Human visual acceptance, Windows execution, resource soak, broad multi-project/file-conflict behavior, and the advanced e-commerce scenario remain unverified.

## Change boundary and preservation

This checkpoint records current implementation and evidence only. No new production feature or UI change is introduced by this document. Preserve the dirty worktree. Vision, UI-TARS, Computer-Use Lab, CLI, and Termi remain outside this milestone.
