# Root Cause Report — Execution Reliability Foundation

## Evidence status

- **VERIFIED:** the normal composition wires one selected model client into both Maestro and Cody; provider/model construction remains outside this change.
- **VERIFIED:** Cody previously parsed decision text with `JSON.parse` once and threw on malformed syntax or a nonmatching action shape (`packages/cody/src/agent.ts`, prior `CodyDecisionProvider.decide`). It had no structural-repair loop.
- **VERIFIED:** Cody’s bounded action loop did pass list/read/search results into subsequent decisions, including actual listed names (bounded by the existing tool output limits). Its successful-tool evidence stored only counts/lengths, not private file contents (`packages/cody/src/agent.ts`, `summarize` and `describeToolOutcome`).
- **VERIFIED:** ordinary failed `filesystem.search` and `filesystem.edit` outcomes were converted to a generic thrown error rather than returned to model continuation. Read/list/write and process failures had different handling.
- **VERIFIED:** Maestro already retried structural decision errors within `MAESTRO_MAX_DECISION_ATTEMPTS`, used fixed feedback, and did not retry semantic or provider transport failures (`packages/maestro/src/index.ts`, `MaestroDecisionProvider.decide`). Its parser assumed provider-normalized JSON at that boundary.
- **VERIFIED:** selected workspace state was captured before asynchronous turn work and the immutable root was propagated through Maestro, Cody, and ToolRuntime. Existing thread/project identity was not compared with the active workspace before accepting a new turn.
- **VERIFIED:** nonempty client-supplied `recentHistory` could replace the more authoritative SQLite-derived recent turns; previous-turn failure evidence was separately built from the stored turn.
- **UNPROVEN:** the exact MiniMax response that caused the reported `actionType: undefined`. No local safe execution log contained the raw response, and existing diagnostics retained only response length, object keys, and an action-type summary. Therefore this report does not attribute the observed incident to any specific envelope, truncation, or provider behavior.

## Root causes corrected

1. Cody had strict one-shot parsing and no safe structural repair. The corrected provider uses the existing reasoning/JSON normalizer, strict allowlisted action validation, and at most two attempts. It never echoes rejected output or reasoning into the repair prompt.
2. Ordinary tool failures did not all reach Cody’s next decision. Failed search/edit/process/filesystem results now remain observed failures and are included in bounded continuation history; cancellation remains terminal.
3. Server context authority was split between SQLite and AppContext: stale client history could win. Continuations now derive bounded history from SQLite.
4. A thread associated with project A could be submitted while B was active and run with B’s workspace root. The API now rejects this mismatch before prompt persistence/model execution. A project-independent thread becomes project-scoped when its accepted turn is associated with the active project.

## What this does not prove

The deterministic provider doubles prove that these contracts work with the exercised response shapes. They do not establish the current MiniMax response distribution, provider reliability, autonomous coding quality, or production readiness. Real connected-model acceptance remains a human gate.

## M3.3 runtime-resource finding

- **VERIFIED:** the Command Center `WorkspaceManager` eagerly owned a native recursive watcher for workspace roots even when there were no filesystem-event subscribers; test-created managers were not consistently disposed. That created avoidable watcher pressure in addition to the explicit watcher tests.
- **CORRECTED:** watcher acquisition is now subscriber- and OPEN-session-scoped; manager disposal and the last unsubscribe close it. An independent code review also identified stale watcher retention in `restoreLastWorkspace()` early-return branches; both now call `syncWatcher()`, and the no-active-ID path clears `currentSession`.
- **UNPROVEN:** native event delivery still fails with `EMFILE: too many open files, watch` in the standalone probe in this sandbox. We could not inspect/change host watcher limits or other processes. Therefore the code-level ownership correction is verified, but platform watcher operation remains unverified here.
- **VERIFIED FAILURE:** the focused hybrid Vision composition test produces two task `failed` states where its fake-provider test expects `completed`; its HTTP variant cannot bind localhost (`EPERM`). The source-level contract does not establish the task failure reason, and no sandbox-independent run was available. Do not claim the focused runtime matrix passes.

## Maestro definition and prompt integration

- **VERIFIED:** `apps/command-center/src/composition.ts` loads `mediobots/maestro/MEDIOBOT.md`, parses it with `parseMediobotDefinition`, and registers its Markdown instructions on the existing Maestro domain definition. `MaestroExecutionAdapter.decideTurn()` reads that registered definition and passes its instructions to `MaestroDecisionProvider`; `compileMaestroContext()` serializes them into the model input. The selected provider receives that input through the normal `/api/turns` path.
- **VERIFIED:** the server compiles the current prompt, up to four SQLite-derived prior turns, previous execution outcome evidence, canonical workspace/project state, project intelligence, and tool metadata before invoking Maestro. Deterministic `/api/turns` regressions now inspect the exact model input for the definition, project identity, history/failure evidence, and specialist metadata.
- **CORRECTED:** when no validated project workspace exists, production already restricted `availableIntents` to direct response and clarification, but still advertised Cody/Research/Tester IDs as assignable. `decideTurn()` now sends an empty assignable set in that state. The same model-facing roster now describes Research and Tester according to their actual text-only dispatch path instead of advertising Tester filesystem/test tools for a text-only assignment.
- **VERIFIED:** attempted delegation without an authorized workspace is rejected by decision validation and creates no execution task. ToolRuntime remains the filesystem/terminal permission and containment authority; Markdown instructions and model decisions cannot grant tool access.
- **VERIFIED:** production `/api/turns` regression has Cody attempt a traversal read from a temporary workspace. ToolRuntime denies it (`PERMISSION_DENIED`), Cody receives the failed result, and the outside sentinel is absent from model history, evidence, events, and persisted assistant output. Existing permission-engine tests also cover forbidden paths and approvals.
- **CORRECTED:** text-worker synthesis previously supplied a hard-coded `definitionInstructions` string instead of the loaded definition, and omitted original project/history/tool context. Synthesis now uses the same `MaestroContext` builder as initial decisions and adds only bounded specialist reports, supervision notices, and the goal anchor. A `/api/turns` test verifies the exact synthesis payload, original SQLite history, canonical workspace, and real worker-report evidence.
- **LIMITATION:** production currently exposes direct response, clarification, Cody delegation, and bounded text delegation as available intents. Although `acquire_context` and `use_capability` exist in the decision schema, this execution path does not currently expose them as available/executable intents. No new capability broker or skill-body selection path was added.
- **LIMITATION:** text-worker synthesis is deliberately restricted to response or clarification; it does not trigger another delegation cycle. Cody's normal action loop and configured evidence/completion policy handle execution and verification; optional independent Tester execution remains controlled by runtime options rather than a new model-selected post-Cody routing loop. This change does not claim arbitrary dynamic re-delegation.
