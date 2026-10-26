# Phase 1 target architecture

2026-10-28. Implementation specification for Antigravity Teamwork. This review changes documentation only. Paths are repository-relative. The current dirty checkout, configuration and data are the migration baseline; no clean checkout/reset is permitted.

## 1. Decision and evidence standard

Retain LangGraph as the sole managed workflow authority. Finish the production seams connecting goal interpretation, exact specialist inference, tools, independent verification and the existing interface. No evidence justifies replacing the execution engine, SQLite, provider compatibility layer or React application.

Current readiness is **PARTIAL**. Focused acceptance reports two controlled 5/5 runs. Inspected fixtures use scripted specialist selection, delayed inference and scripted finish/report responses. They demonstrate application scheduling, events and some UI/lifecycle integration, not autonomous coding or general research quality. The stored JSON is one aggregate; preserve it without relabeling it live acceptance. Tests were inspected, not rerun during this specification.

Use four evidence labels: **observed source**, **controlled execution**, **authorized live-model execution**, **unverified**. Never promote one into another. “Production-ready” requires the acceptance matrix, not source plausibility or typechecking.

## 2. Preserve, repair, consolidate

| Classification | Current source / decision |
| --- | --- |
| Preserve; controlled foundations | `packages/maestro/src/langgraph-engine.ts`: dependency fan-out, checkpoints, interrupts, persisted outcomes and safe retry classification. `packages/runtime/src/index.ts`, `durable.ts`: WorkerRuntime/task lifecycle. Existing Governor, subprocess supervisor, SQLite task/session/message stores and product-event journal. |
| Preserve; integrate correctly | `packages/models/src/index.ts`, `scheduler.ts`; `apps/command-center/src/runtime/modelRegistry.ts`: streaming, compatibility codecs, exact selection, retries and provider queues. `packages/cody/src/agent.ts`: actual tools and bounded action loop. `packages/tester/src/agent.ts`: read-only execution and revision checks. `packages/intelligence/src/`: project discovery/retrieval. |
| Preserve; qualify acceptance | Shared `Crawl4AiRuntime`, address-pinning HTTP backend, browser routing and settlement-aware cancellation in `packages/runtime/src/crawl4ai*`. Recent fixes supersede earlier audit findings where verified; run targeted negative controls before reopening them. Python/browser security remains a release gate. |
| Repair integration | Main Chat/direct specialist configuration, task scopes, evidence verdict propagation, independent Tester binding, live event projections and project-mutation coordination. See confirmed seams below. |
| Consolidate narrowly | Editor and agent file locks, verification policy across single/mixed delegation, explicit conversation scope, structured collaboration events. Consolidate the policy/lock, not the entire application. |
| Isolate, do not rewrite | `packages/maestro/src/orchestrator.ts`, exported as `./legacy-orchestrator`, remains an isolated rollback/test API. No production managed task may also be scheduled there. Reference repositories are not production dependencies. |
| Missing / outside Phase 1 | Dessy/Weby executors, new CLI/Termi integration and expanded Vision/UI-TARS/general computer-use. Do not advertise or implement them. No new long-term memory service. |

### Confirmed seams requiring correction

1. `Composer.tsx` passes effort to `AppContext.sendPrompt`, but `state/AppContext.tsx`'s `runtimeInstance.startTurn` around line 2325 omits it. Stored preference is not proof of inference routing.
2. `server.ts` direct-specialist construction around line 2033 unconditionally gives Doc/Research/Scraapy `web.search` + `web.crawl`; conversation/drafting should not force web work.
3. `maestro/src/index.ts` mixed Tester branch around 1187–1193 wraps execution as completed without propagating its failed/blocked/unverified verdict. Automatic Tester around 1978–2003 uses the parent-created `activeTester` and insufficient child options. Single-Cody recovery around 1749–1802 can derive current rather than saved child selection and swallows durable errors.
4. `tester/src/agent.ts` around 523–537 labels all proposed assertions runner-observed after any exit-zero command and copies model-supported criteria. Existing baseline/post-revision checking must stay, but evidence promotion must follow that check and bind each criterion to actual observations.
5. `workspaceManager.ts::writeFile/withWriteLock` and `tools/src/index.ts::fileLockManager` use different lock domains. Both can validate the same old hash and then rename independently.
6. `EmptyState.tsx::botConversations` infers ownership from message actors; participation in a team thread is not a private specialist conversation. `AppContext.tsx` refreshes collaboration history using English progress-message regexes rather than structured metadata.
7. `models/src/index.ts::parseRetryAfter` caps at 60 s; `computeBackoffDelay` caps again at 10 s. A server-required wait above those caps can be retried early. `ResourceGovernor.acquireModelSlot` exists but production model resolution uses only the provider scheduler; reported zero model leases alone does not prove accounted inference.

Reproduce these against the current source before changing behavior; line numbers drift. Do not assume every historical defect remains.

## 3. One organization, one execution substrate

```text
Main Chat / direct specialist conversation
  → captured project + conversation scope + explicit inference snapshot
  → Maestro plan OR direct specialist task interpretation
  → validated outcome criteria, capabilities and dependency DAG
  → LangGraph dispatch / checkpoint / interrupt
  → WorkerRuntime + Resource Governor
  → existing provider scheduler → selected model compatibility codec
  → validated action → permissions/approval → actual tool
  → durable evidence/artifact/message + product event
  → dependent independent Tester → bounded repair → recheck
  → evidence-grounded result → same replayable UI projections
```

Direct specialist execution does not require an unnecessary Maestro inference call. It retains the same task ownership, authority, tool permissions, durable engine and event contracts. An explicit specialist selection identifies the actor; it never grants capabilities.

### Stable responsibility boundaries

- **Maestro:** interpret goals, clarify material scope ambiguity, choose the smallest useful team, supervise outcome criteria and authorize bounded replanning. Use model-authored assignments validated against actual capabilities; no fixed pipeline or prompt-specific plan.
- **LangGraph:** scheduling, dependencies, durable control flow, approvals and recovery. Retry/wait timers are bounded operation controls, not separate task schedulers.
- **WorkerRuntime/Governor:** execution lifecycle and resource reservations; child task/worker/approval settlement. A parent terminal status does not certify external cleanup.
- **ModelResolver/compatibility:** exact connection/model/protocol; action proposals only. Tool authorization and execution remain outside codecs. No model fallback or weakening of validation.
- **Tools:** enforce project ownership, read/write/network/terminal permissions, content preconditions, subprocess safety and actual result evidence.
- **SQLite/product events:** one product data store and durable event journal. Checkpoints describe workflow state; task rows alone are not checkpoint recovery.
- **UI:** views of persisted/streamed state, drafts and user controls. Never reconstruct identity, message delivery or completion from narration.

## 4. Minimal contracts

Extend/reuse `packages/contracts/src/index.ts`, domain goal/evidence types, `TextAssignmentDraft`/`WorkerReport`, `TrustedCompletion`, existing product events and durable APIs. Integrator owns shared edits. Additive migration only if existing options/records cannot safely represent the data.

| Contract | Required semantics |
| --- | --- |
| Execution scope | Workspace ID, captured canonical root, thread, direct-private or team scope, initiating specialist, parent task, authorization scope. Explicit owner; UI navigation never retargets running work. |
| Inference snapshot | Exact provider-connection ID, model ID, requested effort, protocol/profile version and limits. Resolve effective/unsupported effort per request. Persist before first inference and reuse on all recovery/repair paths. Secrets remain in credential storage. |
| Assignment | Stable ID, specialist, objective, required capabilities, authorized input/artifact refs, required criteria, dependency IDs, deadline and budget. Independent assignments remain independent; validate cycles and missing executors before admission. |
| Evidence/check | Producer, task/attempt/invocation, kind, observed result, bounded output ref, timestamps, criterion IDs and artifact revision/hash set. Runner-observed claims require real check records. Peer/model reports retain attributed unverified status unless corroborated. |
| Outcome | Execution settlement separately from goal verdict: verified, failed, blocked, unverified or cancelled; preserve partial findings. Worker completion means it returned, not that every criterion passed. |
| Product event | Stable event ID/sequence; parent and child task, worker instance and specialist identity, invocation/attempt, structured phase/status, timestamp, safe summary and evidence refs. No hidden reasoning or credentials. |

Criterion verification must match the **final candidate revision**. A changed artifact invalidates earlier checks for that artifact. Tester cannot certify an unrelated requirement because `node --version` exited zero. A runner-parsed named test/assertion or an explicit observed-output matcher must support each machine-checkable criterion; merely attaching a model-selected command ID does not establish the claim. Semantic requirements without an independent check remain explicitly unverified. Final host validation vetoes unsupported success, even if Maestro proposes it.

## 5. Functional personalities and direct workspaces

Reuse the existing `MEDIOBOT.md` parser/registry and role action contracts. Add missing Cody/Tester structured definition assets only after checking existing code-owned definitions. One identity registry and versioned behavior source; do not create a parallel personality database. Definition policy is subordinate to runtime permissions.

Shared definition fields: stable ID/version, mission, style, expertise, planning rules, declared capabilities, tool constraints, evidence policy, collaboration policy, limitations, completion standard. Load concise selected-role instructions into every initial/repair/responding model request, not a full transcript or all agents' prompts.

| Mediobot | Operational behavior / boundary |
| --- | --- |
| Maestro | Calm and accountable; clarify project ambiguity, choose necessary roles, track criteria/conflicts, authorize one bounded repair; report unsupported parts explicitly. |
| Cody | Practical engineer; relevant repository discovery, read before change, hash-safe edits, authorized commands, tests/debugging and concise artifact/check report. No repeated broad listing as a substitute for progress. |
| Doc | Structured and source-conscious; distinguish local project documents from external sources. Read authorized relevant files; draft or edit explicitly authorized documentation targets; cite versions/sources and assumptions. No general terminal or code-write grant. |
| Scraapy | Efficient web investigator; discover/retrieve/filter/extract with query/source provenance, source failure classification and no unsupported facts. Retain existing component-research specialization as an optional task mode, not mandatory on every request. |
| Tester | Skeptical independent quality engineer; list/read/run only within existing policy, inspect requirements and outputs, bind assertions to checks/current revision, report failure or unknown honestly. No workspace writes. |

Direct Doc/Scraapy discussion uses the existing text/report path when no tool is needed. A documentation task may need local reads or approved Markdown edits; add a narrow document adapter if current adapters cannot provide them, reusing tool action schemas and ToolRuntime. Do not instantiate Cody under Doc's name or grant Doc all Cody tools. A `draft-document` result can be an attributed artifact without implying it was applied to the project. Applying it must execute an authorized write with a diff.

Each direct workspace uses the existing thread timeline, task/event store and scoped session context. Preserve drafts, history, scroll and active execution on switching. Distinguish private conversation, shared assignment participation, availability, current activity and historical completion.

## 6. Execution interface

Retain navigation, Settings, typography, colors, avatars, tabs, Explorer/editor and current activity components. Improve information architecture in the existing `ThreadView`, `timeline.ts`, `ActivityItem`, `ToolExecutionView`, `DiffViewer`, `ApprovalBanner` and specialist views.

Show a compact parent goal with attributed child assignment groups: queued/admitting/model-wait/running/action/tool/check/retry/approval/blocked/terminal. Independent children remain visibly separate. Expand actual inputs/results, safe terminal diagnostics, files/diffs and criterion results. Coordinator summaries must not overwrite specialist messages. Private chats never become group messages automatically.

Use one reducer/projection seam for Main Chat and direct views; durable event sequence orders records, timestamps measure intervals, event IDs deduplicate replay. Preserve stream subscription-before-replay behavior. Remove English-regex delivery detection. Stream model answer content only where supported/safe; partial action arguments and reasoning are not user-visible executable actions. Batch rendering and bound retained output; virtualize only if a measured long-timeline regression justifies it.

## 7. Project integration and safe effects

Keep `workspaceManager.ts`, workspace repository, watcher, Explorer and ToolRuntime operations. Open/persist actual local roots; capture root at submission. Support existing create/read/write/search/rename/delete routes with existing confirmation policies; add missing user-authorized operations only through those contracts. Model-directed deletion is not an unrestricted terminal workaround.

Unify editor and agent mutation locking by canonical path through one existing lock service. Within the lock: validate current root/symlink constraints, compare expected content hash, apply atomic change, record artifact/diff and publish event. Watcher observations must reconcile with own writes, not duplicate events or silently discard unsaved editor content. Conflicts yield recoverable explicit state; no last-writer-wins overwrite.

Persist operation intent/result where current durable records support it. Completed effects are not replayed after model retry. On a crash after effect but before record, reconcile actual hash/outcome; ambiguous commands require review. Retain bounded owned-file before-images/diffs if needed for approved rollback; restore only matching expected post-hashes. Never reset/stash or restore unrelated dirty files.

## 8. Provider admission and recovery

Extend the **existing** `ProviderRequestScheduler`; it remains the model queue, LangGraph remains the workflow engine, Governor remains the resource ledger. `modelId` is currently metadata rather than an independent limit key. Supply per-connection and optional exact-model overrides from safe configuration/observed headers; do not infer all NVIDIA models have the same concurrency or quota.

Define a small injected admission port, avoiding a runtime→models import cycle: `tryAcquire(scope) → lease | undefined`, `release(lease)`, and `subscribeCapacityChange(listener) → unsubscribe`. Model requests carry task/workspace/specialist attribution. Existing scheduler dispatch checks provider/model capacity and nonblocking Governor acquisition together; roll back any partial admission before leaving a request queued. No second waiting queue or capacity held while waiting for another capacity. Wake this queue on release/cooldown expiry and cancel queued items promptly; do not busy-poll. Within a connection, schedule fairly across task/specialist queues; cap queue length using the current default 32 unless measured requirements justify a change.

Transport retries release inference capacity during backoff, then re-enter the same queue; keep the permit through response/stream completion, not just headers. Honor both Retry-After forms. If required wait exceeds the remaining deadline, defer/block truthfully rather than retry early; never cap a required server delay downward. Reuse current exponential jitter, cancellation and error classification. Retry transient capacity/transport only within a single shared attempt budget; do not retry authentication/configuration or replay tools. Distinguish queue wait, TTFB, first visible content/tool token, streaming idle and total time.

Preserve exact protocol profiles and native-tool/schema/JSON/text fallbacks already approved. Unknown protocol support is not a generic tools flag. Every decoded proposal still passes current contracts and permissions. A reasoning-only/blank/filtered/truncated/malformed response is a classified inference failure, not proof of a weak model. No additional model call merely to narrate progress.

Keep model selection unchanged. Unsupported effort must be reported as requested-but-unsupported (or require user choice), never silently mapped. Hosted entitlement documentation does not authorize this account's inference. The current $0 restriction and separate live-call authorization remain in force.

## 9. Resource, recovery and migration budgets

- Initial reference workflow: two independent useful specialists, then dependent Tester; optional third only when needed. Existing stricter Governor/provider limits always win. At most one browser for the reference task; lazy HTTP-first retrieval and supervised subprocesses. Do not run provider calls while holding an unnecessary exclusive filesystem lock.
- Proposed bounded task policy: at most 8 decisions/specialist, one schema repair/decision, one implementation repair, and 24 model-provider HTTP attempts per goal. Count classifier, schema repair, transport retry, peer-responder and synthesis requests exactly once in this shared budget; web search/crawl retains separate existing tool bounds. Reuse existing stricter limits. Approval pauses do not consume active worker/browser/model reservations after confirmed suspension.
- Budget context by selected model's supported window; reserve output headroom, use bounded repository retrieval/session summaries and evidence refs. Unknown tokenization uses labeled conservative estimates. Never infer capacity from a model's name or inject a million tokens because a model card permits it.
- Report backend RSS, owned Python/browser/subprocess tree RSS and system RAM separately. Measure CPU/event-loop lag and post-task idle recovery. A proposed reference target is ≤2 GiB total owned peak on the 16 GB Mac with responsive controls; report measured failures instead of presenting this as current fact.
- Preserve existing SQLite data. Reuse versioned additive migrations, back up before migration tests, and test old task/approval/settings/evidence records. If a legacy record lacks scope/model/verification provenance, display explicit unknown/blocked state; do not guess or delete it.
- Preserve Tester's existing shadow workspace and original-revision/node-modules integrity checks. These are not a kernel sandbox; arbitrary child commands can have wider effects. Execute only explicitly authorized commands with scoped cwd/environment and existing permission policy. If a task requires stronger isolation than available, retain current fail-closed behavior; do not claim OS isolation or add containers merely for this phase.
- UI migration is projection/component reuse, not a redesign. Isolate legacy execution as rollback. Rollback cannot start a second engine for an in-flight managed task; drain/pause and explicitly reconcile first. No destructive downgrade of additive tables.

## 10. Source-backed research and dependency decision

No new production dependency is proposed. Registry metadata checked over verified TLS for the exact existing versions: LangGraph **1.5.1** and SQLite saver **1.1.0** (MIT, Node ≥18); React **19.2.8** (MIT); TypeScript **5.9.3** and Playwright **1.63.0** (Apache-2.0; Playwright Node ≥20). This verifies published metadata/existence, not a full vulnerability audit or “latest” status. Registry endpoints: `https://registry.npmjs.org/<encoded-package>/<version>`. Keep lockfile versions; compile against installed APIs, not unversioned examples.

Python `packages/runtime/requirements.txt` says pinned but uses lower bounds. Record a tested resolved environment/constraints for Crawl4AI, Python Playwright, HTTPX/HTTPCore and browser binaries before packaging; do not indiscriminately upgrade. Private HTTPX/HTTPCore backend usage requires compatibility tests against that environment.

| Official reference, checked 2026-10-28 | Architectural implication |
| --- | --- |
| [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [Functional API](https://docs.langchain.com/oss/javascript/langgraph/functional-api), [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | Replay/checkpoint boundaries matter; place effects behind durable task boundaries and reconcile uncertain outcomes. Resume does not mean continuing at the interrupted line. Keep current engine. |
| [React external-store subscriptions](https://react.dev/reference/react/useSyncExternalStore), [TypeScript 5.9](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-9.html) | Stable subscription cleanup/cached snapshots and discriminated typed state; do not replace AppContext solely for fashion. Existing reducer improvements come first. |
| [Playwright network](https://playwright.dev/docs/network), [BrowserContext routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route) | Context/page isolation and real DOM assertions; routing has service-worker limitations. Block service workers where interception enforces policy and prove denied destinations receive no connections. |
| [Node 22.22.3 child processes](https://nodejs.org/download/release/v22.22.3/docs/api/child_process.html) | Prefer argv-based asynchronous execution; handle Windows command wrappers deliberately. Signal sent/exit/stdio-close/process-tree cleanup are distinct states. |
| [WHATWG SSE](https://html.spec.whatwg.org/multipage/server-sent-events.html), [RFC 9110 Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) | Durable IDs/reconnect/replay, incremental frame parsing and required retry delay, rather than timestamp ordering or premature retries. |
| [OpenAI structured output](https://developers.openai.com/api/docs/guides/structured-outputs), [Claude tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview) | Provider schemas/tool proposals differ; preserve existing codecs and internal authorization. No wholesale SDK/runtime transplant. |
| [NVIDIA hosted API guide](https://docs.api.nvidia.com/nim/docs/api-quickstart), [Nemotron Ultra exact API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer), [trial FAQ](https://docs.api.nvidia.com/nim/docs/product) | Consult exact hosted endpoint/model. Ultra documents streaming and effort `none/medium/high`; that does not authorize another model's protocol or account usage. No universal numeric per-account concurrency/RPM quota was established by these sources. Use explicit policy/observed safe headers, not invented limits; self-hosted NIM configuration is not hosted entitlement. |

Local OpenCode reference inspected at commit `d30e990c69efd8a954413a724b35c5a27462f320`: `packages/core/src/session/{execution.ts,model-transport.ts,message.ts,compaction.ts}` supplies useful separation of execution, message state and bounded context. Its MIT license permits adaptation with notices; **adapt concepts only**, no Bun/Effect/runtime transplant. Codex's [public repository](https://github.com/openai/codex) is Apache-2.0; use public protocol/interaction ideas with attribution if code is reused. The Claude Code reference at `a6e289a2e772a17b3614a9ef43303003de5cd887` is not proof that its proprietary runtime is available; do not copy it. Antigravity/Codex visual comparisons express usability goals, not implementation evidence or permission to clone their UI identity.
