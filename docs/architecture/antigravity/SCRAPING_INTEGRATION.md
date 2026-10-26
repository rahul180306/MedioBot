# Existing search/crawling integration — implementation guide

Source audit: 2026-10-26, current dirty worktree. No network calls, dependency installation or runtime tests performed. Paths are repository-relative.

## Current state and confirmed defects

| Status | Source / behavior |
| --- | --- |
| Working in source | `apps/command-center/src/composition.ts`, `createComposition`, creates one shared `Crawl4AiRuntime`, passes it to ToolRuntime and Maestro. |
| Working in source | `packages/maestro/src/index.ts`, `MaestroExecutionAdapter`, capability-aware executor routing; `web-workers.ts`, `WebAgentExecution.definitionIds`/`execute`, implements Scraapy, Doc and Research search → relevance filter → bounded crawl → report and authorized peer/group findings. |
| Working in source | `web-workers.ts`: `buildSearchQuery`, `searchCandidateRejectionReason`, `filterRelevantSearchItems`; `packages/tools/src/index.ts`: `runWebIntelligence` handles `web.search`, `web.crawl`, `web.doc`; contracts live in `packages/contracts/src/web-intelligence.ts`. |
| Partial | `packages/runtime/src/crawl4ai_worker.py`, `handle_discover`, combines curated React/GSAP/component sources with DuckDuckGo and reports `providerStatus`, including challenge. This is not an exhaustive discovery service. Candidate snippets are not retrieved-page verification. |
| Confirmed permission gap | WebAgentExecution directly calls the crawler and manually emits tool events. ToolRuntime's web branch also returns before the ordinary `permissionEngine.requestApproval` path; `validateWebContext` checks world/active worker/task ownership only. Routing via ToolRuntime alone will not fix web authorization. |
| Confirmed resource gap | `crawl4ai-runtime.ts`, `crawl`, acquires browser admission only for explicit `renderJs=true`/selector. Python `handle_crawl` can fall through to Chromium after HTTP failure/empty content even with `renderJs=false`; fallback can therefore start a browser without matching admission. |
| Confirmed recovery/cache gaps | `Crawl4AiRuntime.sendRequest` rejects/removes the pending caller on abort/timeout but sends no operation cancellation to Python. `crawl` lowercases the entire URL as a global cache key, collapsing case-sensitive paths and extraction variants; cache lookup precedes abort checking. |
| Confirmed portability gap | `detectPythonBinary` searches POSIX `.venv/bin/python` and a developer-specific absolute path, then `python3`; Windows `.venv/Scripts/python.exe` is not searched. |

No successful direct crawl proves unknown-source discovery. Source inspection does not establish current public-search availability or verified model-authored research.

## Minimal implementation

1. Reuse existing web contracts/runtime. Add web authorization to the existing ToolRuntime/permission policy: active specialist capability, bound task/workspace, destination policy and cancellation. Validate HTTP(S), unsafe/private destinations and redirects consistently; external content remains untrusted. Do not grant broader network authority from a model assignment.
2. Route WebAgentExecution calls through that authorized tool entry, retaining role limits, actual results and child identity. Remove duplicate manual lifecycle emissions only after one invocation has one canonical event sequence. Keep capability-aware text/web routing and parallel specialists.
3. Preserve challenge/empty/unavailable distinctions in adapter reports and final evidence. Track query, candidate rejection, selected/final URL, extraction backend/status, bounded excerpt and evidence reference. Known authoritative URLs should use the authorized retrieval path directly instead of relying on rediscovery.
4. Keep candidate-only discovery explicitly unverified. Claim page-supported findings only after meaningful relevant extraction; do not mark tests/code behavior verified from a web report. Keep prompt-injection flags, attribution and bounded report content.
5. Make browser escalation explicit and Governor-admitted; lack of admission returns a truthful bounded failure or HTTP-only result. Do not secretly launch Chromium after `renderJs=false`.
6. Correct cache identity using normalized scheme/host, preserved path/query and extraction options; authorize/check cancellation before cache reads. Determine task/workspace partitioning needed for private content. Keep bounded LRU/TTL storage.
7. Add request-scoped Python cancellation/settlement using the existing JSON-line worker protocol. Never kill the shared worker to cancel one specialist. Until confirmed, report caller cancellation separately from external-operation termination. Add platform-correct interpreter discovery; remove developer-specific paths.

## Acceptance and safety

- Extend `packages/maestro/tests/web-intelligence-orchestration.test.ts`, `capability-routing.test.ts`, `packages/runtime/tests/crawl4ai-runtime.test.ts`, `test_crawl4ai_search.py`, and existing web ToolRuntime tests. Use local HTTP fixtures and injected search responses.
- Separately prove unknown-source discovery, known Node.js URL retrieval, unrelated React/GSAP rejection, challenge reporting and empty results. Candidate-only reports must not claim verified extraction.
- Exercise actual Scraapy/Research/Doc adapters concurrently; assert tool calls/results, overlap, correct event attribution, permissions denied before network, peer evidence and truthful failure isolation.
- Test HTTP→browser admission, redirect denial, case-sensitive URLs/options, abort on cache hit, cancellation with a sibling active and lease release. Record bounded RSS/CPU for HTTP-only versus admitted browser extraction.
- Existing `pnpm --filter @mediobot-v2/command-center research:manual` uses live public search/crawl plus a deterministic report client: it is **not** real-model acceptance. Review network authorization before running it; do not use its ToolRuntime-without-permission setup as production policy.
- Reuse current Python requirements and lazy worker/idle shutdown; no new scraping framework/service. Validate interpreter, subprocess cleanup and browser availability on Windows/macOS separately. Any broader network-permission policy change requires security review.
