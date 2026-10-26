# Phase 1 acceptance matrix

2026-10-28. This is an executable verification specification, not a record of new test passes. Owners/packages are defined in `PHASE1_IMPLEMENTATION_WORKPACKAGES.md`. Preserve existing accepted evidence, distinguish controlled/live/human/OS results, and record immutable run IDs.

## Reference project and task

Q creates a **disposable** dependency-free Node.js 22+ notes CLI with real `add`/`list` commands, JSON note storage, README, package manifest and passing baseline `node:test` checks. Proposed fixture location: `apps/command-center/tests/fixtures/phase1-notes-cli/` (new, not an existing component). Run copies in a canonical OS temporary directory; application databases are isolated from user settings/data. No dependency installation is needed.

User request through existing Main Chat:

> Inspect this notes CLI. Add `list --tag <tag>` with case-insensitive exact tag matching. Preserve unfiltered list behavior and note ordering. Missing tag values must fail clearly; listing must never change stored notes. Update usage documentation and regression tests. Get Doc's authoritative argument-parsing guidance, let Tester independently verify actual artifacts, and report files, checks and limitations.

The initial data includes mixed-case tags, overlapping names (`dev` and `devops`), an untagged note and an unrelated dirty file sentinel. Expected behavior covers exact/case-insensitive matching, no-match result, old list output, invalid/missing values, notes-byte preservation and original commands. The fixture must describe its CLI/output contract explicitly; models must inspect it rather than assume the project uses a package manager/framework.

Cody and Doc have independent initial assignments. Doc publishes an actual retrieved finding with source refs while Cody is active; Cody reads it before a subsequent action. Tester depends on produced artifacts. Doc can use known authoritative Node documentation directly; unknown-source discovery is a separate test, not a prerequisite for retrieving a known URL. Controlled tests use a clearly labeled local documentation fixture, never pretend it is a live official page. Authorized live acceptance uses the official source and exact configured models.

Keep an independent evaluator/check specification outside model-writable paths. Cody's authored tests complement it; rewriting tests to hide failure must not satisfy user criteria. Tester remains read-only and executes actual checks against candidate artifacts. A deliberately broken candidate is a **separate negative control**; real-model success must not require a scripted mistake.

Variation: use a differently named CLI/project and a distinct feature (for example `list --limit <positive integer>` with ordering/data-preservation requirements). No production prompt matching, fixture filenames, fixed patches or canned final responses.

## Required gates

| Gate / owner | Objective pass condition | Required evidence / negative case |
| --- | --- | --- |
| G00 baseline / I,Q | Current checkout/config/history preserved; exact source manifest and scoped baseline recorded. | Original fixture tests/hashes, unrelated sentinel, dirty-file manifest excluding secrets. HEAD alone is insufficient. |
| G01 identities/personality / E,U | Five existing Phase 1 bots have unique identities, role-specific instructions/tools and functional direct entry points. | Actual model request role/capability fields and denied out-of-role action; no unavailable specialist advertised as executable. |
| G02 inference / M,I | Browser send → server → resolved client uses exact selected provider/model/requested effort on existing/new/direct/team threads. | Inspect encoded requests, profile and effective/unsupported effort; same display names/different providers; unconfigured/disabled pair sends zero requests. |
| G03 inference recovery / E,I | Approval/restart/repair uses original child snapshot despite changed Settings. | Persisted snapshot and intercepted original-model calls for Cody, Doc, Scraapy and Tester; automatic Tester included. No silent parent inheritance. |
| G04 provider admission / M,R | One existing queue enforces global/provider/model limits fairly; unrelated local tools continue during model wait. | Admission/release counts, observable waiting and operation overlap; cancelled queue item never starts. Bounds are configuration, not an invented NVIDIA quota. |
| G05 backoff / M | Required Retry-After is never shortened; bounded attempts/no retry storms. | Fake clock tests numeric/date >60 s, 429/503, deadline shorter than wait, cancellation during cooldown and stream failure; no duplicate tools. |
| G06 real project / F,U | Open/persist actual root; Explorer/read/edit/create/rename/delete/search/watch reflect actual bytes. | Browser/API/filesystem hashes; native watcher probe; explicit destructive approval and denied traversal/symlink escapes. |
| G07 mutation conflicts / F | Editor/Cody same-revision collision cannot silently overwrite; different files can proceed independently. | Shared-lock/CAS barrier test: one success, one conflict; unsaved draft and unrelated dirty bytes retained. |
| G08 goal grounding / E | Material project ambiguity prompts clarification; project-bound tasks never inspect a different root. | Main Chat “analyze the framework” with small active workspace and no specified target must not claim inspection of MedioBot itself. Clear target is honored only if authorized. |
| G09 decomposition / E | Model may select a minimal capability-valid team and acyclic dependencies; controls enforce them. | Valid independent Cody/Doc plan plus dependent Tester; unknown role/capability/cycle denied. Controlled plan proves validation, not intelligence. |
| G10 concurrency / Q | Actual admitted worker/tool intervals overlap; dependent Tester starts after required candidate work. | Raw per-operation intervals and positive overlap. Separately identify worker overlap, provider serialization and task dependencies. `Promise.all`/UI ordering alone fails. |
| G11 collaboration / E,Q | Attributed finding published/delivered/consumed during active work, within budgets and scope. | Group/direct sequence, producer/ref, consumer's next decision/tool and resulting artifact; private unrelated messages excluded; dedup/timeout/cycle tests. |
| G12 web evidence / F,R,E | Actual search/crawl/extraction returns relevant bounded evidence; unavailable/challenge/empty remain distinct. | Known URL retrieval, independent unknown-source discovery and unrelated-result rejection; candidate snippets never upgraded to retrieved-page proof. |
| G13 network boundary / R,F | Denied DNS/IP/redirect/browser-subresource destinations receive zero connections. | Local rebinding and connection counters, address pin/TLS hostname checks, concurrent origin-scope isolation, blocked service-worker bypass and fail-closed missing pinned context. Reopen fixes only on actual failures. |
| G14 artifacts / E,Q | Cody edits actual code/tests/docs and runs permitted commands; final changes meet the feature contract. | Pre/post hashes, diff, observed tool outputs and immutable evaluator results; no fabricated reports or tool stubs. |
| G15 independent verification / E | Each required criterion binds to observed check IDs and final candidate revisions; Tester does not mutate project. | Failed/blocked/unverified report prevents verified goal; unrelated exit-zero command cannot support a fabricated assertion. Post-verification mutation invalidates checks. |
| G16 bounded repair / E | One actual failed verification produces one authorized repair and independent recheck. | Failed criterion/diagnostic → Cody effect → new hash → Tester verdict. Preserve siblings; second failure/exhaustion returns truthful partial/failed state. Negative control labeled. |
| G17 final synthesis / E,Q | Final answer accurately states changed files, criteria/checks, peer evidence, failures and limitations. | Read persisted response text and compare with ledger. Parent `task.completed` or `maestro.responded` alone does not prove accurate synthesis. |
| G18 direct workspaces / I,U | Private/direct/team scopes remain separate; switching preserves draft/reader position and active work. | Direct Cody/Doc/Scraapy/Tester tasks, reload, project switch; team participation is not private-chat ownership. Text-only Doc discussion performs no forced crawl. |
| G19 live interface / U,Q | Main/direct views show real child identity/status, current action, expanded tools/output/diffs/messages/checks while active. | Browser content assertions plus 2048×1159/smaller screenshots before terminal state; no fake progress, duplicated replay, composer overlap or unrelated redesign. |
| G20 controls/recovery / R,I,Q | Pause/approval/cancel/restart retain state and completed effects; unrelated work survives. | Interrupted DB/checkpoint recovery, no repeated owned write, explicit ambiguous-effect review, correct event replay and pending approval. |
| G21 cancellation settlement / R | Worker/model/tool cleanup confirmed before release, or explicitly pending with reservation retained. | Cleanup-resistant >5 s operation, ack mismatch/timeout/error, sibling completion, actual socket/page/process closure and eventual bounded cleanup. Parent cancelled is insufficient. |
| G22 diagnostics/security / M,F | Bounded command/cwd/launch or exit/timing/classification retained without secrets or hidden reasoning. | Hostile metadata/prompt/secret sentinels absent in response/SSE/log/export; malformed, filtered, reasoning-only, truncated, timeout and transport classified separately. |
| G23 resources / R,Q | Responsive laptop execution, bounded contexts/events/processes, correctly labeled CPU/RSS and no orphan leases. | Backend vs owned tree vs system memory separately; peak and post-idle samples, process/lease lifecycle, UI stop acknowledgment. Reference target ≤2 GiB owned peak on 16 GB Mac, measured not assumed. |
| G24 compatibility/regressions / all | Existing affected suites, typechecks and production build pass; platform claims match actual runs. | Actual commands/exit codes, skipped/block reasons; macOS and Windows separate. Python/browser versions constrained and tested; no broad dependency upgrades. |
| G25 live-model/human / I,Q | Separately authorized zero-cost provider run completes real feature through UI and human review accepts. | Actual selected-model requests, useful autonomous choices, tools, finding use, checks and response. Current status BLOCKED until account eligibility **and specific call authorization**; controlled completion cannot close this gate. |

## Execution methods and evidence discipline

- Contract/unit tests verify parsers, request mapping, criterion/evidence provenance and negative cases. They are not substitutes for the API/browser gates.
- Integration uses production composition and `/api/turns`, isolated SQLite and real local tools. Inject only provider responses/search fixtures needed for repeatability; record exactly what is simulated. Do not inject tools, verification conclusions or task terminal states to manufacture success.
- For UI configuration, intercept the browser's real request body and actual resolved inference request. A preferred-model label or stored DB selection is insufficient. Check role-specific follow-up/repair/responding calls too.
- Measure monotonic intervals within each process and record wall-clock anchors for durable events. Use barriers for controlled overlap; provider delay is not CPU work. Do not merge min/max operation envelopes into claims of uninterrupted simultaneous execution.
- Test commands must be reviewed for live/network opt-ins. Do not blindly run the broad e2e/runtime/manual research suite if it may call configured providers or public search. Preserve the current $0 restriction.
- Give each run an immutable directory and source/version manifest, assertions, timings/events, fixture-vs-real declaration, evidence/check/hash refs, safe DB excerpt, diagnostics, resource traces and browser screenshots. Do not overwrite prior evidence or store credentials/reasoning/private raw prompts.

## Readiness declarations

Use **PASS** only with the named evidence; **FAIL** when a gate's criterion is violated; **BLOCKED** for missing authorization/environment; **PARTIAL** for useful completed scope with named missing criteria. A missing artifact or skipped test is not a pass.

Local implementation may finish while G25 remains BLOCKED, but must be labeled **Phase 1 local controlled acceptance**, not autonomous production readiness. Windows, browser/network-security and human/live results remain individually visible. Today’s delivery target changes priority, never the pass conditions.
