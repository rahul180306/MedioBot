# Independent implementation audit — 2026-10-27

**Verdict: PARTIAL; production acceptance unsupported.** Inspected current dirty-worktree source and test assertions. No tests executed, network/provider requests made, or application files changed. References below are repository-relative; line numbers identify this snapshot.

**Missing evidence:** `master_verification.ts` was not found by filename search throughout the MedioBot parent workspace (including ignored files, excluding dependencies/Git), `/tmp`, or the Antigravity artifact directory; Spotlight returned no match. Its source/output must be supplied before its literal PASS claims can be independently judged. Do not treat the observations below as verification of that missing script.

## 1. Parallelism: implemented scheduling, incomplete production proof

- **Confirmed working mechanism:** `packages/maestro/src/langgraph-engine.ts:341–350`, `runParallel`, fans out ready assignments through multiple LangGraph `Send` operations; dependencies gate readiness. `packages/maestro/src/index.ts` invokes it per specialist assignment. This is real asynchronous concurrency support, not merely sequential work labeled parallel.
- `packages/maestro/tests/langgraph-engine.test.ts:9–48` measures overlapping controlled callbacks and completed-outcome preservation after sibling failure. Such callbacks prove scheduler overlap, not autonomous model decisions, real tool concurrency, or production UI behavior.
- `packages/models/src/scheduler.ts:52–61` now honors explicit connection/type limits or the default; the former NVIDIA-name serialization heuristic is removed. This is a source change, not evidence that any account supports increased concurrency. Governor task admission and provider request admission remain separate constraints.
- **Required correction/evidence:** retain LangGraph and existing Governor. Extend a controlled `/api/turns` case using production composition, two actual disposable local tool operations, one dependent assignment and bounded barriers. Assert positive interval overlap, dependent start after prerequisite end, provider queue/admission timestamps, child task/agent/tool attribution in durable SSE replay, and released leases after cancellation. Do not accept UI row order, `Promise.all` alone, or elapsed-time estimates as proof. Live autonomous acceptance remains unverified.

## 2. P1 — Cody's configured model can differ from its actual inference model

**Confirmed defect, high confidence:**

1. `apps/command-center/src/composition.ts:255–268`, `decisionResolver.resolveDecisions`, resolves one client from the supplied task selection and constructs Maestro/Cody/Tester decision providers from that client.
2. `packages/maestro/src/index.ts:889–897`, `MaestroExecutionAdapter.execute`, resolves this bundle from **parent** options and constructs `codyAdapter` immediately.
3. The Cody branch resolves/persists the specialist override later (`index.ts:1174–1207`), then passes the correct child selection/effort to that already-constructed adapter (`:1339–1347`). Changing adapter options does not replace its captured decision client.

Consequently, correct SQLite metadata or UI selection is insufficient proof of Cody routing. Parent-client construction itself is not universally wrong; reusing it for a differently configured child is the defect. Tester has a later assignment-specific resolver call (`index.ts:1134`); verify that path separately rather than assuming identical behavior.

**Partial improvements:** `state/agentModelRouting.ts`, server `/api/turns` validation (`server.ts:1552–1586`), and `text-workers.ts`/`web-workers.ts` now carry per-specialist `reasoningEffort`. However, `composition.ts:119–130`, `resolveSelection`, strips it from selection records; child submission/resume paths using this helper can lose embedded effort. Missing assignment overrides still permit parent inheritance through `resolveDurableChildModelSelection`. `packages/models/src/index.ts:594–596` silently omits unsupported native effort values; prompt guidance does not prove effective provider reasoning settings.

**Minimal correction:** construct Cody decisions only after resolving the durable child configuration; use the existing resolver and adapter, without changing organizational architecture. Preserve validated effort through submission/recovery and expose requested/effective/unsupported effort explicitly. Model-backed specialists without an explicit valid selection must block rather than inherit accidentally.

**Acceptance:** intercept actual transport requests from production `createComposition` and `/api/turns`; use distinct Maestro/Cody/Doc/Tester provider/model identities and efforts, including identical display names. Assert initial, repair, responder, continuation and final synthesis requests; repeat after checkpoint/approval recovery with Settings changed. Missing/disabled selections make zero requests. `tests/runtime/agent-model-routing.test.ts` currently tests UI helper values, not this composition defect.

## 3. P0 — SSRF protection remains incomplete

**Confirmed gaps:** `packages/tools/src/index.ts:1260–1279`, `validateWebDestination`, checks textual hosts without DNS resolution. Its loopback check misses the wider `127.0.0.0/8` range and bracketed IPv6 forms; private IPv6/mapped addresses and public-looking names resolving privately are not comprehensively checked. `NODE_ENV=test`/`ALLOW_LOCAL_SCRAPING` broadly bypass local restrictions, rather than expressing task-scoped authorization.

`packages/runtime/src/crawl4ai_worker.py:164–189` checks HTTP destinations in a **response** hook, after a request has reached that URL. It omits `is_private`/`is_loopback`, performs no DNS binding check, and is not a browser subresource policy. The browser path (`:368` onward) does not establish equivalent destination enforcement. Blocking a response after receipt does not prevent SSRF.

**Minimal correction:** enforce the existing network permission boundary before connection, on every redirect and browser request/subresource, using resolved IPv4/IPv6 addresses and connection-consistent resolution. Deny metadata/link-local/private/loopback destinations unless a specific local task authorization allows the exact destination. Preserve external-content distrust; no framework replacement.

**Acceptance:** local/injected network fixtures covering DNS-to-private, rebinding, redirects, IPv6/mapped IPs, alternate loopback addresses and Chromium subresources. Assert denied targets receive **zero connections**. Allowed local tests need explicit scoped permission, not a global test-mode bypass.

## 4. P1 — Crawl4AI integration improved; termination is not yet proven

- **Present:** production composition shares `Crawl4AiRuntime`; `WebAgentExecution.execute` now uses ToolRuntime when supplied (`web-workers.ts:393,510`). `ToolRuntime.runWebIntelligence` invokes `permissionEngine.requestApproval` (`tools/src/index.ts:1142–1161`). Optional direct-crawler branches remain (`web-workers.ts:456,578`); prohibit these in production or explicitly restrict them to isolated tests.
- **Present:** runtime sends `allowBrowser` according to admission (`crawl4ai-runtime.ts:226–264`); Python refuses escalation when not admitted (`crawl4ai_worker.py:345–365`). URL path case/options cache handling and pre-cache abort checks improved. These do not establish complete browser quota/cancellation acceptance.
- **Confirmed settlement gap:** TypeScript sends cancel then immediately rejects/removes the original pending request (`crawl4ai-runtime.ts:568–592`); it does not await acknowledgment or operation settlement. Python calls `Task.cancel()` and acknowledges that a cancellation was requested (`crawl4ai_worker.py:673–681`), not that browser/network cleanup finished. The caller can release its browser lease while underlying work is still unwinding.
- Cache identity (`buildCrawlCacheKey`, runtime `:54`) still omits `waitForSelector` and workspace/authorization scope. Different extraction requirements or private scopes need an explicit isolation policy.

**Acceptance:** one slow operation and one unaffected sibling; cancellation acknowledged, original operation settled, listeners/timers cleaned, then lease released. Verify no later network/tool side effects. Test deny-before-network, browser admission rejection and exactly one attributed tool lifecycle. Keep process/resource overhead bounded and verify Windows/macOS separately.

## 5. Empty model responses: symptom proven in code, historical cause unknown

`packages/models/src/index.ts:803–805,906–910` rejects absent/blank action content; native tool-call and parsed-schema branches are handled separately. Length truncation is explicitly classified (`:735,871`). Streaming `reasoning_content` is declared but is not accumulated as executable content (`:717–743`); a reasoning-only response can therefore produce the empty-content error, but **no inspected trace proves that happened in the reported failure**. Do not execute hidden reasoning as an action.

Wrong-model routing above is a proven implementation defect, not proof of the empty response's cause. Output-budget exhaustion, provider filtering, model behavior and transport interruption remain hypotheses without the exact sanitized response/timing record.

**Acceptance/correction:** capture bounded metadata only: actual resolved model/protocol, HTTP status, finish reason, content/reasoning character counts, tool-call count, parse outcome, TTFB/TTFT and total duration. Fixture-test blank, reasoning-only, filtered, truncated, malformed and interrupted responses plus valid content-null/tool-call output. Preserve completed tools/findings; retry only bounded safe reasoning, never completed side effects. Do not increase timeouts or switch providers based solely on this symptom.

## PASS claims that the inspected tests do not justify

- `packages/runtime/tests/crawl4ai-runtime.test.ts:20–27`: asserts caller rejection, not Python cancellation acknowledgment, external settlement, listener counts or sibling survival; shutdown afterwards cannot prove cancellation isolation.
- Same file `:49–76,99–130`: uses `raw:` HTML; proves extraction/cache and worker supervision, not HTTP discovery, real Chromium admission, redirects or SSRF defense. Zero browser leases before/after a raw-memory operation is not quota proof.
- Same file `:30–46`: GSAP/React discovery can succeed from the curated knowledge base; it does not prove live search-provider discovery.
- Model-selection helper assertions and controlled parallel callbacks are useful but cannot justify full production routing or real-model PASS. No test suite was run in this audit; historical pass counts were not revalidated.

**Correction order:** SSRF boundary → child inference configuration → acknowledged cancellation/resource settlement → production-path evidence and empty-response diagnostics. Preserve LangGraph, UI, permissions, dirty worktree and exact configured models. Live-provider acceptance remains pending separate authorization; do not label the missing master verification script or this static audit PASS.
