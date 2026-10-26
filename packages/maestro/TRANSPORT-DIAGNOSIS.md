# Real-provider acceptance: external DNS blocker

Status on 2026-10-08: **NOT PROVEN**. Production architecture was not changed. Provider attempts stopped after establishing the external blocker.

## Cause and evidence

The generic MiniMax `transport` failure was reproduced using the real application Maestro entry point, the normal registry, and the native OpenAI-compatible client. A test-only wrapper forwards the exact native fetch arguments unchanged and logs only fixed error codes, safe identifiers, host, stages, status, and timing.

Resolution succeeded for:

- Config source: default production application store, opened read-only.
- Provider connection: `dahl`.
- Model: `MiniMaxAI/MiniMax-M2.7`.
- Connected/enabled/text-capable checks: passed.
- Normal credential resolution: passed; no credential values were inspected or printed.
- Host: `inference.dahl.global`.
- JSON mode and system-role support: true, matching the normal provider adapter.

Native fetch then failed **before any HTTP response**, with cause code **ENOTFOUND**, after **7.704166 ms**. The application adapter translated that error into its existing safe `transport` category. No HTTP status, response JSON, structured model output, or Maestro decision was received. This was not a model capability rejection, a provider HTTP authentication rejection, rate limiting, or a model inference timeout.

Independent credential-free DNS checks:

| Host | System lookup | Direct DNS query |
| --- | --- | --- |
| inference.dahl.global | ENOTFOUND | ECONNREFUSED |
| integrate.api.nvidia.com | ENOTFOUND | ECONNREFUSED |
| example.com (control) | ENOTFOUND | ECONNREFUSED |

This establishes DNS unavailability in the current execution environment across both providers and an unrelated control. It does not prove a provider outage or identify the underlying host/sandbox DNS policy. The environment is network-restricted, but no outside-sandbox comparison was made. The original run discarded its native cause, so the historical low-level error cannot be recovered; the current reproduction establishes the concrete failure stage now.

No repeated provider attempts or alternative-model inference followed this diagnosis. The single diagnostic request could not resolve its host and obtained no provider response.

## Product path versus harness

| Stage | Product | Acceptance/diagnostic harness | Finding |
| --- | --- | --- | --- |
| Database selection | LocalDatabase → getDatabasePath → application data directory | Explicit read-only DatabaseSync at application store | Same default production path; test temporary directory deliberately avoided |
| Override | MEDIOBOT_DATA_DIR or explicit server database option | MEDIOBOT_DATA_DIR when set | Current diagnostic used default store; a separately running UI process's overrides were not inspected |
| Provider and credentials | ProviderRepository with SqliteCredentialStore | Same classes/default credential mechanism | Resolver succeeded; no credential extraction |
| Selection | Explicit providerConnectionId + modelId | Explicit `dahl` + `MiniMaxAI/MiniMax-M2.7` | Identity preserved, no display-name lookup/fallback |
| Capability gate | UI preflight resolveTextClient; Maestro dom-reasoning | Composition Maestro dom-reasoning; text workers text-inference | Both operation gates require text; no model-specific worker binding |
| Base URL | Connection URL or catalog default | Same ModelResolver | Resolved host confirmed |
| Headers | Repository resolves stored custom headers; resolver passes them to client; client adds content type/Bearer auth then custom headers | Same code | No acceptance-specific headers or credentials; header values not logged or manually inspected |
| Model in body | Client sends `model: this.modelId` from resolver options | Same client and options | Model ID remains exactly the selected registered ID |
| Request | Native structured client; same timeout/messages/JSON mode/role adaptation | Same client; diagnostic fetch wrapper forwards input/init unchanged | No direct credential-bearing HTTP proof script |
| Response | Native fetch → HTTP check → JSON/choices/content → structuredJsonOnly → Maestro validation | Same path | Never reached response stage |

A previously successful UI run is consistent with a different network execution context or time, but it does not prove current UI connectivity. No UI browser was opened and no live UI process configuration or networking was measured. Therefore there is no demonstrated application-code/configuration divergence to repair. The established blocker is DNS in this execution environment.

## Real acceptance results

| Mediobot / phase | Selected provider/model | Real result | Inference start/end |
| --- | --- | --- | --- |
| Maestro diagnostic | dahl / MiniMaxAI/MiniMax-M2.7 | FAIL before HTTP response: ENOTFOUND | No inference interval; fetch failed after 7.704166 ms |
| Cody single worker | Not dispatched | NOT REACHED | Not available |
| Research | Not dispatched | NOT REACHED | Not available |
| Tester | Not dispatched | NOT REACHED | Not available |
| Two-worker execution | Not dispatched | NOT PROVEN | No common interval |
| Three-worker execution | Not dispatched | NOT PROVEN | No common interval |
| Heterogeneous execution | Not dispatched | NOT AVAILABLE from this environment | No common interval |
| Real Maestro synthesis | Not invoked | NOT REACHED | Not available |

MiniMax: native request blocked by DNS. DiffusionGemma: provider hostname also fails DNS; no model call attempted. **Real overlap: NO proof.** No timestamps or successful WorkerReports were fabricated. No live failure-isolation check was run; deterministic isolation coverage remains passing.

## Validation and scope

- Models: 32 passed.
- Maestro: 43 passed, including shared text-worker concurrency/isolation/report tests.
- Application parallel composition and direct-conversation regressions: 4 passed. Direct conversation still creates zero execution identities.
- Focused deterministic regression total: **79 passed** in this continuation.
- HTTP registry suite: run once; **3 passed, 11 failed due to local listen EPERM**. These eleven are environment-blocked, not validated successes. No approval request or repeat run.
- Live transport diagnostic: **0 passed, 1 skipped**, with safe native failure diagnostics. A skipped diagnostic is not real-model acceptance.
- Workspace typecheck: passed.
- Production build: passed; existing large-chunk warning unchanged.
- `git diff --check` and authored-file whitespace checks: passed.

Changes in this continuation: one opt-in test-only diagnostic harness and documentation. No production provider/model/runtime/worker code changed. No Vision work, UI redesign, Auto routing, recovery, persistence, self-improvement, or autonomous reassignment was added.

## Next action and manual UI acceptance

Restore DNS/network access for the execution environment, then rerun the diagnostic once. Do not rewrite orchestration to address DNS failures.

From the repository root:

```sh
MEDIOBOT_DIAGNOSE_TRANSPORT=1 MEDIOBOT_ALLOW_PROD_DB=1 MEDIOBOT_DIAGNOSTIC_PROVIDER=dahl MEDIOBOT_DIAGNOSTIC_MODEL=MiniMaxAI/MiniMax-M2.7 node --experimental-strip-types --test apps/command-center/tests/runtime/provider-transport-diagnostic.test.ts
```

Only after connectivity succeeds, execute the requested staged acceptance: one real shared text-worker assignment, two independent workers with positive common inference interval, then three workers, then heterogeneous providers if available. Review the real Maestro synthesis against each specialist's contributions. The older parallel acceptance harness starts with three specialists and is not a substitute for this staged proof.

After backend staged acceptance succeeds, in the unchanged UI:

1. Select a connected text provider/model by its existing model picker; submit `Hi` and confirm a direct response without worker activity.
2. Submit: `Design a small in-memory rate-limited job queue for one Node.js process. Limit job starts to five per second and active jobs to two. Have Cody propose the implementation, Research independently analyze architecture/tradeoffs from this supplied context, and Tester independently identify failure cases and acceptance criteria. Run those perspectives concurrently and synthesize one final recommendation. Text only: do not write files, run commands, browse, or claim tests were executed.`
3. Verify the recommendation covers both rate/concurrency limits, architecture tradeoffs, and failure/acceptance cases. Check that the timeline reflects real workers and that unexecuted research/tests are not claimed as completed.

The existing UI inherits the selected pair for all workers; heterogeneous overrides are backend-only. Human acceptance is still required. Current status is neither BACKEND REAL-MODEL PROVEN nor MANUALLY ACCEPTED.

No browser, Chromium, Playwright tests, screenshots, OCR, image calls, or computer use were launched. No `.env` was inspected. No secrets, authorization headers, sensitive provider payloads, or hidden reasoning were exposed. No commit or push was made, and unrelated dirty/untracked work was preserved. Vision remains retained, deferred, NOT ACCEPTED, and NOT PROVEN reliable.

## git status --short

Broad pre-existing dirty/untracked state remains:

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
