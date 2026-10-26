# Remaining defects — independent fix verification, 2026-10-28

Compared current source with `INDEPENDENT_IMPLEMENTATION_AUDIT_2026-10-27.md` and inspected relevant test assertions and tracked diffs. Most application/fix files are still untracked, so Git cannot provide an isolated Antigravity before/after patch. Findings below are current-source findings, not attribution of individual edits.

**Executed:** six injected-fetch tests in `packages/models/tests/empty-response-diagnostics.test.ts` passed; no external calls. A Python standard-library probe reproduced pending cancellation cleanup after `asyncio.wait` timed out (`pending=1`, `task.done()=False`). All other findings are static inspection; no crawling, browser or provider acceptance run.

## P0 — Validated DNS is not bound to connections

`packages/tools/src/index.ts:1436–1469`, `validateWebDestinationAsync`, returns the URL after lookup, not an address-bound connection. `packages/runtime/src/crawl4ai_worker.py:169–185` similarly discards validated addresses. HTTP request hooks (`:253–264`) and browser `page.route` (`:493–510`) then continue hostname-based requests, letting HTTPX/Chromium resolve again. Redirect checks therefore also retain the DNS check/use race. A public answer during validation followed by a private answer during connection can bypass the boundary; zero connections to denied targets is **not established**.

**Minimum correction:** bind each actual connection to validated addresses while preserving hostname/TLS validation; revalidate redirects and apply the same enforced boundary to browser subresources. Until browser connections can enforce that boundary, fail closed for affected requests. Do not equate preflight lookup or a route callback with DNS pinning. The shared crawler's per-request `set_hook` also captures an authorization list: isolate that hook/context per operation so concurrent crawls cannot overwrite each other's policy.

**Acceptance:** controlled resolver changes its answer between validation and connection; initial, redirect and browser-subresource denied servers record zero connections. Concurrent crawls with different allowed origins must not share authorization. Current `subresource-ssrf.test.ts` checks literal loopback targets, not rebinding or policy crossover.

## P1 — Cancellation falsely reports settlement and releases leases early

`packages/runtime/src/crawl4ai_worker.py:817–826` ignores the `(done, pending)` result of `asyncio.wait(..., timeout=5.0)` and unconditionally returns `settled: true`. Pending cleanup is possible; the local probe confirmed the underlying asyncio semantics using a shorter timeout.

`packages/runtime/src/crawl4ai-runtime.ts:690–727`, `sendCancelAndAwaitSettlement`, ignores acknowledgment data and resolves on timeout, rejection, write error or unavailable stdin. `crawl` releases the browser lease in `finally` (`:448–451`). Thus even correcting Python's boolean alone would not retain reservations until cleanup completes. Python also awaits cancellation in its input loop, delaying other control requests while that wait runs.

**Minimum correction:** acknowledge actual completion, return pending/unknown honestly, validate acknowledgment identity/state, and retain operation reservations until confirmed cleanup or confirmed supervised termination. Use bounded task-scoped cleanup without terminating unrelated work; keep the protocol reader responsive.

**Acceptance:** cancellation-resistant cleanup longer than five seconds keeps its lease; timeout/missing/error acknowledgment cannot mark cleanup complete. Assert socket/page closure before release and an unaffected sibling. `cancellation-settlement.test.ts` uses a fixed 100 ms delay and checks caller rejection/release, not cleanup acknowledgment or socket/page termination; it does not prove this invariant.

## P1 — Exact routing still incomplete across decision paths

- `packages/maestro/src/index.ts:1370–1380` resolves assignment-specific Cody decisions, but the separate single-`delegate` path still calls the parent-created `codyAdapter` at `:1820`. That path's durable child submission (`:1738` onward) also omits the child's model selection. Correcting `composition.ts.resolveSelection` and the mixed-assignment path does not fix this entry point or its recovery.
- Tester passes parent `context.options` to `prepare` at `index.ts:1169–1171`, rather than the resolved `testerOptions`. `packages/tester/src/agent.ts:274,500` prefers that explicit parent effort over its selected-client default, allowing Maestro's effort to override Tester's.
- Tester's missing-selection branch (`index.ts:1148–1151`) references `task`, `assignment` and `worker` before their `const` initialization (`:1162–1166`): the intended blocked result instead throws. `parsedTesterSelection.reasoningEffort` at `:1156` also assumes selection exists when no decision resolver is supplied.

**Minimum correction:** reuse one child-selection/resolved-adapter path for single and mixed delegation and resume; persist it before execution. Pass Tester its child options and build a safe blocked result without accessing uninitialized records. Keep exact model IDs and validated effort; no fallback selection.

**Acceptance:** intercept encoded requests through `/api/turns` for single/mixed Cody, web-backed Doc/Scraapy and Tester, with distinct providers/models/efforts; repeat after restart/approval recovery and Settings edits. The new `agent-model-routing-production.test.ts` injects `createClient.complete`, checks Cody/Doc values and stored Cody selection; it does not cover Scraapy, active Tester effort, encoded provider effort or restart. Effective reasoning support cannot be inferred from the request object's preference alone.

## P2 — Diagnostic metadata is not fully bounded/sanitized or retained

`packages/models/src/index.ts:765,999,1059,1095` copies provider-controlled `finish_reason` directly into diagnostics. Its TypeScript string type is not runtime validation; an unexpected large/sensitive string can enter the supposedly sanitized diagnostic object. Allowlist finish reasons, map unknown values to a fixed category and cap all retained identifiers. Existing tests demonstrate ordinary blank/reasoning-only/filter/truncation cases without leaking their sentinels; they do not test hostile metadata.

`packages/cody/src/agent.ts:456–464` projects only generic provider/timing fields, dropping the new parse outcome/count metadata; composition logs that reduced projection. Detailed classification attached to `ModelProviderError` is therefore not proof it survives the production diagnostic path. Retain only the bounded allowlisted diagnostic fields through the existing event/log boundary.

**Acceptance:** hostile finish-reason/identifier sentinels never appear verbatim; actual Cody/Maestro failure diagnostics retain classification/counts without prompts, raw content, reasoning or credentials. The six passing transport fixtures do not establish production diagnostic retention or the cause of any historical empty response.
