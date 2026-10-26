# Phase 1 implementation work packages

Implement with `PHASE1_TARGET_ARCHITECTURE.md` and `PHASE1_ACCEPTANCE_MATRIX.md`. These are product slices, not permission to substitute fixtures for live acceptance. Antigravity Teamwork owns implementation, integration, automated diagnosis and repair. Preserve the current dirty worktree; no commits/pushes or provider calls.

## Ownership and parallel execution

The **integration lead I** owns `apps/command-center/src/{server.ts,composition.ts,state/AppContext.tsx,runtime/client.ts}`, central request/product types, `packages/contracts/src/index.ts`, and SQLite schema/migrations. Others submit small interface changes to I; they must not edit these files concurrently. Freeze a shared contract revision before parallel implementation. Domain changes also pass through I.

| Team role | Exclusive implementation area | Responsibilities |
| --- | --- | --- |
| I — integration lead | Central files above; integration journal | Contract compatibility, task/config/scope plumbing, migrations, production composition, final integration. |
| M — inference engineer | `packages/models/`, app `runtime/modelRegistry.ts` and provider validation/configuration repository internals | Exact inference, provider scheduling/backoff, safe diagnostics. Central storage schema edits belong to I. |
| F — workspace/tools engineer | `workspaceManager.ts`, `watcher/`, `packages/tools/`, workspace repository internals | Shared mutation lock, project isolation, filesystem/network permission entry points, safe commands. |
| E — execution/specialist engineer | `packages/maestro/`, `packages/cody/`, `packages/tester/`, `mediobots/` | Role definitions/adapters, outcome contracts, verification, repair/recovery. Do not activate legacy orchestration. |
| U — product UI engineer | Existing thread/activity/empty/Explorer components, Composer, presentation tests | Shared execution views and direct-bot usability. AppContext/client/event contract changes are integrated by I; do not redesign Settings/navigation. |
| R — runtime/security engineer | `packages/runtime/`, except domain/shared contracts | Resource accounting, subprocess/crawler lifecycle, security and checkpoint integration support. Submit ToolRuntime changes to F. |
| Q — independent acceptance engineer | New Phase 1 fixture/e2e harness and evidence directory; review of others' tests | Real local effects, browser assertions, negative controls, artifacts, cross-platform/resource acceptance. Unit tests stay with their implementation owner. |

Workers are not alone in the checkout: never revert another worker's edits. Use separate read scopes and exclusive file ownership. Parallel agents report exact changed files and dependencies; I serializes central-file integration and prevents mixed contract versions. Do not create extra processes merely to appear parallel.

**Waves:** WP0 first. Then M/WP1, F/WP2 and R/WP6a can run independently; U begins existing-component work against frozen event contracts, E begins WP3. Integrate each package continuously. WP4 follows usable specialist adapters; WP5 is integrated alongside WP3/4, not deferred until the end. WP6b and WP7 exercise the integrated application. Dependent features proceed only after prerequisite gates pass; independent work may continue while live-provider authorization is blocked.

## WP0 — Baseline, contracts and evidence ownership (P0, owner I; Q reviews)

**Objective/current components:** record actual source/evidence baseline, inspect `NEXT_PHASE_IMPLEMENTATION_PLAN.md`, focused report/test, current production composition, contracts, domain evidence and durable stores. Do not regenerate already accepted runs just to increase test counts.

**Changes/files/contracts:** define the minimal execution-scope, inference-snapshot, criterion/check/revision and outcome contracts from target architecture. Reuse current goal/evidence, `OrchestrationTaskSpec`, `WorkerReport`, `VerificationCheck`, `TrustedCompletion` and product events. Publish a field/ownership map and exact delta to current types. Inspect existing persistence before any additive migration; assign unique schema versions centrally.

**Boundary/dependencies/parallelism:** prerequisite for shared-schema changes; no new framework/database/event store. Q can inventory assertions and build fixture inputs independently; I alone edits central contracts.

**Tests/browser:** existing affected contract parsers, schema migration preservation, scope decoding and event projection. Browser baseline screenshots at 2048×1159 plus one smaller desktop; distinguish fixture UI from active user DB. Do not read provider secrets or run live suites.

**Acceptance:** old persisted tasks/threads/settings/evidence still load; new fields backward-compatible; unknown historical provenance stays unknown; a shared contract version is agreed. Correct the focused report's scripted-autonomy, working-state assertion and process-tree claims without erasing historical evidence.

**Recovery/evidence:** if schema compatibility fails, stop dependents and fix the additive decoder/migration. Preserve pre-migration disposable DB copies. Evidence packet lists relevant source hashes, commands, assertions, limitations and baseline artifact IDs.

## WP1 — Exact inference and provider-aware admission (P0, M + I)

**Objective/current components:** every Main Chat/direct/delegated/resumed call uses its captured provider/model/effort; waiting is bounded and fairly accounted. Inspect Composer → AppContext → client → server → ModelResolver → codecs; scheduler, retry helpers, Governor model slots.

**Changes/files/contracts:** M implements the existing scheduler/admission port (`tryAcquire/release/subscribeCapacityChange`) and per-attempt scope described in target architecture; I wires the Governor once and supplies task/agent attribution. Dispatch is nonblocking and releases partial acquisitions before queueing. I forwards effort on every send and persists/reloads exact child snapshots. E consumes these contracts in WP3/4. Keep unsupported effort explicit; no automatic model switch. Fix Retry-After truncation and aggregate model-HTTP attempt budgets before adding policy knobs. Safe scheduling configuration uses existing provider repository/options; no Settings redesign or credential migration.

**Boundary/dependencies/parallelism:** depends WP0. M can work alongside F/R/U. Default concurrency is policy, not a claimed provider quota. One model queue; no permit held during cooldown or while waiting for a different permit. Keep answer/model streams bounded and action validation intact.

**Tests/browser:** injected transport bodies for duplicate model names, distinct roles, invalid selection, requested/effective effort, 429/503, numeric/date Retry-After above 60 s, streaming interruption and cancellation while queued. Use fake clock for long waits. Browser intercepts actual `/api/turns` and resumed task requests from existing/direct threads; assert exact request and resulting attribution, not just dropdown labels.

**Acceptance:** private and group specialists retain selections across approval/restart/Settings edits; invalid selection makes zero requests; provider queued state appears while unrelated local tools proceed; active model lease counts match admitted network attempts and settle correctly. No retry before server cooldown and no retry storms.

**Recovery/evidence:** on protocol unsupported/blank/filtered/auth failure preserve task evidence and report the correct failure category. Persist safe cooldown/deadline context only as necessary; restart must not replay completed tools. Capture redacted attempt/protocol/timing/usage metadata without prompts, reasoning, keys or endpoint query secrets.

## WP2 — One safe live project (P0, F; I integrates endpoints)

**Objective/current components:** actual project open/persistence, Explorer/editor and specialist operations share the same captured workspace and mutation safety. Inspect workspace manager/repository, watcher, server workspace routes, ToolRuntime and permissions.

**Changes/files/contracts:** unify existing canonical-path mutation locking across editor and agents, keeping hash preconditions and atomic operations. Reconcile watcher/own-write events and external edits with editor dirty state. Preserve create/read/write/search/rename/delete capabilities and confirmation; add a model-facing delete proposal only if required, bound to existing approved delete policy. Do not grant deletion via unrestricted shell commands. Use per-file effect/diff refs and current durable intent/result records for safe recovery.

**Boundary/dependencies/parallelism:** WP0; independent of inference implementation. F owns all `packages/tools` mutations; R submits required web-boundary patches. Never touch unrelated project files or broad dirty worktree state.

**Tests/browser:** real temp projects A/B, paths with spaces/Unicode, traversal/symlink/hard-link boundaries, editor/Cody simultaneous same-hash writes, independent-file edits, external file change and project switch mid-task. Browser verifies actual Explorer refresh, diff/save/conflict/delete confirmation and retained unsent content.

**Acceptance:** one competing writer succeeds and the other conflicts without data loss; independent files remain concurrent. Tasks keep submission-time roots after UI switching. Watchers show real final bytes once, not phantom duplicate changes. Denied operations leave zero changes.

**Recovery/evidence:** fail-before-mutation where possible; ambiguous prior effect is reconciled by hash/record, never blindly replayed. No automatic whole-project rollback. Record before/after hashes and bounded diffs of authorized fixture files; prove unrelated dirty bytes remain unchanged.

## WP3 — Role-correct direct and team specialists (P1, E; I/U integrate)

**Objective/current components:** Maestro/Cody/Doc/Scraapy/Tester behave as actual configured specialists through both entry modes. Inspect structured definitions, prompts, text/web workers, Cody/Tester loops and `specialist-communication.ts`.

**Changes/files/contracts:** one concise versioned behavior definition per identity using existing registry/parser. Make declared tools, instructions and completion policies role-correct. Direct conversation uses supplied-context text when adequate; derive task capabilities rather than forcing every Doc/Scraapy request onto web search. Add the narrow authorized document adapter/actions only where needed: local list/read/search, scoped documentation write/edit, web evidence and finish; no general code-write/run grant. Scraapy performs relevant discovery/extraction, not a mandatory component-demo search. Tester stays read-only. Preserve native protocols and current action validators.

**Boundary/dependencies/parallelism:** WP0/1/2 for final integration. E owns role/action source; U can build direct views against agreed contracts. No Vision/Dessy/Weby/CLI/Termi work; no second personality or conversation registry.

**Tests/browser:** same controlled model with distinct roles must receive different real instructions/capabilities; disallowed role actions are denied. Direct Cody performs a local edit; Doc drafts/applies approved documentation; Scraapy extracts a local served authoritative fixture; Tester executes read/check only. Check each selected model/effort. Browser tests switch roles while work runs and preserve drafts, scroll and private scope.

**Acceptance:** actual role artifacts/evidence persist, direct history stays distinct from team participation, a conceptual Doc question performs no unnecessary search, and an authorized group finding reaches a peer during execution without exposing private messages.

**Recovery/evidence:** missing tool/model yields blocked work rather than decorative status. Existing 12/task and 6/specialist communication budgets, 2 requests/specialist, depth guard, 4 KB injection and bounded waits remain or become stricter. Record publish/delivery/consumption refs and actual follow-up tools; model acknowledgment alone is insufficient.

## WP4 — Criterion-bound verification and one repair (P0 policy / P1 delivery, E + I)

**Objective/current components:** mixed and single task success means the requested current artifacts were verified. Inspect mixed Tester wrapper, automatic Tester path, single-Cody recovery, Tester assertion provenance and `completion.ts`.

**Changes/files/contracts:** separate worker settlement from verification verdict. Propagate failed/blocked/unverified Tester reports; bind each supported criterion to check invocation IDs and candidate hashes. Promote verified evidence only after preserved post-revision checks succeed. Resolve automatic Tester's own saved configuration/scope/permissions. Single-child recovery must prefer saved selection, and durable errors must not be silently swallowed.

Add one bounded LangGraph repair continuation when actual independent checks fail; send precise bounded failure evidence to Cody, preserve unaffected siblings, then schedule Tester against the new revision. No generic recursive self-improvement loop. Conflicting findings become explicit unresolved criteria; a blocked prerequisite cannot be presented as completed.

**Boundary/dependencies/parallelism:** contracts WP0; production integration requires WP1/2/3. E serializes its shared `maestro/index.ts` work; I owns central storage/composition changes. Existing checkpoint/outcome records are reused.

**Tests/browser:** unrelated exit-zero command cannot certify a fabricated assertion; failed/unverified Tester report cannot satisfy goal; edit-after-check invalidates old proof. Positive/negative fixture checks through `/api/turns`, one repair/recheck, exhaustion, read-only completion and truthful partial synthesis. Browser displays actual check, revision/result, repair state and final verdict; no fake “verified” badge.

**Acceptance:** all required criteria supported on final revision or an accurate non-success/partial outcome; original tests remain green; no duplicate completed side effect; successful sibling evidence survives model/synthesis failure.

**Recovery/evidence:** interrupted repair resumes from durable state and original snapshots. Ambiguous check/process state stays unknown pending reconciliation. Store check stdout/stderr/exit or launch error as bounded redacted evidence, explicit supported/unverified criteria and before/after artifact hashes.

## WP5 — Unified execution-centered experience (P1, U + I)

**Objective/current components:** Main Chat and individual Mediobot pages expose one coherent execution history. Inspect `ThreadView`, `timeline.ts`, existing activity/tool/diff/approval components, specialist history, `EmptyState`, AppContext and durable SSE projections.

**Changes/files/contracts:** hierarchical parent/child activity groups using existing UI style, expandable real inputs/results, current action/status, artifacts, checks, approvals and recovery. Use explicit direct-private versus team scope in conversation indexes. Replace regex-based collaboration refresh with structured identity/status fields. I handles shared reducer/client/server changes; U owns presentation. Preserve existing per-bot drafts/scroll and exact model/effort controls. Stable keys prevent remount/flicker.

**Boundary/dependencies/parallelism:** starts after WP0 with existing events and proceeds alongside WP1–4; final gate requires their integrated states. No unrelated navigation, Settings or visual-system redesign; no invented model narration. Do not add virtualization unless a measured long-history failure requires it.

**Tests/browser:** open running application at 2048×1159 and smaller desktop; assert each real child is distinguishable, shows current action/tool result and updates while active. Expand failure and verification details; approve/pause/resume/cancel; switch project/bot and reconnect with Last-Event-ID. Assert no duplicate events, scope leakage, draft loss or stale action after termination.

**Acceptance:** every visible claim corresponds to a durable event/evidence ref; the same task agrees across Main Chat/direct views/history after reload; private conversations remain private. Live activity and waiting states are readable without oversized empty greetings or overlapping composer content.

**Recovery/evidence:** malformed/old events are rejected or handled backward-compatibly without erasing newer live state. Capture timestamped screenshots and relevant DOM assertions plus replay/event IDs; screenshots alone cannot prove timeline content or correct task state.

## WP6 — Security, recovery and resource efficiency (P0 safety + P2 hardening, R; F/M/I collaborate)

**Objective/current components:** existing safety fixes survive real integrations on ordinary laptops. Inspect crawler pinned backend/context, cancellation protocol, retained leases, subprocess supervisor, Governor/telemetry and SQLite checkpoint/approval recovery.

**Changes/files/contracts:** reproduce only current residual failures before editing. Enforce address-bound HTTP and browser-subresource requests including redirects; no permissive fallback when pinned context is absent. Avoid unsafe shared crawler hook/context reuse. Cancellation acknowledgment must match request and actual cleanup; pending cleanup retains reservation until confirmed settlement/termination, with a defined safe cleanup path rather than a permanent silent leak. Keep protocol reader responsive. Persist enough state for task/approval recovery without recreating completed effects.

Separate backend RSS from owned process-tree RSS/system RAM, account admitted model calls, bound browser/subprocess/context/event retention and freeze a tested Python dependency resolution. Keep current budgets unless evidence justifies change. Do not install unreviewed scripts/dependencies or disable TLS/sandboxing.

**Boundary/dependencies/parallelism:** WP6a source/local safety work can run after WP0 alongside WP1/2; WP6b integrated recovery depends WP4/5. R does not modify ToolRuntime or ModelResolver ownership areas directly. Vision runtime/architecture stays untouched.

**Tests/browser:** local DNS-rebinding/redirect/subresource probes with zero denied connections, cancellation-resistant cleanup over five seconds plus unaffected sibling, crash between effect/result record, pending approval restart, long-history responsiveness and repeated task soak. Browser verifies pending cleanup and recovered approvals accurately. Windows/macOS command/path/tree-cleanup behavior must be tested on each actual OS.

**Acceptance:** no unsafe network fallback or duplicated effect, no verified-before-cleanup release, no lost user data, no hidden orphan processes. Reference-task resource targets from architecture are measured explicitly; no false whole-app RSS claim.

**Recovery/evidence:** unsafe or ambiguous external operation remains blocked/pending review; do not release quota merely to clear an indicator. Save process IDs/exit confirmations, leases/timestamps, relevant hashes and OS/runtime/browser versions with secrets redacted. Windows unavailable means BLOCKED for Windows, not PASS.

## WP7 — Integrated reference workflow and release review (P1/P2, Q + I)

**Objective/current components:** complete one useful user request through the existing application, then a variation proving the implementation is not prompt-specific. Use the notes CLI task in the acceptance matrix, current server startup command and isolated SQLite/disposable workspace fixtures.

**Changes/files/contracts:** add one focused integrated acceptance harness and immutable evidence packets; reuse existing tests instead of inventing another runner. Controlled providers may propose actions, but all filesystem/terminal/evidence/message/UI behavior must execute genuinely. Do not stub verification verdicts or tool results. Fixed failures belong in negative controls, explicitly labeled.

**Boundary/dependencies/parallelism:** depends all local gates. Q reviews independently rather than changing production code to weaken assertions. I integrates and repairs through the owning worker; no mass speculative refactor. Live-provider work remains separately gated under the $0 limit.

**Tests/browser:** run critical unit/contract/security checks, integrated API/UI workflow and variant, relevant regressions, typechecks and production build. Audit test commands first for live-model/public-web opt-ins; use loopback-only controlled tests and reviewed egress restrictions rather than blindly invoking broad scripts that search publicly. Real source retrieval/model use is labeled separately.

**Acceptance:** every required matrix row has evidence or explicit BLOCKED status. Local Phase 1 is not final live-model/production readiness. A broken candidate must fail; a valid candidate must pass; one authorized repair must recheck the changed revision. User-visible final claims match durable evidence.

**Recovery/evidence:** diagnose and repair genuine failures incrementally. If a gate is environmentally blocked, record exact command/error and continue unrelated packages; do not retry expensive failures repeatedly. Stop at true security/architecture/external authorization gates.

## Evidence packet, commands and same-day priorities

Use `docs/architecture/antigravity/evidence/phase1/<run-id>/`: source manifest for relevant non-secret files (HEAD alone is insufficient in this dirty repo), OS/Node/Python/browser versions, command/status/duration, scoped DB snapshot/schema, sanitized request metadata, event IDs/sequences, assignment/operation intervals, messages/evidence refs, artifact hashes/check results, lease/process settlement, CPU/RSS samples and screenshots. Never collect `.env`, credential databases, keys, hidden reasoning or entire private prompts. Include an assertion-to-evidence map; do not write success booleans unconditionally.

Existing commands: `pnpm dev`; `pnpm typecheck`; `pnpm --filter @mediobot-v2/command-center build`; `pnpm test:ui`; package-specific tests and reviewed selected runtime/e2e files. Do not start a duplicate server or assume ports; use current repository startup output/health checks. Do not run model/manual-research commands without required authorization. Every process started for acceptance must terminate or be explicitly handed over.

Today's critical path is WP0 → WP1/WP2 plus WP4 verification seam → WP3/5 integrated workflow → WP6b/WP7. Defer optional long-history optimization/document-export polish before correctness. If time expires, stop claiming completion, preserve working work and list exact unfinished gates. Do not lower verification, security or live-model standards to meet the date.
